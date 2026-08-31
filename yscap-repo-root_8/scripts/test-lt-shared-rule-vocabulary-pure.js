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

// ── E. THE OPERATOR TABLE AND THE VALIDATOR ARE NOW ONE, NOT TWO THAT AGREE ──
// Sections A–D proved the shared module CAN speak Long-Term. This one pins that
// Long-Term actually USES it — the difference between a duplicate that has not
// drifted yet and no duplicate at all.
{
  const LTR = require('../src/longterm/conditions-center/rules');
  const ltReg = require('../src/longterm/conditions-center/field-registry');
  const FIELDS = ltReg.fieldMap();

  // IDENTITY, not deep equality. Two tables with the same contents is exactly
  // the state this work removed, and an equality check would pass on it.
  ok(LTR.OPERATORS_BY_TYPE === SH.OPERATORS_BY_TYPE,
    'E1 the long-term operator table IS the shared object — not a copy that currently matches');

  // The validator delegates. Proven by a refusal only the SHARED validator can
  // produce: the long-term one never looked at an enum's option list at all, so
  // a typo'd enum value saved happily and then silently never matched a file.
  const typo = LTR.validateRule(
    { combinator: 'and', rules: [{ field: 'loan_purpose', operator: 'eq', value: 'purchace' }] }, FIELDS);
  ok(typo.ok === false && /unknown value/i.test(String(typo.problems[0] && typo.problems[0].detail)),
    'E2 a typo\'d enum value is REFUSED — a check only the shared validator has, so the delegation is real');
  ok(LTR.validateRule(
    { combinator: 'and', rules: [{ field: 'loan_purpose', operator: 'eq', value: 'purchase' }] }, FIELDS).ok === true,
  'E3 …and a real option is still accepted, so the check is not simply refusing everything');

  // The two seams that stay Long-Term's own, and the shape its screens read.
  ok(LTR.validateRule(null, FIELDS).ok === true,
    'E4 a condition with NO rule is valid — every one of the shipped 28 relies on it');
  ok(LTR.validateRule({ field: 'loan_purpose', operator: 'eq', value: 'purchase' }, FIELDS).ok === true,
    'E5 a bare row at the root validates as the one-row group it means');
  const bad = LTR.validateRule({ combinator: 'and', rules: [{ field: 'nope', operator: 'eq', value: 'x' }] }, FIELDS);
  ok(bad.ok === false && bad.problems.length === 1 && bad.problems[0].reason === 'unknown_field'
    && typeof bad.problems[0].why === 'string' && bad.problems[0].why.length > 0,
  'E6 the answer keeps long-term\'s {ok, problems:[{reason, detail, why}]} shape, with wording for a person');

  // THE ONE THAT MATTERS MOST: every operator the builder now OFFERS is one the
  // evaluator can actually answer. Without this, sharing the table hands the
  // rule builder a control that silently evaluates to "cannot tell" forever —
  // which reads as a condition that mysteriously never applies.
  const unanswerable = [];
  for (const [key, f] of Object.entries(FIELDS)) {
    for (const op of (SH.OPERATORS_BY_TYPE[f.type] || [])) {
      const value = op === 'between' ? [1, 2]
        : (op === 'in' || op === 'not_in') ? ['x']
          : f.type === 'date' ? '2021-01-01' : (f.type === 'money' || f.type === 'number' || f.type === 'pct') ? 1 : 'x';
      const tree = { combinator: 'and', rules: [{ field: key, operator: op, value }] };
      // A non-blank context, so a blank cannot be the reason it says "cannot tell".
      const ctx = { [key]: f.type === 'boolean' ? true : f.type === 'date' ? '2021-01-01'
        : (f.type === 'money' || f.type === 'number' || f.type === 'pct') ? 1 : 'x' };
      if (LTR.evaluateRule(tree, ctx, FIELDS) === null) unanswerable.push(`${key} (${f.type}) ${op}`);
    }
  }
  eq(JSON.stringify(unanswerable), '[]',
    'E7 every operator the shared table offers a long-term field is one the long-term evaluator answers');

  // …AND ONE A PERSON CAN READ. `describeRule` falls through to the raw key when
  // an operator has no label, so the settings screen reads "Program ends_with
  // 30yr" — and a rule an administrator cannot READ is a rule they cannot safely
  // change. Sharing the table brought in exactly one operator this side had
  // never had to word, which is precisely the kind of gap that ships silently.
  const offered = new Set();
  for (const f of Object.values(FIELDS)) for (const op of (SH.OPERATORS_BY_TYPE[f.type] || [])) offered.add(op);
  const unworded = [...offered].filter((op) => !LTR.OPERATOR_LABEL[op]);
  eq(JSON.stringify(unworded.sort()), '[]',
    'E8 …and every one of them has plain-English wording, so no rule renders as a raw operator key');
}

