'use strict';
/* Email-signature images are never filed as returned/closing documents
   (owner-reported 2026-07-29: a title company's "Received." reply carried only
   its signature images, and the file announced "Title documents came back",
   flipped the order to documents_in and nudged the condition to 'received').
   PURE — no DB. Run: node scripts/test-order-return-filter.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  classifyReturnAttachment, imageDimensions, IMAGE_MIN_BYTES, IMAGE_MIN_LONG_SIDE,
} = require('../src/lib/order-return-filter');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// Real magic-byte payloads so the classifier judges the BYTES, not just the name.
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(4 * 1024)]);
const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(4 * 1024)]);
const BIG_JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(IMAGE_MIN_BYTES + 1024)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(1024)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(1024)]);
const TIFF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2A, 0x00]), Buffer.alloc(IMAGE_MIN_BYTES + 1024)]);
const SMALL_TIFF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2A, 0x00]), Buffer.alloc(2 * 1024)]);

/* ---- the reported case: tiny signature images ---- */
// The title agent's 5 KB signature card ("AVI ROTH LAKELAND ABSTRACT") and the
// insurance agent's logo ("SIB Insurance") — small standalone images. Never filed.
let c = classifyReturnAttachment({ filename: 'image.png', contentType: 'image/png', buf: PNG });
assert.strictEqual(c.file, false);
assert.strictEqual(c.reason, 'signature_image');
c = classifyReturnAttachment({ filename: 'image001.jpg', contentType: 'image/jpeg', buf: JPG });
assert.strictEqual(c.file, false);
ok('a small standalone image (the reported signature card / logo) never files');

// Embedded in the email body (inline / Content-ID) — never files, at ANY size.
c = classifyReturnAttachment({ filename: 'logo.jpg', contentType: 'image/jpeg', buf: BIG_JPG, contentDisposition: 'inline' });
assert.strictEqual(c.file, false);
assert.strictEqual(c.reason, 'embedded_image');
c = classifyReturnAttachment({ filename: 'sig.png', contentType: 'image/png', buf: PNG, contentId: '<part1.abc@mail>' });
assert.strictEqual(c.file, false);
assert.strictEqual(c.reason, 'embedded_image');
ok('an inline / Content-ID image never files, whatever its size');

// Vector logos / favicons: never a document.
c = classifyReturnAttachment({ filename: 'logo.svg', contentType: 'image/svg+xml', sizeBytes: 500000 });
assert.strictEqual(c.file, false);
assert.strictEqual(c.reason, 'vector_image');
ok('an SVG/ICO never files');

/* ---- real documents always file ---- */
// A PDF of ANY size — the owner's rule: real returned documents are PDFs.
c = classifyReturnAttachment({ filename: 'binder.pdf', contentType: 'application/pdf', buf: PDF });
assert.strictEqual(c.file, true, 'a small PDF still files — size gates only images');
// Even a PDF the client marked inline (some mail clients do) — disposition is
// only consulted for images.
c = classifyReturnAttachment({ filename: 'commitment.pdf', contentType: 'application/pdf', buf: PDF, contentDisposition: 'inline' });
assert.strictEqual(c.file, true, 'an inline PDF files — disposition only gates images');
// Word/Excel (zip container), TIFF scans (a document format, not a signature format).
assert.strictEqual(classifyReturnAttachment({ filename: 'invoice.docx', buf: ZIP }).file, true);
assert.strictEqual(classifyReturnAttachment({ filename: 'scan.tif', contentType: 'image/tiff', buf: TIFF }).file, true);
assert.strictEqual(classifyReturnAttachment({ filename: 'scan.tif', contentType: 'image/tiff', buf: SMALL_TIFF }).file, true,
  'TIFF is a scan format — never judged as a signature image, even small');
// An unknown binary files (pre-existing behavior — when in doubt, keep it).
assert.strictEqual(classifyReturnAttachment({ filename: 'payload.bin', contentType: 'application/octet-stream', buf: Buffer.alloc(64, 7) }).file, true);
ok('PDF / Word / Excel / TIFF / unknown types always file');

// A LARGE standalone image (a genuine photo scan of a document) still files.
c = classifyReturnAttachment({ filename: 'photo-of-policy.jpg', contentType: 'image/jpeg', buf: BIG_JPG });
assert.strictEqual(c.file, true, 'a big non-embedded photo still files');
ok('a large standalone photo (a real scan) still files');

