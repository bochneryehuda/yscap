'use strict';
/**
 * LT PPE — the PURE COMPILER for an investor's LAYER-2 ELIGIBILITY MATRIX: data in, the CANONICAL rule
 * objects the engine already evaluates out (PPE item #47, the scalable foundation).
 *
 * THE PROBLEM THIS SOLVES. Layer 2 is hand-written JavaScript for ONE investor
 * (`deephaven-matrix.evaluateEligibility`). Onboarding a second investor that way means a second module
 * with the same shape — two copies of the same wiring, which drift. Here the matrix is DATA
 * (`investor-data/*.eligibility.*.json`) and this file is the only code: it compiles that data into the
 * `eligibility` / `bound` rules `rules.evaluateRules` already runs, built and validated through
 * `rule-builder` (never a second rule shape, never a second validator).
 *
 * FOUR THINGS THE CANONICAL SHAPE DOES NOT CARRY, AND HOW THEY ARE HANDLED — each is an exact
 * reproduction, never an approximation:
 *
 *   1. NORMALIZED / TYPE-CHECKED INPUTS. `rules.LEAF_OPS` has no regex, no substring test and no
 *      "is a finite number" test. The hand-written module does `String(purpose||'').toLowerCase()`,
 *      `/rowhome|rowhouse/.test(...)` and `isNum(x)` before every comparison. So the compiler runs a
 *      DERIVED-FACT stage first (`layer-facts.js`, a closed vocabulary) and INJECTS the numeric guard
 *      leaf-locally: every `lt/lte/gt/gte/between` leaf over a declared numeric fact becomes
 *      `all:[ {<fact>__num eq true}, <leaf> ]`. Leaf-LOCAL matters — a guard hoisted to the top of a
 *      rule would change the meaning of a leaf sitting inside a `not`/`none`.
 *
 *   2. THE DECLINE'S `dimension` AND `citation`. A canonical eligibility rule carries a `code` and a
 *      `declineReason` and nothing else (`rule-builder.validateRule` REFUSES any other field — that
 *      refusal is the point: a rule may not grow presentation fields). So the compiler emits a
 *      CATALOG beside the rules, keyed by each rule's unique internal `code`, carrying the public
 *      decline code + dimension + citation. The rules stay canonical; the presentation is a sidecar.
 *
 *   3. THE MAX-LTV GRID'S RESOLVED CELL. `rules.evaluateRules` reports which rules matched only through
 *      `declines` and `bounds`. A priced grid cell produces no decline, so the compiler emits it as a
 *      BOUND on a diagnostic target (`grid_cell`) whose surviving `ruleRef` names the cell. Targets that
 *      are not scenario facts never produce a decline (`requested` is undefined → `satisfied: null`), so
 *      a diagnostic bound is inert by construction. Same trick for `grid_ready` / `grid_over_max`.
 *
 *   4. THE ORDER OF THE DECLINES. `evaluateRules` emits eligibility declines in (priority, input) order
 *      and APPENDS bound-violation declines afterwards. The data therefore carries an explicit
 *      `priority` per rule, in the hand-written module's own emission order. Bound-derived declines are
 *      excluded from the presented reasons — a bound exists here to produce `maxLtvMilli`, and every
 *      violated bound is accompanied by its own eligibility rule carrying the real wording. That
 *      invariant is asserted by the equivalence suite, not assumed.
 *
 * WHAT IT NEVER DOES: invent a number, a threshold, a code or a reason. Everything it emits is
 * transcribed or rendered from the data document.
 *
 * PURE: no DB, no network, no clock, no config. LT-only. No RTL imports.
 */

const { evaluateRules } = require('./rules');
const ruleBuilder = require('./rule-builder');
const layerFacts = require('./layer-facts');

class LayerCompileError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'LayerCompileError';
    if (errors) this.errors = errors;
  }
}

const SCHEMA = 'lt-ppe/investor-eligibility-matrix';
const SCHEMA_VERSION = 1;

// The comparison ops whose JS semantics differ from the hand-written `isNum(x) && x <op> v` guard when
// the fact is not a finite number ('80' > 75 is true; isNum('80') is false). Equality/membership ops are
// strict in both worlds, so they need no guard.
const GUARDED_OPS = new Set(['lt', 'lte', 'gt', 'gte', 'between']);

const NUM_SUFFIX = '__num';