// ── F. THE OWNER'S SPELLING RULE — "Purchase" AND "purchase" ARE ONE VALUE ───
// Owner-directed 2026-08-31, asked whether a rule should match a value spelled
// slightly differently: *"yes, these two should technically mean the same
// because lowercase and uppercase should not be different."*
//
// A rule is typed by a person into a settings screen and compared against a
// value that arrived from a form, a spreadsheet import or another system. There
// is no spelling authority between those two, so "Single Family" and
// "SingleFamily" and "single family" are one value to everybody except a
// character-by-character comparison. Before this, a rule an administrator wrote
// and read back as correct simply never fired, and NOTHING anywhere said why —
// which is the worst shape a rule engine can fail in.
//
// The whole risk of a LOOSER comparison is the other direction: two values that
// are genuinely DIFFERENT collapsing into one, so a rule written for A silently
// also fires on B. F6 is what holds that shut, and it is MEASURED against both
// live registries on every run rather than asserted once.
{
  const LTR = require('../src/longterm/conditions-center/rules');
  const ltReg = require('../src/longterm/conditions-center/field-registry');
  const F = {
    program: { type: 'enum', options: [{ v: 'Single Family' }, { v: '30-Year Fixed' }] },
    note: { type: 'text' },
  };
  const fire = (rules, ctx, fields) => SH.evaluateRule({ combinator: 'and', rules }, ctx, fields || F);

  // ONE normaliser, not two that agree today. The long-term module does not
  // keep its own: it reads the shared one, so the two products cannot drift
  // into meaning different things by the same rule.
  ok(LTR._internals && LTR._internals.norm === SH.normText,
    'F1 the long-term side uses the SHARED normaliser — not a copy of it');

  // The owner's own two examples, on the ENUM branch (which was case-SENSITIVE)
  // and the TEXT branch beside it (which lowercased but kept punctuation).
  ok(fire([{ field: 'program', operator: 'eq', value: 'single family' }], { program: 'Single Family' }),
    'F2 "single family" matches a stored "Single Family" — case is not a difference');
  ok(fire([{ field: 'program', operator: 'eq', value: 'SingleFamily' }], { program: 'Single Family' }),
    'F3 "SingleFamily" matches a stored "Single Family" — a missing space is not a difference');
  ok(fire([{ field: 'note', operator: 'eq', value: 'Purchase' }], { note: 'purchase' }),
    'F4 text answers the same way — "Purchase" is "purchase"');

  // …AND IT HAS A FLOOR. A looser comparison that matched everything would pass
  // F2–F4 and be worthless.
  ok(!fire([{ field: 'program', operator: 'eq', value: 'Multi Family' }], { program: 'Single Family' }),
    'F5a two genuinely different values still do NOT match');
  ok(!fire([{ field: 'program', operator: 'eq', value: 'Single Family' }], { program: '' }),
    'F5b a blank file value does not match a real one');
  ok(fire([{ field: 'program', operator: 'neq', value: 'Multi Family' }], { program: 'Single Family' }),
    'F5c "is not" still answers yes when the values really do differ');
  ok(!fire([{ field: 'program', operator: 'neq', value: 'SINGLE-FAMILY' }], { program: 'Single Family' }),
    'F5d …and "is not" answers NO on two spellings of one value, so the two operators agree');

  // THE SAFETY PROPERTY, re-measured live against BOTH registries every run: no
  // field anywhere offers two options that become the same string once case and
  // punctuation are ignored. Add one and this fails, which is the point — it is
  // the only way the looser comparison could ever match the wrong value.
  const collisions = [];
  const sweep = (product, fields) => {
    for (const [key, f] of Object.entries(fields)) {
      const seen = new Map();
      for (const o of (f.options || [])) {
        const v = typeof o === 'string' ? o : o.v;
        const k = SH.normText(v);
        if (seen.has(k) && seen.get(k) !== v) collisions.push(`${product}.${key}: "${seen.get(k)}" vs "${v}"`);
        seen.set(k, v);
      }
    }
  };
  sweep('short-term', registry.BY_KEY);
  sweep('long-term', ltReg.fieldMap());
  eq(JSON.stringify(collisions), '[]',
    'F6 NO field in either registry offers two options that collapse into one — the looser match cannot confuse two real values');

  // Every operator on both branches agrees about what makes two strings the
  // same. One of them disagreeing is how a rule means one thing written as "is"
  // and another written as "is any of".
  ok(fire([{ field: 'program', operator: 'in', value: ['single-family', 'condo'] }], { program: 'Single Family' }),
    'F7a "is any of" is spelling-tolerant too');
  ok(!fire([{ field: 'program', operator: 'not_in', value: ['single-family'] }], { program: 'Single Family' }),
    'F7b …and so is "is none of"');
  ok(fire([{ field: 'note', operator: 'contains', value: 'Year Fixed' }], { note: '30-year-fixed' }),
    'F7c "contains" reads the two the same way');
  ok(fire([{ field: 'note', operator: 'starts_with', value: '30 Year' }], { note: '30-Year Fixed' }),
    'F7d …as does "starts with"');
  ok(fire([{ field: 'note', operator: 'ends_with', value: 'FIXED' }], { note: '30-Year Fixed' }),
    'F7e …and "ends with"');

  // The long-term evaluator answers identically on its OWN registry, so a rule
  // does not mean one thing on one product and something else on the other.
  const LTF = ltReg.fieldMap();
  const ltEnum = Object.entries(LTF).find(([, f]) => f.type === 'enum' && (f.options || []).length);
  if (ltEnum) {
    const [k, f] = ltEnum;
    const real = typeof f.options[0] === 'string' ? f.options[0] : f.options[0].v;
    const shouted = String(real).toUpperCase().replace(/[_\s]/g, '-');
    ok(LTR.evaluateRule({ combinator: 'and', rules: [{ field: k, operator: 'eq', value: shouted }] },
      { [k]: real }, LTF) === true,
    `F8 the long-term evaluator answers the same way on its own field (${k}: "${shouted}" matches "${real}")`);
  } else {
    ok(false, 'F8 the long-term registry offers no enum options to check the spelling rule against');
  }
}

if (failed) {
  console.log(`\ntest-lt-shared-rule-vocabulary-pure: ${failed} of ${n} checks FAILED`);
  process.exit(1);
}
console.log(`test-lt-shared-rule-vocabulary-pure: ${n} checks passed`);
