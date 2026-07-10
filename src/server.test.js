// ponytail: one runnable self-check for pure logic + db + security.
// No server boot, no network. Uses a throwaway temp DB. Run: node src/server.test.js
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crc from 'crc';

// isolate the DB file BEFORE importing db.js
const tmpDb = path.join(os.tmpdir(), `gw-test-${crypto.randomUUID()}.db`);
process.env.DB_FILE = tmpDb;

const store = await import('./db.js');
const { safeEqual, signBody, verifyWebhookSignature } = await import('./security.js');

// ── QRIS logic (mirror of server.js) ─────────────────────────────────────────
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

const STATIC = '00020101021126001180002ID' + '5802ID' + '540520006304ABCD';

// 1. dynamic QRIS has valid trailing CRC + country tag
const q = buildDynamicQris(STATIC, 2050);
assert.ok(q.includes('5802ID'), 'retain country tag');
assert.strictEqual(q.slice(-4), convertCRC16(q.slice(0, -4)), 'CRC validates');
assert.throws(() => buildDynamicQris('nope', 1000), /Invalid QRIS/);

// ── DB: insert / get / pending-by-amount / status update ─────────────────────
function mkTrx(over = {}) {
   return {
      trxId: crypto.randomUUID(),
      status: 'PENDING',
      amount: 2000,
      fee: 0,
      total: 2000,
      payAmount: 2000,
      qrString: 'x',
      callbackUrl: null,
      idempotencyKey: null,
      metadata: { orderId: 42 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      paidAt: null,
      entry: null,
      ...over,
   };
}

const t1 = mkTrx({ payAmount: 3000 });
store.insertTrx(t1);
const got = store.getTrx(t1.trxId);
assert.strictEqual(got.payAmount, 3000);
assert.deepStrictEqual(got.metadata, { orderId: 42 }, 'metadata round-trips as JSON');

// pending-by-amount finds it, then not after paid
assert.ok(store.getPendingByAmount(3000), 'found while pending');
store.updateStatus({ ...t1, status: 'PAID', paidAt: new Date().toISOString(), entry: { t: 1 } });
assert.strictEqual(store.getPendingByAmount(3000), null, 'not pending after paid');
assert.strictEqual(store.getTrx(t1.trxId).status, 'PAID');
assert.deepStrictEqual(store.getTrx(t1.trxId).entry, { t: 1 });

// unique pending-amount index blocks a second PENDING at same amount
const a = mkTrx({ payAmount: 5000 });
store.insertTrx(a);
assert.throws(() => store.insertTrx(mkTrx({ payAmount: 5000 })), /UNIQUE|constraint/i,
   'unique pending payAmount enforced');
// but a PAID one at 5000 does NOT block (partial index only covers PENDING)
store.updateStatus({ ...a, status: 'PAID' });
store.insertTrx(mkTrx({ payAmount: 5000 }));
assert.ok(store.getPendingByAmount(5000), 'new pending allowed after prior paid');

// fee/total persist
const feeTrx = mkTrx({ payAmount: 7025, amount: 7000, fee: 25, total: 7025 });
store.insertTrx(feeTrx);
const gotFee = store.getTrx(feeTrx.trxId);
assert.strictEqual(gotFee.fee, 25);
assert.strictEqual(gotFee.total, 7025);
assert.strictEqual(gotFee.amount + gotFee.fee, gotFee.total, 'total = amount + fee');

// idempotency key: unique + lookup
const idemTrx = mkTrx({ payAmount: 8000, idempotencyKey: 'order-abc' });
store.insertTrx(idemTrx);
assert.strictEqual(store.getByIdempotencyKey('order-abc').trxId, idemTrx.trxId);
assert.throws(() => store.insertTrx(mkTrx({ payAmount: 8001, idempotencyKey: 'order-abc' })),
   /UNIQUE|constraint/i, 'duplicate idempotency key rejected');

// custom trxId: caller-supplied primary key round-trips + collision rejected
const custom = mkTrx({ trxId: 'order-9001', payAmount: 9001 });
store.insertTrx(custom);
assert.strictEqual(store.getTrx('order-9001').trxId, 'order-9001');
assert.throws(() => store.insertTrx(mkTrx({ trxId: 'order-9001', payAmount: 9002 })),
   /UNIQUE|constraint|PRIMARY/i, 'duplicate trxId rejected');

// list: paginated, filterable by status
const listed = store.listTrx({ limit: 100 });
assert.ok(listed.length >= 4);
assert.ok(store.listTrx({ status: 'PENDING', limit: 100 }).every((t) => t.status === 'PENDING'));

// counts
const c = store.counts();
assert.ok(c.total >= 3 && typeof c.pending === 'number');

// listPending returns only pending
assert.ok(store.listPending().every((t) => t.status === 'PENDING'));

// ── GoBiz history: upsert / exists / reconcile filter ────────────────────────
assert.ok(!store.historyExists('GB-1'), 'not archived yet');
store.upsertHistory({ gobizId: 'GB-1', amount: 52500, time: 't1', matchedTrxId: 'order-9001', raw: { x: 1 }, seenAt: new Date().toISOString() });
store.upsertHistory({ gobizId: 'GB-2', amount: 3000, time: 't2', matchedTrxId: null, seenAt: new Date().toISOString() });
assert.ok(store.historyExists('GB-1'), 'archived now');
assert.deepStrictEqual(store.listHistory({ matched: true }).map((h) => h.gobizId), ['GB-1'], 'matched filter');
assert.deepStrictEqual(store.listHistory({ matched: false }).map((h) => h.gobizId), ['GB-2'], 'unmatched filter');
assert.strictEqual(store.listHistory().length, 2, 'all history');
assert.deepStrictEqual(store.listHistory({ matched: true })[0].raw, { x: 1 }, 'raw JSON round-trips');
// upsert idempotent + backfills matchedTrxId without clobbering
store.upsertHistory({ gobizId: 'GB-2', amount: 3000, matchedTrxId: 'order-late', seenAt: new Date().toISOString() });
assert.strictEqual(store.listHistory({ matched: true }).length, 2, 'GB-2 now matched, no dup row');

// ── Security ─────────────────────────────────────────────────────────────────
assert.ok(safeEqual('abc', 'abc'));
assert.ok(!safeEqual('abc', 'abd'));
assert.ok(!safeEqual('abc', 'abcd'), 'length mismatch is false, no throw');

const body = JSON.stringify({ trxId: 'abc', status: 'PAID' });
const sig = signBody(body, 'secret');
assert.strictEqual(sig, signBody(body, 'secret'), 'deterministic');
assert.notStrictEqual(sig, signBody(body, 'other'), 'secret-dependent');
assert.ok(verifyWebhookSignature(body, sig, 'secret'), 'verify passes on good sig');
assert.ok(!verifyWebhookSignature(body, sig, 'wrong'), 'verify fails on wrong secret');
assert.ok(!verifyWebhookSignature(body, '', 'secret'), 'verify fails on empty sig');

// ── SSRF guard: validateWebhookUrl ───────────────────────────────────────────
const { validateWebhookUrl } = await import('./security.js');
// allowed
assert.ok(validateWebhookUrl('https://shop.example.com/hook').ok);
assert.ok(validateWebhookUrl('http://api.example.com:8080/cb').ok);
// blocked: bad scheme, internal hosts, credentials
assert.ok(!validateWebhookUrl('ftp://example.com').ok, 'non-http rejected');
assert.ok(!validateWebhookUrl('file:///etc/passwd').ok, 'file scheme rejected');
assert.ok(!validateWebhookUrl('http://localhost/x').ok, 'localhost rejected');
assert.ok(!validateWebhookUrl('http://127.0.0.1/x').ok, 'loopback rejected');
assert.ok(!validateWebhookUrl('http://169.254.169.254/latest/meta-data/').ok, 'cloud metadata rejected');
assert.ok(!validateWebhookUrl('http://10.0.0.5/x').ok, '10/8 rejected');
assert.ok(!validateWebhookUrl('http://172.16.3.4/x').ok, '172.16/12 rejected');
assert.ok(!validateWebhookUrl('http://192.168.1.1/x').ok, '192.168/16 rejected');
assert.ok(!validateWebhookUrl('http://[::1]/x').ok, 'ipv6 loopback rejected');
assert.ok(!validateWebhookUrl('http://user:pass@example.com/x').ok, 'credentials rejected');
assert.ok(!validateWebhookUrl('not a url').ok, 'garbage rejected');
// public IP still allowed (only private ranges blocked)
assert.ok(validateWebhookUrl('http://8.8.8.8/hook').ok, 'public IP allowed');

// cleanup
store.default.close();
fs.rmSync(tmpDb, { force: true });

console.log('OK: all self-checks passed');
