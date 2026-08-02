import express from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { log } from '../logger.js';
import { validateWebhookUrl } from '../security.js';
import * as transactions from '../db/transactions.js';
import * as webhookStore from '../db/webhooks.js';
import * as payments from '../services/payments.js';
import * as webhooks from '../services/webhooks.js';

const STATUSES = ['PENDING', 'PAID', 'EXPIRED'];
const TRX_ID_PATTERN = /^[\w.-]{1,64}$/;

const fail = (res, status, error) => res.status(status).json({ success: false, error });

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

   const expireMinutes = body.expireMinutes == null
      ? config.expireMinutes
      : parseInt(body.expireMinutes, 10);
   if (!Number.isInteger(expireMinutes) || expireMinutes <= 0) {
      return { error: 'expireMinutes must be a positive integer' };
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

export function paymentRoutes(guard) {
   const router = express.Router();

   router.post('/payment/create', guard, (req, res) => {
      const { error, value } = parseCreateBody(req.body, req.headers);
      if (error) return fail(res, 400, error);

      if (value.trxId && transactions.get(value.trxId)) {
         return fail(res, 409, 'trxId already exists');
      }

      // Idempotency: the same key returns the original instead of double-charging.
      if (value.idempotencyKey) {
         const existing = transactions.getByIdempotencyKey(value.idempotencyKey);
         if (existing) {
            return res.json({
               success: true,
               idempotent: true,
               data: payments.toPublic(existing, baseUrlFor(req)),
            });
         }
      }

      try {
         const trx = payments.create(value);
         res.status(201).json({ success: true, data: payments.toPublic(trx, baseUrlFor(req)) });
      } catch (e) {
         if (e.code === 'NO_FREE_CODE' || e.code === 'DUPLICATE') return fail(res, 503, e.message);
         throw e;
      }
   });

   router.get('/payments', guard, (req, res) => {
      const status = req.query.status ? String(req.query.status).toUpperCase() : null;
      if (status && !STATUSES.includes(status)) {
         return fail(res, 400, `status must be one of ${STATUSES.join(', ')}`);
      }
      const { limit, offset } = transactions.clampPage(req.query);
      const base = baseUrlFor(req);
      const data = transactions.list({ status, limit, offset }).map((t) => payments.toPublic(t, base));
      res.json({ success: true, data, meta: { limit, offset, count: data.length } });
   });

   router.get('/payment/:trxId', (req, res) => {
      const trx = transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      res.json({ success: true, data: payments.toPublic(trx, baseUrlFor(req)) });
   });

   router.get('/payment/:trxId/qr.png', async (req, res, next) => {
      const trx = transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      try {
         const png = await QRCode.toBuffer(trx.qrString, { scale: 8, errorCorrectionLevel: 'M' });
         res.type('png').send(png);
      } catch (e) {
         next(e);
      }
   });

   router.post('/payment/:trxId/cancel', guard, (req, res) => {
      const trx = transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      if (trx.status !== 'PENDING') return fail(res, 409, `cannot cancel ${trx.status} trx`);

      payments.expire(trx);
      // Re-read: expire() may have lost the race to an incoming payment.
      const fresh = transactions.get(trx.trxId) || trx;
      res.json({ success: true, data: payments.toPublic(fresh, baseUrlFor(req)) });
   });

   // Re-queue a webhook that exhausted its attempts (consumer down too long).
   router.post('/payment/:trxId/replay-webhook', guard, (req, res) => {
      const trx = transactions.get(req.params.trxId);
      if (!trx) return fail(res, 404, 'not found');
      if (trx.status === 'PENDING') return fail(res, 409, 'trx is still PENDING — nothing to replay');

      webhookStore.owe(trx.trxId);
      webhooks.deliver(transactions.get(trx.trxId))
         .catch((e) => log('webhook').error(`${trx.trxId} replay crashed: ${e.message}`));
      res.json({ success: true, data: { trxId: trx.trxId, webhookState: 'PENDING' } });
   });

   return router;
}
