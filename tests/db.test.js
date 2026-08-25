import assert from 'node:assert';
import { createSuite, makeTrx, setupDatabase, useTempEnv } from './helpers.js';

useTempEnv();
const db = await setupDatabase();
const transactions = await import('../src/db/transactions.js');
const history = await import('../src/db/history.js');
const webhooks = await import('../src/db/webhooks.js');

const { test, report } = createSuite('db');

test('round-trips a transaction with JSON columns', async () => {
   const trx = makeTrx({ payAmount: 3001, uniqueCode: 1 });
   await transactions.insert(trx);
   const got = await transactions.get(trx.trxId);
   assert.strictEqual(got.payAmount, 3001);
   assert.strictEqual(got.uniqueCode, 1);
   assert.deepStrictEqual(got.metadata, { orderId: 42 });
});

test('rupiah columns survive values past INT4', async () => {
   // amount + fee + code can exceed 2^31, which is why they are BIGINT.
   const big = 2_000_000_050;
   const trx = makeTrx({ amount: 1_000_000_000, fee: 1_000_000_000, total: 2_000_000_000, payAmount: big, uniqueCode: 50 });
   await transactions.insert(trx);
   const got = await transactions.get(trx.trxId);
   assert.strictEqual(got.payAmount, big, 'read back as a number, not a string');
   assert.strictEqual(typeof got.amount, 'number');
   assert.ok((await transactions.getPendingByAmount(big)), 'matchable by payAmount');
});

test('pending-by-amount stops matching once settled', async () => {
   const trx = makeTrx({ payAmount: 3100 });
   await transactions.insert(trx);
   assert.ok(await transactions.getPendingByAmount(3100));
   assert.strictEqual(await transactions.settle({ ...trx, status: 'PAID', paidAt: 'now', entry: { t: 1 } }), true);
   assert.strictEqual(await transactions.getPendingByAmount(3100), null);
   assert.deepStrictEqual((await transactions.get(trx.trxId)).entry, { t: 1 });
});

test('settle-once guard protects a PAID row from a late expiry', async () => {
   const trx = makeTrx({ payAmount: 3200 });
   await transactions.insert(trx);
   await transactions.settle({ ...trx, status: 'PAID', paidAt: 'now', entry: { t: 2 } });
   assert.strictEqual(await transactions.settle({ ...trx, status: 'EXPIRED' }), false, 'second settle rejected');
   assert.strictEqual((await transactions.get(trx.trxId)).status, 'PAID');
   assert.deepStrictEqual((await transactions.get(trx.trxId)).entry, { t: 2 }, 'entry not clobbered');
});

test('unique index blocks two PENDING rows at one amount', async () => {
   const trx = makeTrx({ payAmount: 5000 });
   await transactions.insert(trx);
   await assert.rejects(() => transactions.insert(makeTrx({ payAmount: 5000 })), (e) => e.code === '23505');
   // the partial index only covers PENDING, so a settled row frees the amount
   await transactions.settle({ ...trx, status: 'PAID' });
   await transactions.insert(makeTrx({ payAmount: 5000 }));
   assert.ok(await transactions.getPendingByAmount(5000));
});

test('idempotency key is unique and queryable', async () => {
   const trx = makeTrx({ payAmount: 8000, idempotencyKey: 'order-abc' });
   await transactions.insert(trx);
   assert.strictEqual((await transactions.getByIdempotencyKey('order-abc')).trxId, trx.trxId);
   await assert.rejects(
      () => transactions.insert(makeTrx({ payAmount: 8001, idempotencyKey: 'order-abc' })),
      (e) => e.code === '23505',
   );
});

test('caller-supplied trxId round-trips and rejects duplicates', async () => {
   await transactions.insert(makeTrx({ trxId: 'order-9001', payAmount: 9001 }));
   assert.strictEqual((await transactions.get('order-9001')).trxId, 'order-9001');
   await assert.rejects(
      () => transactions.insert(makeTrx({ trxId: 'order-9001', payAmount: 9002 })),
      (e) => e.code === '23505',
   );
});

test('pagination clamps negative and oversized values', async () => {
   assert.deepStrictEqual(transactions.clampPage({ limit: -1, offset: -5 }), { limit: 1, offset: 0 });
   assert.deepStrictEqual(transactions.clampPage({ limit: 9999 }), { limit: 200, offset: 0 });
   assert.deepStrictEqual(transactions.clampPage({}), { limit: 50, offset: 0 });
   assert.deepStrictEqual(transactions.clampPage({ limit: 'abc' }), { limit: 50, offset: 0 });
   assert.ok((await transactions.list({ limit: -1 })).length <= 200, 'list respects the clamp');
});

test('list filters by status', async () => {
   assert.ok((await transactions.list({ status: 'PENDING', limit: 100 })).every((t) => t.status === 'PENDING'));
   assert.ok((await transactions.listPending()).every((t) => t.status === 'PENDING'));
});

