#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the four NEWEST stores, against a REAL Postgres.
 *
 * WHY THIS EXISTS. `parity-cell-store` (db/575), `schedule-store` (db/570), `cutover-store` (db/566)
 * and `agreement-store` (db/576) are each covered by a suite that drives them through a RECORDING
 * STUB. That is the right shape for the rules — a stub is what lets the write contract and the
 * fail-closed paths be proven with no database in reach — and those suites say so plainly. But a stub
 * records the SQL TEXT and hands back whatever rows the test author invented. It cannot answer the one
 * question a database answers:
 *
 *     WILL POSTGRES ACCEPT THIS STATEMENT, AGAINST THE TABLE THE MIGRATION ACTUALLY BUILT?
 *
 * This repository has been bitten by exactly that gap more than once — a SELECT naming a column that
 * lives on a different table, an `is_current` that is really `superseded`, an `ON CONFLICT` whose index
 * cannot be inferred, a `::uuid[]` cast against a BIGINT id. Every one of them sat behind a swallowing
 * catch or a stub that agreed, and every one of them read as a confident, wrong answer in production.
 * The governing rule is the first one in CLAUDE.md: rehearse against the real thing — a real Postgres —
 * never a mock that agrees with you.
 *
 * SO THIS SUITE ADDS ONLY WHAT A STUB STRUCTURALLY CANNOT, and deliberately does not re-assert the
 * decision rules (those belong to the pure suites, where they are mutation-proven):
 *
 *   1. EVERY COLUMN EXISTS AND EVERY CAST IS LEGAL — the statements are executed, not inspected.
 *   2. THE UPSERTS RESOLVE THEIR REAL INDEX. `parity-cell-store` infers by column list and
 *      `schedule-store` names its constraint (`ON CONFLICT ON CONSTRAINT
 *      lt_ppe_canary_schedule_scope_uk`); a wrong or renamed constraint is a runtime error no stub can
 *      see, and the failure mode is a duplicate row rather than a refreshed measurement.
 *   3. THE DRIVER'S TYPES ARE THE REAL ONES. Postgres returns BIGINT and NUMERIC as STRINGS, so every
 *      `rowToX` coercion is only genuinely exercised here — a stub that hands back JS numbers proves
 *      the mapper against data the mapper will never see.
 *   4. THE CONCURRENCY BRANCH IS PROVEN BY THE INDEX THAT RAISES IT. `cutover-store` turns a 23505 into
 *      a plain "somebody else decided while you were deciding". A stub can fake the error code; only a
 *      real UNIQUE proves there is something to raise it.
 *   5. THE FOREIGN KEY AND ITS CASCADE ARE REAL. db/576's header claims an agreement row belongs to a
 *      rate-sheet version and dies with it. That is a claim about the database, so it is asked of one.
 *
 * PURE section (always): nothing — every assertion here needs a database, and saying so is better than
 * padding the file with checks that already live elsewhere.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-store-roundtrip-db.js
 *
 * LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');

const parityCells = require('../src/longterm/ppe/parity-cell-store');
const scheduleStore = require('../src/longterm/ppe/schedule-store');
const cutoverStore = require('../src/longterm/ppe/cutover-store');
const agreementStore = require('../src/longterm/ppe/agreement-store');
const store = require('../src/longterm/ppe/store');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// One cell, one dimension — the smallest matrix `rowsFromMatrix` accepts. Every measure is a DIFFERENT
// number so a mapper that reads the wrong column cannot pass by coincidence.
const matrix = (over = {}) => ({
  dimensions: [{
    dimension: 'fico',
    kind: 'band',
    cells: [Object.assign({
      key: '700-720', label: 'FICO 700–720',
      total: 10, agreed: 9, disagreed: 1, errors: 0, incomparable: 2, overlay: 3,
      agreementRate: 0.9,
      priceDelta: { scenarios: 8, samples: 7, worstAbsMilli: 1250, meanMilli: 120.5 },
    }, over)],
  }],
});

