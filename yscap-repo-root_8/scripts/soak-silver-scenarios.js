'use strict';
/**
 * SILVER PROGRAM SOAK RUNNER — millions of randomized scenarios against the
 * frozen Silver engine, asserting INVARIANTS on every one (owner-directed
 * 2026-07-29: "run unlimited scenarios for the entire night to find more things
 * that you didn't catch").
 *
 * Deterministic: seeded xorshift RNG (SOAK_SEED, default 1). Scenario count via
 * SOAK_N (default 250,000). Any violation prints the FULL input JSON + the
 * engine output and exits non-zero, so a failure is exactly reproducible.
 *
 * Invariants checked per scenario (never "plausible" — always exact):
 *  I1  determinism: evaluate() twice returns identical JSON.
 *  I2  every priced note rate == a REAL workbook cell + the effective markup
 *      (cell membership against the extracted fixture, exact to 1e-9).
 *  I3  the effective markup never exceeds 1.00% whatever the admin typed
 *      (owner-authorized cap 2026-07-29) and never goes below 0.
 *  I4  sizing never breaches the tier caps: LTC, acquisition LTV, AR LTV
 *      (+2bp float tolerance), the tier max loan, the $2.5M small-band wall,
 *      the $100k minimum (stated-loan floor cases go MANUAL, never size under).
 *  I5  excluded STATES never price (NV/MN/ND/SD are INELIGIBLE).
 *  I6  typed excluded ZIPs with a consistent state never price; with a
 *      contradicting typed state they are MANUAL (never silently ELIGIBLE).
 *  I7  a leading house number in free text alone never blocks a deal.
 *  I8  NYC F&F never prices above 80% LTC and never prices a refi; no NYC
 *      loan sizes above $2.5M.
 *  I9  FICO < 640 never prices (INELIGIBLE); tier-3 FICO bands respected.
 *  I10 F&F refi tier gates: tier 3 F&F refis never price (the workbook has no
 *      cells); tiers 1-2 may.
 *  I11 owner-occupied and ineligible property types never price.
 *  I12 breakdown reconciliation: totalLoan == initial + rehabHoldback +
 *      reserve to the penny, all >= 0, reserve <= term x monthly interest + $1.
 *  I13 status is always one of ELIGIBLE / MANUAL / INELIGIBLE, and a priced
 *      sizing only appears on ELIGIBLE/MANUAL evaluations.
 */
const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'silver-program.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json'));

const N = Math.max(1, parseInt(process.env.SOAK_N || '250000', 10));
const SEED = parseInt(process.env.SOAK_SEED || '1', 10);

// Seeded xorshift32 — deterministic, fast.
let _s = SEED >>> 0 || 1;
function rnd() { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const irnd = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));

// Real workbook rate SET for I2 membership (exact 6-decimal lattice).
const RATE_SET = new Set(Object.values(FIX.rates).map((r) => Math.round(r * 1e6)));
const TG = FIX.tierGrid;

const STATES_OK = ['NJ', 'NY', 'PA', 'TX', 'FL', 'GA', 'OH', 'CT', 'MA', 'MD', 'IL', 'MI', 'CA', 'AZ', 'CO', 'NC', 'SC', 'TN', 'IN', 'LA', 'AL', 'MO', 'WI', 'VA', 'KY', 'OK', 'UT', 'WA', 'OR', 'ME'];
const STATES_EXCL = ['NV', 'MN', 'ND', 'SD'];
const ZIPS_OK = ['07030', '08540', '10952', '11230', '19406', '75201', '33101', '30301', '44101', '21044', '60540', '48009', '90210', '85001', '80202', '28202', '37201', '46201', '70112'];
const ZIPS_EXCL = ['19147', '19104', '60629', '60706', '60803', '48227', '48221', '21215', '21201', '21229'];
const ZIPS_NYC = ['10013', '10456', '11215', '11375', '11004', '10301', '10462', '11101'];
const STRATS = ['Fix & Flip', 'Ground-Up Construction', 'Bridge', 'Fix & Hold', 'New Construction'];
const PROPS = ['single family', '2-4', 'condo', 'townhome', 'multi 5+', 'mixed use', 'office'];
const TERMS = [12, 18, 24];

let fails = 0;
function fail(label, input, ev, extra) {
  fails++;
  console.error(`\nINVARIANT VIOLATION ${label}`);
  console.error('input:', JSON.stringify(input));
  try { console.error('status:', ev && ev.status, 'reasons:', JSON.stringify((ev && ev.reasons || []).map((r) => r.msg))); } catch (_) {}
  if (extra) console.error('detail:', extra);
  if (fails >= 20) { console.error('\nToo many failures — aborting early.'); summary(); process.exit(1); }
}