// ---- small helpers ----------------------------------------------------------------------------

function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }
function isNonEmptyString(x) { return typeof x === 'string' && x.trim().length > 0; }
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function deepFreeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deepFreeze(x[k]); }
  return x;
}

/**
 * Render `{name}` placeholders from `vars`. A placeholder with no matching variable is a COMPILE-TIME
 * refusal, never a literal `{name}` leaking into a decline reason a human reads.
 */
function render(tpl, vars, at) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) {
      throw new LayerCompileError(`${at}: template references unknown variable {${k}}`);
    }
    return String(vars[k]);
  });
}

/** `all` of a conjunct list, collapsing the 0/1 cases the predicate grammar does not allow. */
function conj(list) {
  const l = list.filter((x) => x != null);
  if (l.length === 0) return undefined;
  if (l.length === 1) return l[0];
  return { all: l };
}

// ---- the numeric-guard transform --------------------------------------------------------------

/**
 * Walk a predicate tree and wrap every comparison leaf over a declared numeric fact in its
 * `<fact>__num` guard. LEAF-LOCAL on purpose (see the header). Returns a NEW tree; never mutates.
 */
function injectNumericGuards(node, numericFacts) {
  if (node == null) return node;
  if (typeof node !== 'object') return node;
  for (const k of ['all', 'any', 'none']) {
    if (Array.isArray(node[k])) return { [k]: node[k].map((c) => injectNumericGuards(c, numericFacts)) };
  }
  if (node.not != null) return { not: injectNumericGuards(node.not, numericFacts) };
  if (typeof node.fact === 'string' && numericFacts.has(node.fact) && GUARDED_OPS.has(node.op)) {
    return { all: [{ fact: node.fact + NUM_SUFFIX, op: 'eq', value: true }, clone(node)] };
  }
  return clone(node);
}

// ---- schema validation (fail-closed) ----------------------------------------------------------

