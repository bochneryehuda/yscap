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
const routing = require(path.join(ROOT, 'src/longterm/pricing/investor-routing'));

/**
 * One Lender Price leaf, amortising, so the board is genuinely two-vendor. The stub also hands back
 * a WIRE REQUEST — the body the real client returns after building it on the live foundation — so
 * section C can make it disagree with the static build, and can take Lender Price down entirely.
 */
const LP = { criteria: { interestOnly: false }, fail: false };
lpClient.price = async () => {
  if (LP.fail) { const e = new Error('lender price down (stub)'); e.code = 'lp_stub_down'; throw e; }
  return {
    ok: true,
    raw: { results: { qualifiedNonQMData: {
      type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
      childs: [{ type: 'LenderKey', keyLabel: 'Acra Lending', plenderId: 'L1', leafs: [{
        companyId: 'L1', companyName: 'Acra Lending', programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
        rate: 7.5, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5, dayLock: 30, term: 30,
        loanAmount: 375000, monthlyPayment: { monthlyPI: 2500 }, isInterestOnly: false,
      }] }],
    } } },
    searchKey: 'k1', request: { criteria: { ...LP.criteria } }, provenance: null,
  };
};

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
const { priceBoth, explainScenario, askedOf, scenarioRefused } = routeMod._internals;

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
    // Asserted on the BUILT VENDOR BODY, against the state the board was priced in — not against
    // a second run of the same chain, which would agree with itself whatever it did.
    const built = nexScenario.buildNexApp(enriched, reg, { countyKey: 31001 });
    eq(built.state, 'NJ', 'A3  the vendor body the explain builds names the state the board was priced in');
    eq(Object.keys(built), Object.keys(rawApp),
      'A3b …by FILLING the state the raw build left null — the SAME field list, in the same order, not a field the raw build lacked');
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
    eq([r.body.asked.rate, r.body.asked.lockDays], [5.75, 15], 'B6  …and which quote: the rate and the lock');
    ok(!('price' in r.body.asked) && !('price' in r.body.option.evidence.asked),
      'B6b …but NOT the price: the vendor is asked about its own (97.75 held back + 0.25), and stating it beside a held-back row would let a reader subtract the two');
    eq(r.body.asked.transactionId, TXN, 'B7  …and which search');
    ok(!('portal' in r.body.asked), 'B8  the portal is NOT on the answer unless the caller asked to see the source (it names the investor\'s own portal)');
    const rev = await post('/explain', { quote: HANDLE, scenario: BROWSER, option: { priceBuild: { noteRate: 5.75 }, terms: { dayLock: 15 } }, marginHoldback: 0.25, routes: {}, revealSource: true });
    ok(rev.status === 200 && rev.body.asked.price === 98 && rev.body.asked.portal === PORTAL,
      `B8b an admin who asked to see the source gets the price the vendor was asked about (97.75 + 0.25 = 98) and the portal (got ${rev.body.asked && rev.body.asked.price}, ${rev.body.asked && rev.body.asked.portal})`);
    ok(r.body.option && r.body.option.evidence && r.body.option.evidence.asked && r.body.option.evidence.asked.state === 'NJ',
      'B9  what was asked rides ON THE OPTION\'S EVIDENCE BLOCK, which is the shape the panel reads');
    ok(r.body.vendor && r.body.vendor.answered === false && r.body.vendor.reason === 'vendor_returned_no_evidence',
      'B10 the answer states whether the vendor answered, and the reason when it did not');

    const rv = await post('/explain', { quote: HANDLE, scenario: BROWSER, option: {}, revealSource: true, marginHoldback: 0.25, routes: {} });
    eq(rv.body.asked.portal, PORTAL, 'B11 with the source revealed, the portal is named');

    const bad = await post('/explain', { quote: HANDLE, scenario: { ...BROWSER, zip: 'nope' }, option: {} });
    ok(bad.status === 422 && bad.body.error === 'invalid_zip', 'B12 a refused scenario is a 422 naming the field — never sent to the vendor as a different loan');

    // A REFUSAL and an INTERNAL FAILURE are two different answers (pre-merge audit 2026-09-02,
    // finding 4): `validateScenario` THROWING is the server's fault, and answering 422 for it
    // tells the caller their scenario is wrong when it is not. The doors cannot be made to throw
    // internally from outside (the checker is bound at load), so the ONE function both doors
    // answer through is exercised directly, and E4b pins that both doors actually use it.
    const fakeRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    const typed = fakeRes(); scenarioRefused(typed, Object.assign(new Error('bad zip'), { status: 422, code: 'invalid_zip', field: 'zip' }));
    ok(typed.code === 422 && typed.body.error === 'invalid_zip' && typed.body.field === 'zip', 'B12b a typed refusal answers its own status, code and field');
    const own = fakeRes(); scenarioRefused(own, Object.assign(new Error('nope'), { status: 400, code: 'x' }));
    ok(own.code === 400, 'B12c …and keeps the status it was given (a refusal is never forced to 422)');
    const crash = fakeRes(); scenarioRefused(crash, new Error('validateScenario blew up'));
    ok(crash.code === 500 && crash.body.error === 'scenario_check_failed' && crash.body.ok === false,
      `B12d an error with NO status is not a refusal: it is a 500 that says the scenario check failed (got ${crash.code} ${crash.body && crash.body.error})`);
    ok(!('field' in crash.body), 'B12e …and it names no field, because no field was refused');

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

    // ⛔ THE MIRROR READS THE WIRE, NOT THE STATIC BUILD (pre-merge audit 2026-09-02). The client
    // builds the body it POSTs on the tenant's LIVE foundation, and a live default can carry a
    // different `interestOnly` from the static base `validateScenario` builds from. The static
    // build for this scenario says false (C1); the wire says true here.
    LP.criteria = { interestOnly: true };
    const wireIo = await board({ ...BROWSER });
    eq(wireIo.productFilter.asked.io, true, 'C16 a silent scenario mirrors the request Lender Price was ACTUALLY sent — the wire says interest-only, whatever the static build says');
    const wireNex = nexProgs(wireIo);
    ok(wireNex.length > 0 && wireNex.every((p) => p.isInterestOnly === true), `C16b …and the LoanNEX board is narrowed to match it (${wireNex.filter((p) => !p.isInterestOnly).length} amortising of ${wireNex.length})`);
    LP.criteria = { interestOnly: false };
    LP.fail = true;
    const lpDown = await board({ ...BROWSER });
    const lpStatus = (out) => ((out.merged.sources || {}).lenderprice) || {};
    ok(lpStatus(off).answered === true && lpStatus(lpDown).answered === false && /lp_stub_down|down/.test(String(lpStatus(lpDown).error || '')),
      'C17 CONTROL — Lender Price failed on this search (the merge says so, with the reason), so there is no wire body');
    eq(lpDown.productFilter.asked.io, false, 'C17b …and the narrowing falls back to the static build (the DSCR base says false) — never to un-narrowed');
    ok(nexProgs(lpDown).every((p) => p.isInterestOnly === false), 'C17c …so the LoanNEX board is still amortising while Lender Price is down');
    LP.fail = false;

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
    // Against the PARSED BOARD the option shape was built FROM — the input side of the function
    // under test — never two fields computed from one source inside it, which can only agree.
    const byProduct = new Map(REAL.programs.map((p) => [`${p.lenderId}|${p.productId}`, p]));
    // A LoanNEX option keeps its vendor ids on its `explain` handle (the row carries no vendor id
    // of its own without reveal).
    const traced = nexOpts.map((o) => ({ o, p: byProduct.get(`${(o.explain || {}).lenderId}|${(o.explain || {}).productId}`) }));
    ok(traced.every((t) => t.p), `D5  every LoanNEX quote traces back to a recorded programme by lender + product (${traced.filter((t) => !t.p).length} untraced)`);
    ok(traced.every((t) => t.p && t.o.terms.term === t.p.termInMonths && t.o.terms.interestOnly === t.p.isInterestOnly),
      'D5b …and its terms block states what THAT programme states: the term in months and whether it is interest-only');
    ok(nexOpts.every((o) => o.terms.interestOnly === o.interestOnly && o.terms.dayLock === o.dayLock),
      'D5c the top-level copies (which older readers use) agree with the terms block');
    const split = qs.splitInterestOnly(nexOpts);
    ok(split.unknown.length === 0 && split.io.length === nexOpts.length, 'D6  the option-level interest-only filter can now classify every board quote (none unknown)');
    ok(lpOpts.length > 0 && lpOpts.every((o) => o.terms && o.terms.interestOnly === false), 'D7  a Lender Price quote\'s terms are exactly what they were');
  }

  // ── D2. THE ORDINARY BOARD CAN ACTUALLY BE ASKED FOR AN ITEMISATION ───────
  /**
   * THE SECOND HALF OF THE OWNER'S *"I still don't see the detailed LLPA and adjustments
   * populate"*, found by the A-to-Z audit on 2026-09-02 and MEASURED before it was fixed.
   *
   * The vendor addresses a quote by BOTH of its ids — `loannex/client.evidence` builds
   * `{ productId, investorId }`, and the vendor's own recorded request carries both
   * (`capture/evidence.json`). `explainHandle` reads them off the program row, and the handle is
   * built AFTER `investor-routing.stripSource` has removed the vendor ids for the one-system view.
   * So on the ORDINARY board — the one the screen asks for, since it sends no `revealSource`
   * unless an admin ticks the box — every LoanNEX row went out with NO investor id, and the vendor
   * was asked to itemise a quote without being told whose it was. Measured on the recorded board:
   * 735 of 735 handles carried it with the source revealed, 0 of 735 without.
   *
   * The fix carries the id to the handle as a NON-ENUMERABLE property, so it reaches the one
   * function that needs it and cannot serialise onto the board. Both halves are pinned here: the
   * board must be ADDRESSABLE, and the carrier must be INVISIBLE.
   */
  {
    const plain = await priceBoth({ ...BROWSER }, { marginHoldback: 0.25, routes: ALL_NEX, links: {}, revealSource: false });
    const handles = [];
    const seen = new Set();
    (function walk(v) {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      /* RE-POINTED 2026-09-02 (audit F8). This used to find handles by `v.vendor === 'loannex'` —
         reading the very fingerprint the one-system rule says must not be on the ordinary board, so
         the guard could only pass while the defect stood.
         A handle is now found by WHERE IT LIVES: it is the `explain` block of an option, which is
         also the only thing the screen ever hands to `/explain`. Sniffing for `priceHashKey`
         instead was tried and is WRONG — the raw rungs under `merged` carry that key too
         (`loannex/parse.js` puts it on every rung), so the walk collected 809 rungs that were never
         handles and D9 failed on objects it should never have been looking at. Structure, not a
         field that happens to be present. */
      if (v.explain && typeof v.explain === 'object') handles.push(v.explain);
      if (Array.isArray(v)) v.forEach(walk); else Object.values(v).forEach(walk);
    })(plain);
    ok(handles.length > 0, `D8  the ordinary board carries LoanNEX rows to address (${handles.length})`);
    ok(handles.every((h) => h.lenderId != null),
      `D9  EVERY one of them names the investor the vendor needs to itemise it — on the board the screen actually asks for, not only the revealed one (${handles.filter((h) => h.lenderId == null).length} unaddressable)`);
    const wire = JSON.stringify(plain);
    ok(!wire.includes('explainLenderId'),
      'D10 …and the key it travelled under never reaches the answer, so it is not a new vendor tell on the row');
    const progs = (plain.merged.investors || []).flatMap((e) => e.programs || []);
    ok(progs.length > 0 && progs.every((p) => p.lenderId == null && p.source == null),
      `D11 the one-system strip still bites on the ROW itself: no programme names a vendor (${progs.filter((p) => p.lenderId != null || p.source != null).length} of ${progs.length} do)`);

    /* ── AUDIT F8: THE THREE PLACES THE ORDINARY BOARD STILL NAMED THE VENDOR ──────────────
       `stripSource` goes to real lengths to remove the fingerprint, and then three things put it
       straight back. Each is asserted on the SAME ordinary board above, and against a REVEALED
       control, so "withheld" is proved to be a decision the flag makes rather than a field that
       was never there. */
    ok(!('provenance' in plain),
      'D12 the ordinary board carries NO `provenance` block — it was returned unconditionally, keyed by vendor name, with the LoanNEX portal inside it');
    /* ⛔ HIDDEN ROWS ARE BUILT ON PURPOSE, because this board produces NONE.
       The first cut of this asserted "no hidden row lacks a white label" against
       `plain.merged.hidden` — which is EMPTY here, so the filter was empty and the assertion could
       not fail. Removing `whiteLabel` from both hidden shapes left the suite green, which is how it
       was caught. That is the same vacuous shape this suite has been finding all day, and it is
       worth naming once more: an assertion about "none of X" is worthless until something proves
       there was an X. Both hidden shapes are now driven deliberately — one investor switched OFF,
       one routed to a source with no quote — and the count is asserted before the property is. */
    const hid = routing.applyRouting({
      investors: [
        { key: 'acra', investor: 'Acra Lending', presentIn: ['loannex'], programs: { loannex: [{ program: 'P' }] } },
        { key: 'nqm', investor: 'NQM Funding', presentIn: ['loannex'], programs: { loannex: [{ program: 'Q' }] } },
      ],
      sources: { lenderprice: { answered: false, error: 'down' } },
    }, { routes: { acra: { enabled: false }, nqm: { source: 'lenderprice' } } }).hidden || [];
    ok(hid.length === 2 && hid.some((h) => h.why === 'switched_off') && hid.some((h) => /source_/.test(h.why)),
      `D13a BOTH hidden shapes are on the table to judge — switched off, and a source that did not answer (${hid.map((h) => h.why).join(', ')})`);
    const badHidden = hid.filter((h) => !('whiteLabel' in h));
    ok(badHidden.length === 0,
      `D13 every HIDDEN row carries the client-safe name too (${badHidden.length} of ${hid.length} without) — a SHOWN row always did, and the panel draws \`whiteLabel || investor || key\`, so the odd one out fell back to the investor's REAL name`);

    /* THE SWEEP. Not a list of three field names — everything the BOARD hands over, for the
       vendor's own name in any casing. It is the guard that will still be right about a field
       nobody has written yet, and it is what turns "we fixed three places" into "there are none".

       ⛔ SCOPED TO THE BOARD, AND HERE IS WHY — the first cut swept the whole answer and found
       nine more hits, all of them `investorPairing.rows[].names.loannex`. That block is NOT a
       defect: it is the owner's own A-to-Z linking panel (*"it would be better to do an A-to-Z
       search on this one"*), it is mounted unconditionally on this screen, and its entire purpose
       is to put "what LoanNEX called this investor" beside "what Lender Price called them" so a
       person can join the two. You cannot link two spellings without naming the two programs. The
       one-system rule is about the PRICED ROW — that a quote must not be tellable apart — not about
       an admin's linking table. Narrowed with the reason stated rather than deleted, and the parts
       swept are named explicitly so nothing new rides in under a key this list forgot. */
    const boardOnly = JSON.stringify({
      programs: plain.programs,
      merged: plain.merged,
      hidden: plain.hidden,
      productFilter: plain.productFilter,
      investorRoster: plain.investorRoster,
      investorsUnmapped: plain.investorsUnmapped,
      sources: plain.sources,
      options: plain.options,
    });
    const hits = (boardOnly.match(/loannex/gi) || []).length;
    const where = [];
    (function locate(v, at) {
      if (v == null) return;
      if (typeof v === 'string') { if (/loannex/i.test(v)) where.push(`${at} = ${JSON.stringify(v).slice(0, 40)}`); return; }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach((x, i) => locate(x, `${at}[${i}]`));
      for (const [k, val] of Object.entries(v)) {
        if (/loannex/i.test(k)) where.push(`${at}.${k}  (the KEY)`);
        locate(val, `${at}.${k}`);
      }
    }(JSON.parse(boardOnly), ''));
    ok(hits === 0,
      `D14 THE SWEEP: the vendor's name appears ${hits} times in the entire ordinary-board answer${where.length ? ' -> ' + [...new Set(where)].slice(0, 6).join(' | ') : ''}`);
  }

  // ── D3. AND THE SAME ANSWER, REVEALED, STILL HAS EVERYTHING ───────────────
  // The controls for D12/D14: nothing was deleted, the flag decides what is SHOWN. A "withheld"
  // guard whose control is not checked is satisfied just as well by a field that never existed.
  {
    const shown = await priceBoth({ ...BROWSER }, { marginHoldback: 0.25, routes: ALL_NEX, links: {}, revealSource: true });
    ok(shown.provenance && typeof shown.provenance === 'object' && 'loannex' in shown.provenance,
      'D15 an admin who ASKS still gets the whole provenance block back — nothing was thrown away');
    ok(JSON.stringify(shown).includes('loannex'),
      'D16 …and the revealed answer does name the vendor, which is what makes D14 a decision rather than an accident');
  }

  // ── E. WHAT MUST NOT MOVE ─────────────────────────────────────────────────
  {
    const src = read('src/longterm/routes/combined-pricer.js');
    ok(/request: r\.request \|\| null/.test(src)
      && /const lpCriteria = \(wire && wire\.criteria && typeof wire\.criteria === 'object'\) \? wire\.criteria\s*\n\s*: \(chk\.request && chk\.request\.criteria\);/.test(src)
      && /const want = productFilter\.wantFrom\(sc, lpModel\._internals, \{ lpCriteria, lpRequest \}\)/.test(src),
      'E1  priceBoth mirrors the WIRE request the client hands back, and falls back to the static build only when there is none');
    /* 2026-09-02 — E1 CAUGHT THIS ONE ITSELF, which is the point of it: the rate lock became a
       fourth mirrored dimension and the call site grew a second argument, so the guard went red
       until it was re-pointed at the new truth. Re-pointed, not relaxed — the lock travels the
       SAME wire-first, static-fallback road as the criteria, and both halves are now asserted.
       The lock is read off the body ROOT (`dayLocksCriteria`), not off `criteria`, so a mirror
       that quietly went back to reading `lpCriteria.dayLocks` would find nothing and narrow
       nothing — silently, which is exactly how this defect lived. */
    ok(/const lpRequest = wire \|\| \(chk\.request && typeof chk\.request === 'object' \? chk\.request : null\);/.test(src),
      'E1b …and the RATE LOCK is mirrored off the same wire body, with the same static fallback — one road for both, never two that can drift');
    ok(/\(\(\{ request: _wire, \.\.\.rest \}\) => rest\)\(lpRes\.value\)/.test(src),
      'E1b …and strips the wire body off the board before it is answered');
    ok(/const io = want\.io;/.test(src), 'E2  the option-level filter reads the SAME resolved answer as the programme narrowing');
    ok(!/nex\s*\.evidence\(scenarioOf\(req\)/.test(src), 'E3  no explain door hands the vendor the raw browser scenario any more');
    ok((src.match(/sc = explainScenario\(req\)/g) || []).length === 2, 'E4  both explain doors run the scenario through explainScenario');
    ok((src.match(/catch \(e\) \{ return scenarioRefused\(res, e\); \}/g) || []).length === 2, 'E4b …and both answer a refusal through scenarioRefused — the one function B12b–e prove');
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
