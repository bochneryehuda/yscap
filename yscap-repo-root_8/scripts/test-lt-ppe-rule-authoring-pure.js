#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the RULE-AUTHORING SERVICE, pure offline test.
 *
 * WHAT THIS IS ACTUALLY PROVING, in the order it matters:
 *
 *  (A) THE PROPERTY THAT MATTERS — a rule a human authors is a rule the ENGINE CAN RUN. Every one of
 *      the four result kinds is authored through the service and then evaluated by the REAL
 *      interpreter (`rules.evaluateRules`), asserting the answer: the LLPA lands with the right
 *      milli-points, the decline carries the author's reason, the bound is the one that binds, the
 *      holdback arrives as a holdback. A service that produces rules the engine silently ignores is
 *      exactly the "built it and it does nothing" defect this codebase keeps finding, so it is not
 *      assumed — it is run.
 *      It also asserts the HALF-OPEN boundary through the whole chain: a rule authored for 640–660
 *      fires at 640 and at 659 and NOT at 660. That single assertion is what makes "740 falls in two
 *      bands" impossible to reintroduce anywhere between the author's typing and the price.
 *
 *  (B) THE FOUR REFUSALS the service exists to make, each with a message a non-developer could act on:
 *      an unknown dimension, an unparseable band, a rule that can never fire, and two rules on the
 *      same cell. Each is asserted to be REFUSED (not accepted, not silently dropped) AND to be
 *      readable — the messages are checked for the jargon that must not reach a screen.
 *
 *  (C) THE LINE BETWEEN REFUSING AND REPORTING. A PARTIAL overlap is reported and NOT refused, because
 *      a whole-column rule plus a cell inside it is how every sheet in this engine layers. A predicate
 *      the reducer cannot read is reported as unchecked and NOT refused. Both directions are asserted,
 *      because a checker that refuses the ordinary case gets switched off and a checker that stays
 *      silent about what it skipped is worse than none.
 *
 *  (D) THE COLLISION THAT ALMOST SHIPPED. An intent's `op` is the AUTHORING operation and a scope
 *      spec's `op` is the COMPARISON. The first cut flattened them onto one object, and every scope
 *      intent was refused with a message naming a field the caller never set. The nested-`scope`
 *      contract is pinned here so it cannot be flattened back.
 *
 *   node scripts/test-lt-ppe-rule-authoring-pure.js
 *
 * PURE: no database, no network. LT-only.
 */
const A = require('../src/longterm/ppe/rule-authoring');
const coverage = require('../src/longterm/ppe/rule-coverage');
const ppp = require('../src/longterm/ppe/ppp-structures');
const { evaluateRules } = require('../src/longterm/ppe/rules');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function refusedWith(out, code, label) {
  const got = (out.refusals || []).map((r) => r.code);
  ok(out.ok === false && got.includes(code), `${label} — refused as ${code}${out.ok ? ' (IT WAS ACCEPTED)' : ` (got ${got.join(', ') || 'nothing'})`}`);
  return (out.refusals || []).find((r) => r.code === code);
}
/**
 * A refusal a non-developer can act on: it says something, it does not lead with the library's own
 * "op: refused —" prefix, and it does not put the words a person cannot act on in the message itself.
 * The technical wording is still required to SURVIVE, on `detail` — a message nobody can debug is the
 * other half of this failure.
 */
function plainlyWorded(r, label) {
  if (!r) { ok(false, `${label} — no refusal to read`); return; }
  const m = String(r.message || '');
  const jargon = /predicate|adjMilli|milli-points|conjunction|LEAF_OPS|jsonb|\bnull\b|undefined/i.test(m);
  ok(m.length > 30 && !/refused —/.test(m) && !jargon,
    `${label} — the message is plain${jargon ? ` (jargon leaked: "${m.slice(0, 90)}…")` : ''}`);
}

console.log('LT PPE rule-authoring service — offline\n');

// ============================================================================
// A) THE PROPERTY THAT MATTERS — an authored rule is one the REAL engine runs.
// ============================================================================
console.log('A) an authored rule actually evaluates');

