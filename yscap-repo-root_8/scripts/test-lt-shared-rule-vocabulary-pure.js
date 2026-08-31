'use strict';
/**
 * THE SHARED RULE EVALUATOR LEARNED TO SPEAK BOTH PRODUCTS — and did not move
 * an inch for the one that was already using it.
 *
 * The owner's 2026-08-30 directive is that the Condition Center is ONE
 * implementation: *"We don't want to reinvent the code. We want to use the same
 * exact condition center, and when we update something, it should update on
 * both."* The two products' rule evaluators were written separately, and before
 * one can replace the other the shared one has to be able to say everything the
 * Long-Term one can. Three gaps were found by MEASUREMENT rather than reading,
 * and this pins all three — plus, far more importantly, that closing them
 * changed nothing for the short-term product, which is live.
 *
 * ── WHAT IS PINNED ──────────────────────────────────────────────────────────
 *
 *  A. THE `pct` TYPE. Long-Term spells the percent type `pct` and the shared
 *     registry spells it `percent`. Unnoticed, that is a rule that silently
 *     refuses to validate. It is INERT for the short-term product because no
 *     short-term field is typed `pct` — asserted here against the static
 *     registry rather than assumed.
 *
 *  B. `is_empty` / `not_empty` ON A BOOLEAN. A latent defect, not a rule: the
 *     evaluator has always handled them (its switch answers before it looks at
 *     the type) and the module's own comment ADVISES using `is_empty` on a
 *     boolean — while the validator refused to let anybody save one. The fix is
 *     validation-only and permissive, and the evaluation half is pinned
 *     unchanged.
 *
 *  C. THE TRI-STATE, `evaluateRuleTri`. Long-Term needs to tell "no" from
 *     "cannot tell" so its engine can leave a condition alone rather than
 *     deciding against it on an unreadable file. The governing property is that
 *     it is a strict REFINEMENT: its boolean projection is identical to the
 *     evaluator the short-term product uses, so the two can never disagree
 *     about whether a condition applies — only about whether we know.
 *
 *  D. AND IT AGREES WITH THE MODULE IT IS MEANT TO REPLACE, on every rule the
 *     Long-Term library actually ships, in every context. Read out of the
 *     library rather than retyped, so a rule added there is covered for free.
 *
 * NAMED `test-lt-…` DELIBERATELY, even though its SUBJECT is the shared module.
 * The separation gate reads a suite's FILENAME as its product identity and only
 * a `test-lt-*` suite may import Long-Term code — and this one must, because the
 * whole question it answers is whether the shared evaluator can serve Long-Term.
 * Its own field registry and library are the evidence; a copy of them here would
 * go stale the first time either changed.
 *
 * PURE — no database, no network.
 *
 * Run: node scripts/test-lt-shared-rule-vocabulary-pure.js
 */

const SH = require('../src/lib/conditions/rules');
const registry = require('../src/lib/conditions/field-registry');

