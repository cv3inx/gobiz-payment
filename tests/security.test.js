import assert from 'node:assert';
import { createSuite } from './helpers.js';
import { safeEqual, signBody, verifyWebhookSignature, validateWebhookUrl, isAuthenticated } from '../src/security.js';

const { test, report } = createSuite('security');

test('safeEqual compares without throwing on length mismatch', () => {
   assert.ok(safeEqual('abc', 'abc'));
   assert.ok(!safeEqual('abc', 'abd'));
   assert.ok(!safeEqual('abc', 'abcd'));
   assert.ok(!safeEqual('', 'x'));
});

test('signatures are deterministic and secret-dependent', () => {
   const body = JSON.stringify({ trxId: 'abc', status: 'PAID' });
   const sig = signBody(body, 'secret');
   assert.strictEqual(sig, signBody(body, 'secret'));
   assert.notStrictEqual(sig, signBody(body, 'other'));
   assert.ok(verifyWebhookSignature(body, sig, 'secret'));
   assert.ok(!verifyWebhookSignature(body, sig, 'wrong'));
   assert.ok(!verifyWebhookSignature(body, '', 'secret'));
   assert.ok(!verifyWebhookSignature(body, undefined, 'secret'));
});

test('a tampered body fails verification', () => {
   const sig = signBody('{"amount":100}', 'secret');
   assert.ok(!verifyWebhookSignature('{"amount":999}', sig, 'secret'));
});

test('accepts public webhook URLs', () => {
   for (const url of ['https://shop.example.com/hook', 'http://api.example.com:8080/cb', 'http://8.8.8.8/hook']) {
      assert.ok(validateWebhookUrl(url).ok, `${url} allowed`);
   }
});

test('blocks internal hosts, bad schemes, and credentials (SSRF)', () => {
   const blocked = [
      'ftp://example.com', 'file:///etc/passwd',
      'http://localhost/x', 'http://127.0.0.1/x', 'http://[::1]/x',
      'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/x',
      'http://10.0.0.5/x', 'http://172.16.3.4/x', 'http://192.168.1.1/x',
      'http://user:pass@example.com/x', 'not a url',
   ];
   for (const url of blocked) assert.ok(!validateWebhookUrl(url).ok, `${url} rejected`);
});

test('isAuthenticated reads both header forms without blocking', () => {
   const req = (headers) => ({ get: (h) => headers[h.toLowerCase()] ?? '' });
   assert.ok(isAuthenticated(req({ 'x-api-key': 'k' }), 'k'), 'X-API-Key');
   assert.ok(isAuthenticated(req({ authorization: 'Bearer k' }), 'k'), 'Bearer');
   assert.ok(!isAuthenticated(req({ 'x-api-key': 'wrong' }), 'k'));
   assert.ok(!isAuthenticated(req({}), 'k'), 'no credentials');
   assert.ok(!isAuthenticated(req({ authorization: 'Basic k' }), 'k'), 'wrong scheme');
});

test('isAuthenticated reports true when no key is configured', () => {
   // Nothing is protected in that case, so pretending otherwise would hide fields
   // from an operator who has no way to authenticate at all. The startup warning
   // about an unset API_KEY is what covers this.
   const req = { get: () => '' };
   assert.ok(isAuthenticated(req, null));
   assert.ok(isAuthenticated(req, ''));
});

process.exit(await report() ? 0 : 1);
