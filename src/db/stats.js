import { all, one } from './index.js';

/**
 * Aggregates for the admin dashboard.
 *
 * `createdAt` / `paidAt` are ISO-8601 UTC strings, so `substr(...,1,10)` is the
 * calendar day and lexical comparison is chronological — no timestamp casting
 * needed to slice by date.
 */

const day = (offsetDays) =>
   new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Headline totals: counts per status plus paid volume over rolling windows. */
export async function summary() {
   const row = await one(`
      SELECT
         COUNT(*)                                                     AS total,
         COUNT(*) FILTER (WHERE status = 'PENDING')                    AS pending,
         COUNT(*) FILTER (WHERE status = 'PAID')                       AS paid,
         COUNT(*) FILTER (WHERE status = 'EXPIRED')                    AS expired,
         COUNT(*) FILTER (WHERE "webhookState" = 'PENDING')            AS "webhooksOwed",
         COUNT(*) FILTER (WHERE "webhookState" = 'PENDING'
                            AND "webhookAttempts" >= $1)               AS "webhooksStuck",
         COALESCE(SUM(amount + fee) FILTER (WHERE status = 'PAID'), 0)  AS "revenueAll",
         COALESCE(SUM(amount + fee) FILTER (
            WHERE status = 'PAID' AND substr("paidAt", 1, 10) = $2), 0) AS "revenueToday",
         COALESCE(SUM(amount + fee) FILTER (
            WHERE status = 'PAID' AND substr("paidAt", 1, 10) >= $3), 0) AS "revenue7d",
         COALESCE(SUM(amount + fee) FILTER (
            WHERE status = 'PAID' AND substr("paidAt", 1, 10) >= $4), 0) AS "revenue30d"
      FROM transactions
   `, [12, day(0), day(6), day(29)]);

   const orphans = await one(`
      SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS value
      FROM gobiz_history WHERE "matchedTrxId" IS NULL
   `);

   return {
      total: Number(row.total),
      pending: Number(row.pending),
      paid: Number(row.paid),
      expired: Number(row.expired),
      webhooksOwed: Number(row.webhooksOwed),
      webhooksStuck: Number(row.webhooksStuck),
      revenueAll: Number(row.revenueAll),
      revenueToday: Number(row.revenueToday),
      revenue7d: Number(row.revenue7d),
      revenue30d: Number(row.revenue30d),
      unmatchedPayments: Number(orphans.n),
      unmatchedValue: Number(orphans.value),
      // Of everything that stopped being PENDING, how much actually got paid.
      conversionRate: Number(row.paid) + Number(row.expired) > 0
         ? Number(row.paid) / (Number(row.paid) + Number(row.expired))
         : null,
   };
}

/** Per-day series for the dashboard chart. Days with no activity are filled in. */
export async function daily(days = 14) {
   const from = day(days - 1);
   const rows = await all(`
      SELECT substr("createdAt", 1, 10)                          AS day,
             COUNT(*)                                            AS created,
             COUNT(*) FILTER (WHERE status = 'PAID')             AS paid,
             COUNT(*) FILTER (WHERE status = 'EXPIRED')          AS expired,
             COALESCE(SUM(amount + fee) FILTER (WHERE status = 'PAID'), 0) AS revenue
      FROM transactions
      WHERE substr("createdAt", 1, 10) >= $1
      GROUP BY 1 ORDER BY 1
   `, [from]);

   const byDay = new Map(rows.map((r) => [r.day, r]));
   return Array.from({ length: days }, (_, i) => {
      const d = day(days - 1 - i);
      const r = byDay.get(d);
      return {
         day: d,
         created: Number(r?.created ?? 0),
         paid: Number(r?.paid ?? 0),
         expired: Number(r?.expired ?? 0),
         revenue: Number(r?.revenue ?? 0),
      };
   });
}
