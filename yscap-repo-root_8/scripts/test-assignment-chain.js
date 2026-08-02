#!/usr/bin/env node
'use strict';
/**
 * Pure tests for src/lib/underwriting/assignment-chain.js + the role-aware seller comparison it
 * gives the tie-out (owner-directed 2026-08-02).
 *
 * What is being pinned: a wholesale deal has THREE bodies (original seller → flipper → end buyer)
 * and TWO legs of paper, the money has to close across both legs AND the loan file, and a document
 * naming the flipper as ITS seller must never be judged against the original seller. Plus the
 * never-fabricate discipline: a role is only assigned on positive proof, and an amount we cannot
 * read is never turned into an accusation.
 */
const assert = require('assert');
const { buildAssignmentChain } = require('../src/lib/underwriting/assignment-chain');
const { buildTieout } = require('../src/lib/underwriting/tieout');

const ADDR = { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' };
const SELLER = 'Atlantic Bay 6 LLC';
const FLIPPER = 'Ocean 100 Delaware LLC';
const VEST = '76 Thompson St LLC';

const ext = (doc_type, fields, id) => ({ id: id || null, doc_type, fields });
const codes = (r) => r.findings.map((f) => f.code).sort();
// The wholesale file: seller price 438k + a 36k flip fee = the 474k the borrower pays.
const asgCtx = (over) => ({
  app: Object.assign({ property_address: ADDR, is_assignment: true, purchase_price: 474000,
    underlying_contract_price: 438000, assignment_fee: 36000 }, over || {}),
  borrower: { first_name: 'Moshe', last_name: 'Spitzer' },
  vestingName: VEST,
});

// ===== 1. A clean assignment: contract + assignment paper, every number closing =====
{
  const exts = [
    ext('title', { propertyAddress: ADDR, vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { propertyAddress: ADDR, assignorName: FLIPPER, assigneeName: VEST, sellerName: SELLER,
      originalPurchasePrice: 438000, assignmentFee: 36000, totalPriceToAssignee: 474000 }, 'a1'),
  ];
  const r = buildAssignmentChain(asgCtx(), exts);
  assert.deepStrictEqual(codes(r), [], 'a clean wholesale chain raises nothing');
  assert.strictEqual(r.status, 'intact');
  assert.deepStrictEqual(r.parties.originalSeller, [SELLER], 'the original seller is the owner of record');
  assert.deepStrictEqual(r.parties.flipper, [FLIPPER], 'the flipper is the assignor / contract buyer');
  assert.deepStrictEqual(r.parties.endBuyer, [VEST], 'the end buyer is the assignee');
  assert.strictEqual(r.money.documents.underlying, 438000);
  assert.strictEqual(r.money.documents.flip, 36000);
  assert.strictEqual(r.money.flipAgrees, true);
  assert.strictEqual(r.legs.length, 2, 'two legs of paper');
  assert.strictEqual(r.legs[0].amount, 438000, "leg 1 carries the seller's price");
  assert.strictEqual(r.legs[1].amount, 36000, 'leg 2 carries the flip fee');
}

// ===== 2. TWO CONTRACTS — the flip contract's seller is the FLIPPER, not the original seller =====
// This is the shape that produced the all-red "Seller" row: the second contract legitimately names a
// different seller, and the matrix was comparing the two as if they had to be the same party.
{
  const exts = [
    ext('title', { propertyAddress: ADDR, vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: [FLIPPER], buyerName: VEST, purchasePrice: 474000 }, 'c2'),
  ];
  const r = buildAssignmentChain(asgCtx(), exts);
  assert.deepStrictEqual(codes(r), [], 'two connected contracts raise nothing');
  assert.strictEqual(r.sellerRoleBySource.c1, 'origin', "the seller's contract names the original seller");
  assert.strictEqual(r.sellerRoleBySource.c2, 'flipper', 'the flip contract names the wholesaler as its seller');
  assert.deepStrictEqual(r.parties.flipper, [FLIPPER]);
  assert.strictEqual(r.money.documents.flip, 36000, 'the flip fee is derived from the two contract prices');

  // …and the tie-out no longer calls that a seller mismatch.
  const to = buildTieout(asgCtx(), exts.map((e) => ({ id: e.id, docType: e.doc_type, fields: e.fields })));
  assert.ok(!to.discrepancies.some((d) => d.code === 'tieout_seller_name'),
    'a flip contract naming the wholesaler is NOT a seller mismatch');
  const row = to.matrix.find((m) => m.key === 'seller_name');
  assert.strictEqual(row.status, 'ok', 'the Seller row is clean on a properly connected wholesale deal');
  const flipCell = row.cells.find((c) => c.source === 'c2');
  assert.strictEqual(flipCell.status, 'agree', "the flip contract's seller agrees with the flipper");
  assert.strictEqual(flipCell.role, 'flipper', 'the cell says WHICH seller it is talking about');
  assert.strictEqual(row.cells.find((c) => c.source === 't').role, 'original_seller');

  // The SAME file read as a straight purchase still flags it — the tolerance is assignment-only.
  const straight = { app: { property_address: ADDR, is_assignment: false }, vestingName: VEST };
  const toStraight = buildTieout(straight, exts.map((e) => ({ id: e.id, docType: e.doc_type, fields: e.fields })));
  assert.ok(toStraight.discrepancies.some((d) => d.code === 'tieout_seller_name'),
    'on a straight purchase two different sellers are still a mismatch');
}

// ===== 3. The contract selling to us is signed by a stranger → the chain is broken =====
{
  const exts = [
    ext('title', { propertyAddress: ADDR, vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: ['Nobody Holdings LLC'], buyerName: VEST, purchasePrice: 474000 }, 'c2'),
  ];
  const r = buildAssignmentChain(asgCtx(), exts);
  assert.ok(codes(r).includes('asg_flip_seller_not_flipper'), 'a stranger selling to us breaks the chain');
  assert.strictEqual(r.status, 'broken');
  assert.ok(r.findings.every((f) => f.blocksCtc === false), 'every assignment-chain finding is advisory');
  const f = r.findings.find((x) => x.code === 'asg_flip_seller_not_flipper');
  assert.ok(/Nobody Holdings LLC/.test(f.docValue) && new RegExp(FLIPPER).test(f.fileValue),
    'the finding names the party who signed and the party who should have');
  // The stranger IS still a seller mismatch in the matrix — it matches neither body in the chain.
  const to = buildTieout(asgCtx(), exts.map((e) => ({ id: e.id, docType: e.doc_type, fields: e.fields })));
  assert.ok(to.discrepancies.some((d) => d.code === 'tieout_seller_name'),
    'a seller who is nowhere in the chain is still flagged');
}

// ===== 4. The flip amount, DERIVED — the paper states the final price, not the fee =====
{
  // The assignment says the borrower pays 500k over a 438k seller price → a 62k flip, but the file
  // records a 36k fee. Nothing else in the stack compares a derived flip amount.
  const exts = [
    ext('title', { propertyAddress: ADDR, vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { propertyAddress: ADDR, assignorName: FLIPPER, assigneeName: VEST,
      originalPurchasePrice: 438000, totalPriceToAssignee: 500000 }, 'a1'),
  ];
  const r = buildAssignmentChain(asgCtx(), exts);
  assert.ok(codes(r).includes('asg_flip_amount_unreconciled'), 'a derived flip fee that disagrees is flagged');
  const f = r.findings.find((x) => x.code === 'asg_flip_amount_unreconciled');
  assert.strictEqual(f.docValue, '$62,000');
  assert.strictEqual(f.fileValue, '$36,000');

  // The other shape of the owner's rule: the paper states the FEE and the FILE has no fee recorded,
  // so the file's own price jump is what it is checked against.
  const noFee = asgCtx({ assignment_fee: null, purchase_price: 480000 });
  const r2 = buildAssignmentChain(noFee, [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: FLIPPER, assigneeName: VEST, assignmentFee: 36000 }, 'a1'),
  ]);
  assert.ok(codes(r2).includes('asg_flip_amount_unreconciled'),
    "a stated fee against the file's own price jump (42k) is checked even with no fee on file");

  // A STATED fee on both sides is owned by the per-document check + the assignment_fee fact — the
  // chain must not duplicate it.
  const r3 = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: FLIPPER, assigneeName: VEST, originalPurchasePrice: 438000, assignmentFee: 50000 }, 'a1'),
  ]);
  assert.ok(!codes(r3).includes('asg_flip_amount_unreconciled'),
    'a stated fee vs the file fee belongs to the per-document check — never duplicated here');
}

