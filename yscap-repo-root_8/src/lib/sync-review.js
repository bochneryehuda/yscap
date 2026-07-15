/**
 * Sync review queue — the human gate for suspicious cross-system changes
 * (2026-07-15 date incident; db/108 + two-sided upgrade db/110). The sync
 * stays fully bidirectional: normal changes flow both ways as always, and the
 * auto-resolution engine (src/lib/sync-autoresolve.js) settles the PROVABLE
 * conflicts by itself. Only genuine ambiguity stops here and waits for a
 * person:
 *   * outbound DOB changes of any magnitude (a DOB change is a human decision),
 *   * inbound dates with out-of-range years (mid-typing / 2-digit-year "26"),
 *   * inbound DOBs that disagree with the portal and can't be auto-resolved,
 *   * PII overwrites a bulk repush wanted to make.
 * Every row is TWO-SIDED: it records what ClickUp holds and what PILOT holds,
 * and resolving picks a winner that is applied to BOTH systems (values are
 * re-read live at resolve time — stored values are display-only; SSNs are
 * stored masked, never cleartext).
 * The file's LOAN OFFICER is notified (in-app + branded email) the moment a
 * row lands, with a deep link to /internal/sync-reviews — reviews are theirs
 * to resolve, not an admin-only backwater.
 * Queueing is best-effort and deduped (one open row per task+field+proposal;
 * DOBs dedupe per borrower) — it must never break a sync pass.
 */
const db = require('../db');

const FIELD_LABELS = {
  date_of_birth: 'Date of birth', expected_closing: 'Expected closing date',
  actual_closing: 'Actual closing date', acquisition_date: 'Acquisition date',
  ssn: 'Social Security number', first_name: 'Borrower name', email: 'Borrower email',
  cell_phone: 'Borrower cell', current_address: 'Borrower home address', status: 'File status',
  // FILE-LEVEL rows (owner-directed 2026-07-15 night: "not only a field that is
  // wrong — entire files; anything stuck goes to manual review, with options"):
  file_link: 'File not syncing', ys_loan_number: 'YS loan number', push_job: 'ClickUp push failed',
  co_first_name: 'Co-borrower name', co_cell_phone: 'Co-borrower cell',
  sharepoint_folder: 'SharePoint filing', sharepoint_doc: 'SharePoint document sync',
};

async function queueReview({ applicationId, borrowerId, taskId, direction, fieldKey,
  currentValue, proposedValue, rawValue, reason, clickupValue, portalValue, suppressIfRejected }) {
  try {
    // FILE-LEVEL rows are re-produced by every sync pass while the file stays
    // stuck — so a reviewer's explicit DISMISS must stick (the next reconcile
    // is 5 minutes away; without this the dismissed row respawns forever).
    // Field-value rows don't use this: a re-blocked write is a fresh event.
    if (suppressIfRejected) {
      const rej = await db.query(
        `SELECT 1 FROM sync_review_queue
          WHERE coalesce(task_id,'') = coalesce($1,'') AND field_key=$2 AND reason=$3
            AND status='rejected' LIMIT 1`, [taskId || null, fieldKey, reason]);
      if (rej.rows[0]) return;
    }
    // A DOB is a BORROWER-level fact: one open review per borrower + proposal,
    // not one per linked task (a borrower with three tasks was queueing three
    // identical rows — owner-reported noise, 2026-07-15). The task-scoped
    // ON CONFLICT below still dedupes everything else.
    if (fieldKey === 'date_of_birth' && borrowerId) {
      const dup = await db.query(
        `SELECT 1 FROM sync_review_queue
          WHERE status='open' AND field_key='date_of_birth' AND borrower_id=$1
            AND coalesce(proposed_value,'') = coalesce($2,'') LIMIT 1`,
        [borrowerId, proposedValue == null ? null : String(proposedValue)]);
      if (dup.rows[0]) return;
    }
    // Two-sided values: prefer explicit clickupValue/portalValue from the
    // caller; otherwise derive from direction (inbound: source=ClickUp is the
    // proposal, destination=PILOT is the current — outbound the reverse).
    const cuV = clickupValue !== undefined ? clickupValue
      : (direction === 'inbound' ? proposedValue : currentValue);
    const pV = portalValue !== undefined ? portalValue
      : (direction === 'inbound' ? currentValue : proposedValue);
    const ins = await db.query(
      `INSERT INTO sync_review_queue
         (application_id, borrower_id, task_id, direction, field_key, current_value, proposed_value, raw_value, reason, clickup_value, portal_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT ((coalesce(task_id,'')), field_key, direction, (coalesce(proposed_value,''))) WHERE status='open'
       DO NOTHING RETURNING id`,
      [applicationId || null, borrowerId || null, taskId || null, direction, fieldKey,
       currentValue == null ? null : String(currentValue),
       proposedValue == null ? null : String(proposedValue),
       rawValue == null ? null : String(rawValue), reason,
       cuV == null ? null : String(cuV), pV == null ? null : String(pV)]);
    if (ins.rows[0]) notifyLoanOfficer(ins.rows[0].id).catch(() => {});
  } catch (e) { console.warn('[sync-review] queue insert skipped:', e.message); }
}

