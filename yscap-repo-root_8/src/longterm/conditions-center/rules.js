'use strict';
/**
 * LONG-TERM — THE GENERAL CONDITION CENTER'S RULE EVALUATOR.
 *
 * A template's `rule_logic` decides whether a condition belongs on a file. This
 * is the whole of how one is read.
 *
 * ── THE ONE PROPERTY THAT MATTERS ───────────────────────────────────────────
 *
 * NOTHING HERE IS EVER EVALUATED AS CODE. A rule is data: a field KEY the
 * registry carries, an operator from a fixed list, and a value. There is no
 * `eval`, no `Function`, no template that becomes an expression, and no path
 * that reaches a database. A rule naming a field the registry does not carry
 * REFUSES — it does not match, and it does not silently evaluate to true.
 *
 * ── WHY IT REFUSES RATHER THAN GUESSING ─────────────────────────────────────
 *
 * A rule that cannot be read has three possible answers and only one of them is
 * honest. Answering TRUE puts a condition on every file for a reason nobody can
 * explain. Answering FALSE silently takes a real requirement OFF files — which
 * is the expensive direction, because nobody notices a condition that is not
 * there. So an unreadable rule answers `null` — "cannot say" — and the ENGINE
 * decides what that means, in one place, with the reason recorded.
 *
 * ── A BLANK IS NOT A ZERO AND NOT A "NO" ────────────────────────────────────
 *
 * A field the file has no value for short-circuits every comparison to FALSE
 * except the two operators that are ABOUT emptiness (`is_empty`, `not_empty`).
 * Without that, `loan_amount lt 500000` matches a file with no loan amount, and
 * a condition meant for small loans lands on every unread file in the book.
 *
 * ── THE GRAMMAR IS THE SHORT-TERM RULE BUILDER'S SHAPE, ON PURPOSE ──────────
 *
 * `{combinator: 'and'|'or', rules: [ {field, operator, value} | <group> ]}`,
 * with ONE level of nesting. That shape is a design convention shared so the two
 * products read the same to a person moving between them — the grammar, not the
 * code: this evaluator, its registry and every table it serves are Long-Term's
 * own (CLAUDE.md rule 6).
 *
 * DEPTH IS CAPPED AT ONE NESTED LEVEL because a rule nobody can read on a screen
 * is a rule nobody can maintain, and because an uncapped tree from a jsonb column
 * is an unbounded recursion on somebody else's input.
 *
 * PURE. No database, no network, no clock. Every function is total: bad input
 * produces a refusal, never a throw.
 */

/* THE SHARED CONDITION CENTER'S OWN RULE MODULE — authorized in
   docs/LONG-TERM-AUTHORIZED-COPIES.md under the 2026-08-30 share-the-code grant.
   What comes from it is WHAT COUNTS AS A VALID RULE: the operator table and the
   validator. What stays here is Long-Term's own reading of its own data — see
   `validateRule` and `evaluateRule` below, each of which says why. */
const shared = require('../../lib/conditions/rules');

const MAX_DEPTH = 2;

/** Operators that ask about EMPTINESS and are therefore valid on a blank. */
const EMPTY_OPS = new Set(['is_empty', 'not_empty']);

/* Operators that take no value at all — the SHARED list, in the Set shape this
   module and its route already use. Built from the shared array rather than
   retyped, so the two can never disagree about which operators need a value. */
const NO_VALUE_OPS = new Set(shared.NO_VALUE_OPS);

/* WHICH OPERATORS EACH FIELD TYPE ACCEPTS — THE SHARED TABLE, not a copy.
   This was a second definition of the same rule, and two tables agreeing today
   is not one definition; it is two copies that have not drifted yet. Measured
   before they were joined: on the six types Long-Term uses they were already
   IDENTICAL except that this side offered `in` / `not_in` on text and the shared
   side offered `ends_with`. Both now live in the shared table, so this side
   loses nothing and the builder gains `ends_with` — which `compareText` below
   answers, so the table and the evaluator agree about every operator offered.
   A type the shared table carries and Long-Term has no field of (`percent`) is
   simply never reached. */
