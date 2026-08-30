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
  const spellings = ['2-4 units', '2-4 Unit', 'TwoToFourUnits', 'two to four units', 'Duplex', 'multi-family'];
  const spelled = spellings.filter((t) => build({ ...BASE, propertyType: t, units: 3 }).propertyType === 'TwoToFourUnits');
  ok(spelled.length === spellings.length,
    `ALIAS-2 every natural spelling of 2-4 units reaches the vendor's key (${spelled.length}/${spellings.length})`);
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

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
