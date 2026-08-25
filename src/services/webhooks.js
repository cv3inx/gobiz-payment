import { config } from '../config.js';
import { log } from '../logger.js';
import { signBody } from '../security.js';
import * as store from '../db/webhooks.js';

const logger = log('webhook');

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped. */
function backoffMs(attempt) {
   return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), config.webhook.maxBackoffMs);
}

export function buildPayload(trx) {
   return {
      event: trx.status === 'PAID' ? 'payment.paid' : 'payment.expired',
      trxId: trx.trxId,
      status: trx.status,
      amount: trx.amount,
      fee: trx.fee,
      uniqueCode: trx.uniqueCode ?? trx.payAmount - trx.total,
      amountToPay: trx.payAmount,
      paidAt: trx.paidAt || null,
      metadata: trx.metadata || null,
   };
}

/** Single POST attempt. Never throws — returns why it failed instead. */
async function post(url, trx) {
   const body = JSON.stringify(buildPayload(trx));
   // A per-transaction secret (set at create time) signs only that transaction's
   // deliveries, so a caller can verify with their own key.
   const secret = trx.callbackSecret || config.webhook.secret;
   try {
      const res = await fetch(url, {
         method: 'POST',
         headers: {
            'Content-Type': 'application/json',
            'X-Signature': signBody(body, secret),
         },
         body,
         // Without a timeout a black-holed consumer hangs until the function's
         // own wall-clock limit kills it, taking the whole sweep down with it.
         signal: AbortSignal.timeout(config.webhook.timeoutMs),
      });
      return res.ok ? { ok: true, status: res.status } : { ok: false, why: `HTTP ${res.status}` };
   } catch (e) {
      // undici hides the real reason behind a generic "fetch failed"
      return { ok: false, why: e.cause?.code || e.cause?.message || e.message };
   }
}

/** Attempt one delivery and persist the outcome. */
export async function deliver(trx) {
   const url = trx.callbackUrl || config.webhook.url;
   if (!url) {
      await store.markSent(trx.trxId); // nothing configured — don't queue forever
      return;
   }

   const attempt = (trx.webhookAttempts || 0) + 1;
   const result = await post(url, trx);

   if (result.ok) {
      await store.markSent(trx.trxId);
      logger.ok(`${trx.trxId} delivered (HTTP ${result.status}) on attempt ${attempt}`);
      return;
   }

   const exhausted = attempt >= config.webhook.maxAttempts;
   const nextAt = exhausted ? null : new Date(Date.now() + backoffMs(attempt)).toISOString();
   await store.markFailed(trx.trxId, result.why, nextAt);

   if (exhausted) {
      logger.error(`${trx.trxId} gave up after ${attempt} attempts: ${result.why} (${url}) — ` +
         `replay: POST /payment/${trx.trxId}/replay-webhook`);
   } else {
      logger.warn(`${trx.trxId} attempt ${attempt}/${config.webhook.maxAttempts} failed: ` +
         `${result.why} (${url}) — retrying in ${Math.round(backoffMs(attempt) / 1000)}s`);
   }
}

/**
 * Queue a webhook, then try it once inline.
 *
 * The inline attempt is awaited rather than fired and forgotten: a serverless
 * instance is frozen the moment the response is sent, so a floating promise would
 * be killed mid-flight. Failures are already persisted, so the cron sweep picks
 * them up regardless.
 */
export async function enqueue(trx) {
   await store.owe(trx.trxId);
   try {
      await deliver(trx);
   } catch (e) {
      logger.error(`${trx.trxId} delivery crashed: ${e.message}`);
   }
}

/**
 * Deliver every webhook that is due, claiming each so an overlapping run cannot
 * send the same event twice. Delivery is concurrent but bounded — a serverless
 * invocation has a wall clock, and a batch of slow consumers done serially would
 * blow through it.
 */
export async function drain({ limit = 20, concurrency = 5 } = {}) {
   const batch = await store.claim({ maxAttempts: config.webhook.maxAttempts, limit });
   if (!batch.length) return 0;

   const queue = [...batch];
   const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
         const trx = queue.shift();
         try {
            await deliver(trx);
         } catch (e) {
            logger.error(`${trx.trxId} delivery crashed: ${e.message}`);
         }
      }
   });
   await Promise.all(workers);
   return batch.length;
}

export const owedCount = () => store.owedCount();
