/**
 * Tie-out two-document contradiction sources (owner-directed 2026-07-22).
 * Each tie-out discrepancy now carries the specific conflicting `sources`
 * ({ kind, label, value, documentId }) so the desk can open the two disagreeing
 * documents side by side ("this document vs. that document"). Pure — no DB.
 */
const assert = require('assert');
const { buildTieout } = require('../src/lib/underwriting/tieout');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// (A) file-vs-document: the file's purchase price disagrees with the settlement
// statement (settlement isn't per-doc-covered for purchase_price, so the tie-out
// raises it). sources = [loan file, the conflicting document with its id].
{
  const ctx = { app: { purchase_price: 400000, is_assignment: false } };
  const sources = [{ id: 'e1', documentId: 'doc-settle', docType: 'settlement', fields: { contractSalesPrice: 450000 } }];
  const out = buildTieout(ctx, sources);
  const d = out.discrepancies.find((x) => x.field === 'purchase_price');
  ok(!!d, 'A: a purchase_price discrepancy is raised (file vs settlement)');
  ok(Array.isArray(d.sources) && d.sources.length === 2, 'A: it carries exactly two sources (file + settlement)');
  const file = d.sources.find((s) => s.kind === 'file');
  const doc = d.sources.find((s) => s.kind === 'document');
  ok(file && file.documentId === null, 'A: the loan-file source has no documentId (no PDF)');
  ok(doc && doc.documentId === 'doc-settle', 'A: the document source carries its real document id');
  ok(doc && /450,000/.test(String(doc.value)) && file && /400,000/.test(String(file.value)), 'A: each source shows its own value');
}

// (B) document-vs-document: two documents disagree on the SELLER (no file value),
// so both documents are the conflicting sources.
{
  const ctx = { app: {} };   // no seller on the file
  const sources = [
    { id: 'e1', documentId: 'doc-contract', docType: 'purchase_contract', fields: { sellerNames: ['Alice Seller'] } },
    { id: 'e2', documentId: 'doc-settle', docType: 'settlement', fields: { sellerName: 'Bob Different' } },
  ];
  const out = buildTieout(ctx, sources);
  const d = out.discrepancies.find((x) => x.field === 'seller_name');
  ok(!!d, 'B: a seller_name discrepancy is raised (document vs document)');
  ok(d && Array.isArray(d.sources) && d.sources.length === 2 && d.sources.every((s) => s.kind === 'document'), 'B: both sources are documents');
  const ids = (d && d.sources || []).map((s) => s.documentId).sort();
  ok(ids[0] === 'doc-contract' && ids[1] === 'doc-settle', 'B: both document ids are present for the side-by-side compare');
}

// (C) a source WITHOUT a documentId (e.g. the appraisal source) still surfaces,
// with documentId null (the UI shows it as a value chip, not an openable pane).
{
  const ctx = { app: { arv: 600000 } };
  const sources = [{ id: 'appraisal', docType: 'appraisal', fields: { arvValue: 700000 } }];   // no documentId
  const out = buildTieout(ctx, sources);
  const d = out.discrepancies.find((x) => x.field === 'arv');
  ok(!!d, 'C: an ARV discrepancy is raised (file vs appraisal)');
  const doc = (d.sources || []).find((s) => s.kind === 'document');
  ok(doc && doc.documentId === null, 'C: a source with no source-PDF carries documentId null (still listed)');
}

assert.strictEqual(failures, 0, `${failures} assertion(s) failed`);
console.log(failures ? `\n${failures} failed` : '\nALL tieout-sources assertions passed');
process.exit(failures ? 1 : 0);