function problemsFor(data) {
  const e = [];
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return ['data must be an object'];
  if (data.schema !== SCHEMA) e.push(`schema: must be ${JSON.stringify(SCHEMA)} (got ${JSON.stringify(data.schema)})`);
  if (data.schemaVersion !== SCHEMA_VERSION) e.push(`schemaVersion: this compiler understands ${SCHEMA_VERSION} (got ${JSON.stringify(data.schemaVersion)})`);
  for (const k of ['investor', 'program', 'dataVersion', 'citation']) {
    if (!isNonEmptyString(data[k])) e.push(`${k}: must be a non-empty string`);
  }
  if (!Array.isArray(data.numericFacts) || data.numericFacts.some((f) => !isNonEmptyString(f))) e.push('numericFacts: must be an array of fact names');
  e.push(...layerFacts.derivationProblems(data.derivedFacts));
  if (!Array.isArray(data.rules)) e.push('rules: must be an array');
  if (data.unverifiable !== undefined && !Array.isArray(data.unverifiable)) e.push('unverifiable: must be an array when present');

  const ids = new Set();
  for (const [i, r] of (Array.isArray(data.rules) ? data.rules : []).entries()) {
    const at = `rules[${i}]`;
    if (r == null || typeof r !== 'object') { e.push(`${at}: must be an object`); continue; }
    if (!isNonEmptyString(r.id)) e.push(`${at}.id: must be a non-empty string`);
    else if (ids.has(r.id)) e.push(`${at}.id: duplicate rule id ${JSON.stringify(r.id)}`);
    else ids.add(r.id);
    if (r.kind !== 'eligibility' && r.kind !== 'bound') e.push(`${at}.kind: must be 'eligibility' or 'bound'`);
    if (!isFiniteNumber(r.priority)) e.push(`${at}.priority: must be a finite number (the hand-written emission order)`);
    if (r.kind === 'eligibility') {
      if (!isNonEmptyString(r.code)) e.push(`${at}.code: an eligibility rule needs the public decline code`);
      if (!isNonEmptyString(r.dimension)) e.push(`${at}.dimension: required`);
      if (!isNonEmptyString(r.declineReason)) e.push(`${at}.declineReason: required`);
      if (!isNonEmptyString(r.citationDetail)) e.push(`${at}.citationDetail: required`);
    } else if (r.kind === 'bound') {
      if (!isNonEmptyString(r.target)) e.push(`${at}.target: required`);
      if (r.op !== 'min' && r.op !== 'max') e.push(`${at}.op: must be 'min' or 'max'`);
      if (!isFiniteNumber(r.value)) e.push(`${at}.value: must be a finite number`);
    }
    if (r.when !== undefined) e.push(...ruleBuilder.predicateProblems(r.when, { path: `${at}.when`, top: true }));
  }

  const g = data.grid;
  if (g != null) {
    if (typeof g !== 'object' || Array.isArray(g)) e.push('grid: must be an object');
    else {
      if (!isFiniteNumber(g.priority)) e.push('grid.priority: must be a finite number');
      if (!isFiniteNumber(g.maxLoan)) e.push('grid.maxLoan: must be a finite number');
      if (!isFiniteNumber(g.capScale)) e.push('grid.capScale: must be a finite number');
      for (const k of ['loanFact', 'ficoFact', 'ltvFact', 'boundTarget']) if (!isNonEmptyString(g[k])) e.push(`grid.${k}: required`);
      if (!Array.isArray(g.requireFacts) || g.requireFacts.length === 0) e.push('grid.requireFacts: required');
      if (!Array.isArray(g.purposeClasses) || g.purposeClasses.length === 0) e.push('grid.purposeClasses: required');
      if (!Array.isArray(g.dscrBands) || g.dscrBands.length === 0) e.push('grid.dscrBands: required');
      if (!Array.isArray(g.tiers) || g.tiers.length === 0) e.push('grid.tiers: required');
      for (const k of ['belowMinFico', 'naCell', 'capExceeded']) {
        if (!isNonEmptyString((g.codes || {})[k])) e.push(`grid.codes.${k}: required`);
        if (!isNonEmptyString((g.dimensions || {})[k])) e.push(`grid.dimensions.${k}: required`);
      }
      for (const k of ['belowMinFicoReason', 'belowMinFicoCitation', 'naCellReason', 'naCellCitation', 'capExceededReason', 'capExceededCitation']) {
        if (!isNonEmptyString((g.templates || {})[k])) e.push(`grid.templates.${k}: required`);
      }
      const cellKeys = [];
      for (const pc of (g.purposeClasses || [])) for (const b of (g.dscrBands || [])) cellKeys.push(`${pc.key}_${b.key}`);
      for (const [ti, t] of (Array.isArray(g.tiers) ? g.tiers : []).entries()) {
        const at = `grid.tiers[${ti}]`;
        if (!isFiniteNumber(t.maxLoan)) e.push(`${at}.maxLoan: must be a finite number`);
        if (t.minLoanExclusive !== null && !isFiniteNumber(t.minLoanExclusive)) e.push(`${at}.minLoanExclusive: must be a number or null`);
        if (!isFiniteNumber(t.minFico)) e.push(`${at}.minFico: must be a finite number`);
        if (!Array.isArray(t.rows) || t.rows.length === 0) { e.push(`${at}.rows: required`); continue; }
        // Rows MUST be strictly descending by FICO floor: the lookup is "the highest floor the score
        // meets", and an out-of-order table would silently price the wrong cell.
        for (let ri = 1; ri < t.rows.length; ri++) {
          if (!(t.rows[ri].fico < t.rows[ri - 1].fico)) e.push(`${at}.rows[${ri}].fico: rows must be strictly DESCENDING by FICO floor`);
        }
        // The tier's declared `minFico` is what the decline QUOTES; the lowest row is what the lookup
        // actually falls through. If they disagree the message would name a floor the grid does not use.
        const lowest = t.rows[t.rows.length - 1].fico;
        if (lowest !== t.minFico) e.push(`${at}.minFico: declared ${t.minFico} but the lowest row floor is ${lowest} — they must agree`);
        for (const [ri, row] of t.rows.entries()) {
          if (!isFiniteNumber(row.fico)) e.push(`${at}.rows[${ri}].fico: must be a finite number`);
          const caps = row.caps || {};
          for (const ck of cellKeys) {
            if (!Object.prototype.hasOwnProperty.call(caps, ck)) e.push(`${at}.rows[${ri}].caps.${ck}: missing (every purposeClass × dscrBand cell must be stated, null = N/A)`);
            else if (caps[ck] !== null && !isFiniteNumber(caps[ck])) e.push(`${at}.rows[${ri}].caps.${ck}: must be a number or null`);
          }
          for (const k of Object.keys(caps)) if (!cellKeys.includes(k)) e.push(`${at}.rows[${ri}].caps.${k}: not a declared cell key`);
        }
      }
    }
  }
  return e;
}

