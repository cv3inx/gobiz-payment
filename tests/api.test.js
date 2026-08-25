import assert from 'node:assert';
import http from 'node:http';
import { createSuite, setupDatabase, useTempEnv } from './helpers.js';

// A webhook consumer that is refusing connections, so delivery fails the way it
// does in production (ECONNREFUSED) without any network access.
const DEAD_CONSUMER = 'http://127.0.0.1:45997/hook';
useTempEnv({
   API_KEY: 'test-key',
   WEBHOOK_URL: DEAD_CONSUMER,
   UNIQUE_CODE_MAX: '99',
});

const db = await setupDatabase();
const { createApp } = await import('../src/app.js');
const { verifyWebhookSignature } = await import('../src/security.js');
const transactions = await import('../src/db/transactions.js');

/**
 * Stand-in for GoPayMerchant. `history` is the upstream feed the poller reads, so a
 * test can make a payment "arrive" without touching the network.
 */
const upstream = { history: [], failNext: null };
const merchant = {
   token: 'tok',
   _initialized: true,
   _isTokenValid: async () => true,
   init: async () => {},
   getHistory: async () => {
      if (upstream.failNext) {
         const why = upstream.failNext;
         upstream.failNext = null;
         throw new Error(why);
      }
      return upstream.history;
   },
};

const server = createApp({ merchant }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const AUTH = { 'Content-Type': 'application/json', 'X-API-Key': 'test-key' };

const call = async (method, path, { headers = AUTH, body } = {}) => {
   const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
   });
   const text = await res.text();
   const meta = { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control') };
   try {
      return { ...meta, body: JSON.parse(text) };
   } catch {
      return { ...meta, body: text };
   }
};

const create = (body) => call('POST', '/payment/create', { body });
/** There is no cron: this is the same cycle ordinary traffic drives. */
const runCycle = () => call('POST', '/api/admin/poll');

/** One upstream payin entry, shaped like lib/gobiz.js `getHistory` output. */
const payin = (gobizId, amount) => ({
   gobizId,
   amount,
   time: '01 Jan 2026 - 10:00:00',
   raw: { transaction_id: gobizId, gross_amount: amount * 100, status: 'SETTLEMENT' },
});

const { test, report } = createSuite('api');
const results = {};

// ── run the async scenarios up front, assert on them below ───────────────────
results.notFound = await call('GET', '/nope');
results.badJson = await call('POST', '/payment/create', { body: '{oops' });
results.noKey = await call('GET', '/payments', { headers: {} });
results.badAmount = await create({ amount: 0 });
results.hugeAmount = await create({ amount: 99_999_999_999 });
results.badFee = await create({ amount: 100, fee: -1 });
results.badExpire = await create({ amount: 100, expireMinutes: 0 });
// A lifetime past the cap would overflow a 32-bit timer in any scheduler and
// reserves one of only UNIQUE_CODE_MAX payable amounts indefinitely.
results.hugeExpire = await create({ amount: 100, expireMinutes: 40_000 });
results.ssrf = await create({ amount: 100, callbackUrl: 'http://169.254.169.254/x' });
results.badTrxId = await create({ amount: 100, trxId: 'bad id!' });
results.badStatus = await call('GET', '/payments?status=BOGUS');

results.cycleNoAuth = await call('POST', '/api/admin/poll', { headers: {} });

// The first cycle seeds: pre-existing upstream history must NOT be reconciled
// against orders created later.
upstream.history = [payin('GB-OLD-1', 5101), payin('GB-OLD-2', 7777)];
results.cycleSeed = await runCycle();

results.created = await create({ amount: 5000, fee: 100, metadata: { orderId: 1 } });
const trxId = results.created.body.data?.trxId;
const createdAmount = results.created.body.data?.amountToPay;

results.duplicate = await create({ amount: 100, trxId });
results.idem1 = await create({ amount: 7000, idempotencyKey: 'idem-1' });
results.idem2 = await create({ amount: 7000, idempotencyKey: 'idem-1' });

