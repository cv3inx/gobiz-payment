import { fromNodeMiddleware } from 'h3'
// @ts-expect-error — plain JS, no type declarations
import { apiApp } from '../../src/server.js'

/**
 * Hand API traffic to the Express app.
 *
 * Nitro middleware runs before route matching, so the payment API keeps its exact
 * public paths (`/payment/*`, `/payments`, `/health`, ...) while Nuxt owns
 * everything else. Nothing about the API had to be rewritten as a Nitro handler.
 *
 * Anything NOT listed here falls through to Nuxt: `/` and `/admin` are Vue pages.
 * The admin *data* endpoints deliberately sit under `/api/admin/` so they cannot
 * collide with the `/admin` page route.
 */
const API_PREFIXES = [
   '/payment',   // covers /payment/create and /payment/:trxId/*
   '/payments',
   '/history',
   '/health',
   '/api/admin',
   '/docs',
   '/openapi.json',
]

const handleWithExpress = fromNodeMiddleware(apiApp)

const isApiPath = (path: string) => {
   const clean = path.split('?')[0]
   return API_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`))
}

export default defineEventHandler(async (event) => {
   if (!isApiPath(event.path)) return
   return handleWithExpress(event)
})
