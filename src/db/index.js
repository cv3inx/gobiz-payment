/**
 * Postgres access layer.
 *
 * Serverless-shaped: no long-lived state, no local files. Every function takes
 * and releases a pooled connection, so a Vercel function can be frozen between
 * invocations without leaking anything.
 *
 * The driver is chosen by env: DATABASE_URL uses `pg` against a real server,
 * otherwise tests fall back to PGlite (Postgres compiled to WASM, in-process).
 * Both expose the same `query(text, params) -> { rows }`, so there is exactly one
 * code path — no per-driver branching below this file.
 */

/** @type {{ query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }} */
let client = null;
let connecting = null;

/**
 * Force `sslmode=verify-full` on the connection string.
 *
 * `sslmode=require` currently means "verify fully" in pg, but v9 changes it to
 * libpq semantics — encrypt without verifying — which would silently downgrade
 * this connection. Saying `verify-full` outright is future-proof, and it also
 * silences pg's deprecation warning about exactly that change.
 *
 * Rewritten here rather than in DATABASE_URL because that variable is injected by
 * the Neon integration; editing it by hand would be undone the next time the
 * integration rotates credentials.
 */
export function withVerifiedSsl(raw) {
   try {
      const url = new URL(raw);
      const mode = url.searchParams.get('sslmode');
      if (mode && mode !== 'disable' && mode !== 'verify-full') {
         url.searchParams.set('sslmode', 'verify-full');
      }
      return url.toString();
   } catch {
      return raw; // not a parseable URL — hand it over untouched and let pg complain
   }
}

async function connect() {
   if (process.env.DATABASE_URL) {
      const { default: pg } = await import('pg');
      // int8 (OID 20) arrives as a string by default; every bigint we store is a
      // rupiah amount well under 2^53, so reading it as a Number is safe.
      pg.types.setTypeParser(20, Number);
      const pool = new pg.Pool({
         connectionString: withVerifiedSsl(process.env.DATABASE_URL),
         // One connection per instance. Serverless spawns many instances, so a
         // per-instance pool of 2+ multiplies into pooler exhaustion.
         // ponytail: point DATABASE_URL at a transaction-mode pooler
         // (Supabase :6543 / Neon -pooler) — that is what actually scales.
         max: 1,
         idleTimeoutMillis: 10_000,
         connectionTimeoutMillis: 10_000,
         // Verify the server certificate. This connection carries transaction rows
         // and the GoBiz access token, so encrypted-but-unauthenticated is not
         // good enough — without this, anything able to intercept the path could
         // present its own certificate.
         //
         // Belt and braces with withVerifiedSsl() above: this option wins over the
         // URL's `sslmode`, so verification holds even if that string changes.
         //
         // Managed Postgres (Neon, Supabase) serves a publicly-trusted cert, so no
         // custom CA is needed. A self-hosted server with a private CA needs
         // `ca:` here instead of turning verification off.
         ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
            ? false
            : { rejectUnauthorized: true },
      });
      return pool;
   }

   // Indirect specifier so the Nitro/rollup build cannot statically resolve it.
   // PGlite is a devDependency — it must never be pulled into the deployed bundle,
   // and this branch is unreachable in production (DATABASE_URL is required there).
   const pgliteModule = '@electric-sql/pglite';
   const { PGlite } = await import(/* @vite-ignore */ pgliteModule);
   const db = await PGlite.create(process.env.PGLITE_DIR || undefined);
   return { query: (text, params) => db.query(text, params), _pglite: db };
}

/**
 * Transport-level failures, as opposed to "your SQL was wrong".
 *
 * These happen for several unrelated reasons and none of them mean the query was
 * bad: a managed Postgres hostname resolves to several addresses and not all are
 * reachable from every network, a transaction-mode pooler recycles backends under
 * it, and a scale-to-zero instance can drop the connection that wakes it. Retrying
 * gets a live socket. Retrying a *query* error would just repeat the same error.
 */
const TRANSIENT = new Set([
   'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
   '57P01', // admin_shutdown — the pooler recycled our backend
   '57P03', // cannot_connect_now — still starting up
   '08006', '08001', '08004', // connection failure / rejected
]);

const isTransient = (e) =>
   TRANSIENT.has(e?.code) || (Array.isArray(e?.errors) && e.errors.some(isTransient));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open() {
   // Reset on failure, otherwise a single bad connect poisons every later query
   // with the same rejected promise.
   connecting ??= connect().then(
      (c) => (client = c),
      (e) => { connecting = null; throw e; },
   );
   await connecting;
}

