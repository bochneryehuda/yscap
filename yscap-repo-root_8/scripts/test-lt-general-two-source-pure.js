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
const eqA = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
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
  /* THE INITIAL BOARD'S LENS ROSTER AND UNNAMED LIST. The immediate `/price` door
     reads these to draw its investor lens and its "name this lender" warning; they
     are derived from the ROUTED programmes so the board and the lens can never
     describe two different sets. (owner-directed 2026-09-03 — LoanNEX now reaches the
     immediate board, not only the bands.) */
  ok(Array.isArray(out.roster) && Array.isArray(out.unmapped),
    'GEN-1b the board carries a lens roster and an unnamed-lender list');
  ok(out.roster.every((x) => x && x.key && Array.isArray(x.programs) && x.programs.length === x.programCount),
    'GEN-1c …each roster entry is well-shaped, its programme count in step with its list');
  ok(out.roster.every((x) => x.whiteLabel) && out.unmapped.every((u) => !u.whiteLabel),
    'GEN-1d …a NAMED investor is in the roster and only an unnamed one in the unmapped list');
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
  /* ⛔ THE EXPECTATION IS DERIVED THROUGH THE BOARD'S OWN NARROWING, never re-typed as
     "the fixed ones". This guard's subject is the DUPLICATE — that routing takes an
     investor from ONE sheet — and re-stating the narrowing rule here would make it fail
     every time that rule legitimately tightens (it did, the day interest-only, the term
     and the rate lock joined the amortization), which reads as "you broke the routing"
     when the truth is "the filter got stricter". The board REPORTS what it read the
     search as asking for (`nx.want`), so the expectation follows it. */
  const pf5 = require(path.join(ROOT, 'src/longterm/pricing/product-filter.js'));
  const nxNarrowed = pf5.narrowBoard(NX_BOARD, out.nx.want).board.programs
    .filter((p) => /NQM Funding/i.test(String(p.investor || p.lender))).length;
  const lpNqm = LP_RAW.results.qualifiedNonQMData.childs
    .filter((c) => /NQM Funding/i.test(String(c.keyLabel))).length;
  ok(lpNqm > 0, `GEN-5a CONTROL: Lender Price DOES quote NQM (${lpNqm}), so there is a duplicate to avoid`);
  ok(nxNarrowed > 0 && by.get('nqm') === nxNarrowed,
    `GEN-5 NQM appears ONCE per programme, from LoanNEX only (${by.get('nqm')} = the ${nxNarrowed} LoanNEX programmes this search narrows to, not those plus Lender Price's)`);

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
  /* programCount/lenderCount now describe the ROUTED board (LoanNEX folded in, turned-off
     Lender Price investors dropped), so they are DELIBERATELY not the plain-LP counts — the
     counts line on screen must name the board that is actually shown (GEN-9b/9c). */
  const ROUTED_COUNTS = new Set(['programCount', 'lenderCount']);
  const changed = Object.keys(direct).filter((k) => k !== 'programs' && !ROUTED_COUNTS.has(k)
    && JSON.stringify(direct[k]) !== JSON.stringify(out.parsed[k]));
  ok(changed.length === 0,
    `GEN-9 every parsed field except the programme list and the two routed counts is byte-identical to a plain parse (${changed.length} differ)`);
  const routedLenders = new Set(out.programs.map((x) => x && x.lender).filter(Boolean)).size;
  ok(out.parsed.programCount === out.programs.length && out.parsed.lenderCount === routedLenders,
    `GEN-9b the counts describe the ROUTED board (${out.parsed.programCount} programmes · ${out.parsed.lenderCount} lenders over ${out.programs.length} routed rows)`);
  ok(direct.programCount !== out.parsed.programCount,
    `GEN-9c …and that is NOT the raw Lender Price count (LP ${direct.programCount} != routed ${out.parsed.programCount}) — the old code reported the wrong one`);
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
  /* THE VENDOR'S OWN DIAGNOSTICS RIDE THROUGH. priceErrorBody surfaces firstHttp /
     retryHttp / upstream / provenance; before the fix the board error return flattened
     them to a bare error+http, so the FULL door lost them (the summary door never did). */
  const lpDiag = { price: async () => ({ ok: false, error: 'lp_http', message: 'boom', http: 503, firstHttp: 502, retryHttp: 503, upstream: { detail: 'x' }, provenance: { tries: 2 } }), parseFull: lpModel.parseFull };
  const diag = await run(lpDiag, nexOk);
  ok(diag.ok === false && diag.http === 503 && diag.firstHttp === 502 && diag.retryHttp === 503
    && diag.upstream && diag.upstream.detail === 'x' && diag.provenance && diag.provenance.tries === 2,
    'GEN-18b a Lender Price failure passes its firstHttp/retryHttp/upstream/provenance through the board error return');
  /* A REJECTED promise (the vendor threw, no result object) still composes a clean error. */
  const lpThrow = { price: async () => { throw new Error('network dead'); }, parseFull: lpModel.parseFull };
  const thrown = await run(lpThrow, nexOk);
  ok(thrown.ok === false && thrown.error === 'lp_price_failed' && !!thrown.message,
    `GEN-18c a Lender Price promise that REJECTS composes a clean error (${thrown.message})`);

  console.log('\n── THE GUARD CAN FAIL ──');
  const noNex = await run(lpOk, nexOk, { wantLoanNex: false });
  const noNexBy = byInvestor(noNex.programs);
  ok(!noNexBy.has('eresi') && noNexBy.get('deephaven') === 1,
    'GEN-19 with LoanNEX not asked at all the board is Lender Price only — so the LoanNEX rows above are really coming from LoanNEX');

  console.log('\n── DEV DIAGNOSTICS (parity with the summary door) ──');
  const lpDbg = { price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: {}, provenance: null }), parseFull: lpModel.parseFull, summarizeRaw: lpModel.summarizeRaw };
  const noDbg = await run(lpDbg, nexOk);
  ok(noDbg.rawSummary === undefined,
    'GEN-20 an ordinary search returns no rawSummary — the board is never bloated with raw vendor payloads');
  const dbg = await run(lpDbg, nexOk, { debug: true });
  ok(dbg.rawSummary !== undefined && dbg.rawSummary !== null,
    'GEN-20b …but opts.debug returns the raw Lender Price summary, restoring the full-path parity the summary door has');

  console.log('\n── THE PRE-SEARCH PICKER MATCHES THE BOARD (owner-directed 2026-09-03) ──');
  const prKeys = (cfg) => gb.pickerRoster(cfg).map((x) => x.key);
  const onAll = gb.pickerRoster({ settings: {}, custom: null });
  const keysOn = onAll.map((x) => x.key);
  ok(['nqm', 'acra', 'eresi', 'button_finance', 'clearedge'].every((k) => keysOn.includes(k)),
    `GEN-21 the picker offers the LoanNEX-switched investors (${['nqm', 'acra', 'eresi', 'button_finance', 'clearedge'].filter((k) => keysOn.includes(k)).join(', ')})`);
  ok(onAll.every((x) => x.key && x.whiteLabel && x.investorLabel && !('custom' in x)),
    'GEN-22 …each entry is {key, whiteLabel, investorLabel} — the picker component is unchanged');
  const offNqm = prKeys({ settings: { nqm: { enabled: false } }, custom: null });
  ok(keysOn.includes('nqm') && !offNqm.includes('nqm'),
    'GEN-23 turning an investor OFF removes it from the picker (default offers it, off does not) — the misleading "nothing populated" for a deliberate turn-off is gone');
  const mkCustom = (wl) => new Map([['onyxco', { key: 'onyxco', label: 'Onyx Co', whiteLabel: wl, custom: true, seen: 0, aliases: [] }]]);
  const named = prKeys({ settings: {}, custom: mkCustom('Onyx') });
  const unnamed = prKeys({ settings: {}, custom: mkCustom(null) });
  ok(named.includes('onyxco') && !unnamed.includes('onyxco'),
    'GEN-24 a NAMED hand-added investor is offered (it reaches the board) and an UNNAMED one is not (it lands in `unmapped`) — the picker names investors exactly as the board does');

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


  /* ── A LENDER PRICE PROGRAM NOBODY CAN NAME STILL REACHES THIS BOARD ──────
     The owner: *"it's not even pricing LenderPrice right now at all"* (2026-09-03).
     Routing the whole Lender Price half through `merge.merge` was a silent regression:
     the merge keeps a row it cannot name OFF the priced board — correctly, for ITS
     purpose — so a lender the registry does not carry DISAPPEARED from a board it had
     always been on, and the screen's "no white-label name yet" warning came back empty.

     ⛔ THE CONTROL IS THE MERGE ITSELF, not a copy of the board with the fix cut out.
     `merge.merge` is the very function whose behaviour caused the regression, so asking
     IT what it does with the same input is the honest before-picture — and it can never
     go stale the way a hand-maintained "old version" of the board would. */
  console.log('\n── A LENDER PRICE LENDER WITH NO WHITE LABEL IS BACK ON THE BOARD ──');
  {
    const mergeMod = require(path.join(ROOT, 'src/longterm/pricing/merge.js'));
    const unknownLp = { results: { qualifiedNonQMData: { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR', childs: [
      { type: 'LenderKey', keyLabel: 'Deephaven', plenderId: 'C', leafs: [leaf('Deephaven', 7.6)] },
      // Two lenders the investor registry has never heard of. On a live board these are
      // the ordinary case — Lender Price adds lenders faster than anybody names them.
      { type: 'LenderKey', keyLabel: 'ResiCentral', plenderId: 'E', leafs: [leaf('ResiCentral', 7.8)] },
      { type: 'LenderKey', keyLabel: 'Harbourline Credit', plenderId: 'F', leafs: [leaf('Harbourline Credit', 7.9)] },
    ] } } };
    const lpUnknown = { price: async () => ({ ok: true, raw: unknownLp, searchKey: 'k9', request: {}, provenance: null }), parseFull: lpModel.parseFull };
    const nexDown = { price: async () => { throw new Error('loannex is not answering'); } };

    /* ⛔ THE CONTROL, READ OFF THE MERGE'S REAL ANSWER.
       The first cut of this control read `mergedOnly.programs`. `merge()` returns
       `{sources, summary, investors, unmapped}` and has NO `programs` key, so
       `(mergedOnly.programs || [])` was always `[]` and both "does not contain"
       assertions were true BY CONSTRUCTION — they would have passed just as happily
       if the merge had kept every row. Found by the pre-merge audit of 2026-09-03.

       The merge's real statement about these two lenders is that it RESOLVED NEITHER:
       they appear in `unmapped` and not in `investors`. That is the regression — the
       board was built from the merge's resolved investors, so a lender the registry
       cannot name had nothing to appear as. */
    const lpParsed = lpModel.parseFull({ ...unknownLp });
    const lpBoard = { source: 'lenderprice', programs: investorPrograms.decorate(lpParsed.programs).programs };
    const mergedOnly = mergeMod.merge({ lenderprice: lpBoard, loannex: null }, { errors: { lenderprice: null, loannex: 'down' } });
    ok(lpBoard.programs.length === 3, `LPU-0 CONTROL: Lender Price returned 3 lenders (${lpBoard.programs.length})`);
    // The shape itself is asserted, or this control could rot back into a tautology the
    // day `merge()` grows a `programs` key and nobody re-reads this block.
    ok(mergedOnly.programs === undefined && Array.isArray(mergedOnly.unmapped),
      'LPU-1a CONTROL: merge() answers investors + unmapped, and carries no programme list of its own');
    const mergedResolved = new Set((mergedOnly.investors || []).map((i) => String(i.key)));
    const mergedUnmapped = new Set((mergedOnly.unmapped || []).map((u) => String(u.name || '')));
    ok(mergedResolved.size === 1 && mergedResolved.has('deephaven'),
      `LPU-1b CONTROL: the merge resolves ONLY the named lender (${[...mergedResolved].join(',') || 'none'})`);
    ok(mergedUnmapped.has('ResiCentral') && mergedUnmapped.has('Harbourline Credit'),
      'LPU-1 CONTROL: it names BOTH unnamed lenders as unmapped and resolves neither — the regression, reproduced');

    const out2 = await run(lpUnknown, nexDown, { wantLoanNex: true });
    const lenders = (out2.programs || []).map((p) => String(p.lender || ''));
    ok(out2.ok === true, 'LPU-2 the board is still built when LoanNEX refuses outright');
    ok(lenders.includes('ResiCentral') && lenders.includes('Harbourline Credit'),
      'LPU-3 …and BOTH unnamed Lender Price lenders are on it');
    const unnamedRows = (out2.programs || []).filter((p) => !p.investorKey);
    ok(unnamedRows.length === 2 && unnamedRows.every((p) => p.whiteLabel === null && p.consumerLabel === null),
      'LPU-4 an unnamed row carries NO white label and NO client-safe label — it can never be quoted to a client');
    const unmappedLenders = (out2.unmapped || []).map((u) => String(u.lender || u.investor || ''));
    ok(unmappedLenders.includes('ResiCentral') && unmappedLenders.includes('Harbourline Credit'),
      'LPU-5 …and each is REPORTED as still needing a name, which is what makes it visible rather than silent');
    ok(!lenders.some((l) => /^\s*$/.test(l)) && lenders.filter((l) => l === 'Deephaven').length === 1,
      'LPU-6 a NAMED lender is not duplicated by the restoration');

    /* ⛔ ONLY THE LENDER PRICE HALF. A LoanNEX row nobody can name was never on this
       board, and the owner's standing rule for a LoanNEX investor that does not arrive
       is to leave it off silently and tell a super admin — so bringing one on under a
       vendor spelling would be a NEW decision, not a repair. */
    // It must be a FIXED programme, or the ARM filter drops it before the restoration
    // could ever see it and the assertion passes for the wrong reason.
    const aFixedNxProgram = RECORDED.programs.find((x) => String(x.amortizationType || '').toLowerCase() === 'fixed');
    ok(!!aFixedNxProgram, 'LPU-7a CONTROL: the recording carries a FIXED LoanNEX programme to stand in');
    const strangeNx = { price: async () => ({ board: { ...RECORDED, programs: [{
      ...aFixedNxProgram, lender: 'Someone Nobody Named', investor: 'Someone Nobody Named', lenderId: 99999,
    }] }, transactionId: 't9', portal: null }) };
    const out3 = await run(lpUnknown, strangeNx, { wantLoanNex: true });
    ok(!(out3.programs || []).some((p) => String(p.lender || '') === 'Someone Nobody Named'),
      'LPU-7 an unnameable LOANNEX row is still left off — the restoration is the Lender Price half only');
  }


  /* ── THE LOANNEX HALF IS NARROWED ON ALL FOUR DIMENSIONS ─────────────────
     The owner: *"LoanNEX was perfect, including filtering out the wrong programs by term
     and by interest-only and by ARM… I told you to copy it from here"* (2026-09-03). This
     board narrowed on the AMORTIZATION alone, so an officer's own interest-only answer,
     their term and their rate lock did nothing to the LoanNEX half while Lender Price had
     already been asked for exactly those — the two sheets answering two different questions
     on one screen.

     ⛔ THE CONTROL IS THE OLD RULE ITSELF, run over the same recorded board: `narrowBoard`
     with `{ amortization: 'fixed' }` IS what this file used to pass, so the before-picture
     is produced rather than remembered. */
  console.log('\n── THE LOANNEX BOARD IS NARROWED TO WHAT THE SEARCH ASKED FOR ──');
  {
    const pfF = require(path.join(ROOT, 'src/longterm/pricing/product-filter.js'));
    const smF = require(path.join(ROOT, 'src/longterm/lenderprice/search-model.js'));
    // An ordinary officer search: 30 years, NOT interest-only, a 30-day lock.
    const SCF = { ...SC, termYears: 30, lockDays: 30, propertyType: 'SingleFamily', state: 'NJ' };
    const vF = smF.validateScenario(SCF);
    ok(vF.ok === true, 'FIL-0 CONTROL: the search is a valid one, so what follows is about the filter');

    const ctrl = pfF.narrowBoard(RECORDED, { amortization: 'fixed' }); // the rule that was here
    const io = (b) => b.programs.filter((p) => p.isInterestOnly === true).length;
    const terms = (b) => [...new Set(b.programs.map((p) => p.termInMonths))].sort((a, c) => a - c);
    const locks = (b) => [...new Set(b.programs.flatMap((p) => (p.rungs || [])
      .flatMap((r) => (r.lockDays == null ? [] : [r.lockDays]))))].sort((a, c) => a - c);
    ok(io(ctrl.board) > 0, `FIL-1 CONTROL: the old rule left ${io(ctrl.board)} interest-only programmes on a search that asked for none`);
    ok(terms(ctrl.board).length > 1, `FIL-2 CONTROL: …and terms it never asked for (${terms(ctrl.board).join('/')} months on a 30-year search)`);
    ok(locks(ctrl.board).length > 1, `FIL-3 CONTROL: …at ${locks(ctrl.board).length} different rate locks, when Lender Price answers at one`);

    const want = Object.assign(
      pfF.wantFrom(SCF, smF._internals, { lpCriteria: vF.request.criteria, lpRequest: vF.request }),
      { amortization: 'fixed' },
    );
    const fixed = pfF.narrowBoard(RECORDED, want);
    eqA(io(fixed.board), 0, 'FIL-4 with the fix, NOT ONE interest-only programme survives a non-interest-only search');
    eqA(terms(fixed.board), [360], 'FIL-5 …only the 30-year term the search asked for');
    eqA(locks(fixed.board), [30], 'FIL-6 …and only the lock it asked for');
    ok(fixed.board.programs.length < ctrl.board.programs.length,
      `FIL-7 …so the board is narrower than the old rule left it (${fixed.board.programs.length} against ${ctrl.board.programs.length})`);

    /* AND THE BOARD ITSELF RUNS THAT NARROWING — a filter nothing calls is not a fix. */
    const lpF = { price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: vF.request, provenance: null }), parseFull: lpModel.parseFull };
    const nexF = { price: async () => ({ board: RECORDED, transactionId: 't1', portal: null }) };
    const outF = await gb.boardForScenario(SCF, { lp: lpF, nex: nexF, investorPrograms }, { staticRequest: vF.request });
    eqA(outF.nx.want, want, 'FIL-8 the board reads the search exactly as the filter does — one definition, not two');
    ok(outF.nx.droppedIo > 0 && outF.nx.droppedTerm > 0 && outF.nx.droppedLockRungs > 0,
      `FIL-9 …and REPORTS what each dimension dropped (io ${outF.nx.droppedIo}, term ${outF.nx.droppedTerm}, lock ${outF.nx.droppedLockRungs} rungs) rather than shrinking the board in silence`);
    ok(!(outF.programs || []).some((p) => p.interestOnly === true || p.isInterestOnly === true),
      'FIL-10 …so no interest-only row reaches the screen on a search that asked for none');

    /* ⛔ THE ARM RULE IS STILL ABSOLUTE ON THIS SCREEN (owner: *"don't enable the ARM
       feature"*), even if a caller ever manages to state one. Asserted THROUGH THE BOARD
       rather than through `wantFrom` alone, so it pins the ORDER: forcing fixed BEFORE the
       search is read would let a stated ARM win, and an assertion on `wantFrom`'s own answer
       could never see that. `amortization` is not a supported field on this door today — a
       caller sending one is 422'd upstream — so this is a guard against the day it is
       accepted, and it is written so that day cannot pass unnoticed. */
    const armOut = await gb.boardForScenario({ ...SCF, amortization: 'ARM' },
      { lp: lpF, nex: nexF, investorPrograms }, { staticRequest: vF.request });
    eqA(armOut.nx.want.amortization, 'fixed',
      'FIL-11 an ARM answer cannot widen this board — fixed is forced AFTER the search is read');
    ok(!(armOut.programs || []).some((p) => /arm/i.test(String(p.amortizationType || ''))),
      'FIL-11b …and no ARM row reaches the screen even then');

    /* ⛔ THE WIRE BODY WINS OVER THE STATIC BUILD, and the two really can disagree: the
       client builds what it POSTs on the tenant's LIVE foundation and copies same-typed
       scalars — `criteria.interestOnly` included — off the live defaultSearch. So a live
       default of `true` would have Lender Price answering an interest-only board while the
       static build said otherwise. Mirroring the wrong one is silent. */
    const wireIo = JSON.parse(JSON.stringify(vF.request));
    wireIo.criteria.interestOnly = true;
    const lpWire = { price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: wireIo, provenance: null }), parseFull: lpModel.parseFull };
    const outWire = await gb.boardForScenario(SCF, { lp: lpWire, nex: nexF, investorPrograms }, { staticRequest: vF.request });
    ok(vF.request.criteria.interestOnly !== true,
      'FIL-12a CONTROL: the static build says this is NOT an interest-only search, so the two disagree');
    eqA(outWire.nx.want.io, true,
      'FIL-12 the board mirrors the body Lender Price was ACTUALLY sent, not the static build');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PAIR · WHAT THE TWO SHEETS CALLED EACH INVESTOR — the linking screen's input.

     Owner-reported 2026-09-03: *"linking doesn't work"*. It did not, and the panel
     was never the problem: it was mounted and pointed at this engine's own doors the
     whole time. What was missing was the DATA. The COMBINED board has always returned
     `investorPairing`; the GENERAL board returned nothing of the kind, so the panel
     had no board to work from and only ever showed anything if the same person had
     visited the combined pricer (super-admin only) in the same browser session.
     ═════════════════════════════════════════════════════════════════════════ */
  {
    const out = await run(lpOk, nexOk, {});
    const pr = out.investorPairing;
    ok(pr && Array.isArray(pr.rows), 'PAIR-1 the general board returns a pairing the linking screen can read');
    ok(pr && pr.rows.length > 0, `PAIR-2 …with real rows off the boards the sheets returned (${pr ? pr.rows.length : 0})`);
    /* THE CASE THE PANEL EXISTS FOR: one investor spelled two ways that no human has
       confirmed — "Acra Lending" against "Acra Lending - Corr". */
    const guessed = (pr ? pr.rows : []).filter((r) => (r.names.loannex || []).some((n) => n.guessed)
      || (r.names.lenderprice || []).some((n) => n.guessed));
    ok(guessed.length > 0,
      `PAIR-3 …including the ones still only GUESSED, which are the rows a person is asked to confirm (${guessed.length})`);
    ok((pr ? pr.rows : []).every((r) => r.key && typeof r.investor === 'string'),
      'PAIR-4 every row names the investor it is about — a row nobody can identify is a row nobody can link');

    /* ONE DEFINITION, BOTH ENGINES. `namesFromBoard` was private to the combined pricer;
       two engines each deriving "which names did this sheet return" their own way is how
       one screen comes to offer a link the other cannot see. */
    const links = require(path.join(ROOT, 'src/longterm/pricing/investor-links.js'));
    ok(typeof links.namesFromBoard === 'function',
      'PAIR-5 the "which names did this board carry" rule is shared, not copied per engine');
    const read = (f) => require('fs').readFileSync(path.join(ROOT, f), 'utf8');
    ok(/namesOf = investorLinks\.namesFromBoard/.test(read('src/longterm/routes/combined-pricer.js')),
      'PAIR-6 …and the combined pricer asks the shared one rather than keeping its own copy');

    /* THE SCREEN MUST ACTUALLY RECEIVE AND REMEMBER IT — a board field nothing reads is
       a field nobody benefits from, which is this whole section's subject. */
    ok(/investorPairing: board\.investorPairing/.test(read('src/longterm/routes/dscr-pricer.js')),
      'PAIR-7 the price door sends it on to the browser');
    const screen = read('app-v2/src/longterm/LtPricer.jsx')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/rememberPairing\(r\.investorPairing\)/.test(screen),
      'PAIR-8 …and the pricer remembers it, which is how the SETTINGS screen gets a board to link from');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     HOLD · AN INVESTOR'S OWN HOLDBACK APPLIES ON BOTH SHEETS.

     Owner-reported 2026-09-03. The LoanNEX half went through
     `vendorMargin.applyToBoard` and the Lender Price half went through nothing at
     all, so a per-investor holdback set in the settings was silently ignored on
     every Lender Price row of this board — while the COMBINED engine had been
     applying it to both sheets all along. One setting doing two different things
     on two screens is the split this engine keeps being caught by.
     ═════════════════════════════════════════════════════════════════════════ */
  {
    const lpOnly = { price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: {}, provenance: null }), parseFull: lpModel.parseFull };
    const nexNone = { price: async () => ({ board: null }) };
    const priceOf = (b) => {
      const o = ((b.programs || [])[0] || {}).options || [];
      return o[0] ? o[0].priceBuild.price : null;
    };
    const plain = await gb.boardForScenario(SC, { lp: lpOnly, nex: nexNone, investorPrograms },
      { wantLoanNex: false, extraFor: null });
    const held = await gb.boardForScenario(SC, { lp: lpOnly, nex: nexNone, investorPrograms },
      { wantLoanNex: false, extraFor: () => 0.5 });
    ok(priceOf(plain) != null, `HOLD-0 CONTROL: a Lender Price row carries a price to move (${priceOf(plain)})`);
    ok(priceOf(held) === priceOf(plain) - 0.5,
      `HOLD-1 a 0.5 holdback for this investor moves its Lender Price price by exactly 0.5 (${priceOf(plain)} → ${priceOf(held)})`);

    /* ⛔ AND IT CANNOT TAKE OUR MARGIN TWICE. Lender Price's own base is ZERO BY DESIGN —
       its feed already carries our holdback — so a board with no per-investor extra must
       be byte-identical to one built without this call at all. */
    ok(priceOf(plain) === 99,
      `HOLD-2 with no holdback set the price is untouched (${priceOf(plain)}) — the feed's own margin is never taken twice`);
    /* ⛔ HOLD-3 WAS A TAUTOLOGY AND IS RE-POINTED. It applied the holdback twice and
       asserted the price had not moved, claiming to prove the module's "already done is
       done" guard. It does not: removing that guard leaves the price EXACTLY the same
       (measured), because the option price is anchored on the vendor's own `vendorPrice`
       and is idempotent by construction — a different mechanism entirely. An assertion
       that cannot fail for the reason it names proves nothing.

       So the two real properties are asserted instead: the ANCHOR that makes a second
       pass harmless, and the "called once per board per vendor" invariant the module's
       own header depends on — which is exactly what adding a second `applyToBoard` call
       to this builder could have broken. */
    const vm = require(path.join(ROOT, 'src/longterm/pricing/vendor-margin.js'));
    const b1 = vm.applyToBoard({ source: 'lenderprice', programs: [{ lender: 'X', options: [{ priceBuild: { price: 99 } }] }] },
      'lenderprice', { extraFor: () => 0.5 });
    ok(b1.programs[0].options[0].priceBuild.vendorPrice === 99,
      'HOLD-3 the option keeps the vendor\'s OWN price as its anchor — which is what makes the shift idempotent');
    const b2 = vm.applyToBoard({ ...b1, marginHoldback: undefined }, 'lenderprice', { extraFor: () => 0.5 });
    ok(b2.programs[0].options[0].priceBuild.price === b1.programs[0].options[0].priceBuild.price,
      'HOLD-3a …so even with the already-done guard bypassed, the price cannot be held back twice');
    /* The module states plainly that the LADDER's own points have NO anchor and would drift,
       and that this is safe only because the door is called once per board per vendor. This
       change added a call, so that count is now pinned rather than assumed. */
    /* ⛔ COUNTED ACROSS BOTH FILES, because the LoanNEX half's call moved into
       `pricing/loannex-half.js` when that half was lifted out for BOTH engines to share.
       The property is "once per sheet", not "twice in this file" — so it is counted where
       each call actually lives, and each file is pinned on its own: a second call added to
       either one is what would make the ladder's unanchored points drift, and a count of
       the total alone could be satisfied by 2-and-0. */
    const callsIn = (rel) => (require('fs').readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      .match(/vendorMargin\.applyToBoard\(/g) || []).length;
    const gbCalls = callsIn('src/longterm/pricing/general-board.js');
    const halfCalls = callsIn('src/longterm/pricing/loannex-half.js');
    ok(gbCalls === 1 && halfCalls === 1,
      `HOLD-3b the board applies the holdback exactly ONCE per sheet — the Lender Price half here (${gbCalls}), the LoanNEX half in the shared module (${halfCalls})`);

    /* THE BOARD MUST ACTUALLY GO THROUGH THAT DOOR — a rule the builder does not call
       is a rule nobody is following, which is exactly what this defect was. */
    const gbSrc = require('fs').readFileSync(path.join(ROOT, 'src/longterm/pricing/general-board.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/vendorMargin\.applyToBoard\(\s*\{ source: 'lenderprice'/.test(gbSrc)
      || /applyToBoard\([\s\S]{0,120}'lenderprice'/.test(gbSrc),
      'HOLD-4 the Lender Price half is built through the shared holdback door, same as the LoanNEX half');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SEAM · WHAT THE BOARD PRODUCES IS WHAT THE REGISTER READS.

     ⛔ THE GAP THE PRE-MERGE AUDIT OF 2026-09-03 FOUND, and it is the sharpest kind:
     `search-record.collector().observe()` discards a sheet whose entry is not
     `answered`, and `general-board` is the only thing that sets that word. Flipping
     ONE token — `lenderprice: { answered: true` → `false` — silences every Lender
     Price sighting on BOTH doors for ever: the settings screen's "available on"
     column never fills and no button is ever locked. The audit swept all TWELVE
     suites that mention sightings, search-record or general-board and every one of
     them stayed green.

     The reason is structural: `test-lt-search-record-wired-pure` stubs BOTH sides of
     this seam (the board AND the register), so it proves the CALL HAPPENS and can
     never prove the call CARRIES USABLE EVIDENCE. Its own fixture proved the gap —
     it carried no `answered` key at all, which the real collector would have thrown
     away entirely.

     So this runs the REAL collector over the REAL board, with only the two WRITERS
     stubbed. It belongs here, not there, because this is the suite that has a real
     `boardForScenario` in its hands. */
  {
    const searchRecord = require(path.join(ROOT, 'src/longterm/pricing/search-record.js'));

    /* ⛔ THE BOARD IS BUILT FROM THE REAL `loadConfig`, NOT FROM `{}` — the re-audit's D-7.
       Every earlier cut of this section passed an EMPTY opts object, so the board was built
       with `routes`, `custom`, `settings`, `links`, `extraFor`, `heldSetting` and
       `wantLoanNex` all undefined. That is a fixture THINNER than what production builds,
       and a fixture thinner than the real thing is blind to any gate on the missing fields:
       a `if (!opts.settings) return {...no sightings...}` added tomorrow would leave this
       whole section green while silencing both doors in production — the exact shape of the
       defect SEAM was written to catch, one layer down.

       `loadConfig` runs with NO DATABASE when it is handed its three inputs (it reports the
       unreadable settings store as `problem` and answers with empty maps), which is what
       makes the real config reachable from a pure suite. MEASURED: the board it produces is
       identical to the `{}` one today — 14 programmes, the same six investors, the same
       sightings — so this changes nothing about what is asserted and everything about what
       a future gate can walk past. */
    const cfg = await gb.loadConfig({ routes: {}, links: {}, marginHoldback: 0.25 });
    const board = await run(lpOk, nexOk, cfg);
    ok(board.ok && board.programs.length > 0,
      'SEAM-0 CONTROL: the board under test priced something, so the assertions below mean something');

    /* AND THE KEY LIST IS DERIVED FROM THE TWO FUNCTIONS THEMSELVES, never hand-kept: a
       config key added to `loadConfig` and read by the board arrives here for free, and a
       key the BOARD reads that `loadConfig` does not supply fails until somebody says which
       kind it is. `raw` / `staticRequest` / `debug` are per-CALL, not config — a caller
       decides them per search, so they are named once, here, and nowhere else. */
    {
      const fs = require('fs');
      const all = fs.readFileSync(path.join(ROOT, 'src/longterm/pricing/general-board.js'), 'utf8');
      const start = all.indexOf('async function boardForScenario');
      const after = all.slice(start + 1);
      const nextDecl = after.search(/\n(?:async )?function [A-Za-z_]|\nmodule\.exports/);
      const body = (nextDecl === -1 ? after : after.slice(0, nextDecl))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const readKeys = Array.from(new Set((body.match(/opts\.[A-Za-z_]+/g) || [])
        .map((m) => m.slice(5)))).sort();
      const PER_CALL = ['debug', 'raw', 'staticRequest'];
      const cfgKeys = Object.keys(cfg);
      const fromConfig = readKeys.filter((k) => !PER_CALL.includes(k));
      const missingFromCfg = fromConfig.filter((k) => !cfgKeys.includes(k));
      ok(missingFromCfg.length === 0,
        `SEAM-0a the board reads no opts key its own loadConfig cannot supply (per-call: ${PER_CALL.join(', ')}) — unaccounted: ${missingFromCfg.join(', ') || 'none'}`);
      const notPassed = fromConfig.filter((k) => !(k in cfg));
      ok(notPassed.length === 0 && fromConfig.length >= 5,
        `SEAM-0b every config key the board reads is actually handed to it here (${fromConfig.join(', ')})`);
    }

    let sighted = null; let missed = null;
    const col = searchRecord.collector({
      recordSightings: async (s) => { sighted = s; return { ok: true }; },
      recordMisses: async (m) => { missed = m; return { ok: true }; },
    });
    col.observe(board);
    await col.flush({ scenario: SC, searchKey: board.searchKey, door: 'immediate' });

    ok(sighted && sighted.lenderprice && Array.isArray(sighted.lenderprice.keys) && sighted.lenderprice.keys.length > 0,
      `⛔ SEAM-1 THE ONE THAT MATTERS: the register is handed real Lender Price sightings off a real board (${sighted && sighted.lenderprice ? sighted.lenderprice.keys.length : 'none'})`);
    ok(sighted && sighted.loannex && Array.isArray(sighted.loannex.keys) && sighted.loannex.keys.length > 0,
      `SEAM-2 …and real LoanNEX sightings too (${sighted && sighted.loannex ? sighted.loannex.keys.length : 'none'})`);

    /* Every sheet the register knows about must be described by the board, or the one
       nobody described is silently unrecordable — exactly the shape of the defect. */
    const REG = require(path.join(ROOT, 'src/longterm/pricing/investor-sightings.js'));
    ok(REG.SOURCES.every((sname) => board.sightings && board.sightings[sname]
      && typeof board.sightings[sname].answered === 'boolean'
      && Array.isArray(board.sightings[sname].keys)),
      `SEAM-3 …and the board describes every sheet the register knows about (${REG.SOURCES.join(', ')}), each with an ANSWERED flag`);

    /* A sheet that genuinely refused says nothing — the property the `answered` flag is
       FOR. This is the control that stops SEAM-1 being satisfiable by ignoring the flag. */
    const lpDown = { price: async () => ({ ok: false, error: 'down' }), parseFull: lpModel.parseFull };
    const downBoard = await run(lpDown, nexOk, cfg);
    let sightedDown = null;
    const col2 = searchRecord.collector({
      recordSightings: async (s) => { sightedDown = s; return { ok: true }; },
      recordMisses: async () => ({ ok: true }),
    });
    col2.observe(downBoard);
    await col2.flush({ scenario: SC, searchKey: 'k-down', door: 'immediate' });
    ok(!sightedDown || !sightedDown.lenderprice || sightedDown.lenderprice.keys.length === 0,
      'SEAM-4 CONTROL: a sheet that refused records no sighting at all, which is what the flag is for');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', (e && e.stack) || e); process.exit(1); });
