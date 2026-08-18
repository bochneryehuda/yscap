'use strict';
/**
 * LT PPE — the CLOSED derived-fact vocabulary shared by the Layer-2 (eligibility) and Layer-3 (PPP)
 * DATA COMPILERS (PPE item #47, the scalable foundation).
 *
 * WHY THIS EXISTS. `rules.LEAF_OPS` is a deliberately small, auditable set of comparison operators
 * (eq/neq/in/nin/lt/lte/gt/gte/between/exists). It has NO regex, NO substring test, and NO "is this a
 * finite number" test — and that is correct: a predicate language that can run arbitrary matching is a
 * predicate language nobody can audit. But the hand-written investor modules DO normalize and test their
 * inputs before comparing them (`String(purpose||'').toLowerCase()`, `/rowhome|rowhouse/.test(pt)`,
 * `isNum(x)`), so a compiler that emits ONLY leaf comparisons cannot reproduce them exactly.
 *
 * The answer every serious pricing engine uses is a DERIVED-FACT stage: a small, declared, closed set of
 * normalizations that runs BEFORE the rules and adds named facts the leaves can then compare with the
 * ordinary operators. That is this file. It is closed on purpose:
 *   • `DERIVATION_KINDS` is the whole vocabulary. An unknown kind is REFUSED at compile time, never
 *     silently skipped — a skipped normalization would make a guarded rule stop firing, which is a
 *     silent under-decline. **The refusal is `derivationProblems`**, and that is not a detail: it is
 *     the only thing the compilers call (`layer-compile-eligibility.problemsFor` and
 *     `layer-compile-ppp.problemsFor` each `e.push(...layerFacts.derivationProblems(data.derivedFacts))`,
 *     and an unknown kind is one of the errors it returns, so `compileEligibility` / `compilePpp`
 *     throw `LayerCompileError` rather than compiling). This bullet used to credit
 *     `unsupportedDerivationKinds` instead. That function is real and correct, but NOTHING in `src/`
 *     calls it — its only caller anywhere is `scripts/test-lt-ppe-layer-compilers.js` — so anyone
 *     grepping the credited name would have found a helper with no production caller and concluded
 *     the guard was decoration, or "consolidated" the live check in `derivationProblems` away in
 *     favour of it. Kept as the standalone question ("which kinds are unsupported?") a caller can ask
 *     without building an error list; `scripts/test-lt-ppe-claim-drift.js` proves the refusal is the
 *     one credited here by actually compiling a document carrying an unknown kind.
 *   • Nothing here can read a second fact, branch on a rule, or produce a number out of thin air. Each
 *     derivation is a pure function of ONE named input fact plus its own literal parameters.
 *
 * THE SIX KINDS, and the exact hand-written expression each one reproduces:
 *   string        — `String(x || '').toLowerCase()` / `.toUpperCase()` / `.replace(/[^a-z0-9]/g,'')`
 *   is_number     — `typeof x === 'number' && Number.isFinite(x)`  (the modules' own `isNum`)
 *   truthy        — `!!x`
 *   number_gt     — `Number(x) > n`
 *   substring_any — `/a|b/.test(normalized)`  (an ordered OR of literal substrings)
 *   classify      — an ordered `if (/…/.test(k)) return 'A'; if (/…/.test(k)) return 'B'; return null`
 *
 * ABSENT. A derivation may decline to produce a value (today only `classify` with no matching case and a
 * null default). The fact is then simply NOT ADDED to the fact bag, so `rules._evalLeaf` treats it as
 * unknown and every leaf over it is FALSE — which is exactly what `x === null` comparisons do in the
 * hand-written modules, and it keeps the engine's fail-safe-on-unknown guarantee intact.
 *
 * PURE: no DB, no network, no clock, no config. LT-only. No RTL imports.
 */

/** The sentinel a derivation returns to mean "produce no fact at all". */
const ABSENT = Symbol('lt-ppe:absent-fact');