/** Lazily open the connection, then run the query. Retries a cold/dropped link. */
export async function sql(text, params = []) {
   let lastError;
   for (let attempt = 1; attempt <= 3; attempt++) {
      try {
         if (!client) await open();
         return await client.query(text, params);
      } catch (e) {
         lastError = e;
         if (!isTransient(e)) throw e;
         // Drop the pool: its sockets are the thing that just failed.
         const dead = client;
         client = null;
         connecting = null;
         dead?.end?.().catch?.(() => {});
         if (attempt < 3) await sleep(attempt * 400);
      }
   }
   throw lastError;
}

/** First row, or null. */
export const one = async (text, params) => (await sql(text, params)).rows[0] ?? null;

/** All rows. */
export const all = async (text, params) => (await sql(text, params)).rows;

/** Rows affected by an INSERT/UPDATE/DELETE. */
export const changed = async (text, params) => {
   const res = await sql(text, params);
   return res.rowCount ?? res.affectedRows ?? 0;
};

export async function close() {
   const c = client;
   client = null;
   connecting = null;
   if (c?.end) await c.end();
   else if (c?._pglite) await c._pglite.close();
}

// ── Schema ───────────────────────────────────────────────────────────────────
// Applied by `npm run migrate` (and by tests on a fresh database). Idempotent,
// but NOT run on every cold start — DDL on each invocation would burn latency
// and race with itself.
const SCHEMA = `
   CREATE TABLE IF NOT EXISTS transactions (
      "trxId"            TEXT PRIMARY KEY,
      status             TEXT NOT NULL,
      amount             BIGINT NOT NULL,
      fee                BIGINT NOT NULL DEFAULT 0,
      total              BIGINT NOT NULL,
      "payAmount"        BIGINT NOT NULL,
      "uniqueCode"       INTEGER,
      "qrString"         TEXT NOT NULL,
      "callbackUrl"      TEXT,
      "callbackSecret"   TEXT,
      "idempotencyKey"   TEXT,
      metadata           JSONB,
      "createdAt"        TEXT NOT NULL,
      "expiresAt"        TEXT NOT NULL,
      "paidAt"           TEXT,
      entry              JSONB,
      "webhookState"     TEXT,
      "webhookAttempts"  INTEGER NOT NULL DEFAULT 0,
      "webhookNextAt"    TEXT,
      "webhookLastError" TEXT
   );

   CREATE INDEX IF NOT EXISTS idx_status ON transactions(status);
   CREATE INDEX IF NOT EXISTS idx_created ON transactions("createdAt" DESC);

   -- The match key. Two PENDING orders may never share a payable amount, or an
   -- incoming payment would be ambiguous. This index is the real guarantee;
   -- allocation just tries codes until one lands.
   CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_amount
      ON transactions("payAmount") WHERE status = 'PENDING';
   CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency
      ON transactions("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
   CREATE INDEX IF NOT EXISTS idx_webhook_due
      ON transactions("webhookNextAt") WHERE "webhookState" = 'PENDING';

   -- Pending transactions past their expiry, found by the sweep in runCycle().
   CREATE INDEX IF NOT EXISTS idx_pending_expiry
      ON transactions("expiresAt") WHERE status = 'PENDING';

   -- Incoming GoBiz transactions, archived for reconciliation. matchedTrxId links
   -- an entry to one of our orders when its amount matched a pending payment.
   CREATE TABLE IF NOT EXISTS gobiz_history (
      "gobizId"      TEXT PRIMARY KEY,
      amount         BIGINT NOT NULL,
      time           TEXT,
      "matchedTrxId" TEXT,
      raw            JSONB,
      "seenAt"       TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_hist_matched ON gobiz_history("matchedTrxId");
   CREATE INDEX IF NOT EXISTS idx_hist_seen ON gobiz_history("seenAt" DESC);

   -- Key-value: GoBiz token cache (no filesystem in serverless), login cooldown,
   -- session health, and the global poll throttle.
   CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
   );

   -- Unique-code cursor. A sequence is atomic without a transaction or lock, so
   -- two concurrent /payment/create calls can never be handed the same code.
   -- CYCLE + a huge MAXVALUE: the caller applies "% UNIQUE_CODE_MAX", so the
   -- configured ceiling can change without touching the sequence.
   CREATE SEQUENCE IF NOT EXISTS unique_code_seq AS BIGINT
      START WITH 1 INCREMENT BY 1 CYCLE MAXVALUE 9223372036854775806;
`;

export async function migrate() {
   for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await sql(statement);
   }
}
