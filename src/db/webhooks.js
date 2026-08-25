import { all, sql } from './index.js';

// Delivery state lives on the transaction row — one owed webhook per transaction.
// Persisted before the first send, so an event survives a consumer outage and the
// function instance being frozen or recycled mid-flight.
// webhookState: null = nothing to send, 'PENDING' = owed, 'SENT' = delivered.

/** How long a claimed webhook stays hidden from other workers before retrying. */
const LEASE_MS = 60_000;

const parse = (row) => ({
   ...row,
   amount: Number(row.amount),
   fee: Number(row.fee),
   total: Number(row.total),
   payAmount: Number(row.payAmount),
   uniqueCode: row.uniqueCode == null ? null : Number(row.uniqueCode),
});

/** Mark a transaction as owing a webhook. Resets the attempt counter. */
export const owe = async (trxId, nextAt = new Date().toISOString()) => {
   await sql(
      `UPDATE transactions
       SET "webhookState" = 'PENDING', "webhookAttempts" = 0,
           "webhookNextAt" = $2, "webhookLastError" = NULL
       WHERE "trxId" = $1`,
      [trxId, nextAt],
   );
};

export const markSent = async (trxId) => {
   await sql(
      `UPDATE transactions
       SET "webhookState" = 'SENT', "webhookNextAt" = NULL, "webhookLastError" = NULL,
           "webhookAttempts" = "webhookAttempts" + 1
       WHERE "trxId" = $1`,
      [trxId],
   );
};

export const markFailed = async (trxId, error, nextAt) => {
   await sql(
      `UPDATE transactions
       SET "webhookAttempts" = "webhookAttempts" + 1, "webhookNextAt" = $2,
           "webhookLastError" = $3
       WHERE "trxId" = $1`,
      [trxId, nextAt, String(error).slice(0, 500)],
   );
};

/** Read-only view of what is due. Does not claim — for /health and tests. */
export async function due({ maxAttempts = 12, limit = 20, now = new Date().toISOString() } = {}) {
   const rows = await all(
      `SELECT * FROM transactions
       WHERE "webhookState" = 'PENDING' AND "webhookAttempts" < $1
         AND ("webhookNextAt" IS NULL OR "webhookNextAt" <= $2)
       ORDER BY "webhookNextAt" LIMIT $3`,
      [maxAttempts, now, limit],
   );
   return rows.map(parse);
}

/**
 * Atomically take ownership of up to `limit` due webhooks.
 *
 * Two cycles can overlap (concurrent requests both claiming the slot), and both
 * would otherwise deliver the same event twice. A single UPDATE ... RETURNING is
 * atomic, so pushing "webhookNextAt" out to a lease makes the claimed rows stop
 * matching the other worker's "due" filter. If this instance dies mid-delivery
 * the lease simply expires and the webhook becomes due again.
 *
 * SKIP LOCKED on the inner select keeps two workers from blocking on each other
 * while the UPDATE takes its row locks.
 */
export async function claim({ maxAttempts = 12, limit = 20, now = Date.now() } = {}) {
   const nowIso = new Date(now).toISOString();
   const leaseIso = new Date(now + LEASE_MS).toISOString();
   const rows = await all(
      `UPDATE transactions SET "webhookNextAt" = $4
       WHERE "trxId" IN (
          SELECT "trxId" FROM transactions
          WHERE "webhookState" = 'PENDING' AND "webhookAttempts" < $1
            AND ("webhookNextAt" IS NULL OR "webhookNextAt" <= $2)
          ORDER BY "webhookNextAt" LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [maxAttempts, nowIso, limit, leaseIso],
   );
   return rows.map(parse);
}

export const owedCount = async () => {
   const rows = await all(
      `SELECT COUNT(*) AS n FROM transactions WHERE "webhookState" = 'PENDING'`,
   );
   return Number(rows[0].n);
};
