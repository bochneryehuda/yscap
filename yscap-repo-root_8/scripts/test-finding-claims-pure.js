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
];
// NOTE: `contract_in_personal_name` is deliberately NOT in this list — see the family comment in
// finding-claims.js. It asserts something adjacent but carries a different remedy (it opens the
// assignment-to-vesting-entity condition), so it is kept separate; that is asserted further down.
const merged = FC.dedupeByClaim(sixDesks);
ok(merged.length === 1, `the vesting/buyer mismatch collapses to ONE finding (got ${merged.length})`);
ok(merged[0].code === 'contract_buyer_mismatch', 'the FATAL one survives as the representative');
ok(Array.isArray(merged[0].mergedFrom) && merged[0].mergedFrom.length === 3,
  `every other desk that agreed is recorded (mergedFrom=${JSON.stringify(merged[0] && merged[0].mergedFrom)})`);
ok(!merged[0].mergedFrom.includes('contract_buyer_mismatch'), 'the survivor is not listed as merged into itself');

// Before this module existed, the call site deduped exactly ONE hard-coded code — so every one of
// these was its own row on the desk. That is the count the owner was staring at.
ok(new Set(sixDesks.map((f) => f.code)).size === sixDesks.length,
  `all ${sixDesks.length} came from DIFFERENT desks under different codes, so nothing merged them before`);

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

// ---------- pre-existing behaviour preserved (REAL row shapes) ----------
// Both producers write PERSISTED document_findings rows on DIFFERENT documents — the purchase
// contract (purchase-contract-checks) and the assignment (doc-checks) — so the fake `subject`
// fixture this used to carry proved nothing. It is one economic truth about the deal restated on
// two documents, and its family is marked fileLevel so it still collapses. Both are non-blocking
// warnings, which is what makes that override safe.
const fee = FC.dedupeByClaim([
  { id: 'fee1', code: 'assignment_fee_over_cap', severity: 'warning', field: 'assignment_fee',
    document_id: 'doc-contract', blocks_ctc: false },
  { id: 'fee2', code: 'assignment_fee_over_cap', severity: 'warning', field: 'assignment_fee',
    document_id: 'doc-assignment', blocks_ctc: false },
]);
ok(fee.length === 1,
  `assignment fee over cap still shows once across both documents (got ${fee.length}) — the old DEDUP_ONCE behaviour`);
ok(fee[0].id, 'and the survivor is a real resolvable row');

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

// ---------- AUDIT 2026-07-26: the fixtures above are NOT what production rows look like ----------
// A stored finding (`document_findings`, db/200) has NO `subject` column, and `field` is a per-code
// CONSTANT. Every assertion above that relies on `subject` to keep findings apart proves nothing
// about the real thing. These use the REAL row shape — id + document_id + field, no subject — and
// they are the ones that matter, because merging two of them is a FALSE CLEAR.
const row = (id, code, severity, documentId, field, extra) =>
  Object.assign({ id, code, severity, document_id: documentId, field, blocks_ctc: severity === 'fatal' }, extra || {});

// Two bank statements, each held by a different non-borrower. Gold requires two months, so this is
// an ordinary file — and both are FATAL, both counted by the clear-to-close gate.
const twoBanks = FC.dedupeByClaim([
  row('f1', 'bank_account_not_borrower', 'fatal', 'doc-stmt-A', 'account_holder'),
  row('f2', 'bank_account_not_borrower', 'fatal', 'doc-stmt-B', 'account_holder'),
]);
ok(twoBanks.length === 2,
  `TWO bank statements with two different non-borrower holders stay TWO fatals (got ${twoBanks.length}) — hiding one is a false clear`);
ok(twoBanks.every((f) => f.id), 'both survivors keep their id, so both can still be resolved on the desk');

// Borrower + co-borrower government IDs, both expired.
const twoIds = FC.dedupeByClaim([
  row('f3', 'id_expired', 'fatal', 'doc-id-borrower', 'expiration'),
  row('f4', 'id_expired', 'fatal', 'doc-id-coborrower', 'expiration'),
]);
ok(twoIds.length === 2, `the borrower's and co-borrower's expired IDs stay two (got ${twoIds.length})`);

// Borrower + co-borrower fraud reports — the family case, and the most safety-critical one to keep.
const twoFraud = FC.dedupeByClaim([
  row('f5', 'background_fraud_alerts', 'warning', 'doc-fraud-borrower', 'alerts'),
  row('f6', 'background_fraud_alerts', 'warning', 'doc-fraud-coborrower', 'alerts'),
]);
ok(twoFraud.length === 2,
  `two background reports' fraud alerts stay two (got ${twoFraud.length}) — a co-borrower's alerts must never be hidden behind the borrower's`);

// Two persisted rows in the SAME family under DIFFERENT codes still never merge — the rule is about
// what is separately resolvable and separately gate-counted, not about the code.
const twoPersistedFamily = FC.dedupeByClaim([
  row('f7', 'contract_buyer_mismatch', 'fatal', 'doc-contract', 'buyer'),
  row('f8', 'cot_final_buyer_not_vesting', 'fatal', 'doc-assignment', 'vesting'),
]);
ok(twoPersistedFamily.length === 2,
  `two PERSISTED findings never merge, even inside one family (got ${twoPersistedFamily.length})`);

