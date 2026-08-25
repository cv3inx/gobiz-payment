import express from 'express';
import morgan from 'morgan';
import { config } from './config.js';
import { log, dim, fg, useColor } from './logger.js';
import { securityHeaders, requireApiKey, rateLimit } from './security.js';
import { paymentRoutes } from './routes/payments.js';
import { historyRoutes } from './routes/history.js';
import { adminRoutes } from './routes/admin.js';
import { systemRoutes, healthRoutes } from './routes/system.js';

const logHttp = log('http');

const statusColor = (status) => {
   if (!useColor) return status;
   const n = parseInt(status, 10);
   const color = n >= 500 ? 31 : n >= 400 ? 33 : n >= 300 ? 36 : 32;
   return `\x1b[1;${color}m${status}\x1b[0m`;
};

/** Request log in the shared logger's style: [TIME] STATUS path | METHOD - MS */
function requestLogger() {
   morgan.token('ts', () => new Date().toTimeString().slice(0, 8));
   return morgan((tokens, req, res) => [
      dim(`[${tokens.ts()}]`),
      statusColor(tokens.status(req, res) || '---'),
      tokens.url(req, res),
      dim('|'),
      useColor ? fg(35, tokens.method(req, res).padEnd(4)) : tokens.method(req, res).padEnd(4),
      dim('-'),
      dim(`${tokens['response-time'](req, res) || '0'}ms`),
   ].join(' '), {
      // Swagger's own static assets are pure noise; keep the real API calls visible.
      skip: (req) => /^\/docs\/.+\.(js|css|png|ico|map)$/.test(req.originalUrl),
   });
}

/**
 * @param {object} [deps]
 * @param {import('../lib/gobiz.js').default} [deps.merchant] - enables traffic-driven
 *   payment detection and the /api/admin/poll action
 */
export function createApp({ merchant = null } = {}) {
   const app = express();

   // Trust a fixed number of proxy hops. `true` would accept the client's own
   // X-Forwarded-For, letting anyone forge an IP and evade the rate limit.
   app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

   app.use(requestLogger());

   // Ahead of the docs, so serving the Swagger bundle can't be used to hammer the
   // deployment for free.
   app.use(rateLimit({ max: config.rateMax }));

   // Docs stay ahead of securityHeaders: Swagger UI's inline assets do not survive
   // the API's `default-src 'none'` policy.
   app.use(systemRoutes());

   app.use(securityHeaders);
   app.use(express.json({ limit: '64kb' }));

   const guard = requireApiKey(config.apiKey);
   app.use(healthRoutes());
   app.use(adminRoutes(guard, merchant));
   app.use(paymentRoutes(guard, merchant));
   app.use(historyRoutes(guard));

   // Only API prefixes reach this app (see server/middleware/api.ts), so an
   // unmatched path here really is an unknown endpoint, not a Nuxt page.
   app.use((req, res) => res.status(404).json({ success: false, error: 'not found' }));

   // Last resort: a throw in any route lands here instead of killing the process
   // or leaking a stack trace to the caller.
   app.use((err, req, res, next) => {
      logHttp.error(`${req.method} ${req.originalUrl} → ${err.stack || err.message}`);
      if (res.headersSent) return next(err);
      const badBody = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
      res.status(badBody ? 400 : 500).json({
         success: false,
         error: badBody ? 'invalid or oversized JSON body' : 'internal error',
      });
   });

   return app;
}