let n = 0;
let failed = 0;
const rec = (pass, m) => { n++; if (!pass) { failed++; console.log(`FAIL ${m}`); } };
const ok = (c, m) => rec(!!c, m);
const eq = (a, b, m) => rec(Object.is(a, b), `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

// ---------------------------------------------------------------------------
// A. THE `pct` TYPE — known, and inert for the short-term product.
// ---------------------------------------------------------------------------
{
  ok(Array.isArray(SH.OPERATORS_BY_TYPE.pct), 'A1 the shared evaluator knows the `pct` type');
  eq(JSON.stringify(SH.OPERATORS_BY_TYPE.pct), JSON.stringify(SH.OPERATORS_BY_TYPE.percent),
    'A2 …and treats it exactly as `percent`, or the two spellings would mean two things');
  ok(SH.NUMERIC_TYPES.includes('pct') && SH.NUMERIC_TYPES.includes('percent'),
    'A3 both spellings are numeric — the list is ONE definition, because it was written twice and '
    + 'adding a type to one copy validates a rule the other answers false on, silently');

  // INERT: no short-term field is typed `pct`, so no existing rule can reach it.
  const builtIns = Object.values(registry.BY_KEY || {});
  ok(builtIns.length > 0, 'A4 the short-term registry was readable');
  eq(builtIns.filter((f) => f && f.type === 'pct').length, 0,
    'A5 …and NOT ONE short-term field is typed `pct`, which is what makes A1 inert');

  const F = { ltv: { key: 'ltv', label: 'LTV', type: 'pct' } };
  const tree = { combinator: 'and', rules: [{ field: 'ltv', operator: 'gt', value: 70 }] };
  eq(JSON.stringify(SH.validateRule(tree, { fields: F })), '[]', 'A6 a pct rule validates');
  eq(SH.evaluateRule(tree, { ltv: 80 }, F), true, 'A7 …and evaluates as a number');
  eq(SH.evaluateRule(tree, { ltv: 60 }, F), false, 'A8 …in both directions');
  ok(/70%/.test(SH.summarizeRule(tree, { fields: F })),
    'A9 …and reads with a per-cent sign, like every other percent');
}

// ---------------------------------------------------------------------------
// B. `is_empty` / `not_empty` ON A BOOLEAN — permissive, and evaluation-only.
// ---------------------------------------------------------------------------
{
  const F = { b: { key: 'b', label: 'Is condo', type: 'boolean' } };
  for (const op of ['is_empty', 'not_empty']) {
    const tree = { combinator: 'and', rules: [{ field: 'b', operator: op }] };
    eq(JSON.stringify(SH.validateRule(tree, { fields: F })), '[]', `B1 \`${op}\` on a boolean validates`);
  }
  // The evaluator ALWAYS handled them, which is the whole reason this is safe.
  const isEmpty = { combinator: 'and', rules: [{ field: 'b', operator: 'is_empty' }] };
  const notEmpty = { combinator: 'and', rules: [{ field: 'b', operator: 'not_empty' }] };
  for (const [v, empty] of [[null, true], [undefined, true], ['', true], [true, false], [false, false]]) {
    eq(SH.evaluateRule(isEmpty, { b: v }, F), empty, `B2 is_empty on ${JSON.stringify(v)}`);
    eq(SH.evaluateRule(notEmpty, { b: v }, F), !empty, `B3 not_empty on ${JSON.stringify(v)}`);
  }
  // AND `is_false` STAYS STRICT. A never-answered boolean is unknown, not false —
  // the short-term rule, documented and chosen, and the one genuine conflict
  // between the two modules. It is settled in the short-term product's favour.
  const isFalse = { combinator: 'and', rules: [{ field: 'b', operator: 'is_false' }] };
  eq(SH.evaluateRule(isFalse, { b: false }, F), true, 'B4 is_false is true on a real false');
  eq(SH.evaluateRule(isFalse, { b: null }, F), false, 'B5 …and NOT on a blank — unknown is not "no"');
  eq(SH.evaluateRule(isFalse, { b: 0 }, F), false, 'B6 …nor on a zero');
  eq(SH.evaluateRule(isFalse, { b: 'false' }, F), false, 'B7 …nor on the word');
}

// ---------------------------------------------------------------------------
// C. THE TRI-STATE IS A STRICT REFINEMENT.
//
// THE ONE THAT MATTERS. If the projection could ever differ, the two engines
// would disagree about whether a condition applies to a file — which is the
// entire thing sharing an evaluator is supposed to make impossible.
// ---------------------------------------------------------------------------
{
  const FIELDS = {
    amt: { key: 'amt', label: 'Amount', type: 'money' },
    p:   { key: 'p',   label: 'Rate',   type: 'pct' },
    t:   { key: 't',   label: 'State',  type: 'text' },
    e:   { key: 'e',   label: 'Program', type: 'enum', options: [{ v: 'gold', label: 'Gold' }, { v: 'std', label: 'Standard' }] },
    b:   { key: 'b',   label: 'Condo',  type: 'boolean' },
    d:   { key: 'd',   label: 'Closing', type: 'date' },
  };
  const valuesFor = (type, op) => {
    if (['is_empty', 'not_empty', 'is_true', 'is_false'].includes(op)) return [null];
    if (op === 'between') return type === 'date' ? [['2026-01-01', '2026-12-31']] : [[10, 90]];
    if (op === 'in' || op === 'not_in') return [['gold'], ['gold', 'std']];
    if (type === 'money' || type === 'pct') return [70, 500000];
    if (type === 'text') return ['NJ'];
    if (type === 'enum') return ['gold'];
    if (type === 'date') return ['2026-06-01'];
    return [null];
  };
  const CTX = [null, undefined, '', true, false, 0, 70, 500000, 'NJ', 'gold', '2026-06-01', 'abc'];

  let compared = 0, drift = 0;
  for (const key of Object.keys(FIELDS)) {
    const f = FIELDS[key];
    for (const op of (SH.OPERATORS_BY_TYPE[f.type] || [])) {
      for (const val of valuesFor(f.type, op)) {
        for (const comb of ['and', 'or']) {
          const flat = { combinator: comb, rules: [{ field: key, operator: op, value: val }] };
          const nested = { combinator: comb, rules: [
            { field: key, operator: op, value: val },
            { combinator: 'and', rules: [{ field: 'b', operator: 'is_true' }] },
          ] };
          for (const tree of [flat, nested]) {
            for (const cv of CTX) {
              const ctx = {}; for (const k of Object.keys(FIELDS)) ctx[k] = cv;
              compared++;
              if ((SH.evaluateRuleTri(tree, ctx, FIELDS) === true) !== SH.evaluateRule(tree, ctx, FIELDS)) drift++;
            }
          }
        }
      }
    }
  }
  ok(compared > 2000, `C1 the refinement was tested over a real battery (${compared} evaluations)`);
  eq(drift, 0, 'C2 …and the tri-state\'s boolean projection is IDENTICAL to the short-term walk, everywhere');

  // The third answer really is reachable — or C2 would be true of a function
  // that simply never says "cannot tell", which would prove nothing.
  eq(SH.evaluateRuleTri({ combinator: 'and', rules: [{ field: 'nope', operator: 'is_true' }] }, {}, FIELDS), null,
    'C3 an unknown field answers "cannot tell"');
  eq(SH.evaluateRuleTri({ combinator: 'and', rules: [{ field: 'amt', operator: 'gt', value: 1 }] }, { amt: 'abc' }, FIELDS), null,
    'C4 …and so does a number that is not one');
  eq(SH.evaluateRuleTri(null, {}, FIELDS), true, 'C5 no rule at all applies to everything');

  // The short-circuit: a readable row that settles it wins over an unreadable one.
  eq(SH.evaluateRuleTri({ combinator: 'or', rules: [
    { field: 'nope', operator: 'is_true' }, { field: 'b', operator: 'is_true' }] }, { b: true }, FIELDS), true,
    'C6 an OR settled by a readable row is true despite an unreadable one');
  eq(SH.evaluateRuleTri({ combinator: 'and', rules: [
    { field: 'nope', operator: 'is_true' }, { field: 'b', operator: 'is_true' }] }, { b: false }, FIELDS), false,
    'C7 …and an AND settled false is false, for the same reason');
  eq(SH.evaluateRuleTri({ combinator: 'and', rules: [
    { field: 'nope', operator: 'is_true' }, { field: 'b', operator: 'is_true' }] }, { b: true }, FIELDS), null,
    'C8 …but nothing settling it, with something unreadable, is "cannot tell"');
}

