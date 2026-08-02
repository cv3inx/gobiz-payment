import { db } from './index.js';

const COLUMNS = `trxId, status, amount, fee, total, payAmount, uniqueCode, qrString,
   callbackUrl, callbackSecret, idempotencyKey, metadata, createdAt, expiresAt, paidAt, entry`;

const stmt = {
   insert: db.prepare(`
      INSERT INTO transactions (${COLUMNS})
      VALUES (:trxId, :status, :amount, :fee, :total, :payAmount, :uniqueCode, :qrString,
              :callbackUrl, :callbackSecret, :idempotencyKey, :metadata, :createdAt,
              :expiresAt, :paidAt, :entry)
   `),
   get: db.prepare(`SELECT * FROM transactions WHERE trxId = ?`),
   byAmount: db.prepare(`SELECT * FROM transactions WHERE payAmount = ? AND status = 'PENDING'`),
   byIdempotency: db.prepare(`SELECT * FROM transactions WHERE idempotencyKey = ?`),
   pending: db.prepare(`SELECT * FROM transactions WHERE status = 'PENDING'`),
   pendingCodes: db.prepare(`SELECT uniqueCode FROM transactions WHERE status = 'PENDING'`),
   list: db.prepare(`
      SELECT * FROM transactions
      WHERE (:status IS NULL OR status = :status)
      ORDER BY createdAt DESC LIMIT :limit OFFSET :offset
   `),
   // Guarded on PENDING: a transaction leaves PENDING exactly once, so a late
   // expiry timer can never overwrite a PAID row (or vice versa).
   settle: db.prepare(`
      UPDATE transactions SET status = :status, paidAt = :paidAt, entry = :entry
      WHERE trxId = :trxId AND status = 'PENDING'
   `),
   counts: db.prepare(`
      SELECT
         (SELECT COUNT(*) FROM transactions WHERE status = 'PENDING') AS pending,
         (SELECT COUNT(*) FROM transactions) AS total,
         (SELECT COUNT(*) FROM transactions WHERE webhookState = 'PENDING') AS webhooksOwed
   `),
};

const parse = (row) => (row ? {
   ...row,
   metadata: row.metadata ? JSON.parse(row.metadata) : null,
   entry: row.entry ? JSON.parse(row.entry) : null,
} : null);

/**
 * Clamp pagination. SQLite treats a NEGATIVE limit as "no limit", so an
 * unclamped `?limit=-1` would dump the whole table.
 */
export function clampPage({ limit, offset } = {}) {
   return {
      limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
      offset: Math.max(parseInt(offset, 10) || 0, 0),
   };
}

export function insert(trx) {
   stmt.insert.run({
      ...trx,
      fee: trx.fee ?? 0,
      uniqueCode: trx.uniqueCode ?? null,
      callbackUrl: trx.callbackUrl ?? null,
      callbackSecret: trx.callbackSecret ?? null,
      idempotencyKey: trx.idempotencyKey ?? null,
      metadata: trx.metadata != null ? JSON.stringify(trx.metadata) : null,
      paidAt: trx.paidAt ?? null,
      entry: trx.entry != null ? JSON.stringify(trx.entry) : null,
   });
}

export const get = (trxId) => parse(stmt.get.get(trxId));
export const getPendingByAmount = (payAmount) => parse(stmt.byAmount.get(payAmount));
export const getByIdempotencyKey = (key) => parse(stmt.byIdempotency.get(key));
export const listPending = () => stmt.pending.all().map(parse);
export const counts = () => stmt.counts.get();

/** Unique codes currently held by pending transactions. */
export const pendingCodes = () =>
   stmt.pendingCodes.all().map((r) => r.uniqueCode).filter((c) => c != null);

export function list({ status = null, ...page } = {}) {
   return stmt.list.all({ status, ...clampPage(page) }).map(parse);
}

/** Settle a PENDING transaction. Returns false if it was already settled. */
export function settle(trx) {
   const { changes } = stmt.settle.run({
      trxId: trx.trxId,
      status: trx.status,
      paidAt: trx.paidAt ?? null,
      entry: trx.entry != null ? JSON.stringify(trx.entry) : null,
   });
   return changes > 0;
}
