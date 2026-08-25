import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from '../config.js';
import { openApiSpec } from '../openapi.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
import { isAuthenticated } from '../security.js';
import { sessionHealth } from '../services/session.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * Docs. Mounted before the strict CSP — Swagger UI's inline assets need a looser
 * policy than the API does.
 */
export function systemRoutes() {
   const router = express.Router();

   router.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'GoBiz Payment Gateway — API Docs',
      swaggerOptions: {
         persistAuthorization: true,
         tryItOutEnabled: true,
         displayRequestDuration: true,
      },
   }));

   router.get('/openapi.json', (req, res) => res.json(openApiSpec));

   return router;
}

export function healthRoutes() {
   const router = express.Router();

   /**
    * Liveness + upstream session state. Unauthenticated, so an uptime monitor can
    * poll it without holding the API key.
    *
    * 503 when the GoBiz session is down: payments cannot be detected, so the
    * deployment is degraded even though HTTP is fine.
    *
    * Transaction counts and the code cursor are only returned to an authenticated
    * caller. Volume and revenue pace are business intelligence — an open endpoint
    * publishing "pending: 3, total: 128" tells anyone who asks how much trade this
    * merchant does. `/api/admin/stats` is the place for the full picture.
    */
   router.get('/health', wrap(async (req, res) => {
      const session = await sessionHealth();
      const degraded = session.ok === false;

      const data = {
         session: {
            ok: session.ok,
            lastCheckAt: session.lastCheckAt,
            lastOkAt: session.lastOkAt,
            consecutiveFailures: session.consecutiveFailures,
            reauths: session.reauths,
            lastError: session.lastError,
         },
      };

      if (isAuthenticated(req, config.apiKey)) {
         const [tally, uniqueCodeCursor] = await Promise.all([
            counts(),
            cursor(config.uniqueCodeMax),
         ]);
         Object.assign(data, tally, { uniqueCodeCursor });
      }

      res.status(degraded ? 503 : 200).json({ success: !degraded, data });
   }));

   return router;
}
