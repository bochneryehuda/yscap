#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the canonical ≥200-scenario agreement battery (agreement-scenarios.js), pure/offline.
 * Proves the battery meets the owner's ≥200 bar, covers every LLPA angle (grouped), carries valid
 * Lender Price scenario shapes (a sample is run through the REAL search-model.validateScenario so a
 * scenario that LP would reject can never sit silently in the battery), flags the ineligible probes,
 * and honours the include filter.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const sm = require('../src/longterm/lenderprice/search-model');
const registry = require('../src/longterm/lenderprice/field-registry');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — canonical agreement scenario battery\n');

const { scenarios, count, byGroup } = buildAgreementScenarios();

// ---- 1) the ≥200 bar + group coverage ----------------------------------------------------------
ok(count >= 200, `battery has ≥200 scenarios (${count})`);
ok(count === scenarios.length, 'count matches the array length');
const expectGroups = ['ficoxcltv', 'dscrxcltv', 'purpose', 'loansize', 'property', 'prepay', 'flags', 'state',
  // the deep-verification angles added when the battery grew from 225 → 299 (2026-08-17): the advanced
  // overlay facts, borrower_type/PPP-by-state, the standard PPP structure library, and the T1/T2/T3
  // eligibility grid cells — every one a distinct pricing/eligibility angle.
  'advanced', 'borrower', 'pppstruct', 'eliggrid', 'ineligible'];
ok(expectGroups.every((g) => byGroup[g] > 0), `every LLPA angle is covered: ${JSON.stringify(byGroup)}`);
ok(byGroup.ficoxcltv === 126, 'FICO×CLTV swept at both DSCR bands (9×7×2 = 126)');
ok(byGroup.dscrxcltv === 63, 'DSCR×CLTV swept (9×7 = 63)');
ok(byGroup.ineligible === 10, 'ten ineligible probes');

// ---- 2) every scenario is a well-formed LP scenario --------------------------------------------
ok(scenarios.every((s) => s._label && s._group), 'every scenario carries a _label and _group');
ok(scenarios.every((s) => s.purpose && Number(s.value) > 0 && Number(s.loan) > 0), 'every scenario has purpose + a positive value + loan (the amount triangle)');
ok(scenarios.every((s) => Number(s.fico) > 0 && Number(s.dscr) > 0), 'every scenario has a FICO and a DSCR');
ok(scenarios.every((s) => s.state && s.zip && s.countyFps), 'every scenario carries a known-good address (state/zip/county — no enrichment in the hot path)');

// ---- 3) the ineligible probes are flagged ------------------------------------------------------
const inelig = scenarios.filter((s) => s._group === 'ineligible');
ok(inelig.length === 10 && inelig.every((s) => s._ineligible === true), 'every ineligible probe is flagged _ineligible');
ok(scenarios.filter((s) => s._group !== 'ineligible').every((s) => !s._ineligible), 'no priced scenario is flagged ineligible');

// ---- 4) EVERY scenario validates against the real Lender Price scenario contract ----------------
// Strip our internal keys before handing it to the validator; a LP-invalid scenario must never hide
// in the battery (it would fail the live run with a client-side scenario error, not a real
// disagreement — which is exactly how the live battery caught the TwoToFourUnit / NJ-county bugs).
const strip = (s) => { const o = { ...s }; delete o._label; delete o._group; delete o._ineligible; return o; };
const bad = [];
for (const s of scenarios) {
  const v = sm.validateScenario(strip(s));
  if (!v || v.ok !== true) bad.push(`${s._label}: ${v && (v.error || v.message)}`);
}
ok(bad.length === 0, `all ${scenarios.length} scenarios pass the real LP scenario contract${bad.length ? ' — ' + bad.slice(0, 5).join(' | ') : ''}`);

// ---- 5) the include filter narrows to the requested groups -------------------------------------
const onlyState = buildAgreementScenarios({ include: ['state'] });
ok(onlyState.count === byGroup.state && onlyState.scenarios.every((s) => s._group === 'state'), 'include:["state"] returns only the state sweep');
const two = buildAgreementScenarios({ include: ['ineligible', 'flags'] });
ok(two.count === byGroup.ineligible + byGroup.flags, 'include with two groups returns exactly their union');

