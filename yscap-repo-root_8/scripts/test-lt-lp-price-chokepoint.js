#!/usr/bin/env node
'use strict';
/**
 * LT / Lender Price — EVERY PRICED SCENARIO IS VALIDATED AND ENRICHED AT ONE CHOKEPOINT.
 * (offline; no database, no network — `global.fetch` is stubbed, which is the real IO seam.)
 *
 * WHY THIS EXISTS. `validateScenario` fills a location in from its ZIP (state, county name, county
 * FIPS), and its own note is explicit that a caller "MUST go on to price the returned scenario:
 * pricing the original would validate one request and send a different, county-less one upstream."
 * Only `routes/dscr-pricer.js` did that. `routes/ppe.js` — the SHADOW/CANARY path, whose entire
 * purpose is to compare our engine against Lender Price and decide whether we may cut over — called
 * `price()` with the raw scenario. So it priced a county-less location while the real pricer priced
 * a county-carrying one: the comparison that governs the cutover was measuring two different
 * requests, silently, and no test could see it because both halves "worked".
 *
 * Enrichment at the CALL SITE can only ever be as complete as the list of call sites somebody
 * remembered — which is how the gap opened. So it now happens inside `price()` /
 * `priceDisqualified()`, and this suite asserts the property that makes call sites irrelevant:
 * whatever a caller passes, what goes ON THE WIRE is enriched.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; } else { failed++; console.log('  FAIL: ' + what); } };

// ---- the IO seam ------------------------------------------------------------------------------
const sent = [];
let tokenIssued = false;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const mk = (status, body) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
    clone() { return this; },
  });
  if (u.includes('/oauth/token')) {
    tokenIssued = true;
    return mk(200, { access_token: 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3599 })).toString('base64') + '.y',
      refresh_token: 'r', expires_in: 3599, companyId: 'CO', userId: 'US' });
  }
  if (u.includes('searchRaw')) {
    let body = null; try { body = JSON.parse(opts.body); } catch {}
    sent.push(body);
    return mk(200, { ok: true, programs: [] });
  }
  // defaultSearch / smo — answer "unavailable" so the canonical base is used.
  return mk(404, {});
};

process.env.LP_USERNAME = 'probe@example.test';
process.env.LP_PASSWORD = 'not-a-real-password';
process.env.LP_CLIENT_SECRET = 'not-a-real-secret';

const lp = require(path.join(ROOT, 'src', 'longterm', 'lenderprice', 'client.js'));
const zipCounty = require(path.join(ROOT, 'src', 'longterm', 'lenderprice', 'zip-county.js'));

// A scenario carrying ONLY a ZIP for its location — exactly what the shadow path passes.
const BARE = { purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
  zip: '07104', propertyType: 'SingleFamily', units: 1, borrowerType: 'LLC', incomeDocType: 'DSCR', termYears: 30 };

(async () => {
  console.log('LT Lender Price — the price() chokepoint');

  // The enrichment table must actually know this ZIP, or the test proves nothing about the wiring.
  console.log('\nA. the ZIP table knows the fixture');
  // `enrichLocation` reports the fill as { ok, location, filled, resolved } — the resolved location
  // is what buildSearch consumes, so that is what is asserted (not a flat countyFps on the result).
  const enr = zipCounty.enrichLocation({ zip: '07104' });
  ok(enr && enr.ok === true, 'the ZIP table resolves 07104');
  ok(enr && enr.resolved && enr.resolved.countyFps === '34013', 'ZIP 07104 resolves to county FIPS 34013');
  ok(enr && enr.resolved && enr.resolved.state === 'NJ', 'and to state NJ');
  ok(enr && Array.isArray(enr.filled) && enr.filled.includes('countyFps'), 'the county FIPS is reported as FILLED, so it was absent and is now supplied');

  console.log('\nB. price() sends an ENRICHED location, whatever the caller passed');
  sent.length = 0;
  const r = await lp.price({ ...BARE });
  ok(r && r.ok === true, 'price() succeeded against the stubbed vendor');
  ok(sent.length === 1, 'exactly one searchRaw request was sent');
  const addr = sent[0] && sent[0].property && sent[0].property.address;
  ok(!!addr, 'the request carries a property address');
  ok(addr && addr.zip === '07104', 'the ZIP the caller gave is on the wire');
  ok(addr && addr.state === 'NJ', 'the STATE was derived from the ZIP and is on the wire');
  ok(addr && addr.county === '34013', 'the COUNTY FIPS was derived from the ZIP and is on the wire');
  ok(addr && addr.censustract === '34013', 'censustract (the vendor carries the FIPS twice) is on the wire');
  ok(addr && typeof addr.countyName === 'string' && addr.countyName.length > 0, 'the county NAME is on the wire');

  console.log('\nC. priceDisqualified() enriches identically');
  sent.length = 0;
  await lp.priceDisqualified({ ...BARE }, { maxWaitMs: 1, pollMs: 1 });
  ok(sent.length >= 1, 'the ineligible path sent a request');
  const a2 = sent[0] && sent[0].property && sent[0].property.address;
  ok(a2 && a2.county === '34013', 'the ineligible path prices the SAME enriched county as the eligible one');

  console.log('\nD. an already-enriched scenario is unchanged (running it twice is safe)');
  sent.length = 0;
  await lp.price({ ...BARE, state: 'NJ', county: 'Essex', countyFps: '34013' });
  const a3 = sent[0] && sent[0].property && sent[0].property.address;
  ok(a3 && a3.county === '34013' && a3.state === 'NJ', 'a pre-enriched scenario prices identically');

  console.log('\nE. an unpriceable scenario is REFUSED here, not sent upstream');
  sent.length = 0;
  const bad = await lp.price({ ...BARE, purpose: 'Something The Vendor Never Heard Of' });
  ok(bad && bad.ok === false, 'an unknown loan purpose is refused');
  ok(bad && bad.reason === 'lp_scenario_invalid', 'the refusal names itself rather than surfacing as a vendor 500');
  ok(sent.length === 0, 'NOTHING was sent upstream for an invalid scenario');

  sent.length = 0;
  const noLoc = await lp.price({ purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5, propertyType: 'SingleFamily', units: 1 });
  ok(noLoc && noLoc.ok === false, 'a scenario with NO location at all is refused');
  ok(sent.length === 0, 'a locationless scenario is never sent upstream');

  console.log('\nF. the shadow path cannot bypass it');
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'src', 'longterm', 'lenderprice', 'client.js'), 'utf8');
    const priceBody = src.slice(src.indexOf('async function price(scenario)'), src.indexOf('async function priceDisqualified'));
    ok(/validatedScenario\(scenario\)/.test(priceBody), 'price() runs the scenario through the shared validator');
    const dq = src.slice(src.indexOf('async function priceDisqualified'));
    ok(/validatedScenario\(scenario\)/.test(dq.slice(0, 900)), 'priceDisqualified() runs it too');
  }

  ok(tokenIssued, 'the stubbed login was exercised (the test really went through the client)');

  console.log('\n' + (failed === 0 ? 'OFFLINE: all passed' : 'FAILURES') + ' (' + passed + ' passed, ' + failed + ' failed)');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('THREW: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e)); process.exit(1); });