// ---------------------------------------------------------------------------
// D. IT AGREES WITH THE MODULE IT IS MEANT TO REPLACE, on every rule the
// Long-Term library actually ships. Read OUT of the library, so a rule added
// there is covered without anybody remembering to add it here.
// ---------------------------------------------------------------------------
{
  const LT = require('../src/longterm/conditions-center/rules');
  const lib = require('../src/longterm/conditions-center/library');
  const FIELDS = require('../src/longterm/conditions-center/field-registry').fieldMap();

  const shipped = [].concat(lib.PRIOR_TO_SUBMISSION || [], lib.PRIOR_TO_CTC || [])
    .map((c) => c && c.rule).filter(Boolean);
  ok(shipped.length >= 15, `D1 the library ships rules to compare (${shipped.length})`);

  let cmp = 0, evalDrift = 0, wordDrift = 0;
  for (const tree of shipped) {
    for (const v of [true, false, null, undefined]) {
      const ctx = {}; for (const k of Object.keys(FIELDS)) ctx[k] = v;
      cmp++;
      if (LT.evaluateRule(tree, ctx, FIELDS) !== SH.evaluateRuleTri(tree, ctx, FIELDS)) evalDrift++;
    }
    if (LT.describeRule(tree, FIELDS) !== SH.summarizeRule(tree, { fields: FIELDS })) wordDrift++;
  }
  eq(evalDrift, 0, `D2 every shipped long-term rule evaluates identically in both modules (${cmp} evaluations)`);
  eq(wordDrift, 0, 'D3 …and reads identically, so no screen changes wording when they merge');

  // EVERY TYPE THE LONG-TERM REGISTRY DECLARES IS NOW KNOWN HERE. This is the
  // check that fails when somebody adds a Long-Term field of a type the shared
  // evaluator cannot judge — which would validate nowhere and evaluate to
  // "cannot tell" everywhere, silently.
  const ltTypes = [...new Set(Object.values(FIELDS).map((f) => f && f.type).filter(Boolean))];
  const unknown = ltTypes.filter((t) => !SH.OPERATORS_BY_TYPE[t]);
  eq(JSON.stringify(unknown), '[]', `D4 the shared evaluator knows every long-term field type (${ltTypes.join(', ')})`);
}

if (failed) {
  console.log(`\ntest-lt-shared-rule-vocabulary-pure: ${failed} of ${n} checks FAILED`);
  process.exit(1);
}
console.log(`test-lt-shared-rule-vocabulary-pure: ${n} checks passed`);
