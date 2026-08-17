'use strict';
/**
 * LT PPE — the universal RULE / CONDITION BUILDER (the authoring layer, PPE item #48).
 * PURE: no DB, no network, no clock, no config. A partial spec goes in, a VALIDATED,
 * frozen, canonical rule comes out — or the operation is REFUSED with a clear reason.
 *
 * WHAT "BEST-IN-CLASS" LOOKS LIKE (LoanPass / Polly / LenderPrice / LoanSifter), at a
 * high level, and why this file is shaped the way it is:
 *   • Every one of those authoring layers models a price/eligibility rule as a
 *     WHEN → THEN pair: a boolean CONDITION over scenario dimensions (FICO, LTV,
 *     loan amount, state, purpose, occupancy, prepay, units, borrower type, …) and a
 *     typed RESULT (add price/LLPA points, adjust margin, hold back, disqualify, floor
 *     or cap the price). This builder authors exactly that pair.
 *   • They keep ONE internal rule representation and layer an editor on top — they do
 *     NOT invent a second shape per screen. So this file authors the SAME canonical
 *     rule the existing interpreter (`rules.evaluateRules`) already prices — the three
 *     kinds `eligibility | bound | pricing`, and the same predicate leaves/ops
 *     (`rules.LEAF_OPS`). Nothing here is a parallel rule model; it is a validated,
 *     immutable factory + editor over the shape already in production.
 *   • They are DETERMINISTIC and STATELESS: an authoring operation is a pure function
 *     of its inputs. So is every function here — immutable-in / new-out, no shared
 *     references with the input, output deep-frozen so a caller cannot silently mutate
 *     an authored rule.
 *
 * THE RESULT KINDS (the "THEN"), mapped onto the canonical rule shape:
 *   • add-LLPA points        → kind 'pricing', adjustment.unit 'points'   (addLlpa)
 *   • margin / holdback      → kind 'pricing', adjustment.unit 'margin'|'holdback' (addMarginHoldback)
 *   • eligibility disqualify → kind 'eligibility', declineReason          (addEligibility)
 *   • min / max price        → kind 'bound', target 'price', op 'min'|'max' (addPriceBound)
 *
 * THE "WHEN" (scope) — a rule is scoped to ANY dimension by ANDing a predicate leaf on
 * that dimension's fact into `when`. `DIMENSIONS` is the ONE catalog of authorable
 * dimensions + their value kind, so scope/rescope FAIL CLOSED on an unknown dimension
 * or a value of the wrong kind (a state that is not a real code, an `io` that is not a
 * boolean, a band on a non-numeric dimension) — an over-eager scope would silently
 * author a rule that prices or declines the wrong loans. The state whitelist is
 * IMPORTED from `disqualify-crosswalk` (never a second copy). Bands reuse
 * `ratesheet.bandPredicate` — the ONE half-open [min,max) definition. The margin/holdback
 * milli validity rule is IMPORTED from `margin-holdback._milliOrNull` (never a second copy).
 *
 * REFUSAL DISCIPLINE: `validateRule(rule)` is the ONE validator — a pure predicate that
 * returns { ok, errors[] } and never throws. Every authoring OPERATION runs it and
 * THROWS a clear `RuleBuilderError` when the result is invalid, so a caller can never be
 * handed a silently-malformed rule. Nothing here invents a business/pricing number — it
 * only shapes and checks what the caller supplies.
 *
 * UNITS (the one convention the whole PPE speaks — rules.js / quote.js / crosswalk.js):
 * fico = integer score; ltv/cltv/dscr = milli (75% → 75000, 1.25 → 1250); loan_amount =
 * dollars; units = integer; state = 2-letter code; io/booleans = boolean; price/points/
 * margin/holdback adjustments = milli-points. The builder validates values in the
 * dimension's native unit — it NEVER scales, because "is 75 a percent or a milli?" is a
 * caller decision, not this file's to guess.
 *
 * LT-only. No RTL imports.
 */

const { LEAF_OPS } = require('./rules');
const { bandPredicate } = require('./ratesheet');
const { _milliOrNull } = require('./margin-holdback');
const { _internals: crosswalkInternals } = require('./disqualify-crosswalk');

const STATE_CODES = crosswalkInternals.STATE_CODES; // the ONE state whitelist (imported, never copied)

// ---- refusal type -----------------------------------------------------------

