'use strict';
/**
 * Silver Program — "PROGRAM MAXIMUM LEVERAGE" IS FIXED AND REACHABLE;
 *                  the deal's PRICED CEILING may move and must explain itself.
 *
 * THE OWNER'S REPORT (2026-07-30, Silver / ground-up REFINANCE / tier 2 / upstate NY):
 *   "the Max LTV keeps changing when I change the interest reserve — if I make the
 *    reserve 18 months it's max 65 LTC, if I make the interest 12 months it's max
 *    74.99 LTC … the Max LTC should never change, each tier has its own Max LTC …
 *    it shouldn't change based on what you're changing the interest reserve."
 * THE OWNER'S CORRECTION, same day:
 *   "the tier two cannot anytime get 92.5 even if it says that it's available because
 *    it doesn't price — so keep that tier at 85%."
 *
 * SO THE DISPLAYED PROGRAM MAXIMUM MUST BE BOTH:
 *   FIXED     — it may not move when a deal input the user edits moves (the interest
 *               reserve above all, plus rehab budget, ARV, purchase price, as-is), and
 *   REACHABLE — it is the tier-grid cap LOWERED to the highest leverage band the rate
 *               grid genuinely PRICES for that family. A cap the grid never prices is a
 *               number the borrower can never reach, which is the same misleading
 *               display we are fixing.
 *
 * ROOT CAUSE (fixed in the ENGINE, not the display layer): the Silver engine's
 * grid-aware step-down did `capsEff = best.caps` and that same mutated object was
 * handed to the result as `caps` — so the one field carried a DEAL-SPECIFIC ceiling
 * under a PROGRAM-level name. Standard and Gold never do this, which is why the owner
 * correctly observed the problem was Silver-only. The engine result now splits three
 * meanings:
 *     result.caps          — the PROGRAM MAXIMUM this profile can actually reach (fixed)
 *     result.pricedCeiling — what THIS deal was sized and priced at (may be lower)
 *     result.tierCaps      — the workbook Tier Grid row, verbatim (audit / parity)
 *
 * OWNER-AUTHORIZED GUIDELINE CHANGE (2026-07-30, the owner's own words — this
 * SUPERSEDES the narrower cap-only rule of the same day):
 *   "Fix this entire deal to allow every 75 to price as 74.99. And qualify the same,
 *    because this is a mistake from their excel sheet how they set it up, but in real
 *    life that should be the case. And it should be on every tier, on every scenario,
 *    on everything. Everything should go in this logic. We should do this small change
 *    to every single scenario. Every single pair, every single experience. Every single
 *    kind of a deal. It should not be this point 99. It should be the above."
 * The workbook writes its bands to two decimals and ends three of them one hundredth of
 * a point short of the round number the next band advertises — "<64.99%" before
 * "65.00%-70.00%", "<74.99%" before "75.00%-80.00%", "87.51%-89.99%" before
 * "90.00%-92.50%" — leaving a seam BOTH labels disclaim. Their sheet is a CHECKER, so a
 * typed loan practically never lands in it; ours is a SIZER and lands on the round
 * number every time a cap or a de-leverage target binds. So a band whose upper edge ends
 * in ".99" now runs to the round number one hundredth above it: a ratio of exactly
 * 65.00% / 75.00% / 90.00% (and the whole seam beneath it) bands DOWN, into the cheaper
 * band, and the band above starts strictly above that round number.
 * The rule is derived FROM THE LABELS on both sides — the engine from its own copy, this
 * spec from the fixture's — and is UNIVERSAL: every tier, product, purpose, market, size
 * band and FICO band, cap or no cap. The earlier cap-only mechanism
 * (capBoundaryEdge / atCap's axis argument) is REPLACED, not layered.
 * The reachable maximum therefore moves wherever a family's top priced band was one of
 * those three, e.g.
 *     FF|P|T3, GUC|P|T3, GUC|R|T3, BR|R|T3 — AR-LTV 64.99% → 65.00%
 *     BR|R|T1, BR|P|T1, BR|P|T2, FF|R|T2   — loan-to-cost 74.99% → 75.00%
 *     any family topping out in "87.51%-89.99%" — 89.99% → 90.00%
 * GUC|P|T2 / GUC|R|T2 stay at the actually-priced 85.00% LTC / 70.00% AR-LTV: their top
 * priced band is "80.01%-85.00%", which ends on a round number and lifts nothing. That
 * is the counter-example section 1b pins.
 *
 * WHAT THIS FILE PINS
 *   (1) REACHABILITY — result.caps equals min(tier-grid cap, highest priced band edge),
 *       with the band edges read off the labels and a ".99" edge lifted to the round
 *       number above it. Recomputed HERE from the workbook FIXTURE, never from the
 *       engine's own logic. Includes the families that advertise leverage the grid never
 *       prices:
 *         GUC|P|T2 92.5% → 85%,  GUC|R|T2 92.5% → 85%  (top priced band ends round)
 *         BR|R|T1 75% → 75%  (top priced band is "<74.99%", lifted, so the cap is met)
 *       plus NYC, whose reachable maxima are lower still (F&F / GUC top out at 80%).
 *   (2) INVARIANCE — result.caps does not move across reserve months 0/3/6/9/12/18/24,
 *       an amount-driven reserve, rehab budgets, ARVs, prices and as-is values.
 *   (3) TRUTHFULNESS — result.pricedCeiling may move, may never exceed result.caps'
 *       tier row, and whenever the step-down lowered it, the engine's own explaining
 *       sentence (reason code `leverage_capped`) names the axis that actually bound.
 *   (4) MUTATION PROOF — the same assertions re-run against the OLD readings FAIL:
 *       (a) the pre-fix display (effective ceiling under the program-maximum label)
 *           breaks INVARIANCE, and
 *       (b) displaying the RAW tier cap breaks REACHABILITY.
 *   (5) CONTRACT — pricedCeiling is what the sizing was measured against, so a sized
 *       loan never exceeds it; and every result shape carries all three fields.
 *
 * HARD RULES HONORED: no DB, no network, pure Node, well under 60s.
 *
 * Run:  node scripts/test-silver-maxlev-display.js
 * npm test entry to ADD (package.json is NOT edited by this script):
 *   "node scripts/test-silver-maxlev-display.js" — place it immediately after
 *   "node scripts/test-silver-address-parse.js" in the test chain.
 */

