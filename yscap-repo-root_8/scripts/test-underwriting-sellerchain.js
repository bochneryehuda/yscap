'use strict';
/* Unit tests for the seller→buyer ownership chain (seller-chain.js). Pure — no DB, no AI. */
const assert = require('assert');
const { buildSellerChain } = require('../src/lib/underwriting/seller-chain');

const borrower = { first_name: 'Michael', last_name: 'Goldberg' };
const ctx = { borrower, vestingName: 'Maple Grove Holdings LLC', app: { is_assignment: true } };
const exts = (over = {}) => ([
  { doc_type: 'title', fields: { vestedOwners: ['John Smith'], ...over.title } },
  { doc_type: 'purchase_contract', fields: { sellerNames: ['John Smith'], buyerName: 'ABC Wholesale LLC', ...over.contract } },
  { doc_type: 'assignment', fields: { assigneeName: 'Maple Grove Holdings LLC', sellerName: 'ABC Wholesale LLC', ...over.assignment } },
]);
const has = (r, code) => r.findings.some((f) => f.code === code);

// ---- A clean chain reaching the vesting LLC raises nothing ----
{
  const r = buildSellerChain(ctx, exts());
  assert.strictEqual(r.reachesVesting, true, 'assignee is the vesting LLC → reached');
  assert.strictEqual(r.findings.length, 0, 'a clean chain raises no chain findings');
  assert.ok(r.nodes.length >= 4 && r.nodes.some((n) => n.role === 'Vesting entity (our borrower)'));
}

// ---- Contract/assignment lands in the borrower's PERSONAL name → suggest assign-to-LLC ----
{
  const r = buildSellerChain(ctx, exts({ assignment: { assigneeName: 'Michael Goldberg' } }));
  assert.ok(has(r, 'contract_in_personal_name'), 'personal-name assignee → the LLC-assignment suggestion');
  const f = r.findings.find((x) => x.code === 'contract_in_personal_name');
  assert.strictEqual(f.severity, 'warning');
  assert.strictEqual(f.blocksCtc, false, 'it is a fixable condition, not a hard block');
  assert.strictEqual(f.opensCondition, 'assignment_to_vesting_entity');
  assert.strictEqual(f.docValue, 'Michael Goldberg');
  assert.strictEqual(f.fileValue, 'Maple Grove Holdings LLC');
}

// ---- Non-assignment purchase directly in the LLC name is clean ----
{
  const c2 = { borrower, vestingName: 'Maple Grove Holdings LLC', app: { is_assignment: false } };
  const r = buildSellerChain(c2, [
    { doc_type: 'title', fields: { vestedOwners: ['John Smith'] } },
    { doc_type: 'purchase_contract', fields: { sellerNames: ['John Smith'], buyerName: 'Maple Grove Holdings LLC' } },
  ]);
  assert.strictEqual(r.reachesVesting, true);
  assert.strictEqual(r.findings.length, 0);
}

// ---- Non-assignment purchase in the borrower's personal name → suggest assign-to-LLC ----
{
  const c2 = { borrower, vestingName: 'Maple Grove Holdings LLC', app: { is_assignment: false } };
  const r = buildSellerChain(c2, [
    { doc_type: 'title', fields: { vestedOwners: ['John Smith'] } },
    { doc_type: 'purchase_contract', fields: { sellerNames: ['John Smith'], buyerName: 'Michael Goldberg' } },
  ]);
  assert.ok(has(r, 'contract_in_personal_name'));
}

// ---- The chain view marks a broken seller link (owner of record ≠ contract seller) ----
{
  // title owner John Smith, but contract seller is a wholesaler that isn't the record owner
  const r = buildSellerChain(ctx, exts({ contract: { sellerNames: ['ABC Wholesale LLC'], buyerName: 'ABC Wholesale LLC' } }));
  const edge = r.edges.find((e) => e.from === 'Owner of record' && e.to === 'Seller on contract');
  assert.strictEqual(edge.status, 'mismatch', 'owner-of-record ≠ contract seller shows as a broken link');
  assert.strictEqual(r.status, 'broken');
  // …but the chain module does NOT re-raise the seller fatal (that is the tie-out's job).
  assert.ok(!has(r, 'tieout_seller_name'));
}

// ---- Never-guess: empty inputs raise nothing and never throw ----
{
  const r = buildSellerChain({}, []);
  assert.strictEqual(r.findings.length, 0);
  assert.ok(Array.isArray(r.nodes));
}

console.log('test-underwriting-sellerchain: ownership chain + personal-name→LLC suggestion pass');
