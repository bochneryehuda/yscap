'use strict';
/**
 * LONG-TERM — WHY DID THIS RULE NOT FIRE?
 *
 * Owner-directed 2026-09-04: *"The idea was to open audit engines to make sure
 * that every rule is actually firing."*
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 *
 * `logic.matches()` answers true / false / cannot-say for a whole rule. That is
 * the right answer for the OVERLAY, which only needs to know whether to act. It
 * is a useless answer for the PERSON who wrote the rule and is staring at a
 * board it did not touch, because "false" does not say WHICH of their nine
 * conditions was the one that failed — and on a nine-condition rule, finding
 * that by hand means re-reading the board against every row.
 *
 * This module answers the same question row by row, in the words the person
 * typed, and then names the SHORTEST honest reason the rule did not fire.
 *
 * ── IT NEVER KEEPS ITS OWN COPY OF THE SEMANTICS ───────────────────────────
 *
 * ⛔ Every verdict here comes from the SHARED walk — `evaluateRuleTri` on a
 * one-row group — never from re-implementing a comparison. That is the whole
 * safety property of this file. A diagnosis that decides "LTV 85 is between 80
 * and 90" with its own arithmetic is a diagnosis that will one day say a rule
 * fires when the board says it does not, and the person will believe the
 * diagnosis, because the diagnosis is the thing that explains itself.
 *
 * A one-row group is exactly the row's own verdict: the walk evaluates the row
 * and an `and` of one is that value. Asserted directly in
 * `test-lt-pricing-rules-pure.js` (section J) against a battery that includes
 * both `null` answers — an unknown field and an operator the field's type does
 * not take — so the equivalence is held, not assumed.
 *
 * ── "CANNOT SAY" IS NOT "NO" ───────────────────────────────────────────────
 *
 * The tri-state matters most here. A row that cannot be read (a field the
 * registry no longer has, an operator the type does not take) is reported as
 * UNREADABLE, in its own words, and never as a plain failure — because those
 * two have opposite fixes. A failing row means the loan did not qualify; an
 * unreadable row means the RULE is broken and has been quietly doing nothing.
 *
 * PURE: no database, no network, no clock.
 */

const shared = require('../../../lib/conditions/rules');
const fields = require('./fields');
const logic = require('./logic');
const actions = require('./actions');

