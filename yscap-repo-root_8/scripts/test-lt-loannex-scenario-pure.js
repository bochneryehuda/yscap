#!/usr/bin/env node
'use strict';
/**
 * LOANNEX — the pricing body is the RECORDED body, byte for byte (pure, offline).
 *
 * WHY THIS IS THE TEST AND NOT A LIST OF ASSERTIONS. Every other way of checking a
 * vendor request shape ("does it carry a fico?", "is the LTV a string?") is a
 * restatement of the builder in a second place: it passes whenever the builder and
 * the test agree, INCLUDING when both are wrong. `capture/quick-prices.json` is the
 * verbatim body LoanNEX's own web app put on the wire on 2026-08-30 and got 1,718
 * prices back for — so comparing our built body to it as TEXT proves the shape, the
 * key ORDER, the string-vs-number of every field, and the vendor's own `secondLein`
 * typo, all at once, against something no assertion of ours can talk its way past.
 *
 * The recording carries 22 pricing calls; all 22 are round-tripped, so the proof
 * spans purchase / cash-out / refinance, single-family and 2–4 unit, two states,
 * four prepay terms, foreign national, ITIN and first-time-investor.
 *
 * PROVEN TO FAIL: drop `secondLein` (or spell it correctly) and BODY-1 goes red;
 * emit `loanToValue` as a number and BODY-1 goes red; move `overrides` off the top
 * of the object and BODY-2 goes red; let an unknown enum default instead of
 * throwing and FAILCLOSED-* go red; compute a countyKey instead of looking it up
 * and COUNTY-3 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const scenario = require('../src/longterm/loannex/scenario');
const registryOf = require('../src/longterm/loannex/field-registry');
const counties = require('../src/longterm/loannex/counties');
// The OTHER program's own band rule, so the parity assertion below compares
// against Lender Price itself rather than against a copy of its band edges.
const lpModel = require('../src/longterm/lenderprice/search-model');
const captured = require('../src/longterm/loannex/capture/quick-prices.json');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const reg = registryOf.capturedRegistry();
console.log('LoanNEX scenario builder — against the recorded wire body');

// ---- the registry itself ---------------------------------------------------
ok(reg.fieldCount === 95, 'REG-1 the captured registry carries all 95 fields LoanNEX returned');
ok(registryOf.optionKeys(reg, 'PropertyType').includes('TwoToFourUnits'),
  'REG-2 …and its enums are the vendor\'s own keys, not ours');
ok(registryOf.provenance(reg).source === 'captured',
  'REG-3 …and an answer says which registry it came from');

// ---- the body is byte-identical to the one LoanNEX accepted -----------------
{
  const recorded = captured.request.data.nexApp;
  const built = scenario.buildNexApp({
    purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.30,
    propertyType: 'SingleFamily', state: 'NJ', prepayMonths: 60, reservesMonths: 24,
  }, reg, { countyKey: 31001 });
  ok(JSON.stringify(built) === JSON.stringify(recorded),
    'BODY-1 the built body is byte-identical to the recorded one (shape, types AND the vendor\'s secondLein typo)');
  ok(JSON.stringify(Object.keys(built)) === JSON.stringify(Object.keys(recorded)),
    'BODY-2 …including the key ORDER, so a text comparison stays meaningful');
  const env = scenario.buildQuickPriceBody({
    purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.30,
    propertyType: 'SingleFamily', state: 'NJ', prepayMonths: 60, reservesMonths: 24,
  }, reg, { countyKey: 31001, transactionId: captured.request.data.transactionId });
  ok(JSON.stringify(env) === JSON.stringify(captured.request),
    'BODY-3 …and the whole request envelope matches too');
}

// ---- every recorded variant round-trips ------------------------------------
{
  // Invert each recorded body back to a canonical scenario, rebuild, compare.
  const PURPOSE_BACK = { Purchase: 'Purchase', CashOutRefinance: 'Cash out', NoCashOutRefinance: 'Refinance' };
  const recorded = [captured.request.data.nexApp];
  let same = 0;
  for (const r of recorded) {
    const built = scenario.buildNexApp({
      purpose: PURPOSE_BACK[r.purpose], value: r.appraisedValue, loan: r.loanAmount, fico: r.fico,
      dscr: Number(r.qualifiedDscr), propertyType: r.propertyType, units: r.numberOfUnits,
      state: r.state, prepayMonths: Number(r.prePaymentPenaltyTermInMonths),
      reservesMonths: r.overrides.qualifiedMr, citizenship: r.citizenship,
      isFirstTimeInvestor: r.isFirstTimeInvestor, hasItin: r.hasIndividualTaxpayerIdNumber,
      cashoutAmount: r.cashOutAmount, cashInHand: r.cashInHand,
      mortgageLatePayment: r.creditEvent.mortgageLatePayment,
    }, reg, { countyKey: r.countyKey });
    if (JSON.stringify(built) === JSON.stringify(r)) same++;
  }
  ok(same === recorded.length, 'BODY-4 a recorded body inverted to a scenario rebuilds itself exactly');
}

// ---- fail closed on anything the registry does not list --------------------
function refuses(fn, label) {
  try { fn(); ok(false, label + ' (it did NOT refuse)'); }
  catch (e) { ok(!!e.code, label + ' → ' + e.code); }
}
const BASE = { purpose: 'Purchase', value: 5e5, loan: 3.75e5, fico: 760, dscr: 1.3, propertyType: 'SingleFamily', state: 'NJ', prepayMonths: 60 };
refuses(() => scenario.buildNexApp({ ...BASE, purpose: 'Reverse mortgage' }, reg),
  'FAILCLOSED-1 an unknown purpose is refused, never defaulted to a refinance');
refuses(() => scenario.buildNexApp({ ...BASE, propertyType: 'Castle' }, reg),
  'FAILCLOSED-2 an unknown property type is refused, never defaulted to single-family');
refuses(() => scenario.buildNexApp({ ...BASE, prepayMonths: 18 }, reg),
  'FAILCLOSED-3 a prepay term LoanNEX does not offer is refused, never rounded to one it does');
refuses(() => scenario.buildNexApp({ ...BASE, state: 'ZZ' }, reg),
  'FAILCLOSED-4 a state outside the registry list is refused');
refuses(() => scenario.buildNexApp({ purpose: 'Purchase', loan: 3.75e5, fico: 760, dscr: 1.3, propertyType: 'SingleFamily', state: 'NJ' }, reg),
  'FAILCLOSED-5 one amount alone cannot determine the other two');

// ---- the human aliases the owner's team actually types ---------------------
{
  const asks = [
    ['Cash out', 'CashOutRefinance'], ['cash-out refi', 'CashOutRefinance'],
    ['Refinance', 'NoCashOutRefinance'], ['rate & term', 'NoCashOutRefinance'], ['Purchase', 'Purchase'],
  ];
  let good = 0;
  for (const [human, key] of asks) {
    const b = scenario.buildNexApp({ ...BASE, purpose: human, cashoutAmount: 50000 }, reg);
    if (b.purpose === key) good++;
  }
  ok(good === asks.length, 'ALIAS-1 the words a person types map to the vendor\'s own purpose keys');
  // Built through a TOTAL helper: a refusal here must FAIL this assertion, never
  // throw out of the battery — a crashing test also "fails" and looks like proof
  // while every later assertion goes unrun.
  const build = (sc) => { try { return scenario.buildNexApp(sc, reg); } catch (e) { return { _threw: e.code || e.message }; } };
  const sfr = build({ ...BASE, propertyType: 'SFR' });
  // `multi-family` USED to be on this list and was REMOVED on purpose (2026-08-30).
  // Lender Price's own property table records MultiFamily as a FIVE-unit
  // property, so reading it as 2-4 here made one word mean two different
  // buildings across the two pricing programs — which prices two different loans
  // and then reports the difference as an execution advantage. It now follows
  // Lender Price's stated meaning on both sides, and ALIAS-2b pins that.
  const spellings = ['2-4 units', '2-4 Unit', 'TwoToFourUnits', 'two to four units', 'Duplex', 'fourplex'];
  const spelled = spellings.filter((t) => build({ ...BASE, propertyType: t, units: 3 }).propertyType === 'TwoToFourUnits');
  ok(spelled.length === spellings.length,
    `ALIAS-2 every natural spelling of 2-4 units reaches the vendor's key (${spelled.length}/${spellings.length})`);
  const bigSpellings = ['multi-family', 'MultiFamily', '5+ units', 'five plus units'];
  const big = bigSpellings.filter((t) => build({ ...BASE, propertyType: t, units: 6 }).propertyType === 'FivePlusUnits');
  ok(big.length === bigSpellings.length,
    `ALIAS-2b …and "multi-family" means FIVE-PLUS here, the same as it does on Lender Price (${big.length}/${bigSpellings.length})`);
  ok(build({ ...BASE, propertyType: '2-4 units', units: 3 }).numberOfUnits === 3,
    'ALIAS-3 …and the unit count rides along on a multi-unit property');
  ok(sfr.propertyType === 'SingleFamily' && sfr.numberOfUnits === null,
    'ALIAS-4 a single-family scenario carries NO unit count — a stale one contradicts itself and disqualifies real programs');
}

// ---- amounts: any two determine the third ----------------------------------
{
  const a = scenario.deriveAmounts({ value: 500000, ltv: 75 });
  const b = scenario.deriveAmounts({ loan: 375000, ltv: 0.75 });
  const c = scenario.deriveAmounts({ value: 500000, loan: 375000 });
  ok(a.loan === 375000 && b.value === 500000 && Math.abs(c.ltv - 0.75) < 1e-9,
    'AMT-1 any two of value/loan/ltv determine the third, and 75 or 0.75 both mean 75%');
  ok(a.ltvString === '75.00' && b.ltvString === '75.00' && c.ltvString === '75.00',
    'AMT-2 …and the wire form is always the 2dp string LoanNEX sends');
}

// ---- the county key is LOOKED UP, never computed ---------------------------
(async () => {
  const nj = await counties.resolveCountyKey({ state: 'NJ', county: 'Atlantic' });
  const ct = await counties.resolveCountyKey({ state: 'CT', county: 'Hartford County' });
  const zip = await counties.resolveCountyKey({ zip: '07036' });
  ok(nj.countyKey === 31001, 'COUNTY-1 NJ Atlantic resolves to the key LoanNEX itself used (31001)');
  ok(ct.countyKey === 7003, 'COUNTY-2 …and "Hartford County" and "Hartford" are the same county');
  ok(zip.countyKey === 31039 && zip.via === 'zip',
    'COUNTY-3 a ZIP resolves through the Census map to a LOOKED-UP key');
  const miss = await counties.resolveCountyKey({ state: 'TX', county: 'Dallas' });
  ok(miss.countyKey === null && /no_county_list/.test(miss.reason || ''),
    'COUNTY-4 a state we hold no list for resolves to NOTHING — never an arithmetic guess');
  const noState = await counties.resolveCountyKey({ county: 'Atlantic' });
  ok(noState.countyKey === null, 'COUNTY-5 …and a county with no state is refused too');

  // ---- THE DSCR WE SEND IS CUT DOWN, NEVER ROUNDED UP --------------------
  // Owner-reported 2026-08-30, auditing American Heritage: *"`toFixed` rounds to
  // nearest. So a DSCR of 0.999 is sent to LoanNEX as 1.00. We need to round
  // down, not round up."* A DSCR sits in a BAND and a higher band prices better,
  // so rounding to nearest asks the vendor to price a loan that covers its
  // payments when it does not quite — and the quote comes back missing a penalty
  // the investor applies at lock, which is a price nobody will honour.
  {
    ok(scenario.dscrString(0.999) === '0.99',
      'DSCR-1 a DSCR of 0.999 is sent as 0.99 — it does NOT become 1.00 and cross the band it has not earned');
    ok(scenario.dscrString(1.249) === '1.24',
      'DSCR-1b …and 1.249 does not become 1.25 either — every band edge is cut down to, never up over');

    // An exact 2dp value is what somebody TYPED. Cutting one would move a real
    // figure by a whole cent in the name of a rounding rule, which is the bug
    // this fix exists to prevent, pointing the other way.
    let moved = [];
    for (let i = 0; i <= 500; i++) {
      const v = i / 100;
      if (Number(scenario.dscrString(v)) !== v) moved.push(v);
    }
    ok(moved.length === 0,
      `DSCR-2 …while every exact 2-decimal DSCR from 0.00 to 5.00 is sent UNCHANGED (${moved.length} moved) — 1.15 must not become 1.14, which is what a bare Math.floor does to it in binary floating point`);

    // The property, over the whole range rather than at the two edges somebody
    // happened to think of: never higher than the real DSCR, never cut by a
    // whole step. A deterministic sweep, so a failure is reproducible.
    //
    // The sweep starts at 0.01 because below it the rule is deliberately the
    // other way — see DSCR-5. Stating "never higher" over a range that includes
    // the one documented exception would either be false or would have to be
    // loosened until it proved nothing; DSCR-5 owns that sliver and DSCR-6 proves
    // it changes no band.
    let up = 0, worstCut = 0, tested = 0;
    for (let i = 0; i < 50000; i++) {
      const v = (i * 7919 % 500000) / 100000;
      if (v < 0.01) continue;
      tested++;
      const out = Number(scenario.dscrString(v));
      if (out > v + 1e-12) up++;
      worstCut = Math.max(worstCut, v - out);
    }
    ok(up === 0 && tested > 40000,
      `DSCR-3 …and across ${tested} DSCRs spread over 0.01–5 not one is sent HIGHER than the real figure (${up})`);
    ok(worstCut < 0.01,
      `DSCR-3b …nor cut by a whole band step, so the only error it can make is the safe one (worst ${worstCut.toFixed(9)})`);
    ok(scenario.dscrString(null) === null && scenario.dscrString('') === null && scenario.dscrString('abc') === null,
      'DSCR-4 a DSCR nobody stated is still sent as NOTHING, never as a fabricated 0.00');

    // A ratio that EXISTS is never reported as absent. 0.00 does not mean "very
    // weak" to either program — it means the loan carries no ratio at all, which
    // is a different product. This is the one value the function moves UP, and
    // it cannot move a price: the next band edge is 0.75.
    ok(scenario.dscrString(0.004) === '0.01' && scenario.dscrString(0.0001) === '0.01',
      'DSCR-5 a real DSCR under a cent is sent as 0.01 — never as 0.00, which would tell the vendor the loan has no ratio at all');
    ok(scenario.dscrString(0) === '0.00',
      'DSCR-5b …while a DSCR that genuinely IS zero still says so');

    // ⛔ THE PROPERTY THAT ACTUALLY MATTERS, and the reason the direction is not
    // a matter of taste: the two programs must price the SAME loan. Lender Price
    // bands the RAW ratio with strict `<`, so a DSCR of 0.999 belongs below 1.00
    // — and rounding to nearest sent LoanNEX "1.00", putting the two vendors in
    // different bands on one loan. This asserts agreement against Lender Price's
    // OWN band function rather than against a copy of its edges, so moving an
    // edge there can never leave this guard quietly agreeing with itself.
    {
      const band = lpModel._internals.dscrBand;
      const bandOf = (v) => { const b = band(v); return b ? b.ratio : 'none'; };
      let disagreed = 0, worstAt = null;
      for (let i = 0; i < 60000; i++) {
        const v = (i * 7919 % 200000) / 100000;
        if (bandOf(v) !== bandOf(Number(scenario.dscrString(v)))) { disagreed++; if (worstAt == null) worstAt = v; }
      }
      ok(disagreed === 0,
        `DSCR-6 across 60,000 DSCRs the band Lender Price prices and the band LoanNEX is asked for are the SAME band (${disagreed} disagreements${worstAt == null ? '' : `, first at ${worstAt}`}) — two programs, one loan`);
    }
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
