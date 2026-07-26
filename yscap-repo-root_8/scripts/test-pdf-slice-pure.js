'use strict';
/**
 * R5.1 — pure tests for the packet-splitter PDF slicer. Covers page
 * normalization, the PDF sniff, and the no-throw contract on bad input. The
 * actual pdf-lib slice is exercised only when pdf-lib is installed (skipped
 * gracefully otherwise) so the suite passes with or without node_modules.
 */
const assert = require('assert');
const { slicePdfPages, _internals } = require('../src/lib/underwriting/pdf-slice');

let passed = 0;
function ok(name) { console.log(`  ok  ${name}`); passed++; }

(async () => {
  // normalizePages: dedupe, sort, drop non-positive / non-integer.
  assert.deepStrictEqual(_internals.normalizePages([3, 1, 2, 2, 1]), [1, 2, 3]);
  assert.deepStrictEqual(_internals.normalizePages([0, -1, 2.5, 4]), [4]);
  assert.deepStrictEqual(_internals.normalizePages('nope'), []);
  assert.deepStrictEqual(_internals.normalizePages([]), []);
  ok('normalizePages dedupes, sorts, drops invalid');

  // looksLikePdf sniff.
  assert.strictEqual(_internals.looksLikePdf(Buffer.from('%PDF-1.7\n...')), true);
  assert.strictEqual(_internals.looksLikePdf(Buffer.from('\xEF\xBB\xBF%PDF-1.4')), true);
  assert.strictEqual(_internals.looksLikePdf(Buffer.from('PK\x03\x04 zip')), false);
  assert.strictEqual(_internals.looksLikePdf(Buffer.from('')), false);
  assert.strictEqual(_internals.looksLikePdf(null), false);
  ok('looksLikePdf sniffs the header only');

  // No-throw contract on degenerate input — must resolve, never reject.
  let r = await slicePdfPages(Buffer.from('%PDF-1.7 not really'), []);
  assert.strictEqual(r.ok, false); assert.match(r.reason, /no valid pages/);
  ok('empty page list → {ok:false}, no throw');

  r = await slicePdfPages(null, [1]);
  assert.strictEqual(r.ok, false); assert.match(r.reason, /no source bytes/);
  ok('null source → {ok:false}, no throw');

  r = await slicePdfPages(Buffer.from('PLAIN TEXT not a pdf'), [1]);
  assert.strictEqual(r.ok, false); assert.match(r.reason, /not a PDF/);
  ok('non-PDF source → {ok:false}, no throw');

  // A valid tiny PDF, sliced — only runs when pdf-lib is present.
  let havePdfLib = true;
  try { require.resolve('pdf-lib'); } catch (_) { havePdfLib = false; }
  if (havePdfLib) {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage(); doc.addPage(); doc.addPage();
    const bytes = Buffer.from(await doc.save());
    const sliced = await slicePdfPages(bytes, [2, 3, 99]);
    assert.strictEqual(sliced.ok, true, 'slice should succeed');
    assert.deepStrictEqual(sliced.pages, [2, 3], 'out-of-range page 99 dropped');
    assert.strictEqual(sliced.sourcePageCount, 3);
    const back = await PDFDocument.load(new Uint8Array(sliced.buf));
    assert.strictEqual(back.getPageCount(), 2, 'sliced PDF has exactly 2 pages');
    ok('valid PDF sliced to in-range pages (pdf-lib present)');
  } else {
    console.log('  --  pdf-lib not installed; skipping real-slice case');
  }

  console.log(`\nR5.1 pdf-slice pure: ${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
