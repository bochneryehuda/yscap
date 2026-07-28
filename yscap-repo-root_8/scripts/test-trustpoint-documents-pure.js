'use strict';
/**
 * TrustPoint document + photo archive — the PURE parts (owner-directed 2026-07-27).
 * No Postgres, no network.
 *
 * Covers the two things that must not regress:
 *   1. `extractJpegs` recovers whole, valid photographs from a PDF and never throws on junk.
 *      This is the mechanism that gets the inspector's photos into our own report, because
 *      TrustPoint publishes no photo endpoint — verified against the live account, every
 *      document on the project and its draws is application/pdf.
 *   2. `mirror._isTrustpointDocHost` accepts TrustPoint's real document hosts and rejects
 *      look-alikes. The original pin accepted only api.trustpoint.ai, which is why no
 *      inspection report was ever archived — TrustPoint serves bytes from S3.
 *
 * A synthetic PDF is built here (rather than committing a 6.7 MB fixture) using the same
 * structure TrustPoint's reports use: JPEG bytes inside `stream`/`endstream` pairs. The real
 * files were verified by hand during the investigation — 99 photos out of the draw-2
 * inspection report for 105-107 N 10th St, every one a valid JPEG.
 */
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src');
const { extractJpegs } = require(path.join(SRC, 'trustpoint', 'documents'));

// ---- a JPEG the extractor should recover: SOI … EOI, padded past the min-size floor ----
function fakeJpeg(sizeBytes, fillByte) {
  const body = Buffer.alloc(Math.max(0, sizeBytes - 4), fillByte);
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), body, Buffer.from([0xFF, 0xD9])]);
}
function pdfWith(streams) {
  const parts = [Buffer.from('%PDF-1.7\n')];
  for (const s of streams) {
    parts.push(Buffer.from('\n10 0 obj\n<< /Filter /DCTDecode >>\nstream\n'));
    parts.push(s);
    parts.push(Buffer.from('\nendstream\nendobj\n'));
  }
  parts.push(Buffer.from('\n%%EOF\n'));
  return Buffer.concat(parts);
}

function photoExtraction() {
  const a = fakeJpeg(20000, 0x41), b = fakeJpeg(30000, 0x42);
  const got = extractJpegs(pdfWith([a, b]));
  assert.strictEqual(got.length, 2, 'both embedded photos are recovered');
  for (const img of got) {
    assert.ok(img[0] === 0xFF && img[1] === 0xD8 && img[2] === 0xFF, 'starts with the JPEG marker');
    assert.ok(img[img.length - 2] === 0xFF && img[img.length - 1] === 0xD9, 'ends with the JPEG marker');
  }
  assert.ok(got[0].equals(a) && got[1].equals(b), 'bytes are copied verbatim — never re-encoded');

  // Tiny embedded images are logos/spacers, not inspection photographs.
  const small = extractJpegs(pdfWith([fakeJpeg(1000, 0x43), fakeJpeg(20000, 0x44)]));
  assert.strictEqual(small.length, 1, 'sub-threshold images are skipped');

  // A non-image stream must not be mistaken for a photo.
  const textish = Buffer.from('BT /F5 12 Tf <0103> Tj ET');
  assert.strictEqual(extractJpegs(pdfWith([textish])).length, 0, 'text content streams are not photos');

  // The cap is honoured.
  assert.strictEqual(extractJpegs(pdfWith([a, b, a, b]), { max: 3 }).length, 3, 'the per-document cap holds');

  // Junk in, nothing out — never a throw, because this runs inside a draw reaction.
  for (const junk of [null, undefined, Buffer.alloc(0), Buffer.from('not a pdf'), 'a string', 42, {}]) {
    assert.strictEqual(extractJpegs(junk).length, 0, `junk input (${typeof junk}) returns no photos`);
  }
  // A truncated stream (download cut off mid-file) must not hang or throw.
  assert.doesNotThrow(() => extractJpegs(Buffer.concat([Buffer.from('stream\n'), fakeJpeg(9000, 0x45)])));
  console.log('  ✓ photos: recovered byte-exact, junk and truncation handled, caps honoured');
}

function documentHosts() {
  const mirror = require(path.join(SRC, 'trustpoint', 'mirror'));
  const ok = mirror._isTrustpointDocHost;
  const API = 'api.trustpoint.ai';

  // The real host TrustPoint serves document bytes from (from the live /report/ response).
  assert.strictEqual(ok('tp-backend-evidence-prod-us-west-2.s3.amazonaws.com', API), true,
    'TrustPoint\'s own evidence bucket must be downloadable — rejecting it archived nothing');
  assert.strictEqual(ok(API, API), true, 'the API host stays allowed');

  for (const bad of [
    'evil.com',
    'tp-evil.s3.amazonaws.com.attacker.net',   // suffix smuggling
    's3.amazonaws.com',                        // bare S3 — anyone can put a bucket there
    'api.trustpoint.ai.attacker.net',
    'notap-backend.s3.amazonaws.com',          // must start with the tp- prefix
    '169.254.169.254',                         // link-local metadata
  ]) {
    assert.strictEqual(ok(bad, API), false, `${bad} must be rejected`);
  }
  console.log('  ✓ hosts: TrustPoint\'s API + evidence bucket allowed, look-alikes rejected');
}

(function () {
  console.log('trustpoint document + photo archive (pure)');
  photoExtraction();
  documentHosts();
  console.log('All TrustPoint document-archive tests passed.');
})();
