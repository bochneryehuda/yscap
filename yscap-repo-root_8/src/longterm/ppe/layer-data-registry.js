'use strict';
/**
 * LT PPE — THE VERSIONED INVESTOR-LAYER DATA REGISTRY, and the COMPILED program catalog built on it
 * (PPE item #47, the scalable foundation).
 *
 * WHAT THIS IS FOR. `program-registry.js` catalogs HAND-WRITTEN program descriptors by investor. This is
 * its data-driven sibling: it catalogs the LAYER DATA DOCUMENTS (an eligibility matrix, a PPP matrix)
 * by (investor, layer, VERSION), compiles them on demand through the pure compilers, and builds the
 * program descriptor the existing `program-engine.runProgram` pipeline already knows how to run.
 *
 * WHY A VERSION IS PART OF THE KEY, AND WHY A PROGRAM MUST NAME ITS OWN. An investor's matrix has an
 * effective date and is reissued; a PPP matrix carries thresholds that change every year. Two versions
 * of the same investor's matrix therefore have to be able to sit side by side — one live, one being
 * prepared or being compared against — and the PROGRAM is what says which one it prices on. So
 * `getData` REFUSES to guess: a caller asks for a named version, and a program registration pins the
 * version it means. `latestVersion()` exists for a listing screen, never for pricing.
 *
 * WHY IT IS A REGISTRY AND NOT A `require` PER INVESTOR. Onboarding a second investor becomes: drop in
 * two JSON documents, add one `registerProgram` entry naming them. No pricing code changes, and the two
 * investors' programs coexist under different keys with no shared mutable state.
 *
 * WHAT IS NOT DATA YET, AND IS HONEST ABOUT IT. Only layers 2 and 3 are compiled from data. A program
 * registration still supplies its own `evaluateOverlay` / `evaluateInformational` slots (the Advanced
 * overlay layer and the informational layer are separate modules and separate work), so a compiled
 * descriptor is explicit about which of its slots came from data and which are still code — see
 * `describeProgram()`.
 *
 * PURE: no DB, no network, no clock, no config. Compilation is memoized per (investor, layer, version).
 * LT-only. No RTL imports.
 */

const { assertDescriptor, runProgram } = require('./program-engine');
const { _normKey: normKey } = require('./program-registry'); // the ONE investor-key normalizer, imported
const { compileEligibility } = require('./layer-compile-eligibility');
const { compilePpp } = require('./layer-compile-ppp');

const LAYERS = Object.freeze(['eligibility', 'ppp']);
const COMPILERS = Object.freeze({ eligibility: compileEligibility, ppp: compilePpp });

// ---- the data catalog -------------------------------------------------------------------------

const DATA = new Map();      // `${investorKey}|${layer}|${version}` → { investor, investorKey, layer, version, doc }
const COMPILED = new Map();  // the same key → the compiled layer (memoized)

const dataKey = (investorKey, layer, version) => `${investorKey}|${layer}|${version}`;

/**
 * Register a layer DATA DOCUMENT. Its investor / layer / dataVersion come from the document itself, so
 * a registration can never disagree with the file it names. Re-registering the SAME (investor, layer,
 * version) with a DIFFERENT document is REFUSED — a version is an immutable identity, and silently
 * swapping one would change what an already-priced program means.
 */
function registerData(doc) {
  if (doc == null || typeof doc !== 'object') throw new Error('layer-data-registry:data_not_an_object');
  const { investor, layer, dataVersion } = doc;
  if (!investor || typeof investor !== 'string') throw new Error('layer-data-registry:data_missing_investor');
  if (!LAYERS.includes(layer)) throw new Error(`layer-data-registry:unknown_layer:${String(layer)}`);
  if (!dataVersion || typeof dataVersion !== 'string') throw new Error('layer-data-registry:data_missing_dataVersion');
  const investorKey = normKey(investor);
  const key = dataKey(investorKey, layer, dataVersion);
  const prior = DATA.get(key);
  if (prior && prior.doc !== doc) throw new Error(`layer-data-registry:version_already_registered:${key}`);
  const entry = Object.freeze({ investor, investorKey, layer, version: dataVersion, doc });
  DATA.set(key, entry);
  return entry;
}