const OPERATORS_BY_TYPE = shared.OPERATORS_BY_TYPE;

/* THE OPERATOR WORDING IS THE SHARED TABLE'S. It was a second copy, and two of
   its entries had drifted — `is_empty` read "is blank" and `not_empty` read
   "is filled in" against the shared module's "is empty" / "is not empty" — so a
   rule read one way on a long-term screen and another wherever the shared
   summariser rendered it. The `ends_with` patch this table used to carry is no
   longer needed either: the shared table has it. */
const OPERATOR_LABEL = shared.OPERATOR_LABEL;

/**
 * WHY A RULE COULD NOT BE READ. Each is a different piece of work: an unknown
 * field means somebody renamed something, a bad operator means a rule was hand-
 * edited, and a malformed tree means the jsonb is not a rule at all.
 */
const REFUSAL = {
  unknown_field: 'This rule names a field the system does not have.',
  bad_operator: 'This rule uses a test that field does not support.',
  malformed: 'This rule is not shaped like a rule.',
  too_deep: 'This rule is nested deeper than the builder allows.',
  bad_value: 'This rule compares against a value of the wrong kind.',
};

const isGroup = (n) => !!n && typeof n === 'object' && Array.isArray(n.rules);

/**
 * Is this a rule tree the builder could have produced?
 *
 * THE ANSWER IS THE SHARED CONDITION CENTER'S. This function used to be a second
 * implementation of the same question, which is exactly what the share-the-code
 * directive removed: two validators agreeing today is not one definition, and the
 * one that drifts is the one that starts accepting a rule the other refuses. It
 * delegates, and adds only the two things that are genuinely Long-Term's own.
 *
 * ── ONE: NO RULE AT ALL IS A VALID STATE ────────────────────────────────────
 * Every one of the 28 conditions in Long-Term's shipped library carries
 * `ruleLogic: null` — it applies to every file — so this is load-bearing rather
 * than theoretical. It is a fact about Long-Term's DATA, not about rule grammar,
 * which is why it lives at this seam and not in the shared validator: the shared
 * builder never hands its validator a null, so teaching it to accept one would
 * loosen a check for a caller that does not need it.
 *
 * ── TWO: A BARE ROW AT THE ROOT ─────────────────────────────────────────────
 * The shared validator requires the root to be a GROUP. Long-Term's evaluator has
 * always also read a single `{field, operator, value}` at the root, so one is
 * wrapped in a one-row AND group FOR THE PURPOSE OF VALIDATION ONLY. The stored
 * rule is untouched, and the wrap cannot change the verdict: a one-row AND group
 * is the same rule.
 *
 * The SHAPE stays Long-Term's — `{ok, problems:[{reason, detail, why}]}`, which
 * its screens and its library check both read. The shared validator answers a
 * flat `string[]`; each string becomes one problem carrying the shared module's
 * own sentence, so the two can never describe one refusal two different ways.
 *
 * Never throws. `fields` is the registry: `{key: {type, label, options}}`.
 */
function validateRule(node, fields) {
  // Long-Term's own reading of its own data — see ONE above.
  if (node == null) return { ok: true, problems: [] };

  if (typeof node !== 'object') {
    return { ok: false, problems: [{ reason: 'malformed', detail: typeof node, why: REFUSAL.malformed }] };
  }

  // See TWO above: validate a bare row as the one-row group it means.
  const tree = isGroup(node) ? node : { combinator: 'and', rules: [node] };

  let messages;
  try {
    messages = shared.validateRule(tree, { fields: fields || {} });
  } catch (e) {
    /* The shared validator is total by contract, so this is unreachable — and a
       rule builder that 500s instead of saying "that rule is not valid" is a
       worse failure than the one it would be reporting, so it is caught anyway
       and answers the honest refusal. */
    return { ok: false, problems: [{ reason: 'malformed', detail: String(e && e.message), why: REFUSAL.malformed }] };
  }

  const problems = (messages || []).map((m) => ({ reason: reasonOf(m), detail: m, why: m }));
  return { ok: problems.length === 0, problems };
}