results.sequential = [];
for (let i = 0; i < 3; i++) results.sequential.push((await create({ amount: 33_000 })).body.data.uniqueCode);

results.status = await call('GET', `/payment/${trxId}`);
results.statusPublic = await call('GET', `/payment/${trxId}`, { headers: {} });
results.qr = await call('GET', `/payment/${trxId}/qr.png`);
results.qrMiss = await call('GET', '/payment/NOPE-NOT-A-TRX/qr.png');
results.healthPublic = await call('GET', '/health', { headers: {} });
results.list = await call('GET', '/payments?limit=-1');
results.health = await call('GET', '/health');
results.history = await call('GET', '/history');

// A payment arrives for the order created above. The consumer is still down, so
// the PAID webhook must be recorded as owed rather than lost.
upstream.history = [payin('GB-PAY-1', createdAmount), ...upstream.history];
results.cyclePaid = await runCycle();
results.afterPaid = await call('GET', `/payment/${trxId}`);
results.historyMatched = await call('GET', '/history?matched=true');

// Re-running the same upstream feed must not reconcile the same payment twice.
results.cycleReplay = await runCycle();

// An unmatched payment is archived, not dropped.
upstream.history = [payin('GB-ORPHAN', 999_777), ...upstream.history];
results.cycleOrphan = await runCycle();
results.historyUnmatched = await call('GET', '/history?matched=false');

// A pending transaction whose expiry has passed while nothing was running: the
// cycle sweep settles it, and a status read settles it on the spot.
const shortLived = await create({ amount: 4100, expireMinutes: 1 });
const shortId = shortLived.body.data.trxId;
await transactions.settle; // no-op, keeps the import obviously used
await db.sql(
   `UPDATE transactions SET "expiresAt" = $1 WHERE "trxId" = $2`,
   [new Date(Date.now() - 60_000).toISOString(), shortId],
);
results.lazyExpire = await call('GET', `/payment/${shortId}`);

const sweptTrx = await create({ amount: 4300, expireMinutes: 1 });
const sweptId = sweptTrx.body.data.trxId;
await db.sql(
   `UPDATE transactions SET "expiresAt" = $1 WHERE "trxId" = $2`,
   [new Date(Date.now() - 60_000).toISOString(), sweptId],
);
results.cycleSweep = await runCycle();
results.afterSweep = await call('GET', `/payment/${sweptId}`);

// Upstream failing must not stop the sweep or webhook retries.
upstream.failNext = 'HTTP Error Analytics: 503';
results.cycleUpstreamDown = await runCycle();

results.cancel = await call('POST', `/payment/${results.idem1.body.data.trxId}/cancel`);
results.cancelAgain = await call('POST', `/payment/${results.idem1.body.data.trxId}/cancel`);
results.afterFailedWebhook = await call('GET', `/payment/${results.idem1.body.data.trxId}`);
results.replayUnknown = await call('POST', '/payment/NOPE/replay-webhook');

// The consumer comes back up. Replaying now must deliver the queued event —
// this is the production recovery path for a webhook that failed while it was down.
let delivered = null;
const consumer = http.createServer((req, res) => {
   let raw = '';
   req.on('data', (c) => (raw += c));
   req.on('end', () => {
      delivered = {
         valid: verifyWebhookSignature(raw, req.headers['x-signature'], 'test-secret'),
         payload: JSON.parse(raw),
      };
      res.writeHead(200).end('ok');
   });
});
await new Promise((r) => consumer.listen(45997, '127.0.0.1', r));

results.replay = await call('POST', `/payment/${trxId}/replay-webhook`);
results.afterReplay = await call('GET', `/payment/${trxId}`);
consumer.close();

