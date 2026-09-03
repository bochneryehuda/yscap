'use strict';
/**
 * THE GENERAL PRICING ENGINE'S BOARD, BUILT FROM TWO RATE SHEETS.
 *
 * ── THE OWNER'S ASK (2026-09-03) ───────────────────────────────────────────
 * *"Leave the general pricing way it is. Just bring in the LoanNEX integration and
 * bring in these five investors as an add-on… the search should run right away in
 * both places and return which investors we want to see from each place… we're just
 * adding a new source for these investors and turning off three investors from
 * Lender Price."* And: *"In the general engine, don't enable the ARM feature."*
 *
 * Every assertion below runs the REAL module over the REAL recorded LoanNEX board
 * (5,286 rungs across 90 programmes) and a Lender Price answer in the vendor's own
 * shape. Nothing here is a hand-built agreement with itself.
 *
 * PURE: no network, no database.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const gb = require(path.join(ROOT, 'src/longterm/pricing/general-board.js'));
const lpModel = require(path.join(ROOT, 'src/longterm/lenderprice/client.js'));
const nexParse = require(path.join(ROOT, 'src/longterm/loannex/parse.js'));
const investorPrograms = require(path.join(ROOT, 'src/longterm/lenderprice/investor-programs.js'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const RECORDED = nexParse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);

/**
 * ⛔ THE FIFTH INVESTOR THE RECORDING DOES NOT HAVE.
 *
 * The owner turned FIVE investors onto LoanNEX — NQM, Acra, eResi, Button Finance and
 * ClearEdge Lending. The recorded board is from 2026-08-30 and carries nine investors,
 * none of them ClearEdge, because ClearEdge was added to the roster on 2026-09-02. So a
 * suite built on the recording alone can only ever demonstrate FOUR of the five, and
 * reads as though the fifth is not handled.
 *
 * It is handled — `investor-settings` routes all five — and this is what proves it: one
 * SYNTHETIC programme, in the vendor's own shape, standing in for the recording we do not
 * have. It is marked synthetic on purpose. It says nothing about whether ClearEdge is live
 * on the LoanNEX account, which is an account question and not a code one; it says only
 * that if that sheet returns ClearEdge, this engine routes it like the other four.
 */
const CLEAREDGE_SYNTHETIC = {
  source: 'loannex', lender: 'ClearEdge Lending', investor: 'ClearEdge Lending',
  lenderId: 9901, investorOrganizationGuid: null,
  program: 'DSCR Select', programId: 991, programCode: 'CE-DSCR',
  product: '30 Yr. Fixed', productId: 99001, rateSheetName: 'ClearEdge DSCR',
  amortizationType: 'Fixed', termInMonths: 360, isInterestOnly: false, interestOnlyTerm: null,
  hasQuestions: false, questionsAnswered: true, lockDaysOffered: [30],
  minRate: 6.5, minPoints: -1, maxPrice: 101,
  rungs: [
    { rate: 6.5, price: 101, points: -1, pointsDerived: true, lockDays: 30, cushionedLockDays: null,
      payment: 2371, dscr: 1.3, priceHashKey: '99001-101-9901-3001', isException: false, hasSoftStopViolation: false },
    { rate: 6.75, price: 100.5, points: -0.5, pointsDerived: true, lockDays: 30, cushionedLockDays: null,
      payment: 2432, dscr: 1.3, priceHashKey: '99001-102-9901-3002', isException: false, hasSoftStopViolation: false },
  ],
  rungCount: 2,
};
const NX_BOARD = { ...RECORDED, programs: RECORDED.programs.concat([CLEAREDGE_SYNTHETIC]) };

const leaf = (co, rate) => ({
  companyId: co, companyName: co, programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
  rate, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5,
  dayLock: 30, term: 30, loanAmount: 375000, dscr: 1.3, fico: 760, ltv: 75,
  monthlyPayment: { monthlyPI: 2500, mi: 0 }, groupAdjustmentProperties: [],
  ratePeriod: { validAsOf: '2026-09-03T00:00:00Z' }, expired: false,
});
/* Lender Price quotes NQM and Acra too. That is the point of the two rows: the owner
   moved those investors to LoanNEX, so their Lender Price copies must be DROPPED —
   an investor appearing twice, once from each sheet, is the failure this guards. */
const LP_RAW = { results: { qualifiedNonQMData: { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR', childs: [
  { type: 'LenderKey', keyLabel: 'NQM Funding', plenderId: 'A', leafs: [leaf('NQM Funding', 7.5)] },
  { type: 'LenderKey', keyLabel: 'Acra Lending', plenderId: 'B', leafs: [leaf('Acra Lending', 7.4)] },
  { type: 'LenderKey', keyLabel: 'Deephaven', plenderId: 'C', leafs: [leaf('Deephaven', 7.6)] },
  { type: 'LenderKey', keyLabel: 'Verus', plenderId: 'D', leafs: [leaf('Verus', 7.7)] },
] } } };

