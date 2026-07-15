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
};

async function queueReview({ applicationId, borrowerId, taskId, direction, fieldKey,
  currentValue, proposedValue, rawValue, reason, clickupValue, portalValue }) {
  try {
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
    const a = (await db.query(
      `SELECT a.loan_officer_id, s.email FROM applications a
         LEFT JOIN staff_users s ON s.id = a.loan_officer_id AND s.is_active
        WHERE a.id=$1`, [row.application_id])).rows[0];
    if (a) add(a.loan_officer_id, a.email, row.application_id);
  }
  if (!officers.size && row.borrower_id) {
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
  for (const [staffId, o] of officers) {
    try {
      await notify.notifyStaff(staffId, {
        type: 'sync_review',
        title: `Sync review needed: ${label}${who}`,
        body: `PILOT and ClickUp disagree on the ${label.toLowerCase()}${who}. ` +
              `In ClickUp: ${row.clickup_value || '—'}. In PILOT: ${row.portal_value || '—'}. ` +
              `Open the Sync review screen, compare both sides, and choose which value should win — it will be applied to both systems.`,
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
async function closeStaleReviews({ borrowerId, taskId, fieldKey, note }) {
  if (!fieldKey || (!borrowerId && !taskId)) return 0;
  try {
    const r = await db.query(
      `UPDATE sync_review_queue
          SET status='resolved', auto_resolved=true, resolved_at=now(),
              resolution_note=$1
        WHERE status='open' AND field_key=$2
          AND (($3::uuid IS NOT NULL AND borrower_id=$3) OR ($4::text IS NOT NULL AND task_id=$4))
        RETURNING id`,
      [note || 'auto-closed — the two systems now agree (fixed at the source)',
       fieldKey, borrowerId || null, taskId || null]);
    return r.rowCount || 0;
  } catch (e) { console.warn('[sync-review] stale-close skipped:', e.message); return 0; }
}

module.exports = { queueReview, notifyLoanOfficer, closeStaleReviews, FIELD_LABELS };
