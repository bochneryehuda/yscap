'use strict';
/**
 * THE GENERAL PRICING ENGINE'S BRACKETS, ASKING BOTH RATE SHEETS.
 *
 * ── THE OWNER'S ASK (2026-09-03) ───────────────────────────────────────────
 * *"Everything should operate the same way according to the brackets according to
 * everything that we build already… Bring in that the search should run right away
 * in both places and return which investors we want to see from each place… we're
 * just adding a new source for these investors and turning off three investors from
 * Lender Price."*
 *
 * This drives the REAL `/price-brackets` route over the REAL Express router with both
 * vendor clients stubbed — one with a Lender Price answer in the vendor's own shape,
 * one with the recorded LoanNEX board (5,286 rungs). It is the end-to-end proof that
 * the second sheet reaches the bracketed board through the same loop, rather than
 * being bolted on after it.
 *
 * DB-gated: the route reads the settings store. Skips cleanly without DATABASE_URL.
 */

if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-general-brackets (no DATABASE_URL)'); process.exit(0); }

const path = require('path');
const ROOT = path.join(__dirname, '..');

// ⛔ STUB FIRST, THEN REQUIRE THE ROUTE — it captures the clients at require time.
const lp = require(path.join(ROOT, 'src/longterm/lenderprice/client'));
const nex = require(path.join(ROOT, 'src/longterm/loannex/client'));
const nexParse = require(path.join(ROOT, 'src/longterm/loannex/parse'));
const RECORDED = nexParse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);
/* The fifth investor the 2026-08-30 recording does not carry — ClearEdge was added to the
   roster on 2026-09-02. Synthetic on purpose, and it claims nothing about whether ClearEdge
   is live on the LoanNEX account: only that this engine routes it like the other four. */
const CLEAREDGE_SYNTHETIC = {
  source: 'loannex', lender: 'ClearEdge Lending', investor: 'ClearEdge Lending', lenderId: 9901,
  program: 'DSCR Select', programId: 991, product: '30 Yr. Fixed', productId: 99001,
  amortizationType: 'Fixed', termInMonths: 360, isInterestOnly: false, lockDaysOffered: [30],
  minRate: 6.5, minPoints: -1, maxPrice: 101, rungCount: 1,
  rungs: [{ rate: 6.5, price: 101, points: -1, lockDays: 30, payment: 2371, dscr: 1.3,
    priceHashKey: '99001-101-9901-3001', isException: false, hasSoftStopViolation: false }],
};
const NX_BOARD = { ...RECORDED, programs: RECORDED.programs.concat([CLEAREDGE_SYNTHETIC]) };

const leaf = (co, rate) => ({
  companyId: co, companyName: co, programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
  rate, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5, dayLock: 30, term: 30,
  loanAmount: 375000, dscr: 1.3, fico: 760, ltv: 75, monthlyPayment: { monthlyPI: 2500, mi: 0 },
  groupAdjustmentProperties: [], ratePeriod: { validAsOf: '2026-09-03T00:00:00Z' }, expired: false,
});
/* Lender Price quotes NQM as well — the investor the owner MOVED to LoanNEX. Its copy
   must not reach the board, or the officer sees one investor twice. */
const LP_RAW = { results: { qualifiedNonQMData: { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR', childs: [
  { type: 'LenderKey', keyLabel: 'NQM Funding', plenderId: 'A', leafs: [leaf('NQM Funding', 7.5)] },
  { type: 'LenderKey', keyLabel: 'Deephaven', plenderId: 'C', leafs: [leaf('Deephaven', 7.6)] },
] } } };

let lpCalls = 0; let nexCalls = 0; let nexDown = false;
lp.price = async () => { lpCalls++; return { ok: true, raw: LP_RAW, searchKey: 'k1', request: {}, provenance: null }; };
nex.price = async () => {
  nexCalls++;
  if (nexDown) throw new Error('loannex refused');
  return { board: NX_BOARD, transactionId: 't1', portal: null };
};

