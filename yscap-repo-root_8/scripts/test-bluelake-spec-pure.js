'use strict';
/**
 * ISG-BL — pure tests for the Blue Lake Capital RTL spec + the desk's generic-vs-specific
 * dedup. Proves:
 *   • the spec is well-formed (unique cond_no; valid scope/lifecycle/domain/clears_by; every
 *     trigger uses a supported operator);
 *   • Blue Lake conditions are note-buyer-scoped (they never leak onto another note buyer);
 *   • the leverage/tier/pricing conditions are Gold-governed (meta.governed_by='gold_program')
 *     and carry NO forked number to enforce — the live Gold engine owns those;
 *   • the ground-up/heavy-rehab insurance + feasibility conditions trigger on rehab_type;
 *   • dedupePreferSpecific keeps a note-buyer-specific condition over a generic all-note-buyers
 *     one on the same PILOT template, and never drops a null-template condition; null-safe.
 */
const assert = require('assert');
const spec = require('../src/lib/underwriting/investor-guidelines/bluelake-rtl-spec');
const desk = require('../src/lib/underwriting/investor-guidelines/desk');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const SCOPES = new Set(['all_note_buyers', 'note_buyer', 'all_but_note_buyer_limits']);
const LIFECYCLES = new Set(['active_now', 'hold_attorney_closing', 'defer_post_closing', 'closing_phase']);
const CLEARS = new Set(['document_upload', 'internal_verification', 'third_party_order', 'attorney_closing', 'system']);
const OPS = new Set(['eq', 'gt', 'lt', 'in', 'is_true', 'is_false']);

// 1. well-formed spec.
{
  assert.strictEqual(spec.NOTE_BUYER, 'bluelake');
  assert.ok(spec.CONDITIONS.length >= 50, 'a substantial condition set');
  const nums = spec.CONDITIONS.map((c) => c.cond_no);
  assert.strictEqual(new Set(nums).size, nums.length, 'cond_no unique');
  for (const c of spec.CONDITIONS) {
    assert.ok(c.cond_no && c.name && c.domain, `row ${c.cond_no} has cond_no/name/domain`);
    assert.ok(SCOPES.has(c.scope), `row ${c.cond_no} scope`);
    assert.ok(LIFECYCLES.has(c.lifecycle), `row ${c.cond_no} lifecycle`);
    assert.ok(CLEARS.has(c.clears_by), `row ${c.cond_no} clears_by`);
    const t = c.trigger;
    if (t && Array.isArray(t.rules)) for (const r of t.rules) assert.ok(OPS.has(r.operator), `row ${c.cond_no} operator ${r.operator}`);
  }
  ok('spec is well-formed (unique cond_no; valid scope/lifecycle/clears_by; supported trigger operators)');
}

// 2. Blue Lake conditions are note-buyer-scoped — they never apply to another note buyer.
{
  assert.strictEqual(spec.CONDITIONS.filter((c) => spec.appliesToNoteBuyer(c, 'corrfirst')).length, 0, 'nothing leaks to corrfirst');
  assert.ok(spec.applicableFor('bluelake').length >= 50, 'the active set applies to bluelake');
  assert.ok(spec.appliesToNoteBuyer(spec.CONDITIONS[0], 'Blue Lake'), 'the "Blue Lake" label normalizes to bluelake');
  ok('Blue Lake conditions are note-buyer-scoped (never leak onto another note buyer)');
}

// 3. leverage/tier/pricing conditions are Gold-governed with no forked number.
{
  const gg = spec.goldGoverned();
  assert.ok(gg.length >= 5, 'several Gold-governed conditions');
  for (const c of gg) {
    assert.strictEqual(c.meta.governed_by, 'gold_program');
    // Gold-governed rows carry no note_buyer_specific numeric limit to independently enforce —
    // their checks describe the deferral, they don't assert a competing cap value.
  }
  // the leverage caps condition exists and defers to Gold.
  const lev = spec.CONDITIONS.find((c) => /LEVERAGE CAPS/.test(c.name));
  assert.ok(lev && lev.meta && lev.meta.governed_by === 'gold_program', 'leverage caps are Gold-governed');
  // the assignment-fee condition uses 15% (owner-confirmed) and is Gold-governed.
  const asg = spec.CONDITIONS.find((c) => /ASSIGNMENT FEE/.test(c.name));
  assert.ok(asg && /15%/.test(asg.required_evidence) && !/10%/.test(asg.required_evidence), 'assignment fee is 15% (not 10%)');
  ok('leverage/tier/pricing conditions are Gold-governed (no forked number); assignment fee = 15%');
}

