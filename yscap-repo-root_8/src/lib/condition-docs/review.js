'use strict';

/**
 * ACCEPT OR REJECT A CONDITION DOCUMENT — one definition, both products.
 *
 * Lifted VERBATIM out of `src/routes/staff.js`'s `POST /documents/:id/review`
 * under the 2026-08-30 share-the-code directive. The verbs the owner named —
 * *"accept, reject, preview, download, and delete"* — are the ones that must
 * behave the same everywhere, and the rules below are the ones a second copy
 * would get subtly wrong:
 *
 *   • a REJECTION always needs a reason, and an ACCEPT-AND-ASK-FOR-MORE always
 *     needs a note (owner-directed 2026-07-12 — an empty "request more" left the
 *     borrower with a still-open condition and no reason);
 *   • ACCEPT marks the condition RECEIVED, never SATISFIED (#135) — a
 *     multi-document condition must not fly away because one of its documents
 *     was accepted;
 *   • REJECT re-opens the condition to 'issue' AND drops any sign-off, because
 *     the rejected document WAS the evidence that sign-off attested to;
 *   • REQUEST-MORE writes the ask into `borrower_hint`, never into `notes`
 *     (which is internal-only), replacing a previous "Still needed:" instead of
 *     stacking them.
 *
 * WHAT IS THE CALLER'S — who may accept. `canAccept` is passed in because the
 * two products have different role systems; the ORDER and the WORDING of the
 * refusals are here so they can never drift apart.
 *
 * WHAT IS A HOOK — the throttled verdict EMAIL and the ClickUp push. The RTL
 * door keeps sending its own emails at its own point in the sequence (its
 * entity, track-record and draw side effects run in between, and moving the
 * sends would have reordered work on the main product for no sharing gain); it
 * uses `claimVerdictEmail` below so both products throttle identically.
 */

const { ownerWhere } = require('../condition-owner');
const { defaultHooks } = require('./hooks-rtl');

/** The columns a verdict needs off the document row. */
const REVIEW_COLUMNS =
  'id,filename,application_id,lt_loan_id,borrower_id,llc_id,checklist_item_id,track_record_id';

