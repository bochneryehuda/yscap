'use strict';
/**
 * P1 — pure tests for the document-feature probe. Proves it NEVER throws and
 * returns safe defaults (hasNativeText:false → the matrix OCRs) on empty / bad /
 * non-PDF / probe-unavailable input, and flags an appraisal delivered as XML.
 * The real native-text extraction runs against unpdf in CI/prod (not installed
 * locally); the contract tested here is the safe-fallback behavior the matrix
 * depends on.
 */
const assert = require('assert');
const df = require('../src/lib/ai/document-features');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  // empty input → safe defaults
  let r = await df.detectFeatures({ base64: '', mimeType: 'application/pdf' });
  assert.strictEqual(r.hasNativeText, false);
  assert.strictEqual(r.appraisalXmlPresent, false);
  ok('empty input → safe defaults (never throws, OCR fallback)');

  // a non-PDF image → no native-text claim
  r = await df.detectFeatures({ buffer: Buffer.from('not a pdf'), mimeType: 'image/jpeg' });
  assert.strictEqual(r.hasNativeText, false, 'an image has no native text layer');
  ok('a non-PDF image → hasNativeText false');

  // a PDF whose probe library is unavailable locally → safe fallback (no throw)
  r = await df.detectFeatures({ buffer: Buffer.from('%PDF-1.4 minimal'), mimeType: 'application/pdf' });
  assert.strictEqual(r.hasNativeText, false, 'probe unavailable → falls back to OCR, never throws');
  ok('a PDF with the probe unavailable → safe OCR fallback, no throw');

  // an appraisal delivered AS xml → appraisalXmlPresent true (no PDF probe)
  r = await df.detectFeatures({ base64: Buffer.from('<VALUATION_RESPONSE/>').toString('base64'), mimeType: 'application/xml', docType: 'appraisal', filename: 'appr.xml' });
  assert.strictEqual(r.appraisalXmlPresent, true, 'appraisal XML sidecar is flagged for the matrix');
  ok('an appraisal delivered as XML → appraisalXmlPresent true');

  // a NON-appraisal xml is not flagged as an appraisal sidecar
  r = await df.detectFeatures({ base64: Buffer.from('<x/>').toString('base64'), mimeType: 'application/xml', docType: 'title', filename: 't.xml' });
  assert.strictEqual(r.appraisalXmlPresent, false, 'only an appraisal XML is the appraisal sidecar');
  ok('a non-appraisal XML is not flagged as an appraisal sidecar');

  // internals: magic-byte PDF detection + xml filename detection
  assert.strictEqual(df._internals.isPdf('', Buffer.from('%PDF-1.7')), true);
  assert.strictEqual(df._internals.isPdf('image/png', Buffer.from('\x89PNG')), false);
  assert.strictEqual(df._internals.isXml('', 'report.xml'), true);
  ok('isPdf recognizes the %PDF magic; isXml recognizes an .xml filename');

  console.log(`\nP1 document-features pure — ${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