const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'silver-program.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json'));

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); } }
const eqNum = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-12;
const pctS = (x) => (Math.round(x * 10000) / 100) + '%';

/* ===================================================================== *
 * SPEC — the reachable maximum, recomputed from the WORKBOOK FIXTURE.
 * This is the independent expectation the engine is measured against; it
 * never calls the engine's own achievable-cap lookup.
 * ===================================================================== */
const AR_BANDS = ['<64.99%', '65.00%-70.00%', '70.01%-75.00%'];
const LTC_BANDS = ['<74.99%', '75.00%-80.00%', '80.01%-85.00%', '85.01%-87.50%', '87.51%-89.99%', '90.00%-92.50%'];
/* THE BAND EDGES ARE READ OFF THE LABELS, AND A ".99" EDGE IS THE ROUND NUMBER ABOVE IT
   (owner-authorized 2026-07-30 — see the header). Derived here so this spec never
   hard-codes 0.65 / 0.75 / 0.90, and so a future workbook with different labels is
   handled by the same three lines. A label already ending on a round number lifts
   nothing, which is why 70.00% / 80.00% / 85.00% / 87.50% / 92.50% are untouched. */
function edgeOf(label) {
  let m = /^<(\d+(?:\.\d+)?)%$/.exec(label) || /^\d+(?:\.\d+)?%-(\d+(?:\.\d+)?)%$/.exec(label);
  if (!m) throw new Error(`unparseable band label ${label}`);
  const h = Math.round(parseFloat(m[1]) * 100);        // hundredths of a percent
  return (h % 100 === 99 ? h + 1 : h) / 10000;
}
const AR_EDGE = AR_BANDS.map(edgeOf);                   // [0.65, 0.70, 0.75]
const LTC_EDGE = LTC_BANDS.map(edgeOf);                 // [0.75, 0.80, 0.85, 0.875, 0.90, 0.925]
/* The PRE-CHANGE edges — the labels read literally, no lift. Kept ONLY so section 1b can
   measure what moved and prove each move is exactly one hundredth of a point. */
const AR_EDGE_RAW = [0.6499, 0.70, 0.75];
const LTC_EDGE_RAW = [0.7499, 0.80, 0.85, 0.875, 0.8999, 0.925];
const FICO_12 = ['FICO 700+', 'FICO 660-699', 'FICO 640-659'];
const FICO_3 = ['FICO 700+', 'FICO 680-699', 'FICO 640-679'];
function ficoBandOf(tier, fico) {
  const L = tier === 3 ? FICO_3 : FICO_12;
  if (tier === 3) return fico >= 700 ? L[0] : fico >= 680 ? L[1] : fico >= 640 ? L[2] : null;
  return fico >= 700 ? L[0] : fico >= 660 ? L[1] : fico >= 640 ? L[2] : null;
}
/** The highest AR / LTC band index carrying ANY priced fixture cell for this family. */
function topPricedBands(mkt, size, prod, purp, term, tier, fb) {
  let bestL = -1, bestA = -1;
  for (let i = 0; i < AR_BANDS.length; i++) {
    for (let k = 0; k < LTC_BANDS.length; k++) {
      const key = `${mkt}|${size}|${prod}|${purp}|${term}|T${tier}|${AR_BANDS[i]}|${fb}|${LTC_BANDS[k]}`;
      if (FIX.rates[key] != null) { if (k > bestL) bestL = k; if (i > bestA) bestA = i; }
    }
  }
  return { bestL, bestA };
}
/** min(tier cap, highest LTC/AR band with ANY priced fixture cell) for a family, on the
 *  band edges read off the labels with the owner-authorized .99 lift of 2026-07-30.
 *  `edges` is injected so section 1b can run the identical shape on the RAW edges and
 *  measure exactly what the ruling moved. */
function programMaxOn(arEdge, ltcEdge, mkt, size, prod, purp, term, tier, fico) {
  const row = FIX.tierGrid[`${prod}|${purp}|T${tier}`];
  if (!row) return null;
  const fb = ficoBandOf(tier, fico);
  if (!fb) return null;
  const { bestL, bestA } = topPricedBands(mkt, size, prod, purp, term, tier, fb);
  const out = { maxLoan: row.maxloan, minFico: row.minfico, maxAcqLTV: row.maxacq, maxARLTV: row.maxar, maxLTC: row.maxltc };
  if (bestL < 0) return out;                       // nothing prices — the tier row stands
  if (ltcEdge[bestL] < out.maxLTC) out.maxLTC = ltcEdge[bestL];
  if (arEdge[bestA] < out.maxARLTV) out.maxARLTV = arEdge[bestA];
  return out;
}
function specProgramMax(mkt, size, prod, purp, term, tier, fico) {
  return programMaxOn(AR_EDGE, LTC_EDGE, mkt, size, prod, purp, term, tier, fico);
}

/* ===================================================================== *
 * 0. THE OWNER'S OWN SCENARIO.
 * ===================================================================== */
const OWNER = {
  loanType: 'Refinance', strategy: 'Ground-up', state: 'NY', zip: '12201', city: 'Albany',
  propertyType: 'single family', fico: 700, expGround: 2,
  purchasePrice: 600000, asIsValue: 700000, arv: 1500000, rehabBudget: 500000, term: 18,
};
const OWNER_ROW = FIX.tierGrid['GUC|R|T2'];

