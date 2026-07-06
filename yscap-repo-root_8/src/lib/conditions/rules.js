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
  text:    ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'not_empty'],
  enum:    ['eq', 'neq', 'in', 'not_in', 'is_empty', 'not_empty'],
  boolean: ['is_true', 'is_false'],
  date:    ['eq', 'before', 'after', 'between', 'is_empty', 'not_empty'],
};

const OPERATOR_LABEL = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', in: 'is any of', not_in: 'is none of',
  contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with',
  is_empty: 'is empty', not_empty: 'is not empty', is_true: 'is yes', is_false: 'is no',
  before: 'is before', after: 'is after',
};

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
  if (['money', 'number', 'percent'].includes(f.type)) {
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
    case 'is_false': return actual === false || isBlank(actual);
    default: break;
  }
  if (isBlank(actual)) return false;
  if (['money', 'number', 'percent'].includes(f.type)) {
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

function fmtValue(f, v) {
  if (f.type === 'money') return '$' + Math.round(Number(v)).toLocaleString('en-US');
  if (f.type === 'percent') return Number(v) + '%';
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

module.exports = { OPERATORS_BY_TYPE, OPERATOR_LABEL, NO_VALUE_OPS, RANGE_OPS, LIST_OPS, validateRule, evaluateRule, summarizeRule, isGroup };
