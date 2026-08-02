import assert from 'node:assert';
import http from 'node:http';
import { createSuite, useTempDatabase } from './helpers.js';

// A webhook consumer that is refusing connections, so delivery fails the way it
// does in production (ECONNREFUSED) without any network access.
const DEAD_CONSUMER = 'http://127.0.0.1:45997/hook';
const { cleanup } = useTempDatabase({
   API_KEY: 'test-key',
   WEBHOOK_URL: DEAD_CONSUMER,
   WEBHOOK_SWEEP_MS: '300',
   UNIQUE_CODE_MAX: '99',
});

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { verifyWebhookSignature } = await import('../src/security.js');

const server = createApp().listen(0);
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
   try {
      return { status: res.status, body: JSON.parse(text), type: res.headers.get('content-type') };
   } catch {
      return { status: res.status, body: text, type: res.headers.get('content-type') };
   }
};

const create = (body) => call('POST', '/payment/create', { body });

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
results.ssrf = await create({ amount: 100, callbackUrl: 'http://169.254.169.254/x' });
results.badTrxId = await create({ amount: 100, trxId: 'bad id!' });
results.badStatus = await call('GET', '/payments?status=BOGUS');

results.created = await create({ amount: 5000, fee: 100, metadata: { orderId: 1 } });
const trxId = results.created.body.data?.trxId;

results.duplicate = await create({ amount: 100, trxId });
results.idem1 = await create({ amount: 7000, idempotencyKey: 'idem-1' });
results.idem2 = await create({ amount: 7000, idempotencyKey: 'idem-1' });

results.sequential = [];
for (let i = 0; i < 3; i++) results.sequential.push((await create({ amount: 33_000 })).body.data.uniqueCode);

results.status = await call('GET', `/payment/${trxId}`);
results.qr = await call('GET', `/payment/${trxId}/qr.png`);
results.list = await call('GET', '/payments?limit=-1');
results.health = await call('GET', '/health');
results.history = await call('GET', '/history');

results.cancel = await call('POST', `/payment/${trxId}/cancel`);
results.cancelAgain = await call('POST', `/payment/${trxId}/cancel`);

await new Promise((r) => setTimeout(r, 600)); // let delivery fail + record state
results.afterFailedWebhook = await call('GET', `/payment/${trxId}`);
results.replayUnknown = await call('POST', '/payment/NOPE/replay-webhook');
results.replayPending = await call('POST', `/payment/${results.idem1.body.data.trxId}/replay-webhook`);

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
await new Promise((r) => setTimeout(r, 800)); // replay delivers out-of-band
results.afterReplay = await call('GET', `/payment/${trxId}`);
consumer.close();

// A per-transaction callbackSecret must sign that transaction's webhook instead of
// the global secret, and must never be echoed back in any response.
// The consumer listens on the same port as WEBHOOK_URL: a caller-supplied
// callbackUrl pointing at loopback is (correctly) refused by the SSRF guard.
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
await new Promise((r) => setTimeout(r, 600));
results.secretStatus = await call('GET', `/payment/${secretTrxId}`);
secretConsumer.close();

// /health must report a dead upstream session, so a load balancer can react.
const { check: checkSession } = await import('../src/services/session.js');
const brokenMerchant = {
   token: 'tok',
   _isTokenValid: async () => false,
   init: async () => { throw new Error('Login di-cooldown 900s'); },
};
await checkSession(brokenMerchant);
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

test('input validation rejects bad amounts, fees, and URLs', () => {
   assert.strictEqual(results.badAmount.status, 400, 'amount 0');
   assert.strictEqual(results.hugeAmount.status, 400, 'amount over MAX_AMOUNT');
   assert.strictEqual(results.badFee.status, 400, 'negative fee');
   assert.strictEqual(results.badExpire.status, 400, 'expireMinutes 0');
   assert.strictEqual(results.ssrf.status, 400, 'SSRF callbackUrl');
   assert.strictEqual(results.badTrxId.status, 400, 'malformed trxId');
   assert.strictEqual(results.badStatus.status, 400, 'unknown status filter');
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
   assert.strictEqual(results.healthDegraded.status, 503, 'signals degraded to a load balancer');
   assert.strictEqual(results.healthDegraded.body.success, false);
   assert.strictEqual(results.healthDegraded.body.data.session.ok, false);
   assert.match(results.healthDegraded.body.data.session.lastError, /cooldown/i);
   assert.strictEqual(results.healthRecovered.status, 200, 'back to 200 once the session recovers');
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

test('replay re-queues, 404s unknown, 409s pending', () => {
   assert.strictEqual(results.replay.status, 200);
   assert.strictEqual(results.replayUnknown.status, 404);
   assert.strictEqual(results.replayPending.status, 409);
});

test('a returning consumer receives the queued event with a valid signature', () => {
   assert.ok(delivered, 'webhook was delivered after the consumer came back');
   assert.ok(delivered.valid, 'signature verifies against the raw body');
   assert.strictEqual(delivered.payload.trxId, trxId);
   assert.strictEqual(delivered.payload.event, 'payment.expired');
   assert.strictEqual(delivered.payload.amountToPay, results.created.body.data.amountToPay);
   assert.strictEqual(delivered.payload.uniqueCode, results.created.body.data.uniqueCode);
   assert.strictEqual(results.afterReplay.body.data.webhook.state, 'SENT', 'marked delivered');
});

const ok = report();
server.close();
cleanup(db);
process.exit(ok ? 0 : 1);
