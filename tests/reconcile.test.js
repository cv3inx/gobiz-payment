import assert from 'node:assert';
import http from 'node:http';
import { createSuite, setupDatabase, useTempEnv } from './helpers.js';

// A live consumer, so the manual-reconcile webhook can actually be inspected.
const CONSUMER_PORT = 45998;
useTempEnv({
   API_KEY: 'admin-key',
   WEBHOOK_URL: `http://127.0.0.1:${CONSUMER_PORT}/hook`,
   UNIQUE_CODE_MAX: '99',
   POLL_MIN_INTERVAL_MS: '600000', // keep read-driven cycles out of this suite
});

const db = await setupDatabase();
const { createApp } = await import('../src/app.js');
const { verifyWebhookSignature } = await import('../src/security.js');
const history = await import('../src/db/history.js');
const transactions = await import('../src/db/transactions.js');

const merchant = {
   token: 'tok',
   _initialized: true,
   _isTokenValid: async () => true,
   init: async () => {},
   getHistory: async () => [],
};

const server = createApp({ merchant }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const AUTH = { 'Content-Type': 'application/json', 'X-API-Key': 'admin-key' };

const call = async (method, path, body) => {
   const res = await fetch(base + path, {
      method,
      headers: AUTH,
      body: body === undefined ? undefined : JSON.stringify(body),
   });
   const text = await res.text();
   try {
      return { status: res.status, body: JSON.parse(text) };
   } catch {
      return { status: res.status, body: text };
   }
};

/** Collect every webhook the gateway delivers during this suite. */
const delivered = [];
const consumer = http.createServer((req, res) => {
   let raw = '';
   req.on('data', (c) => (raw += c));
   req.on('end', () => {
      delivered.push({
         valid: verifyWebhookSignature(raw, req.headers['x-signature'], 'test-secret'),
         payload: JSON.parse(raw),
      });
      res.writeHead(200).end('ok');
   });
});
await new Promise((r) => consumer.listen(CONSUMER_PORT, '127.0.0.1', r));

const archive = (gobizId, amount) =>
   history.upsert({
      gobizId,
      amount,
      time: '01 Jan 2026 - 10:00:00',
      raw: { transaction_id: gobizId, gross_amount: amount * 100, status: 'SETTLEMENT' },
      seenAt: new Date().toISOString(),
   });

const { test, report } = createSuite('reconcile');
const results = {};

// ── the core scenario: payer sent the wrong amount, order already EXPIRED ─────
const order = await call('POST', '/payment/create', { amount: 20_000, metadata: { orderId: 7 } });
const orderId = order.body.data.trxId;
const expected = order.body.data.amountToPay;
await call('POST', `/payment/${orderId}/cancel`); // now EXPIRED
delivered.length = 0; // drop the payment.expired webhook from the record

// Money arrived, 3 rupiah short of the payable figure, so nothing auto-matched.
const received = expected - 3;
await archive('GB-WRONG-AMOUNT', received);

results.unmatchedBefore = await call('GET', '/history?matched=false');
results.reconcile = await call('POST', '/api/admin/reconcile', { gobizId: 'GB-WRONG-AMOUNT', trxId: orderId });
results.afterReconcile = await call('GET', `/payment/${orderId}`);
results.unmatchedAfter = await call('GET', '/history?matched=false');
results.matchedAfter = await call('GET', '/history?matched=true');

// Doing it twice must not settle again or fire a second webhook.
const deliveredAfterFirst = delivered.length;
results.reconcileAgain = await call('POST', '/api/admin/reconcile', { gobizId: 'GB-WRONG-AMOUNT', trxId: orderId });
results.extraWebhooks = delivered.length - deliveredAfterFirst;

// ── validation and error paths ────────────────────────────────────────────────
results.missingFields = await call('POST', '/api/admin/reconcile', { gobizId: 'GB-WRONG-AMOUNT' });
results.unknownPayment = await call('POST', '/api/admin/reconcile', { gobizId: 'GB-NOPE', trxId: orderId });

await archive('GB-FREE', 4321);
results.unknownTrx = await call('POST', '/api/admin/reconcile', { gobizId: 'GB-FREE', trxId: 'TRX-DOES-NOT-EXIST' });

const alreadyPaid = await call('POST', '/payment/create', { amount: 31_000 });
const paidId = alreadyPaid.body.data.trxId;
await transactions.forcePaid({ trxId: paidId, paidAt: new Date().toISOString() });
results.alreadyPaidTrx = await call('POST', '/api/admin/reconcile', { gobizId: 'GB-FREE', trxId: paidId });

// A payment already linked to one order must not be reusable for another.
const other = await call('POST', '/payment/create', { amount: 12_345 });
results.reusePayment = await call('POST', '/api/admin/reconcile', {
   gobizId: 'GB-WRONG-AMOUNT',
   trxId: other.body.data.trxId,
});

results.noKey = await fetch(`${base}/api/admin/reconcile`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ gobizId: 'GB-FREE', trxId: orderId }),
}).then((r) => r.status);

