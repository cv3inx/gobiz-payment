import { log } from '../logger.js';
import * as meta from '../db/meta.js';
import * as history from '../db/history.js';
import * as payments from './payments.js';
import * as webhooks from './webhooks.js';
import { check as checkSession } from './session.js';

const logger = log('poller');
const SEEDED_KEY = 'poller.seeded';

/**
 * One pass over GoBiz history.
 *
 * There is no in-process "seen" set to dedupe against — an instance is frozen
 * between invocations, so `gobiz_history` is the memory. That is a straight
 * upgrade on a poller that remembered in RAM: a payment that lands while nothing
 * is running is still unseen on the next pass, so it gets reconciled instead of
 * being silently swallowed at the next cold start.
 *
 * Two overlapping passes reconciling the same entry is harmless: `settle()` is
 * guarded on status = 'PENDING', so only one wins and only one webhook fires.
 */
export async function pollOnce(merchant) {
   const entries = (await merchant.getHistory({ days: 1, size: 30 }))
      .filter((e) => Number.isFinite(e.amount));

   const known = await history.seen(entries.map((e) => e.gobizId));
   const fresh = entries.filter((e) => !known.has(e.gobizId));
   const seenAt = new Date().toISOString();

   // First pass on a new deployment: archive the existing history as "already
   // known" rather than reconciling a day of past payments against fresh orders.
   //
   // Checked before the empty-batch shortcut on purpose. If the first pass sees no
   // history at all (a quiet day, a brand-new merchant) the flag must still be set
   // — otherwise the seed is deferred and the first REAL payment gets archived as
   // "pre-existing" and never reconciled.
   if (!(await meta.get(SEEDED_KEY))) {
      for (const e of fresh) {
         await history.upsert({ gobizId: e.gobizId, amount: Math.round(e.amount), time: e.time, raw: e.raw, seenAt });
      }
      await meta.set(SEEDED_KEY, true);
      logger.info(`Seed selesai. ${fresh.length} transaksi lama ditandai "sudah dikenal".`);
      return { fresh: fresh.length, matched: 0, seeded: true };
   }

   if (!fresh.length) return { fresh: 0, matched: 0, seeded: false };

   let matched = 0;
   for (const e of fresh) {
      logger.ok(`Transaksi baru: Rp ${e.amount.toLocaleString('id-ID')} | ID: ${e.gobizId}`);
      if (await payments.reconcile({ amount: e.amount, txId: e.gobizId, entry: e })) matched++;
   }
   return { fresh: fresh.length, matched, seeded: false };
}

/**
 * Run one maintenance cycle, but only if nobody has run one recently.
 *
 * There is no cron and no background process. This is the whole engine: ordinary
 * app traffic drives it. A payer watching the QR screen polls their own status
 * every few seconds, and each read may claim the slot and do a full cycle — poll
 * GoBiz, expire what is overdue, retry owed webhooks.
 *
 * Which means detection is near-real-time exactly while somebody is waiting, and
 * there are zero upstream calls when nobody is. That is also gentler on the GoBiz
 * account than a blind fixed-interval poller.
 *
 * The throttle lives in the database, so it holds across every instance at once.
 *
 * The tradeoff, stated plainly: with literally zero traffic nothing runs, so a
 * `payment.expired` webhook can sit until the next request touches the gateway.
 * `payment.paid` is unaffected — the cycle that finds the payment is the one that
 * settles it and queues the webhook.
 */
export async function cycleIfStale(merchant, minIntervalMs) {
   if (!(await meta.tryClaimPollSlot(minIntervalMs))) return null;
   try {
      return await runCycle(merchant, { session: false });
   } catch (e) {
      logger.error(`opportunistic cycle gagal: ${e.message}`);
      return null;
   }
}

/**
 * Everything an always-on process would have done in the background, as one pass.
 *
 * Steps are independent: a failing upstream poll must not stop owed webhooks from
 * being retried or overdue transactions from expiring.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.session] - probe the GoBiz session too. Skipped on the
 *   traffic-driven path, where it would add a second upstream round trip to a
 *   request a payer is waiting on; `getHistory` re-authenticates on its own anyway.
 */
export async function runCycle(merchant, { session = true } = {}) {
   const result = { session: null, poll: null, expired: 0, webhooks: 0, errors: [] };

   const step = async (name, fn) => {
      try {
         return await fn();
      } catch (e) {
         result.errors.push(`${name}: ${e.message}`);
         logger.error(`${name} gagal: ${e.message}`);
         return null;
      }
   };

   if (session) result.session = await step('session', () => checkSession(merchant));
   result.poll = await step('poll', async () => {
      // Stamp the shared throttle so another request doesn't immediately repeat
      // the upstream call this cycle just made.
      await meta.set('poller.lastRunAt', Date.now());
      return pollOnce(merchant);
   });
   result.expired = (await step('expire', () => payments.expireDue())) ?? 0;
   result.webhooks = (await step('webhooks', () => webhooks.drain())) ?? 0;

   return result;
}
