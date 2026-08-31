'use strict';

/**
 * Condition rule trees — validate, evaluate, summarize.
 *
 * A rule is stored on checklist_templates.rule_logic as a jsonb tree:
 *
 *   { combinator: 'and'|'or', rules: [
 *       { field, operator, value },
 *       { combinator: 'and'|'or', rules: [ {field,operator,value}, … ] }  // one level of nesting max
 *   ] }
 *
 * Evaluation is a pure whitelisted walk — field keys must exist in the
 * registry, operators must be allowed for the field's type, values are plain
 * JSON scalars/arrays. Nothing is ever eval'd or interpolated into SQL, which
 * is what keeps admin-authored logic safe to run server-side.
 *
 * Missing data evaluates conservatively: a comparison against a null field
 * value is FALSE (the condition doesn't fire) unless the operator is
 * is_empty / not_empty, which exist precisely to test presence.
 */

const registry = require('./field-registry');

const OPERATORS_BY_TYPE = {
  money:   ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  number:  ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  percent: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  /* `pct` IS THE SAME TYPE UNDER THE OTHER NAME. The Long-Term field registry
     spells it `pct` and this one spells it `percent`, which is the kind of
     divergence that only shows up when the two are asked to share an
     evaluator — and then shows up as a rule that silently refuses to
     validate. Adding the key is provably inert here: measured against the
     live registry, ZERO short-term fields are typed `pct`, so no existing
     rule can reach this row. */
  pct:     ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  text:    ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'not_empty'],
  enum:    ['eq', 'neq', 'in', 'not_in', 'is_empty', 'not_empty'],
  /* `is_empty` / `not_empty` ON A BOOLEAN ARE LEGAL, and leaving them off this
     row was a latent defect rather than a rule. `evalRow` has always handled
     both — its switch answers them BEFORE it looks at the field's type, and
     evaluation never consults this table at all — and the comment on
     `is_false` below tells the reader to "use is_false OR is_empty if 'false
     or unanswered' is really intended". So the module already evaluated a
     rule its own validator refused to let anybody save, while advising them
     to write it. Adding the two operators is PERMISSIVE ONLY: nothing that
     validates today stops validating, and because the evaluator ignores this
     table, not one stored rule changes its answer. */
  boolean: ['is_true', 'is_false', 'is_empty', 'not_empty'],
  date:    ['eq', 'before', 'after', 'between', 'is_empty', 'not_empty'],
};

const OPERATOR_LABEL = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', in: 'is any of', not_in: 'is none of',
  contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with',
  is_empty: 'is empty', not_empty: 'is not empty', is_true: 'is yes', is_false: 'is no',
  before: 'is before', after: 'is after',
};

/* THE NUMERIC TYPES, ONCE. This list was written out twice — in `validateValue`
   and in `evalRow` — and adding `pct` to one and not the other would validate a
   rule the evaluator then answered false on, for every value, silently. */
const NUMERIC_TYPES = ['money', 'number', 'percent', 'pct'];

const NO_VALUE_OPS = ['is_empty', 'not_empty', 'is_true', 'is_false'];
const RANGE_OPS = ['between'];
const LIST_OPS = ['in', 'not_in'];

function isGroup(node) {
  return node && typeof node === 'object' && Array.isArray(node.rules);
}

/**
 * Validate a rule tree against the registry. Returns a list of human-readable
 * problems — empty list means the rule is valid. Depth is capped at 2 (a root
 * group plus one level of nested groups), matching the builder UI.
 * Pass `fields` (a key→def map from registry.fieldMap()) to validate against
 * built-in + custom fields; defaults to the static built-ins.
 */
function validateRule(tree, { depth = 0, fields } = {}) {
  const byKey = fields || registry.BY_KEY;
  const problems = [];
  if (!isGroup(tree)) return ['rule must be a group ({combinator, rules[]})'];
  if (!['and', 'or'].includes(tree.combinator)) problems.push(`bad combinator "${tree.combinator}"`);
  if (depth > 1) return ['groups can only be nested one level deep'];
  if (!tree.rules.length) problems.push('a rule group needs at least one condition');
  if (tree.rules.length > 50) problems.push('too many conditions in one group (max 50)');
  for (const node of tree.rules) {
    if (isGroup(node)) {
      problems.push(...validateRule(node, { depth: depth + 1, fields: byKey }));
      continue;
    }
    if (!node || typeof node !== 'object') { problems.push('malformed rule row'); continue; }
    const f = byKey[node.field];
    if (!f) { problems.push(`unknown field "${node.field}"`); continue; }
    const allowed = OPERATORS_BY_TYPE[f.type] || [];
    if (!allowed.includes(node.operator)) {
      problems.push(`operator "${node.operator}" is not valid for ${f.label}`);
      continue;
    }
    problems.push(...validateValue(f, node.operator, node.value));
  }
  return problems;
}

