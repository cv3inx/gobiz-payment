import assert from 'node:assert';
import { createSuite } from './helpers.js';
import { buildDynamicQris, crc16 } from '../src/qris.js';

/** A QRIS payload is valid when its trailing 4 chars match the CRC of the rest. */
const isValidQris = (qris) => qris.slice(-4) === crc16(qris.slice(0, -4));

/** Checksum a CRC-less body the way a real static QRIS carries it. */
const signed = (body) => body + '6304' + crc16(body + '6304');

const { test, report } = createSuite('qris');

// A well-formed static QRIS: every tag's length prefix tiles the string exactly.
const FIELDS = '000201' + '010211' + '26120008ID.GOPAY' + '52045812' + '5303360';
const TAIL = '5802ID' + '5908TOKO ABC' + '6007JAKARTA';
const STATIC = signed(FIELDS + TAIL);

test('checksum is 4 uppercase hex chars', () => {
   const sum = crc16('hello');
   assert.match(sum, /^[0-9A-F]{4}$/);
   assert.strictEqual(sum, crc16('hello'), 'deterministic');
});

test('dynamic QRIS keeps the country tag and validates', () => {
   const qris = buildDynamicQris(STATIC, 2050);
   assert.ok(qris.includes('5802ID'), 'country tag retained');
   assert.ok(isValidQris(qris), 'trailing CRC matches payload');
});

test('encodes the amount in tag 54 with a length prefix, before the country tag', () => {
   assert.ok(buildDynamicQris(STATIC, 2050).includes('540420505802ID'), '4 digits');
   assert.ok(buildDynamicQris(STATIC, 152).includes('5403152'), '3 digits');
   assert.ok(buildDynamicQris(STATIC, 1_000_000).includes('54071000000'), '7 digits');
});

test('switches the static indicator to dynamic', () => {
   assert.ok(buildDynamicQris(STATIC, 500).startsWith('000201010212'));
});

test('an amount already in the static string is replaced, not duplicated', () => {
   // Two tag-54s is a QR a wallet may read as the old amount.
   const withAmount = signed(FIELDS + '540512345' + TAIL);
   const qris = buildDynamicQris(withAmount, 2050);
   assert.ok(!qris.includes('540512345'), 'old amount gone');
   assert.strictEqual(qris, buildDynamicQris(STATIC, 2050));
});

test('surrounding whitespace from a pasted env value is ignored', () => {
   // A trailing newline used to land inside the payload and break the checksum.
   assert.strictEqual(buildDynamicQris(`  ${STATIC}\n`, 2050), buildDynamicQris(STATIC, 2050));
});

test('a tag-like substring inside another field is left alone', () => {
   // "5802ID" inside tag 26 is data, not the country tag.
   const tricky = signed('000201' + '010211' + '26125802ID.GOPAY' + '52045812' + '5303360' + TAIL);
   const qris = buildDynamicQris(tricky, 2050);
   assert.ok(qris.includes('26125802ID.GOPAY'), 'tag 26 untouched');
   assert.ok(qris.includes('540420505802ID5908'), 'amount placed before the real country tag');
});

test('rejects a malformed QRIS string', () => {
   assert.throws(() => buildDynamicQris('nope', 1000), /Invalid QRIS/);
   assert.throws(() => buildDynamicQris(STATIC.slice(0, -10), 1000), /Invalid QRIS/, 'truncated');
   assert.throws(() => buildDynamicQris(signed(FIELDS), 1000), /Invalid QRIS/, 'no country tag');
});

test('rejects a non-positive or non-integer amount', () => {
   for (const bad of [0, -5, 1.5, NaN, '100']) {
      assert.throws(() => buildDynamicQris(STATIC, bad), /positive integer/, `rejects ${bad}`);
   }
});

test('a tampered payload fails its own checksum', () => {
   const qris = buildDynamicQris(STATIC, 2050);
   assert.ok(!isValidQris(qris.slice(0, -5) + '9' + qris.slice(-4)), 'payload edit detected');
});

process.exit(await report() ? 0 : 1);
