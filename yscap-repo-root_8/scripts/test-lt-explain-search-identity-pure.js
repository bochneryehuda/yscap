/**
 * A LOANNEX QUOTE BELONGS TO A SEARCH — and the explain call must say which one.
 *
 * WHAT THIS IS ABOUT (measured, 2026-09-02). LoanNEX scopes a priced quote to the search that
 * produced it: `POST /loans/apps/{u}/quick-prices` mints a transaction, and BOTH follow-up reads
 * hang off it — `/loans/evidences/{u}/{txn}/fails` (why each investor said no) and
 * `/loans/evidences/{u}/{txn}` (the itemized LLPA breakdown). The vendor's own web app proves the
 * intent: in the recorded HAR (`capture/evidence.json`) all three explain calls carry the SAME
 * `scenarioTestId` `27684de7-4f69-4759-9962-b2711751924e` — the id of the search, and the id in the
 * rate-stack URL.
 *
 * THE DEFECT THIS PINS. The browser held no transaction at all (it never read `provenance`), so
 * every explain reached the client with `{}` and `evidence()` minted a fresh id: we asked the
 * vendor to itemise a quote inside a search it had never seen. The fix puts the search's identity
 * ON THE ROW, so a handle can never be paired with a later board's transaction and the browser
 * forwards it without knowing it exists.
 *
 * ⛔ WHY `priceBoth` IS DRIVEN HERE RATHER THAN ONLY `programsForBoard`: a first cut of this suite
 * checked the stamp and the route but not the WIRING between them, and a mutation that stopped
 * `priceBoth` passing the id down SURVIVED. A back end is not a feature until the thing that calls
 * it is exercised too.
 *
 * PURE: no network, no database. The vendor clients are stubbed before the route is required.
 *
 * Sections: A the stamp, B whose answer wins, C the real board end to end, D the route over HTTP,
 * E what must not move.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client'));
const lpClient = require(path.join(ROOT, 'src/longterm/lenderprice/client'));

const TXN = '27684de7-4f69-4759-9962-b2711751924e';
const PORTAL = 'nqmfcorr';

/** One Lender Price leaf, so the board is genuinely two-vendor — this battery is about the other. */
lpClient.price = async () => ({
  ok: true,
  raw: { results: { qualifiedNonQMData: {
    type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
    childs: [{ type: 'LenderKey', keyLabel: 'Acra Lending', plenderId: 'L1', leafs: [{
      companyId: 'L1', companyName: 'Acra Lending', programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
      rate: 7.5, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5, dayLock: 30, term: 30,
      loanAmount: 375000, monthlyPayment: { monthlyPI: 2500 },
    }] }],
  } } },
  searchKey: 'k1', request: {}, provenance: null,
});

const NEX_PROGRAMS = [
  { lender: 'NQM Funding', investor: 'NQM Funding', program: 'DSCR 30', product: '30 Yr Fixed',
    productId: 39035, lenderId: 13398, amortizationType: 'Fixed', isInterestOnly: false, termInMonths: 360,
    rungCount: 2,
    rungs: [
      { rate: 7, price: 101.5, points: -1.5, lockDays: 30, payment: 2400, priceHashKey: 'h-a' },
      { rate: 7.25, price: 102, points: -2, lockDays: 45, payment: 2450, priceHashKey: 'h-b' },
    ] },
];
/** The vendor's own answer carries the search it was priced in — this is what gets stamped. */
nexClient.price = async () => ({
  board: { source: 'loannex', programCount: 1, lenderCount: 1, rungCount: 2, programs: NEX_PROGRAMS },
  transactionId: TXN,
  portal: PORTAL,
});

let asked = null;
nexClient.evidence = async (sc, quote, opts) => {
  asked = { quote, opts: opts || {} };
  return { evidence: null, absence: { reason: 'vendor_returned_no_evidence', message: 'stub' },
    transactionId: (opts || {}).transactionId || 'MINTED' };
};