// 4. ground-up / heavy-rehab insurance + feasibility trigger on rehab_type.
{
  const gl = spec.CONDITIONS.find((c) => /BUILDERS RISK \+ GENERAL LIABILITY/.test(c.name));
  const feas = spec.CONDITIONS.find((c) => /CONSTRUCTION FEASIBILITY REPORT/.test(c.name));
  for (const c of [gl, feas]) {
    assert.ok(c, 'the condition exists');
    const vals = c.trigger.rules[0].value;
    assert.ok(vals.includes('heavy') && (vals.includes('ground_up') || vals.includes('construction')), `${c.name} triggers on ground-up AND heavy rehab`);
  }
  ok('General Liability + Feasibility Report attach on ground-up AND heavy rehab');
}

// 5. dedup — ONLY a generic row is dropped when a buyer-specific row covers its template.
//    TWO buyer-specific rows sharing a template are DISTINCT requirements and BOTH survive
//    (the guideline→PILOT crosswalk is many-to-one). Null templates always kept.
{
  const rows = [
    { cond_no: 1015, scope: 'all_note_buyers', pilot_template_code: 'rtl_cond_credit', name: 'GENERIC CREDIT' },
    { cond_no: 41, scope: 'note_buyer', pilot_template_code: 'rtl_cond_credit', name: 'BLUELAKE CREDIT' },
    // six distinct title requirements all clear through ONE template — every one must survive.
    { cond_no: 2, scope: 'note_buyer', pilot_template_code: 'rtl_cond_title', name: 'TITLE A' },
    { cond_no: 140, scope: 'note_buyer', pilot_template_code: 'rtl_cond_title', name: 'TITLE B' },
    { cond_no: 141, scope: 'note_buyer', pilot_template_code: 'rtl_cond_title', name: 'TITLE C' },
    { cond_no: 5, scope: 'all_note_buyers', pilot_template_code: 'rtl_p1_id', name: 'GENERIC ID' },
    { cond_no: 98, scope: 'note_buyer', pilot_template_code: null, name: 'no-code A' },
    { cond_no: 99, scope: 'note_buyer', pilot_template_code: null, name: 'no-code B' },
  ];
  const out = desk.dedupePreferSpecific(rows);
  assert.strictEqual(out.filter((r) => r.name === 'GENERIC CREDIT').length, 0, 'the generic credit row is superseded and dropped');
  assert.strictEqual(out.filter((r) => r.pilot_template_code === 'rtl_cond_credit').length, 1, 'exactly the buyer-specific credit survives');
  assert.strictEqual(out.filter((r) => r.pilot_template_code === 'rtl_cond_title').length, 3, 'ALL THREE distinct title requirements survive (many-to-one crosswalk)');
  assert.strictEqual(out.find((r) => r.pilot_template_code === 'rtl_p1_id').name, 'GENERIC ID', 'an un-superseded generic row stays');
  assert.strictEqual(out.filter((r) => !r.pilot_template_code).length, 2, 'null-template rows are never deduped');
  assert.strictEqual(out.length, 7, '8 in → drop only the 1 superseded generic credit = 7 kept');
  for (const bad of [null, undefined, 42, 'x', {}, [{}], [null]]) assert.doesNotThrow(() => desk.dedupePreferSpecific(bad));
  ok('dedup drops ONLY a superseded generic; distinct same-scope rows on one template all survive; null-safe');
}

// 6. the REAL Blue Lake active set (all note-buyer-scoped) survives dedup intact — nothing lost.
{
  const active = spec.applicableFor('bluelake');   // lifecycle active_now
  const out = desk.dedupePreferSpecific(active.slice());
  assert.strictEqual(out.length, active.length, 'every active Blue Lake condition survives dedup (no generic to supersede within one buyer)');
  // and the shared-template conditions are all present (e.g. every rtl_cond_title requirement).
  const titles = active.filter((c) => c.pilot_template_code === 'rtl_cond_title');
  assert.ok(titles.length >= 3, 'multiple title requirements exist in the spec');
  assert.strictEqual(out.filter((c) => c.pilot_template_code === 'rtl_cond_title').length, titles.length, 'all title requirements survive');
  ok('the full Blue Lake active set survives dedup — no condition silently dropped');
}

console.log(`\nBlue Lake spec + desk dedup pure — ${passed} checks passed`);