// ---- the compiler -----------------------------------------------------------------------------

/**
 * compileEligibility(data) → a compiled layer:
 *   { schema, investor, program, dataVersion, citation,
 *     rules[]        — canonical, rule-builder-validated, deep-frozen
 *     catalog{}      — ruleCode → { code, dimension, declineReason, citation, role, cell? }
 *     derivedFacts{} — the derived-fact definitions (declared + auto numeric guards)
 *     unverifiable[] — the matrix layer's honest "cannot check" catalog, verbatim
 *     evaluate(facts) — the oracle-shaped verdict }
 * REFUSES (throws LayerCompileError) on any schema problem — a matrix that cannot be compiled must never
 * half-compile into a rule set that silently declines less.
 */
function compileEligibility(data) {
  const errs = problemsFor(data);
  if (errs.length) throw new LayerCompileError(`compileEligibility: refused — ${errs.join('; ')}`, errs);

  const numericFacts = new Set(data.numericFacts);
  const derived = { ...clone(data.derivedFacts || {}) };
  for (const f of numericFacts) derived[f + NUM_SUFFIX] = { kind: 'is_number', from: f };

  const rules = [];
  const catalog = Object.create(null);
  const guard = (w) => injectNumericGuards(w, numericFacts);

  const pushEligibility = (code, spec, meta) => {
    if (catalog[code]) throw new LayerCompileError(`compileEligibility: duplicate internal rule code ${code}`);
    rules.push(ruleBuilder.addEligibility({ code, declineReason: spec.declineReason, when: spec.when, priority: spec.priority, source: 'base', description: spec.description }));
    catalog[code] = Object.freeze(meta);
  };
  const pushBound = (code, spec, meta) => {
    if (catalog[code]) throw new LayerCompileError(`compileEligibility: duplicate internal rule code ${code}`);
    const r = { code, kind: 'bound', target: spec.target, op: spec.op, value: spec.value, source: 'base' };
    if (spec.when !== undefined) r.when = spec.when;
    if (spec.priority !== undefined) r.priority = spec.priority;
    if (spec.description !== undefined) r.description = spec.description;
    rules.push(ruleBuilder.createRule(r));
    catalog[code] = Object.freeze(meta || { role: 'diagnostic' });
  };

  // ---- the declared rule list (envelope + overlays) --------------------------------------------
  for (const r of data.rules) {
    const when = r.when === undefined ? undefined : guard(r.when);
    if (r.kind === 'eligibility') {
      pushEligibility(r.id, { declineReason: r.declineReason, when, priority: r.priority, description: r.description }, {
        code: r.code,
        dimension: r.dimension,
        declineReason: r.declineReason,
        citation: `${data.citation} — ${r.citationDetail}`,
        role: 'rule',
      });
    } else {
      pushBound(r.id, { target: r.target, op: r.op, value: r.value, when, priority: r.priority, description: r.description }, { role: 'bound' });
    }
  }

  // ---- the Max-LTV GRID -------------------------------------------------------------------------
  let gridMeta = null;
  if (data.grid) {
    const g = data.grid;
    const codes = g.codes;
    const dims = g.dimensions;
    const tpl = g.templates;

    // grid_ready — every fact the grid lookup needs is a finite number. Its PRESENCE is what tells the
    // adapter the hand-written `gridCell` would not have returned 'unknown'.
    pushBound('grid_ready', {
      target: 'grid_ready', op: 'max', value: 1, priority: 1000,
      when: conj(g.requireFacts.map((f) => ({ fact: f + NUM_SUFFIX, op: 'eq', value: true }))),
      description: 'diagnostic: the grid lookup has every fact it needs',
    });
    // grid_over_max — the loan is above the grid's own ceiling, so no tier can match.
    pushBound('grid_over_max', {
      target: 'grid_over_max', op: 'max', value: 1, priority: 1000,
      when: guard({ fact: g.loanFact, op: 'gt', value: g.maxLoan }),
      description: 'diagnostic: the loan is over the grid ceiling',
    });

    let cellIndex = 0;
    for (const tier of g.tiers) {
      const tierLeaves = [{ fact: g.loanFact, op: 'lte', value: tier.maxLoan }];
      if (tier.minLoanExclusive != null) tierLeaves.push({ fact: g.loanFact, op: 'gt', value: tier.minLoanExclusive });
      const tierVars = { tierMax: tier.maxLoan, tierMM: tier.maxLoan / 1e6, minFico: tier.minFico };

      // Below the tier's lowest FICO floor → no row matches.
      const lowest = tier.rows[tier.rows.length - 1].fico;
      const bmfCode = `grid_min_fico:t${tier.maxLoan}`;
      pushEligibility(bmfCode, {
        declineReason: render(tpl.belowMinFicoReason, tierVars, 'grid.templates.belowMinFicoReason'),
        priority: g.priority,
        description: `grid: FICO below the <=$${tier.maxLoan} tier's lowest floor`,
        when: guard(conj([
          ...tierLeaves,
          ...g.requireFacts.map((f) => ({ fact: f + NUM_SUFFIX, op: 'eq', value: true })),
          { fact: g.ficoFact, op: 'lt', value: lowest },
        ])),
      }, {
        code: codes.belowMinFico,
        dimension: dims.belowMinFico,
        declineReason: render(tpl.belowMinFicoReason, tierVars, 'grid.templates.belowMinFicoReason'),
        citation: `${data.citation} — ${render(tpl.belowMinFicoCitation, tierVars, 'grid.templates.belowMinFicoCitation')}`,
        role: 'grid_min_fico',
      });

      for (const [ri, row] of tier.rows.entries()) {
        const ficoLeaves = [{ fact: g.ficoFact, op: 'gte', value: row.fico }];
        if (ri > 0) ficoLeaves.push({ fact: g.ficoFact, op: 'lt', value: tier.rows[ri - 1].fico });
        for (const pc of g.purposeClasses) {
          for (const band of g.dscrBands) {
            const cellKey = `${pc.key}_${band.key}`;
            const suffix = `t${tier.maxLoan}:f${row.fico}:${pc.key}:${band.key}`;
            const cellWhen = guard(conj([...tierLeaves, ...ficoLeaves, pc.when, band.when]));
            const cap = row.caps[cellKey];
            const vars = {
              ...tierVars,
              ficoFloor: row.fico,
              purposeLabel: pc.label,
              dscrBandLabel: band.label,
              capPct: cap == null ? '' : (cap * g.capScale) / g.capScale,
            };
            if (cap == null) {
              const code = `grid_na:${suffix}`;
              pushEligibility(code, {
                declineReason: render(tpl.naCellReason, vars, 'grid.templates.naCellReason'),
                priority: g.priority,
                description: `grid: N/A cell ${cellKey}`,
                when: cellWhen,
              }, {
                code: codes.naCell,
                dimension: dims.naCell,
                declineReason: render(tpl.naCellReason, vars, 'grid.templates.naCellReason'),
                citation: `${data.citation} — ${render(tpl.naCellCitation, vars, 'grid.templates.naCellCitation')}`,
                role: 'grid_na',
              });
            } else {
              const capMilli = cap * g.capScale;
              const cell = Object.freeze({ tierMax: tier.maxLoan, ficoFloor: row.fico, purposeClass: pc.key, dscrBand: band.key });
              // The DECLINE (exact hand-written wording) …
              pushEligibility(`grid_ltv:${suffix}`, {
                declineReason: render(tpl.capExceededReason, vars, 'grid.templates.capExceededReason'),
                priority: g.priority,
                description: `grid: cell ${cellKey} cap exceeded`,
                when: guard(conj([...tierLeaves, ...ficoLeaves, pc.when, band.when, { fact: g.ltvFact, op: 'gt', value: capMilli }])),
              }, {
                code: codes.capExceeded,
                dimension: dims.capExceeded,
                declineReason: render(tpl.capExceededReason, vars, 'grid.templates.capExceededReason'),
                citation: `${data.citation} — ${render(tpl.capExceededCitation, vars, 'grid.templates.capExceededCitation')}`,
                role: 'grid_ltv',
                cell,
              });
              // … the real BOUND it is a cap on (this is what produces maxLtvMilli) …
              pushBound(`grid_cap:${suffix}`, {
                target: g.boundTarget, op: 'max', value: capMilli, when: cellWhen, priority: 1000,
                description: `grid: cell ${cellKey} max-LTV cap`,
              }, { role: 'grid_cap', cell });
              // … and the diagnostic bound whose surviving ruleRef NAMES the resolved cell.
              pushBound(`grid_cell:${suffix}`, {
                target: 'grid_cell', op: 'max', value: ++cellIndex, when: cellWhen, priority: 1000,
                description: `grid: cell ${cellKey} identity`,
              }, { role: 'grid_cell', cell });
            }
          }
        }
      }
    }
    gridMeta = { boundTarget: g.boundTarget, codes, statusUnknown: 'unknown' };
  }

  const compiled = {
    schema: data.schema,
    schemaVersion: data.schemaVersion,
    investor: data.investor,
    program: data.program,
    layer: 'eligibility',
    dataVersion: data.dataVersion,
    citation: data.citation,
    rules,
    catalog,
    derivedFacts: derived,
    grid: gridMeta,
    unverifiable: clone(data.unverifiable || []),
  };
  compiled.evaluate = buildEvaluator(compiled);
  return compiled;
}

