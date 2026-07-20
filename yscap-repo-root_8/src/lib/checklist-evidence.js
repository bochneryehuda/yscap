'use strict';

// A required document condition is treated as "cleared" through
// checklist_items.signed_off_at (and status='satisfied') — that's what the
// clear-to-close gate (advancementBlockers) and the pipeline KPIs read.
//
// So when the DOCUMENT EVIDENCE behind a condition becomes invalid — the reviewer
// REJECTS it, a new unreviewed VERSION supersedes it, or an appraisal-import UNDO
// removes it — the sign-off must be dropped, or the file keeps counting a
// condition as done on evidence that is gone (and could clear-to-close / fund on
// rejected paperwork). The LLC and track-record flows already revoke their
// verification on the same events; this is the equivalent for the plain checklist
// sign-off, in one place so every evidence-invalidating path stays consistent.
//
// `q` is any query runner (the pool `db` or a transaction client). `status` is the
// state to move to: 'issue' (rejected), 'received' (a new unreviewed version is
// present), or 'outstanding' (evidence removed entirely).
async function reopenConditionEvidence(q, itemId, status) {
  if (!itemId) return;
  await q.query(
    `UPDATE checklist_items
        SET status=$2, signed_off_at=NULL, signed_off_by=NULL,
            reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
      WHERE id=$1`, [itemId, status]);
}

module.exports = { reopenConditionEvidence };
