'use strict';
/**
 * #112 (R5.15) — pure tests for OCR layout capture. Proves:
 *   • Azure flat polygons (in page units) are paired + normalized to 0..1 by the
 *     page width/height, with a correct axis-aligned bbox;
 *   • Google normalizedVertices (already 0..1) pass through, and pixel vertices are
 *     normalized by the page dimension; text resolves via the textAnchor segments;
 *   • bboxOf computes the tight rect; out-of-range coords clamp to [0,1];
 *   • capturePages dispatches per engine over a full result;
 *   • hostile / partial input never throws and degrades to null geometry (text kept).
 */
const assert = require('assert');
const lc = require('../src/lib/ai/layout-capture');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// 1. Azure: flat polygon in inches → normalized 0..1 + bbox.
{
  const page = {
    pageNumber: 1, width: 8.5, height: 11, unit: 'inch',
    lines: [{ content: 'BORROWER NAME', polygon: [0.85, 1.1, 4.25, 1.1, 4.25, 1.65, 0.85, 1.65] }],
    words: [{ content: 'BORROWER', confidence: 0.98, polygon: [0.85, 1.1, 2.0, 1.1, 2.0, 1.65, 0.85, 1.65] }],
  };
  const cp = lc.normalizeAzurePage(page, 0);
  assert.strictEqual(cp.lines.length, 1);
  const b = cp.lines[0].bbox;
  assert.ok(near(b.x, 0.1) && near(b.y, 0.1), `bbox x/y ${b.x},${b.y}`);       // 0.85/8.5=0.1, 1.1/11=0.1
  assert.ok(near(b.w, 0.4) && near(b.h, 0.05), `bbox w/h ${b.w},${b.h}`);       // (4.25-0.85)/8.5=0.4, (1.65-1.1)/11=0.05
  assert.strictEqual(cp.lines[0].text, 'BORROWER NAME');
  assert.strictEqual(cp.words[0].confidence, 0.98);
  assert.strictEqual(cp.lines[0].polygon.length, 4, 'flat array paired into 4 points');
  ok('Azure flat polygon → normalized 0..1 points + correct bbox; text + confidence kept');
}

// 2. Google: normalizedVertices pass through; pixel vertices normalize; text via anchor.
{
  const fullText = 'Property Address: 12 Main St';
  const page = {
    pageNumber: 1, dimension: { width: 1000, height: 1400, unit: 'pixels' },
    lines: [{
      layout: {
        textAnchor: { textSegments: [{ startIndex: 0, endIndex: 17 }] },
        boundingPoly: { normalizedVertices: [{ x: 0.05, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.14 }, { x: 0.05, y: 0.14 }] },
      },
    }],
    tokens: [{
      layout: {
        textAnchor: { textSegments: [{ startIndex: 18, endIndex: 28 }] },
        boundingPoly: { vertices: [{ x: 100, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 250 }, { x: 100, y: 250 }] },
      },
    }],
  };
  const cp = lc.normalizeGooglePage(page, 0, fullText);
  assert.strictEqual(cp.lines[0].text, 'Property Address:', 'line text via textAnchor');
  assert.ok(near(cp.lines[0].bbox.x, 0.05) && near(cp.lines[0].bbox.w, 0.55), 'normalizedVertices pass through');
  // token pixel vertices normalized by 1000x1400
  assert.ok(near(cp.words[0].bbox.x, 0.1) && near(cp.words[0].bbox.y, 200 / 1400), 'pixel vertices normalized by page dim');
  assert.strictEqual(cp.words[0].text, '12 Main St');
  ok('Google normalizedVertices pass through; pixel vertices normalized; text via anchor');
}