/**
 * Email + in-app notify the file's loan officer that a review needs them
 * (owner-directed 2026-07-15). Resolution: the row's application's LO; for a
 * borrower-level row (a DOB), every LO across the borrower's active linked
 * files (deduped). Falls back to nothing quietly — notification must never
 * break the sync. notified_at marks delivery so re-queues never double-send.
 */
async function notifyLoanOfficer(reviewId) {
  const r = await db.query(
    `SELECT q.*, b.first_name || ' ' || b.last_name AS borrower_name
       FROM sync_review_queue q LEFT JOIN borrowers b ON b.id = q.borrower_id
      WHERE q.id=$1 AND q.status='open' AND q.notified_at IS NULL`, [reviewId]);
  const row = r.rows[0];
  if (!row) return;
  const officers = new Map();
  const add = (id, email, appId) => { if (id && !officers.has(id)) officers.set(id, { email, appId }); };
  if (row.application_id) {
    // HARD SCOPE GUARD (owner-reported 2026-07-15 night: an officer with NO
    // relation to the file was emailed a review for it): a FILE-scoped row
    // notifies ONLY that file's assigned loan officer — never any other
    // officer, and NEVER the borrower-wide fan-out below. A file with no
    // assigned LO emails nobody (the admin queue, the sidebar badge, and the
    // 7-day admin escalation still surface it).
    const a = (await db.query(
      `SELECT a.loan_officer_id, s.email FROM applications a
         LEFT JOIN staff_users s ON s.id = a.loan_officer_id AND s.is_active
        WHERE a.id=$1`, [row.application_id])).rows[0];
    if (a) add(a.loan_officer_id, a.email, row.application_id);
  } else if (row.borrower_id) {
    // BORROWER-level rows only (no file to scope to — e.g. a DOB): the loan
    // officers of THIS borrower's own active files, each of whom owns the
    // shared fact being reviewed.
    const apps = (await db.query(
      `SELECT a.id, a.loan_officer_id, s.email FROM applications a
         LEFT JOIN staff_users s ON s.id = a.loan_officer_id AND s.is_active
        WHERE a.borrower_id=$1 AND a.deleted_at IS NULL AND a.loan_officer_id IS NOT NULL`, [row.borrower_id])).rows;
    for (const a of apps) add(a.loan_officer_id, a.email, a.id);
  }
  if (!officers.size) return;   // unassigned file — the admin queue view still shows it
  const notify = require('./notify');
  const label = FIELD_LABELS[row.field_key] || row.field_key;
  const who = row.borrower_name ? ` for ${row.borrower_name}` : '';
  // FILE-LEVEL rows aren't a value disagreement — the email must say what the
  // situation is and that the review screen offers ACTIONS, not sides
  // (pre-merge audit #257 should-fix: the two-sided copy misdirected LOs).
  const fileLevel = ['file_link', 'push_job', 'ys_loan_number', 'sharepoint_folder', 'sharepoint_doc', 'co_first_name', 'co_cell_phone'].includes(row.field_key);
  const body = fileLevel
    ? `A file${who} needs a decision: ${label.toLowerCase()}` +
      (row.clickup_value ? ` (${row.clickup_value})` : '') + '. ' +
      `Open the Sync review screen — it explains what happened and offers the resolution options (create the file, link it to an existing one, retry the push, or dismiss).`
    : `PILOT and ClickUp disagree on the ${label.toLowerCase()}${who}. ` +
      `In ClickUp: ${row.clickup_value || '—'}. In PILOT: ${row.portal_value || '—'}. ` +
      `Open the Sync review screen, compare both sides, and choose which value should win — it will be applied to both systems.`;
  for (const [staffId, o] of officers) {
    try {
      await notify.notifyStaff(staffId, {
        type: 'sync_review',
        title: `Sync review needed: ${label}${who}`,
        body,
        applicationId: row.application_id || o.appId || null,
        link: '/internal/sync-reviews',
        emailTo: o.email || undefined,
      });
    } catch (e) { console.warn('[sync-review] LO notify failed:', e.message); }
  }
  await db.query(`UPDATE sync_review_queue SET notified_at=now() WHERE id=$1`, [reviewId]).catch(() => {});
}

