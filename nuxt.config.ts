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
   },

   // `swagger-ui-express` and `express` are CommonJS and must stay external —
   // bundling them breaks their internal `require` of static assets.
   vite: {
      build: { target: 'esnext' },
   },
})
