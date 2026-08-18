#!/usr/bin/env node
'use strict';
/**
 * LT — THE PRODUCT PROFILE IS A PARAMETER, NOT A CONSTANT (§2.88).
 *
 * THE OWNER ASKED TO "search any kind of scenarios in Lender Price". Measured: we could search exactly
 * ONE. `wireDiscipline` forced five fields onto EVERY request ever built —
 * `loanType: Fixed`, `mortgageTypes: [Conventional]`, `propertyUse: Investment`,
 * `lienPriorityType: FirstLien`, `compensationType: BorrowerCompPlan` — so no owner-occupied loan, no
 * ARM, no FHA/VA, no second lien, and no lender-paid comp could be searched at all.
 *
 * ⛔ AND ONE OF THE FIVE WAS A LIVE DEFECT, not merely a limit. `applyRegistry` VALIDATES a caller's
 * `compensationType` against the confirmed menu and writes it onto the body — and then this force
 * overwrote it. A caller asking for LenderPaid was priced BorrowerPaid, with no error and nothing in
 * the response saying so. Borrower-paid versus lender-paid is a first-order price difference.
 *
 * ⛔ THE SAFETY PROPERTY IS THE WHOLE POINT, AND IT IS ASSERTED FIRST. `'dscr'` is the default and must
 * stay BYTE-IDENTICAL to what has always been sent — every live measurement, every captured anchor and
 * every parity number in this repo was taken against that body, and a widening that quietly moved it
 * would invalidate all of them at once, silently, everywhere. Section A asserts identity across the
 * whole canonical battery, not on one hand-picked scenario.
 *
 * ⛔ AN UNKNOWN PROFILE NAME NARROWS, IT NEVER WIDENS. A typo falls back to `'dscr'` — the same
 * fail-closed direction every other unrecognized value in this connector takes. A typo that widened
 * what we search would be a request nobody meant to send, priced.
 *
 *   node scripts/test-lt-ppe-profile-parameter.js
 *
 * PURE — no network, no DB. LT-only.
 */
const { buildSearch, _internals: model } = require('../src/longterm/lenderprice/search-model');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const dscrRoute = require('../src/longterm/routes/dscr-pricer');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// `date` is a timestamp and moves on every build; it says nothing about the profile.
const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.date; return JSON.stringify(c); };
const BASE = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
  state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings', city: 'Brooklyn',
  propertyType: 'SingleFamily', units: 1, borrowerType: 'LLC' };

// ---- A: 'dscr' is byte-identical, across the WHOLE battery ---------------------------------------
console.log("-- A: the default profile has not moved --");
const battery = buildAgreementScenarios().scenarios;
ok(battery.length >= 290, `the canonical battery is ${battery.length} scenarios`);
let moved = 0; let firstMoved = null;
for (const sc of battery) {
  const implicit = strip(buildSearch(sc));
  const explicit = strip(buildSearch(sc, { profile: 'dscr' }));
  if (implicit !== explicit) { moved += 1; if (!firstMoved) firstMoved = sc._label || '?'; }
}
ok(moved === 0, `omitting the profile equals asking for 'dscr' on ALL ${battery.length} scenarios${firstMoved ? ` (first difference: ${firstMoved})` : ''}`);
// The teeth: prove the comparison CAN fail, or "0 moved" means nothing.
ok(strip(buildSearch(BASE)) !== strip(buildSearch({ ...BASE, fico: 640 })),
  '(the comparison has teeth — a real scenario change does move the body)');

// ---- B: an unknown profile narrows -------------------------------------------------------------
console.log("\n-- B: a typo must not widen what we search --");
const dscrBody = strip(buildSearch(BASE, { profile: 'dscr' }));
// ⛔ THE FALLBACK MUST BE TESTED ON A SCENARIO WHERE THE PROFILES ACTUALLY DIFFER. A first cut used
// BASE, which states none of the five — and section D proves that such a scenario is byte-identical
// under both profiles. So a mutation that made an unknown name fall back to `mirror` (the dangerous
// direction) passed every assertion here. The discriminating scenario is one that STATES one of the
// five: `compensationType` is overwritten under `dscr` and honoured under `mirror`.
const DISCRIMINATING = { ...BASE, compensationType: 'LenderPaid' };
ok(strip(buildSearch(DISCRIMINATING, { profile: 'dscr' })) !== strip(buildSearch(DISCRIMINATING, { profile: 'mirror' })),
  '(the fallback probe has teeth — this scenario really is built differently under the two profiles)');
const dscrDiscriminating = strip(buildSearch(DISCRIMINATING, { profile: 'dscr' }));
for (const bogus of ['nope', 'MIRROR', 'Dscr', '', null, undefined, 0, {}, []]) {
  ok(strip(buildSearch(DISCRIMINATING, { profile: bogus })) === dscrDiscriminating,
    `profile ${JSON.stringify(bogus)} falls back to 'dscr' — fails CLOSED`);
  ok(strip(buildSearch(BASE, { profile: bogus })) === dscrBody,
    `…and on a scenario stating none of the five, ${JSON.stringify(bogus)} is unchanged either way`);
}
// The DEFAULT is asserted by BEHAVIOUR as well as by name, on the same discriminating scenario — a
// constant renamed without changing what is sent would otherwise pass.
ok(strip(buildSearch(DISCRIMINATING)) === dscrDiscriminating,
  'omitting the profile entirely builds the NARROW body, proven where the two profiles differ');
