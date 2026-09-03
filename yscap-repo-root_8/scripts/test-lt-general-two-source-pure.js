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

const NX_BOARD = nexParse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);

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
  ok(out.nx && out.nx.droppedArm === armInSheet,
    `GEN-8 …the count dropped is stated, and equals the sheet's own ARM count (${out.nx && out.nx.droppedArm})`);

  console.log('\n── THE LENDER PRICE HALF IS PASSED THROUGH UNTOUCHED ──');
  const direct = lpModel.parseFull(LP_RAW);
  const changed = Object.keys(direct).filter((k) => k !== 'programs'
    && JSON.stringify(direct[k]) !== JSON.stringify(out.parsed[k]));
  ok(changed.length === 0,
    `GEN-9 every parsed field except the programme list is byte-identical to a plain parse (${changed.length} differ)`);
  ok(out.searchKey === 'k1', 'GEN-10 …and the search key the disqualify poll needs still rides out');

  console.log('\n── AN INVESTOR LOANNEX DID NOT PRICE ──');
  ok(Array.isArray(out.missing) && out.missing.includes('clearedge'),
    `GEN-11 an investor routed to LoanNEX that LoanNEX did not carry is REPORTED (${JSON.stringify(out.missing)})`);
  ok(!by.has('clearedge'),
    'GEN-12 …and is absent from the board rather than quietly served from the other sheet');

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

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', (e && e.stack) || e); process.exit(1); });
