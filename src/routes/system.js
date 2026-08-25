import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from '../config.js';
import { openApiSpec } from '../openapi.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
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

   // 503 when the upstream GoBiz session is down: payments can't be detected, so a
   // load balancer or uptime monitor should know this deployment is degraded even
   // though HTTP is fine.
   router.get('/health', wrap(async (req, res) => {
      const [session, tally, uniqueCodeCursor] = await Promise.all([
         sessionHealth(),
         counts(),
         cursor(config.uniqueCodeMax),
      ]);
      const degraded = session.ok === false;
      res.status(degraded ? 503 : 200).json({
         success: !degraded,
         data: {
            ...tally,
            uniqueCodeCursor,
            session: {
               ok: session.ok,
               lastCheckAt: session.lastCheckAt,
               lastOkAt: session.lastOkAt,
               consecutiveFailures: session.consecutiveFailures,
               reauths: session.reauths,
               lastError: session.lastError,
            },
         },
      });
   }));

   return router;
}
