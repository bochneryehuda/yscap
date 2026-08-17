'use strict';
/**
 * LT PPE — the PER-CELL PARITY SERIES (db/575). The durable half of P9.
 *
 * The parity matrix measures WHERE two engines disagree; this remembers it, run after run, so the
 * question the cutover decision actually turns on can be answered: **has this band been off for three
 * weeks, or was that one bad afternoon?** `lt_ppe_shadow_run` keeps a single agreement rate per day,
 * from which per-cell history cannot be recovered at any later date.
 *
 * TWO RULES RUN THROUGH EVERY FUNCTION HERE, and they are the same rule twice:
 *
 *   1. A MISSING ROW MEANS "NOT MEASURED", NEVER "MEASURED BADLY". A run whose scenarios happened to
 *      include no loans in the 640–660 band writes no row for it that day. Filling that gap with a
 *      zero would report a band nobody priced as one that failed completely, and the trend would then
 *      show a collapse that never happened. Gaps are reported as gaps (`daysMeasured` vs the window),
 *      never interpolated and never zero-filled.
 *   2. IT MEASURES; IT NEVER DECIDES. Nothing here holds a threshold. What counts as "clean enough"
 *      is the owner's (master plan Part 4.2/4.3) and belongs to the cutover gate; a reader ranks and
 *      counts, and the direction of a series is delegated to `scoreboard.trend` so there is exactly
 *      ONE definition of "improving" in this codebase.
 *
 * LT-only. No RTL imports.
 */

const scoreboard = require('./scoreboard');

// A 500-scenario run across seven axes can produce well over a thousand cells. Bounded so one canary
// cannot write an unbounded batch — and the overflow is REPORTED, never silently dropped, because a
// series quietly missing its tail reads as a clean stretch.
const MAX_CELLS_PER_RUN = 2000;

function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v) { const n = num(v); return n == null ? 0 : Math.round(n); }
function normLabel(v) { return v == null ? '' : String(v); }

/**
 * Flatten a parity matrix into the row shape this table stores. PURE — no DB — so the shape is
 * testable without one, and so the caller can see exactly what would be written.
 * Returns { rows, truncated } — `truncated` is how many cells did not fit the per-run cap.
 */
function rowsFromMatrix(matrix, opts = {}) {
  const dims = (matrix && Array.isArray(matrix.dimensions)) ? matrix.dimensions : [];
  const rows = [];
  let truncated = 0;
  for (const d of dims) {
    for (const c of ((d && Array.isArray(d.cells)) ? d.cells : [])) {
      if (!c || c.key == null) continue;
      if (rows.length >= MAX_CELLS_PER_RUN) { truncated += 1; continue; }
      const pd = c.priceDelta || {};
      rows.push({
        dimension: String(d.dimension),
        cellKey: String(c.key),
        cellLabel: String(c.label == null ? c.key : c.label),
        kind: d.kind === 'band' ? 'band' : 'category',
        total: int(c.total),
        agreed: int(c.agreed),
        disagreed: int(c.disagreed),
        errors: int(c.errors),
        incomparable: int(c.incomparable),
        overlay: int(c.overlay),
        agreementRate: isFiniteNum(c.agreementRate) ? c.agreementRate : null,
        priceScenarios: int(pd.scenarios),
        priceSamples: int(pd.samples),
        worstAbsMilli: isFiniteNum(pd.worstAbsMilli) ? Math.round(pd.worstAbsMilli) : null,
        meanMilli: isFiniteNum(pd.meanMilli) ? pd.meanMilli : null,
      });
    }
  }
  return { rows, truncated, dimensions: dims.length };
}

/**
 * Persist one run's cells.
 *   matrix — parity-matrix.buildParityMatrix output.
 *   opts   — { db, investor, program, programId, dayMs }
 * Re-persisting the SAME run (same day) UPSERTs on the natural key — the freshest measure of that run
 * wins and no row is duplicated, exactly as `run-store.persistRun` behaves for the daily aggregate.
 * Returns { persisted, rows, truncated, reason? }. A run with no finite dayMs is REFUSED rather than
 * stored under a made-up date: a measurement we cannot place in time is not a series entry.
 */
