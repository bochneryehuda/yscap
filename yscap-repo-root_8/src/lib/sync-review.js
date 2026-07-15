/**
 * Sync review queue — the human gate for suspicious cross-system changes
 * (2026-07-15 date incident; db/108). The sync stays fully bidirectional:
 * normal changes flow both ways as always. Only the SUSPICIOUS cases stop
 * here and wait for a person:
 *   * outbound DOB one-day shifts (the corruption signature),
 *   * inbound dates with out-of-range years (mid-typing / 2-digit-year "26"),
 *   * inbound DOBs that disagree with an existing portal DOB.
 * Queueing is best-effort and deduped (one open row per task+field+proposal) —
 * it must never break a sync pass.
 */
const db = require('../db');

async function queueReview({ applicationId, borrowerId, taskId, direction, fieldKey,
  currentValue, proposedValue, rawValue, reason }) {
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
    await db.query(
      `INSERT INTO sync_review_queue
         (application_id, borrower_id, task_id, direction, field_key, current_value, proposed_value, raw_value, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT ((coalesce(task_id,'')), field_key, direction, (coalesce(proposed_value,''))) WHERE status='open'
       DO NOTHING`,
      [applicationId || null, borrowerId || null, taskId || null, direction, fieldKey,
       currentValue == null ? null : String(currentValue),
       proposedValue == null ? null : String(proposedValue),
       rawValue == null ? null : String(rawValue), reason]);
  } catch (e) { console.warn('[sync-review] queue insert skipped:', e.message); }
}

module.exports = { queueReview };