// GB-FREE must still be unlinked after every one of those rejections.
results.freeStillUnmatched = (await call('GET', '/history?matched=false')).body.data
   .some((h) => h.gobizId === 'GB-FREE');

// ── assertions ───────────────────────────────────────────────────────────────
test('an unmatched payment is visible before reconciling', () => {
   assert.ok(
      results.unmatchedBefore.body.data.some((h) => h.gobizId === 'GB-WRONG-AMOUNT'),
      'the orphan payment shows up for the operator',
   );
});

test('reconciling revives an EXPIRED order to PAID', () => {
   // The whole point: the money provably arrived, so an expired order must be
   // recoverable. This is the one path allowed to override the PENDING guard.
   assert.strictEqual(results.reconcile.status, 200);
   const d = results.reconcile.body.data;
   assert.strictEqual(d.previousStatus, 'EXPIRED');
   assert.strictEqual(d.status, 'PAID');
   assert.strictEqual(results.afterReconcile.body.data.status, 'PAID');
   assert.ok(results.afterReconcile.body.data.paidAt, 'paidAt recorded');
});

test('the amount discrepancy is reported, not hidden', () => {
   const d = results.reconcile.body.data;
   assert.strictEqual(d.expected, expected);
   assert.strictEqual(d.received, received);
   assert.strictEqual(d.difference, -3, 'negative means the payer sent less');
});

test('the payment is linked to the order and leaves the unmatched list', () => {
   assert.ok(
      !results.unmatchedAfter.body.data.some((h) => h.gobizId === 'GB-WRONG-AMOUNT'),
      'gone from ?matched=false',
   );
   const linked = results.matchedAfter.body.data.find((h) => h.gobizId === 'GB-WRONG-AMOUNT');
   assert.ok(linked, 'present in ?matched=true');
   assert.strictEqual(linked.matchedTrxId, orderId);
});

test('reconciling fires exactly one payment.paid webhook', async () => {
   await new Promise((r) => setTimeout(r, 400));
   const paid = delivered.filter((d) => d.payload.trxId === orderId && d.payload.event === 'payment.paid');
   assert.strictEqual(paid.length, 1, `expected 1 payment.paid, got ${paid.length}`);
   assert.ok(paid[0].valid, 'signature verifies');
   assert.deepStrictEqual(paid[0].payload.metadata, { orderId: 7 }, 'metadata carried through');
});

test('reconciling twice is rejected and does not re-notify', () => {
   assert.strictEqual(results.reconcileAgain.status, 409);
   assert.strictEqual(results.extraWebhooks, 0, 'no second webhook');
});

test('a payment cannot be pointed at a second order', () => {
   assert.strictEqual(results.reusePayment.status, 409);
   assert.match(results.reusePayment.body.error, /already linked/i);
});

test('bad input and unknown ids are rejected cleanly', () => {
   assert.strictEqual(results.missingFields.status, 400, 'trxId omitted');
   assert.strictEqual(results.unknownPayment.status, 404, 'unknown gobizId');
   assert.strictEqual(results.unknownTrx.status, 404, 'unknown trxId');
   assert.strictEqual(results.alreadyPaidTrx.status, 409, 'order already PAID');
   assert.strictEqual(results.noKey, 401, 'requires the API key');
});

test('a rejected reconcile leaves the payment claimable', () => {
   // The link is claimed before the order is touched, so a rejection must not
   // strand the payment as "matched to nothing".
   assert.ok(results.freeStillUnmatched, 'GB-FREE is still available to reconcile');
});

const ok = await report();
server.close();
consumer.close();
await db.close();
process.exit(ok ? 0 : 1);
