/* WHAT TO DO NEXT ON A CONDITION — one decision, for every row shape.
 *
 * Owner-reported 2026-07-27, after uploading a document to a live file: "it's
 * getting so messed up — the accept button and the sign off button and the done
 * button, it's way too complicated. We don't need to remove features but we need
 * to find a way to make it more simplified, more user friendly."
 *
 * THE ROOT CAUSE is not the number of buttons, it is that they were a FLAT LIST
 * with no hierarchy. A condition row offered, all at one weight and all at once:
 * a status dropdown, an assignee dropdown, Done, Sign off, Not required,
 * Override, Send back, and per document Preview / Download / Replace / Accept /
 * Accept +1 more / Reject / Delete. Three of those — Accept, Done, Sign off —
 * read as "this is finished" and mean three different things at three different
 * points in the workflow, which is exactly the pair the owner named.
 *
 * So the fix is HIERARCHY, not removal: work out the ONE thing this viewer
 * should do next, give it the only prominent button, and put everything else
 * behind "More". Nothing is taken away — every action is still one click from
 * where it was.
 *
 * The workflow this encodes is the one already documented across the screen
 * (roleDone, the Done/Sign off button titles, and the #133/#135 notes):
 *
 *     documents arrive  ->  a completer ACCEPTS each one   (sets 'received')
 *                       ->  the loan officer marks DONE    (their step)
 *                       ->  a completer SIGNS OFF          (clears it for everyone)
 *
 * Pure on purpose — no React, no api — so the ladder can be tested without a
 * browser, and so the two row shapes can never disagree about what comes next.
 * That is not hypothetical: the same six buttons were written out twice and had
 * already drifted ("Not required" vs "Waive", "Send back" vs "Reopen / send
 * back"), and the inline entry boxes were written into one shape only and
 * silently vanished from the other when Phase 5b changed which shape a staff
 * condition renders in.
 */

/* Who may complete a condition — accept a document, sign off, waive.
   Lives here rather than in the screen so the ladder owns its own role rules. */
export const canComplete = (role) =>
  ['processor', 'admin', 'super_admin', 'underwriter', 'loan_coordinator'].includes(role);

/* A document still waiting on somebody. Anything not accepted and not rejected
   is pending — matching how the rows themselves read `review_status`, where an
   absent value means pending. */
export function pendingDocs(docs) {
  return (docs || []).filter((d) => {
    const rs = d.review_status || 'pending';
    return rs !== 'accepted' && rs !== 'rejected';
  });
}

/* THE LADDER. Returns the ONE next step for this viewer, as data:
 *
 *   { key, label, title, patch, tone, hint }
 *
 *   key   — stable id for tests and for keying the button
 *   label — what the button says
 *   patch — the onPatch payload it sends (null when the action is not a patch)
 *   tone  — 'primary' for a step that moves the file forward, 'ghost' for an undo
 *   hint  — one plain sentence under the button saying what happens, or what to
 *           do first. This is the half that actually answers "which one do I
 *           press?" — a button alone never has.
 *
 * `docs` is this condition's current documents; pass [] when it has none.
 */
export function nextStep(it, { role, docs } = {}) {
  const completer = canComplete(role);
  const isLO = role === 'loan_officer';
  const signed = !!it.signed_off_at;
  const waived = !!it.waived_at;

  // Already cleared — the only forward move left is to undo it.
  if (completer && waived) {
    return { key: 'undo_waive', label: 'Undo not required', tone: 'ghost',
      patch: { waived: false },
      title: 'Put this condition back on the list',
      hint: 'Cleared as not required. Undo to put it back on everyone’s list.' };
  }
  if (completer && signed) {
    return { key: 'undo_signoff', label: 'Undo sign-off', tone: 'ghost',
      patch: { signedOff: false },
      title: 'Reopen this condition',
      hint: 'Signed off. Undo to reopen it for everyone.' };
  }

  // A completer's step is the sign-off. If a document is still sitting
  // unreviewed we say so rather than leaving them to guess which of the three
  // finish-sounding buttons comes first.
  if (completer) {
    const waiting = pendingDocs(docs).length;
    return { key: 'signoff', label: 'Sign off', tone: 'primary',
      patch: { signedOff: true },
      title: 'Sign off = the whole condition is complete. This is what removes it from the list for everyone.',
      hint: waiting
        ? `Accept the ${waiting === 1 ? 'document' : `${waiting} documents`} above first, then sign off — signing off clears this condition for everyone.`
        : 'Signing off clears this condition for everyone.' };
  }

  // NOT a completer, and the condition is already cleared. The undo branches
  // above are gated on completer for a reason — this viewer has no authority to
  // reopen it — so the honest answer is that there is nothing for them to do.
  // Their own Done step is still offered (it is their record, and marking it is
  // never harmful), but the hint says plainly that the condition is finished,
  // rather than implying a sign-off is still coming.
  const cleared = signed || waived || it.status === 'satisfied';
  const after = isLO ? 'The back office signs off after you.'
    : 'Someone with sign-off clears it after you.';

  if (it.reviewed_at) {
    return { key: 'undo_done', label: 'Undo done', tone: 'ghost',
      patch: { reviewed: false },
      title: 'You marked this done — undo to put it back on your list',
      hint: cleared
        ? 'This condition is already cleared — nothing more is needed from you.'
        : `You marked this done. ${after}` };
  }
  return { key: 'done', label: 'Done', tone: 'primary',
    patch: { reviewed: true },
    title: isLO
      ? 'Mark this condition done (loan-officer step). The processor still signs it off.'
      : 'Mark this condition done. Someone with sign-off still clears it.',
    hint: cleared
      ? 'This condition is already cleared — nothing more is needed from you.'
      : `Records your step and clears it off your list. ${after}` };
}

/* THE DOCUMENT ROW's one next step. Same idea, one line down: a document that
   nobody has reviewed wants Accept; everything else about it is secondary. */
export function docNextStep(doc, { role } = {}) {
  const rs = (doc && doc.review_status) || 'pending';
  if (!canComplete(role)) return null;          // only a completer can accept
  if (rs === 'accepted') return null;           // nothing forward left to do
  return { key: 'accept', label: 'Accept', tone: 'primary',
    title: rs === 'rejected'
      ? 'Accept this document after all'
      : 'Accept this document — the condition stays open until it is signed off' };
}