// A per-transaction callbackSecret must sign that transaction's webhook instead of
// the global secret, and must never be echoed back in any response.
let perTrx = null;
const secretConsumer = http.createServer((req, res) => {
   let raw = '';
   req.on('data', (c) => (raw += c));
   req.on('end', () => {
      perTrx = {
         signedWithPerTrx: verifyWebhookSignature(raw, req.headers['x-signature'], 'per-trx-secret-123'),
         signedWithGlobal: verifyWebhookSignature(raw, req.headers['x-signature'], 'test-secret'),
         body: raw,
      };
      res.writeHead(200).end('ok');
   });
});
await new Promise((r) => secretConsumer.listen(45997, '127.0.0.1', r));

results.secretShort = await create({ amount: 100, callbackSecret: 'short' });
results.secretCreate = await create({ amount: 4242, callbackSecret: 'per-trx-secret-123' });
const secretTrxId = results.secretCreate.body.data?.trxId;
await call('POST', `/payment/${secretTrxId}/cancel`);
results.secretStatus = await call('GET', `/payment/${secretTrxId}`);
secretConsumer.close();

// /health must report a dead upstream session, so an uptime monitor can react.
const { check: checkSession } = await import('../src/services/session.js');
await checkSession({
   token: 'tok',
   _isTokenValid: async () => false,
   init: async () => { throw new Error('Login di-cooldown 900s'); },
});
results.healthDegraded = await call('GET', '/health');

await checkSession({ token: 'tok', _isTokenValid: async () => true, init: async () => {} });
results.healthRecovered = await call('GET', '/health');

// ── assertions ───────────────────────────────────────────────────────────────
test('unknown route returns the JSON error envelope', () => {
   assert.strictEqual(results.notFound.status, 404);
   assert.strictEqual(results.notFound.body.success, false);
});

test('malformed JSON body is a 400, not a crash', () => {
   assert.strictEqual(results.badJson.status, 400);
});

test('missing API key is rejected', () => {
   assert.strictEqual(results.noKey.status, 401);
});

test('the cycle endpoint refuses an unauthenticated caller', () => {
   // Anyone able to drive this could hammer GoBiz until the account is blocked.
   assert.strictEqual(results.cycleNoAuth.status, 401);
});

test('input validation rejects bad amounts, fees, expiries, and URLs', () => {
   assert.strictEqual(results.badAmount.status, 400, 'amount 0');
   assert.strictEqual(results.hugeAmount.status, 400, 'amount over MAX_AMOUNT');
   assert.strictEqual(results.badFee.status, 400, 'negative fee');
   assert.strictEqual(results.badExpire.status, 400, 'expireMinutes 0');
   assert.strictEqual(results.hugeExpire.status, 400, 'expireMinutes past the cap');
   assert.strictEqual(results.ssrf.status, 400, 'SSRF callbackUrl');
   assert.strictEqual(results.badTrxId.status, 400, 'malformed trxId');
   assert.strictEqual(results.badStatus.status, 400, 'unknown status filter');
});

test('the first cycle seeds history instead of reconciling it', () => {
   assert.strictEqual(results.cycleSeed.status, 200);
   assert.strictEqual(results.cycleSeed.body.data.poll.seeded, true);
   assert.strictEqual(results.cycleSeed.body.data.poll.matched, 0, 'nothing matched on a seed pass');
});

test('create returns a payable amount built from amount + fee + code', () => {
   const { status, body } = results.created;
   assert.strictEqual(status, 201);
   const d = body.data;
   assert.strictEqual(d.amount, 5000);
   assert.strictEqual(d.fee, 100);
   assert.strictEqual(d.amountToPay, 5000 + 100 + d.uniqueCode);
   assert.ok(d.uniqueCode >= 1 && d.uniqueCode <= 99, `code ${d.uniqueCode} within 1..99`);
   assert.ok(d.qrImageUrl.startsWith('http'), 'absolute QR url');
});

test('unique codes are handed out sequentially', () => {
   const [a, b, c] = results.sequential;
   assert.strictEqual(b, (a % 99) + 1, `${a} -> ${b}`);
   assert.strictEqual(c, (b % 99) + 1, `${b} -> ${c}`);
});

test('duplicate trxId is a 409', () => {
   assert.strictEqual(results.duplicate.status, 409);
});

