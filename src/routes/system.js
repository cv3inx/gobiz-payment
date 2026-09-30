import express from 'express';
import { config } from '../config.js';
import { openApiSpec } from '../openapi.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
import { isAuthenticated } from '../security.js';
import { sessionHealth } from '../services/session.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * Swagger UI, pointed at `/openapi.json`.
 *
 * The page is written out here instead of via `swagger-ui-express`, because that
 * package serves the assets with `express.static` from inside `node_modules` —
 * a path the Nitro build does not carry into `.output`, which left the page
 * blank in production. The assets now ship as Nitro public assets under
 * `/docs-assets` (see nuxt.config.ts) and are requested by absolute path, so
 * they resolve whether or not the trailing slash is there.
 */
const DOCS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
   <meta charset="utf-8">
   <meta name="viewport" content="width=device-width, initial-scale=1">
   <meta name="robots" content="noindex, nofollow">
   <title>GoBiz Payment Gateway — API Docs</title>
   <link rel="stylesheet" href="/docs-assets/swagger-ui.css">
   <link rel="icon" type="image/png" href="/docs-assets/favicon-32x32.png" sizes="32x32">
   <style>body { margin: 0; background: #fafafa }</style>
</head>
<body>
   <div id="swagger-ui"></div>
   <script src="/docs-assets/swagger-ui-bundle.js"></script>
   <script src="/docs-assets/swagger-ui-standalone-preset.js"></script>
   <script>
      window.ui = SwaggerUIBundle({
         url: '/openapi.json',
         dom_id: '#swagger-ui',
         presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
         layout: 'StandaloneLayout',
         persistAuthorization: true,
         tryItOutEnabled: true,
         displayRequestDuration: true,
      });
   </script>
</body>
</html>`;

export function systemRoutes() {
   const router = express.Router();

   router.get(['/docs', '/docs/'], (req, res) => {
      // Narrower than the API's `default-src 'none'`, which this page cannot use:
      // Swagger UI needs its own inline bootstrap script and injects style tags.
      res.setHeader(
         'Content-Security-Policy',
         "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
         "img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
      );
      res.type('html').send(DOCS_PAGE);
   });

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
