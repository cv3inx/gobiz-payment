import assert from 'node:assert';
import { createSuite, makeTrx, useTempDatabase } from './helpers.js';

const { cleanup } = useTempDatabase();
const { db } = await import('../src/db/index.js');
const transactions = await import('../src/db/transactions.js');
const history = await import('../src/db/history.js');
const webhooks = await import('../src/db/webhooks.js');

const { test, report } = createSuite('db');

test('round-trips a transaction with JSON columns', () => {
   const trx = makeTrx({ payAmount: 3001, uniqueCode: 1 });
   transactions.insert(trx);
   const got = transactions.get(trx.trxId);
   assert.strictEqual(got.payAmount, 3001);
   assert.strictEqual(got.uniqueCode, 1);
   assert.deepStrictEqual(got.metadata, { orderId: 42 });
});

test('pending-by-amount stops matching once settled', () => {
   const trx = makeTrx({ payAmount: 3100 });
   transactions.insert(trx);
   assert.ok(transactions.getPendingByAmount(3100));
   assert.strictEqual(transactions.settle({ ...trx, status: 'PAID', paidAt: 'now', entry: { t: 1 } }), true);
   assert.strictEqual(transactions.getPendingByAmount(3100), null);
   assert.deepStrictEqual(transactions.get(trx.trxId).entry, { t: 1 });
});

test('settle-once guard protects a PAID row from a late expiry', () => {
   const trx = makeTrx({ payAmount: 3200 });
   transactions.insert(trx);
   transactions.settle({ ...trx, status: 'PAID', paidAt: 'now', entry: { t: 2 } });
   assert.strictEqual(transactions.settle({ ...trx, status: 'EXPIRED' }), false, 'second settle rejected');
   assert.strictEqual(transactions.get(trx.trxId).status, 'PAID');
   assert.deepStrictEqual(transactions.get(trx.trxId).entry, { t: 2 }, 'entry not clobbered');
});

test('unique index blocks two PENDING rows at one amount', () => {
   const trx = makeTrx({ payAmount: 5000 });
   transactions.insert(trx);
   assert.throws(() => transactions.insert(makeTrx({ payAmount: 5000 })), /UNIQUE|constraint/i);
   // the partial index only covers PENDING, so a settled row frees the amount
   transactions.settle({ ...trx, status: 'PAID' });
   transactions.insert(makeTrx({ payAmount: 5000 }));
   assert.ok(transactions.getPendingByAmount(5000));
});

test('idempotency key is unique and queryable', () => {
   const trx = makeTrx({ payAmount: 8000, idempotencyKey: 'order-abc' });
   transactions.insert(trx);
   assert.strictEqual(transactions.getByIdempotencyKey('order-abc').trxId, trx.trxId);
   assert.throws(
      () => transactions.insert(makeTrx({ payAmount: 8001, idempotencyKey: 'order-abc' })),
      /UNIQUE|constraint/i,
   );
});

test('caller-supplied trxId round-trips and rejects duplicates', () => {
   transactions.insert(makeTrx({ trxId: 'order-9001', payAmount: 9001 }));
   assert.strictEqual(transactions.get('order-9001').trxId, 'order-9001');
   assert.throws(
      () => transactions.insert(makeTrx({ trxId: 'order-9001', payAmount: 9002 })),
      /UNIQUE|constraint|PRIMARY/i,
   );
});

test('pagination clamps negative and oversized values', () => {
   // SQLite reads a negative LIMIT as "unlimited" — it must never reach the query.
   assert.deepStrictEqual(transactions.clampPage({ limit: -1, offset: -5 }), { limit: 1, offset: 0 });
   assert.deepStrictEqual(transactions.clampPage({ limit: 9999 }), { limit: 200, offset: 0 });
   assert.deepStrictEqual(transactions.clampPage({}), { limit: 50, offset: 0 });
   assert.deepStrictEqual(transactions.clampPage({ limit: 'abc' }), { limit: 50, offset: 0 });
   assert.ok(transactions.list({ limit: -1 }).length <= 200, 'list respects the clamp');
});