test('idempotency key returns the original transaction', () => {
   assert.strictEqual(results.idem2.status, 200);
   assert.strictEqual(results.idem2.body.idempotent, true);
   assert.strictEqual(results.idem2.body.data.trxId, results.idem1.body.data.trxId);
});

test('status, QR image, and health all respond', () => {
   assert.strictEqual(results.status.status, 200);
   assert.strictEqual(results.qr.status, 200);
   assert.match(results.qr.type, /image\/png/);
   assert.strictEqual(results.health.status, 200);
   assert.ok(typeof results.health.body.data.pending === 'number');
   assert.ok(typeof results.health.body.data.uniqueCodeCursor === 'number');
   assert.ok(results.health.body.data.session, 'reports session health');
   assert.strictEqual(results.history.status, 200);
});

test('the public status view withholds the merchant\'s own fields', () => {
   // A caller-supplied trxId can be guessable, and this endpoint has to stay open
   // for the payer. So the payer gets what they need to pay and nothing else.
   const pub = results.statusPublic.body.data;
   assert.strictEqual(results.statusPublic.status, 200, 'still open to the payer');
   assert.strictEqual(pub.amountToPay, results.created.body.data.amountToPay, 'can still pay');
   assert.ok(pub.qrString && pub.status && pub.expiresAt, 'has what a payer needs');
   for (const leak of ['metadata', 'callbackUrl', 'webhook']) {
      assert.ok(!(leak in pub), `${leak} must not be public`);
   }
   // The authenticated view is unchanged, so merchant tooling keeps its contract.
   const priv = results.status.body.data;
   assert.deepStrictEqual(priv.metadata, { orderId: 1 }, 'API key still sees metadata');
   assert.ok('webhook' in priv && 'callbackUrl' in priv);
});

test('public /health reports liveness but not trade volume', () => {
   // "pending: 3, total: 128" on an open endpoint tells anyone how much business
   // this merchant does.
   const pub = results.healthPublic.body.data;
   assert.strictEqual(results.healthPublic.status, 200);
   assert.ok(pub.session, 'still usable by an uptime monitor');
   for (const leak of ['pending', 'total', 'webhooksOwed', 'uniqueCodeCursor']) {
      assert.ok(!(leak in pub), `${leak} must not be public`);
   }
});

test('the QR is cached by the CDN, and a miss is not', () => {
   // Rendering a PNG is the most expensive thing this API does, and for a given
   // trxId the bytes never change.
   assert.match(results.qr.cache, /immutable/, 'hit is cacheable forever');
   assert.strictEqual(results.qrMiss.status, 404);
   assert.match(results.qrMiss.cache, /no-store/, 'a miss must never be cached');
});

test('a cycle reconciles a matching payment and marks it PAID', () => {
   assert.strictEqual(results.cyclePaid.body.data.poll.matched, 1, 'one order matched');
   assert.strictEqual(results.afterPaid.body.data.status, 'PAID');
   assert.ok(results.afterPaid.body.data.paidAt, 'paidAt set');
   const linked = results.historyMatched.body.data.find((h) => h.gobizId === 'GB-PAY-1');
   assert.ok(linked, 'payment archived');
   assert.strictEqual(linked.matchedTrxId, trxId, 'archive links back to the order');
});

test('re-seeing the same upstream payment does not reconcile it twice', () => {
   assert.strictEqual(results.cycleReplay.body.data.poll.fresh, 0, 'already-archived ids are not fresh');
});

test('an unmatched payment is archived rather than dropped', () => {
   assert.strictEqual(results.cycleOrphan.body.data.poll.fresh, 1);
   assert.strictEqual(results.cycleOrphan.body.data.poll.matched, 0);
   assert.ok(
      results.historyUnmatched.body.data.some((h) => h.gobizId === 'GB-ORPHAN'),
      'visible via ?matched=false for manual reconciliation',
   );
});

test('an overdue transaction is settled on read', () => {
   // No timer can fire in a frozen instance, so reading must not report PENDING
   // for something that expired.
   assert.strictEqual(results.lazyExpire.body.data.status, 'EXPIRED');
});

