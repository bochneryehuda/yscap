'use strict';
/**
 * Evidence-ledger wiring (R5.17) — pure/fake-client tests.
 * Proves (1) pagesToLines turns analyze ocrPages into aligner lines, (2)
 * store.saveAnalysis records evidence spans + finding links for a doc-side
 * value under a SAVEPOINT, (3) a failure inside the evidence pass rolls back
 * to the savepoint and NEVER breaks saveAnalysis, and (4)
 * twin.recordFactsFromExtraction now returns the observation ids it recorded.
 */
const assert = require('assert');
const aligner = require('../src/lib/underwriting/field-aligner');
const store = require('../src/lib/underwriting/store');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- pagesToLines (pure) ---
const pages = [
  { pageNumber: 1, text: 'Seller: John Doe\nPurchase Price: $500,000' },
  { pageNumber: 2, text: '  \nAccount Holder: Summit LLC\n' },
  null, { pageNumber: 3 }, // hostile entries
];
const lines = aligner.pagesToLines(pages);
assert.strictEqual(lines.length, 3, 'blank lines + hostile pages dropped');
assert.deepStrictEqual(lines[0], { text: 'Seller: John Doe', page: 1 });
assert.deepStrictEqual(lines[2], { text: 'Account Holder: Summit LLC', page: 2 });
assert.deepStrictEqual(aligner.pagesToLines(null), []);
assert.deepStrictEqual(aligner.pagesToLines('x'), []);
// and alignToSpan finds the right page line
const span = aligner.alignToSpan('$500,000', lines);
assert.ok(span && span.pageNumber === 1 && /Purchase Price/.test(span.quote), 'a value aligns to its page line');
ok('pagesToLines builds aligner lines from ocrPages and alignToSpan grounds a value to its page');

// --- a scripted fake pg client for saveAnalysis ---
function makeClient(opts = {}) {
  const calls = [];
  let obN = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const s = String(sql);
      if (opts.failOn && opts.failOn.test(s)) throw new Error('boom:' + opts.failOn);
      if (/INSERT INTO document_extractions/.test(s)) return { rows: [{ id: 'ext-1' }], rowCount: 1 };
      if (/INSERT INTO fact_observations/.test(s)) { obN++; return { rows: [{ id: `ob-${obN}`, created_at: 'now' }], rowCount: 1 }; }
      if (/INSERT INTO document_findings/.test(s)) return { rows: [{ id: `f-${calls.length}` }], rowCount: 1 };
      if (/INSERT INTO evidence_spans/.test(s)) return { rows: [{ id: `span-${calls.length}`, application_id: params && params[0] }], rowCount: 1 };
      if (/SELECT application_id FROM evidence_spans/.test(s)) return { rows: [{ application_id: 'app-1' }], rowCount: 1 };
      if (/INSERT INTO fact_evidence_links|INSERT INTO finding_evidence_links/.test(s)) return { rows: [{ id: 'link' }], rowCount: 1 };
      if (/SELECT/.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const baseArgs = {
  documentId: 'doc-1', applicationId: 'app-1', borrowerId: 'b-1', docType: 'settlement',
  extraction: {
    status: 'analyzed', confidence: 'definite',
    fields: { contractSalesPrice: '$500,000' },
    ocrPages: pages, ocrEngine: 'azure', aiModel: 'gpt',
  },
  findings: [{ code: 'tieout_price', severity: 'warning', field: 'purchase_price', docValue: '$500,000', fileValue: '$490,000', title: 'x', blocksCtc: false }],
  analyzedSha256: 'sha', analyzerVersion: 'v-test', subjectHash: 'subj',
};

(async () => {
  // --- happy path: spans recorded + finding linked, all inside the savepoint ---
  const c1 = makeClient();
  const saved = await store.saveAnalysis(c1, baseArgs);
  assert.ok(saved && saved.extractionId === 'ext-1');
  const sqls = c1.calls.map((c) => c.sql);
  assert.ok(sqls.some((s) => /SAVEPOINT evidence_pass/.test(s)), 'evidence pass opens a savepoint');
  assert.ok(sqls.some((s) => /RELEASE SAVEPOINT evidence_pass/.test(s)), 'and releases it on success');
  assert.ok(sqls.some((s) => /INSERT INTO evidence_spans/.test(s)), 'an evidence span is recorded');
  assert.ok(sqls.some((s) => /INSERT INTO finding_evidence_links/.test(s)), 'the finding is linked to its span');
  ok('saveAnalysis records evidence spans + finding links under a savepoint');

  // --- a mid-pass failure rolls back to the savepoint and saveAnalysis still succeeds ---
  const c2 = makeClient({ failOn: /INSERT INTO evidence_spans/ });
  const saved2 = await store.saveAnalysis(c2, baseArgs);
  assert.ok(saved2 && saved2.extractionId === 'ext-1', 'saveAnalysis is unharmed by an evidence-pass failure');
  const sqls2 = c2.calls.map((c) => c.sql);
  assert.ok(sqls2.some((s) => /ROLLBACK TO SAVEPOINT evidence_pass/.test(s)), 'the failed pass rolls back to the savepoint');
  assert.ok(!sqls2.some((s) => /INSERT INTO finding_evidence_links/.test(s)), 'no dangling link after the failure');
  ok('an evidence-pass failure rolls back to the savepoint and never breaks the extraction');

  // --- twin returns the observation ids it recorded ---
  const twin = require('../src/lib/underwriting/twin');
  const c3 = makeClient();
  const res = await twin.recordFactsFromExtraction(c3, {
    appId: 'app-1', documentId: 'doc-1', docType: 'settlement', extractionId: 'ext-1',
    fields: { contractSalesPrice: '$500,000' },
  });
  assert.ok(res && Array.isArray(res.observations), 'recordFactsFromExtraction returns an observations array');
  if (res.observations.length) {
    assert.ok(res.observations[0].observationId, 'each observation carries its row id');
    assert.ok(res.observations[0].factKey, 'and its fact key');
  }
  ok('recordFactsFromExtraction returns {recorded, observations[]} for span linking');

  console.log(`\nevidence-wiring pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
