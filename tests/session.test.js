import assert from 'node:assert';
import { createSuite, useTempDatabase } from './helpers.js';

const { cleanup } = useTempDatabase({ SESSION_CHECK_MS: '50' });
const { db } = await import('../src/db/index.js');
const { check, sessionHealth, startKeepalive } = await import('../src/services/session.js');

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

const results = {};

results.healthy = await (async () => {
   const m = fakeMerchant({ tokenValid: true });
   const ok = await check(m);
   return { ok, state: sessionHealth(), initCalls: m.initCalls };
})();

results.reauth = await (async () => {
   const m = fakeMerchant({ tokenValid: false });
   const ok = await check(m);
   return { ok, state: sessionHealth(), initCalls: m.initCalls };
})();

results.failure = await (async () => {
   const m = fakeMerchant({ tokenValid: false, initFails: true });
   const ok = await check(m);
   return { ok, state: sessionHealth() };
})();

results.recovery = await (async () => {
   const ok = await check(fakeMerchant({ tokenValid: true }));
   return { ok, state: sessionHealth() };
})();

results.keepalive = await (async () => {
   const m = fakeMerchant({ tokenValid: true });
   const stop = startKeepalive(m);
   const before = sessionHealth().lastCheckAt;
   await new Promise((r) => setTimeout(r, 180)); // ~3 ticks at 50ms
   stop();
   const after = sessionHealth().lastCheckAt;
   const settled = sessionHealth().lastCheckAt;
   await new Promise((r) => setTimeout(r, 120)); // must not tick after stop()
   return { before, after, stoppedAt: settled, afterStop: sessionHealth().lastCheckAt };
})();

test('a valid token passes without re-authenticating', () => {
   assert.strictEqual(results.healthy.ok, true);
   assert.strictEqual(results.healthy.initCalls, 0, 'no needless login');
   assert.strictEqual(results.healthy.state.consecutiveFailures, 0);
   assert.ok(results.healthy.state.lastOkAt, 'records success time');
});

test('an invalid token triggers re-authentication', () => {
   assert.strictEqual(results.reauth.ok, true);
   assert.strictEqual(results.reauth.initCalls, 1, 'init() called to refresh');
   assert.ok(results.reauth.state.reauths >= 1, 'reauth counted');
});

test('a failed re-auth marks the session down and records why', () => {
   assert.strictEqual(results.failure.ok, false);
   assert.match(results.failure.state.lastError, /cooldown/i);
   assert.ok(results.failure.state.consecutiveFailures >= 1);
});

test('a later success clears the failure state', () => {
   assert.strictEqual(results.recovery.ok, true);
   assert.strictEqual(results.recovery.state.consecutiveFailures, 0, 'counter reset');
   assert.strictEqual(results.recovery.state.lastError, null, 'error cleared');
});

test('keepalive probes on its interval and stops when told', () => {
   assert.notStrictEqual(results.keepalive.after, results.keepalive.before, 'probed while running');
   assert.strictEqual(results.keepalive.afterStop, results.keepalive.stoppedAt, 'no probe after stop()');
});

const ok = report();
cleanup(db);
process.exit(ok ? 0 : 1);