// 3. bboxOf tight rect + clamp on out-of-range Azure coords.
{
  assert.deepStrictEqual(lc.bboxOf([[1, 2], [5, 2], [5, 8], [1, 8]]), { x: 1, y: 2, w: 4, h: 6 });
  assert.strictEqual(lc.bboxOf([]), null);
  // a polygon point beyond the page bounds clamps to 1.
  const cp = lc.normalizeAzurePage({ width: 10, height: 10, lines: [{ content: 'x', polygon: [0, 0, 12, 0, 12, 12, 0, 12] }] }, 0);
  assert.ok(cp.lines[0].bbox.x === 0 && cp.lines[0].bbox.w === 1, 'coords clamp into 0..1');
  ok('bboxOf computes the tight rect; out-of-range coords clamp to [0,1]');
}

// 4. capturePages dispatches per engine over a full result.
{
  const azure = { pages: [{ width: 1, height: 1, lines: [{ content: 'a', polygon: [0, 0, 1, 0, 1, 1, 0, 1] }] }] };
  const gp = lc.capturePages(azure, { engine: 'azure' });
  assert.strictEqual(gp.length, 1);
  assert.strictEqual(gp[0].lines[0].text, 'a');
  const google = { engine: 'google-docai', text: 'hello world', pages: [{ dimension: { width: 100, height: 100 }, lines: [{ layout: { textAnchor: { textSegments: [{ startIndex: 0, endIndex: 5 }] }, boundingPoly: { normalizedVertices: [{ x: 0, y: 0 }, { x: 0.5, y: 0.1 }] } } }] }] };
  const gg = lc.capturePages(google);   // engine read from result.engine
  assert.strictEqual(gg[0].lines[0].text, 'hello');
  ok('capturePages dispatches per engine over a full OCR result');
}

// 5. hostile / partial input never throws; degrades to null geometry, keeps text.
{
  for (const bad of [null, undefined, 42, 'x', [], {}, { lines: 7 }, { polygon: 'zz' }]) {
    assert.doesNotThrow(() => lc.captureLayout(bad, { engine: 'azure' }));
    assert.doesNotThrow(() => lc.captureLayout(bad, { engine: 'google' }));
    assert.doesNotThrow(() => lc.capturePages(bad));
    assert.doesNotThrow(() => lc.bboxOf(bad));
  }
  // a line with a garbled polygon still captures its text, with null geometry.
  const cp = lc.normalizeAzurePage({ width: 10, height: 10, lines: [{ content: 'kept', polygon: ['nope'] }] }, 0);
  assert.strictEqual(cp.lines[0].text, 'kept');
  assert.strictEqual(cp.lines[0].polygon, null);
  assert.strictEqual(cp.lines[0].bbox, null);
  // an unknown engine → empty canonical page, never a throw.
  const u = lc.captureLayout({}, { engine: 'mystery', index: 3 });
  assert.strictEqual(u.pageNumber, 4);
  assert.deepStrictEqual(u.lines, []);
  ok('hostile/partial input never throws; garbled geometry → null, text preserved');
}

// 6. alignerLines flattens canonical pages into the field-aligner input shape.
{
  const pages = [
    { pageNumber: 1, lines: [{ text: 'Line A', polygon: [[0, 0], [1, 0]], bbox: { x: 0, y: 0, w: 1, h: 0 } }, { text: '', polygon: null, bbox: null }] },
    { pageNumber: 2, lines: [{ text: 'Line B', polygon: null, bbox: null }] },
  ];
  const al = lc.alignerLines(pages);
  assert.strictEqual(al.length, 2, 'empty-text lines are skipped');
  assert.deepStrictEqual(al[0], { text: 'Line A', page: 1, polygon: [[0, 0], [1, 0]], bbox: { x: 0, y: 0, w: 1, h: 0 }, spanType: 'line' });
  assert.strictEqual(al[1].page, 2);
  assert.strictEqual(al[1].polygon, null, 'a line with no geometry still aligns (polygon null)');
  assert.doesNotThrow(() => lc.alignerLines(null));
  ok('alignerLines flattens pages into the field-aligner {text,page,polygon} shape');
}

console.log(`\nlayout-capture pure — ${passed} checks passed`);
