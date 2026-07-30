'use strict';
/**
 * Silver Program engine verification battery (pure — no DB, no network).
 *
 * The Silver Program (EMCAP note buyer) engine is verified against the EMCAP
 * "RTL Seller Pricing & Eligibility Tool v1" workbook (June 2026 guideline
 * version) in three independent ways:
 *
 *  (1) RATE PARITY — scripts/fixtures/emcap-pricing-tool-v1.json holds every
 *      one of the workbook's 1,555 priced grid cells (9-part key → rate),
 *      extracted straight from the workbook's hidden Engine tab. The engine's
 *      compact RATE_BLOCKS encoding must reconstruct EXACTLY that set: same
 *      keys, same rates, nothing extra, nothing missing.
 *
 *  (2) FORMULA PARITY over a large random sweep — the workbook's classifier
 *      formulas (tier base K11/K12, AR-LTV band K17, FICO band K18, LTC band
 *      K19, rate key K20, tier-grid lookups, term gate K35, value-add K40,
 *      DSCR K37, cash-out K38, geography K29) are TRANSCRIBED here from the
 *      sheet itself — independently of the engine source — and compared to
 *      the engine's primitives across thousands of seeded random scenarios.
 *
 *  (3) END-TO-END evaluate() behavior — the workbook's own default example,
 *      geography exclusions, NYC limits, term gates, the value-add rule,
 *      DSCR/cash-out gates, GC-only caps, interest-reserve mechanics
 *      (Standard-style: financed, in cost basis, capped at the full term),
 *      and the frozen-engine guarantee (Standard + Gold untouched).
 *
 * Run: node scripts/test-silver-program.js
 */

const assert = require('assert');
const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'silver-program.js'));
const YSP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'standard-program.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json'));

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed++;
}

/* ------------------------------------------------------------------ *
 * (1) RATE PARITY — reconstruct every cell from the engine's blocks
 * ------------------------------------------------------------------ */
(function ratesMatchWorkbook() {
  const C = SVP.constants;
  const recon = {};
  Object.keys(C.RATE_BLOCKS).forEach((bk) => {
    const [mkt, size, prod, purp, term, tierTok] = bk.split('|');
    const tier = Number(tierTok.slice(1));
    const fl = tier === 3 ? C.FICO_BANDS_3 : C.FICO_BANDS_12;
    C.AR_BANDS.forEach((ar, i) => {
      fl.forEach((f, j) => {
        C.LTC_BANDS.forEach((l, k) => {
          const v = C.RATE_BLOCKS[bk][(i * 3 + j) * 6 + k];
          if (v > 0) recon[[mkt, size, prod, purp, term, tierTok, ar, f, l].join('|')] = Math.round(v * 125) / 1e6;
        });
      });
    });
  });
  const fixKeys = Object.keys(FIX.rates);
  ok(fixKeys.length === 1555, `fixture has 1555 cells (got ${fixKeys.length})`);
  ok(Object.keys(recon).length === 1555, `engine reconstructs 1555 cells (got ${Object.keys(recon).length})`);
  for (const k of fixKeys) {
    ok(recon[k] != null, `engine has workbook cell ${k}`);
    ok(Math.abs(recon[k] - FIX.rates[k]) < 1e-9, `rate matches for ${k}: engine ${recon[k]} vs workbook ${FIX.rates[k]}`);
  }
  // gridRate() itself must agree with the reconstruction for every cell
  for (const k of fixKeys) {
    const [mkt, size, prod, purp, term, tierTok, ar, f, l] = k.split('|');
    const g = SVP.gridRate(mkt, size, prod, purp, term, Number(tierTok.slice(1)), ar, f, l);
    ok(g != null && Math.abs(g - FIX.rates[k]) < 1e-9, `gridRate agrees for ${k}`);
  }
  console.log('  (1) rate parity: all 1,555 workbook cells match exactly');
})();