/* THE SHARED MESSAGE IS THE WORDING; this only sorts it into one of Long-Term's
   own reason codes, which its screens colour by. It is a best-effort READING of
   a sentence, so it falls through to `malformed` — the least specific code —
   rather than guessing, and nothing downstream depends on the code being right:
   `detail` and `why` always carry the shared validator's own words. */
function reasonOf(message) {
  const m = String(message || '');
  if (/^unknown field/i.test(m)) return 'unknown_field';
  if (/^operator /i.test(m)) return 'bad_operator';
  if (/nested one level deep/i.test(m)) return 'too_deep';
  if (/: /.test(m)) return 'bad_value';
  return 'malformed';
}

/**
 * Evaluate a rule tree against one file's values.
 *
 * @returns {true|false|null} — null means CANNOT SAY. Never a throw.
 *
 * `values` is `{key: value}` as the registry read them off the loan.
 */
function evaluateRule(node, values, fields, depth = 0) {
  if (node == null) return true;                            // no rule = applies
  if (typeof node !== 'object') return null;

  if (isGroup(node)) {
    if (depth >= MAX_DEPTH) return null;
    const or = String(node.combinator || 'and').toLowerCase() === 'or';
    let sawUnknown = false;
    for (const child of node.rules) {
      const r = evaluateRule(child, values, fields, depth + 1);
      if (r === null) { sawUnknown = true; continue; }
      // SHORT-CIRCUIT ON A DECIDED ANSWER, and only then. An OR with one true
      // row is true even if another row is unreadable — the readable row already
      // settled it — and an AND with one false row is false for the same reason.
      // That is not leniency: it is the only reading that does not let a broken
      // row change an answer the rest of the tree already determined.
      if (or && r === true) return true;
      if (!or && r === false) return false;
    }
    // Nothing settled it, and something could not be read: cannot say.
    if (sawUnknown) return null;
    return !or;   // an AND with nothing false is true; an OR with nothing true is false
  }

  const key = String(node.field || '');
  const f = fields && fields[key];
  if (!f) return null;

  const op = String(node.operator || '');
  if (!(OPERATORS_BY_TYPE[f.type] || []).includes(op)) return null;

  const actual = values ? values[key] : undefined;
  const blank = actual == null || actual === '';

  // A BLANK SHORT-CIRCUITS EVERYTHING EXCEPT THE TWO OPERATORS ABOUT BLANKNESS.
  // Without this, "loan amount is less than 500,000" is TRUE on a file whose
  // amount has not been read yet, and the condition lands on the whole unread
  // book.
  if (EMPTY_OPS.has(op)) return op === 'is_empty' ? blank : !blank;
  if (blank) return false;

  switch (f.type) {
    case 'boolean': {
      const b = actual === true || actual === 'true' || actual === 1 || actual === '1';
      return op === 'is_true' ? b : !b;
    }
    case 'number': case 'money': case 'pct': return compareNumber(op, actual, node.value);
    case 'date': return compareDate(op, actual, node.value);
    default: return compareText(op, actual, node.value);
  }
}

function num(v) {
  if (v === true || v === false) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function compareNumber(op, actual, value) {
  const a = num(actual);
  if (a === null) return null;                    // stored something that is not a number
  if (op === 'between') {
    if (!Array.isArray(value)) return null;
    const lo = num(value[0]); const hi = num(value[1]);
    if (lo === null || hi === null) return null;
    return a >= Math.min(lo, hi) && a <= Math.max(lo, hi);
  }
  const b = num(value);
  if (b === null) return null;
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: return null;
  }
}

/**
 * Dates are compared as CALENDAR DAYS, from the string, never through a local
 * Date. `new Date('2026-01-01')` is midnight UTC and renders as the previous day
 * west of Greenwich — the timezone-shift class this repo has been bitten by more
 * than once.
 */
