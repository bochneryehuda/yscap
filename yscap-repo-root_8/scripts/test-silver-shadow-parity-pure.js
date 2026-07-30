'use strict';
/**
 * SILVER SHADOW-EXCEL PARITY MONITOR — pure battery (no DB, no network).
 *
 * Proves src/lib/silver-shadow-parity.js against the frozen Silver engine +
 * the EMCAP workbook fixture:
 *  (a) a clean ELIGIBLE scenario ties out → ok (incl. a non-default markup);
 *  (b) a doctored result ONE BAND LOW → rate_mismatch (an under-priced rate is
 *      NEVER tolerated, even sitting on a band edge);
 *  (c) rate one band UP with the achieved ratio ON a band edge → ok (the
 *      knife-edge tolerance), the same rate one band UP far from any edge →
 *      rate_mismatch;
 *  (d) engine-ELIGIBLE where the fixture has no cell family (tier-3 F&F refi)
 *      → eligibility_mismatch;
 *  (e) a MANUAL no-cell verdict on a knife-edge → ok (mirror tolerance), the
 *      same verdict off-edge → eligibility_mismatch (workbook prices it);
 *  (f) hostile/garbage input → { ok:true, skipped } — NEVER throws;
 *  plus cap drift → cap_mismatch, a MANUAL-with-rate (FICO waiver) tie-out,
 *  the admin-override / no-FICO skips, and the kill switch.
 *
 * Run: node scripts/test-silver-shadow-parity-pure.js
 */

const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'tools', 'silver-program.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json'));
const monitor = require(path.join(__dirname, '..', 'src', 'lib', 'silver-shadow-parity'));

let failures = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('PASS', msg); }
  else { failures++; console.error('FAIL', msg); }
}

// Evaluate with an explicit markup, exactly as the quote path would.
function evalWith(input, markup) {
  SVP.setMarkup(markup);
  try { return SVP.evaluate(input); } finally { SVP.setMarkup(null); }
}

/* ---- base scenarios (verified shapes; see the matrix runner for the method) ---- */
// (a) clean ELIGIBLE fix & flip purchase, Tier 1, standard market.
const A = {
  loanType: 'Purchase', cashOut: false, strategy: 'Fix & Flip', state: 'NJ', city: 'Hoboken', zip: '07030',
  propertyType: 'single family', fico: 740, expFlips: 4, expHolds: 1, expGround: 0,
  purchasePrice: 300000, sellerPrice: 0, isAssignment: false, asIsValue: 300000, arv: 550000,
  rehabBudget: 100000, term: 12, irMonths: 0, irAmount: 0, targetLTC: 0,
  markupSilverPct: 0.5,   // explicit per-file markup → deterministic without settings/DB
};

/* (a) clean ELIGIBLE ties out */
(function cleanEligible() {
  const ev = evalWith(A, 0.005);
  ok(ev.status === 'ELIGIBLE' && ev.noteRate > 0, '(a) fixture scenario is ELIGIBLE with a rate');
  const r = monitor.shadowCheck(A, ev);
  ok(r.ok === true && !r.skipped, `(a) clean ELIGIBLE → ok (got ${JSON.stringify(r)})`);
  // buy-rate tie-up: the exact cell must equal noteRate − markup
  const cell = FIX.rates[ev.rateKey];
  ok(cell != null && Math.abs(ev.noteRate - 0.005 - cell) < 1e-9, '(a) buy rate (note − markup) equals the workbook cell');

  // non-default markup (0.75%) resolves identically
  const A2 = { ...A, markupSilverPct: 0.75 };
  const ev2 = evalWith(A2, 0.0075);
  const r2 = monitor.shadowCheck(A2, ev2);
  ok(ev2.noteRate > 0 && r2.ok === true && !r2.skipped, '(a) clean ELIGIBLE at a 0.75% markup → ok');
})();

