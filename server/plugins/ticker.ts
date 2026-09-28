// @ts-expect-error — plain JS, no type declarations
import { merchant, config } from '../../src/server.js'
// @ts-expect-error — plain JS, no type declarations
import { cycleIfStale } from '../../src/services/poller.js'
// @ts-expect-error — plain JS, no type declarations
import { log } from '../../src/logger.js'

const logger = log('ticker')

/**
 * Background maintenance cycle for an always-on host (pm2, Docker).
 *
 * On serverless there is no process between requests, so payer traffic drives
 * the cycle instead (see `cycleIfStale`). A long-lived process has no such limit,
 * and without this a payment is only noticed when someone reads a status: a
 * consumer that just waits for the webhook would never hear about it.
 *
 * Off unless BACKGROUND_POLL=1. It ticks every second but goes through the same
 * database throttle as request-driven cycles, so GoBiz is still called at most
 * once per POLL_MIN_INTERVAL_MS.
 */
const TICK_MS = 1000

export default defineNitroPlugin(() => {
  if (process.env.BACKGROUND_POLL !== '1' || process.env.VERCEL) return
  let running = false
  setInterval(() => {
    if (running) return
    running = true
    // The cycle logs its own step failures; this catches the throttle query
    // itself failing, e.g. while the database is unreachable.
    cycleIfStale(merchant, config.pollMinIntervalMs)
      .catch((e: any) => logger.error(e.message))
      .finally(() => { running = false })
  }, TICK_MS)
})
