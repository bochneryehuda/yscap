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

// ---- Insurance ----
const insGood = { namedInsured: 'Maple LLC', dwellingCoverage: 400000, policyEffective: '2026-06-01', policyExpiration: '2027-06-01', mortgageeClausePresent: true, readable: true };
assert.deepStrictEqual(codes(C.computeInsuranceFindings(insGood, { loan_amount: 300000 }, { today: TODAY })), []);
assert.strictEqual(C.computeInsuranceFindings({ ...insGood, mortgageeClausePresent: false }, { loan_amount: 300000 }, { today: TODAY }).find((f) => f.code === 'insurance_no_mortgagee').severity, 'fatal');
assert.ok(C.computeInsuranceFindings({ ...insGood, dwellingCoverage: 250000 }, { loan_amount: 300000 }, { today: TODAY }).some((f) => f.code === 'insurance_underinsured'));
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

console.log('✓ test-underwriting-docchecks: assignment, entity chain, insurance, flood, settlement, credit, OFAC pass');
