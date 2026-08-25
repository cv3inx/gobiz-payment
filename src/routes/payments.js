import express from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { log } from '../logger.js';
import { validateWebhookUrl } from '../security.js';
import * as transactions from '../db/transactions.js';
import * as webhookStore from '../db/webhooks.js';
import * as payments from '../services/payments.js';
import * as webhooks from '../services/webhooks.js';
import { cycleIfStale } from '../services/poller.js';

const STATUSES = ['PENDING', 'PAID', 'EXPIRED'];
const TRX_ID_PATTERN = /^[\w.-]{1,64}$/;

const fail = (res, status, error) => res.status(status).json({ success: false, error });

/**
 * Express 4 does not catch a rejected promise from a handler, so an async route
 * that throws would hang the request instead of reaching the error middleware.
 */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** PUBLIC_URL wins, else derive from the request (honors X-Forwarded-* via trust proxy). */
const baseUrlFor = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

/** Validate the create-payment body. Returns { error } or { value }. */
function parseCreateBody(body = {}, headers) {
   const amount = parseInt(body.amount, 10);
   if (!Number.isInteger(amount) || amount <= 0 || amount > config.maxAmount) {
      return { error: `amount must be an integer between 1 and ${config.maxAmount}` };
   }

   const fee = body.fee == null ? 0 : parseInt(body.fee, 10);
   if (!Number.isInteger(fee) || fee < 0 || fee > config.maxAmount) {
      return { error: `fee must be an integer between 0 and ${config.maxAmount}` };
   }

   // Upper bound matters: an unbounded lifetime keeps one of only UNIQUE_CODE_MAX
   // payable amounts reserved indefinitely.
   const expireMinutes = body.expireMinutes == null
      ? config.expireMinutes
      : parseInt(body.expireMinutes, 10);
   if (!Number.isInteger(expireMinutes) || expireMinutes <= 0 || expireMinutes > config.maxExpireMinutes) {
      return { error: `expireMinutes must be an integer between 1 and ${config.maxExpireMinutes}` };
   }

   // Reject caller-supplied webhook URLs pointing at internal services (SSRF).
   const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : null;
   if (callbackUrl) {
      const check = validateWebhookUrl(callbackUrl);
      if (!check.ok) return { error: check.error };
   }

   // Optional per-transaction signing secret. Signs only this transaction's
   // webhooks instead of the global WEBHOOK_SECRET. Never echoed back.
   let callbackSecret = null;
   if (body.callbackSecret != null) {
      callbackSecret = String(body.callbackSecret);
      if (callbackSecret.length < 8 || callbackSecret.length > 256) {
         return { error: 'callbackSecret must be 8-256 chars' };
      }
   }

   let trxId = null;
   if (body.trxId != null) {
      trxId = String(body.trxId);
      if (!TRX_ID_PATTERN.test(trxId)) {
         return { error: 'trxId must be 1-64 chars: letters, digits, _ . -' };
      }
   }

   return {
      value: {
         amount,
         fee,
         expireMinutes,
         callbackUrl,
         callbackSecret,
         trxId,
         metadata: body.metadata ?? null,
         idempotencyKey: headers['idempotency-key'] || body.idempotencyKey || null,
      },
   };
}