// (A1) an LLPA — authored, then priced by rules.evaluateRules.
{
  const out = A.applyIntent({
    op: 'add_llpa', code: 'llpa_fico_640', adjMilli: 250, dimension: 'fico',
    reason: 'FICO 640–659', when: { fact: 'fico', op: 'between', value: [640, 660] },
  }, { ruleset: [] });
  ok(out.ok, 'an LLPA is authored');

  const at645 = evaluateRules([out.rule], { fico: 645 });
  ok(at645.adjustments.length === 1 && at645.adjustments[0].adjMilli === 250 && at645.adjustments[0].unit === 'points',
    'the REAL engine applies it at FICO 645, at exactly the authored 250 milli-points');
  ok(at645.adjustments[0].code === 'llpa_fico_640', '…carrying the code the author gave it');

  // The half-open rule, end to end. This is the assertion that makes "740 in two bands" impossible.
  ok(evaluateRules([out.rule], { fico: 640 }).adjustments.length === 1, 'it fires at the band\'s low edge (640)');
  ok(evaluateRules([out.rule], { fico: 659 }).adjustments.length === 1, 'it fires at 659');
  ok(evaluateRules([out.rule], { fico: 660 }).adjustments.length === 0, 'it does NOT fire at 660 — the high edge belongs to the next band');
  ok(evaluateRules([out.rule], { fico: 700 }).adjustments.length === 0, 'it does not fire above the band');
  // Fail-safe on a fact the scenario does not carry — the engine's own rule, proven to survive authoring.
  const noFico = evaluateRules([out.rule], { ltv: 70000 });
  ok(noFico.adjustments.length === 0 && noFico.unknownFacts.includes('fico'),
    'a scenario with no FICO is not charged, and the missing fact is REPORTED rather than swallowed');
}

// (A2) an eligibility decline — authored, then declined by the engine, with the author's own reason.
{
  const out = A.applyIntent({
    op: 'add_eligibility', code: 'no_ny', declineReason: 'New York is not eligible on this program',
    when: { fact: 'state', op: 'eq', value: 'NY' },
  }, { ruleset: [] });
  ok(out.ok, 'an eligibility rule is authored');
  const ny = evaluateRules([out.rule], { state: 'NY' });
  ok(ny.eligible === false && ny.declines[0].reason === 'New York is not eligible on this program',
    'the REAL engine declines a NY loan, quoting the reason the author typed');
  ok(evaluateRules([out.rule], { state: 'TX' }).eligible === true, 'a TX loan is untouched by it');
}

// (A3) a price bound — authored, then binding.
{
  const out = A.applyIntent({ op: 'add_price_bound', code: 'floor_99', bound: 'min', priceMilli: 99000 }, { ruleset: [] });
  ok(out.ok, 'a price floor is authored');
  const r = evaluateRules([out.rule], { price: 98500 });
  ok(r.bounds['price:min'] && r.bounds['price:min'].value === 99000 && r.bounds['price:min'].satisfied === false,
    'the REAL engine binds the floor and reports the requested price as violating it');
  ok(r.declines.some((d) => d.bound === true), '…and turns that violation into a decline');
  ok(evaluateRules([out.rule], { price: 99500 }).bounds['price:min'].satisfied === true, 'a price above the floor satisfies it');
}

// (A4) a margin and a holdback — authored, then carried as the right unit.
{
  const m = A.applyIntent({ op: 'add_margin_holdback', code: 'mrg_tx', knob: 'margin', milli: 375, when: { fact: 'state', op: 'eq', value: 'TX' } }, { ruleset: [] });
  const h = A.applyIntent({ op: 'add_margin_holdback', code: 'hb_dscr_low', knob: 'holdback', milli: 125, when: { fact: 'dscr', op: 'lt', value: 1100 } }, { ruleset: [] });
  ok(m.ok && h.ok, 'a margin and a holdback are authored');
  const r = evaluateRules([m.rule, h.rule], { state: 'TX', dscr: 1000 });
  const units = r.adjustments.map((a) => `${a.unit}:${a.adjMilli}`).sort();
  ok(units.join('|') === 'holdback:125|margin:375',
    'the REAL engine carries both, each as its own unit and at its own amount');
}

