'use strict';
/* Pure test — the content sniffer must let an ANCHORED signature outrank a
 * scan-anywhere heuristic, so a container's payload can never impersonate the
 * container.
 *
 * Root cause it guards (owner-reported 2026-08-20: "TPR_YSCAP258134701_2026-07-21.zip
 * — the FILE ITSELF appears corrupted (content is pdf, not zip)", on a package
 * PILOT had just built itself, and "we're getting this lately a lot"):
 * sniffKind ran its tolerant "%PDF anywhere in the first 1KB" scan BEFORE the
 * anchored ZIP signature. lib/zip.js is STORE-only on purpose — its members are
 * already-compressed PDFs — so the first member's raw "%PDF" sits about seventy
 * bytes in, well inside that window. Every TPR export whose first document is a
 * PDF was therefore judged a PDF and reported corrupted.
 *
 * No DB, no network. Run: node scripts/test-content-sniff-order-pure.js
 */
const assert = require('assert');
const { sniffKind, expectedKind } = require('../src/lib/upload-bytes');
const { zip } = require('../src/lib/zip');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// A realistic PDF: header, body, trailer.
const pdf = (tag = 'x') => Buffer.concat([
  Buffer.from('%PDF-1.4\n'), Buffer.from(`% ${tag}\n`), Buffer.alloc(3000, 0x41), Buffer.from('\n%%EOF\n')]);

// === THE REPORTED CASE, built by the REAL writer ===========================
// Deliberately NOT a hand-rolled fixture: the whole bug lived in the interaction
// between our own STORE-only ZIP layout and the sniffer, so a fake "PK...%PDF"
// buffer could pass while the real thing still failed.
const tpr = zip([
  { name: 'Contract & Assignment/purchase-contract.pdf', data: pdf('contract') },
  { name: 'TITLE/commitment.pdf', data: pdf('title') },
  { name: 'Appraisal/report.pdf', data: pdf('appraisal') },
]);
assert.strictEqual(tpr[0], 0x50, 'the real writer emits a PK signature');
assert.strictEqual(tpr[1], 0x4B, 'the real writer emits a PK signature');
assert.ok(tpr.subarray(0, 1024).indexOf('%PDF') > 0,
  'the payload really does put %PDF inside the first 1KB — otherwise this test proves nothing');
assert.strictEqual(sniffKind(tpr), 'zip', 'a TPR export is a ZIP, not the PDF sitting inside it');
ok('a real TPR export — our own ZIP writer, PDFs stored uncompressed — sniffs as a zip');

// And therefore the corruption detector no longer fires on it.
const expected = expectedKind('TPR_YSCAP258134701_2026-07-21.zip', 'application/zip');
assert.strictEqual(expected, 'zip');
assert.strictEqual(sniffKind(tpr), expected, 'expected and sniffed agree — no false "corrupted" verdict');
ok('the reported file no longer reads as corrupted');

// A single-member zip puts %PDF even closer to the front — the worst case.
const tight = zip([{ name: 'a.pdf', data: pdf() }]);
assert.ok(tight.subarray(0, 64).indexOf('%PDF') > 0, 'worst case really is within 64 bytes');
assert.strictEqual(sniffKind(tight), 'zip');
ok('the worst case — %PDF barely 35 bytes in — still reads as a zip');

// === WHAT MUST NOT HAVE CHANGED ============================================
assert.strictEqual(sniffKind(pdf()), 'pdf', 'an ordinary PDF is still a PDF');
ok('an ordinary PDF is unchanged');

// The PDF spec tolerates a preamble and real readers scan for the header, so
// this tolerance is deliberate and must survive — it is only DEMOTED below the
// anchored signatures, never removed.
const preamble = Buffer.concat([Buffer.from('junk from a bad download\r\n'), pdf()]);
assert.strictEqual(sniffKind(preamble), 'pdf', 'a PDF whose header is not at byte 0 is still a PDF');
ok('the PDF-preamble tolerance survives — it is demoted, not deleted');

for (const [name, buf, want] of [
  ['PNG', Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(64)]), 'png'],
  ['JPEG', Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64)]), 'jpg'],
  ['GIF', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]), 'gif'],
  ['TIFF-LE', Buffer.concat([Buffer.from([0x49, 0x49, 0x2A, 0x00]), Buffer.alloc(64)]), 'tiff'],
  ['TIFF-BE', Buffer.concat([Buffer.from([0x4D, 0x4D, 0x00, 0x2A]), Buffer.alloc(64)]), 'tiff'],
  ['HEIC', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(32)]), 'heic'],
]) {
  assert.strictEqual(sniffKind(buf), want, `${name} still sniffs as ${want}`);
}
ok('every other format is unchanged');

// A docx/xlsx is a ZIP and must stay one (the mirror treats Office formats specially).
assert.strictEqual(sniffKind(zip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }])), 'zip');
ok('an Office file (a zip of XML) still sniffs as a zip');

// === THE SAME PRINCIPLE, APPLIED CONSISTENTLY ==============================
// An HTML document anchors its own start, so it now outranks the unanchored PDF
// scan. This is the e-sign-portal accident the corruption detector exists to
// catch: an error page saved as ".pdf". If the page happens to mention %PDF in
// its body — a download page very well might — it used to read as a PDF and slip
// through the very check meant to catch it.
const errorPage = Buffer.from(
  '<!doctype html>\n<html><body><h1>Download failed</h1>' +
  '<p>Your %PDF document could not be prepared.</p></body></html>');
assert.ok(errorPage.subarray(0, 1024).indexOf('%PDF') > 0, 'the page really does mention %PDF');
assert.strictEqual(sniffKind(errorPage), 'html', 'an HTML page is HTML even when it mentions %PDF');
assert.notStrictEqual(sniffKind(errorPage), expectedKind('binder.pdf', 'application/pdf'),
  'so an HTML error page saved as .pdf is still caught as corrupted');
ok('an HTML error page mentioning %PDF is caught, not mistaken for a PDF');

// === DEGRADES THE SAME WAY AS BEFORE =======================================
for (const junk of [null, undefined, Buffer.alloc(0), Buffer.from('ab'), Buffer.from('nothing recognisable here')]) {
  assert.strictEqual(sniffKind(junk), null, 'unrecognised input answers null, never a guess');
}
ok('unreadable or unrecognised bytes still answer null rather than guessing');

console.log(`\nAll ${n} content-sniff ordering checks passed.`);
