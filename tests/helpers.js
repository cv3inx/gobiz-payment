import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point the modules under test at a throwaway database. MUST run before any
 * `src/db/*` import, since the connection is opened at module load.
 */
export function useTempDatabase(env = {}) {
   const file = path.join(os.tmpdir(), `gobiz-test-${crypto.randomUUID()}.db`);
   process.env.DB_FILE = file;
   process.env.QRIS_STRING ??= '00020101021126001180002ID5802ID540520006304ABCD';
   process.env.WEBHOOK_SECRET ??= 'test-secret';
   Object.assign(process.env, env);

   return {
      file,
      cleanup: (db) => {
         try { db?.close(); } catch {}
         for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
      },
   };
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
      idempotencyKey: null,
      metadata: { orderId: 42 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      paidAt: null,
      entry: null,
      ...overrides,
   };
}

/** Minimal test runner: collects failures so one bad case doesn't hide the rest. */
export function createSuite(title) {
   const failures = [];
   let passed = 0;

   const test = (name, fn) => {
      try {
         fn();
         passed++;
      } catch (e) {
         failures.push({ name, message: e.message });
      }
   };

   const report = () => {
      for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
      const status = failures.length ? 'FAIL' : 'OK';
      console.log(`${status}: ${title} — ${passed} passed, ${failures.length} failed`);
      return failures.length === 0;
   };

   return { test, report };
}