const routeMod = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'));
const { priceBoth, searchIdentity } = routeMod._internals;
const parse = require(path.join(ROOT, 'src/longterm/loannex/parse.js'));
const qs = require(path.join(ROOT, 'src/longterm/pricing/quote-shape.js'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── A. THE STAMP, over the REAL recorded board ──────────────────────────────
// The whole 90-programme / 5,286-rung answer, so a rung shape this misses shows up as a missing
// stamp rather than passing quietly on a convenient fixture.
const real = parse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);
eq(real.transactionId, TXN, 'A0  the recording carries the search id the HAR explains under');

const merged = { investors: [{ key: 'k', whiteLabel: null, programs: real.programs }] };
const rows = qs.programsForBoard(merged, { reveal: true, transactionId: real.transactionId, portal: PORTAL });
let handles = 0; let stampedTxn = 0; let stampedPortal = 0; let wrongTxn = 0;
for (const row of rows) for (const o of row.options || []) {
  const h = o.explain; if (!h) continue;
  handles += 1;
  if (h.transactionId === real.transactionId) stampedTxn += 1; else if (h.transactionId != null) wrongTxn += 1;
  if (h.portal === PORTAL) stampedPortal += 1;
}
ok(handles > 5000, 'A1  the board really does produce explain handles');
eq(stampedTxn, handles, 'A2  EVERY handle names the search that priced it');
eq(stampedPortal, handles, 'A3  EVERY handle names the portal it was found on');
eq(wrongTxn, 0, 'A4  no handle names a different search');
const one = rows.map((r) => (r.options || []).find((o) => o.explain)).find(Boolean).explain;
ok(typeof one.priceHashKey === 'string' && one.priceHashKey, 'A5  the handle still carries the priceHashKey');
ok(one.productId != null && one.lenderId != null, 'A6  the handle still carries productId and lenderId');

// ⛔ OMITTED, NEVER NULL. The client's fallback is `opts.transactionId || newTransactionId()`, and a
// board with no transaction must reach it exactly as it always did.
const h0 = qs.programsForBoard(merged, { reveal: true })
  .map((r) => (r.options || []).find((o) => o.explain)).find(Boolean).explain;
ok(!('transactionId' in h0), 'A7  with no search id the key is ABSENT, not null');
ok(!('portal' in h0), 'A8  with no portal the key is ABSENT, not null');

// ── B. WHOSE ANSWER WINS ────────────────────────────────────────────────────
eq(searchIdentity({ transactionId: 'row', portal: 'rp' }, { transactionId: 'body', portal: 'bp' }), { transactionId: 'row', portal: 'rp' }, 'B1  the row wins over the body');
eq(searchIdentity({}, { transactionId: 'body', portal: 'bp' }), { transactionId: 'body', portal: 'bp' }, 'B2  the body is the fallback for a caller predating the stamp');
eq(searchIdentity({}, {}), {}, 'B3  neither says -> {} so the client mints as before');
eq(searchIdentity({ transactionId: '', portal: '' }, {}), {}, 'B4  an empty string is not an answer');
eq(searchIdentity({ transactionId: 'row' }, { portal: 'bp' }), { transactionId: 'row', portal: 'bp' }, 'B5  each half is decided on its own');
eq(searchIdentity(null, null), {}, 'B6  a missing quote is not a crash');

// ── C. THE REAL BOARD, END TO END ───────────────────────────────────────────
const SCENARIO = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3, termYears: 30 };
const TO_LP = { acra: { source: 'lenderprice' } };

(async () => {
  const out = await priceBoth(SCENARIO, { marginHoldback: null, routes: TO_LP, links: {} });
  const nexOpts = [];
  for (const p of out.programs || []) for (const o of p.options || []) if (o.explain) nexOpts.push(o.explain);
  ok(nexOpts.length >= 2, 'C1  the priced board carries LoanNEX explain handles');
  ok(nexOpts.every((h) => h.transactionId === TXN), 'C2  priceBoth stamps the vendor\'s OWN search onto every handle');
  ok(nexOpts.every((h) => h.portal === PORTAL), 'C3  priceBoth stamps the portal it was priced on');
  // A Lender Price row explains itself and must gain no handle at all.
  const lpRows = (out.programs || []).filter((p) => (p.options || []).some((o) => !o.explain));
  ok(lpRows.length > 0, 'C4  the Lender Price side still has rows with no handle');

  // ── D. THE ROUTE, OVER REAL HTTP ──────────────────────────────────────────
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((q, _r, n) => { q.actor = { kind: 'staff', role: 'super_admin', id: 'x' }; n(); });
  app.use('/lt', routeMod.makeRouter({ superAdminOnly: false }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const post = (body) => fetch(`http://127.0.0.1:${port}/lt/explain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  // The handle EXACTLY as the board above produced it — never a hand-typed one, so this cannot
  // pass on a shape the board does not actually make.
  const HANDLE = nexOpts[0];
  asked = null;
  await post({ quote: { ...HANDLE }, scenario: SCENARIO, option: {} });
  eq(asked.opts.transactionId, TXN, 'D1  the vendor is asked under the row\'s own search');
  eq(asked.opts.portal, PORTAL, 'D2  the vendor is asked on the row\'s own portal');

  asked = null;
  await post({ quote: { vendor: 'loannex', priceHashKey: 'h-a', rate: 7, price: 101.5, lockDays: 30 }, scenario: SCENARIO, option: {}, transactionId: TXN, portal: PORTAL });
  eq(asked.opts.transactionId, TXN, 'D3  a body-supplied search is still honoured (older callers)');

  asked = null;
  const r4 = await post({ quote: { vendor: 'lenderprice' }, scenario: SCENARIO, option: {} });
  ok(asked === null, 'D4  a Lender Price row is answered without a vendor call');
  ok(r4 && r4.alreadyExplained === true, 'D5  and is told its breakdown already arrived');

  // ── E. WHAT MUST NOT MOVE ────────────────────────────────────────────────
  asked = null;
  await post({ quote: { ...HANDLE }, scenario: SCENARIO, option: {} });
  eq(asked.quote.priceHashKey, HANDLE.priceHashKey, 'E1  the priceHashKey still rides');
  eq(asked.quote.productId, HANDLE.productId, 'E2  productId still rides');
  eq(asked.quote.lenderId, HANDLE.lenderId, 'E3  lenderId still rides');
  eq(asked.quote.lockDays, HANDLE.lockDays, 'E4  the lock still rides');

  // The browser forwards the handle VERBATIM — which is what makes this need no front-end change.
  const jsx = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8');
  ok(/explainer\(\{\s*\.\.\.handle,/.test(jsx), 'E5  the panel still spreads the whole handle into the ask');
  const api = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/api.js'), 'utf8');
  ok(/combinedExplain:\s*\(quote, scenario, option\)/.test(api), 'E6  the api layer still sends the quote through untouched');

  srv.close();
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL PASSED — ${pass} checks`);
  if (fail) process.exit(1);
})().catch((e) => { console.error('CRASHED:', e && e.message); process.exit(1); });
