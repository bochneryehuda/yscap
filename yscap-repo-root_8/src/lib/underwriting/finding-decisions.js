'use strict';
/**
 * A HUMAN'S DECISION ON A FINDING IS DURABLE (owner-reported 2026-07-27).
 *
 * "I click Dismiss, or I escalate it and the super-admin grants an exception —
 *  and the finding keeps popping up again. It never actually disappears."
 *
 * ROOT CAUSE (one class, three doors — full write-up in db/333):
 *   1. `ai_suggestions.record()` deduped only against `status='open'`, so a
 *      DISMISSED suggestion was invisible to the dedupe and the next sync pass
 *      (which runs on every file view) inserted a brand-new open row.
 *   2. `document_findings` are re-inserted by every re-analysis with no memory of
 *      the resolution a human recorded on the previous row.
 *   3. The DERIVED desks (tie-out, chains, liquidity, experience, reasonability,
 *      note-buyer guidelines) never had a row at all — pure functions of the file,
 *      recomputed on every view, so a Dismiss had nothing to attach to.
 *
 * THE FIX. Record the decision against the finding's stable IDENTITY (the claim key
 * from finding-claims.js — the same one the desk already uses to merge the six
 * desks that notice one fact), in `finding_decisions`, and have EVERY producer and
 * EVERY reader consult it. Whichever row happens to carry the finding tomorrow, the
 * decision stands.
 *
 * SCOPE. Per FILE and per FINDING — never portfolio-wide (that is
 * `ai_silenced_codes`, db/253, and it stays a super-admin-only escape hatch).
 *
 * SAFETY. Every function is best-effort and NEVER THROWS: a ledger failure must
 * degrade to "the finding shows again" (annoying) and never to a lost analysis or a
 * broken file view. Reads fail OPEN (an unreadable ledger suppresses nothing).
 */

const claims = require('./finding-claims');

// Resolutions that mean "settled — don't raise this again". post_condition and
// request_document deliberately keep a finding OPEN until the follow-up lands, so
// they must never suppress. `decline` closes the finding by declining the LOAN.
const SUPPRESSING_ACTIONS = new Set([
  'dismiss', 'dismissed', 'clear', 'cleared', 'grant_exception', 'exception_granted',
  'fix_file', 'fixed', 'decline', 'declined', 'keep', 'acknowledge', 'replace', 'custom',
  'resolved', 'converted_to_condition', 'converted_to_task', 'noted',
]);
const NON_SUPPRESSING_ACTIONS = new Set([
  'post_condition', 'open_condition', 'request_document', 'request_revision',
  'downgrade_severity', 'upgrade_severity', 'escalate', 'escalated',
  'mark_important', 'marked_important', 'unmark_important', 'ask_admin', 'asked_admin', 'open',
]);

/** Does this verb settle the finding for good? Unknown verbs never suppress. */
function suppresses(action) {
  const a = String(action == null ? '' : action).trim().toLowerCase();
  if (!a) return false;
  if (NON_SUPPRESSING_ACTIONS.has(a)) return false;
  return SUPPRESSING_ACTIONS.has(a);
}

/**
 * The stable identity of a finding — delegated to finding-claims so the ledger and
 * the desk's own de-duplication can never disagree about what "the same finding" is.
 * Accepts a stored `document_findings` row, an `appraisal_findings` row (whose
 * doc-side column is `appraisal_value`), or a freshly-computed derived finding.
 * Returns null when there is nothing stable to key on (no code) — the caller then
 * records nothing rather than guessing.
 */
function keyOf(finding) {
  try {
    const f = finding || {};
    if (!f.code) return null;
    // Normalize the appraisal desk's column name onto the shared shape so both
    // tables produce the same key form (db/333’s backfill matches this exactly).
    const shaped = f.appraisal_value != null && f.docValue == null && f.doc_value == null
      ? Object.assign({}, f, { docValue: f.appraisal_value })
      : f;
    return claims.claimOf(shaped);
  } catch (_) { return null; }
}

/**
 * Run one ledger write so a failure can NEVER poison the caller's transaction.
 *
 * Most callers are mid-transaction (a finding resolve, an appraisal import). A
 * swallowed pg error inside a transaction still leaves that transaction ABORTED,
 * so the caller's COMMIT silently rolls back the real work — the exact trap
 * store.js documents around its evidence + advice passes. So every ledger write
 * runs inside a SAVEPOINT and rolls back only itself. Outside a transaction
 * SAVEPOINT is itself an error; in that case there is nothing to poison, so we
 * just run the statement directly.
 */
async function _guarded(client, fn) {
  let savepoint = false;
  try { await client.query('SAVEPOINT finding_decision'); savepoint = true; }
  catch (_) { savepoint = false; }
  try {
    const out = await fn();
    if (savepoint) await client.query('RELEASE SAVEPOINT finding_decision').catch(() => {});
    return out;
  } catch (_) {
    if (savepoint) await client.query('ROLLBACK TO SAVEPOINT finding_decision').catch(() => {});
    return null;
  }
}