// (A5) scope, then rescope — the edit path, still evaluating correctly afterwards.
{
  const base = A.applyIntent({ op: 'add_llpa', code: 'llpa_hi_ltv', adjMilli: 500, dimension: 'ltv' }, { ruleset: [] }).rule;
  const scoped = A.applyIntent({ op: 'scope', scope: { dimension: 'ltv', min: 75000, max: 80000 } }, { rule: base, ruleset: [] });
  ok(scoped.ok, 'the rule is narrowed to an LTV band');
  ok(evaluateRules([scoped.rule], { ltv: 77000 }).adjustments.length === 1, '…and charges inside the band');
  ok(evaluateRules([scoped.rule], { ltv: 82000 }).adjustments.length === 0, '…and not outside it');

  const re = A.applyIntent({ op: 'rescope', scope: { dimension: 'ltv', min: 80000, max: 85000 } }, { rule: scoped.rule, ruleset: [] });
  ok(re.ok, 'the LTV constraint is REPLACED, not stacked');
  ok(evaluateRules([re.rule], { ltv: 82000 }).adjustments.length === 1, '…the new band charges');
  ok(evaluateRules([re.rule], { ltv: 77000 }).adjustments.length === 0,
    '…and the OLD band no longer does — a rescope that merely ANDed a second band would leave a rule that fires nowhere');
  ok(base.when === undefined && Object.isFrozen(scoped.rule), 'the input rule is untouched and the output is frozen');
}

// ============================================================================
// B) THE FOUR REFUSALS — loudly, and in words a person can act on.
// ============================================================================
console.log('\nB) validate and refuse, loudly');

// (B1) an unknown dimension.
{
  const out = A.applyIntent({ op: 'scope', scope: { dimension: 'ficoo', op: 'gte', value: 700 } },
    { rule: A.applyIntent({ op: 'add_llpa', code: 'x', adjMilli: 100, dimension: 'fico' }, { ruleset: [] }).rule });
  const r = refusedWith(out, 'unknown_dimension', 'a dimension that does not exist');
  plainlyWorded(r, 'unknown dimension');
  ok(r && /FICO score/.test(r.message) && /prepayment-penalty structure/.test(r.message),
    '…and it LISTS what can be used instead, by their human names');
  ok(r && typeof r.detail === 'string' && /unknown dimension/.test(r.detail),
    '…while the library\'s own wording survives on `detail` for whoever has to debug it');
}

// (B2) an unparseable band — backwards, and open at both ends.
{
  const base = A.applyIntent({ op: 'add_llpa', code: 'x', adjMilli: 100, dimension: 'fico' }, { ruleset: [] }).rule;
  const back = A.applyIntent({ op: 'scope', scope: { dimension: 'fico', min: 760, max: 700 } }, { rule: base });
  plainlyWorded(refusedWith(back, 'bad_band', 'a band whose low end is above its high end'), 'backwards band');
  const open = A.applyIntent({ op: 'scope', scope: { dimension: 'fico' } }, { rule: base });
  ok(open.ok === false, 'a scope with neither a band nor a comparison is refused');
  const onEnum = A.applyIntent({ op: 'scope', scope: { dimension: 'state', min: 1, max: 2 } }, { rule: base });
  refusedWith(onEnum, 'bad_band', 'a numeric band on a dimension that is not a number');
  const notAState = A.applyIntent({ op: 'scope', scope: { dimension: 'state', op: 'eq', value: 'Nueva York' } }, { rule: base });
  plainlyWorded(refusedWith(notAState, 'bad_value', 'a state that is not a state code'), 'bad state');
}