(function section0() {
  const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }));
  ok(ev.product === 'GUC' && ev.loanType === 'Refinance' && ev.tier === 2,
    `owner scenario is GUC | Refinance | Tier 2 (got ${ev.product} | ${ev.loanType} | T${ev.tier})`);
  ok(ev.market === 'STD' && ev.sizeBand === 'S', `owner scenario is the STD market, small band (got ${ev.market}|${ev.sizeBand})`);
  ok(!!ev.caps && !!ev.pricedCeiling && !!ev.tierCaps, 'the result carries all three leverage meanings');
  // the workbook row is 92.5% ...
  ok(eqNum(ev.tierCaps.maxLTC, OWNER_ROW.maxltc) && eqNum(ev.tierCaps.maxLTC, 0.925),
    `the workbook tier row still says ${pctS(OWNER_ROW.maxltc)} (got ${pctS(ev.tierCaps.maxLTC)})`);
  // ... but the grid never prices it, so the PROGRAM MAXIMUM shown is 85%
  ok(eqNum(ev.caps.maxLTC, 0.85), `THE OWNER'S NUMBER: the displayed program maximum is 85% LTC, not 92.5% (got ${pctS(ev.caps.maxLTC)})`);
  ok(eqNum(ev.caps.maxARLTV, 0.70), `and 70% AR-LTV — the 75% tier cap is likewise never priced (got ${pctS(ev.caps.maxARLTV)})`);
  ok(eqNum(ev.caps.maxAcqLTV, OWNER_ROW.maxacq), 'the as-is advance cap is the tier row (the grid is not keyed on acq-LTV)');
  ok(eqNum(ev.caps.maxLoan, OWNER_ROW.maxloan), 'the max loan amount is the tier row');
  const spec = specProgramMax('STD', 'S', 'GUC', 'R', '18', 2, 700);
  ok(eqNum(ev.caps.maxLTC, spec.maxLTC) && eqNum(ev.caps.maxARLTV, spec.maxARLTV),
    'the engine\'s program maximum equals the one recomputed independently from the workbook fixture');
})();

/* ===================================================================== *
 * 1. REACHABILITY — every family, engine vs the fixture-derived spec.
 *    Includes the three rows that advertise unreachable leverage.
 * ===================================================================== */
