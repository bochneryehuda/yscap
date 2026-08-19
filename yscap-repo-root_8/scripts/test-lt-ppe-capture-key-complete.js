#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE CAPTURE MUST RECORD EVERY FACT IT SENDS (§2.120).
 *
 * A capture directory exists so a paid run can be re-read for nothing. The ONLY way to tell which
 * scenario a stored vendor payload answered is to rebuild the request from the facts the capture kept
 * beside it (`client._internals.captureScenarioMeta`, a deliberate allowlist). So the allowlist has a
 * CORRECTNESS DUTY nobody had stated: it must cover every scenario fact that reaches the request. A
 * fact that changes what we SEND but is not recorded makes two different loans indistinguishable on
 * disk, and a replay then either answers one with the other's evidence or cannot answer at all.
 *
 * MEASURED before the fix, on the real 305-scenario battery: FOURTEEN facts reached the vendor request
 * and were not recorded — `city`, `countyFps`, `cashoutAmount`, `prepayMonths`, `prepayStructure`,
 * `io`, `escrowWaive`, `nonWarrantable`, `rentalTerm`, `rural_property`, `short_term_rental`,
 * `first_time_investor`, `first_time_homebuyer`, `foreign_national`. 277 distinct real requests
 * collapsed onto 244 recordable keys, and SIX of those keys hid more than one real request (one hid
 * fifteen). After the widening: 277 real requests, 277 recordable keys, zero collisions.
 *
 * ⛔ THIS SUITE DERIVES THE SET, IT DOES NOT REMEMBER IT. The whole point is that a hand-kept list goes
 * stale the first time somebody adds a fact to `buildSearch` — which is exactly how the fourteen got
 * there. Every scenario fact the battery carries is PERTURBED against several different bases; if the
 * built request moves and the fact is not on the allowlist, this fails and names it.
 *
 * ⛔ IT IS DELIBERATELY ONE-DIRECTIONAL. A fact on the allowlist that this cannot show reaching the
 * request is NOT a failure: perturbation can only prove presence, and an allowlist that is slightly
 * wider than the request costs nothing but a few bytes on disk, while one that is narrower loses
 * evidence. The over-wide entries are reported, never failed.
 *
 *   node scripts/test-lt-ppe-capture-key-complete.js
 */
const { buildSearch } = require('../src/longterm/lenderprice/search-model');
const client = require('../src/longterm/lenderprice/client');
const { CAPTURE_SCENARIO_KEYS, captureScenarioMeta } = client._internals;
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const scenarios = buildAgreementScenarios().scenarios;
const ALLOWED = new Set(CAPTURE_SCENARIO_KEYS);
// The battery's own bookkeeping — never part of a request, and stripped before one is built.
const BOOKKEEPING = new Set(['_label', '_group', '_ineligible']);

function stripInternal(sc) { const o = { ...sc }; for (const k of BOOKKEEPING) delete o[k]; return o; }
function request(sc) { try { return JSON.stringify(buildSearch(stripInternal(sc))); } catch (e) { return `ERR:${e.message}`; } }

console.log('LT PPE — the capture records every fact it sends (§2.120) — offline\n');

// ---- A. THE BATTERY IS REAL AND BIG ENOUGH TO MEASURE AGAINST ------------------------------------
{
  ok(Array.isArray(scenarios) && scenarios.length >= 200,
    `A1 measuring against the real agreement battery — ${scenarios.length} scenarios`);
}

// ---- B. EVERY FACT THAT MOVES THE REQUEST IS RECORDED --------------------------------------------
// Derived by perturbation over SEVERAL bases: a fact's effect can be conditional (a cash-out amount
// does nothing on a purchase), so one base is not enough to find it.
{
  const facts = new Set();
  for (const sc of scenarios) for (const k of Object.keys(sc)) if (!BOOKKEEPING.has(k)) facts.add(k);
  ok(facts.size > 20, `B1 the battery carries ${facts.size} distinct scenario facts to check`);

  // Bases chosen to span the battery's shapes rather than picked: one per group, capped so the sweep
  // stays quick.
  const byGroup = new Map();
  for (const sc of scenarios) if (!byGroup.has(sc._group)) byGroup.set(sc._group, sc);
  const bases = [...byGroup.values()];
  ok(bases.length >= 5, `B2 …perturbed against ${bases.length} different bases, one per battery group`);

  const affects = new Map();   // fact -> a base label where it demonstrably moved the request
  for (const base of bases) {
    const baseReq = request(base);
    for (const k of facts) {
      if (affects.has(k)) continue;
      // Perturb with a value some OTHER scenario really uses, so the probe is a value the vendor
      // could actually be sent — never an invented one.
      const alt = scenarios.find((s) => s[k] !== undefined && JSON.stringify(s[k]) !== JSON.stringify(base[k]));
      if (!alt) continue;
      const probe = { ...base, [k]: alt[k] };
      if (request(probe) !== baseReq) affects.set(k, base._label);
    }
  }
  ok(affects.size > 0, `B3 …and ${affects.size} of them demonstrably move what we send`);

  const unrecorded = [...affects.keys()].filter((k) => !ALLOWED.has(k)).sort();
  for (const k of unrecorded) {
    ok(false, `B4 "${k}" reaches the Lender Price request and the capture does NOT record it (seen on "${affects.get(k)}")`);
  }
  ok(unrecorded.length === 0,
    `B5 every request-affecting fact is recorded beside its payload — ${affects.size} checked, ${unrecorded.length} missing`);

  // One-directional, and said out loud rather than asserted away.
  const notShown = [...ALLOWED].filter((k) => !BOOKKEEPING.has(k) && !affects.has(k)).sort();
  console.log(`  note  ${notShown.length} allowlisted fact(s) could not be SHOWN to move the request here` +
    `${notShown.length ? ` (${notShown.join(', ')})` : ''} — recorded anyway, which costs bytes, not evidence`);
}

