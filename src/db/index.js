import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'transaction.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);
// WAL: readers don't block the writer, and a crash mid-write replays on open
// instead of corrupting the file.
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

   -- Incoming GoBiz transactions, archived for reconciliation. matchedTrxId links
   -- an entry to one of our orders when its amount matched a pending payment.
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

   CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
   );
`);

// Additive migrations for databases created before a column existed.
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

for (const [column, ddl] of [
   ['webhookState', `ALTER TABLE transactions ADD COLUMN webhookState TEXT`],
   ['webhookAttempts', `ALTER TABLE transactions ADD COLUMN webhookAttempts INTEGER NOT NULL DEFAULT 0`],
   ['webhookNextAt', `ALTER TABLE transactions ADD COLUMN webhookNextAt TEXT`],
   ['webhookLastError', `ALTER TABLE transactions ADD COLUMN webhookLastError TEXT`],
   ['uniqueCode', `ALTER TABLE transactions ADD COLUMN uniqueCode INTEGER`],
   ['callbackSecret', `ALTER TABLE transactions ADD COLUMN callbackSecret TEXT`],
]) {
   if (!columns('transactions').includes(column)) db.exec(ddl);
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_due
   ON transactions(webhookNextAt) WHERE webhookState = 'PENDING'`);

export function close() {
   db.close();
}
