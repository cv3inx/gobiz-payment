import { all } from './db/index.js';
import { nextCodes, codeCursor } from './db/meta.js';

/**
 * Sequential unique-code allocator.
 *
 * GoPay history reports only the amount of an incoming payment, so the code added
 * to `amount + fee` is the only thing that maps a payment back to one order.
 *
 * Codes come from a Postgres sequence: `nextval` is atomic without a transaction
 * or a lock, so two concurrent /payment/create calls in two different function
 * instances can never be handed the same code. They arrive in order (1, 2, 3 ...
 * max, wrapping to 1) and the cursor is durable, so a cold start continues where
 * the last one left off instead of colliding.
 *
 * Allocation is advisory, not a guarantee: the real guarantee is the partial
 * unique index on ("payAmount") WHERE status = 'PENDING'. The caller retries when
 * an insert loses a race.
 */

const noFreeCode = (message) =>
   Object.assign(new Error(message), { code: 'NO_FREE_CODE' });

/** Which of these payable amounts are already held by a PENDING transaction. */
async function takenAmounts(payAmounts) {
   const rows = await all(
      `SELECT "payAmount" FROM transactions
       WHERE status = 'PENDING' AND "payAmount" = ANY($1::bigint[])`,
      [payAmounts],
   );
   return new Set(rows.map((r) => Number(r.payAmount)));
}

/**
 * Allocate the next free code for `base`.
 *
 * Fast path is one code and one lookup — the normal, uncontended case, which is
 * also what keeps codes visibly sequential. Only when that code is already in use
 * at this base does it draw the remaining `max - 1`; consecutive `nextval`s mod
 * `max` cover every code exactly once, so failing after that genuinely means all
 * of them are taken.
 *
 * @param {number} base - amount + fee
 * @param {{ max: number }} opts
 * @returns {Promise<{ code: number, payAmount: number }>}
 * @throws {Error & { code: 'NO_FREE_CODE' }}
 */
export async function allocate(base, { max }) {
   const [first] = await nextCodes(max, 1);
   if (first != null && !(await takenAmounts([base + first])).size) {
      return { code: first, payAmount: base + first };
   }

   const rest = await nextCodes(max, max - 1);
   if (!rest.length) throw noFreeCode(`all ${max} unique codes are in use for amount ${base}`);

   const taken = await takenAmounts(rest.map((code) => base + code));
   for (const code of rest) {
      if (!taken.has(base + code)) return { code, payAmount: base + code };
   }
   throw noFreeCode(`all ${max} unique codes are in use for amount ${base}`);
}

/** Last code handed out (0 before the first allocation). */
export const cursor = (max) => codeCursor(max);