// ---- the adapter: compiled rules → the hand-written module's result shape ----------------------

/**
 * buildEvaluator(compiled) → evaluate(facts). Exported so a test can perturb a compiled rule/catalog
 * entry and re-bind the evaluator — an equivalence harness that cannot be made to fail proves nothing.
 */
function buildEvaluator(compiled) {
  const { rules, catalog, derivedFacts, grid } = compiled;
  // The unverifiable catalog is static per compiled layer, so it is deep-frozen ONCE and shared rather
  // than deep-copied on every evaluation. Frozen is strictly safer than the hand-written module's fresh
  // array (a caller cannot mutate it at all) and it takes a JSON round-trip off the hot path.
  const unverifiable = deepFreeze(clone(compiled.unverifiable));
  const ltvKey = grid ? `${grid.boundTarget}:max` : 'ltv:max';

  // The RAW engine output (declines incl. bound-derived ones, bounds, trace, unknownFacts) for callers
  // that want the audit detail the hand-written module never produced. Deliberately NOT part of
  // `evaluate`'s return value: that value must stay byte-identical to the hand-written verdict.
  const engine = (facts) => {
    const raw = facts || {};
    return evaluateRules(rules, { ...raw, ...layerFacts.deriveFacts(derivedFacts, raw) });
  };

  function evaluate(facts) {
    const raw = facts || {};
    const bag = { ...raw, ...layerFacts.deriveFacts(derivedFacts, raw) };
    const out = evaluateRules(rules, bag);

    const reasons = [];
    let sawNa = false;
    let sawBelowFico = false;
    for (const d of out.declines) {
      if (d.bound) continue; // a bound's own decline is the engine's wording; the rule beside it carries the matrix's
      const meta = catalog[d.code];
      if (!meta || meta.role === 'bound' || meta.role === 'diagnostic') continue;
      if (meta.role === 'grid_na') sawNa = true;
      if (meta.role === 'grid_min_fico') sawBelowFico = true;
      reasons.push({ code: meta.code, dimension: meta.dimension, declineReason: meta.declineReason, citation: meta.citation });
    }

    const ltvBound = out.bounds[ltvKey];
    const maxLtvMilli = ltvBound ? ltvBound.value : null;

    const cellBound = out.bounds['grid_cell:max'];
    const cell = cellBound ? catalog[cellBound.ruleRef].cell : null; // already deep-frozen at compile time

    let gridStatus;
    if (!grid) gridStatus = 'unknown';
    else if (!out.bounds['grid_ready:max']) gridStatus = 'unknown';
    else if (out.bounds['grid_over_max:max']) gridStatus = 'over_max_loan';
    else if (cell) gridStatus = 'priced';
    else if (sawNa) gridStatus = 'na_cell';
    else if (sawBelowFico) gridStatus = 'below_min_fico';
    else gridStatus = 'unknown';

    return {
      eligible: reasons.length === 0,
      reasons,
      maxLtvMilli,
      cell,
      gridStatus,
      unverifiable,
    };
  }

  evaluate.engine = engine;
  return evaluate;
}

module.exports = {
  compileEligibility,
  buildEvaluator,
  LayerCompileError,
  SCHEMA,
  SCHEMA_VERSION,
  _internals: { injectNumericGuards, render, conj, problemsFor, GUARDED_OPS, NUM_SUFFIX },
};
