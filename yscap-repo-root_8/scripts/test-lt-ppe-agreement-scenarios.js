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
const expectGroups = ['ficoxcltv', 'dscrxcltv', 'purpose', 'loansize', 'property', 'prepay', 'flags', 'state', 'ineligible'];
ok(expectGroups.every((g) => byGroup[g] > 0), `every LLPA angle is covered: ${JSON.stringify(byGroup)}`);
ok(byGroup.ficoxcltv === 126, 'FICO×CLTV swept at both DSCR bands (9×7×2 = 126)');
ok(byGroup.dscrxcltv === 63, 'DSCR×CLTV swept (9×7 = 63)');
ok(byGroup.ineligible === 6, 'six ineligible probes');

// ---- 2) every scenario is a well-formed LP scenario --------------------------------------------
ok(scenarios.every((s) => s._label && s._group), 'every scenario carries a _label and _group');
ok(scenarios.every((s) => s.purpose && Number(s.value) > 0 && Number(s.loan) > 0), 'every scenario has purpose + a positive value + loan (the amount triangle)');
ok(scenarios.every((s) => Number(s.fico) > 0 && Number(s.dscr) > 0), 'every scenario has a FICO and a DSCR');
ok(scenarios.every((s) => s.state && s.zip && s.countyFps), 'every scenario carries a known-good address (state/zip/county — no enrichment in the hot path)');

// ---- 3) the ineligible probes are flagged ------------------------------------------------------
const inelig = scenarios.filter((s) => s._group === 'ineligible');
ok(inelig.length === 6 && inelig.every((s) => s._ineligible === true), 'every ineligible probe is flagged _ineligible');
ok(scenarios.filter((s) => s._group !== 'ineligible').every((s) => !s._ineligible), 'no priced scenario is flagged ineligible');

// ---- 4) a SAMPLE actually validates against the real Lender Price scenario contract -------------
// Strip our internal keys before handing it to the validator; a LP-invalid scenario must never hide
// in the battery (it would fail the live run with a scenario error, not a real disagreement).
const strip = (s) => { const o = { ...s }; delete o._label; delete o._group; delete o._ineligible; return o; };
const sample = [scenarios[0], scenarios[63], scenarios[125], scenarios[189], scenarios[count - 1]];
let validated = 0;
for (const s of sample) {
  const v = sm.validateScenario(strip(s));
  if (v && v.ok === true) validated += 1;
  else ok(false, `sample scenario "${s._label}" should validate — got ${JSON.stringify(v && (v.error || v.message))}`);
}
ok(validated === sample.length, `a sample of ${sample.length} scenarios all pass the real LP scenario contract`);

// ---- 5) the include filter narrows to the requested groups -------------------------------------
const onlyState = buildAgreementScenarios({ include: ['state'] });
ok(onlyState.count === byGroup.state && onlyState.scenarios.every((s) => s._group === 'state'), 'include:["state"] returns only the state sweep');
const two = buildAgreementScenarios({ include: ['ineligible', 'flags'] });
ok(two.count === byGroup.ineligible + byGroup.flags, 'include with two groups returns exactly their union');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
