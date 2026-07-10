import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import crc from 'crc';
import QRCode from 'qrcode';
import GoPayMerchant, { GoPayWatcher } from './lib/gobiz.js';
import * as store from './src/db.js';
import { openApiSpec } from './src/openapi.js';
import { log, badge, padScope, dim, fg, bold, useColor, LEVEL_META } from './src/logger.js';
import {
   securityHeaders,
   requireApiKey,
   rateLimit,
   signBody,
   validateWebhookUrl,
} from './src/security.js';

const logHttp = log('http');
const logTrx = log('trx');
const logWebhook = log('webhook');
const logBoot = log('server');

/*
 * Self-hosted payment gateway on top of GoBiz/GoPay merchant.
 *
 * Reality check: upstream GoPay history reports only the *amount* of an
 * incoming payment — no way to inject our own trxId. So each pending trx gets a
 * UNIQUE amount (base + small offset) and the `payment` event is matched back to
 * a trxId by that exact amount.
 *
 * State lives in SQLite (src/db.js) so it survives restarts. Pending timers are
 * rebuilt on boot.
 */

const PORT = parseInt(process.env.PORT || '3000', 10);
const QRIS_STRING = process.env.QRIS_STRING;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change-me';
const API_KEY = process.env.API_KEY || null;
const POLL_MS = parseInt(process.env.POLL_MS || '7000', 10);
// Expiry is configured in MINUTES (humans think in minutes, not ms).
const DEFAULT_EXPIRE_MIN = parseInt(process.env.EXPIRE_MINUTES || '5', 10);
const RATE_MAX = parseInt(process.env.RATE_MAX || '60', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://pay.tokoku.com
// Unique code (rupiah) ALWAYS added to amount+fee so each pending trx has a
// distinct payable amount — this is the match key (no trxId in GoPay history).
// e.g. amount 100 + code 52 => payer scans/pays 152.
const UNIQUE_CODE_MAX = parseInt(process.env.UNIQUE_CODE_MAX || '999', 10);

if (!QRIS_STRING) {
   logBoot.error('FATAL: QRIS_STRING not set in .env');
   process.exit(1);
}

// pending expiry timers, keyed by trxId (not persisted — rebuilt on boot)
const timers = new Map();

// ── QRIS helpers (lifted from demo.js) ──────────────────────────────────────
function convertCRC16(str) {
   const c = crc.crc16ccitt(Buffer.from(str, 'utf8')).toString(16).toUpperCase();
   return ('0000' + c).slice(-4);
}

function buildDynamicQris(staticQris, amount) {
   const data = staticQris.endsWith('6304') ? staticQris : staticQris.slice(0, -4);
   const step1 = data.replace('010211', '010212');
   if (!step1.includes('5802ID')) throw new Error('Invalid QRIS_STRING format');
   const [before, after] = step1.split('5802ID');
   const nominalField = '54' + String(amount.toString().length).padStart(2, '0') + amount;
   const raw = before + nominalField + '5802ID' + after;
   return raw + convertCRC16(raw);
}

// Public shape of a transaction. `amountToPay` = amount + fee + uniqueCode, and
// is the one figure the payer transfers / the QR encodes / the gateway matches.
// baseUrl makes qrImageUrl absolute: PUBLIC_URL env, else the request's own
// scheme+host (honors X-Forwarded-* via `trust proxy`).
function toPublic(trx, baseUrl = '') {
   const qrPath = `/payment/${trx.trxId}/qr.png`;
   return {
      trxId: trx.trxId,
      status: trx.status,
      amount: trx.amount,
      fee: trx.fee,
      uniqueCode: trx.payAmount - trx.total, // random code added for matching
      amountToPay: trx.payAmount,
      qrString: trx.qrString,
      qrImageUrl: baseUrl ? baseUrl + qrPath : qrPath,
      callbackUrl: trx.callbackUrl || null,
      metadata: trx.metadata || null,
      createdAt: trx.createdAt,
      expiresAt: trx.expiresAt,
      paidAt: trx.paidAt || null,
   };
}

/** Resolve the public base URL for a request: PUBLIC_URL env wins, else derived. */
function baseUrlFor(req) {
   return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// Pick amount = base + a random unique code (1..UNIQUE_CODE_MAX). The code is
// ALWAYS added, so the payer always transfers a slightly-off figure the gateway
// can match to exactly one pending trx. Tries random codes first, then falls
// back to a full scan so we don't fail while free slots remain.
// Generate a trxId like TRX-K3F9Q2A7X1B4: prefix + 12 base32 chars (no 0/1/O/I
// to stay unambiguous), from crypto random. ~10^18 space — collision unrealistic.
function genTrxId() {
   const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
   const bytes = crypto.randomBytes(12);
   let s = '';
   for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
   return `TRX-${s}`;
}

function pickUniqueAmount(base) {
   const tries = Math.min(20, UNIQUE_CODE_MAX);
   for (let i = 0; i < tries; i++) {
      const code = 1 + Math.floor(Math.random() * UNIQUE_CODE_MAX);
      if (!store.getPendingByAmount(base + code)) return base + code;
   }
   for (let code = 1; code <= UNIQUE_CODE_MAX; code++) {
      if (!store.getPendingByAmount(base + code)) return base + code;
   }
   throw new Error(`No free unique-code slot near ${base} (too many concurrent trx)`);
}

async function fireWebhook(trx) {
   const url = trx.callbackUrl || WEBHOOK_URL;
   if (!url) return;
   const payload = {
      event: trx.status === 'PAID' ? 'payment.paid' : 'payment.expired',
      trxId: trx.trxId,
      status: trx.status,
      amount: trx.amount,
      fee: trx.fee,
      uniqueCode: trx.payAmount - trx.total,
      amountToPay: trx.payAmount,
      paidAt: trx.paidAt || null,
      metadata: trx.metadata || null,
   };
   const bodyStr = JSON.stringify(payload);
   const signature = signBody(bodyStr, WEBHOOK_SECRET);
   for (let attempt = 1; attempt <= 3; attempt++) {
      try {
         const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
            body: bodyStr,
         });
         if (res.ok) { logWebhook.ok(`${trx.trxId} delivered (HTTP ${res.status})`); return; }
         logWebhook.warn(`${trx.trxId} attempt ${attempt} → HTTP ${res.status}`);
      } catch (e) {
         // undici's "fetch failed" hides the real reason in e.cause
         const why = e.cause?.code || e.cause?.message || e.message;
         logWebhook.warn(`${trx.trxId} attempt ${attempt} failed: ${why} (${url})`);
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
   }
   logWebhook.error(`${trx.trxId} gave up after 3 attempts`);
}

function clearTimer(trxId) {
   const t = timers.get(trxId);
   if (t) { clearTimeout(t); timers.delete(trxId); }
}

function expireTrx(trx) {
   if (trx.status !== 'PENDING') return;
   trx.status = 'EXPIRED';
   store.updateStatus(trx);
   clearTimer(trx.trxId);
   fireWebhook(trx);
}

function markPaid(trx, entry) {
   if (trx.status !== 'PENDING') return;
   trx.status = 'PAID';
   trx.paidAt = new Date().toISOString();
   trx.entry = entry || null;
   store.updateStatus(trx);
   clearTimer(trx.trxId);
   logTrx.ok(`PAID ${trx.trxId} amountToPay=${trx.payAmount}`);
   fireWebhook(trx);
}

function scheduleExpiry(trx) {
   const ms = new Date(trx.expiresAt).getTime() - Date.now();
   const timer = setTimeout(() => {
      const fresh = store.getTrx(trx.trxId);
      if (fresh) expireTrx(fresh);
   }, Math.max(0, ms));
   timers.set(trx.trxId, timer);
}

// ── Watcher wiring ───────────────────────────────────────────────────────────
// Auth: either email/password (auto-login) OR a ready access_token +
// merchant_id lifted from the browser (F12 → Cookies). Token wins when set.
const merchant = new GoPayMerchant({
   token: process.env.GOPAY_ACCESS_TOKEN || null,
   merchantId: process.env.GOPAY_MERCHANT_ID || null,
});
const watcher = new GoPayWatcher(merchant, POLL_MS);

watcher.on('payment', ({ amount, txId, entry }) => {
   const trx = store.getPendingByAmount(amount);
   if (trx) markPaid(trx, entry);

   // archive every incoming GoBiz transaction + reconcile against our orders
   try {
      store.upsertHistory({
         gobizId: txId,
         amount,
         time: entry?.time ?? null,
         matchedTrxId: trx ? trx.trxId : null,
         raw: entry ?? null,
         seenAt: new Date().toISOString(),
      });
   } catch (e) {
      log('history').warn(`archive failed: ${e.message}`);
   }
});

watcher._listeners++;
watcher._startPoller();

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true); // honor X-Forwarded-For when behind a reverse proxy