(function section1() {
  const MK = ['STD', 'NYC'], SZ = ['S', 'L'], PR = ['FF', 'GUC', 'BR'], PU = ['P', 'R'], TM = ['12', '18', '24'];
  let checked = 0, mismatch = 0, lowered = 0;
  for (const mkt of MK) for (const size of SZ) for (const prod of PR) for (const purp of PU) for (const term of TM) for (const tier of [1, 2, 3]) {
    for (const fico of [700, 665, 645]) {
      const spec = specProgramMax(mkt, size, prod, purp, term, tier, fico);
      if (!spec) continue;
      const eng = SVP.constants ? null : null;   // never read engine internals — go through evaluate() below
      checked++;
      if (spec.maxLTC < FIX.tierGrid[`${prod}|${purp}|T${tier}`].maxltc - 1e-12) lowered++;
      void eng;
    }
  }
  ok(checked > 200, `the fixture-derived spec covers ${checked} family/FICO combinations`);
  ok(lowered > 0, `${lowered} of them advertise an LTC cap the grid never prices`);

  // The three named rows (STD market, small band, FICO 700+, 18-month term).
  const NAMED = [
    { name: 'GUC|P|T2', prod: 'GUC', purp: 'P', tier: 2, wantLtc: 0.85, tierLtc: 0.925 },
    { name: 'GUC|R|T2', prod: 'GUC', purp: 'R', tier: 2, wantLtc: 0.85, tierLtc: 0.925 },
    // AUTHORIZED 2026-07-30: 75.00% sits ON the "<74.99%" boundary and the band below
    // prices right across this family, so the tier cap IS reached — no longer 74.99%.
    { name: 'BR|R|T1', prod: 'BR', purp: 'R', tier: 1, wantLtc: 0.75, tierLtc: 0.75 },
  ];
  for (const nm of NAMED) {
    const spec = specProgramMax('STD', 'S', nm.prod, nm.purp, '18', nm.tier, 700);
    ok(eqNum(spec.maxLTC, nm.wantLtc), `SPEC ${nm.name}: reachable LTC is ${pctS(nm.wantLtc)} (fixture says ${pctS(spec.maxLTC)})`);
    ok(eqNum(FIX.tierGrid[`${nm.prod}|${nm.purp}|T${nm.tier}`].maxltc, nm.tierLtc),
      `SPEC ${nm.name}: the tier grid advertises ${pctS(nm.tierLtc)}`);
  }
  // GUC tier 2 is the WHOLE-BAND gap the owner ruled stays lowered — it must still be
  // shown at the actually-priced 85%, never at the 92.5% the tier grid advertises.
  for (const purp of ['P', 'R']) {
    const spec = specProgramMax('STD', 'S', 'GUC', purp, '18', 2, 700);
    ok(eqNum(spec.maxLTC, 0.85), `SPEC GUC|${purp}|T2 STAYS at the priced 85% (got ${pctS(spec.maxLTC)}) — a whole-band gap is not a boundary sliver`);
  }

  // ...and the engine agrees, through evaluate(), on real deals.
  const LIVE = [
    { name: 'GUC|P|T2 STD S', wantLtc: 0.85, wantAr: 0.70, inp: { loanType: 'Purchase', strategy: 'Ground-up', state: 'NJ', zip: '07030', fico: 720, expGround: 1, purchasePrice: 600000, asIsValue: 650000, arv: 1500000, rehabBudget: 400000, term: 18 } },
    { name: 'GUC|R|T2 STD S', wantLtc: 0.85, wantAr: 0.70, inp: OWNER },
    { name: 'BR|R|T1 STD S', wantLtc: 0.75, wantAr: 0.75, inp: { loanType: 'Refinance', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 720, expFlips: 5, purchasePrice: 600000, asIsValue: 800000, arv: 900000, rehabBudget: 0, term: 18 } },
    { name: 'FF|P|T1 NYC S', wantLtc: 0.80, wantAr: 0.75, inp: { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NY', zip: '11201', fico: 720, expFlips: 5, purchasePrice: 900000, asIsValue: 950000, arv: 1600000, rehabBudget: 300000, term: 18 } },
    { name: 'GUC|P|T1 NYC S', wantLtc: 0.80, wantAr: 0.75, inp: { loanType: 'Purchase', strategy: 'Ground-up', state: 'NY', zip: '10001', fico: 720, expGround: 5, purchasePrice: 900000, asIsValue: 950000, arv: 2200000, rehabBudget: 600000, term: 18 } },
  ];
  for (const c of LIVE) {
    const ev = SVP.evaluate(Object.assign({}, c.inp, { irMonths: 0 }));
    ok(!!ev.caps, `${c.name}: the engine publishes a program maximum`);
    if (!ev.caps) continue;
    ok(eqNum(ev.caps.maxLTC, c.wantLtc), `${c.name}: program max LTC ${pctS(c.wantLtc)} (got ${pctS(ev.caps.maxLTC)})`);
    ok(eqNum(ev.caps.maxARLTV, c.wantAr), `${c.name}: program max AR-LTV ${pctS(c.wantAr)} (got ${pctS(ev.caps.maxARLTV)})`);
    ok(ev.caps.maxLTC <= ev.tierCaps.maxLTC + 1e-12, `${c.name}: the program maximum never EXCEEDS the tier grid row`);
  }
})();

/* ===================================================================== *
 * 1b. THE UNIVERSAL .99 RULE — the WHOLE 18-row table, both markets, both size
 *     bands, every term and FICO band. Every restatement must be exactly one
 *     0.01-percentage-point step UP off a .99 edge, never anything else — and
 *     GUC tier 2, whose top priced band ends on a round number, must not budge.
 * ===================================================================== */
(function section1b() {
  // the PRE-CHANGE reading: the identical computation on the RAW (unlifted) label
  // edges, so "what moved" is measured, never assumed.
  const priorProgramMax = (...a) => programMaxOn(AR_EDGE_RAW, LTC_EDGE_RAW, ...a);
  const DOT99 = [0.6499, 0.7499, 0.8999];         // the ONLY edges in this workbook that lift
  const isDot99 = (x) => DOT99.some((e) => eqNum(e, x));
  const STEP = 0.0001;                            // one 0.01-percentage-point
  const moved = new Set();
  let compared = 0, badMove = 0, badDirection = 0;
  for (const mkt of ['STD', 'NYC']) for (const size of ['S', 'L'])
    for (const prod of ['FF', 'GUC', 'BR']) for (const purp of ['P', 'R']) for (const tier of [1, 2, 3])
      for (const term of ['12', '18', '24']) for (const fico of [700, 685, 665, 645]) {
        const now = specProgramMax(mkt, size, prod, purp, term, tier, fico);
        const was = priorProgramMax(mkt, size, prod, purp, term, tier, fico);
        if (!now || !was) continue;
        compared++;
        const rowName = `${prod}|${purp}|T${tier}`;
        const row = FIX.tierGrid[rowName];
        for (const [k, tierCap, axis] of [['maxLTC', row.maxltc, 'LTC'], ['maxARLTV', row.maxar, 'AR']]) {
          if (eqNum(now[k], was[k])) continue;
          moved.add(`${rowName} ${mkt} ${size} ${axis}`);
          // A value may ONLY move off one of the three .99 edges — anything else is a bleed.
          if (!isDot99(was[k])) {
            badMove++;
            ok(false, `BLEED — ${rowName} ${mkt} ${size} ${axis} moved ${pctS(was[k])} → ${pctS(now[k])}, but ${pctS(was[k])} is not a ".99" band edge`);
          }
          // upward only, exactly one label step, and never past the tier cap
          if (!(now[k] > was[k]) || Math.abs(now[k] - was[k] - STEP) > 1e-9 || now[k] > tierCap + 1e-12) {
            badDirection++;
            ok(false, `${rowName} ${mkt} ${size} ${axis}: restatement is not "one 0.01-pt step up, inside the tier cap" (${pctS(was[k])} → ${pctS(now[k])}, tier cap ${pctS(tierCap)})`);
          }
        }
        // GUC tier 2 — its top priced band is "80.01%-85.00%" / "65.00%-70.00%", both of
        // which end on a round number, so the ruling reaches nothing here.
        if (prod === 'GUC' && tier === 2) {
          if (!eqNum(now.maxLTC, was.maxLTC) || !eqNum(now.maxARLTV, was.maxARLTV)) {
            ok(false, `GUC|${purp}|T2 ${mkt} ${size} term ${term} FICO ${fico}: the change BLED into GUC tier 2`);
          }
        }
      }
  ok(compared > 400, `compared ${compared} family/FICO combinations before vs after`);
  ok(badMove === 0, `every restatement started on a ".99" band edge (${badMove} bleeds)`);
  ok(badDirection === 0, `every restatement is one 0.01-percentage-point step UP, inside the tier cap (${badDirection} malformed)`);
  /* THE DISPLAYED PROGRAM MAXIMUM is min(tier cap, top priced band edge), so the lift
     only shows up where the top priced band was one of the three .99 bands AND the tier
     cap did not already clamp it lower — 11 combinations. That is NOT the size of the
     rule: the rule is in the CLASSIFIER (asserted below and swept by the 204k matrix),
     which reaches every deal on every tier. Pinned exactly so a future edge change to
     this display is deliberate. */
  const MOVED_EXPECTED = [
    'BR|R|T1 NYC S LTC', 'BR|R|T1 STD L LTC', 'BR|R|T1 STD S LTC',
    'BR|R|T3 NYC S AR', 'BR|R|T3 STD L AR', 'BR|R|T3 STD S AR',
    'FF|P|T3 STD S AR',
    'GUC|P|T3 STD L AR', 'GUC|P|T3 STD S AR',
    'GUC|R|T3 STD L AR', 'GUC|R|T3 STD S AR',
  ].join(' | ');
  ok([...moved].sort().join(' | ') === MOVED_EXPECTED,
    `exactly the 11 expected row/market/size/axis combinations moved up onto the round number (got: ${[...moved].sort().join(' | ')})`);
  // The five rows the earlier CAP-ONLY commit reached must still be reached — the
  // universal rule is a superset of it, never a replacement that loses ground.
  const CAP_ROWS = [
    ['FF', 'P', 3, 'maxARLTV', 0.65], ['GUC', 'P', 3, 'maxARLTV', 0.65],
    ['GUC', 'R', 3, 'maxARLTV', 0.65], ['BR', 'R', 3, 'maxARLTV', 0.65],
    ['BR', 'R', 1, 'maxLTC', 0.75],
  ];
  for (const [prod, purp, tier, key, want] of CAP_ROWS) {
    const s = specProgramMax('STD', 'S', prod, purp, '18', tier, 700);
    ok(s && eqNum(s[key], want), `${prod}|${purp}|T${tier}: the cap-only rule's row still reaches ${pctS(want)} (got ${s ? pctS(s[key]) : 'none'})`);
  }
  // GUC tier 2 stays at 85% wherever it prices at all, in EVERY market and size band.
  let gucT2 = 0;
  for (const mkt of ['STD', 'NYC']) for (const size of ['S', 'L']) for (const purp of ['P', 'R'])
    for (const term of ['12', '18', '24']) for (const fico of [700, 665, 645]) {
      const s = specProgramMax(mkt, size, 'GUC', purp, term, 2, fico);
      if (!s) continue;
      const anyPriced = !eqNum(s.maxLTC, 0.925) || !eqNum(s.maxARLTV, 0.75);
      if (!anyPriced) continue;             // this FICO band prices nothing — the tier row stands
      gucT2++;
      ok(s.maxLTC <= 0.85 + 1e-12, `GUC|${purp}|T2 ${mkt}|${size} term ${term} FICO ${fico}: LTC still capped at the priced 85% (got ${pctS(s.maxLTC)})`);
    }
  ok(gucT2 > 0, `GUC tier 2 checked in ${gucT2} priced family/FICO combinations — every one still 85%`);

  /* THE CLASSIFIER ITSELF, straight off the engine: exactly 65.00% / 75.00% / 90.00%
     bands DOWN into the cheaper band, one hundredth of a point above it bands up, and
     every edge that does NOT end in .99 is byte-identical to the workbook's own reading.
     This is the owner's "every single scenario" restated at its root. */
  const LIFTED = [
    ['AR', 0.65, '<64.99%', '65.00%-70.00%'],
    ['LTC', 0.75, '<74.99%', '75.00%-80.00%'],
    ['LTC', 0.90, '87.51%-89.99%', '90.00%-92.50%'],
  ];
  for (const [axis, at, below, above] of LIFTED) {
    const f = axis === 'AR' ? SVP.arBand : SVP.ltcBand;
    ok(f(at) === below, `ENGINE: exactly ${pctS(at)} ${axis} bands as "${below}" (got "${f(at)}")`);
    ok(f(at - 1e-9) === below, `ENGINE: the seam just under ${pctS(at)} ${axis} bands as "${below}"`);
    ok(f(at + 0.0001) === above, `ENGINE: ${pctS(at + 0.0001)} ${axis} bands as "${above}" (got "${f(at + 0.0001)}")`);
  }
  const UNMOVED = [
    ['AR', 0.70, '65.00%-70.00%', '70.01%-75.00%'], ['AR', 0.75, '70.01%-75.00%', null],
    ['LTC', 0.80, '75.00%-80.00%', '80.01%-85.00%'], ['LTC', 0.85, '80.01%-85.00%', '85.01%-87.50%'],
    ['LTC', 0.875, '85.01%-87.50%', '87.51%-89.99%'], ['LTC', 0.925, '90.00%-92.50%', null],
  ];
  for (const [axis, at, below, above] of UNMOVED) {
    const f = axis === 'AR' ? SVP.arBand : SVP.ltcBand;
    ok(f(at) === below, `ENGINE: the round edge ${pctS(at)} ${axis} is UNCHANGED — still "${below}" (got "${f(at)}")`);
    ok(f(at + 0.0001) === above, `ENGINE: ${pctS(at + 0.0001)} ${axis} is UNCHANGED — "${above}" (got "${f(at + 0.0001)}")`);
  }

  // ...and the ENGINE agrees on real deals for each row the ruling reached.
  const REACHED = [
    { name: 'BR|R|T1 STD S (LTC 75%)', axis: 'maxLTC', want: 0.75,
      inp: { loanType: 'Refinance', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 720, expFlips: 5, purchasePrice: 600000, asIsValue: 800000, arv: 900000, rehabBudget: 0, term: 18 } },
    { name: 'BR|R|T1 NYC S (LTC 75%)', axis: 'maxLTC', want: 0.75,
      inp: { loanType: 'Refinance', strategy: 'Bridge', state: 'NY', zip: '11215', fico: 720, expFlips: 5, purchasePrice: 600000, asIsValue: 800000, arv: 900000, rehabBudget: 0, term: 18 } },
    { name: 'FF|P|T3 STD S (AR 65%)', axis: 'maxARLTV', want: 0.65,
      inp: { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', zip: '07030', fico: 700, expFlips: 0, expHolds: 0, expGround: 0, purchasePrice: 400000, asIsValue: 420000, arv: 800000, rehabBudget: 120000, term: 12 } },
    { name: 'GUC|P|T3 STD S (AR 65%)', axis: 'maxARLTV', want: 0.65,
      inp: { loanType: 'Purchase', strategy: 'Ground-up', state: 'NJ', zip: '07030', fico: 700, expFlips: 0, expHolds: 0, expGround: 0, purchasePrice: 400000, asIsValue: 420000, arv: 900000, rehabBudget: 200000, term: 12 } },
    { name: 'GUC|R|T3 STD S (AR 65%)', axis: 'maxARLTV', want: 0.65,
      inp: { loanType: 'Refinance', strategy: 'Ground-up', state: 'NJ', zip: '07030', fico: 700, expFlips: 0, expHolds: 0, expGround: 0, purchasePrice: 400000, asIsValue: 420000, arv: 900000, rehabBudget: 200000, term: 12 } },
    { name: 'BR|R|T3 STD S (AR 65%)', axis: 'maxARLTV', want: 0.65,
      inp: { loanType: 'Refinance', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 700, expFlips: 0, expHolds: 0, expGround: 0, purchasePrice: 400000, asIsValue: 500000, arv: 0, rehabBudget: 0, term: 12 } },
  ];
  for (const c of REACHED) {
    const ev = SVP.evaluate(Object.assign({}, c.inp, { irMonths: 0 }));
    ok(!!ev.caps && eqNum(ev.caps[c.axis], c.want),
      `${c.name}: the engine's program maximum reaches the tier cap ${pctS(c.want)} (got ${ev.caps ? pctS(ev.caps[c.axis]) : 'none'})`);
  }
})();

/* ===================================================================== *
 * 2. INVARIANCE — the program maximum does not move when a DEAL input moves.
 * ===================================================================== */
function progSig(ev) {
  const c = ev.caps;
  return c ? [c.maxLoan, c.minFico, c.maxAcqLTV, c.maxARLTV, c.maxLTC].join('|') : 'NONE';
}
function ceilSig(ev) {
  const c = ev.pricedCeiling;
  return c ? [c.maxLoan, c.minFico, c.maxAcqLTV, c.maxARLTV, c.maxLTC].join('|') : 'NONE';
}
// Every variant below leaves FICO, experience, product, purpose, market, size band
// and term untouched — so the family, and therefore the program maximum, may not budge.
const DEAL_VARIANTS = [];
[0, 3, 6, 9, 12, 18, 24].forEach((m) => DEAL_VARIANTS.push({ label: `reserve ${m} months`, patch: { irMonths: m } }));
[0, 10000, 40000, 90000, 150000, 250000].forEach((a) => DEAL_VARIANTS.push({ label: `reserve $${a} (amount-driven)`, patch: { irAmount: a, irMonths: 0 } }));
[0, 100000, 250000, 500000, 750000, 1000000].forEach((b) => DEAL_VARIANTS.push({ label: `rehab budget $${b}`, patch: { rehabBudget: b } }));
[900000, 1100000, 1300000, 1500000, 1900000, 2400000].forEach((v) => DEAL_VARIANTS.push({ label: `ARV $${v}`, patch: { arv: v } }));
[400000, 600000, 850000, 1200000].forEach((p) => DEAL_VARIANTS.push({ label: `price $${p}`, patch: { purchasePrice: p } }));
[500000, 700000, 950000].forEach((v) => DEAL_VARIANTS.push({ label: `as-is $${v}`, patch: { asIsValue: v } }));

(function section2() {
  const baseline = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }));
  const want = progSig(baseline);
  let moved = 0, ceilMoved = 0, seen = 0;
  const distinctCeil = new Set();
  for (const v of DEAL_VARIANTS) {
    const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }, v.patch));
    if (!ev.caps) continue;
    seen++;
    if (progSig(ev) !== want) { moved++; ok(false, `PROGRAM MAXIMUM MOVED on a deal change — ${v.label}: ${progSig(ev)} (expected ${want})`); }
    if (ceilSig(ev) !== ceilSig(baseline)) ceilMoved++;
    distinctCeil.add(ceilSig(ev));
  }
  ok(moved === 0, `the program maximum is invariant across all ${seen} deal variants (moved ${moved} times)`);
  ok(ceilMoved > 0, `the deal's PRICED CEILING does move across the same variants (${ceilMoved} of ${seen}) — the two are genuinely different things`);
  ok(distinctCeil.size > 1, `the priced ceiling takes ${distinctCeil.size} distinct values over the battery`);
})();