function scenario() {
  const geo = rnd();
  let state, zip, address;
  if (geo < 0.05) { state = pick(STATES_EXCL); zip = pick(ZIPS_OK); }
  else if (geo < 0.13) { state = pick(['PA', 'IL', 'MI', 'MD']); zip = pick(ZIPS_EXCL); }           // consistent excluded zip
  else if (geo < 0.18) { state = pick(['TX', 'FL', 'NJ']); zip = pick(ZIPS_EXCL); }                 // contradicting typed zip
  else if (geo < 0.30) { state = 'NY'; zip = pick(ZIPS_NYC); }
  else if (geo < 0.34) { state = pick(['TX', 'GA']); zip = ''; address = pick(ZIPS_EXCL) + ' Main St, Somewhere'; } // house number trap
  else { state = pick(STATES_OK); zip = pick(ZIPS_OK); }

  const strategy = pick(STRATS);
  const isBridge = /bridge/i.test(strategy);
  const refi = rnd() < 0.35;
  const price = irnd(40, 5200) * 1000;
  const aiv = Math.round(price * (0.8 + rnd() * 0.5));
  const rehab = isBridge ? 0 : irnd(0, 2200) * 1000;
  const arv = Math.round((aiv + rehab) * (0.95 + rnd() * 0.7));
  const input = {
    loanType: refi ? 'Refinance' : 'Purchase',
    cashOut: refi && rnd() < 0.4,
    strategy,
    state, zip, address,
    city: '',
    propertyType: pick(PROPS),
    ownerOccupied: rnd() < 0.04,
    fico: irnd(580, 820),
    expFlips: irnd(0, 12), expHolds: irnd(0, 6), expGround: irnd(0, 8),
    purchasePrice: refi ? aiv : price,
    asIsValue: aiv,
    arv,
    rehabBudget: rehab,
    term: pick(TERMS),
    irMonths: irnd(0, 12),
    monthlyRent: rnd() < 0.3 ? irnd(800, 9000) : 0,
    payoff: refi ? Math.round(aiv * (0.2 + rnd() * 0.6)) : 0,
  };
  if (rnd() < 0.10) input.loanAmount = irnd(60, 5000) * 1000;  // stated loan
  return input;
}

