/**
 * Nuxt owns the deployment: it builds the Vue dashboard and it is the only
 * server entry point. The Express API lives on unchanged in `src/` and is mounted
 * by `server/middleware/api.ts`, so the whole tested HTTP layer is reused rather
 * than ported to Nitro handlers.
 *
 * Previously Vercel auto-detected "Express" and tried to treat `src/app.js` as a
 * function entry ("The default export must be a function or server"). With Nuxt
 * there is exactly one entry, so that failure mode is gone.
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

// Swagger UI's stylesheet and bundle, served as static files.
//
// They used to come from `swagger-ui-express`, whose middleware points
// `express.static` at this same directory. That cannot work inside the Nitro
// build: the bundler traces only the JS it sees required, so `.output` received
// `absolute-path.js` and nothing else, and every asset request fell through to
// the HTML handler — the docs page loaded, then rendered blank.
const swaggerUiDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'))

export default defineNuxtConfig({
   srcDir: 'web',

   // The dashboard renders from authenticated API calls, so there is nothing to
   // server-render. A pure SPA also means the pages ship as static files and only
   // real API calls reach a function.
   ssr: false,

   devtools: { enabled: false },
   telemetry: false,

   css: ['~/assets/css/main.css'],

   app: {
      head: {
         title: 'GoBiz Payment — Admin',
         meta: [
            { name: 'viewport', content: 'width=device-width, initial-scale=1' },
            { name: 'robots', content: 'noindex, nofollow' },
            { name: 'color-scheme', content: 'dark light' },
         ],
      },
   },

   nitro: {
      // PGlite is a devDependency used only as the offline/test database. Keeping
      // it out of the bundle stops the build from inlining a WASM Postgres that
      // production never touches.
      externals: { external: ['@electric-sql/pglite'] },

      // Copied into `.output/public` at build time, so the deployment carries its
      // own docs assets and needs no CDN. Versioned by the lockfile.
      publicAssets: [{ dir: swaggerUiDir, baseURL: '/docs-assets', maxAge: 31_536_000 }],
   },

   // `express` is CommonJS and must stay external — bundling it breaks its
   // internal `require`.
   vite: {
      build: { target: 'esnext' },
   },
})
