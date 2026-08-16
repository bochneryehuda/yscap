#!/usr/bin/env node
'use strict';
/**
 * Long-Term Lender Price client — verification harness.
 *
 * TWO MODES:
 *   (default) OFFLINE  — no network. Proves the request builder produces the exact
 *                        login + searchRaw shapes the browser uses (Origin header set,
 *                        field tokens correct). Runs in CI / anywhere.
 *   LP_LIVE=1          — LIVE. Logs into Lender Price with LP_USERNAME/LP_PASSWORD and
 *                        runs a scenario battery, printing real results. Intended to run
 *                        on Render (where the request originates from a trusted server and
 *                        is not blocked). Needs LP_USERNAME + LP_PASSWORD in the env.
 *
 *   node scripts/test-lt-lenderprice.js
 *   LP_LIVE=1 node scripts/test-lt-lenderprice.js
 */

const lp = require('../src/longterm/lenderprice/client');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

function offline() {
  console.log('OFFLINE verification (no network)\n');

  // 1) Login shape: the fix for the 401 is the Origin/Referer header. Prove req() sets it.
  //    We can't call the private req(), so assert the config the client will use.
  const I = lp._internals;
  ok(I.ORIGIN === (process.env.LP_ORIGIN || 'https://yscapgroup.digitallending.com'), `login Origin = company page (${I.ORIGIN})`);
  ok(I.CLIENT_ID === (process.env.LP_CLIENT_ID || 'acme2'), `client_id = ${I.CLIENT_ID}`);
  ok(I.AUTH_BASE.startsWith('https://'), 'auth base is https');

  // 2) SSRF guard: only the two Lender Price hosts are reachable.
  let blocked = false;
  try { I.assertAllowed('https://evil.example.com/x'); } catch { blocked = true; }
  ok(blocked, 'SSRF guard blocks a non-allowlisted host');
  let allowed = true;
  try { I.assertAllowed(I.API_BASE + '/rest/v1/x'); } catch { allowed = false; }
  ok(allowed, 'SSRF guard allows the Lender Price API host');

  // 3) searchRaw body: a representative DSCR purchase.
  const body = lp.buildSearchPayload({
    purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25,
    propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039',
    prepayMonths: 60, borrowerType: 'LLC',
  });
  ok(body.criteria.loanPurpose === 'Purchase', 'purpose → Purchase');
  ok(body.criteria.purchasePrice === 500000 && body.criteria.appraisedValue === 500000, 'value fills purchasePrice + appraisedValue');
  ok(body.criteria.loanAmount === 375000, 'loan amount set');
  ok(body.criteria.ltv === 0.75, `ltv derived = ${body.criteria.ltv}`);
  ok(body.criteria.fico === 760, 'fico set');
  ok(body.criteria.dscr === 1.25, 'dscr set');
  ok(body.criteria.propertyUse === 'Investment', 'occupancy locked Investment');
  ok(body.criteria.loanType === 'Fixed' && body.criteria.loanYear === 30, 'fixed / 30yr locked');
  ok(body.dynamicPropertiesMap.IncomeDocType === 'DSCR', 'IncomeDocType DSCR');
  ok(body.dynamicPropertiesMap.AddlOccupancyType === 'Long_Term_Rental_Property', 'AddlOccupancyType long-term rental');
  ok(body.dynamicPropertiesMap.GLOBAL_RESERVES === 'Reserves_24', 'reserves 24');
  ok(body.dynamicPropertiesMap.PrepayTerm === '60 Months', 'prepay 60 Months');
  ok(body.dynamicPropertiesMap.PrePayment_Plan_Type === 'Standard', 'prepay plan Standard');
  ok(body.criteria.specialMortgageOptions.includes('5 Yr PPP'), 'special option 5 Yr PPP');
  ok(body.property.propertyType === 'SingleFamily', 'property type SingleFamily');
  ok(body.property.address.county === '34039', 'county FIPS passed');

  // 4) Prepay = none → null tokens + No PPP.
  const none = lp.buildSearchPayload({ purpose: 'Purchase', value: 4e5, loan: 3e5, fico: 720, dscr: 1.1, prepayMonths: 0, propertyType: 'SingleFamily' });
  ok(none.dynamicPropertiesMap.PrepayTerm === null, 'no-prepay → PrepayTerm null');
  ok(none.criteria.specialMortgageOptions.includes('No PPP'), 'no-prepay → No PPP');

  // 5) Cash-out + non-warrantable condo.
  const co = lp.buildSearchPayload({ purpose: 'CashOut', value: 6e5, loan: 4e5, fico: 700, dscr: 1.2, propertyType: 'CondoNonWarr', prepayMonths: 36 });
  ok(co.criteria.loanPurpose === 'CashoutRefinance', 'cash-out → CashoutRefinance');
  ok(co.criteria.nonWarrantableProject === true, 'non-warrantable flag true');
  ok(co.criteria.specialMortgageOptions.includes('Non-Warrantable Condo'), 'special option Non-Warrantable Condo');
  ok(co.property.propertyType === 'Condos', 'condo → Condos token');

  // 6) 2–4 unit.
  const u = lp.buildSearchPayload({ purpose: 'Purchase', value: 8e5, loan: 6e5, fico: 740, dscr: 1.3, propertyType: 'Unit2_4', prepayMonths: 48 });
  ok(u.property.propertyType === 'UnitDwelling_2_4', '2–4 unit token');
  ok(u.dynamicPropertiesMap.PrepayTerm === '48 Months', 'prepay 48 Months');

  // 7) Historical as-of date passes through.
  const asof = lp.buildSearchPayload({ purpose: 'Purchase', value: 5e5, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', prepayMonths: 60, date: '2026-04-23T04:45:00.000Z' });
  ok(asof.date === '2026-04-23T04:45:00.000Z', 'as-of date passed through');

  // 8) Parser flattens a synthetic tree.
  const fake = { results: { investorA: { lenderName: 'Test Lender', programName: 'DSCR 30yr',
    ladder: [{ rate: 6.5, price: 100.5, points: -0.5, apr: 6.7, monthlyPayment: 2300 },
             { rate: 6.75, price: 101.2, points: -1.2, apr: 6.9, monthlyPayment: 2350 }] } } };
  const parsed = lp.parse(fake);
  ok(parsed.programCount === 1 && parsed.programs[0].lender === 'Test Lender', 'parser groups by lender/program');
  ok(parsed.programs[0].rungCount === 2 && parsed.programs[0].minRate === 6.5, 'parser collects + sorts rungs');

  console.log(`\nOFFLINE: ${failures ? failures + ' FAILED' : 'all passed'}`);
}

async function live() {
  console.log('LIVE Lender Price run\n');
  if (!lp.configured()) { console.log('LP_USERNAME / LP_PASSWORD not set — cannot run live. (Set them in Render.)'); process.exit(2); }

  const t0 = Date.now();
  const s = await lp.getSession({ force: true });
  if (!s.ok) { console.log('LOGIN FAILED:', s.error, '-', s.message); process.exit(1); }
  console.log(`LOGIN ok in ${((Date.now() - t0) / 1000).toFixed(2)}s  company=${s.companyId} user=${s.userId} nmls=${s.profile.loanOfficerNmlsId} exp=${new Date(s.expiresAt).toISOString()}`);

  const battery = [
    { name: 'SFR purchase 75% 760 DSCR1.25 NJ 5yr', purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039', prepayMonths: 60, borrowerType: 'LLC' },
    { name: 'SFR cash-out 70% 720 DSCR1.10 FL 3yr', purpose: 'CashOut', value: 600000, loan: 420000, fico: 720, dscr: 1.10, propertyType: 'SingleFamily', zip: '33101', state: 'FL', county: 'Miami-Dade', countyFps: '12086', prepayMonths: 36, borrowerType: 'LLC' },
    { name: '2-4 unit purchase 75% 740 DSCR1.30 NY 5yr', purpose: 'Purchase', value: 900000, loan: 675000, fico: 740, dscr: 1.30, propertyType: 'Unit2_4', zip: '11211', state: 'NY', county: 'Kings', countyFps: '36047', prepayMonths: 60, borrowerType: 'LLC' },
    { name: 'Warr condo r/t refi 65% 780 DSCR1.40 TX none', purpose: 'RateTerm', value: 450000, loan: 292500, fico: 780, dscr: 1.40, propertyType: 'CondoWarr', zip: '75201', state: 'TX', county: 'Dallas', countyFps: '48113', prepayMonths: 0, borrowerType: 'LLC' },
    { name: 'SFR purchase I/O 80% 700 DSCR1.05 GA 2yr', purpose: 'Purchase', value: 350000, loan: 280000, fico: 700, dscr: 1.05, propertyType: 'SingleFamily', zip: '30301', state: 'GA', county: 'Fulton', countyFps: '13121', prepayMonths: 24, io: true, borrowerType: 'LLC' },
  ];

  for (const sc of battery) {
    const r = await lp.price(sc);
    if (!r.ok) { console.log(`  FAIL  ${sc.name} → ${r.error} ${r.http || ''} ${r.message || ''} ${r.body || ''}`); continue; }
    const p = lp.parse(r.raw);
    const best = p.programs.reduce((m, x) => (x.minRate != null && x.minRate < m ? x.minRate : m), Infinity);
    console.log(`  ok    ${sc.name}  → ${p.programCount} programs / ${p.lenderCount} lenders / ${p.rungCount} rungs / best ${isFinite(best) ? best + '%' : '—'}`);
    await new Promise((res) => setTimeout(res, 1200)); // pace: gentle on one shared login
  }
  console.log('\nLIVE run complete.');
}

(async () => {
  if (process.env.LP_LIVE === '1') { await live(); }
  else { offline(); process.exit(failures ? 1 : 0); }
})();