/* ------------------------------------------------------------------ *
 * (2) FORMULA PARITY — workbook formulas transcribed independently
 * ------------------------------------------------------------------ */
// Transcriptions of the Pricing Tool's own cell formulas (column K):
const wb = {
  // K6: size token
  sizeToken: (loan) => (loan <= 2500000 ? 'S' : 'L'),
  // K11 + K12: tier from comps, size band and GC-only
  tier: (sizeTok, comps, gcOnly) => {
    const base = sizeTok === 'S' ? (comps >= 3 ? 1 : comps >= 1 ? 2 : 3)
                                 : (comps >= 5 ? 1 : comps >= 2 ? 2 : 3);
    if (gcOnly) return sizeTok === 'S' ? Math.max(base, 2) : 3;
    return base;
  },
  // K17: AR-LTV band
  arBand: (r) => (!(r > 0) ? null : r <= 0.6499 ? '<64.99%' : r <= 0.70 ? '65.00%-70.00%' : r <= 0.75 ? '70.01%-75.00%' : null),
  // K18: FICO band (tier 3 has its own banding)
  ficoBand: (tier, fico) => {
    if (!(fico > 0)) return null;
    if (tier === 3) return fico >= 700 ? 'FICO 700+' : fico >= 680 ? 'FICO 680-699' : fico >= 640 ? 'FICO 640-679' : null;
    return fico >= 700 ? 'FICO 700+' : fico >= 660 ? 'FICO 660-699' : fico >= 640 ? 'FICO 640-659' : null;
  },
  // K19: LTC band
  ltcBand: (r) => (!(r > 0) ? null : r <= 0.7499 ? '<74.99%' : r <= 0.80 ? '75.00%-80.00%' : r <= 0.85 ? '80.01%-85.00%'
    : r <= 0.875 ? '85.01%-87.50%' : r <= 0.8999 ? '87.51%-89.99%' : r <= 0.925 ? '90.00%-92.50%' : null),
  // K35: term gate — fails only for the F&F product with a budget at/below the threshold
  termFail: (termTok, prodTok, budget) => {
    if (termTok === '12') return false;
    if (termTok === '18') return !(prodTok !== 'FF' || budget > 100000);
    return !(prodTok !== 'FF' || budget > 200000);
  },
  // K29: geography (tool checks 191/606/607/608; commentary adds the rest — engine carries the full list)
  geoZipFail: (zip3) => ['191', '606', '607', '608', '481', '482', '483'].indexOf(zip3) > -1,
  // K37: DSCR fail (HOLD exit, DSCR > 0 and < 1)
  dscrFail: (exit, dscr) => exit === 'HOLD' && dscr > 0 && dscr < 1,
  // K38: cash-out fail (refi, cash-out > 50% of profit)
  cashoutFail: (purp, cashOut, profit) => purp === 'R' && cashOut > 0 && profit > 0 && cashOut > 0.5 * profit,
  // K40: value-add fail (LTC must exceed AR-LTV ⇔ ARV must exceed cost basis)
  valueAddFail: (arltv, ltc) => arltv > 0 && ltc > 0 && ltc <= arltv,
};

