import crypto from 'node:crypto';

/**
 * Point the modules under test at a throwaway database.
 *
 * With no DATABASE_URL the db layer falls back to PGlite — real Postgres compiled
 * to WASM, in-process — so the suite runs offline against the same SQL the
 * deployment uses. Set TEST_DATABASE_URL to run it against a real server instead.
 *
 * MUST run before any `src/db/*` import, since the driver is chosen on first query.
 */
export function useTempEnv(env = {}) {
   if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
   else delete process.env.DATABASE_URL;

   process.env.QRIS_STRING ??= '00020101021126001180002ID5802ID540520006304ABCD';
   process.env.WEBHOOK_SECRET ??= 'test-secret';

   delete process.env.VERCEL;
   Object.assign(process.env, env);
}

/** Apply the schema to the (fresh) test database. */
export async function setupDatabase() {
   const db = await import('../src/db/index.js');
   await db.migrate();
   return db;
}

export function makeTrx(overrides = {}) {
   const base = 2000;
   return {
      trxId: `TRX-${crypto.randomUUID().slice(0, 12)}`,
      status: 'PENDING',
      amount: base,
      fee: 0,
      total: base,
      payAmount: base + 1,
      uniqueCode: 1,
      qrString: 'qris',
      callbackUrl: null,
      callbackSecret: null,
      idempotencyKey: null,
      metadata: { orderId: 42 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      paidAt: null,
      entry: null,
      ...overrides,
   };
}

/**
 * Minimal test runner: collects failures so one bad case doesn't hide the rest.
 * `test` accepts async functions — every DB call is a promise now.
 */
export function createSuite(title) {
   const failures = [];
   const queued = [];
   let passed = 0;

   // Queued, not started: these cases share one database, so running them
   // concurrently would have them trample each other's rows.
   const test = (name, fn) => queued.push({ name, fn });

   const report = async () => {
      for (const { name, fn } of queued) {
         try {
            await fn();
            passed++;
         } catch (e) {
            failures.push({ name, message: e.message });
         }
      }
      for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
      const status = failures.length ? 'FAIL' : 'OK';
      console.log(`${status}: ${title} — ${passed} passed, ${failures.length} failed`);
      return failures.length === 0;
   };

   return { test, report };
}
