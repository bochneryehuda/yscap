#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM (LT) PPE — RUN THE PROGRAM SELF-AUDIT AGAINST THE REAL INVESTOR CATALOG.
 *
 *   node scripts/lt-ppe-program-audit.js            → the readable report
 *   node scripts/lt-ppe-program-audit.js --json     → the same answer as JSON
 *   node scripts/lt-ppe-program-audit.js --strict   → also EXIT 1 while a dead-rule question is open
 *
 * WHY THE COMMAND'S BODY LIVES HERE AND NOT IN `scripts/`. Long-Term back-end code lives ONLY in
 * `src/longterm/**` (the two-product separation rule), and `scripts/check-product-separation.js`
 * enforces it: the ONLY files outside `src/longterm/` allowed to `require()` Long-Term are the router
 * mount in `src/server.js` and `scripts/test-lt-*.js`. A command is neither. So the command IS this
 * module — runnable directly (`node src/longterm/ppe/program-audit-command.js`) — and
 * `scripts/lt-ppe-program-audit.js` is a launcher that starts it as its own process and imports
 * nothing. That keeps the operator-facing name where a person will look for it without an RTL file
 * gaining a dependency on Long-Term. Collapsing the two into one `scripts/` file would need the
 * owner's WRITTEN authorization recorded as an `rtl-import` entry in
 * `docs/LONG-TERM-AUTHORIZED-COPIES.md`; that is the owner's call, not an agent's.
 *
 * WHAT THIS IS FOR. `src/longterm/ppe/program-audit.js` can profile a program across a battery of
 * scenarios; it has a thorough test and, until this command, NOTHING RAN IT against the programs we
 * actually ship. This is that runner. It takes every program in the catalog — the hand-written
 * descriptors in `program-registry.js` AND the ones compiled from the versioned layer documents in
 * `layer-data-registry.js` — pushes a deterministic battery of loan scenarios through each, and prints
 * what the engine DECIDED: how many loans it would take, which layer turned the rest away, how often
 * each rule fired, which investor overlays armed, and what it still cannot check.
 *
 * THE ANSWER IT EXISTS FOR IS THE DEAD RULE. A decline rule that fires on ZERO of tens of thousands of
 * loans is one of two things and they are not the same thing at all: a rule that was encoded wrong and
 * can never fire (a real defect — the investor's requirement is silently not being applied), or a rule
 * this battery simply never asked about. **This command refuses to pick one for you.** For every rule
 * that never fired it re-reads that rule's OWN published trigger and checks, condition by condition,
 * whether any scenario in the battery ever came close:
 *
 *   · a trigger condition NO scenario in the battery satisfies  → "the battery never tried it" — and it
 *     names the exact condition that was never tried, so widening the battery is a five-second job;
 *   · every condition met somewhere, yet the rule still never fired → "the battery tried it and it
 *     never fired" — a REAL QUESTION for a human, because a rule whose parts are all reachable but
 *     which never triggers is what a mis-encoded threshold looks like;
 *   · a rule whose trigger is not published as data, or a truncated battery → "cannot tell", stated as
 *     "cannot tell", never rounded down to "fine".
 *
 * TWO THINGS IT WILL NOT DO, both learned the hard way in this repository:
 *
 *   1. IT CANNOT REPORT "ALL CLEAR" HAVING MEASURED NOTHING. An empty catalog, an empty battery, or a
 *      program whose rules could not be enumerated at all is a FAILURE (exit 1), not a clean run. A
 *      runner that reports green because it ran nothing is the exact defect this workstream keeps
 *      finding, and it is indistinguishable from a working one unless the runner refuses.
 *   2. IT NEVER TRUSTS A TRUNCATED BATTERY. `scenario-matrix.buildMatrix` deterministically STRIDES a
 *      grid that is larger than its ceiling, and a strided grid can skip every cell that would have
 *      armed a live rule. Every leg of the battery is built at a ceiling above its own full size and
 *      the run ASSERTS it came back untruncated; if one ever does truncate, every never-fired verdict
 *      in that run is downgraded to "cannot tell" and the report says so at the top.
 *
 * WHAT IT CANNOT SEE, said out loud rather than implied. A program's ELIGIBILITY and PREPAYMENT layers
 * are compiled from data documents that publish their rule catalog, so their rules can be enumerated
 * and a never-fired one is meaningful. The OVERLAY layer is still a code slot on the descriptor and
 * publishes no catalog, so its codes are only ever COUNTED here, never checked for completeness —
 * silence from that layer is not evidence, and the report says exactly that.
 *
 * Read-only in every sense: no database, no network, no clock, no writes. LT-only; no RTL imports.
 */

const handWritten = require('./program-registry');
const compiledRegistry = require('./layer-data-registry');
const { auditProgram } = require('./program-audit');
const { buildMatrix } = require('./scenario-matrix');
const { evalPredicate } = require('./rules');
const { deriveFacts } = require('./layer-facts');

// ---- the battery -----------------------------------------------------------------------------------
//
// Several SMALL FULL grids rather than one big strided one. A single grid spanning every axis this
// program reads is astronomically large, so it would be strided — and a strided grid is exactly what
// makes a `neverFired` verdict untrustworthy. Each leg below is a complete cartesian product of its own
// axes, built at a ceiling far above its own size, so every leg is untruncated and the union of them is
// a battery every scenario of which was genuinely evaluated.
//
// The axes are LOAN FACTS in the engine's own vocabulary (fico raw, ltv milli-percent, dscr milli,
// dollars raw). They are chosen to straddle the published thresholds — a value on each side of every
// line the matrix draws — which is what makes a rule that still never fires worth asking about.

const pct = (p) => p * 1000;   // 70 → 70000 milli-percent
const CEILING = 5000000;       // far above every leg's own full size; a leg that truncates is a defect

const LEGS = [
  {
    name: 'core envelope',
    why: 'loan size, credit score, leverage and coverage across every published threshold',
    base: { state: 'NY', borrower_type: 'LLC', property_type: 'SFR', prepay_months: 0, occupancy: 'leased' },
    axes: {
      fico: [600, 640, 660, 680, 700, 720, 760],
      ltv: [pct(50), pct(60), pct(65), pct(70), pct(75), pct(80), pct(85)],
      dscr: [700, 750, 900, 1000, 1150, 1250],
      loan_amount: [50000, 74999, 100000, 124999, 150000, 400000, 1600000, 2100000, 2600000],
      units: [1, 2, 5],
      purpose: ['purchase', 'ratetermrefi', 'cashout'],
      interest_only: [false, true],
    },
  },
  {
    name: 'cash-out proceeds',
    why: 'the two cash-out dollar caps, which only apply on a cash-out refinance either side of 65% LTV',
    base: { state: 'NY', borrower_type: 'LLC', property_type: 'SFR', prepay_months: 0, occupancy: 'leased', purpose: 'cashout', fico: 760, dscr: 1250, units: 1 },
    axes: {
      ltv: [pct(60), pct(65), pct(66), pct(70)],
      loan_amount: [400000, 1200000, 2000000],
      cashout_amount: [0, 400000, 600000, 1100000],
    },
  },
  {
    name: 'property and structure',
    why: 'property type, unit count and subordinate financing — the flat eligibility refusals',
    base: { state: 'NY', borrower_type: 'LLC', prepay_months: 0, occupancy: 'leased', purpose: 'purchase', fico: 760, dscr: 1250, ltv: pct(65), loan_amount: 400000 },
    axes: {
      property_type: ['SFR', 'PUD', 'Townhome', 'Row Home', 'Condo', 'Non-Warrantable Condo'],
      units: [1, 2, 4, 5, 6],
      subordinate_amount: [0, 50000],
    },
  },
  {
    name: 'prepayment penalty by state',
    why: 'every state the prepayment matrix carries a rule for, both borrower kinds, either side of each dollar and APR line',
    base: { property_type: 'SFR', occupancy: 'leased', purpose: 'purchase', fico: 760, dscr: 1250, ltv: pct(70) },
    axes: {
      state: ['AK', 'IL', 'LA', 'MD', 'MI', 'MN', 'NJ', 'NM', 'OH', 'PA', 'RI', 'VA', 'VT', 'CA', 'TX'],
      borrower_type: ['LLC', 'Individual'],
      units: [1, 2, 4, 6],
      loan_amount: [50000, 100000, 116356, 120000, 329411, 400000, 832750, 900000, 1000000, 1100000],
      apr: [7, 9],
      rural_property: [false, true],
      prepay_months: [0, 60],
    },
  },
  {
    name: 'investor overlays',
    why: 'the Advanced overlay switches, each against the credit / coverage / leverage / size it cuts on',
    base: { state: 'NY', borrower_type: 'LLC', property_type: 'SFR', prepay_months: 0, purpose: 'purchase' },
    axes: {
      units: [1, 2],
      short_term_rental: [false, true],
      first_time_investor: [false, true],
      rural_property: [false, true],
      declining_market: [false, true],
      foreign_national: [false, true],
      first_time_homebuyer: [false, true],
      renovation: [false, true],
      occupancy: ['leased', 'vacant'],
      fico: [660, 700, 720, 760],
      dscr: [900, 1000, 1150, 1250],
      ltv: [pct(60), pct(65), pct(70), pct(75), pct(80)],
      loan_amount: [400000, 1600000],
    },
  },
];

/**
 * Build the battery: every leg's FULL grid, concatenated. PURE.
 * Returns { scenarios, legs:[{name, why, size, truncated}], truncated, total }.
 * `truncated` is true when ANY leg came back strided — the caller must then treat every never-fired
 * verdict as "cannot tell", because a strided grid can skip the very cell that arms a rule.
 */
function buildBattery(legs = LEGS, opts = {}) {
  const ceiling = opts.maxScenarios == null ? CEILING : opts.maxScenarios;
  const scenarios = [];
  const out = [];
  for (const leg of legs) {
    const built = buildMatrix(leg.axes, { base: leg.base, maxScenarios: ceiling });
    for (const s of built.scenarios) scenarios.push(s);
    out.push({ name: leg.name, why: leg.why, size: built.scenarios.length, fullSize: built.fullSize, truncated: built.truncated });
  }
  return { scenarios, legs: out, truncated: out.some((l) => l.truncated), total: scenarios.length };
}

// ---- the catalog -----------------------------------------------------------------------------------

/**
 * Every program the system can price with, from BOTH catalogs, never hand-built here. PURE.
 * `program-registry` holds the hand-written descriptors; `layer-data-registry` holds the ones compiled
 * from the versioned layer documents. Both are audited: they are the same investor's same matrix by two
 * different routes, and a difference between them is itself worth seeing.
 */
function catalogPrograms(registries = {}) {
  const hand = registries.handWritten || handWritten;
  const comp = registries.compiled || compiledRegistry;
  const out = [];
  for (const p of hand.listPrograms()) {
    const descriptor = hand.programFor(p.investor);
    if (descriptor) out.push({ source: 'hand-written descriptor', sourceModule: 'program-registry.js', investor: p.investor, programName: p.programName, descriptor, dataVersions: null });
  }
  for (const p of comp.listPrograms()) {
    const descriptor = comp.programFor(p.investorKey);
    if (descriptor) out.push({ source: 'compiled from the layer data documents', sourceModule: 'layer-data-registry.js', investor: p.investor, programName: p.programName, descriptor, dataVersions: p.dataVersions || null });
  }
  return out;
}

// ---- what rules a program PUBLISHES ------------------------------------------------------------------

const LAYER_LABEL = {
  eligibility: 'the eligibility matrix',
  ppp: 'the prepayment-penalty rules',
  overlay: 'the investor overlays',
};

/**
 * The decline rules a program publishes for one compiled layer. Derived entirely from the compiled
 * layer's own catalog + rule list — never a list kept by hand here, so a rule added to a data document
 * is audited the day it lands. Returns { enumerable, rules:[{ruleId, code, when, declineReason}], codes,
 * derivedFacts } or { enumerable:false, why } when the layer publishes nothing readable.
 */
function layerCatalog(descriptor, layer) {
  const compiled = descriptor && descriptor.compiledLayers && descriptor.compiledLayers[layer];
  if (!compiled || !compiled.catalog || !Array.isArray(compiled.rules)) {
    return {
      enumerable: false,
      rules: [],
      codes: [],
      why: `this program does not publish a rule catalog for ${LAYER_LABEL[layer] || layer} — its rules are code, not data, so nothing here can list them`,
    };
  }
  const rules = [];
  for (const r of compiled.rules) {
    const entry = compiled.catalog[r.code];
    // A rule with no decline code in the catalog is a BOUND or a DIAGNOSTIC (it sets a cap, or records
    // that a state has a rule table). It can never turn a loan away, so it is not a dead-rule candidate.
    if (!entry || !entry.code) continue;
    rules.push({ ruleId: r.code, code: entry.code, when: r.when == null ? null : r.when, declineReason: entry.declineReason || null });
  }
  return { enumerable: true, rules, codes: [...new Set(rules.map((r) => r.code))], derivedFacts: compiled.derivedFacts || {} };
}

/**
 * The overlay layer's decline rules, from the CUT TABLE the descriptor carries. The overlay layer is
 * still code rather than a compiled data document, but its cuts are a declarative table, so a program
 * that hands that table to its descriptor can be held to it here exactly like the other two layers. A
 * program that does not is reported as un-enumerable — silence from it is not evidence.
 *
 * Each cut becomes a rule with TWO things the coverage probe can test separately: the group's ARMING
 * fact (the Advanced switch that turns the whole group on) and the cut's own comparison.
 */
function overlayCatalog(descriptor) {
  const table = descriptor && descriptor.overlayCuts;
  if (!Array.isArray(table) || !table.length) {
    return {
      enumerable: false,
      rules: [],
      codes: [],
      why: 'this program hands the audit no overlay cut table, so the overlay layer is a closed function here — its declines are COUNTED but cannot be checked for completeness',
    };
  }
  const rules = [];
  for (const group of table) {
    for (const cut of group.cuts || []) {
      if (!cut || !cut.code) continue;
      rules.push({
        ruleId: `${group.when}:${cut.code}`,
        code: cut.code,
        arming: { fact: group.when, equals: Object.prototype.hasOwnProperty.call(group, 'whenEquals') ? group.whenEquals : true },
        cut: { fact: cut.fact, cmp: cut.cmp, value: Object.prototype.hasOwnProperty.call(cut, 'value') ? cut.value : undefined },
        declineReason: typeof cut.reason === 'string' ? cut.reason : (cut.label && typeof cut.label === 'string' ? cut.label : null),
        when: null,
      });
    }
  }
  return { enumerable: rules.length > 0, rules, codes: [...new Set(rules.map((r) => r.code))], derivedFacts: {} };
}

/** Every layer's catalog for a program, plus the flat list of codes we can hold it to. PURE. */
function declaredCodes(descriptor) {
  const layers = {
    eligibility: layerCatalog(descriptor, 'eligibility'),
    ppp: layerCatalog(descriptor, 'ppp'),
    overlay: overlayCatalog(descriptor),
  };
  const codes = [...new Set([...layers.eligibility.codes, ...layers.ppp.codes, ...layers.overlay.codes])];
  const notEnumerable = Object.keys(layers).filter((k) => !layers[k].enumerable).map((k) => ({ layer: k, label: LAYER_LABEL[k] || k, why: layers[k].why }));
  return { layers, codes, notEnumerable, anyEnumerable: Object.keys(layers).some((k) => layers[k].enumerable) };
}

// ---- did the battery ever come close? ---------------------------------------------------------------

/** Every leaf condition in a published trigger tree. PURE. */
function leavesOf(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  for (const key of ['all', 'any', 'none']) {
    if (Array.isArray(node[key])) { for (const n of node[key]) leavesOf(n, out); return out; }
  }
  if (node.not != null) return leavesOf(node.not, out);
  if ('fact' in node && 'op' in node) out.push(node);
  return out;
}

/** A leaf condition in plain words: `loan_amount > 2,500,000`. PURE. */
function describeLeaf(leaf) {
  const OP = { eq: 'is', neq: 'is not', in: 'is one of', nin: 'is none of', lt: '<', lte: '<=', gt: '>', gte: '>=', between: 'is in the range', exists: 'is present' };
  const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : JSON.stringify(v));
  if (leaf.op === 'exists') return `${leaf.fact} is present`;
  return `${leaf.fact} ${OP[leaf.op] || leaf.op} ${Array.isArray(leaf.value) ? leaf.value.map(num).join(' / ') : num(leaf.value)}`;
}