class RuleBuilderError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'RuleBuilderError';
    if (errors) this.errors = errors;
  }
}

// ---- constants (the vocabulary) ---------------------------------------------

const RULE_KINDS = Object.freeze(['eligibility', 'bound', 'pricing']);
const RULE_SOURCES = Object.freeze(['base', 'overlay']);
const BOUND_OPS = Object.freeze(['min', 'max']);
// The recognized pricing RESULT kinds (the adjustment `unit`). Fail-closed: any other
// unit is refused, never silently priced.
const PRICING_UNITS = Object.freeze(['points', 'margin', 'holdback']);

/**
 * DIMENSIONS — the ONE catalog of authorable when-dimensions. Each entry names the
 * predicate-leaf `fact` it constrains and the `kind` of value it accepts:
 *   int     — integer (fico score, units count)
 *   milli   — a milli-scaled ratio, supplied already in milli (ltv/cltv 75% → 75000, dscr 1.25 → 1250)
 *   dollars — a dollar amount (loan_amount)
 *   state   — a 2-letter US state code (validated against the shared whitelist)
 *   enum    — a free string token (purpose/occupancy/property_type/prepay/borrower_type);
 *             the MECHANISM accepts any token — the allowed set is a business rule this
 *             file deliberately does not hard-code.
 *   bool    — a boolean (io / interest-only)
 * The fact names are the same vocabulary the crosswalk + rate-sheet grid already speak.
 */
const DIMENSIONS = Object.freeze({
  fico: { fact: 'fico', kind: 'int' },
  ltv: { fact: 'ltv', kind: 'milli' },
  cltv: { fact: 'cltv', kind: 'milli' },
  dscr: { fact: 'dscr', kind: 'milli' },
  loan_amount: { fact: 'loan_amount', kind: 'dollars' },
  units: { fact: 'units', kind: 'int' },
  state: { fact: 'state', kind: 'state' },
  purpose: { fact: 'purpose', kind: 'enum' },
  occupancy: { fact: 'occupancy', kind: 'enum' },
  property_type: { fact: 'property_type', kind: 'enum' },
  prepay: { fact: 'prepay', kind: 'enum' },
  borrower_type: { fact: 'borrower_type', kind: 'enum' },
  io: { fact: 'io', kind: 'bool' },
});
const NUMERIC_KINDS = new Set(['int', 'milli', 'dollars']);

function dimensionNames() { return Object.keys(DIMENSIONS); }

// ---- immutability helpers ---------------------------------------------------

// Deep clone via JSON — every value in a rule (numbers, strings, booleans, null,
// arrays, plain objects) is JSON-safe, so this can never carry a shared reference
// or a function through. Refuses undefined (JSON drops it) by round-tripping.
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

function deepFreeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Object.keys(x)) deepFreeze(x[k]);
  }
  return x;
}

function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }
function isInteger(x) { return typeof x === 'number' && Number.isInteger(x); }
function isNonEmptyString(x) { return typeof x === 'string' && x.trim().length > 0; }

// ---- predicate validation (reuses rules.LEAF_OPS) ---------------------------

/**
 * Validate a predicate TREE against the exact grammar `rules._evalNode` accepts:
 *   tree: { all:[...] } | { any:[...] } | { none:[...] } | { not: <node> }
 *   leaf: { fact:<non-empty string>, op:<LEAF_OPS>, value:<per op> }
 * A `null`/absent predicate is legal ONLY as the whole `when` (the base row that
 * matches everything) — never as a child of a tree. Returns a list of problem strings
 * (empty = valid). Never throws.
 */
