'use strict';
/**
 * R5.35 (evaluator) — a SAFE, deterministic evaluator for guideline rule
 * expressions. Completes the rule compiler + evaluator + precedence engine.
 *
 * SAFETY: a guideline expression is DATA, never code. This evaluator walks a
 * whitelisted JSON tree — boolean nodes (and/or/not) over leaf comparisons
 * (field <cmp> value) — with NO `eval`, no function construction, no property
 * access beyond a flat context lookup. An unknown operator/comparator throws
 * rather than guessing, so a malformed rule can never silently "pass".
 *
 * Expression shape:
 *   leaf:  { field: 'ltv', cmp: '<=', value: 0.75 }
 *          { field: 'state', cmp: 'in', value: ['NY','NJ'] }
 *          { field: 'reserve_months', cmp: 'between', value: [3, 12] }
 *   node:  { op: 'and'|'or', clauses: [ …expr ] }
 *          { op: 'not', clause: expr }
 *   const: true | false   (a rule that always/never applies)
 *
 * evaluate(expression, context) → { matched, unmet }
 *   unmet = the leaf comparisons that were false (for a plain-English "why not").
 *
 * Pure: no DB, no I/O.
 */

const CMP = {
  '<':  (a, b) => num(a) <  num(b),
  '<=': (a, b) => num(a) <= num(b),
  '>':  (a, b) => num(a) >  num(b),
  '>=': (a, b) => num(a) >= num(b),
  '==': (a, b) => eq(a, b),
  '!=': (a, b) => !eq(a, b),
  'in': (a, b) => Array.isArray(b) && b.some((x) => eq(a, x)),
  'not_in': (a, b) => Array.isArray(b) && !b.some((x) => eq(a, x)),
  'between': (a, b) => Array.isArray(b) && b.length === 2 && num(a) >= num(b[0]) && num(a) <= num(b[1]),
};

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}
// Case-insensitive, trimmed equality for strings; strict for numbers/bools.
function eq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (typeof a === 'number' || typeof b === 'number') return num(a) === num(b);
  return a === b;
}

function evalLeaf(leaf, ctx, unmet) {
  const cmp = CMP[leaf.cmp];
  if (!cmp) throw new Error(`guideline-evaluator: unknown comparator "${leaf.cmp}"`);
  const actual = ctx ? ctx[leaf.field] : undefined;
  // A missing field cannot satisfy a comparison — it is "unmet", never a silent pass.
  let ok;
  if (actual === undefined || actual === null) {
    ok = false;
  } else {
    const r = cmp(actual, leaf.value);
    ok = (r === true);
  }
  if (!ok) unmet.push({ field: leaf.field, cmp: leaf.cmp, expected: leaf.value, actual: actual ?? null });
  return ok;
}

function evalNode(expr, ctx, unmet) {
  if (expr === true) return true;
  if (expr === false) return false;
  if (!expr || typeof expr !== 'object') {
    throw new Error('guideline-evaluator: malformed expression node');
  }
  if (expr.op === 'and') {
    if (!Array.isArray(expr.clauses)) throw new Error('and: clauses[] required');
    // evaluate all clauses (collect every unmet) — result is the AND.
    let all = true;
    for (const c of expr.clauses) { if (!evalNode(c, ctx, unmet)) all = false; }
    return all;
  }
  if (expr.op === 'or') {
    if (!Array.isArray(expr.clauses)) throw new Error('or: clauses[] required');
    // OR: a local unmet list — only surface unmet if the whole OR fails.
    const local = [];
    const any = expr.clauses.some((c) => evalNode(c, ctx, local));
    if (!any) for (const u of local) unmet.push(u);
    return any;
  }
  if (expr.op === 'not') {
    if (!('clause' in expr)) throw new Error('not: clause required');
    const local = [];
    return !evalNode(expr.clause, ctx, local);
  }
  if ('field' in expr && 'cmp' in expr) return evalLeaf(expr, ctx, unmet);
  throw new Error(`guideline-evaluator: unknown expression op "${expr.op}"`);
}

function evaluate(expression, context) {
  const unmet = [];
  // An empty expression is treated as "always applies" (a rule with no gate).
  if (expression == null || (typeof expression === 'object' && Object.keys(expression).length === 0)) {
    return { matched: true, unmet };
  }
  const matched = evalNode(expression, context || {}, unmet);
  return { matched, unmet };
}

module.exports = { evaluate, CMP: Object.freeze(Object.keys(CMP)), _internals: { num, eq, evalNode } };
