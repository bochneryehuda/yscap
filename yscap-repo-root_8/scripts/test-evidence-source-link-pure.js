'use strict';
/**
 * Evidence source link on DERIVED findings (owner-reported 2026-07-27: "every finding needs a
 * direct link to the document — open me to the exact spot").
 *
 * A tie-out discrepancy is not a stored `document_findings` row, so it has no `document_id`; it
 * carries the specific conflicting `sources[]` (each with a `documentId` when that side is a real
 * PDF). The file view's `decorate()` now surfaces the finding's source document from those sources
 * so the card renders the SAME "Open the source document" link every stored finding has — but only
 * when the choice is UNAMBIGUOUS (exactly one openable source). When two or more sources are
 * openable the card already offers the richer side-by-side compare, so decorate leaves `documentId`
 * unset and lets that win.
 *
 * Pure: requires the route module (with a dummy DATABASE_URL so the db shim stays quiet) and
 * exercises the exported `_decorate` directly. No DB, no network.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const assert = require('assert');
const route = require('../src/routes/underwriting');
const decorate = route._decorate;
assert.strictEqual(typeof decorate, 'function', 'route exports _decorate for testing');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1) A tie-out finding with exactly ONE openable source → decorate surfaces it as documentId.
{
  const f = {
    code: 'tieout_purchase_price', severity: 'warning', title: 'Purchase price disagrees',
    sources: [
      { kind: 'file', label: 'Loan file', value: '$500,000', documentId: null },
      { kind: 'document', label: 'Purchase contract', value: '$525,000', documentId: 'doc-contract-1' },
    ],
  };
  const d = decorate(f);
  assert.strictEqual(d.documentId, 'doc-contract-1', 'single openable source becomes the finding source doc');
  ok('tie-out with one openable source gets an "Open the source document" link');
}

// 2) A tie-out finding with TWO+ openable sources → decorate does NOT pick one (compare wins).
{
  const f = {
    code: 'tieout_address', severity: 'warning', title: 'Address disagrees',
    sources: [
      { kind: 'document', label: 'Appraisal', value: '1 Main St', documentId: 'doc-appraisal' },
      { kind: 'document', label: 'Title', value: '1 Maine St', documentId: 'doc-title' },
    ],
  };
  const d = decorate(f);
  assert.strictEqual(d.documentId, undefined, 'ambiguous multi-doc conflict is left to the compare view');
  ok('tie-out with two openable sources is left for the side-by-side compare, not a single link');
}

// 3) A stored per-document finding already has document_id → decorate never overrides it.
{
  const f = {
    code: 'insurance_mortgagee_clause', severity: 'fatal', title: 'Wrong mortgagee', document_id: 'doc-binder',
    // even if a stray sources[] is present, the real document_id must win
    sources: [{ kind: 'document', label: 'Invoice', value: 'x', documentId: 'doc-invoice' }],
  };
  const d = decorate(f);
  assert.strictEqual(d.document_id, 'doc-binder', 'the real document_id is preserved');
  assert.strictEqual(d.documentId, undefined, 'decorate does not add a second, conflicting documentId');
  ok('a real per-document finding keeps its own document_id (no override)');
}

// 4) No sources and no document_id (staleness / metric / aggregate finding) → no link, no crash.
{
  const f = { code: 'metric_ltv_high', severity: 'warning', title: 'LTV high' };
  const d = decorate(f);
  assert.strictEqual(d.document_id == null && d.documentId == null, true, 'aggregate finding stays link-less');
  ok('an aggregate finding with no source is unchanged (no link fabricated)');
}

// 5) sources present but NONE openable (all documentId null) → no link.
{
  const f = {
    code: 'tieout_seller', severity: 'warning', title: 'Seller disagrees',
    sources: [
      { kind: 'file', label: 'Loan file', value: 'A', documentId: null },
      { kind: 'file', label: 'Other file datum', value: 'B', documentId: null },
    ],
  };
  const d = decorate(f);
  assert.strictEqual(d.documentId, undefined, 'no openable source → no fabricated link');
  ok('sources with no openable document produce no link');
}

// 6) The claim key is still stamped (decorate keeps doing its original job).
{
  const f = { code: 'tieout_purchase_price', severity: 'warning', title: 'x',
    sources: [{ kind: 'document', label: 'K', value: 'y', documentId: 'doc-1' }] };
  const d = decorate(f);
  assert.ok('claimKey' in d, 'claimKey is always stamped');
  assert.ok(Array.isArray(d.availableActions), 'availableActions is always attached');
  ok('decorate still stamps claimKey and availableActions alongside the new link');
}

console.log(`\nOK  evidence-source-link pure — ${passed} checks passed`);
