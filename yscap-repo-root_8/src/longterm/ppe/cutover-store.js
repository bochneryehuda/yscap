'use strict';
/**
 * LT PPE — the durable bridge for the cutover DECISION LEDGER (§11 of
 * docs/longterm/PPE-MEGA-PLAN.md). Persists to `lt_ppe_cutover_ledger` (db/566) the lifecycle moves
 * `cutover-ledger.js` produces — draft → shadow → live → retired — and reads a history back in exactly
 * the shape that module consumes, so the whole promote/rollback story survives a restart.
 *
 * ONE DEFINITION, TWICE OVER. This bridge decides NOTHING. `appendDecision` loads the history, hands it
 * to `cutoverLedger.applyDecision` — which in turn delegates legality to `cutover.transition` — and
 * writes back whatever entry that produced. So "may this investor go live?" has ONE answer in this
 * codebase, reached through the same path a screen, a test and a cron all take. The same discipline
 * run-store.js follows delegating aggregation to scoreboard.assemble: the SQL here never re-implements
 * a rule, because a rule with a second copy in SQL is a rule that will drift and take the more
 * dangerous branch with it.
 *
 * APPEND-ONLY. There is exactly one write and it is an INSERT — no UPDATE, no DELETE, no upsert. A
 * governance trail that can be edited is not a trail, and a correction is a NEW decision (`rollback` /
 * `reopen` exist for exactly that) rather than a rewrite of the record of the first one. `verifyHistory`
 * re-derives the whole sequence from DRAFT so a tampered or partially-restored ledger is DETECTED
 * rather than trusted.
 *
 * `db` is an injected pg pool/client exposing `.query(text, params)` — same convention as
 * finding-store.js / run-store.js / store.js. Everything is `scope`-scoped (multi-tenant); investor is
 * normalized to '' (a company-wide lifecycle) so the NULL-safe unique key works. LT-only; no RTL
 * imports.
 */

const cutover = require('./cutover');
const cutoverLedger = require('./cutover-ledger');

// Postgres returns BIGINT as a string and NUMERIC as a string; epoch-ms (~1.7e12) is well inside
// Number's safe range, so parse it. Returns a finite number or null.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normLabel(v) { return v == null ? '' : String(v); }

/**
 * DB row -> the cutover-ledger entry contract { seq, action, from, to, by, atMs, reason, eligible,
 * scoreboard }. The column names are deliberately NOT the entry's field names (`from`/`to` are SQL
 * reserved-ish and `by` is meaningless as a column), so this mapping is the one place the two
 * vocabularies meet — every reader goes through it rather than reading raw rows.
 */
function rowToEntry(row) {
  return {
    seq: num(row.seq),
    action: row.action,
    from: row.from_mode,
    to: row.to_mode,
    by: row.decided_by,
    atMs: num(row.decided_at),
    reason: row.reason,
    eligible: row.eligible === true,
    scoreboard: row.scoreboard == null ? null : row.scoreboard,
  };
}

/** Load one (scope, investor) lifecycle, OLDEST FIRST — the order validateHistory replays in. */
async function listHistory(scope, opts = {}) {
  const db = opts.db;
  const { rows } = await db.query(
    `SELECT seq, action, from_mode, to_mode, decided_by, decided_at, reason, eligible, scoreboard
       FROM lt_ppe_cutover_ledger
      WHERE scope = $1 AND investor = $2
      ORDER BY seq ASC`,
    [scope, normLabel(opts.investor)],
  );
  return rows.map(rowToEntry);
}

/** The investor's mode right now, straight from the persisted history. Empty history = DRAFT. */
async function currentMode(scope, opts = {}) {
  return cutoverLedger.currentMode(await listHistory(scope, opts));
}

/**
 * Append one lifecycle decision, durably.
 *   decision: { action, by, atMs, reason, eligible?, scoreboard? } — cutover-ledger's own contract.
 *   opts: { db, investor }
 * Returns { ok, entry, mode, error, conflict } — on refusal NOTHING is written and the error is the
 * rule's own wording, so a caller never has to guess which requirement it missed.
 *
 * THE RACE IS HANDLED BY THE DATABASE, NOT BY HOPE. `seq` comes from the history we just read, so two
 * admins deciding at the same instant both compute the same next number. The UNIQUE (scope, investor,
 * seq) refuses the loser (23505) and we report `conflict:true` — "someone else just decided, re-read
 * and try again" — rather than letting two contradictory decisions both claim to be step 4, or
 * silently overwriting one with the other. That duplicate-key error is the guard doing its job; the
 * caller retries against the NEW history, where the rule may legitimately give a different answer.
 */
async function appendDecision(scope, decision = {}, opts = {}) {
  const db = opts.db;
  const investor = normLabel(opts.investor);
  const history = await listHistory(scope, opts);

  // The legality question is NOT asked here. applyDecision → cutover.transition owns it.
  const applied = cutoverLedger.applyDecision(history, decision);
  if (!applied.ok) {
    return { ok: false, entry: null, mode: cutoverLedger.currentMode(history), error: applied.error, conflict: false };
  }
  const e = applied.entry;

  try {
    await db.query(
      `INSERT INTO lt_ppe_cutover_ledger
         (scope, investor, seq, action, from_mode, to_mode, decided_by, decided_at, reason, eligible, scoreboard)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [scope, investor, e.seq, e.action, e.from, e.to, e.by, e.atMs, e.reason, e.eligible === true,
        e.scoreboard == null ? null : JSON.stringify(e.scoreboard)],
    );
  } catch (err) {
    if (err && String(err.code) === '23505') {
      return {
        ok: false,
        entry: null,
        mode: cutoverLedger.currentMode(history),
        error: 'Another decision was recorded for this investor while this one was being made. Re-read the history and try again.',
        conflict: true,
      };
    }
    throw err;
  }
  return { ok: true, entry: e, mode: e.to, error: null, conflict: false };
}

/**
 * Replay the persisted history from DRAFT and confirm every step is legal and consistent — the
 * tamper/restore check. DELEGATES to cutover-ledger.validateHistory (one definition); this only
 * supplies the rows.
 */
async function verifyHistory(scope, opts = {}) {
  return cutoverLedger.validateHistory(await listHistory(scope, opts));
}

/**
 * The one-glance lifecycle summary for an admin surface, with the history it was computed from.
 * DELEGATES to cutover-ledger.summarize. `nowMs` is injected so "days in this mode" is testable.
 */
async function loadSummary(scope, opts = {}) {
  const history = await listHistory(scope, opts);
  return { ...cutoverLedger.summarize(history, { nowMs: opts.nowMs }), history };
}

module.exports = {
  MODES: cutover.MODES,
  rowToEntry, listHistory, currentMode, appendDecision, verifyHistory, loadSummary,
};
