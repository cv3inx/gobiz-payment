import { db } from './index.js';
import { clampPage } from './transactions.js';

const stmt = {
   upsert: db.prepare(`
      INSERT INTO gobiz_history (gobizId, amount, time, matchedTrxId, raw, seenAt)
      VALUES (:gobizId, :amount, :time, :matchedTrxId, :raw, :seenAt)
      ON CONFLICT(gobizId) DO UPDATE SET
         matchedTrxId = COALESCE(excluded.matchedTrxId, gobiz_history.matchedTrxId)
   `),
   list: db.prepare(`
      SELECT * FROM gobiz_history
      WHERE (:matched IS NULL
             OR (:matched = 1 AND matchedTrxId IS NOT NULL)
             OR (:matched = 0 AND matchedTrxId IS NULL))
      ORDER BY seenAt DESC LIMIT :limit OFFSET :offset
   `),
};

/**
 * Archive an incoming GoBiz transaction. matchedTrxId links it to one of our orders.
 * Idempotent: re-seeing a gobizId backfills the match instead of duplicating the row.
 */
export function upsert({ gobizId, amount, time = null, matchedTrxId = null, raw = null, seenAt }) {
   stmt.upsert.run({
      gobizId: String(gobizId),
      amount,
      time,
      matchedTrxId,
      raw: raw != null ? JSON.stringify(raw) : null,
      seenAt,
   });
}

/** matched: true = only linked, false = only unlinked, null = all. */
export function list({ matched = null, ...page } = {}) {
   const flag = matched === null ? null : matched ? 1 : 0;
   return stmt.list.all({ matched: flag, ...clampPage(page) }).map((row) => ({
      ...row,
      raw: row.raw ? JSON.parse(row.raw) : null,
   }));
}
