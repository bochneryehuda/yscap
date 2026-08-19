#!/usr/bin/env node
'use strict';
/**
 * /api/lt/ppe/* — the PPE HTTP surface (pure: no network, no database).
 *
 * The engine underneath this route was built, green and UNREACHABLE. What this
 * suite guards is not the engine (the rest of the `test-lt-ppe-*` family does that
 * — a count is deliberately not quoted here; this line used to say "27 suites" and
 * was stale within the month) but the ROUTE's own promises, each of which is a way
 * the shadow model could be broken from above:
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

// ---------------------------------------------------------------------------
// THE LENDER PRICE STUB — ONLY THE NETWORK IS FAKE
// ---------------------------------------------------------------------------
//
// A STUB THAT ONLY AGREES WITH THE CODE IS DECORATION, and this one used to be exactly that. It
// answered `price()` with `{ rungs:[{rate, price}] }` — a shape the REAL client has never produced.
// The real `price()` resolves with the VENDOR ENVELOPE `{ ok, raw, request, searchKey, provenance }`
// and the ladder only exists after `parse(raw)` and a normalizer. So the canary's `theirs` leg was
// wired to the raw envelope in production (every scenario `incomparable`, `agreementRate` NULL, run
// persisted, HTTP 200 — a green canary that compared nothing) while this suite stayed green, because
// the stub handed the comparator the shape the mis-wiring needed. Worse, it ran BACKWARDS: correcting
// the wiring to parse the capture would have made this suite RED, because the stub had no `parse`.
//
// So the stub now fakes ONLY the network call. `price()` returns a real envelope carrying a real
// searchRaw-shaped body, and every reading function — `parse`, `parseFull`, `parseDisqualified`,
// `hasDisqualifyData` — is the REAL client's, taken from the module itself. A wiring that skips the
// parse now gets an envelope the comparator cannot read, and says so.
const realLp = require('../src/longterm/lenderprice/client');

// A searchRaw body in the shape the real parser walks (results -> qualified tree -> lender -> leafs).
// Prices are POINTS and rates are PERCENT, exactly as Lender Price states them; `adjustedPoints` is
// what the parser derives the price from (price = 100 - points).
function lpLeaf(rate, price) {
  return {
    rate, adjustedPoints: Math.round((100 - price) * 1000) / 1000,
    basePoints: 0, adjustmentPoints: 0, apr: rate + 0.2,
    programName: 'DSCR  >= 1.25  - 30 Yr Fixed', productName: 'DSCR30', companyName: 'Deephaven',
    dayLock: 30, term: 360, loanAmount: 400000,
    ratePeriod: { validAsOf: '2026-08-01', expired: false, name: 'Sheet A', id: 'rp1' },
  };
}
function lpRaw(rungs, programName) {
  return {
    search: { date: '2026-08-17T12:00:00Z' },
    results: {
      lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'Deephaven', shortName: 'DHVN' }] },
      qualifiedNonQMData: {
        childs: [{
          type: 'CriteriaFromLineResultKey', keyLabel: programName || 'DSCR  >= 1.25  - 30 Yr Fixed',
          childs: [{
            type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"',
            leafs: rungs.map(([rate, price]) => lpLeaf(rate, price)),
          }],
        }],
      },
    },
  };
}
// The sheet the route's own fixture publishes is one rung at 7.125% / 102.850, so the stub's default
// capture states the SAME deal — which is what makes a correctly-wired canary agree and a
// wrongly-wired one incomparable, rather than both being noise.
const LP_DEFAULT_RAW = lpRaw([[7.125, 102.85]]);

const lpStub = {
  ...realLp,                 // parse / parseFull / parseDisqualified / hasDisqualifyData — the REAL ones
  calls: [],
  raw: LP_DEFAULT_RAW,
  ok: true,
  throwWith: null,
  _internals: { lpRaw, lpLeaf },
};
lpStub.price = async (sc) => {
  lpStub.calls.push(sc);
  if (lpStub.throwWith) throw new Error(lpStub.throwWith);
  // The real client reports a refusal IN BAND rather than throwing — a leg that treats an ok:false as
  // an answer must fail here, not in production.
  if (!lpStub.ok) return { ok: false, reason: 'lp_scenario_invalid', message: 'stubbed refusal' };
  return { ok: true, raw: lpStub.raw, request: { url: 'x', body: {} }, searchKey: 'k', provenance: {}, recovered: false };
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
// 36 since the canary DRIVER's operator read (`GET /canary/driver`) — "is anything actually firing
// the daily schedules, and what did it last do?", which had no answer at all while nothing drove the
// tick.
// 33 since the agreement HARNESS became reachable — the gate's missing measuring half, so a sheet
// can be made publishable by being MEASURED rather than only by the recorded override.
// 32 was the ONBOARDING + RATE-SHEET CONSOLE — create an investor, create a
// program, open a draft version, load its grid / LLPAs / price limits, read it back, read the
// agreement gate, and publish. Before them EVERY rate-sheet writer in ppe/store.js had zero callers
// anywhere in src/, so an investor could not be onboarded through the product at all and the
// ≥200-scenario agreement gate guarded a door that did not exist. (23 was the canary schedule.)
// This count is a deliberate guard: adding a handler without exporting/testing it should FAIL here, so
// bump it in the same commit that adds one — never delete the assertion to make a build green.
// 36 added the canary DRIVER read (`GET /ppe/canary/driver`) — the in-process tick's own status door.
// 41 since the rule-authoring service gained its READ + DRAFT doors — five handlers
// (list/create/read/render/discard a draft). There is deliberately NO sixth for publishing: that door
// changes a priced number and who may press it is an open owner question (§2.51), so this count is
// also the guard that would go red if somebody quietly added one.
// 44 with the SETTINGS WRITE DOOR — save, clear, and the audit read. Before them nothing in src/
// called store.setSetting/clearSetting and the router published the settings READ with no write
// route at all, so every parity tolerance, the rounding, the price floor and the per-investor
// margin could only be changed by editing the database by hand.
// 45 adds currentRateSheetRoute — "which published version prices this program right now", the read
// behind the pricing screen's chooser and the first caller in src/ of the in-effect predicate.
// 50 with the compensation read (D18/E9) — who makes what on a file, once the owner's two answers
// unblocked it. It prices nothing: whether the company's quarter point is the same one the pipeline
// already subtracts is still open, so the door reports the stack and never moves a number.
// 49 with the DISQUALIFIER REVIEW's three doors (§2.58, owner-instructed): the run that asks Lender
// Price why it refused and lines it up against our sheet, the queue that shows the questions, and the
// door that records what a person concluded. None of them publishes anything — that stays the super
// admin's separate act — which is exactly why they are admin-gated rather than super-gated.
// 46 with the PUBLISH door — the one route on this router that changes what a borrower is quoted. It
// was deliberately absent while the authority was an open question; the owner answered it on
// 2026-08-18 ("all in the super admin") and the guard below is now about its GATE, not its absence.
// 52 with the CUTOVER DOOR (§11 / P10) — the read and the decision. `cutover-ledger.js` and
// `cutover-store.js` had been built, tested and reachable by nothing, waiting in LT-UNREACHED.md on
// one open question: who may take an investor live. The owner answered it ("all in the super admin"),
// so the write door is super-gated like the publish; the read is admin-gated like every other
// governance surface here.
// 53 with the FREE PRE-FLIGHT (§2.75) — what the paid battery would find on OUR side, for nothing.
// Every guard the paid run had was about the vendor or the inputs; a sheet whose own leg priced nothing
// still paid for ~299 calls. This door answers the free half before anyone presses the paid button, and
// the paid route asks the same module for itself. It is a GET, admin-gated like every other read here:
// it changes nothing and makes no vendor call.
ok(Object.keys(H).length === 53, `all 53 handlers are exported for testing (${Object.keys(H).length})`);
// A COUNT ALONE IS NOT ENOUGH: it stays satisfied if a handler is renamed, or if one is dropped in the
// same commit another is added. Naming them is what makes the guard bite on either.
for (const name of ['rateSheetPreflightRoute', 'cutoverStateRoute', 'cutoverDecisionRoute',
  'listSuggestionsRoute', 'acceptSuggestionRoute', 'dismissSuggestionRoute',
  'listRulesRoute', 'mineSuggestionsRoute', 'ruleCoverageRoute',
  'getProgramLpScopeRoute', 'setProgramLpScopeRoute', 'parityCellsRoute', 'listProgramsRoute',
  'listSchedulesRoute', 'saveScheduleRoute', 'deleteScheduleRoute', 'canaryTickRoute',
  'canaryDriverRoute',
  'createInvestorRoute', 'createProgramRoute', 'createRateSheetRoute', 'getRateSheetRoute',
  'setBasePricesRoute', 'setAdjustmentsRoute', 'setPriceLimitRoute', 'agreementRoute',
  'rateSheetCoverageRoute', 'rateSheetDiffRoute', 'runAgreementRoute', 'publishRateSheetRoute',
  'listRuleDraftsRoute', 'createRuleDraftRoute', 'getRuleDraftRoute', 'renderRuleDraftRoute',
  'discardRuleDraftRoute', 'publishRuleDraftRoute',
  'saveSettingsRoute', 'clearSettingsRoute', 'settingsAuditRoute',
  'currentRateSheetRoute']) {
  ok(typeof H[name] === 'function', `the ${name} handler is exported by name`);
}

// ⛔ AND ITS GATE, asserted rather than assumed. A draft becomes a rule that prices real loans through
// `rule-authoring-store.publishDraft`. This guard used to assert the door did NOT EXIST, because who
// may publish was an open owner question and wiring it to `requirePpeAdmin` — the gate on every
// neighbouring route — would have answered that question by convenience. The owner answered it on
// 2026-08-18: *"all in the super admin."* So the guard asserts the ANSWER, which is strictly stronger
// than asserting the absence was: the door exists, exactly one of them does, and it is the ONLY route
// on this router that does not take the ordinary admin gate.
//
// WHY THAT DISTINCTION IS LOAD-BEARING RATHER THAN PEDANTIC: `requirePpeAdmin` asks
// `access.mayManagePeople`, whose role list a buyer can WIDEN in settings. `requirePpeSuperAdmin`
// reads `access.ADMIN_FLOOR_ROLE`, which is a floor and is added back whatever the setting says. If
// publish were quietly moved onto the admin gate, a settings change would become a way to grant the
// authority to change a borrower's price — and the handler count above could never see it.
{
  const publishers = Object.keys(H).filter((k) => /RuleDraft/.test(k) && /publish/i.test(k));
  ok(publishers.length === 1 && publishers[0] === 'publishRuleDraftRoute',
    `exactly ONE handler publishes a rule draft (${publishers.join(', ') || 'none'})`);

  const raw = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/publishDraft/.test(src), '…and the route file does call publishDraft — the door is real, not a stub');

  // The REGISTRATION, read out of the source: the count and the name say nothing about which gate the
  // route was mounted behind, and the gate is the whole of the owner's answer.
  const reg = src.match(/router\.post\(\s*'\/rule-drafts\/:id\/publish'\s*,\s*(\w+)/);
  ok(!!reg, 'the publish route is registered at POST /rule-drafts/:id/publish');
  if (reg) ok(reg[1] === 'requirePpeSuperAdmin',
    `…behind requirePpeSuperAdmin, never the ordinary admin gate (found ${reg[1]})`);

  // …and that gate must genuinely read the role FLOOR rather than the widenable admin list, or the
  // name above would be the only thing that changed. The check is written ONCE now and the refusal
  // SENTENCE is its parameter (there is more than one act the owner reserved to a super admin, and a
  // refusal naming the wrong one sends somebody hunting a rule they never touched), so what is read
  // here is the factory — and that both super-gates are built from it rather than hand-rolled beside
  // it, which is how a second copy would quietly stop asking about the floor.
  const gate = raw.match(/function ppeSuperAdminFor\([\s\S]*?\n}/);
  ok(!!gate && /ADMIN_FLOOR_ROLE/.test(gate[0]) && !/mayManagePeople/.test(gate[0]),
    'the super-admin gate reads the role FLOOR, not the list a settings change can widen');
  ok(/const requirePpeSuperAdmin = ppeSuperAdminFor\(/.test(raw)
    && /const requirePpeCutoverAuthority = ppeSuperAdminFor\(/.test(raw),
    '…and every super-gated door is built from that ONE check, never a second copy of it');

  // NOTHING ELSE may take that gate by accident: it exists for the one door that moves a price.
  // Counted on the REGISTRATIONS, not on every mention: the gate is also defined and exported, and a
  // mention count would move for reasons that have nothing to do with which routes take it.
  const superGated = [...src.matchAll(/router\.\w+\([^)]*requirePpeSuperAdmin/g)];
  ok(superGated.length === 1,
    `exactly ONE route takes the super-admin gate — it exists for the one door that moves a price (${superGated.length})`);
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
  // 6) investors — each one's REAL lifecycle, read rather than asserted
  //
  // This block used to assert the opposite: `perInvestor:false` and a flat `mode:'shadow'`, with the
  // response body carrying the sentence "every investor is in shadow and Lender Price is
  // authoritative". That was honest while no promote door existed, and became a lie on a screen the
  // moment one did (§11 / P10) — a promotion is one click and the sentence would not have moved. The
  // shape is now the honest one for a router that HAS a lifecycle: the mode is read per investor out
  // of the ledger, and an empty ledger reads as DRAFT rather than as an invented state.
  // -------------------------------------------------------------------------
  // The stub answers PER QUERY here, which it must: this route now runs two different reads (the
  // investor list, then that investor's lifecycle history), and a stub returning the same rows to both
  // would feed investor rows into the ledger mapper and prove nothing about either.
  dbStub.next = (text) => (/lt_ppe_cutover_ledger/.test(text)
    ? { rows: [] }
    : { rows: [{ id: 'i1', code: 'ACME', name: 'Acme', active: true }] });
  r = await call(H.listInvestorsRoute);
  ok(r.code === 200 && r.body.investors.length === 1, 'investors: lists what is configured');
  ok(r.body.lifecycle && r.body.lifecycle.perInvestor === true && r.body.lifecycle.mode === undefined,
    'investors: no longer claims ONE mode for everybody — each investor carries its own');
  ok(r.body.investors[0].mode === 'draft',
    'investors: …read out of the ledger, and an investor nobody has decided about is DRAFT, not an invented "shadow"');
  ok(!/every investor is in shadow/.test((r.body.lifecycle || {}).note || ''),
    'investors: …and the response body no longer ships a sentence a single promotion would falsify');

  // -------------------------------------------------------------------------
  // 7) quote — LP answers; a missing program costs the SHADOW, not the quote
  // -------------------------------------------------------------------------
  r = await call(H.quoteRoute, { body: {} });
  ok(r.code === 400, 'quote: refuses a request with no scenario');

  // A REAL LENDER PRICE SCENARIO, and that is the point of the change (§2.123). This used to be
  // `{ fico: 760 }` — a bag so minimal that an LP scenario and a bag of engine facts look identical,
  // which is exactly how the door's two engines came to be fed opposite shapes without any suite
  // noticing. `/quote` posts this object to Lender Price, so it must be a Lender Price scenario, and
  // the route now says so at the door with Lender Price's own validator.
  const LP_SCENARIO = {
    purpose: 'Purchase', value: 500000, loan: 250000, fico: 760, dscr: 1.25,
    state: 'NY', zip: '11211', countyFps: '36047', prepayMonths: 60,
  };

  r = await call(H.quoteRoute, { body: { scenario: { fico: 760, ltv: 72500, loan_amount: 400000 } } });
  ok(r.code === 422 && r.body.reason,
    'quote: refuses a bag of ENGINE FACTS — this door takes a Lender Price scenario (§2.123)');
  ok(r.code === 422 && /POST \/breakdown/.test(String(r.body.contract || '')),
    'quote: …and names the door that DOES take engine facts, so the caller is never left guessing');

  lpStub.calls = [];
  dbStub.queries = [];
  r = await call(H.quoteRoute, { body: { scenario: LP_SCENARIO } });
  // LP's answer is passed through UNTOUCHED — the vendor envelope, which is what a caller of /quote
  // has always received. Asserted on the envelope's own shape rather than on object identity, because
  // the stub now builds a fresh one per call exactly as the real client does.
  ok(r.code === 200 && r.body.authoritative === 'lp'
     && r.body.answer && r.body.answer.ok === true && r.body.answer.raw === lpStub.raw,
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
      version: { id: 'v1', label: 'Sheet A', program_id: 'p1' },
      basePrices: [{ note_rate_milli_pct: 7125, lock_days: 30, product: 'DSCR30', price_milli: 102850 }],
      adjustments: [], priceLimit: null,
      // THE OWNING PROGRAM ROW, CARRYING THE LENDER PRICE SCOPE (db/574). A real sheet has one, and a
      // canary is refused without one: Lender Price answers a single request with EVERY program it
      // sells (17 on the live Deephaven capture) while this sheet prices ONE, so an unscoped ladder is
      // a merge of somebody else's catalogue. A fixture with no scope would have been a fixture that
      // can never exercise a canary at all.
      program: { id: 'p1', lp_program_like: 'DSCR .* 30 Yr Fixed' },
    };
    const withRuns = (text, params) => {
      if (/FROM lt_ppe_program/.test(text)) return { rows: [sheet.program] };
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
    // READING STAYS OPEN — an engineer must be able to see why a scenario disagreed without being an
    // administrator. This used to be written as "no gated post/put/delete on these PATHS", which read
    // as a rule about the read surface but was really a rule about path names: the moment `POST
    // /investors` existed (creating an investor, which SHOULD be gated) it failed, on a route that has
    // nothing to do with reading. It now names the READ registrations and asserts each is ungated, so
    // it bites on exactly what its label claims and cannot be tripped by an unrelated write.
    const READ_OPEN = [
      ["get", "/health"], ["get", "/settings"], ["get", "/investors"], ["get", "/findings"],
      ["get", "/scoreboard"], ["get", "/suggestions"], ["get", "/rules"], ["get", "/parity-cells"],
      ["get", "/programs"], ["get", "/canary/schedules"], ["post", "/quote"], ["post", "/breakdown"],
    ];
    for (const [method, p] of READ_OPEN) {
      const re = new RegExp(`router\\.${method}\\('${p.replace(/\//g, '\\/')}',\\s*wrap\\(`);
      ok(re.test(src), `ROUTER: ${method.toUpperCase()} ${p} is NOT admin-gated (reading stays open)`);
    }
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
    //
    // THE LEASE IS PART OF THIS DOOR NOW, and the stub has to answer for it. This door used to call
    // the tick directly, so two administrators pressing at the same moment both priced the whole
    // battery, live, twice — while the durable lease built to prevent exactly that protected only the
    // scheduled job. Granting the lease here is what lets the assertions below still be about the
    // TICK; the lease being genuinely exclusive is proven against a real Postgres in
    // `test-lt-ppe-canary-driver.js`, which is where a lock can actually be raced.
    const withLease = (inner) => (sql, params) => (
      /lt_ppe_canary_driver_state/.test(sql) ? { rows: [{ holder: (params && params[1]) || 'x' }] } : inner(sql, params)
    );
    dbStub.next = withLease((sql) => {
      if (/FROM lt_ppe_canary_schedule/.test(sql)) return { rows: [schedRow({})] };
      return { rows: [] }; // no rate-sheet version -> loadProgram finds none
    });
    // The upstream stub is SHARED with the canary tests above, so the count is snapshotted rather
    // than compared to zero — an assertion that reads a running total proves nothing about this call.
    const lpBefore = lpStub.calls.length;
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.code === 200 && r.body.ran.length === 0, 'TICK-1 with no program to price against, nothing runs');
    ok(r.body.held.length === 1 && r.body.held[0].reason === 'no_program',
      'TICK-2 …and the schedule is HELD with the reason, never silently skipped');
    ok(lpStub.calls.length === lpBefore, 'TICK-3 …and the live upstream was never called');

    // A PAUSED schedule holds with the module's own reason, and still never prices anything.
    dbStub.next = withLease((sql) => (/FROM lt_ppe_canary_schedule/.test(sql) ? { rows: [schedRow({ enabled: false })] } : { rows: [] }));
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
    const withProgram = (extra) => (text, params) => {
      // The tick door takes the lease first (see the TICK block above); granting it keeps every
      // assertion below about the TICK rather than about the lock.
      if (/lt_ppe_canary_driver_state/.test(text)) return { rows: [{ holder: (params && params[1]) || 'x' }] };
      if (/FROM lt_ppe_canary_schedule/.test(text)) return { rows: [schedRow({ rate_sheet_version_id: 'v1' })] };
      if (/lt_ppe_rate_sheet_version/.test(text)) return { rows: [sheet.version] };
      if (/lt_ppe_base_price/.test(text)) return { rows: sheet.basePrices };
      return extra(text, params);
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

    // No schedules at all is an honest empty answer, not an error. (The lease is still granted — the
    // door takes it before it looks at anything, so refusing it here would test the lock, not this.)
    dbStub.next = withLease(() => ({ rows: [] }));
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.code === 200 && r.body.schedules === 0 && r.body.ran.length === 0 && r.body.held.length === 0,
      'TICK-5 an empty schedule table ticks to nothing');
    ok(r.body.maxPerTick === 1, 'TICK-6 …and the default cap is ONE battery per tick, because each is a live vendor run');

    // ---- THE LOCK IS ON THIS DOOR, and that is new -----------------------------------------------
    // This door used to call the tick directly, so the durable lease that exists precisely to stop two
    // callers paying for one battery guarded the scheduled job and NOT the hand-fired run: two
    // administrators pressing at the same moment each priced the whole battery, live. The lock being
    // genuinely exclusive is raced against a real Postgres in `test-lt-ppe-canary-driver.js`; what is
    // proven here is that this door is behind it at all.
    const lpBeforeLock = lpStub.calls.length;
    dbStub.next = (sql) => (/lt_ppe_canary_driver_state/.test(sql)
      ? { rows: [] }                                   // somebody else holds it
      : { rows: [schedRow({ rate_sheet_version_id: 'v1' })] });
    r = await call(H.canaryTickRoute, { body: {} });
    ok(r.code === 409 && r.body.outcome === 'lease_held',
      `TICK-14 a tick somebody else is already running is turned away, not run twice (${r.code} ${r.body.outcome})`);
    ok(lpStub.calls.length === lpBeforeLock, 'TICK-15 …and the vendor was not called a second time');
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
