import assert from 'node:assert';
import { createSuite, useTempEnv } from './helpers.js';

useTempEnv();
const { default: GoPayMerchant } = await import('../lib/gobiz.js');

const { test, report } = createSuite('gobiz');

/**
 * Parsing the upstream payload, tested against its real field names.
 *
 * This suite exists because of a live incident: the refund filter read `tx.status`,
 * but the analytics endpoint calls it `transaction_status`. Every row failed the
 * filter, `getHistory` always returned [], and no payment was ever reconciled — a
 * customer paid and the order stayed PENDING.
 *
 * It slipped through because every other suite fakes `getHistory` at the
 * *normalized* level, so `_normalize` — the only code that touches upstream's field
 * names — had no coverage at all. `_normalize` is pure, so testing it needs neither
 * network nor database.
 */
const merchant = new GoPayMerchant({ token: 'tok', merchantId: 'G1' });

/** A row shaped like the real /merchant-analytics response. */
const analyticsRow = (over = {}) => ({
   id: '01a03ae9-bd40-7000-813b-1ae015791f83',
   merchant_id: 'G871304384',
   order_id: 'ORD-1',
   transaction_status: 'SETTLEMENT',
   payment_type: 'QRIS',
   transaction_time: '2026-08-26T04:53:12+07:00',
   gross_amount: 501_800, // upstream reports cents
   ...over,
});

test('a settled payin is parsed, with the amount converted from cents', () => {
   const [entry] = merchant._normalize([analyticsRow()]);
   assert.ok(entry, 'the row survives the filter');
   assert.strictEqual(entry.amount, 5018, 'gross_amount / 100');
   assert.strictEqual(entry.gobizId, '01a03ae9-bd40-7000-813b-1ae015791f83');
   assert.ok(entry.time, 'formatted time');
   assert.strictEqual(entry.raw.gross_amount, 501_800, 'raw payload kept for the archive');
});

test('the status filter reads transaction_status, not status', () => {
   // The exact regression. `status` is absent from this payload, so a filter
   // reading it drops every payment and the gateway silently stops working.
   const rows = [analyticsRow()];
   assert.strictEqual(rows[0].status, undefined, 'upstream really has no `status` key');
   assert.strictEqual(merchant._normalize(rows).length, 1, 'must not be dropped');
});

test('CAPTURE counts as money arriving', () => {
   assert.strictEqual(merchant._normalize([analyticsRow({ transaction_status: 'CAPTURE' })]).length, 1);
});

test('refunds are dropped, because their gross_amount is positive too', () => {
   // A refund of 5018 would otherwise mark an order awaiting 5018 as PAID, while
   // the money was actually going out.
   for (const status of ['REFUND', 'PARTIAL_REFUND']) {
      const out = merchant._normalize([analyticsRow({ transaction_status: status })]);
      assert.strictEqual(out.length, 0, `${status} must never look like a payin`);
   }
});

test('statuses that are not yet money are dropped', () => {
   for (const status of ['PENDING', 'AUTHORIZE', 'DENY', 'EXPIRE', 'CANCEL', '']) {
      assert.strictEqual(
         merchant._normalize([analyticsRow({ transaction_status: status })]).length,
         0,
         `${status || '(empty)'} is not a settled payment`,
      );
   }
});

test('status matching is case-insensitive', () => {
   // The journal fallback returns lower-case statuses.
   assert.strictEqual(merchant._normalize([analyticsRow({ transaction_status: 'settlement' })]).length, 1);
});

test('the journal fallback shape uses `status` on a nested transaction', () => {
   // getHistory() unwraps metadata.transaction before calling _normalize, and that
   // object carries `status` rather than `transaction_status`.
   const nested = { id: 'J-1', status: 'settlement', gross_amount: 250_000, transaction_time: '2026-08-26T04:00:00+07:00' };
   const [entry] = merchant._normalize([nested]);
   assert.ok(entry, 'the fallback path still parses');
   assert.strictEqual(entry.amount, 2500);
});

test('the id falls back through transaction_id, id, then order_id', () => {
   const pick = (over) => merchant._normalize([analyticsRow(over)])[0].gobizId;
   assert.strictEqual(pick({ transaction_id: 'TXN-1' }), 'TXN-1', 'transaction_id wins');
   assert.strictEqual(pick({}), '01a03ae9-bd40-7000-813b-1ae015791f83', 'then id');
   assert.strictEqual(pick({ id: undefined }), 'ORD-1', 'then order_id');
   // Never undefined: the archive uses this as a primary key, and a null one would
   // make every payment look unseen and be reconciled again and again.
   const synthetic = pick({ id: undefined, order_id: undefined });
   assert.ok(synthetic && synthetic !== 'undefined', `got ${synthetic}`);
});

test('a non-numeric gross_amount yields NaN so the poller can skip it', () => {
   // pollOnce filters on Number.isFinite — an unparseable amount must not be
   // rounded into a real rupiah value that could match somebody's order.
   const [entry] = merchant._normalize([analyticsRow({ gross_amount: null })]);
   assert.ok(Number.isNaN(entry.amount));
});

process.exit(await report() ? 0 : 1);