function predicateProblems(node, { path = 'when', top = true } = {}) {
  const errs = [];
  if (node == null) {
    if (!top) errs.push(`${path}: null is not allowed inside a predicate tree`);
    return errs;
  }
  if (typeof node !== 'object' || Array.isArray(node)) {
    errs.push(`${path}: predicate node must be an object`);
    return errs;
  }
  const treeKeys = ['all', 'any', 'none'].filter((k) => k in node);
  const hasNot = 'not' in node;
  const isLeaf = 'fact' in node || 'op' in node;

  // Exactly one shape: a combinator array, OR a `not`, OR a leaf — never mixed.
  const shapes = treeKeys.length + (hasNot ? 1 : 0) + (isLeaf ? 1 : 0);
  if (shapes === 0) { errs.push(`${path}: node is neither a combinator, a not, nor a leaf`); return errs; }
  if (shapes > 1) { errs.push(`${path}: node mixes shapes (combinator/not/leaf) — keep one per node`); return errs; }

  if (treeKeys.length === 1) {
    const k = treeKeys[0];
    const arr = node[k];
    if (!Array.isArray(arr) || arr.length === 0) { errs.push(`${path}.${k}: must be a non-empty array`); return errs; }
    arr.forEach((child, i) => errs.push(...predicateProblems(child, { path: `${path}.${k}[${i}]`, top: false })));
    return errs;
  }
  if (hasNot) {
    errs.push(...predicateProblems(node.not, { path: `${path}.not`, top: false }));
    return errs;
  }

  // a leaf
  if (!isNonEmptyString(node.fact)) errs.push(`${path}.fact: must be a non-empty string`);
  if (!LEAF_OPS.has(node.op)) { errs.push(`${path}.op: unknown op ${JSON.stringify(node.op)} (allowed: ${[...LEAF_OPS].join(', ')})`); return errs; }
  if (node.op === 'exists') return errs; // value ignored
  if (!('value' in node)) { errs.push(`${path}.value: required for op ${node.op}`); return errs; }
  if (node.op === 'between') {
    const v = node.value;
    if (!Array.isArray(v) || v.length !== 2 || !isFiniteNumber(v[0]) || !isFiniteNumber(v[1])) errs.push(`${path}.value: 'between' needs [min, max] numbers`);
    else if (!(v[0] < v[1])) errs.push(`${path}.value: 'between' min ${v[0]} must be < max ${v[1]}`);
  } else if (node.op === 'in' || node.op === 'nin') {
    if (!Array.isArray(node.value) || node.value.length === 0) errs.push(`${path}.value: '${node.op}' needs a non-empty array`);
  }
  return errs;
}

// ---- the ONE rule validator -------------------------------------------------

const COMMON_KEYS = new Set(['code', 'kind', 'source', 'when', 'priority', 'description']);
const KIND_KEYS = {
  eligibility: new Set(['declineReason']),
  bound: new Set(['target', 'op', 'value']),
  pricing: new Set(['adjustment']),
};

/**
 * validateRule(rule) → { ok, errors[] }. The SINGLE definition of a valid authored LT
 * PPE rule, consistent with everything `rules.evaluateRules` requires plus the authoring
 * invariants (a stable non-empty `code`; no cross-kind fields; a recognized pricing unit).
 * Pure — never throws. Every authoring operation runs this and refuses on !ok.
 */
