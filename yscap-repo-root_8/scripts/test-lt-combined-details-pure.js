#!/usr/bin/env node
/**
 * THE DETAILS PANEL ON THE COMBINED BOARD — every Lender Price row carries its own itemization,
 * and our margin holdback moves the price build without breaking its arithmetic.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR (owner-reported 2026-09-01: *"the LLPA and adjustments don't
 * populate in the whole nice, laid-out table … Nothing populates at all"*). The combined route
 * parsed Lender Price with `lp.parse`, which returns the LADDER and nothing else — no itemized
 * LLPAs, no fees, no comp, no terms, no monthly payment. Lender Price ships all of that WITH the
 * search, so it was being thrown away on the one vendor that gives it for free.
 *
 * And it was worse than a missing panel. `quote-shape.programsForBoard` tells the two vendors apart
 * by SHAPE — a programme with `rungs` and no `options` is a LoanNEX programme — because the
 * one-system rule has already stripped the source by the time it runs. So every Lender Price
 * programme was additionally REBUILT by the LoanNEX adapter, which hard-codes `basePoints: null`
 * and `adjustmentPoints: null` and reads the monthly payment from a key a Lender Price rung does
 * not carry. The row on the board was a LoanNEX-shaped copy of a Lender Price quote.
 *
 * PURE. Both vendor clients are stubbed before anything requires the route, and the settings the
 * route would read from the database are passed in — so `priceBoth`, the real function the HTTP
 * price door calls, is driven end to end with no network and no Postgres. Asserting through it
 * rather than through the parser is the whole point: the parser was never broken, the ROUTE never
 * asked it for the itemization.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ⛔ STUB FIRST, THEN REQUIRE — the route captures the clients at require time.
const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client'));
const lpClient = require(path.join(ROOT, 'src/longterm/lenderprice/client'));

/** One Lender Price leaf, in the vendor's own shape, carrying everything the panel draws. */
const leaf = (rate, adjPts) => ({
  companyId: 'L1', companyName: 'Acra Lending', programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
  rate, adjustedPoints: adjPts, basePoints: adjPts - 0.5, adjustmentPoints: 0.5,
  dayLock: 30, term: 30, loanAmount: 375000, dscr: 1.3, fico: 760, ltv: 75,
  monthlyPayment: { monthlyPI: 2500, mi: 0 },
  groupAdjustmentProperties: [
    { name: 'FICO/LTV', adjustments: [{ key: 'FICO 760-779, LTV 70.01-75.00', type: 'LLPA', valueType: 'Points', llpa: 0.75 }] },
    { name: 'DSCR', adjustments: [{ key: 'DSCR >= 1.25', type: 'LLPA', valueType: 'Points', llpa: -0.25 }] },
  ],
  totalOriginationFee: 3750, totalLenderFees: 1200, cashToCloseAmount: 130000,
  borrowerPaid: 5036.5, borrowerPaidDetails: [{ amount: 5036.5 }],
  ratePeriod: { validAsOf: '2026-08-29T12:00:00Z' }, expired: false,
});
const LP_RAW = { results: { qualifiedNonQMData: {
  type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
  childs: [{ type: 'LenderKey', keyLabel: 'Acra Lending', plenderId: 'L1', leafs: [leaf(7.5, 1.0), leaf(7.0, 2.0)] }],
} } };
lpClient.price = async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: {}, provenance: null });
nexClient.price = async () => ({ board: { source: 'loannex', programs: [{
  lender: 'NQM Funding', investor: 'NQM Funding', program: 'DSCR 30 Yr', product: '30 Yr Fixed',
  rungs: [{ rate: 7, price: 101.5, points: -1.5, lockDays: 30, payment: 2400, priceHashKey: 'h1' }],
}] } });