test('listExpired finds only overdue pending rows', async () => {
   const dead = makeTrx({ payAmount: 61_001, expiresAt: new Date(Date.now() - 60_000).toISOString() });
   const alive = makeTrx({ payAmount: 61_002, expiresAt: new Date(Date.now() + 600_000).toISOString() });
   await transactions.insert(dead);
   await transactions.insert(alive);
   const ids = (await transactions.listExpired()).map((t) => t.trxId);
   assert.ok(ids.includes(dead.trxId), 'overdue row is listed');
   assert.ok(!ids.includes(alive.trxId), 'still-valid row is not');
});

test('history upserts idempotently and backfills the match', async () => {
   const seenAt = new Date().toISOString();
   await history.upsert({ gobizId: 'GB-1', amount: 52_500, matchedTrxId: 'order-9001', raw: { x: 1 }, seenAt });
   await history.upsert({ gobizId: 'GB-2', amount: 3000, matchedTrxId: null, seenAt });
   assert.deepStrictEqual((await history.list({ matched: true })).map((h) => h.gobizId), ['GB-1']);
   assert.deepStrictEqual((await history.list({ matched: false })).map((h) => h.gobizId), ['GB-2']);
   assert.deepStrictEqual((await history.list({ matched: true }))[0].raw, { x: 1 }, 'raw JSON round-trips');

   await history.upsert({ gobizId: 'GB-2', amount: 3000, matchedTrxId: 'order-late', seenAt });
   assert.strictEqual((await history.list({ matched: true })).length, 2, 'backfilled, no duplicate row');
});

test('history.seen is the pollers durable memory', async () => {
   const known = await history.seen(['GB-1', 'GB-2', 'GB-NEVER']);
   assert.ok(known.has('GB-1') && known.has('GB-2'), 'archived ids are known');
   assert.ok(!known.has('GB-NEVER'), 'unarchived id is fresh');
   assert.strictEqual((await history.seen([])).size, 0, 'empty input needs no query');
});

test('webhook queue survives a backoff window', async () => {
   const trx = makeTrx({ payAmount: 12_000, trxId: 'wh-1' });
   await transactions.insert(trx);
   await transactions.settle({ ...trx, status: 'PAID', paidAt: 'now' });

   assert.strictEqual((await webhooks.due()).find((t) => t.trxId === 'wh-1'), undefined, 'nothing owed yet');
   await webhooks.owe('wh-1');
   assert.ok((await webhooks.due()).some((t) => t.trxId === 'wh-1'), 'owed webhook is due');

   const later = new Date(Date.now() + 60_000).toISOString();
   await webhooks.markFailed('wh-1', 'ECONNREFUSED', later);
   assert.ok(!(await webhooks.due()).some((t) => t.trxId === 'wh-1'), 'not due while backing off');
   assert.strictEqual((await transactions.get('wh-1')).webhookAttempts, 1);
   assert.match((await transactions.get('wh-1')).webhookLastError, /ECONNREFUSED/);

   const afterBackoff = new Date(Date.now() + 120_000).toISOString();
   assert.ok((await webhooks.due({ now: afterBackoff })).some((t) => t.trxId === 'wh-1'),
      'due again once backoff elapses — this is what survives a cold start');
   assert.ok(!(await webhooks.due({ maxAttempts: 1, now: afterBackoff })).some((t) => t.trxId === 'wh-1'),
      'respects maxAttempts');

   await webhooks.markSent('wh-1');
   assert.ok(!(await webhooks.due({ now: afterBackoff })).some((t) => t.trxId === 'wh-1'), 'never re-sent');
   assert.strictEqual((await transactions.get('wh-1')).webhookState, 'SENT');
   assert.strictEqual((await transactions.get('wh-1')).webhookNextAt, null);
});

test('claim leases a webhook so an overlapping run cannot double-send it', async () => {
   const trx = makeTrx({ payAmount: 12_500, trxId: 'wh-lease' });
   await transactions.insert(trx);
   await transactions.settle({ ...trx, status: 'PAID', paidAt: 'now' });
   await webhooks.owe('wh-lease');

   const first = await webhooks.claim({ limit: 50 });
   assert.ok(first.some((t) => t.trxId === 'wh-lease'), 'first worker gets it');

   const second = await webhooks.claim({ limit: 50 });
   assert.ok(!second.some((t) => t.trxId === 'wh-lease'), 'concurrent worker is locked out by the lease');

   // Once the lease expires it becomes due again, so a crashed delivery retries.
   const afterLease = Date.now() + 61_000;
   const third = await webhooks.claim({ limit: 50, now: afterLease });
   assert.ok(third.some((t) => t.trxId === 'wh-lease'), 'lease expiry re-queues it');
   await webhooks.markSent('wh-lease');
});

test('replay re-queues an exhausted webhook', async () => {
   await webhooks.markFailed('wh-1', 'boom', null);
   await webhooks.owe('wh-1');
   assert.strictEqual((await transactions.get('wh-1')).webhookAttempts, 0, 'attempts reset');
   assert.strictEqual((await transactions.get('wh-1')).webhookLastError, null, 'error cleared');
   assert.ok((await transactions.counts()).webhooksOwed >= 1);
   await webhooks.markSent('wh-1');
});

const ok = await report();
await db.close();
process.exit(ok ? 0 : 1);