async function persistCells(scope, matrix, opts = {}) {
  const db = opts.db;
  const dayMs = num(opts.dayMs);
  if (dayMs == null) return { persisted: false, rows: 0, truncated: 0, reason: 'no_day_ms' };
  const { rows, truncated } = rowsFromMatrix(matrix, opts);
  if (!rows.length) return { persisted: true, rows: 0, truncated, reason: rows.length ? null : 'no_cells' };

  const investor = normLabel(opts.investor);
  const program = normLabel(opts.program);
  const programId = opts.programId || null;

  for (const r of rows) {
    await db.query(
      `INSERT INTO lt_ppe_parity_cell
         (scope, investor, program, program_id, day_ms, dimension, cell_key, cell_label, kind,
          total, agreed, disagreed, errors, incomparable, overlay, agreement_rate,
          price_scenarios, price_samples, worst_abs_milli, mean_milli)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (scope, investor, program, day_ms, dimension, cell_key) DO UPDATE SET
         program_id      = COALESCE(EXCLUDED.program_id, lt_ppe_parity_cell.program_id),
         cell_label      = EXCLUDED.cell_label,
         kind            = EXCLUDED.kind,
         total           = EXCLUDED.total,
         agreed          = EXCLUDED.agreed,
         disagreed       = EXCLUDED.disagreed,
         errors          = EXCLUDED.errors,
         incomparable    = EXCLUDED.incomparable,
         overlay         = EXCLUDED.overlay,
         agreement_rate  = EXCLUDED.agreement_rate,
         price_scenarios = EXCLUDED.price_scenarios,
         price_samples   = EXCLUDED.price_samples,
         worst_abs_milli = EXCLUDED.worst_abs_milli,
         mean_milli      = EXCLUDED.mean_milli,
         updated_at      = now()`,
      [scope, investor, program, programId, dayMs, r.dimension, r.cellKey, r.cellLabel, r.kind,
        r.total, r.agreed, r.disagreed, r.errors, r.incomparable, r.overlay, r.agreementRate,
        r.priceScenarios, r.priceSamples, r.worstAbsMilli, r.meanMilli],
    );
  }
  return { persisted: true, rows: rows.length, truncated };
}

// A stored row → the reading shape. Postgres returns NUMERIC as a string; `num` is what keeps an
// agreement rate from arriving as "0.5" and silently failing every arithmetic comparison downstream.
function rowToCell(row) {
  return {
    dayMs: num(row.day_ms),
    dimension: row.dimension,
    cellKey: row.cell_key,
    cellLabel: row.cell_label,
    kind: row.kind,
    total: int(row.total),
    agreed: int(row.agreed),
    disagreed: int(row.disagreed),
    errors: int(row.errors),
    incomparable: int(row.incomparable),
    overlay: int(row.overlay),
    agreementRate: num(row.agreement_rate),
    priceScenarios: int(row.price_scenarios),
    priceSamples: int(row.price_samples),
    worstAbsMilli: num(row.worst_abs_milli),
    meanMilli: num(row.mean_milli),
  };
}

/**
 * Read cells for a series, oldest first.
 *   opts — { db, investor, program, dimension?, cellKey?, sinceMs?, limit? }
 * `dimension`/`cellKey` narrow to one cell's history; without them it is every cell in the window.
 */
async function listCells(scope, opts = {}) {
  const db = opts.db;
  const params = [scope, normLabel(opts.investor), normLabel(opts.program)];
  let sql = `SELECT * FROM lt_ppe_parity_cell WHERE scope = $1 AND investor = $2 AND program = $3`;
  if (opts.dimension != null) { params.push(String(opts.dimension)); sql += ` AND dimension = $${params.length}`; }
  if (opts.cellKey != null) { params.push(String(opts.cellKey)); sql += ` AND cell_key = $${params.length}`; }
  const since = num(opts.sinceMs);
  if (since != null) { params.push(since); sql += ` AND day_ms >= $${params.length}`; }
  sql += ' ORDER BY day_ms ASC, dimension ASC, cell_key ASC';
  const lim = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : null;
  if (lim) { params.push(lim); sql += ` LIMIT $${params.length}`; }
  const r = await db.query(sql, params);
  return (r.rows || []).map(rowToCell);
}

// A canary writes ONE (investor, program) pair per run, so the distinct pairs in a window are the
// number of things anybody has ever pointed a canary at — small by nature. Bounded anyway, and the
// caller compares the length against this so a cap is SAID rather than read as "that is all of them".
const MAX_SERIES = 200;

/**
 * WHICH series hold measurements at all, in the window.
 *
 * This exists because `listCells` matches (scope, investor, program) EXACTLY: a canary run against an
 * investor stores that investor's code and a run against nobody stores ''. So a reader that asks for a
 * key the table does not hold gets an empty list back — and an empty list renders as "nothing has been
 * measured" while the table is full of measurements, which is the one thing a parity screen must never
 * say. A reader offers what this returns rather than guessing a key.
 *
 * It reports COUNTS, never a verdict: how many days a series was measured on and when it was last
 * measured. Ordering is most-recently-measured first, which is a recency fact, not a ranking of
 * badness — that is `persistentlyWorst`'s job, and only inside one series.
 */
