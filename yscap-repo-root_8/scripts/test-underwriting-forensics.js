'use strict';
/**
 * Unit tests for the PDF tampering-forensics scan (pdf-forensics.js). Pure — no DB/AI.
 * The overriding requirement: legitimate documents (linearized statements, e-signed contracts,
 * library-generated PDFs) are NEVER flagged. Only image-editor metadata raises the advisory.
 */
const assert = require('assert');
const { analyzePdf } = require('../src/lib/underwriting/pdf-forensics');
const buf = (s) => Buffer.from(s, 'latin1');
const codes = (fs) => fs.map((f) => f.code).sort();

// ---- Safety: never throws, non-PDF ignored ----
assert.deepStrictEqual(analyzePdf(null).findings, []);
assert.deepStrictEqual(analyzePdf(undefined).findings, []);
assert.deepStrictEqual(analyzePdf(buf('')).findings, []);
assert.deepStrictEqual(analyzePdf(buf('\xFF\xD8\xFF\xE0 JFIF jpeg')).findings, [], 'a JPEG is not a PDF → no signal');
assert.strictEqual(analyzePdf(buf('\xFF\xD8\xFF\xE0 JFIF jpeg')).isPdf, false);
assert.deepStrictEqual(analyzePdf(Buffer.alloc(5000)).findings, [], 'zeros → no crash, no signal');

// ---- LEGITIMATE documents must NOT be flagged (the whole point) ----
// Clean single-generation PDF.
assert.deepStrictEqual(analyzePdf(buf('%PDF-1.7\n/Producer (Microsoft Print to PDF) /CreationDate (D:20260701120000) /ModDate (D:20260701120000)\n%%EOF')).findings, [], 'clean PDF → nothing');
// Linearized statement (two %%EOF by construction) + library generator (iText) + ModDate>CreationDate.
assert.deepStrictEqual(analyzePdf(buf('%PDF-1.7\n/Producer (iText 7.2.0 \\(iText Group\\)) /CreationDate (D:20260701120000) /ModDate (D:20260701120030)\n%%EOF\nxref update\n%%EOF')).findings, [], 'a linearized, iText-generated bank statement is NOT flagged');
// DocuSign e-signed contract: incremental save + bumped ModDate, no image editor.
assert.deepStrictEqual(analyzePdf(buf('%PDF-1.7\n/Producer (DocuSign) /CreationDate (D:20260701120000) /ModDate (D:20260715090000)\n%%EOF\n/Type /Sig /ByteRange[0 100 200 300]\n%%EOF')).findings, [], 'an e-signed document is NOT flagged');
// Nitro-printed doc with a later ModDate.
assert.deepStrictEqual(analyzePdf(buf('%PDF-1.7\n/Producer (Nitro PDF) /CreationDate (D:20260701120000) /ModDate (D:20260715090000)\n%%EOF')).findings, [], 'a Nitro-generated doc is NOT flagged');
// Scanner app.
assert.deepStrictEqual(analyzePdf(buf('%PDF-1.7\n/Producer (Adobe Scan) /CreationDate (D:20260701120000) /ModDate (D:20260701120100)\n%%EOF\n%%EOF')).findings, [], 'a scanned doc is NOT flagged');

// ---- The ONE thing that IS flagged: image-editing software ----
{
  const r = analyzePdf(buf('%PDF-1.7\n/Producer (Adobe Photoshop 25.0) /CreationDate (D:20260701120000)\n%%EOF'));
  assert.deepStrictEqual(codes(r.findings), ['pdf_tampering_signs']);
  assert.strictEqual(r.findings[0].severity, 'warning');
  assert.strictEqual(r.findings[0].blocksCtc, false, 'never blocks — advisory only');
  assert.ok(/image-editing software/.test(r.findings[0].howTo));
}
// GIMP anywhere in the metadata (even behind an earlier benign Producer) is still caught.
assert.deepStrictEqual(codes(analyzePdf(buf('%PDF-1.7\n/Producer (Microsoft Word)\n... later ...\n/Creator (GIMP 2.10)\n%%EOF')).findings), ['pdf_tampering_signs']);
// Photopea (web image editor).
assert.deepStrictEqual(codes(analyzePdf(buf('%PDF-1.7\n/Producer (Photopea)\n%%EOF')).findings), ['pdf_tampering_signs']);

console.log('✓ test-underwriting-forensics: legitimate docs pass clean; only image-editor metadata is flagged');