// (B3) a rule that can never fire.
{
  const out = A.applyIntent({
    op: 'create',
    rule: { code: 'dead_rule', kind: 'pricing', adjustment: { adjMilli: 100, unit: 'points', category: 'fico' },
      when: { all: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'fico', op: 'lt', value: 650 }] } },
  }, { ruleset: [] });
  const r = refusedWith(out, 'never_fires', 'a rule whose own FICO conditions contradict each other');
  plainlyWorded(r, 'never fires');
  ok(r && /FICO score/.test(r.message), '…and it NAMES the dimension that contradicts itself, so it can be fixed');

  // The same, on an enum: two `eq` on one fact can never both hold.
  const two = A.applyIntent({
    op: 'create',
    rule: { code: 'dead_state', kind: 'eligibility', declineReason: 'nope',
      when: { all: [{ fact: 'state', op: 'eq', value: 'NY' }, { fact: 'state', op: 'eq', value: 'TX' }] } },
  }, { ruleset: [] });
  refusedWith(two, 'never_fires', 'a rule that requires the state to be two different states');

  // AND THE CONTROL, which is what makes the assertions above mean anything: a rule that CAN fire is
  // accepted, and the engine does fire it.
  const live = A.applyIntent({
    op: 'create',
    rule: { code: 'live_rule', kind: 'pricing', adjustment: { adjMilli: 100, unit: 'points', category: 'fico' },
      when: { all: [{ fact: 'fico', op: 'gte', value: 650 }, { fact: 'fico', op: 'lt', value: 700 }] } },
  }, { ruleset: [] });
  ok(live.ok && evaluateRules([live.rule], { fico: 675 }).adjustments.length === 1,
    'CONTROL: the same shape with a satisfiable band is accepted and does fire');
}

// (B4) two rules addressing the same cell, and a name already taken.
{
  const existing = {
    code: 'llpa_fico_640', kind: 'pricing', source: 'overlay',
    adjustment: { code: 'llpa_fico_640', adjMilli: 250, unit: 'points', category: 'fico' },
    when: { fact: 'fico', op: 'between', value: [640, 660] },
  };
  const same = A.applyIntent({ op: 'add_llpa', code: 'llpa_fico_640_again', adjMilli: 125, dimension: 'fico', when: { fact: 'fico', op: 'between', value: [640, 660] } }, { ruleset: [existing] });
  const r = refusedWith(same, 'same_cell', 'a second price adjustment on exactly the same cell');
  plainlyWorded(r, 'same cell');
  ok(r && r.otherCode === 'llpa_fico_640' && /llpa_fico_640/.test(r.message),
    '…and it NAMES the rule already there, so the author knows which one to open');

  // The same cell WRITTEN DIFFERENTLY is still the same cell — this is why the check compares the
  // region a predicate reduces to and not the predicate's text.
  const spelt = A.applyIntent({ op: 'add_llpa', code: 'other_name', adjMilli: 125, dimension: 'fico', when: { all: [{ fact: 'fico', op: 'gte', value: 640 }, { fact: 'fico', op: 'lt', value: 660 }] } }, { ruleset: [existing] });
  refusedWith(spelt, 'same_cell', 'the same cell written as two comparisons instead of a band');

  // A name already taken is its own refusal, whatever the rule says.
  const dupName = A.applyIntent({ op: 'add_llpa', code: 'llpa_fico_640', adjMilli: 125, dimension: 'ltv', when: { fact: 'ltv', op: 'lt', value: 70000 } }, { ruleset: [existing] });
  plainlyWorded(refusedWith(dupName, 'duplicate_code', 'a rule name that is already in use here'), 'duplicate code');

  // AND THE CONTROL: editing the live rule is not a collision with itself. Without this, the most
  // ordinary operation in the editor would be a dead end.
  const editing = A.applyIntent({ op: 'add_llpa', code: 'llpa_fico_640', adjMilli: 300, dimension: 'fico', when: { fact: 'fico', op: 'between', value: [640, 660] } },
    { ruleset: [existing], replacingCode: 'llpa_fico_640' });
  ok(editing.ok, 'CONTROL: replacing a live rule with a new version of ITSELF is accepted, not refused as a duplicate');
}