/* (b) doctored ONE BAND LOW → rate_mismatch, even ON an edge */
(function underPriced() {
  const ev = evalWith(A, 0.005);
  ok(Math.abs(ev.sizing.ltcPct - 0.925) < 1e-9, '(b) scenario sits ON the 92.5% band edge (cap-bound)');
  const doctored = { ...ev, noteRate: ev.noteRate - 0.00125 };   // one grid band lower
  const r = monitor.shadowCheck(A, doctored);
  ok(r.ok === false && r.kind === 'rate_mismatch', `(b) one band LOW → rate_mismatch (got ${JSON.stringify(r && r.kind)})`);
  ok(/LOWER/.test(String(r.detail)), '(b) the detail names the UNDER-priced direction');
})();

/* (c) one band UP: tolerated ON an edge, flagged off-edge */
(function knifeEdgeUp() {
  // C1: voluntary de-leverage to exactly 0.85 — a real band edge; LTC binds there.
  const C1 = { ...A, arv: 900000, rehabBudget: 300000, targetLTC: 0.85 };
  const ev1 = evalWith(C1, 0.005);
  ok(ev1.status === 'ELIGIBLE' && Math.abs(ev1.sizing.ltcPct - 0.85) < 1e-9, '(c) edge scenario lands exactly on the 85% edge');
  const exact1 = FIX.rates[ev1.rateKey];
  const oneUp = exact1 + 0.00125;               // the one-band-up neighbor's rate
  const famHasOneUp = Object.keys(FIX.rates).some((k) =>
    k.startsWith('STD|S|FF|P|12|T1|') && Math.abs(FIX.rates[k] - oneUp) < 1e-9);
  ok(famHasOneUp, '(c) the one-band-up rate is a real same-family workbook rate');
  const rEdge = monitor.shadowCheck(C1, { ...ev1, noteRate: oneUp + 0.005 });
  ok(rEdge.ok === true && rEdge.edge === 'rate_lagged', `(c) one band UP on the edge → ok/tolerated (got ${JSON.stringify(rEdge)})`);

  // C2: same structure levered to 0.83 — far from every band edge.
  const C2 = { ...A, arv: 900000, rehabBudget: 300000, targetLTC: 0.83 };
  const ev2 = evalWith(C2, 0.005);
  ok(ev2.status === 'ELIGIBLE' && Math.abs(ev2.sizing.ltcPct - 0.83) < 1e-9, '(c) off-edge scenario lands at 83% LTC');
  const rOff = monitor.shadowCheck(C2, { ...ev2, noteRate: FIX.rates[ev2.rateKey] + 0.00125 + 0.005 });
  ok(rOff.ok === false && rOff.kind === 'rate_mismatch', `(c) one band UP off-edge → rate_mismatch (got ${JSON.stringify(rOff && rOff.kind)})`);
  ok(/HIGHER/.test(String(rOff.detail)), '(c) the detail names the OVER-priced direction');
})();

/* (d) engine-ELIGIBLE where the workbook has no cell family (tier-3 F&F refi) */
(function noTierRow() {
  const D = { ...A, loanType: 'Refinance', expFlips: 0, expHolds: 0, expGround: 0 };
  const evD = evalWith(D, 0.005);
  ok(evD.status === 'INELIGIBLE', '(d) the engine itself refuses a tier-3 F&F refi');
  // honest refusal → nothing to flag
  const rHonest = monitor.shadowCheck(D, evD);
  ok(rHonest.ok === true, '(d) an honest refusal of the no-row family → ok');
  // doctored ELIGIBLE-with-rate against the same inputs → eligibility_mismatch
  const doctored = { status: 'ELIGIBLE', noteRate: 0.09, sizing: { totalLoan: 200000, ltcPct: 0.8 } };
  const r = monitor.shadowCheck(D, doctored);
  ok(r.ok === false && r.kind === 'eligibility_mismatch', `(d) ELIGIBLE where the workbook has no tier row → eligibility_mismatch (got ${JSON.stringify(r && r.kind)})`);
})();

/* (e) MANUAL no-cell on a knife-edge → ok; off-edge → eligibility_mismatch.
   The natural artifact is ~2-in-204k (see the matrix runner), so the replay is
   injected via the documented test-only evOverride hook with the exact float
   shape the matrix observed (0.925 + 2e-16 raw, exact-decimal cell priced). */
