#!/usr/bin/env node
'use strict';
/**
 * THE DETAILS PANEL ASKS ABOUT THE SAME LOAN THE BOARD PRICED — and the interest-only switch
 * narrows LoanNEX the way it narrows Lender Price.
 *
 * TWO OWNER REPORTS, 2026-09-02, both on the Combined board's LoanNEX rows:
 *
 *   1. *"Very important: I still don't see the detailed LLPA and adjustments populate."*
 *      MEASURED: `priceBoth` runs every scenario through `validateScenario` before either vendor
 *      is asked — the browser sends a ZIP and nothing else about the location, and that step
 *      turns it into state + county. The explain doors handed the RAW browser scenario to the
 *      LoanNEX body builder, so the vendor was asked to itemise a quote for a loan with NO STATE
 *      (`nexApp.state: null` against the board's `"NJ"`). The 30-Aug live recording supplied the
 *      state by hand and three of four investors itemised; the board never did.
 *
 *   2. *"Interest-only program still comes up even when I'm not searching for interest-only."*
 *      MEASURED: the screen's `toScenario` OMITS an off switch (it sends a yes/no button only
 *      when it is on), Lender Price's tenant base carries `interestOnly: false` for an omitted
 *      flag, and `product-filter.wantFrom` read `io: null` and narrowed nothing — so Lender Price
 *      was asked for an amortising board while LoanNEX's interest-only programmes stayed on.
 *
 * PURE: no network, no database. The vendor clients are stubbed before the route is required.
 * The LoanNEX board is the REAL recorded answer (90 programmes, 46 of them interest-only).
 *
 * Sections: A the explain doors ask about the enriched loan, B the answer says what was asked,
 * C interest-only through the real board, D the board's options state their terms, E what must
 * not move.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client'));
const lpClient = require(path.join(ROOT, 'src/longterm/lenderprice/client'));
const parse = require(path.join(ROOT, 'src/longterm/loannex/parse'));
const nexScenario = require(path.join(ROOT, 'src/longterm/loannex/scenario'));
const registryOf = require(path.join(ROOT, 'src/longterm/loannex/field-registry'));
const lpModel = require(path.join(ROOT, 'src/longterm/lenderprice/search-model'));
const qs = require(path.join(ROOT, 'src/longterm/pricing/quote-shape'));
const pf = require(path.join(ROOT, 'src/longterm/pricing/product-filter'));

/** One Lender Price leaf, amortising, so the board is genuinely two-vendor. */
lpClient.price = async () => ({
  ok: true,
  raw: { results: { qualifiedNonQMData: {
    type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
    childs: [{ type: 'LenderKey', keyLabel: 'Acra Lending', plenderId: 'L1', leafs: [{
      companyId: 'L1', companyName: 'Acra Lending', programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
      rate: 7.5, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5, dayLock: 30, term: 30,
      loanAmount: 375000, monthlyPayment: { monthlyPI: 2500 }, isInterestOnly: false,
    }] }],
  } } },
  searchKey: 'k1', request: {}, provenance: null,
});

const REAL = parse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);
const TXN = REAL.transactionId;
const PORTAL = 'web';
nexClient.price = async () => ({ board: REAL, transactionId: TXN, portal: PORTAL });

let asked = null;
nexClient.evidence = async (sc, quote, opts) => {
  asked = { sc, quote, opts: opts || {} };
  return { evidence: null, absence: { reason: 'vendor_returned_no_evidence', message: 'stub' },
    transactionId: (opts || {}).transactionId || 'MINTED' };
};

const routeMod = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'));
const { priceBoth, explainScenario, askedOf } = routeMod._internals;

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** EXACTLY what the browser sends: `toScenario(pricedForm)` — a ZIP, never a state or county. */
const BROWSER = { purpose: 'Purchase', propertyType: 'SingleFamily', units: 1, value: 500000, loan: 375000,
  zip: '08201', fico: 760, dscr: 1.3, termYears: 30, amortization: 'fixed', borrowerType: 'LLC', prepayMonths: 60, citizenship: 'US Citizen' };
