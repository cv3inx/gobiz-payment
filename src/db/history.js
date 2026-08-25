import { all, sql } from './index.js';
import { clampPage } from './transactions.js';

/**
 * Archive an incoming GoBiz transaction. matchedTrxId links it to one of our orders.
 * Idempotent: re-seeing a gobizId backfills the match instead of duplicating the row.
 *
 * This table doubles as the watcher's memory. Serverless has no in-process Set of
 * seen ids, so "have I already reconciled this payment?" is answered by the
 * gobizId primary key — see `seen()`.
 */
export async function upsert({ gobizId, amount, time = null, matchedTrxId = null, raw = null, seenAt }) {
   await sql(
      `INSERT INTO gobiz_history ("gobizId", amount, time, "matchedTrxId", raw, "seenAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT ("gobizId") DO UPDATE SET
          "matchedTrxId" = COALESCE(excluded."matchedTrxId", gobiz_history."matchedTrxId")`,
      [
         String(gobizId), amount, time, matchedTrxId,
         raw != null ? JSON.stringify(raw) : null, seenAt,
      ],
   );
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
