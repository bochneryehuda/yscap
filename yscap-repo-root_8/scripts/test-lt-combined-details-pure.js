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
const fs = require('fs');
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
const quoteShape = require(path.join(ROOT, 'src/longterm/pricing/quote-shape'));

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
    /* RE-POINTED 2026-09-02 (audit F8). This PINNED `explain.vendor === 'loannex'` as correct — on
       the ordinary board, whose whole rule is that it must not be tellable apart. A guard that
       requires the fingerprint is a guard that would have to be deleted to fix the defect, so it is
       turned around instead: the handle must still ADDRESS the quote, and must no longer NAME the
       vendor. Nothing ever read that field — `/explain` routes on `priceHashKey` and no browser
       code mentions it. */
    ok(o.explain && o.explain.priceHashKey === 'h1',
      'NEX-4 …and it still carries the handle the explain door needs');
    ok(o.explain && !('vendor' in o.explain),
      'NEX-4b …and that handle no longer NAMES the vendor — it addresses the quote without saying who sold it');
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

  console.log('\n── THE OTHER HALF: a row that has to be ASKED, and the door that answers ──');
  {
    // The LoanNEX side explains a row on demand. The door has existed since the board shipped and
    // no screen ever called it, so those rows drew the same empty panel — the other half of the
    // owner's report. It must hand back an OPTION (the shape the panel reads), with the base
    // brought into step with the held-back price the row is quoting.
    const express = require(path.join(ROOT, 'node_modules/express'));
    /* WHAT THE VENDOR WAS ASKED is captured, because the price on the handle is OURS (the holdback
       is applied to the LoanNEX board before the merge) and the door has to put the vendor's own
       figure back for the one call addressed to them. `answer` lets a case make the sheet SILENT. */
    let asked = null;
    let answer = 'evidence';
    nexClient.evidence = async (sc, quote) => { asked = quote; return answer === 'silent'
      ? { evidence: null, absence: { reason: 'vendor_returned_no_evidence', message: 'The rate sheet accepted the question and returned no breakdown for this quote.' }, transactionId: 't1' }
      : ({
      evidence: {
        rate: 7, lockPeriod: 30, basePrice: 101.5, baseRate: 6.75, priceFloor: 96, priceCeiling: 103,
        adjustments: [
          { name: 'FICO 760-779', description: 'FICO : 760 - 779', type: 'LLPA', priceAdjustment: -0.75 },
          { name: 'DSCR >= 1.25', description: 'DSCR : 1.25+', type: 'LLPA', priceAdjustment: 0.25 },
        ],
      },
      transactionId: 't1',
    }); };
    const app = express();
    app.use(express.json());
    app.use('/c', require(path.join(ROOT, 'src/longterm/routes/combined-pricer')).makeRouter({ superAdminOnly: false }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const r = await fetch(`${base}/c/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return r.json();
    };
    // The vendor's own build: base 101.5 with adjustments netting -0.5 in price = a final of 101.0.
    // Our 0.25 is taken off that, so the row on the board quotes 100.75 — which is what the panel
    // has to land on when it adds the base and the lines up.
    const QUOTE = { vendor: 'loannex', priceHashKey: 'h1', rate: 7, price: 100.75, lockDays: 30 };
    const RAW_QUOTE = { ...QUOTE, price: 101 };
    try {
      const r = await post({ quote: QUOTE, scenario: SCENARIO, investorKey: 'nqm', marginHoldback: 0.25, routes: {} });
      ok(r.ok === true && !!r.option, 'ASK-1 the door hands back an OPTION as well as the breakdown — so the panel never re-keys one shape into the other in the browser');
      const o = r.option || {};
      ok(Array.isArray(o.adjustments) && o.adjustments.length === 2,
        `ASK-2 …carrying the itemized adjustments (${(o.adjustments || []).length}), which is the empty table the owner reported on these rows`);
      ok((o.adjustments || []).every((a) => a.reason && a.detail),
        'ASK-3 …each with the vendor\'s own name AND the grid cell it came out of');
      const pb = o.priceBuild || {};
      ok(pb.price === 100.75, 'ASK-4 the price is the BOARD\'s — already held back, and never held back a second time here');
      ok(pb.basePoints === -1.25,
        `ASK-5 the base is brought into step with it (${pb.basePoints}) — the vendor\'s own -1.5 plus the 0.25 we took, so the panel\'s running total lands on the price printed under it`);
      ok(pb.basePoints != null && pb.adjustmentPoints != null && r3(pb.basePoints + pb.adjustmentPoints) === pb.adjustedPoints,
        `ASK-6 …so base + adjustments = adjusted (${pb.basePoints} + ${pb.adjustmentPoints} = ${pb.adjustedPoints}) on this side too`);
      ok(!('vendorBasePoints' in pb), 'ASK-7 and the pre-holdback base does NOT ride out — our margin is not readable off the panel by subtraction');

      // ⛔ A TOTAL ACCESSOR, because a mutation that stops the door returning an option at all must
      // FAIL these rather than throw: a crashing battery stops where it stands and reports a pass
      // rate that means nothing.
      const buildOf = (resp) => ((resp || {}).option || {}).priceBuild || {};

      const rev = await post({ quote: QUOTE, scenario: SCENARIO, investorKey: 'nqm', marginHoldback: 0.25, routes: {}, revealSource: true });
      ok(buildOf(rev).vendorBasePoints === -1.5,
        'ASK-8 …until an admin asks where the row came from, which is the same rule the board follows');

      const none = await post({ quote: RAW_QUOTE, scenario: SCENARIO, marginHoldback: 0, routes: {} });
      ok(buildOf(none).basePoints === -1.5,
        'ASK-9 with nothing held back the base is the vendor\'s own, untouched');

      const already = await post({ quote: { vendor: 'lenderprice', rate: 7, price: 98 }, scenario: SCENARIO });
      ok(already.ok === true && already.alreadyExplained === true && already.breakdown === null,
        'ASK-10 a row whose sheet published its build with the search is told so plainly — never refused, which would send somebody hunting for a call that was never needed');

      console.log('\n── THE VENDOR IS ASKED ABOUT ITS OWN PRICE, NOT OURS ──');
      answer = 'evidence';
      await post({ quote: QUOTE, scenario: SCENARIO, investorKey: 'nqm', marginHoldback: 0.25, routes: {} });
      ok(asked && asked.price === 101,
        `PRICE-1 the rate sheet is asked to itemise 101 — its OWN price — not the 100.75 the board is quoting after our margin (asked ${asked && asked.price})`);
      ok(asked && asked.priceHashKey === 'h1' && asked.rate === 7 && asked.lockDays === 30,
        'PRICE-2 …and nothing else on the question moves: the key that identifies the quote, the rate and the lock ride through untouched');
      await post({ quote: RAW_QUOTE, scenario: SCENARIO, marginHoldback: 0, routes: {} });
      ok(asked && asked.price === 101,
        'PRICE-3 with nothing held back the question is the quote itself — a board with no margin on it asks exactly what it always asked');

      console.log('\n── THE ROW SURVIVES THE EXPLANATION (the blank loan amount, term and payment) ──');
      /* The row as the board handed it to the panel: everything the handle does NOT carry, plus a
         STALE itemization and our own margin's trail, which a browser must not be able to assert. */
      const ROW = {
        lender: 'NQM Funding', program: 'DSCR 30 Yr', product: '30 Yr Fixed',
        terms: { loanAmount: 375000, term: 360, termInMonths: true, interestOnly: false, dayLock: 999 },
        monthlyPayment: { monthlyPI: 2400, mi: 0 },
        dscr: 1.3, stalenessUnknown: true,
        rateSheet: { expired: null, name: 'NQM 8/29', validAsOf: 'STALE' },
        adjustments: [{ reason: 'A LINE FROM AN EARLIER ANSWER', value: -9 }],
        eligibility: { provided: true, screen: 'STALE' },
        evidence: { fetched: true, appliesToThisRate: true, reason: 'inline_with_search' },
        priceBuild: { price: 999, noteRate: 999, basePoints: 999, adjustmentPoints: 999, vendorPrice: 101, vendorBasePoints: 42, vendorAdjustedPoints: 42, pointsDerivedFromPrice: true },
      };
      answer = 'evidence';
      const withRow = await post({ quote: QUOTE, scenario: SCENARIO, option: ROW, investorKey: 'nqm', marginHoldback: 0.25, routes: {} });
      const w = withRow.option || {};
      ok(w.terms && w.terms.loanAmount === 375000 && w.terms.term === 360 && w.terms.termInMonths === true,
        'ROW-1 the loan amount and the term are still there after the explanation — they were going blank the moment a row was explained, which is the owner\'s emptied panel');
      ok(w.monthlyPayment && w.monthlyPayment.monthlyPI === 2400 && w.dscr === 1.3 && w.stalenessUnknown === true,
        'ROW-2 …and the monthly payment, the ratio and the staleness verdict with them');
      ok(w.rateSheet && w.rateSheet.name === 'NQM 8/29',
        'ROW-3 …and the rate sheet\'s own name');
      ok(w.priceBuild.price === 100.75 && w.priceBuild.noteRate === 7 && w.terms.dayLock === 30,
        `ROW-4 the HANDLE still wins the rate, the price and the lock (${w.priceBuild.price} / ${w.priceBuild.noteRate} / ${w.terms.dayLock}) — the vendor's answer is judged against those, so a browser must not be able to move them`);
      ok((w.adjustments || []).length === 2 && !(w.adjustments || []).some((a) => /EARLIER ANSWER/.test(a.reason || '')),
        'ROW-5 a stale itemization sent up is REPLACED by this call\'s, never merged with it');
      ok(w.priceBuild.basePoints === -1.25 && !('vendorPrice' in w.priceBuild) && !('vendorBasePoints' in w.priceBuild),
        'ROW-6 …and our own margin\'s trail cannot be put back on the panel by asking for it');
      ok(w.eligibility === null || (w.eligibility && w.eligibility.screen !== 'STALE'),
        'ROW-7 …nor a stale eligibility answer');
      ok(w.priceBuild.pointsDerivedFromPrice === true,
        'ROW-8 but an ordinary fact of the row — how its points were arrived at — is kept, which is the whole point of sending it');
      /* ⛔ THIS IS WHAT THE `vendor*` STRIP IS ACTUALLY FOR. On the way OUT those three are removed
         anyway, so a test that only looked for them in the answer proves nothing. `vendorBasePoints`
         is the ANCHOR `holdBackExplainedBase` shifts the base FROM — so a browser able to assert one
         would decide where the panel's base sits. ROW carries a fabricated 42; the base must still
         be the vendor's own -1.5 moved by our 0.25. */
      ok(w.priceBuild.basePoints === -1.25,
        `ROW-9 a base anchor fabricated by the caller cannot move where the holdback shifts from (${w.priceBuild.basePoints}, not 42.25)`);

      console.log('\n── AND A SHEET THAT SAYS NOTHING IS QUOTED SAYING NOTHING ──');
      answer = 'silent';
      const quiet = await post({ quote: QUOTE, scenario: SCENARIO, option: ROW, investorKey: 'nqm', marginHoldback: 0.25, routes: {} });
      const q = quiet.option || {};
      ok(quiet.ok === true, 'WHY-1 a rate sheet that returns no breakdown is not an error — the call worked, the answer was empty');
      ok(q.evidence && q.evidence.appliesToThisRate === false && q.evidence.reason === 'vendor_returned_no_evidence',
        `WHY-2 …and the option says WHICH silence it was (${q.evidence && q.evidence.reason}) rather than an empty table that reads as "this quote has no adjustments"`);
      ok(q.evidence && /returned no breakdown/.test(q.evidence.message || ''),
        'WHY-3 …in the vendor\'s own words, which is what the panel prints where the table would have been');
      ok(q.terms && q.terms.loanAmount === 375000 && q.monthlyPayment && q.monthlyPayment.monthlyPI === 2400,
        'WHY-4 and the row is STILL whole — an unanswered question must not empty the panel it was asked from');
      /* ⛔ THIS IS THE CASE THE `adjustments` STRIP EXISTS FOR, and the only one. On a sheet that
         ANSWERS, `attachEvidence` overwrites the list wholesale, so the strip cannot bite there.
         On a sheet that says NOTHING it never touches the list — so without the strip the panel
         would print an earlier answer's itemization underneath today's silence, which is the exact
         lie the reason line is there to prevent. */
      ok(!Array.isArray(q.adjustments) || !q.adjustments.some((a) => /EARLIER ANSWER/.test(a.reason || '')),
        'WHY-5 …and an itemization from an earlier answer, sent up with the row, does NOT survive that silence');
      answer = 'evidence';
    } finally { server.close(); }
  }

  console.log('\n── AND THE SCREEN ACTUALLY ASKS (source, because there is no browser here) ──');
  {
    const fs = require('fs');
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const eng = read('app-v2/src/longterm/pricerEngine.js');
    const pricer = read('app-v2/src/longterm/LtPricer.jsx');
    const api = read('app-v2/src/longterm/api.js');
    /* ⛔ RE-POINTED, NOT LOOSENED (2026-09-03). This pinned `explain: null` on the general
       engine, whose subject was "an ordinary Lender Price board never makes a second call".
       That is still true and is asserted below — but the general board now carries LOANNEX
       rows too (the owner switched five investors onto that sheet), and a LoanNEX row ships
       the ladder and explains itself only when ASKED. So the general engine has a door of its
       OWN now; what must never happen is a SECOND IMPLEMENTATION of it, which is what the
       next two assertions pin. */
    ok(/key: 'general',[\s\S]{0,3000}?explain: \(quote, scenario, option\) => ltApi\.dscrExplain\(/.test(eng),
      'WIRE-1 the GENERAL engine has its own explain door — a LoanNEX row on that board can be asked to itemise itself');
    ok(/dscrExplain: \(quote, scenario, option\) => ltPost\(lt\('\/dscr\/explain'\)/.test(api),
      'WIRE-1b …at this engine\'s own path');
    ok(!/revealSource/.test((api.match(/dscrExplain[\s\S]{0,300}/) || [''])[0]),
      'WIRE-1c …and it never asks to be shown the vendor — this board is ONE SYSTEM');
    ok(/key: 'combined',[\s\S]{0,3000}?explain: \(quote, scenario, option\) => ltApi\.combinedExplain\(quote, scenario, option\)/.test(eng),
      'WIRE-2 the COMBINED engine points at the door, carrying the row the panel is drawing');
    ok(/combinedExplain: \(quote, scenario, option\) => ltPost\(lt\('\/dscr\/combined\/explain'\)/.test(api)
      && /quote, scenario, option, investorKey: \(quote && quote\.investorKey\) \|\| null/.test(api),
      'WIRE-3 the call posts to the real door and names WHICH investor\'s saved setting to read — a pointer, never an amount');
    ok(/const explainer = useExplain\(\);/.test(pricer),
      'WIRE-4 the panel reads the explain seam');
    ok(/oProp\.explain && oProp\.explain\.priceHashKey \? oProp\.explain : null/.test(pricer),
      'WIRE-5 …and only asks a row that carries a handle — a row that arrived explained is never asked');
    ok(/if \(r && r\.option\) setFetched\(r\.option\);/.test(pricer),
      'WIRE-6 …and merges the OPTION the door hands back, not a translated breakdown');
    ok(/\{askErr && \(/.test(pricer) && /setAskErr\(/.test(pricer),
      'WIRE-7 …and a refusal is SAID where the empty table would be — a blank space reads as "this quote has no adjustments", a claim no rate sheet made');
    ok(/<ExplainProvider value=\{explainRow\}>/.test(pricer) && /<\/ExplainProvider>/.test(pricer),
      'WIRE-8 the seam is actually provided — a back end nobody can reach is not a feature');
    ok(/if \(!engine\.explain \|\| !pricedForm\) return null;\s*\n\s*const sc = toScenario\(pricedForm\);/.test(pricer),
      'WIRE-9 …bound to the scenario the BOARD was priced with, never the form as it stands — a half-edited form must not make a panel explain the row in front of you against a different loan');
    ok(/explainer\(\{ \.\.\.handle, investorKey: invKey \}, oProp\)/.test(pricer),
      'WIRE-10 …and it SENDS the row it is drawing, which is what makes the answer come back whole instead of as the four fields the handle carries');
    ok(/const explainNote = \(!asking && !askErr && askable && ev && ev\.appliesToThisRate === false && adj\.length === 0\)/.test(pricer)
      && /\{explainNote && \(/.test(pricer),
      'WIRE-11 an unexplained build SAYS SO on the panel — computed from the server\'s own verdict and actually rendered, because a back end nobody can see is not a feature');
    ok(/o\.terms\.interestOnly != null/.test(pricer),
      'WIRE-12 an unstated interest-only flag draws an em dash, never a confident "Fully amortising" — Lender Price fills it on every option, so the general board is unchanged');
    ok(/\$\{engine\.sheetSubject\} returned no fee lines/.test(pricer)
      && /\$\{engine\.sheetSubject\} returned no comp lines/.test(pricer),
      'WIRE-13 the two empty states no longer name one vendor on a board quoted by two');
  }

  console.log('\n── THE LOANNEX ROW SAYS WHAT LOAN IT WAS QUOTED FOR ──');
  {
    /**
     * ⛔ THE DEFECT THIS EXISTS FOR (owner-reported: *"I realized that, by the loannex, it's
     * missing the loan amount by the terms"*). A LoanNEX rung states no loan amount — that figure
     * is the question we asked, not part of the vendor's answer — so the terms block restates it
     * from the search. `optionsFromLoanNex` was handed the search by the route; the BOARD builder
     * behind `programsForBoard`, which is the one the Details panel actually reads, was not. Two
     * copies of one rule, and the copy that drifted is the copy on screen.
     *
     * ONE REQUEST answers both ways here on purpose: whatever else changes, the two shapes a
     * single price call produces must not describe the loan differently.
     */
    const out = await board({ shape: 'options' });
    const nexRow = nexRowOf(out);
    const boardOpt = (nexRow && nexRow.options && nexRow.options[0]) || {};
    const bt = boardOpt.terms || {};

    ok(bt.loanAmount === 375000,
      `NEX-T1 the loan amount is on the LoanNEX row the panel draws (${bt.loanAmount === undefined ? 'key absent' : bt.loanAmount}) — the owner's em dash`);
    ok(bt.fico === 760 && bt.loanPurpose === 'Purchase',
      `NEX-T2 …and so is the rest of the search it was quoted for (FICO ${bt.fico}, ${bt.loanPurpose})`);

    // THE ANTI-DRIFT GUARD, and it is the assertion that would have caught this. Comparing the two
    // builders' whole terms blocks — not one field — is what makes the NEXT divergence fail here
    // instead of on somebody's screen.
    const optRow = ((out.options && out.options.rows) || []).find((r) => r.program === 'DSCR 30 Yr') || null;
    ok(!!optRow, 'NEX-T3 the same rung also reaches the ?shape=options answer, so the two are comparable');
    const ot = (optRow && optRow.terms) || {};
    /**
     * The two are NOT byte-identical and should not be: `optionsFromLoanNex` merges its terms into
     * the empty option's full shape, so it additionally carries `mortgageType` / `cltv` / `dti` /
     * `hti` as nulls that a LoanNEX rung never states. So the guard is exact in BOTH directions
     * instead of loose in one: every key the shared builder emits must AGREE, and any key only one
     * side carries must be null — a real value appearing on one board and not the other is the
     * failure, and a key going MISSING is the failure that shipped.
     *
     * The key list is DERIVED from the real builder, so adding a term keeps this honest for free.
     */
    const sharedKeys = Object.keys(quoteShape.loanNexTerms({}, {}, {}));
    const disagree = sharedKeys.filter((k) => JSON.stringify(bt[k]) !== JSON.stringify(ot[k]));
    ok(sharedKeys.length >= 12 && disagree.length === 0,
      `NEX-T4 the BOARD builder and the OPTIONS builder describe one rung identically across all ${sharedKeys.length} shared terms${disagree.length ? ` — disagree on ${disagree.join(', ')}` : ''}`);
    const extras = [...new Set([...Object.keys(bt), ...Object.keys(ot)])].filter((k) => !sharedKeys.includes(k));
    const nonNullExtras = extras.filter((k) => bt[k] != null || ot[k] != null);
    ok(nonNullExtras.length === 0,
      `NEX-T4b …and a key only one of them carries is null, never a figure the other board would not show (${nonNullExtras.join(', ') || 'none'})`);

    // An input nobody handed us is NULL, never 0: the validated scenario carries no LTV, and a
    // `0` there would print as a real leverage figure on a loan that has one.
    ok(bt.ltv === null && ot.ltv === null,
      `NEX-T5 an input the search never stated stays null, never 0 (ltv ${JSON.stringify(bt.ltv)})`);

    // The key must EXIST even when null — `r.lockDays` written raw is `undefined` on a rung that
    // omits it, and JSON DROPS an undefined key, so the panel reads a missing field rather than a
    // stated blank. This is the second way the two copies had drifted.
    ok(Object.prototype.hasOwnProperty.call(bt, 'loanAmount') && Object.prototype.hasOwnProperty.call(bt, 'dayLock'),
      'NEX-T6 …and the keys are present rather than undefined, so JSON cannot drop them on the way to the browser');

    // SOURCE GUARD: no pure test can see whether the ROUTE hands the search to both builders, and
    // wiring one and not the other is exactly how this shipped.
    const route = fs.readFileSync(path.join(ROOT, 'src/longterm/routes/combined-pricer.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/const nxSearch = \{[^}]*loanAmount: sc\.loan/.test(route),
      'NEX-T7 the route declares the search ONCE');
    ok(/optionsFromLoanNex\(\{ programs: progs \}, nxSearch\)/.test(route),
      'NEX-T8 …the options builder reads that one declaration');
    ok(/programsForBoard\([\s\S]{0,600}?\.\.\.nxSearch/.test(route),
      'NEX-T9 …and so does the board builder, which is the half that was missing');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