// ---- C. THE RECORDABLE KEY IS AS DISCRIMINATING AS THE REAL REQUEST ------------------------------
// The measurement that made this item necessary, re-run every time this suite does.
{
  const realKeys = new Set();
  const byRecordable = new Map();
  for (const sc of scenarios) {
    realKeys.add(request(sc));
    const rk = request(captureScenarioMeta(sc));
    if (!byRecordable.has(rk)) byRecordable.set(rk, []);
    byRecordable.get(rk).push(sc);
  }
  let hiding = 0;
  const examples = [];
  for (const [, group] of byRecordable) {
    const distinct = new Set(group.map(request));
    if (distinct.size > 1) { hiding += 1; if (examples.length < 3) examples.push({ n: distinct.size, labels: group.slice(0, 3).map((s) => s._label) }); }
  }
  console.log(`  note  ${scenarios.length} scenarios → ${realKeys.size} distinct real requests → ${byRecordable.size} distinct recordable keys`);
  ok(hiding === 0,
    `C1 no recordable key hides more than one real request — ${hiding} do${examples.length ? ` (e.g. ${JSON.stringify(examples[0])})` : ''}`);
  ok(byRecordable.size === realKeys.size,
    `C2 …so the recordable key is EXACTLY as discriminating as the request itself (${byRecordable.size} vs ${realKeys.size})`);
}

// ---- D. THE ALLOWLIST IS STILL AN ALLOWLIST ------------------------------------------------------
// Widening it must not have turned it into "record the whole scenario". Two things are load-bearing:
// it still refuses an unknown key, and nothing on it identifies a person.
{
  const forged = { ...scenarios[0], borrowerSsn: '123-45-6789', borrowerName: 'A Person', notes: 'x' };
  const kept = captureScenarioMeta(forged);
  ok(!('borrowerSsn' in kept) && !('borrowerName' in kept) && !('notes' in kept),
    'D1 a fact nobody allowlisted is still refused — the projection cannot start capturing by accident');
  ok(Object.keys(kept).every((k) => ALLOWED.has(k)),
    'D2 …and everything it keeps is on the list, with nothing added along the way');

  const IDENTITY = /(ssn|social|name|email|phone|dob|birth|borrower_?id|address|street)/i;
  const identityish = CAPTURE_SCENARIO_KEYS.filter((k) => IDENTITY.test(k) && !BOOKKEEPING.has(k));
  ok(identityish.length === 0,
    `D3 nothing on the allowlist identifies a borrower — these are deal-shape facts${identityish.length ? ` (found ${identityish.join(', ')})` : ''}`);
  ok(CAPTURE_SCENARIO_KEYS.length < 60,
    `D4 …and it is a named subset (${CAPTURE_SCENARIO_KEYS.length} keys), not the whole scenario`);
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — applied to src/longterm/lenderprice/client.js, control green either side, each
 * verified to have APPLIED (md5 before/after) before the result was believed.
 *   M1  remove 'prepayMonths' from CAPTURE_SCENARIO_KEYS  → B4/B5 name it, C1/C2 fail
 *   M2  remove 'countyFps'                                → B4/B5 name it, C1/C2 fail
 *   M3  revert the allowlist to its pre-§2.120 seventeen  → B4 names all fourteen, C1/C2 fail
 *   M4  captureScenarioMeta: copy the WHOLE scenario      → D1/D2 fail (the allowlist stops being one)
 * ------------------------------------------------------------------------------------------- */