test('the cycle sweep expires overdue transactions', () => {
   assert.ok(results.cycleSweep.body.data.expired >= 1, 'sweep reported an expiry');
   assert.strictEqual(results.afterSweep.body.data.status, 'EXPIRED');
});

test('a failing upstream poll does not stop the rest of the cycle', () => {
   assert.strictEqual(results.cycleUpstreamDown.status, 200, 'still answers');
   assert.strictEqual(results.cycleUpstreamDown.body.success, false, 'reports the failure');
   assert.ok(
      results.cycleUpstreamDown.body.data.errors.some((e) => e.startsWith('poll:')),
      'names the failed step',
   );
   assert.ok('webhooks' in results.cycleUpstreamDown.body.data, 'webhook sweep still ran');
});

test('negative limit is clamped instead of dumping the table', () => {
   assert.strictEqual(results.list.status, 200);
   assert.ok(results.list.body.data.length <= 200);
   assert.strictEqual(results.list.body.meta.limit, 1);
});

test('cancel expires a pending transaction exactly once', () => {
   assert.strictEqual(results.cancel.status, 200);
   assert.strictEqual(results.cancel.body.data.status, 'EXPIRED');
   assert.strictEqual(results.cancelAgain.status, 409);
});

test('a failed webhook is recorded, not lost', () => {
   const wh = results.afterFailedWebhook.body.data.webhook;
   assert.strictEqual(wh.state, 'PENDING', 'still owed after failure');
   assert.ok(wh.attempts >= 1, 'attempt counted');
   assert.match(wh.lastError, /ECONNREFUSED|fetch failed/, `got ${wh.lastError}`);
   assert.ok(wh.nextAttemptAt, 'retry scheduled');
});

test('replay re-queues and 404s an unknown trx', () => {
   assert.strictEqual(results.replay.status, 200);
   assert.strictEqual(results.replayUnknown.status, 404);
});

test('a returning consumer receives the queued event with a valid signature', () => {
   assert.ok(delivered, 'webhook was delivered after the consumer came back');
   assert.ok(delivered.valid, 'signature verifies against the raw body');
   assert.strictEqual(delivered.payload.trxId, trxId);
   assert.strictEqual(delivered.payload.event, 'payment.paid');
   assert.strictEqual(delivered.payload.amountToPay, createdAmount);
   assert.strictEqual(delivered.payload.uniqueCode, results.created.body.data.uniqueCode);
   assert.strictEqual(results.afterReplay.body.data.webhook.state, 'SENT', 'marked delivered');
});

test('a per-transaction callbackSecret signs that webhook, not the global secret', () => {
   assert.strictEqual(results.secretCreate.status, 201);
   assert.ok(perTrx, 'webhook delivered');
   assert.ok(perTrx.signedWithPerTrx, 'signature verifies with the per-trx secret');
   assert.ok(!perTrx.signedWithGlobal, 'global secret must NOT verify it');
});

test('callbackSecret is never echoed back and is length-checked', () => {
   assert.ok(!('callbackSecret' in results.secretCreate.body.data), 'absent from create response');
   assert.ok(!('callbackSecret' in results.secretStatus.body.data), 'absent from status response');
   assert.ok(!perTrx.body.includes('per-trx-secret-123'), 'absent from the webhook payload');
   assert.strictEqual(results.secretShort.status, 400, 'rejects a secret under 8 chars');
});

test('health degrades to 503 when the GoBiz session is down', () => {
   assert.strictEqual(results.healthDegraded.status, 503, 'signals degraded to a monitor');
   assert.strictEqual(results.healthDegraded.body.success, false);
   assert.strictEqual(results.healthDegraded.body.data.session.ok, false);
   assert.match(results.healthDegraded.body.data.session.lastError, /cooldown/i);
   assert.strictEqual(results.healthRecovered.status, 200, 'back to 200 once the session recovers');
});

const ok = await report();
server.close();
await db.close();
process.exit(ok ? 0 : 1);