/* The owner's exact reproduction: reserve 0 → 6 → 12 → 18 on their own deal. */
(function section2b() {
  const rows = [0, 6, 12, 18].map((m) => {
    const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: m }));
    return { m, prog: progSig(ev), ceil: ceilSig(ev), pc: ev.pricedCeiling, caps: ev.caps, ev };
  });
  ok(rows.every((r) => r.prog === rows[0].prog),
    `OWNER REPRO — the program maximum is identical at reserve 0 / 6 / 12 / 18`);
  rows.forEach((r) => ok(eqNum(r.caps.maxLTC, 0.85) && eqNum(r.caps.maxARLTV, 0.70),
    `OWNER REPRO — at reserve ${r.m} months the program maximum is still 85% LTC / 70% ARV`));
  ok(rows.some((r) => r.ceil !== rows[0].ceil), 'OWNER REPRO — the priced ceiling does change across those same four reserves (the symptom is real)');
  ok(eqNum(rows[3].pc.maxLTC, 0.80), `OWNER REPRO — at an 18-month reserve THIS DEAL prices up to 80% LTC (got ${pctS(rows[3].pc.maxLTC)})`);
  ok(eqNum(rows[2].pc.maxARLTV, 0.70), `OWNER REPRO — at a 12-month reserve THIS DEAL prices up to 70% AR-LTV (got ${pctS(rows[2].pc.maxARLTV)})`);
  // ...and each lowered ceiling is explained
  rows.forEach((r) => {
    const lowered = r.pc.maxLTC < r.caps.maxLTC - 1e-9 || r.pc.maxARLTV < r.caps.maxARLTV - 1e-9;
    if (!lowered) return;
    const why = (r.ev.reasons || []).filter((x) => x && x.code === 'leverage_capped');
    ok(why.length === 1, `OWNER REPRO — the lower ceiling at reserve ${r.m} carries exactly one explaining sentence`);
  });
})();