// TWO cells on ONE day. This exists so `measurements` and `days` can never be equal by accident:
// with one cell on one day both aggregates are 1, and `COUNT(DISTINCT day_ms)` degraded to a plain
// `COUNT(day_ms)` passes every assertion (proven — that mutation survived the first cut of this
// suite). The consequence in production is a series measured once across twelve bands reporting
// "12 days measured", which is precisely the overstated coverage the parity screen exists not to do.
const twoCellMatrix = () => ({
  dimensions: [{
    dimension: 'fico',
    kind: 'band',
    cells: [
      { key: '700-720', label: 'FICO 700–720', total: 10, agreed: 9, disagreed: 1, errors: 0, incomparable: 2, overlay: 3, agreementRate: 0.9, priceDelta: { scenarios: 8, samples: 7, worstAbsMilli: 1250, meanMilli: 120.5 } },
      { key: '720-740', label: 'FICO 720–740', total: 6, agreed: 6, disagreed: 0, errors: 0, incomparable: 0, overlay: 0, agreementRate: 1, priceDelta: { scenarios: 6, samples: 6, worstAbsMilli: 0, meanMilli: 0 } },
    ],
  }],
});

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE store round-trip skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scope = `test_rt_${process.pid}_${Date.now()}`;
  const INV = 'Deephaven Mortgage';
  const PRG = 'dscr30';
  const DAY = 1700000000000;

  try {
    // The migrations this suite is about, applied TWICE — which is what "idempotently" claims and
    // what every boot of this system does. The line under it used to be `ok(true, '… (idempotent)')`,
    // an assertion with no false branch: it passed whether the migrations were idempotent or not, and
    // an apply that threw would have ended the run in a stack trace rather than a named failure.
    const files = ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql', '566_lt_ppe_cutover_ledger.sql',
      '570_lt_ppe_canary_schedule.sql', '575_lt_ppe_parity_cell_series.sql',
      '576_lt_ppe_ratesheet_agreement_gate.sql'];
    let applyErr = null;
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const f of files) await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
      }
    } catch (e) { applyErr = e; }
    ok(!applyErr, `db/558 + 560 + 566 + 570 + 575 + 576 apply TWICE in a row without error${applyErr ? `: ${applyErr.message}` : ''}`);
    const present = await db.query("SELECT to_regclass('public.lt_ppe_parity_cell') IS NOT NULL AS ok");
    ok(present.rows[0].ok === true, '…and the parity-cell table they create is there afterwards');

    // ---- A. parity cells (db/575) -----------------------------------------
    console.log('\nA. parity cell series (db/575)\n');

    const first = await parityCells.persistCells(scope, matrix(), { db, investor: INV, program: PRG, dayMs: DAY });
    ok(first.persisted === true && first.rows === 1, 'A1 persistCells INSERTs — the statement runs against the real table');

    let cells = await parityCells.listCells(scope, { db, investor: INV, program: PRG, sinceMs: 1 });
    ok(cells.length === 1, 'A2 the cell reads back');

    // (3) The driver's real types. day_ms is BIGINT and agreement_rate/mean_milli are NUMERIC, so pg
    // hands all three back as STRINGS. A stub returning JS numbers can never exercise this coercion,
    // and a mapper that forgot one would surface as a screen doing arithmetic on "1700000000000".
    const c = cells[0];
    ok(typeof c.dayMs === 'number' && c.dayMs === DAY, 'A3 BIGINT day_ms is coerced to a number, not a string');
    ok(typeof c.agreementRate === 'number' && c.agreementRate === 0.9, 'A4 NUMERIC agreementRate is coerced to a number');
    ok(typeof c.meanMilli === 'number' && c.meanMilli === 120.5, 'A5 NUMERIC meanMilli keeps its fraction through the round-trip');
    ok(c.worstAbsMilli === 1250 && c.total === 10 && c.agreed === 9 && c.disagreed === 1
      && c.incomparable === 2 && c.overlay === 3 && c.priceScenarios === 8 && c.priceSamples === 7,
      'A6 every measure lands in its OWN column (all-distinct values, so no coincidental pass)');

    // (2) The UPSERT resolves the real unique index by column list. If the inference failed this would
    // raise; if the index were wrong we would get TWO rows and a stale measurement served as current.
    const again = await parityCells.persistCells(scope, matrix({ agreed: 10, disagreed: 0, agreementRate: 1 }),
      { db, investor: INV, program: PRG, dayMs: DAY });
    ok(again.persisted === true, 'A7 re-persisting the same natural key runs (ON CONFLICT inference resolves)');
    cells = await parityCells.listCells(scope, { db, investor: INV, program: PRG, sinceMs: 1 });
    ok(cells.length === 1, 'A8 …and UPDATES rather than duplicating — still one row on the natural key');
    ok(cells[0].agreed === 10 && cells[0].disagreed === 0 && cells[0].agreementRate === 1,
      'A9 …with every mutable measure REFRESHED (a stale cell is a wrong answer, not a missing one)');

    // The window bound, executed rather than pattern-matched.
    const laterOnly = await parityCells.listCells(scope, { db, investor: INV, program: PRG, sinceMs: DAY + 1 });
    ok(laterOnly.length === 0, 'A10 the sinceMs bound genuinely excludes an earlier day in SQL');

    // A SECOND cell on the SAME day, and the same pair again on a LATER day: 3 measurements across
    // 2 days, so `measurements` and `days` are different numbers and neither can stand in for the
    // other. See the note on twoCellMatrix — this is what makes the DISTINCT load-bearing.
    await parityCells.persistCells(scope, twoCellMatrix(), { db, investor: INV, program: PRG, dayMs: DAY });
    await parityCells.persistCells(scope, matrix(), { db, investor: INV, program: PRG, dayMs: DAY + 86400000 });

    const series = await parityCells.listSeries(scope, { db });
    ok(series.length === 1 && series[0].investor === INV && series[0].program === PRG,
      'A11 listSeries finds the series that actually holds rows');
    ok(series[0].measurements === 3, 'A12 …counting every CELL measured (3), off a real aggregate');
    ok(series[0].days === 2,
      'A13 …but only the DISTINCT days (2) — two bands measured on one day is one day, not two');
    ok(series[0].firstDayMs === DAY && series[0].lastDayMs === DAY + 86400000,
      'A14 …with both day bounds coerced off BIGINT MIN/MAX');

    // ---- B. canary schedule (db/570) --------------------------------------
    console.log('\nB. canary schedule (db/570)\n');

    const sched = { investor: INV, enabled: true, intervalMs: 24 * 60 * 60 * 1000, scenarios: [{ fico: 700, ltv: 70 }] };
    const saved = await scheduleStore.saveSchedule(scope, sched, { db, by: 'roundtrip@ys', nowMs: DAY });
    // Deliberately NOT claimed: that the `$6::jsonb` cast is load-bearing. Removing it was mutated and
    // the suite stayed green — Postgres coerces the bound text into the jsonb column on its own — so
    // the cast is belt-and-braces, and saying otherwise would credit this test with a guard it has not
    // got. What IS proven is that the statement runs and the battery survives the trip (B5).
    ok(saved.ok === true, 'B1 saveSchedule INSERTs — every column and bind is accepted by the real table');

    // (2) This one names its constraint. A renamed or missing lt_ppe_canary_schedule_scope_uk is a
    // 42704 at runtime, invisible to a stub, and the visible symptom would be a second schedule for
    // one investor — i.e. a vendor loop firing twice as often as anybody armed it for.
    const resaved = await scheduleStore.saveSchedule(scope,
      Object.assign({}, sched, { intervalMs: 12 * 60 * 60 * 1000 }), { db, by: 'roundtrip@ys', nowMs: DAY + 1 });
    ok(resaved.ok === true, 'B2 re-saving resolves ON CONFLICT ON CONSTRAINT lt_ppe_canary_schedule_scope_uk');
    const all = await scheduleStore.listSchedules(scope, { db });
    ok(all.length === 1, 'B3 …and UPDATES — one schedule per (scope, investor), never two');
    ok(all[0].intervalMs === 12 * 60 * 60 * 1000, 'B4 …with the new cadence, coerced off BIGINT');

    const loaded = await scheduleStore.loadSchedule(scope, INV, { db });
    ok(loaded && Array.isArray(loaded.scenarios) && loaded.scenarios.length === 1 && loaded.scenarios[0].fico === 700,
      'B5 the jsonb battery round-trips through Postgres intact');

    const removed = await scheduleStore.deleteSchedule(scope, INV, { db });
    ok(removed.ok === true && removed.removed === true, 'B6 deleteSchedule removes exactly the named schedule');
    ok((await scheduleStore.listSchedules(scope, { db })).length === 0, 'B7 …and it is gone');

    // ---- C. cutover ledger (db/566) ---------------------------------------
    console.log('\nC. cutover decision ledger (db/566)\n');

    const d1 = await cutoverStore.appendDecision(scope,
      { action: 'activate', by: 'roundtrip@ys', reason: 'round-tripping the ledger', atMs: DAY },
      { db, investor: INV });
    ok(d1.ok === true && d1.entry && d1.entry.seq === 1, 'C1 appendDecision writes the first entry');
    ok(await cutoverStore.currentMode(scope, { db, investor: INV }) === d1.entry.to,
      'C2 currentMode reads back the mode the ledger just recorded');

    const hist = await cutoverStore.listHistory(scope, { db, investor: INV });
    ok(hist.length === 1 && hist[0].by === 'roundtrip@ys' && hist[0].atMs === DAY,
      'C3 listHistory returns the entry with its BIGINT stamp coerced');

    const verdict = await cutoverStore.verifyHistory(scope, { db, investor: INV });
    ok(verdict.ok === true, 'C4 verifyHistory replays the PERSISTED history from draft and finds it legal');

    // (4) The optimistic-concurrency branch, reached as the REAL race rather than simulated.
    //
    // Two sessions read the same history, compute the same next seq, and both insert; the UNIQUE is
    // what makes that safe. The window is between this caller's own SELECT and its INSERT, so the
    // competing row has to land INSIDE it — pre-inserting it first does not race at all (the reader
    // simply sees it and takes the next seq, which is what a first cut of this test proved). The db
    // handed in is therefore a thin wrapper that slips the other session's decision in at exactly that
    // moment. Everything else is real: a real second row, the real UNIQUE, a real 23505.
    let slipped = false;
    const racingDb = {
      query: async (sql, params) => {
        if (!slipped && /INSERT INTO lt_ppe_cutover_ledger/i.test(sql)) {
          slipped = true;
          await db.query(
            `INSERT INTO lt_ppe_cutover_ledger (scope, investor, seq, action, from_mode, to_mode, decided_by, decided_at, reason, eligible)
             VALUES ($1,$2,$3,'promote','shadow','live','someone-else@ys',$4,'won the race',true)`,
            [scope, INV, params[2], DAY + 1]);
        }
        return db.query(sql, params);
      },
    };
    const raced = await cutoverStore.appendDecision(scope,
      { action: 'promote', by: 'roundtrip@ys', reason: 'losing the race deliberately', atMs: DAY + 2, eligible: true },
      { db: racingDb, investor: INV });
    ok(slipped === true, 'C5 the competing decision landed inside this caller\'s read→write window (a real race)');
    ok(raced.ok === false && raced.conflict === true,
      'C6 …so the lost race is reported as a CONFLICT — the real UNIQUE raised 23505 and it was caught');
    ok(typeof raced.error === 'string' && /another decision/i.test(raced.error),
      'C7 …in plain language, telling the caller to re-read and try again');
    const afterRace = await cutoverStore.listHistory(scope, { db, investor: INV });
    ok(afterRace.length === 2 && afterRace[1].by === 'someone-else@ys',
      'C8 …and only the WINNER is on the ledger — the loser wrote nothing');

    // ---- D. agreement ledger (db/576) -------------------------------------
    console.log('\nD. agreement ledger (db/576)\n');

    const inv = await store.createInvestor(db, scope, { code: 'DHVN', name: 'Deephaven Mortgage' });
    const program = await store.createProgram(db, scope, { investorId: inv.id, code: 'DSCR30', name: 'DSCR 30yr' });
    const ver = await store.createRateSheetVersion(db, scope, { programId: program.id, versionNo: 1, channel: 'correspondent' });

    const summary = { gateMet: true, scenarios: 240, comparable: 236, agreed: 236, disagreed: 0, errors: 0, byDimension: { fico: 'ok' } };
    const run = await agreementStore.recordRun(scope, { db, versionId: ver.id, summary, recordedBy: 'roundtrip@ys', nowMs: DAY });
    ok(run.ok === true, 'D1 recordRun INSERTs — the ::jsonb cast and every count column are legal');
    ok(run.record.gateMet === true && run.record.comparable === 236 && run.record.scenarios === 240,
      'D2 …and the counts read back off INTEGER columns as numbers');
    ok(typeof run.record.recordedAt === 'number' && run.record.recordedAt === DAY,
      'D3 …with the BIGINT clock coerced, not left a string');
    ok(run.record.summary && run.record.summary.byDimension && run.record.summary.byDimension.fico === 'ok',
      'D4 …and the harness summary stored VERBATIM, nested keys intact');

    const gate = await agreementStore.gateStatus(scope, ver.id, { db });
    ok(gate.proven === true, 'D5 gateStatus reads the persisted run and answers PROVEN');

    const ovr = await agreementStore.recordOverride(scope,
      { db, versionId: ver.id, recordedBy: 'roundtrip@ys', reason: 'publishing unmeasured on purpose', nowMs: DAY + 1 });
    ok(ovr.ok === true && ovr.record.gateMet === null,
      'D6 an override stores gate_met as NULL — the column really is nullable');
    const afterOverride = await agreementStore.gateStatus(scope, ver.id, { db });
    ok(afterOverride.proven === false && afterOverride.reason === 'overridden',
      'D7 …and the LATEST word wins: a passing run does not survive an override on top of it');

    // (5) db/576's header claims the row belongs to a version and dies with it. Both halves asked of
    // the database rather than assumed.
    let fkRefused = false;
    try {
      await db.query(
        `INSERT INTO lt_ppe_ratesheet_agreement (scope, rate_sheet_version_id, kind, recorded_at)
         VALUES ($1,'00000000-0000-0000-0000-000000000000','run',$2)`, [scope, DAY]);
    } catch (e) { fkRefused = String(e.code) === '23503'; }
    ok(fkRefused, 'D8 an agreement row for a version that does not exist is REFUSED by the foreign key');

    let kindRefused = false;
    try {
      await db.query(
        `INSERT INTO lt_ppe_ratesheet_agreement (scope, rate_sheet_version_id, kind, recorded_at)
         VALUES ($1,$2,'something_else',$3)`, [scope, ver.id, DAY]);
    } catch (e) { kindRefused = String(e.code) === '23514'; }
    ok(kindRefused, 'D9 a kind outside (run, override) is refused by the CHECK — the ledger holds two kinds only');

    // ---- E. the grid writers are SCOPED (defence in depth) ----------------
    //
    // `replaceBasePrices` / `replaceAdjustments` take a scope and used to DELETE by version_id ALONE,
    // so a caller holding another tenant's version id would wipe that tenant's grid and re-stamp the
    // rows as its own. The routes refuse such an id before the store is ever reached — which is why
    // reverting this filter did NOT fail the console suite, and why the check belongs HERE: the store
    // is the layer a future caller might reach without going through that door.
    console.log('\nE. the grid writers are scoped (defence in depth)\n');

    const eVer = await store.createRateSheetVersion(db, scope, { programId: program.id, versionNo: 2, channel: 'correspondent' });
    await store.replaceBasePrices(db, scope, eVer.id, [{ noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 }]);
    await store.replaceAdjustments(db, scope, eVer.id, [{ code: 'x', dimension: 'dscr', dscrMin: 1000, dscrMax: 1250, adjMilli: 250 }]);

    // The write is REFUSED outright, not merely made harmless. Scoping the DELETE alone stopped an
    // intruder DESTROYING this grid, and left them able to ADD rows to it — which matters because
    // `loadRateSheet` selects the grid by version_id ALONE, so those foreign rows would join the grid
    // the OWNER's quotes price from.
    let refused = null;
    try {
      await store.replaceBasePrices(db, `${scope}_intruder`, eVer.id, [{ noteRateMilliPct: 1, lockDays: 1, priceMilli: 1 }]);
    } catch (e) { refused = e; }
    ok(refused && refused.code === 'LT_PPE_VERSION_OUT_OF_SCOPE', 'E1 a base-price write against another scope\'s version is REFUSED');

    let refusedAdj = null;
    try {
      await store.replaceAdjustments(db, `${scope}_intruder`, eVer.id, []);
    } catch (e) { refusedAdj = e; }
    ok(refusedAdj && refusedAdj.code === 'LT_PPE_VERSION_OUT_OF_SCOPE', 'E2 …and so is an LLPA write');

    // Nothing of the owner's moved, and — the half a scoped DELETE could not give — nothing of the
    // intruder's was ADDED either, on ANY scope.
    const bp = await db.query('SELECT COUNT(*)::int AS n, MIN(price_milli)::int AS p FROM lt_ppe_base_price WHERE version_id = $1', [eVer.id]);
    ok(bp.rows[0].n === 1 && bp.rows[0].p === 101500, 'E2a the owner\'s grid is untouched and carries no foreign row');
    const adjRows = await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_adjustment WHERE version_id = $1', [eVer.id]);
    ok(adjRows.rows[0].n === 1, 'E2b …and so are the LLPAs');

    ok(await store.rateSheetVersionInScope(db, scope, eVer.id) !== null, 'E3 rateSheetVersionInScope finds a version in its own scope');
    ok(await store.rateSheetVersionInScope(db, `${scope}_intruder`, eVer.id) === null, 'E4 …and refuses it from another scope');

    // ---- F. a grid write is ATOMIC ----------------------------------------
    //
    // REPRODUCED BEFORE IT WAS FIXED, against this database: `replaceBasePrices` is
    // DELETE-then-INSERT-in-a-loop, and on a pool each statement is its own transaction — so one
    // duplicated cell (an ordinary copy/paste mistake) tripped lt_ppe_base_price_cell_uk AFTER the
    // delete had already committed, and a live two-row sheet became a one-row sheet. Any INSERT
    // failure does it, not only a duplicate. The grid is what every quote prices from, so it is the
    // one thing here that must never be half-written.
    console.log('\nF. a grid write is atomic\n');

    await store.replaceBasePrices(db, scope, eVer.id, [
      { noteRateMilliPct: 7000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 7125, lockDays: 30, priceMilli: 102850 },
    ]);
    const gridBefore = await db.query(
      'SELECT COUNT(*)::int AS n, SUM(price_milli)::int AS s FROM lt_ppe_base_price WHERE version_id = $1', [eVer.id]);

    let threw = null;
    try {
      await store.replaceBasePrices(db, scope, eVer.id, [
        { noteRateMilliPct: 7000, lockDays: 30, priceMilli: 101500 },
        { noteRateMilliPct: 7000, lockDays: 30, priceMilli: 999999 },   // the same cell twice
        { noteRateMilliPct: 7250, lockDays: 30, priceMilli: 103000 },
      ]);
    } catch (e) { threw = e; }
    ok(threw !== null && String(threw.code) === '23505', 'F1 a duplicated cell is refused by the unique key');
    const gridAfter = await db.query(
      'SELECT COUNT(*)::int AS n, SUM(price_milli)::int AS s FROM lt_ppe_base_price WHERE version_id = $1', [eVer.id]);
    // The SUM matters as much as the count: a rolled-back write that happened to leave two rows of
    // the WRONG prices would pass a count check and still be a corrupted sheet.
    ok(gridAfter.rows[0].n === gridBefore.rows[0].n && gridAfter.rows[0].s === gridBefore.rows[0].s,
      'F2 …and the previous grid is byte-for-byte intact — the failed write rolled back whole');

    await store.replaceBasePrices(db, scope, eVer.id, [{ noteRateMilliPct: 7500, lockDays: 45, priceMilli: 100250 }]);
    const replaced = await db.query(
      'SELECT COUNT(*)::int AS n, MIN(price_milli)::int AS p FROM lt_ppe_base_price WHERE version_id = $1', [eVer.id]);
    ok(replaced.rows[0].n === 1 && replaced.rows[0].p === 100250,
      'F3 …while a GOOD write still replaces the grid cleanly (the transaction did not break the ordinary path)');

    let adjThrew = null;
    try {
      await store.replaceAdjustments(db, scope, eVer.id, [
        { code: 'ok', dimension: 'dscr', adjMilli: 250 },
        { code: 'bad', dimension: null, adjMilli: 100 },   // dimension is NOT NULL
      ]);
    } catch (e) { adjThrew = e; }
    ok(adjThrew !== null, 'F4 an LLPA row the column refuses raises');
    const adjLeft = await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_adjustment WHERE version_id = $1', [eVer.id]);
    ok(adjLeft.rows[0].n === 1,
      'F5 …and the LLPA set rolled back whole too — not the one good row left behind on its own');

    await db.query('DELETE FROM lt_ppe_base_price WHERE version_id = $1', [eVer.id]);
    await db.query('DELETE FROM lt_ppe_adjustment WHERE version_id = $1', [eVer.id]);
    await db.query('DELETE FROM lt_ppe_rate_sheet_version WHERE id = $1', [eVer.id]);

    await db.query('DELETE FROM lt_ppe_rate_sheet_version WHERE id = $1', [ver.id]);
    const orphans = await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_ratesheet_agreement WHERE rate_sheet_version_id = $1', [ver.id]);
    ok(orphans.rows[0].n === 0, 'D10 deleting the version CASCADES its agreement rows away — no orphan evidence');

    // ---- cleanup ----------------------------------------------------------
    for (const t of ['lt_ppe_ratesheet_agreement', 'lt_ppe_parity_cell', 'lt_ppe_canary_schedule',
      'lt_ppe_cutover_ledger', 'lt_ppe_program', 'lt_ppe_investor']) {
      await db.query(`DELETE FROM ${t} WHERE scope = $1`, [scope]);
    }
  } catch (e) {
    ok(false, `unexpected error: ${e && e.message}`);
  } finally {
    await db.end();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
