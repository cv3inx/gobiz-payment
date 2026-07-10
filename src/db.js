// SQLite persistence via better-sqlite3 (synchronous, stable native binding).
// ponytail: one table, JSON columns for metadata. Add indexes/migrations when
// the schema actually changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'transaction.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
// WAL mode: readers don't block the writer, and a crash/restart mid-write won't
// corrupt the DB (journal replays on open). Creates -wal and -shm sidecar files.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
   CREATE TABLE IF NOT EXISTS transactions (
      trxId          TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      amount         INTEGER NOT NULL,
      fee            INTEGER NOT NULL DEFAULT 0,
      total          INTEGER NOT NULL,
      payAmount      INTEGER NOT NULL,
      qrString       TEXT NOT NULL,
      callbackUrl    TEXT,
      idempotencyKey TEXT,
      metadata       TEXT,
      createdAt      TEXT NOT NULL,
      expiresAt      TEXT NOT NULL,
      paidAt         TEXT,
      entry          TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_status ON transactions(status);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_amount
      ON transactions(payAmount) WHERE status = 'PENDING';
   CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency
      ON transactions(idempotencyKey) WHERE idempotencyKey IS NOT NULL;

   -- Mirror of incoming GoBiz transactions (archive + reconciliation).
   -- gobizId is GoBiz's own transaction id; matchedTrxId links to our order
   -- (transactions.trxId) when the amount matches a pending payment.
   CREATE TABLE IF NOT EXISTS gobiz_history (
      gobizId      TEXT PRIMARY KEY,
      amount       INTEGER NOT NULL,
      time         TEXT,
      matchedTrxId TEXT,
      raw          TEXT,
      seenAt       TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_hist_matched ON gobiz_history(matchedTrxId);
   CREATE INDEX IF NOT EXISTS idx_hist_seen ON gobiz_history(seenAt);
`);

const stmtInsert = db.prepare(`
   INSERT INTO transactions
      (trxId, status, amount, fee, total, payAmount, qrString, callbackUrl, idempotencyKey, metadata, createdAt, expiresAt, paidAt, entry)
   VALUES
      (:trxId, :status, :amount, :fee, :total, :payAmount, :qrString, :callbackUrl, :idempotencyKey, :metadata, :createdAt, :expiresAt, :paidAt, :entry)
`);
const stmtGet = db.prepare(`SELECT * FROM transactions WHERE trxId = ?`);
const stmtByAmount = db.prepare(`SELECT * FROM transactions WHERE payAmount = ? AND status = 'PENDING'`);
const stmtByIdem = db.prepare(`SELECT * FROM transactions WHERE idempotencyKey = ?`);
const stmtPending = db.prepare(`SELECT * FROM transactions WHERE status = 'PENDING'`);
const stmtList = db.prepare(`
   SELECT * FROM transactions
   WHERE (:status IS NULL OR status = :status)
   ORDER BY createdAt DESC LIMIT :limit OFFSET :offset
`);
const stmtUpdate = db.prepare(`
   UPDATE transactions SET status = :status, paidAt = :paidAt, entry = :entry WHERE trxId = :trxId
`);
const stmtCounts = db.prepare(`
   SELECT
      (SELECT COUNT(*) FROM transactions WHERE status = 'PENDING') AS pending,
      (SELECT COUNT(*) FROM transactions) AS total
`);

// gobiz_history statements
const stmtHistUpsert = db.prepare(`
   INSERT INTO gobiz_history (gobizId, amount, time, matchedTrxId, raw, seenAt)
   VALUES (:gobizId, :amount, :time, :matchedTrxId, :raw, :seenAt)
   ON CONFLICT(gobizId) DO UPDATE SET
      matchedTrxId = COALESCE(excluded.matchedTrxId, gobiz_history.matchedTrxId)
`);
const stmtHistExists = db.prepare(`SELECT 1 FROM gobiz_history WHERE gobizId = ?`);
const stmtHistList = db.prepare(`
   SELECT * FROM gobiz_history
   WHERE (:matched IS NULL
          OR (:matched = 1 AND matchedTrxId IS NOT NULL)
          OR (:matched = 0 AND matchedTrxId IS NULL))
   ORDER BY seenAt DESC LIMIT :limit OFFSET :offset
`);

function rowToTrx(row) {
   if (!row) return null;
   return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      entry: row.entry ? JSON.parse(row.entry) : null,
   };
}

export function insertTrx(trx) {
   stmtInsert.run({
      trxId: trx.trxId,
      status: trx.status,
      amount: trx.amount,
      fee: trx.fee ?? 0,
      total: trx.total,
      payAmount: trx.payAmount,
      qrString: trx.qrString,
      callbackUrl: trx.callbackUrl ?? null,
      idempotencyKey: trx.idempotencyKey ?? null,
      metadata: trx.metadata != null ? JSON.stringify(trx.metadata) : null,
      createdAt: trx.createdAt,
      expiresAt: trx.expiresAt,
      paidAt: trx.paidAt ?? null,
      entry: trx.entry != null ? JSON.stringify(trx.entry) : null,
   });
}

export function getTrx(trxId) {
   return rowToTrx(stmtGet.get(trxId));
}

export function getPendingByAmount(payAmount) {
   return rowToTrx(stmtByAmount.get(payAmount));
}

export function getByIdempotencyKey(key) {
   return rowToTrx(stmtByIdem.get(key));
}

export function listPending() {
   return stmtPending.all().map(rowToTrx);
}

export function listTrx({ status = null, limit = 50, offset = 0 } = {}) {
   return stmtList.all({ status, limit, offset }).map(rowToTrx);
}

export function updateStatus(trx) {
   stmtUpdate.run({
      trxId: trx.trxId,
      status: trx.status,
      paidAt: trx.paidAt ?? null,
      entry: trx.entry != null ? JSON.stringify(trx.entry) : null,
   });
}

export function counts() {
   return stmtCounts.get();
}

// ── GoBiz history (archive + reconciliation) ─────────────────────────────────
/** True if this GoBiz transaction id was already archived. */
export function historyExists(gobizId) {
   return !!stmtHistExists.get(gobizId);
}

/** Upsert an incoming GoBiz transaction. matchedTrxId links it to our order. */
export function upsertHistory({ gobizId, amount, time, matchedTrxId = null, raw = null, seenAt }) {
   stmtHistUpsert.run({
      gobizId: String(gobizId),
      amount,
      time: time ?? null,
      matchedTrxId,
      raw: raw != null ? JSON.stringify(raw) : null,
      seenAt,
   });
}

/** List archived GoBiz transactions. matched: true=only linked, false=only unlinked, null=all. */
export function listHistory({ matched = null, limit = 50, offset = 0 } = {}) {
   const m = matched === null ? null : matched ? 1 : 0;
   return stmtHistList.all({ matched: m, limit, offset }).map((row) => ({
      ...row,
      raw: row.raw ? JSON.parse(row.raw) : null,
   }));
}

export default db;
