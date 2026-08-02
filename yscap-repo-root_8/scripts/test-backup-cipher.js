'use strict';
/**
 * The backup container must be UNUSABLE without the key and UNREADABLE if anything changed.
 *
 * A backup is the one artifact nobody looks at until the day it is the only copy left, so every
 * failure mode has to be LOUD rather than quiet: a flipped byte, a truncated download, a tampered
 * header and the wrong key must all refuse outright, never hand back partial plausible data. Pure —
 * no DB, no network, no vault.
 * Run: node scripts/test-backup-cipher.js
 */
const crypto = require('crypto');
const cipher = require('../src/lib/backup/cipher');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const threw = async (fn, re, m) => {
  try { await fn(); fail++; console.log('  ✗ FAIL', m, '(it did NOT throw)'); }
  catch (e) { if (!re || re.test(e.message)) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m, '— wrong error:', e.message); } }
};

const KEY = 'jH8kM2pQ7xR4vN9wL5tY3bZ6cF1dG0sA';          // 32 chars — the documented minimum
const KEY_B64 = crypto.randomBytes(32).toString('base64');
const OTHER = crypto.randomBytes(32).toString('base64');

(async () => {
  // ---- a dump goes in, the identical bytes come back out ----------------------------------
  const payload = Buffer.concat([Buffer.from('PGDMP fake archive '), crypto.randomBytes(200000)]);
  const sealed = await cipher.encryptBuffer(KEY, payload, { name: 'yscap.dump' });
  const back = await cipher.decryptBuffer(KEY, sealed);
  ok(back.equals(payload), 'a dump round-trips byte for byte');
  ok(sealed.length > payload.length, 'the container is larger than the plaintext (header + tag)');
  ok(!sealed.includes(Buffer.from('PGDMP fake archive ')),
    'the plaintext does NOT appear anywhere in the container — it is really encrypted');

  // ---- key handling -------------------------------------------------------------------------
  ok(cipher.keyFingerprint(KEY) === cipher.keyFingerprint(KEY), 'the key fingerprint is stable');
  ok(cipher.keyFingerprint(KEY) !== cipher.keyFingerprint(OTHER), 'different keys fingerprint differently');
  ok(!cipher.keyFingerprint(KEY).includes(KEY.slice(0, 8)), 'the fingerprint does not leak the key');
  await threw(() => cipher.encryptBuffer('', payload), /not set/i, 'an empty key refuses to encrypt at all');
  await threw(() => cipher.encryptBuffer('short-key-123', payload), /too short/i, 'a weak key is refused, not silently stretched');
  ok(Buffer.isBuffer(await cipher.encryptBuffer(KEY_B64, payload)), 'a base64 32-byte key is accepted');
  ok(Buffer.isBuffer(await cipher.encryptBuffer(crypto.randomBytes(32).toString('hex'), payload)), 'a 64-char hex key is accepted');

  // ---- every way a backup can go bad ---------------------------------------------------------
  await threw(() => cipher.decryptBuffer(OTHER, sealed), /DIFFERENT key/i,
    'the WRONG key is named as such — not a generic decryption error');

  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 200] ^= 0x01;                    // one bit, deep in the ciphertext
  await threw(() => cipher.decryptBuffer(KEY, flipped), /FAILED VERIFICATION/,
    'ONE flipped bit fails the whole file (never partial data)');

  await threw(() => cipher.decryptBuffer(KEY, sealed.subarray(0, sealed.length - 1)), /FAILED VERIFICATION/,
    'a file one byte short is refused — a truncated download can never look like a short database');
  await threw(() => cipher.decryptBuffer(KEY, sealed.subarray(0, Math.floor(sealed.length / 2))), /FAILED VERIFICATION/,
    'a half-downloaded backup is refused');

  const { header, headerBlock } = cipher._internals.parseHeaderBlock(sealed);
  const doctored = Buffer.concat([
    cipher._internals.buildHeaderBlock(Object.assign({}, header, { createdAt: '1999-01-01T00:00:00.000Z' })),
    sealed.subarray(headerBlock.length),
  ]);
  await threw(() => cipher.decryptBuffer(KEY, doctored), /FAILED VERIFICATION/,
    'editing the header (the date) fails the tag — the header is authenticated, not decoration');

  await threw(() => cipher.decryptBuffer(KEY, Buffer.from('this is just a text file, not a backup at all!!')),
    /not a YS Capital backup/i, 'a file that is not a backup says so plainly');
  await threw(() => cipher.decryptBuffer(KEY, Buffer.alloc(0)), /truncated|ended before/i, 'an empty file is refused');

  // ---- fresh salt + IV per backup -------------------------------------------------------------
  const a = cipher._internals.parseHeaderBlock(await cipher.encryptBuffer(KEY, payload)).header;
  const b = cipher._internals.parseHeaderBlock(await cipher.encryptBuffer(KEY, payload)).header;
  ok(a.salt !== b.salt && a.iv !== b.iv, 'two backups with the SAME key never reuse the salt or the nonce');
  ok(a.keyId === b.keyId, '…but they carry the same key fingerprint, so you can tell which key opens them');
  const s1 = await cipher.encryptBuffer(KEY, payload);
  const s2 = await cipher.encryptBuffer(KEY, payload);
  ok(!s1.equals(s2), 'the same dump encrypted twice produces different bytes');

  // ---- streaming, and the empty database ------------------------------------------------------
  const enc = cipher.createEncryptStream(KEY, { name: 'streamed' });
  const chunks = [];
  enc.on('data', (c) => chunks.push(c));
  await new Promise((res, rej) => { enc.on('end', res); enc.on('error', rej); enc.end(payload); enc.resume(); });
  const streamed = Buffer.concat(chunks);
  ok((await cipher.decryptBuffer(KEY, streamed)).equals(payload), 'the streaming encryptor produces a readable container');
  ok(enc.plainBytes === payload.length, 'the encryptor reports the plaintext size (the manifest needs it)');
  ok(enc.plainSha256 === crypto.createHash('sha256').update(payload).digest('hex'), 'and the plaintext checksum');
  ok(enc.cipherSha256 === crypto.createHash('sha256').update(streamed).digest('hex'), 'and the ciphertext checksum');

  const empty = await cipher.encryptBuffer(KEY, Buffer.alloc(0), { name: 'empty' });
  ok(empty.length > 0, 'an EMPTY dump still produces a valid container, not a zero-byte file');
  ok((await cipher.decryptBuffer(KEY, empty)).length === 0, '…which decrypts back to nothing, honestly');

  // ---- a large multi-chunk stream (the real shape of a dump) ----------------------------------
  const big = crypto.randomBytes(3 * 1024 * 1024 + 7);
  ok((await cipher.decryptBuffer(KEY, await cipher.encryptBuffer(KEY, big))).equals(big),
    'a multi-megabyte dump round-trips (the tag hold-back works across many chunks)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
