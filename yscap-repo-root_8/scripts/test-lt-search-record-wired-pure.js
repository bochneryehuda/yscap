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
const calls = { recordOne: [], flush: [], observe: 0, observed: [], later: 0, collector: [] };
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
  /* ⛔ AND `collector`'s OWN ARGUMENT COUNT IS RECORDED TOO — the hole A3a closes on
     `recordOne`, still open one line up on the OTHER door until the pre-merge audit of
     2026-09-03 found it. `searchRecord.collector({ recordSightings: async () => ({ok:true}),
     recordMisses: async () => ({ok:true}) })` at the bands door turns every band's sighting
     AND miss recording into nothing in production — and this stub's `collector: () => ({…})`
     discarded its own argument, so all 24 checks stayed green while the register went
     silent. Rest params record what was ACTUALLY passed. */
  collector: (...ca) => { calls.collector.push({ deps: ca[0], argc: ca.length }); return ({
    /* ⛔ THE ARGUMENT IS RECORDED, NOT COUNTED — the re-audit's D-6. A spy that only
       counts calls proves the door CALLED the recorder and nothing about what it handed
       over: `observe(null)` twice, or `observe(someSummary)` instead of the board, keeps a
       count-based assertion green while the register is fed nothing it can read. So every
       argument is kept and asserted by IDENTITY against the object the board stub returned.
       The count stays too — it is what proves BOTH bands were observed. */
    observe: (...a) => { calls.observe += 1; calls.observed.push({ arg: a[0], argc: a.length }); },
    flush: (o) => { calls.flush.push(o); },
  }); },
  /* ⛔ AND THE ARGUMENT COUNT IS KEPT — the re-audit's D-5. `(b, o) => …` silently ignores a
     third argument, so a door that injected its own no-op dependency (`recordOne(board, opts,
     { recordMiss: () => {} })`) would turn the recording into nothing in production and leave
     every assertion here green. Rest params record what was ACTUALLY passed. */
  recordOne: (...a) => { calls.recordOne.push({ board: a[0], opts: a[1], argc: a.length }); },
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
  /* ⛔ `answered` IS PART OF THE SHAPE, and leaving it off is how this fixture lied.
     The real `search-record` collector discards a sheet whose entry is not `answered`,
     so the first cut of this fixture — `{ lenderprice: { keys: ['nqm'] } }` — described a
     board the real collector would have thrown away entirely, while the stubbed one here
     accepted it. That is what let the audit silence the register at `general-board.js`
     with one token and keep all twelve related suites green. The SEAM itself (this shape
     against what the collector reads) is proved on a REAL board in
     `test-lt-general-two-source-pure` — SEAM-1..SEAM-4; what is proved HERE is only that
     both doors call the recorder, which is all a stubbed recorder can honestly hold. */
  sightings: { lenderprice: { answered: true, keys: ['nqm'] }, loannex: { answered: true, keys: [] } },
  request: {},
  searchKey: 'sk',
  provenance: null,
  missing: [],
  sources: { lenderprice: true, loannex: true },
  investorPairing: null,
};
/* MUTABLE so a section can put the door in a shop that has switched NOBODY over —
   see section D, which is what stops this whole suite being silenced by a condition
   that the one fixture here happens to satisfy. */
const cfg = { wantLoanNex: true };
/* ONE object, not a fresh spread per call, so the observe spy above can assert the door
   handed over THE BOARD IT WAS GIVEN rather than something shaped like it. */