/**
 * Auto-close OPEN review rows whose underlying disagreement no longer exists
 * (owner-directed 2026-07-15: "once it's fixed in ClickUp, the review should
 * go away on the next sync, even if you don't click anything"). Called by the
 * sync whenever it observes the two systems AGREEING (or auto-adopts a
 * canonical value) for a field that has open rows. Closed as
 * status='resolved' + auto_resolved=true with an explanatory note — kept as
 * history, never deleted. A NEW conflict later simply queues a new row.
 */
async function closeStaleReviews({ borrowerId, taskId, applicationId, fieldKey, note }) {
  if (!fieldKey || (!borrowerId && !taskId && !applicationId)) return 0;
  try {
    const r = await db.query(
      `UPDATE sync_review_queue
          SET status='resolved', auto_resolved=true, resolved_at=now(),
              resolution_note=$1
        WHERE status='open' AND field_key=$2
          AND (($3::uuid IS NOT NULL AND borrower_id=$3) OR ($4::text IS NOT NULL AND task_id=$4)
               OR ($5::uuid IS NOT NULL AND application_id=$5))
        RETURNING id`,
      [note || 'auto-closed — the two systems now agree (fixed at the source)',
       fieldKey, borrowerId || null, taskId || null, applicationId || null]);
    return r.rowCount || 0;
  } catch (e) { console.warn('[sync-review] stale-close skipped:', e.message); return 0; }
}

/**
 * AGING + ESCALATION (mega-audit enhancement #2; db/112): "nothing is silent"
 * must be a STANDING guarantee, not a point-in-time one. A row still open
 * after 3 days re-notifies the file's loan officer once (reminded_at); after
 * 7 days it escalates once to every active admin (escalated_at). Runs on boot
 * and daily; bounded and best-effort — never breaks the sync.
 */
