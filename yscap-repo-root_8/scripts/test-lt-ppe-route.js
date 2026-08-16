#!/usr/bin/env node
'use strict';
/**
 * /api/lt/ppe/* — the PPE HTTP surface (pure: no network, no database).
 *
 * The engine underneath this route was built, green and UNREACHABLE. What this
 * suite guards is not the engine (27 suites already do that) but the ROUTE's own
 * promises, each of which is a way the shadow model could be broken from above:
 *
 *   • Lender Price stays the answer. Our engine may only ADD a `shadow` block.
 *   • With no program configured we do NOT pretend to shadow — because
 *     `quote.quoteProgram` THROWS without one, and the facade would faithfully
 *     record that as an `engine_error` finding on EVERY quote, filling the ledger
 *     with a configuration fact and burying the real disagreements.
 *   • The decision vocabulary is the LEDGER's, never the route's — a status
 *     invented here would break "never re-open a settled finding".
 *   • Writes are admin-gated, and a gate that cannot be CHECKED is not a gate
 *     that has been PASSED (503, never fall-open).
 *   • No silent caps: over the canary limit is a REFUSAL naming the limit, and a
 *     truncated findings page says so.
 *   • Nothing is reported as measured that was not measured (the scoreboard gate
 *     cannot pass with no canary history).
 *
 * The LT db pool and the Lender Price client are stubbed through require.cache
 * BEFORE the route is loaded, so this runs with no DATABASE_URL and no upstream.
 *
 * LT-only. No RTL imports.
 */
const path = require('path');

let failures = 0;
function ok(c, l) { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; }

// ---------------------------------------------------------------------------
// stubs, installed before the route is required
// ---------------------------------------------------------------------------
const P = (rel) => require.resolve(path.join(__dirname, '..', 'src', 'longterm', rel));

const dbStub = { queries: [], next: null, throwWith: null };
dbStub.query = async (text, params) => {
  dbStub.queries.push({ text, params });
  if (dbStub.throwWith) throw new Error(dbStub.throwWith);
  const r = typeof dbStub.next === 'function' ? dbStub.next(text, params) : dbStub.next;
  return r || { rows: [], rowCount: 0 };
};
require.cache[P('db.js')] = { id: P('db.js'), filename: P('db.js'), loaded: true, exports: dbStub };

const lpStub = { calls: [], result: { rungs: [] }, throwWith: null };
lpStub.price = async (sc) => {
  lpStub.calls.push(sc);
  if (lpStub.throwWith) throw new Error(lpStub.throwWith);
  return lpStub.result;
};
require.cache[P('lenderprice/client.js')] = {
  id: P('lenderprice/client.js'), filename: P('lenderprice/client.js'), loaded: true, exports: lpStub,
};

const settingsStub = { admin: true, throwWith: null };
settingsStub.load = async () => {
  if (settingsStub.throwWith) throw new Error(settingsStub.throwWith);
  return { settings: {} };
};
require.cache[P('settings/store.js')] = {
  id: P('settings/store.js'), filename: P('settings/store.js'), loaded: true, exports: settingsStub,
};

const accessStub = require(P('access.js'));
const realMayManage = accessStub.mayManagePeople;
accessStub.mayManagePeople = () => settingsStub.admin;

const route = require('../src/longterm/routes/ppe');
const H = route.handlers;
const I = route._internals;
const finding = require('../src/longterm/ppe/finding');

// a minimal express-ish res
function mkRes() {
  const res = { code: 200, body: null, headersSent: false };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}
const call = async (fn, req) => { const res = mkRes(); await fn(req || {}, res); return res; };

console.log('/api/lt/ppe/* — the PPE HTTP surface');

// ---------------------------------------------------------------------------
// 1) the router itself
// ---------------------------------------------------------------------------
ok(typeof route === 'function' && typeof route.use === 'function', 'the module IS an express router (server.js can mount it)');
ok(Object.keys(H).length === 8, `all 8 handlers are exported for testing (${Object.keys(H).length})`);