// An overlay cut's comparison, expressed as one of the engine's own leaf operators, so the coverage
// probe below can ask "did any loan in the battery land on that side of the line?" without owning a
// second copy of the cut vocabulary. THIS IS A PROBE, NOT AN ENFORCER: it never decides a decline (the
// overlay cut engine does that, and did it already), it only decides the WORDING of a never-fired
// verdict — so an operator it does not recognise (today `gtRelative`, whose threshold is computed per
// loan from the grid and therefore has no static value) yields NO probe and the answer degrades to
// "cannot tell", never to "fine".
const CUT_CMP_AS_LEAF_OP = { lt: 'lt', lte: 'lte', gt: 'gt', gte: 'gte' };

/**
 * Every condition of one rule, as leaf probes the battery can be measured against. PURE.
 * A data-compiled rule contributes every leaf of its published trigger tree; an overlay cut contributes
 * its group's ARMING switch plus, when the comparison is expressible as a leaf, the cut itself.
 */
function conditionsOf(rule) {
  if (rule.when != null) return leavesOf(rule.when);
  const out = [];
  if (rule.arming && rule.arming.fact) out.push({ fact: rule.arming.fact, op: 'eq', value: rule.arming.equals });
  const cut = rule.cut;
  if (cut && cut.fact) {
    if (cut.cmp === 'isTrue') out.push({ fact: cut.fact, op: 'eq', value: true });
    else if (CUT_CMP_AS_LEAF_OP[cut.cmp] && cut.value !== undefined) out.push({ fact: cut.fact, op: CUT_CMP_AS_LEAF_OP[cut.cmp], value: cut.value });
  }
  return out;
}