(function formulaSweep() {
  // seeded PRNG (mulberry32) — deterministic across runs
  let seed = 0xE3C4A9;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const MKTS = ['STD', 'NYC'], PRODS = ['FF', 'GUC', 'BR'], PURPS = ['P', 'R'], TERMS = ['12', '18', '24'];
  let rateChecks = 0, naChecks = 0;
  for (let i = 0; i < 12000; i++) {
    const loan = Math.round(100000 + rnd() * 4400000);
    const comps = Math.floor(rnd() * 8);
    const gcOnly = rnd() < 0.15;
    const fico = 600 + Math.floor(rnd() * 220);
    const ar = 0.4 + rnd() * 0.45;      // 0.40 – 0.85
    const ltc = 0.5 + rnd() * 0.5;      // 0.50 – 1.00
    const mkt = pick(MKTS), prod = pick(PRODS), purp = pick(PURPS), term = pick(TERMS);

    const sizeTok = wb.sizeToken(loan);
    const tier = wb.tier(sizeTok, comps, gcOnly);
    ok(SVP.tierOf(sizeTok, comps, gcOnly) === tier, `tier parity @${i}: size ${sizeTok} comps ${comps} gc ${gcOnly}`);
    ok((SVP.arBand(ar) || null) === wb.arBand(ar), `AR band parity @${i} (${ar})`);
    ok((SVP.ltcBand(ltc) || null) === wb.ltcBand(ltc), `LTC band parity @${i} (${ltc})`);
    ok((SVP.ficoBand(tier, fico) || null) === wb.ficoBand(tier, fico), `FICO band parity @${i} (T${tier} ${fico})`);

    // rate lookup parity vs the raw workbook fixture
    const arB = wb.arBand(ar), fB = wb.ficoBand(tier, fico), lB = wb.ltcBand(ltc);
    const key = [mkt, sizeTok, prod, purp, term, 'T' + tier, arB, fB, lB].join('|');
    const expected = (arB && fB && lB) ? (FIX.rates[key] != null ? FIX.rates[key] : null) : null;
    const got = SVP.gridRate(mkt, sizeTok, prod, purp, term, tier, arB, fB, lB);
    if (expected == null) { ok(got == null, `NA cell stays NA @${i} ${key}`); naChecks++; }
    else { ok(got != null && Math.abs(got - expected) < 1e-9, `rate parity @${i} ${key}`); rateChecks++; }

  }
  // term-gate parity (explicit sweep over the boundary)
  [['12', 'FF', 50000, false], ['18', 'FF', 100000, true], ['18', 'FF', 100001, false], ['18', 'GUC', 0, false],
   ['18', 'BR', 0, false], ['24', 'FF', 200000, true], ['24', 'FF', 200001, false], ['24', 'GUC', 0, false]]
    .forEach(([t, p, b, fail]) => ok(wb.termFail(t, p, b) === fail, `workbook term gate ${t}/${p}/${b}`));
  console.log(`  (2) formula sweep: 12,000 scenarios — tier/AR/LTC/FICO bands + ${rateChecks} priced-cell and ${naChecks} NA-cell rate lookups all match`);
})();

/* ------------------------------------------------------------------ *
 * (3) END-TO-END evaluate() behavior
 * ------------------------------------------------------------------ */
(function workbookDefaultExample() {
  // The workbook's own worked example: FF purchase, 12 mo, 3 comps (T1), FICO
  // 720, loan $500k, purchase $400k, rehab $150k, ARV $750k → grid 8.625%,
  // ELIGIBLE, bands 65-70 / FICO 700+ / 90-92.5.
  const g = SVP.gridRate('STD', 'S', 'FF', 'P', '12', 1, '65.00%-70.00%', 'FICO 700+', '90.00%-92.50%');
  ok(Math.abs(g - 0.08625) < 1e-9, 'workbook default cell = 8.625%');
  // Same profile through evaluate() (sizes to the program max; the achieved
  // bands land in the same cells the tool classifies).
  const ev = SVP.evaluate({ loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720,
    expFlips: 3, purchasePrice: 400000, asIsValue: 400000, arv: 750000, rehabBudget: 150000, term: 12 });
  ok(ev.status === 'ELIGIBLE', 'workbook example is eligible');
  ok(ev.tier === 1 && ev.sizeBand === 'S' && ev.market === 'STD', 'workbook example classifies T1/S/STD');
  ok(ev.noteRate > 0 && ev.sizing.totalLoan > 0, 'workbook example prices and sizes');
  ok(Math.abs(ev.noteRate - (SVP.gridRate('STD', 'S', 'FF', 'P', '12', 1,
    SVP.arBand(ev.sizing.totalLoan / 750000), 'FICO 700+', SVP.ltcBand(ev.sizing.ltcPct)) + SVP.constants.MARKUP)) < 1e-9,
    'note rate = grid rate at achieved bands + markup');
})();

