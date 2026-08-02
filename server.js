/**
 * Self-hosted payment gateway on top of GoBiz/GoPay Merchant.
 *
 * Upstream GoPay history reports only the *amount* of an incoming payment — there
 * is no way to attach our own trxId. So every pending transaction gets a unique
 * payable amount (base + a sequential code) and payments are matched back by it.
 *
 * State lives in SQLite; expiry timers and owed webhooks are rebuilt on boot.
 */
import http from 'node:http';
import GoPayMerchant, { GoPayWatcher } from './lib/gobiz.js';
import { config, checkConfig } from './src/config.js';
import { log, dim, fg, bold, useColor } from './src/logger.js';
import { createApp } from './src/app.js';
import * as database from './src/db/index.js';
import * as payments from './src/services/payments.js';
import * as webhooks from './src/services/webhooks.js';
import { startKeepalive, check as checkSession } from './src/services/session.js';

const logBoot = log('server');

const { fatal, warn } = checkConfig();
for (const message of warn) logBoot.warn(message);
if (fatal.length) {
   for (const message of fatal) logBoot.error(`FATAL: ${message}`);
   process.exit(1);
}

const merchant = new GoPayMerchant({
   token: process.env.GOPAY_ACCESS_TOKEN || null,
   merchantId: process.env.GOPAY_MERCHANT_ID || null,
});

const watcher = new GoPayWatcher(merchant, config.pollMs);
watcher.on('payment', (event) => payments.reconcile(event));
watcher._listeners++;
watcher._startPoller();

const app = createApp();
const server = http.createServer(app);
const stopSweeper = webhooks.startSweeper();
const stopKeepalive = startKeepalive(merchant);

function banner() {
   const base = config.publicUrl || `http://localhost:${config.port}`;
   if (!useColor) {
      console.log(`\n  GoBiz Payment Gateway\n  API  ${base}\n  Docs ${base}/docs\n`);
      return;
   }
   console.log([
      '',
      fg(36, '  ┌─────────────────────────────────────────────┐'),
      fg(36, '  │') + bold('   GoBiz Payment Gateway') + fg(36, '                    │'),
      fg(36, '  └─────────────────────────────────────────────┘'),
      `  ${dim('API ')} ${base}`,
      `  ${dim('Docs')} ${base}/docs`,
      '',
   ].join('\n'));
}

server.listen(config.port, async () => {
   banner();
   logBoot.ok(`listening on :${config.port}`);
   payments.restorePending();

   const owed = webhooks.owedCount();
   if (owed) logBoot.info(`${owed} webhook(s) owed — retrying in background`);

   try {
      await merchant.init();
      logBoot.ok('GoPay merchant authenticated');
      await checkSession(merchant); // seed session health so /health isn't "unknown"
   } catch (e) {
      logBoot.warn(`GoPay auth failed (will retry on poll): ${e.message}`);
   }
   logBoot.info(`session health check every ${Math.round(config.sessionCheckMs / 1000)}s`);
});

// PM2 sends SIGINT/SIGTERM on restart. Stop accepting work, then close cleanly.
let shuttingDown = false;
function shutdown(signal) {
   if (shuttingDown) return;
   shuttingDown = true;
   logBoot.info(`${signal} received, closing...`);

   watcher._stopPoller();
   stopSweeper();
   stopKeepalive();
   payments.clearAllTimers();

   server.close(() => {
      try { database.close(); } catch {}
      logBoot.ok('shutdown done');
      process.exit(0);
   });

   // Hard cap so a hung connection can't block PM2's restart forever.
   setTimeout(() => {
      logBoot.error('shutdown forced after 10s');
      process.exit(1);
   }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
   logBoot.error(`unhandled rejection: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
   logBoot.error(`uncaught exception: ${err.stack || err.message}`);
   shutdown('uncaughtException');
});

export { app, server };
