'use strict';
/**
 * LT PPE — the durable home for a canary SCHEDULE (db/570). The bridge between the pure decision
 * (`canary-schedule.js` — WHEN a canary runs and on WHAT) and the row a human saved.
 *
 * ONE DEFINITION. This bridge decides NOTHING about validity: `save` hands the incoming schedule to
 * `canarySchedule.validateSchedule` and writes only what that accepts, so a schedule the RUNNER would
 * refuse can never reach the table in the first place. Without that, an invalid row would sit there
 * producing the same silent "no_battery" every tick forever — a scheduler that looks configured and
 * has never once run. The database's own CHECKs are deliberately LOOSER than the module (they refuse
 * the absurd: a zero cadence, an unknown battery kind) precisely so they are not a second copy of a
 * rule that would drift; the module's exact bounds are env-tunable and live in one place.
 *
 * THE RULE THIS TABLE EXISTS TO PROTECT: a schedule never invents a battery. `save` therefore has no
 * defaulting behaviour at all — no "if they didn't send scenarios, use the standard matrix". WHICH
 * scenarios are worth measuring is a business judgement about the investor's book, and a battery this
 * code made up would still produce an agreement rate, which then feeds the promote gate.
 *
 * WHAT IS DELIBERATELY ABSENT: a last-run stamp. "When did we last measure this scope?" is already
 * answered by the run series the canary writes (`run-store.listRuns`), and a second answer would
 * drift — the one that drifts is the one the gate reads. It also means a canary an admin fired BY
 * HAND counts toward the cadence, which is correct and would not be true of a private stamp.
 *
 * `db` is an injected pg pool/client exposing `.query(text, params)` — the same convention as
 * cutover-store.js / run-store.js / finding-store.js. Everything is `scope`-scoped (multi-tenant);
 * investor is normalized to '' (a company-wide schedule) so the NULL-safe unique key works.
 * LT-only; no RTL imports.
 */

const canarySchedule = require('./canary-schedule');

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normLabel(v) { return v == null ? '' : String(v); }

/**
 * DB row → the schedule contract `canary-schedule` consumes. The column names are NOT the contract's
 * field names (SQL is snake_case and `battery` is stored split into kind + payload), so this mapping
 * is the ONE place the two vocabularies meet — every reader goes through it rather than reading raw
 * rows, or the decision module would start seeing two different shapes depending on the caller.
 */
function rowToSchedule(row) {
  if (!row) return null;
  const s = {
    scope: row.scope,
    investor: row.investor === '' ? null : row.investor,
    enabled: row.enabled === true,
    intervalMs: num(row.interval_ms),
    rateSheetVersionId: row.rate_sheet_version_id || null,
    concurrency: num(row.concurrency),
    note: row.note || null,
    updatedBy: row.updated_by,
    updatedAt: num(row.updated_at),
  };
  // Exactly one battery shape is set, matching the module's contract — never both, which it refuses.
  if (row.battery_kind === 'matrix') s.matrix = row.battery;
  else s.scenarios = row.battery;
  return s;
}

/** Load one (scope, investor) schedule, or null when none is saved. */
async function loadSchedule(scope, investor, opts = {}) {
  const db = opts.db;
  const r = await db.query(
    `SELECT * FROM lt_ppe_canary_schedule WHERE scope = $1 AND investor = $2 LIMIT 1`,
    [normLabel(scope) || 'company', normLabel(investor)],
  );
  return rowToSchedule(r.rows[0]);
}

/**
 * Every schedule for a scope, oldest-updated first.
 *
 * `enabledOnly` is what the TICK reads. It is a narrowing of the query and NOT a second due-ness
 * rule: `canarySchedule.decide` still has the final say (a disabled schedule reports `disabled`, and
 * the reason is reportable), so the two can never disagree about whether something should run. The
 * filter exists so a tick does not load every paused schedule in the tenant to be told the same
 * thing.
 */
async function listSchedules(scope, opts = {}) {
  const db = opts.db;
  const params = [normLabel(scope) || 'company'];
  let sql = `SELECT * FROM lt_ppe_canary_schedule WHERE scope = $1`;
  if (opts.enabledOnly) sql += ` AND enabled = true`;
  sql += ` ORDER BY updated_at ASC, investor ASC`;
  const r = await db.query(sql, params);
  return r.rows.map(rowToSchedule);
}

/**
 * Save (create or replace) the schedule for one (scope, investor).
 *
 * REFUSES rather than stores an unrunnable schedule, and returns the module's own reason and wording
 * so the person saving it hears exactly what the runner would have said — silently accepting one and
 * discovering at 3am that it has never run is the failure this guards.
 *
 * Returns { ok: true, schedule } or { ok: false, reason, message }.
 */
async function saveSchedule(scope, schedule, opts = {}) {
  const db = opts.db;
  const v = canarySchedule.validateSchedule(schedule);
  if (!v.ok) return { ok: false, reason: v.reason, message: v.message };

  const by = normLabel(opts.by || (schedule && schedule.updatedBy));
  if (!by) {
    // A loop that calls a vendor on a cadence has an owner. Recording who armed it is not
    // bookkeeping: it is the first question asked when it starts costing money or firing wrongly.
    return { ok: false, reason: 'no_author', message: 'Say who is saving this schedule — an automatic vendor loop records who armed it.' };
  }
  const atMs = num(opts.nowMs);
  if (atMs == null) {
    return { ok: false, reason: 'no_clock', message: 'No clock was supplied, so the schedule cannot be stamped.' };
  }

  const kind = v.battery.kind;
  const battery = kind === 'matrix' ? v.battery.matrix : v.battery.scenarios;
  const r = await db.query(
    `INSERT INTO lt_ppe_canary_schedule
       (scope, investor, enabled, interval_ms, battery_kind, battery, rate_sheet_version_id, concurrency, note, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
     ON CONFLICT ON CONSTRAINT lt_ppe_canary_schedule_scope_uk DO UPDATE SET
       enabled = EXCLUDED.enabled,
       interval_ms = EXCLUDED.interval_ms,
       battery_kind = EXCLUDED.battery_kind,
       battery = EXCLUDED.battery,
       rate_sheet_version_id = EXCLUDED.rate_sheet_version_id,
       concurrency = EXCLUDED.concurrency,
       note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      normLabel(scope) || 'company',
      normLabel(schedule && schedule.investor),
      schedule && schedule.enabled === true,      // a real boolean only — a truthy string never arms a vendor loop
      v.intervalMs,
      kind,
      JSON.stringify(battery),
      (schedule && schedule.rateSheetVersionId) || null,
      canarySchedule._internals.posInt(schedule && schedule.concurrency),
      (schedule && schedule.note) ? String(schedule.note) : null,
      by,
      atMs,
    ],
  );
  return { ok: true, schedule: rowToSchedule(r.rows[0]) };
}

/** Remove a saved schedule. Returns { ok, removed } — removing one that is not there is not an error. */
async function deleteSchedule(scope, investor, opts = {}) {
  const db = opts.db;
  const r = await db.query(
    `DELETE FROM lt_ppe_canary_schedule WHERE scope = $1 AND investor = $2`,
    [normLabel(scope) || 'company', normLabel(investor)],
  );
  return { ok: true, removed: r.rowCount > 0 };
}

module.exports = { loadSchedule, listSchedules, saveSchedule, deleteSchedule, rowToSchedule };