// Request log using the shared logger style: same badge/scope/columns.
morgan.token('ts', () => new Date().toTimeString().slice(0, 8));
const statusColor = (s) => {
   if (!useColor) return s;
   const n = parseInt(s, 10);
   const code = n >= 500 ? 31 : n >= 400 ? 33 : n >= 300 ? 36 : 32;
   return `\x1b[1;${code}m${s}\x1b[0m`;
};
const methodColor = (m) => (useColor ? fg(35, m.padEnd(4)) : m.padEnd(4));
app.use(morgan((tokens, req, res) => {
   const status = tokens.status(req, res) || '---';
   const ms = `${tokens['response-time'](req, res) || '0'}ms`;
   return [
      dim(tokens.ts()),
      badge(LEVEL_META.http),
      useColor ? fg(36, padScope('http')) : padScope('http'),
      dim('│'),
      statusColor(status),
      methodColor(tokens.method(req, res)),
      tokens.url(req, res),
      dim(ms),
   ].join(' ');
}));

// Swagger UI mounted before the strict CSP — its inline assets need a looser
// policy. ponytail: the docs page is public; gate it behind auth only if the
// API surface itself is sensitive.
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
   customSiteTitle: 'GoBiz Payment Gateway — API Docs',
}));
app.get('/openapi.json', (req, res) => res.json(openApiSpec));