function dayOf(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function compareDate(op, actual, value) {
  const a = dayOf(actual);
  if (!a) return null;
  if (op === 'between') {
    if (!Array.isArray(value)) return null;
    const lo = dayOf(value[0]); const hi = dayOf(value[1]);
    if (!lo || !hi) return null;
    const [x, y] = lo <= hi ? [lo, hi] : [hi, lo];
    return a >= x && a <= y;
  }
  const b = dayOf(value);
  if (!b) return null;
  switch (op) {
    case 'eq': return a === b;
    case 'before': return a < b;
    case 'after': return a > b;
    default: return null;
  }
}

/**
 * Text and enums compare case- and space-insensitively.
 *
 * A tenant types "Single Family" and the dictionary says "SingleFamily"; a
 * condition that fired on one spelling and not the other would be a bug nobody
 * could see from the rule. `norm` is the ONE normaliser, so every text operator
 * agrees about what two strings being "the same" means.
 */
/* THE SHARED NORMALISER, not a copy of it. This rule — that case and the
   punctuation between words are formatting rather than meaning — is now the
   owner's answer for BOTH products (2026-08-31), and the short-term evaluator
   compares the same way. Long-Term had it first; keeping a private copy is how
   the two would come to disagree about whether "Single Family" is the same
   value as "single_family", which decides whether a condition lands on a file. */
const norm = shared.normText;

function compareText(op, actual, value) {
  const a = norm(actual);
  const list = Array.isArray(value) ? value.map(norm) : null;
  switch (op) {
    case 'in': return list ? list.includes(a) : null;
    case 'not_in': return list ? !list.includes(a) : null;
    case 'eq': return a === norm(value);
    case 'neq': return a !== norm(value);
    case 'contains': return a.includes(norm(value));
    case 'not_contains': return !a.includes(norm(value));
    case 'starts_with': return a.startsWith(norm(value));
    /* `ends_with` arrives with the SHARED operator table. Without this row the
       builder would offer an operator this evaluator answers "cannot say" to —
       a control that silently does nothing, which is worse than not offering it.
       Through the same `norm` as every other text test, so it cannot disagree
       with `starts_with` about what two strings are made of. */
    case 'ends_with': return a.endsWith(norm(value));
    default: return null;
  }
}

/**
 * The rule in plain words, for the settings screen and for an audit line.
 *
 * A rule an administrator cannot READ is a rule they cannot safely change, and
 * this is the whole reason the buckets and the library are editable at all.
 */
function describeRule(node, fields, depth = 0) {
  if (node == null) return 'Every long-term file.';
  if (typeof node !== 'object') return 'An unreadable rule.';
  if (isGroup(node)) {
    if (depth >= MAX_DEPTH) return 'A rule nested too deeply to read.';
    // ── THE WORDS ARE THE SHARED MODULE'S, NOT A SECOND COPY ────────────────
    //
    // This used to render the sentence itself, and it drifted — silently, for as
    // long as no shipped rule had more than one row. The first multi-row rule
    // (the vesting one, 2026-08-31) showed three differences at once: this file
    // bracketed the outermost group where the shared one does not, joined with
    // " AND " where it joins with " and ", and called `is_empty` "is blank"
    // against its "is empty". `test-lt-shared-rule-vocabulary-pure` D3 is what
    // caught it, and it could only ever have caught it on such a rule.
    //
    // So the sentence comes from `shared.summarizeRule` — the module this one is
    // meant to be replaced by, and already the source of NO_VALUE_OPS,
    // OPERATORS_BY_TYPE, validateRule and normText here. What stays local is
    // only the wording for the cases it does not cover: no rule at all, and a
    // rule that is not readable as one.
    const said = shared.summarizeRule(node, { fields: fields || {} });
    return said || 'Every long-term file.';
  }
  return shared.summarizeRule({ combinator: 'and', rules: [node] }, { fields: fields || {} })
    || 'An unreadable rule.';
}

module.exports = {
  MAX_DEPTH,
  OPERATORS_BY_TYPE,
  OPERATOR_LABEL,
  NO_VALUE_OPS,
  REFUSAL,
  validateRule,
  evaluateRule,
  describeRule,
  _internals: { norm, dayOf, compareNumber, compareDate, compareText },
};