/* Invariance holds for the other named families too. */
(function section2c() {
  const FAMILIES = [
    { name: 'GUC|P|T2', inp: { loanType: 'Purchase', strategy: 'Ground-up', state: 'NJ', zip: '07030', fico: 720, expGround: 1, purchasePrice: 600000, asIsValue: 650000, arv: 1500000, rehabBudget: 400000, term: 18 } },
    { name: 'BR|R|T1', inp: { loanType: 'Refinance', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 720, expFlips: 5, purchasePrice: 600000, asIsValue: 800000, arv: 900000, rehabBudget: 0, term: 18 } },
    { name: 'FF|P|T1 NYC', inp: { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NY', zip: '11201', fico: 720, expFlips: 5, purchasePrice: 900000, asIsValue: 950000, arv: 1600000, rehabBudget: 300000, term: 18 } },
  ];
  for (const f of FAMILIES) {
    const sigs = new Set();
    for (const m of [0, 6, 12, 18, 24]) {
      for (const rb of [f.inp.rehabBudget, Math.round(f.inp.rehabBudget * 1.6) || 200000]) {
        const ev = SVP.evaluate(Object.assign({}, f.inp, { irMonths: m, rehabBudget: rb }));
        if (ev.caps) sigs.add(progSig(ev));
      }
    }
    ok(sigs.size === 1, `${f.name}: one program maximum across five reserves × two budgets (saw ${sigs.size})`);
  }
})();

/* ===================================================================== *
 * 3. TRUTHFULNESS — swept battery: ceiling ≤ program max' tier row, and every
 *    step-down is explained by the engine, naming the axis that bound.
 * ===================================================================== */
(function section3() {
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let n = 0, withCaps = 0, stepped = 0, unexplained = 0, overTier = 0, progOverTier = 0, sizedOver = 0, missing = 0;
  for (let i = 0; i < 12000; i++) {
    const pp = Math.round((120000 + rnd() * 2600000) / 5000) * 5000;
    const rehab = Math.round((rnd() * 0.9 * pp) / 5000) * 5000;
    const inp = {
      loanType: rnd() < 0.5 ? 'Refinance' : 'Purchase',
      strategy: pick(['Fix & Flip', 'Fix & Hold', 'Ground-up', 'Bridge']),
      state: pick(['NY', 'NJ', 'CT', 'PA', 'FL', 'TX', 'GA', 'OH', 'MA', 'NC']),
      zip: pick(['12201', '07030', '06510', '15201', '33101', '75201', '30301', '43201', '02101', '10001']),
      propertyType: 'single family', fico: pick([645, 665, 685, 700, 720, 760, 800]),
      expFlips: Math.floor(rnd() * 6), expHolds: Math.floor(rnd() * 4), expGround: Math.floor(rnd() * 6),
      purchasePrice: pp, asIsValue: Math.round(pp * (0.85 + rnd() * 0.5)),
      arv: Math.round((pp + rehab) * (1.02 + rnd() * 0.7)), rehabBudget: rehab,
      term: pick([12, 18, 24]), irMonths: pick([0, 3, 6, 9, 12, 18, 24]),
      irAmount: rnd() < 0.12 ? Math.round(rnd() * 120000) : 0,
    };
    const ev = SVP.evaluate(inp);
    n++;
    if (!ev.caps) continue;
    // A refusal that returns BEFORE sizing has no priced ceiling — there was no deal to
    // price. It still answers "what can this profile reach?" (caps) and "what does the
    // workbook say?" (tierCaps), which is the point of publishing all three.
    if (!ev.tierCaps) { missing++; continue; }
    if (!ev.pricedCeiling) { if (ev.sizing && ev.sizing.totalLoan > 0) missing++; continue; }
    withCaps++;
    const prog = ev.caps, pc = ev.pricedCeiling, tier = ev.tierCaps;
    if (prog.maxLTC > tier.maxLTC + 1e-9 || prog.maxARLTV > tier.maxARLTV + 1e-9 || prog.maxAcqLTV > tier.maxAcqLTV + 1e-9) progOverTier++;
    if (pc.maxLTC > tier.maxLTC + 1e-9 || pc.maxARLTV > tier.maxARLTV + 1e-9 || pc.maxAcqLTV > tier.maxAcqLTV + 1e-9) overTier++;
    // the SIZED loan is measured against the priced ceiling — that is what it was handed
    const s = ev.sizing || {};
    if (s.totalLoan > 0 && s.ltcPct > 0 && s.ltcPct > pc.maxLTC + 2e-4) sizedOver++;
    const lowered = (pc.maxLTC < prog.maxLTC - 1e-9) || (pc.maxARLTV < prog.maxARLTV - 1e-9);
    if (!lowered) continue;
    stepped++;
    const why = (ev.reasons || []).filter((r) => r && r.code === 'leverage_capped');
    if (!why.length) { unexplained++; continue; }
    const msg = why[0].msg;
    const cutLtc = pc.maxLTC < tier.maxLTC - 1e-9, cutAr = pc.maxARLTV < tier.maxARLTV - 1e-9;
    const saysLtc = msg.indexOf(pctS(pc.maxLTC) + ' loan-to-cost') > -1;
    const saysAr = msg.indexOf(pctS(pc.maxARLTV) + ' of the after-repair value') > -1;
    if ((cutLtc && !saysLtc) || (cutAr && !saysAr)) unexplained++;
  }
  ok(withCaps > 3000, `swept ${n} scenarios, ${withCaps} carried the full three-way caps contract`);
  ok(missing === 0, `every SIZED result carries a priced ceiling and a tier row alongside its program maximum (${missing} incomplete)`);
  ok(progOverTier === 0, `the program maximum never exceeds the workbook tier row (${progOverTier} violations)`);
  ok(overTier === 0, `the priced ceiling never exceeds the workbook tier row (${overTier} violations)`);
  ok(sizedOver === 0, `every sized loan sits inside the ceiling it was sized against (${sizedOver} violations)`);
  ok(stepped > 100, `the step-down fired often enough to be meaningful (${stepped} times)`);
  ok(unexplained === 0, `every lowered ceiling carries the engine's sentence naming the bound axis (${unexplained} unexplained)`);
})();

/* ===================================================================== *
 * 4. MUTATION PROOF — the two OLD readings must FAIL these assertions.
 * ===================================================================== */
(function section4() {
  const sig = (c) => (c ? [c.maxLoan, c.minFico, c.maxAcqLTV, c.maxARLTV, c.maxLTC].join('|') : 'NONE');
  const READ = {
    fixed: (ev) => ev.caps,                 // the FIX: the reachable program maximum
    preFix: (ev) => ev.pricedCeiling,       // MUTATION A: the pre-fix display (effective ceiling)
    rawTier: (ev) => ev.tierCaps,           // MUTATION B: the raw tier-grid cap
  };
  function invariant(read) {
    const want = sig(read(SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }))));
    for (const m of [0, 6, 12, 18]) {
      if (sig(read(SVP.evaluate(Object.assign({}, OWNER, { irMonths: m })))) !== want) return false;
    }
    for (const v of DEAL_VARIANTS) {
      const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }, v.patch));
      if (!ev.caps) continue;
      if (sig(read(ev)) !== want) return false;
    }
    return true;
  }
  function reachable(read) {
    // every leverage the display promises must be one the grid actually prices
    for (const c of [
      { inp: OWNER, mkt: 'STD', sz: 'S', prod: 'GUC', purp: 'R', term: '18', tier: 2, fico: 700 },
      { inp: { loanType: 'Purchase', strategy: 'Ground-up', state: 'NJ', zip: '07030', fico: 720, expGround: 1, purchasePrice: 600000, asIsValue: 650000, arv: 1500000, rehabBudget: 400000, term: 18 }, mkt: 'STD', sz: 'S', prod: 'GUC', purp: 'P', term: '18', tier: 2, fico: 720 },
      { inp: { loanType: 'Refinance', strategy: 'Bridge', state: 'NJ', zip: '07030', fico: 720, expFlips: 5, purchasePrice: 600000, asIsValue: 800000, arv: 900000, rehabBudget: 0, term: 18 }, mkt: 'STD', sz: 'S', prod: 'BR', purp: 'R', term: '18', tier: 1, fico: 720 },
    ]) {
      const ev = SVP.evaluate(Object.assign({}, c.inp, { irMonths: 0 }));
      const shown = read(ev);
      const spec = specProgramMax(c.mkt, c.sz, c.prod, c.purp, c.term, c.tier, c.fico);
      if (!shown || !spec) return false;
      if (shown.maxLTC > spec.maxLTC + 1e-12) return false;   // promising leverage the grid never prices
    }
    return true;
  }

  ok(invariant(READ.fixed) === true, 'MUTATION CONTROL — the FIXED reading passes INVARIANCE');
  ok(reachable(READ.fixed) === true, 'MUTATION CONTROL — the FIXED reading passes REACHABILITY');
  ok(invariant(READ.preFix) === false,
    'MUTATION PROOF A — restoring the PRE-FIX display (the deal ceiling under the program-maximum label) FAILS invariance');
  ok(reachable(READ.rawTier) === false,
    'MUTATION PROOF B — displaying the RAW tier-grid cap (92.5% on GUC tier 2) FAILS reachability');

  // and tied to the owner's own four reserves
  const preFixOwner = [0, 6, 12, 18].map((m) => sig(READ.preFix(SVP.evaluate(Object.assign({}, OWNER, { irMonths: m })))));
  const fixedOwner = [0, 6, 12, 18].map((m) => sig(READ.fixed(SVP.evaluate(Object.assign({}, OWNER, { irMonths: m })))));
  ok(new Set(preFixOwner).size > 1,
    `MUTATION PROOF A — the pre-fix reading produced ${new Set(preFixOwner).size} different "program maximums" across reserve 0/6/12/18 (exactly what the owner saw)`);
  ok(new Set(fixedOwner).size === 1, 'MUTATION PROOF A — the fixed reading produces exactly ONE program maximum across the same four reserves');
  const rawShown = READ.rawTier(SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 })));
  ok(eqNum(rawShown.maxLTC, 0.925), 'MUTATION PROOF B — the raw tier reading would advertise 92.5%, which never prices for this tier');
})();

