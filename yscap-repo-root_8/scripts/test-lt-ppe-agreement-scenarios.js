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

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