// (B5) an eligibility rule on the same cell as another is NOT refused — declines are collected on
// purpose, and flagging that would cry wolf on correct rules.
{
  const existing = { code: 'no_ny', kind: 'eligibility', declineReason: 'NY not eligible', when: { fact: 'state', op: 'eq', value: 'NY' } };
  const second = A.applyIntent({ op: 'add_eligibility', code: 'ny_condo', declineReason: 'NY condos not eligible', when: { fact: 'state', op: 'eq', value: 'NY' } }, { ruleset: [existing] });
  ok(second.ok, 'two eligibility rules on the same loans are ACCEPTED — a borrower is told both reasons');
  const both = evaluateRules([existing, second.rule], { state: 'NY' });
  ok(both.declines.length === 2, '…and the engine does collect both declines');
}

// (B6) an unreadable intent is refused, not thrown.
{
  ok(A.applyIntent({ op: 'obliterate' }, {}).ok === false, 'an operation the editor does not have is refused');
  ok(A.applyIntent(null, {}).ok === false, 'a missing intent is refused rather than crashing');
  ok(A.applyIntent({ op: 'edit', patch: { code: 'x' } }, {}).refusals[0].code === 'no_rule', 'an edit with no rule to edit says so');
}

// ============================================================================
// C) REPORTED, NOT REFUSED — and never silently dropped.
// ============================================================================
console.log('\nC) the line between refusing and reporting');

{
  // A whole-column rule plus a cell inside it: overlapping, deliberate, ACCEPTED — with a warning.
  const column = { code: 'fico_780_plus', kind: 'pricing', adjustment: { code: 'fico_780_plus', adjMilli: -125, unit: 'points', category: 'fico' }, when: { fact: 'fico', op: 'gte', value: 780 } };
  const cell = A.applyIntent({ op: 'add_llpa', code: 'fico_780_lowltv', adjMilli: -50, dimension: 'fico', when: { all: [{ fact: 'fico', op: 'gte', value: 780 }, { fact: 'ltv', op: 'lt', value: 50000 }] } }, { ruleset: [column] });
  ok(cell.ok, 'a cell inside a whole-column rule is ACCEPTED — that is how a sheet layers');
  ok(cell.warnings.some((w) => w.code === 'overlaps_existing'),
    '…and the overlap is REPORTED, so it is neither refused nor silently dropped');
  ok(cell.warnings.some((w) => w.code === 'overlaps_existing' && /fico_780_plus/.test(w.message)),
    '…naming the rule it overlaps');

  // A predicate the reducer cannot read: accepted, and SAID to be unchecked.
  const cannotRead = A.applyIntent({ op: 'add_llpa', code: 'any_tree', adjMilli: 100, dimension: 'fico', when: { any: [{ fact: 'fico', op: 'lt', value: 640 }, { fact: 'ltv', op: 'gte', value: 80000 }] } }, { ruleset: [column] });
  ok(cannotRead.ok, 'an any/or rule is ACCEPTED — refusing what cannot be read would ban a large part of the engine\'s own vocabulary');
  ok(cannotRead.warnings.some((w) => w.code === 'overlap_not_checked'),
    '…and the screen is TOLD the overlap check did not run on it, rather than shown a silent clean bill of health');
  ok(cannotRead.render.cellReason === 'unanalyzable' && cannotRead.render.cell === null,
    '…and the rendered rule says WHY it has no cell, instead of leaving a blank that reads as nothing-to-report');
}

// ============================================================================
// D) THE COLLISION THAT ALMOST SHIPPED — `op` means two different things.
// ============================================================================
console.log('\nD) the scope spec is nested, and stays nested');

{
  const base = A.applyIntent({ op: 'add_llpa', code: 'x', adjMilli: 100, dimension: 'fico' }, { ruleset: [] }).rule;
  const nested = A.applyIntent({ op: 'scope', scope: { dimension: 'fico', op: 'gte', value: 700 } }, { rule: base, ruleset: [] });
  ok(nested.ok && nested.rule.when.op === 'gte',
    'a scope spec in `intent.scope` carries its own comparison through untouched');
  const flattened = A.applyIntent({ op: 'scope', dimension: 'fico', value: 700 }, { rule: base, ruleset: [] });
  ok(flattened.ok === false && flattened.refusals[0].code === 'no_scope',
    'a FLATTENED scope is refused with an instruction, not accepted and not misread as a comparison called "scope"');
}