(function geography() {
  const base = { loanType: 'Purchase', strategy: 'Fix & Flip', fico: 720, expFlips: 3,
    purchasePrice: 400000, asIsValue: 400000, arv: 750000, rehabBudget: 150000, term: 12 };
  // hard ZIP exclusions
  [['19147', 'PA'], ['60629', 'IL'], ['60706', 'IL'], ['60803', 'IL'], ['48227', 'MI'], ['21215', 'MD']].forEach(([zip, st]) => {
    const ev = SVP.evaluate(Object.assign({}, base, { zip, state: st }));
    ok(ev.status === 'INELIGIBLE', `ZIP ${zip} is ineligible`);
  });
  // excluded states
  ['NV', 'MN', 'ND', 'SD'].forEach((st) => {
    const ev = SVP.evaluate(Object.assign({}, base, { state: st, zip: '89101' }));
    ok(ev.status === 'INELIGIBLE', `state ${st} is ineligible`);
  });
  // city-name-only match (no ZIP) → manual review, not a hard decline
  const evCity = SVP.evaluate(Object.assign({}, base, { state: 'IL', city: 'Chicago' }));
  ok(evCity.status === 'MANUAL', 'city-only Chicago (no ZIP) routes to manual review');
  // TYPED excluded ZIP + a TYPED state that contradicts it: two typed fields
  // disagreeing is a data problem, never priced silently (re-audit 2026-07-30, 1b-i).
  [['21215', 'TX'], ['60629', 'TX'], ['19147', 'NJ']].forEach(([zip, st]) => {
    const ev = SVP.evaluate(Object.assign({}, base, { zip, state: st }));
    ok(ev.status === 'MANUAL' && ev.reasons.some(r => /doesn't match that ZIP/.test(r.msg)),
      `typed excluded ZIP ${zip} + contradicting state ${st} routes to manual review`);
  });
  // …but a TEXT-parsed 5-digit group that contradicts the state is a house number
  // ("60629 Main St, Dallas") and must still price (the original audit repro).
  const evHouseNo = SVP.evaluate(Object.assign({}, base, { state: 'TX', address: '60629 Main St, Dallas' }));
  ok(evHouseNo.status === 'ELIGIBLE', 'a leading house number in free text never blocks a deal');
  // a good ZIP is decisive even with a scary city name (Chicago Heights-style)
  const evGood = SVP.evaluate(Object.assign({}, base, { state: 'IL', city: 'Naperville', zip: '60540' }));
  ok(evGood.status === 'ELIGIBLE', 'a non-excluded IL ZIP prices normally');
  // Indiana / Louisiana are ALLOWED on Silver (EMCAP does not exclude them —
  // deliberate difference from the Standard program).
  ['IN', 'LA'].forEach((st) => {
    const ev = SVP.evaluate(Object.assign({}, base, { state: st, zip: st === 'IN' ? '46201' : '70112' }));
    ok(ev.status === 'ELIGIBLE', `${st} is allowed on Silver (EMCAP list only)`);
  });
})();

(function nycLimits() {
  const base = { strategy: 'Fix & Flip', fico: 720, expFlips: 5, term: 12 };
  // NYC F&F refi: no priced cells → explicit ineligible reason
  const evR = SVP.evaluate(Object.assign({}, base, { loanType: 'Refinance', state: 'NY', zip: '11215',
    asIsValue: 500000, arv: 800000, rehabBudget: 100000 }));
  ok(evR.status === 'INELIGIBLE' && evR.reasons.some(r => /NYC/.test(r.msg)), 'NYC F&F refi is ineligible');
  // NYC purchase: the grid only prices F&F up to 80% LTC (FICO 700+), so the
  // engine steps leverage down to the max the grid actually prices.
  const evP = SVP.evaluate(Object.assign({}, base, { loanType: 'Purchase', state: 'NY', zip: '11215',
    purchasePrice: 500000, asIsValue: 500000, arv: 900000, rehabBudget: 150000 }));
  ok(evP.status === 'ELIGIBLE' && evP.market === 'NYC' && evP.noteRate > 0, 'NYC F&F purchase prices on the NYC grid');
  ok(evP.sizing.ltcPct <= 0.80 + 1e-6, 'NYC F&F leverage steps down to the 80% LTC the grid prices');
  ok(evP.reasons.some(r => /Leverage is capped/.test(r.msg)), 'the step-down is explained in the reasons');
  // NYC + FICO below 700: the grid has no cells for that band → individual review
  const evLowF = SVP.evaluate(Object.assign({}, base, { loanType: 'Purchase', state: 'NY', zip: '11215', fico: 680,
    purchasePrice: 500000, asIsValue: 500000, arv: 900000, rehabBudget: 150000 }));
  ok(evLowF.status === 'MANUAL' && evLowF.reasons.some(r => /individual review/.test(r.msg)), 'NYC FICO under 700 goes to individual review (no priced cells)');
  // NYC large loan (stated) → ineligible
  const evL = SVP.evaluate(Object.assign({}, base, { loanType: 'Purchase', state: 'NY', zip: '10013', loanAmount: 3000000,
    purchasePrice: 4000000, asIsValue: 4000000, arv: 6500000, rehabBudget: 900000 }));
  ok(evL.reasons.some(r => /NYC/.test(r.msg) && /2,500,000/.test(r.msg)), 'NYC loans over $2.5M are refused');
})();

(function termGates() {
  const base = { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720, expFlips: 3,
    purchasePrice: 400000, asIsValue: 400000, arv: 750000 };
  const ev18small = SVP.evaluate(Object.assign({}, base, { rehabBudget: 90000, term: 18, arv: 600000 }));
  ok(ev18small.status === 'INELIGIBLE' && ev18small.reasons.some(r => /18-month/.test(r.msg)), '18-mo F&F needs >$100k budget');
  const ev18ok = SVP.evaluate(Object.assign({}, base, { rehabBudget: 150000, term: 18 }));
  ok(ev18ok.status === 'ELIGIBLE', '18-mo F&F with $150k budget is fine');
  const ev24small = SVP.evaluate(Object.assign({}, base, { rehabBudget: 150000, term: 24 }));
  ok(ev24small.status === 'INELIGIBLE' && ev24small.reasons.some(r => /24-month/.test(r.msg)), '24-mo F&F needs >$200k budget');
  const evGuc18 = SVP.evaluate(Object.assign({}, base, { strategy: 'Ground-Up Construction', expGround: 3, rehabBudget: 90000, term: 18, arv: 900000 }));
  ok(!evGuc18.reasons.some(r => /18-month/.test(r.msg)), 'GUC has no 18-mo budget gate');
  const ev30 = SVP.evaluate(Object.assign({}, base, { rehabBudget: 250000, term: 30, arv: 900000 }));
  ok(ev30.reasons.some(r => r.level === 'MANUAL' && /24 months/.test(r.msg)), 'terms over 24 months go to manual review');
})();

(function valueAddGate() {
  const base = { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720, expFlips: 3,
    purchasePrice: 400000, asIsValue: 400000, rehabBudget: 150000, term: 12 };
  const evEq = SVP.evaluate(Object.assign({}, base, { arv: 550000 }));   // ARV == basis
  ok(evEq.status === 'INELIGIBLE' && evEq.reasons.some(r => /value-add/.test(r.msg)), 'ARV equal to cost basis fails (value-add required)');
  const evShort = SVP.evaluate(Object.assign({}, base, { arv: 500000 }));
  ok(evShort.status === 'INELIGIBLE', 'ARV below cost basis fails');
  const evOk = SVP.evaluate(Object.assign({}, base, { arv: 551000 }));
  ok(evOk.status !== 'INELIGIBLE', 'ARV just above cost basis passes the value-add gate');
  // Bridge is exempt (stabilized, sized on as-is)
  const evBr = SVP.evaluate({ loanType: 'Purchase', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 720, expFlips: 3,
    purchasePrice: 400000, asIsValue: 400000, arv: 400000, term: 12 });
  ok(!evBr.reasons.some(r => /value-add/.test(r.msg)), 'bridge has no value-add gate');
})();

(function dscrAndCashout() {
  const hold = { loanType: 'Purchase', strategy: 'Fix & Hold', state: 'NJ', zip: '07030', fico: 720, expFlips: 3,
    purchasePrice: 400000, asIsValue: 400000, arv: 750000, rehabBudget: 150000, term: 12 };
  const evNoRent = SVP.evaluate(hold);
  ok(evNoRent.status === 'ELIGIBLE', 'hold exit with unknown rent is not DSCR-gated');
  const evBadRent = SVP.evaluate(Object.assign({}, hold, { monthlyRent: 1000 }));
  ok(evBadRent.status === 'INELIGIBLE' && evBadRent.reasons.some(r => /DSCR/.test(r.msg)), 'hold exit with DSCR < 1 fails');
  const evDscr = SVP.evaluate(Object.assign({}, hold, { dscr: 1.15 }));
  ok(evDscr.status === 'ELIGIBLE', 'explicit DSCR 1.15 passes');
  // cash-out cap: proceeds ≤ 50% of projected profit
  const refi = { loanType: 'Refinance', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720, expFlips: 3,
    asIsValue: 400000, arv: 700000, rehabBudget: 100000, term: 12, cashOut: true };
  const evCoOk = SVP.evaluate(Object.assign({}, refi, { cashOutAmount: 90000 }));   // profit 200k → cap 100k
  ok(!evCoOk.reasons.some(r => /Cash-out/.test(r.msg)), 'cash-out under 50% of profit passes');
  const evCoBad = SVP.evaluate(Object.assign({}, refi, { cashOutAmount: 120000 }));
  ok(evCoBad.status === 'INELIGIBLE' && evCoBad.reasons.some(r => /Cash-out/.test(r.msg)), 'cash-out over 50% of profit fails');
})();

(function gcOnlyAndTiers() {
  const base = { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720,
    purchasePrice: 400000, asIsValue: 400000, arv: 751000, rehabBudget: 150000, term: 12 };
  ok(SVP.evaluate(Object.assign({}, base, { expFlips: 5 })).tier === 1, '5 comps → T1 (small)');
  ok(SVP.evaluate(Object.assign({}, base, { expFlips: 5, gcOnlyExperience: true })).tier === 2, 'GC-only caps small loans at T2');
  ok(SVP.evaluate(Object.assign({}, base, { expFlips: 0 })).tier === 3, '0 comps → T3');
  // first-time investor F&F refi is ineligible (tier grid row NA)
  const evT3refi = SVP.evaluate({ loanType: 'Refinance', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720,
    asIsValue: 400000, arv: 700000, rehabBudget: 100000, term: 12 });
  ok(evT3refi.status === 'INELIGIBLE' && evT3refi.reasons.some(r => /first-time/.test(r.msg)), 'T3 F&F refi is ineligible');
  // FICO floors
  const evLowFico = SVP.evaluate(Object.assign({}, base, { expFlips: 3, fico: 630 }));
  ok(evLowFico.status === 'INELIGIBLE', 'FICO under 640 is ineligible');
  const evWaiver = SVP.evaluate(Object.assign({}, base, { expFlips: 0, fico: 660 }));   // T3 min 680
  ok(evWaiver.status === 'MANUAL' && evWaiver.reasons.some(r => /waiver/.test(r.msg)), 'FICO under the tier min goes to waiver review');
})();

(function interestReserveLikeStandard() {
  // Reserve is financed, in the cost basis, capped at the full term — the
  // Standard Program mechanic (owner-directed 2026-07-29).
  const base = { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 740, expFlips: 5,
    purchasePrice: 400000, asIsValue: 400000, arv: 900000, rehabBudget: 150000, term: 12 };
  const ev0 = SVP.evaluate(base);
  const ev6 = SVP.evaluate(Object.assign({}, base, { irMonths: 6 }));
  ok(ev6.sizing.financedIR > 0, 'a requested reserve is financed');
  ok(ev6.sizing.costBasis > ev0.sizing.costBasis, 'the financed reserve joins the cost basis');
  const ev24 = SVP.evaluate(Object.assign({}, base, { irMonths: 24 }));   // term is 12 → capped
  ok(ev24.reserveTermCapped === true, 'reserve months are capped at the loan term');
  ok(ev24.sizing.financedIR <= 12 * ev24.sizing.fullPayment + 1, 'financed reserve never exceeds full-term interest');
  // amount path: $14k request on a 12-mo deal at ~$X/mo caps exactly like months
  const evAmt = SVP.evaluate(Object.assign({}, base, { irAmount: 10000000 }));
  ok(evAmt.sizing.financedIR <= 12 * evAmt.sizing.fullPayment + 1, 'an exact-dollar reserve obeys the same term ceiling');
  // bridge finances no reserve
  const evBr = SVP.evaluate({ loanType: 'Purchase', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 740, expFlips: 5,
    purchasePrice: 400000, asIsValue: 400000, term: 12, irMonths: 6 });
  ok((evBr.sizing && evBr.sizing.financedIR || 0) === 0, 'bridge finances no reserve');
})();

(function sizingRespectsTierGrid() {
  // Sweep: the sized loan must respect every cap in the EMCAP tier grid.
  let seed = 0xBADA55;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let sized = 0;
  for (let i = 0; i < 3000; i++) {
    const pp = 150000 + Math.round(rnd() * 2000000);
    const rehab = Math.round(rnd() * 800000);
    const arv = Math.round((pp + rehab) * (1.05 + rnd() * 0.6));
    const strat = ['Fix & Flip', 'Ground-Up Construction', 'Bridge'][Math.floor(rnd() * 3)];
    const purp = rnd() < 0.7 ? 'Purchase' : 'Refinance';
    const ev = SVP.evaluate({ loanType: purp, strategy: strat, state: 'TX', zip: '75001',
      fico: 640 + Math.floor(rnd() * 180), expFlips: Math.floor(rnd() * 7), expGround: Math.floor(rnd() * 7),
      purchasePrice: pp, asIsValue: pp, arv: arv, rehabBudget: rehab, term: 12 });
    if (ev.status === 'INELIGIBLE' || !ev.sizing || !(ev.sizing.totalLoan > 0) || !ev.caps) continue;
    sized++;
    const s = ev.sizing, c = ev.caps;
    ok(s.totalLoan <= c.maxLoan + 1, `loan within tier max @${i}`);
    ok(s.ltcPct <= c.maxLTC + 1e-6, `LTC within cap @${i}`);
    if (ev.strategyCode !== 'BR' && arv > 0) ok(s.totalLoan / arv <= c.maxARLTV + 1e-6, `AR-LTV within cap @${i}`);
    ok(s.acqLtvPct <= c.maxAcqLTV + 1e-6, `acq-LTV within cap @${i}`);
    if (ev.noteRate > 0) {
      // the note rate must be a real fixture cell + the 0.5% default markup
      const grid = Math.round((ev.noteRate - 0.005) * 1e6) / 1e6;
      ok(Object.values(FIX.rates).some((r) => Math.abs(r - grid) < 1e-9), `note rate is grid+markup @${i} (${ev.noteRate})`);
    }
  }
  ok(sized > 500, `sweep sized a healthy sample (${sized})`);
  console.log(`  (3) sizing sweep: ${sized} priced deals all inside the EMCAP tier-grid caps`);
})();

(function frozenEnginesUntouched() {
  // The Silver engine reuses YSP.sizeLoan but must not alter Standard/Gold.
  ok(YSP.constants.MARKUP === 0.005 && YSP.constants.ORIG_PCT === 0.0125, 'Standard constants untouched');
  ok(YSP.constants.MATRIX.NAT['Purchase|FF|1'][0] === 2500000, 'Standard matrix untouched');
  const GSP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'gold-standard.js'));
  ok(GSP.constants.MAX_LOAN === 3000000 && GSP.constants.ORIG_PCT === 0.0125, 'Gold constants untouched');
  // Silver's own program constants
  ok(SVP.constants.MARKUP === 0.005 && SVP.constants.ORIG_PCT === 0.0125, 'Silver defaults: 0.5% markup, 1.25% origination');
  ok(SVP.constants.MIN_LOAN === 100000 && SVP.constants.ABS_MAX_LOAN === 4500000, 'Silver loan bounds');
})();

