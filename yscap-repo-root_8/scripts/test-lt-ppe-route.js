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
// 23 since the CANARY SCHEDULE became reachable — list/save/delete plus the tick that honours it.
// Before them, `canary-schedule.js` and `schedule-store.js` were built, tested and callable by nothing,
// so the agreement series only grew on the days somebody fired a canary by hand.
// This count is a deliberate guard: adding a handler without exporting/testing it should FAIL here, so
// bump it in the same commit that adds one — never delete the assertion to make a build green.
ok(Object.keys(H).length === 23, `all 23 handlers are exported for testing (${Object.keys(H).length})`);
// A COUNT ALONE IS NOT ENOUGH: it stays satisfied if a handler is renamed, or if one is dropped in the
// same commit another is added. Naming them is what makes the guard bite on either.
for (const name of ['listSuggestionsRoute', 'acceptSuggestionRoute', 'dismissSuggestionRoute',
  'listRulesRoute', 'mineSuggestionsRoute', 'ruleCoverageRoute',
  'getProgramLpScopeRoute', 'setProgramLpScopeRoute', 'parityCellsRoute', 'listProgramsRoute',
  'listSchedulesRoute', 'saveScheduleRoute', 'deleteScheduleRoute', 'canaryTickRoute']) {
  ok(typeof H[name] === 'function', `the ${name} handler is exported by name`);
}

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
  const expected = [...finding.SETTLED_STATUSES].sort();
  ok(JSON.stringify([...I.DECIDABLE].sort()) === JSON.stringify(expected),
    'DECIDABLE is derived from finding.js, so the route can never invent a status the ledger refuses');
  // SETTLING statuses ONLY. Accepting the open ones let this endpoint move a settled
  // finding back to open, and decideFinding overwrites decision_reason
  // unconditionally — so the re-open DESTROYED the note the route itself calls the
  // only lasting record of why. A finding re-opens by REPRODUCING (finding.reconcile
  // marks it `regressed`), never by a decision.
  for (const openStatus of finding.OPEN_STATUSES) {
    ok(!I.DECIDABLE.includes(openStatus), `REOPEN-${openStatus} is not offered as a decision`);
  }
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
  // 7c) THE ROUNDING-MODE VOCABULARY GAP — the re-audit's second blocker
  // `lt_ppe_price_limit.rounding_mode` is NOT NULL DEFAULT 'nearest_eighth' (db/560)
  // with NO CHECK — the SETTINGS vocabulary. The pricer accepts only
  // nearest|up|down|half_even|none, and quote.js lets a sheet's own mode WIN over
  // resolveRounding, the only thing that translates between them. So a price-limit
  // row created at the schema DEFAULT produced a program that passed every one of
  // loadProgram's guards and then threw INSIDE quoteProgram — recorded by the shadow
  // facade as an engine_error finding on EVERY quote. loadProgram's guard only
  // covered the one throw it had happened to observe. Every fixture missed this by
  // using 'none' (the one token both vocabularies share) or no price-limit row.
  {
    const ratesheet = require('../src/longterm/ppe/ratesheet');
    const quoteMod = require('../src/longterm/ppe/quote');
    const ppeSettings2 = require('../src/longterm/ppe/settings');
    const settings2 = ppeSettings2.resolveAll({}).values;
    const sheetWith = (mode) => ({
      version: { id: 'v1' },
      basePrices: [{ note_rate_milli_pct: 7125, lock_days: 30, product: 'P', price_milli: 102850 }],
      adjustments: [],
      priceLimit: { min_price_milli: 98000, rounding_mode: mode, rounding_increment_milli: 125, cap_tiers: [] },
    });
    const throwsWith = (mode) => {
      const prog = ratesheet.rateSheetToProgram(sheetWith(mode), { code: 'v1' });
      try { quoteMod.quoteProgram({ scenario: { fico: 760, loan_amount: 400000 }, program: prog, settings: settings2 }); return null; }
      catch (e) { return e.message; }
    };
    ok(throwsWith('nearest_eighth') === null,
      'ROUND-DEFAULT the db/560 column DEFAULT prices instead of throwing (this is the whole finding)');
    for (const m of ['nearest_increment', 'up', 'down', 'half_even', 'none']) {
      ok(throwsWith(m) === null, `ROUND-SETTINGS "${m}" translates to a mode the pricer accepts`);
    }
    for (const m of ['nearest', 'up', 'down', 'half_even', 'none']) {
      const prog = ratesheet.rateSheetToProgram(sheetWith(m), { code: 'v1' });
      ok(prog.priceLimit.roundingMode === m, `ROUND-PASSTHRU "${m}" is left exactly as stored`);
    }
    ok(/bad_rounding_mode:banana/.test(throwsWith('banana') || ''),
      'ROUND-UNKNOWN an unrecognised mode is still refused BY NAME, never silently defaulted to a rounding nobody chose');
  }

  // -------------------------------------------------------------------------
  // 7b) THE SETTINGS SHAPE — the re-audit's first blocker
  // `settings.resolveAll` returns {values, sources} and its keys are NAMESPACED.
  // The route wrapped that object a SECOND time and read flat keys off it, so every
  // setting was undefined. Nothing errored: the engine fell back to its coded
  // defaults, which meant a MARGIN OF 0 instead of the configured 250 milli — our
  // shadow engine priced every scenario a quarter point off Lender Price and
  // manufactured a systematic disagreement, filling the ledger with our own
  // misconfiguration. The old assertion (`typeof values === 'object'`) was satisfied
  // by the double-wrapped object, which is why it was blind.
  {
    const ppeSettings = require('../src/longterm/ppe/settings');
    const { values, sources } = await I.resolveSettingsSafe('company');
    ok(!Object.prototype.hasOwnProperty.call(values, 'values'),
      'SET-1 resolveSettingsSafe returns the FLAT map, not the {values,sources} wrapper');
    ok(values['pricing.correspondent_margin_milli'] === 250,
      `SET-2 the configured margin resolves (got ${values['pricing.correspondent_margin_milli']}) — 0 would misprice every shadow quote by a quarter point`);
    ok(typeof values[I.K.priceTolerance] === 'number',
      `SET-3 the parity tolerance resolves through the namespaced key (${I.K.priceTolerance})`);
    ok(sources && typeof sources === 'object', 'SET-4 …and where each value came from is kept, not discarded');
    // every key the route reads must EXIST in the registry — a typo here is silent
    for (const k of Object.values(I.K)) {
      ok(Object.prototype.hasOwnProperty.call(values, k), `SET-KEY ${k} is a real setting key`);
    }
    // a screen doing values[def.key] must not get undefined for every definition
    const defs = ppeSettings.allDefinitions();
    const undef = defs.filter((d) => values[d.key] === undefined && d.default !== undefined);
    ok(undef.length === 0, `SET-5 a screen can read every definition off the map (${undef.length} undefined)`);
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
  // The stub HONOURS the SQL predicate, because the narrowing now happens in the
  // database. A stub that ignored it would let a route that forgot to pass
  // `investor` pass this test while fetching the whole ledger on every read.
  const ledgerStub = (text, params) => {
    if (!/lt_ppe_finding/.test(text)) return { rows: [] };
    const inv = /AND investor = \$(\d+)/.exec(text);
    if (!inv) return { rows };
    const want = params[Number(inv[1]) - 1];
    return { rows: rows.filter((x) => x.investor === want) };
  };
  dbStub.next = ledgerStub;
  dbStub.queries = [];
  r = await call(H.listFindingsRoute, { query: { investor: 'ACME' } });
  ok(r.code === 200 && r.body.total === 4, 'findings: narrows to one investor (4 of 7)');
  ok(r.body.truncated === false, 'findings: says when nothing was held back');
  {
    const q = dbStub.queries.find((x) => /lt_ppe_finding/.test(x.text));
    ok(q && /AND investor = \$\d/.test(q.text) && q.params.includes('ACME'),
      'findings: the investor narrowing is a SQL PREDICATE, not a JS filter over the whole scope');
    ok(!/LIMIT/.test(q.text),
      'findings: …and NO SQL limit — buildQueue ranks by severity, which only exists in JS, so truncating in SQL would present the most RECENT as the most IMPORTANT');
  }

  r = await call(H.listFindingsRoute, { query: { limit: 2 } });
  ok(r.body.returned === 2 && r.body.total === 7 && r.body.truncated === true,
    'findings: a limited page REPORTS the truncation (no silent cap)');

  // -------------------------------------------------------------------------
  // 9) decide — the ledger's vocabulary, and a reason that is actually a reason
  // -------------------------------------------------------------------------
  r = await call(H.decideFindingRoute, { params: { key: 'k1' }, body: { status: 'banana', reason: 'a good long reason' } });
  ok(r.code === 400, 'decide: refuses a status the ledger does not know');

  for (const openStatus of finding.OPEN_STATUSES) {
    const rr = await call(H.decideFindingRoute, { params: { key: 'k1' }, body: { status: openStatus, reason: 'a good long reason' } });
    ok(rr.code === 400 && /where a finding STARTS/.test(rr.body.error || ''),
      `decide: refuses "${openStatus}" — re-opening would overwrite the very note that records why it was settled`);
  }

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

  dbStub.next = ledgerStub; // section 9 left it returning nothing
  dbStub.queries = [];
  r = await call(H.scoreboardRoute, { query: { investor: 'ACME' } });
  ok(r.code === 200 && r.body.scoreboard.openFindings === 4, 'scoreboard: counts that investor\'s open findings');
  {
    const q = dbStub.queries.find((x) => /lt_ppe_finding/.test(x.text));
    ok(q && /AND investor = \$\d/.test(q.text) && q.params.includes('ACME'),
      'scoreboard: …narrowed in SQL too, so it does not read the whole ledger to score one investor');
  }
  ok(r.body.scoreboard.canaryAgreementRate === null,
    'scoreboard: no canary history reads as NOT PROVEN (never a fabricated 1.0)');
  ok(r.body.gate && r.body.gate.eligible === false,
    'scoreboard: the go-live gate therefore cannot pass — the honest state, not a failure');

  // -------------------------------------------------------------------------
  // 11b) THE RUN SERIES — the canary's measurement is DURABLE, and the scoreboard
  //      reads back the very series the canary wrote.
  //
  // The findings ledger answers "what disagreed"; the run series answers "how well
  // the two engines agreed on this date". The scoreboard's clean-day streak and
  // agreement trend are computed from the SERIES, so with nothing persisting it the
  // go-live gate could never pass however long the engine behaved — the investor
  // would be permanently unmeasured, which reads exactly like a permanent failure.
  //
  // The trap this section exists to catch: the series is keyed on
  // (scope, investor, program) and run-store stores those as LABELS. The canary
  // writes with the loaded program OBJECT in hand and the scoreboard reads with a
  // query STRING, so if the two do not resolve to the same label the write lands in
  // one series and the read finds an empty one — and "nothing measured" is
  // indistinguishable from "no canary has run". Passing the object stringifies to
  // "[object Object]": still a valid series key, just one nothing will ever read.
  // Hence ONE helper used by both, and the round-trip below is what proves it.
  // -------------------------------------------------------------------------
  {
    // an in-memory `lt_ppe_shadow_run` keyed exactly as db/565 keys it, so the WRITE
    // and the READ have to agree about the key for anything at all to come back.
    const runTable = [];
    const sheet = {
      version: { id: 'v1', label: 'Sheet A' },
      basePrices: [{ note_rate_milli_pct: 7125, lock_days: 30, product: 'DSCR30', price_milli: 102850 }],
      adjustments: [], priceLimit: null,
    };
    const withRuns = (text, params) => {
      if (/INSERT INTO lt_ppe_shadow_run/.test(text)) {
        const [scope2, investor2, program2, , dayMs, rate, keys, summary] = params;
        const row = {
          scope: scope2, investor: investor2, program: program2, day_ms: dayMs,
          agreement_rate: rate,
          finding_keys: JSON.parse(keys),
          summary: summary == null ? null : JSON.parse(summary),
        };
        const at = runTable.findIndex((x) => x.scope === scope2 && x.investor === investor2
          && x.program === program2 && String(x.day_ms) === String(dayMs));
        if (at >= 0) runTable[at] = row; else runTable.push(row);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM lt_ppe_shadow_run/.test(text)) {
        const [scope2, investor2, program2] = params;
        return {
          rows: runTable.filter((x) => x.scope === scope2 && x.investor === investor2 && x.program === program2),
        };
      }
      if (/lt_ppe_rate_sheet_version/.test(text)) return { rows: [sheet.version] };
      if (/lt_ppe_base_price/.test(text)) return { rows: sheet.basePrices };
      return ledgerStub(text, params);
    };
    dbStub.next = withRuns;

    // Call it the way the ROUTER does. `wrap()` turns a throw into a 500, so a
    // handler that throws must be asserted as a 500 answer, not left to crash the
    // suite: a crashing test also "fails" and looks like proof, while telling you
    // nothing about what the endpoint actually returns to a caller. Mis-wiring the
    // engines threw exactly here, so this is the assertion that has to be legible.
    const callWrapped = async (fn, req) => {
      const res = mkRes();
      try { await fn(req || {}, res); } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
      }
      return res;
    };

    r = await callWrapped(H.canaryRoute, {
      body: { investor: 'ACME', rateSheetVersionId: 'v1', scenarios: [{ fico: 760 }] },
    });
    ok(r.code === 200,
      `RUN-1 a canary with a real program RUNS rather than 500ing (${r.code}: ${(r.body && r.body.error) || 'ok'})`);
    ok(r.body.runPersisted === true && r.body.runPersistError === null,
      'RUN-2 …and its run record reaches the series (a measurement nobody stored is one nobody can act on)');
    ok(runTable.length === 1, 'RUN-3 …as exactly one row');

    // THE KEY. `programLabel` collapses the loaded program to its code; handing the
    // OBJECT to run-store would store the literal string "[object Object]".
    ok(runTable[0].program === 'v1',
      'RUN-4 the series is keyed on the program CODE, never the stringified object');
    ok(!/\[object Object\]/.test(String(runTable[0].program)),
      'RUN-5 …so the key is one a reader can actually name');
    ok(runTable[0].investor === 'ACME' && runTable[0].scope === I.SCOPE,
      'RUN-6 …and scoped to the investor and tenant that were priced');

    // THE ROUND TRIP — the point of the whole change. The scoreboard reads with a
    // query string; the canary wrote with an object in hand. This passes only if
    // both resolved to the SAME label.
    dbStub.queries = [];
    r = await call(H.scoreboardRoute, { query: { investor: 'ACME', program: 'v1' } });
    ok(r.code === 200 && r.body.measured === true,
      'RUN-7 the scoreboard reads back the series the canary just wrote — the write key and the read key are ONE definition');
    ok(r.body.scoreboard.canaryAgreementRate != null,
      'RUN-8 …so the agreement rate is a MEASURED number, not the permanent null it was before');
    ok(r.body.runs === 1 && r.body.days === 1,
      'RUN-9 runs and days are counted separately (a day can hold several runs)');
    ok(r.body.dropped === 0,
      'RUN-10 `dropped` is the NUMBER zero — "nothing was dropped" must not collapse into the same null a failed read produces');
    {
      const q = dbStub.queries.find((x) => /FROM lt_ppe_shadow_run/.test(x.text));
      ok(q && q.params.includes('ACME') && q.params.includes('v1'),
        'RUN-11 …and the series is narrowed in SQL, not by reading every run in the tenant');
    }

    // TWO RUNS IN A DAY ARE TWO ROWS AND ONE DAY, and that split is the whole reason
    // the response reports both numbers. run-store stores `day_ms` VERBATIM — the row
    // key is the run's own instant, so a second canary minutes later is a second
    // measurement, not an overwrite — while `scoreboard.dailySeries` buckets those
    // rows to a calendar day and takes the freshest as that day's agreement rate. So
    // the clean-day streak can never be inflated by running the canary twice, and the
    // run count can never be deflated by reporting days as runs.
    r = await call(H.canaryRoute, {
      body: { investor: 'ACME', rateSheetVersionId: 'v1', scenarios: [{ fico: 700 }] },
    });
    ok(r.body.runPersisted === true && runTable.length === 2,
      'RUN-12 a second canary the same day is a second RUN row (day_ms is the instant, stored verbatim)');
    r = await call(H.scoreboardRoute, { query: { investor: 'ACME', program: 'v1' } });
    ok(r.body.runs === 2 && r.body.days === 1,
      'RUN-12b …but ONE day in the series — running the canary twice can never inflate the clean-day streak');

    // ASKING ABOUT A DIFFERENT PROGRAM MUST NOT ANSWER WITH THIS ONE. If the read
    // ever stopped honouring the program key, every investor would appear measured
    // the moment any one of their programs was.
    r = await call(H.scoreboardRoute, { query: { investor: 'ACME', program: 'other-sheet' } });
    ok(r.code === 200 && r.body.measured === false,
      'RUN-13 a program with no runs of its own reads as unmeasured (the series key is honoured)');
    ok(r.body.gate && r.body.gate.eligible === false,
      'RUN-14 …and therefore cannot pass the go-live gate');

    // THE TWO STORES FAIL INDEPENDENTLY, and are reported that way: "the findings
    // landed but the run did not" is a different problem from the reverse, and a
    // caller told only "persisted: true" would believe the series had grown.
    dbStub.next = (text, params) => {
      if (/lt_ppe_shadow_run/.test(text)) throw new Error('run store down');
      return withRuns(text, params);
    };
    r = await call(H.canaryRoute, {
      body: { investor: 'ACME', rateSheetVersionId: 'v1', scenarios: [{ fico: 760 }] },
    });
    ok(r.code === 200 && r.body.persisted === true,
      'RUN-15 a run-series failure does not take the findings ledger down with it');
    ok(r.body.runPersisted === false && /run store down/.test(r.body.runPersistError || ''),
      'RUN-16 …and it is reported separately, naming what actually failed');

    // A SERIES WE COULD NOT READ IS NOT AN INVESTOR WE DID NOT MEASURE. Both are
    // "not proven" for the gate — which is the safe verdict either way — but only
    // one of them is somebody's fault, and only one is fixable.
    dbStub.next = (text, params) => {
      if (/lt_ppe_shadow_run/.test(text)) throw new Error('series unreadable');
      return ledgerStub(text, params);
    };
    r = await call(H.scoreboardRoute, { query: { investor: 'ACME', program: 'v1' } });
    ok(r.code === 200 && r.body.measured === false && /series unreadable/.test(r.body.seriesError || ''),
      'RUN-17 an unreadable series says so — never silently reported as an unmeasured investor');
    ok(r.body.gate && r.body.gate.eligible === false,
      'RUN-18 …and still cannot pass the gate (fails closed)');
    ok(r.body.scoreboard && typeof r.body.scoreboard.openFindings === 'number',
      'RUN-19 …while the findings picture it CAN read is still shown');

    dbStub.next = ledgerStub;
  }

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
    // The rule loop's two operator actions are admin-gated exactly like deciding a finding.
    ok(/router\.post\('\/suggestions\/:id\/accept',\s*requirePpeAdmin/.test(src), 'ROUTER: accepting a suggestion is admin-gated');
    ok(/router\.post\('\/suggestions\/:id\/dismiss',\s*requirePpeAdmin/.test(src), 'ROUTER: dismissing a suggestion is admin-gated');
    ok(!/router\.get\('\/(suggestions|rules)'[^)]*requirePpeAdmin/.test(src), 'ROUTER: listing suggestions/rules is NOT admin-gated (you must see a proposal to judge it)');
    ok(/router\.post\('\/suggestions\/mine',\s*requirePpeAdmin/.test(src), 'ROUTER: mining suggestions is admin-gated (it hits the upstream and writes)');
  }

  // ---- the rule-loop handlers ----------------------------------------------
  // A non-numeric / zero suggestion id is refused BEFORE any DB work.
  {
    const r1 = await call(H.acceptSuggestionRoute, { params: { id: 'abc' }, body: {}, actor: { id: 'u1' } });
    ok(r1.code === 400, 'accept: a non-numeric suggestion id is refused (400)');
    const r2 = await call(H.dismissSuggestionRoute, { params: { id: '0' }, body: {}, actor: { id: 'u1' } });
    ok(r2.code === 400, 'dismiss: a zero suggestion id is refused (400)');
  }
  // Listing returns the store rows in a stable shape.
  {
    dbStub.next = () => ({ rows: [{ id: 1, investor_label: 'Deephaven', decline_reason: 'FICO - below 660', status: 'open' }] });
    const r = await call(H.listSuggestionsRoute, { query: {} });
    ok(r.code === 200 && r.body.ok && r.body.total === 1 && r.body.suggestions[0].decline_reason === 'FICO - below 660', 'list suggestions returns the store rows');
    const rr = await call(H.listRulesRoute, { query: {} });
    ok(rr.code === 200 && rr.body.ok && Array.isArray(rr.body.rules), 'list rules returns an array');
    dbStub.next = null;
  }
  // Mining: no body → 400; an already-parsed disqualified result → saves + summarizes.
  {
    const bad = await call(H.mineSuggestionsRoute, { body: {} });
    ok(bad.code === 400, 'mine with neither searchKey nor disqualified → 400');
    dbStub.next = () => ({ rows: [] }); // saveSuggestions upserts return nothing
    const parsed = { ready: true, lenderCount: 1, itemCount: 1, reasonCount: 1, lenders: [{ lender: 'L', investor: 'Deephaven', items: [{ program: 'DSCR 30', reasons: [{ rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' }] }] }] };
    const r = await call(H.mineSuggestionsRoute, { body: { disqualified: parsed } });
    ok(r.code === 200 && r.body.ok && r.body.suggestionCount === 1 && r.body.investorCount === 1, 'mine from a parsed disqualified result saves the suggestion + reports counts');
    dbStub.next = null;
  }

  // ---- the program list: the read that makes the db/574 scope writer reachable -------------------
  //
  // An UNSCOPED program's shadow comparison abstains — deliberately, because Lender Price answers with
  // every program it sells and ours prices one — and on a findings screen an abstention is
  // indistinguishable from two engines that agree. So the count of unscoped programs is the number
  // this route exists to publish, and it must be stated rather than left to be inferred from a list.
  {
    const row = (over) => Object.assign({
      id: 'p1', code: 'DHVN-DSCR', name: 'Deephaven DSCR', investor_id: 'i1',
      investor_code: 'DHVN', investor_name: 'Deephaven Mortgage',
      lp_investor: null, lp_lender: null, lp_program: null, lp_product: null, lp_program_like: null,
      lp_scope_set_at: null, lp_scope_set_by: null,
    }, over);

    dbStub.next = () => ({ rows: [row({}), row({ id: 'p2', code: 'DHVN-DSCR-HI', lp_program_like: '^dscr' })] });
    const r = await call(H.listProgramsRoute, { query: {} });
    ok(r.code === 200 && r.body.ok, 'PROG-1 the program list answers');
    ok(r.body.programs.length === 2, 'PROG-2 …with every program in the scope');
    ok(r.body.programs[0].id === 'p1' && r.body.programs[0].investorName === 'Deephaven Mortgage',
      'PROG-3 …each carrying the id the scope writer needs, and the investor it belongs to');
    ok(r.body.programs[0].lpScope === null, 'PROG-4 an unscoped program reports NO scope, not an empty one');
    ok(r.body.programs[1].lpScope && r.body.programs[1].lpScope.programLike === '^dscr',
      'PROG-5 …and a scoped one reports the pattern it is measured against');
    ok(typeof r.body.programs[1].describe === 'string' && r.body.programs[1].describe.length > 0,
      'PROG-6 …described in words, so a pattern is readable by whoever has to confirm it');
    ok(r.body.unscoped === 1, 'PROG-7 the unscoped programs are COUNTED');
    ok(typeof r.body.note === 'string' && /abstains/.test(r.body.note),
      'PROG-8 …and said out loud — an abstaining comparison reads exactly like agreement');

    // Nothing unscoped → no warning. A note that never goes away is a note nobody reads.
    dbStub.next = () => ({ rows: [row({ lp_program_like: '^dscr' })] });
    const clean = await call(H.listProgramsRoute, { query: {} });
    ok(clean.body.unscoped === 0 && clean.body.note === null, 'PROG-9 a fully scoped book raises no note');

    // No programs at all is not an abstention warning either — there is nothing to scope.
    dbStub.next = () => ({ rows: [] });
    const empty = await call(H.listProgramsRoute, { query: {} });
    ok(empty.code === 200 && empty.body.programs.length === 0 && empty.body.note === null,
      'PROG-10 an empty book answers empty, with no warning about programs that do not exist');
    dbStub.next = null;
  }

  // ---- the canary SCHEDULE, and the tick that honours it -----------------------------------------
  //
  // The decision module and its store were built, tested and callable by nothing, so the agreement
  // series only grew on the days somebody fired a canary by hand — and the promote gate reads that
  // series, where an unfed streak does not look unmeasured, it looks like a low score. What these
  // guard is the asymmetry the whole design turns on: a canary that does not fire is a visible gap,
  // while one that fires when it should not is N live vendor calls per tick, forever. So every
  // uncertainty must HOLD, with its reason.
  {
    const HOUR = 60 * 60 * 1000;
    const schedRow = (over) => Object.assign({
      scope: 'company', investor: 'DHVN', enabled: true, interval_ms: 24 * HOUR,
      battery_kind: 'scenarios', battery: [{ fico: 720 }], rate_sheet_version_id: null,
      concurrency: null, note: null, updated_by: 'someone@ys', updated_at: 1,
    }, over);

    // LISTING says what the RUNNER would decide, from the same function the tick uses.
    dbStub.next = () => ({ rows: [schedRow({}), schedRow({ investor: 'PAUSED', enabled: false })] });
    let r = await call(H.listSchedulesRoute, { query: {} });
    ok(r.code === 200 && r.body.schedules.length === 2, 'SCHED-1 the schedules list');
    ok(r.body.schedules[0].runnable === true, 'SCHED-2 …an enabled, valid one reads as runnable');
    const paused = r.body.schedules.find((x) => x.investor === 'PAUSED');
    ok(paused.runnable === false && paused.reason === 'disabled',
      'SCHED-3 …and a SAVED one that is paused says so — saved is not running');
    ok(r.body.runnable === 1, 'SCHED-4 the runnable ones are counted');

    // Nothing runnable is called out: it means the series only grows by hand.
    dbStub.next = () => ({ rows: [schedRow({ enabled: false })] });
    r = await call(H.listSchedulesRoute, { query: {} });
    ok(r.body.runnable === 0 && /only grows when somebody fires one by hand/.test(r.body.note || ''),
      'SCHED-5 …and with none runnable the list SAYS the series is only fed by hand');

    // SAVING refuses with the decision module's own wording, and records who armed it.
    dbStub.next = () => ({ rows: [] });
    r = await call(H.saveScheduleRoute, { body: { investor: 'DHVN', enabled: true, intervalMs: 1000, scenarios: [{ fico: 720 }] }, actor: { email: 'a@ys' } });
    ok(r.code === 400 && r.body.reason === 'interval_too_short',
      'SCHED-6 a cadence under the floor is refused — the floor guards a live vendor, not a preference');
    r = await call(H.saveScheduleRoute, { body: { investor: 'DHVN', enabled: true, intervalMs: 24 * HOUR }, actor: { email: 'a@ys' } });
    ok(r.code === 400 && /battery/i.test(String(r.body.error)),
      'SCHED-7 …and a schedule with NO battery is refused — a schedule never invents one');
    r = await call(H.saveScheduleRoute, { body: { investor: 'DHVN', enabled: true, intervalMs: 24 * HOUR, scenarios: [{ fico: 720 }] }, actor: null });
    ok(r.code === 400 && /who armed it/.test(String(r.body.error)),
      'SCHED-8 …and an anonymous request cannot arm a vendor loop');

    // THE TICK. With no program resolvable, every schedule HOLDS with the reason — it never runs.
    dbStub.next = (sql) => {
      if (/FROM lt_ppe_canary_schedule/.test(sql)) return { rows: [schedRow({})] };
      return { rows: [] }; // no rate-sheet version -> loadProgram finds none
    };
    // The upstream stub is SHARED with the canary tests above, so the count is snapshotted rather
    // than compared to zero — an assertion that reads a running total proves nothing about this call.
    const lpBefore = lpStub.calls.length;
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.code === 200 && r.body.ran.length === 0, 'TICK-1 with no program to price against, nothing runs');
    ok(r.body.held.length === 1 && r.body.held[0].reason === 'no_program',
      'TICK-2 …and the schedule is HELD with the reason, never silently skipped');
    ok(lpStub.calls.length === lpBefore, 'TICK-3 …and the live upstream was never called');

    // A PAUSED schedule holds with the module's own reason, and still never prices anything.
    dbStub.next = (sql) => (/FROM lt_ppe_canary_schedule/.test(sql) ? { rows: [schedRow({ enabled: false })] } : { rows: [] });
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.body.ran.length === 0 && r.body.held.some((h) => h.reason === 'no_program' || h.reason === 'disabled'),
      'TICK-4 a paused schedule never runs');

    // ---- the two cases that need a RESOLVABLE program, and they are the dangerous ones ----------
    // Both survived the first cut of these tests: with no program in the fixture every schedule was
    // held as `no_program` long before the code under test could be reached, so the assertions passed
    // while the rules they name were unenforced. A fixture that stops short of the branch it claims to
    // cover is the quietest way a suite can be decorative.
    const sheet = {
      version: { id: 'v1', label: 'Sheet A' },
      basePrices: [{ note_rate_milli_pct: 7125, lock_days: 30, product: 'DSCR30', price_milli: 102850 }],
    };
    const withProgram = (extra) => (text) => {
      if (/FROM lt_ppe_canary_schedule/.test(text)) return { rows: [schedRow({ rate_sheet_version_id: 'v1' })] };
      if (/lt_ppe_rate_sheet_version/.test(text)) return { rows: [sheet.version] };
      if (/lt_ppe_base_price/.test(text)) return { rows: sheet.basePrices };
      return extra(text);
    };

    // (a) AN UNREADABLE RUN SERIES MUST NEVER READ AS "NEVER RUN". The last-run stamp is what the
    //     cadence is measured from, so a failed read treated as null says "most overdue thing there
    //     is" and the schedule fires on EVERY tick, forever, against a paid vendor. It holds instead.
    const lpBeforeSeries = lpStub.calls.length;
    dbStub.next = withProgram((text) => {
      if (/FROM lt_ppe_shadow_run/.test(text)) throw new Error('series read failed');
      return { rows: [] };
    });
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.body.ran.length === 0, 'TICK-7 an unreadable run series never runs a battery');
    ok(r.body.held.some((h) => h.reason === 'series_unreadable'),
      'TICK-8 …it is HELD as unreadable — read as "never run" it would fire on every tick forever');
    ok(lpStub.calls.length === lpBeforeSeries, 'TICK-9 …and the vendor was not called');

    // (b) A SCHEDULE THAT IS SIMPLY NOT DUE YET is held with the DECISION MODULE's own reason. A tick
    //     that reports only what it ran reads as healthy while measuring nothing.
    const lpBeforeDue = lpStub.calls.length;
    dbStub.next = withProgram((text) => {
      // A run a minute ago on a daily cadence: nothing to do, and the tick must say so.
      if (/FROM lt_ppe_shadow_run/.test(text)) return { rows: [{ day_ms: String(Date.now() - 60000), agreement_rate: '1', finding_keys: [], summary: {} }] };
      return { rows: [] };
    });
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.body.ran.length === 0, 'TICK-10 a schedule that ran a minute ago is not due on a daily cadence');
    ok(r.body.held.length === 1 && typeof r.body.held[0].reason === 'string' && r.body.held[0].reason !== 'no_program',
      'TICK-11 …and it is reported in `held` with the decision module\'s own reason, not omitted');
    ok(r.body.held[0].dueAt != null, 'TICK-12 …carrying WHEN it next comes due, so a quiet tick is explainable');
    ok(lpStub.calls.length === lpBeforeDue, 'TICK-13 …and again nothing was priced');

    // No schedules at all is an honest empty answer, not an error.
    dbStub.next = () => ({ rows: [] });
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.code === 200 && r.body.schedules === 0 && r.body.ran.length === 0 && r.body.held.length === 0,
      'TICK-5 an empty schedule table ticks to nothing');
    ok(r.body.maxPerTick === 1, 'TICK-6 …and the default cap is ONE battery per tick, because each is a live vendor run');
    dbStub.next = null;
  }

  // ---- the battery rules are ONE definition, shared by the button and the schedule ---------------
  {
    const big = { scenarios: new Array(I.MAX_CANARY_SCENARIOS + 1).fill({ fico: 720 }) };
    const refused = I.resolveBattery(big);
    ok(refused.refused && refused.refused.status === 422 && refused.refused.body.reason === 'battery_too_large',
      'BATT-1 an over-size battery is REFUSED, never thinned — a thinned one measures scenarios nobody chose');
    ok(I.resolveBattery({}).refused.body.reason === 'no_battery', 'BATT-2 no battery at all is refused');
    ok(I.resolveBattery({ scenarios: [] }).refused.body.reason === 'empty_battery', 'BATT-3 …and an empty one is its own reason');
    ok(I.resolveBattery({ scenarios: [{ fico: 720 }] }).scenarios.length === 1, 'BATT-4 a real battery passes through untouched');
    ok(I.resolveBattery({ matrix: 'nope' }).refused.body.reason === 'no_battery', 'BATT-5 a matrix that is not an object is refused, never coerced');
  }

  accessStub.mayManagePeople = realMayManage;
  console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