ok(model.profileForces('mirror') !== model.PROFILE_FORCED, "'mirror' is a different force set from 'dscr'");
ok(Object.keys(model.profileForces('mirror')).length === 0, "'mirror' forces NOTHING — the scenario decides");
ok(Object.keys(model.profileForces('dscr')).length === 5, "'dscr' forces the five profile-identity fields");
ok(model.DEFAULT_PROFILE === 'dscr', 'the default is the NARROW profile, stated as data');

// ---- C: the defect the force was hiding ---------------------------------------------------------
console.log("\n-- C: a validated field is no longer overwritten --");
const asked = { ...BASE, compensationType: 'LenderPaid' };
const underDscr = buildSearch(asked, { profile: 'dscr' });
const underMirror = buildSearch(asked, { profile: 'mirror' });
ok(underDscr.criteria.compensationType === 'BorrowerCompPlan',
  "under 'dscr' a caller's LenderPaid is still overwritten — the historical behaviour, unchanged on the default path");
ok(underMirror.criteria.compensationType === 'LenderCompPlan',
  "under 'mirror' the caller's LenderPaid SURVIVES — borrower-paid vs lender-paid is a first-order price difference");
ok(underDscr.criteria.compensationType !== underMirror.criteria.compensationType,
  '…and the two profiles genuinely differ on it, so this is a real unlock rather than a renamed constant');

// ---- D: a silent scenario is not changed by the profile -----------------------------------------
console.log("\n-- D: 'mirror' widens what CAN be asked, it does not change what IS asked --");
// A scenario that states none of the five produces the SAME body under both profiles, because the
// merged foundation already carries the vendor's own defaults. This is the property that makes the
// unlock safe to ship: switching profile alone changes nothing.
ok(strip(buildSearch(BASE, { profile: 'mirror' })) === dscrBody,
  'a scenario stating none of the five is byte-identical under both profiles');
let mirrorMoved = 0;
for (const sc of battery) if (strip(buildSearch(sc, { profile: 'mirror' })) !== strip(buildSearch(sc))) mirrorMoved += 1;
ok(mirrorMoved === 0, `and that holds across all ${battery.length} battery scenarios (${mirrorMoved} moved)`);

// ---- E: the repairs are NOT profile identity and survive both ------------------------------------
console.log("\n-- E: the two wire repairs run under every profile --");
// `mortgageTypes: []` was the MEASURED cause of a live 500, and a body that says Fixed in one place
// and ARM in another is a request no reader can honour. Neither is profile identity — both are the
// difference between a readable request and a broken one — so a mirror search gets them too.
for (const profile of ['dscr', 'mirror']) {
  const b = buildSearch(BASE, { profile, base: { criteria: { mortgageTypes: [] }, loanTypeCriteria: [] } });
  ok(Array.isArray(b.criteria.mortgageTypes) && b.criteria.mortgageTypes.length > 0,
    `${profile}: an empty mortgageTypes is repaired, never sent (it was a measured 500)`);
  ok(Array.isArray(b.loanTypeCriteria) && b.loanTypeCriteria[0] === b.criteria.loanType,
    `${profile}: loanType and loanTypeCriteria agree`);
}

// ---- F: the door accepts it as an ENVELOPE key, not a pricing input ------------------------------
console.log("\n-- F: the route's contract --");
ok(dscrRoute.META_FIELDS.has('profile'), 'the route accepts `profile` in the request envelope');
ok(!dscrRoute.SUPPORTED_FIELDS.has('profile'),
  '…and NOT as a pricing input — it selects which body is sent, it is not a fact about the loan');
ok(dscrRoute._internals.unsupportedFields({ profile: 'mirror' }).length === 0, 'a body carrying it is not 422d');
ok(dscrRoute._internals.unsupportedFields({ prof1le: 'mirror' }).length === 1,
  '…while a MISSPELLED profile key is still refused, rather than silently dropped');
const fs = require('fs');
const path = require('path');
const clientSrc = fs.readFileSync(path.join(__dirname, '../src/longterm/lenderprice/client.js'), 'utf8');
ok(/async function price\(scenario, opts = \{\}\)/.test(clientSrc), 'client.price takes the option');
ok(/profile: opts\.profile/.test(clientSrc), '…and passes it to buildSearch — not merely accepts and drops it');
const routeSrc = fs.readFileSync(path.join(__dirname, '../src/longterm/routes/dscr-pricer.js'), 'utf8');
ok(/lp\.price\(sc, \{ profile: req\.body && req\.body\.profile \}\)/.test(routeSrc),
  'the route passes the caller\'s profile through to the client');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