export function paymentRoutes(guard, merchant = null) {
   const router = express.Router();

   router.post('/payment/create', guard, wrap(async (req, res) => {
      const { error, value } = parseCreateBody(req.body, req.headers);
      if (error) return fail(res, 400, error);

      if (value.trxId && await transactions.get(value.trxId)) {
         return fail(res, 409, 'trxId already exists');
      }

      // Idempotency: the same key returns the original instead of double-charging.
      if (value.idempotencyKey) {
         const existing = await transactions.getByIdempotencyKey(value.idempotencyKey);
         if (existing) {
            return res.json({
               success: true,
               idempotent: true,
               data: payments.toPublic(existing, baseUrlFor(req)),
            });
         }
      }

      try {
         const trx = await payments.create(value);
         res.status(201).json({ success: true, data: payments.toPublic(trx, baseUrlFor(req)) });
      } catch (e) {
         if (e.code === 'NO_FREE_CODE') return fail(res, 503, e.message);
         if (e.code === 'DUPLICATE') {
            // Lost a race on the idempotency key: the winner's row is the answer,
            // which is the whole point of the key.
            const existing = value.idempotencyKey
               && await transactions.getByIdempotencyKey(value.idempotencyKey);
            if (existing) {
               return res.json({
                  success: true,
                  idempotent: true,
                  data: payments.toPublic(existing, baseUrlFor(req)),
               });
            }
            if (value.trxId && await transactions.get(value.trxId)) {
               return fail(res, 409, 'trxId already exists');
            }
            return fail(res, 503, e.message);
         }
         throw e;
      }
   }));

   router.get('/payments', guard, wrap(async (req, res) => {
      const status = req.query.status ? String(req.query.status).toUpperCase() : null;
      if (status && !STATUSES.includes(status)) {
         return fail(res, 400, `status must be one of ${STATUSES.join(', ')}`);
      }
      const { limit, offset } = transactions.clampPage(req.query);
      const base = baseUrlFor(req);
      const rows = await transactions.list({ status, limit, offset });
      const data = rows.map((t) => payments.toPublic(t, base));
      res.json({ success: true, data, meta: { limit, offset, count: data.length } });
   }));

   router.get('/payment/:trxId', wrap(async (req, res) => {
      let found = await transactions.get(req.params.trxId);
      if (!found) return fail(res, 404, 'not found');

      // Somebody is waiting on this payment, so use the read to drive a full
      // cycle — globally throttled, so a busy checkout page cannot hammer GoBiz.
      // There is no cron: this request IS the scheduler.
      // ponytail: awaited, so it adds the upstream round trip to this response.
      // Move it behind `waitUntil` from @vercel/functions if that latency matters.
      if (merchant && found.status === 'PENDING' && !payments.isOverdue(found)) {
         await cycleIfStale(merchant, config.pollMinIntervalMs);
         found = (await transactions.get(req.params.trxId)) || found;
      }

      // No timers exist to fire expiry, so settle it here rather than reporting a
      // PENDING transaction that is actually long dead.
      const trx = await payments.expireIfOverdue(found);
      // Unauthenticated on purpose — the payer needs to poll this. Note it also
      // returns metadata/callbackUrl, so a guessable caller-supplied trxId
      // ("ORDER-1042") exposes them; use the auto-generated id for public flows.
      res.json({ success: true, data: payments.toPublic(trx, baseUrlFor(req)) });
   }));

   router.get('/payment/:trxId/qr.png', wrap(async (req, res) => {
      const trx = await transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      const png = await QRCode.toBuffer(trx.qrString, { scale: 8, errorCorrectionLevel: 'M' });
      res.type('png').send(png);
   }));

   router.post('/payment/:trxId/cancel', guard, wrap(async (req, res) => {
      const trx = await transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      if (trx.status !== 'PENDING') return fail(res, 409, `cannot cancel ${trx.status} trx`);

      await payments.expire(trx);
      // Re-read: expire() may have lost the race to an incoming payment.
      const fresh = (await transactions.get(trx.trxId)) || trx;
      res.json({ success: true, data: payments.toPublic(fresh, baseUrlFor(req)) });
   }));

   // Re-queue a webhook that exhausted its attempts (consumer down too long).
   router.post('/payment/:trxId/replay-webhook', guard, wrap(async (req, res) => {
      const trx = await transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      if (trx.status === 'PENDING') return fail(res, 409, 'trx is still PENDING — nothing to replay');

      await webhookStore.owe(trx.trxId);
      // Awaited: a floating promise would be killed the moment this response is
      // sent and the instance is frozen. A failure is persisted, so the cron
      // sweep retries it anyway.
      try {
         await webhooks.deliver(await transactions.get(trx.trxId));
      } catch (e) {
         log('webhook').error(`${trx.trxId} replay crashed: ${e.message}`);
      }
      const fresh = await transactions.get(trx.trxId);
      res.json({
         success: true,
         data: { trxId: trx.trxId, webhookState: fresh?.webhookState ?? 'PENDING' },
      });
   }));

   return router;
}