// ===== 5. Leg 1: the seller's own contract price vs the seller price on the file =====
{
  const exts = [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 450000 }, 'c1'),
    ext('purchase_contract', { sellerNames: [FLIPPER], buyerName: VEST, purchasePrice: 474000 }, 'c2'),
  ];
  const r = buildAssignmentChain(asgCtx(), exts);
  assert.deepStrictEqual(codes(r), ['asg_underlying_price_mismatch'],
    "the seller's contract price is checked against the file — and it is the ONLY finding (the flip fee is off purely as a consequence)");
  const f = r.findings[0];
  assert.strictEqual(f.docValue, '$450,000');
  assert.strictEqual(f.fileValue, '$438,000');

  // A STATED underlyingPrice field is owned by purchase-contract-checks → not duplicated here.
  const stated = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 474000,
      isAssignment: true, underlyingPrice: 450000, assignmentFee: 36000 }, 'c1'),
  ]);
  assert.ok(!codes(stated).includes('asg_underlying_price_mismatch'),
    "a stated underlyingPrice field is the contract check's finding, not ours");
}

// ===== 6. Missing paperwork — asked for, never guessed at =====
{
  const noPaper = buildAssignmentChain(asgCtx(), [ext('title', { vestedOwners: [SELLER] }, 't')]);
  assert.ok(codes(noPaper).includes('asg_missing_assignment_paper'), 'a wholesale file with no assignment is flagged');

  const noContract = buildAssignmentChain(asgCtx(), [
    ext('assignment', { assignorName: FLIPPER, assigneeName: VEST, originalPurchasePrice: 438000, assignmentFee: 36000 }, 'a1'),
  ]);
  assert.ok(codes(noContract).includes('asg_missing_underlying_contract'), "the seller's contract is asked for");

  const noAmount = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: FLIPPER, assigneeName: VEST }, 'a1'),
  ]);
  assert.ok(codes(noAmount).includes('asg_flip_amount_unstated'), 'an assignment stating no money is flagged');
  assert.strictEqual(noAmount.findings.find((f) => f.code === 'asg_flip_amount_unstated').severity, 'info');
}

