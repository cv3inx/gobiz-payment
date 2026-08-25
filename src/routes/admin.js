import express from 'express';
import { config } from '../config.js';
import * as stats from '../db/stats.js';
import * as meta from '../db/meta.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
import { sessionHealth } from '../services/session.js';
import { runCycle } from '../services/poller.js';
import * as payments from '../services/payments.js';
import * as webhooks from '../services/webhooks.js';

/** Express 4 does not catch a rejected promise from a handler; this forwards it. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** @param {import('express').RequestHandler} guard */
export function adminRoutes(guard, merchant = null) {
   const router = express.Router();

   // Everything the dashboard needs for its overview, in one round trip — a
   // dashboard that fires six requests on every refresh just burns invocations.
   router.get('/api/admin/stats', guard, wrap(async (req, res) => {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
      // No transaction feed here: /payments already returns the full public shape
      // (including webhook.lastError and metadata) and supports filter + paging, so
      // duplicating it as a second query would be two sources to keep in step.
      const [summary, daily, tally, session, uniqueCodeCursor, lastPollAt, cooldownUntil] =
         await Promise.all([
            stats.summary(),
            stats.daily(days),
            counts(),
            sessionHealth(),
            cursor(config.uniqueCodeMax),
            meta.lastPollAt(),
            // Optional: a stub merchant in tests need not implement it.
            merchant?.loginCooldownUntil?.() ?? null,
         ]);

      res.json({
         success: true,
         data: {
            summary,
            daily,
            counts: tally,
            session: {
               ...session,
               // Non-null means re-authenticating right now would only deepen a
               // GoBiz rate-limit. The dashboard disables "check now" while it holds.
               cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
               cooldownSeconds: cooldownUntil ? Math.ceil((cooldownUntil - Date.now()) / 1000) : 0,
            },
            uniqueCode: { cursor: uniqueCodeCursor, max: config.uniqueCodeMax },
            poll: {
               lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
               // How stale detection is right now. With no cron, this is driven by
               // traffic — so it also tells an operator the gateway is being used.
               staleSeconds: lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : null,
               minIntervalMs: config.pollMinIntervalMs,
            },
            config: {
               expireMinutes: config.expireMinutes,
               maxExpireMinutes: config.maxExpireMinutes,
               webhookUrl: config.webhook.url ? maskUrl(config.webhook.url) : null,
               webhookMaxAttempts: config.webhook.maxAttempts,
               serverless: config.isServerless,
               publicUrl: config.publicUrl || null,
            },
         },
      });
   }));

   // "Check now" — runs a full cycle, ignoring the throttle, so an operator can
   // force reconciliation instead of waiting for the next request to drive one.
   router.post('/api/admin/poll', guard, wrap(async (req, res) => {
      if (!merchant) return res.status(503).json({ success: false, error: 'upstream not configured' });
      const result = await runCycle(merchant);
      res.json({ success: result.errors.length === 0, data: result });
   }));

   /**
    * Attach an archived payment to an order by hand.
    *
    * The one place the gateway will mark an EXPIRED order PAID, so it is a POST,
    * behind the API key, and it logs a distinct MANUAL RECONCILE line.
    */
   router.post('/api/admin/reconcile', guard, wrap(async (req, res) => {
      const gobizId = typeof req.body?.gobizId === 'string' ? req.body.gobizId.trim() : '';
      const trxId = typeof req.body?.trxId === 'string' ? req.body.trxId.trim() : '';
      if (!gobizId || !trxId) {
         return res.status(400).json({ success: false, error: 'gobizId and trxId are required' });
      }

      try {
         const result = await payments.reconcileManually({ gobizId, trxId });
         res.json({
            success: true,
            data: {
               trxId: result.trx.trxId,
               status: result.trx.status,
               previousStatus: result.previousStatus,
               expected: result.trx.payAmount,
               received: result.received,
               // Signed: negative means the payer sent less than we asked for.
               difference: result.difference,
            },
         });
      } catch (e) {
         const status = e.code === 'NOT_FOUND' ? 404
            : e.code === 'ALREADY_MATCHED' || e.code === 'ALREADY_PAID' ? 409
            : 500;
         if (status === 500) throw e;
         res.status(status).json({ success: false, error: e.message });
      }
   }));

   // Retry every owed webhook now rather than on the backoff schedule.
   router.post('/api/admin/webhooks/drain', guard, wrap(async (req, res) => {
      const delivered = await webhooks.drain({ limit: 50 });
      res.json({ success: true, data: { attempted: delivered } });
   }));

   return router;
}

/** Keep any token embedded in a webhook URL out of the dashboard payload. */
function maskUrl(raw) {
   try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname}`;
   } catch {
      return null;
   }
}