// ============================================================================
// E) THE REGION REDUCER now tells its two refusals apart (rule-coverage).
// ============================================================================
console.log('\nE) the reducer distinguishes "cannot read" from "can never fire"');

{
  const empty = coverage.regionDetail({ all: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'fico', op: 'lt', value: 650 }] });
  ok(empty.region === null && empty.reason === 'empty' && empty.fact === 'fico',
    'a contradiction is reported as `empty`, naming the fact');
  const unread = coverage.regionDetail({ any: [{ fact: 'fico', op: 'gte', value: 700 }] });
  ok(unread.region === null && unread.reason === 'unanalyzable', 'an any-tree is reported as `unanalyzable`');
  const none = coverage.regionDetail(null);
  ok(none.region === null && none.reason === 'no_predicate', 'no predicate is reported as `no_predicate`');
  const good = coverage.regionDetail({ fact: 'fico', op: 'between', value: [640, 660] });
  ok(good.region !== null && good.reason === 'ok', 'a readable predicate comes back as a region');

  // `regionOf` is unchanged — the analyzer's behaviour must not move.
  ok(coverage._internals.regionOf({ any: [] }) === null && coverage._internals.regionOf(null) === null,
    'regionOf still returns null everywhere it used to');
  ok(coverage._internals.regionOf({ fact: 'fico', op: 'between', value: [640, 660] }) !== null,
    'regionOf still returns a region where it used to');

  // sameRegion: identical is not the same question as overlapping.
  const a = coverage.regionDetail({ fact: 'fico', op: 'between', value: [640, 660] }).region;
  const b = coverage.regionDetail({ all: [{ fact: 'fico', op: 'gte', value: 640 }, { fact: 'fico', op: 'lt', value: 660 }] }).region;
  const c = coverage.regionDetail({ fact: 'fico', op: 'between', value: [640, 700] }).region;
  ok(coverage.sameRegion(a, b) === true, 'two spellings of one cell are the SAME cell');
  ok(coverage.sameRegion(a, c) === false, 'a cell that merely CONTAINS another is not the same cell');
  ok(coverage.sameRegion(a, null) === false && coverage.sameRegion(null, null) === false,
    'nothing is ever "the same cell" as an unreadable region');
}

// ============================================================================
// F) THE CATALOG a screen builds its pickers from, and the prepayment library.
// ============================================================================
console.log('\nF) the catalog, and the prepayment-penalty library');

{
  ok(A.verifyDimensionLabels().length === 0,
    'every authorable dimension has a human name — a dimension added without one would print a raw fact name at somebody');
  const c = A.catalog();
  ok(c.dimensions.length === Object.keys(require('../src/longterm/ppe/rule-builder').DIMENSIONS).length,
    'the catalog offers exactly the dimensions the builder accepts — a screen built from it cannot offer one that would be refused');
  ok(c.pppStructures.length === ppp.PPP_STRUCTURES.length && c.pppStructures.every((s) => s.key && s.label),
    'the catalog offers every prepayment-penalty structure the library holds, with its label');
  ok(c.dimensions.some((d) => d.name === 'ppp_structure_key'),
    'a rule can be scoped to a prepayment-penalty structure');
  ok(c.intents.length === A.INTENT_OPS.length && c.intents.every((i) => i.label),
    'every authoring operation is offered with a label');

  // The structure library is the source of the allowed values — an invented key is refused.
  const base = A.applyIntent({ op: 'add_margin_holdback', code: 'hb', knob: 'holdback', milli: 200 }, { ruleset: [] }).rule;
  const bad = A.applyIntent({ op: 'scope', scope: { dimension: 'ppp_structure_key', op: 'eq', value: 'not_a_structure' } }, { rule: base, ruleset: [] });
  const r = refusedWith(bad, 'unknown_ppp_structure', 'a prepayment structure the library does not have');
  ok(r && /54321/.test(r.message), '…and the real structures are listed');

  // A real one is accepted, and the two things only the library knows are REPORTED.
  const good = A.applyIntent({ op: 'scope', scope: { dimension: 'ppp_structure_key', op: 'eq', value: '33321' } }, { rule: base, ruleset: [] });
  ok(good.ok, 'a real structure key is accepted');
  ok(good.warnings.some((w) => w.code === 'ppp_holdback_already_applied'),
    'authoring a holdback on a structure that ALREADY carries one is reported — the double charge nobody would otherwise see');
  ok(good.warnings.some((w) => w.code === 'ppp_overlay_only'),
    'a structure Lender Price cannot price says so, so nobody expects a comparison that will never happen');

  // …and a structure that carries neither raises neither, so the warnings mean something.
  const plain = A.applyIntent({ op: 'scope', scope: { dimension: 'ppp_structure_key', op: 'eq', value: '54321' } }, { rule: base, ruleset: [] });
  ok(plain.ok && !plain.warnings.some((w) => w.code === 'ppp_holdback_already_applied' || w.code === 'ppp_overlay_only'),
    'CONTROL: an ordinary, Lender-Price-priceable structure raises neither warning');
}

