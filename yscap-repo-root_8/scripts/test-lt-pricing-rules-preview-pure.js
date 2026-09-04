'use strict';
/**
 * LONG-TERM — CAN THE RULE BUILDER ACTUALLY TRY THE RULE YOU JUST WROTE?
 *
 * Owner-directed 2026-09-04: the Rule Center should be *"a little more modern, a
 * little more user-friendly, and a little more simple"*.
 *
 * ── THE DEFECT THIS GUARDS ─────────────────────────────────────────────────
 *
 * The builder's *"try it before you turn it on"* panel offered FOUR boxes —
 * state, loan amount, prepayment months, DSCR — while the rule grammar reads
 * FORTY-EIGHT scenario and property facts. So a rule about FICO, LTV, property
 * type, citizenship, units or a credit event was tried against a loan that
 * stated none of them, answered "It does not match this loan", and read as the
 * rule being broken. The one thing the panel exists to do, it could not do for
 * most rules.
 *
 * ⛔ THE FIX IS A PUBLISHED MAP, NOT A LONGER LIST OF BOXES. A fact's name is
 * not the name of the box that fills it (`loan_amount` ← `loan`,
 * `property_value` ← `value`, `bankruptcy_chapter` ← `bankruptcy.chapter`), so
 * a builder that grew its own copy of those spellings would be a SECOND
 * definition — and a drifted copy tests a different loan than the boxes on
 * screen describe, with total confidence. Worse than no preview.
 *
 * ── WHAT THIS FILE PROVES, AND WHY IT IS NOT A LIST CHECK ───────────────────
 *
 * Asserting "the map has 46 entries" proves nothing: a wrong spelling has an
 * entry too. So every entry is EXERCISED — the probe value is put at the mapped
 * path and `scenarioFacts` / `quoteFacts` are RUN — which is the only thing that
 * can tell a correct mapping from a plausible one.
 *
 * PURE: no database, no network, no clock.
 */

const assert = require('assert');
const pathMod = require('path');
const fields = require('../src/longterm/pricing/rules/fields');
const facts = require('../src/longterm/pricing/rules/facts');
const sampleRow = require('../src/longterm/pricing/rules/sample-row');
/* The screen's own derivation, loaded from the browser module it really uses —
   never a copy written for the test, which would prove only that the copy
   works. It is an ES module, so it is read and evaluated rather than required. */
