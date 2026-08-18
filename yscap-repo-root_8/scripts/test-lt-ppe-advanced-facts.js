#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the ADVANCED-FACTS REGISTRY (advanced-facts.js). Proves the data-driven registry of the
 * overlay facts the Advanced search section exposes (vacant/leased, rural, STR, FTI, FTHB, foreign
 * national, declining market, renovation), and — the load-bearing guard — that every registry fact is
 * tied to a REAL matrix overlay (deephaven-matrix's `unverifiable[]`) so the two can never drift.
 * LT-only, pure, offline.
 */
const AF = require('../src/longterm/ppe/advanced-facts');
const { evaluateEligibility } = require('../src/longterm/ppe/deephaven-matrix');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — advanced-facts registry\n');

// ── the registry is complete + well-formed ────────────────────────────────────────────────────────
ok(Array.isArray(AF.ADVANCED_FACTS) && AF.ADVANCED_FACTS.length >= 8, 'registry carries the advanced overlay facts');
for (const f of AF.ADVANCED_FACTS) {
  const okShape = f.key && f.label && f.type && f.category && f.effect && f.matrixMatch
    && (f.type !== 'enum' || (Array.isArray(f.enumValues) && f.enumValues.length))
    && typeof f.overlayOnly === 'boolean'
    // `lpPrices` is a MEASUREMENT, so its only honest values are true (a probe itemized a charge) and
    // null (nobody has asked). A bare `false` would re-assert what the old single flag wrongly claimed.
    && (f.lpPrices === true || f.lpPrices === null);
  if (!okShape) ok(false, `fact ${f && f.key} is well-formed`);
}
ok(true, 'every advanced fact is well-formed');
ok(new Set(AF.advancedFactKeys()).size === AF.advancedFactKeys().length, 'fact keys are unique');

// ── the owner's named advanced options are present ────────────────────────────────────────────────
for (const k of ['occupancy', 'rural_property', 'short_term_rental', 'first_time_investor', 'first_time_homebuyer', 'foreign_national', 'declining_market', 'renovation']) {
  ok(!!AF.getAdvancedFact(k), `has advanced fact ${k}`);
}
ok(AF.getAdvancedFact('nope') === null, 'an unknown key → null (never throws)');

// ── D27: occupancy is vacant/leased ───────────────────────────────────────────────────────────────
{
  const occ = AF.getAdvancedFact('occupancy');
  ok(occ.type === 'enum' && occ.enumValues.includes('vacant') && occ.enumValues.includes('leased') && occ.default === 'leased',
    'occupancy is an enum of leased/vacant, defaulting to leased (a performing rental)');
}

// ── every advanced fact is OVERLAY-ONLY (our matrix enforces its cuts itself) ─────────────────────
ok(AF.ADVANCED_FACTS.every((f) => f.overlayOnly === true), 'every advanced fact is overlay-only — the class we override LP on, with a stated reason');
ok(AF.overlayOnlyKeys().length === AF.ADVANCED_FACTS.length, 'overlayOnlyKeys() returns them all');
// …and that says NOTHING about the price side, which is the separate measured flag (task #82).
ok(AF.lpPricedKeys().includes('short_term_rental'),
  'short-term rental is recorded as MEASURED-priced by Lender Price, while still being overlay-only');
ok(AF.lpPricedKeys().length < AF.ADVANCED_FACTS.length,
  'the priced set is a floor, not the whole registry — an unprobed fact is absent because it is unknown');
ok(AF.isAdvancedFact('rural_property') && !AF.isAdvancedFact('fico') && !AF.isAdvancedFact('ltv'),
  'isAdvancedFact separates advanced facts from the basic LP-priced ones (fico/ltv)');

// ── the UI shape renders from the registry (searchable/extensible) ────────────────────────────────
{
  const sec = AF.advancedSection();
  ok(sec.length === AF.ADVANCED_FACTS.length && sec.every((s) => s.key && s.label && s.effect), 'advancedSection() renders every fact with a label + effect');
}

// ── DRIFT GUARD: every registry fact ties to a REAL matrix overlay, and every matrix overlay is in
//    the registry — so the Advanced section and the matrix can never diverge ────────────────────────
{
  // Pull the live matrix overlay strings (unverifiable[]) from a scenario that triggers them all.
  const overlays = evaluateEligibility({ fico: 760, ltv: 60000, dscr: 1250, loan_amount: 400000, value: 666666, purpose: 'purchase', units: 1, state: 'CA' }).unverifiable.map((u) => u.overlay);
  // (1) every registry fact's matrixMatch is found in a real matrix overlay.
  let unmatched = 0;
  for (const f of AF.ADVANCED_FACTS) {
    if (!overlays.some((o) => o.includes(f.matrixMatch))) { unmatched += 1; console.log('    (no matrix overlay for ' + f.key + ' / "' + f.matrixMatch + '")'); }
  }
  ok(unmatched === 0, 'every advanced fact is tied to a real matrix overlay (registry ⊆ matrix)');
  // (2) every matrix overlay is ACCOUNTED FOR — either an advanced-toggle fact in the registry, OR
  //     explicitly handled elsewhere (geo overlays are ADDRESS-derived, not user toggles; the <$100k
  //     delegate overlay is loan-size-derived → the informational layer). Nothing is silently dropped.
  const HANDLED_ELSEWHERE = [
    { match: 'Philadelphia', where: 'address/geo overlay (derived from the property city — not a user toggle)' },
    { match: 'Ineligible geos', where: 'address/geo overlay (derived from the property location)' },
    { match: 'Loan < $100,000', where: 'informational.js delegate exception (loan-size-derived, not a toggle)' },
  ];
  let missing = 0;
  for (const o of overlays) {
    const inRegistry = AF.ADVANCED_FACTS.some((f) => o.includes(f.matrixMatch));
    const elsewhere = HANDLED_ELSEWHERE.some((h) => o.includes(h.match));
    if (!inRegistry && !elsewhere) { missing += 1; console.log('    (matrix overlay unaccounted for: "' + o.slice(0, 50) + '…")'); }
  }
  ok(missing === 0, 'every matrix overlay is accounted for (an advanced fact OR explicitly handled elsewhere) — no silent drift');
  // the effect strings are transcribed verbatim from the matrix.
  for (const f of AF.ADVANCED_FACTS) {
    if (!overlays.includes(f.effect)) { ok(false, `effect for ${f.key} is verbatim from the matrix`); }
  }
  ok(true, 'every advanced fact effect is the matrix overlay string verbatim');
}

// ── advancedFactsFromScenario: registry-driven reader with type + default handling ────────────────
{
  const all = AF.advancedFactsFromScenario({ occupancy: 'vacant', rural_property: true, short_term_rental: 1 });
  ok(all.occupancy === 'vacant' && all.rural_property === true && all.short_term_rental === true, 'reads occupancy + booleans (coerced) from a scenario');
  const def = AF.advancedFactsFromScenario({});
  ok(def.occupancy === 'leased' && def.rural_property === false && def.foreign_national === false, 'omitted facts take their registry defaults (leased / false)');
  const bad = AF.advancedFactsFromScenario({ occupancy: 'garbage' });
  ok(bad.occupancy === 'leased', 'an invalid enum value falls back to the default (never sneaks through)');
  // every registry fact is present in the output.
  ok(AF.advancedFactKeys().every((k) => k in def), 'the reader returns every registry fact (registry-driven)');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
