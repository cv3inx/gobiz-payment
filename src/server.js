/**
 * The single Express instance the Nitro middleware mounts.
 *
 * Built once per process, not per request: a serverless instance is reused across
 * invocations, and rebuilding the router (plus its rate-limit map) every time would
 * throw that warm state away.
 *
 * Fatal misconfiguration throws here, on first import. That fails the request with
 * the reason in the logs instead of quietly serving a gateway that cannot take
 * money safely.
 */
import GoPayMerchant from '../lib/gobiz.js';
import { config, checkConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './app.js';

const logBoot = log('server');

const { fatal, warn } = checkConfig();
for (const message of warn) logBoot.warn(message);
if (fatal.length) {
   for (const message of fatal) logBoot.error(`FATAL: ${message}`);
   throw new Error(`Misconfigured: ${fatal.join('; ')}`);
}

export const merchant = new GoPayMerchant({
   token: process.env.GOPAY_ACCESS_TOKEN || null,
   merchantId: process.env.GOPAY_MERCHANT_ID || null,
});

export const apiApp = createApp({ merchant });
export { config };