function validateRule(rule) {
  const errors = [];
  if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
    return { ok: false, errors: ['rule must be an object'] };
  }
  if (!isNonEmptyString(rule.code)) errors.push('code: an authored rule needs a stable non-empty code');
  if (!RULE_KINDS.includes(rule.kind)) {
    errors.push(`kind: must be one of ${RULE_KINDS.join(' | ')} (got ${JSON.stringify(rule.kind)})`);
    return { ok: false, errors }; // can't check kind-specific fields without a known kind
  }
  if (rule.source !== undefined && !RULE_SOURCES.includes(rule.source)) errors.push(`source: must be ${RULE_SOURCES.join(' | ')}`);
  if (rule.priority !== undefined && !isFiniteNumber(rule.priority)) errors.push('priority: must be a finite number');
  if (rule.description !== undefined && typeof rule.description !== 'string') errors.push('description: must be a string');
  if (rule.when !== undefined) errors.push(...predicateProblems(rule.when, { path: 'when', top: true }));

  // No cross-kind fields — an eligibility rule carrying an `adjustment`, a bound carrying
  // a `declineReason`, etc., is a silently-malformed hybrid. Refuse it.
  const allowed = new Set([...COMMON_KEYS, ...KIND_KEYS[rule.kind]]);
  for (const k of Object.keys(rule)) {
    if (!allowed.has(k)) errors.push(`${k}: not a valid field on a '${rule.kind}' rule`);
  }

  if (rule.kind === 'eligibility') {
    if (!isNonEmptyString(rule.declineReason)) errors.push('declineReason: an eligibility rule needs a non-empty decline reason');
  } else if (rule.kind === 'bound') {
    if (!isNonEmptyString(rule.target)) errors.push('target: a bound needs a non-empty target (e.g. "price", "ltv")');
    if (!BOUND_OPS.includes(rule.op)) errors.push(`op: a bound needs op ${BOUND_OPS.join(' | ')} (got ${JSON.stringify(rule.op)})`);
    if (!isFiniteNumber(rule.value)) errors.push('value: a bound needs a finite numeric value');
  } else if (rule.kind === 'pricing') {
    const a = rule.adjustment;
    if (a == null || typeof a !== 'object' || Array.isArray(a)) {
      errors.push('adjustment: a pricing rule needs an adjustment object');
    } else {
      if (!isInteger(a.adjMilli)) errors.push('adjustment.adjMilli: must be an integer number of milli-points');
      const unit = a.unit === undefined ? 'points' : a.unit;
      if (!PRICING_UNITS.includes(unit)) errors.push(`adjustment.unit: must be ${PRICING_UNITS.join(' | ')} (got ${JSON.stringify(a.unit)})`);
      // margin & holdback are non-negative milli — the SAME rule the resolver applies.
      if ((unit === 'margin' || unit === 'holdback') && isInteger(a.adjMilli) && _milliOrNull(a.adjMilli) == null) {
        errors.push(`adjustment.adjMilli: a ${unit} must be a non-negative integer of milli-points`);
      }
      if (a.category !== undefined && !isNonEmptyString(a.category)) errors.push('adjustment.category: must be a non-empty string when present');
      if (a.reason !== undefined && typeof a.reason !== 'string') errors.push('adjustment.reason: must be a string when present');
      if (a.dimension !== undefined && a.dimension !== null && typeof a.dimension !== 'string') errors.push('adjustment.dimension: must be a string when present');
      if (a.cumulative !== undefined && typeof a.cumulative !== 'boolean') errors.push('adjustment.cumulative: must be a boolean when present');
      if (a.code !== undefined && a.code !== null && typeof a.code !== 'string') errors.push('adjustment.code: must be a string when present');
    }
  }
  return { ok: errors.length === 0, errors };
}

// Validate `rule`, throw a clear RuleBuilderError on !ok, else return a deep-frozen clone.
function finalize(rule, opLabel) {
  const v = validateRule(rule);
  if (!v.ok) throw new RuleBuilderError(`${opLabel}: refused — ${v.errors.join('; ')}`, v.errors);
  return deepFreeze(clone(rule));
}

// ---- core authoring operations ----------------------------------------------

/**
 * createRule(spec) — the general constructor. `spec` is a partial rule in the canonical
 * shape; `source` defaults to 'base'. Validated + frozen, or REFUSED.
 */
function createRule(spec) {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RuleBuilderError('createRule: refused — spec must be an object');
  }
  const rule = clone(spec);
  if (rule.source === undefined) rule.source = 'base';
  return finalize(rule, 'createRule');
}

/**
 * duplicateRule(rule, patch?) — a validated COPY under a NEW code. When `patch.code` is
 * omitted the new code is `${code}_copy` (deterministic, never collides with the source).
 * The source is never mutated; the result is a fresh frozen rule.
 */
function duplicateRule(rule, patch = {}) {
  if (rule == null || typeof rule !== 'object') throw new RuleBuilderError('duplicateRule: refused — rule must be an object');
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) throw new RuleBuilderError('duplicateRule: refused — patch must be an object');
  const next = clone(rule);
  const newCode = patch.code !== undefined ? patch.code : `${rule.code}_copy`;
  Object.assign(next, clone(patch));
  next.code = newCode;
  if (isNonEmptyString(rule.code) && next.code === rule.code) {
    throw new RuleBuilderError('duplicateRule: refused — the copy must have a different code than the source');
  }
  return finalize(next, 'duplicateRule');
}

/**
 * editRule(rule, patch) — apply a shallow patch (a wholesale replacement per top-level
 * key: pass a full `adjustment`/`when` to change it) and re-validate. Immutable: returns
 * a new frozen rule, never mutates the input.
 */
function editRule(rule, patch) {
  if (rule == null || typeof rule !== 'object') throw new RuleBuilderError('editRule: refused — rule must be an object');
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) throw new RuleBuilderError('editRule: refused — patch must be an object');
  const next = clone(rule);
  // Iterate the ORIGINAL patch keys — a JSON clone would drop `undefined` values, so the
  // explicit-delete contract (patch a key to `undefined` to remove it) must be read here.
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) delete next[k];
    else next[k] = clone(patch[k]);
  }
  return finalize(next, 'editRule');
}

