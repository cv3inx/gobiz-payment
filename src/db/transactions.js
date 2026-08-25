import { all, one, changed } from './index.js';

const COLS = `"trxId", status, amount, fee, total, "payAmount", "uniqueCode", "qrString",
   "callbackUrl", "callbackSecret", "idempotencyKey", metadata, "createdAt", "expiresAt",
   "paidAt", entry`;

/**
 * Rupiah columns are BIGINT so `amount + fee + code` can exceed INT4 without
 * overflowing. Coerce here so callers always see plain numbers regardless of how
 * the driver decodes int8.
 */
const parse = (row) => (row ? {
   ...row,
   amount: Number(row.amount),
   fee: Number(row.fee),
   total: Number(row.total),
   payAmount: Number(row.payAmount),
   uniqueCode: row.uniqueCode == null ? null : Number(row.uniqueCode),
} : null);

/**
 * Clamp pagination so a caller cannot ask for the whole table.
 */
export function clampPage({ limit, offset } = {}) {
   return {
      limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
      offset: Math.max(parseInt(offset, 10) || 0, 0),
   };
}

/**
 * Insert a transaction. Rejects with a PG unique-violation (code 23505) when the
 * payable amount, idempotency key, or trxId is already taken.
 */
export async function insert(trx) {
   await one(
      `INSERT INTO transactions (${COLS}) VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING "trxId"`,
      [
         trx.trxId, trx.status, trx.amount, trx.fee ?? 0, trx.total, trx.payAmount,
         trx.uniqueCode ?? null, trx.qrString, trx.callbackUrl ?? null,
         trx.callbackSecret ?? null, trx.idempotencyKey ?? null,
         trx.metadata != null ? JSON.stringify(trx.metadata) : null,
         trx.createdAt, trx.expiresAt, trx.paidAt ?? null,
         trx.entry != null ? JSON.stringify(trx.entry) : null,
      ],
   );
}

export const get = async (trxId) =>
   parse(await one(`SELECT * FROM transactions WHERE "trxId" = $1`, [trxId]));

export const getPendingByAmount = async (payAmount) =>
   parse(await one(
      `SELECT * FROM transactions WHERE "payAmount" = $1 AND status = 'PENDING'`,
      [payAmount],
   ));

export const getByIdempotencyKey = async (key) =>
   parse(await one(`SELECT * FROM transactions WHERE "idempotencyKey" = $1`, [key]));

export const listPending = async () =>
   (await all(`SELECT * FROM transactions WHERE status = 'PENDING'`)).map(parse);

/** PENDING transactions already past their expiry — the cron sweep's work list. */
export const listExpired = async (now = new Date().toISOString(), limit = 500) =>
   (await all(
      `SELECT * FROM transactions WHERE status = 'PENDING' AND "expiresAt" <= $1
       ORDER BY "expiresAt" LIMIT $2`,
      [now, limit],
   )).map(parse);

export async function list({ status = null, ...page } = {}) {
   const { limit, offset } = clampPage(page);
   const rows = await all(
      `SELECT * FROM transactions
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset],
   );
   return rows.map(parse);
}

/**
 * Settle a PENDING transaction. Returns false if it was already settled — the
 * `status = 'PENDING'` guard means a transaction leaves PENDING exactly once, so
 * a payment landing as the expiry sweep runs can never double-notify.
 */
export async function settle(trx) {
   return await changed(
      `UPDATE transactions SET status = $2, "paidAt" = $3, entry = $4
       WHERE "trxId" = $1 AND status = 'PENDING'`,
      [
         trx.trxId,
         trx.status,
         trx.paidAt ?? null,
         trx.entry != null ? JSON.stringify(trx.entry) : null,
      ],
   ) > 0;
}

export const counts = async () => {
   const row = await one(`
      SELECT
         (SELECT COUNT(*) FROM transactions WHERE status = 'PENDING')            AS pending,
         (SELECT COUNT(*) FROM transactions)                                     AS total,
         (SELECT COUNT(*) FROM transactions WHERE "webhookState" = 'PENDING')    AS "webhooksOwed"
   `);
   return {
      pending: Number(row.pending),
      total: Number(row.total),
      webhooksOwed: Number(row.webhooksOwed),
   };
};