// The bytes win over a misleading name: a signature PNG named "document.png"
// with a generic content type is still judged an image by its magic bytes.
c = classifyReturnAttachment({ filename: 'document', contentType: 'application/octet-stream', buf: PNG });
assert.strictEqual(c.file, false, 'magic bytes identify the image even without name/type');
ok('classification sniffs the bytes — a mislabeled signature image is still caught');

// No bytes available (metadata-only): falls back to declared type/extension + size.
c = classifyReturnAttachment({ filename: 'image001.png', contentType: 'image/png', sizeBytes: 6 * 1024 });
assert.strictEqual(c.file, false);
c = classifyReturnAttachment({ filename: 'huge.png', contentType: 'image/png', sizeBytes: IMAGE_MIN_BYTES + 1 });
assert.strictEqual(c.file, true);
ok('metadata-only classification (no buffer) works off type + size');

// Garbage input never throws — and defaults to filing (never lose a document).
assert.strictEqual(classifyReturnAttachment(null).file, true);
assert.strictEqual(classifyReturnAttachment({}).file, true);
ok('never throws; when in doubt it files');

/* ---- TOO SMALL TO BE A PAGE (owner-reported 2026-08-03) -------------------
   The two rules above both have a hole: the mail provider does not always
   expose the inline/Content-ID metadata, and a modern @2x logo or headshot can
   weigh more than the 150 KB floor. What is ALWAYS true of a signature image is
   its size in PIXELS, so the classifier reads the picture's own header. */

// PNG: 8-byte signature, then the IHDR chunk carrying width/height big-endian.
const pngOf = (w, h, pad = 1024) => {
  const head = Buffer.alloc(24);
  Buffer.from([0x89]).copy(head, 0);
  head.write('PNG\r\n\x1a\n', 1, 'latin1');
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
};
// JPEG: SOI then a baseline frame header (SOF0) stating height, then width.
const jpgOf = (w, h, pad = 1024) => {
  const head = Buffer.alloc(11);
  head.writeUInt16BE(0xFFD8, 0);
  head.writeUInt16BE(0xFFC0, 2);
  head.writeUInt16BE(17, 4);
  head.writeUInt8(8, 6);
  head.writeUInt16BE(h, 7);
  head.writeUInt16BE(w, 9);
  return Buffer.concat([head, Buffer.alloc(pad)]);
};
const gifOf = (w, h) => {
  const b = Buffer.alloc(32);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
};
const bmpOf = (w, h) => {
  const b = Buffer.alloc(64);
  b.write('BM', 0, 'latin1');
  b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22);   // top-down bitmap: negative height
  return b;
};

// The case that could still slip past: a RETINA logo — 400 x 120, but 200 KB, so
// the byte floor keeps it — and no inline metadata from the provider.
c = classifyReturnAttachment({
  filename: 'image.png', contentType: 'image/png', buf: pngOf(400, 120, IMAGE_MIN_BYTES + 50 * 1024),
});
assert.strictEqual(c.file, false);
assert.strictEqual(c.reason, 'tiny_image');
ok('a heavy @2x signature logo is caught by its PIXELS even though it clears the byte floor');

// A signature strip / email banner: wide enough to pass the pixel floor, but no
// page has that shape.
c = classifyReturnAttachment({ filename: 'sig.jpg', contentType: 'image/jpeg', buf: jpgOf(1600, 140, 300 * 1024) });
assert.strictEqual(c.file, false);
assert.strictEqual(c.reason, 'banner_image');
ok('a long thin banner / signature strip never files');

// AND THE OTHER DIRECTION — a real document must survive both new rules.
c = classifyReturnAttachment({ filename: 'policy.jpg', contentType: 'image/jpeg', buf: jpgOf(1700, 2200, IMAGE_MIN_BYTES + 1024) });
assert.strictEqual(c.file, true, 'a genuine page scan files');
// The lowest resolution any real page arrives at: US Letter at 72 dpi is
// 612 x 792, which must sit ABOVE the floor — that is why the floor is 700.
assert.ok(IMAGE_MIN_LONG_SIDE < 792, 'the pixel floor stays under a 72-dpi US Letter page');
c = classifyReturnAttachment({ filename: 'page.png', contentType: 'image/png', buf: pngOf(612, 792, 200 * 1024) });
assert.strictEqual(c.file, true, 'a 72-dpi US Letter page — the smallest real page — still files');
// A landscape page, and a phone photo, are nowhere near the aspect limit.
assert.strictEqual(classifyReturnAttachment({ filename: 'p.jpg', buf: jpgOf(2200, 1700, 400 * 1024) }).file, true);
ok('a real page — even the smallest and even landscape — still files');

