'use strict';
/** Unit tests for the PDF tampering-forensics scan (pdf-forensics.js). Pure — no DB/AI. */
const assert = require('assert');
const { analyzePdf } = require('../src/lib/underwriting/pdf-forensics');
const buf = (s) => Buffer.from(s, 'latin1');
const codes = (fs) => fs.map((f) => f.code).sort();

// Non-PDF (e.g. a JPEG ID) → not analyzed, no signals, no findings.
{
  const r = analyzePdf(buf('\xFF\xD8\xFF\xE0 JFIF some jpeg bytes'));
  assert.strictEqual(r.isPdf, false);
  assert.deepStrictEqual(r.findings, []);
}
// Empty / null → safe.
assert.deepStrictEqual(analyzePdf(null).findings, []);
assert.deepStrictEqual(analyzePdf(buf('')).findings, []);

// A clean, single-generation PDF → signals possible but NO advisory raised.
{
  const clean = '%PDF-1.7\n/Producer (Microsoft Print to PDF) /CreationDate (D:20260701120000) /ModDate (D:20260701120000)\n%%EOF';
  const r = analyzePdf(buf(clean));
  assert.strictEqual(r.isPdf, true);
  assert.deepStrictEqual(r.findings, [], 'a clean PDF raises no tampering advisory');
}

// A single incremental save alone (common with e-sign) → NO advisory (too common to flag).
{
  const oneUpdate = '%PDF-1.7\n/CreationDate (D:20260701120000)\n%%EOF\n... appended ...\n%%EOF';
  assert.deepStrictEqual(analyzePdf(buf(oneUpdate)).findings, [], 'incremental save alone is not flagged');
}

// Image-editor fingerprint (a bank statement "made in Photoshop") → WARNING advisory.
{
  const photoshopped = '%PDF-1.7\n/Producer (Adobe Photoshop 25.0) /CreationDate (D:20260701120000)\n%%EOF';
  const r = analyzePdf(buf(photoshopped));
  assert.deepStrictEqual(codes(r.findings), ['pdf_tampering_signs']);
  assert.strictEqual(r.findings[0].severity, 'warning');
  assert.strictEqual(r.findings[0].blocksCtc, false, 'never blocks — advisory only');
}

// Saved-over AND modified-after-creation → advisory (info).
{
  const edited = '%PDF-1.7\n/CreationDate (D:20260701120000) /ModDate (D:20260715090000)\n%%EOF\nappended\n%%EOF';
  const r = analyzePdf(buf(edited));
  assert.deepStrictEqual(codes(r.findings), ['pdf_tampering_signs']);
  assert.ok(r.findings[0].severity === 'info' || r.findings[0].severity === 'warning');
  assert.ok(/modified after it was created/.test(r.findings[0].howTo));
}

// PDF-editor fingerprint + a modification → advisory.
{
  const filled = '%PDF-1.7\n/Producer (PDFescape) /CreationDate (D:20260701120000) /ModDate (D:20260715090000)\n%%EOF';
  assert.deepStrictEqual(codes(analyzePdf(buf(filled)).findings), ['pdf_tampering_signs']);
}

console.log('✓ test-underwriting-forensics: PDF tampering-signal detection cases pass');