// ---- shared string normalization -------------------------------------------------------------
// Reproduces the hand-written idiom exactly, in this order: fallback → String() → case → strip.
// `fallbackOn:'falsy'` is `String(x || fb)`; `fallbackOn:'nullish'` is `String(x == null ? fb : x)`.
// The two differ for 0/''/false and the hand-written modules genuinely use both, so the compiler must
// be told which — it may never guess.
function normString(raw, spec) {
  const fallbackOn = spec.fallbackOn || 'falsy';
  const fb = spec.fallback === undefined ? '' : spec.fallback;
  let v = raw;
  if (fallbackOn === 'nullish' ? v == null : !v) v = fb;
  let s = String(v);
  const cs = spec.case || 'none';
  if (cs === 'lower') s = s.toLowerCase();
  else if (cs === 'upper') s = s.toUpperCase();
  const strip = spec.strip || 'none';
  if (strip === 'nonalnum') s = s.replace(/[^a-z0-9]/g, '');
  else if (strip === 'nonalpha') s = s.replace(/[^a-z]/g, '');
  return s;
}

const DERIVATION_KINDS = Object.freeze({
  string: (spec, facts) => normString(facts[spec.from], spec),

  is_number: (spec, facts) => {
    const x = facts[spec.from];
    return typeof x === 'number' && Number.isFinite(x);
  },

  truthy: (spec, facts) => !!facts[spec.from],

  number_gt: (spec, facts) => Number(facts[spec.from]) > spec.than,

  substring_any: (spec, facts) => {
    const s = normString(facts[spec.from], spec);
    return spec.needles.some((n) => s.includes(n));
  },

  classify: (spec, facts) => {
    const s = normString(facts[spec.from], spec);
    for (const c of spec.cases) if (c.needles.some((n) => s.includes(n))) return c.value;
    return spec.default === undefined || spec.default === null ? ABSENT : spec.default;
  },
});

const DERIVATION_KIND_NAMES = Object.freeze(Object.keys(DERIVATION_KINDS));

// ---- validation (fail-closed, at compile time) ------------------------------------------------

const CASES = new Set(['none', 'lower', 'upper']);
const STRIPS = new Set(['none', 'nonalnum', 'nonalpha']);
const FALLBACK_ONS = new Set(['falsy', 'nullish']);

/**
 * Every problem with a derived-fact definition map. Empty = valid. PURE, never throws.
 * `defs` is `{ <outFact>: { kind, from, ...params } }`.
 */
