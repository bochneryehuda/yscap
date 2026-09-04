'use strict';
/**
 * LONG-TERM — THE PRICING RULE CENTER, WITHOUT A DATABASE.
 *
 * The centre ships EMPTY, so the property that matters most is the one asserted
 * first: with no rules every board is byte-for-byte what it is today. Everything
 * after that is about the three ways a rule centre goes wrong quietly —
 *
 *   • a drop-down whose values are not real, so a rule can be built, saved, and
 *     never match (the DSCR band shipped this way in the first cut: all eleven
 *     options came out as the string "undefined");
 *   • a rule read against the WRONG registry, so it evaluates one way and PRINTS
 *     another (the first cut of `summarize` did exactly this and dropped every
 *     row whose field only exists in this product);
 *   • an overlay applied at the wrong point in the board, so an investor OUR
 *     rules refuse is reported as one the rate sheet failed to price.
 *
 * PURE: no database, no network. Every module here takes its data as arguments.
 *
 * ⛔ EVERY READ IN HERE IS TOTAL — `(out.programs[0] || {})`, never
 * `out.programs[0].x`. A mutation that empties a list would otherwise CRASH this
 * battery rather than failing it, and a crash stops the run where it stands and
 * reports a pass count that means nothing. Measured: making an unreadable rule
 * fire failed five assertions and then threw on the sixth, which is exactly the
 * "a crashing test also fails, and looks like proof" trap.
 */

const fs = require('fs');
const path = require('path');

const fields = require('../src/longterm/pricing/rules/fields');
const logic = require('../src/longterm/pricing/rules/logic');
const actions = require('../src/longterm/pricing/rules/actions');
const facts = require('../src/longterm/pricing/rules/facts');
const overlay = require('../src/longterm/pricing/rules/overlay');

let pass = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, a, b) => ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/**
 * Comments are STRIPPED before every "must not appear" check: the code that
 * removes a thing necessarily names it in the comment that explains why, and a
 * guard reading comments fails on its own explanation and is then "fixed" by
 * deleting the explanation.
 *
 * ⛔ IT IS A SCANNER, NOT TWO REGULAR EXPRESSIONS, and that is not fastidiousness.
 * The obvious pair — strip `/*…*\/`, then strip `//…` — DELETED THE WHOLE OF
 * `src/longterm/index.js`: one line comment in that file contains the characters
 * that open a block comment, so the block pass matched from there to a `*\/`
 * hundreds of lines later and swallowed every mount in between. The three wiring
 * guards then reported "the rule centre is not mounted" about a file that mounts
 * it on line 242. A guard that fails for its own reason is worse than no guard,
 * because the next person deletes it.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; continue; }
    if (c === '/' && d === '/') { const end = text.indexOf('\n', i); i = end === -1 ? n : end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      // A quoted string may contain either comment opener; skip it whole.
      out += c; i++;
      while (i < n && text[i] !== c) { if (text[i] === '\\') { out += text[i]; i++; } out += text[i]; i++; }
      out += text[i] || ''; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nA. THE FIELDS A RULE MAY ASK ABOUT');
// ═══════════════════════════════════════════════════════════════════════════

ok('A1  there are fields at all', fields.KEYS.length > 30, `${fields.KEYS.length}`);
ok('A2  every key is unique', new Set(fields.KEYS).size === fields.KEYS.length);

{
  const bad = fields.FIELDS.filter((f) => !f.label || !f.type || !f.group || !f.source);
  ok('A3  every field is labelled, typed, grouped and sourced', !bad.length, bad.map((f) => f.key).join(', '));
}

{
  /* ⛔ THE BUG THIS EXISTS FOR. The DSCR band options were built from `t.key` /
     `t.label`, which the ladder does not carry, so every one of the eleven came
     out as the string "undefined": eleven identical options, a rule that saves,
     and a rule that can never match. A drop-down whose values collide is
     indistinguishable from a working one on the screen. */
  const enums = fields.FIELDS.filter((f) => f.type === 'enum');
  ok('A4  every drop-down actually has options', enums.every((f) => Array.isArray(f.options) && f.options.length),
    enums.filter((f) => !(f.options || []).length).map((f) => f.key).join(', '));
  const collide = enums.filter((f) => new Set((f.options || []).map((o) => o.v)).size !== (f.options || []).length);
  ok('A5  no drop-down has two options with the same value', !collide.length, collide.map((f) => f.key).join(', '));
  const undef = enums.filter((f) => (f.options || []).some((o) => o.v === 'undefined' || o.v === 'null' || o.v === ''));
  ok('A6  no drop-down offers "undefined"', !undef.length, undef.map((f) => f.key).join(', '));
}

{
  /* THE OPTIONS ARE DERIVED, and this is the proof rather than the intention: the
     property-type list has to BE the pricing registry's list, or a rule can name
     a property type the engine has never heard of. */
  const lp = require('../src/longterm/lenderprice/field-registry');
  const declared = new Set((fields.BY_KEY.property_type.options || []).map((o) => o.v));
  const real = [...(lp.PROPERTY_TYPES instanceof Set ? lp.PROPERTY_TYPES : Object.keys(lp.PROPERTY_TYPES || {}))];
  ok('A7  the property types are the pricing registry\'s own', real.length > 0 && real.every((v) => declared.has(String(v))),
    real.filter((v) => !declared.has(String(v))).join(', '));

  const dt = require('../src/longterm/pricing/dscr-tiers');
  const bands = (fields.BY_KEY.dscr_band.options || []).map((o) => o.v);
  eq('A8  there is one band option per DSCR tier', bands.length, dt.DSCR_TIERS.length);
  ok('A9  every band is labelled by the ladder itself',
    (fields.BY_KEY.dscr_band.options || []).every((o) => o.label === dt.tierLabel(Number(o.v))));
}

{
  /* ⛔ EVERY SCENARIO FIELD MUST BE ONE THE PRICER HONOURS. A field the route
     would 422 as unsupported is a field no search can ever state, so a rule about
     it silently never matches. The pricer's own set is the authority. */
  const route = require('../src/longterm/routes/dscr-pricer');
  const supported = route.SUPPORTED_FIELDS;
  /* The rule field is our own name; what has to exist upstream is the SCENARIO
     KEY the fact bag reads it from. `facts.js` is the map, so the check is that
     every scenario-sourced field is filled from at least one supported key. */
  const bag = facts.scenarioFacts(Object.fromEntries([...supported].map((k) => [k, k === 'bankruptcy' ? { chapter: 'x' } : 'x'])));
  const unreachable = fields.SCENARIO_KEYS.filter((k) => bag[k] === undefined);
  ok('A10 every scenario field is one the fact bag actually fills', !unreachable.length, unreachable.join(', '));

  const blank = facts.scenarioFacts({});
  const missingFromEmpty = fields.SCENARIO_KEYS.filter((k) => !(k in blank));
  ok('A11 …and is present (as null) even when the search says nothing', !missingFromEmpty.length, missingFromEmpty.join(', '));
}