/**
 * The fact view one layer's rules are evaluated against, for one scenario. The eligibility layer reads
 * the engine facts directly; the prepayment layer reads the program's OWN facts→input mapping. Both
 * then add the layer's declared derived facts. Returns null when it cannot be built (never throws) — an
 * unbuildable view means we cannot judge coverage, which is reported as "cannot tell", never as "fine".
 */
function factViewFor(descriptor, layer, cat, scenario) {
  try {
    const base = layer === 'ppp' ? descriptor.pppInputFromFacts(scenario) : scenario;
    if (base == null || typeof base !== 'object') return null;
    return { ...base, ...deriveFacts(cat.derivedFacts, base) };
  } catch (_e) {
    return null;
  }
}

/**
 * For every code that never fired, work out WHICH of the two it is — and say "cannot tell" when it is
 * neither. PURE (it re-runs the published triggers over the same scenarios; no IO).
 *
 * The test is per LEAF CONDITION: a rule can only ever fire if every condition in its trigger is
 * satisfiable by something in the battery. A condition nothing in the battery satisfies is proof the
 * battery never asked the question — and naming it is the whole point, because it turns a scary
 * "nothing fired" into "add this value to the battery". Only when EVERY condition of some rule was met
 * somewhere, and the rule still never fired, is there a real question for a human.
 */