function refuse(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Read the document a verdict is about.
 *
 * `owner` is OPTIONAL and is the whole point of this function. RTL's staff door
 * has no owner in its path (`/documents/:id/review`) and authorizes through
 * `canSeeDocument`, so it reads by id exactly as it always has. A door that
 * DOES know its owner passes one, and the ownership is then welded into the
 * statement — an id belonging to the other product reaches nothing at all,
 * rather than reaching a row that some later check is trusted to refuse.
 */
async function loadDocument(q, id, owner = null) {
  if (!owner) return (await q.query(`SELECT ${REVIEW_COLUMNS} FROM documents WHERE id=$1`, [id])).rows[0] || null;
  const w = ownerWhere(owner, null, 2);
  const r = await q.query(`SELECT ${REVIEW_COLUMNS} FROM documents WHERE id=$1 AND ${w.sql}`, [id, ...w.params]);
  return r.rows[0] || null;
}

/**
 * The verdict a request is asking for, or a refusal. Returns the normalized
 * verdict; throws with `err.status` in the SAME order the door always refused.
 */
function validateVerdict(body, { canAccept } = {}) {
  const b = body || {};
  const action = b.action;
  if (!['accept', 'reject'].includes(action)) throw refuse('action must be accept or reject', 400);
  // Accepting a document completes its condition — processor/admin only.
  // Anyone on the file may reject (the document lands in the file's trash).
  if (action === 'accept' && !canAccept) {
    throw refuse('Only the processor can accept a document — you can reject it or mark the condition reviewed.', 403);
  }
  if (action === 'reject' && !String(b.reason || '').trim()) throw refuse('a rejection reason is required', 400);
  // Accept + request another document: the borrower must be told WHAT else is
  // needed, so the note is required too (owner-directed 2026-07-12) — an empty
  // "request more" left the borrower with a still-open condition and no reason.
  if (action === 'accept' && b.requestMore && !String(b.note || '').trim()) {
    throw refuse('tell the borrower what additional document is needed', 400);
  }
  // Accept-and-request-more: the document itself is GOOD and stays accepted,
  // but the condition is not satisfied yet — the reviewer asks the borrower
  // for one more document on the same condition (a new slot), so the
  // condition stays open instead of signing off.
  const requestMore = action === 'accept' && !!b.requestMore;
  return {
    action,
    status: action === 'accept' ? 'accepted' : 'rejected',
    requestMore,
    moreNote: requestMore ? String(b.note || '').trim().slice(0, 500) : '',
    reason: action === 'reject' ? String(b.reason).slice(0, 1000) : null,
  };
}

/**
 * ONE BORROWER EMAIL PER CONDITION PER VERDICT.
 *
 * A tool submission (Scope of Work, track record, term sheet…) saves the SAME
 * logical document in SEVERAL formats — HTML + XML + PDF — as separate `documents`
 * rows on ONE checklist item. A verdict (reject / request-more) on that item was
 * firing the borrower email once PER FORMAT (owner-reported 2026-07-20: three
 * identical "needs a new document" emails for one Scope of Work). The first
 * format's verdict notifies, the sibling formats update silently. Returns true if
 * THIS call should notify. No checklist item to key on (LLC/profile doc) → always
 * notify.
 *
 * Uses the shared ATOMIC claim (pg_advisory_xact_lock in its own statement) —
 * a plain INSERT…WHERE NOT EXISTS is NOT race-safe under READ COMMITTED, so two
 * of the export formats' parallel reject calls could both win and re-send. The
 * helper also FAILS CLOSED on a DB error (returns null → no email) instead of
 * throwing a 500 out of the handler after the review already committed.
 */
async function claimVerdictEmail(checklistItemId, action) {
  if (!checklistItemId) return true;   // no logical item to key on → always notify
  const { claimOncePerPeriod } = require('../throttle-claim');
  return (await claimOncePerPeriod({ action, entityId: checklistItemId, interval: '5 minutes', entityType: 'checklist_item' })) != null;
}

/**
 * Stamp the verdict on the document and move its condition. Everything a
 * PRODUCT does about a verdict (emails, entity verification, track-record tier,
 * live refreshes) belongs to the caller or to a hook.
 */
async function applyVerdict(q, { doc, verdict, actorId, hooks, owner = null }) {
  const use = hooks || defaultHooks(owner);
  await q.query(
    `UPDATE documents SET review_status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1`,
    [doc.id, verdict.status, verdict.reason, actorId]);

  // Move the linked checklist item: accept -> satisfied, reject -> issue —
  // unless the reviewer asked for another document, which keeps it open.
  if (doc.checklist_item_id) {
    if (verdict.requestMore) {
      // The note must reach the BORROWER — ci.notes is internal-only (never
      // sent to borrowers), so the ask lands in borrower_hint, replacing any
      // previous "Still needed:" suffix instead of stacking them.
      const cur = await q.query(`SELECT COALESCE(borrower_hint, hint, '') AS bh FROM checklist_items WHERE id=$1`, [doc.checklist_item_id]);
      const baseHint = String((cur.rows[0] && cur.rows[0].bh) || '').replace(/\s*·?\s*Still needed:.*$/s, '').trim();
      const newHint = verdict.moreNote ? (baseHint ? `${baseHint} · Still needed: ${verdict.moreNote}` : `Still needed: ${verdict.moreNote}`) : null;
      await q.query(
        `UPDATE checklist_items SET status='outstanding',
                signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL,
                notes=CASE WHEN $2 <> '' THEN $2 ELSE notes END,
                borrower_hint=COALESCE($3, borrower_hint), updated_at=now() WHERE id=$1`,
        [doc.checklist_item_id, verdict.moreNote ? `Still needed: ${verdict.moreNote}` : '', newHint]);
    } else if (verdict.action === 'accept') {
      // Accepting a document only marks the condition RECEIVED — NOT satisfied
      // (owner-directed 2026-07-12). The condition stays open on the list until
      // a reviewer explicitly SIGNS IT OFF (which routes through signOffGate and
      // therefore enforces every required document/slot — e.g. a background AND
      // criminal report, insurance binder AND invoice). This prevents a
      // multi-document condition from "flying away" the moment ONE of its
      // documents is accepted, and keeps accept (doc is good) distinct from
      // sign-off (the whole condition is complete).
      await q.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1`,
        [doc.checklist_item_id]);
    } else {
      // Reject -> issue, AND drop any prior sign-off: the rejected document was
      // the evidence the sign-off attested to, so the condition must re-open
      // (otherwise a signed-off condition stays "cleared" for the clear-to-close
      // gate with rejected/zero evidence). Same class as the LLC/track-record
      // reject-revokes-verification handling the RTL door does next.
      await require('../checklist-evidence').reopenConditionEvidence(q, doc.checklist_item_id, 'issue');
    }
    if (use.conditionTouched) use.conditionTouched(doc.checklist_item_id);   // mapped conditions → ClickUp dropdown
  }
  return { review_status: verdict.status };
}

module.exports = { REVIEW_COLUMNS, loadDocument, validateVerdict, claimVerdictEmail, applyVerdict };