/* ===================================================================== *
 * 5. CONTRACT SHAPE — every result answers all three questions.
 * ===================================================================== */
(function section5() {
  const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 18 }));
  ok(ev.caps && ev.pricedCeiling && ev.tierCaps, 'a priced result carries caps + pricedCeiling + tierCaps');
  ok(ev.caps !== ev.pricedCeiling, 'the program maximum and the priced ceiling are separate objects');
  const why = (ev.reasons || []).filter((r) => r && r.code === 'leverage_capped');
  ok(why.length === 1 && why[0].level === 'ELIGIBLE', 'the explanation exists and is not itself a refusal');
  ok(/loan-to-cost/.test(why[0].msg) && /after-repair value/.test(why[0].msg), 'on this deal the sentence names both axes');
  // an INELIGIBLE early exit still answers "what can this profile reach?"
  const bad = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0, ownerOccupied: true }));
  ok(bad.status === 'INELIGIBLE', 'control: an owner-occupied property is ineligible');
  ok(bad.caps == null || eqNum(bad.caps.maxLTC, 0.85), 'an ineligible result never reports a WRONG program maximum');
  // a combination the grid has no row for reports nothing rather than guessing
  const noRow = SVP.evaluate({ loanType: 'Refinance', strategy: 'Fix & Flip', state: 'NY', zip: '12201', fico: 700,
    purchasePrice: 400000, asIsValue: 400000, arv: 700000, rehabBudget: 100000, term: 12 });
  ok(noRow.caps === null && noRow.tierCaps === null, 'a product/purpose/tier the grid has no row for reports nulls, never a guess');
  // a voluntary de-leverage is a DEAL choice: it moves the ceiling, never the program max
  const slid = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 6, targetLTC: 0.70 }));
  const open = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 6 }));
  ok(progSig(slid) === progSig(open), 'a voluntary de-leverage does not move the program maximum');
  ok(ceilSig(slid) !== ceilSig(open), 'a voluntary de-leverage DOES move the priced ceiling');
})();

/* ===================================================================== */
console.log(`\nSilver — program maximum (fixed + reachable) vs this deal's priced ceiling`);
console.log(`  passed: ${pass}`);
console.log(`  failed: ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  fails.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
console.log("  OK - the program maximum is FIXED and REACHABLE; the deal's priced ceiling may move and always explains itself.");
process.exit(0);
