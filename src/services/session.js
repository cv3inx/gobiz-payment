import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('session');

/**
 * Keeps the GoBiz session warm and observable.
 *
 * The payment watcher already calls GoBiz every POLL_MS, so the session never goes
 * idle on its own. What this adds is a *cheap explicit probe* (merchant lookup, not
 * history) that detects an expired token before a payment poll trips over it, and
 * records the result so `/health` can report whether the upstream session is alive.
 */
const state = {
   ok: null,
   lastCheckAt: null,
   lastOkAt: null,
   lastError: null,
   consecutiveFailures: 0,
   reauths: 0,
};

/** Snapshot for /health. */
export const sessionHealth = () => ({ ...state });

/**
 * Probe the session once. Re-authenticates when the token has gone bad, which is
 * why this is worth doing on a timer instead of waiting for a payment poll to fail.
 */
export async function check(merchant) {
   state.lastCheckAt = new Date().toISOString();
   try {
      // Lightweight: a 1-record merchant lookup, not a history fetch.
      const valid = merchant.token && await merchant._isTokenValid(merchant.token);

      if (!valid) {
         logger.warn('token invalid — re-authenticating');
         merchant._initialized = false;
         await merchant.init();
         state.reauths++;
         logger.ok('session re-authenticated');
      }

      state.ok = true;
      state.lastOkAt = state.lastCheckAt;
      state.lastError = null;
      state.consecutiveFailures = 0;
   } catch (e) {
      state.ok = false;
      state.lastError = e.message;
      state.consecutiveFailures++;
      // Cooldown errors are expected backoff, not a new problem — don't shout.
      const level = /cooldown/i.test(e.message) ? 'info' : 'warn';
      logger[level](`health check failed (${state.consecutiveFailures}x): ${e.message}`);
   }
   return state.ok;
}

/** Start the periodic probe. Returns a stop function. */
export function startKeepalive(merchant) {
   const run = () => check(merchant).catch((e) => logger.error(`keepalive crashed: ${e.message}`));
   const timer = setInterval(run, config.sessionCheckMs);
   timer.unref?.();
   return () => clearInterval(timer);
}
