'use strict';
/**
 * LT PPE — the PURE COMPILER for an investor's LAYER-3 PREPAYMENT-PENALTY STATE MATRIX: data in, the
 * CANONICAL rule objects the engine already evaluates out (PPE item #47, the scalable foundation).
 *
 * WHAT LAYER 3 ACTUALLY IS. Two answers from one ordered, per-state, FIRST-MATCH-WINS decision table:
 *   • a RESULT — standard | prohibited | restricted (+ the state's capped terms), which the product
 *     description carries; and
 *   • a DISQUALIFIER — non-null ONLY when a PPP is requested AND that state/combination prohibits one.
 *
 * HOW EACH MAPS ONTO THE CANONICAL RULE SHAPE — both exactly, neither approximated:
 *
 *   • FIRST-MATCH-WINS becomes MUTUAL EXCLUSION. Rule k of a state compiles to
 *     `all: [ <state>, none: [ <clause 1 … k-1> ], <clause k> ]`. `none` is part of the predicate
 *     grammar already, and each earlier clause is compiled ONCE and reused verbatim inside it, so the
 *     "did an earlier rule match?" test can never drift from that earlier rule's own predicate.
 *     Because at most one rule per state can then match, order stops being load-bearing at run time.
 *     THE ORDER IS ALSO CARRIED A SECOND WAY, and both are deliberate: the `ppp_match` bound's value is
 *     the rule's ASCENDING index and the engine tightens a `max` bound to its MINIMUM, so the earliest
 *     matching rule wins the diagnostic even if two matched. Belt and braces, and they cover different
 *     things — the index orders the RESULT, the exclusion is what stops two prohibitions in one state
 *     emitting two declines (declines accumulate; there is no tightening there). The equivalence suite
 *     records that on Deephaven's own table the exclusion is REDUNDANT (its state rules are already
 *     disjoint) and proves the mechanism on a synthetic table that genuinely overlaps — do not delete
 *     the exclusion on the strength of this data set alone.
 *
 *   • THE RESULT is not a decline and not a price, so it rides a BOUND on a diagnostic target
 *     (`ppp_match`) whose surviving `ruleRef` names the matched rule; the catalog turns that back into
 *     { result, terms, note }. A second diagnostic bound (`ppp_state_known`) records whether the state
 *     carries a rule table at all — the hand-written module answers a state with NO table differently
 *     (matched:true, and with no `terms`/`note` keys at all) from a state whose table matched nothing
 *     (matched:false + an explanatory note), and that difference must survive.
 *
 *   • THE DISQUALIFIER is an ordinary `eligibility` rule — one per (state, prohibiting rule, borrower
 *     label class), because the hand-written decline sentence names the borrower class and the matched
 *     rule's note, and a canonical rule's `declineReason` is a literal string, not a template.
 *
 * NORMALIZATION (state upper-cased, lien defaulted, borrower type classified, "is a finite number")
 * runs in the closed derived-fact stage `layer-facts.js` — see the header of the eligibility compiler
 * for why that stage exists and why the numeric guard is injected leaf-LOCALLY.
 *
 * PURE: no DB, no network, no clock, no config. LT-only. No RTL imports.
 */

const { evaluateRules } = require('./rules');
const ruleBuilder = require('./rule-builder');
const layerFacts = require('./layer-facts');
const { LayerCompileError, _internals: eligInternals } = require('./layer-compile-eligibility');
// The ONE definition of the third answer — shared with the hand-written oracle, so "we could not tell"
// is worded and detailed identically by both. See ppp-unresolved.js.
const pppUnresolvedLib = require('./ppp-unresolved');

const { injectNumericGuards, conj, NUM_SUFFIX } = eligInternals;

const SCHEMA = 'lt-ppe/investor-ppp-matrix';
const SCHEMA_VERSION = 1;

function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }
function isNonEmptyString(x) { return typeof x === 'string' && x.trim().length > 0; }
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

// ---- schema validation (fail-closed) ----------------------------------------------------------