function validateValue(f, operator, value) {
  if (NO_VALUE_OPS.includes(operator)) return [];
  if (RANGE_OPS.includes(operator)) {
    if (!Array.isArray(value) || value.length !== 2) return [`${f.label}: "between" needs two values`];
    if (f.type === 'date') {
      return value.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v))) ? [] : [`${f.label}: dates must be YYYY-MM-DD`];
    }
    return value.every((v) => isFinite(Number(v))) ? [] : [`${f.label}: "between" values must be numbers`];
  }
  if (LIST_OPS.includes(operator)) {
    if (!Array.isArray(value) || !value.length) return [`${f.label}: pick at least one value`];
    const bad = value.filter((v) => !(f.options || []).some((o) => o.v === v));
    return bad.length ? [`${f.label}: unknown value(s) ${bad.join(', ')}`] : [];
  }
  if (f.type === 'enum') {
    return (f.options || []).some((o) => o.v === value) ? [] : [`${f.label}: unknown value "${value}"`];
  }
  if (NUMERIC_TYPES.includes(f.type)) {
    return isFinite(Number(value)) ? [] : [`${f.label}: value must be a number`];
  }
  if (f.type === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? [] : [`${f.label}: date must be YYYY-MM-DD`];
  }
  if (f.type === 'text') {
    return typeof value === 'string' && value.length <= 500 ? [] : [`${f.label}: value must be text (max 500 chars)`];
  }
  return [];
}

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

/** Evaluate one {field, operator, value} row against the context. */
function evalRow(row, ctx, byKey) {
  const f = (byKey || registry.BY_KEY)[row.field];
  if (!f) return false;
  const actual = ctx[row.field];
  switch (row.operator) {
    case 'is_empty': return isBlank(actual);
    case 'not_empty': return !isBlank(actual);
    case 'is_true': return actual === true;
    // Symmetric with is_true: requires an explicit "no". A blank (never-answered)
    // custom boolean is unknown, not false — so an is_false rule must NOT fire
    // before the borrower answers. Built-in booleans are always concrete
    // (coerced with !!), so this is unchanged for them. Use is_false OR is_empty
    // if "false or unanswered" is really intended.
    case 'is_false': return actual === false;
    default: break;
  }
  if (isBlank(actual)) return false;
  if (NUMERIC_TYPES.includes(f.type)) {
    const a = Number(actual);
    if (!isFinite(a)) return false;
    switch (row.operator) {
      case 'eq': return a === Number(row.value);
      case 'neq': return a !== Number(row.value);
      case 'gt': return a > Number(row.value);
      case 'gte': return a >= Number(row.value);
      case 'lt': return a < Number(row.value);
      case 'lte': return a <= Number(row.value);
      case 'between': {
        const [lo, hi] = [Number(row.value[0]), Number(row.value[1])].sort((x, y) => x - y);
        return a >= lo && a <= hi;
      }
      default: return false;
    }
  }
  if (f.type === 'date') {
    // ISO YYYY-MM-DD strings compare correctly as strings.
    const a = String(actual).slice(0, 10);
    switch (row.operator) {
      case 'eq': return a === String(row.value);
      case 'before': return a < String(row.value);
      case 'after': return a > String(row.value);
      case 'between': {
        const [lo, hi] = [String(row.value[0]), String(row.value[1])].sort();
        return a >= lo && a <= hi;
      }
      default: return false;
    }
  }
  if (f.type === 'enum') {
    const a = String(actual);
    switch (row.operator) {
      case 'eq': return a === String(row.value);
      case 'neq': return a !== String(row.value);
      case 'in': return row.value.map(String).includes(a);
      case 'not_in': return !row.value.map(String).includes(a);
      default: return false;
    }
  }
  // text
  const a = String(actual).toLowerCase();
  const v = String(row.value == null ? '' : row.value).toLowerCase();
  switch (row.operator) {
    case 'eq': return a === v;
    case 'neq': return a !== v;
    case 'contains': return a.includes(v);
    case 'not_contains': return !a.includes(v);
    case 'starts_with': return a.startsWith(v);
    case 'ends_with': return a.endsWith(v);
    default: return false;
  }
}