/** Every investor on the recorded board routed to LoanNEX and switched on, so routing hides nothing. */
const ALL_NEX = Object.fromEntries(['acra', 'nqm', 'eresi', 'a_and_d', 'american_heritage', 'button_finance', 'champions', 'phh', 'pennymac']
  .map((k) => [k, { source: 'both', enabled: true }]));
const reg = registryOf.capturedRegistry();

(async () => {
  // ── A. THE EXPLAIN DOORS ASK ABOUT THE ENRICHED LOAN ─────────────────────
  {
    // The defect, reproduced on the real builder: the raw browser scenario has no state.
    const rawApp = nexScenario.buildNexApp(BROWSER, reg, { countyKey: 31001 });
    eq(rawApp.state, null, 'A0  CONTROL — the raw browser scenario reaches the vendor with NO state (this is what the panel used to send)');

    const enriched = explainScenario({ body: { scenario: BROWSER } });
    eq(enriched.state, 'NJ', 'A1  explainScenario enriches the ZIP into the state the board was priced in');
    eq(enriched.countyName, 'Atlantic', 'A2  …and the county');
    const boardSc = lpModel.validateScenario(BROWSER).scenario;
    eq(nexScenario.buildNexApp(enriched, reg, { countyKey: 31001 }), nexScenario.buildNexApp(boardSc, reg, { countyKey: 31001 }),
      'A3  the vendor body the explain builds is IDENTICAL, field for field, to the body the board built');
    let refused = null;
    try { explainScenario({ body: { scenario: { ...BROWSER, zip: 'nope' } } }); } catch (e) { refused = e; }
    ok(refused && refused.status === 422 && refused.code === 'invalid_zip', 'A4  a scenario the price door refuses is refused here with the same 422 and code');
    ok(explainScenario({ body: { ...BROWSER } }).state === 'NJ', 'A5  a scenario sent at the root of the body (older callers) is enriched too');
  }

  // ── B. THE ROUTE, OVER REAL HTTP: enriched, and it says what it asked ─────
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((q, _r, n) => { q.actor = { kind: 'staff', role: 'super_admin', id: 'x' }; n(); });
  app.use('/lt', routeMod.makeRouter({ superAdminOnly: false }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const post = (p, body) => fetch(`http://127.0.0.1:${port}/lt${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const HANDLE = { vendor: 'loannex', priceHashKey: '39338-625-33249-5459', rate: 5.75, price: 97.75, lockDays: 15,
    productId: 39338, lenderId: 7236, transactionId: TXN, portal: PORTAL };
  {
    asked = null;
    const r = await post('/explain', { quote: HANDLE, scenario: BROWSER, option: { priceBuild: { noteRate: 5.75 }, terms: { dayLock: 15 } }, marginHoldback: 0.25, routes: {} });
    ok(r.status === 200 && r.body.ok === true, 'B1  the explain door answers');
    eq(asked.sc.state, 'NJ', 'B2  the vendor is asked about the loan IN NEW JERSEY — the state the board was priced in');
    eq(asked.sc.countyName, 'Atlantic', 'B3  …in Atlantic County');
    eq(asked.opts.transactionId, TXN, 'B4  …inside the row\'s own search (the 2026-09-02 identity fix still rides)');
    ok(r.body.asked && r.body.asked.state === 'NJ' && r.body.asked.county === 'Atlantic' && r.body.asked.zip === '08201',
      'B5  the answer SAYS which loan it asked about');
    eq([r.body.asked.rate, r.body.asked.price, r.body.asked.lockDays], [5.75, 98, 15],
      'B6  …and which quote: the vendor\'s OWN price (held-back 97.75 + the 0.25 holdback), the rate and the lock');
    eq(r.body.asked.transactionId, TXN, 'B7  …and which search');
    ok(!('portal' in r.body.asked), 'B8  the portal is NOT on the answer unless the caller asked to see the source (it names the investor\'s own portal)');
    ok(r.body.option && r.body.option.evidence && r.body.option.evidence.asked && r.body.option.evidence.asked.state === 'NJ',
      'B9  what was asked rides ON THE OPTION\'S EVIDENCE BLOCK, which is the shape the panel reads');
    ok(r.body.vendor && r.body.vendor.answered === false && r.body.vendor.reason === 'vendor_returned_no_evidence',
      'B10 the answer states whether the vendor answered, and the reason when it did not');

    const rv = await post('/explain', { quote: HANDLE, scenario: BROWSER, option: {}, revealSource: true, marginHoldback: 0.25, routes: {} });
    eq(rv.body.asked.portal, PORTAL, 'B11 with the source revealed, the portal is named');

    const bad = await post('/explain', { quote: HANDLE, scenario: { ...BROWSER, zip: 'nope' }, option: {} });
    ok(bad.status === 422 && bad.body.error === 'invalid_zip', 'B12 a refused scenario is a 422 naming the field — never sent to the vendor as a different loan');

    asked = null;
    const legacy = await post('/loannex/explain', { quote: HANDLE, scenario: BROWSER });
    ok(legacy.status === 200 && asked && asked.sc.state === 'NJ', 'B13 the legacy door asks about the enriched loan too');

    // askedOf never names a vendor and never crashes on an empty ask.
    const a = askedOf({}, {}, {}, {});
    ok(a && a.rate === null && a.transactionId === null && !('portal' in a), 'B14 askedOf tolerates an empty ask and omits the portal by default');
  }

  // ── C. INTEREST-ONLY, THROUGH THE REAL BOARD ──────────────────────────────
  const board = (sc, opts = {}) => priceBoth(sc, { marginHoldback: null, routes: ALL_NEX, links: {}, revealSource: true, shape: 'options', ...opts });
  const nexProgs = (out) => out.merged.investors.flatMap((e) => (e.bySource && e.bySource.loannex) || []);
  {
    ok(REAL.programs.filter((p) => p.isInterestOnly).length === 46, `C0  the recorded board carries 46 interest-only programmes (got ${REAL.programs.filter((p) => p.isInterestOnly).length})`);

    // What the screen actually sends when the switch is OFF: nothing.
    const off = await board({ ...BROWSER });
    eq(off.productFilter.asked.io, false, 'C1  with the switch OFF (flag omitted) the search is resolved as NOT interest-only — what Lender Price was asked');
    const offNex = nexProgs(off);
    ok(offNex.length > 0 && offNex.every((p) => p.isInterestOnly === false), `C2  …and NOT ONE interest-only programme survives onto the board (${offNex.filter((p) => p.isInterestOnly).length} of ${offNex.length})`);
    ok(off.options.filteredByInterestOnly === true && off.options.rows.every((r) => r.terms && r.terms.interestOnly === false),
      'C3  …and the option list agrees: every quote is amortising');
    ok(off.productFilter.dropped.interestOnly > 0, `C4  the answer REPORTS what the interest-only answer removed (${off.productFilter.dropped.interestOnly})`);

    const explicitOff = await board({ ...BROWSER, io: false });
    eq(explicitOff.productFilter.asked.io, false, 'C5  an explicit false is the same answer');
    eq(nexProgs(explicitOff).length, offNex.length, 'C6  …and the same board');

    const on = await board({ ...BROWSER, io: true });
    eq(on.productFilter.asked.io, true, 'C7  with the switch ON the search is interest-only');
    const onNex = nexProgs(on);
    ok(onNex.length > 0 && onNex.every((p) => p.isInterestOnly === true), `C8  …and ONLY interest-only programmes survive (${onNex.filter((p) => !p.isInterestOnly).length} amortising of ${onNex.length})`);
    ok(onNex.some((p) => p.termInMonths === 480), 'C9  …including the 40-year products an interest-only search also covers (the shared term rule)');
    ok(!offNex.some((p) => p.termInMonths === 480), 'C10 …which an amortising 30-year search does not');

    // The scenario still wins when it says something; the request only fills its silence.
    eq(pf.wantFrom({ io: true }, lpModel._internals, { lpCriteria: { interestOnly: false } }).io, true, 'C11 a stated answer beats the request');
    eq(pf.wantFrom({}, lpModel._internals, { lpCriteria: { interestOnly: false } }).io, false, 'C12 silence takes the request\'s answer');
    eq(pf.wantFrom({}, lpModel._internals, {}).io, null, 'C13 with no request to mirror the dimension stays un-narrowed (the honest answer, never a guess)');
    eq(pf.wantFrom({}, lpModel._internals, { lpCriteria: { interestOnly: 'false' } }).io, null, 'C14 a request carrying a non-boolean is not read as an answer');

    // ⛔ WHY THE SERVER HAS TO RESOLVE IT: the screen omits an off switch. If this ever changes the
    // server rule is harmless (a stated false is the same answer) — but the rule exists BECAUSE of it.
    const sf = read('app-v2/src/longterm/scenarioFields.js');
    ok(/if \(BOOLEAN\.has\(k\)\) \{ if \(v === true \|\| v === 'true'\) out\[k\] = true; continue; \}/.test(sf),
      'C15 the screen still sends a yes/no button only when it is ON — the omitted false is what the server now resolves');
  }

  // ── D. THE BOARD'S OPTIONS STATE THEIR TERMS ─────────────────────────────
  {
    const out = await priceBoth({ ...BROWSER, io: true }, { marginHoldback: null, routes: ALL_NEX, links: {}, revealSource: true });
    const nexOpts = [];
    const lpOpts = [];
    for (const p of out.programs || []) for (const o of p.options || []) (o.explain ? nexOpts : lpOpts).push(o);
    ok(nexOpts.length > 100, `D1  the board carries LoanNEX quotes (${nexOpts.length})`);
    ok(nexOpts.every((o) => o.terms && typeof o.terms.interestOnly === 'boolean'),
      'D2  every LoanNEX quote states its amortization under `terms.interestOnly` — the key the panel\'s "Amortization" row reads');
    ok(nexOpts.every((o) => o.terms && Number.isFinite(o.terms.term) && o.terms.termInMonths === true),
      'D3  …and its term, in months, said to be months (the panel prints "360 months")');
    ok(nexOpts.every((o) => o.terms && Number.isFinite(o.terms.dayLock)), 'D4  …and its lock');
    ok(nexOpts.every((o) => o.terms.interestOnly === o.interestOnly && o.terms.dayLock === o.dayLock),
      'D5  the top-level copies (which older readers use) agree with the terms block');
    const split = qs.splitInterestOnly(nexOpts);
    ok(split.unknown.length === 0 && split.io.length === nexOpts.length, 'D6  the option-level interest-only filter can now classify every board quote (none unknown)');
    ok(lpOpts.length > 0 && lpOpts.every((o) => o.terms && o.terms.interestOnly === false), 'D7  a Lender Price quote\'s terms are exactly what they were');
  }

  // ── E. WHAT MUST NOT MOVE ─────────────────────────────────────────────────
  {
    const src = read('src/longterm/routes/combined-pricer.js');
    ok(/const want = productFilter\.wantFrom\(sc, lpModel\._internals, \{ lpCriteria: chk\.request && chk\.request\.criteria \}\)/.test(src),
      'E1  priceBoth hands the narrowing the BUILT Lender Price request — the same object lp.price sends');
    ok(/const io = want\.io;/.test(src), 'E2  the option-level filter reads the SAME resolved answer as the programme narrowing');
    ok(!/nex\s*\.evidence\(scenarioOf\(req\)/.test(src), 'E3  no explain door hands the vendor the raw browser scenario any more');
    ok((src.match(/sc = explainScenario\(req\)/g) || []).length === 2, 'E4  both explain doors run the scenario through explainScenario');
    const jsx = read('app-v2/src/longterm/LtPricer.jsx');
    ok(/askedLine\(ev\.asked\)/.test(jsx), 'E5  the panel prints what was asked under an empty breakdown');
    ok(!/loannex|LoanNEX/i.test(jsx.slice(jsx.indexOf('function askedLine'), jsx.indexOf('function askedLine') + 1500)), 'E6  …and names no vendor doing it');
    const pfSrc = read('src/longterm/pricing/product-filter.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/\.(program|product|programName|productName|name|label|description)\b/.test(pfSrc),
      'E7  the narrowing still reads no programme name, product name, label or description (the owner\'s condition on this filter)');
  }

  srv.close();
  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILED'} — ${pass + fail} checks (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