{
  const q = facts.quoteFacts({}, {}, {});
  const missing = fields.FIELDS.filter((f) => (f.source === 'quote' || f.source === 'engine') && !(f.key in q));
  ok('A12 every quote field is one the fact bag fills', !missing.length, missing.map((f) => f.key).join(', '));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nB. READING A RULE');
// ═══════════════════════════════════════════════════════════════════════════

const NJ_PREPAY = {
  combinator: 'and',
  rules: [
    { field: 'state', operator: 'eq', value: 'NJ' },
    { field: 'has_prepay', operator: 'is_true' },
    { field: 'loan_amount', operator: 'lt', value: 250000 },
  ],
};

eq('B1  a real rule validates', logic.validate(NJ_PREPAY).length, 0);
ok('B2  an empty rule is refused', logic.validate({}).length === 1);
ok('B3  a rule naming a field we do not have is refused',
  logic.validate({ combinator: 'and', rules: [{ field: 'nope', operator: 'eq', value: 1 }] }).length > 0);
ok('B4  a rule using an operator the type does not take is refused',
  logic.validate({ combinator: 'and', rules: [{ field: 'state', operator: 'gt', value: 'NJ' }] }).length > 0);

eq('B5  it matches when it should', logic.matches(NJ_PREPAY, { state: 'NJ', has_prepay: true, loan_amount: 100000 }), true);
eq('B6  it does not match when it should not', logic.matches(NJ_PREPAY, { state: 'NY', has_prepay: true, loan_amount: 100000 }), false);
eq('B7  an unreadable tree answers "cannot tell", never true', logic.matches(null, {}), null);
eq('B8  …and never false either', logic.matches({}, {}), null);

{
  /* ⛔ THE REGISTRY BUG. `summarizeRule` takes an OPTIONS object; handing it the
     bare registry is not an error — it falls back to the SHORT-TERM registry and
     silently drops every row whose field exists only here. Measured on the first
     cut: this three-row rule printed as "Loan amount is less than $250,000",
     because `loan_amount` is the one key both registries happen to carry. A rule
     that reads correctly and PRINTS a different rule is the worst kind of wrong. */
  const said = logic.summarize(NJ_PREPAY);
  ok('B9  the sentence names the state row', /state/i.test(said), said);
  ok('B10 …the loan-amount row', /loan amount/i.test(said), said);
  ok('B11 …and the prepayment row', /prepayment/i.test(said), said);
}

{
  const nested = { combinator: 'and', rules: [
    { field: 'state', operator: 'in', value: ['NJ', 'NY'] },
    { combinator: 'or', rules: [{ field: 'source', operator: 'eq', value: 'loannex' }, { field: 'units', operator: 'gte', value: 3 }] },
  ] };
  eq('B12 a nested rule validates', logic.validate(nested).length, 0);
  eq('B13 …and reads correctly', logic.matches(nested, { state: 'NY', source: 'loannex', units: 1 }), true);
  eq('B14 …both ways', logic.matches(nested, { state: 'NY', source: 'lenderprice', units: 1 }), false);
  ok('B15 …and prints both halves', /NJ/.test(logic.summarize(nested)) && /loannex/i.test(logic.summarize(nested)),
    logic.summarize(nested));
}

{
  /* A BLANK IS NOT A ZERO. The owner's own worked example is "cash out is more
     than 250,000" — on a purchase with no cash out it must not fire. */
  const cash = { combinator: 'and', rules: [{ field: 'cashout_amount', operator: 'gt', value: 250000 }] };
  eq('B16 a rule about cash out does not fire on a loan with none',
    logic.matches(cash, facts.scenarioFacts({ purpose: 'Purchase', loan: 400000 })), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC. WHAT A RULE MAY DO');
// ═══════════════════════════════════════════════════════════════════════════

eq('C1  a holdback with points validates', actions.validate([{ type: 'add_holdback', points: 0.25 }]).length, 0);
ok('C2  an unknown verb is refused', actions.validate([{ type: 'nope' }]).length > 0);
ok('C3  zero points is refused, never accepted as a no-op', actions.validate([{ type: 'add_holdback', points: 0 }]).length > 0);
ok('C4  a negative is refused', actions.validate([{ type: 'discount', points: -1 }]).length > 0);
ok('C5  more than the limit is refused', actions.validate([{ type: 'discount', points: actions.MAX_POINTS + 1 }]).length > 0);
ok('C6  marking ineligible without a reason is refused', actions.validate([{ type: 'ineligible' }]).length > 0);
eq('C7  …and with one it validates', actions.validate([{ type: 'ineligible', reason: 'Not licensed in NJ' }]).length, 0);
ok('C8  blocking an investor without a reason is refused', actions.validate([{ type: 'block_investor' }]).length > 0);
ok('C9  a rule cannot stop a quote two ways at once',
  actions.validate([{ type: 'ineligible', reason: 'a' }, { type: 'block_investor', reason: 'b' }]).length > 0);
ok('C10 an empty list is refused', actions.validate([]).length > 0);

eq('C11 a holdback keeps money back (negative on the client\'s side)', actions.netPoints([{ type: 'add_holdback', points: 0.5 }]), -0.5);
eq('C12 a discount gives it to the client', actions.netPoints([{ type: 'discount', points: 0.5 }]), 0.5);
eq('C13 a credit gives it to the client', actions.netPoints([{ type: 'credit', points: 0.25 }]), 0.25);
eq('C14 reducing a holdback gives it back', actions.netPoints([{ type: 'reduce_holdback', points: 0.25 }]), 0.25);
eq('C15 two money actions in one rule add up', actions.netPoints([{ type: 'add_holdback', points: 0.5 }, { type: 'discount', points: 0.25 }]), -0.25);
eq('C16 a stop moves no money', actions.netPoints([{ type: 'ineligible', reason: 'x' }]), 0);
ok('C17 the stopping action is found', (actions.stopAction([{ type: 'add_holdback', points: 1 }, { type: 'ineligible', reason: 'x' }]) || {}).type === 'ineligible');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nD. THE OVERLAY — WITH NO RULES IT CHANGES NOTHING');
// ═══════════════════════════════════════════════════════════════════════════

const boardOf = () => ([
  { investorKey: 'acra', whiteLabel: 'Vermilion', lender: 'Acra', program: 'DSCR 30', options: [
    { priceBuild: { price: 99.5, borrowerPaidPoints: 0.5, adjustedPoints: 0.5, noteRate: 7.5, basePoints: 2, priceFloor: 98, priceCeiling: 104, vendorPrice: 99.75 }, terms: { ltv: 70, dscr: 1.2 } },
    { priceBuild: { price: 100.5, borrowerPaidPoints: -0.5, adjustedPoints: -0.5, noteRate: 8 }, terms: { ltv: 70, dscr: 1.2 } },
  ] },
  { investorKey: 'visio', whiteLabel: 'Onyx', lender: 'Visio', program: 'DSCR', pricedBy: 'loannex',
    priceBuild: { price: 98, borrowerPaidPoints: 2, noteRate: 7.9 }, terms: { ltv: 70, dscr: 1.2 } },
]);

{
  const board = boardOf();
  const out = overlay.apply(board, { rules: [], scenario: { state: 'NJ' }, engine: 'general' });
  ok('D1  no rules returns the SAME array, by identity', out.programs === board);
  eq('D2  …and says it did not run', out.ran, false);
  const out2 = overlay.apply(board, { rules: null, scenario: {}, engine: 'general' });
  ok('D3  a null rule list is the same', out2.programs === board);
  const out3 = overlay.apply(board, { rules: [{ id: 'x', name: 'off', enabled: false, when: NJ_PREPAY, then: [{ type: 'ineligible', reason: 'x' }] }], scenario: { state: 'NJ', prepayMonths: 60, loan: 100000 }, engine: 'general' });
  ok('D4  a switched-off rule is the same', out3.programs === board);
  const out4 = overlay.apply(board, { rules: [{ id: 'x', name: 'combined only', enabled: true, engine: 'combined', when: NJ_PREPAY, then: [{ type: 'ineligible', reason: 'x' }] }], scenario: { state: 'NJ', prepayMonths: 60, loan: 100000 }, engine: 'general' });
  ok('D5  a rule written for the other engine does not touch this board', out4.programs === board);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nE. THE OVERLAY — WHEN IT DOES ACT');
// ═══════════════════════════════════════════════════════════════════════════

const holdbackRule = { id: 'h', name: 'Small loan holdback', enabled: true, engine: 'all', priority: 20,
  when: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'lt', value: 200000 }] },
  then: [{ type: 'add_holdback', points: 0.25 }] };

{
  const out = overlay.apply(boardOf(), { rules: [holdbackRule], scenario: { loan: 150000 }, engine: 'general' });
  const pb = ((((out.programs[0] || {}).options || [])[0] || {}).priceBuild) || {};
  eq('E1  a holdback moves the price DOWN', pb.price, 99.25);
  eq('E2  …and the points UP by the same amount', pb.borrowerPaidPoints, 0.75);
  eq('E3  …and records what it moved', pb.houseAdjustPoints, -0.25);
  eq('E4  …and keeps the price it started from', pb.housePrice, 99.5);
  eq('E5  the vendor\'s own price is untouched', pb.vendorPrice, 99.75);
  eq('E6  the sheet\'s own base points are untouched', pb.basePoints, 2);
  eq('E7  the sheet\'s floor is untouched', pb.priceFloor, 98);
  eq('E8  the sheet\'s ceiling is untouched', pb.priceCeiling, 104);
  eq('E9  the note rate never moves', pb.noteRate, 7.5);
  eq('E10 the flat LoanNEX row is adjusted too', ((out.programs[1] || {}).priceBuild || {}).price, 97.75);
  eq('E11 it reports which rules reached quotes', out.applied.length, 1);
  eq('E12 …and how many quotes each reached', (out.applied[0] || {}).quotes, 3);
}

{
  const out = overlay.apply(boardOf(), { rules: [{ ...holdbackRule, then: [{ type: 'discount', points: 0.25 }] }], scenario: { loan: 150000 }, engine: 'general' });
  const pb = ((((out.programs[0] || {}).options || [])[0] || {}).priceBuild) || {};
  eq('E13 a discount moves the price UP', pb.price, 99.75);
  eq('E14 …and the points DOWN', pb.borrowerPaidPoints, 0.25);
}

{
  /* ONCE PER BOARD. A second pass would list every adjustment twice in the
     trace even though the anchors keep the arithmetic right. */
  const first = overlay.apply(boardOf(), { rules: [holdbackRule], scenario: { loan: 150000 }, engine: 'general' });
  const second = overlay.apply(first.programs, { rules: [holdbackRule], scenario: { loan: 150000 }, engine: 'general' });
  ok('E15 a board it has already run on is returned untouched', second.programs === first.programs);
  eq('E16 …and the price did not move twice', second.programs[0].options[0].priceBuild.price, 99.25);
}

{
  const njRule = { id: 'nj', name: 'No NJ prepay', enabled: true, engine: 'all', priority: 10,
    when: NJ_PREPAY, then: [{ type: 'ineligible', reason: 'No investor of ours allows a prepayment penalty in New Jersey.' }] };
  const out = overlay.apply(boardOf(), { rules: [njRule], scenario: { state: 'NJ', prepayMonths: 60, loan: 100000 }, engine: 'general' });
  eq('E17 every refused quote leaves the board', out.programs.length, 0);
  eq('E18 …and every one is named', out.ineligible.length, 3);
  eq('E19 …with OUR reason', (out.ineligible[0] || {}).reason, 'No investor of ours allows a prepayment penalty in New Jersey.');
  eq('E20 …attributed to the rule that refused it', (out.ineligible[0] || {}).rule, 'No NJ prepay');
  ok('E21 …and marked as ours, not the rate sheet\'s', out.ineligible.every((r) => r.why === 'house_rule'));
  ok('E22 the ineligible list never carries the investor\'s real name',
    out.ineligible.every((r) => r.name === 'Vermilion' || r.name === 'Onyx'), JSON.stringify(out.ineligible.map((r) => r.name)));
}

{
  /* A ROW-LEVEL REFUSAL TAKES ONE QUOTE, NOT THE PROGRAM. */
  const rateRule = { id: 'r', name: 'No rates over 7.75', enabled: true, engine: 'all',
    when: { combinator: 'and', rules: [{ field: 'note_rate', operator: 'gt', value: 7.75 }] },
    then: [{ type: 'ineligible', reason: 'Above our ceiling.' }] };
  const out = overlay.apply(boardOf(), { rules: [rateRule], scenario: {}, engine: 'general' });
  eq('E23 the program stays with the quotes that pass', out.programs.length, 1);
  eq('E24 …carrying only the passing quote', ((out.programs[0] || {}).options || []).length, 1);
  eq('E25 …the right one', ((((out.programs[0] || {}).options || [])[0] || {}).priceBuild || {}).noteRate, 7.5);
  eq('E26 …and both refusals are named', out.ineligible.length, 2);
  const counted = overlay.apply(
    boardOf().map((r) => (r.options ? { ...r, optionCount: r.options.length } : r)),
    { rules: [rateRule], scenario: {}, engine: 'general' });
  eq('E26a …and a row that says how many quotes it has says the new number',
    (counted.programs[0] || {}).optionCount, 1);
  eq('E26b …while a row that never carried the count is not given one',
    'optionCount' in (overlay.apply(boardOf(), { rules: [holdbackRule], scenario: { loan: 150000 }, engine: 'general' }).programs[0] || {}), false);
}

{
  /* BLOCKING AN INVESTOR TAKES ALL OF IT, matched on any one of its quotes —
     the owner's *"this investor should not populate if it's in this state"*. */
  const blockRule = { id: 'b', name: 'Acra not in NJ', enabled: true, engine: 'all',
    when: { combinator: 'and', rules: [{ field: 'investor_key', operator: 'eq', value: 'acra' }, { field: 'state', operator: 'eq', value: 'NJ' }] },
    then: [{ type: 'block_investor', reason: 'We do not place Acra in New Jersey.' }] };
  const out = overlay.apply(boardOf(), { rules: [blockRule], scenario: { state: 'NJ' }, engine: 'general' });
  eq('E27 the blocked investor is gone entirely', out.programs.length, 1);
  eq('E28 …and the one left is the other investor', (out.programs[0] || {}).investorKey, 'visio');
  eq('E29 the block is reported once, not once per quote', out.blocked.length, 1);
  eq('E30 …with its reason', (out.blocked[0] || {}).reason, 'We do not place Acra in New Jersey.');
  eq('E31 …and nothing lands in the ineligible list', out.ineligible.length, 0);
}

{
  /* PRIORITY DECIDES WHICH REASON THE BOARD PRINTS. */
  const a = { id: 'a', name: 'First', enabled: true, priority: 1, when: { combinator: 'and', rules: [{ field: 'state', operator: 'eq', value: 'NJ' }] }, then: [{ type: 'ineligible', reason: 'reason A' }] };
  const b = { id: 'b2', name: 'Second', enabled: true, priority: 2, when: { combinator: 'and', rules: [{ field: 'state', operator: 'eq', value: 'NJ' }] }, then: [{ type: 'ineligible', reason: 'reason B' }] };
  const out = overlay.apply(boardOf(), { rules: [b, a], scenario: { state: 'NJ' }, engine: 'general' });
  eq('E32 the lower priority number wins the reason', (out.ineligible[0] || {}).reason, 'reason A');
}

{
  /* AN UNREADABLE RULE NEVER FIRES AND IS NEVER SILENT. */
  const broken = { id: 'x', name: 'Broken', enabled: true, when: null, then: [{ type: 'ineligible', reason: 'x' }] };
  const out = overlay.apply(boardOf(), { rules: [broken], scenario: {}, engine: 'general' });
  eq('E33 an unreadable rule refuses nothing', out.ineligible.length, 0);
  eq('E34 …and every board keeps its quotes', out.programs.length, 2);
  eq('E35 …and it is reported', out.problems.length, 1);
  eq('E36 …once, not once per quote', (out.problems[0] || {}).ruleId, 'x');
}

{
  /* A RULE DOES NOT SEE ANOTHER RULE'S ADJUSTMENT — the stated design. */
  const first = { id: '1', name: 'take a point', enabled: true, priority: 1,
    when: { combinator: 'and', rules: [{ field: 'investor_key', operator: 'eq', value: 'visio' }] },
    then: [{ type: 'add_holdback', points: 1 }] };
  const second = { id: '2', name: 'if the price is under 97.5', enabled: true, priority: 2,
    when: { combinator: 'and', rules: [{ field: 'price', operator: 'lt', value: 97.5 }] },
    then: [{ type: 'ineligible', reason: 'too low' }] };
  const out = overlay.apply(boardOf(), { rules: [first, second], scenario: {}, engine: 'general' });
  eq('E37 the second rule reads the price the ENGINE quoted, not the first rule\'s', out.ineligible.length, 0);
  eq('E38 …and the first rule still moved it', ((out.programs[1] || {}).priceBuild || {}).price, 97);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nF. THE FACTS');
// ═══════════════════════════════════════════════════════════════════════════

{
  const f0 = facts.scenarioFacts({});
  eq('F1  a search that says nothing has no loan amount', f0.loan_amount, null);
  eq('F2  …and no DSCR band, rather than band one', f0.dscr_band, null);
  eq('F3  …and does not claim there is no prepayment penalty', f0.has_prepay, null);
  eq('F4  …and does not claim a switch is off', f0.interest_only, null);

  eq('F5  a zero-month prepay IS no prepayment penalty', facts.scenarioFacts({ prepayMonths: 0 }).has_prepay, false);
  eq('F6  a sixty-month prepay IS one', facts.scenarioFacts({ prepayMonths: 60 }).has_prepay, true);
  eq('F7  a structure of None reads as no penalty', facts.scenarioFacts({ prepayStructure: 'None' }).has_prepay, false);
  eq('F8  any other structure reads as one', facts.scenarioFacts({ prepayStructure: 'Standard' }).has_prepay, true);

  eq('F9  the DSCR band is the ladder\'s own', facts.scenarioFacts({ dscr: 1.2 }).dscr_band, '7');
  eq('F10 an explicit false stays false', facts.scenarioFacts({ io: false }).interest_only, false);
  eq('F11 …and an explicit true stays true', facts.scenarioFacts({ io: true }).interest_only, true);
  /* ⛔ ONLY A REAL BOOLEAN. `scenario-defaults.readFlag` refuses anything else and
     THROWS, because the string "false" is truthy in JavaScript and silently turns
     a switch ON — Lender Price learned that the expensive way. The first cut of
     the fact bag caught that throw and parsed 'true' / 'yes' / 1 itself, which is a
     second, looser reading of the same question one function away from the strict
     one. A value the engine refuses reads here as "we cannot say", never as a yes. */
  eq('F11a a string "true" is not a yes — it is unreadable', facts.scenarioFacts({ io: 'true' }).interest_only, null);
  eq('F11b …and a string "false" is not a no either', facts.scenarioFacts({ io: 'false' }).interest_only, null);
  eq('F11c …nor is a 1', facts.scenarioFacts({ io: 1 }).interest_only, null);
}

{
  /* THE ROW'S OWN NUMBERS, NEVER THE SEARCH'S. */
  const q = facts.quoteFacts({ investor: 'Acra', whiteLabel: 'Vermilion', pricedBy: 'loannex' },
    { priceBuild: { price: 99, borrowerPaidPoints: 1, noteRate: 7.25 }, terms: { ltv: 65, dscr: 1.4 } }, { engine: 'general' });
  eq('F12 the quoted LTV is the row\'s', q.quoted_ltv, 65);
  eq('F13 the quoted DSCR is the row\'s', q.quoted_dscr, 1.4);
  eq('F14 the rate sheet is named', q.source, 'loannex');
  eq('F15 the engine is named', q.engine, 'general');
  eq('F16 the client-safe name rides along', q.white_label, 'Vermilion');
  const merged = facts.factsFor(facts.scenarioFacts({ ltv: 80 }), { pricedBy: 'loannex' }, { priceBuild: { price: 99 }, terms: { ltv: 65 } }, {});
  eq('F17 the searched LTV and the quoted LTV are different facts', `${merged.ltv}/${merged.quoted_ltv}`, '80/65');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nG. THE WIRING — a back end nobody reaches is not a feature');
// ═══════════════════════════════════════════════════════════════════════════

{
  const gb = src('src/longterm/pricing/general-board.js');
  const bare = stripComments(gb);
  ok('G1  the general board applies the overlay', /houseRules\.apply\(/.test(bare));
  ok('G2  …and returns what it did', /houseRules:\s*\{/.test(bare));
  ok('G3  …and reads the rules once, in loadConfig', /rulesStore\.liveRules\(\)/.test(bare));

  /* ⛔ THE ORDER IS LOAD-BEARING. `missing` and `sightings` describe what the RATE
     SHEETS did; an investor OUR rules refuse is not one LoanNEX failed to price.
     Applying the overlay before them would file every house block as a missing
     investor and email a super admin about a sheet that answered perfectly well. */
  const iMissing = bare.indexOf('const missing =');
  const iSightings = bare.indexOf('const sightings =');
  const iApply = bare.indexOf('houseRules.apply(');
  ok('G4  the overlay runs AFTER the missing-investor list is computed', iMissing > 0 && iApply > iMissing, `${iMissing} / ${iApply}`);
  ok('G5  …and AFTER the sightings', iSightings > 0 && iApply > iSightings, `${iSightings} / ${iApply}`);
  const iLens = bare.indexOf('const lens =');
  ok('G6  …and BEFORE the roster and counts that describe the board on screen', iLens > 0 && iApply < iLens, `${iApply} / ${iLens}`);
}

{
  const cp = stripComments(src('src/longterm/routes/combined-pricer.js'));
  ok('G7  the combined engine applies the overlay', /houseOverlay\.apply\(/.test(cp));
  ok('G8  …and returns the board as the rules allow it, not the raw one', /programs:\s*house\.programs/.test(cp));
  ok('G9  …and never returns the raw list beside it', !/\n\s*programs,\n/.test(cp));
  ok('G10 …and reports what the rules did', /houseRules:\s*\{/.test(cp));
  /* THE OTHER SHAPE OF THE SAME ENGINE'S ANSWER. No screen asks for it today, and a
     rule centre that governed one shape and not the other would be a hole nobody
     could see until something read it. */
  ok('G10a …on the ?shape=options answer as well as the board', /options\.rows/.test(cp) && /optHouse/.test(cp));
}

{
  const idx = stripComments(src('src/longterm/index.js'));
  ok('G11 the rule centre is mounted', /router\.use\('\/dscr\/pricing-rules'/.test(idx));
  ok('G12 …behind its own makeRouter, so the gate applies', /require\('\.\/routes\/pricing-rules'\)\.makeRouter\(\)/.test(idx));
  const iRules = idx.indexOf("'/dscr/pricing-rules'");
  const iDscr = idx.indexOf("router.use('/dscr', require('./routes/dscr-pricer')");
  ok('G13 …registered BEFORE the /dscr mount, or it would never match', iRules > 0 && iDscr > 0 && iRules < iDscr, `${iRules} / ${iDscr}`);
}

{
  const route = require('../src/longterm/routes/pricing-rules');
  const is = route._internals.isSuperAdmin;
  eq('G14 a super admin is let in', is({ actor: { kind: 'staff', role: 'super_admin' } }), true);
  eq('G15 an admin is not', is({ actor: { kind: 'staff', role: 'admin' } }), false);
  eq('G16 a borrower is not', is({ actor: { kind: 'borrower', role: 'super_admin' } }), false);
  eq('G17 nobody is not', is({}), false);

  /* IT ANSWERS 404, NOT 403 — a control the rest of the team may not use should
     not announce itself to them. */
  const r = route.makeRouter();
  const layer = r.stack[0];
  let status = null;
  layer.handle({ actor: { kind: 'staff', role: 'admin' } },
    { status(s) { status = s; return { json() {} }; } }, () => { status = 'next'; });
  eq('G18 …and everyone else gets a 404', status, 404);
}

{
  /* ⛔ A BACK END NOBODY REACHES IS NOT A FEATURE, and the SCREEN is the reach.
     The overlay can refuse a quote and move a price perfectly and still be
     invisible if the board never draws what it did — which is exactly the state
     the owner asked to be rid of: *"it should come up an ineligible section and
     it should say the ineligible reason is our own overlay."* No unit test of the
     overlay can see whether a screen renders it, so it is pinned on the source. */
  const be = stripComments(src('app-v2/src/longterm/BoardExplains.jsx'));
  ok('G22 the shared board panel has an ineligible section of our own', /function OurOwnRules\(/.test(be));
  ok('G23 …and it is mounted on BOTH boards, not only one', /<OurOwnRules houseRules=\{r\.houseRules\}/.test(be));
  ok('G24 …reading the server\'s own list, never re-deriving one', /houseRules\.ineligible|h\.ineligible/.test(be));
  ok('G25 …and prints the reason the person who wrote the rule typed', /reason \|\| 'no reason was written on the rule'/.test(be));
  ok('G26 …and never folds it into the rate sheets\' own "not on this board"',
    be.indexOf('function OurOwnRules(') !== be.indexOf('function NotOnThisBoard('));

  const nav = stripComments(src('app-v2/src/components/StaffLayout.jsx'));
  ok('G27 the centre has a way in', /to="\/internal\/lt\/pricing-rules"/.test(nav));
  ok('G28 …super admin only, like the door', /role === 'super_admin'[\s\S]{0,400}internal\/lt\/pricing-rules/.test(nav));
  const app = stripComments(src('app-v2/src/App.jsx'));
  ok('G29 …and the screen is routed', /path="\/internal\/lt\/pricing-rules"/.test(app));

  const screen = stripComments(src('app-v2/src/longterm/LtPricingRules.jsx'));
  ok('G30 the builder asks the SERVER what a rule may say', /pricingRuleCatalog\(\)/.test(screen));
  ok('G31 …and never keeps its own field list', !/const FIELDS\s*=/.test(screen));
  ok('G32 …and nothing is pre-filled: the centre opens empty', /No rules yet/.test(screen));
  ok('G33 a rule can be tried before it is turned on', /pricingRuleTest\(/.test(screen));
  ok('G34 …and taking one out uses PILOT\'s own message box, never the browser\'s',
    /await askConfirm\(/.test(screen) && !/window\.confirm\(/.test(screen));
}

{
  const st = src('src/longterm/pricing/rules/store.js');
  ok('G19 the board read never throws', /async function liveRules[\s\S]{0,600}catch \(e\)/.test(st));
  ok('G20 every write records an audit line', /logEvent\(client/.test(st));
  const bare = stripComments(st);
  const writes = (bare.match(/logEvent\(client/g) || []).length;
  ok('G21 …on all four kinds of change', writes >= 4, `${writes}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nH. WHAT THE POST-MERGE AUDIT FOUND (each proven to fail before its fix)');
// ═══════════════════════════════════════════════════════════════════════════

/* THE INHERITED-NAME HOLE. `ACTIONS` is an object literal, so a bracket lookup
   walks the prototype chain: `ACTIONS['constructor']` is `Object` and truthy, so
   `validate` — which only asked whether the spec existed — ACCEPTED it, the rule
   SAVED, and the summariser then read `.label` off `Object` and threw. Both
   engines call `overlay.apply` without a catch, so one such rule took down every
   board on every band. Measured end to end against a real database. */
const INHERITED = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];
{
  let refused = 0;
  let threw = 0;
  for (const type of INHERITED) {
    const list = [{ type }];
    if (actions.validate(list).length) refused += 1;
    try { actions.summarize(list); } catch (_) { threw += 1; }
  }
  eq('H1  every inherited property name is refused at the door', refused, INHERITED.length);
  eq('H2  …and none of them can throw in the summariser', threw, 0);
  ok('H3  a real verb is still accepted', actions.validate([{ type: 'note', reason: 'hi' }]).length === 0);
  ok('H4  …and plain nonsense is still refused', actions.validate([{ type: 'zzz' }]).length > 0);
}

{
  /* …AND IF ONE EVER REACHES THE TABLE, THE BOARD STILL PRICES. */
  const poison = { id: 'p', name: 'Poison', enabled: true, engine: 'all', priority: 1,
    when: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'lt', value: 200000 }] },
    then: [{ type: 'constructor' }] };
  let out = null;
  let boom = null;
  try {
    out = overlay.apply(boardOf(), { rules: [poison, holdbackRule], scenario: { loan: 150000 }, engine: 'general' });
  } catch (e) { boom = e; }
  ok('H5  a rule the overlay cannot read never takes the board down', !boom, boom && boom.message);
  ok('H6  …it is reported against its own rule', !!(out && out.problems || []).find((x) => x.ruleId === 'p'));
  eq('H7  …and the readable rule beside it still priced', out ? out.programs.length : -1, 2);
  eq('H8  …at the price it would have reached alone',
    ((((out || {}).programs || [])[0] || {}).options || [])[0].priceBuild.price, 99.25);
}

{
  /* THE BOARD DECIDED "IS THIS AN ADJUSTMENT?" BY TESTING THE SENTENCE for the
     word "point", so a rule that both REFUSES a loan and holds back margin —
     legal, since only two STOPS are forbidden — was printed as having priced a
     row it had just taken off the board. */
  const both = { id: 'b', name: 'Refuse and hold back', enabled: true, engine: 'all', priority: 5,
    when: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'lt', value: 200000 }] },
    then: [{ type: 'ineligible', reason: 'Not licensed.' }, { type: 'add_holdback', points: 0.5 }] };
  const out = overlay.apply(boardOf(), { rules: [both], scenario: { loan: 150000 }, engine: 'general' });
  const entry = (out.applied || [])[0] || {};
  ok('H9  applied carries the facts, not a sentence to be read', typeof entry.points === 'number');
  eq('H10 …and says plainly that it stops a quote', entry.stops, 'row');
  const adjusted = (out.applied || []).filter((a) => a && a.points && !a.stops);
  eq('H11 …so a stopping rule is never listed as a price adjustment', adjusted.length, 0);
}

{
  /* PASS ONE WAS NULL-SAFE AND PASS TWO WAS NOT. Not reachable from the board
     builder today, which only pushes objects — a guard, not a live defect. */
  let boom = null;
  let out = null;
  try {
    out = overlay.apply([null, ...boardOf()], { rules: [holdbackRule], scenario: { loan: 150000 }, engine: 'general' });
  } catch (e) { boom = e; }
  ok('H12 a row that is not an object cannot take the board down', !boom, boom && boom.message);
  ok('H13 …and is passed through rather than quietly dropped', !!out && out.programs.length === 3);
}

{
  const cp = stripComments(src('src/longterm/routes/combined-pricer.js'));
  ok('H14 the combined board counts the board it is RETURNING',
    /programCount:\s*house\.programs\.length/.test(cp));
  ok('H15 …never the raw pre-overlay array', !/programCount:\s*programs\.length/.test(cp));
}

{
  const panel = stripComments(src('app-v2/src/longterm/LtPricer.jsx'));
  /* PINNED ON THE ROW, NOT ON THE FILE. The first cut tested the whole panel for
     the string `houseAdjustPoints` — which also appears in the CONDITION guarding
     the row — so a mutation that rendered `pts(0)` in the VALUE slot left the
     string present and this guard green while the line showed nothing. Extract
     the element and assert what it actually displays. */
  const houseRow = (panel.match(/k="Our own rules"[\s\S]{0,240}?\/>/) || [''])[0];
  ok('H16 the price-build panel names our own rules in the ladder they moved', !!houseRow);
  ok('H16b …and shows the amount a house rule actually moved', /houseAdjustPoints/.test(houseRow));
  ok('H16c …negated, because points move opposite to the price',
    /-\s*Number\(b\.houseAdjustPoints\)/.test(houseRow));
  const explains = stripComments(src('app-v2/src/longterm/BoardExplains.jsx'));
  ok('H17 the board asks the FACTS which rules moved a price', /a\.points\s*&&\s*!a\.stops/.test(explains));
  ok('H18 …never the wording of the summary', !/\/point\/i\.test\(a\.did/.test(explains));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nI. WHAT THE SECOND POST-MERGE AUDIT FOUND');
// ═══════════════════════════════════════════════════════════════════════════

{
  /* THE EXPLAIN REBUILD DROPPED OUR OWN MOVE. `handlePatch` re-establishes price
     and adjusted points from the rung handle — minted BEFORE the overlay runs,
     and it has to win them, because `evidenceCoversRate` judges the vendor's
     answer against this option's rate and lock. But the row it is laid on may
     have been moved by a house rule, and `houseAdjustPoints` survived while the
     two figures it moved did not: the panel drew "Our own rules +0.500" over a
     total of 0.500 and a Final price contradicting the row above it. LoanNEX
     rows only — Lender Price rows carry no `explain`. */
  const quoteShape = require('../src/longterm/pricing/quote-shape');
  const flatBoard = () => ([{
    investorKey: 'x', program: 'P', terms: { dayLock: 30 },
    priceBuild: { noteRate: 7.5, price: 99.5, adjustedPoints: 0.5, borrowerPaidPoints: 0.5, basePoints: 2, vendorPrice: 99.5 },
    explain: { priceHashKey: 'K', vendor: 'loannex', rate: 7.5, price: 99.5, lockDays: 30 },
  }]);
  const row = overlay.apply(flatBoard(), { rules: [holdbackRule], scenario: { loan: 150000 }, engine: 'general' }).programs[0];
  const rebuilt = quoteShape.optionForExplain(row.explain, row).priceBuild;
  eq('I1  the explain rebuild agrees with the board on price', rebuilt.price, row.priceBuild.price);
  eq('I2  …and on adjusted points', rebuilt.adjustedPoints, row.priceBuild.adjustedPoints);
  const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
  const r3n = round3;
  ok('I3  …so the ladder adds up', round3(0.5 + -Number(rebuilt.houseAdjustPoints)) === Number(rebuilt.adjustedPoints),
    `0.5 + ${-Number(rebuilt.houseAdjustPoints)} vs ${rebuilt.adjustedPoints}`);
  eq('I4  …and the points it already moved are not moved twice',
    rebuilt.borrowerPaidPoints, row.priceBuild.borrowerPaidPoints);
  const twice = quoteShape.optionForExplain(row.explain, row).priceBuild;
  ok('I5  …laying it on again changes nothing', JSON.stringify(twice) === JSON.stringify(rebuilt));

  /* THE RE-ANCHOR ONLY BITES ON A RE-QUOTE, so it has to be tested on one. When
     the handle comes back at the SAME price the board was built from, anchoring
     on the row's stale `housePrice` and on the handle's own price give the same
     answer — so a fixture that does not move the price cannot tell a working
     re-anchor from a missing one. Here the vendor answers 98.5 rather than 99.5:
     the handle must win the base and our own move ride on top of THAT. */
  const requoted = { ...row.explain, price: 98.5 };
  const rq = quoteShape.optionForExplain(requoted, row).priceBuild;
  eq('I5a a re-quote wins the base the house move rides on', rq.price, r3n(98.5 + Number(rq.houseAdjustPoints)));
  ok('I5b …so the board\'s older price is not shown instead', rq.price !== row.priceBuild.price);

  /* A PRICELESS HANDLE MUST NOT ANCHOR ON ZERO. `handlePatch` writes `price` as a
     number OR NULL, and `Number(null)` is 0 — which is finite. Tested that way the
     re-anchor stamped `housePrice: 0` and the panel's Final price came out as the
     house delta itself (-0.500) instead of the board's figure. Same
     `Number(null) === 0` class the commit that added this fixed in
     `overlay.ordered()`, reintroduced two files over by the fix for it. */
  const priceless = { priceHashKey: 'K', vendor: 'loannex', rate: 7.5, lockDays: 30 };
  const pl = quoteShape.optionForExplain(priceless, row).priceBuild;
  eq('I5c a handle carrying no price never anchors on zero', pl.housePrice, row.priceBuild.housePrice);
  eq('I5d …and shows the board\'s own price, never the bare delta', pl.price, row.priceBuild.price);
  eq('I5d2 …and the POINTS anchor keeps the board\'s value, never a coerced zero',
    pl.houseAdjustedPoints, row.priceBuild.houseAdjustedPoints);

  const clean = overlay.apply(flatBoard(), { rules: [], scenario: {}, engine: 'general' }).programs[0];
  eq('I5e CONTROL: with no house rule a priceless handle still reads as no price',
    quoteShape.optionForExplain(priceless, clean).priceBuild.price, null);
  const untouched = quoteShape.optionForExplain(clean.explain, clean).priceBuild;
  eq('I6  a board no rule touched rebuilds exactly as before', untouched.price, 99.5);
  eq('I7  …points included', untouched.adjustedPoints, 0.5);
}

{
  /* AN ADJUSTMENT IS ONLY REPORTED WHERE IT LANDED. `appliedRules` counts every
     quote a rule REACHED; a quote a higher-priority rule then refused is not on
     the board, so a plain holdback whose every quote was refused by a DIFFERENT
     rule was still printed as "Priced with our own adjustment", over a board
     with no rows. */
  const when = { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'lt', value: 200000 }] };
  const stopRule = { id: 's', name: 'Not licensed', enabled: true, engine: 'all', priority: 1, when, then: [{ type: 'ineligible', reason: 'No.' }] };
  const holdRule = { id: 'h2', name: 'Margin holdback', enabled: true, engine: 'all', priority: 2, when, then: [{ type: 'add_holdback', points: 0.5 }] };
  const onScreen = (o) => (o.applied || []).filter((a) => a && a.points && !a.stops && a.adjustedQuotes !== 0).map((a) => a.name);

  const both = overlay.apply(boardOf(), { rules: [stopRule, holdRule], scenario: { loan: 150000 }, engine: 'general' });
  eq('I8  every quote refused leaves no row on the board', both.programs.length, 0);
  eq('I9  …and no rule is reported as having priced one', onScreen(both).length, 0);

  const alone = overlay.apply(boardOf(), { rules: [holdRule], scenario: { loan: 150000 }, engine: 'general' });
  ok('I10 CONTROL: the same holdback alone IS reported', onScreen(alone).join() === 'Margin holdback');
  eq('I11 …and says how many quotes it actually moved', (alone.applied[0] || {}).adjustedQuotes, 3);
}

{
  /* `Number(null)` IS 0, WHICH IS FINITE — so the sort tested `a && a.priority`
     and then dereferenced `a.priority`, throwing one line ahead of the `r && …`
     guard that exists because a rule may be null. */
  let boom = null;
  try { overlay.apply(boardOf(), { rules: [holdbackRule, null], scenario: { loan: 150000 }, engine: 'general' }); } catch (e) { boom = e; }
  ok('I12 a null rule beside a good one cannot take the board down', !boom, boom && boom.message);
  /* TOTAL AGAINST A THROW, not just against a wrong answer: a crash also "fails"
     and looks like proof while stopping the battery where it stands. */
  let orderedOk = false;
  let orderErr = null;
  try {
    orderedOk = overlay.ordered([{ id: 'b', priority: 9 }, null, { id: 'a', priority: 1 }])[0].id === 'a';
  } catch (e) { orderErr = e; }
  ok('I13 …and ordering still puts the lower priority first', orderedOk, orderErr && `threw: ${orderErr.message}`);
}

{
  const explains = stripComments(src('app-v2/src/longterm/BoardExplains.jsx'));
  ok('I14 the board only lists an adjustment that reached a quote on it',
    /a\.adjustedQuotes\s*!==\s*0/.test(explains));
  const qs = stripComments(src('src/longterm/pricing/quote-shape.js'));
  ok('I15 the explain rebuild re-applies our own move', /reapplyHouseMove\(/.test(qs));
  ok('I16 …through the overlay\'s own definition, never a second copy',
    /houseRules\.movePriceBuild\(/.test(qs) && !/houseAdjustPoints\s*\*/.test(qs));
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nJ. BLOCKING ONE PROGRAM, WHICH IS NOT BLOCKING THE INVESTOR');
// ═══════════════════════════════════════════════════════════════════════════
/* Owner-directed 2026-09-04: *"this investor should not populate this program
   name"*, and — asked which of the two verbs a rule should carry — *"let me
   choose per rule"*. So there are two stopping verbs and the writer picks; the
   difference between them is the only thing worth testing, and it is a property
   of the BOARD, so the overlay is RUN rather than read. */
{
  /* ONE investor, TWO programs, so "the other one still prices" is a fact this
     fixture can actually hold. A one-program fixture would pass either way. */
  const twoPrograms = () => ([
    { investorKey: 'acra', whiteLabel: 'Vermilion', lender: 'Acra', program: 'DSCR 30',
      priceBuild: { price: 99.5, borrowerPaidPoints: 0.5, noteRate: 7.5 }, terms: { ltv: 70, dscr: 1.2 } },
    { investorKey: 'acra', whiteLabel: 'Vermilion', lender: 'Acra', program: 'DSCR 40 IO',
      priceBuild: { price: 99, borrowerPaidPoints: 1, noteRate: 7.9 }, terms: { ltv: 70, dscr: 1.2 } },
    { investorKey: 'visio', whiteLabel: 'Onyx', lender: 'Visio', program: 'DSCR 30',
      priceBuild: { price: 98, borrowerPaidPoints: 2, noteRate: 7.9 }, terms: { ltv: 70, dscr: 1.2 } },
  ]);
  const NJ = { combinator: 'and', rules: [{ field: 'state', operator: 'eq', value: 'NJ' }] };
  /* THE RULE NAMES THE INVESTOR AS WELL AS THE PROGRAM, which is what a real
     "we do not place THIS program with THIS investor" rule says — and it is what
     makes J5 a measurement: a rule matching on the program name ALONE genuinely
     matches every investor's copy of it, so blocking all of them would be the
     rule working, not the key over-reaching. */
  const ruleFor = (type, program, investorKey = 'acra', extra = {}) => ({
    id: `${type}:${program}`, name: `${type} on ${program}`, enabled: true, engine: 'all', priority: 10,
    when: {
      combinator: 'and',
      rules: [
        { field: 'state', operator: 'eq', value: 'NJ' },
        { field: 'investor_key', operator: 'eq', value: investorKey },
        { field: 'program_name', operator: 'eq', value: program },
      ],
    },
    then: [{ type, reason: 'we do not place this here' }],
    ...extra,
  });
  const SC = { state: 'NJ', loan: 400000 };

  ok('J1  "block this program name" is a verb a rule may use',
    !!actions.specOf('block_program') && actions.specOf('block_program').stops === 'program');
  ok('J2  …and it needs a reason, like every other stop',
    actions.specOf('block_program').needsReason === true);

  const prog = overlay.apply(twoPrograms(), { rules: [ruleFor('block_program', 'DSCR 30')], scenario: SC, engine: 'general' });
  const names = (rows) => rows.map((r) => `${r.investorKey}/${r.program}`).sort();
  eq('J3  the named program is off the board for the investor it matched',
    names(prog.programs).includes('acra/DSCR 30'), false);
  eq('J4  …AND THE INVESTOR\'S OTHER PROGRAM STILL PRICES — the whole difference between the two verbs',
    names(prog.programs).includes('acra/DSCR 40 IO'), true);
  /* ⛔ AND ANOTHER INVESTOR'S PROGRAM OF THE SAME NAME IS UNTOUCHED. "30 Yr.
     Fixed" is on nearly every sheet, so a key of the program alone would block
     every investor's copy of it — `block_investor` applied to several investors
     at once, which nobody asked for. */
  eq('J5  …and another investor quoting a program of the SAME NAME is untouched',
    names(prog.programs).includes('visio/DSCR 30'), true);
  eq('J6  …the removal is reported, never silent', (prog.blocked || []).length, 1);
  eq('J7  …and says WHICH kind of block it was, so the board can word the two differently',
    (prog.blocked[0] || {}).kind, 'program');
  eq('J8  …naming the program', (prog.blocked[0] || {}).program, 'DSCR 30');

  /* THE CONTROL. The same rule with the WIDER verb takes the investor's other
     program too — which is what makes J4 a measurement rather than a tautology. */
  const inv = overlay.apply(twoPrograms(), { rules: [ruleFor('block_investor', 'DSCR 30')], scenario: SC, engine: 'general' });
  eq('J9  CONTROL: "block this investor" takes the other program as well',
    names(inv.programs).includes('acra/DSCR 40 IO'), false);
  eq('J10 …and still leaves the other investor alone',
    names(inv.programs).includes('visio/DSCR 30'), true);
  eq('J11 …reported as an INVESTOR block', (inv.blocked[0] || {}).kind, 'investor');

  /* BOTH AT ONCE IS REFUSED AT THE DOOR, and the refusal now names all three
     stopping verbs — it named two while there were three, so a writer who had
     picked the third was advised about verbs they had not used. */
  const both = actions.validate([{ type: 'block_investor', reason: 'a' }, { type: 'block_program', reason: 'b' }]);
  ok('J12 a rule cannot stop a quote two ways', both.length === 1);
  ok('J13 …and the refusal names every stopping verb there is',
    both[0].includes('block this program name') && both[0].includes('block this investor') && both[0].includes('mark ineligible'));
  ok('J14 …built from the registry, so a fourth verb cannot be left out of it',
    !/pick "mark ineligible" or "block this investor"\.$/.test(both[0]));

  /* THE WIDER BLOCK WINS WHERE BOTH REACH ONE ROW. Two rules, which is legal —
     only two stops in ONE rule are refused — and they are matched on DIFFERENT
     rows of the same investor, because a single row can only ever carry ONE
     stop (the highest-priority rule that matched it, which is what priority is
     for and is not being re-litigated here). So: the program rule takes DSCR 30,
     the investor rule fires on DSCR 40 IO, and the DSCR 30 row is then reached
     by both. Reporting it as a PROGRAM block would tell an officer this
     investor's other programs are still priced, when the investor block has
     just taken them. */
  const wide = overlay.apply(twoPrograms(), {
    rules: [ruleFor('block_program', 'DSCR 30'), ruleFor('block_investor', 'DSCR 40 IO')],
    scenario: SC, engine: 'general',
  });
  eq('J15 where both kinds reach one row the WIDER one is reported',
    ((wide.blocked || []).find((b) => b.program === 'DSCR 30' && b.investorKey === 'acra') || {}).kind, 'investor');
  eq('J15b …and the investor is off the board entirely',
    names(wide.programs).filter((n) => n.startsWith('acra/')).length, 0);

  /* THE SCREEN'S OWN SPLIT, extracted and RUN — a source check could not tell a
     working split from one that files every row under "investor". */
  const bsrc = src('app-v2/src/longterm/BoardExplains.jsx');
  const m = bsrc.match(/export function blockedBy\(rows, kind\) \{[\s\S]*?\n\}/);
  ok('J16 the screen\'s own splitter was found', !!m);
  const blockedBy = m ? new Function(`${m[0].replace(/^export /, '')}; return blockedBy;`)() : () => [];
  eq('J17 …a program block is filed under programs',
    blockedBy([{ kind: 'program' }], 'program').length, 1);
  eq('J18 …an investor block is filed under investors',
    blockedBy([{ kind: 'investor' }], 'investor').length, 1);
  eq('J19 …a row from BEFORE this verb existed carries no kind and was an investor block',
    blockedBy([{ name: 'old' }], 'investor').length, 1);
  eq('J20 …and an unrecognised kind reads as the WIDER one, which never promises other programs are priced',
    blockedBy([{ kind: 'nonsense' }], 'investor').length, 1);
  eq('J21 …so no row is ever dropped by both sections', blockedBy([{ kind: 'nonsense' }], 'program').length, 0);
}

const total = pass + failures.length;
console.log(`\n${failures.length ? 'FAILED' : 'ALL PASSED'} (${pass} passed, ${failures.length} failed of ${total})`);
if (failures.length) { failures.forEach((f) => console.log(`  · ${f}`)); process.exit(1); }
