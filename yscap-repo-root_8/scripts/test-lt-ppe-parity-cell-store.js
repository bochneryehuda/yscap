'use strict';
/**
 * Pure offline test for the PER-CELL PARITY SERIES (src/longterm/ppe/parity-cell-store.js) — the
 * durable half of P9, which is what turns "we disagree" into "this band has been off for three weeks".
 *   node scripts/test-lt-ppe-parity-cell-store.js
 *
 * The database is a STUB that records the SQL and the binds, so the write contract — one upsert per
 * cell, on the natural key, with every column named — is asserted without a live Postgres. What a stub
 * cannot prove is that the columns EXIST, so the migration and the Prisma model are read and compared
 * against the columns this module actually binds (section F): a phantom column here would sit inside
 * the route's catch and report a confident "cells did not persist" forever.
 *
 *   A. matrix → rows: the flattening, the counts, the cap
 *   B. the write contract: upsert on the natural key, refuse an undateable run
 *   C. THE RULE THAT RUNS THROUGH EVERYTHING: a missing row is "not measured", never "measured badly"
 *   D. one cell's history + the direction, delegated to the ONE trend definition
 *   E. ranking without thresholds
 *   F. the columns are real, and the route publishes the series
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/longterm/ppe/parity-cell-store');
const M = require('../src/longterm/ppe/parity-matrix');
const scoreboard = require('../src/longterm/ppe/scoreboard');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const deep = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// A stub db that records every statement.
function stubDb(onQuery) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (onQuery) return onQuery(sql, params);
      return { rows: [] };
    },
  };
}

const PROGRAM = { rules: [{ code: 'r', kind: 'pricing', when: { all: [{ fact: 'fico', op: 'between', value: [700, 760] }] } }] };
const DAY = 24 * 60 * 60 * 1000;

const matrixOf = (results) => M.buildParityMatrix(results, { program: PROGRAM });

async function main() {
  // =========================================================================
  // A. MATRIX → ROWS
  // =========================================================================
  {
    const m = matrixOf([
      { agree: true, facts: { fico: 720, state: 'NY' }, findings: [] },
      { agree: false, facts: { fico: 650, state: 'NY' }, findings: [{ kind: 'price_mismatch', deltaMilli: -1250 }] },
    ]);
    const { rows, truncated } = S.rowsFromMatrix(m);
    eq(truncated, 0, 'A1 nothing truncated on a small run');
    eq(rows.length, 3, 'A2 two FICO bands and one state cell');
    const bad = rows.find((r) => r.dimension === 'fico' && r.cellLabel === '< 700') || {};
    eq(bad.total, 1, 'A3 the cell carries its counts');
    eq(bad.agreed, 0, 'A4 …including the ones that are zero');
    eq(bad.agreementRate, 0, 'A5 …and a real zero rate, which is not the same as no rate');
    eq(bad.worstAbsMilli, 1250, 'A6 …the worst gap, absolute');
    eq(bad.meanMilli, -1250, 'A7 …and the SIGNED mean');
    eq(bad.priceScenarios, 1, 'A8 loans with a gap');
    eq(bad.priceSamples, 1, 'A9 …and coupons with one');
    eq(bad.kind, 'band', 'A10 a banded axis is recorded as banded');
    const st = rows.find((r) => r.dimension === 'state') || {};
    eq(st.kind, 'category', 'A11 …and a categorical one as categorical');
    eq(st.cellKey, 'NY', 'A12 a category cell is keyed by its own value');
    ok(bad.cellKey !== bad.cellLabel, 'A13 a band\'s KEY is not its label — a reprice can change punctuation without changing which loans it holds');
  }
  {
    // A cell with no comparable scenarios has NO rate. A zero would read as total disagreement.
    const cell = { key: 'k', label: 'k', total: 0, agreed: 0, disagreed: 0, errors: 0, incomparable: 0, overlay: 0, agreementRate: null, priceDelta: {} };
    const { rows } = S.rowsFromMatrix({ dimensions: [{ dimension: 'd', kind: 'category', cells: [cell] }] });
    eq(rows[0].agreementRate, null, 'A14 no rate stays NULL, never 0');
    eq(rows[0].worstAbsMilli, null, 'A15 …and so does an absent gap');
    eq(rows[0].total, 0, 'A16 …while the COUNTS are a real zero');
  }
  {
    const cells = [];
    for (let i = 0; i < S.MAX_CELLS_PER_RUN + 15; i += 1) cells.push({ key: `k${i}`, label: `k${i}`, total: 1, agreed: 1, priceDelta: {} });
    const { rows, truncated } = S.rowsFromMatrix({ dimensions: [{ dimension: 'd', kind: 'category', cells }] });
    eq(rows.length, S.MAX_CELLS_PER_RUN, 'A17 the per-run batch is capped');
    eq(truncated, 15, 'A18 …and the overflow is COUNTED — a series missing its tail reads as a clean stretch');
  }
  {
    deep(S.rowsFromMatrix(null).rows, [], 'A19 no matrix → no rows, no throw');
    deep(S.rowsFromMatrix({ dimensions: 'nope' }).rows, [], 'A20 junk → no rows');
  }

  // =========================================================================
  // B. THE WRITE CONTRACT
  // =========================================================================
  {
    const db = stubDb();
    const m = matrixOf([{ agree: true, facts: { fico: 720 }, findings: [] }]);
    const out = await S.persistCells('company', m, { db, investor: 'DHVN', program: 'P', dayMs: 1700000000000 });
    eq(out.persisted, true, 'B1 the cells persisted');
    eq(out.rows, 1, 'B2 …one row for one cell');
    eq(db.calls.length, 1, 'B3 …written with one statement per cell');
    const sql = db.calls[0].sql;
    ok(/INSERT INTO lt_ppe_parity_cell/.test(sql), 'B4 into the series table');
    ok(/ON CONFLICT \(scope, investor, program, day_ms, dimension, cell_key\) DO UPDATE/.test(sql),
      'B5 re-persisting the SAME run UPSERTS on the natural key — never a duplicate row');
    ok(/updated_at\s*=\s*now\(\)/.test(sql), 'B6 …and stamps when it was refreshed');
    // The freshest measure of a run wins, so every mutable measure is in the DO UPDATE.
    for (const col of ['total', 'agreed', 'disagreed', 'errors', 'incomparable', 'overlay', 'agreement_rate', 'price_scenarios', 'price_samples', 'worst_abs_milli', 'mean_milli']) {
      ok(new RegExp(`${col}\\s*=\\s*EXCLUDED.${col}`).test(sql), `B7 ${col} is refreshed on a re-persist`);
    }
    ok(/program_id\s*=\s*COALESCE\(EXCLUDED.program_id/.test(sql),
      'B8 …but a resolved program anchor is never overwritten with a null');
  }
  {
    // A measurement we cannot place in time is not a series entry. Refused, with the reason, rather
    // than stored under a made-up date where it would corrupt every trend that reads it.
    const db = stubDb();
    const out = await S.persistCells('company', matrixOf([{ agree: true, facts: { fico: 720 } }]), { db, dayMs: null });
    eq(out.persisted, false, 'B9 an undateable run is refused');
    eq(out.reason, 'no_day_ms', 'B10 …with the reason');
    eq(db.calls.length, 0, 'B11 …and nothing is written');
  }
  {
    const db = stubDb();
    const out = await S.persistCells('company', { dimensions: [] }, { db, dayMs: 1 });
    eq(out.persisted, true, 'B12 a run with no cells is not a failure');
    eq(out.rows, 0, 'B13 …it simply wrote nothing');
    eq(db.calls.length, 0, 'B14 …with no statement issued');
  }
  {
    // Postgres returns NUMERIC as a STRING; a rate arriving as "0.5" fails every arithmetic
    // comparison downstream in perfect silence.
    const c = S.rowToCell({ day_ms: '1700000000000', dimension: 'fico', cell_key: 'k', cell_label: 'l', kind: 'band', total: '3', agreed: '2', disagreed: '1', errors: '0', incomparable: '0', overlay: '0', agreement_rate: '0.6666', price_scenarios: '1', price_samples: '2', worst_abs_milli: '1250', mean_milli: '-625.5' });
    eq(typeof c.agreementRate, 'number', 'B15 a NUMERIC rate is read back as a NUMBER');
    eq(c.dayMs, 1700000000000, 'B16 …and a BIGINT day as a number');
    eq(c.worstAbsMilli, 1250, 'B17 …and the worst gap');
    eq(c.meanMilli, -625.5, 'B18 …keeping its sign');
    eq(S.rowToCell({ agreement_rate: null }).agreementRate, null, 'B19 a null rate stays null');
    eq(S.rowToCell({ total: null }).total, 0, 'B20 …while a null COUNT reads as zero');
  }

  // =========================================================================
  // C. A MISSING ROW IS "NOT MEASURED", NEVER "MEASURED BADLY"
  // =========================================================================
  {
    // The whole reason this rule exists: a run whose scenarios happened to include no loans in a band
    // writes nothing for it. Zero-filling that gap would report a band nobody priced as one that
    // failed completely, and the trend would show a collapse that never happened.
    const cell = (dayMs, rate, dis) => ({ dayMs, dimension: 'fico', cellKey: '-Infinity:700', cellLabel: '< 700', agreementRate: rate, disagreed: dis, total: 5, worstAbsMilli: null, legVersion: S.LEG_VERSION });
    const sparse = [cell(1 * DAY, 1, 0), cell(5 * DAY, 1, 0)]; // days 2,3,4 not measured at all
    const h = S.cellHistory(sparse, { windowDays: 5 });
    eq(h.daysMeasured, 2, 'C1 only the days actually measured are counted');
    eq(h.windowDays, 5, 'C2 …against the window that was asked about');
    eq(h.days.length, 2, 'C3 the series has NO invented entries for the missing days');
    ok(!h.days.some((d) => d.agreementRate === 0), 'C4 …and no gap was zero-filled into a failure');
    eq(h.latestAgreementRate, 1, 'C5 the latest measured value is the latest MEASURED value');
  }
  {
    // A caller who does not say what window they mean gets null, not a number implying full coverage.
    const h = S.cellHistory([{ dayMs: 1, dimension: 'd', cellKey: 'k', agreementRate: 1, disagreed: 0 }]);
    eq(h.windowDays, null, 'C6 an unstated window is null, never a flattering default');
  }
  {
    const h = S.cellHistory([]);
    eq(h.daysMeasured, 0, 'C7 an empty history measures nothing');
    eq(h.latestAgreementRate, null, 'C8 …and reports NO rate, never 1');
    eq(h.trend.direction, 'unknown', 'C9 …and an unknown direction');
    eq(S.cellHistory(null).daysMeasured, 0, 'C10 junk does not throw');
  }

  // =========================================================================
  // D. THE DIRECTION IS THE ONE TREND DEFINITION
  // =========================================================================
  {
    const c = (d, rate) => ({ dayMs: d * DAY, dimension: 'fico', cellKey: 'k', cellLabel: 'k', agreementRate: rate, disagreed: rate < 1 ? 1 : 0, legVersion: S.LEG_VERSION });
    const improving = S.cellHistory([c(1, 0.2), c(2, 0.3), c(3, 0.9), c(4, 0.95)]);
    eq(improving.trend.direction, 'improving', 'D1 a recovering band reads as improving');
    const worsening = S.cellHistory([c(1, 0.99), c(2, 0.98), c(3, 0.4), c(4, 0.3)]);
    eq(worsening.trend.direction, 'worsening', 'D2 …and a regressing one as worsening');
    // REUSED, not re-implemented: "improving" must mean one thing in this codebase.
    const days = [c(1, 0.2), c(2, 0.3), c(3, 0.9), c(4, 0.95)].map((x) => ({ dayMs: x.dayMs, agreementRate: x.agreementRate }));
    deep(improving.trend, scoreboard.trend(days, {}), 'D3 the direction IS scoreboard.trend — one definition, not two');
    eq(S.cellHistory([c(1, 0.5)]).trend.direction, 'unknown', 'D4 one point is not a direction');
    eq(improving.daysWithDisagreement, 4, 'D5 the days it was seen disagreeing are counted');
    eq(improving.worstAbsMilli, null, 'D6 …and an absent gap stays absent');
  }

  // =========================================================================
  // E. RANKING WITHOUT THRESHOLDS
  // =========================================================================
  {
    const mk = (dim, key, day, rate, dis, worst) => ({ dayMs: day * DAY, dimension: dim, cellKey: key, cellLabel: key, agreementRate: rate, disagreed: dis, worstAbsMilli: worst, legVersion: S.LEG_VERSION });
    const cells = [
      // a band off on all three days — the one worth a human's morning
      mk('fico', 'lo', 1, 0.2, 4, 1250), mk('fico', 'lo', 2, 0.3, 3, 1000), mk('fico', 'lo', 3, 0.25, 4, 1500),
      // one bad afternoon, then clean
      mk('fico', 'mid', 1, 0.5, 2, 300), mk('fico', 'mid', 2, 1, 0, null), mk('fico', 'mid', 3, 1, 0, null),
      // clean throughout
      mk('state', 'NY', 1, 1, 0, null), mk('state', 'NY', 2, 1, 0, null),
    ];
    const worst = S.persistentlyWorst(cells, { windowDays: 3 });
    eq(worst[0].cellKey, 'lo', 'E1 the PERSISTENTLY bad band ranks first');
    eq(worst[0].daysWithDisagreement, 3, 'E2 …because it was off on every measured day');
    eq(worst[1].cellKey, 'mid', 'E3 the one bad afternoon ranks below it');
    eq(worst[1].daysWithDisagreement, 1, 'E4 …with one day, which is the distinction the whole table exists to make');
    eq(worst[2].cellKey, 'NY', 'E5 …and the clean cell ranks last');
    eq(worst[0].worstAbsMilli, 1500, 'E6 the worst gap across the window rides along');
    // PERSISTENCE AND DIRECTION ARE DIFFERENT FACTS, and this cell is why both are reported: it has
    // disagreed every single measured day (0.20 → 0.30 → 0.25) and its direction is nonetheless
    // "improving", because the newest half averages higher than the older. Ranking on direction alone
    // would let a band that has never once agreed drift to the bottom of the list on a rounding-scale
    // wobble; ranking on persistence alone would hide that a real fix has started to land.
    eq(worst[0].trend.direction, 'improving', 'E7 …and its direction, which can be improving even while it disagrees every day');
    eq(worst[0].daysMeasured, 3, 'E7a …over the days it was actually measured');
    eq(S.persistentlyWorst(cells, { limit: 1 }).length, 1, 'E8 the limit is honoured');
    eq(S.persistentlyWorst(null).length, 0, 'E9 junk ranks nothing');
    // Cells from different dimensions never merge, even sharing a key.
    const collide = [mk('fico', 'x', 1, 0.1, 1, 10), mk('state', 'x', 1, 0.1, 1, 10)];
    eq(S.persistentlyWorst(collide).length, 2, 'E10 the same key in two dimensions is two cells');
    const merged = S.persistentlyWorst(collide);
    deep(merged.map((h) => h.dimension).sort(), ['fico', 'state'], 'E10a …kept apart BY DIMENSION, not merged on a shared key');

    // THE CASE THAT SEPARATES THE TWO RANKINGS. `chronic` has disagreed on all three measured days
    // and has since recovered (latest 1.00); `fresh` was perfect twice and broke only today
    // (latest 0.10). Ranking on the LATEST rate puts `fresh` first; ranking on PERSISTENCE puts
    // `chronic` first — which is the whole point of keeping a series rather than a snapshot, and the
    // reason the sort leads with days-disagreeing. Without this fixture both orderings agree and the
    // ordering is untested.
    const split = [
      mk('fico', 'chronic', 1, 0.4, 3, 900), mk('fico', 'chronic', 2, 0.5, 2, 800), mk('fico', 'chronic', 3, 1, 1, 100),
      mk('fico', 'fresh', 1, 1, 0, null), mk('fico', 'fresh', 2, 1, 0, null), mk('fico', 'fresh', 3, 0.1, 1, 5000),
    ];
    const ranked = S.persistentlyWorst(split, { windowDays: 3 });
    eq(ranked[0].cellKey, 'chronic', 'E11 the CHRONIC band ranks above the one that broke today…');
    eq(ranked[0].daysWithDisagreement, 3, 'E11a …on three days of disagreement');
    eq(ranked[1].cellKey, 'fresh', 'E11b …even though today it is the worse of the two');
    ok(ranked[1].latestAgreementRate < ranked[0].latestAgreementRate,
      'E11c …which is exactly the ordering a latest-rate sort would invert');
  }

  // =========================================================================
  // G0. THE READ ITSELF — narrowing, and the window
  // =========================================================================
  //
  // `listCells` had no coverage at all until a mutation of its window clause was run and the whole
  // suite stayed green. That is not a hypothetical: a read silently ignoring `sinceMs` returns the
  // WHOLE series under a "last 30 days" heading, so a band that has been clean for a month reads as
  // chronically bad off measurements from a quarter ago.
  {
    const db = stubDb(() => ({ rows: [] }));
    await S.listCells('company', { db, investor: 'DHVN', program: 'DSCR', sinceMs: 1690000000000 });
    const { sql, params } = db.calls[0];
    ok(/FROM lt_ppe_parity_cell/.test(sql), 'G0-1 the read hits the series table');
    ok(/scope = \$1 AND investor = \$2 AND program = \$3/.test(sql),
      'G0-2 …matching the series key EXACTLY — which is why a guessed key comes back empty');
    ok(/day_ms >= \$4/.test(sql), 'G0-3 …bounded by the window the caller asked about');
    deep(params, ['company', 'DHVN', 'DSCR', 1690000000000], 'G0-4 …with the window actually bound');
    ok(/ORDER BY day_ms ASC/.test(sql), 'G0-5 …oldest first, because a trend is read forwards');
  }
  {
    // ONE cell by name — the day-by-day history behind a row.
    const db = stubDb(() => ({ rows: [] }));
    await S.listCells('company', { db, dimension: 'fico', cellKey: '700:760' });
    const { sql, params } = db.calls[0];
    ok(/dimension = \$4/.test(sql) && /cell_key = \$5/.test(sql), 'G0-6 a named cell narrows on both halves of its identity');
    deep(params, ['company', '', '', 'fico', '700:760'], 'G0-7 …and an unstated investor/program is the EMPTY key, never a wildcard');
    ok(!/day_ms >=/.test(sql), 'G0-8 …with no window invented when none was asked for');
  }
  {
    // A row comes back through the same NUMERIC-to-number reader the trend arithmetic needs.
    const db = stubDb(() => ({ rows: [{ day_ms: '1700000000000', dimension: 'fico', cell_key: 'k', cell_label: 'l', kind: 'band', agreement_rate: '0.5', total: '2', agreed: '1' }] }));
    const cells = await S.listCells('company', { db });
    eq(cells.length, 1, 'G0-9 a stored row is read back');
    eq(cells[0].agreementRate, 0.5, 'G0-10 …with its NUMERIC rate as a number, not the string Postgres returns');
  }

  // =========================================================================
  // G. WHICH SERIES HOLD ANYTHING — the read that stops an empty view lying
  // =========================================================================
  //
  // `listCells` matches (scope, investor, program) EXACTLY, so a reader that asks for a key nobody
  // wrote gets an empty list — which a screen draws as "the engines have never been measured" while
  // the table is full of measurements. `listSeries` is what lets a reader offer what EXISTS instead
  // of guessing a key and reporting silence.
  {
    const db = stubDb(() => ({
      rows: [
        { investor: 'DHVN', program: 'DSCR', measurements: '40', days: '4', last_day_ms: '1700200000000', first_day_ms: '1700000000000' },
        { investor: null, program: null, measurements: '3', days: '1', last_day_ms: '1699000000000', first_day_ms: '1699000000000' },
      ],
    }));
    const series = await S.listSeries('company', { db, sinceMs: 1690000000000 });
    eq(series.length, 2, 'G1 every series in the window comes back');
    eq(series[0].investor, 'DHVN', 'G2 …carrying the investor the canary recorded');
    eq(series[0].program, 'DSCR', 'G3 …and the program label beside it');
    eq(series[0].days, 4, 'G4 …with the DAYS it was measured on, not just the row count');
    eq(series[0].measurements, 40, 'G5 …and the row count too, which is a different question');
    eq(typeof series[0].lastDayMs, 'number', 'G6 a BIGINT day is read back as a number');
    // A run recorded against nobody stores '' — never null — because that is the key the read matches.
    eq(series[1].investor, '', 'G7 a run against no investor reads as the empty key it was stored under');
    eq(series[1].program, '', 'G8 …and the same for its program');
    const sql = db.calls[0].sql;
    ok(/GROUP BY investor, program/.test(sql), 'G9 the series are grouped by the key the cell read matches');
    ok(/COUNT\(DISTINCT day_ms\)/.test(sql), 'G10 …counting DAYS distinctly, so many cells on one day are one day');
    ok(/ORDER BY MAX\(day_ms\) DESC/.test(sql), 'G11 …most recently measured first, which is recency and not a ranking of badness');
    ok(/day_ms >= \$2/.test(sql), 'G12 …bounded by the window the caller asked about');
    deep(db.calls[0].params, ['company', 1690000000000, S.MAX_SERIES], 'G13 …and capped, so one query cannot be unbounded');
  }
  {
    // No window asked for → no window clause, and the cap still rides.
    const db = stubDb(() => ({ rows: [] }));
    const series = await S.listSeries('company', { db });
    eq(series.length, 0, 'G14 an empty table lists no series');
    ok(!/day_ms >=/.test(db.calls[0].sql), 'G15 …and an unstated window is not invented as a filter');
    deep(db.calls[0].params, ['company', S.MAX_SERIES], 'G16 …with the cap as the only other bind');
  }

  // =========================================================================
  // F. THE COLUMNS ARE REAL, AND THE SERIES IS REACHABLE
  // =========================================================================
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'db', '575_lt_ppe_parity_cell_series.sql'), 'utf8')
      .replace(/^\s*--.*$/gm, '');
    // A stub db proves the SQL SHAPE, never that the columns exist. A phantom column would sit inside
    // the route's catch and report a confident "the cells did not persist" forever.
    const bound = ['scope', 'investor', 'program', 'program_id', 'day_ms', 'dimension', 'cell_key', 'cell_label', 'kind',
      'total', 'agreed', 'disagreed', 'errors', 'incomparable', 'overlay', 'agreement_rate',
      'price_scenarios', 'price_samples', 'worst_abs_milli', 'mean_milli'];
    for (const col of bound) ok(new RegExp(`\\b${col}\\b`).test(mig), `F1 the migration declares ${col}`);
    ok(/CREATE TABLE IF NOT EXISTS lt_ppe_parity_cell/.test(mig), 'F2 the table is created idempotently');
    ok(/UNIQUE \(scope, investor, program, day_ms, dimension, cell_key\)/.test(mig), 'F3 …with the natural key the upsert names');
    ok(/CREATE INDEX IF NOT EXISTS lt_ppe_parity_cell_series_idx/.test(mig), 'F4 …and the index the trend query rides');
    ok(!/UPDATE lt_ppe_parity_cell SET/.test(mig), 'F5 there is NO backfill — per-cell history was never captured and cannot be invented from a daily total');

    const prisma = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'prisma', 'schema.prisma'), 'utf8');
    ok(/model LtPpeParityCell/.test(prisma), 'F6 the schema map declares the table');
    for (const col of ['cell_key', 'worst_abs_milli', 'price_scenarios']) {
      ok(new RegExp(`@map\\("${col}"\\)`).test(prisma), `F7 …including ${col}`);
    }

    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // AWAITED and ASSIGNED, not merely mentioned: a call left dangling in a fire-and-forget wrapper
    // still contains the function's name, so matching the name alone proves nothing about whether the
    // cells reach the table or whether a failure is reported.
    ok(/cellsPersisted\s*=\s*await parityCellStore\.persistCells\(/.test(routeSrc),
      'F8 the canary AWAITS the cell persist and keeps its result');
    ok(/cellPersistError/.test(routeSrc), 'F9 …reported separately, because the three stores fail independently');
    ok(/cellsTruncated:/.test(routeSrc), 'F10 …and a capped batch is said, never silently short');
    ok(/router\.get\('\/parity-cells'/.test(routeSrc), 'F11 the series is readable');
    ok(/persistentlyWorst/.test(routeSrc), 'F12 …ranked by how persistently a cell has disagreed');
    // The read matches ONE series exactly, so a reader that guesses a key gets silence back. The
    // series list is what turns that silence into "the measurements are over there".
    ok(/await parityCellStore\.listSeries\(/.test(routeSrc),
      'F12a …and the series that actually hold rows ride with it, so an empty view is never read as an empty table');
    ok(/seriesTruncated:/.test(routeSrc),
      'F12b …with a capped series list SAID, because a series a reader cannot see reads as unmeasured');
    // An empty series and a series of clean days look identical on a chart.
    // Keyed on EMPTINESS, in the code rather than in a comment: the sentence existing somewhere in
    // the file says nothing about whether an empty window actually reaches it.
    ok(/note:\s*cells\.length\s*\?\s*null\s*:\s*'No per-band measurements in this window yet/.test(routeSrc),
      'F13 …and an empty window SAYS it is empty rather than looking clean');

    // A NUL byte inside a template literal has now slipped into this codebase TWICE — it survives
    // every test (it is just an odd separator character), makes the file read as binary to grep, and
    // is invisible in a diff. Cheap to check, so it is checked.
    for (const f of ['src/longterm/ppe/parity-cell-store.js', 'src/longterm/ppe/parity-matrix.js']) {
      const bytes = fs.readFileSync(path.join(__dirname, '..', f));
      eq(bytes.indexOf(0), -1, `F14 ${f} carries no NUL byte`);
    }
  }

  // =========================================================================
  // F. §2.126a — A SEQUENCE IS ONLY A MEASUREMENT WHEN ONE INSTRUMENT TOOK EVERY READING
  //
  // This module's own headline rule is that a MISSING row means "not measured", never "measured
  // badly". It had no rule at all for the day the engine underneath changed. Measured on a real
  // Postgres, 2026-08-19: a twelve-day window whose ONLY change was the leg fix (§2.122 gave our
  // engine the deal's real facts; §2.124 taught it that a quote answers in three states) reported
  //     trend = { direction: 'improving', delta: 0.20 }
  // which describes the repair of the instrument, not the behaviour of the band. Every column on the
  // table — 23 of them — and every key on a cell record was checked first; none named an engine.
  // =========================================================================
  {
    const OLD = '2026-08-19/2.122';
    const day = (d, rate, leg) => ({
      dayMs: d * DAY, dimension: 'fico', cellKey: '700:760', cellLabel: '700-760',
      agreementRate: rate, disagreed: rate < 1 ? 3 : 0, worstAbsMilli: rate < 1 ? 120 : null,
      ...(leg === undefined ? {} : { legVersion: leg }),
    });

    // F1-F5 — the five answers, one place.
    eq(S.comparabilityOf([day(1, 1, S.LEG_VERSION), day(2, 1, S.LEG_VERSION)]).comparability, 'current',
      'F1 every reading taken by today\'s engine');
    eq(S.comparabilityOf([day(1, 1, OLD), day(2, 1, OLD)]).comparability, 'older',
      'F2 every reading taken by one engine that has since changed');
    eq(S.comparabilityOf([day(1, 1), day(2, 1)]).comparability, 'unstamped',
      'F3 every reading taken before the stamp existed — the state of the whole live series today');
    eq(S.comparabilityOf([day(1, 0.4, OLD), day(2, 1, S.LEG_VERSION)]).comparability, 'mixed',
      'F4 the instrument changed inside the window — not a sequence at all');
    eq(S.comparabilityOf([]).comparability, 'none', 'F5 nothing measured is its own answer');
    // An UNMEASURED day carries no reading, so it cannot make a window mixed.
    eq(S.comparabilityOf([day(1, 1, S.LEG_VERSION), { ...day(2, null), agreementRate: null }]).comparability,
      'current', 'F6 a day with no rate says nothing about which engine read it');

    // F7-F11 — the defect, reproduced exactly as it was measured.
    const crossing = [];
    for (let i = 1; i <= 12; i++) crossing.push(day(i, i <= 6 ? 0.4 : 1, i <= 6 ? OLD : S.LEG_VERSION));
    const h = S.cellHistory(crossing, { windowDays: 12 });
    eq(h.comparability, 'mixed', 'F7 a window crossing the leg fix is reported as mixed');
    eq(h.trend, null, 'F8 …and NO direction is stated — "improving" there describes the repair, not the band');
    eq(h.trendOfOlderReadings, null, 'F9 …nor is one smuggled in under the other key: mixed is not a sequence');
    ok(/changed inside this window/.test(h.trendReason || ''), 'F10 …and the reason says so in plain words');
    eq(h.daysWithDisagreement, 6, 'F11 the honest count of days it was seen off is kept');
    eq(h.daysWithDisagreementCurrentLeg, 0,
      'F12 …beside the part today\'s engine actually saw, which is the half that describes the engine we run');
    deep(h.legVersions.slice().sort(), [OLD, S.LEG_VERSION].sort(), 'F13 both wirings are named');

    // F14-F16 — an older window holds a REAL sequence. It is preserved, just not under `trend`.
    const allOld = [];
    for (let i = 1; i <= 4; i++) allOld.push(day(i, 0.2 + i * 0.2, OLD));
    const ho = S.cellHistory(allOld, {});
    eq(ho.trend, null, 'F14 an older window states no CURRENT direction');
    ok(ho.trendOfOlderReadings && ho.trendOfOlderReadings.direction === 'improving',
      'F15 …but the real direction of those readings is kept, under its own key — nothing is destroyed');
    ok(/has since changed/.test(ho.trendReason || ''), 'F16 …and the reader is told which engine took them');

    // F17 — an unstamped window (every row that exists today) is the same shape with its own sentence.
    const allNone = [];
    for (let i = 1; i <= 4; i++) allNone.push(day(i, 0.2 + i * 0.2));
    const hn = S.cellHistory(allNone, {});
    eq(hn.trend, null, 'F17 an unstamped window states no current direction either');
    ok(/what read them is unknown/.test(hn.trendReason || ''),
      'F18 …and says the reader is UNKNOWN, not that it was wrong');

    // F19-F21 — the ranking. The old first key counted days read by whatever engine was running.
    const mk2 = (key, d, rate, leg) => ({ ...day(d, rate, leg), cellKey: key, cellLabel: key });
    const cells = [
      // `oldOnly` looked terrible, but only under the leg that declined everything
      mk2('oldOnly', 1, 0.1, OLD), mk2('oldOnly', 2, 0.1, OLD), mk2('oldOnly', 3, 0.1, OLD),
      // `realNow` is off under the engine we actually run
      mk2('realNow', 4, 0.3, S.LEG_VERSION), mk2('realNow', 5, 0.3, S.LEG_VERSION),
    ];
    const ranked = S.persistentlyWorst(cells, { windowDays: 5 });
    eq(ranked[0].cellKey, 'realNow',
      'F19 what TODAY\'S engine saw ranks first — three bad days under a corrected leg are not evidence');
    eq(ranked[1].cellKey, 'oldOnly', 'F20 …and the old readings are ranked below, never thrown away');
    eq(ranked[1].daysWithDisagreement, 3, 'F21 …with their honest day count intact');

    // F22 — AND IT COSTS NOTHING ON A SERIES WITH NO STAMPS, which is every series that exists today:
    // every entry scores 0 on the new first key, so the order falls through to exactly what it was.
    const legacy = [
      mk2('lo', 1, 0.2), mk2('lo', 2, 0.3), mk2('lo', 3, 0.25),
      mk2('mid', 1, 0.5), mk2('mid', 2, 1), mk2('mid', 3, 1),
      mk2('clean', 1, 1), mk2('clean', 2, 1),
    ];
    deep(S.persistentlyWorst(legacy, { windowDays: 3 }).map((x) => x.cellKey), ['lo', 'mid', 'clean'],
      'F22 an unstamped series ranks exactly as it always did — the change is free until there is something to rank on');

    // F24 — THE TIE-BREAK IS LOAD-BEARING, and nothing could see it until this case existed. The new
    // first key is what today's engine saw; on a series with no stamps at all every cell scores 0
    // there, and the honest total day-count is what must decide next. Both cells below end on the same
    // latest rate and the same (absent) worst gap, so ONLY that count can order them — and `oneBadDay`
    // is listed first, so an implementation that dropped the tie-break would leave it first.
    const raw = (key, d, rate, dis) => ({
      dayMs: d * DAY, dimension: 'fico', cellKey: key, cellLabel: key,
      agreementRate: rate, disagreed: dis, worstAbsMilli: null,
    });
    const tie = [
      raw('oneBadDay', 1, 1, 0), raw('oneBadDay', 2, 1, 0), raw('oneBadDay', 3, 0.5, 1),
      raw('offEveryDay', 1, 0.5, 1), raw('offEveryDay', 2, 0.5, 1), raw('offEveryDay', 3, 0.5, 1),
    ];
    const tieRanked = S.persistentlyWorst(tie, { windowDays: 3 });
    eq(tieRanked[0].cellKey, 'offEveryDay',
      'F24 with nothing stamped, the cell off on every day still ranks above the one bad afternoon');
    eq(tieRanked[0].daysWithDisagreementCurrentLeg, tieRanked[1].daysWithDisagreementCurrentLeg,
      'F24a …and it is NOT the new key deciding it — both scored zero there');
    eq(tieRanked[0].latestAgreementRate, tieRanked[1].latestAgreementRate,
      'F24b …nor the latest rate, which is identical: only the honest day count can order these two');

    // F23 — the WRITER stamps, and from the constant. A stamp a caller can pass is one a caller can
    // forget, and a forgotten stamp reads as "taken before the fix".
    const built = S.rowsFromMatrix({ dimensions: [{ dimension: 'fico', kind: 'band', cells: [{ key: 'k', label: 'k', total: 1, agreed: 1, agreementRate: 1 }] }] },
      { legVersion: 'forged/9.99' });
    eq(built.rows[0].legVersion, S.LEG_VERSION, 'F23 every row written carries today\'s stamp, and an opts value does not win');
  }

  console.log(`ok - lt ppe parity cell series (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
