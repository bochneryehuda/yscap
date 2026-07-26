'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-3 read→evidence mapper
 * (src/pipeline/read-to-evidence.js). Pure: no DB, no network.
 *
 * Proves: a real read result becomes evidence candidates WITH page-level provenance — the document
 * type from the highest-confidence segment's pages, and each extractor field stamped with the page
 * it was read from; empty/garbage results yield []; never fabricates a page; never throws.
 */
const R = require('path').resolve(__dirname, '..');
const RTE = require(R + '/src/pipeline/read-to-evidence');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(function main() {
  const ctx = { jobId: 'j1', documentId: 'd1', loanId: 'l1', family: 'bank_statement' };

  // ---- empty / garbage → [] , never throws ----
  ok(RTE.readToEvidence(null, ctx).length === 0, 'null result → []');
  ok(RTE.readToEvidence({}, ctx).length === 0, 'empty result → []');
  ok(RTE.readToEvidence({ segments: 'x', fields: 'y' }, ctx).length === 0, 'garbage-typed fields/segments → [] (no throw)');

  // ---- document type from the highest-confidence segment, with page provenance ----
  const withType = RTE.readToEvidence({
    documentType: 'bank_statement', confidence: 0.92, provider: 'azure', service: 'document_intelligence',
    segments: [
      { docType: 'insurance', confidence: 0.4, pages: [1] },
      { docType: 'bank_statement', confidence: 0.92, pages: [2, 3] },
    ],
  }, ctx);
  const dt = withType.find((c) => c.fieldKey === 'document_type');
  ok(!!dt, 'a document_type candidate is produced');
  ok(dt.valueText === 'bank_statement' && dt.confidence === 0.92, 'document_type: value + confidence carried');
  ok(dt.pageNumber === 2, 'document_type: page from the highest-confidence segment (page 2)');
  ok(dt.evidenceSpan && dt.evidenceSpan.source === 'classifier' && Array.isArray(dt.evidenceSpan.pages) && dt.evidenceSpan.pages[0] === 2, 'document_type: evidenceSpan carries the classifier page range');
  ok(dt.jobId === 'j1' && dt.documentId === 'd1' && dt.loanId === 'l1' && dt.documentFamily === 'bank_statement', 'candidate links job/document/loan/family from ctx');
  ok(dt.provider === 'azure' && dt.service === 'document_intelligence', 'candidate carries the reader provider/service');

  // ---- a document type with NO segment pages → pageNumber null (never fabricate) ----
  const noSegPage = RTE.readToEvidence({ documentType: 'insurance', confidence: 0.8 }, ctx).find((c) => c.fieldKey === 'document_type');
  ok(noSegPage.pageNumber === null, 'no segment pages → document_type pageNumber null (never guessed)');

  // ---- extractor fields, each stamped with its page (multiple provenance shapes) ----
  const withFields = RTE.readToEvidence({
    documentType: 'bank_statement', confidence: 0.9, provider: 'azure', service: 'document_intelligence',
    fields: [
      { key: 'Account Holder', value: 'John Smith', confidence: 0.88, page: 1 },
      { name: 'coverage_amount', content: '500000', confidence: 0.7, boundingRegions: [{ pageNumber: 4, polygon: [0, 0, 1, 1] }] },
      { key: 'blank_field', value: '', confidence: 0.5 },           // empty value → skipped
      { key: '', value: 'no key', confidence: 0.5 },                // no key → skipped
    ],
  }, ctx);
  const holder = withFields.find((c) => c.fieldKey === 'account_holder');
  ok(!!holder && holder.valueText === 'John Smith' && holder.pageNumber === 1, 'field: "Account Holder" → key normalized, value + page 1');
  ok(holder.evidenceSpan.source === 'field' && holder.evidenceSpan.page === 1, 'field: evidenceSpan source=field with page');
  const cov = withFields.find((c) => c.fieldKey === 'coverage_amount');
  ok(!!cov && cov.valueText === '500000' && cov.pageNumber === 4, 'field: page from boundingRegions[0].pageNumber (page 4)');
  ok(Array.isArray(cov.evidenceSpan.polygon) && cov.evidenceSpan.polygon.length === 4, 'field: bounding polygon carried as provenance');
  ok(!withFields.some((c) => c.fieldKey === 'blank_field'), 'field with empty value → NOT recorded (no empty facts)');
  ok(!withFields.some((c) => c.valueText === 'no key'), 'field with no key → NOT recorded');

  // ---- a field with an unknown page → pageNumber null ----
  const noPage = RTE.readToEvidence({ fields: [{ key: 'x', value: 'y', confidence: 0.5 }] }, ctx)[0];
  ok(noPage.pageNumber === null && noPage.evidenceSpan.page === null, 'field with no page info → pageNumber null (never fabricated)');

  // ---- cap: never floods the ledger ----
  const many = { fields: Array.from({ length: 500 }, (_, i) => ({ key: 'f' + i, value: 'v' + i, confidence: 0.5 })) };
  ok(RTE.readToEvidence(many, ctx).length <= RTE._internals.MAX_CANDIDATES, 'candidate count is capped');

  console.log(`test-read-to-evidence-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