// ...but the owner's actual case still collapses: ONE persisted finding + derived restatements of it.
const ownersCase = FC.dedupeByClaim([
  row('f9', 'contract_buyer_mismatch', 'fatal', 'doc-contract', 'buyer'),
  { code: 'cot_final_buyer_not_vesting', severity: 'warning' },   // derived — no id
  { code: 'chain_vesting_not_reached', severity: 'info' },        // derived — no id
  { code: 'chain_vesting_vs_contract_buyer', severity: 'warning' },
]);
ok(ownersCase.length === 1,
  `the owner's real case — one stored finding restated by three live desks — still collapses to ONE (got ${ownersCase.length})`);
ok(ownersCase[0].id === 'f9', 'and the survivor is the PERSISTED one, so it is still resolvable');
ok(ownersCase[0].mergedFrom && ownersCase[0].mergedFrom.length === 3, 'the three desks that agreed are recorded');

// A derived finding must never displace a persisted one, even when it reads better.
const richerDerived = FC.dedupeByClaim([
  row('f10', 'background_entity_not_screened', 'fatal', 'doc-fraud', 'entity'),
  { code: 'entity_not_screened', severity: 'fatal',
    explanation: 'A much longer and more helpful explanation that would otherwise win on length.' },
]);
ok(richerDerived.length === 1 && richerDerived[0].id === 'f10',
  'a better-worded DERIVED finding never displaces the persisted row that carries the id');

// contract_in_personal_name is a DIFFERENT remedy (it opens the assignment-to-vesting condition), so
// it must survive alongside the buyer-mismatch fatal — merging it took that action off the desk.
const personalName = FC.dedupeByClaim([
  row('f11', 'contract_buyer_mismatch', 'fatal', 'doc-contract', 'buyer'),
  { code: 'contract_in_personal_name', severity: 'warning', opensCondition: 'assignment_to_vesting_entity' },
]);
ok(personalName.length === 2,
  `the personal-name finding survives alongside the buyer mismatch (got ${personalName.length}) — it opens a different condition`);
ok(personalName.some((f) => f.opensCondition === 'assignment_to_vesting_entity'),
  'the "post the final-assignment-to-LLC condition" action is still on the desk');

// The SAME check on the SAME document is still one finding (a genuine re-emit is still deduped).
const sameDoc = FC.dedupeByClaim([
  { code: 'doc_low_authenticity', severity: 'warning', document_id: 'doc-x', field: 'authenticity' },
  { code: 'doc_low_authenticity', severity: 'warning', document_id: 'doc-x', field: 'authenticity' },
]);
ok(sameDoc.length === 1, `the same check re-emitted for the same document is still one (got ${sameDoc.length})`);

// ---------- derived findings emitted in a LOOP (audit 2026-07-26) ----------
// Several desks push N findings from one loop — one per LLC member, one per assignment hop — all
// under the SAME code with the same constant `field` and no document id. Keyed on code+field they
// collapsed to one, and because every merged sibling shared the code, `mergedFrom` came out empty:
// the card said nothing at all. Silently hiding beneficial owners is a KYC gap.
const threeOwners = FC.dedupeByClaim([
  { code: 'beneficial_owner_unidentified', severity: 'warning', field: 'ownership', docValue: 'ADAM STERN (34%)' },
  { code: 'beneficial_owner_unidentified', severity: 'warning', field: 'ownership', docValue: 'MOSES WEIL (33%)' },
  { code: 'beneficial_owner_unidentified', severity: 'warning', field: 'ownership', docValue: 'RIVKA GOLD (33%)' },
]);
ok(threeOwners.length === 3,
  `three beneficial owners with no ID on file stay THREE findings (got ${threeOwners.length}) — each is its own KYC gap`);

const twoHops = FC.dedupeByClaim([
  { code: 'cot_assignor_never_held_title', severity: 'warning', field: 'assignor', docValue: 'Assignment 1 — J. Stern' },
  { code: 'cot_assignor_never_held_title', severity: 'warning', field: 'assignor', docValue: 'Assignment 2 — M. Roth' },
]);
ok(twoHops.length === 2,
  `both hops of a two-hop wholesale chain stay two (got ${twoHops.length}) — this is the fraud signature the check exists for`);

// …and a genuine RE-EMIT of the identical finding still collapses, so the merge still does its job.
const reEmit = FC.dedupeByClaim([
  { code: 'beneficial_owner_unidentified', severity: 'warning', field: 'ownership', docValue: 'ADAM STERN (34%)' },
  { code: 'beneficial_owner_unidentified', severity: 'warning', field: 'ownership', docValue: 'ADAM STERN (34%)' },
]);
ok(reEmit.length === 1, `the identical finding raised twice is still one (got ${reEmit.length})`);

console.log(`test-finding-claims-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