function problemsFor(data) {
  const e = [];
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return ['data must be an object'];
  if (data.schema !== SCHEMA) e.push(`schema: must be ${JSON.stringify(SCHEMA)} (got ${JSON.stringify(data.schema)})`);
  if (data.schemaVersion !== SCHEMA_VERSION) e.push(`schemaVersion: this compiler understands ${SCHEMA_VERSION} (got ${JSON.stringify(data.schemaVersion)})`);
  for (const k of ['investor', 'program', 'dataVersion', 'citation', 'defaultResult', 'unevaluableResult', 'stateFact', 'borrowerClassFact']) {
    if (!isNonEmptyString(data[k])) e.push(`${k}: must be a non-empty string`);
  }
  // `unevaluableResult` MUST NOT be one of the three permission/prohibition answers. The whole of defect
  // A8.1 was a document whose unmatched answer was 'standard' — a permission printed where a rule could
  // not be evaluated — so the compiler REFUSES to compile one rather than trust the author to notice.
  // The only value it accepts is the shared `unknown`, so the two implementations cannot diverge.
  if (isNonEmptyString(data.unevaluableResult) && data.unevaluableResult !== pppUnresolvedLib.PPP_UNKNOWN) {
    e.push(`unevaluableResult: must be ${JSON.stringify(pppUnresolvedLib.PPP_UNKNOWN)} (got ${JSON.stringify(data.unevaluableResult)}) — a state whose rules could not be evaluated is neither allowed nor prohibited`);
  }
  // The `defaultResult` is the answer for a state that is NOT IN THE MATRIX, which the owner authorized
  // on 2026-08-18 as allowed with no limits. It is deliberately a SEPARATE field from the unevaluable
  // one: mechanically both are "no rule matched", in meaning they are opposites.
  const un = data.unresolved;
  if (un == null || typeof un !== 'object') e.push('unresolved: required (the "we could not tell" identity)');
  else for (const k of ['code', 'dimension', 'citation']) {
    if (!isNonEmptyString(un[k])) e.push(`unresolved.${k}: required`);
  }
  const declared = data.derivedFacts || {};
  for (const k of ['stateFact', 'borrowerClassFact']) {
    if (isNonEmptyString(data[k]) && !Object.prototype.hasOwnProperty.call(declared, data[k])) {
      e.push(`${k}: names ${JSON.stringify(data[k])}, which is not a declared derived fact`);
    }
  }
  if (!Array.isArray(data.numericFacts) || data.numericFacts.some((f) => !isNonEmptyString(f))) e.push('numericFacts: must be an array of fact names');
  e.push(...layerFacts.derivationProblems(data.derivedFacts));

  const when = data.when;
  if (when == null || typeof when !== 'object' || Array.isArray(when)) e.push('when: must be the when-key vocabulary map');
  else {
    for (const [k, spec] of Object.entries(when)) {
      if (spec == null || typeof spec !== 'object') { e.push(`when.${k}: must be an object`); continue; }
      if (!isNonEmptyString(spec.fact)) e.push(`when.${k}.fact: required`);
      if (!isNonEmptyString(spec.op)) e.push(`when.${k}.op: required`);
      if (spec.onlyWhenValue !== undefined && typeof spec.onlyWhenValue !== 'boolean') e.push(`when.${k}.onlyWhenValue: must be a boolean`);
    }
  }

  const dq = data.disqualifier;
  if (dq == null || typeof dq !== 'object') e.push('disqualifier: required');
  else {
    for (const k of ['code', 'dimension', 'reason', 'noteSuffix', 'citation', 'requestedFact', 'prohibitedResult']) {
      if (!isNonEmptyString(dq[k])) e.push(`disqualifier.${k}: required`);
    }
    if (!Array.isArray(dq.borrowerLabels) || dq.borrowerLabels.length === 0) e.push('disqualifier.borrowerLabels: required');
    else for (const [i, b] of dq.borrowerLabels.entries()) {
      if (b == null || typeof b !== 'object') { e.push(`disqualifier.borrowerLabels[${i}]: must be an object`); continue; }
      if (b.class !== null && !isNonEmptyString(b.class)) e.push(`disqualifier.borrowerLabels[${i}].class: a class name or null (the "no class" fallback)`);
      if (!isNonEmptyString(b.label)) e.push(`disqualifier.borrowerLabels[${i}].label: required`);
    }
  }

  if (data.states == null || typeof data.states !== 'object' || Array.isArray(data.states)) e.push('states: must be an object map of state → ordered rules');
  else {
    const knownWhenKeys = new Set(Object.keys(when || {}));
    const results = new Set(['standard', 'prohibited', 'restricted']);
    for (const [st, list] of Object.entries(data.states)) {
      if (!/^[A-Z]{2}$/.test(st)) e.push(`states.${st}: must be a 2-letter upper-case code`);
      if (!Array.isArray(list) || list.length === 0) { e.push(`states.${st}: must be a non-empty ordered rule list`); continue; }
      for (const [i, r] of list.entries()) {
        const at = `states.${st}[${i}]`;
        if (r == null || typeof r !== 'object') { e.push(`${at}: must be an object`); continue; }
        if (!results.has(r.result)) e.push(`${at}.result: must be ${[...results].join(' | ')}`);
        if (r.terms !== undefined && !isNonEmptyString(r.terms)) e.push(`${at}.terms: must be a non-empty string when present`);
        if (r.note !== undefined && !isNonEmptyString(r.note)) e.push(`${at}.note: must be a non-empty string when present`);
        const w = r.when;
        if (w == null || typeof w !== 'object' || Array.isArray(w)) { e.push(`${at}.when: must be an object (use {} for "always")`); continue; }
        // FAIL-CLOSED on an unknown when-key, exactly as the hand-written table does at load: an
        // un-taught key would make its rule stop matching, silently dropping a real prohibition.
        for (const k of Object.keys(w)) if (!knownWhenKeys.has(k)) e.push(`${at}.when.${k}: unsupported when-key (known: ${[...knownWhenKeys].join(', ')})`);
        // An "always" clause ({}) matches every scenario, so every rule after it in the same state is
        // DEAD. First-match-wins compiles to `none:[earlier clauses]`, and a dead rule would compile to
        // a predicate that can never be satisfied — refuse the data rather than ship unreachable rules.
        if (Object.keys(w).length === 0 && i !== list.length - 1) e.push(`${at}.when: an empty (always-matches) clause must be the LAST rule of its state — every rule after it is unreachable`);
      }
    }
  }

  const ifm = data.inputFromFacts;
  if (ifm !== undefined) {
    if (ifm == null || typeof ifm !== 'object' || Array.isArray(ifm)) e.push('inputFromFacts: must be an object map when present');
    else for (const [k, spec] of Object.entries(ifm)) {
      if (spec == null || typeof spec !== 'object') { e.push(`inputFromFacts.${k}: must be an object`); continue; }
      const hasConst = Object.prototype.hasOwnProperty.call(spec, 'const');
      const hasOrder = Array.isArray(spec.factsInOrder) && spec.factsInOrder.length > 0;
      if (spec.kind === 'assumed_flag') {
        if (!isNonEmptyString(spec.fact)) e.push(`inputFromFacts.${k}.fact: assumed_flag needs the explicit "was this assumed?" fact`);
        if (!Array.isArray(spec.noneOf) || spec.noneOf.length === 0) e.push(`inputFromFacts.${k}.noneOf: assumed_flag needs the facts whose ABSENCE also means assumed`);
        continue;
      }
      if (!hasConst && !hasOrder && !isNonEmptyString(spec.fact)) e.push(`inputFromFacts.${k}: needs a 'fact', a 'factsInOrder', or a 'const'`);
      if (spec.coerce !== undefined && spec.coerce !== 'boolean' && spec.coerce !== 'numberGtZero') e.push(`inputFromFacts.${k}.coerce: must be 'boolean' or 'numberGtZero'`);
    }
  }
  return e;
}