function classifyNeverFired(descriptor, cat, neverFired, scenarios, opts = {}) {
  const truncated = !!opts.truncated;
  const out = [];
  for (const code of neverFired) {
    const layer = cat.layers.eligibility.codes.includes(code) ? 'eligibility'
      : cat.layers.ppp.codes.includes(code) ? 'ppp' : 'overlay';
    const layerCat = cat.layers[layer];
    const rules = layerCat.rules.filter((r) => r.code === code);
    const entry = { code, layer, layerLabel: LAYER_LABEL[layer], declineReason: (rules[0] && rules[0].declineReason) || null, rules: rules.map((r) => r.ruleId) };

    if (truncated) {
      out.push({ ...entry, verdict: 'cannot_tell', because: 'the battery was cut short, so a rule it never reached looks identical to one that cannot fire' });
      continue;
    }
    if (!rules.length || rules.some((r) => r.when == null && !r.arming)) {
      out.push({ ...entry, verdict: 'cannot_tell', because: 'this rule does not publish a trigger we can re-read, so we cannot say whether the battery ever asked the question' });
      continue;
    }

    // Per rule: which of its conditions did NOTHING in the battery satisfy?
    let anyRuleFullyExercised = false;
    const untried = [];
    let unjudgeable = false;
    for (const rule of rules) {
      const leaves = conditionsOf(rule);
      if (!leaves.length) { unjudgeable = true; continue; }
      // `met[i]` = "SOME loan in the battery satisfied condition i" — asked per condition, not per loan,
      // because the question is whether the battery ever went near each of them at all.
      const met = leaves.map(() => false);
      for (const s of scenarios) {
        const view = factViewFor(descriptor, layer, layerCat, s);
        if (!view) { unjudgeable = true; break; }
        for (let i = 0; i < leaves.length; i += 1) {
          if (!met[i] && evalPredicate(leaves[i], view).value) met[i] = true;
        }
        if (met.every(Boolean)) break; // every condition of this rule is reachable — nothing left to learn
      }
      const missing = leaves.filter((_l, i) => !met[i]).map(describeLeaf);
      if (!missing.length) anyRuleFullyExercised = true; else untried.push({ ruleId: rule.ruleId, neverTried: missing });
    }

    if (unjudgeable && !anyRuleFullyExercised) {
      out.push({ ...entry, verdict: 'cannot_tell', because: 'this rule\'s trigger could not be re-read against the battery' });
    } else if (anyRuleFullyExercised) {
      out.push({ ...entry, verdict: 'exercised_but_never_fired', because: 'every condition this rule needs was met somewhere in the battery, yet the rule itself never triggered on a single loan' });
    } else {
      out.push({ ...entry, verdict: 'battery_never_tried_it', because: 'the battery contains no loan that meets this rule\'s own trigger conditions', untried });
    }
  }
  return out;
}

