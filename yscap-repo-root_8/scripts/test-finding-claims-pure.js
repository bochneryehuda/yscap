'use strict';
/**
 * ONE finding per real-world issue (owner-reported 2026-07-26 on a live file).
 *
 * The owner counted the contract-buyer/vesting mismatch SIX times on one file, the borrowing-entity
 * OFAC gap three times, and the fraud-alert instruction twice. Root cause: ~11 desks each notice the
 * same fact under their OWN code, and the desk de-duplicated exactly one hard-coded code. These
 * assertions pin the merge so the regression cannot come back quietly.
 *
 * Pure: no DB, no AI, no network.
 */
const R = require('path').resolve(__dirname, '..');
const FC = require(R + '/src/lib/underwriting/finding-claims');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---------- the six-times case, verbatim from the owner's file ----------
// Six desks, six codes, six different `subject` values — one fact: the contract buyer is a person
// and the loan vests into an LLC. Subjects DIFFER on purpose: that is exactly why a code+subject key
// failed to merge them.
const sixDesks = [
  { code: 'contract_buyer_mismatch', severity: 'fatal', subject: 'MW TRADING LLC',
    explanation: 'The contract must name the borrowing entity as the buyer.', document_id: 'doc-contract' },
  { code: 'cot_final_buyer_not_vesting', severity: 'warning', subject: 'Moshe Weil',
    explanation: 'The purchase chain ends at Moshe Weil but the loan vests into MW TRADING LLC.' },
  { code: 'chain_vesting_not_reached', severity: 'info', subject: 'Moshe Weil',
    explanation: 'The purchase chain does not clearly reach the vesting entity.' },
  { code: 'chain_vesting_vs_contract_buyer', severity: 'warning', subject: 'MW TRADING LLC',
    explanation: 'The vesting entity is not the buyer on the purchase contract.' },
  { code: 'contract_in_personal_name', severity: 'warning', subject: 'Moshe Weil',
    explanation: 'The contract is in a personal name.' },
];
const merged = FC.dedupeByClaim(sixDesks);
ok(merged.length === 1, `the vesting/buyer mismatch collapses to ONE finding (got ${merged.length})`);
ok(merged[0].code === 'contract_buyer_mismatch', 'the FATAL one survives as the representative');
ok(Array.isArray(merged[0].mergedFrom) && merged[0].mergedFrom.length === 4,
  `every other desk that agreed is recorded (mergedFrom=${JSON.stringify(merged[0] && merged[0].mergedFrom)})`);
ok(!merged[0].mergedFrom.includes('contract_buyer_mismatch'), 'the survivor is not listed as merged into itself');

// The old key would NOT have merged these — proves the test is testing the real change.
const distinctOldKeys = new Set(sixDesks.map((f) => `${f.code}::${f.subject}`));
ok(distinctOldKeys.size === 5, 'under the old code+subject key these were 5 separate findings');

// ---------- entity OFAC screening (seen 3×) ----------
const ofac = FC.dedupeByClaim([
  { code: 'background_entity_not_screened', severity: 'warning', subject: 'MW TRADING LLC' },
  { code: 'entity_not_screened', severity: 'warning', subject: 'MW TRADING LLC' },
  { code: 'background_entity_not_screened', severity: 'warning', subject: 'MW TRADING LLC' },
]);
ok(ofac.length === 1, `the borrowing-entity screening gap shows once (got ${ofac.length})`);

// ---------- fraud alerts: one report, several alert batches ----------
const fraud = FC.dedupeByClaim([
  { code: 'background_fraud_alerts', severity: 'warning', subject: 'POTENTIAL STRAW BUYER ISSUE' },
  { code: 'background_fraud_alerts', severity: 'warning', subject: 'NO SSN WAS SUBMITTED' },
]);
ok(fraud.length === 1, `fraud alerts on one report are one item of work (got ${fraud.length})`);

// ---------- pre-existing behaviour preserved ----------
const fee = FC.dedupeByClaim([
  { code: 'assignment_fee_over_cap', severity: 'warning', subject: 'contract' },
  { code: 'assignment_fee_over_cap', severity: 'warning', subject: 'assignment' },
]);
ok(fee.length === 1, 'assignment fee over cap still shows once (the old DEDUP_ONCE behaviour)');

// ---------- and the far more important half: it must NOT over-merge ----------
const unrelated = FC.dedupeByClaim([
  { code: 'title_policy_amount_low', severity: 'warning', subject: 'title' },
  { code: 'insurance_mortgagee_address', severity: 'info', subject: 'insurance' },
  { code: 'title_mortgagee_address', severity: 'info', subject: 'title' },
  { code: 'identity_name_variation', severity: 'warning', subject: 'borrower' },
]);
ok(unrelated.length === 4, `four genuinely different issues stay four (got ${unrelated.length})`);

// The SAME code about DIFFERENT subjects is still two findings when it is not in a family — a
// per-document check that legitimately fires on two documents must not be silently halved.
const perDoc = FC.dedupeByClaim([
  { code: 'doc_low_authenticity', severity: 'warning', subject: 'insurance' },
  { code: 'doc_low_authenticity', severity: 'warning', subject: 'title' },
]);
ok(perDoc.length === 2, `an un-familied code on two subjects stays two (got ${perDoc.length})`);

// ---------- survivor selection ----------
const richer = FC.dedupeByClaim([
  { code: 'entity_not_screened', severity: 'warning', subject: 'x', explanation: 'short' },
  { code: 'background_entity_not_screened', severity: 'warning', subject: 'x',
    explanation: 'A much longer explanation that actually tells the underwriter what to do next.' },
]);
ok(/much longer/.test(richer[0].explanation || ''),
  'at equal severity the better-explained finding survives (thin reasoning was the owner\'s complaint)');

// ---------- order + robustness ----------
const ordered = FC.dedupeByClaim([
  { code: 'title_policy_amount_low', severity: 'warning', subject: 't' },
  { code: 'contract_buyer_mismatch', severity: 'fatal', subject: 'a' },
  { code: 'cot_final_buyer_not_vesting', severity: 'warning', subject: 'b' },
  { code: 'identity_name_variation', severity: 'warning', subject: 'n' },
]);
ok(ordered.length === 3 && ordered[0].code === 'title_policy_amount_low',
  'first-appearance order is preserved (the caller sorts by severity later)');

ok(FC.dedupeByClaim([]).length === 0, 'empty input → empty output');
ok(FC.dedupeByClaim(null).length === 0, 'null input → empty output, no throw');
const withJunk = FC.dedupeByClaim([null, { severity: 'warning' }, { code: 'title_policy_amount_low' }]);
ok(withJunk.length === 3, `null / code-less findings pass through untouched (got ${withJunk.length})`);

console.log(`test-finding-claims-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
