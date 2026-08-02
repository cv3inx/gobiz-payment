import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from '../openapi.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
import { sessionHealth } from '../services/session.js';

/**
 * Docs and health. Mounted before the strict CSP — Swagger UI's inline assets
 * need a looser policy than the API does.
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
   router.get('/', (req, res) => res.redirect('/docs'));

   return router;
}

export function healthRoutes() {
   const router = express.Router();

   // 503 when the upstream GoBiz session is down: payments can't be detected, so a
   // load balancer should know this instance is degraded even though HTTP is fine.
   router.get('/health', (req, res) => {
      const session = sessionHealth();
      const degraded = session.ok === false;
      res.status(degraded ? 503 : 200).json({
         success: !degraded,
         data: {
            ...counts(),
            uniqueCodeCursor: cursor(),
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
   });

   return router;
}