// ---- result-kind constructors (the four "THEN"s) ----------------------------

/**
 * addEligibility({ code, declineReason, when?, source?, priority?, description? })
 * → an eligibility DISQUALIFY rule: a match produces a structured decline.
 */
function addEligibility(spec = {}) {
  const { code, declineReason, when, source, priority, description } = spec;
  const rule = { code, kind: 'eligibility', declineReason };
  if (when !== undefined) rule.when = when;
  if (source !== undefined) rule.source = source; else rule.source = 'base';
  if (priority !== undefined) rule.priority = priority;
  if (description !== undefined) rule.description = description;
  return finalize(rule, 'addEligibility');
}

/**
 * addLlpa({ code, adjMilli, when?, dimension?, category?, reason?, cumulative?, source?, priority?, description? })
 * → an add-LLPA-POINTS pricing rule. `adjMilli` is a signed integer of milli-points
 * (the caller supplies the number; the sign convention is the engine's — see rules.js).
 */
function addLlpa(spec = {}) {
  const { code, adjMilli, when, dimension, category, reason, cumulative, source, priority, description } = spec;
  const adjustment = { code: code, adjMilli, unit: 'points' };
  adjustment.category = category !== undefined ? category : (dimension || 'llpa');
  if (dimension !== undefined) adjustment.dimension = dimension;
  if (reason !== undefined) adjustment.reason = reason;
  if (cumulative !== undefined) adjustment.cumulative = cumulative;
  const rule = { code, kind: 'pricing', adjustment };
  if (when !== undefined) rule.when = when;
  rule.source = source !== undefined ? source : 'base';
  if (priority !== undefined) rule.priority = priority;
  if (description !== undefined) rule.description = description;
  return finalize(rule, 'addLlpa');
}

/**
 * addMarginHoldback({ code, knob:'margin'|'holdback', milli, when?, dimension?, reason?, cumulative?, source?, priority?, description? })
 * → a MARGIN or HOLDBACK pricing rule. `milli` is a non-negative integer of milli-points
 * (the same validity rule the margin/holdback resolver applies). `knob` selects which.
 */
function addMarginHoldback(spec = {}) {
  const { code, knob, milli, when, dimension, reason, cumulative, source, priority, description } = spec;
  if (knob !== 'margin' && knob !== 'holdback') {
    throw new RuleBuilderError(`addMarginHoldback: refused — knob must be 'margin' or 'holdback' (got ${JSON.stringify(knob)})`);
  }
  const adjustment = { code: code, adjMilli: milli, unit: knob };
  adjustment.category = knob;
  if (dimension !== undefined) adjustment.dimension = dimension;
  if (reason !== undefined) adjustment.reason = reason;
  if (cumulative !== undefined) adjustment.cumulative = cumulative;
  const rule = { code, kind: 'pricing', adjustment };
  if (when !== undefined) rule.when = when;
  rule.source = source !== undefined ? source : 'base';
  if (priority !== undefined) rule.priority = priority;
  if (description !== undefined) rule.description = description;
  return finalize(rule, 'addMarginHoldback');
}

/**
 * addPriceBound({ code, bound:'min'|'max', priceMilli, when?, source?, priority?, description? })
 * → a MIN or MAX PRICE bound. `bound:'min'` is a price FLOOR, `'max'` a price CEILING.
 * `priceMilli` is a price in milli. (This is the price-specific case of the generic
 * `bound` kind; use createRule with kind 'bound' to bound any other target.)
 */
function addPriceBound(spec = {}) {
  const { code, bound, priceMilli, when, source, priority, description } = spec;
  const rule = { code, kind: 'bound', target: 'price', op: bound, value: priceMilli };
  if (when !== undefined) rule.when = when;
  rule.source = source !== undefined ? source : 'base';
  if (priority !== undefined) rule.priority = priority;
  if (description !== undefined) rule.description = description;
  return finalize(rule, 'addPriceBound');
}

// ---- scope / rescope --------------------------------------------------------

