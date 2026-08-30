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

const MAX_DEPTH = 2;

/** Operators that ask about EMPTINESS and are therefore valid on a blank. */
const EMPTY_OPS = new Set(['is_empty', 'not_empty']);

/** Operators that take no value at all. */
const NO_VALUE_OPS = new Set(['is_empty', 'not_empty', 'is_true', 'is_false']);

/** Which operators each field type accepts. Anything else is refused. */
const OPERATORS_BY_TYPE = {
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'in', 'not_in', 'is_empty', 'not_empty'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  money: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  pct: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  boolean: ['is_true', 'is_false', 'is_empty', 'not_empty'],
  date: ['eq', 'before', 'after', 'between', 'is_empty', 'not_empty'],
};

const OPERATOR_LABEL = {
  eq: 'is', neq: 'is not',
  gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between',
  in: 'is any of', not_in: 'is none of',
  contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with',
  is_empty: 'is blank', not_empty: 'is filled in',
  is_true: 'is yes', is_false: 'is no',
  before: 'is before', after: 'is after',
};

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
 * Answers `{ok, problems:[{reason, detail}]}` — never throws, and NAMES every
 * problem rather than stopping at the first, because a person fixing a rule
 * wants the whole list.
 *
 * `fields` is the registry: `{key: {type, label}}`.
 */
function validateRule(node, fields, depth = 0) {
  const problems = [];
  const add = (reason, detail) => problems.push({ reason, detail, why: REFUSAL[reason] });

  if (node == null) return { ok: true, problems };          // no rule is a valid state
  if (typeof node !== 'object') { add('malformed', typeof node); return { ok: false, problems }; }

  if (isGroup(node)) {
    if (depth >= MAX_DEPTH) { add('too_deep'); return { ok: false, problems }; }
    const comb = String(node.combinator || 'and').toLowerCase();
    if (comb !== 'and' && comb !== 'or') add('malformed', `combinator "${node.combinator}"`);
    for (const child of node.rules) {
      const r = validateRule(child, fields, depth + 1);
      problems.push(...r.problems);
    }
    return { ok: problems.length === 0, problems };
  }

  const key = String(node.field || '');
  const f = fields && fields[key];
  if (!f) { add('unknown_field', key); return { ok: false, problems }; }

  const op = String(node.operator || '');
  const allowed = OPERATORS_BY_TYPE[f.type] || [];
  if (!allowed.includes(op)) { add('bad_operator', `${op} on ${f.label || key}`); return { ok: false, problems }; }

  if (!NO_VALUE_OPS.has(op)) {
    const v = node.value;
    if (op === 'between') {
      if (!Array.isArray(v) || v.length !== 2) add('bad_value', `${f.label || key} needs two values`);
    } else if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(v) || v.length === 0) add('bad_value', `${f.label || key} needs a list`);
    } else if (v == null || v === '') {
      add('bad_value', `${f.label || key} needs a value`);
    }
  }
  return { ok: problems.length === 0, problems };
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
const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '');

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
    const join = String(node.combinator || 'and').toLowerCase() === 'or' ? ' OR ' : ' AND ';
    const parts = node.rules.map((r) => describeRule(r, fields, depth + 1)).filter(Boolean);
    if (!parts.length) return 'Every long-term file.';
    return parts.length === 1 ? parts[0] : `(${parts.join(join)})`;
  }
  const key = String(node.field || '');
  const f = fields && fields[key];
  const label = (f && f.label) || key || 'an unknown field';
  const op = OPERATOR_LABEL[String(node.operator || '')] || String(node.operator || '');
  if (NO_VALUE_OPS.has(node.operator)) return `${label} ${op}`;
  const v = Array.isArray(node.value) ? node.value.join(' and ') : node.value;
  return `${label} ${op} ${v}`;
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
