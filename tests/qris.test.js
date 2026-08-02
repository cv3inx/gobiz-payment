import assert from 'node:assert';
import { createSuite } from './helpers.js';
import { buildDynamicQris, crc16 } from '../src/qris.js';

/** A QRIS payload is valid when its trailing 4 chars match the CRC of the rest. */
const isValidQris = (qris) => qris.slice(-4) === crc16(qris.slice(0, -4));

const { test, report } = createSuite('qris');

const STATIC = '00020101021126001180002ID' + '5802ID' + '540520006304ABCD';

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

test('encodes the amount in tag 54 with a length prefix', () => {
   assert.ok(buildDynamicQris(STATIC, 2050).includes('54042050'), '4 digits');
   assert.ok(buildDynamicQris(STATIC, 152).includes('543152'.replace('3', '03')), '3 digits');
   assert.ok(buildDynamicQris(STATIC, 1_000_000).includes('54071000000'), '7 digits');
});

test('switches the static indicator to dynamic', () => {
   assert.ok(buildDynamicQris('00020101021126001180002ID5802ID540520006304ABCD', 500).includes('010212'));
});

test('rejects a malformed QRIS string', () => {
   assert.throws(() => buildDynamicQris('nope', 1000), /Invalid QRIS/);
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

process.exit(report() ? 0 : 1);
