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
  // the checks honor the never-throws contract even on a null/garbage signals bag.
  for (const bad of [null, undefined, 42, 'x', []]) {
    for (const fn of [desk.checkSellerConcession, desk.checkContingency, desk.checkLiabilityTier, desk.checkMedianValue]) {
      assert.doesNotThrow(() => fn(bad));
      assert.strictEqual(fn(bad).status, 'to_verify', 'no signals → to_verify, never a throw/conflict');
    }
  }
  ok('numeric checks: conflict only on a known bad value; missing data → to_verify (never fabricated); null-safe');
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
  assert.ok(/NOT satisfied/i.test(res.headline), 'the headline leads with the note buyer being not satisfied');
  // hostile input never throws
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => desk.assess(bad));
    assert.doesNotThrow(() => desk.assessCondition(bad, bad));
  }
  ok('assess() rolls up summary + headline; hostile input never throws');
}

// 7. triggerApplies — fail-open trigger filter using the real rule_logic evaluator.
{
  const { BY_KEY } = require('../src/lib/conditions/field-registry');
  const fm = BY_KEY;
  // empty trigger always applies.
  assert.strictEqual(desk.triggerApplies({}, {}, fm), true);
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.always, { anything: 1 }, fm), true);
  // condo: property_type known-and-matching → true; known-and-different → false; absent → true (fail-open).
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.condo, { property_type: 'condo' }, fm), true);
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.condo, { property_type: 'sfr' }, fm), false, 'known non-condo → excluded');
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.condo, {}, fm), true, 'unknown property_type → fail-open include');
  // flood zone (boolean is_true).
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.flood_zone, { in_flood_zone: true }, fm), true);
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.flood_zone, { in_flood_zone: false }, fm), false);
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.flood_zone, {}, fm), true, 'unknown flood flag → fail-open include');
  // loan amount > $2M (money gt).
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.loan_amount_gt_2000000, { loan_amount: 2500000 }, fm), true);
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.loan_amount_gt_2000000, { loan_amount: 500000 }, fm), false, 'under $2M → excluded');
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.loan_amount_gt_2000000, {}, fm), true);
  // a trigger on a field the registry does not have (vesting_type) fails OPEN when absent,
  // so the entity conditions are never silently dropped.
  assert.strictEqual(desk.triggerApplies(spec.TRIGGERS.entity_vesting, {}, fm), true, 'unknown vesting field → fail-open include');
  // triggerFields extracts the referenced keys.
  assert.deepStrictEqual(desk.triggerFields(spec.TRIGGERS.condo), ['property_type']);
  // hostile input never throws.
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.doesNotThrow(() => desk.triggerApplies(bad, bad, fm));
    assert.strictEqual(desk.triggerApplies(bad, {}, fm), true, 'a non-group trigger → applies (fail-open)');
    assert.doesNotThrow(() => desk.triggerFields(bad));
  }
  ok('triggerApplies: known non-match excludes, unknown/absent field fails OPEN (never drops a requirement)');
}

// 8. duplicate-check bug FIX — an evaluator condition renders ONE numeric line (the file's tier)
//    plus any descriptive checks, not one copy per spec check.
{
  const hz = spec.CONDITIONS.find((x) => x.cond_no === 2186); // hazard: 4 spec checks (3 tiers + 1 note)
  assert.ok(hz.checks.length >= 3, 'the spec carries the tiered checks');
  const r = desk.assessCondition(hz, { existingByCode: new Map(), signals: { loan_amount: 318500, liability_coverage: 300000 } });
  const liabilityLines = r.checks.filter((k) => /liability coverage/i.test(k.text || '') || /\$300,000/.test(k.text || ''));
  assert.strictEqual(liabilityLines.length, 1, 'the liability line renders ONCE (the file tier), not once per spec check');
  assert.ok(r.checks.length < hz.checks.length, 'the tiered spec rows collapsed to the applicable one');
  ok('duplicate-check fix: an evaluator condition shows ONE tier line + descriptive checks (no N-copy repeat)');
}

// 9. the OVERLAY view — the desk answers "is the note buyer happy with the file as-is?" and
//    surfaces ONLY the not-happy items: a CONFLICT (fatal) and a COVERAGE GAP (a required
//    condition not posted; feasibility/construction missing → fatal). A satisfied condition is
//    silent (not unhappy); an OPEN posted condition is silent (it will be checked on arrival).
{
  const sc = spec.CONDITIONS.find((x) => x.cond_no === 3035);   // seller concession (evaluator)
  const feas = spec.CONDITIONS.find((x) => x.cond_no === 2193); // construction feasibility
  const cred = spec.CONDITIONS.find((x) => x.cond_no === 1015); // credit
  const existingByCode = new Map([['rtl_cond_credit', { status: 'satisfied', signed_off: false }]]);
  const res = desk.assess({ conditions: [sc, feas, cred], existingByCode, signals: { seller_concession_pct: 9 }, noteBuyerKey: 'corrfirst', noteBuyerName: 'CorrFirst' });
  assert.strictEqual(res.happy, false, 'the investor is not happy');
  assert.strictEqual(res.unhappy.length, 2, 'exactly the conflict + the coverage gap surface');
  assert.ok(res.unhappy.some((u) => u.flag === 'conflict' && u.severity === 'fatal'), 'the over-cap seller concession is a fatal conflict');
  const gap = res.unhappy.find((u) => u.flag === 'coverage_gap');
  assert.ok(gap && gap.severity === 'fatal', 'a missing construction/feasibility condition is a FATAL coverage gap');
  assert.strictEqual(res.summary.fatal, 2);
  assert.ok(/NOT satisfied/i.test(res.headline));
  // a fully-satisfied, non-conflicting file → happy + silent.
  const happyRes = desk.assess({ conditions: [cred], existingByCode, signals: {}, noteBuyerKey: 'corrfirst' });
  assert.strictEqual(happyRes.happy, true, 'a satisfied file makes the investor happy');
  assert.strictEqual(happyRes.unhappy.length, 0, 'nothing surfaces when the investor is happy');
  assert.ok(/satisfied with the file/i.test(happyRes.headline));
  // an OPEN posted condition (not satisfied, but on file) is NOT a coverage gap.
  const openRes = desk.assess({ conditions: [cred], existingByCode: new Map([['rtl_cond_credit', { status: 'received', signed_off: false }]]), signals: {}, noteBuyerKey: 'corrfirst' });
  assert.strictEqual(openRes.happy, true, 'an open (posted) condition is fine — not a gap');
  // hostile input never throws + still returns happy/unhappy shape.
  for (const bad of [null, undefined, 42, 'x', [], {}]) { const r = desk.assess(bad); assert.ok(typeof r.happy === 'boolean' && Array.isArray(r.unhappy)); }
  ok('overlay: surfaces ONLY not-happy items (conflict + missing-required coverage gap); happy+silent otherwise; null-safe');
}

console.log(`\ninvestor-guideline desk pure — ${passed} checks passed`);
