'use strict';

// Freeze the loan STRUCTURE / economics through ONE chokepoint that every
// economics write path already calls (register, details edit, complete-fields,
// SOW/rehab-budget, appraisal reprice/undo, change-request approve, and the
// borrower equivalents). Two independent freezes share it:
//
//   1. STATUS freeze (#84) — once a file reaches Clear-to-Close / Funded (or a
//      terminal Declined / Withdrawn), its structural basis must not be
//      overwritten. A super_admin may deliberately UNLOCK the file
//      (structural_unlocked_at) to correct a mistake, then re-lock. Status
//      changes themselves are NOT gated here, so staff can always push a file
//      back to an earlier status.
//
//   2. TERM-SHEET-SENT freeze (owner-directed 2026-07-22) — the moment the Term
//      Sheet DocuSign package is SENT, the loan's figures + structure freeze so
//      the sent term sheet can never silently disagree with the file. The ONLY
//      way to change anything is to CLEAR the Term Sheet package (void it) —
//      that reopens the term-sheet + application conditions and lets you
//      re-register. A super_admin unlock does NOT bypass this one: clearing the
//      package is the deliberate action that keeps the two in agreement. The
//      freeze lifts automatically the instant the package is voided/declined.
//
// The freeze applies to EVERYONE on every write path that CALLS this. A caller
// passing no actor (borrower paths) stays frozen. The ClickUp inbound sync
// writes economics directly and does NOT yet consult this (it has its own
// review/park machinery) — a separate, tracked follow-up, same as for #84.

const db = require('../db');

const STRUCTURE_LOCKED = ['clear_to_close', 'funded', 'declined', 'withdrawn'];
const LABEL = { clear_to_close: 'Clear to Close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };

// A Term Sheet package counts as "sent and not cleared" while it is in a live
// sent / delivered / completed state. A void (the Clear action), a decline, or a
// send error is terminal and frees the file — matching the esign in-flight model.
const TS_SENT_STATUSES = ['sent', 'delivered', 'completed'];

// Returns a human-readable reason string when the file's structure is locked, or
// null when it's still editable. Pass { actor: req.actor } to honor an active
// super_admin unlock of the STATUS freeze (the term-sheet freeze is never
// unlocked that way — clear the package instead).
async function structuralLockReason(appId, client = db, opts = {}) {
  try {
    const r = await client.query(
      `SELECT a.status, a.structural_unlocked_at,
              EXISTS(SELECT 1 FROM esign_envelopes e
                      WHERE e.application_id = a.id
                        AND e.purpose = 'term_sheet_package'
                        AND e.status = ANY($2)) AS ts_sent
         FROM applications a WHERE a.id=$1`,
      [appId, TS_SENT_STATUSES]);
    const row = r.rows[0];
    if (!row) return null;
    const status = row.status;
    const actor = opts.actor || null;
    const isSuper = !!(actor && actor.kind === 'staff' && actor.role === 'super_admin');

    // 1) STATUS freeze — super_admin-unlockable.
    if (status && STRUCTURE_LOCKED.includes(status) && !(row.structural_unlocked_at && isSuper)) {
      return `This file is ${LABEL[status] || status} — its loan structure is locked. `
        + (isSuper
            ? 'A super-admin can unlock it to make a correction, then re-lock.'
            : 'Move it back to an earlier status, or ask a super-admin to unlock it, before changing this.');
    }

    // 2) TERM-SHEET-SENT freeze — the only unlock is clearing the package.
    //    Audience-aware: staff get the actionable "clear the package" copy; a
    //    borrower (no staff actor — the borrower register/SOW paths pass none)
    //    can't clear a package, so they're steered to their loan officer.
    if (row.ts_sent) {
      const isStaff = !!(actor && actor.kind === 'staff');
      return isStaff
        ? 'The Term Sheet DocuSign package has been sent, so the loan’s figures and structure are frozen. '
          + 'Clear the Term Sheet package first to change anything (that removes the sent term sheet and reopens '
          + 'the term-sheet and application conditions), then re-register.'
        : 'This file’s details are locked because the term sheet has been sent for signature. '
          + 'Contact your loan officer if something needs to change.';
    }
  } catch (_) { /* if we can't read status, don't hard-block */ }
  return null;
}

// Is THIS file frozen specifically because a Term Sheet package is live-sent?
// (Handy for the UI / the future Clear button — distinct from the status lock.)
async function termSheetSentLock(appId, client = db) {
  try {
    const r = await client.query(
      `SELECT EXISTS(SELECT 1 FROM esign_envelopes e
                      WHERE e.application_id=$1 AND e.purpose='term_sheet_package'
                        AND e.status = ANY($2)) AS ts_sent`,
      [appId, TS_SENT_STATUSES]);
    return !!(r.rows[0] && r.rows[0].ts_sent);
  } catch (_) { return false; }
}

module.exports = { structuralLockReason, STRUCTURE_LOCKED, TS_SENT_STATUSES, termSheetSentLock };
