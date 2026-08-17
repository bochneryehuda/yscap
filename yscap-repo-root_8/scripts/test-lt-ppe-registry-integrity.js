#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE REGISTRY INTEGRITY BAR (the gate that makes "add the second investor" safe; PPE #47).
 *
 * The whole scalable-PPE promise is: adding investor #2 is a new program DESCRIPTOR + one line in
 * `program-registry.js`, and nothing in the pricing pipeline changes. That promise is only safe if EVERY
 * program in the catalog is held to the SAME integrity bar automatically — otherwise the day someone
 * registers a malformed or half-wired descriptor, it prices live and nobody finds out until a quote is
 * wrong. This suite is that bar. It does NOT re-test Deephaven's specific rules (the per-layer suites do
 * that); it asserts, GENERICALLY over `program-registry.listPrograms()`, that whatever is registered:
 *
 *   1. VALIDATES — every descriptor passes `assertDescriptor` (every REQUIRED_SLOT present + typed), so a
 *      descriptor missing a layer function fails the build here instead of throwing at pricing time.
 *   2. RESOLVES BY EVERY NAME — `programFor(investor)` returns the descriptor, and an unknown investor
 *      returns null (never a silent default — the registry's stated contract).
 *   3. PRODUCES A WELL-FORMED VERDICT for every scenario in a broad battery — the RESULT-SHAPE invariants
 *      the pipeline downstream relies on: `eligible` is a boolean and equals `reasons.length === 0`
 *      (the engine's own definition), every reason is labelled with a KNOWN layer + a code, the overlay
 *      block is present with its three arrays, and `unverifiableReconciled` is present with its two.
 *   4. IS AUDITABLE — `auditProgram` over the same battery yields a digest whose arithmetic closes
 *      (eligible + ineligible === total) and whose layer-hit counts never exceed the scenario count.
 *
 * A new investor's descriptor gets all four checks for free the moment it is registered. Nothing here is
 * Deephaven-specific: it discovers programs from the registry, so it grows with the catalog.
 *
 * PURE. No DB, no network, no clock. LT-only; no RTL import.
 */
const registry = require('../src/longterm/ppe/program-registry');
const { assertDescriptor, REQUIRED_SLOTS } = require('../src/longterm/ppe/program-engine');
const { auditProgram } = require('../src/longterm/ppe/program-audit');
const { buildMatrix } = require('../src/longterm/ppe/scenario-matrix');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

const LAYERS = new Set(['eligibility_matrix', 'ppp_matrix', 'overlay']);
const ltv = (pct) => pct * 1000;

console.log('LT PPE — registry integrity bar\n');

// A broad, layer-exercising battery every program is run against. It is investor-agnostic engine facts,
// spanning the eligibility grid axes, a PPP-capable state/borrower/prepay combo, and the overlay facts —
// so a program that wires any of the three layers is actually exercised, not just its happy path.
const { scenarios } = buildMatrix({
  fico: [640, 680, 720, 760],
  ltv: [ltv(60), ltv(70), ltv(75), ltv(80)],
  dscr: [700, 1000, 1150, 1300],
  loan_amount: [60000, 200000, 400000, 2600000],
  units: [1, 2],
  purpose: ['purchase', 'cashout'],
  state: ['NY', 'NJ'],
  borrower_type: ['LLC', 'individual'],
  prepay_requested: [false, true],
  short_term_rental: [false, true],
  foreign_national: [false, true],
}, { base: { apr: 8 }, maxScenarios: 20000 });

const programs = registry.listPrograms();
ok(programs.length >= 1, `the registry catalogs ${programs.length} program(s)`);

// The registry contract: an unknown investor is null, never a silent default.
ok(registry.programFor('no-such-investor-xyz') === null, 'programFor(unknown) is null — no silent default program');
ok(registry.evaluateProgramFor('no-such-investor-xyz', {}) === null, 'evaluateProgramFor(unknown) is null — the caller decides, never a default verdict');

for (const p of programs) {
  const label = `${p.investor} / ${p.programName}`;
  ok(p.investor && p.programName, `[${label}] catalog entry names both investor and program`);

  const desc = registry.programFor(p.investor);
  ok(desc, `[${label}] programFor(investor) resolves the descriptor`);
  if (!desc) continue;

  // 1) VALIDATES — assertDescriptor throws on a missing/wrong slot; catch it as a failure, not a crash.
  let validated = true; let vErr = '';
  try { assertDescriptor(desc); } catch (e) { validated = false; vErr = e.message; }
  ok(validated, `[${label}] descriptor passes assertDescriptor (all ${REQUIRED_SLOTS.length} slots present + typed)` + (validated ? '' : `\n        ${vErr}`));

  // 2) PRODUCES A WELL-FORMED VERDICT for every scenario in the battery.
  let shapeBad = null; let eligN = 0; let ineligN = 0;
  for (let i = 0; i < scenarios.length && !shapeBad; i += 1) {
    const facts = scenarios[i];
    const r = registry.evaluateProgramFor(p.investor, facts, {});
    const why = verdictShapeProblem(r);
    if (why) { shapeBad = `scenario ${i} (${JSON.stringify(facts)}): ${why}`; break; }
    if (r.eligible) eligN += 1; else ineligN += 1;
  }
  ok(shapeBad === null, `[${label}] every one of ${scenarios.length} scenarios returns a well-formed verdict (eligible⇔no reasons, known layers, overlay + reconciled blocks)` + (shapeBad ? `\n        ${shapeBad}` : ''));
  ok(eligN > 0 && ineligN > 0, `[${label}] the battery exercises BOTH verdicts (${eligN} eligible / ${ineligN} ineligible) — a program that can only pass or only fail is not being tested`);

  // 3) IS AUDITABLE — the digest arithmetic closes and the per-scenario counts never exceed the total.
  const d = auditProgram(desc, scenarios);
  ok(d.total === scenarios.length && d.eligible + d.ineligible === d.total, `[${label}] audit digest totals close (eligible ${d.eligible} + ineligible ${d.ineligible} = total ${d.total})`);
  const overCounted = Object.entries(d.layerHitCounts).find(([, n]) => n > d.total);
  ok(!overCounted, `[${label}] no layer is counted more than once per scenario` + (overCounted ? `\n        ${overCounted[0]} hit ${overCounted[1]} > ${d.total}` : ''));
  const badCode = Object.keys(d.declineCodeCounts).find((c) => !c || typeof c !== 'string');
  ok(!badCode, `[${label}] every tallied decline code is a real string key`);
}

// The verdict-shape contract every registered program must satisfy. Returns a reason string, or null.
function verdictShapeProblem(r) {
  if (!r || typeof r !== 'object') return 'no result object';
  if (typeof r.eligible !== 'boolean') return '`eligible` is not a boolean';
  if (!Array.isArray(r.reasons)) return '`reasons` is not an array';
  if (r.eligible !== (r.reasons.length === 0)) return `eligible=${r.eligible} but reasons.length=${r.reasons.length} (the engine defines eligible as no reasons)`;
  for (const x of r.reasons) {
    if (!x || !LAYERS.has(x.layer)) return `a reason has an unknown layer: ${x && x.layer}`;
    if (!x.code) return 'a reason carries no code';
  }
  const o = r.overlay;
  if (!o || !Array.isArray(o.declines) || !Array.isArray(o.enforced) || !Array.isArray(o.stillFlagged)) return 'overlay block missing its three arrays';
  const rc = r.unverifiableReconciled;
  if (!rc || !Array.isArray(rc.handledByOverlay) || !Array.isArray(rc.stillUnverifiable)) return 'unverifiableReconciled missing its two arrays';
  return null;
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