// ---- the compiler -----------------------------------------------------------------------------

/**
 * compilePpp(data) → a compiled layer:
 *   { rules[], catalog{}, derivedFacts{}, statesWithRules[],
 *     pppResult(input), pppDisqualifier(input), inputFromFacts(facts) }
 * REFUSES (throws LayerCompileError) on any schema problem.
 */
function compilePpp(data) {
  const errs = problemsFor(data);
  if (errs.length) throw new LayerCompileError(`compilePpp: refused — ${errs.join('; ')}`, errs);

  const numericFacts = new Set(data.numericFacts);
  const derived = { ...clone(data.derivedFacts || {}) };
  for (const f of numericFacts) derived[f + NUM_SUFFIX] = { kind: 'is_number', from: f };

  const rules = [];
  const catalog = Object.create(null);
  const push = (rule, meta) => {
    if (catalog[rule.code]) throw new LayerCompileError(`compilePpp: duplicate internal rule code ${rule.code}`);
    rules.push(rule);
    catalog[rule.code] = Object.freeze(meta);
  };

  // A `when`-clause key/value pair → one predicate leaf, from the declared vocabulary. An `onlyWhenValue`
  // key (ruralProperty) contributes a leaf ONLY for that value — the hand-written handler is
  // `w.ruralProperty !== true || i.ruralProperty === true`, i.e. any other value is a wildcard.
  function leafFor(key, value) {
    const spec = data.when[key];
    if (spec.onlyWhenValue !== undefined && value !== spec.onlyWhenValue) return null;
    return { fact: spec.fact, op: spec.op, value };
  }
  function clauseFor(whenObj) {
    const leaves = [];
    for (const [k, v] of Object.entries(whenObj || {})) {
      const leaf = leafFor(k, v);
      if (leaf) leaves.push(leaf);
    }
    return injectNumericGuards(conj(leaves), numericFacts);
  }

  const statesWithRules = Object.keys(data.states).sort();
  // Every `when` key each state's rules read — DERIVED from the document, so an unresolved answer can
  // name the facts that state's table wanted. Mirrors `deephaven-ppp-matrix.STATE_WHEN_KEYS`.
  const stateWhenKeys = Object.create(null);
  for (const st of statesWithRules) {
    stateWhenKeys[st] = [...new Set(data.states[st].flatMap((r) => Object.keys(r.when || {})))];
  }
  // Same fail-closed check the hand-written module makes at load: a when-key the shared unresolved
  // vocabulary cannot name would make "we could not tell" under-report which fact is missing.
  {
    const unnamed = [...new Set(Object.values(stateWhenKeys).flat())].filter((k) => !pppUnresolvedLib.WHEN_INPUT_FIELD[k]);
    if (unnamed.length) throw new LayerCompileError(`compilePpp: when-key(s) with no input field in ppp-unresolved.WHEN_INPUT_FIELD: ${unnamed.join(', ')}`, unnamed);
  }
  const dq = data.disqualifier;
  let matchIndex = 0;

  const stateFact = data.stateFact;
  const btFact = data.borrowerClassFact;

  for (const st of statesWithRules) {
    const stateLeaf = { fact: stateFact, op: 'eq', value: st };

    // Diagnostic: this state carries a rule table at all.
    push(ruleBuilder.createRule({
      code: `ppp_state_known:${st}`, kind: 'bound', target: 'ppp_state_known', op: 'max', value: 1,
      when: stateLeaf, priority: 1000, source: 'base',
      description: `diagnostic: ${st} has a PPP rule table`,
    }), { role: 'state_known', state: st });

    const priorClauses = [];
    for (const [k, r] of data.states[st].entries()) {
      const clause = clauseFor(r.when);
      // first-match-wins → "no earlier clause of this state matched"
      const exclusion = priorClauses.length ? { none: priorClauses.map((c) => clone(c)) } : null;
      const matchWhen = conj([stateLeaf, exclusion, clause]);

      push(ruleBuilder.createRule({
        code: `ppp_match:${st}:${k}`, kind: 'bound', target: 'ppp_match', op: 'max', value: ++matchIndex,
        when: matchWhen, priority: 1000, source: 'base',
        description: `diagnostic: ${st} rule ${k} matched → ${r.result}`,
      }), { role: 'match', state: st, index: k, result: r.result, terms: r.terms || null, note: r.note || null });

      if (r.result === dq.prohibitedResult) {
        for (const bl of dq.borrowerLabels) {
          const btLeaf = bl.class === null
            ? { not: { fact: btFact, op: 'exists' } }
            : { fact: btFact, op: 'eq', value: bl.class };
          const vars = {
            state: st,
            stateLower: st.toLowerCase(),
            borrowerLabel: bl.label,
            note: r.note || '',
            noteSuffix: r.note ? dq.noteSuffix.replace('{note}', r.note) : '',
            citation: data.citation,
          };
          const reason = renderVars(dq.reason, vars);
          const code = `ppp_dq:${st}:${k}:${bl.class === null ? 'unknown' : bl.class}`;
          push(ruleBuilder.addEligibility({
            code,
            declineReason: reason,
            when: conj([{ fact: dq.requestedFact, op: 'eq', value: true }, stateLeaf, exclusion ? clone(exclusion) : null, clause ? clone(clause) : null, btLeaf]),
            priority: 10 + k,
            source: 'base',
            description: `${st} PPP prohibition (rule ${k}, ${bl.class === null ? 'unclassified borrower' : bl.class})`,
          }), {
            role: 'disqualifier',
            code: renderVars(dq.code, vars),
            dimension: dq.dimension,
            declineReason: reason,
            citation: renderVars(dq.citation, vars),
          });
        }
      }
      priorClauses.push(clause);
    }
  }

  const compiled = {
    schema: data.schema,
    schemaVersion: data.schemaVersion,
    investor: data.investor,
    program: data.program,
    layer: 'ppp',
    dataVersion: data.dataVersion,
    citation: data.citation,
    defaultResult: data.defaultResult,
    unevaluableResult: data.unevaluableResult,
    unresolvedSpec: clone(data.unresolved),
    stateFact,
    borrowerClassFact: btFact,
    rules,
    catalog,
    derivedFacts: derived,
    statesWithRules,
    stateWhenKeys,
    inputFromFactsSpec: clone(data.inputFromFacts || null),
  };
  const bound = buildPppEvaluators(compiled);
  compiled.pppResult = bound.pppResult;
  compiled.pppDisqualifier = bound.pppDisqualifier;
  compiled.pppUnresolved = bound.pppUnresolved;
  compiled.inputFromFacts = bound.inputFromFacts;
  return compiled;
}

