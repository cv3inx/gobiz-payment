import * as meta from './db/meta.js';
import * as transactions from './db/transactions.js';

const CURSOR_KEY = 'uniqueCode.cursor';

/**
 * Sequential unique-code allocator.
 *
 * GoPay history reports only the amount of an incoming payment, so the code added
 * to `amount + fee` is the only thing that maps a payment back to one order.
 * Codes are handed out in order (1, 2, 3 ... max) and wrap back to 1, skipping any
 * code still held by a pending transaction at the same base amount. The cursor is
 * persisted, so a restart continues where it left off instead of colliding.
 */

/** Codes in use for this base amount, so two pending orders never share one. */
function takenFor(base, isTaken) {
   const taken = new Set();
   for (const code of transactions.pendingCodes()) {
      if (isTaken(base + code)) taken.add(code);
   }
   return taken;
}

/**
 * Allocate the next free code for `base`.
 * @param {number} base - amount + fee
 * @param {object} opts
 * @param {number} opts.max - highest code to hand out before wrapping
 * @param {(payAmount: number) => boolean} opts.isTaken - is this payable amount in use?
 * @returns {{ code: number, payAmount: number }}
 * @throws if every code from 1..max is already in use for this base amount
 */
export function allocate(base, { max, isTaken }) {
   // IMMEDIATE so two concurrent /payment/create calls can't read the same cursor
   // and hand out the same code.
   return meta.transact(() => {
      const taken = takenFor(base, isTaken);
      if (taken.size >= max) {
         throw Object.assign(
            new Error(`all ${max} unique codes are in use for amount ${base}`),
            { code: 'NO_FREE_CODE' },
         );
      }

      const last = meta.getInt(CURSOR_KEY, 0);
      for (let step = 1; step <= max; step++) {
         const candidate = ((last + step - 1) % max) + 1; // wraps max -> 1
         if (taken.has(candidate)) continue;
         const payAmount = base + candidate;
         if (isTaken(payAmount)) continue;
         meta.set(CURSOR_KEY, candidate);
         return { code: candidate, payAmount };
      }
      throw Object.assign(
         new Error(`no free unique code near ${base}`),
         { code: 'NO_FREE_CODE' },
      );
   });
}

/** Last code handed out (0 before the first allocation). */
export const cursor = () => meta.getInt(CURSOR_KEY, 0);

/** Reset the cursor. Test helper. */
export const resetCursor = () => meta.set(CURSOR_KEY, 0);