const { priceBoth } = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'))._internals;
const vendorMargin = require(path.join(ROOT, 'src/longterm/pricing/vendor-margin'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const r3 = (n) => Math.round(n * 1000) / 1000;

const SCENARIO = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3 };
// Acra is one of the three the OWNER moved to LoanNEX, so it must be routed back to Lender Price
// for this battery — the point is the Lender Price SHAPE, not which investor sits where.
const TO_LP = { acra: { source: 'lenderprice' } };
const board = (opts = {}) => priceBoth(SCENARIO, { marginHoldback: null, routes: TO_LP, links: {}, ...opts });
/** The Lender Price row on the board: the one that is not the stubbed LoanNEX programme. */
const lpRowOf = (out) => (out.programs || []).find((p) => p.program === 'DSCR 30 Yr Fixed') || null;
const nexRowOf = (out) => (out.programs || []).find((p) => p.program === 'DSCR 30 Yr') || null;

(async () => {
  console.log('\n── THE PANEL: a Lender Price row carries the build its own vendor published ──');
  {
    const out = await board({ shape: 'options' });
    const lp = lpRowOf(out);
    ok(!!lp, 'DET-0 the Lender Price programme reaches the board at all');
    const opts = (lp && lp.options) || [];
    ok(opts.length === 2, `DET-1 both priced quotes arrive as OPTIONS, not as one hollow programme (${opts.length})`);
    // Rate-ascending, exactly as parseFull orders them, so option 0 is the 7.0.
    const o = opts[0] || {};
    const pb = o.priceBuild || {};
    ok(pb.basePoints === 1.5 && pb.adjustmentPoints === 0.5 && pb.adjustedPoints === 2 && pb.price === 98,
      `DET-2 the whole price build is the VENDOR'S — base ${pb.basePoints}, adjustments ${pb.adjustmentPoints}, adjusted ${pb.adjustedPoints}, price ${pb.price}`);
    // THE MUTATION THIS CATCHES: the LoanNEX adapter hard-codes both of these null.
    ok(pb.basePoints != null && pb.adjustmentPoints != null,
      'DET-3 …so the row was NOT rebuilt by the LoanNEX adapter, which hard-codes basePoints and adjustmentPoints null');
    ok(Array.isArray(o.adjustments) && o.adjustments.length === 2,
      `DET-4 the itemized LLPAs are on the row (${(o.adjustments || []).length} lines) — this is the owner's empty table`);
    ok((o.adjustments || []).some((a) => /FICO 760-779/.test(a.reason || '')),
      'DET-5 …and each line carries the vendor\'s own grid cell, which is the whole of "why is this price this price"');
    ok(o.monthlyPayment && o.monthlyPayment.monthlyPI === 2500,
      'DET-6 the monthly payment arrives — the LoanNEX adapter read it from `payment`, a key a Lender Price rung has never carried');
    ok(o.terms && o.terms.term === 30 && o.terms.dayLock === 30 && o.terms.loanAmount === 375000,
      'DET-7 the terms block is filled (term, lock, loan amount)');
    ok(o.fees && o.fees.totalOriginationFee === 3750 && o.fees.cashToClose === 130000,
      'DET-8 the vendor\'s own fee fields are filled');
    ok(o.comp && o.comp.borrowerPaid === 5036.5, 'DET-9 the compensation block is filled');
    ok(o.rateSheet && o.rateSheet.validAsOf === '2026-08-29T12:00:00Z' && o.rateSheet.expired === false,
      'DET-10 the rate sheet\'s own provenance and staleness verdict ride with it');
  }

  console.log('\n── THE ARITHMETIC ON THE PANEL ADDS UP ──');
  {
    const out = await board();
    const o = ((lpRowOf(out) || {}).options || [])[0] || {};
    const pb = o.priceBuild || {};
    ok(r3(pb.basePoints + pb.adjustmentPoints) === pb.adjustedPoints,
      `DET-11 base + adjustments = adjusted (${pb.basePoints} + ${pb.adjustmentPoints} = ${pb.adjustedPoints}) — the panel draws that as a running total, so a gap is an unexplained number`);
    const summed = (o.adjustments || []).reduce((s, a) => s + (a.value || 0), 0);
    ok(r3(summed) === pb.adjustmentPoints,
      `DET-12 the itemized lines sum to the vendor's own stated total (${r3(summed)} = ${pb.adjustmentPoints}) — the breakdown reconciles them and would say so if not`);
  }

  console.log('\n── ?shape=options COUNTS QUOTES, NOT PROGRAMMES ──');
  {
    const out = await board({ shape: 'options' });
    // 2 Lender Price quotes + 1 LoanNEX rung. It used to be 2: ONE hollow shell per Lender Price
    // programme, because `optionsFromLenderPrice` was handed the PROGRAMME rows.
    ok(out.options && out.options.count === 3, `OPT-1 three quotes, not two programmes (${out.options && out.options.count})`);
    const lpRows = (out.options.rows || []).filter((x) => x.priceBuild && x.priceBuild.basePoints != null);
    ok(lpRows.length === 2, `OPT-2 both Lender Price rows carry a real price build (${lpRows.length})`);
    ok(lpRows.every((x) => Array.isArray(x.adjustments) && x.adjustments.length === 2),
      'OPT-3 …and their itemized adjustments, which the hollow shells had none of');
  }

  console.log('\n── THE HOLDBACK MOVES THE PANEL WITH THE ROW, OR THEY QUOTE TWO PRICES ──');
  {
    const EXTRA = { acra: { source: 'lenderprice', holdback: 0.25 } };
    const out = await priceBoth(SCENARIO, { marginHoldback: null, routes: EXTRA, links: {}, revealSource: true });
    const lp = lpRowOf(out);
    const rung = ((lp || {}).rungs || []).find((r) => r.rate === 7) || {};
    const o = ((lp || {}).options || []).find((x) => x.priceBuild && x.priceBuild.noteRate === 7) || {};
    const pb = o.priceBuild || {};
    ok(rung.price === 97.75, `HB-1 the ladder's price is held back (98 → ${rung.price})`);
    ok(pb.price === 97.75, `HB-2 the panel's price moves with it (${pb.price}) — a board saying 97.75 beside a panel saying 98 is worse than the empty panel it replaced`);
    ok(pb.adjustedPoints === 2.25, `HB-3 the points shift by exactly the same amount (${pb.adjustedPoints})`);
    ok(pb.basePoints === 1.75, `HB-4 …and so does the BASE (${pb.basePoints}), which is what keeps the running total summing`);
    ok(r3(pb.basePoints + pb.adjustmentPoints) === pb.adjustedPoints,
      'HB-5 base + adjustments STILL = adjusted under a holdback — the panel shows no unexplained gap');
    ok(pb.adjustmentPoints === 0.5 && (o.adjustments || []).length === 2,
      'HB-6 the vendor\'s own LLPA total and its lines are UNTOUCHED — moving them would make the panel accuse the rate sheet of not adding up');
    ok(pb.vendorPrice === 98 && pb.vendorBasePoints === 1.5 && pb.vendorAdjustedPoints === 2,
      'HB-7 the pre-holdback numbers ride along for the reveal, exactly as `vendorPrice` does on a rung');
  }

  console.log('\n── AND THE TRAIL IS STRIPPED WHEN NOBODY ASKED WHERE THE ROW CAME FROM ──');
  {
    const EXTRA = { acra: { source: 'lenderprice', holdback: 0.25 } };
    const plain = await priceBoth(SCENARIO, { marginHoldback: null, routes: EXTRA, links: {} });
    const o = ((lpRowOf(plain) || {}).options || [])[0] || {};
    const pb = o.priceBuild || {};
    ok(pb.price === 97.75, 'STRIP-1 the price still has the holdback in it — "baked into the rate" is the owner\'s own rule');
    ok(!('vendorPrice' in pb) && !('vendorBasePoints' in pb) && !('vendorAdjustedPoints' in pb) && !('marginHoldback' in o),
      'STRIP-2 …and our own margin, and the pre-holdback price it was taken from, do NOT ride out inside the price build');
    ok(!('marginHoldback' in (lpRowOf(plain) || {})),
      'STRIP-3 nor on the programme itself');
  }

  console.log('\n── NOTHING ABOUT THE LOANNEX SIDE MOVED ──');
  {
    const out = await board();
    const nx = nexRowOf(out);
    const o = ((nx || {}).options || [])[0] || {};
    ok(!!nx && (nx.options || []).length === 1, 'NEX-1 the LoanNEX programme is still converted to one option per rung');
    ok(o.priceBuild && o.priceBuild.basePoints === null && o.priceBuild.adjustmentPoints === null,
      'NEX-2 …and still says plainly that it published no base or adjustment total with the ladder — it explains on demand');
    ok(o.monthlyPayment && o.monthlyPayment.monthlyPI === 2400, 'NEX-3 …and its payment still comes off its own `payment` key');
    ok(o.explain && o.explain.vendor === 'loannex' && o.explain.priceHashKey === 'h1',
      'NEX-4 …and it still carries the handle the explain door needs');
  }

  console.log('\n── THE PARSER WITH THE FLAG OFF IS BYTE-IDENTICAL ──');
  {
    const plain = lpClient.parse(LP_RAW);
    const withOpts = lpClient.parse(LP_RAW, { withOptions: true });
    const full = lpClient.parseFull(LP_RAW);
    const stripped = {
      ...withOpts,
      programs: withOpts.programs.map(({ options, optionCount, lenderShort, ...rest }) => rest),
    };
    delete stripped.optionCount;
    ok(JSON.stringify(plain) === JSON.stringify(stripped),
      'PARSE-1 `parse(raw)` is unchanged to the byte — every existing caller, the general engine included, is untouched');
    ok(JSON.stringify(withOpts.programs[0].options) === JSON.stringify(full.programs[0].options),
      'PARSE-2 the options it attaches are `parseFull`\'s own, in `parseFull`\'s own order — one grouping loop, so the two can never fall out of alignment');
    ok(JSON.stringify(plain.programs[0].rungs) === JSON.stringify(withOpts.programs[0].rungs),
      'PARSE-3 …and the ladder the merge, the comparison and the ladder module read is unchanged beside them');
  }

  console.log('\n── shiftOptions: the rules it must never break ──');
  {
    const { shiftOptions } = vendorMargin._internals;
    ok(shiftOptions(undefined, 0.25) === undefined, 'SHIFT-1 a programme with no options is returned untouched, never coerced into an array');
    const noBuild = shiftOptions([{ terms: {} }], 0.25);
    ok(noBuild[0].priceBuild === undefined && !('marginHoldback' in noBuild[0]),
      'SHIFT-2 an option with no price build is left alone rather than given an invented one');
    const once = shiftOptions([{ priceBuild: { price: 98, adjustedPoints: 2, basePoints: 1.5 } }], 0.25);
    const twice = shiftOptions(once, 0.25);
    ok(JSON.stringify(once) === JSON.stringify(twice),
      'SHIFT-3 shifting twice is shifting once — `vendorPrice` is the anchor, so a second pass can never take the holdback twice');
    const noBase = shiftOptions([{ priceBuild: { price: 98, adjustedPoints: 2 } }], 0.25);
    ok(noBase[0].priceBuild.price === 97.75 && !('basePoints' in noBase[0].priceBuild),
      'SHIFT-4 a vendor that stated no base gets none invented — the breakdown derives one and would have made ours indistinguishable from the sheet\'s');
    const zero = shiftOptions([{ priceBuild: { price: 98, adjustedPoints: 2, basePoints: 1.5 } }], 0);
    ok(zero[0].priceBuild.price === 98 && zero[0].priceBuild.basePoints === 1.5,
      'SHIFT-5 a holdback of zero moves no number');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
