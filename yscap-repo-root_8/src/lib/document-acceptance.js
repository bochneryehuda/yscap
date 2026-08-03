/**
 * WHAT "ACCEPTED" MEANS — the ONE definition of whether a document counts.
 *
 * Owner-reported 2026-08-03, on a live file: the insurance condition already
 * carried documents from a PREVIOUS policy (a different carrier, no mortgagee
 * clause) which were NEVER accepted. Insurance was then ordered properly, the
 * order return came back, THAT document was accepted and the condition was
 * signed off. The TPR export and the closing-prep email to the attorney then
 * shipped ALL of the insurance documents — the never-accepted ones included.
 *
 * ROOT CAUSE, and it is one line repeated in a dozen places: every selector in
 * this repo asked `review_status <> 'rejected'`. That is a test for "nobody has
 * thrown this away", not for "somebody has checked this". A document that has
 * simply never been looked at is `pending` (db/013 default), passes `<> rejected`
 * everywhere, and therefore counted as fulfillment for a sign-off, rode into the
 * investor package, and was attached to an email to an outside law firm.
 * `tpr-export`'s own header even recorded the earlier decision out loud — "Review
 * no longer gates inclusion — a pending doc ships and is LABELED pending in the
 * manifest" — and the manifest that carried the label was later dropped, so the
 * label went with it and the pending document shipped silently.
 *
 * THE OWNER'S RULE (2026-08-03), which this module encodes once:
 *   1. A document that has not been ACCEPTED is not part of the file's document
 *      set. It is not ready to ship, it may not be used for a TPR export, and it
 *      may not be attached to the closing-prep request.
 *   2. A condition that requires documents cannot be signed off unless a
 *      document on it has been ACCEPTED — "there are documents over there" is
 *      not the test.
 *   3. A condition cannot be signed off while ANY document on it is still
 *      pending. Every document must be accepted, rejected, or deleted first.
 *
 * SO: the outbound test is `review_status = 'accepted'`, with NO exception list.
 * A document PILOT itself generated or ordered (a DocuSign-executed package, a
 * tool's own Excel/PDF, a flood certificate PILOT ordered from the vendor) is
 * born `accepted` AT ITS INSERT — the same thing db/186 and db/189 already did
 * for appraisal photos and appraisal source documents — rather than being carved
 * out here. That is deliberate: an exception list in the predicate drifts from
 * the inserts, and it would also have swept up the two system-generated
 * documents that are meant to wait for a human (an entity document COPIED onto a
 * profile by `entity-adopt`, and a vendor's emailed order return), both of which
 * are documented as needing review before they count.
 *
 * The consequence is that `pending` finally means one honest thing everywhere:
 * a human still has to look at this.
 *
 * NOT changed by this rule, on purpose:
 *   · the SHAREPOINT MIRROR still mirrors everything. It is the file cabinet and
 *     the backup — the one place where dropping a document loses it — and its
 *     own policy is that nothing is ever deleted. What the owner listed is what
 *     goes OUT (the export, ready-to-ship, the closing-prep email).
 *   · every INTERNAL surface (the conditions list, document dossier, quick
 *     links, the underwriting desk) still shows pending documents. Hiding a
 *     document from the person who has to accept it would be absurd.
 */

/** The stored review states. `pending` is the db/013 default, so a NULL reads as
    pending everywhere — always through COALESCE, never a bare column. */
const ACCEPTED = 'accepted';
const PENDING = 'pending';
const REJECTED = 'rejected';
const SUPERSEDED = 'superseded';

const statusOf = (doc) => String((doc && doc.review_status) || PENDING).toLowerCase();

/** May this document leave the building — export, package, attachment, sign-off
    evidence? Exactly one answer: a human accepted it (or PILOT made it, in which
    case it was born accepted). */
const isAccepted = (doc) => statusOf(doc) === ACCEPTED;

/** Is this document still waiting on a human? Rejected and superseded are
    DECIDED — the owner's "rejected, deleted, or accepted" — so only `pending`
    counts as waiting. */
const isAwaiting = (doc) => statusOf(doc) === PENDING;

/**
 * SQL fragments. `alias` is the table alias the caller used (`d`, `documents`,
 * or '' for an unaliased single-table query). They are string constants with a
 * validated alias — never interpolated user input.
 */
function col(alias) {
  const a = String(alias == null ? 'd' : alias).trim();
  if (a && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error('bad alias');
  return `COALESCE(${a ? `${a}.` : ''}review_status,'${PENDING}')`;
}

/** `… AND <ACCEPTED_SQL('d')>` — the outbound test. */
const ACCEPTED_SQL = (alias) => `${col(alias)} = '${ACCEPTED}'`;
/** `… AND <AWAITING_SQL('d')>` — still waiting on a human. */
const AWAITING_SQL = (alias) => `${col(alias)} = '${PENDING}'`;

/* ── the wording, in one place so every surface says the same thing ────────── */

/** Refusal shown when a document-required condition has documents but none accepted. */
const NOT_ACCEPTED_MSG =
  'The documents on this condition have not been accepted yet. Open each one and accept it '
  + '(or reject it) before signing off — a condition can only be signed off on documents somebody has accepted.';

/** Refusal when every document on the condition was SENT BACK. Reached only after
    the pending check has passed, so there is nothing left waiting — the condition
    genuinely has no evidence, and asking for an accept would be a dead end. */
const ALL_REJECTED_MSG =
  'Every document on this condition was rejected, so there is nothing to sign off on. '
  + 'Upload a replacement and accept it first.';

/** Refusal shown when a condition still carries pending documents. `names` is a
    SAMPLE (the caller reads a handful, not all thirty), so "+N more" counts off
    the real total `n` — counting off the sample would tell somebody staring at
    thirty documents that there were two more than the three it named. */
function pendingDocsMsg(n, names = []) {
  const shown = names.slice(0, 3);
  const rest = Math.max(0, (Number(n) || shown.length) - shown.length);
  const which = shown.length ? ` (${shown.join(', ')}${rest ? `, +${rest} more` : ''})` : '';
  return n === 1
    ? `One document on this condition is still waiting for a decision${which}. Accept it, reject it, or delete it before signing off.`
    : `${n} documents on this condition are still waiting for a decision${which}. Accept, reject or delete each one before signing off.`;
}

/** What the export / closing-prep surfaces say about what they held back. */
function heldBackNote(n) {
  if (!n) return '';
  return n === 1
    ? '1 document is not accepted yet, so it was left out. Accept it to include it.'
    : `${n} documents are not accepted yet, so they were left out. Accept them to include them.`;
}

module.exports = {
  ACCEPTED, PENDING, REJECTED, SUPERSEDED,
  statusOf, isAccepted, isAwaiting,
  ACCEPTED_SQL, AWAITING_SQL,
  NOT_ACCEPTED_MSG, ALL_REJECTED_MSG, pendingDocsMsg, heldBackNote,
};
