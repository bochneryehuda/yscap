'use strict';
/**
 * LT PPE — the durable bridge for the shadow RUN-RECORD series (§10.5/§11 of
 * docs/longterm/PPE-MEGA-PLAN.md). Persists to `lt_ppe_shadow_run` (db/565) what the canary
 * (canary.js) emits per run — the `{ dayMs, agreementRate, findingKeys, summary }` runRecord — and
 * reads a series back in exactly that shape so the cutover scoreboard can be assembled over TIME.
 *
 * ONE DEFINITION: this bridge does NOT aggregate. `assembleScoreboard` loads a series via `listRuns`
 * and DELEGATES to `scoreboard.assemble` — the same discipline finding-store uses delegating to
 * finding.reconcile — so day-bucketing, the daily agreement rate, the new-findings trend and the
 * cutover-eligibility verdict all keep their single definition in scoreboard.js. `day_ms` is stored
 * VERBATIM (never pre-bucketed), so a round-trip through the store is byte-faithful and adds no second
 * aggregation.
 *
 * `db` is an injected pg pool/client exposing `.query(text, params)` — same convention as
 * finding-store.js / store.js. Everything is `scope`-scoped (multi-tenant); investor/program are
 * normalized to '' (a company-wide run) so the NULL-safe unique key upserts correctly. LT-only; no RTL
 * imports.
 */

const scoreboard = require('./scoreboard');

function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }
// A run's dayMs is an epoch-ms integer (~1.7e12), well within Number's safe range; BIGINT comes back
// from pg as a string, so parse it. Returns a finite number or null.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normLabel(v) { return v == null ? '' : String(v); }

// DB row -> the scoreboard runRecord contract { dayMs, agreementRate, findingKeys, summary }.
// (investor/program are scoping columns, not part of the scoreboard contract — they are query filters.)
function rowToRunRecord(row) {
  return {
    dayMs: num(row.day_ms),
    agreementRate: row.agreement_rate == null ? null : num(row.agreement_rate),
    findingKeys: Array.isArray(row.finding_keys) ? row.finding_keys.filter((k) => typeof k === 'string' && k) : [],
    summary: row.summary == null ? null : row.summary,
  };
}

/**
 * UPSERT one run record for a (scope, investor, program) series. A re-persist of the SAME run (same
 * day_ms) overwrites the mutable measures (agreement_rate / finding_keys / summary / program_id) — the
 * freshest measure of that run wins — and never duplicates the row.
 *   runRecord: { dayMs, agreementRate?, findingKeys?, summary? } (the canary's runRecord).
 *   opts: { db, investor, program, programId } — investor/program default to '' (a company-wide run).
 * Returns { persisted:true, dayMs } — or { persisted:false, reason } when the run has no finite dayMs
 * (a run we cannot place in time is not storable in a time series; fail closed, never a bogus row).
 */
async function persistRun(scope, runRecord = {}, opts = {}) {
  const db = opts.db;
  const dayMs = num(runRecord.dayMs);
  if (dayMs == null) return { persisted: false, reason: 'no_day_ms' };
  const investor = normLabel(opts.investor);
  const program = normLabel(opts.program);
  const agreementRate = isFiniteNum(runRecord.agreementRate) ? runRecord.agreementRate : null;
  const findingKeys = Array.isArray(runRecord.findingKeys)
    ? Array.from(new Set(runRecord.findingKeys.filter((k) => typeof k === 'string' && k))).sort()
    : [];
  const summary = runRecord.summary == null ? null : runRecord.summary;
  await db.query(
    `INSERT INTO lt_ppe_shadow_run
       (scope, investor, program, program_id, day_ms, agreement_rate, finding_keys, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
     ON CONFLICT (scope, investor, program, day_ms) DO UPDATE SET
       program_id     = COALESCE(EXCLUDED.program_id, lt_ppe_shadow_run.program_id),
       agreement_rate = EXCLUDED.agreement_rate,
       finding_keys   = EXCLUDED.finding_keys,
       summary        = EXCLUDED.summary,
       updated_at     = now()`,
    [scope, investor, program, opts.programId || null, dayMs, agreementRate,
      JSON.stringify(findingKeys), summary == null ? null : JSON.stringify(summary)],
  );
  return { persisted: true, dayMs };
}