app.use(securityHeaders);
app.use(express.json({ limit: '64kb' }));
app.use(rateLimit({ max: RATE_MAX }));

const guard = requireApiKey(API_KEY);

app.get('/health', (req, res) => {
   res.json({ success: true, data: store.counts() });
});

// Create payment
app.post('/payment/create', guard, (req, res) => {
   const amount = parseInt(req.body?.amount, 10);
   if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be a positive integer' });
   }
   const fee = req.body?.fee == null ? 0 : parseInt(req.body.fee, 10);
   if (!Number.isInteger(fee) || fee < 0) {
      return res.status(400).json({ success: false, error: 'fee must be a non-negative integer' });
   }
   const total = amount + fee;
   // expireMinutes in the body (humans think in minutes). Validate if present.
   const expireMinutes = req.body?.expireMinutes == null
      ? DEFAULT_EXPIRE_MIN
      : parseInt(req.body.expireMinutes, 10);
   if (!Number.isInteger(expireMinutes) || expireMinutes <= 0) {
      return res.status(400).json({ success: false, error: 'expireMinutes must be a positive integer' });
   }
   const expireMs = expireMinutes * 60_000;

   // reject caller-supplied webhook URLs that point at internal services (SSRF)
   const callbackUrl = typeof req.body?.callbackUrl === 'string' ? req.body.callbackUrl : null;
   if (callbackUrl) {
      const check = validateWebhookUrl(callbackUrl);
      if (!check.ok) return res.status(400).json({ success: false, error: check.error });
   }

   // optional caller-supplied trxId (must be unique); else generate one
   let trxId = req.body?.trxId;
   if (trxId != null) {
      trxId = String(trxId);
      if (!/^[\w.-]{1,64}$/.test(trxId)) {
         return res.status(400).json({
            success: false,
            error: 'trxId must be 1-64 chars: letters, digits, _ . -',
         });
      }
      if (store.getTrx(trxId)) {
         return res.status(409).json({ success: false, error: 'trxId already exists' });
      }
   } else {
      trxId = genTrxId();
   }

   // idempotency: same key returns the original trx instead of a duplicate charge
   const idempotencyKey = req.get('idempotency-key') || req.body?.idempotencyKey || null;
   if (idempotencyKey) {
      const existing = store.getByIdempotencyKey(idempotencyKey);
      if (existing) {
         return res.status(200).json({
            success: true,
            idempotent: true,
            data: toPublic(existing, baseUrlFor(req)),
         });
      }
   }

   let payAmount;
   try {
      payAmount = pickUniqueAmount(total);
   } catch (e) {
      return res.status(503).json({ success: false, error: e.message });
   }

   let qrString;
   try {
      qrString = buildDynamicQris(QRIS_STRING, payAmount);
   } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
   }

   const trx = {
      trxId,
      status: 'PENDING',
      amount,
      fee,
      total,
      payAmount,
      qrString,
      callbackUrl,
      idempotencyKey,
      metadata: req.body?.metadata ?? null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expireMs).toISOString(),
      paidAt: null,
      entry: null,
   };
   try {
      store.insertTrx(trx);
   } catch (e) {
      // unique index race on pending payAmount or idempotencyKey
      return res.status(503).json({ success: false, error: 'slot taken, retry' });
   }
   scheduleExpiry(trx);
   logTrx.info(`CREATE ${trx.trxId} amount=${amount} fee=${fee} amountToPay=${payAmount}`);

   res.status(201).json({
      success: true,
      data: toPublic(trx, baseUrlFor(req)),
   });
});