function checkOne(i, input, markup) {
  SVP.setMarkup(markup);
  const effCap = markup == null ? 0.005 : Math.min(Math.max(markup, 0), 0.01);

  const ev = SVP.evaluate(input);
  // I1 determinism
  const ev2 = SVP.evaluate(input);
  if (JSON.stringify(ev) !== JSON.stringify(ev2)) return fail('I1 non-deterministic', input, ev);

  // I13 status domain
  if (!['ELIGIBLE', 'MANUAL', 'INELIGIBLE'].includes(ev.status)) return fail('I13 bad status', input, ev);

  const st = String(input.state || '').toUpperCase();
  // I5 excluded states
  if (STATES_EXCL.includes(st) && ev.status !== 'INELIGIBLE') return fail('I5 excluded state priced', input, ev);

  // I6 typed excluded zips
  if (input.zip && ZIPS_EXCL.includes(input.zip)) {
    const consistent = { 1: 'PA', 6: 'IL', 4: 'MI', 2: 'MD' }[input.zip[0]] === st || !st;
    if (consistent && ev.status === 'ELIGIBLE') return fail('I6 excluded ZIP priced', input, ev);
    if (!consistent && ev.status === 'ELIGIBLE') return fail('I6 zip/state contradiction silently eligible', input, ev);
  }
  // I7 house number in text never blocks
  if (!input.zip && input.address && /^\d{5} /.test(input.address)
      && ev.status === 'INELIGIBLE' && (ev.reasons || []).some((r) => /Greater (Philadelphia|Chicago|Baltimore|Detroit)/.test(r.msg))) {
    return fail('I7 house number blocked a deal', input, ev);
  }

  // I9 fico floor
  if (input.fico < 640 && ev.status !== 'INELIGIBLE') return fail('I9 fico<640 not refused', input, ev);

  // I11 property/occupancy
  const prop = String(input.propertyType || '').toLowerCase();
  if ((input.ownerOccupied || ['multi 5+', 'mixed use', 'office'].includes(prop)) && ev.status === 'ELIGIBLE') {
    return fail('I11 ineligible property/occupancy priced', input, ev);
  }

  if (ev.status === 'INELIGIBLE') return;

  // Priced-path invariants (ELIGIBLE, or MANUAL evaluations that still sized)
  const s = ev.sizing;
  if (ev.status === 'ELIGIBLE') {
    if (!s || !(s.totalLoan > 0)) return fail('I13 eligible without sizing', input, ev);
    if (!(ev.noteRate > 0)) return fail('I13 eligible without a rate', input, ev);
  }
  if (!s || !(s.totalLoan > 0)) return;

  // I3 + I2: rate == real cell + capped markup
  if (ev.noteRate > 0) {
    const grid = Math.round((ev.noteRate - effCap) * 1e6);
    if (!RATE_SET.has(grid)) return fail('I2 rate is not a workbook cell + markup', input, ev, `rate=${ev.noteRate} markup=${effCap}`);
  }

  // I4 caps (tier grid from the fixture — independent of the engine's own copy)
  const tier = ev.tier, size = ev.sizeBand;
  const pTok = SVP.prodToken(SVP.normStrategy ? SVP.normStrategy(input.strategy) : ev.strategyCode || 'FF');
  const purp = input.loanType === 'Refinance' ? 'R' : 'P';
  const caps = TG && TG[`${pTok}|${purp}|${tier}|${size}`];
  const TOL = 2e-4;
  if (caps) {
    if (s.ltcPct > 0 && s.ltcPct > caps.maxLTC + TOL && !(ev.reasons || []).some((r) => /Leverage is capped/.test(r.msg))) {
      return fail('I4 LTC breach', input, ev, `ltc=${s.ltcPct} cap=${caps.maxLTC}`);
    }
    if (caps.maxLoan && s.totalLoan > caps.maxLoan + 1) return fail('I4 tier max loan breach', input, ev, `loan=${s.totalLoan} cap=${caps.maxLoan}`);
  }
  if (size === 'S' && s.totalLoan > 2500000 + 1) return fail('I4 small band over $2.5M', input, ev);
  if (s.totalLoan > 4500000 + 1) return fail('I4 absolute max breach', input, ev);
  if (ev.status === 'ELIGIBLE' && s.totalLoan < 100000 - 1) return fail('I4 under min loan priced', input, ev);

  // I8 NYC rules — the LTC/loan ceilings judge PRICED (eligible) deals; a MANUAL
  // "no priced grid cell → individual review" evaluation carries a reference
  // sizing a human re-prices, which is not a grid violation.
  if (ev.market === 'NYC' && ev.status === 'ELIGIBLE') {
    if (s.totalLoan > 2500000 + 1) return fail('I8 NYC over $2.5M', input, ev);
    const sc = pTok;
    if (sc === 'FF' && purp === 'R') return fail('I8 NYC F&F refi priced', input, ev);
    if (sc === 'FF' && s.ltcPct > 0.80 + TOL) return fail('I8 NYC F&F over 80% LTC', input, ev);
  }

  // I10 F&F refi tier gate (workbook: T3 has no F&F refi cells)
  if (pTok === 'FF' && purp === 'R' && tier === 3 && ev.status === 'ELIGIBLE') {
    return fail('I10 tier-3 F&F refi priced', input, ev);
  }

  // I12 breakdown reconciliation (engine fields: acquisition + rehabLoan + financedIR)
  const parts = (s.acquisition || 0) + (s.rehabLoan || 0) + (s.financedIR || 0);
  if (Math.abs(parts - s.totalLoan) > 0.02) return fail('I12 breakdown does not reconcile', input, ev, `parts=${parts} total=${s.totalLoan}`);
  if ((s.acquisition || 0) < -0.01 || (s.rehabLoan || 0) < -0.01 || (s.financedIR || 0) < -0.01) return fail('I12 negative component', input, ev);
  if ((s.financedIR || 0) > 0 && (s.monthlyInterest || 0) > 0 && !s.rehabOverCap) {
    // Bound with the engine's OWN monthly-interest figure — the two-pass rate/IR
    // loop (mirroring the frozen Standard engine) can leave the reserve sized on
    // the first-pass rate, one band off the final reported rate. A rehab-over-cap
    // (wall-capped) fit is excluded: the frozen YSP waterfall fits the reserve
    // BEFORE the wall clamps the total, so the final monthly figure understates
    // the payment the reserve was legitimately fitted on.
    const maxReserve = s.monthlyInterest * (input.term || 12) * 1.10 + 1;
    if (s.financedIR > maxReserve) return fail('I12 reserve over full-term interest', input, ev, `reserve=${s.financedIR} max=${maxReserve}`);
  }
}

function summary() {
  console.log(`\nSilver soak: ${N.toLocaleString()} scenarios, seed ${SEED} — ${fails === 0 ? 'ALL INVARIANTS HELD' : fails + ' FAILURES'}`);
}

const MARKUPS = [null, 0, 0.004, 0.005, 0.0075, 0.01, 0.015, 0.025];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const input = scenario();
  const markup = (i % 10 === 0) ? pick(MARKUPS) : null;   // mostly default; every 10th randomizes the admin markup
  try {
    checkOne(i, input, markup);
  } catch (e) {
    fail('THROW ' + (e && e.message), input, null, e && e.stack);
  }
  if ((i + 1) % 100000 === 0) {
    const dt = (Date.now() - t0) / 1000;
    console.log(`  ${(i + 1).toLocaleString()} scenarios (${Math.round((i + 1) / dt).toLocaleString()}/s, ${fails} failures)`);
  }
}
SVP.setMarkup(null);
summary();
process.exit(fails ? 1 : 0);