// ===== 7. NEVER FABRICATE =====
{
  // A straight purchase is not an assignment chain at all.
  const straight = buildAssignmentChain({ app: { property_address: ADDR, is_assignment: false }, vestingName: VEST },
    [ext('purchase_contract', { sellerNames: [SELLER], buyerName: VEST, purchasePrice: 438000 }, 'c1')]);
  assert.strictEqual(straight.status, 'not_assignment');
  assert.deepStrictEqual(codes(straight), [], 'a straight purchase raises nothing');

  // Nothing at all → no findings, no throw.
  assert.deepStrictEqual(codes(buildAssignmentChain({}, [])), []);
  assert.deepStrictEqual(codes(buildAssignmentChain(null, null)), []);

  // Nothing PROVES a middle party → no role is guessed, and the seller comparison is untouched.
  const unproven = buildAssignmentChain(asgCtx(), [
    ext('purchase_contract', { sellerNames: ['Someone LLC'], buyerName: 'Someone Else LLC', purchasePrice: 999000 }, 'c1'),
    ext('assignment', { assigneeName: VEST, originalPurchasePrice: 438000, assignmentFee: 36000 }, 'a1'),
  ]);
  assert.deepStrictEqual(unproven.parties.flipper, [], 'no assignor and no record owner → no flipper is invented');
  assert.strictEqual(unproven.sellerRoleBySource.c1, 'origin', 'an unproven seller stays the original seller');

  // A borrower buying in their own name is not their own middleman.
  const personal = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: 'Moshe Spitzer', purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: 'Moshe Spitzer', assigneeName: VEST, originalPurchasePrice: 438000, assignmentFee: 36000 }, 'a1'),
  ]);
  assert.deepStrictEqual(personal.parties.flipper, [], 'the borrower personally is never read as the flipper');

  // A "fee" that is really the whole price is quarantined, not used as the flip amount.
  const mislabeled = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: FLIPPER, assigneeName: VEST, originalPurchasePrice: 438000,
      assignmentFee: 474000, totalPriceToAssignee: 474000 }, 'a1'),
  ]);
  assert.strictEqual(mislabeled.money.documents.fee, null, 'a "fee" equal to the total is quarantined');
  assert.strictEqual(mislabeled.money.documents.flip, 36000, 'the flip amount falls back to total − seller price');
  assert.ok(!codes(mislabeled).includes('asg_flip_amount_unreconciled'), 'and no false mismatch comes of it');
}

