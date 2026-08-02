import { db } from './index.js';

// Delivery state lives on the transaction row — one owed webhook per transaction.
// Persisted before the first send, so an event survives a consumer outage and a
// gateway restart instead of dying with the process.
// webhookState: null = nothing to send, 'PENDING' = owed, 'SENT' = delivered.
const stmt = {
   owe: db.prepare(`
      UPDATE transactions
      SET webhookState = 'PENDING', webhookAttempts = 0, webhookNextAt = :nextAt,
          webhookLastError = NULL
      WHERE trxId = :trxId
   `),
   sent: db.prepare(`
      UPDATE transactions
      SET webhookState = 'SENT', webhookNextAt = NULL, webhookLastError = NULL,
          webhookAttempts = webhookAttempts + 1
      WHERE trxId = :trxId
   `),
   failed: db.prepare(`
      UPDATE transactions
      SET webhookAttempts = webhookAttempts + 1, webhookNextAt = :nextAt,
          webhookLastError = :error
      WHERE trxId = :trxId
   `),
   due: db.prepare(`
      SELECT * FROM transactions
      WHERE webhookState = 'PENDING' AND webhookAttempts < :maxAttempts
        AND (webhookNextAt IS NULL OR webhookNextAt <= :now)
      ORDER BY webhookNextAt LIMIT :limit
   `),
};

/** Mark a transaction as owing a webhook. Resets the attempt counter. */
export const owe = (trxId, nextAt = new Date().toISOString()) => void stmt.owe.run({ trxId, nextAt });

export const markSent = (trxId) => void stmt.sent.run({ trxId });

export const markFailed = (trxId, error, nextAt) =>
   void stmt.failed.run({ trxId, error: String(error).slice(0, 500), nextAt });

/** Transactions whose webhook is due for (re)delivery. */
export function due({ maxAttempts = 12, limit = 20, now = new Date().toISOString() } = {}) {
   return stmt.due.all({ maxAttempts, limit, now }).map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
   }));
}