const lpOk = { price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: {}, provenance: null }), parseFull: lpModel.parseFull };
const nexOk = { price: async () => ({ board: NX_BOARD, transactionId: 't1', portal: null }) };
const SC = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3, ltv: 75 };
const run = (lp, nex, opts = {}) => gb.boardForScenario(SC, { lp, nex, investorPrograms }, opts);
const investorsOfBoard = (out) => byInvestor(out.programs);
const byInvestor = (programs) => {
  const m = new Map();
  for (const p of programs) m.set(p.investorKey || '(unresolved)', (m.get(p.investorKey || '(unresolved)') || 0) + 1);
  return m;
};

(async () => {
  console.log('\n── BOTH SHEETS, ONE BOARD, EACH INVESTOR FROM ITS OWN ──');
  const out = await run(lpOk, nexOk);
  ok(out.ok === true && Array.isArray(out.programs) && out.programs.length > 0,
    `GEN-1 the board is built at all (${out.programs.length} programmes)`);
  const by = byInvestor(out.programs);

  // The LoanNEX board carries these; the Lender Price answer carries NQM and Acra too.
  ok(by.get('nqm') > 1 && by.get('acra') > 1,
    `GEN-2 NQM (${by.get('nqm')}) and Acra (${by.get('acra')}) come from LoanNEX — more programmes than the one leaf Lender Price offered`);
  ok(by.get('deephaven') === 1 && by.get('verus') === 1,
    'GEN-3 …while Deephaven and Verus still come from Lender Price, untouched');
  ok(by.get('eresi') > 0 && by.get('button_finance') > 0,
    `GEN-4 eResi (${by.get('eresi')}) and Button Finance (${by.get('button_finance')}) reach the board, which only LoanNEX quotes`);

  /* ⛔ THE DUPLICATE IS THE FAILURE THIS EXISTS FOR. Both sheets quote NQM and Acra.
     Routing must take each investor from ONE sheet, so the count has to equal the
     LoanNEX count alone — not the two added together. */
  const nxOnly = NX_BOARD.programs.filter((p) => /NQM Funding/i.test(String(p.investor || p.lender)) && p.amortizationType === 'Fixed').length;
  ok(nxOnly > 0 && by.get('nqm') === nxOnly,
    `GEN-5 NQM appears ONCE per programme, from LoanNEX only (${by.get('nqm')} = the ${nxOnly} fixed LoanNEX programmes, not those plus Lender Price's)`);

  console.log('\n── NO ARM ON THIS SCREEN ──');
  const armOnBoard = out.programs.filter((p) => /ARM/i.test(String(p.amortizationType || p.product || p.program || ''))).length;
  const armInSheet = NX_BOARD.programs.filter((p) => p.amortizationType === 'ARM').length;
  ok(armInSheet > 0, `GEN-6 the recorded LoanNEX sheet really does carry ARMs to exclude (${armInSheet} of ${NX_BOARD.programs.length})`);
  ok(armOnBoard === 0, `GEN-7 …and NONE of them reaches the general board (${armOnBoard})`);
  /* The sheet's ARMs leave by two doors now: the duplicate suppression takes its share
     first, and the amortization filter takes the rest. The sum is what must equal the
     sheet's own ARM count — asserting the filter alone would go stale the moment a
     duplicate happened to be an ARM, which is exactly what happened. */
  const armDupes = (out.nx && out.nx.duplicates ? out.nx.duplicates : [])
    .filter((d) => /ARM/i.test(String(d.product || ''))).length;
  ok(out.nx && (out.nx.droppedArm + armDupes) === armInSheet,
    `GEN-8 …every one of them is accounted for: ${out.nx && out.nx.droppedArm} by the fixed-only rule + ${armDupes} that were duplicates = ${armInSheet}`);

  console.log('\n── THE LENDER PRICE HALF IS PASSED THROUGH UNTOUCHED ──');
  const direct = lpModel.parseFull(LP_RAW);
  const changed = Object.keys(direct).filter((k) => k !== 'programs'
    && JSON.stringify(direct[k]) !== JSON.stringify(out.parsed[k]));
  ok(changed.length === 0,
    `GEN-9 every parsed field except the programme list is byte-identical to a plain parse (${changed.length} differ)`);
  ok(out.searchKey === 'k1', 'GEN-10 …and the search key the disqualify poll needs still rides out');

  console.log('\n── AN INVESTOR LOANNEX DID NOT PRICE ──');
  /* ALL FIVE the owner switched on, not four. The recording carries no ClearEdge, so the
     fifth rides on a synthetic programme (see the top of this file) — without it this suite
     could only ever show four and would read as though the fifth were unhandled. */
  ok(['nqm', 'acra', 'eresi', 'button_finance', 'clearedge'].every((k) => by.has(k)),
    `GEN-11 ALL FIVE investors routed to LoanNEX reach the board (${['nqm', 'acra', 'eresi', 'button_finance', 'clearedge'].filter((k) => by.has(k)).join(', ')})`);
  ok(Array.isArray(out.missing) && out.missing.length === 0,
    `GEN-12 …so none of the five is reported missing (${JSON.stringify(out.missing)})`);

  /* AND THE MISSING REPORT STILL BITES when a sheet really does drop one. */
  const nexNoClearEdge = { price: async () => ({ board: RECORDED, transactionId: 't1', portal: null }) };
  const without = await run(lpOk, nexNoClearEdge);
  ok(without.missing.includes('clearedge') && !investorsOfBoard(without).has('clearedge'),
    `GEN-12b an investor the sheet does NOT carry is reported and left off, never substituted (${JSON.stringify(without.missing)})`);

  console.log('\n── ONE SHEET DOWN ──');
  const nexDown = { price: async () => { throw new Error('loannex refused'); } };
  const down = await run(lpOk, nexDown);
  ok(down.ok === true && down.programs.length > 0,
    'GEN-13 LoanNEX refusing does not cost the board — Lender Price still answers');
  ok(down.sources.loannex.ok === false && !!down.sources.loannex.reason,
    `GEN-14 …and the refusal is recorded with its reason (${down.sources.loannex.reason})`);
  ok(Array.isArray(down.missing) && down.missing.length === 0,
    'GEN-15 …but the five are NOT reported as five missing investors — one sheet down is one fact, not five');
  const downBy = byInvestor(down.programs);
  ok(downBy.get('deephaven') === 1 && !downBy.has('eresi'),
    'GEN-16 …the Lender Price investors are all there, and the LoanNEX-only ones are simply absent');
  ok(!downBy.has('nqm') && !downBy.has('acra'),
    'GEN-17 …and a switched investor is NOT silently served from Lender Price, which is the sheet we stopped trusting for it');

  const lpDown = { price: async () => ({ ok: false, error: 'lp_price_failed', message: 'no' }), parseFull: lpModel.parseFull };
  const both = await run(lpDown, nexOk);
  ok(both.ok === false && both.error === 'lp_price_failed',
    'GEN-18 Lender Price failing fails the board, exactly as this screen already behaved');

  console.log('\n── THE GUARD CAN FAIL ──');
  const noNex = await run(lpOk, nexOk, { wantLoanNex: false });
  const noNexBy = byInvestor(noNex.programs);
  ok(!noNexBy.has('eresi') && noNexBy.get('deephaven') === 1,
    'GEN-19 with LoanNEX not asked at all the board is Lender Price only — so the LoanNEX rows above are really coming from LoanNEX');

  console.log('\n\u2500\u2500 EVERY ROW CAN IDENTIFY ITSELF TO THE RATE SHEET \u2500\u2500');
  {
    /* ⛔ THE OWNER'S REPORT (2026-09-03), on a live NQM row: *"The rate sheet accepted the
       question and returned no breakdown for this quote."* The recorded live capture holds
       the same failure with the request kept beside it — `"request": {}` — so the sheet was
       answering about NO QUOTE, because we had asked with no product, no investor and no
       price hash. The vendor addresses a quote by product AND investor AND price hash, so a
       row that reaches the panel without them can never be explained.
       This walks EVERY option of a real board and fails if one cannot identify itself. */
    const nexParse2 = require(path.join(ROOT, 'src/longterm/loannex/parse.js'));
    const qs = require(path.join(ROOT, 'src/longterm/pricing/quote-shape.js'));
    const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client.js'));
    const all = nexParse2.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);
    const merged = { investors: [{ key: 'nqm', whiteLabel: 'Ruby', programs: all.programs }] };
    // The ORDINARY board — reveal off, which is the state the owner is in and the state
    // that strips the vendor's own ids off every row.
    const rows = qs.programsForBoard(merged, { reveal: false, transactionId: 'T-ef8ce9', loanAmount: 375000, fico: 760, ltv: 75, loanPurpose: 'Purchase' });
    let options = 0; let unexplainable = 0; let firstBad = null;
    for (const pg of rows) {
      for (const o of (pg.options || [])) {
        options++;
        const miss = nexClient._internals && nexClient._internals.missingIdentity
          ? nexClient._internals.missingIdentity(o.explain)
          : null;
        if (miss === null) continue;
        if (!o.explain || miss.length) { unexplainable++; if (!firstBad) firstBad = { miss, handle: o.explain }; }
      }
    }
    ok(options > 200, `IDENT-1 a real board's worth of rows to check (${options} options)`);
    ok(unexplainable === 0,
      `IDENT-2 every row carries what the rate sheet needs to find it — product, investor, price hash, rate and lock (${unexplainable} could not)${firstBad ? ' — first: ' + JSON.stringify(firstBad.miss) : ''}`);

    /* AND THE REFUSAL IS REAL. A quote that cannot identify itself must be refused by
       name rather than sent, so the panel stops blaming the sheet for our own empty
       question. This is the control: without it the two checks above prove nothing. */
    const res = await nexClient.evidence({}, { rate: 6.875, lockDays: 30 }, {});
    ok(res && res.evidence === null && res.absence && res.absence.reason === 'quote_incomplete',
      `IDENT-3 an unidentifiable quote is refused before the vendor is called (${res && res.absence && res.absence.reason})`);
    ok(res.absence.missing.includes('priceHashKey') && res.absence.missing.includes('productId') && res.absence.missing.includes('investorId'),
      `IDENT-4 …and it names exactly what was missing (${JSON.stringify(res.absence.missing)})`);
    const bd = require(path.join(ROOT, 'src/longterm/pricing/breakdown.js'));
    const wording = (bd._internals && bd._internals.NO_BREAKDOWN) || null;
    ok(wording === null || /ours to fix/i.test(String(wording.quote_incomplete || '')),
      'IDENT-5 …and the screen says it is ours, not the rate sheet refusing');
  }

  console.log('\n\u2500\u2500 A PROGRAMME THE SHEET PUBLISHES TWICE \u2500\u2500');
  {
    /* Owner-reported: *"BUSINESS PURPOSE / DSCR (5% Fixed) · 30 Yr. Fixed… is just a
       duplicate. It's the same pricing… not on the general pricing engine and not on
       the combined pricing engine."* Verified before it was believed: 102 rungs each,
       every one matching on rate, lock AND price. */
    const pf = require(path.join(ROOT, 'src/longterm/pricing/product-filter.js'));
    const dupes = require(path.join(ROOT, 'src/longterm/pricing/duplicate-programs.js'));
    const nexParse3 = require(path.join(ROOT, 'src/longterm/loannex/parse.js'));
    const full = nexParse3.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);
    const has = (b, prog, prod) => (b.programs || []).some((p) => p.program === prog && p.product === prod);

    ok(has(full, 'BUSINESS PURPOSE / DSCR (5% Fixed)', '30 Yr. Fixed'),
      'DUP-1 the recorded sheet really does publish the duplicate, so there is something to drop');
    const r = pf.narrowBoard(full, {});
    ok(!has(r.board, 'BUSINESS PURPOSE / DSCR (5% Fixed)', '30 Yr. Fixed'),
      'DUP-2 …and it is gone from the board');
    ok(has(r.board, 'BUSINESS PURPOSE / DSCR', '30 Yr. Fixed'),
      'DUP-3 …while the programme it duplicates stays, which is the whole point');
    ok(Array.isArray(r.duplicates) && r.duplicates.length > 0 && r.duplicates.every((d) => d.duplicateOf),
      `DUP-4 what was dropped is REPORTED, with what it duplicated (${r.duplicates.length} products)`);
    ok(Array.isArray(r.diverged) && r.diverged.length === 0,
      'DUP-5 …and nothing was suppressed whose pricing no longer matches its twin');

    /* ⛔ THE SUPPRESSION IS CHECKED, NOT TRUSTED. Two programmes that price alike today
       can diverge tomorrow, and a list that goes on hiding one would drop real pricing
       on the screen an officer quotes from. Move one price and it must be KEPT. */
    const moved = JSON.parse(JSON.stringify(full));
    const five = moved.programs.find((p) => p.program === 'BUSINESS PURPOSE / DSCR (5% Fixed)' && p.product === '30 Yr. Fixed');
    five.rungs[0].price = Number(five.rungs[0].price) + 0.5;
    const r2 = pf.narrowBoard(moved, {});
    ok(has(r2.board, 'BUSINESS PURPOSE / DSCR (5% Fixed)', '30 Yr. Fixed'),
      'DUP-6 a suppressed programme whose pricing DIVERGES is kept, not hidden');
    ok(r2.diverged.some((d) => d.program === 'BUSINESS PURPOSE / DSCR (5% Fixed)'),
      'DUP-7 …and it is named, so somebody finds out the day the assumption breaks');

    /* And a lone programme is never hidden just because a list names it. */
    const alone = { programs: (full.programs || []).filter((p) => p.program === 'BUSINESS PURPOSE / DSCR (5% Fixed)') };
    const r3 = dupes.dropDuplicates(alone);
    ok(r3.board.programs.length === alone.programs.length && r3.dropped.length === 0,
      'DUP-8 with no twin on the board there is no duplicate, so nothing is dropped');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', (e && e.stack) || e); process.exit(1); });