// ===== 8. ONLY THE ODD ONE OUT — the majority rule that ended the all-red row =====
{
  const many = [
    ext('title', { propertyAddress: ADDR, vestedOwners: [SELLER] }, 't1'),
    ext('title', { propertyAddress: ADDR, vestedOwners: [SELLER] }, 't2'),
    ext('title', { propertyAddress: ADDR, vestedOwners: ['Ocean 100 Delaware LLC'] }, 't3'),
    ext('purchase_contract', { propertyAddress: ADDR, sellerNames: [SELLER], purchasePrice: 438000 }, 'c1'),
  ];
  const straightCtx = { app: { property_address: ADDR, is_assignment: false }, vestingName: VEST };
  const to = buildTieout(straightCtx, many.map((e) => ({ id: e.id, docType: e.doc_type, fields: e.fields })));
  const row = to.matrix.find((m) => m.key === 'seller_name');
  assert.strictEqual(row.status, 'mismatch', 'a real disagreement still turns the row red');
  assert.strictEqual(row.cells.filter((c) => c.status === 'disagree').length, 1, 'ONLY the odd document out is marked');
  assert.strictEqual(row.cells.find((c) => c.source === 't3').status, 'disagree');
  assert.strictEqual(row.cells.find((c) => c.source === 't1').status, 'agree', 'the documents that agree read as agreeing');
  const d = to.discrepancies.find((x) => x.code === 'tieout_seller_name');
  assert.ok(d, 'the disagreement is still a finding');
  assert.ok(/Ocean 100/.test(d.docValue) && !new RegExp(SELLER).test(d.docValue),
    'the finding names only the document that disagrees');
  assert.strictEqual(d.sources.filter((s) => s.agrees).length, 3, 'the agreeing side rides along for the comparison');

  // A genuine TIE has no majority to stand on → every claim is named, exactly as before.
  const tie = buildTieout(straightCtx, [
    { id: 'a', docType: 'title', fields: { vestedOwners: [SELLER] } },
    { id: 'b', docType: 'purchase_contract', fields: { sellerNames: ['Someone Else LLC'] } },
  ]);
  const tieRow = tie.matrix.find((m) => m.key === 'seller_name');
  assert.strictEqual(tieRow.cells.filter((c) => c.status === 'disagree').length, 2, 'a 1-vs-1 tie flags both');
  assert.ok(tie.discrepancies.some((x) => x.code === 'tieout_seller_name'));

  // A majority the OTHER values can't be judged against is no majority at all — otherwise the row
  // would name nobody and a real conflict between two minority values would go unreported. Here two
  // documents say POL-123, one says POL-999, and one is unreadable (uncomparable, not a mismatch),
  // so there is nothing to measure the minority against → everything is flagged, as it always was.
  const unjudgeable = buildTieout({ app: {} }, [
    { id: 'i1', docType: 'insurance', fields: { policyNumber: 'POL-123' } },
    { id: 'i2', docType: 'insurance', fields: { policyNumber: 'POL-123' } },
    { id: 'i3', docType: 'insurance_invoice', fields: { policyNumber: 'POL-999' } },
    { id: 'i4', docType: 'insurance_invoice', fields: { policyNumber: '###' } },
  ]);
  const uRow = unjudgeable.matrix.find((m) => m.key === 'policy_number');
  assert.strictEqual(uRow.cells.filter((c) => c.status === 'disagree').length, 4,
    'a majority that cannot be judged against every other value falls back to flagging them all');
  assert.ok(unjudgeable.discrepancies.some((x) => x.code === 'tieout_policy_number'),
    'and the discrepancy still fires — the gate never gets quieter than it was');
}