// Build one predicate leaf for a dimension from a scope spec. Fail-closed on an unknown
// dimension, an op outside LEAF_OPS, a band on a non-numeric dimension, or a value of the
// wrong kind. Never scales the value — the caller supplies it in the dimension's unit.
function leafForDimension(dimension, spec) {
  const d = DIMENSIONS[dimension];
  if (!d) throw new RuleBuilderError(`scope: refused — unknown dimension ${JSON.stringify(dimension)} (known: ${dimensionNames().join(', ')})`);
  const s = spec || {};

  // Band form: { min, max } → a half-open [min,max) predicate (numeric dimensions only).
  if (s.min !== undefined || s.max !== undefined) {
    if (!NUMERIC_KINDS.has(d.kind)) throw new RuleBuilderError(`scope: refused — dimension '${dimension}' (${d.kind}) does not take a min/max band`);
    const min = s.min === undefined ? null : s.min;
    const max = s.max === undefined ? null : s.max;
    if (min !== null && !isFiniteNumber(min)) throw new RuleBuilderError(`scope: refused — band min must be a number (got ${JSON.stringify(min)})`);
    if (max !== null && !isFiniteNumber(max)) throw new RuleBuilderError(`scope: refused — band max must be a number (got ${JSON.stringify(max)})`);
    if (min === null && max === null) throw new RuleBuilderError('scope: refused — band is fully open (min and max both absent)');
    if (min !== null && max !== null && !(min < max)) throw new RuleBuilderError(`scope: refused — band min ${min} must be < max ${max}`);
    return bandPredicate(d.fact, min, max);
  }

  // op/value form.
  const op = s.op;
  if (!LEAF_OPS.has(op)) throw new RuleBuilderError(`scope: refused — op ${JSON.stringify(op)} is not one of ${[...LEAF_OPS].join(', ')}`);
  if (op === 'exists') return { fact: d.fact, op: 'exists' };
  if (!('value' in s)) throw new RuleBuilderError(`scope: refused — op '${op}' needs a value`);
  const value = coerceDimensionValue(d, dimension, op, s.value);
  return { fact: d.fact, op, value };
}

function coerceOneScalar(d, dimension, v) {
  switch (d.kind) {
    case 'int':
      if (!isInteger(v)) throw new RuleBuilderError(`scope: refused — dimension '${dimension}' needs an integer (got ${JSON.stringify(v)})`);
      return v;
    case 'milli':
    case 'dollars':
      if (!isFiniteNumber(v)) throw new RuleBuilderError(`scope: refused — dimension '${dimension}' needs a number in its native unit (got ${JSON.stringify(v)})`);
      return v;
    case 'state':
      if (typeof v !== 'string' || !STATE_CODES.has(v)) throw new RuleBuilderError(`scope: refused — '${JSON.stringify(v)}' is not a valid 2-letter US state code`);
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw new RuleBuilderError(`scope: refused — dimension '${dimension}' needs a boolean (got ${JSON.stringify(v)})`);
      return v;
    case 'enum':
      if (!isNonEmptyString(v)) throw new RuleBuilderError(`scope: refused — dimension '${dimension}' needs a non-empty string token (got ${JSON.stringify(v)})`);
      return v;
    default:
      throw new RuleBuilderError(`scope: refused — dimension '${dimension}' has an unknown kind`);
  }
}

function coerceDimensionValue(d, dimension, op, value) {
  if (op === 'between') {
    if (!NUMERIC_KINDS.has(d.kind)) throw new RuleBuilderError(`scope: refused — 'between' is only valid on a numeric dimension, not '${dimension}'`);
    if (!Array.isArray(value) || value.length !== 2 || !isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) throw new RuleBuilderError(`scope: refused — 'between' needs [min, max] numbers`);
    if (!(value[0] < value[1])) throw new RuleBuilderError(`scope: refused — 'between' min ${value[0]} must be < max ${value[1]}`);
    return [value[0], value[1]];
  }
  if (op === 'in' || op === 'nin') {
    if (!Array.isArray(value) || value.length === 0) throw new RuleBuilderError(`scope: refused — '${op}' needs a non-empty array of values`);
    return value.map((v) => coerceOneScalar(d, dimension, v));
  }
  return coerceOneScalar(d, dimension, value);
}

