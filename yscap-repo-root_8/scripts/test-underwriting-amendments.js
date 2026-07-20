'use strict';
/**
 * Unit tests for the contract-amendment / versioning resolver (amendments.js). Pure — no AI/DB.
 * The governing value = base contract overlaid by the LATEST fully-executed amendment; unexecuted
 * amendments never apply; ambiguous precedence and file-supersession are flagged.
 */
const assert = require('assert');
const { resolveEffectiveTerms } = require('../src/lib/underwriting/amendments');

const base = { purchasePrice: 400000, closingDate: '2026-08-01', buyerName: 'Acme LLC', sellerNames: ['Jane Seller'] };

// ---- No amendments → effective terms are the base contract ----
{
  const r = resolveEffectiveTerms(base, [], { purchase_price: 400000 });
  assert.strictEqual(r.effective.purchasePrice, 400000);
  assert.strictEqual(r.provenance.purchasePrice.source, 'base_contract');
  assert.strictEqual(r.findings.length, 0);
}

// ---- An executed price amendment governs; the file (still 400k) is flagged stale ----
{
  const r = resolveEffectiveTerms(base, [
    { amendmentDate: '2026-07-15', newPurchasePrice: 425000, executed: true },
  ], { purchase_price: 400000 });
  assert.strictEqual(r.effective.purchasePrice, 425000, 'the amendment governs');
  assert.strictEqual(r.provenance.purchasePrice.source, 'amendment');
  const sup = r.findings.find((f) => f.code === 'amendment_supersedes_file');
  assert.ok(sup, 'the file value (400k) differs from the governing 425k');
  assert.ok(/425,000/.test(sup.docValue));
}

// ---- The LATEST executed amendment wins over an earlier one ----
{
  const r = resolveEffectiveTerms(base, [
    { amendmentDate: '2026-07-10', newPurchasePrice: 420000, executed: true },
    { amendmentDate: '2026-07-20', newPurchasePrice: 430000, executed: true },
  ], { purchase_price: 430000 });
  assert.strictEqual(r.effective.purchasePrice, 430000, 'the later amendment governs');
  // File already 430k → no supersede finding, but two setters with distinct dates → no ambiguity.
  assert.ok(!r.findings.some((f) => f.code === 'amendment_ambiguous_precedence'));
  assert.ok(!r.findings.some((f) => f.code === 'amendment_supersedes_file'));
}

// ---- An UNEXECUTED amendment never applies ----
{
  const r = resolveEffectiveTerms(base, [
    { amendmentDate: '2026-07-15', newPurchasePrice: 999000, executed: false },
  ], { purchase_price: 400000 });
  assert.strictEqual(r.effective.purchasePrice, 400000, 'draft amendment ignored');
  assert.strictEqual(r.unexecuted, 1);
  assert.ok(!r.findings.some((f) => f.code === 'amendment_supersedes_file'), 'no supersede — draft does not govern');
}

// ---- Ambiguous precedence: two executed price amendments, same date ----
{
  const r = resolveEffectiveTerms(base, [
    { amendmentDate: '2026-07-15', newPurchasePrice: 420000, executed: true },
    { amendmentDate: '2026-07-15', newPurchasePrice: 435000, executed: true },
  ], { purchase_price: 420000 });
  assert.ok(r.findings.some((f) => f.code === 'amendment_ambiguous_precedence'), 'same-date executed amendments are ambiguous');
}

// ---- A closing-date amendment supersedes the file's closing date ----
{
  const r = resolveEffectiveTerms(base, [
    { amendmentDate: '2026-07-15', newClosingDate: '2026-09-01', executed: true },
  ], { closing_date: '2026-08-01' });
  assert.strictEqual(r.effective.closingDate, '2026-09-01');
  assert.ok(r.findings.some((f) => f.code === 'amendment_supersedes_file' && f.field === 'closingDate'));
}

// ---- The per-document check: an unexecuted amendment that changes a term is flagged ----
{
  const { computeAmendmentFindings } = require('../src/lib/underwriting/doc-checks');
  const unsigned = computeAmendmentFindings({ amendmentDate: '2026-07-15', newPurchasePrice: 425000, executed: false, changeSummary: 'raise price', readable: true }, {}, {});
  assert.ok(unsigned.some((f) => f.code === 'amendment_unexecuted'), 'an unsigned amendment that changes a term is flagged');
  const signed = computeAmendmentFindings({ amendmentDate: '2026-07-15', newPurchasePrice: 425000, executed: true, readable: true }, {}, {});
  assert.ok(!signed.some((f) => f.code === 'amendment_unexecuted'), 'a fully-executed amendment is not flagged unexecuted');
  const blank = computeAmendmentFindings({ readable: false }, {}, {});
  assert.ok(blank.some((f) => f.code === 'contract_amendment_unreadable'), 'an unreadable amendment routes to manual review');
}

console.log('test-underwriting-amendments: effective-terms resolution + precedence + supersession pass');