// List payments (paginated, optional ?status=)
app.get('/payments', guard, (req, res) => {
   const status = req.query.status ? String(req.query.status).toUpperCase() : null;
   const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
   const offset = parseInt(req.query.offset, 10) || 0;
   const rows = store.listTrx({ status, limit, offset });
   const base = baseUrlFor(req);
   const data = rows.map((t) => toPublic(t, base));
   res.json({ success: true, data, meta: { limit, offset, count: data.length } });
});

// GoBiz transaction history (archived from the watcher). ?matched=true|false
app.get('/history', guard, (req, res) => {
   const matched = req.query.matched == null ? null : req.query.matched === 'true';
   const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
   const offset = parseInt(req.query.offset, 10) || 0;
   const data = store.listHistory({ matched, limit, offset });
   res.json({ success: true, data, meta: { limit, offset, count: data.length } });
});

// Check payment by trxId
app.get('/payment/:trxId', (req, res) => {
   const trx = store.getTrx(req.params.trxId);
   if (!trx) return res.status(404).json({ success: false, error: 'not found' });
   res.json({ success: true, data: toPublic(trx, baseUrlFor(req)) });
});

// QR PNG
app.get('/payment/:trxId/qr.png', async (req, res) => {
   const trx = store.getTrx(req.params.trxId);
   if (!trx) return res.status(404).json({ success: false, error: 'not found' });
   try {
      const png = await QRCode.toBuffer(trx.qrString, { scale: 8, errorCorrectionLevel: 'M' });
      res.type('png').send(png);
   } catch (e) {
      res.status(500).json({ success: false, error: e.message });
   }
});

// Manual cancel/expire
app.post('/payment/:trxId/cancel', guard, (req, res) => {
   const trx = store.getTrx(req.params.trxId);
   if (!trx) return res.status(404).json({ success: false, error: 'not found' });
   if (trx.status !== 'PENDING') {
      return res.status(409).json({ success: false, error: `cannot cancel ${trx.status} trx` });
   }
   expireTrx(trx);
   res.json({ success: true, data: toPublic(trx, baseUrlFor(req)) });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
function restorePending() {
   const pending = store.listPending();
   for (const trx of pending) {
      if (new Date(trx.expiresAt).getTime() <= Date.now()) {
         expireTrx(trx); // was due while process was down
      } else {
         scheduleExpiry(trx);
      }
   }
   if (pending.length) logBoot.info(`restored ${pending.length} pending trx`);
}

function banner() {
   const base = PUBLIC_URL || `http://localhost:${PORT}`;
   const lines = [
      '',
      fg(36, '  ┌─────────────────────────────────────────────┐'),
      fg(36, '  │') + bold('   GoBiz Payment Gateway') + fg(36, '                    │'),
      fg(36, '  └─────────────────────────────────────────────┘'),
      `  ${dim('API ')} ${base}`,
      `  ${dim('Docs')} ${base}/docs`,
      '',
   ];
   console.log(useColor ? lines.join('\n') : `\n  GoBiz Payment Gateway\n  API  ${base}\n  Docs ${base}/docs\n`);
}

const server = http.createServer(app);
server.listen(PORT, async () => {
   banner();
   logBoot.ok(`listening on :${PORT}`);
   restorePending();
   try {
      await merchant.init();
      logBoot.ok('GoPay merchant authenticated');
   } catch (e) {
      logBoot.warn(`GoPay auth failed (will retry on poll): ${e.message}`);
   }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// PM2 sends SIGINT/SIGTERM on restart/stop. Stop accepting connections, stop the
// poller, cancel pending expiry timers, and close SQLite cleanly.
let shuttingDown = false;
function shutdown(signal) {
   if (shuttingDown) return;
   shuttingDown = true;
   logBoot.info(`${signal} received, closing...`);
   watcher._stopPoller();
   for (const t of timers.values()) clearTimeout(t);
   timers.clear();
   server.close(() => {
      try { store.default.close(); } catch {}
      logBoot.ok('shutdown done');
      process.exit(0);
   });
   // hard cap so a hung connection can't block PM2's restart forever
   setTimeout(() => {
      logBoot.error('shutdown forced after 10s');
      process.exit(1);
   }, 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, buildDynamicQris };