/** The registered document for an exact (investor, layer, version), or null. Never guesses a version. */
function getData(investor, layer, version) {
  return DATA.get(dataKey(normKey(investor), layer, version)) || null;
}

/** Every registered document, optionally narrowed. For listings/admin — never for pricing. */
function listData(filter = {}) {
  const wantInvestor = filter.investor ? normKey(filter.investor) : null;
  const out = [];
  for (const e of DATA.values()) {
    if (wantInvestor && e.investorKey !== wantInvestor) continue;
    if (filter.layer && e.layer !== filter.layer) continue;
    out.push({ investor: e.investor, investorKey: e.investorKey, layer: e.layer, version: e.version });
  }
  return out.sort((a, b) => a.investorKey.localeCompare(b.investorKey) || a.layer.localeCompare(b.layer) || a.version.localeCompare(b.version));
}

/** The versions registered for an (investor, layer), newest LAST by registration order. Listing only. */
function versionsFor(investor, layer) {
  return listData({ investor, layer }).map((e) => e.version);
}

/** The COMPILED layer for an exact (investor, layer, version). Memoized. Throws if not registered. */
function compiledLayer(investor, layer, version) {
  const key = dataKey(normKey(investor), layer, version);
  if (COMPILED.has(key)) return COMPILED.get(key);
  const entry = DATA.get(key);
  if (!entry) throw new Error(`layer-data-registry:no_such_data:${key}`);
  const compiled = COMPILERS[layer](entry.doc);
  COMPILED.set(key, compiled);
  return compiled;
}

// ---- the compiled PROGRAM catalog ---------------------------------------------------------------

const PROGRAMS = new Map();   // investorKey (and each alias) → registration
const DESCRIPTORS = new Map(); // registration → built descriptor (memoized)

/**
 * Register a program built from DATA. `dataVersions` names the exact version of each compiled layer —
 * that pinning is the whole point of the registry. `slots` supplies the layers that are still code
 * (overlay + informational) plus the overlay's fact coverage.
 */
function registerProgram(reg) {
  if (reg == null || typeof reg !== 'object') throw new Error('layer-data-registry:program_not_an_object');
  const { investor, programName, dataVersions, slots, aliases } = reg;
  if (!investor || !programName) throw new Error('layer-data-registry:program_missing_identity');
  if (!dataVersions || !dataVersions.eligibility || !dataVersions.ppp) throw new Error('layer-data-registry:program_must_pin_data_versions');
  if (!slots || typeof slots.evaluateOverlay !== 'function' || typeof slots.evaluateInformational !== 'function') {
    throw new Error('layer-data-registry:program_missing_code_slots');
  }
  const entry = Object.freeze({
    investor,
    investorKey: normKey(investor),
    programName,
    dataVersions: Object.freeze({ ...dataVersions }),
    slots,
    aliases: Object.freeze([...(aliases || [])]),
  });
  for (const a of [investor, ...(aliases || [])]) {
    const k = normKey(a);
    const prior = PROGRAMS.get(k);
    if (prior && prior !== entry && prior.investorKey !== entry.investorKey) {
      throw new Error(`layer-data-registry:alias_collision:${k}`);
    }
    PROGRAMS.set(k, entry);
  }
  return entry;
}