(function edgeManual() {
  const E = { ...A, purchasePrice: 300000, asIsValue: 300000, rehabBudget: 300000, arv: 900000 };
  const capsRow = { maxLoan: 4500000, minFico: 640, maxAcqLTV: 0.90, maxARLTV: 0.75, maxLTC: 0.925 };
  const mk = (ltcRaw, total) => ({
    status: 'MANUAL', noteRate: 0, market: 'STD', sizeBand: 'S', product: 'FF', tier: 1,
    caps: capsRow, sizing: { totalLoan: total, ltcPct: ltcRaw },
    reasons: [{ level: 'MANUAL', msg: 'No priced grid cell for this profile — submit for individual review.' }],
  });
  // exact-decimal cell at snap9(0.9250000000000002)=0.925 IS priced:
  const exactKey = 'STD|S|FF|P|12|T1|<64.99%|FICO 700+|90.00%-92.50%';
  ok(FIX.rates[exactKey] != null, '(e) the exact-decimal edge cell is a real priced workbook cell');
  const onEdge = mk(0.9250000000000002, 555000.0000000001);
  const rEdge = monitor.shadowCheck(E, onEdge, { evOverride: onEdge, markup: 0.005 });
  ok(rEdge.ok === true && rEdge.edge === 'edge_manual', `(e) MANUAL no-cell ON the knife-edge → ok/tolerated (got ${JSON.stringify(rEdge)})`);
  // off-edge: raw 0.91 bands into a PRICED cell — the refusal contradicts the workbook
  const offEdge = mk(0.91, 546000);
  const rOff = monitor.shadowCheck(E, offEdge, { evOverride: offEdge, markup: 0.005 });
  ok(rOff.ok === false && rOff.kind === 'eligibility_mismatch', `(e) MANUAL no-cell OFF the edge where the workbook prices → eligibility_mismatch (got ${JSON.stringify(rOff && rOff.kind)})`);

  // NATURAL knife-edge (found by the 204k matrix runner, MATRIX_N=500 seed 1,
  // cell BR:3:R): a cap-bound bridge refi whose AR ratio lands 1.9e-10 above
  // the 64.99% edge — the frozen engine's raw float bands UP into an unpriced
  // cell and routes to MANUAL while exact-decimal arithmetic prices the edge.
  // Runs through the REAL engine replay (no evOverride).
  const NAT = {
    loanType: 'Refinance', cashOut: false, strategy: 'Bridge (stabilized)', state: 'AZ', zip: '85001', city: '',
    propertyType: 'single family', ownerOccupied: false, fico: 782, expFlips: 0, expHolds: 0, expGround: 0,
    purchasePrice: 1058002, asIsValue: 1058002, arv: 0, rehabBudget: 0, term: 18, irMonths: 2,
    monthlyRent: 0, payoff: 389649, targetLTC: 0.6499, markupSilverPct: 0.5,
  };
  const evNat = evalWith(NAT, 0.005);
  ok(evNat.status === 'MANUAL' && !(evNat.noteRate > 0) &&
     (evNat.reasons || []).some((x) => /No priced grid cell/.test(x.msg)),
    '(e) the NATURAL knife-edge scenario reproduces (engine MANUAL, no cell)');
  const rNat = monitor.shadowCheck(NAT, evNat);
  ok(rNat.ok === true && rNat.edge === 'edge_manual', `(e) natural knife-edge MANUAL through the real replay → ok/tolerated (got ${JSON.stringify(rNat)})`);
})();

/* caps drift → cap_mismatch */
(function capDrift() {
  const ev = evalWith(A, 0.005);
  const drifted = { ...ev, caps: { ...ev.caps, minFico: 700 } };
  const r = monitor.shadowCheck(A, drifted, { evOverride: drifted, markup: 0.005 });
  ok(r.ok === false && r.kind === 'cap_mismatch', `caps drifted off the tier grid → cap_mismatch (got ${JSON.stringify(r && r.kind)})`);
})();

