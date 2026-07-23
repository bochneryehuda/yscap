'use strict';
/**
 * ISG-3 — pure tests for the investor-guideline DESK vetting engine. Proves:
 *   • assessCondition drives the verdict from the mapped PILOT condition's status
 *     (satisfied → SATISFIED; present-but-open → OUTSTANDING; absent-new → OUTSTANDING+suggestPost);
 *   • a deferred/held condition is surfaced as DEFERRED, never posted/evaluated now;
 *   • the note-buyer numeric checks (seller concession, contingency, liability tier, median)
 *     conflict ONLY on a known bad value and degrade to 'to_verify' on missing data — never a
 *     fabricated conflict; a real conflict escalates the verdict to CONFLICTS with a cited number;
 *   • assess() rolls up the summary + headline; hostile input never throws.
 */
const assert = require('assert');
const desk = require('../src/lib/underwriting/investor-guidelines/desk');
const spec = require('../src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const V = desk.VERDICT;

const cond = (over) => Object.assign({ cond_no: 9001, name: 'Test', domain: 'other', scope: 'all_note_buyers', lifecycle: 'active_now', clears_by: 'document_upload', checks: [], pilot_template_code: 'rtl_x', match_quality: 'exact' }, over);

// 1. verdict from the mapped PILOT condition status.
{
  const satisfied = new Map([['rtl_x', { status: 'satisfied', signed_off: false }]]);
  const signed = new Map([['rtl_x', { status: 'received', signed_off: true }]]);
  const open = new Map([['rtl_x', { status: 'outstanding', signed_off: false }]]);
  assert.strictEqual(desk.assessCondition(cond(), { existingByCode: satisfied }).verdict, V.SATISFIED);
  assert.strictEqual(desk.assessCondition(cond(), { existingByCode: signed }).verdict, V.SATISFIED, 'signed off → satisfied');
  const o = desk.assessCondition(cond(), { existingByCode: open });
  assert.strictEqual(o.verdict, V.OUTSTANDING);
  assert.strictEqual(o.pilotOnFile, true);
  ok('verdict follows the mapped PILOT condition: satisfied / signed-off → SATISFIED, open → OUTSTANDING');
}

// 2. a NEW condition with no PILOT equivalent, not on file → OUTSTANDING + suggestPost.
{
  const c = cond({ cond_no: 3333, pilot_template_code: null, match_quality: 'new' });
  const r = desk.assessCondition(c, { existingByCode: new Map() });
  assert.strictEqual(r.verdict, V.OUTSTANDING);
  assert.strictEqual(r.suggestPost, true, 'a new, unposted condition is suggested to post');
  // an exact-match condition simply not on the file yet is outstanding but NOT suggestPost (PILOT owns it).
  const r2 = desk.assessCondition(cond(), { existingByCode: new Map() });
  assert.strictEqual(r2.verdict, V.OUTSTANDING);
  assert.ok(!r2.suggestPost, 'a mapped PILOT condition is not a new-post suggestion');
  ok('new-with-no-PILOT-equivalent → suggest posting; a mapped one is left to PILOT');
}

// 3. deferred / held conditions are surfaced as DEFERRED, never active.
{
  for (const lc of ['hold_attorney_closing', 'defer_post_closing', 'closing_phase']) {
    const r = desk.assessCondition(cond({ lifecycle: lc }), { existingByCode: new Map() });
    assert.strictEqual(r.verdict, V.DEFERRED, `${lc} → DEFERRED`);
  }
  ok('attorney-hold / post-closing / closing-phase conditions surface as DEFERRED');
}

// 4. numeric checks conflict ONLY on a known bad value; missing data → to_verify.
{
  // seller concession: 6% cap (3% for 5+ units)
  assert.strictEqual(desk.checkSellerConcession({}).status, 'to_verify', 'no data → to_verify');
  assert.strictEqual(desk.checkSellerConcession({ seller_concession_pct: 5 }).status, 'ok');
  assert.strictEqual(desk.checkSellerConcession({ seller_concession_pct: 8 }).status, 'conflict');
  assert.strictEqual(desk.checkSellerConcession({ seller_concession_pct: 4, units: 5 }).status, 'conflict', '4% > 3% cap for 5+ units');
  // contingency: 10% cap
  assert.strictEqual(desk.checkContingency({ sow_contingency_pct: 12 }).status, 'conflict');
  assert.strictEqual(desk.checkContingency({ sow_contingency_pct: 8 }).status, 'ok');
  assert.strictEqual(desk.checkContingency({}).status, 'to_verify');
  // liability tier by loan amount
  assert.strictEqual(desk.checkLiabilityTier({ loan_amount: 400000, liability_coverage: 300000 }).status, 'ok');
  assert.strictEqual(desk.checkLiabilityTier({ loan_amount: 400000, liability_coverage: 250000 }).status, 'conflict');
  assert.strictEqual(desk.checkLiabilityTier({ loan_amount: 1500000, liability_coverage: 500000 }).status, 'conflict', '$1.5M loan needs $1M');
  assert.strictEqual(desk.checkLiabilityTier({ loan_amount: 400000 }).status, 'to_verify', 'no coverage value → to_verify');
  // median value caps
  assert.strictEqual(desk.checkMedianValue({ arv: 150000, zillow_median: 100000, units: 1 }).status, 'conflict', '150% > 125% (1 unit)');
  assert.strictEqual(desk.checkMedianValue({ arv: 150000, zillow_median: 100000, units: 3 }).status, 'ok', '150% < 300% (3-4 unit)');
  assert.strictEqual(desk.checkMedianValue({ arv: 150000 }).status, 'to_verify', 'no median → to_verify');
  ok('numeric checks: conflict only on a known bad value; missing data → to_verify (never fabricated)');
}

// 5. a note-buyer-specific conflict escalates the condition verdict to CONFLICTS with a cited number.
{
  const c = spec.CONDITIONS.find((x) => x.cond_no === 3035); // seller concession, corrfirst
  const r = desk.assessCondition(c, { existingByCode: new Map(), signals: { seller_concession_pct: 9 } });
  assert.strictEqual(r.verdict, V.CONFLICTS);
  assert.ok(/9%/.test(r.reason) && /6%/.test(r.reason), 'reason cites the actual vs the cap');
  assert.ok(r.checks.some((k) => k.status === 'conflict'), 'the conflicting check is attached');
  // with good data it is not a conflict.
  const good = desk.assessCondition(c, { existingByCode: new Map(), signals: { seller_concession_pct: 5 } });
  assert.notStrictEqual(good.verdict, V.CONFLICTS);
  ok('a known over-cap value escalates to CONFLICTS with the actual vs cap cited');
}

// 6. assess() rolls up summary + headline; hostile input never throws.
{
  const conditions = [
    cond({ cond_no: 1, pilot_template_code: 'a' }),
    cond({ cond_no: 2, pilot_template_code: 'b' }),
    cond({ cond_no: 3, pilot_template_code: null, match_quality: 'new' }),
    cond({ cond_no: 4, lifecycle: 'hold_attorney_closing' }),
    spec.CONDITIONS.find((x) => x.cond_no === 3035),
  ];
  const existingByCode = new Map([['a', { status: 'satisfied', signed_off: false }]]);
  const res = desk.assess({ conditions, existingByCode, signals: { seller_concession_pct: 20 }, noteBuyerKey: 'corrfirst', noteBuyerName: 'CorrFirst' });
  assert.strictEqual(res.summary.satisfied, 1, 'one satisfied');
  assert.strictEqual(res.summary.conflicts, 1, 'one conflict (seller concession 20%)');
  assert.strictEqual(res.summary.deferred, 1, 'one deferred (attorney-hold)');
  assert.strictEqual(res.summary.toPost, 1, 'one to post (new, unmapped)');
  assert.ok(res.suggestedToPost.length === 1 && res.conflicts.length === 1);
  assert.ok(/conflict/i.test(res.headline));
  // hostile input never throws
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => desk.assess(bad));
    assert.doesNotThrow(() => desk.assessCondition(bad, bad));
  }
  ok('assess() rolls up summary + headline; hostile input never throws');
}

console.log(`\ninvestor-guideline desk pure — ${passed} checks passed`);