/**
 * Record (or replace) the human decision on one finding.
 * Best-effort — never throws, returns false when nothing was written.
 *
 * @param {*} client pg client/pool
 * @param {{applicationId:string, finding?:object, key?:string, code?:string,
 *          origin?:string, decision:string, note?:string, decidedBy?:string,
 *          suppress?:boolean}} o
 */
async function record(client, o = {}) {
  try {
    if (!client || !o.applicationId) return false;
    const key = o.key || keyOf(o.finding);
    if (!key) return false;
    const decision = String(o.decision || '').trim().toLowerCase() || 'resolved';
    const suppress = typeof o.suppress === 'boolean' ? o.suppress : suppresses(decision);
    const code = o.code || (o.finding && o.finding.code) || null;
    const done = await _guarded(client, () => client.query(
      `INSERT INTO finding_decisions
         (application_id, finding_key, code, origin, decision, suppressed, note, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (application_id, finding_key) DO UPDATE
         SET code = COALESCE(EXCLUDED.code, finding_decisions.code),
             origin = COALESCE(EXCLUDED.origin, finding_decisions.origin),
             decision = EXCLUDED.decision,
             suppressed = EXCLUDED.suppressed,
             note = EXCLUDED.note,
             decided_by = COALESCE(EXCLUDED.decided_by, finding_decisions.decided_by),
             decided_at = now(),
             -- A fresh decision always un-supersedes: this row is live again.
             superseded_at = NULL, superseded_by = NULL,
             updated_at = now()`,
      [o.applicationId, key, code, o.origin || null, decision, suppress,
       o.note != null ? String(o.note).slice(0, 1000) : null, o.decidedBy || null]));
    return done != null;
  } catch (_) { return false; }
}

/**
 * RE-OPEN a finding a human had settled (the "I dismissed that by mistake" door,
 * and what an explicit un-dismiss on the desk calls). Keeps the row for the audit
 * trail; it just stops suppressing. Best-effort, never throws.
 */
async function reopen(client, { applicationId, key, finding, by } = {}) {
  try {
    if (!client || !applicationId) return false;
    const k = key || keyOf(finding);
    if (!k) return false;
    const r = await _guarded(client, () => client.query(
      `UPDATE finding_decisions
          SET suppressed = false, superseded_at = now(), superseded_by = $3, updated_at = now()
        WHERE application_id = $1 AND finding_key = $2 AND superseded_at IS NULL`,
      [applicationId, k, by || null]));
    return !!(r && r.rowCount > 0);
  } catch (_) { return false; }
}

/**
 * The live suppression set for a file: every finding a human already settled.
 * FAILS OPEN — an unreadable ledger returns an empty set, so a DB problem can
 * only ever show MORE findings, never hide one.
 * @returns {Promise<Set<string>>}
 */
async function suppressedKeys(client, applicationId) {
  try {
    if (!client || !applicationId) return new Set();
    // Guarded like the writes: this READ runs inside the document-analysis
    // transaction, and a failing statement aborts the whole transaction — which
    // would roll back the analysis itself on COMMIT.
    const r = await _guarded(client, () => client.query(
      `SELECT finding_key FROM finding_decisions
        WHERE application_id = $1 AND suppressed = true AND superseded_at IS NULL`,
      [applicationId]));
    return new Set(((r && r.rows) || []).map((x) => x.finding_key));
  } catch (_) { return new Set(); }
}

/** The full decision rows for a file (for the "show what was dismissed" view). */
async function decisionsForFile(client, applicationId) {
  try {
    if (!client || !applicationId) return [];
    const r = await _guarded(client, () => client.query(
      `SELECT d.*, s.full_name AS decided_by_name
         FROM finding_decisions d
         LEFT JOIN staff_users s ON s.id = d.decided_by
        WHERE d.application_id = $1
        ORDER BY d.decided_at DESC`, [applicationId]));
    return (r && r.rows) || [];
  } catch (_) { return []; }
}

/** Is this finding already settled? `set` comes from suppressedKeys(). */
function isSuppressed(set, finding) {
  try {
    if (!set || !set.size) return false;
    const k = keyOf(finding);
    return !!(k && set.has(k));
  } catch (_) { return false; }
}

/**
 * Drop every finding a human already settled, and (optionally) hand the dropped
 * ones back so a surface can show them under "already dealt with". Pure + total:
 * a bad input yields the input back untouched.
 */
function filterSuppressed(set, findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (!set || !set.size) return { kept: list, suppressed: [] };
  const kept = [], suppressed = [];
  for (const f of list) (isSuppressed(set, f) ? suppressed : kept).push(f);
  return { kept, suppressed };
}

module.exports = {
  keyOf, record, reopen, suppressedKeys, decisionsForFile, isSuppressed, filterSuppressed,
  suppresses, SUPPRESSING_ACTIONS, NON_SUPPRESSING_ACTIONS,
};
