import assert from 'node:assert';
import { createSuite, setupDatabase, useTempEnv } from './helpers.js';

useTempEnv();
const db = await setupDatabase();
const { check, sessionHealth } = await import('../src/services/session.js');

const { test, report } = createSuite('session');

/** Stand-in for GoPayMerchant with just the surface the checker touches. */
function fakeMerchant({ tokenValid = true, initFails = false } = {}) {
   return {
      token: 'tok',
      _initialized: true,
      initCalls: 0,
      _isTokenValid: async () => tokenValid,
      init: async function () {
         this.initCalls++;
         if (initFails) throw new Error('Login di-cooldown 900s');
         this._initialized = true;
      },
   };
}

test('a valid token passes without re-authenticating', async () => {
   const m = fakeMerchant({ tokenValid: true });
   assert.strictEqual(await check(m), true);
   const state = await sessionHealth();
   assert.strictEqual(m.initCalls, 0, 'no needless login');
   assert.strictEqual(state.consecutiveFailures, 0);
   assert.ok(state.lastOkAt, 'records success time');
});

test('an invalid token triggers re-authentication', async () => {
   const m = fakeMerchant({ tokenValid: false });
   assert.strictEqual(await check(m), true);
   assert.strictEqual(m.initCalls, 1, 'init() called to refresh');
   assert.ok((await sessionHealth()).reauths >= 1, 'reauth counted');
});

test('a failed re-auth marks the session down and records why', async () => {
   assert.strictEqual(await check(fakeMerchant({ tokenValid: false, initFails: true })), false);
   const state = await sessionHealth();
   assert.match(state.lastError, /cooldown/i);
   assert.ok(state.consecutiveFailures >= 1);
});

test('consecutive failures accumulate across invocations', async () => {
   // The whole point of persisting health: each invocation is a different instance,
   // so an in-memory counter would reset to 1 every time.
   const before = (await sessionHealth()).consecutiveFailures;
   await check(fakeMerchant({ tokenValid: false, initFails: true }));
   assert.strictEqual((await sessionHealth()).consecutiveFailures, before + 1);
});

test('a later success clears the failure state', async () => {
   assert.strictEqual(await check(fakeMerchant({ tokenValid: true })), true);
   const state = await sessionHealth();
   assert.strictEqual(state.consecutiveFailures, 0, 'counter reset');
   assert.strictEqual(state.lastError, null, 'error cleared');
});

test('reauth count is not lost when a later check fails', async () => {
   const reauths = (await sessionHealth()).reauths;
   await check(fakeMerchant({ tokenValid: false, initFails: true }));
   assert.strictEqual((await sessionHealth()).reauths, reauths, 'preserved through a failure');
});

const ok = await report();
await db.close();
process.exit(ok ? 0 : 1);