const rs = (() => {
  const src = require('fs').readFileSync(
    pathMod.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'ruleSample.js'), 'utf8');
  const cjs = src.replace(/^export function /gm, 'function ')
    + '\nmodule.exports = { fieldsUsedBy, previewBoxes, putAt, buildSample };';
  const m = { exports: {} };
  new Function('module', 'exports', cjs)(m, m.exports);
  return m.exports;
})();

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass += 1; } else { fail += 1; console.log('  FAIL ' + what); } };
const eq = (a, b, what) => ok(a === b, what + ' — got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b));

/** A value a person could plausibly type into a box of this field's type. */
function probeFor(f) {
  switch (f.type) {
    case 'boolean': return true;
    case 'money': return 250000;
    case 'pct': return 65;
    case 'number': return 7;
    case 'enum': return (f.options && f.options[0] && f.options[0].v) || 'x';
    default: return 'probe';
  }
}

console.log('\nA. Every scenario fact is either typeable or named as worked-out');
{
  const mapped = Object.keys(facts.SCENARIO_INPUT);
  const derived = Object.keys(facts.DERIVED_SCENARIO_FACTS);

  for (const key of fields.SCENARIO_KEYS) {
    const isMapped = Object.prototype.hasOwnProperty.call(facts.SCENARIO_INPUT, key);
    const isDerived = derived.includes(key);
    ok(isMapped || isDerived,
      'A1 ' + key + ' is either given a box or named as worked-out');
    ok(!(isMapped && isDerived),
      'A2 ' + key + ' is not both typeable and worked-out');
  }

  /* THE OTHER DIRECTION, so the map cannot name a field the grammar dropped —
     a box for a fact no rule can read is a box that does nothing. */
  for (const key of mapped) {
    ok(fields.SCENARIO_KEYS.includes(key), 'A3 ' + key + ' is a real scenario field');
  }
  for (const key of derived) {
    ok(fields.SCENARIO_KEYS.includes(key), 'A4 ' + key + ' is a real scenario field');
  }

  /* The count is stated so the shortfall this fixes stays legible: the panel
     used to offer four of these. */
  ok(fields.SCENARIO_KEYS.length >= 40,
    'A5 the grammar really does read dozens of scenario facts (' + fields.SCENARIO_KEYS.length + ')');
}

console.log('\nB. Every box actually fills the fact it claims to fill');
{
  for (const [factKey, path] of Object.entries(facts.SCENARIO_INPUT)) {
    const f = fields.BY_KEY[factKey];
    const probe = probeFor(f);
    const scenario = facts.putAtPath({}, path, probe);
    const bag = facts.scenarioFacts(scenario);

    /* NOT "is it non-null" — that would pass on a mapping that filled the WRONG
       fact and left this one to some default. The typed value has to arrive
       HERE, as itself. */
    const got = bag[factKey];
    if (f.type === 'boolean') {
      eq(got, true, 'B1 ' + factKey + ' ← ' + path);
    } else if (f.type === 'money' || f.type === 'pct' || f.type === 'number') {
      eq(got, probe, 'B1 ' + factKey + ' ← ' + path);
    } else {
      eq(String(got == null ? '' : got).toLowerCase(), String(probe).toLowerCase(),
        'B1 ' + factKey + ' ← ' + path);
    }
  }
}

console.log('\nC. A fact nobody can type is not quietly typeable');
{
  for (const [key, from] of Object.entries(facts.DERIVED_SCENARIO_FACTS)) {
    /* Setting a box of the fact's OWN name must do nothing — if it worked, the
       fact belongs in the map, and leaving it out would deny somebody a box
       that would have worked. */
    const bag = facts.scenarioFacts({ [key]: 'A' });
    eq(bag[key], null, 'C1 ' + key + ' cannot be set directly');

    /* AND IT NAMES A BOX THAT REALLY EXISTS. This is the half that keeps a
       rule written purely on a worked-out fact testable: the builder follows
       these back and offers those boxes instead. A name that led nowhere would
       leave that rule exactly as broken as before, while looking handled. */
    ok(Array.isArray(from) && from.length > 0, 'C1b ' + key + ' says what it follows from');
    for (const src of (from || [])) {
      ok(Object.prototype.hasOwnProperty.call(facts.SCENARIO_INPUT, src),
        'C1c ' + key + ' follows from ' + src + ', which has a box');
    }
  }

  /* And they really ARE worked out from boxes that exist, or naming them as
     derived would be an excuse rather than a reason. */
  eq(facts.scenarioFacts({ dscr: 1.4 }).dscr_band != null, true,
    'C2 the DSCR band follows the DSCR you type');
  eq(facts.scenarioFacts({ prepayMonths: 60 }).has_prepay, true,
    'C3 having a prepayment penalty follows the months you type');
  eq(facts.scenarioFacts({ prepayMonths: 0 }).has_prepay, false,
    'C4 zero months means there is no penalty');
  eq(facts.scenarioFacts({}).has_prepay, null,
    'C5 saying nothing about a penalty is not saying there is none');
}

console.log('\nD. The quote half, exercised the same way');
{
  /* THE TWO MAPS MAY NOT OVERLAP. The builder asks the loan/property map first,
     so a fact in both would have its quote box silently unreachable — a box
     that exists in one map and never renders. They are disjoint by construction
     (a field's `source` puts it in one or the other), which is exactly the kind
     of "cannot happen" worth pinning, because it stops being true the day
     somebody adds a fact by hand to the wrong map. */
  for (const k of Object.keys(sampleRow.QUOTE_INPUT)) {
    ok(!Object.prototype.hasOwnProperty.call(facts.SCENARIO_INPUT, k),
      'D2 ' + k + ' is in exactly one map');
  }

  for (const [factKey, inputKey] of Object.entries(sampleRow.QUOTE_INPUT)) {
    const f = fields.BY_KEY[factKey];
    ok(!!f, 'D0 ' + factKey + ' is a real field');
    if (!f) continue;
    const probe = probeFor(f);
    const row = sampleRow.sampleRow({ [inputKey]: probe });
    const bag = facts.quoteFacts(row, null, {});
    const got = bag[factKey];
    if (f.type === 'money' || f.type === 'pct' || f.type === 'number') {
      eq(got, probe, 'D1 ' + factKey + ' ← ' + inputKey);
    } else {
      eq(String(got == null ? '' : got).toLowerCase(), String(probe).toLowerCase(),
        'D1 ' + factKey + ' ← ' + inputKey);
    }
  }
}

console.log('\nE. A blank box is NOT STATED, never a quoted zero');
{
  /* `Number('')` is 0 and 0 is finite — the recurring hazard in this codebase,
     and the route this replaced had it. A rule reading "note rate is less than
     7" must not fire on a rate nobody typed. */
  const blank = facts.quoteFacts(sampleRow.sampleRow({ noteRate: '' }), null, {});
  eq(blank.note_rate, null, 'E1 a blank note rate is not stated');

  const blankLtv = facts.quoteFacts(sampleRow.sampleRow({ quotedLtv: '' }), null, {});
  eq(blankLtv.quoted_ltv, null, 'E2 a blank quoted LTV is not stated');

  const zero = facts.quoteFacts(sampleRow.sampleRow({ noteRate: 0 }), null, {});
  eq(zero.note_rate, 0, 'E3 a rate somebody really typed as 0 is 0');

  const junk = facts.quoteFacts(sampleRow.sampleRow({ quotedDscr: 'n/a' }), null, {});
  eq(junk.quoted_dscr, null, 'E4 an unreadable number is not stated');
}

console.log('\nF. The sample the preview starts from reads correctly');
{
  const bag = facts.quoteFacts(sampleRow.sampleRow({}), null, {});
  eq(bag.price, 100, 'F1 the sample is priced at par, so a holdback’s effect is checkable in your head');
  eq(bag.points, 0, 'F2 the sample carries no points to start with');
  eq(bag.note_rate, null, 'F3 an unstated rate stays unstated');
  ok(typeof bag.program_name === 'string' && bag.program_name.length > 0,
    'F4 the sample names itself, so nobody reads it as a live quote');
}

console.log('\nH. The boxes a rule needs, worked out and asserted');
{
  /* THE ARITHMETIC, RUN. Sections A–D prove the MAP is right; only this proves
     the builder turns a rule into the right boxes. A source guard over the
     screen could never see it — the repo has learned that twice — so the
     derivation is a plain module and this calls it. */
  const cat = {
    scenarioInput: facts.SCENARIO_INPUT,
    quoteInput: sampleRow.QUOTE_INPUT,
    derivedFacts: facts.DERIVED_SCENARIO_FACTS,
  };
  const boxesFor = (when) => rs.previewBoxes(rs.fieldsUsedBy(when), cat, fields.BY_KEY);
  const keys = (bs) => bs.map((b) => b.factKey);

  /* The owner's own worked example: LoanNEX + New Jersey + a loan under an
     amount + a prepayment penalty. Four conditions, and the old panel could
     state exactly two of them. */
  const ownerRule = { combinator: 'and', rules: [
    { field: 'source', operator: 'eq', value: 'loannex' },
    { field: 'state', operator: 'eq', value: 'NJ' },
    { field: 'loan_amount', operator: 'lt', value: 250000 },
    { field: 'has_prepay', operator: 'is_true' },
  ] };
  const ob = boxesFor(ownerRule);
  ok(keys(ob).includes('state'), 'H1 the state it names gets a box');
  ok(keys(ob).includes('loan_amount'), 'H2 the loan amount it names gets a box');
  ok(keys(ob).includes('prepay_months') && keys(ob).includes('prepay_structure'),
    'H3 "has a prepayment penalty" is worked out, so the boxes that make it appear');
  ok(!keys(ob).includes('has_prepay'), 'H4 …and the worked-out fact itself gets no box of its own');
  /* THE RATE SHEET GETS A BOX, and that is the owner's own worked example
     ("if the pricing is being pulled from LoanNEX") — it is a fact about the
     quote, so it is stated on the quote. What gets NO box is `engine`, which
     the panel asks for separately as the board to run against; a box for it
     would be a second, contradictable answer to the same question. */
  const srcBox = ob.find((b) => b.factKey === 'source');
  ok(srcBox && srcBox.where === 'quote', 'H5 the rate sheet is stated on the quote');
  const engineBox = boxesFor({ combinator: 'and', rules: [{ field: 'engine', operator: 'eq', value: 'general' }] });
  eq(engineBox.length, 0, 'H5b the board is asked for separately, so it draws no second box');

  /* A rule the OLD panel could not state one word of. */
  const ficoRule = { combinator: 'and', rules: [
    { field: 'fico', operator: 'lt', value: 700 },
    { field: 'property_type', operator: 'eq', value: 'condo' },
    { field: 'citizenship', operator: 'eq', value: 'foreign_national' },
  ] };
  eq(keys(boxesFor(ficoRule)).join(','), 'fico,property_type,citizenship',
    'H6 a rule the old four boxes could not describe at all');

  /* Nesting, and no repeats. */
  const nested = { combinator: 'and', rules: [
    { field: 'fico', operator: 'lt', value: 700 },
    { combinator: 'or', rules: [
      { field: 'state', operator: 'eq', value: 'NJ' },
      { field: 'fico', operator: 'gt', value: 600 },
    ] },
  ] };
  eq(keys(boxesFor(nested)).join(','), 'fico,state', 'H7 a group inside a group, each field once');

  eq(boxesFor({ combinator: 'and', rules: [] }).length, 0, 'H8 an empty rule asks for nothing');
  eq(rs.fieldsUsedBy(null).length, 0, 'H9 a rule that is not there is not a crash');
  eq(boxesFor({ combinator: 'and', rules: [{ field: 'not_a_field', operator: 'eq', value: 1 }] }).length, 0,
    'H10 a field the registry does not have draws no box');

  /* A quote-side field routes to the quote, not the loan. */
  const qb = boxesFor({ combinator: 'and', rules: [{ field: 'quoted_ltv', operator: 'gt', value: 70 }] });
  eq(qb.length && qb[0].where, 'quote', 'H11 a fact about the quote is filled on the quote');
}

console.log('\nI. What the boxes build is what the door takes');
{
  const cat = {
    scenarioInput: facts.SCENARIO_INPUT,
    quoteInput: sampleRow.QUOTE_INPUT,
    derivedFacts: facts.DERIVED_SCENARIO_FACTS,
  };
  const when = { combinator: 'and', rules: [
    { field: 'fico', operator: 'lt', value: 700 },
    { field: 'state', operator: 'eq', value: 'NJ' },
    { field: 'bankruptcy_chapter', operator: 'eq', value: '7' },
    { field: 'rural', operator: 'is_true' },
    { field: 'quoted_ltv', operator: 'gt', value: 70 },
  ] };
  const boxes = rs.previewBoxes(rs.fieldsUsedBy(when), cat, fields.BY_KEY);

  const built = rs.buildSample(boxes, {
    fico: '680', state: 'NJ', bankruptcy_chapter: '7', rural: 'yes', quoted_ltv: '75',
  });

  /* END TO END: through the SAME `scenarioFacts` and the SAME row builder the
     door uses, so what the person typed is what the rule is judged on. */
  const bag = facts.factsFor(facts.scenarioFacts(built.scenario), sampleRow.sampleRow(built.quote), null, {});
  eq(bag.fico, 680, 'I1 a number typed as text arrives as a number');
  eq(bag.state, 'NJ', 'I2 the state arrives');
  eq(bag.bankruptcy_chapter, '7', 'I3 a nested box arrives (bankruptcy.chapter)');
  eq(bag.rural, true, 'I4 a yes/no box arrives as a real yes');
  eq(bag.quoted_ltv, 75, 'I5 a quote-side box arrives on the quote');

  /* AND THE THREE-STATE RULE. Not stated is not "no". */
  const noneStated = rs.buildSample(boxes, {});
  const emptyBag = facts.factsFor(facts.scenarioFacts(noneStated.scenario),
    sampleRow.sampleRow(noneStated.quote), null, {});
  eq(emptyBag.rural, null, 'I6 leaving the yes/no box alone says nothing, it does not say no');
  eq(emptyBag.fico, null, 'I7 an untouched number is not a quoted zero');
  eq(Object.keys(noneStated.scenario).length, 0, 'I8 nothing typed sends nothing');

  const saidNo = rs.buildSample(boxes, { rural: 'no' });
  eq(facts.scenarioFacts(saidNo.scenario).rural, false, 'I9 saying no really says no');

  /* ⛔ AN EMPTIED BOX IS AN EMPTY STRING, NOT `undefined` — and that is the case
     that matters, because it is the ONLY blank the screen can produce: a person
     types 700 into FICO, changes their mind and deletes it, and `SampleInput`
     hands back `''`. The first cut of this section only ever passed an empty
     OBJECT, so `raw` was `undefined` and the realistic path was never walked:
     a mutation that stopped skipping `''` sailed straight through with the
     suite green, while sending FICO as a quoted 0 (`Number('') === 0`, finite)
     and a cleared yes/no as an explicit "no". Both would have shipped.

     Test the blank your own screen actually makes. */
  const cleared = rs.buildSample(boxes, {
    fico: '', state: '', bankruptcy_chapter: '', rural: '', quoted_ltv: '',
  });
  eq(Object.keys(cleared.scenario).length, 0, 'I11 an emptied box sends nothing at all');
  eq(Object.keys(cleared.quote).length, 0, 'I12 …on the quote side too');

  const clearedBag = facts.factsFor(facts.scenarioFacts(cleared.scenario),
    sampleRow.sampleRow(cleared.quote), null, {});
  eq(clearedBag.fico, null, 'I13 an emptied number is not a quoted zero');
  eq(clearedBag.rural, null, 'I14 an emptied yes/no is not a quiet "no"');
  eq(clearedBag.quoted_ltv, null, 'I15 an emptied quote box is not a quoted zero');

  /* AND ONLY A REAL YES IS A YES. `raw !== 'no'` reads every other value —
     including a blank, and including anything a future control might hand
     back — as a yes, which on a rule like "is not rural" flips the answer. */
  const oddly = rs.buildSample(boxes, { rural: 'maybe' });
  eq(facts.scenarioFacts(oddly.scenario).rural, false,
    'I16 a value that is not a yes is not read as one');

  const junk = rs.buildSample(boxes, { fico: 'seven hundred' });
  eq(Object.prototype.hasOwnProperty.call(junk.scenario, 'fico'), false,
    'I10 a number nobody can read is not sent as a guess');
}

console.log('\nG. The builder is handed the maps rather than guessing them');
{
  const fs = require('fs');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const route = strip(fs.readFileSync(require.resolve('../src/longterm/routes/pricing-rules.js'), 'utf8'));
  ok(/scenarioInput:\s*facts\.SCENARIO_INPUT/.test(route), 'G1 the catalog publishes the loan/property map');
  ok(/quoteInput:\s*sampleRow\.QUOTE_INPUT/.test(route), 'G2 the catalog publishes the quote map');
  ok(/derivedFacts:\s*facts\.DERIVED_SCENARIO_FACTS/.test(route), 'G3 the catalog names the worked-out facts');
  ok(/sampleRow\.sampleRow\(/.test(route), 'G4 the preview builds its row with the shared builder');

  /* BOTH DOORS, ONE BUILDER. The preview and the fire drill each carried their
     own copy of the row literal, so the two could answer differently about the
     same typed quote — and one of them silently read a blank as a quoted zero.
     Counting the calls is what stops a third door growing a third copy. */
  const builds = (route.match(/sampleRow\.sampleRow\(/g) || []).length;
  ok(builds >= 2, 'G4b every door that needs a sample row asks the builder for one (' + builds + ')');
  ok(!/priceBuild:\s*\{/.test(route), 'G4c neither door hand-builds a price');
  ok(!/borrowerPaidPoints:/.test(route), 'G4d neither door hand-builds the points');

  /* The screen may not carry its own copy of either map — that is the whole
     safety property, and a source check is the only thing that can see it. */
  const screen = strip(fs.readFileSync(
    require.resolve('../app-v2/src/longterm/LtPricingRules.jsx'), 'utf8'));
  /* MATCHED AS A WORD, NOT AS A QUOTED STRING — and that distinction is the
     whole guard. The first cut of this check looked for `'prepayMonths'` in
     quotes, so the mutation that matters walked straight through it: the box
     names came back the way they were written in the first place, as OBJECT
     KEYS (`{ state: 'NJ', prepayMonths: 60 }`), which carry no quotes at all.
     A guard that cannot catch the defect being restored is worse than none,
     because the next person budgets against it.

     The names checked are the distinctive ones. `loan` and `state` are
     deliberately absent: they are ordinary English and ordinary React, so
     matching them would fail on prose and get the whole guard deleted. */
  for (const spelling of [
    'prepayMonths', 'cashoutAmount', 'subordinateLoanAmount', 'firstTimeInvestor',
    'quotedLtv', 'asIsValue', 'propertyType', 'loanAmount',
  ]) {
    ok(!new RegExp('\\b' + spelling + '\\b').test(screen),
      'G5 the screen does not re-type the box name ' + spelling);
  }
  /* THE DERIVATION MOVED OUT OF THE SCREEN, so the check follows it: sections H
     and I run that module for real, and these two only hold that it reads the
     SERVER's maps rather than growing its own. A guard left pointing at the old
     file would have gone green on an empty screen. */
  const derive = strip(fs.readFileSync(
    require.resolve('../app-v2/src/longterm/ruleSample.js'), 'utf8'));
  ok(/cat\.scenarioInput/.test(derive), 'G6 the derivation reads the published loan/property map');
  ok(/cat\.quoteInput/.test(derive), 'G7 the derivation reads the published quote map');
  ok(/cat\.derivedFacts/.test(derive), 'G7b …and the published list of worked-out facts');
  ok(/from '\.\/ruleSample\.js'/.test(screen), 'G7c the screen uses that module rather than its own copy');
  for (const spelling of ['prepayMonths', 'cashoutAmount', 'quotedLtv', 'asIsValue', 'loanAmount']) {
    ok(!new RegExp('\\b' + spelling + '\\b').test(derive),
      'G7d the derivation does not re-type the box name ' + spelling);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
