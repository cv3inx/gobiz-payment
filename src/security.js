// Security middleware — no external deps (no helmet/express-rate-limit needed
// for a single-process self-hosted gateway).
// ponytail: in-memory rate limiter, fixed window. Swap for Redis + sliding
// window if you run multiple instances or need precise limits.
import crypto from 'node:crypto';

/** Constant-time string compare that won't throw on length mismatch. */
export function safeEqual(a, b) {
   const ba = Buffer.from(String(a));
   const bb = Buffer.from(String(b));
   if (ba.length !== bb.length) {
      // still burn a compare to keep timing flat
      crypto.timingSafeEqual(ba, ba);
      return false;
   }
   return crypto.timingSafeEqual(ba, bb);
}

/** Baseline hardening headers. */
export function securityHeaders(req, res, next) {
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('X-Frame-Options', 'DENY');
   res.setHeader('Referrer-Policy', 'no-referrer');
   res.setHeader('Content-Security-Policy', "default-src 'none'");
   res.removeHeader('X-Powered-By');
   next();
}

/**
 * API-key guard (timing-safe). Reads the `X-API-Key` header. No-op if apiKey
 * is falsy. Also accepts `Authorization: Bearer <key>` as a fallback.
 * @param {string|null} apiKey
 */
export function requireApiKey(apiKey) {
   return (req, res, next) => {
      if (!apiKey) return next();
      const headerKey = req.get('x-api-key') || '';
      const auth = req.get('authorization') || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const provided = headerKey || bearer;
      if (provided && safeEqual(provided, apiKey)) return next();
      return res.status(401).json({ success: false, error: 'unauthorized' });
   };
}

/**
 * Fixed-window in-memory rate limiter, keyed by client IP.
 * @param {{ windowMs?: number, max?: number }} [opts]
 */
export function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
   /** @type {Map<string, { count: number, reset: number }>} */
   const hits = new Map();
   return (req, res, next) => {
      const now = Date.now();
      const key = req.ip || req.socket?.remoteAddress || 'unknown';
      let rec = hits.get(key);
      if (!rec || now > rec.reset) {
         rec = { count: 0, reset: now + windowMs };
         hits.set(key, rec);
      }
      rec.count++;
      const remaining = Math.max(0, max - rec.count);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      if (rec.count > max) {
         res.setHeader('Retry-After', Math.ceil((rec.reset - now) / 1000));
         return res.status(429).json({ success: false, error: 'rate limited' });
      }
      // opportunistic sweep so the map can't grow unbounded
      if (hits.size > 10_000) {
         for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
      }
      next();
   };
}

/** HMAC-SHA256 signature of a raw string body. */
export function signBody(bodyStr, secret) {
   return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

// ── SSRF guard for caller-supplied webhook URLs ──────────────────────────────
// A malicious `callbackUrl` could point the gateway at internal services
// (cloud metadata 169.254.169.254, localhost:6379, ...). Reject non-http(s) and
// obviously-internal hosts. ponytail: string/literal-IP checks only — no DNS
// resolution. A hostname that resolves to a private IP still slips through;
// add DNS pinning if the gateway runs in a network where that matters.
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '169.254.169.254', 'metadata.google.internal']);

function isPrivateIp(host) {
   // IPv4 literals
   const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
   if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 10) return true;                       // 10.0.0.0/8
      if (a === 127) return true;                      // loopback
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true;         // 192.168.0.0/16
      if (a === 169 && b === 254) return true;         // link-local / metadata
      if (a === 0) return true;
      return false;
   }
   // IPv6 loopback / link-local / unique-local
   const h = host.replace(/^\[|\]$/g, '').toLowerCase();
   if (h === '::1' || h === '::') return true;
   if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
   return false;
}

/**
 * Validate a caller-supplied webhook URL. Returns { ok, error }.
 * Only http/https, no internal/private hosts, no credentials in the URL.
 */
export function validateWebhookUrl(raw) {
   let url;
   try {
      url = new URL(raw);
   } catch {
      return { ok: false, error: 'callbackUrl is not a valid URL' };
   }
   if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'callbackUrl must be http or https' };
   }
   if (url.username || url.password) {
      return { ok: false, error: 'callbackUrl must not contain credentials' };
   }
   const host = url.hostname.toLowerCase();
   if (BLOCKED_HOSTNAMES.has(host) || isPrivateIp(host)) {
      return { ok: false, error: 'callbackUrl points to a blocked/internal host' };
   }
   return { ok: true };
}

/**
 * Verify an incoming webhook signature. For consumers of THIS gateway —
 * exported so downstream apps can import the same check.
 * @param {string} rawBody
 * @param {string} signature - value from X-Signature header
 * @param {string} secret
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
   return safeEqual(signBody(rawBody, secret), signature || '');
}
