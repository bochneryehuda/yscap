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
// Freshness (Group B): a valid-through date expiring within 30 days → warning; already past → fatal.
{
  const soon = C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Active', issueDate: '2026-07-15', expirationDate: '2026-08-10', readable: true }, {}, { today: TODAY });
  assert.strictEqual(soon.find((f) => f.code === 'good_standing_expiring_soon').severity, 'warning', 'expiring within 30 days → warning');
  const past = C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Active', issueDate: '2026-04-01', expirationDate: '2026-07-01', readable: true }, {}, { today: TODAY });
  // An expired CERTIFICATE date is a warning (documentation freshness), not a hard block — the fatal
  // is a genuinely revoked ENTITY (entity_not_in_good_standing). (audit fix 2026-07-20)
  assert.strictEqual(past.find((f) => f.code === 'good_standing_expired').severity, 'warning', 'expired cert date → warning, not fatal');
  const okFar = C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Active', issueDate: '2026-07-01', expirationDate: '2027-07-01', readable: true }, {}, { today: TODAY });
  assert.ok(!okFar.some((f) => /good_standing_expir/.test(f.code)), 'a valid-through date far out → no expiry finding');
}
// Tri-state status (deep-audit regression): recognized good-standing SYNONYMS are clean (no false
// fatal), a clearly-negative status is fatal, and an UNRECOGNIZED word is a warning (not a fatal).
for (const ok of ['Subsisting', 'Current', 'Valid', 'In Existence', 'Registered', 'Good Standing']) {
  assert.deepStrictEqual(codes(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: ok, issueDate: '2026-07-01', readable: true }, {}, { today: TODAY })), [],
    `"${ok}" must be treated as good standing (no finding)`);
}
for (const bad of ['Dissolved', 'Suspended', 'Forfeited', 'Not in Good Standing', 'Void', 'Not in Existence']) {
  assert.strictEqual(C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: bad, readable: true }, {}, { today: TODAY }).find((f) => f.code === 'entity_not_in_good_standing').severity, 'fatal',
    `"${bad}" must be a fatal not-in-good-standing`);
}
{
  const unk = C.computeGoodStandingFindings({ entityLegalName: 'Maple LLC', status: 'Pending Review', issueDate: '2026-07-01', readable: true }, {}, { today: TODAY });
  assert.strictEqual(unk.find((f) => f.code === 'entity_status_unrecognized').severity, 'warning', 'an unrecognized status is a WARNING, not a false fatal');
  assert.ok(!unk.some((f) => f.code === 'entity_not_in_good_standing'), 'an unrecognized status is not a fatal');
}