/** How a row's value reads back to a person, whatever shape it was stored in. */
function wroteValue(op, value) {
  if (shared.NO_VALUE_OPS.includes(op)) return '';
  if (shared.RANGE_OPS.includes(op)) {
    const v = Array.isArray(value) ? value : [];
    return `${v[0] == null || v[0] === '' ? '…' : v[0]} and ${v[1] == null || v[1] === '' ? '…' : v[1]}`;
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '…';
  return value == null || value === '' ? '…' : String(value);
}

/**
 * THE OPERATOR AS IT READS AFTER "is not".
 *
 * The shared labels are written to follow a FIELD NAME — "is more than", "is
 * between" — so dropping one straight into "…, which is not ${label}" produces
 * "which is not is more than 999". The leading "is" is stripped for that one
 * position only; `says` still uses the label whole, because there it genuinely
 * does follow the field name.
 */
const afterNot = (opLabel) => String(opLabel || '').replace(/^is\s+/i, '');

/** How the board's own answer reads back. `undefined` and `null` are the same absence. */
function readValue(actual) {
  if (actual === undefined || actual === null || actual === '') return null;
  if (Array.isArray(actual)) return actual.join(', ');
  if (typeof actual === 'boolean') return actual ? 'yes' : 'no';
  return String(actual);
}

/**
 * ONE ROW, JUDGED AND EXPLAINED.
 *
 * ⛔ THE VERDICT COMES FROM THE SHARED WALK, NOT FROM THIS FUNCTION. Everything
 * below the `verdict` line is wording for a decision already made elsewhere.
 */
function judgeRow(node, facts) {
  const key = String((node && node.field) || '');
  const f = fields.BY_KEY[key];
  const op = String((node && node.operator) || '');
  const label = (f && f.label) || key || '(no field)';
  const opLabel = shared.OPERATOR_LABEL[op] || op || '(no test)';
  const wrote = wroteValue(op, node && node.value);

  let verdict = null;
  try {
    verdict = shared.evaluateRuleTri({ combinator: 'and', rules: [node] }, facts || {}, fields.BY_KEY);
  } catch (_) {
    /* The shared walk is total by contract. This catch exists because the tree
       arrives as stored jsonb from a screen, and an audit screen that throws is
       an audit screen that cannot audit the one rule you needed it for. */
    verdict = null;
  }
  if (verdict !== true && verdict !== false) verdict = null;

  const actual = facts ? facts[key] : undefined;
  const shown = readValue(actual);
  const says = wrote ? `${label} ${opLabel} ${wrote}` : `${label} ${opLabel}`;

  /* WHY, IN THE ORDER A PERSON WOULD ASK IT. The unreadable cases come first
     because they are about the RULE being broken rather than the loan not
     qualifying, and they have completely different fixes. */
  let why;
  let unreadable = false;
  if (verdict === null) {
    unreadable = true;
    if (!f) why = `This rule asks about "${key || '(nothing)'}", which the pricer does not have. It can never match.`;
    else if (!(shared.OPERATORS_BY_TYPE[f.type] || []).includes(op)) {
      why = `"${opLabel}" is not a test that works on ${label}. It can never match.`;
    } else why = `${label} is not a number on this quote, so this test cannot be answered.`;
  } else if (verdict === true) {
    why = shown === null ? 'Matches.' : `Matches — ${label} is ${shown}.`;
  } else if (shown === null) {
    why = `This board carries no ${label}, so this condition is not met.`;
  } else {
    why = `${label} is ${shown}, which is not ${afterNot(opLabel)} ${wrote}.`;
  }

  return { kind: 'row', field: key, label, operator: op, operatorLabel: opLabel, wrote, actual: shown, verdict, unreadable, says, why };
}

/** A group, and one level of groups inside it. */
function judgeGroup(tree, facts, depth) {
  const or = String((tree && tree.combinator) || 'and').toLowerCase() === 'or';
  const rows = (tree && Array.isArray(tree.rules) ? tree.rules : [])
    .map((n) => (logic.isGroup(n) ? judgeGroup(n, facts, (depth || 0) + 1) : judgeRow(n, facts)));

  /* THE GROUP'S OWN VERDICT IS COMPUTED FROM ITS CHILDREN'S, and it must agree
     with the shared walk's answer for the same tree. The tri-state rules: an
     `or` is true if any child is true, false only if ALL are false, otherwise
     cannot-say; an `and` is false if any child is false, true only if ALL are
     true. Anything else is cannot-say — which is exactly `evaluateRuleTri`'s
     own rule, asserted against it in section J rather than trusted. */
  const vs = rows.map((r) => r.verdict);
  let verdict;
  if (!vs.length) verdict = null;
  else if (or) verdict = vs.includes(true) ? true : vs.every((v) => v === false) ? false : null;
  else verdict = vs.includes(false) ? false : vs.every((v) => v === true) ? true : null;

  return { kind: 'group', combinator: or ? 'or' : 'and', verdict, rows };
}

/**
 * THE SHORTEST HONEST REASON. Which rows are actually standing between this
 * rule and firing?
 *
 * ── ONE TEST COVERS BOTH `and` AND `or`, AND THAT IS A PROPERTY, NOT A SHORTCUT
 *
 * The two really do need different answers — in an `and` only the FAILING rows
 * are to blame and the passing ones are noise, while in an `or` NOTHING passed
 * so every row is to blame — and the single test below gives both, because a
 * group is only ever walked when it did not pass:
 *
 *   • a group that PASSED returns at the first line, so its children are never
 *     asked about (this is what stops a satisfied `or` inside an `and` being
 *     blamed for the rule not firing);
 *   • therefore an `or` reaching the loop has NO passing child, so
 *     `child.verdict !== true` is true of every one of them — which is exactly
 *     "every row is to blame".
 *
 * ⛔ SO DO NOT ADD AN `or ||` SHORT-CIRCUIT HERE. The first cut had one, with a
 * comment saying it was load-bearing; a mutation removing it changed no answer
 * on any input, because the case it claimed to handle cannot reach it. A guard
 * whose stated reason is false is worse than no guard, because the next person
 * budgets against it. Section C pins the real property from both sides.
 */
function blockersIn(node, out) {
  const list = out || [];
  if (!node || node.verdict === true) return list;
  if (node.kind === 'row') { list.push(node); return list; }
  for (const child of node.rows || []) {
    if (child.verdict !== true) blockersIn(child, list);
  }
  return list;
}

/**
 * DOES THIS RULE FIRE ON THESE FACTS, AND IF NOT, WHY NOT?
 *
 * @param {object} rule  a rule document ({name, when, then, …})
 * @param {object} facts the fact bag a board would hand the overlay
 */
function diagnose(rule, facts) {
  const r = rule || {};
  const problems = [];

  /* THE SAME TWO VALIDATORS THE DOOR AND THE OVERLAY USE, so "would save",
     "would apply" and "would fire" cannot drift into three opinions. A rule
     whose ACTIONS cannot be read never fires however well its conditions match,
     and a screen that reported it as firing would be describing a holdback that
     is not being taken. */
  const condProblems = logic.validate(r.when);
  for (const p of condProblems) problems.push(p);
  for (const p of actions.validate(r.then)) problems.push(p);

  const tree = condProblems.length ? null : judgeGroup(r.when, facts, 0);
  const verdict = tree ? tree.verdict : null;
  const blockers = tree ? blockersIn(tree, []) : [];
  const unreadableRows = [];
  (function walk(n) {
    if (!n) return;
    if (n.kind === 'row') { if (n.unreadable) unreadableRows.push(n); return; }
    for (const c of n.rows || []) walk(c);
  })(tree);

  /* THE HEADLINE, in one sentence, because that is what a list of forty rules
     can show in a column. `broken` is deliberately separate from `fires: false`
     — "this rule did not match this loan" and "this rule cannot match anything"
     are the two answers the owner needs told apart. */
  /* ⛔ HONEST NOTE, MEASURED RATHER THAN ASSUMED: the `unreadableRows` term is
     REDUNDANT TODAY and is kept anyway. The post-merge audit deleted it and
     both suites stayed green, then swept the whole grammar — 65 fields × every
     operator each type takes × a battery of unreadable values — and found ZERO
     cases where a row is unreadable while `logic.validate` reports no problem:
     the unknown-field and wrong-operator arms are caught by the validator
     first, so `problems` is already non-empty every time.
     It stays because it is the honest statement of the rule ("broken" means
     either) and because it is the term that would bite the day
     `evaluateRuleTri` starts answering null for a row that validates. But
     nothing here should be read as proof that it fires — a guard whose stated
     reason is wrong is worse than no guard, so the reason is written down as it
     actually is. */
  const broken = problems.length > 0 || unreadableRows.length > 0;
  let headline;
  /* THE HEADLINE IS THE PLAIN SENTENCE AND THE DETAIL IS THE LIST BESIDE IT.
     The validator's own wording ("unknown field \"x\"") is precise and is not
     an answer to the question a person is asking, which is whether this rule is
     doing anything — so the headline says that and `problems` carries the rest. */
  if (problems.length) headline = `This rule cannot run as written, so it can never match anything — ${problems[0]}`;
  else if (unreadableRows.length) headline = unreadableRows[0].why;
  else if (verdict === true) headline = 'Fires on this scenario.';
  else if (verdict === false) {
    headline = blockers.length === 1
      ? `Does not fire — ${blockers[0].why}`
      : `Does not fire — ${blockers.length} conditions are not met.`;
  } else headline = 'Cannot say on this scenario.';

  return {
    ruleId: r.id || null,
    name: r.name || null,
    enabled: r.enabled !== false,
    engine: r.engine || 'all',
    /* ⛔ `fires` MEANS "WOULD THIS RULE ACT", NOT "DO ITS CONDITIONS MATCH".
       The overlay refuses a rule whose actions cannot be read, however perfectly
       its conditions match — so answering `true` here would be this screen
       telling an officer a rule is working while the board is throwing it away,
       which is the exact "saveable" vs "appliable" drift `actions.js` records.
       `verdict` below is still the pure condition answer, so nothing is lost. */
    fires: verdict === true && !broken,
    verdict,
    broken,
    headline,
    says: logic.summarize(r.when),
    does: actions.summarize(r.then),
    problems,
    unreadable: unreadableRows,
    blockers,
    tree,
  };
}

module.exports = { diagnose, judgeRow, judgeGroup, blockersIn, _internals: { wroteValue, readValue } };