// The top-level conjuncts of a `when` predicate: [] for null, the array for {all:[...]},
// else the single node. Used by rescope to find/replace a dimension's leaf.
function topConjuncts(when) {
  if (when == null) return [];
  if (typeof when === 'object' && Array.isArray(when.all)) return when.all.slice();
  return [when];
}
function fromConjuncts(list) {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return { all: list };
}
// Does `fact` appear anywhere inside `node` OTHER than as the node itself being a direct
// leaf on it? (i.e. nested inside a combinator/not). Used to refuse an unsafe rescope.
function factAppearsNested(node, fact) {
  if (node == null || typeof node !== 'object') return false;
  for (const k of ['all', 'any', 'none']) {
    if (Array.isArray(node[k])) { for (const c of node[k]) if (factContains(c, fact)) return true; }
  }
  if (node.not != null && factContains(node.not, fact)) return true;
  return false;
}
function factContains(node, fact) {
  if (node == null || typeof node !== 'object') return false;
  if (node.fact === fact) return true;
  for (const k of ['all', 'any', 'none']) {
    if (Array.isArray(node[k])) { for (const c of node[k]) if (factContains(c, fact)) return true; }
  }
  if (node.not != null && factContains(node.not, fact)) return true;
  return false;
}

/**
 * scopeRule(rule, scope) — AND a dimension constraint onto the rule's `when`.
 *   scope = { dimension, op, value } | { dimension, min, max }
 * Additive: the new leaf is conjoined with the existing `when`. Fail-closed on an unknown
 * dimension or a bad value. Returns a new frozen rule.
 */
function scopeRule(rule, scope) {
  if (rule == null || typeof rule !== 'object') throw new RuleBuilderError('scopeRule: refused — rule must be an object');
  if (scope == null || typeof scope !== 'object') throw new RuleBuilderError('scopeRule: refused — scope must be an object');
  const leaf = leafForDimension(scope.dimension, scope);
  const conjuncts = topConjuncts(clone(rule.when));
  conjuncts.push(leaf);
  const next = clone(rule);
  const when = fromConjuncts(conjuncts);
  if (when === undefined) delete next.when; else next.when = when;
  return finalize(next, 'scopeRule');
}

/**
 * rescopeRule(rule, scope) — REPLACE the rule's existing constraint on this dimension
 * with a new one (add it if none). Only rewrites a dimension that appears as a TOP-LEVEL
 * conjunct leaf; if the dimension is buried inside a nested combinator/not it is REFUSED
 * (editing that safely is a `when`-tree edit, not a rescope) rather than silently leaving
 * a contradictory pair. Returns a new frozen rule.
 */
function rescopeRule(rule, scope) {
  if (rule == null || typeof rule !== 'object') throw new RuleBuilderError('rescopeRule: refused — rule must be an object');
  if (scope == null || typeof scope !== 'object') throw new RuleBuilderError('rescopeRule: refused — scope must be an object');
  const d = DIMENSIONS[scope.dimension];
  if (!d) throw new RuleBuilderError(`rescopeRule: refused — unknown dimension ${JSON.stringify(scope.dimension)} (known: ${dimensionNames().join(', ')})`);
  const leaf = leafForDimension(scope.dimension, scope);
  const conjuncts = topConjuncts(clone(rule.when));
  // Refuse if the fact is buried inside a nested node — we can only safely replace a
  // top-level leaf conjunct.
  for (const c of conjuncts) {
    const isDirectLeaf = c && typeof c === 'object' && c.fact === d.fact && !('all' in c || 'any' in c || 'none' in c || 'not' in c);
    if (!isDirectLeaf && factContains(c, d.fact)) {
      throw new RuleBuilderError(`rescopeRule: refused — dimension '${scope.dimension}' appears inside a nested predicate; edit the when-tree directly`);
    }
  }
  const kept = conjuncts.filter((c) => !(c && typeof c === 'object' && c.fact === d.fact && !('all' in c || 'any' in c || 'none' in c || 'not' in c)));
  kept.push(leaf);
  const next = clone(rule);
  const when = fromConjuncts(kept);
  if (when === undefined) delete next.when; else next.when = when;
  return finalize(next, 'rescopeRule');
}

module.exports = {
  RuleBuilderError,
  RULE_KINDS,
  RULE_SOURCES,
  BOUND_OPS,
  PRICING_UNITS,
  DIMENSIONS,
  dimensionNames,
  predicateProblems,
  validateRule,
  createRule,
  duplicateRule,
  editRule,
  addEligibility,
  addLlpa,
  addMarginHoldback,
  addPriceBound,
  scopeRule,
  rescopeRule,
  _internals: { clone, deepFreeze, leafForDimension, topConjuncts, fromConjuncts, factContains, factAppearsNested, coerceDimensionValue },
};
