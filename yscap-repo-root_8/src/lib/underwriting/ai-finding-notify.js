'use strict';
/**
 * ai-finding-notify — retire the `ai_fatal_finding` in-app notification when its
 * underlying AI finding is no longer live (owner-reported 2026-08-06, seen "on a lot
 * of files": the "loan_amount is missing" and "silver is not a valid program" fatal
 * notifications kept showing even though #1034 fixed both underlying findings).
 *
 * ROOT CAUSE. `ai-suggestions._notifyFatalNew` writes an `ai_fatal_finding` notification
 * when a fatal AI finding is FIRST raised — but nothing ever cleared it. The FINDING
 * itself self-heals: `ai-narrative.retractOpen` dismisses the `ai_suggestions` row on the
 * next file view once the file's grounding changed (which #1034 did — it re-worded the
 * grounding so the reasoner no longer produces either concern). But the NOTIFICATION is a
 * separate row in a separate table with no link back to the finding's lifecycle, so a
 * finding that was fixed in code kept sitting in the owner's list as an unread fatal.
 *
 * THE CLASS. Whenever a finding is retracted or a human settles it, its notification must
 * be retired too — otherwise "I dismissed it and it's still in my list" recurs for every
 * future finding producer. So the retire runs at the two chokepoints where an
 * `ai_suggestions` finding leaves the OPEN set (`retractOpen` + `decide`), keyed on the
 * finding id the notification's own deep link already carries.
 *
 * HOW THE JOIN WORKS. `_notifyFatalNew` builds the link `/internal/app/<app>?finding=<id>`
 * (that id is the `ai_suggestions.id`), so a notification is matched to its finding by
 * that id. We "retire" by setting `read_at` — NEVER a delete, so the audit trail is kept
 * exactly like every other read notification.
 */

let _db = null;
const db = () => (_db || (_db = require('../../db')));

const NOTIF_TYPE = 'ai_fatal_finding';

// The statuses that mean "this finding has been SETTLED" — a human dismissed it, turned it
// into a condition/task, or noted it as handled. Deliberately NOT `escalated` /
// `marked_important` / `asked_admin` (those mean "still needs handling, louder", so the
// notification stays), nor `open`/`answered`. Mirrors `ai-suggestions.record()`'s own
// "settling verbs" set and the backfill below, so the three can never drift.
const SETTLED_STATUSES = ['dismissed', 'converted_to_condition', 'converted_to_task', 'noted'];

/**
 * Retire (mark read) every `ai_fatal_finding` notification whose deep link points at one
 * of the given `ai_suggestions` ids on this file. A no-op for a suggestion that never had
 * a fatal notification (only fatal findings ever get one). NEVER throws.
 *
 * @param {*} client   pg client (transaction honored)
 * @param {string} appId
 * @param {string[]} suggestionIds
 * @returns {Promise<number>} rows retired
 */
async function retireForSuggestions(client, appId, suggestionIds) {
  const c = client || db();
  const ids = (Array.isArray(suggestionIds) ? suggestionIds : [suggestionIds])
    .map((x) => String(x || '').trim()).filter(Boolean);
  if (!appId || !ids.length) return 0;
  try {
    // Match on the id embedded in the deep link. A UUID is fixed-length and cannot be a
    // prefix of another UUID, so `%finding=<id>%` is unambiguous.
    const patterns = ids.map((id) => `%finding=${id}%`);
    const r = await c.query(
      `UPDATE notifications
          SET read_at = now()
        WHERE type = $1
          AND recipient_kind = 'staff'
          AND application_id = $2
          AND read_at IS NULL
          AND link LIKE ANY($3::text[])`,
      [NOTIF_TYPE, appId, patterns]);
    return r.rowCount || 0;
  } catch (e) {
    // Best-effort — a notification-retire failure must never reverse the finding decision
    // that triggered it.
    try { console.error('[ai-finding-notify] retireForSuggestions', appId, (e && e.message) || e); } catch (_) { /* noop */ }
    return 0;
  }
}

