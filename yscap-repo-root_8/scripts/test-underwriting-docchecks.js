'use strict';
/**
 * Unit tests for the expanded per-document checks (doc-checks.js). Pure — no DB.
 */
const assert = require('assert');
const C = require('../src/lib/underwriting/doc-checks');
const codes = (fs) => fs.map((f) => f.code).sort();
const TODAY = '2026-07-20';

// ---- Assignment ----
assert.deepStrictEqual(codes(C.computeAssignmentFindings({ assigneeName: 'Maple LLC', originalPurchasePrice: 100000, assignmentFee: 15000, totalPriceToAssignee: 115000, assignorSigned: true, assigneeSigned: true, readable: true })), [], 'clean assignment');
assert.deepStrictEqual(codes(C.computeAssignmentFindings({ assigneeName: 'Maple LLC', originalPurchasePrice: 100000, assignmentFee: 25000, totalPriceToAssignee: 130000, assignorSigned: true, assigneeSigned: true, readable: true })), ['assignment_fee_over_cap', 'assignment_math_inconsistent']);
assert.strictEqual(C.computeAssignmentFindings({ assigneeName: 'Maple LLC', originalPurchasePrice: 100000, assignmentFee: 10000, totalPriceToAssignee: 110000, assignorSigned: true, assigneeSigned: false, readable: true }).find((f) => f.code === 'assignment_unsigned').severity, 'fatal');
assert.deepStrictEqual(codes(C.computeAssignmentFindings({ readable: false })), ['assignment_unreadable']);

// ---- Operating agreement (control prong) ----
const oaGood = { entityLegalName: 'Maple Grove Holdings LLC', managingMember: 'John Smith', members: [{ name: 'John Smith', ownershipPct: 100, isManager: true }], authorizesBorrowing: true, signed: true, readable: true };
assert.deepStrictEqual(codes(C.computeOperatingAgreementFindings(oaGood, { borrower_name: 'John Smith' })), [], 'clean OA');
assert.deepStrictEqual(codes(C.computeOperatingAgreementFindings({ ...oaGood, members: [{ name: 'A', ownershipPct: 40 }, { name: 'B', ownershipPct: 40 }] }, { borrower_name: 'John Smith' })), ['oa_ownership_not_100']);
assert.strictEqual(C.computeOperatingAgreementFindings({ ...oaGood, signed: false }, {}).find((f) => f.code === 'oa_unsigned').severity, 'fatal');
assert.ok(C.computeOperatingAgreementFindings({ ...oaGood, managingMember: 'Robert Jones' }, { borrower_name: 'John Smith' }).some((f) => f.code === 'oa_signer_not_borrower'));

// ---- EIN ----
assert.deepStrictEqual(codes(C.computeEinFindings({ ein: '12-3456789', entityLegalName: 'Maple LLC', readable: true })), []);
assert.deepStrictEqual(codes(C.computeEinFindings({ ein: '123', entityLegalName: 'Maple LLC', readable: true })), ['ein_format_invalid']);

// ---- Good standing ----
assert.deepStrictEqual(codes(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Active', issueDate: '2026-07-01', readable: true }, {}, { today: TODAY })), []);
assert.strictEqual(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Revoked', readable: true }, {}, { today: TODAY }).find((f) => f.code === 'entity_not_in_good_standing').severity, 'fatal');
assert.ok(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'active', issueDate: '2026-01-01', readable: true }, {}, { today: TODAY }).some((f) => f.code === 'good_standing_stale'));
// Tri-state status (deep-audit regression): recognized good-standing SYNONYMS are clean (no false
// fatal), a clearly-negative status is fatal, and an UNRECOGNIZED word is a warning (not a fatal).
for (const ok of ['Subsisting', 'Current', 'Valid', 'In Existence', 'Registered', 'Good Standing']) {
  assert.deepStrictEqual(codes(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: ok, issueDate: '2026-07-01', readable: true }, {}, { today: TODAY })), [],
    `"${ok}" must be treated as good standing (no finding)`);
}
for (const bad of ['Dissolved', 'Suspended', 'Forfeited', 'Not in Good Standing', 'Void']) {
  assert.strictEqual(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: bad, readable: true }, {}, { today: TODAY }).find((f) => f.code === 'entity_not_in_good_standing').severity, 'fatal',
    `"${bad}" must be a fatal not-in-good-standing`);
}
{
  const unk = C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Pending Review', issueDate: '2026-07-01', readable: true }, {}, { today: TODAY });
  assert.strictEqual(unk.find((f) => f.code === 'entity_status_unrecognized').severity, 'warning', 'an unrecognized status is a WARNING, not a false fatal');
  assert.ok(!unk.some((f) => f.code === 'entity_not_in_good_standing'), 'an unrecognized status is not a fatal');
}