// The reader itself: every format it claims, and a firm "no opinion" otherwise.
assert.deepStrictEqual(imageDimensions(pngOf(1200, 800)), { w: 1200, h: 800 });
assert.deepStrictEqual(imageDimensions(jpgOf(640, 480)), { w: 640, h: 480 });
assert.deepStrictEqual(imageDimensions(gifOf(88, 31)), { w: 88, h: 31 });
assert.deepStrictEqual(imageDimensions(bmpOf(300, 200)), { w: 300, h: 200 });
assert.strictEqual(imageDimensions(PDF), null, 'a PDF has no raster dimensions');
assert.strictEqual(imageDimensions(Buffer.alloc(4)), null);
assert.strictEqual(imageDimensions(null), null);
assert.strictEqual(imageDimensions(Buffer.from('not an image at all, really')), null);
// A truncated / malformed header must be "no opinion", never a guess — a guess
// would throw away a real document.
assert.strictEqual(imageDimensions(pngOf(400, 120).subarray(0, 18)), null);
assert.strictEqual(imageDimensions(Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(40)])), null);
ok('the dimension reader reads PNG/JPEG/GIF/BMP and abstains on anything else');

// An image whose header cannot be read falls back to the byte rule exactly as
// before — the new rules only ever ADD an opinion.
c = classifyReturnAttachment({ filename: 'weird.webp', contentType: 'image/webp', sizeBytes: 400 * 1024 });
assert.strictEqual(c.file, true, 'an unreadable large image still files');
ok('an unreadable header changes nothing — the size rule still decides');

/* ---- wiring: both inbound document sinks actually run the filter ---- */
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', f), 'utf8');
const orderSrc = read('order-inbox.js');
const closingSrc = read('closing-inbox.js');
const inboxSrc = read('file-inbox.js');
/* The provider-facing half of the inbox moved to lib/inbound-mail.js (2026-08-30,
   so the long-term orders desk shares the SAME reading rather than copying it), so
   the metadata guard below reads THAT file — and, because a guard on a module
   nobody calls proves nothing, also asserts file-inbox still retrieves through it. */
const inboundMailSrc = read('inbound-mail.js');
assert.ok(/classifyReturnAttachment/.test(orderSrc), 'order-inbox runs the filter');
assert.ok(/classifyReturnAttachment/.test(closingSrc), 'closing-inbox runs the filter');
// The filter must run BEFORE the document INSERT in both sinks. Both indexes
// must be REAL hits (>= 0): with only the < comparison, removing the CALL while
// keeping the import would pass vacuously (-1 < any positive index).
const callBeforeInsert = (src, label) => {
  const call = src.indexOf('classifyReturnAttachment(');
  const ins = src.indexOf('INSERT INTO documents');
  assert.ok(call >= 0 && ins >= 0 && call < ins, `${label} runs the filter before the insert`);
};
callBeforeInsert(orderSrc, 'order-inbox');
callBeforeInsert(closingSrc, 'closing-inbox');
// The retrieval path passes the inline/Content-ID metadata through so the
// embedded-image tell actually reaches the classifier.
assert.ok(/contentDisposition:/.test(inboundMailSrc) && /contentId:/.test(inboundMailSrc),
  'the retrieval forwards disposition + content-id metadata');
assert.ok(/require\('\.\/inbound-mail'\)/.test(inboxSrc) && /retrieveAttachmentsSafe\(/.test(inboxSrc),
  'file-inbox retrieves attachments through that shared reading');
ok('order-inbox + closing-inbox are wired through the filter, before any insert');

/* ---- PREVIOUS FILES: the retirement pass exists, is booted, and shares the
   ONE definition of a signature image (owner-reported 2026-08-03: they were
   still rejecting these by hand on every file, because the July filter was
   go-forward only and db/420 then made every old one visible). ---- */
const retireSrc = read('order-signature-retire.js');
assert.ok(/require\('\.\/order-return-filter'\)/.test(retireSrc),
  'the retirement pass calls the SAME classifier — never a second copy of the rule');
assert.ok(/is_current = false/.test(retireSrc), 'it retires by is_current, the column every surface already reads');
assert.ok(!/\bDELETE\b/i.test(retireSrc), 'it never deletes a document');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
assert.ok(/order-signature-retire/.test(serverSrc), 'the retirement pass runs at boot');
ok('the previous-files retirement pass exists, is booted, and deletes nothing');

console.log(`\ntest-order-return-filter: ${n} checks passed`);