(function markupCappedAtOnePoint() {
  // Owner-directed 2026-07-29: the note buyer's buy rate floor is note − 1.00pt, so
  // any markup above 1 point is spread the program never earns. The engine clamps the
  // admin markup at 1.00% — an over-cap admin value prices exactly as 1.00% would.
  ok(SVP.constants.MARKUP_MAX === 0.01, 'Silver markup cap constant is 1.00%');
  const probe = { market: 'STD', sizeBand: 'S', strategyCode: 'FF', loanType: 'Purchase', term: 12, tier: 1, arltv: 0.60, fico: 720, ltc: 0.80 };
  const grid = SVP.gridRate('STD', 'S', 'FF', 'P', '12', 1, SVP.arBand(0.60), 'FICO 700+', SVP.ltcBand(0.80));
  ok(grid != null, 'markup-cap probe cell prices');
  try {
    SVP.setMarkup(0.025);                                      // 2.5% typed by an admin
    ok(Math.abs(SVP.noteRate(probe) - (grid + 0.01)) < 1e-9, 'markup over 1pt clamps to exactly 1.00%');
    SVP.setMarkup(0.01);
    ok(Math.abs(SVP.noteRate(probe) - (grid + 0.01)) < 1e-9, 'markup of exactly 1pt is honored');
    SVP.setMarkup(0.004);                                      // production-style 0.4% stays untouched
    ok(Math.abs(SVP.noteRate(probe) - (grid + 0.004)) < 1e-9, 'markup under the cap passes through unchanged');
    SVP.setMarkup(0);
    ok(Math.abs(SVP.noteRate(probe) - grid) < 1e-9, 'zero markup allowed (never forced up)');
  } finally {
    SVP.setMarkup(null);                                       // restore the default for the rest of the battery
  }
  ok(Math.abs(SVP.noteRate(probe) - (grid + 0.005)) < 1e-9, 'markup restored to the 0.5% default after the cap test');
})();

(function assignmentFrozenRule() {
  // Company-wide frozen rule: financeable assignment fee = 15% of the SELLER's
  // contract price (never the gross total), sizing off the effective price.
  const ev = SVP.evaluate({ loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 720, expFlips: 3,
    purchasePrice: 120000, sellerPrice: 100000, isAssignment: true,
    asIsValue: 120000, arv: 300000, rehabBudget: 60000, term: 12 });
  ok(ev.assignment && Math.abs(ev.assignment.maxFee - 15000) < 1 && Math.abs(ev.assignment.recognizedPrice - 115000) < 1,
    'assignment fee caps at 15% of the seller price (recognized $115k)');
  ok(ev.assignment.excessOOP === 5000, 'excess fee is out of pocket');
})();

console.log(`\nSilver Program engine battery: ALL ${passed} checks passed.`);