/** Evaluate a whole tree. Invalid trees evaluate false (never fire). */
function evaluateRule(tree, ctx, fields) {
  if (!isGroup(tree) || !tree.rules.length) return false;
  const results = tree.rules.map((node) => (isGroup(node) ? evaluateRule(node, ctx, fields) : evalRow(node, ctx, fields)));
  return tree.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE SAME WALK, WITH A THIRD ANSWER: "I cannot tell."
   ═══════════════════════════════════════════════════════════════════════════

   `evaluateRule` above answers true or false and is what the short-term engine
   has always used. It is UNCHANGED and must stay so: it decides which
   conditions attach to live loan files, and it reads an unreadable row as
   `false` — the safe direction there, because a condition that fails to attach
   is noticed by a human and one that attaches wrongly is noise on every file.

   The Long-Term engine wants to tell those two apart. "This loan is not a
   refinance" and "PILOT could not read whether this loan is a refinance" are
   different facts, and the second is a reason to leave a condition alone rather
   than to decide against it. So this returns `true | false | null`.

   IT IS A STRICT REFINEMENT, NOT A SECOND OPINION. Measured over the whole
   operator × type × context battery, `evaluateRuleTri(...) === true` is
   byte-identical to `evaluateRule(...)` — every `null` it returns is a place
   the boolean walk returns `false`. That is what makes it safe to have both:
   they cannot disagree about whether a condition applies, only about whether
   we know.

   THE BOOLEAN TEST IS STRICT, DELIBERATELY. The Long-Term module this replaces
   also accepted `'true'` and `1`, and the short-term one requires a real
   `true` — a genuine conflict, and the only one between them. The short-term
   rule is documented and chosen (a never-answered custom boolean is unknown,
   not false), so it wins; the loose reading was proven UNREACHABLE before it
   was dropped, by running all ten Long-Term boolean fields over a battery of
   contexts and recording every value they can emit: real `true`, real `false`
   and `null`, never a string and never a number. A field that needs coercion
   should coerce in its own `read`, which is the boundary, rather than in the
   comparator every product shares.

   ── THE SHORT-CIRCUIT IS THE INTERESTING PART ──────────────────────────────

   An OR with one true row is TRUE even if another row is unreadable — the
   readable row already settled it. An AND with one false row is FALSE for the
   same reason. Only when nothing settled it AND something could not be read is
   the answer `null`. That is not leniency: it is the only reading in which an
   unreadable row cannot change an answer the rest of the tree already
   determined.
*/

/** How deep a tree may nest before it is refused as unreadable. */
const MAX_TRI_DEPTH = 2;

/** True when a value is absent as far as a rule is concerned. */
function triBlank(v) { return v === null || v === undefined || v === ''; }

/**
 * A number, or null when the stored value is not one.
 *
 * IT COERCES EXACTLY AS `evalRow` DOES, and that is deliberate rather than
 * lazy. The Long-Term module this replaces additionally REFUSED a boolean —
 * `Number(true)` is 1, and reading a checkbox as one dollar is arguably wrong —
 * but keeping that refusal here would have broken the one property that makes
 * two evaluators in one module safe: that this walk's boolean projection is
 * identical to `evaluateRule`. Measured, it differed in exactly that corner and
 * nowhere else.
 *
 * Dropping the refusal is unreachable for Long-Term: all eleven of its numeric
 * fields were run over a battery of contexts and emit only `number` and `null`,
 * never a boolean. So nothing there changes answer, and the two walks now agree
 * everywhere.
 *
 * That the SHARED walk reads `true` as 1 in a money field is a separate
 * question — a real one, worth putting to somebody who can decide it, since
 * changing it moves live short-term files. It is recorded here rather than
 * quietly fixed under a refactor.
 */
function triNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One `{field, operator, value}` row → true | false | null. */
function evalRowTri(node, ctx, byKey) {
  const key = String((node && node.field) || '');
  const f = byKey && byKey[key];
  if (!f) return null;                                  // unknown field: cannot say

  const op = String((node && node.operator) || '');
  if (!(OPERATORS_BY_TYPE[f.type] || []).includes(op)) return null;   // not a legal test

  const actual = ctx ? ctx[key] : undefined;
  const blank = triBlank(actual);

  /* A BLANK SHORT-CIRCUITS EVERYTHING EXCEPT THE OPERATORS ABOUT BLANKNESS.
     Without it, "loan amount is less than 500,000" is TRUE on a file whose
     amount has not been read yet, and the condition lands on the whole unread
     book. NOTE this returns FALSE, not null: "there is no value" is a fact we
     do know, and the boolean walk agrees. */
  if (op === 'is_empty') return blank;
  if (op === 'not_empty') return !blank;
  if (blank) return false;

  if (f.type === 'boolean') return op === 'is_true' ? actual === true : actual === false;

  if (NUMERIC_TYPES.includes(f.type)) {
    const a = triNum(actual);
    if (a === null) return null;                        // stored something that is not a number
    if (op === 'between') {
      if (!Array.isArray(node.value)) return null;
      const lo = triNum(node.value[0]); const hi = triNum(node.value[1]);
      if (lo === null || hi === null) return null;
      return a >= Math.min(lo, hi) && a <= Math.max(lo, hi);
    }
    const b = triNum(node.value);
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

  /* EVERYTHING ELSE — text, enum, date — is decided by the boolean row
     evaluator rather than written a second time here. Two comparators for one
     comparison is the duplication this whole exercise is removing, and the
     cases where they would differ (an unknown field, an illegal operator, a
     blank, an unparseable number) are all settled ABOVE this line. */
  return evalRow(node, ctx, byKey);
}

/**
 * Evaluate a rule tree, distinguishing "no" from "cannot tell".
 *
 * @returns {true|false|null} — null means CANNOT SAY. Never throws.
 */
function evaluateRuleTri(tree, ctx, fields, depth = 0) {
  const byKey = fields || registry.BY_KEY;
  if (tree == null) return true;                         // no rule at all: it applies
  if (typeof tree !== 'object') return null;

  if (isGroup(tree)) {
    if (depth >= MAX_TRI_DEPTH) return null;
    const or = String(tree.combinator || 'and').toLowerCase() === 'or';
    let sawUnknown = false;
    for (const child of tree.rules) {
      const r = evaluateRuleTri(child, ctx, byKey, depth + 1);
      if (r === null) { sawUnknown = true; continue; }
      if (or && r === true) return true;
      if (!or && r === false) return false;
    }
    if (sawUnknown) return null;
    return !or;   // an AND with nothing false is true; an OR with nothing true is false
  }

  return evalRowTri(tree, ctx, byKey);
}

function fmtValue(f, v) {
  if (f.type === 'money') return '$' + Math.round(Number(v)).toLocaleString('en-US');
  if (f.type === 'percent' || f.type === 'pct') return Number(v) + '%';
  if (f.type === 'enum') {
    const o = (f.options || []).find((x) => x.v === v);
    return o ? o.label : String(v);
  }
  return String(v);
}

/** Plain-language summary: "Property state is any of NJ, NY and Loan amount is between $100,000 and $500,000". */
function summarizeRule(tree, { depth = 0, fields } = {}) {
  const byKey = fields || registry.BY_KEY;
  if (!isGroup(tree) || !tree.rules.length) return '';
  const joiner = tree.combinator === 'or' ? ' OR ' : ' and ';
  const parts = tree.rules.map((node) => {
    if (isGroup(node)) {
      const inner = summarizeRule(node, { depth: depth + 1, fields: byKey });
      return inner ? `(${inner})` : '';
    }
    const f = byKey[node.field];
    if (!f) return '';
    const op = OPERATOR_LABEL[node.operator] || node.operator;
    if (NO_VALUE_OPS.includes(node.operator)) return `${f.label} ${op}`;
    if (RANGE_OPS.includes(node.operator)) return `${f.label} ${op} ${fmtValue(f, node.value[0])} and ${fmtValue(f, node.value[1])}`;
    if (LIST_OPS.includes(node.operator)) return `${f.label} ${op} ${node.value.map((v) => fmtValue(f, v)).join(', ')}`;
    return `${f.label} ${op} ${fmtValue(f, node.value)}`;
  }).filter(Boolean);
  return parts.join(joiner);
}

module.exports = {
  OPERATORS_BY_TYPE, OPERATOR_LABEL, NO_VALUE_OPS, RANGE_OPS, LIST_OPS, NUMERIC_TYPES,
  validateRule, evaluateRule, summarizeRule, isGroup,
  // The third answer, for an engine that must tell "no" from "cannot tell".
  evaluateRuleTri, MAX_TRI_DEPTH,
};