function derivationProblems(defs) {
  const errs = [];
  if (defs == null) return errs; // no derived facts is legal
  if (typeof defs !== 'object' || Array.isArray(defs)) return ['derivedFacts: must be an object map'];
  for (const [name, spec] of Object.entries(defs)) {
    const at = `derivedFacts.${name}`;
    if (!name || typeof name !== 'string') { errs.push(`${at}: fact name must be a non-empty string`); continue; }
    if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) { errs.push(`${at}: must be an object`); continue; }
    if (!Object.prototype.hasOwnProperty.call(DERIVATION_KINDS, spec.kind)) {
      errs.push(`${at}.kind: unknown derivation kind ${JSON.stringify(spec.kind)} (known: ${DERIVATION_KIND_NAMES.join(', ')})`);
      continue;
    }
    if (typeof spec.from !== 'string' || !spec.from) errs.push(`${at}.from: must name the source fact`);
    if (spec.case !== undefined && !CASES.has(spec.case)) errs.push(`${at}.case: must be ${[...CASES].join(' | ')}`);
    if (spec.strip !== undefined && !STRIPS.has(spec.strip)) errs.push(`${at}.strip: must be ${[...STRIPS].join(' | ')}`);
    if (spec.fallbackOn !== undefined && !FALLBACK_ONS.has(spec.fallbackOn)) errs.push(`${at}.fallbackOn: must be ${[...FALLBACK_ONS].join(' | ')}`);
    // Stripping runs AFTER the case fold and its character classes are lower-case only, so a strip
    // without a lower-case fold would silently delete every capital letter. Refuse the combination
    // rather than quietly normalizing "Row Home" to "owome".
    if (spec.strip !== undefined && spec.strip !== 'none' && spec.case !== 'lower') {
      errs.push(`${at}.strip: '${spec.strip}' requires case 'lower' (the strip classes are lower-case)`);
    }
    if (spec.kind === 'number_gt' && !(typeof spec.than === 'number' && Number.isFinite(spec.than))) {
      errs.push(`${at}.than: number_gt needs a finite number`);
    }
    if (spec.kind === 'substring_any') {
      if (!Array.isArray(spec.needles) || spec.needles.length === 0 || spec.needles.some((n) => typeof n !== 'string' || !n)) {
        errs.push(`${at}.needles: substring_any needs a non-empty array of non-empty strings`);
      }
    }
    if (spec.kind === 'classify') {
      if (!Array.isArray(spec.cases) || spec.cases.length === 0) errs.push(`${at}.cases: classify needs a non-empty ordered case list`);
      else {
        spec.cases.forEach((c, i) => {
          if (c == null || typeof c !== 'object') { errs.push(`${at}.cases[${i}]: must be an object`); return; }
          if (!Array.isArray(c.needles) || c.needles.length === 0 || c.needles.some((n) => typeof n !== 'string' || !n)) {
            errs.push(`${at}.cases[${i}].needles: needs a non-empty array of non-empty strings`);
          }
          if (c.value === undefined || c.value === null) errs.push(`${at}.cases[${i}].value: needs a value`);
        });
      }
    }
  }
  return errs;
}

/** The derivation kinds a definition map uses that this vocabulary cannot evaluate. Empty = all known. */
function unsupportedDerivationKinds(defs) {
  const bad = [];
  for (const [name, spec] of Object.entries(defs || {})) {
    const k = spec && spec.kind;
    if (!Object.prototype.hasOwnProperty.call(DERIVATION_KINDS, k)) bad.push(`${name}:${String(k)}`);
  }
  return bad;
}

/**
 * Run every derivation over a raw fact bag and return ONLY the derived facts (never the raw ones —
 * the caller merges, so a derivation can never silently shadow a scenario fact it did not mean to).
 * A derivation that returns ABSENT contributes no key at all.
 *
 * DERIVATIONS CHAIN, IN DECLARATION ORDER. A derivation may name an EARLIER derived fact as its
 * `from`, because a hand-written module sometimes normalizes the same input TWICE and the second pass
 * is not a no-op: `deephaven-ppp-matrix` computes `String(inp.lien || 'first').toLowerCase()` when it
 * builds its normalized input AND again inside its lien handler, so a lien of `[]` (truthy, but
 * `String([])` is the empty string) comes out as `'first'` only after the second pass. Modelling that
 * as one derivation would be an approximation; modelling it as two is exact. Declaration order is
 * evaluation order — there is no dependency solver and no cycle detection, deliberately, because a
 * derivation that reads a LATER one simply sees an absent fact and that is visible immediately.
 * PURE.
 */
function deriveFacts(defs, facts) {
  const out = {};
  const base = facts || {};
  let view = base;
  for (const [name, spec] of Object.entries(defs || {})) {
    const fn = DERIVATION_KINDS[spec.kind];
    if (!fn) throw new Error(`layer-facts:unknown_derivation_kind:${name}:${String(spec.kind)}`);
    const v = fn(spec, view);
    if (v !== ABSENT) { out[name] = v; view = { ...base, ...out }; }
  }
  return out;
}

module.exports = {
  ABSENT,
  DERIVATION_KINDS,
  DERIVATION_KIND_NAMES,
  derivationProblems,
  unsupportedDerivationKinds,
  deriveFacts,
  _internals: { normString },
};