// ---- the run ---------------------------------------------------------------------------------------

/** Sort a {key: count} tally into a descending [{key, count}] list. PURE. */
function ranked(tally) {
  return Object.entries(tally || {}).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Audit every program in the catalog over `battery`. PURE (no IO — every input is passed in).
 * Returns the whole report object; `renderReport` and `verdictOf` read it, and `--json` prints it.
 */
function auditCatalog(programs, battery) {
  const results = [];
  for (const p of programs) {
    const cat = declaredCodes(p.descriptor);
    const digest = auditProgram(p.descriptor, battery.scenarios, { expectedCodes: cat.codes });
    const neverFired = Array.isArray(digest.neverFired) ? digest.neverFired : [];
    const findings = classifyNeverFired(p.descriptor, cat, neverFired, battery.scenarios, { truncated: battery.truncated });
    const declaredSet = new Set(cat.codes);
    const observedUndeclared = Object.keys(digest.declineCodeCounts).filter((c) => !declaredSet.has(c)).sort();
    results.push({
      investor: p.investor,
      programName: p.programName,
      source: p.source,
      sourceModule: p.sourceModule,
      dataVersions: p.dataVersions,
      declaredCodeCount: cat.codes.length,
      notEnumerable: cat.notEnumerable,
      anyEnumerable: cat.anyEnumerable,
      digest,
      firedCodes: ranked(digest.declineCodeCounts),
      overlaysArmed: ranked(digest.overlayArmedCounts),
      stillFlagged: ranked(digest.stillFlaggedCounts),
      stillUnverifiable: ranked(digest.stillUnverifiableCounts),
      observedUndeclared,
      findings,
      questions: findings.filter((f) => f.verdict === 'exercised_but_never_fired'),
      untested: findings.filter((f) => f.verdict === 'battery_never_tried_it'),
      cannotTell: findings.filter((f) => f.verdict === 'cannot_tell'),
    });
  }
  return {
    generatedBy: 'scripts/lt-ppe-program-audit.js',
    battery: { total: battery.total, truncated: battery.truncated, legs: battery.legs },
    programsAudited: results.length,
    scenariosAudited: battery.total,
    programs: results,
    crossChecks: crossCheck(results),
  };
}

/**
 * Where the SAME investor is in the catalog twice — once hand-written, once compiled from its data
 * documents — the two are supposed to be the same rule book by two routes, so every loan should get the
 * same answer from both. This says whether they did. It is free (both digests are already computed) and
 * it is the only thing in this run that can catch the data form drifting from the code form: a rule
 * transcribed into the JSON slightly differently would show up here as a handful of loans decided
 * differently, long before anybody priced one. PURE.
 */
function crossCheck(results) {
  const byInvestor = new Map();
  for (const r of results) {
    const k = String(r.investor).toLowerCase();
    if (!byInvestor.has(k)) byInvestor.set(k, []);
    byInvestor.get(k).push(r);
  }
  const out = [];
  for (const [, group] of byInvestor) {
    if (group.length < 2) continue;
    const [a, ...rest] = group;
    for (const b of rest) {
      const differences = [];
      if (a.digest.eligible !== b.digest.eligible) differences.push(`they take a different number of loans: ${a.digest.eligible} vs ${b.digest.eligible}`);
      const codes = [...new Set([...Object.keys(a.digest.declineCodeCounts), ...Object.keys(b.digest.declineCodeCounts)])].sort();
      for (const c of codes) {
        const x = a.digest.declineCodeCounts[c] || 0;
        const y = b.digest.declineCodeCounts[c] || 0;
        if (x !== y) differences.push(`${c}: ${n(x)} loans vs ${n(y)}`);
      }
      out.push({ investor: a.investor, left: a.source, right: b.source, agree: differences.length === 0, differences });
    }
  }
  return out;
}

// ---- the verdict -----------------------------------------------------------------------------------

/**
 * What the run means, and what it must exit with. PURE.
 *
 * THE ONE HARD RULE, and it is the reason this function exists at all: a run that MEASURED NOTHING can
 * never be reported as clear. No programs in the catalog, no scenarios in the battery, or a program
 * whose rules could not be enumerated at all are each a FAILURE — the audit did not do its job, which
 * is a completely different thing from doing its job and finding nothing wrong. This repository has
 * repeatedly found runners that reported green having measured nothing; a green run and an empty run
 * are indistinguishable to a reader unless the runner itself refuses.
 *
 * `strict` additionally exits 1 while a dead-rule QUESTION is open. It is off by default on purpose: a
 * never-fired rule is a question for a person, and turning a question into a build failure on the way
 * in is how a check gets switched off.
 */
function verdictOf(report, opts = {}) {
  const reasons = [];       // each one means the run did NOT do its job
  const limitations = [];   // each one narrows what the run can be read to say
  const programs = (report && report.programs) || [];

  if (!report || !report.programsAudited) reasons.push('NOTHING WAS AUDITED — the program catalog came back empty, so this run proves nothing.');
  if (!report || !report.scenariosAudited) reasons.push('NOTHING WAS MEASURED — the scenario battery is empty, so every rule would look dead and none of it would mean anything.');
  if (report && report.battery && report.battery.truncated) reasons.push('THE BATTERY WAS CUT SHORT — a strided battery can skip the very loan that arms a rule, so no never-fired verdict from this run can be trusted.');
  for (const p of programs) {
    if (!p.digest || !p.digest.total) reasons.push(`${p.programName} (${p.source}) was handed no scenarios.`);
  }
  // Enumerability is what makes a dead-rule verdict possible at all. NO program being enumerable means
  // the run cannot answer the question it exists for — a failure. SOME being enumerable is a narrower
  // reading, reported as a limitation rather than pretended away.
  if (programs.length && programs.every((p) => !p.anyEnumerable)) {
    reasons.push('NO PROGRAM IN THE CATALOG PUBLISHES A RULE CATALOG — nothing here can tell a dead rule from a quiet one, so this run cannot answer the question it exists for.');
  }
  for (const p of programs) {
    if (!p.anyEnumerable) limitations.push(`${p.programName} (${p.source}) publishes no rule catalog, so NONE of its rules could be checked for being dead.`);
    else for (const ne of p.notEnumerable) limitations.push(`${p.programName} (${p.source}): ${ne.label} could not be listed — ${ne.why}`);
  }

  const questions = programs.reduce((n, p) => n + p.questions.length, 0);
  const untested = programs.reduce((n, p) => n + p.untested.length, 0);
  const cannotTell = programs.reduce((n, p) => n + p.cannotTell.length, 0);
  const checked = programs.reduce((n, p) => n + p.declaredCodeCount, 0);

  const measured = reasons.length === 0;
  const headline = !measured
    ? 'THIS RUN DID NOT MEASURE WHAT IT CLAIMS TO — see the reasons below. It is not an all-clear.'
    : questions
      ? `${questions} rule(s) never fired even though this battery exercised every condition they need — a question for a person, not a verdict.`
      : untested
        ? `Every rule this battery reached did fire. ${untested} rule(s) were never tried by it — widen the battery before reading anything into their silence.`
        : `All ${n(checked)} rule(s) the catalog publishes fired at least once across ${n(report.scenariosAudited)} loans. Nothing enumerable looks dead.${limitations.length ? ' Read that alongside the limitations below.' : ''}`;

  return {
    ok: measured && questions === 0,
    measured,
    headline,
    reasons,
    limitations,
    counts: { questions, untested, cannotTell, rulesChecked: checked },
    exitCode: (!measured || (opts.strict && questions > 0)) ? 1 : 0,
  };
}

// ---- the report ------------------------------------------------------------------------------------

const n = (x) => Number(x || 0).toLocaleString('en-US');
const pctOf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

function renderReport(report, verdict) {
  const L = [];
  L.push('LONG-TERM PPE — INVESTOR PROGRAM AUDIT');
  L.push('='.repeat(78));
  L.push('');
  L.push(`Programs audited : ${report.programsAudited}`);
  L.push(`Loan scenarios   : ${n(report.scenariosAudited)}${report.battery.truncated ? '   ** CUT SHORT — see below **' : ''}`);
  L.push('');
  L.push('The battery (each block is a COMPLETE set of combinations, nothing sampled):');
  for (const leg of report.battery.legs) {
    L.push(`  · ${leg.name.padEnd(28)} ${String(n(leg.size)).padStart(9)} loans   ${leg.truncated ? '** CUT SHORT **' : ''}`);
    L.push(`      ${leg.why}`);
  }
  L.push('');
  L.push('-'.repeat(78));
  L.push(`WHAT IT FOUND: ${verdict.headline}`);
  for (const r of verdict.reasons) L.push(`  !! ${r}`);
  if (verdict.limitations.length) {
    L.push('');
    L.push('  WHAT THIS RUN CANNOT SAY (read every answer below alongside these):');
    for (const r of verdict.limitations) L.push(`    · ${r}`);
  }
  L.push('-'.repeat(78));

  for (const p of report.programs) {
    const d = p.digest;
    L.push('');
    L.push(`PROGRAM: ${p.programName}   (investor: ${p.investor})`);
    L.push(`  where it comes from : ${p.source} — ${p.sourceModule}`);
    if (p.dataVersions) L.push(`  rule book version   : eligibility ${p.dataVersions.eligibility}, prepayment ${p.dataVersions.ppp}`);
    L.push('');
    L.push(`  Of ${n(d.total)} loans, it would take ${n(d.eligible)} (${pctOf(d.eligible, d.total)}) and turn away ${n(d.ineligible)} (${pctOf(d.ineligible, d.total)}).`);
    L.push('');
    L.push('  WHICH PART OF THE RULE BOOK SAID NO (loans affected — one loan can hit more than one):');
    for (const [layer, label] of Object.entries(LAYER_LABEL)) {
      const key = layer === 'eligibility' ? 'eligibility_matrix' : layer === 'ppp' ? 'ppp_matrix' : 'overlay';
      L.push(`    ${label.padEnd(32)} ${String(n(d.layerHitCounts[key])).padStart(9)}`);
    }
    L.push('');
    const declaredFired = p.firedCodes.length - p.observedUndeclared.length;
    L.push(`  RULES THAT FIRED — ${p.firedCodes.length} in all, of which ${declaredFired} are among the ${p.declaredCodeCount} this program publishes:`);
    if (!p.firedCodes.length) L.push('    (none — every single loan passed every rule, which on a battery this size is itself worth a look)');
    for (const f of p.firedCodes.slice(0, 40)) {
      L.push(`    ${f.key.padEnd(34)} ${String(n(f.count)).padStart(9)}`);
    }
    if (p.firedCodes.length > 40) L.push(`    … and ${p.firedCodes.length - 40} more`);
    if (p.observedUndeclared.length) {
      L.push('');
      L.push(`    ${p.observedUndeclared.length} of those fired but appear in NO rule catalog this command can read, so`);
      L.push('    this audit cannot say whether the layer they came from has other rules that are dead:');
      for (const c of p.observedUndeclared) L.push(`      ${c}`);
    }

    L.push('');
    L.push('  RULES THAT NEVER FIRED — A QUESTION, NOT A VERDICT:');
    if (!p.declaredCodeCount) {
      L.push('    Unanswerable for this program: it publishes no rule catalog, so there is no list of rules');
      L.push('    to hold the run against. Its silence about a dead rule means nothing at all.');
    } else if (!p.findings.length) {
      L.push(`    None. All ${p.declaredCodeCount} rules this program publishes turned at least one loan away.`);
    }
    if (p.questions.length) {
      L.push('');
      L.push(`    (a) THE BATTERY TRIED IT AND IT NEVER FIRED — ${p.questions.length}. Every condition these rules`);
      L.push('        need was met somewhere in the battery, yet the rule itself never triggered. That is what');
      L.push('        a mis-encoded rule looks like. Somebody should read these against the investor sheet.');
      for (const f of p.questions) {
        L.push(`          ${f.code}  (${f.layerLabel})`);
        if (f.declineReason) L.push(`              would say: ${f.declineReason}`);
      }
    }
    if (p.untested.length) {
      L.push('');
      L.push(`    (b) THE BATTERY NEVER TRIED IT — ${p.untested.length}. Nothing is known about these either way:`);
      L.push('        no loan in this battery meets the rule\'s own trigger, so its silence says nothing about');
      L.push('        the rule. Add the value named below to the battery and run this again.');
      for (const f of p.untested) {
        L.push(`          ${f.code}  (${f.layerLabel})`);
        if (f.declineReason) L.push(`              would say: ${f.declineReason}`);
        for (const u of f.untried || []) {
          L.push(`              never tried: ${u.neverTried.join('  AND  ')}`);
        }
      }
    }
    if (p.cannotTell.length) {
      L.push('');
      L.push(`    (c) CANNOT TELL — ${p.cannotTell.length}. These two cases could not be told apart:`);
      for (const f of p.cannotTell) L.push(`          ${f.code}  (${f.layerLabel}) — ${f.because}`);
    }

    if (p.overlaysArmed.length) {
      L.push('');
      L.push('  INVESTOR OVERLAYS THAT ARMED (loans where the extra rule set applied):');
      for (const o of p.overlaysArmed) L.push(`    ${o.key.padEnd(34)} ${String(n(o.count)).padStart(9)}`);
    }
    if (p.stillFlagged.length) {
      L.push('');
      L.push('  RULES WE KNOW BUT CANNOT APPLY — flagged for a human on every loan below.');
      L.push('  (the investor sheet says something we could not turn into a number without guessing)');
      for (const o of p.stillFlagged) L.push(`    ${String(n(o.count)).padStart(9)}  ${o.key}`);
    }
    if (p.stillUnverifiable.length) {
      L.push('');
      L.push('  RULES NOTHING IN THE SYSTEM CAN CHECK — no layer carries the fact they need:');
      for (const o of p.stillUnverifiable) L.push(`    ${String(n(o.count)).padStart(9)}  ${o.key}`);
    }
    if (p.notEnumerable.length) {
      L.push('');
      L.push('  WHAT THIS AUDIT COULD NOT LIST FOR THIS PROGRAM:');
      for (const ne of p.notEnumerable) L.push(`    ${ne.label} — ${ne.why}`);
    }
  }

  if (report.crossChecks && report.crossChecks.length) {
    L.push('');
    L.push('-'.repeat(78));
    L.push('THE SAME INVESTOR, ENCODED TWICE — DO THE TWO AGREE?');
    for (const c of report.crossChecks) {
      L.push('');
      L.push(`  ${c.investor}: "${c.left}" against "${c.right}"`);
      if (c.agree) L.push(`    They agree on every one of the ${n(report.scenariosAudited)} loans — same answers, same rules fired, same number of times.`);
      else {
        L.push('    THEY DISAGREE. One of the two has drifted from the other; that is a defect, not a question:');
        for (const d of c.differences.slice(0, 20)) L.push(`      ${d}`);
        if (c.differences.length > 20) L.push(`      … and ${c.differences.length - 20} more`);
      }
    }
  }

  L.push('');
  L.push('='.repeat(78));
  L.push('WHAT ALL OF THIS MEANS, IN PLAIN WORDS');
  L.push('');
  L.push('  This ran a long list of made-up loans through each investor program we have encoded and');
  L.push('  wrote down what the system decided. It is not a test of whether the answers are RIGHT — it');
  L.push('  is a check that every rule we wrote down is capable of doing something at all.');
  L.push('');
  L.push('  A rule that never fires once across tens of thousands of loans is either a rule that was');
  L.push('  written down wrong and can never apply — in which case the investor\'s requirement is');
  L.push('  quietly not being enforced — or a rule this list of loans simply never asked about. Those');
  L.push('  are very different problems, so this report never merges them: (a) above is a real question,');
  L.push('  (b) is a gap in the list of loans, and (c) is where it honestly could not tell.');
  L.push('');
  L.push('  It also cannot see everything. The overlay layer is written as code rather than as a rule');
  L.push('  sheet, so its rules are counted here but cannot be checked for completeness — if one of');
  L.push('  those is dead, this report would not know, and it does not pretend otherwise.');
  L.push('='.repeat(78));
  return L.join('\n');
}

// ---- main ------------------------------------------------------------------------------------------

function main(argv = process.argv.slice(2)) {
  const strict = argv.includes('--strict') || process.env.LT_PROGRAM_AUDIT_STRICT === '1';
  const asJson = argv.includes('--json');

  const battery = buildBattery();
  const programs = catalogPrograms();
  const report = auditCatalog(programs, battery);
  const verdict = verdictOf(report, { strict });
  report.verdict = verdict;

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report, verdict));

  process.exit(verdict.exitCode);
}

if (require.main === module) main();

module.exports = {
  LEGS,
  buildBattery,
  catalogPrograms,
  declaredCodes,
  layerCatalog,
  leavesOf,
  describeLeaf,
  classifyNeverFired,
  auditCatalog,
  crossCheck,
  verdictOf,
  renderReport,
  main,
  _internals: { factViewFor, ranked, LAYER_LABEL },
};