test('list filters by status', () => {
   assert.ok(transactions.list({ status: 'PENDING', limit: 100 }).every((t) => t.status === 'PENDING'));
   assert.ok(transactions.listPending().every((t) => t.status === 'PENDING'));
});

test('pendingCodes reports codes held by pending rows only', () => {
   const trx = makeTrx({ payAmount: 41_007, uniqueCode: 7 });
   transactions.insert(trx);
   assert.ok(transactions.pendingCodes().includes(7));
   transactions.settle({ ...trx, status: 'PAID' });
   assert.ok(!transactions.pendingCodes().includes(7), 'settled code released');
});

test('history upserts idempotently and backfills the match', () => {
   const seenAt = new Date().toISOString();
   history.upsert({ gobizId: 'GB-1', amount: 52_500, matchedTrxId: 'order-9001', raw: { x: 1 }, seenAt });
   history.upsert({ gobizId: 'GB-2', amount: 3000, matchedTrxId: null, seenAt });
   assert.deepStrictEqual(history.list({ matched: true }).map((h) => h.gobizId), ['GB-1']);
   assert.deepStrictEqual(history.list({ matched: false }).map((h) => h.gobizId), ['GB-2']);
   assert.deepStrictEqual(history.list({ matched: true })[0].raw, { x: 1 }, 'raw JSON round-trips');

   history.upsert({ gobizId: 'GB-2', amount: 3000, matchedTrxId: 'order-late', seenAt });
   assert.strictEqual(history.list({ matched: true }).length, 2, 'backfilled, no duplicate row');
});

test('webhook queue survives a backoff window', () => {
   const trx = makeTrx({ payAmount: 12_000, trxId: 'wh-1' });
   transactions.insert(trx);
   transactions.settle({ ...trx, status: 'PAID', paidAt: 'now' });

   assert.strictEqual(webhooks.due().find((t) => t.trxId === 'wh-1'), undefined, 'nothing owed yet');
   webhooks.owe('wh-1');
   assert.ok(webhooks.due().some((t) => t.trxId === 'wh-1'), 'owed webhook is due');

   const later = new Date(Date.now() + 60_000).toISOString();
   webhooks.markFailed('wh-1', 'ECONNREFUSED', later);
   assert.ok(!webhooks.due().some((t) => t.trxId === 'wh-1'), 'not due while backing off');
   assert.strictEqual(transactions.get('wh-1').webhookAttempts, 1);
   assert.match(transactions.get('wh-1').webhookLastError, /ECONNREFUSED/);

   const afterBackoff = new Date(Date.now() + 120_000).toISOString();
   assert.ok(webhooks.due({ now: afterBackoff }).some((t) => t.trxId === 'wh-1'),
      'due again once backoff elapses — this is what survives a restart');
   assert.ok(!webhooks.due({ maxAttempts: 1, now: afterBackoff }).some((t) => t.trxId === 'wh-1'),
      'respects maxAttempts');

   webhooks.markSent('wh-1');
   assert.ok(!webhooks.due({ now: afterBackoff }).some((t) => t.trxId === 'wh-1'), 'never re-sent');
   assert.strictEqual(transactions.get('wh-1').webhookState, 'SENT');
   assert.strictEqual(transactions.get('wh-1').webhookNextAt, null);
});

test('replay re-queues an exhausted webhook', () => {
   webhooks.markFailed('wh-1', 'boom', null);
   webhooks.owe('wh-1');
   assert.strictEqual(transactions.get('wh-1').webhookAttempts, 0, 'attempts reset');
   assert.strictEqual(transactions.get('wh-1').webhookLastError, null, 'error cleared');
   assert.ok(transactions.counts().webhooksOwed >= 1);
   webhooks.markSent('wh-1');
});

const ok = report();
cleanup(db);
process.exit(ok ? 0 : 1);