// ============================================================================
// G) WHAT A SCREEN RENDERS — and that it says a draft is not live.
// ============================================================================
console.log('\nG) the render a screen draws');

{
  const out = A.applyIntent({ op: 'add_llpa', code: 'llpa_ltv_high', adjMilli: 500, dimension: 'ltv', when: { fact: 'ltv', op: 'between', value: [75000, 80000] } }, { ruleset: [] });
  const v = out.render;
  ok(/LTV/.test(v.headline) && /add 0\.500 points/.test(v.headline), 'the headline reads as a sentence, with the amount in points');
  ok(/75\.000% \(75000\)/.test(v.whenText),
    'a milli value is shown in per cent WITH the raw number beside it — a conversion that hides its input is how somebody types 80 into a box that wants 80000');
  ok(v.scope.length === 1 && v.scope[0].dimension === 'ltv' && v.scope[0].label === 'LTV', 'the scope is broken out for the screen, by human name');
  ok(v.cell === 'ltv [75000, 80000)', 'the cell it reduces to is reported in the house\'s own half-open notation');
  ok(v.live === false && /prices nothing/.test(v.liveNote),
    'the render SAYS the rule is not live — authoring is not publishing, and the screen has to be able to say so');

  const everyLoan = A.applyIntent({ op: 'add_llpa', code: 'base_adj', adjMilli: 100, dimension: 'base' }, { ruleset: [] });
  ok(everyLoan.render.appliesToEveryLoan === true && /every loan/.test(everyLoan.render.headline),
    'a rule with no conditions says plainly that it applies to every loan');
}

// ============================================================================
// H) NOTHING IS MUTATED, AND NOTHING IS THROWN AT A SCREEN.
// ============================================================================
console.log('\nH) immutability and never-throws');

{
  const rule = A.applyIntent({ op: 'add_llpa', code: 'imm', adjMilli: 100, dimension: 'fico', when: { fact: 'fico', op: 'gte', value: 700 } }, { ruleset: [] }).rule;
  const before = JSON.stringify(rule);
  A.applyIntent({ op: 'scope', scope: { dimension: 'ltv', op: 'lt', value: 70000 } }, { rule, ruleset: [] });
  ok(JSON.stringify(rule) === before, 'authoring from a rule never mutates it');
  ok(Object.isFrozen(rule) && Object.isFrozen(rule.adjustment), 'an authored rule is deep-frozen, so a caller cannot edit it behind the service\'s back');

  let threw = false;
  for (const junk of [undefined, null, 0, 'x', [], { op: 'create' }, { op: 'create', rule: 'no' }, { op: 'scope', scope: [] }]) {
    try { A.applyIntent(junk, { ruleset: [] }); } catch (_) { threw = true; }
  }
  ok(!threw, 'no shape of junk makes the service throw — a screen gets a refusal it can display, never a stack trace');
}

console.log(`\n${failures ? `FAILURES: ${failures}` : 'all passed'}`);
process.exit(failures ? 1 : 0);
