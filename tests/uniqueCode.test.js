import assert from 'node:assert';
import { createSuite, makeTrx, useTempDatabase } from './helpers.js';

const { cleanup } = useTempDatabase();
const { db } = await import('../src/db/index.js');
const transactions = await import('../src/db/transactions.js');
const { allocate, cursor, resetCursor } = await import('../src/uniqueCode.js');

const { test, report } = createSuite('uniqueCode');

const MAX = 99;
const free = () => ({ max: MAX, isTaken: () => false });
/** Allocate against the real pending-transaction state. */
const live = () => ({ max: MAX, isTaken: (amt) => !!transactions.getPendingByAmount(amt) });

test('hands out codes sequentially from 1', () => {
   resetCursor();
   assert.deepStrictEqual(
      [1, 2, 3].map(() => allocate(10_000, free()).code),
      [1, 2, 3],
   );
});

test('continues from the persisted cursor, not from 1', () => {
   resetCursor();
   allocate(10_000, free());
   allocate(10_000, free());
   assert.strictEqual(cursor(), 2, 'cursor tracks the last code');
   assert.strictEqual(allocate(20_000, free()).code, 3, 'a different base continues the sequence');
});

test('wraps from max back to 1', () => {
   resetCursor();
   for (let i = 1; i < MAX; i++) allocate(10_000, free());
   assert.strictEqual(cursor(), MAX - 1);
   assert.strictEqual(allocate(10_000, free()).code, MAX, 'reaches max');
   assert.strictEqual(allocate(10_000, free()).code, 1, 'wraps to 1');
});

test('never exceeds max', () => {
   resetCursor();
   const codes = Array.from({ length: MAX * 2 }, () => allocate(10_000, free()).code);
   assert.ok(Math.max(...codes) <= MAX, `max code ${Math.max(...codes)} <= ${MAX}`);
   assert.ok(Math.min(...codes) >= 1, 'codes start at 1');
});

test('payAmount is base + code', () => {
   resetCursor();
   const { code, payAmount } = allocate(50_000, free());
   assert.strictEqual(payAmount, 50_000 + code);
});

test('skips a code already held by a pending transaction', () => {
   resetCursor();
   // Occupy 7001 (base 7000 + code 1) with a real pending row.
   transactions.insert(makeTrx({ amount: 7000, total: 7000, payAmount: 7001, uniqueCode: 1 }));
   const { code, payAmount } = allocate(7000, live());
   assert.notStrictEqual(code, 1, 'code 1 is taken for this base');
   assert.strictEqual(payAmount, 7000 + code);
   assert.strictEqual(transactions.getPendingByAmount(payAmount), null, 'allocated amount is free');
});

test('reuses a code once its holder is no longer pending', () => {
   resetCursor();
   const trx = makeTrx({ amount: 8000, total: 8000, payAmount: 8001, uniqueCode: 1 });
   transactions.insert(trx);
   transactions.settle({ ...trx, status: 'PAID', paidAt: new Date().toISOString() });
   // 8001 is free again now that the holder is PAID
   const codes = new Set();
   for (let i = 0; i < MAX; i++) codes.add(allocate(8000, live()).code);
   assert.ok(codes.has(1), 'code 1 is available again');
});

test('throws NO_FREE_CODE when every code is in use for one base', () => {
   resetCursor();
   const base = 90_000;
   for (let code = 1; code <= MAX; code++) {
      transactions.insert(makeTrx({ amount: base, total: base, payAmount: base + code, uniqueCode: code }));
   }
   assert.throws(() => allocate(base, live()), (e) => e.code === 'NO_FREE_CODE');
   // a different base is unaffected
   assert.ok(allocate(91_000, live()).code >= 1, 'other amounts still work');
});

test('concurrent allocations never collide', () => {
   resetCursor();
   const base = 60_000;
   const seen = new Set();
   for (let i = 0; i < MAX; i++) {
      const { code, payAmount } = allocate(base, live());
      assert.ok(!seen.has(code), `code ${code} handed out twice`);
      seen.add(code);
      transactions.insert(makeTrx({ amount: base, total: base, payAmount, uniqueCode: code }));
   }
   assert.strictEqual(seen.size, MAX, 'all codes distinct');
});

const ok = report();
cleanup(db);
process.exit(ok ? 0 : 1);