// ===== 9. The card never claims "intact" while the documents are still arguing =====
{
  const disputed = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't1'),
    ext('title', { vestedOwners: [FLIPPER] }, 't2'),          // a second title naming someone else
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: FLIPPER, assigneeName: VEST, sellerName: SELLER,
      originalPurchasePrice: 438000, assignmentFee: 36000, totalPriceToAssignee: 474000 }, 'a1'),
  ]);
  assert.strictEqual(disputed.parties.ownerOfRecordDisputed, true, 'two title reports naming different owners is a dispute');
  assert.strictEqual(disputed.status, 'incomplete', 'a disputed original seller can never read as an intact chain');
  assert.deepStrictEqual(codes(disputed), [], 'but the seller mismatch itself stays the tie-out’s finding — no duplicate here');

  // The chain also stops short of "intact" when it does not end at the vesting entity — the borrower
  // buying in their own name. That FINDING belongs to seller-chain / chain-of-title, not here.
  const personal = buildAssignmentChain(asgCtx(), [
    ext('title', { vestedOwners: [SELLER] }, 't1'),
    ext('purchase_contract', { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 }, 'c1'),
    ext('assignment', { assignorName: FLIPPER, assigneeName: 'Moshe Spitzer', sellerName: SELLER,
      originalPurchasePrice: 438000, assignmentFee: 36000, totalPriceToAssignee: 474000 }, 'a1'),
  ]);
  assert.strictEqual(personal.reachesVesting, false);
  assert.strictEqual(personal.status, 'incomplete');
  assert.deepStrictEqual(codes(personal), [], 'the personal-name case belongs to seller-chain — never re-raised here');
}

// ===== 10. The role map is keyed on the SAME source ids the matrix columns use =====
// buildTieout falls back to `${docType}_${i}` for a source with no id, and the chain has to compute
// the identical key or every role lookup silently misses and the whole feature no-ops.
{
  const noIds = [
    { docType: 'title', fields: { vestedOwners: [SELLER] } },
    { docType: 'purchase_contract', fields: { sellerNames: [SELLER], buyerName: FLIPPER, purchasePrice: 438000 } },
    { docType: 'purchase_contract', fields: { sellerNames: [FLIPPER], buyerName: VEST, purchasePrice: 474000 } },
  ];
  const row = buildTieout(asgCtx(), noIds).matrix.find((m) => m.key === 'seller_name');
  assert.ok(row.cells.some((c) => c.role === 'flipper'), 'a source with no id still resolves its seller role');
  assert.strictEqual(row.status, 'ok');
}

console.log('✓ test-assignment-chain: seller → flipper → end buyer, both legs of paper, the money closing, and only the odd document out');