/* the SERVED sizing is judged, not only the monitor's own replay (fix 2026-07-30,
   item 6): every other check reads ev.sizing (the replay), so a quote whose loan
   was changed AFTER the engine sized it used to come back { ok:true }. */
(function servedSizing() {
  const ev = evalWith(A, 0.005);
  const row = FIX.tierGrid['FF|P|T1'];
  ok(row && row.maxloan === 4500000, 'served-sizing control: the workbook tier row caps FF|P|T1 at $4.5M');
  // 3x the tier maximum — the audit's negative control (used to be MISSED)
  const over = { ...ev, sizing: { ...ev.sizing, totalLoan: row.maxloan * 3 } };
  const rOver = monitor.shadowCheck(A, over);
  ok(rOver.ok === false && rOver.kind === 'cap_mismatch',
    `a SERVED loan at 3x the tier maximum → cap_mismatch (got ${JSON.stringify(rOver && rOver.kind)})`);
  ok(/SERVED/.test(String(rOver.detail)) && /13,500,000/.test(String(rOver.detail)),
    'the detail names the SERVED figure, not the replay');
  // over the small-band ceiling while still under the tier maximum
  const overBand = { ...ev, sizing: { ...ev.sizing, totalLoan: 2600000 } };
  const rBand = monitor.shadowCheck(A, overBand);
  ok(rBand.ok === false && rBand.kind === 'cap_mismatch',
    `a SERVED loan over the $2.5M small-band ceiling → cap_mismatch (got ${JSON.stringify(rBand && rBand.kind)})`);
  // exactly ON the ceiling, and the honest figure, stay clean; a missing/garbage
  // served sizing FAILS OPEN (never a false advisory)
  ok(monitor.shadowCheck(A, { ...ev, sizing: { ...ev.sizing, totalLoan: 2500000 } }).ok === true,
    'a SERVED loan exactly on the band ceiling is not flagged');
  ok(monitor.shadowCheck(A, ev).ok === true, 'the honest served sizing is not flagged');
  ok(monitor.shadowCheck(A, { ...ev, sizing: { ...ev.sizing, totalLoan: 'oops' } }).ok === true,
    'a garbage served sizing fails OPEN');
})();

/* MANUAL-with-rate (FICO waiver below the tier minimum) still ties out */
(function manualWithRate() {
  const W = {
    ...A, loanType: 'Refinance', fico: 680,   // FF|R|T1 minFico is 700 → waiver MANUAL
    purchasePrice: 400000, asIsValue: 400000, arv: 700000, rehabBudget: 100000,
  };
  const ev = evalWith(W, 0.005);
  ok(ev.status === 'MANUAL' && ev.noteRate > 0, 'waiver scenario is MANUAL with a priced rate');
  const r = monitor.shadowCheck(W, ev);
  ok(r.ok === true, `a MANUAL-with-rate quote that matches the workbook → ok (got ${JSON.stringify(r)})`);
})();

/* skips: admin override, missing FICO, unknown status */
(function skips() {
  const ev = evalWith(A, 0.005);
  const rOvr = monitor.shadowCheck({ ...A, ovrRate: 0.10 }, ev);
  ok(rOvr.ok === true && rOvr.skipped === 'admin_override', 'an admin rate override is skipped, never flagged');
  const rForce = monitor.shadowCheck({ ...A, forcePrice: true }, ev);
  ok(rForce.ok === true && rForce.skipped === 'admin_override', 'a force-priced exception is skipped');
  const rNoFico = monitor.shadowCheck({ ...A, fico: 0 }, ev);
  ok(rNoFico.ok === true && rNoFico.skipped === 'no_fico', 'a quote with no FICO (provisional pricing) is skipped');
  const rNoStatus = monitor.shadowCheck(A, { noteRate: 0.09 });
  ok(rNoStatus.ok === true && rNoStatus.skipped === 'no_status', 'a result with no recognizable status is skipped');
})();