function renderVars(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) throw new LayerCompileError(`ppp template references unknown variable {${k}}`);
    return String(vars[k]);
  });
}

// ---- the adapters: compiled rules → the hand-written module's result shapes ---------------------

/**
 * buildPppEvaluators(compiled) → { pppResult, pppDisqualifier, inputFromFacts }. Exported so a test can
 * perturb a compiled rule/catalog entry and re-bind — an equivalence harness that cannot be made to fail
 * proves nothing.
 */
function buildPppEvaluators(compiled) {
  const {
    rules, catalog, derivedFacts, citation, defaultResult, unevaluableResult, unresolvedSpec,
    stateFact, borrowerClassFact, stateWhenKeys, inputFromFactsSpec,
  } = compiled;

  const run = (input) => {
    const raw = input || {};
    const bag = { ...raw, ...layerFacts.deriveFacts(derivedFacts, raw) };
    return { bag, out: evaluateRules(rules, bag) };
  };

  // The three shapes below are the SAME KEY SET on purpose, mirroring the hand-written module: `basis`
  // is what tells them apart, so nothing downstream has to probe for a key to work out which answer it
  // got. See deephaven-ppp-matrix.js's header for what each basis means and why the first and the third
  // must never be collapsed.
  const baseOf = (bag, state) => ({
    state,
    source: citation,
    borrowerType: bag[borrowerClassFact] === undefined ? null : bag[borrowerClassFact],
    borrowerTypeSource: bag.borrowerTypeAssumed === true ? 'assumed' : (bag.borrowerType == null ? 'absent' : 'stated'),
  });

  function pppResult(input) {
    const { bag, out } = run(input);
    const state = bag[stateFact];
    const base = baseOf(bag, state);
    // (1) not in the matrix — the owner's authorization: allowed, no limits.
    if (!out.bounds['ppp_state_known:max']) {
      return { result: defaultResult, basis: 'state_not_in_matrix', terms: null, note: pppUnresolvedLib.UNLISTED_STATE_NOTE, needs: [], matched: true, resolved: true, ...base };
    }
    const m = out.bounds['ppp_match:max'];
    // (3) in the matrix, nothing evaluable — we could not tell. Fails closed.
    if (!m) {
      return {
        result: unevaluableResult,
        basis: 'unevaluable',
        terms: null,
        note: pppUnresolvedLib.UNRESOLVED_NOTE,
        needs: pppUnresolvedLib.missingFacts(stateWhenKeys[state], normalizedForNeeds(bag)),
        matched: false,
        resolved: false,
        ...base,
      };
    }
    // (2) a rule matched.
    const meta = catalog[m.ruleRef];
    return { result: meta.result, basis: 'rule', terms: meta.terms || null, note: meta.note || null, needs: [], matched: true, resolved: true, ...base };
  }

  // The shape `ppp-unresolved.missingFacts` reads: the PPP input AFTER normalization. The derived-fact
  // stage has already done that work, so this only re-labels it — never a second normalization.
  function normalizedForNeeds(bag) {
    return {
      borrowerType: bag[borrowerClassFact] === undefined ? null : bag[borrowerClassFact],
      units: bag.units,
      lien: bag.lien_lc,
      loanAmount: bag.loanAmount,
      apr: bag.apr,
      ruralProperty: bag.ruralProperty,
    };
  }

  function pppUnresolved(input) {
    const raw = input || {};
    if (!raw.prepayRequested) return null;
    const res = pppResult(input);
    if (res.resolved) return null;
    const vars = { state: res.state, stateLower: String(res.state || '').toLowerCase(), citation };
    return {
      code: renderVars(unresolvedSpec.code, vars),
      dimension: unresolvedSpec.dimension,
      state: res.state,
      needs: res.needs,
      borrowerType: res.borrowerType,
      borrowerTypeSource: res.borrowerTypeSource,
      reason: pppUnresolvedLib.unresolvedReason(res.state),
      citation: renderVars(unresolvedSpec.citation, vars),
    };
  }

  function pppDisqualifier(input) {
    const { out } = run(input);
    for (const d of out.declines) {
      if (d.bound) continue;
      const meta = catalog[d.code];
      if (!meta || meta.role !== 'disqualifier') continue;
      return { code: meta.code, dimension: meta.dimension, declineReason: meta.declineReason, citation: meta.citation };
    }
    return null;
  }

  function inputFromFacts(facts) {
    if (!inputFromFactsSpec) throw new LayerCompileError('inputFromFacts: this PPP data document declares no fact mapping');
    const f = facts || {};
    const out = {};
    for (const [k, spec] of Object.entries(inputFromFactsSpec)) {
      if (Object.prototype.hasOwnProperty.call(spec, 'const')) { out[k] = spec.const; continue; }
      // `assumed_flag` — was this input a GUESS? True when the facts say so explicitly, and ALSO true
      // when not one of the facts that could have STATED it is present, because substituting a default
      // for nothing is an assumption whether or not anyone remembered to flag it (defect A8.5).
      if (spec.kind === 'assumed_flag') {
        out[k] = f[spec.fact] === true || !spec.noneOf.some((name) => f[name]);
        continue;
      }
      // `factsInOrder` — the first fact that carries a value wins. Lets the STATED value be read from
      // its own fact while the EFFECTIVE one stays available for every other reader.
      const v = Array.isArray(spec.factsInOrder)
        ? spec.factsInOrder.map((name) => f[name]).find((x) => x) : f[spec.fact];
      if (spec.coerce === 'boolean') out[k] = !!v;
      else if (spec.coerce === 'numberGtZero') out[k] = Number(v) > 0;
      else if (spec.fallbackOnFalsy !== undefined) out[k] = v || spec.fallbackOnFalsy;
      else out[k] = v;
    }
    return out;
  }

  pppResult.engine = (input) => run(input).out;
  return { pppResult, pppDisqualifier, pppUnresolved, inputFromFacts };
}

module.exports = {
  compilePpp,
  buildPppEvaluators,
  LayerCompileError,
  SCHEMA,
  SCHEMA_VERSION,
  _internals: { problemsFor, renderVars },
};
