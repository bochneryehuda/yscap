#!/usr/bin/env node
'use strict';
/** Pure tests for src/lib/underwriting/chain-of-title.js — the multi-hop ownership trace.
 *  Focus: adjacent-pair reconciliation, multi-assignment hops, never-fabricate on missing data. */
const assert = require('assert');
const { buildChainOfTitle } = require('../src/lib/underwriting/chain-of-title');

const codes = (r) => r.findings.map((f) => f.code).sort();
const ext = (doc_type, fields) => ({ doc_type, fields });

// ---- 1. Clean multi-hop assignment chain → intact, no findings ----
{
  const ctx = { vestingName: 'Maple Grove Holdings LLC', borrower: { first_name: 'John', last_name: 'Smith' } };
  const exts = [
    ext('title', { vestedOwners: ['Alice Owner'] }),
    ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'ABC Wholesale LLC' }),
    ext('assignment', { assignorName: 'ABC Wholesale LLC', assigneeName: 'DEF Investors LLC', sellerName: 'Alice Owner', assignmentDate: '2026-01-05' }),
    ext('assignment', { assignorName: 'DEF Investors LLC', assigneeName: 'Maple Grove Holdings LLC', sellerName: 'Alice Owner', assignmentDate: '2026-02-10' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.strictEqual(r.status, 'intact', 'clean multi-hop → intact');
  assert.deepStrictEqual(codes(r), [], 'clean chain → no findings');
  assert.strictEqual(r.reachesVesting, true);
  assert.strictEqual(r.finalBuyer, 'Maple Grove Holdings LLC');
}

// ---- 2. Contract seller ≠ owner of record → cot_seller_not_owner_of_record, broken ----
{
  const ctx = { vestingName: 'Maple Grove Holdings LLC' };
  const exts = [
    ext('title', { vestedOwners: ['Real Owner Trust'] }),
    ext('purchase_contract', { sellerNames: ['Imposter Seller'], buyerName: 'Maple Grove Holdings LLC' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.ok(codes(r).includes('cot_seller_not_owner_of_record'), 'seller≠owner flagged');
  assert.strictEqual(r.status, 'broken');
  // Not a tie-out fatal code:
  assert.ok(!codes(r).some((c) => /seller_name|tieout/.test(c)));
  assert.ok(r.findings.every((f) => f.blocksCtc === false), 'advisory only');
}

// ---- 3. Assignment assignor never held the contract → cot_assignor_never_held_title ----
{
  const ctx = { vestingName: 'End Vesting LLC' };
  const exts = [
    ext('title', { vestedOwners: ['Alice Owner'] }),
    ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'ABC Wholesale LLC' }),
    // assignor is a party (XYZ) that was never the contract buyer:
    ext('assignment', { assignorName: 'XYZ Stranger LLC', assigneeName: 'End Vesting LLC', assignmentDate: '2026-03-01' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.ok(codes(r).includes('cot_assignor_never_held_title'), 'assignor-never-held flagged');
  assert.strictEqual(r.status, 'broken');
}

// ---- 4. Final assignee ≠ vesting LLC (and not the borrower personally) → cot_final_buyer_not_vesting ----
{
  const ctx = { vestingName: 'Correct Vesting LLC', borrower: { first_name: 'John', last_name: 'Smith' } };
  const exts = [
    ext('title', { vestedOwners: ['Alice Owner'] }),
    ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'ABC Wholesale LLC' }),
    ext('assignment', { assignorName: 'ABC Wholesale LLC', assigneeName: 'Some Other LLC', assignmentDate: '2026-02-01' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.ok(codes(r).includes('cot_final_buyer_not_vesting'), 'final buyer≠vesting flagged');
}

// ---- 4b. Chain ends in the borrower's PERSONAL name → deferred to seller-chain (NO cot finding) ----
{
  const ctx = { vestingName: 'Correct Vesting LLC', borrower: { first_name: 'John', last_name: 'Smith' } };
  const exts = [
    ext('title', { vestedOwners: ['Alice Owner'] }),
    ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'John Smith' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.ok(!codes(r).includes('cot_final_buyer_not_vesting'), 'personal-name case deferred to seller-chain');
}

// ---- 5. Missing title/assignment party → info cot_unverified_hop, never throws ----
{
  const ctx = { vestingName: 'Vesting LLC' };
  const exts = [ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'Vesting LLC' })]; // no title/owner-of-record
  const r = buildChainOfTitle(ctx, exts);
  assert.ok(codes(r).includes('cot_unverified_hop'), 'unconfirmed chain → info');
  assert.ok(r.findings.find((f) => f.code === 'cot_unverified_hop').severity === 'info');
}

// ---- 6. Empty inputs → no findings, no throw ----
{
  const r = buildChainOfTitle({}, []);
  assert.deepStrictEqual(r.findings, []);
  assert.ok(Array.isArray(r.hops));
}

// ---- 7. Entity punctuation tolerance ("ABC Wholesale LLC" ~ "ABC Wholesale L.L.C.") ----
{
  const ctx = { vestingName: 'ABC Wholesale L.L.C.' };
  const exts = [
    ext('title', { vestedOwners: ['Alice Owner'] }),
    ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'ABC Wholesale LLC' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.strictEqual(r.reachesVesting, true, 'suffix punctuation tolerated');
  assert.ok(!codes(r).includes('cot_final_buyer_not_vesting'));
}

// ---- 8. Assignments are ordered by date regardless of input order ----
{
  const ctx = { vestingName: 'End LLC' };
  const exts = [
    ext('title', { vestedOwners: ['Alice Owner'] }),
    ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'Mid1 LLC' }),
    // provided out of order — Feb hop first in the array, Jan hop second:
    ext('assignment', { assignorName: 'Mid2 LLC', assigneeName: 'End LLC', assignmentDate: '2026-02-01' }),
    ext('assignment', { assignorName: 'Mid1 LLC', assigneeName: 'Mid2 LLC', assignmentDate: '2026-01-01' }),
  ];
  const r = buildChainOfTitle(ctx, exts);
  assert.deepStrictEqual(codes(r), [], 'date-ordered hops reconcile → no findings');
  assert.strictEqual(r.status, 'intact');
}

console.log('test-chain-of-title: multi-hop reconciliation + seller/assignor/vesting breaks + ordering + never-fabricate all pass');