/** Build (and memoize) the `program-engine` descriptor for a registration. */
function descriptorForRegistration(reg) {
  if (DESCRIPTORS.has(reg)) return DESCRIPTORS.get(reg);
  const elig = compiledLayer(reg.investor, 'eligibility', reg.dataVersions.eligibility);
  const ppp = compiledLayer(reg.investor, 'ppp', reg.dataVersions.ppp);
  const desc = assertDescriptor({
    investor: reg.investor,
    programName: reg.programName,
    evaluateEligibility: elig.evaluate,          // dot 2 — COMPILED FROM DATA
    pppInputFromFacts: ppp.inputFromFacts,       // engine facts → the PPP input shape, FROM DATA
    pppResult: ppp.pppResult,                    // dot 3 — COMPILED FROM DATA
    pppDisqualifier: ppp.pppDisqualifier,        // dot 3 — COMPILED FROM DATA
    evaluateOverlay: reg.slots.evaluateOverlay,  // still code
    evaluateInformational: reg.slots.evaluateInformational, // still code
    overlayCoverage: reg.slots.overlayCoverage || [],
    // The overlay layer's own CUT TABLE, when the registration supplies one. It is carried purely so a
    // self-audit can ENUMERATE the decline codes this still-code layer can emit — without it that layer
    // is a closed function whose declines can be counted but never checked for completeness, so a cut
    // that can never fire would be invisible. Nothing in the pricing pipeline reads it.
    overlayCuts: reg.slots.overlayCuts || [],
    // the versions this program prices on — a descriptor can always answer "which data am I?"
    dataVersions: reg.dataVersions,
    compiledLayers: { eligibility: elig, ppp },
  });
  DESCRIPTORS.set(reg, desc);
  return desc;
}

/** The compiled program descriptor for an investor key, or null when none is registered. Never throws. */
function programFor(investorKey) {
  const reg = PROGRAMS.get(normKey(investorKey));
  if (!reg) return null;
  return descriptorForRegistration(reg);
}

/** Every registered compiled program: identity + the data versions it prices on. */
function listPrograms() {
  const seen = new Set();
  const out = [];
  for (const reg of PROGRAMS.values()) {
    if (seen.has(reg)) continue;
    seen.add(reg);
    out.push({ investor: reg.investor, investorKey: reg.investorKey, programName: reg.programName, dataVersions: { ...reg.dataVersions } });
  }
  return out.sort((a, b) => a.investorKey.localeCompare(b.investorKey));
}

/** Which of a program's layers came from DATA and which are still code — stated, never implied. */
function describeProgram(investorKey) {
  const reg = PROGRAMS.get(normKey(investorKey));
  if (!reg) return null;
  return {
    investor: reg.investor,
    programName: reg.programName,
    layers: {
      eligibility: { source: 'data', version: reg.dataVersions.eligibility },
      ppp: { source: 'data', version: reg.dataVersions.ppp },
      overlay: { source: 'code' },
      informational: { source: 'code' },
      rateSheet: { source: 'code' },
    },
  };
}

/** Evaluate the compiled program registered for `investorKey`, or null when there is none. */
function evaluateProgramFor(investorKey, facts, opts = {}) {
  const desc = programFor(investorKey);
  return desc ? runProgram(desc, facts, opts) : null;
}

// ---- the seed registrations --------------------------------------------------------------------
// Deephaven's two layer documents, and the program that pins them. A SECOND investor is exactly this
// again: two JSON files plus one registerProgram call.

registerData(require('./investor-data/deephaven-dscr.eligibility.v2026-08-04.json'));
registerData(require('./investor-data/deephaven-dscr.ppp.v2026-03.json'));

const { evaluateOverlayDeclines, DEEPHAVEN_OVERLAY_CUTS } = require('./deephaven-overlay-rules');
const { evaluateInformational } = require('./informational');

registerProgram({
  investor: 'Deephaven',
  programName: 'Deephaven DSCR',
  aliases: ['deephaven', 'deephavendscr', 'deephavenmortgage'],
  dataVersions: { eligibility: '2026-08-04', ppp: '2026-03' },
  slots: {
    evaluateOverlay: (facts, o) => evaluateOverlayDeclines(facts, o),
    evaluateInformational,
    overlayCoverage: [...new Set(DEEPHAVEN_OVERLAY_CUTS.map((g) => g.when))],
    overlayCuts: DEEPHAVEN_OVERLAY_CUTS,   // enumerable for the self-audit; see descriptorForRegistration
  },
});

module.exports = {
  LAYERS,
  registerData,
  getData,
  listData,
  versionsFor,
  compiledLayer,
  registerProgram,
  programFor,
  listPrograms,
  describeProgram,
  evaluateProgramFor,
  _internals: { DATA, PROGRAMS, dataKey, normKey },
};
