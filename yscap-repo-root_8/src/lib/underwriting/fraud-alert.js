'use strict';
/**
 * Major-fraud alert (R3.14, owner-directed 2026-07-22).
 *
 * When a file carries a HIGH-confidence fraud signal — a fatal-severity
 * assignment_fraud, authenticity, or bank_account_other_entity AI
 * suggestion, OR a document-authenticity high-alert score — PILOT should
 * pin an admin banner on the file view AND notify admins ONCE per file per
 * signal (dedupe by suggestion id).
 *
 * Never blocks the file, never overrides anything (HARD RULE) — the alert
 * is a *notice* the admin decides on.
 */

let _db = null;
const db = () => (_db || (_db = require('../../db')));

const HIGH_CONF_SOURCES = new Set(['assignment_fraud', 'authenticity']);

/**
 * Return the OPEN high-severity fraud/authenticity signals on a file that
 * warrant an admin alert. Best-effort — silent on DB errors.
 * @returns {Promise<Array<{id, source, title, severity, confidence, created_at}>>}
 */
async function openMajorSignals(appId, client) {
  if (!appId) return [];
  const c = client || db();
  try {
    const r = await c.query(
      `SELECT id, source, title, severity, confidence, created_at
         FROM ai_suggestions
        WHERE application_id=$1
          AND status IN ('open','marked_important','escalated')
          AND (
                (source = 'assignment_fraud' AND severity = 'fatal')
             OR (source = 'authenticity' AND severity = 'fatal')
             OR (source = 'cure_analysis' AND severity = 'fatal' AND evidence->>'code' = 'bank_account_other_entity')
          )
        ORDER BY created_at DESC`, [appId]);
    return r.rows;
  } catch (_) { return []; }
}

/**
 * Compose the banner payload for the file view. Silent (returns null) when
 * nothing is elevated. Runs off the same OPEN suggestions the panel shows.
 * @returns {Promise<null|{level:'critical'|'high', signals:Array, headline:string}>}
 */
async function fileBanner(appId, client) {
  const signals = await openMajorSignals(appId, client);
  if (!signals.length) return null;
  // R3.32 — snooze: latest audit_log 'fraud_banner_snoozed' stamp whose `until`
  // is in the future suppresses the BANNER (the underlying suggestions still
  // show in the AI Findings panel). Silent if no valid stamp.
  try {
    const c = client || db();
    const s = await c.query(
      `SELECT detail FROM audit_log
        WHERE action='fraud_banner_snoozed' AND entity_type='application' AND entity_id=$1
        ORDER BY created_at DESC LIMIT 1`, [appId]);
    const until = s.rows[0] && s.rows[0].detail && s.rows[0].detail.until;
    if (until && new Date(until).getTime() > Date.now()) return null;
  } catch (_) { /* audit-log read failure never surfaces */ }
  const level = signals.some((s) => s.severity === 'fatal') ? 'critical' : 'high';
  const headline = signals.length === 1
    ? signals[0].title
    : `${signals.length} major fraud / authenticity signals on this file`;
  return { level, signals, headline };
}

/**
 * Send the one-time admin alert for a signal. Idempotent per (appId, suggestionId):
 * writes an audit_log stamp that lets a background sweep detect + notify only NEW
 * signals. This function is safe to call on every file-view load (dedupe absorbs
 * repeats).
 * @returns {Promise<{ok:boolean, sent:boolean}>}
 */
async function alertAdminsOncePerSignal(appId, signal, opts = {}) {
  if (!appId || !signal || !signal.id) return { ok: false, sent: false };
  const c = db();
  try {
    // Reserve the audit stamp — the UNIQUE (action, entity_id) ensures ONE row.
    // audit_log has no unique index on (action, entity_id) by default so we use
    // a straight INSERT + swallow the duplicate via SELECT-first.
    const key = `fraud_alert:${signal.source}:${signal.id}`;
    const exists = await c.query(
      `SELECT 1 FROM audit_log WHERE action=$1 AND entity_type='application' AND entity_id=$2 LIMIT 1`,
      [key, appId]);
    if (exists.rows[0]) return { ok: true, sent: false };   // already alerted
    await c.query(
      `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
       VALUES ('system',$1,'application',$2,$3::jsonb)`,
      [key, appId, JSON.stringify({ signal, at: new Date().toISOString() })]);

    // Best-effort notify — admins get an in-app + email. Never fails the caller.
    try {
      const notify = require('../notify');
      await notify.notifyAdmins({
        type: 'workflow_alert',
        title: `⚠ PILOT: major fraud / authenticity signal on a file`,
        body: `PILOT surfaced a "${signal.title}" (${signal.severity}) on a file. Open the AI Findings panel to review; the AI did NOT change anything on the file.`,
        applicationId: appId, link: opts.link,
        meta: { Source: signal.source, Confidence: signal.confidence != null ? Math.round(signal.confidence * 100) + '%' : 'n/a' },
      });
    } catch (_) { /* best-effort */ }

    return { ok: true, sent: true };
  } catch (_) { return { ok: false, sent: false }; }
}

module.exports = { openMajorSignals, fileBanner, alertAdminsOncePerSignal, HIGH_CONF_SOURCES };
