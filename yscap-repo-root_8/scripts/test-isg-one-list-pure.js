'use strict';
/**
 * ONE list for the note-buyer guidelines — the 4th surface (owner-reported 2026-07-27).
 *
 * THE BUG THIS LOCKS DOWN. Three producers assert one fact and each names it differently:
 *   - the desk, off Blue Lake's spec row      → code isg_appraisal_review_123   (warning)
 *   - the desk, off CorrFirst's all-buyer row → code isg_appraisal_review_3345  (warning)
 *   - the whole-loan run's rule table         → code isg_rural_property         (FATAL)
 * All three read the SAME signal (`appraisal_rural`). Keyed on their codes they can never collide,
 * so one rural file said "rural" three times, at two different severities, in two different places
 * — twice as a mild note in Open findings and once as a dealbreaker in the run cockpit.
 *
 * The fix is NOT a list of codes (the desk's are derived from cond_no, so a spec edit would silently
 * re-split the claim). Each producer DECLARES the fact it asserts — the signal name — and that is
 * the merge key. These checks prove the collapse happens, that the DEALBREAKER is what survives,
 * and that nothing unrelated got merged along the way.
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const { deskToFindings } = require('../src/lib/underwriting/investor-guidelines/desk-findings');
const review = require('../src/lib/underwriting/investor-guideline-review');
const { dedupeByClaim, claimOf } = require('../src/lib/underwriting/finding-claims');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${name}`); };

console.log('ISG one list (pure)');

// The desk's two rural rows — one per note-buyer spec, both keyed on the same concern_field.
const ruralDesk = {
  noteBuyer: { name: 'Blue Lake' },
  verdicts: [{ cond_no: 1 }],
  unhappy: [
    { cond_no: 123, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY INELIGIBLE',
      domain: 'property', concern_field: 'appraisal_rural', pilot_template_code: null },
    { cond_no: 3345, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY VERIFICATION',
      domain: 'rural', concern_field: 'appraisal_rural', pilot_template_code: null },
  ],
};

t('a desk finding declares the FACT it asserts, not just its own code', () => {
  const f = deskToFindings(ruralDesk);
  assert.strictEqual(f.length, 2);
  for (const x of f) assert.strictEqual(x.claimKey, 'isg_signal:appraisal_rural');
});

t('the run rule table declares the same fact under its own code', () => {
  const out = review.review({ note_buyer: 'Blue Lake', appraisal_rural: true });
  const rural = out.find((x) => x.code === 'isg_rural_property');
  assert.ok(rural, 'the rural rule must fire when the appraisal says rural');
  assert.strictEqual(rural.claimKey, 'isg_signal:appraisal_rural');
  assert.strictEqual(rural.severity, 'fatal');
});

t('THREE producers, ONE row — and the DEALBREAKER is the one that survives', () => {
  const deskF = deskToFindings(ruralDesk);
  const runF = review.review({ note_buyer: 'Blue Lake', appraisal_rural: true })
    .filter((x) => x.code === 'isg_rural_property');
  assert.strictEqual(deskF.length + runF.length, 3, 'fixture must really produce three');

  const merged = dedupeByClaim([...deskF, ...runF]);
  const rural = merged.filter((x) => String(x.claimKey || '') === 'isg_signal:appraisal_rural');
  assert.strictEqual(rural.length, 1,
    `rural must collapse to ONE row, got ${rural.length}: ${rural.map((x) => x.code).join(', ')}`);
  assert.strictEqual(rural[0].severity, 'fatal',
    'the run calls this a dealbreaker — a merge must never quietly downgrade it to a note');
  assert.strictEqual(rural[0].code, 'isg_rural_property');
  // Nothing an auditor needs is thrown away: the codes that also raised it are recorded.
  assert.ok(Array.isArray(rural[0].mergedFrom) && rural[0].mergedFrom.length === 2,
    'the survivor must record the other two codes that raised the same fact');
});

t('order does not decide the winner — the fatal survives either way', () => {
  const deskF = deskToFindings(ruralDesk);
  const runF = review.review({ note_buyer: 'Blue Lake', appraisal_rural: true })
    .filter((x) => x.code === 'isg_rural_property');
  for (const list of [[...deskF, ...runF], [...runF, ...deskF]]) {
    const m = dedupeByClaim(list).filter((x) => String(x.claimKey || '') === 'isg_signal:appraisal_rural');
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].severity, 'fatal', 'a warning listed first must not win the merge');
  }
});

t('a transferred appraisal collapses the same way', () => {
  const d = {
    noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
    unhappy: [{ cond_no: 3349, flag: 'appraisal_review', severity: 'warning', name: 'TRANSFERRED APPRAISAL',
      domain: 'appraisal', concern_field: 'appraisal_transferred', pilot_template_code: null }],
  };
  const runF = review.review({ note_buyer: 'Blue Lake', appraisal_transferred: true })
    .filter((x) => x.code === 'isg_bl_transferred_appraisal');
  assert.strictEqual(runF.length, 1);
  const merged = dedupeByClaim([...deskToFindings(d), ...runF])
    .filter((x) => String(x.claimKey || '') === 'isg_signal:appraisal_transferred');
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].severity, 'fatal');
});

// ── the merge must not be greedy ─────────────────────────────────────────────
t('a COVERAGE GAP carries no claim key — two missing conditions never merge', () => {
  const d = {
    noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
    unhappy: [
      { cond_no: 2193, flag: 'coverage_gap', severity: 'fatal', name: 'Construction feasibility report',
        pilot_template_code: 'rtl_cond_feasibility', domain: 'construction_feasibility' },
      { cond_no: 1026, flag: 'coverage_gap', severity: 'warning', name: 'Title commitment',
        pilot_template_code: 'rtl_cond_title', domain: 'title' },
    ],
  };
  const f = deskToFindings(d);
  assert.strictEqual(f.length, 2);
  for (const x of f) assert.strictEqual(x.claimKey, undefined,
    'a gap is about a MISSING CONDITION, not a fact — keying it would merge unrelated gaps');
  assert.strictEqual(dedupeByClaim(f).length, 2, 'two different missing conditions are two items of work');
});

t('a rule with no shared signal is untouched — it still keys on its own code', () => {
  assert.strictEqual(review.claimKeyForCode('isg_bl_ny_loan'), null);
  const out = review.review({ note_buyer: 'Blue Lake', property_state: 'NY' });
  const ny = out.find((x) => x.code === 'isg_bl_ny_loan');
  assert.ok(ny);
  assert.strictEqual(ny.claimKey, undefined);
  assert.ok(claimOf(ny).startsWith('code:isg_bl_ny_loan'), 'must fall through to the code key');
});

t('claimKeyForCode never throws and never guesses', () => {
  for (const bad of [null, undefined, '', 'nope', 42, {}, []]) {
    assert.strictEqual(review.claimKeyForCode(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

t('a finding with no claimKey keys EXACTLY as it did before', () => {
  // The whole rest of the registry must be unaffected by the new branch.
  const plain = { code: 'bank_account_not_borrower', field: 'account_holder', document_id: 'doc-1' };
  assert.strictEqual(claimOf(plain), 'code:bank_account_not_borrower::account_holder::doc-1::');
  const family = { code: 'cot_final_buyer_not_vesting' };
  assert.strictEqual(claimOf(family), 'claim:vesting_entity_vs_contract_buyer');
});

t('two DIFFERENT facts never merge into each other', () => {
  const runF = review.review({
    note_buyer: 'Blue Lake', appraisal_rural: true, appraisal_transferred: true, property_state: 'NY',
  });
  const merged = dedupeByClaim(runF);
  const codes = merged.map((x) => x.code);
  assert.ok(codes.includes('isg_rural_property'), 'rural must survive');
  assert.ok(codes.includes('isg_bl_transferred_appraisal'), 'transferred must survive');
  assert.ok(codes.includes('isg_bl_ny_loan'), 'the New York escalation must survive');
});

// ── the advisory boundary is not weakened by folding these into the list ─────
t('ADVISORY — a merged guideline row still cannot gate clear-to-close', () => {
  const deskF = deskToFindings(ruralDesk);
  for (const x of deskF) {
    assert.strictEqual(x.blocksCtc, false);
    assert.strictEqual(x.id, undefined, 'no stored id ⇒ renders read-only, and fileFatalCount cannot see it');
  }
});

console.log(`\n${n} checks passed.`);