/**
 * Load a (scope, investor, program) run series, oldest run first, mapped back into the exact scoreboard
 * runRecord contract. opts: { db, investor, program, sinceMs }. sinceMs (inclusive) bounds the window.
 */
async function listRuns(scope, opts = {}) {
  const db = opts.db;
  const investor = normLabel(opts.investor);
  const program = normLabel(opts.program);
  const params = [scope, investor, program];
  let where = 'scope = $1 AND investor = $2 AND program = $3';
  const sinceMs = num(opts.sinceMs);
  if (sinceMs != null) { params.push(sinceMs); where += ` AND day_ms >= $${params.length}`; }
  const { rows } = await db.query(
    `SELECT day_ms, agreement_rate, finding_keys, summary
       FROM lt_ppe_shadow_run
      WHERE ${where}
      ORDER BY day_ms ASC`,
    params,
  );
  return rows.map(rowToRunRecord);
}

/**
 * WHICH RUN SERIES EXIST FOR THIS INVESTOR, and how big each one is.
 *
 * ⛔ WHY THIS HAD TO EXIST (§2.83). A run is keyed `(scope, investor, program)` and `listRuns` matches
 * `program` by EQUALITY. The canary writes `programLabel(program)` — which resolves to the RATE-SHEET
 * VERSION ID — while the go-live screen asks `/ppe/scoreboard?investor=X` with no program at all, so the
 * picture defaults it to `''`. The two never match. Measured against the real table: one run written
 * under the canary's key, `listRuns(program: '')` returns ZERO, and the gate answers *"no canary run has
 * proven 100% agreement"* — which reads as "the canary has never run" when it has run and its work is
 * filed one shelf over.
 *
 * This does NOT decide which key is right — that is a business question about what a clean-day streak is
 * measured against (see the module note in cutover.js and the owner question recorded with it). It makes
 * the dead end LEGIBLE: a screen that finds nothing can now say what it did find elsewhere, instead of
 * reporting an absence it manufactured.
 *
 * Returns [{ program, runs, firstDayMs, lastDayMs }] ordered by most-recent first. NEVER throws — an
 * unreadable answer is an empty list, because this is a diagnostic and must not be able to break the
 * picture it is explaining.
 */
async function listSeriesKeys(scope, opts = {}) {
  const db = opts.db;
  const investor = normLabel(opts.investor);
  try {
    const { rows } = await db.query(
      `SELECT program, COUNT(*)::int AS runs, MIN(day_ms)::bigint AS first_day_ms, MAX(day_ms)::bigint AS last_day_ms
         FROM lt_ppe_shadow_run
        WHERE scope = $1 AND investor = $2
        GROUP BY program
        ORDER BY MAX(day_ms) DESC`,
      [scope, investor],
    );
    return rows.map((r) => ({
      program: r.program == null ? '' : String(r.program),
      runs: Number(r.runs) || 0,
      firstDayMs: num(r.first_day_ms),
      lastDayMs: num(r.last_day_ms),
    }));
  } catch (_) { return []; }
}

/**
 * Load the persisted run series and DELEGATE to scoreboard.assemble — the ONE definition of the daily
 * agreement rate, the new-findings trend and the cutover-eligibility verdict. This bridge adds no
 * aggregation of its own, so assembleScoreboard(persisted) === scoreboard.assemble(the same runs).
 *   opts: { db, investor, program, sinceMs, findings, settings, nowMs, trendWindow }.
 * `findings` is the current findings ledger (from finding-store); everything else is scoreboard's.
 */
async function assembleScoreboard(scope, opts = {}) {
  const runs = await listRuns(scope, opts);
  return scoreboard.assemble(runs, Array.isArray(opts.findings) ? opts.findings : [], {
    settings: opts.settings || {},
    nowMs: opts.nowMs,
    trendWindow: opts.trendWindow,
  });
}

module.exports = { rowToRunRecord, persistRun, listRuns, listSeriesKeys, assembleScoreboard };
