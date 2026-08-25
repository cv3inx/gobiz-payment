import 'dotenv/config';

const int = (name, fallback) => {
   const raw = process.env[name];
   if (raw == null || raw === '') return fallback;
   const n = parseInt(raw, 10);
   if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
   return n;
};

const str = (name, fallback = null) => process.env[name] || fallback;

/**
 * Ceiling on a transaction's lifetime.
 *
 * Not arbitrary: expiry is enforced against `expiresAt` as an ISO string, but a
 * caller asking for months keeps a payable amount reserved that long, and only
 * UNIQUE_CODE_MAX amounts exist per base price. 7 days is generous for QRIS.
 */
const MAX_EXPIRE_MINUTES = 7 * 24 * 60;

export const config = Object.freeze({
   port: int('PORT', 3000),
   // Vercel injects its own production hostname, so qrImageUrl is absolute
   // without anyone setting PUBLIC_URL by hand.
   publicUrl: (
      process.env.PUBLIC_URL
      || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
      || ''
   ).replace(/\/$/, ''),
   // Vercel puts exactly one proxy hop in front of the function. `true` would take
   // the client's own header at face value, letting anyone forge an IP.
   trustProxy: str('TRUST_PROXY', '1'),

   databaseUrl: str('DATABASE_URL'),
   qrisString: str('QRIS_STRING'),

   sessionCheckMs: int('SESSION_CHECK_MS', 30_000),

   // Floor between upstream polls, shared across instances. Reading a PENDING
   // payment's status is allowed to drive a poll, so this is what stands between
   // a busy checkout page and a rate-limited GoBiz account. Below 7s risks a block.
   pollMinIntervalMs: int('POLL_MIN_INTERVAL_MS', 7000),

   expireMinutes: int('EXPIRE_MINUTES', 5),
   maxExpireMinutes: MAX_EXPIRE_MINUTES,
   rateMax: int('RATE_MAX', 60),
   maxAmount: int('MAX_AMOUNT', 1_000_000_000),

   // Unique code (rupiah) added to amount+fee so each pending transaction has a
   // distinct payable amount — GoPay history reports only the amount, so this is
   // the only key we can match a payment back to an order with.
   uniqueCodeMax: int('UNIQUE_CODE_MAX', 99),

   apiKey: str('API_KEY'),
   webhook: Object.freeze({
      url: str('WEBHOOK_URL'),
      secret: str('WEBHOOK_SECRET', 'change-me'),
      timeoutMs: int('WEBHOOK_TIMEOUT_MS', 10_000),
      maxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 12),
      maxBackoffMs: int('WEBHOOK_MAX_BACKOFF_MS', 900_000),
   }),

   isProduction: process.env.NODE_ENV === 'production',
   isServerless: !!process.env.VERCEL,
});

/** Startup checks. Returns messages for the caller to log; `fatal` means don't serve. */
export function checkConfig(c = config) {
   const fatal = [];
   const warn = [];

   if (!c.databaseUrl && c.isServerless) {
      fatal.push('DATABASE_URL not set — serverless has no local database to fall back to');
   }
   if (!c.qrisString) fatal.push('QRIS_STRING not set');
   if (c.uniqueCodeMax < 1) fatal.push('UNIQUE_CODE_MAX must be >= 1');
   if (c.expireMinutes < 1 || c.expireMinutes > MAX_EXPIRE_MINUTES) {
      fatal.push(`EXPIRE_MINUTES must be between 1 and ${MAX_EXPIRE_MINUTES}`);
   }

   // A known secret means anyone can forge a "payment.paid" callback.
   if (c.webhook.secret === 'change-me') {
      const msg = 'WEBHOOK_SECRET is still the default "change-me" — signatures are forgeable';
      if (c.isProduction) fatal.push(msg);
      else warn.push(msg);
   }
   if (!c.apiKey) warn.push('API_KEY not set — write endpoints are OPEN');
   if (c.trustProxy === 'true') {
      warn.push('TRUST_PROXY=true trusts any client-supplied X-Forwarded-For — set a hop count instead');
   }
   if (!c.webhook.url) warn.push('WEBHOOK_URL not set — events only reach per-transaction callbackUrl');
   if (c.pollMinIntervalMs < 7000) {
      warn.push(`POLL_MIN_INTERVAL_MS=${c.pollMinIntervalMs} is aggressive — risks a GoBiz account block`);
   }
   if (c.isServerless) {
      warn.push('rate limit is per-instance on serverless — put a real limiter at the edge if you need a hard cap');
   }

   return { fatal, warn };
}
