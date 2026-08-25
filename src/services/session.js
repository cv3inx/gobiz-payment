import { log } from '../logger.js';
import * as meta from '../db/meta.js';

const logger = log('session');
const KEY = 'session.health';

/**
 * Tracks whether the GoBiz session is alive.
 *
 * The state lives in the database, not in a module variable: the request that
 * serves /health almost never runs in the same instance as the request
 * that probed upstream, so in-process state would report "unknown" forever.
 *
 * The probe itself is deliberately cheap (a 1-record merchant lookup, not a
 * history fetch) and only runs on the full cycle — probing per request would
 * multiply upstream calls by traffic and risk an account block.
 */
const EMPTY = {
   ok: null,
   lastCheckAt: null,
   lastOkAt: null,
   lastError: null,
   consecutiveFailures: 0,
   reauths: 0,
};

/** Snapshot for /health. */
export async function sessionHealth() {
   return { ...EMPTY, ...(await meta.get(KEY)) };
}

/**
 * Probe the session once and record the result. Re-authenticates when the token
 * has gone bad, so a payment poll doesn't trip over it.
 */
export async function check(merchant) {
   const previous = await sessionHealth();
   const lastCheckAt = new Date().toISOString();

   try {
      const valid = merchant.token && await merchant._isTokenValid(merchant.token);

      let reauths = previous.reauths;
      if (!valid) {
         logger.warn('token invalid — re-authenticating');
         merchant._initialized = false;
         await merchant.init();
         reauths++;
         logger.ok('session re-authenticated');
      }

      await meta.set(KEY, {
         ok: true,
         lastCheckAt,
         lastOkAt: lastCheckAt,
         lastError: null,
         consecutiveFailures: 0,
         reauths,
      });
      return true;
   } catch (e) {
      const consecutiveFailures = previous.consecutiveFailures + 1;
      await meta.set(KEY, {
         ...previous,
         ok: false,
         lastCheckAt,
         lastError: e.message,
         consecutiveFailures,
      });
      // Cooldown errors are expected backoff, not a new problem — don't shout.
      const level = /cooldown/i.test(e.message) ? 'info' : 'warn';
      logger[level](`health check failed (${consecutiveFailures}x): ${e.message}`);
      return false;
   }
}
