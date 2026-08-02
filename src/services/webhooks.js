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
         // Without a timeout a black-holed consumer hangs this promise forever.
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
      store.markSent(trx.trxId); // nothing configured — don't queue forever
      return;
   }

   const attempt = (trx.webhookAttempts || 0) + 1;
   const result = await post(url, trx);

   if (result.ok) {
      store.markSent(trx.trxId);
      logger.ok(`${trx.trxId} delivered (HTTP ${result.status}) on attempt ${attempt}`);
      return;
   }

   const exhausted = attempt >= config.webhook.maxAttempts;
   const nextAt = exhausted ? null : new Date(Date.now() + backoffMs(attempt)).toISOString();
   store.markFailed(trx.trxId, result.why, nextAt);

   if (exhausted) {
      logger.error(`${trx.trxId} gave up after ${attempt} attempts: ${result.why} (${url}) — ` +
         `replay: POST /payment/${trx.trxId}/replay-webhook`);
   } else {
      logger.warn(`${trx.trxId} attempt ${attempt}/${config.webhook.maxAttempts} failed: ` +
         `${result.why} (${url}) — retrying in ${Math.round(backoffMs(attempt) / 1000)}s`);
   }
}

/** Queue a webhook, then try it immediately. Failures fall to the sweeper. */
export function enqueue(trx) {
   store.owe(trx.trxId);
   deliver(trx).catch((e) => logger.error(`${trx.trxId} delivery crashed: ${e.message}`));
}

/** Deliver every webhook that is due. */
export async function drain() {
   for (const trx of store.due({ maxAttempts: config.webhook.maxAttempts })) {
      await deliver(trx);
   }
}

/**
 * Background sweeper draining owed webhooks, so a redelivery survives both a
 * consumer outage and a gateway restart.
 */
export function startSweeper() {
   const timer = setInterval(
      () => drain().catch((e) => logger.error(`sweep failed: ${e.message}`)),
      config.webhook.sweepMs,
   );
   return () => clearInterval(timer);
}

export const owedCount = () =>
   store.due({ maxAttempts: config.webhook.maxAttempts, limit: 10_000 }).length;
