import 'dotenv/config';

const int = (name, fallback) => {
   const raw = process.env[name];
   if (raw == null || raw === '') return fallback;
   const n = parseInt(raw, 10);
   if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
   return n;
};

const str = (name, fallback = null) => process.env[name] || fallback;

export const config = Object.freeze({
   port: int('PORT', 3000),
   publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
   // Number of reverse-proxy hops to trust for X-Forwarded-For. `true` would take
   // the client's own header at face value, letting anyone forge an IP.
   trustProxy: str('TRUST_PROXY', '1'),

   qrisString: str('QRIS_STRING'),

   pollMs: int('POLL_MS', 7000),
   // Periodic GoBiz session probe: catches an expired token before a payment poll
   // trips over it, and feeds session state to /health.
   sessionCheckMs: int('SESSION_CHECK_MS', 30_000),
   expireMinutes: int('EXPIRE_MINUTES', 5),
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
      sweepMs: int('WEBHOOK_SWEEP_MS', 30_000),
   }),

   isProduction: process.env.NODE_ENV === 'production',
});

/** Startup checks. Returns messages for the caller to log; `fatal` means don't boot. */
export function checkConfig(c = config) {
   const fatal = [];
   const warn = [];

   if (!c.qrisString) fatal.push('QRIS_STRING not set');
   if (c.uniqueCodeMax < 1) fatal.push('UNIQUE_CODE_MAX must be >= 1');

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
   if (c.pollMs < 7000) warn.push(`POLL_MS=${c.pollMs} is aggressive — risks a GoBiz account block`);
   if (c.sessionCheckMs < 10_000) {
      warn.push(`SESSION_CHECK_MS=${c.sessionCheckMs} is aggressive — risks a GoBiz account block`);
   }
   if (!c.webhook.url) warn.push('WEBHOOK_URL not set — events only reach per-transaction callbackUrl');

   return { fatal, warn };
}
