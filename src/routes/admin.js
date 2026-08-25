import express from 'express';
import { config } from '../config.js';
import * as stats from '../db/stats.js';
import * as meta from '../db/meta.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
import { sessionHealth } from '../services/session.js';
import { runCycle } from '../services/poller.js';
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
      const [summary, daily, recent, tally, session, uniqueCodeCursor, lastPollAt] =
         await Promise.all([
            stats.summary(),
            stats.daily(days),
            stats.recent(15),
            counts(),
            sessionHealth(),
            cursor(config.uniqueCodeMax),
            meta.lastPollAt(),
         ]);

      res.json({
         success: true,
         data: {
            summary,
            daily,
            recent,
            counts: tally,
            session,
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
