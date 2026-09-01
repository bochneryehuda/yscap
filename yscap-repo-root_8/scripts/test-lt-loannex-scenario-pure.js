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
// …and its FIELD registry, which is where the vesting-type and citizenship enums live as two
// separate sets — the fact the citizenship section below rests on, read rather than retyped.
const lpRegistry = require('../src/longterm/lenderprice/field-registry');
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

  // ---- THE LTV IS LIFTED, NEVER ROUNDED (owner-directed 2026-08-30) -----------
  // The DSCR bug pointing the other way. An LTV sits in a band and a HIGHER band
  // prices WORSE, so the dangerous direction here is DOWN: a loan at 80.0002%
  // rounded to nearest is sent as "80.00", asking the vendor to price a loan one
  // band better than the one we have. Shown that, the owner's answer was *"Round
  // this up."*
  {
    ok(scenario.ltvString(0.800002) === '80.01',
      'LTV-1 the owner\'s own case: a loan at 80.0002% is sent as 80.01, not 80.00 — never a band it has not earned');

    // ⛔ THE FLOAT GUARD, AND IT IS LOAD-BEARING RATHER THAN TIDY. `0.7 * 100` is
    // 70.00000000000001 in floating point, so a bare `Math.ceil` would push a plain
    // 70% loan to 70.01% and price EVERY round-number scenario in the system one
    // tier worse — a far bigger error than the one being fixed, and silent.
    const tiers = [];
    for (let p = 5; p <= 100; p += 0.25) tiers.push(Math.round(p * 100) / 100);
    const moved = tiers.filter((p) => scenario.ltvString(p / 100) !== p.toFixed(2));
    ok(moved.length === 0,
      `LTV-2 an LTV that lands exactly on a tier is UNMOVED across every quarter-point from 5% to 100% (${moved.length} moved${moved.length ? ': ' + moved.slice(0, 3).join(', ') : ''})`);

    // The whole point, swept: the sent figure is NEVER below the real one, so the
    // vendor is never asked to price a better band than the loan has earned.
    let below = 0, worstBelowAt = null, worstLift = 0;
    for (let i = 0; i < 50000; i++) {
      const pct = 5 + (i * 7919 % 950000) / 10000; // 5% .. 100%, irregular so tiers are not favoured
      const sent = Number(scenario.ltvString(pct / 100));
      if (sent < pct - 1e-9) { below++; if (worstBelowAt == null) worstBelowAt = pct; }
      worstLift = Math.max(worstLift, sent - pct);
    }
    ok(below === 0,
      `LTV-3 …and across 50000 LTVs spread over 5–100% not one is sent LOWER than the real figure (${below}${worstBelowAt == null ? '' : ', first at ' + worstBelowAt})`);
    // The other half: lifting must not overshoot either, or it would hand the
    // borrower a worse price than the loan deserves. One cent of LTV is the most
    // it may ever add, which is smaller than any real tier step.
    ok(worstLift < 0.010000001,
      `LTV-3b …nor lifted by more than a single cent of LTV, so it can never jump a whole tier (worst ${worstLift.toFixed(9)})`);

    // A supplied percentage and a supplied decimal are ONE figure — the wire form
    // must not depend on which way a person typed it.
    ok(scenario.deriveAmounts({ value: 500000, ltv: 80 }).ltvString === '80.00'
      && scenario.deriveAmounts({ value: 500000, ltv: 0.8 }).ltvString === '80.00',
      'LTV-4 80 and 0.80 are the same LTV, and both are sent as 80.00');

    // A DERIVED LTV goes the same way — this is the shape that actually produces
    // the fractions, since loan ÷ value rarely lands on a tier.
    ok(scenario.deriveAmounts({ loan: 400001, value: 500000 }).ltvString === '80.01'
      && scenario.deriveAmounts({ loan: 400000, value: 500000 }).ltvString === '80.00',
      'LTV-5 …and an LTV worked out from loan ÷ value is lifted the same way, while an exact one is not');

    // NEVER FABRICATED. With only one figure the triangle refuses outright, so
    // there is no path on which an absent LTV becomes a confident 0.00.
    let refused = false;
    try { scenario.deriveAmounts({ value: 500000 }); } catch (e) { refused = e.code === 'insufficient_amounts'; }
    ok(refused && scenario.ltvString(null) === null,
      'LTV-6 an LTV nobody stated is never invented — one figure alone is refused, and a null LTV stays null');
  }

  // ---- citizenship is NOT the vesting type ----------------------------------
  // THE LIVE DEFECT THIS SECTION EXISTS FOR. `borrowerType` in this scenario
  // vocabulary is the VESTING (entity) type — LLC, Corporation, Trust — and the
  // builder USED to fall back to it for CITIZENSHIP. No vesting word is in any
  // citizenship table, so `mapAlias` refused the request before the wire and
  // EVERY quote the board asked LoanNEX for came back with nothing at all. The
  // board offers only vesting types, so this was not an edge: it was every quote.
  {
    const fixed = require('fs').readFileSync(require.resolve('../src/longterm/loannex/scenario'), 'utf8');
    // The OLD rule, reproduced verbatim, so the control below proves what moved
    // rather than asserting it. If this ever passes 'LLC', the control is broken.
    const oldRule = (s) => (s.borrowerType == null && s.citizenship == null
      ? 'UsCitizen'
      : scenario._internals.mapAlias(scenario._internals.CITIZENSHIP_ALIASES,
        s.citizenship != null ? s.citizenship : s.borrowerType, 'citizenship', 'unknown_citizenship'));

    // EVERY read below goes through this TOTAL accessor, and that is not tidiness:
    // a mutation restoring the old fallback makes several of these calls THROW, and
    // an uncaught throw stops the battery where it stands — which reports a pass
    // rate that means nothing and looks like proof. It answers the refusal code
    // instead, so each assertion fails on its own terms.
    const priceOrCode = (extra) => {
      try {
        return scenario.buildNexApp(Object.assign({
          purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.30,
          propertyType: 'SingleFamily', state: 'NJ', prepayMonths: 60, reservesMonths: 24,
        }, extra), reg, { countyKey: 31001 });
      } catch (e) { return { citizenship: 'REFUSED:' + (e && e.code), _refused: (e && e.code) || 'throw' }; }
    };
    const price = priceOrCode;

    // ── THE PAYLOAD THE BOARD ACTUALLY SENDS ─────────────────────────────────
    // A synthetic minimum is NOT what the screen posts, and the difference is the
    // whole severity here: the defect only ever hurt because the BOARD fills in a
    // vesting type on every quote. A pre-merge audit defeated the first cut of this
    // section with a fallback gated on `s.zip` — a key the board always sends and
    // this fixture never did — which reproduced the owner's empty board while every
    // assertion stayed green. So the fixture is the BOARD'S OWN: its real starting
    // values (`START`, read out of the screen) put through its REAL `toScenario`.
    // Neither is retyped, so it cannot drift from what a person actually posts.
    const boardMod = await import('../app-v2/src/longterm/scenarioFields.js');
    const boardSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../app-v2/src/longterm/LtScenarioFields.jsx'), 'utf8');
    const startBlock = (boardSrc.match(/export const START = \{[\s\S]*?\n\};/) || [null])[0];
    // A FAILED READ MUST FAIL THE TEST, not quietly leave an empty fixture — that is
    // exactly how this section became vacuous the first time.
    const boardStart = startBlock
      ? new Function('DEFAULT_TERM_YEARS', startBlock.replace('export const START =', 'return') + '\n')(boardMod.DEFAULT_TERM_YEARS)
      : null;
    const boardScenario = boardStart ? boardMod.toScenario(boardStart) : null;
    ok(boardScenario && boardScenario.borrowerType === 'LLC' && boardScenario.zip
      && boardScenario.propertyType && boardScenario.dscr != null && Object.keys(boardScenario).length >= 10,
      `CIT-B0 the board's own opening scenario was READ, not retyped (${boardScenario ? Object.keys(boardScenario).length + ' keys, borrowerType=' + boardScenario.borrowerType : 'PARSE FAILED'})`);

    // ⛔ THE SCREEN'S OUTPUT IS NOT THE CONNECTOR'S INPUT, and the gap is where the
    // second audit found the defect again. `combined-pricer` runs the scenario through
    // `validateScenario` FIRST, which ENRICHES it — the board posts 13 keys and the
    // connector is handed 16 (`state`, `countyFps`, `countyName`, resolved from the ZIP).
    // Pricing the screen's own 13 left a fallback gated on `countyFps` invisible while
    // reproducing the owner's empty board exactly. So the fixture is what the ROUTE
    // hands the vendor, produced by the route's own function rather than described here.
    const routeOf = (sc) => {
      const chk = lpModel.validateScenario(Object.assign({ loan: 375000, fico: 760 }, sc));
      return chk && chk.ok !== false && chk.scenario ? chk.scenario : null;
    };
    const routeScenario = routeOf(boardScenario);
    const addedByRoute = routeScenario ? Object.keys(routeScenario).filter((k) => !(k in (boardScenario || {}))) : [];
    ok(routeScenario && addedByRoute.length > 0,
      `CIT-B0b …and the fixture is what the ROUTE hands the vendor, not what the screen posts (${routeScenario ? Object.keys(routeScenario).length : '?'} keys, ${addedByRoute.length} added by the route: ${addedByRoute.join(', ') || 'NONE — the enrichment is not being exercised'})`);

    const priceBoard = (extra) => {
      try {
        return scenario.buildNexApp(Object.assign({}, routeScenario || boardScenario, { loan: 375000, fico: 760 }, extra),
          reg, { countyKey: 31001 });
      } catch (e) { return { citizenship: 'REFUSED:' + (e && e.code), _refused: (e && e.code) || 'throw' }; }
    };

    // THE OWNER'S OWN CASE, end to end: open the board, press Price, get a quote.
    const boardPriced = priceBoard({});
    ok(!boardPriced._refused && boardPriced.citizenship === 'UsCitizen',
      `CIT-B1 the board's own opening scenario prices instead of being refused (${boardPriced.citizenship})`);

    // NO field may decide the citizenship — swept by REMOVAL over the route's own payload,
    // enrichment keys included. A removal the builder genuinely cannot survive is skipped
    // and COUNTED: a silent mass-skip would empty this assertion without failing it.
    let movedBy = [], skipped = 0;
    for (const k of Object.keys(routeScenario || boardScenario || {})) {
      const without = Object.assign({}, routeScenario || boardScenario, { loan: 375000, fico: 760 });
      delete without[k];
      let got = null;
      try { got = scenario.buildNexApp(without, reg, { countyKey: 31001 }).citizenship; }
      catch (e) { skipped++; }
      if (got != null && got !== boardPriced.citizenship) movedBy.push(k + '->' + got);
    }
    const sweptKeys = Object.keys(routeScenario || boardScenario || {}).length;
    ok(movedBy.length === 0 && skipped < sweptKeys,
      `CIT-B2 …and removing any one field the route sends never moves the citizenship (${sweptKeys} swept, ${skipped} unremovable${movedBy.length ? ', moved by ' + movedBy.join(', ') : ''})`);

    // …AND THE SAME BY VARIATION, which is what removal alone cannot see: a gate on a
    // value rather than a presence (`units > 1`, a particular county) survives a delete
    // sweep untouched. Every combination is built from the screen's OWN option lists and
    // run through the route's OWN enrichment, so each ZIP resolves a different county and
    // a person's real choices are what is exercised — not a shape described here.
    // ⛔ EVERY VALUE THIS MATRIX HOLDS STILL IS A HIDING PLACE, and that is not a
    // hypothesis: an audit defeated the previous version twice over by gating the
    // fallback on `fico` — which was 760 in all 63 assertions in this file — and on
    // `lockDays`, which nothing varied. A guard is only as wide as the space it moves
    // through, so every field the screen can change now moves here, including the
    // numbers. `fico` spans the thin-file band deliberately: a rule keyed on credit
    // quality is exactly the plausible-looking gate somebody would write.
    const ZIPS = ['06001', '07036', '33101', '11211'];
    const FICOS = [660, 690, 760];
    let matrix = 0, matrixMoved = [];
    for (const pt of boardMod.PROPERTY_TYPES) for (const pu of boardMod.PURPOSES)
      for (const bt of boardMod.BORROWER_TYPES) for (const zip of ZIPS)
        for (const fico of FICOS) for (const lockDays of boardMod.LOCK_DAYS)
        for (const flags of [{}, { io: true, escrowWaive: true, fthb: true }]) {
          const sc = Object.assign({}, boardScenario, {
            propertyType: pt.value, purpose: pu.value, borrowerType: bt.value, zip,
            fico, lockDays, termYears: boardMod.LOAN_TERMS[matrix % boardMod.LOAN_TERMS.length].value,
            units: boardMod.unitsFor(pt.value, '1'),
          }, flags);
          const routed = routeOf(sc);
          if (!routed) continue; // a combination the route itself refuses is not this rule's business
          matrix++;
          let got;
          try { got = scenario.buildNexApp(Object.assign({ loan: 375000, fico: 760 }, routed), reg, { countyKey: 31001 }).citizenship; }
          catch (e) { got = 'REFUSED:' + (e && e.code); }
          if (got !== 'UsCitizen') matrixMoved.push([pt.value, pu.value, bt.value, zip].join('/') + '=' + got);
        }
    // AN EXACT COUNT, not a floor. `> 50` was the first cut and it would have survived an
    // enrichment regression that silently dropped three quarters of the combinations —
    // the assertion would still have read as a broad sweep while proving almost nothing.
    const expectMatrix = boardMod.PROPERTY_TYPES.length * boardMod.PURPOSES.length
      * boardMod.BORROWER_TYPES.length * ZIPS.length * FICOS.length * boardMod.LOCK_DAYS.length * 2;
    ok(matrix === expectMatrix && matrixMoved.length === 0,
      `CIT-B3 …across every combination the screen can produce, routed and enriched (${matrix} priced of ${expectMatrix} expected${matrixMoved.length ? ', moved by ' + matrixMoved.slice(0, 4).join(', ') : ''})`);

    // The parked vesting types too — not on the screen today, one edit from being back.
    let boardRefused = [];
    for (const b of boardMod.BORROWER_TYPES.concat(boardMod.BORROWER_TYPES_PARKED)) {
      const r = priceBoard({ borrowerType: b.value });
      if (r._refused || r.citizenship !== 'UsCitizen') boardRefused.push(b.value + '=' + r.citizenship);
    }
    ok(boardRefused.length === 0,
      `CIT-B4 …on every vesting type the screen offers, live or parked${boardRefused.length ? ' (' + boardRefused.join(', ') + ')' : ''}`);


    // CONTROL — the old rule really did refuse the board's own default, so every
    // assertion below is measuring a real change and not agreeing with itself.
    let oldRefused = false;
    try { oldRule({ borrowerType: 'LLC' }); } catch (e) { oldRefused = e.code === 'unknown_citizenship'; }
    ok(oldRefused, 'CIT-0 CONTROL: the old rule refused the board\'s default vesting type ("LLC") outright');

    // The two are separate sets in the OTHER program\'s own registry — read from it
    // rather than retyped here, so this states a fact about the system.
    const vestingTypes = Array.from(lpRegistry.BORROWER_TYPES);
    const citizenships = Array.from(lpRegistry._tokens.CITIZENSHIP);
    const shared = vestingTypes.filter((v) => citizenships.includes(v));
    ok(shared.length === 0,
      `CIT-1 a vesting type is never a citizenship — the two enums share no value (${vestingTypes.length} vs ${citizenships.length}, overlap ${shared.length})`);
    // …and the fact this connector's own refusal actually rested on: not one vesting
    // word is a key in LoanNEX's OWN alias table, which is WHY reading the vesting
    // slot refused the request. CIT-1 alone reads two Lender Price sets and could not
    // fail for any change to this file — this one can.
    const vestingInNexTable = vestingTypes.filter((v) =>
      scenario._internals.CITIZENSHIP_ALIASES[scenario._internals.aliasKey(v)] != null);
    ok(vestingInNexTable.length === 0,
      `CIT-1b …and none of them is a key in LoanNEX's own citizenship table, which is why reading that slot refused the request${vestingInNexTable.length ? ' (' + vestingInNexTable.join(', ') + ')' : ''}`);

    // EVERY vesting type the system recognises now prices, and takes the unstated
    // citizenship. Swept from the registry, so a type added later is covered.
    let refusedTypes = [], wrongCitizenship = [];
    for (const bt of vestingTypes) {
      const built = priceOrCode({ borrowerType: bt });
      if (built._refused) refusedTypes.push(bt + ':' + built._refused);
      else if (built.citizenship !== 'UsCitizen') wrongCitizenship.push(bt + '=' + built.citizenship);
    }
    ok(refusedTypes.length === 0,
      `CIT-2 every vesting type prices instead of being refused (${vestingTypes.length} swept${refusedTypes.length ? ', refused ' + refusedTypes.join(', ') : ''})`);
    ok(wrongCitizenship.length === 0,
      `CIT-2b …and none of them moves the citizenship off the unstated default${wrongCitizenship.length ? ' (' + wrongCitizenship.join(', ') + ')' : ''}`);

    // A vesting slot carrying a word that IS a citizenship must still be ignored.
    // It cannot be satisfied by accident — but it is NOT, on its own, proof that the
    // fallback is gone: a pre-merge audit walked straight past it with a fallback
    // gated on a field this minimal scenario omits. What closes the class is the
    // BOARD-SHAPED pair above (CIT-B2 sweeps every field the screen sends) plus
    // CIT-7/7b on the source. Three independent angles, none load-bearing alone.
    ok(price({ borrowerType: 'Foreign National' }).citizenship === 'UsCitizen',
      'CIT-3 the vesting slot is never read for citizenship, even spelled exactly like one');
    ok(price({ borrowerType: 'LLC', citizenship: 'Foreign National' }).citizenship === 'ForeignNational',
      'CIT-3b …while the citizenship field itself still decides, whatever the vesting is');

    // An explicit citizenship is honoured in every spelling the alias table accepts.
    const spellings = { 'US Citizen': 'UsCitizen', 'us citizen': 'UsCitizen', 'Perm Resident': 'PermanentResidentAlien',
      greencard: 'PermanentResidentAlien', 'Non-Perm Resident': 'NonPermanentResidentAlien',
      'Foreign National': 'ForeignNational', foreign: 'ForeignNational' };
    let badSpelling = [];
    for (const [typed, key] of Object.entries(spellings)) {
      let got = null;
      try { got = price({ borrowerType: 'LLC', citizenship: typed }).citizenship; } catch (e) { got = 'REFUSED:' + e.code; }
      if (got !== key) badSpelling.push(typed + '->' + got);
    }
    ok(badSpelling.length === 0,
      `CIT-4 every accepted citizenship spelling still maps to its registry key${badSpelling.length ? ' (' + badSpelling.join(', ') + ')' : ''}`);

    // THE REFUSAL RULE STANDS. A citizenship nobody recognises is still refused by
    // name — the fix removed a wrong SOURCE, it did not soften the never-default rule.
    const unknownRefused = priceOrCode({ citizenship: 'Martian' })._refused;
    ok(unknownRefused === 'unknown_citizenship',
      'CIT-5 an unrecognised citizenship is still refused rather than defaulted');

    // A control nobody filled in reads as unstated — the same convention condoType
    // and escrow use — so a blank box can never refuse the loan.
    ok(price({ citizenship: '' }).citizenship === 'UsCitizen' && price({}).citizenship === 'UsCitizen',
      'CIT-6 a blank or absent citizenship takes the unstated default IN THE BUILDER (the route refuses a blank earlier, by name)');

    // SOURCE GUARD — comments stripped first, because the fix's own explanation
    // necessarily names the field it stopped reading.
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');
    const code = strip(fixed);
    // ANCHORED INSIDE `buildNexApp`, not on the first match in the file. A decoy
    // `const citizenship = s.citizenship` in some helper above it would otherwise BE
    // what this measures, leaving the real expression unread — found in review.
    const bodyStart = code.indexOf('function buildNexApp(');
    const body = bodyStart >= 0 ? code.slice(bodyStart) : code;
    const expr = (body.match(/const citizenship = [\s\S]*?;\n/) || [''])[0];
    // CLASS-SPECIFIC, not name-specific: the expression may read the citizenship — from
    // the scenario or from the shared profile — and NO other scenario property, under any
    // name. Banning the word `borrowerType` alone was defeated in review by the same
    // category error spelled `borrowerEntity`, and again by `vesting`.
    const strayReads = [...new Set((expr.match(/\bs\.([A-Za-z_$][\w$]*)/g) || []).map((m) => m.slice(2)))]
      .filter((k) => k !== 'citizenship');
    ok(bodyStart >= 0 && /\b(s|prof)\.citizenship\b/.test(expr) && strayReads.length === 0 && !/\bs\s*\[/.test(expr),
      `CIT-7 the citizenship expression reads the citizenship and no other scenario field${strayReads.length ? ' (also reads ' + strayReads.join(', ') + ')' : ''}`);
    // …and a read HOISTED above it, or DESTRUCTURED out of the scenario, cannot slip past
    // a guard anchored on the expression. LoanNEX's recorded body carries no vesting field
    // at all, so "this builder reads none anywhere" is both true and stable — and the
    // citizenship now flows through the shared profile, so that module is scanned too.
    // HONEST LIMIT: a source guard catches the shapes a person actually writes, never a
    // determined obfuscation (`s['borrower' + 'Type']` defeats any regex). What closes the
    // class is CIT-B2/B3 above, which price the real routed payload and cannot be fooled
    // by how the read is spelled.
    const sharedCode = strip(require('fs').readFileSync(
      require.resolve('../src/longterm/pricing/scenario-defaults'), 'utf8'));
    const vestingReads = [];
    for (const [label, src] of [['scenario.js', code], ['scenario-defaults.js', sharedCode]]) {
      for (const m of src.match(/\b[A-Za-z_$][\w$]*\.(borrowerType|borrowerEntity|vesting)\b/g) || []) vestingReads.push(label + ':' + m);
      for (const m of src.match(/\{[^{}]*\b(?:borrowerType|borrowerEntity|vesting)\b[^{}]*\}\s*=/g) || []) vestingReads.push(label + ':destructured');
      for (const m of src.match(/\b[A-Za-z_$][\w$]*\s*\[\s*['"](?:borrowerType|borrowerEntity|vesting)['"]\s*\]/g) || []) vestingReads.push(label + ':' + m);
    }
    ok(vestingReads.length === 0,
      `CIT-7b …and neither the builder nor the shared profile reads a vesting field, however it is spelled${vestingReads.length ? ' (' + vestingReads.join(', ') + ')' : ''}`);
  }

  // ---- one citizenship default, read by both programs ------------------------
  // Owner-directed 2026-09-01, on a control for this: *"we don't need to add the
  // option for this in the frontend… just put it somewhere in the backend to
  // pre-fill as U.S. citizens. The same way the other defaults work."* So it lives
  // in the shared profile beside the prepay term and the reserves. What these
  // assertions protect is not the VALUE — it is that ONE value drives BOTH
  // programs, so the day it moves it cannot move on one side only. That was the
  // real exposure: the answer used to live in a captured JSON blob on the Lender
  // Price side and a hard-coded string on the LoanNEX side, agreeing by luck.
  {
    const shared = require('../src/longterm/pricing/scenario-defaults');
    const lpDyn = (m, k) => { const d = (m && m.dynamicPropertiesMap) || {}; const v = d[k]; return v && typeof v === 'object' ? v.value : v; };
    const baseSc = { purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.30,
      propertyType: 'SingleFamily', zip: '07036', state: 'NJ', countyFps: '34039', prepayMonths: 60 };

    ok(shared.DSCR_PROFILE.citizenship === 'US Citizen',
      `DEF-1 the shared profile states the citizenship default in one place (${JSON.stringify(shared.DSCR_PROFILE.citizenship)})`);
    ok(shared.profileFor({}).citizenship === 'US Citizen'
      && shared.profileFor({ citizenship: '' }).citizenship === 'US Citizen'
      && shared.profileFor({ citizenship: 'Foreign National' }).citizenship === 'Foreign National',
      'DEF-2 …applied when the caller states none or leaves the box blank, and never over one they did state');

    // BOTH programs must resolve THAT value — asserted by MOVING it and requiring
    // both wires to follow. Reading the current value on both sides would pass just
    // as well if each carried its own copy, which is exactly the bug being closed.
    const nexOf = () => scenario.buildNexApp(baseSc, reg, { countyKey: 31001 }).citizenship;
    const lpOf = () => lpDyn(lpModel.buildSearch(baseSc), 'Citizenship');
    const beforeNex = nexOf(), beforeLp = lpOf();
    ok(beforeNex === 'UsCitizen' && beforeLp === 'US Citizen',
      `DEF-3 …and each program renders it in its OWN vendor's spelling (LoanNEX ${beforeNex}, Lender Price ${beforeLp})`);

    const restore = shared.DSCR_PROFILE.citizenship;
    let movedNex, movedLp;
    try {
      shared.DSCR_PROFILE.citizenship = 'Foreign National';
      movedNex = nexOf(); movedLp = lpOf();
    } finally { shared.DSCR_PROFILE.citizenship = restore; }
    ok(movedNex === 'ForeignNational' && movedLp === 'Foreign National',
      `DEF-4 …so moving the ONE default moves BOTH programs together (LoanNEX ${movedNex}, Lender Price ${movedLp}) — neither can be left behind`);
    ok(nexOf() === beforeNex && lpOf() === beforeLp,
      'DEF-5 …and the default is put back, so this section leaves nothing behind for the rest of the suite');

    // DEF-6 — THE FOOT-GUN THE AUDIT FOUND. Lender Price compares this value EXACTLY
    // against its own enum with no alias step, so a default spelled the LoanNEX way
    // (`UsCitizen`) is not a synonym there — it is unknown. The connector now ignores a
    // default it cannot read rather than refusing the quote, but the honest place to catch
    // it is here, at build time: the ONE shared value must be usable by BOTH vendors.
    const lpTokens = lpRegistry._tokens.CITIZENSHIP;
    const nexMappable = scenario._internals.CITIZENSHIP_ALIASES[
      scenario._internals.aliasKey(shared.DSCR_PROFILE.citizenship)] != null;
    ok(lpTokens.has(shared.DSCR_PROFILE.citizenship) && nexMappable,
      `DEF-6 …and the shared default is a value BOTH vendors accept (Lender Price token ${lpTokens.has(shared.DSCR_PROFILE.citizenship)}, LoanNEX mappable ${nexMappable})`);
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