/* (f) hostile/garbage input — NEVER throws, always fails open */
(async function hostile() {
  const cases = [
    ['null/null', () => monitor.shadowCheck(null, null)],
    ['undefined/obj', () => monitor.shadowCheck(undefined, {})],
    ['string input', () => monitor.shadowCheck('garbage', { status: 'ELIGIBLE' })],
    ['empty objects', () => monitor.shadowCheck({}, {})],
    ['junk fields', () => monitor.shadowCheck({ fico: 'NaNny', strategy: { a: 1 }, term: [] }, { status: 'ELIGIBLE', noteRate: 'x' })],
    ['throwing proxy input', () => monitor.shadowCheck(new Proxy({}, { get() { throw new Error('boom'); } }), { status: 'ELIGIBLE' })],
    ['throwing proxy result', () => monitor.shadowCheck(A, new Proxy({}, { get() { throw new Error('boom'); } }))],
  ];
  for (const [name, fn] of cases) {
    let r, threw = false;
    try { r = fn(); } catch (_) { threw = true; }
    ok(!threw && r && r.ok === true, `(f) ${name} → { ok:true${r && r.skipped ? `, skipped:'${r.skipped}'` : ''} }, never throws`);
  }
  // A cyclic input evaluates like the real scenario it wraps — the monitor must
  // survive it AND still catch the doctored under-priced rate riding on it.
  let rCyc, threwCyc = false;
  try { const c = { ...A }; c.self = c; rCyc = monitor.shadowCheck(c, { status: 'ELIGIBLE', noteRate: 0.09, sizing: { totalLoan: 370000 } }); }
  catch (_) { threwCyc = true; }
  ok(!threwCyc && rCyc && rCyc.ok === false && rCyc.kind === 'rate_mismatch',
    '(f) cyclic input never throws — and the doctored low rate on it is still caught');

  // monitorQuote is equally throw-proof, with NO real DB behind it: a mismatch's
  // best-effort record fails open ({recorded:false}) instead of erroring.
  const fakeDb = { query: async () => { throw new Error('no db in the pure test'); } };
  const ev = evalWith(A, 0.005);
  const doctored = { ...ev, noteRate: ev.noteRate - 0.00125 };
  let mq, threwMq = false;
  try { mq = await monitor.monitorQuote('00000000-0000-0000-0000-000000000000', A, doctored, { db: fakeDb }); }
  catch (_) { threwMq = true; }
  ok(!threwMq && mq && mq.ok === false && mq.kind === 'rate_mismatch' && mq.record && mq.record.recorded === false,
    '(f) monitorQuote on a mismatch with a dead DB → reports the mismatch, record fails OPEN, never throws');
  let mq2, threw2 = false;
  try { mq2 = await monitor.monitorQuote(null, null, null); } catch (_) { threw2 = true; }
  ok(!threw2 && mq2 && mq2.ok === true, '(f) monitorQuote(null,null,null) → ok, never throws');

  /* kill switch */
  const prev = process.env.SILVER_SHADOW_PARITY;
  process.env.SILVER_SHADOW_PARITY = '0';
  const off = await monitor.monitorQuote('00000000-0000-0000-0000-000000000000', A, doctored, { db: fakeDb });
  ok(off.ok === true && off.skipped === 'disabled', 'SILVER_SHADOW_PARITY=0 disables the monitor');
  if (prev === undefined) delete process.env.SILVER_SHADOW_PARITY; else process.env.SILVER_SHADOW_PARITY = prev;
  ok(monitor.enabled() === true, 'the monitor defaults to ON');

  /* resolver integrity */
  const R = monitor._internals.resolver();
  ok(R.ok === true, 'resolver built from the fixture');
  ok(R.EDGES.some((e) => e === 0.85) && R.EDGES.some((e) => e === 0.925) && R.EDGES.some((e) => e === 0.65),
    'band-edge set carries uppers AND lowers from the fixture labels');
  ok(Object.keys(R.familyRates).length > 0, 'per-family rate sets built');

  console.log(`\n${failures ? 'FAILED' : 'ALL PASSED'} — ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
