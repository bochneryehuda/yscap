'use strict';
/* Email-signature images are never filed as returned/closing documents
   (owner-reported 2026-07-29: a title company's "Received." reply carried only
   its signature images, and the file announced "Title documents came back",
   flipped the order to documents_in and nudged the condition to 'received').
   PURE — no DB. Run: node scripts/test-order-return-filter.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyReturnAttachment, IMAGE_MIN_BYTES } = require('../src/lib/order-return-filter');

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

/* ---- wiring: both inbound document sinks actually run the filter ---- */
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', f), 'utf8');
const orderSrc = read('order-inbox.js');
const closingSrc = read('closing-inbox.js');
const inboxSrc = read('file-inbox.js');
assert.ok(/classifyReturnAttachment/.test(orderSrc), 'order-inbox runs the filter');
assert.ok(/classifyReturnAttachment/.test(closingSrc), 'closing-inbox runs the filter');
// The filter must run BEFORE the document INSERT in both sinks.
assert.ok(orderSrc.indexOf('classifyReturnAttachment(') < orderSrc.indexOf('INSERT INTO documents'), 'order filter runs before the insert');
assert.ok(closingSrc.indexOf('classifyReturnAttachment(') < closingSrc.indexOf('INSERT INTO documents'), 'closing filter runs before the insert');
// The retrieval path passes the inline/Content-ID metadata through so the
// embedded-image tell actually reaches the classifier.
assert.ok(/contentDisposition:/.test(inboxSrc) && /contentId:/.test(inboxSrc), 'file-inbox forwards disposition + content-id metadata');
ok('order-inbox + closing-inbox are wired through the filter, before any insert');

console.log(`\ntest-order-return-filter: ${n} checks passed`);