async function remindStaleReviewsOnce() {
  const notify = require('./notify');
  let reminded = 0, escalated = 0;
  try {
    const remind = await db.query(
      `SELECT id FROM sync_review_queue
        WHERE status='open' AND reminded_at IS NULL AND created_at < now() - interval '3 days'
        ORDER BY created_at ASC LIMIT 50`);
    for (const row of remind.rows) {
      try {
        // Re-run the standard LO notification for the row (it targets the
        // file's LO / the borrower's LOs); notified_at gates only the FIRST
        // send, so clear our own gate by calling notify directly per row.
        await db.query(`UPDATE sync_review_queue SET notified_at=NULL WHERE id=$1`, [row.id]);
        await notifyLoanOfficer(row.id);
        await db.query(`UPDATE sync_review_queue SET reminded_at=now() WHERE id=$1`, [row.id]);
        reminded++;
      } catch (_) { /* per-row best-effort */ }
    }
    const esc = await db.query(
      `SELECT q.id, q.field_key, b.first_name || ' ' || b.last_name AS borrower_name
         FROM sync_review_queue q LEFT JOIN borrowers b ON b.id=q.borrower_id
        WHERE q.status='open' AND q.escalated_at IS NULL AND q.created_at < now() - interval '7 days'
        ORDER BY q.created_at ASC LIMIT 25`);
    if (esc.rows.length) {
      const admins = (await db.query(
        `SELECT id, email FROM staff_users WHERE is_active AND role IN ('admin','super_admin')`)).rows;
      const lines = esc.rows.map((r) => `• ${FIELD_LABELS[r.field_key] || r.field_key}${r.borrower_name ? ` — ${r.borrower_name}` : ''}`).join('\n');
      for (const a of admins) {
        try {
          await notify.notifyStaff(a.id, {
            type: 'sync_review',
            title: `${esc.rows.length} sync review item(s) open for over a week`,
            body: `These have been waiting more than 7 days with no decision:\n${lines}\n\nOpen the Sync review screen to settle them.`,
            link: '/internal/sync-reviews', emailTo: a.email || undefined,
          });
        } catch (_) { /* per-admin best-effort */ }
      }
      await db.query(`UPDATE sync_review_queue SET escalated_at=now() WHERE id = ANY($1)`, [esc.rows.map((r) => r.id)]);
      escalated = esc.rows.length;
    }
  } catch (e) { console.warn('[sync-review] aging sweep skipped:', e.message); }
  if (reminded || escalated) console.log(`[sync-review] aging: ${reminded} reminded, ${escalated} escalated`);
  return { reminded, escalated };
}

/**
 * WEEKLY DIGEST (mega-audit enhancement #5): proof the review system is being
 * worked + early warning when a producer starts flooding. Emails active
 * admins a 7-day summary; self-gates via an audit_log stamp so it sends at
 * most once every 6 days regardless of how often the caller fires.
 */
async function sendReviewDigestOnce() {
  try {
    const already = await db.query(
      `SELECT 1 FROM audit_log WHERE action='sync_review_digest_sent' AND created_at > now() - interval '6 days' LIMIT 1`);
    if (already.rows[0]) return false;
    const stats = (await db.query(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '7 days') AS opened,
         count(*) FILTER (WHERE status='resolved' AND auto_resolved AND resolved_at > now() - interval '7 days') AS auto_closed,
         count(*) FILTER (WHERE status IN ('resolved','approved') AND NOT auto_resolved AND resolved_at > now() - interval '7 days') AS human_resolved,
         count(*) FILTER (WHERE status='rejected' AND resolved_at > now() - interval '7 days') AS dismissed,
         count(*) FILTER (WHERE status='open') AS open_now,
         count(*) FILTER (WHERE status='open' AND created_at < now() - interval '14 days') AS open_14d
       FROM sync_review_queue`)).rows[0];
    const byReason = (await db.query(
      `SELECT reason, count(*)::int AS n FROM sync_review_queue
        WHERE created_at > now() - interval '7 days' GROUP BY reason ORDER BY n DESC LIMIT 8`)).rows;
    const notify = require('./notify');
    const admins = (await db.query(
      `SELECT id, email FROM staff_users WHERE is_active AND role IN ('admin','super_admin')`)).rows;
    const reasonLines = byReason.map((r) => `• ${r.reason}: ${r.n}`).join('\n') || '• (none)';
    for (const a of admins) {
      try {
        await notify.notifyStaff(a.id, {
          type: 'sync_review',
          title: `Sync review weekly digest — ${stats.open_now} open now`,
          body: `Last 7 days: ${stats.opened} opened, ${stats.auto_closed} auto-closed by the system, ` +
                `${stats.human_resolved} resolved by a person, ${stats.dismissed} dismissed.\n` +
                `Open now: ${stats.open_now} (${stats.open_14d} older than 14 days).\n\nTop reasons this week:\n${reasonLines}`,
          link: '/internal/sync-reviews', emailTo: a.email || undefined,
        });
      } catch (_) { /* per-admin best-effort */ }
    }
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system',NULL,'sync_review_digest_sent','application',NULL,$1)`,
      [JSON.stringify(stats)]).catch(() => {});
    return true;
  } catch (e) { console.warn('[sync-review] digest skipped:', e.message); return false; }
}

module.exports = { queueReview, notifyLoanOfficer, closeStaleReviews, remindStaleReviewsOnce, sendReviewDigestOnce, FIELD_LABELS };
