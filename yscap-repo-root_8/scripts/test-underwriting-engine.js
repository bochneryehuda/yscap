'use strict';
/**
 * Unit tests for the underwriting orchestration engine
 * (src/lib/underwriting/engine.js), using injected reader/analyzer stubs.
 * Pure — no DB, no network, no keys.
 */
const assert = require('assert');
const { analyzeDocument } = require('../src/lib/underwriting/engine');

const TODAY = '2026-07-19';
const borrower = {
  first_name: 'John', last_name: 'Smith', date_of_birth: '1980-05-15',
  current_address: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
};
const reader = (result) => ({ read: async () => result });
const analyzer = (result) => ({ extract: async () => result });

const idFields = {
  documentType: 'driver_license', firstName: 'John', lastName: 'Smith', fullName: 'John Smith',
  dateOfBirth: '1980-05-15',
  address: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  documentNumber: 'TX1', expirationDate: '2028-01-01', issueDate: '2022-01-01', readable: true, notes: null,
};

async function main() {
  // 1. Happy path: reader + analyzer succeed, checks run, extraction is 'analyzed'.
  {
    const res = await analyzeDocument(
      { docType: 'government_id', base64: 'ZmFrZQ==', mimeType: 'image/jpeg', subject: borrower, today: TODAY },
      { reader: reader({ ok: true, text: 'JOHN SMITH ...', pageCount: 1 }), analyzer: analyzer({ ok: true, data: idFields }) },
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.extraction.status, 'analyzed');
    assert.strictEqual(res.extraction.ocrEngine, 'document_intelligence');
    assert.strictEqual(res.extraction.confidence, 'analyzed');
    assert.deepStrictEqual(res.findings, [], 'a clean matching ID yields no findings');
  }

  // 1b. A mismatch flows through to a fatal finding.
  {
    const res = await analyzeDocument(
      { docType: 'government_id', base64: 'x', mimeType: 'image/jpeg', subject: borrower, today: TODAY },
      { reader: reader({ ok: true, text: 't', pageCount: 1 }), analyzer: analyzer({ ok: true, data: { ...idFields, dateOfBirth: '1979-01-01' } }) },
    );
    assert.strictEqual(res.findings.length, 1);
    assert.strictEqual(res.findings[0].code, 'id_dob_mismatch');
    assert.strictEqual(res.findings[0].severity, 'fatal');
  }

  // 2. Analyzer failure → 'error' extraction + a single "verify by hand" finding, never a throw.
  {
    const res = await analyzeDocument(
      { docType: 'purchase_contract', base64: 'x', mimeType: 'application/pdf', subject: {}, today: TODAY },
      { reader: reader({ ok: true, text: 'contract text', pageCount: 3 }), analyzer: analyzer({ ok: false, reason: 'the analyzer timed out' }) },
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.extraction.status, 'error');
    assert.strictEqual(res.extraction.pageCount, 3, 'page count from the reader is retained even when understanding fails');
    assert.strictEqual(res.findings.length, 1);
    assert.strictEqual(res.findings[0].code, 'needs_manual_review');
    assert.strictEqual(res.findings[0].blocksCtc, false);
  }

  // 3. Reader failure but analyzer still reads the image → still succeeds (OCR is best-effort).
  {
    const res = await analyzeDocument(
      { docType: 'government_id', base64: 'x', mimeType: 'image/png', subject: borrower, today: TODAY },
      { reader: reader({ ok: false, reason: 'the reader found no text' }), analyzer: analyzer({ ok: true, data: idFields }) },
    );
    assert.strictEqual(res.ok, true, 'a thin OCR read should not fail when the analyzer still understands the image');
    assert.strictEqual(res.extraction.ocrEngine, null);
  }

  // 4. Unknown document type → clean error, no throw.
  {
    const res = await analyzeDocument({ docType: 'mystery', base64: 'x', mimeType: 'application/pdf', subject: {} });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /unknown document type/);
  }

  console.log('✓ test-underwriting-engine: orchestration (read → understand → check) cases pass');
}

main().catch((e) => { console.error(e); process.exit(1); });