async function listSeries(scope, opts = {}) {
  const db = opts.db;
  const params = [scope];
  let sql = `SELECT investor, program,
                    COUNT(*)::int AS measurements,
                    COUNT(DISTINCT day_ms)::int AS days,
                    MAX(day_ms) AS last_day_ms,
                    MIN(day_ms) AS first_day_ms
               FROM lt_ppe_parity_cell
              WHERE scope = $1`;
  const since = num(opts.sinceMs);
  if (since != null) { params.push(since); sql += ` AND day_ms >= $${params.length}`; }
  sql += ' GROUP BY investor, program ORDER BY MAX(day_ms) DESC, investor ASC, program ASC';
  params.push(MAX_SERIES);
  sql += ` LIMIT $${params.length}`;
  const r = await db.query(sql, params);
  return (r.rows || []).map((row) => ({
    investor: normLabel(row.investor),
    program: normLabel(row.program),
    measurements: int(row.measurements),
    days: int(row.days),
    lastDayMs: num(row.last_day_ms),
    firstDayMs: num(row.first_day_ms),
  }));
}

/**
 * One cell's history: its measured days, its direction, and how much of the window it was actually
 * measured on.
 *
 * `daysMeasured` vs `windowDays` is the honest half. A cell measured on two of the last twenty days
 * has a direction computed from two points, and presenting that beside a cell measured on all twenty
 * as though they carry the same weight is how a dashboard talks somebody into a cutover. The gap is
 * NEVER zero-filled: a day with no scenarios in a band is an absence of evidence about that band, and
 * a zero would report it as a total failure that never happened.
 *
 * The DIRECTION is `scoreboard.trend` — the same function the investor-level scoreboard uses — so
 * "improving" means one thing in this codebase, not two.
 */
function cellHistory(cells, opts = {}) {
  const list = (Array.isArray(cells) ? cells : []).slice().sort((a, b) => (a.dayMs || 0) - (b.dayMs || 0));
  const days = list.map((c) => ({ dayMs: c.dayMs, agreementRate: c.agreementRate }));
  const measured = list.filter((c) => isFiniteNum(c.agreementRate));
  const latest = measured.length ? measured[measured.length - 1] : null;
  const withDisagreement = measured.filter((c) => c.disagreed > 0).length;
  const worst = measured.reduce((w, c) => (isFiniteNum(c.worstAbsMilli) && (w == null || c.worstAbsMilli > w) ? c.worstAbsMilli : w), null);
  return {
    dimension: list.length ? list[0].dimension : null,
    cellKey: list.length ? list[0].cellKey : null,
    cellLabel: list.length ? list[0].cellLabel : null,
    days,
    daysMeasured: measured.length,
    // How many DISTINCT days this cell was seen on vs how many the caller asked about. A caller that
    // does not say gets null rather than a number implying full coverage.
    windowDays: Number.isInteger(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : null,
    daysWithDisagreement: withDisagreement,
    latestAgreementRate: latest ? latest.agreementRate : null,
    latestDayMs: latest ? latest.dayMs : null,
    worstAbsMilli: worst,
    trend: scoreboard.trend(days, { window: opts.trendWindow }),
  };
}

/**
 * Group a flat cell list into per-cell histories, ranked by how persistently a cell has disagreed.
 *
 * RANKS, NEVER THRESHOLDS. The order is: most days seen disagreeing, then worst latest agreement,
 * then biggest price gap. It never says "this one is bad enough to block a cutover" — that is the
 * tolerance decision that belongs to the owner and to the cutover gate.
 */
function persistentlyWorst(cells, opts = {}) {
  const byCell = new Map();
  for (const c of (Array.isArray(cells) ? cells : [])) {
    if (!c || !c.dimension || c.cellKey == null) continue;
    const k = `${c.dimension}|${c.cellKey}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(c);
  }
  const out = [];
  for (const list of byCell.values()) out.push(cellHistory(list, opts));
  out.sort((a, b) => (b.daysWithDisagreement - a.daysWithDisagreement)
    || ((a.latestAgreementRate == null ? 1 : a.latestAgreementRate) - (b.latestAgreementRate == null ? 1 : b.latestAgreementRate))
    || ((b.worstAbsMilli || 0) - (a.worstAbsMilli || 0)));
  const lim = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 10;
  return out.slice(0, lim);
}

module.exports = {
  persistCells, listCells, listSeries, cellHistory, persistentlyWorst, rowsFromMatrix, rowToCell,
  MAX_CELLS_PER_RUN, MAX_SERIES,
};
