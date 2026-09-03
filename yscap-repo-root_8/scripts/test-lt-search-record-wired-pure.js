'use strict';
/**
 * LONG-TERM — THE SIDE-BY-SIDE REGISTER IS ACTUALLY WRITTEN, BY BOTH DOORS.
 *
 * ── WHY THIS SUITE EXISTS, AND IT IS THE MOST IMPORTANT LINE IN IT ─────────
 * The owner, 2026-09-03, on why the side-by-side list was empty: *"it's not
 * actually connected."* The fix was to record every search on both doors. The
 * GUARDS written with that fix — H3, H3b, H3d and H3e in
 * `test-lt-investor-sources-pure.js` — are TEXT-PRESENCE REGEXES over the route's
 * source, and the pre-merge audit of 2026-09-03 DEFEATED ALL THREE with a
 * one-token mutation:
 *
 *     void 0 && searchRecord.recordOne(board, { … })
 *
 * The text is all still there, the call is dead, the register goes silent, and the
 * suite reported everything passing — silently restoring the exact defect the
 * whole `search-record` module was written for. H3e's own comment says it exists
 * because "a guard that only watched the bands door is what let that door stay
 * silent"; it could not hold that property, because a regex over a caller can only
 * ever pin the SPELLING of a call, never that the call HAPPENS.
 *
 * So this RUNS BOTH DOORS with the recorder stubbed and counts what it received.
 * `priceBrackets` was added to the route's exported `handlers` for that purpose —
 * a one-word change with no behaviour of its own, and the only thing that makes the
 * bands door's own flush provable.
 *
 * PURE: every vendor, board and bracket dependency is stubbed in the require cache
 * before the route is loaded. No network, no database, no browser.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/* ── The spies, installed BEFORE the route is required ──────────────────────
   The route captures its dependencies at require time (`const searchRecord =
   require(...)` at the top of the file), so a cache entry replaced afterwards is
   never seen — the first cut of this harness stubbed `bracket-run` too late and
   the bands door quietly ran the real one. Everything goes in first. */
