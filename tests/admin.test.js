import assert from 'node:assert';
import { createSuite, setupDatabase, useTempEnv } from './helpers.js';

useTempEnv({
   API_KEY: 'admin-key',
   UNIQUE_CODE_MAX: '99',
   // Tight enough that a test can step past it, loose enough to prove throttling.
   POLL_MIN_INTERVAL_MS: '400',
});

const db = await setupDatabase();
const { createApp } = await import('../src/app.js');

/** Counts how often the poller actually reaches upstream. */
const upstream = { calls: 0, history: [] };
const merchant = {
   token: 'tok',
   _initialized: true,
   _isTokenValid: async () => true,
   init: async () => {},
   getHistory: async () => { upstream.calls++; return upstream.history; },
};

const server = createApp({ merchant }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const AUTH = { 'Content-Type': 'application/json', 'X-API-Key': 'admin-key' };

const call = async (method, path, { headers = AUTH, body } = {}) => {
   const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
   });
   const text = await res.text();
   try {
      return { status: res.status, body: JSON.parse(text), type: res.headers.get('content-type'), headers: res.headers };
   } catch {
      return { status: res.status, body: text, type: res.headers.get('content-type'), headers: res.headers };
   }
};

const payin = (gobizId, amount) => ({
   gobizId, amount, time: '01 Jan 2026 - 10:00:00',
   raw: { transaction_id: gobizId, gross_amount: amount * 100, status: 'SETTLEMENT' },
});

const { test, report } = createSuite('admin');
const results = {};

// Seed pass first, so later polls are live rather than seeding.
await call('POST', '/api/admin/poll');

results.statsNoKey = await call('GET', '/api/admin/stats', { headers: {} });
results.pollNoKey = await call('POST', '/api/admin/poll', { headers: {} });
results.drainNoKey = await call('POST', '/api/admin/webhooks/drain', { headers: {} });

const paid = await call('POST', '/payment/create', { body: { amount: 25_000, fee: 500 } });
const paidId = paid.body.data.trxId;
const paidAmount = paid.body.data.amountToPay;
const expiring = await call('POST', '/payment/create', { body: { amount: 31_000 } });

// A payment lands; force the cycle so it reconciles.
upstream.history = [payin('GB-A', paidAmount), payin('GB-ORPHAN', 888_111)];
results.manualPoll = await call('POST', '/api/admin/poll');

results.stats = await call('GET', '/api/admin/stats?days=7');
results.payments = await call('GET', '/payments?limit=15');
results.statsClamped = await call('GET', '/api/admin/stats?days=9999');

// ── poll-on-read throttle ────────────────────────────────────────────────────
// Reading a PENDING payment drives a poll, but the floor is global: a burst of
// reads must produce at most one upstream call.
upstream.history = [];
const pendingId = expiring.body.data.trxId;
await new Promise((r) => setTimeout(r, 450)); // let the slot go stale
const before = upstream.calls;
await Promise.all(Array.from({ length: 8 }, () => call('GET', `/payment/${pendingId}`)));
results.burstCalls = upstream.calls - before;

await new Promise((r) => setTimeout(r, 450));
const beforeSecond = upstream.calls;
await call('GET', `/payment/${pendingId}`);
results.afterIntervalCalls = upstream.calls - beforeSecond;

// A settled transaction has nobody waiting on it, so it must not poll at all.
const beforeSettled = upstream.calls;
await new Promise((r) => setTimeout(r, 450));
await call('GET', `/payment/${paidId}`);
results.settledCalls = upstream.calls - beforeSettled;

results.drain = await call('POST', '/api/admin/webhooks/drain');

// ── assertions ───────────────────────────────────────────────────────────────
test('admin endpoints require the API key', () => {
   assert.strictEqual(results.statsNoKey.status, 401);
   assert.strictEqual(results.pollNoKey.status, 401);
   assert.strictEqual(results.drainNoKey.status, 401);
});

test('manual poll reconciles without waiting for a schedule', () => {
   assert.strictEqual(results.manualPoll.status, 200);
   assert.strictEqual(results.manualPoll.body.data.poll.matched, 1);
});

test('stats report counts, revenue, and unmatched money', () => {
   assert.strictEqual(results.stats.status, 200);
   const { summary } = results.stats.body.data;
   assert.strictEqual(summary.paid, 1, 'the reconciled order');
   assert.strictEqual(summary.revenueAll, 25_500, 'amount + fee, not payAmount');
   assert.strictEqual(summary.revenueToday, 25_500, 'attributed to the paid date');
   assert.strictEqual(summary.unmatchedPayments, 1, 'the orphan payin');
   assert.strictEqual(summary.unmatchedValue, 888_111);
   assert.ok(summary.conversionRate > 0 && summary.conversionRate <= 1);
});

test('stats include a gap-filled daily series', () => {
   const { daily } = results.stats.body.data;
   assert.strictEqual(daily.length, 7, 'one entry per requested day, zeros included');
   assert.ok(daily.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)), 'ISO days');
   assert.ok(daily.some((d) => d.paid === 1), 'the paid order shows up');
});

test('the dashboard table comes from /payments, with webhook diagnostics', () => {
   // One source for the feed. It must carry what an operator needs to debug a
   // failing webhook, not just its attempt count.
   const rows = results.payments.body.data;
   const row = rows.find((t) => t.trxId === paidId);
   assert.ok(row, '/payments lists the reconciled order');
   // The public shape calls it amountToPay, not payAmount — the dashboard reads
   // this endpoint, so the name it exposes is the one that matters.
   assert.strictEqual(typeof row.amountToPay, 'number', 'bigint decoded');
   assert.strictEqual(row.amountToPay, row.amount + row.fee + row.uniqueCode);
   assert.ok('webhook' in row, 'delivery state present');
   assert.ok('metadata' in row, 'metadata present');
});

test('stats surface poll freshness and the days window is clamped', () => {
   assert.ok(results.stats.body.data.poll.lastPollAt, 'reports when detection last ran');
   assert.ok(results.stats.body.data.poll.staleSeconds != null);
   assert.strictEqual(results.statsClamped.body.data.daily.length, 90, 'days clamped to 90');
});

test('the global poll throttle collapses a burst of reads into one upstream call', () => {
   // Without a DB-level gate each concurrent read would hit GoBiz and get the
   // account rate-limited.
   assert.strictEqual(results.burstCalls, 1, `8 concurrent reads caused ${results.burstCalls} upstream calls`);
});

test('a read after the interval is allowed to poll again', () => {
   assert.strictEqual(results.afterIntervalCalls, 1);
});

test('reading a settled transaction never polls upstream', () => {
   assert.strictEqual(results.settledCalls, 0);
});

test('the manual webhook drain reports what it attempted', () => {
   assert.strictEqual(results.drain.status, 200);
   assert.ok(typeof results.drain.body.data.attempted === 'number');
});

const ok = await report();
server.close();
await db.close();
process.exit(ok ? 0 : 1);