// ---- 6) THE STRUCTURE AXIS IS ACTUALLY SWEPT (§2.94) ---------------------------------------------
// ⛔ THE GROUP WAS NAMED `pppstruct` AND SWEPT ONLY THE TERM. All eight of its scenarios varied
// `prepayMonths`; not one carried a `prepayStructure`. The name promised a structure sweep and the data
// delivered a term sweep, so the axis read as covered and was never exercised — which is why the §2.85
// defect (every structure transmitted as a 60-month term) survived to be found by hand. This asserts
// the DATA, not the name.
{
  const ppp = scenarios.filter((x) => x._group === 'pppstruct');
  const withStructure = ppp.filter((x) => x.prepayStructure != null);
  const withTerm = ppp.filter((x) => x.prepayStructure == null && x.prepayMonths != null);
  ok(withStructure.length >= 7, `the pppstruct group sweeps ${withStructure.length} prepay STRUCTURES (it swept 0)`);
  ok(withTerm.length >= 6, `…and still sweeps ${withTerm.length} prepay TERMS — the term axis was real and is kept`);
  // Distinct plan types, or the "sweep" is one value repeated.
  const plans = new Set(withStructure.map((x) => registry.mapPrepayStructure(x.prepayStructure)));
  ok(plans.size === withStructure.length, `every structure resolves to a DISTINCT plan type (${plans.size})`);
  // ⛔ THE STRUCTURES MUST REACH THE WIRE WITH THEIR OWN TERM. Asserted through the real builder, so
  // this fails if §2.85 is ever undone — the battery is the thing that should have caught it.
  const terms = new Set();
  for (const x of withStructure) {
    const body = sm.buildSearch(strip(x));
    const dyn = body.dynamicPropertiesMap || {};
    const term = dyn.PrepayTerm && dyn.PrepayTerm.value;
    const plan = dyn.PrePayment_Plan_Type && dyn.PrePayment_Plan_Type.value;
    terms.add(term);
    ok(plan != null && plan !== 'Standard', `${x._label}: the structure reaches the wire as plan ${JSON.stringify(plan)}`);
  }
  ok(terms.size >= 4,
    `…and the derived TERMS actually differ across them (${[...terms].sort().join(', ')}) — one repeated term would mean the structures are not carrying their own length`);
  // The control: a plan type that cannot derive a term must be supplied one, and must not invent it.
  const ctrl = ppp.find((x) => x.prepayStructure === '6 Months Interest');
  ok(!!ctrl && ctrl.prepayMonths != null,
    'the un-derivable plan type is included WITH an explicit term — the case where a structure names no length');
}

// ---- 7) NO SCENARIO PAYS TWICE FOR THE SAME ANSWER ----------------------------------------------
// ⛔ TWO SCENARIOS THAT BUILD A BYTE-IDENTICAL REQUEST ARE ONE PAID VENDOR CALL WASTED. That is how
// the two `ppp_structure_key` scenarios sat here: the key is not a vendor field AND `lpScenarioToFacts`
// drops it AND no program carries a rule keyed on it, so both were byte-identical to `ppp 5yr` and
// `ppp 4yr` — two paid calls per run, under a comment claiming they exercised a margin-holdback
// overlay. This counts the duplicates and pins the number, so the count cannot grow unnoticed.
{
  const seen = new Map(); const dups = [];
  for (const x of scenarios) {
    const body = JSON.stringify(sm.buildSearch(strip(x))).replace(/"date":"[^"]*"/, '');
    if (seen.has(body)) dups.push(`${x._label} == ${seen.get(body)}`); else seen.set(body, x._label);
  }
  // The 32 that remain are a MEASURED, pre-existing overlap between the FICO×CLTV and DSCR×CLTV
  // sweeps at FICO 760 — the two groups ask different QUESTIONS of the same request, so the vendor's
  // answer is identical and the second call learns nothing. Recorded, not silently accepted: the
  // number is pinned so it cannot creep, and deduplicating them is its own item (they are attributed
  // to two groups in the report, so collapsing them changes what each group claims to cover).
  // ⛔ 32 -> 29 WHEN §2.96 BRIDGED THREE DROPPED FIELDS, THEN 29 -> 28 WHEN §2.97 BRIDGED A FOURTH.
  // `rural_property`, `first_time_investor`, `first_time_homebuyer` and then `foreign_national` were
  // accepted and never transmitted, so the advanced scenarios that set them sent a request
  // byte-identical to the plain baseline — they were duplicates BECAUSE the fields were dropped, and
  // we paid for a call that could not measure the thing it named. Bridging turns each wasted call into
  // a real measurement, and this pinned number going red is how each was noticed rather than assumed.
  ok(dups.length === 28,
    `${dups.length} scenario pairs build a byte-identical request — pinned so the count cannot creep`);
  // Three advanced scenarios are STILL duplicates, and each is one whose field is recorded as
  // not-transmitted in `test-lt-ppe-field-reaches-wire.js` — a DECISION (`occupancy`), a MEASURED
  // INERT vendor field (`declining_market`) and an OPEN GAP with no vendor field to bridge to
  // (`renovation`). So this list and that record move together, and unlike the four before them none
  // of these is expected to fall off by being bridged.
  const stillDup = dups.filter((d) => /occupancy vacant|declining market|renovation/.test(d));
  ok(stillDup.length === 3,
    `the three remaining advanced duplicates are exactly the not-transmitted fields: ${stillDup.join(' | ')}`);
  // ⛔ ONE OF THE 32 IS A PREPAY SCENARIO, AND IT IS NOT ONE OF THE TWO REMOVED. `ppp 5yr` builds the
  // same body as `state CA`, because 60 months IS the profile default — so a scenario labelled "5yr
  // prepay" transmits exactly what a scenario that never mentions prepay transmits. It measures the
  // default, not the term. Pre-existing, named here rather than left inside a count, because a reader
  // seeing "6 prepay TERMS swept" above should know one of them is the default in disguise.
  const prepayDups = dups.filter((d) => /ppp |structure /.test(d));
  ok(prepayDups.length === 1 && /ppp 5yr/.test(prepayDups[0]),
    `exactly one prepay scenario is a duplicate, and it is the default-in-disguise: ${prepayDups[0]}`);
  // The two INERT ones are gone: neither remaining duplicate involves a structure scenario.
  ok(!dups.some((d) => /structure /.test(d)),
    'no STRUCTURE scenario is a duplicate — the two inert ppp_structure_key ones that were are gone');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