const express = require(path.join(ROOT, 'node_modules/express'));
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const SCENARIO = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3, ltv: 75 };
const FIGURES = { rentMonthly: 4200, taxMonthly: 500, insuranceMonthly: 150, hoaMonthly: 0, loanAmount: 375000, termYears: 30, interestOnly: false };

const investorsOf = (j) => {
  const m = new Map();
  for (const b of (j.bands || j.brackets || [])) {
    for (const p of (b.programs || [])) m.set(p.investorKey || '(none)', (m.get(p.investorKey || '(none)') || 0) + 1);
  }
  return m;
};

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/lt', require(path.join(ROOT, 'src/longterm/routes/dscr-pricer')).makeRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const r = await fetch(`${base}/lt/price-brackets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };

  try {
    console.log('\n── BOTH SHEETS, ONCE PER BAND ──');
    lpCalls = 0; nexCalls = 0;
    const r = await post({ scenario: SCENARIO, figures: FIGURES });
    ok(r.status === 200 && r.json.ok === true, `BR-1 the bracketed board is built (HTTP ${r.status}${r.json.error ? ' ' + r.json.error : ''})`);
    const bands = r.json.bands || r.json.brackets || [];
    ok(bands.length > 1, `BR-2 it really is bracketed — more than one ratio band (${bands.length})`);
    ok(lpCalls > 1 && nexCalls === lpCalls,
      `BR-3 BOTH sheets are asked, once per band, in step (Lender Price ${lpCalls}, LoanNEX ${nexCalls})`);

    const inv = investorsOf(r.json);
    ok(['nqm', 'acra', 'eresi', 'button_finance', 'clearedge'].every((k) => inv.has(k)),
      `BR-4 ALL FIVE investors the owner put on LoanNEX are on the bracketed board (${[...inv.keys()].sort().join(', ')})`);
    ok(inv.has('deephaven'),
      'BR-5 …and a Lender Price investor is still there, untouched');

    /* ⛔ THE DUPLICATE IS THE FAILURE THIS GUARDS. Lender Price quoted NQM too. If its
       copy reached the board the officer would see one investor priced twice, from two
       sheets, with no way to tell which is which. */
    const nqmRows = [];
    for (const b of bands) for (const p of (b.programs || [])) if (p.investorKey === 'nqm') nqmRows.push(p);
    ok(nqmRows.length > 0 && nqmRows.every((p) => Array.isArray(p.options) && p.options.some((o) => o.explain && o.explain.priceHashKey)),
      `BR-6 every NQM row carries a LoanNEX price hash — so none of them is the Lender Price copy (${nqmRows.length} rows)`);

    console.log('\n── NO ARM ON THIS SCREEN ──');
    let arm = 0; let total = 0;
    for (const b of bands) for (const p of (b.programs || [])) { total++; if (/ARM/i.test(String(p.amortizationType || p.product || ''))) arm++; }
    ok(total > 0 && arm === 0, `BR-7 not one ARM programme reaches the general board (${arm} of ${total})`);

    console.log('\n── THE SECOND SHEET DOWN ──');
    nexDown = true; lpCalls = 0; nexCalls = 0;
    const down = await post({ scenario: SCENARIO, figures: FIGURES });
    ok(down.status === 200 && down.json.ok === true,
      'BR-8 LoanNEX refusing does not cost the board — the officer still gets Lender Price');
    const downInv = investorsOf(down.json);
    ok(downInv.has('deephaven'), 'BR-9 …the Lender Price investors are all there');
    ok(!downInv.has('eresi') && !downInv.has('button_finance') && !downInv.has('clearedge'),
      'BR-10 …the LoanNEX-only ones are simply absent');
    ok(!downInv.has('nqm'),
      'BR-11 …and a switched investor is NOT quietly served from Lender Price instead');
    nexDown = false;

    /* ── THE IMMEDIATE, UNBANDED BOARD IS BUILT FROM BOTH SHEETS TOO ──────────
       Owner-directed 2026-09-03: *"First, it will do a general search according to the
       ratio that it populated, and everything populates without bands. Then it runs
       slowly, and the bands start populating… It should follow the same exact path…
       right away, it searches the initial stuff and then it starts dividing it into the
       bands."* So POST /price (full) must merge LoanNEX exactly as the bracket door
       does — before this it asked Lender Price and NOTHING else, so the five switched
       investors were absent from the immediate board and only reached the screen once
       the bands landed. */
    console.log('\n── THE INITIAL BOARD, BOTH SHEETS (owner-directed 2026-09-03) ──');
    const postPrice = async (b) => {
      const rr = await fetch(`${base}/lt/price`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: rr.status, json: await rr.json() };
    };
    const flatInvestors = (j) => {
      const m = new Map();
      for (const p of (j.programs || [])) m.set(p.investorKey || '(none)', (m.get(p.investorKey || '(none)') || 0) + 1);
      return m;
    };
    lpCalls = 0; nexCalls = 0;
    const ib = await postPrice({ scenario: SCENARIO, full: true });
    ok(ib.status === 200 && ib.json.ok === true, `IB-1 the immediate board is built (HTTP ${ib.status}${ib.json.error ? ' ' + ib.json.error : ''})`);
    ok(lpCalls === 1 && nexCalls === 1,
      `IB-2 BOTH sheets are asked ONCE for the immediate board (Lender Price ${lpCalls}, LoanNEX ${nexCalls})`);
    const ibInv = flatInvestors(ib.json);
    ok(['nqm', 'acra', 'eresi', 'button_finance', 'clearedge'].every((k) => ibInv.has(k)),
      `IB-3 ALL FIVE LoanNEX investors are on the immediate board, not only in the bands (${[...ibInv.keys()].sort().join(', ')})`);
    ok(ibInv.has('deephaven'), 'IB-4 …and a Lender Price investor is still there, untouched');
    const ibNqm = (ib.json.programs || []).filter((p) => p.investorKey === 'nqm');
    ok(ibNqm.length > 0 && ibNqm.every((p) => Array.isArray(p.options) && p.options.some((o) => o.explain && o.explain.priceHashKey)),
      `IB-5 every NQM row on the immediate board is the LoanNEX copy, never the Lender Price one (${ibNqm.length} rows)`);
    let ibArm = 0; let ibTotal = 0;
    for (const p of (ib.json.programs || [])) { ibTotal++; if (/ARM/i.test(String(p.amortizationType || p.product || ''))) ibArm++; }
    ok(ibTotal > 0 && ibArm === 0, `IB-6 no ARM on the immediate board either (${ibArm} of ${ibTotal})`);
    ok(Array.isArray(ib.json.investorRoster) && ib.json.investorRoster.some((x) => x.key === 'nqm'),
      'IB-7 the lens roster names the routed investors, so the board and the lens describe one set');

    console.log('\n── THE INITIAL BOARD WHEN LOANNEX IS DOWN ──');
    nexDown = true;
    const ibDown = await postPrice({ scenario: SCENARIO, full: true });
    ok(ibDown.status === 200 && ibDown.json.ok === true,
      'IB-8 LoanNEX refusing does not cost the immediate board — Lender Price still answers');
    const ibDownInv = flatInvestors(ibDown.json);
    ok(ibDownInv.has('deephaven'), 'IB-9 …the Lender Price investors are all there');
    ok(!ibDownInv.has('eresi') && !ibDownInv.has('button_finance') && !ibDownInv.has('clearedge'),
      'IB-10 …the LoanNEX-only ones are simply absent');
    ok(!ibDownInv.has('nqm'),
      'IB-11 …and a switched investor is NOT quietly served from Lender Price');
    ok(ibDown.json.sources && ibDown.json.sources.loannex && ibDown.json.sources.loannex.ok === false,
      'IB-12 …and the board records that LoanNEX did not answer, so the "no login" banner can fire');
    nexDown = false;
  } catch (e) {
    console.error('THREW', (e && e.stack) || e);
    fail++;
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  server.close();
  try { await require(path.join(ROOT, 'src/db')).pool.end(); } catch (_) { /* already gone */ }
  process.exit(fail ? 1 : 0);
})();