/**
 * ONE-SHOT BACKFILL (previous AND future rule). #1034 was grounding-only and shipped no
 * clean-up, so the back book carries two kinds of stale `ai_fatal_finding` notifications:
 *
 *   (1) the two findings the owner reported — "silver is not a valid program" and
 *       "loan_amount is missing while $X is present" — whose PREMISE is now false, so the
 *       notification is stale whether or not the file has been re-viewed yet; and
 *   (2) any fatal notification whose linked finding was ALREADY settled (a human decided
 *       it, or `retractOpen` self-healed it on a re-view that predates the going-forward
 *       wiring above) but whose notification lingered.
 *
 * Both arms only ever set `read_at` on an UNREAD row, so the pass is self-draining (a
 * retired row can't match again) and idempotent. Bounded per boot. NEVER throws. The
 * FINDING rows are deliberately left alone — they self-heal on the next file view via
 * `ai-narrative`'s grounding-hash memo, and touching an advisory finding row risks
 * suppressing a legitimate one; retiring a read-flag is the reversible, low-risk half.
 *
 * Off switch: AI_FATAL_NOTIF_SWEEP_DISABLED=1.
 *
 * @returns {Promise<{retiredStale:number, retiredSettled:number, skipped?:string}>}
 */
async function retireStaleFatalNotificationsOnce(dbClient) {
  const c = dbClient || db();
  const out = { retiredStale: 0, retiredSettled: 0 };
  if (String(process.env.AI_FATAL_NOTIF_SWEEP_DISABLED || '') === '1') return { ...out, skipped: 'disabled' };
  const LIMIT = Math.max(1, parseInt(process.env.AI_FATAL_NOTIF_SWEEP_LIMIT || '5000', 10) || 5000);

  // ---- Arm 1: the two provably-false stale phrasings the owner reported. The notification
  // BODY embeds the finding title (`AI detected a fatal issue on this file: "<title>". …`).
  //   * silver  — the finding asserts silver is not in the allowed program list; silver is
  //               now valid everywhere, so the assertion is false regardless of the file.
  //   * loan_amount — the finding asserts loan_amount is "missing" while a value is present;
  //               gated on the file ACTUALLY having a loan_amount, so a genuinely blank one
  //               (a real "missing" finding) is never touched.
  try {
    const r = await c.query(
      `UPDATE notifications n
          SET read_at = now()
        WHERE n.id IN (
          SELECT n2.id FROM notifications n2
            LEFT JOIN applications a ON a.id = n2.application_id
           WHERE n2.type = $1
             AND n2.recipient_kind = 'staff'
             AND n2.read_at IS NULL
             AND (
               -- silver: valid program flagged as invalid
               ( n2.body ILIKE '%silver%'
                 AND ( n2.body ILIKE '%authoritative program list%'
                    OR n2.body ILIKE '%only defines standard%'
                    OR n2.body ILIKE '%only defines: standard%' ) )
               OR
               -- loan_amount: flagged missing while the file has one
               ( n2.body ILIKE '%loan_amount%'
                 AND n2.body ILIKE '%missing%'
                 AND a.loan_amount IS NOT NULL )
             )
           LIMIT $2
        )`,
      [NOTIF_TYPE, LIMIT]);
    out.retiredStale = r.rowCount || 0;
  } catch (e) {
    try { console.error('[ai-finding-notify] sweep stale', (e && e.message) || e); } catch (_) { /* noop */ }
  }

  // ---- Arm 2: any fatal notification whose linked finding is already SETTLED. Extracts the
  // suggestion id from the deep link and checks its status. Catches findings self-healed
  // (dismissed) by `retractOpen` before the going-forward wiring existed, plus anything a
  // human decided whose notification lingered.
  try {
    const settledList = SETTLED_STATUSES.map((s) => `'${s}'`).join(',');
    const r = await c.query(
      `UPDATE notifications n
          SET read_at = now()
        WHERE n.id IN (
          SELECT n2.id FROM notifications n2
            JOIN ai_suggestions s
              ON s.id = NULLIF(substring(n2.link from 'finding=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'), '')::uuid
           WHERE n2.type = $1
             AND n2.recipient_kind = 'staff'
             AND n2.read_at IS NULL
             AND s.status IN (${settledList})
           LIMIT $2
        )`,
      [NOTIF_TYPE, LIMIT]);
    out.retiredSettled = r.rowCount || 0;
  } catch (e) {
    try { console.error('[ai-finding-notify] sweep settled', (e && e.message) || e); } catch (_) { /* noop */ }
  }

  return out;
}

module.exports = {
  NOTIF_TYPE, SETTLED_STATUSES,
  retireForSuggestions, retireStaleFatalNotificationsOnce,
};