// ---- Insurance ----
const insGood = { namedInsured: 'Maple LLC', dwellingCoverage: 400000, policyEffective: '2026-06-01', policyExpiration: '2027-06-01', mortgageeClausePresent: true, readable: true };
assert.deepStrictEqual(codes(C.computeInsuranceFindings(insGood, { loan_amount: 300000 }, { today: TODAY })), []);
assert.strictEqual(C.computeInsuranceFindings({ ...insGood, mortgageeClausePresent: false }, { loan_amount: 300000 }, { today: TODAY }).find((f) => f.code === 'insurance_no_mortgagee').severity, 'fatal');
{
  // Under-coverage is a WARNING (not a hard block): on a rehab loan the requirement is replacement
  // cost, not the full loan — surface for review, don't false-block (deep-audit 2026-07-20).
  const uf = C.computeInsuranceFindings({ ...insGood, dwellingCoverage: 250000 }, { loan_amount: 300000 }, { today: TODAY }).find((f) => f.code === 'insurance_underinsured');
  assert.ok(uf, 'under-coverage still surfaces');
  assert.strictEqual(uf.severity, 'warning', 'under-coverage is a warning, not a fatal');
}
assert.ok(C.computeInsuranceFindings({ ...insGood, policyExpiration: '2026-01-01' }, { loan_amount: 300000 }, { today: TODAY }).some((f) => f.code === 'insurance_expired'));

// ---- Flood ----
assert.deepStrictEqual(codes(C.computeFloodFindings({ floodZone: 'X', inSfha: false, readable: true }, {})), []);
assert.strictEqual(C.computeFloodFindings({ floodZone: 'AE', inSfha: true, policyPresent: false, readable: true }, {}).find((f) => f.code === 'flood_insurance_required').severity, 'fatal');
assert.deepStrictEqual(codes(C.computeFloodFindings({ floodZone: 'AE', inSfha: true, policyPresent: true, readable: true }, {})), []);

// ---- Settlement ----
assert.deepStrictEqual(codes(C.computeSettlementFindings({ contractSalesPrice: 400000, loanAmount: 300000, totalSources: 410000, totalUses: 410000, readable: true }, {})), []);
assert.ok(C.computeSettlementFindings({ contractSalesPrice: 400000, loanAmount: 300000, totalSources: 410000, totalUses: 405000, readable: true }, {}).some((f) => f.code === 'settlement_unbalanced'));
assert.strictEqual(C.computeSettlementFindings({ contractSalesPrice: 400000, loanAmount: 300000, totalSources: 410000, totalUses: 410000, cashBackToBorrower: 20000, readable: true }, {}).find((f) => f.code === 'settlement_cash_back').severity, 'fatal');

// ---- Credit ----
assert.deepStrictEqual(codes(C.computeCreditFindings({ subjectName: 'John Smith', ficoScore: 720, readable: true }, {})), []);
assert.ok(C.computeCreditFindings({ subjectName: 'John Smith', ficoScore: 640, hasBankruptcy: true, readable: true }, {}).some((f) => f.code === 'credit_major_derogatory'));

// ---- Background / OFAC ----
assert.deepStrictEqual(codes(C.computeBackgroundFindings({ subjectName: 'John Smith', ofacResult: 'clear', readable: true }, {})), []);
assert.strictEqual(C.computeBackgroundFindings({ subjectName: 'John Smith', ofacResult: 'confirmed_match', readable: true }, {}).find((f) => f.code === 'ofac_confirmed_match').severity, 'fatal');
assert.deepStrictEqual(codes(C.computeBackgroundFindings({ subjectName: 'John Smith', ofacResult: 'potential_match', readable: true }, {})), ['ofac_potential_match']);

// ===== SCOPE OF WORK / rehab budget =====
{
  const codes = (fs) => fs.map((f) => f.code).sort();
  // Doc total matches the file rehab budget → clean.
  assert.deepStrictEqual(codes(C.computeScopeOfWorkFindings(
    { totalBudget: 60000, lineItemCount: 12, contractorName: 'Acme Rehab', readable: true }, { rehab_budget: 60000 })), [], 'matching rehab budget → clean');
  // Doc total differs from the file → rehab_budget_mismatch (warning).
  {
    const f = C.computeScopeOfWorkFindings({ totalBudget: 85000, lineItemCount: 12, contractorName: 'Acme Rehab', readable: true }, { rehab_budget: 60000 });
    assert.deepStrictEqual(codes(f), ['rehab_budget_mismatch']);
    assert.strictEqual(f[0].severity, 'warning');
    assert.strictEqual(f[0].blocksCtc, false);
  }
  // The SOW states a budget but the file has none set (null OR 0) → prompt to enter it.
  assert.deepStrictEqual(codes(C.computeScopeOfWorkFindings({ totalBudget: 85000, lineItemCount: 12, contractorName: 'Acme', readable: true }, {})), ['rehab_budget_not_on_file'], 'SOW budget but no file budget → prompt to set it');
  assert.deepStrictEqual(codes(C.computeScopeOfWorkFindings({ totalBudget: 85000, readable: true }, { rehab_budget: 0 })), ['rehab_budget_not_on_file'], 'file rehab_budget 0 (unset) is not treated as a real 0');
  // A SOW with no total → nothing to compare, no flag (never guesses).
  assert.deepStrictEqual(codes(C.computeScopeOfWorkFindings({ totalBudget: null, lineItemCount: 5, contractorName: 'Acme', readable: true }, { rehab_budget: 60000 })), [], 'no SOW total → no flag');
  // Unreadable → routes to manual review, never a false mismatch.
  assert.deepStrictEqual(codes(C.computeScopeOfWorkFindings({ readable: false }, { rehab_budget: 60000 })), ['scope_of_work_unreadable']);
}

console.log('✓ test-underwriting-docchecks: assignment, entity chain, insurance, flood, settlement, credit, OFAC, scope-of-work pass');
