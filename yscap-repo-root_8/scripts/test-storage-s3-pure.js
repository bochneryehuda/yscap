'use strict';
/**
 * S3 storage adapter (src/lib/storage-s3.js) — PURE tests, no network.
 *
 * The load-bearing test is SigV4 correctness: the signer is validated against AWS's OWN published
 * Signature-V4 test vector (the documented GET iam.amazonaws.com ListUsers example) — if our
 * signature matches AWS's to the character, the signing algorithm is correct. Plus the key/ref
 * guards (never fabricate a key, reject traversal) and configured()/probe() gating.
 */
const R = require('path').resolve(__dirname, '..');
const S3 = require(R + '/src/lib/storage-s3');
const I = S3._internals;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(function main() {
  // ---- SigV4 gold-standard vector (AWS docs: GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08) ----
  // AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, us-east-1, service iam, 20150830T123600Z.
  const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const sig = I.signV4({
    method: 'GET',
    path: '/',
    query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      host: 'iam.amazonaws.com',
      'x-amz-date': '20150830T123600Z',
    },
    payloadHash: EMPTY_HASH,
    service: 'iam', region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    dateStamp: '20150830', amzDate: '20150830T123600Z',
  });
  ok(sig.signature === '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    'SigV4 signature matches the AWS published test vector (signing algorithm is correct)');
  ok(sig.signedHeaders === 'content-type;host;x-amz-date', 'SigV4 signed-headers list is sorted + lower-cased');
  ok(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79/.test(sig.authorization),
    'SigV4 Authorization header is well-formed with the right credential scope');

  // empty-payload hash helper
  ok(I.sha256hex(Buffer.alloc(0)) === EMPTY_HASH, 'sha256hex of an empty buffer = the canonical empty hash');

  // ---- encoding ----
  ok(I.encodeRfc3986('a b/c+d') === 'a%20b%2Fc%2Bd', 'encodeRfc3986: space→%20, /→%2F, +→%2B');
  ok(I.encodeRfc3986("A-Za-z0-9-_.~") === 'A-Za-z0-9-_.~', 'encodeRfc3986: unreserved set stays literal');
  ok(I.canonicalUri('/bucket/ab/xy z.pdf') === '/bucket/ab/xy%20z.pdf', 'canonicalUri encodes segments but keeps /');
  ok(I.canonicalQuery({ b: '2', a: '1 x' }) === 'a=1%20x&b=2', 'canonicalQuery sorts + encodes');

  // ---- amzDates ----
  const d = I.amzDates(new Date('2026-07-26T07:08:09.500Z'));
  ok(d.amzDate === '20260726T070809Z' && d.dateStamp === '20260726', 'amzDates: basic ISO-8601 + datestamp');

  // ---- newRef: server-generated, sharded, opaque, keeps a short extension only ----
  const ref = I.newRef('My Bank Statement.PDF');
  ok(/^[0-9a-f]{2}\/[0-9a-f]{32}\.pdf$/.test(ref), 'newRef: sharded 2-char dir + 32-hex id + lower-cased ext');
  ok(I.newRef('noext') && !/\./.test(I.newRef('noext')), 'newRef: no extension when the filename has none');
  ok(I.newRef('') !== I.newRef(''), 'newRef: two calls yield different keys (random, never from user input)');

  // ---- safeKey: reject traversal / absolute / empty / null-byte ----
  ok(I.safeKey('ab/cd.pdf') === 'ab/cd.pdf', 'safeKey accepts a normal ref');
  for (const bad of ['', '/etc/passwd', '../secret', 'a/../b', 'a\0b', null, undefined]) {
    let threw = false; try { I.safeKey(bad); } catch (_e) { threw = true; }
    ok(threw, `safeKey rejects ${JSON.stringify(bad)}`);
  }

  // ---- configured() + probe() gating (no S3 env in the test → not configured) ----
  ok(I.configured() === false, 'configured() false with no S3_* env');
  const p = S3.probe();
  ok(p.ok === false && p.configured === false && /not configured/i.test(p.error), 'probe() reports not-configured (never throws)');
  ok(S3.base === null, 'base is null when not configured');

  console.log(`test-storage-s3-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