const BOARD_LP_ONLY = {
  ...BOARD,
  source: 'lenderprice',
  sources: { lenderprice: true, loannex: false },
  sightings: { lenderprice: { answered: true, keys: ['nqm'] }, loannex: { answered: false, keys: [] } },
};
stub('src/longterm/pricing/general-board.js', {
  loadConfig: async () => ({
    routes: {}, custom: new Map(), links: {}, heldSetting: 0.25,
    extraFor: () => 0, settings: {}, wantLoanNex: cfg.wantLoanNex,
  }),
  /* ⛔ THE BOARD FOLLOWS THE CONFIG, as the real one does. With nobody routed to
     LoanNEX the real `boardForScenario` makes no second vendor call at all, so it
     answers `source: 'lenderprice'` with that sheet unanswered. A stub that returned
     the two-source board regardless would leave section D unable to see a gate written
     on the BOARD (`if (board.source === 'both')`) rather than on the config — and the
     audit defeated the suite both ways. */
  boardForScenario: async () => (cfg.wantLoanNex ? BOARD : BOARD_LP_ONLY),
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
const reset = () => { calls.recordOne.length = 0; calls.flush.length = 0; calls.observe = 0; calls.observed.length = 0; calls.later = 0; };

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
    ok(got.argc === 2,
      `A3a …with EXACTLY the board and the options — a third argument would be a dependency the door injected, which is how a recorder becomes a no-op in production (${got.argc})`);
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
    ok(calls.observed.length === 2 && calls.observed.every((o) => o.arg === BOARD && o.argc === 1),
      `B1a …and what it observed is THE BAND'S OWN BOARD, by identity, not a count of calls (${calls.observed.map((o) => (o.arg === BOARD ? 'board' : String(o.arg && o.arg.source || o.arg))).join(', ')})`);
    ok(calls.flush.length === 1,
      `B2 …and flushed EXACTLY ONCE, after the whole search — never per band, whose silence proves nothing (${calls.flush.length})`);
    ok(calls.later === 1,
      `B3 …off the response path, same as the immediate door (${calls.later})`);
    const f = calls.flush[0] || {};
    ok(f.staffId === 'staff-2' && f.scenario,
      'B4 …carrying who searched and what for');
    ok(calls.recordOne.length === 0,
      'B5 …and it does NOT also call the single-board recorder — one search, one recording');
    /* ⛔ B6 · THE SAME HOLE A3a CLOSES, ON THIS DOOR. `collector()` takes an optional
       dependency bag, so `collector({ recordSightings: async () => ({ok:true}),
       recordMisses: async () => ({ok:true}) })` here turns every band's sighting AND miss
       recording into nothing IN PRODUCTION — and left all 24 checks green until the
       pre-merge audit of 2026-09-03 tried it, because this suite's stub discarded its own
       argument. A3a records `recordOne`'s argument count for the immediate door; this
       records `collector`'s for the bands door. */
    const c0 = calls.collector[0];
    ok(c0 && c0.argc === 0,
      `B6 the collector is asked for with NO dependencies injected — anything passed there is the recorder replaced with a no-op (${c0 ? `argc ${c0.argc}` : 'never called'})`);
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
    ok(calls.observe === 2 && calls.observed.every((o) => o.arg === BOARD),
      `C0b CONTROL: …and the sheets really were asked, each handing over its own board (${calls.observe} bands observed)`);
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

  console.log('\n── D. THE RECORDING IS NOT CONDITIONAL ON ANYTHING THIS FIXTURE HAPPENS TO BE ──');
  {
    /* ⛔ WHY THIS SECTION EXISTS. Sections A–C each exercise ONE board shape, so ANY
       condition that shape happens to satisfy silences the register everywhere else and
       leaves this suite green. The pre-merge audit of 2026-09-03 proved it with a single
       token on the immediate door:

           if (cfg.wantLoanNex) searchRecord.later(() => searchRecord.recordOne(board, {…}))

       The stub above returns `wantLoanNex: true`, so A1 passed — while in production a shop
       that has switched NOBODY to LoanNEX would record nothing at all and the side-by-side
       list would stay permanently empty. That is the owner's *"it's not actually connected"*,
       restored, with every suite reporting green.

       A rate sheet nobody is routed to is exactly the state a shop starts in, and it is
       still a search: Lender Price answered, and whether it did is what the register is for.
       So the door is run in that shop and must record just the same. */
    reset();
    cfg.wantLoanNex = false;
    const res = mkRes();
    await route.handlers.price({ body: { ...SCENARIO, full: true }, actor: { id: 'staff-5' } }, res);
    cfg.wantLoanNex = true;
    ok(res.body && res.body.ok === true,
      `D0 CONTROL: the door still answers a board when nobody is routed to LoanNEX (${res.code || 200})`);
    ok(calls.recordOne.length === 1,
      `⛔ D1 THE ONE THAT MATTERS: it records the search anyway — the register is not gated on the second sheet (${calls.recordOne.length})`);

    /* The bands door, same shop, same rule. Guarding one door and not the other is what
       let the immediate door stay silent in the first place. */
    reset();
    cfg.wantLoanNex = false;
    const res2 = mkRes();
    await route.handlers.priceBrackets({ body: { ...SCENARIO }, actor: { id: 'staff-6' } }, res2);
    cfg.wantLoanNex = true;
    ok(res2.body && res2.body.ok === true, `D2 CONTROL: the bands door answers too (${res2.code || 200})`);
    ok(calls.flush.length === 1,
      `⛔ D3 …and it flushes the register just the same (${calls.flush.length})`);

    /* And the fixture is held to the shape the real board produces, so a board that
       described a sheet WITHOUT saying whether it answered could not sit here unnoticed —
       the omission that made the real seam invisible to this suite. */
    const REG = require(path.join(ROOT, 'src/longterm/pricing/investor-sightings.js'));
    ok(REG.SOURCES.every((src) => BOARD.sightings[src] && typeof BOARD.sightings[src].answered === 'boolean'),
      `D4 …and this suite's own board carries an ANSWERED flag for every sheet the register knows (${REG.SOURCES.join(', ')})`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((e) => { console.log('THREW:', (e && e.message) || e); process.exit(1); });