// It must actually be MOUNTED, or the whole surface is unreachable — the exact
// state this route was built to end.
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'index.js'), 'utf8');
  ok(/router\.use\(\s*['"]\/ppe['"]\s*,\s*require\(['"]\.\/routes\/ppe['"]\)\s*\)/.test(src),
    'MOUNT: src/longterm/index.js mounts it at /ppe (an unmounted router is the bug this closes)');
}

// ---------------------------------------------------------------------------
// 2) the decision vocabulary is the LEDGER's, not the route's
// ---------------------------------------------------------------------------
{
  const expected = [...finding.SETTLED_STATUSES, ...finding.OPEN_STATUSES].sort();
  ok(JSON.stringify([...I.DECIDABLE].sort()) === JSON.stringify(expected),
    'DECIDABLE is derived from finding.js, so the route can never invent a status the ledger refuses');
}

// ---------------------------------------------------------------------------
// 3) intIn refuses rather than coerces
// ---------------------------------------------------------------------------
ok(I.intIn('4', 8) === 4, 'intIn accepts a numeric string in range');
ok(I.intIn('0', 8) === null, 'intIn refuses 0');
ok(I.intIn(9, 8) === null, 'intIn refuses over the max');
ok(I.intIn('abc', 8) === null, 'intIn refuses junk (never NaN)');
ok(I.intIn(2.5, 8) === null, 'intIn refuses a non-integer');
ok(I.intIn(undefined, 8) === null && I.intIn('', 8) === null, 'intIn reads absent as absent');

// ---------------------------------------------------------------------------
// 4) health — a DB failure is reported AS a DB failure, never as "not configured"
// ---------------------------------------------------------------------------
(async () => {
  dbStub.throwWith = null; dbStub.next = () => ({ rows: [{ id: 'i1', code: 'ACME', name: 'Acme', active: true }] });
  let r = await call(H.health);
  ok(r.code === 200 && r.body.configured === true && r.body.investors === 1, 'health: one investor -> configured true');
  ok(r.body.authoritative === 'lp', 'health: says Lender Price is authoritative');

  dbStub.next = () => ({ rows: [] });
  r = await call(H.health);
  ok(r.code === 200 && r.body.configured === false, 'health: no investors -> 200 configured:false (not an error)');

  dbStub.throwWith = 'connection refused';
  r = await call(H.health);
  ok(r.code === 200 && r.body.configured === null && /connection refused/.test(r.body.dbError || ''),
    'health: a DB failure reports configured:null + the error, never a confident configured:false');
  dbStub.throwWith = null;

  // -------------------------------------------------------------------------
  // 5) settings — the screen is drawn from the server's own description
  // -------------------------------------------------------------------------
  dbStub.next = () => ({ rows: [] });
  r = await call(H.getSettings);
  ok(r.code === 200 && Array.isArray(r.body.definitions) && r.body.definitions.length > 0,
    'settings: ships the typed registry so a screen needs no second copy of what is configurable');
  ok(r.body.values && typeof r.body.values === 'object', 'settings: ships the resolved values beside the registry');

  // -------------------------------------------------------------------------
  // 6) investors — honest that per-investor lifecycle is not modelled
  // -------------------------------------------------------------------------
  dbStub.next = () => ({ rows: [{ id: 'i1', code: 'ACME', name: 'Acme', active: true }] });
  r = await call(H.listInvestorsRoute);
  ok(r.code === 200 && r.body.investors.length === 1, 'investors: lists what is configured');
  ok(r.body.lifecycle && r.body.lifecycle.perInvestor === false && r.body.lifecycle.mode === 'shadow',
    'investors: says plainly that per-investor promotion is not persisted (no invented draft/live state)');

  // -------------------------------------------------------------------------
  // 7) quote — LP answers; a missing program costs the SHADOW, not the quote
  // -------------------------------------------------------------------------
  r = await call(H.quoteRoute, { body: {} });
  ok(r.code === 400, 'quote: refuses a request with no scenario');

  lpStub.calls = []; lpStub.result = { rungs: [{ rate: 7.125, price: 100.25 }] };
  dbStub.queries = [];
  r = await call(H.quoteRoute, { body: { scenario: { fico: 760 } } });
  ok(r.code === 200 && r.body.authoritative === 'lp' && r.body.answer === lpStub.result,
    'quote: with no program, LP still answers (LP is authoritative — the shadow is what is lost)');
  ok(r.body.shadow === null && r.body.shadowSkipped === 'no_program_requested',
    'quote: and it SAYS the shadow was skipped, so a missing block is never read as "the engines agreed"');
  ok(!dbStub.queries.some((q) => /lt_ppe_finding/.test(q.text)),
    'quote: NO engine_error finding is written for a missing program (a config fact must not bury real findings)');

  // a program that cannot be loaded is reported as such, not silently ignored
  dbStub.next = () => ({ rows: [] });
  const bad = await I.loadProgram('company', 'v-does-not-exist');
  ok(bad.program === null && bad.reason === 'program_not_found',
    'loadProgram: an unloadable program yields a REASON, never a silent null');

  // THE SHAPE TRAP the route was built with and this suite caught: the STORE
  // returns a stored SHEET (raw base_price / adjustment rows); the ENGINE prices
  // a PROGRAM (`baseGrid` + `rules`). Handing the sheet straight through throws
  // `quote:program_has_no_base_grid`, which the facade records as an
  // engine_error finding on EVERY quote. loadProgram must run the pure mapper.
  {
    const sheetRows = {
      version: { id: 'v1', label: 'Sheet A' },
      basePrices: [{ note_rate_milli_pct: 7125, lock_days: 30, product: 'DSCR30', price_milli: 102850 }],
      adjustments: [], priceLimit: null,
    };
    dbStub.next = (text) => {
      if (/lt_ppe_rate_sheet_version/.test(text)) return { rows: [sheetRows.version] };
      if (/lt_ppe_base_price/.test(text)) return { rows: sheetRows.basePrices };
      return { rows: [] };
    };
    const good = await I.loadProgram('company', 'v1');
    ok(good.program && Array.isArray(good.program.baseGrid) && good.program.baseGrid.length === 1,
      'loadProgram: maps the stored sheet through rateSheetToProgram into a real baseGrid');
    ok(good.program.baseGrid[0].basePriceMilli === 102850 && good.program.baseGrid[0].rate === 7125,
      'loadProgram: …carrying the milli price and rate the engine prices from');
    ok(!Object.prototype.hasOwnProperty.call(good.program, 'basePrices'),
      'loadProgram: the raw sheet shape is NOT passed through (that would throw on every quote)');
    // and a sheet with an empty grid is refused rather than handed on to throw
    dbStub.next = (text) => (/lt_ppe_rate_sheet_version/.test(text) ? { rows: [sheetRows.version] } : { rows: [] });
    const empty = await I.loadProgram('company', 'v1');
    ok(empty.program === null && empty.reason === 'program_has_no_base_grid',
      'loadProgram: a sheet with no base prices is refused with a reason, never handed on');
  }

  // -------------------------------------------------------------------------
  // 8) findings — vocabulary, filtering, and no silent caps
  // -------------------------------------------------------------------------
  r = await call(H.listFindingsRoute, { query: { status: 'banana' } });
  ok(r.code === 400 && Array.isArray(r.body.allowed), 'findings: an unknown status is refused and the allowed set is named');

  const rows = [];
  for (let i = 0; i < 7; i++) {
    rows.push({
      finding_key: `k${i}`, investor: i < 4 ? 'ACME' : 'OTHER', program: 'P', scenario: 's', scenario_facts: {},
      kind: 'price_mismatch', diff: {}, our_payload: {}, their_payload: {}, status: 'open',
      regressed: false, recurrence: 1, first_seen_at: new Date(), last_seen_at: new Date(),
    });
  }
  dbStub.next = () => ({ rows });
  r = await call(H.listFindingsRoute, { query: { investor: 'ACME' } });
  ok(r.code === 200 && r.body.total === 4, 'findings: narrows to one investor (4 of 7)');
  ok(r.body.truncated === false, 'findings: says when nothing was held back');

  r = await call(H.listFindingsRoute, { query: { limit: 2 } });
  ok(r.body.returned === 2 && r.body.total === 7 && r.body.truncated === true,
    'findings: a limited page REPORTS the truncation (no silent cap)');

  // -------------------------------------------------------------------------
  // 9) decide — the ledger's vocabulary, and a reason that is actually a reason
  // -------------------------------------------------------------------------
  r = await call(H.decideFindingRoute, { params: { key: 'k1' }, body: { status: 'banana', reason: 'a good long reason' } });
  ok(r.code === 400, 'decide: refuses a status the ledger does not know');

  r = await call(H.decideFindingRoute, { params: { key: 'k1' }, body: { status: 'fixed', reason: 'short' } });
  ok(r.code === 400 && /never re-opened/.test(r.body.error), 'decide: refuses a too-short reason, and says WHY it matters');

  r = await call(H.decideFindingRoute, { params: { key: '' }, body: { status: 'fixed', reason: 'a good long reason' } });
  ok(r.code === 400, 'decide: refuses a missing key');

  dbStub.next = () => ({ rows: [], rowCount: 0 });
  r = await call(H.decideFindingRoute, { params: { key: 'nope' }, body: { status: 'fixed', reason: 'a good long reason' } });
  ok(r.code === 404, 'decide: a key that matched nothing is a 404, not a silent success');

  // -------------------------------------------------------------------------
  // 10) canary — refusals, and the cap that names itself
  // -------------------------------------------------------------------------
  r = await call(H.canaryRoute, { body: {} });
  ok(r.code === 400, 'canary: refuses with neither scenarios nor a matrix');

  r = await call(H.canaryRoute, { body: { scenarios: [] } });
  ok(r.code === 400, 'canary: refuses an empty battery');

  const many = Array.from({ length: I.MAX_CANARY_SCENARIOS + 1 }, (_, i) => ({ i }));
  r = await call(H.canaryRoute, { body: { scenarios: many } });
  ok(r.code === 422 && r.body.limit === I.MAX_CANARY_SCENARIOS && r.body.asked === many.length,
    'canary: over the cap is a REFUSAL naming the limit and the ask — never a quiet truncation');

  r = await call(H.canaryRoute, { body: { scenarios: [{ fico: 760 }] } });
  ok(r.code === 422 && /rate-sheet version/.test(r.body.error || ''),
    'canary: refuses with no program (it would record N engine_errors that say nothing about agreement)');

  // -------------------------------------------------------------------------
  // 11) scoreboard — nothing is reported as measured that was not measured
  // -------------------------------------------------------------------------
  r = await call(H.scoreboardRoute, { query: {} });
  ok(r.code === 400, 'scoreboard: refuses without an investor');

  dbStub.next = () => ({ rows });
  r = await call(H.scoreboardRoute, { query: { investor: 'ACME' } });
  ok(r.code === 200 && r.body.scoreboard.openFindings === 4, 'scoreboard: counts that investor\'s open findings');
  ok(r.body.scoreboard.canaryAgreementRate === null,
    'scoreboard: no canary history reads as NOT PROVEN (never a fabricated 1.0)');
  ok(r.body.gate && r.body.gate.eligible === false,
    'scoreboard: the go-live gate therefore cannot pass — the honest state, not a failure');

  // -------------------------------------------------------------------------
  // 12) the admin gate — and it fails CLOSED
  // -------------------------------------------------------------------------
  const gate = async () => {
    const res = mkRes(); let passed = false;
    await I.requirePpeAdmin({ actor: {} }, res, () => { passed = true; });
    return { res, passed };
  };
  settingsStub.admin = true; settingsStub.throwWith = null;
  ok((await gate()).passed === true, 'admin gate: an administrator passes');

  settingsStub.admin = false;
  let g = await gate();
  ok(g.passed === false && g.res.code === 403, 'admin gate: a non-administrator is refused 403');

  settingsStub.admin = true; settingsStub.throwWith = 'settings unreadable';
  g = await gate();
  ok(g.passed === false && g.res.code === 503,
    'admin gate: FAILS CLOSED — a gate that cannot be checked is not a gate that has been passed');
  settingsStub.throwWith = null;

  // -------------------------------------------------------------------------
  // 13) the writes are actually gated on the router (not just gateable)
  // -------------------------------------------------------------------------
  {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
    ok(/router\.post\('\/findings\/:key\/decide',\s*requirePpeAdmin/.test(src), 'ROUTER: deciding a finding is admin-gated');
    ok(/router\.post\('\/canary',\s*requirePpeAdmin/.test(src), 'ROUTER: running a canary is admin-gated');
    ok(!/router\.(post|put|patch|delete)\('\/(quote|health|settings|investors|findings|scoreboard)'[^)]*requirePpeAdmin/.test(src),
      'ROUTER: reading is NOT admin-gated (an engineer must be able to see why a scenario disagreed)');
    ok(!/mode:\s*\(\)\s*=>\s*'live'/.test(src), 'MODEL: nothing in this route can put the engine in live mode (§1.2)');
  }

  accessStub.mayManagePeople = realMayManage;
  console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