const calls = { recordOne: [], flush: [], observe: 0, later: 0 };
const stub = (rel, exports) => {
  const id = require.resolve(path.join(ROOT, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

/* `later` RUNS THE WORK INLINE HERE. In production it defers it off the response
   path (the recording can reach an outbound email — measured 161ms vs 3,183ms),
   and deferring in a test would mean asserting on a promise nobody awaited. What
   is asserted is that `later` was ASKED, which is the production property, and
   that the work it was given actually calls the recorder. */
stub('src/longterm/pricing/search-record.js', {
  collector: () => ({
    observe: () => { calls.observe += 1; },
    flush: (o) => { calls.flush.push(o); },
  }),
  recordOne: (b, o) => { calls.recordOne.push({ board: b, opts: o }); },
  later: (fn) => { calls.later += 1; try { fn(); } catch (_) { /* production swallows too */ } },
  settled: async () => {},
});

/* The shape BOTH doors read off a board. `parsed` is what the bands door renders each
   band from and what it reads `pricedAt` off; `sightings` is what the recorder is handed.
   A stub thinner than this makes the door throw, which would be a fact about the fixture
   rather than about the product. */
const BOARD = {
  ok: true,
  source: 'both',
  programs: [],
  investors: [],
  parsed: { programs: [], pricedAt: '2026-09-03T00:00:00.000Z' },
  sightings: { lenderprice: { keys: ['nqm'] }, loannex: { keys: [] } },
  request: {},
  searchKey: 'sk',
  provenance: null,
  missing: [],
  sources: { lenderprice: true, loannex: true },
  investorPairing: null,
};
stub('src/longterm/pricing/general-board.js', {
  loadConfig: async () => ({
    routes: {}, custom: new Map(), links: {}, heldSetting: 0.25,
    extraFor: () => 0, settings: {}, wantLoanNex: true,
  }),
  boardForScenario: async () => BOARD,
  pickerRoster: () => [],
});
/* The bands door's own runner. It hands each band back through `priceOne`, which is
   where the route observes — so a stub that never calls it would prove nothing about
   the union, and this one calls it twice on purpose. */
const bracket = { fail: false };
stub('src/longterm/pricing/bracket-run.js', {
  priceByBracket: async (figures, runSearch) => {
    if (typeof runSearch === 'function') { await runSearch(1.25); await runSearch(1.10); }
    return bracket.fail
      ? { ok: false, error: 'lt_bracket_figures_incomplete' }
      : { ok: true, bands: [], rows: [], searchKey: 'k' };
  },
  quotesFrom: () => [],
  mapLimited: async () => [],
  CONCURRENCY: 1,
});

const route = require(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'));

const mkRes = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const SCENARIO = {
  value: 500000, loan: 375000, fico: 760, ltv: 75, dscr: 1.25,
  state: 'NJ', zip: '07728', county: 'Monmouth', purpose: 'purchase',
  propertyType: 'sfr', termYears: 30,
};
const reset = () => { calls.recordOne.length = 0; calls.flush.length = 0; calls.observe = 0; calls.later = 0; };

(async () => {
  console.log('\n── A. THE IMMEDIATE BOARD RECORDS — the door the owner reported ──');
  {
    reset();
    const res = mkRes();
    await route.handlers.price({ body: { ...SCENARIO, full: true }, actor: { id: 'staff-1' } }, res);
    ok(res.body && res.body.ok === true,
      `A0 CONTROL: the door answered a board (${res.code || 200} ${res.body && res.body.ok})`);
    ok(calls.recordOne.length === 1,
      `A1 THE ONE THAT MATTERS: it recorded the search — exactly once (${calls.recordOne.length})`);
    ok(calls.later === 1,
      `A2 …and asked for it OFF the response path, so a first-miss email never delays the officer's board (${calls.later})`);
    const got = calls.recordOne[0] || {};
    ok(got.board === BOARD,
      'A3 …handing over THE BOARD it just answered, not a re-derived one');
    ok(got.opts && got.opts.staffId === 'staff-1' && got.opts.scenario,
      'A4 …with who searched and what they searched for, which is what makes the review actionable');
    ok(calls.flush.length === 0,
      'A5 …and it does NOT use the bands collector — one door, one recording, never both');
  }

  console.log('\n── B. THE BANDS DOOR RECORDS TOO, ONCE, AFTER THE WHOLE SEARCH ──');
  {
    reset();
    const res = mkRes();
    await route.handlers.priceBrackets({ body: { ...SCENARIO }, actor: { id: 'staff-2' } }, res);
    ok(res.body && res.body.ok === true,
      `B0 CONTROL: the door answered (${res.code || 200} ${res.body && (res.body.ok || res.body.error)})`);
    ok(calls.observe === 2,
      `B1 every band is OBSERVED — an investor that answers in one band is carried (${calls.observe} of 2)`);
    ok(calls.flush.length === 1,
      `B2 …and flushed EXACTLY ONCE, after the whole search — never per band, whose silence proves nothing (${calls.flush.length})`);
    ok(calls.later === 1,
      `B3 …off the response path, same as the immediate door (${calls.later})`);
    const f = calls.flush[0] || {};
    ok(f.staffId === 'staff-2' && f.scenario,
      'B4 …carrying who searched and what for');
    ok(calls.recordOne.length === 0,
      'B5 …and it does NOT also call the single-board recorder — one search, one recording');
  }

  console.log('\n── C. A REFUSED SEARCH IS STILL A SEARCH ──');
  {
    /* A band run that fails is still evidence about the SHEETS — the officer asked,
       and whether a sheet answered is exactly what the register is for. The flush sits
       ABOVE the `!out.ok` branch for that reason. */
    reset();
    bracket.fail = true;
    const res = mkRes();
    await route.handlers.priceBrackets({ body: { ...SCENARIO }, actor: { id: 'staff-3' } }, res);
    bracket.fail = false;
    ok(res.code === 422 && res.body && res.body.error === 'lt_bracket_figures_incomplete',
      `C0 CONTROL: the bracketing really did refuse AFTER the sheets were asked (${res.code} ${res.body && res.body.error})`);
    ok(calls.observe === 2,
      `C0b CONTROL: …and the sheets really were asked (${calls.observe} bands observed)`);
    ok(calls.flush.length === 1,
      `C1 …so the search is recorded anyway — a refusal downstream is not evidence the sheets were never asked (${calls.flush.length})`);

    /* The OTHER kind of refusal is the opposite case and must behave the opposite way: a
       scenario refused by validation never reaches a rate sheet, so there is no search to
       record and recording one would put a phantom row on the review screen. */
    reset();
    const res2 = mkRes();
    await route.handlers.priceBrackets({ body: { loan: 375000 }, actor: { id: 'staff-4' } }, res2);
    ok(res2.code === 422 && calls.observe === 0,
      `C2 CONTROL: a scenario refused by validation asks no sheet (${res2.code}, ${calls.observe} observed)`);
    ok(calls.flush.length === 0,
      `C3 …and records nothing — a search that never happened is not a search (${calls.flush.length})`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((e) => { console.log('THREW:', (e && e.message) || e); process.exit(1); });
