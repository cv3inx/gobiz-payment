import { all, one, sql, changed } from './index.js';
import { clampPage } from './transactions.js';

/**
 * Archive an incoming GoBiz transaction, unlinked. Returns false if this gobizId
 * is already archived.
 *
 * This table doubles as the watcher's memory. Serverless has no in-process Set of
 * seen ids, so "have I already reconciled this payment?" is answered by the
 * gobizId primary key — see `seen()`. The false return is what lets the
 * reconciler claim a payment before it touches any order: of two overlapping
 * cycles that both saw it as fresh, only the one whose insert landed goes on.
 */
export async function claim({ gobizId, amount, time = null, raw = null, seenAt }) {
   return await changed(
      `INSERT INTO gobiz_history ("gobizId", amount, time, raw, "seenAt")
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT ("gobizId") DO NOTHING`,
      [String(gobizId), amount, time, raw != null ? JSON.stringify(raw) : null, seenAt],
   ) > 0;
}

/**
 * Which of these gobizIds have already been archived. One round trip instead of
 * one per id, since the poller checks a whole page at a time.
 */
export async function seen(gobizIds) {
   if (!gobizIds.length) return new Set();
   const rows = await all(
      `SELECT "gobizId" FROM gobiz_history WHERE "gobizId" = ANY($1::text[])`,
      [gobizIds.map(String)],
   );
   return new Set(rows.map((r) => r.gobizId));
}

export async function getById(gobizId) {
   const row = await one(`SELECT * FROM gobiz_history WHERE "gobizId" = $1`, [String(gobizId)]);
   return row ? { ...row, amount: Number(row.amount) } : null;
}

/**
 * Attach an order to an archived payment, but only if nothing is attached yet.
 *
 * The `IS NULL` guard is what stops two operators (or a double-click) from
 * pointing the same incoming payment at two different orders.
 *
 * @returns {Promise<boolean>} false if it was already linked
 */
export async function linkIfUnmatched(gobizId, trxId) {
   return await changed(
      `UPDATE gobiz_history SET "matchedTrxId" = $2
       WHERE "gobizId" = $1 AND "matchedTrxId" IS NULL`,
      [String(gobizId), trxId],
   ) > 0;
}

/** Undo `linkIfUnmatched`, but only the link to this trxId. */
export async function unlink(gobizId, trxId) {
   await sql(
      `UPDATE gobiz_history SET "matchedTrxId" = NULL
       WHERE "gobizId" = $1 AND "matchedTrxId" = $2`,
      [String(gobizId), trxId],
   );
}

/** matched: true = only linked, false = only unlinked, null = all. */
export async function list({ matched = null, ...page } = {}) {
   const { limit, offset } = clampPage(page);
   const rows = await all(
      `SELECT * FROM gobiz_history
       WHERE ($1::boolean IS NULL
              OR ($1 = true  AND "matchedTrxId" IS NOT NULL)
              OR ($1 = false AND "matchedTrxId" IS NULL))
       ORDER BY "seenAt" DESC LIMIT $2 OFFSET $3`,
      [matched, limit, offset],
   );
   return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}