// ---- Credit: middle score vs the priced FICO (Group C) ----
assert.deepStrictEqual(codes(C.computeCreditFindings({ subjectName: 'A B', ficoScore: 720, readable: true }, { registered_fico: 700 }, {})), [], 'actual score above the priced FICO is clean');
{
  const low = C.computeCreditFindings({ subjectName: 'A B', ficoScore: 675, readable: true }, { registered_fico: 700 }, {}).find((f) => f.code === 'credit_score_below_priced');
  assert.ok(low && low.severity === 'warning', 'actual middle score below the priced FICO -> re-register warning');
}
assert.deepStrictEqual(codes(C.computeCreditFindings({ subjectName: 'A B', ficoScore: 699, readable: true }, { registered_fico: 700 }, {})), [], 'a 1-2 pt drop is ignored');
// Tri-merge: the REPRESENTATIVE score is the MIDDLE of three / LOWER of two (owner "middle score" rule).
{
  assert.strictEqual(C.representativeFico({ ficoTransunion: 680, ficoExperian: 710, ficoEquifax: 700 }), 700, 'middle of three');
  assert.strictEqual(C.representativeFico({ ficoTransunion: 720, ficoEquifax: 700 }), 700, 'lower of two');
  assert.strictEqual(C.representativeFico({ ficoExperian: 715 }), 715, 'single bureau');
  assert.strictEqual(C.representativeFico({ ficoScore: 690 }), 690, 'falls back to a stated representative score');
  // The MIDDLE (not the high) is compared to the priced FICO: 680/700/710 → 700, priced 705 → flagged.
  assert.ok(C.computeCreditFindings({ readable: true, subjectName: 'A B', ficoTransunion: 680, ficoExperian: 710, ficoEquifax: 700 }, { registered_fico: 705 }, {}).some((f) => f.code === 'credit_score_below_priced'));
  // A high bureau score can't mask a low middle: 620/625/790 → middle 625 < 700 → flagged.
  assert.ok(C.computeCreditFindings({ readable: true, subjectName: 'A B', ficoTransunion: 620, ficoExperian: 790, ficoEquifax: 625 }, { registered_fico: 700 }, {}).some((f) => f.code === 'credit_score_below_priced'));
  // Middle above the priced score → clean.
  assert.deepStrictEqual(codes(C.computeCreditFindings({ readable: true, subjectName: 'A B', ficoTransunion: 740, ficoExperian: 760, ficoEquifax: 750 }, { registered_fico: 700 }, {})), []);
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
// Builders-risk (Group B): a rehab deal (file has a rehab budget) whose policy isn't builders-risk → warning.
{
  const sub = { loan_amount: 300000, rehab_budget: 85000 };
  const noBr = C.computeInsuranceFindings({ ...insGood, buildersRisk: false }, sub, { today: TODAY }).find((f) => f.code === 'insurance_no_builders_risk');
  assert.ok(noBr && noBr.severity === 'warning', 'a rehab deal on a non-builders-risk policy is flagged');
  const withBr = C.computeInsuranceFindings({ ...insGood, buildersRisk: true }, sub, { today: TODAY });
  assert.ok(!withBr.some((f) => f.code === 'insurance_no_builders_risk'), 'a builders-risk policy on a rehab deal is clean');
  const noRehab = C.computeInsuranceFindings({ ...insGood, buildersRisk: false }, { loan_amount: 300000 }, { today: TODAY });
  assert.ok(!noRehab.some((f) => f.code === 'insurance_no_builders_risk'), 'no rehab budget → builders-risk not required');
}
assert.ok(C.computeInsuranceFindings({ ...insGood, policyExpiration: '2026-01-01' }, { loan_amount: 300000 }, { today: TODAY }).some((f) => f.code === 'insurance_expired'));
// Mortgagee-clause TEXT + loan number must be the lender's (owner-directed 2026-07-20).
{
  const { LENDER_MORTGAGEE_CLAUSE } = require('../src/lib/underwriting/lender');
  const sub = { loan_amount: 300000, loan_number: 'YS-2026-0345' };
  // A clause present but naming a different lender → warning (distinct from the fatal "no clause").
  const wrong = C.computeInsuranceFindings({ ...insGood, mortgageeClause: 'Wells Fargo ISAOA/ATIMA', loanNumber: 'ZZ-1' }, sub, { today: TODAY });
  assert.ok(wrong.some((f) => f.code === 'insurance_wrong_mortgagee' && f.severity === 'warning'));
  assert.ok(wrong.some((f) => f.code === 'insurance_loan_number_mismatch'));
  assert.ok(!wrong.some((f) => f.code === 'insurance_no_mortgagee'), 'a present-but-wrong clause is not the fatal no-clause case');
  // The exact lender clause + matching loan number (formatting-insensitive) → clean.
  const right = C.computeInsuranceFindings({ ...insGood, mortgageeClause: LENDER_MORTGAGEE_CLAUSE, loanNumber: 'YS 2026 0345' }, sub, { today: TODAY });
  assert.deepStrictEqual(codes(right), [], 'correct clause + loan number → clean');
  // An unread clause (null) never false-accuses.
  assert.ok(!C.computeInsuranceFindings({ ...insGood, mortgageeClause: null }, sub, { today: TODAY }).some((f) => /mortgagee/.test(f.code)));
}

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
// Screen must be run on OUR borrower + entity, and high fraud alerts must be cleared (owner-directed).
{
  const subj = { borrower_name: 'Michael Goldberg', entity_name: 'Maple Grove Holdings LLC' };
  // Right party, entity screened, no alerts → clean (only OFAC clear).
  assert.deepStrictEqual(codes(C.computeBackgroundFindings({ readable: true, subjectName: 'Michael Goldberg', ofacResult: 'clear', entityName: 'Maple Grove Holdings LLC', fraudFlags: [], pepHit: false }, subj)), []);
  // Wrong subject name → the clear result can't be trusted for this borrower.
  assert.ok(C.computeBackgroundFindings({ readable: true, subjectName: 'Michael Goldman', ofacResult: 'clear' }, subj).some((f) => f.code === 'background_subject_mismatch'));
  // Entity deal but no entity screened → flagged.
  assert.ok(C.computeBackgroundFindings({ readable: true, subjectName: 'Michael Goldberg', ofacResult: 'clear', entityName: null }, subj).some((f) => f.code === 'background_entity_not_screened'));
  // Entity screened but a DIFFERENT entity → flagged.
  assert.ok(C.computeBackgroundFindings({ readable: true, subjectName: 'Michael Goldberg', ofacResult: 'clear', entityName: 'Other Holdings LLC' }, subj).some((f) => f.code === 'background_entity_mismatch'));
  // High fraud alerts + PEP → both surface, both warning (never a silent accept).
  const f = C.computeBackgroundFindings({ readable: true, subjectName: 'Michael Goldberg', ofacResult: 'clear', entityName: 'Maple Grove Holdings LLC', fraudFlags: ['SSN issued after DOB', 'Known mail-drop address'], pepHit: true }, subj);
  assert.ok(f.some((x) => x.code === 'background_fraud_alerts' && x.severity === 'warning'));
  assert.ok(f.some((x) => x.code === 'background_pep'));
  // An individual (no entity on file) is never asked for an entity screen.
  assert.ok(!C.computeBackgroundFindings({ readable: true, subjectName: 'Michael Goldberg', ofacResult: 'clear' }, { borrower_name: 'Michael Goldberg' }).some((x) => /entity/.test(x.code)));
}

// ===== PAYOFF STATEMENT (the lien being refinanced) =====
{
  const subj = { property_address: { line1: '128 Elm St', city: 'Lakewood', state: 'NJ', zip: '08701' }, loan_amount: 200000, loan_type: 'Refi R&T' };
  const good = { readable: true, servicerName: 'Fay', totalPayoffAmount: 180000, goodThroughDate: '2026-08-15', propertyAddress: subj.property_address };
  // Clean, valid, under the loan → nothing.
  assert.deepStrictEqual(codes(C.computePayoffFindings(good, subj, { today: '2026-07-20' })), []);
  // Wrong property → FATAL (funding would clear the wrong lien), blocks CTC.
  {
    const wp = C.computePayoffFindings({ ...good, propertyAddress: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' } }, subj, { today: '2026-07-20' }).find((f) => f.code === 'payoff_address_mismatch');
    assert.ok(wp && wp.severity === 'fatal' && wp.blocksCtc === true, 'a wrong-property payoff is a fatal dealbreaker');
  }
  // Expired good-through date → warning; near-expiry (within 5 days) → info.
  assert.ok(C.computePayoffFindings({ ...good, goodThroughDate: '2026-07-10' }, subj, { today: '2026-07-20' }).some((f) => f.code === 'payoff_expired' && f.severity === 'warning'));
  assert.ok(C.computePayoffFindings({ ...good, goodThroughDate: '2026-07-22' }, subj, { today: '2026-07-20' }).some((f) => f.code === 'payoff_expiring_soon' && f.severity === 'info'));
  // Payoff larger than the new loan → info (rate/term refi needs cash to close).
  assert.ok(C.computePayoffFindings({ ...good, totalPayoffAmount: 230000 }, subj, { today: '2026-07-20' }).some((f) => f.code === 'payoff_exceeds_loan' && f.severity === 'info'));
  // Unreadable → a single verify finding, no false mismatches.
  assert.deepStrictEqual(codes(C.computePayoffFindings({ readable: false }, subj, { today: '2026-07-20' })), ['payoff_statement_unreadable']);
}

// ===== VOIDED CHECK / wire instructions (borrower disbursement account) =====
{
  const subj = { borrower_name: 'Michael Goldberg', entity_names: ['Maple Grove Holdings LLC'] };
  // Borrower's own account, valid routing + account → clean.
  assert.deepStrictEqual(codes(C.computeVoidedCheckFindings({ readable: true, accountHolderName: 'Michael Goldberg', routingNumber: '021000021', accountNumber: '6789' }, subj, {})), []);
  // The vesting entity's account is also fine.
  assert.deepStrictEqual(codes(C.computeVoidedCheckFindings({ readable: true, accountHolderName: 'Maple Grove Holdings LLC', holderIsBusiness: true, routingNumber: '021000021', accountNumber: '1234' }, subj, {})), []);
  // A third-party account → holder-mismatch (source-of-funds flag).
  assert.ok(C.computeVoidedCheckFindings({ readable: true, accountHolderName: 'Some Stranger', routingNumber: '021000021', accountNumber: '1' }, subj, {}).some((f) => f.code === 'voided_check_holder_mismatch'));
  // A malformed routing number and a missing account each flag.
  const bad = C.computeVoidedCheckFindings({ readable: true, accountHolderName: 'Michael Goldberg', routingNumber: '12345', accountNumber: null }, subj, {});
  assert.ok(bad.some((f) => f.code === 'voided_check_bad_routing'));
  assert.ok(bad.some((f) => f.code === 'voided_check_no_account'));
  // A MISSING routing number (not just malformed) is flagged too — you can't wire without it (audit MINOR).
  assert.ok(C.computeVoidedCheckFindings({ readable: true, accountHolderName: 'Michael Goldberg', routingNumber: null, accountNumber: '6789' }, subj, {}).some((f) => f.code === 'voided_check_no_routing'));
  // Unreadable → single verify finding.
  assert.deepStrictEqual(codes(C.computeVoidedCheckFindings({ readable: false }, subj, {})), ['voided_check_unreadable']);
}

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
