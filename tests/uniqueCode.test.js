import assert from 'node:assert';
import { createSuite, makeTrx, setupDatabase, useTempEnv } from './helpers.js';

useTempEnv();
const db = await setupDatabase();
const transactions = await import('../src/db/transactions.js');
const { allocate, cursor } = await import('../src/uniqueCode.js');

const { test, report } = createSuite('uniqueCode');

const MAX = 99;
/** The cursor is a Postgres sequence; rewind it so each case starts at 1. */
const resetCursor = () => db.sql(`ALTER SEQUENCE unique_code_seq RESTART WITH 1`);

test('hands out codes sequentially from 1', async () => {
   await resetCursor();
   const codes = [];
   for (let i = 0; i < 3; i++) codes.push((await allocate(10_000, { max: MAX })).code);
   assert.deepStrictEqual(codes, [1, 2, 3]);
});

test('continues from the persisted cursor, not from 1', async () => {
   await resetCursor();
   await allocate(10_000, { max: MAX });
   await allocate(10_000, { max: MAX });
   assert.strictEqual(await cursor(MAX), 2, 'cursor tracks the last code');
   assert.strictEqual((await allocate(20_000, { max: MAX })).code, 3, 'a different base continues the sequence');
});

test('wraps from max back to 1', async () => {
   await resetCursor();
   for (let i = 1; i < MAX; i++) await allocate(10_000, { max: MAX });
   assert.strictEqual(await cursor(MAX), MAX - 1);
   assert.strictEqual((await allocate(10_000, { max: MAX })).code, MAX, 'reaches max');
   assert.strictEqual((await allocate(10_000, { max: MAX })).code, 1, 'wraps to 1');
});

test('never exceeds max', async () => {
   await resetCursor();
   const codes = [];
   for (let i = 0; i < MAX * 2; i++) codes.push((await allocate(10_000, { max: MAX })).code);
   assert.ok(Math.max(...codes) <= MAX, `max code ${Math.max(...codes)} <= ${MAX}`);
   assert.ok(Math.min(...codes) >= 1, 'codes start at 1');
});

test('payAmount is base + code', async () => {
   await resetCursor();
   const { code, payAmount } = await allocate(50_000, { max: MAX });
   assert.strictEqual(payAmount, 50_000 + code);
});

test('skips a code already held by a pending transaction', async () => {
   await resetCursor();
   // Occupy 7001 (base 7000 + code 1) with a real pending row.
   await transactions.insert(makeTrx({ amount: 7000, total: 7000, payAmount: 7001, uniqueCode: 1 }));
   const { code, payAmount } = await allocate(7000, { max: MAX });
   assert.notStrictEqual(code, 1, 'code 1 is taken for this base');
   assert.strictEqual(payAmount, 7000 + code);
   assert.strictEqual(await transactions.getPendingByAmount(payAmount), null, 'allocated amount is free');
});

test('reuses a code once its holder is no longer pending', async () => {
   await resetCursor();
   const trx = makeTrx({ amount: 8000, total: 8000, payAmount: 8001, uniqueCode: 1 });
   await transactions.insert(trx);
   await transactions.settle({ ...trx, status: 'PAID', paidAt: new Date().toISOString() });
   // 8001 is free again now that the holder is PAID
   const codes = new Set();
   for (let i = 0; i < MAX; i++) codes.add((await allocate(8000, { max: MAX })).code);
   assert.ok(codes.has(1), 'code 1 is available again');
});

test('throws NO_FREE_CODE when every code is in use for one base', async () => {
   await resetCursor();
   const base = 90_000;
   for (let code = 1; code <= MAX; code++) {
      await transactions.insert(makeTrx({ amount: base, total: base, payAmount: base + code, uniqueCode: code }));
   }
   await assert.rejects(() => allocate(base, { max: MAX }), (e) => e.code === 'NO_FREE_CODE');
   // a different base is unaffected
   assert.ok((await allocate(91_000, { max: MAX })).code >= 1, 'other amounts still work');
});

test('allocations never collide even under a contended base', async () => {
   await resetCursor();
   const base = 60_000;
   const seen = new Set();
   for (let i = 0; i < MAX; i++) {
      const { code, payAmount } = await allocate(base, { max: MAX });
      assert.ok(!seen.has(code), `code ${code} handed out twice`);
      seen.add(code);
      await transactions.insert(makeTrx({ amount: base, total: base, payAmount, uniqueCode: code }));
   }
   assert.strictEqual(seen.size, MAX, 'all codes distinct');
});

test('concurrent allocations get distinct codes', async () => {
   await resetCursor();
   // nextval is atomic without a lock — this is what replaces the old SQLite
   // IMMEDIATE transaction now that two instances can allocate at once.
   const results = await Promise.all(
      Array.from({ length: 20 }, () => allocate(70_000, { max: MAX })),
   );
   const codes = results.map((r) => r.code);
   assert.strictEqual(new Set(codes).size, codes.length, `duplicate code in ${codes.join(',')}`);
});

const ok = await report();
await db.close();
process.exit(ok ? 0 : 1);
