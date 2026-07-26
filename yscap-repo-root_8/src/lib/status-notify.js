/**
 * Borrower-facing status-change notification — the single source of truth shared
 * by every door that can move a file's borrower-facing status:
 *   - the PORTAL doors (staff.js: PATCH /applications/:id + POST /internal-status),
 *   - the ClickUp INBOUND sync (clickup/ingest.js), when the team changes a file's
 *     status directly in ClickUp.
 *
 * Keeping the copy/labels/journey in ONE place means the borrower sees the exact
 * same "Your loan status is now: …" wherever the change originated (owner-directed
 * 2026-07-20 — the team drives statuses in both ClickUp and the portal).
 *
 * The inbound path is GO-FORWARD ONLY via the `status_notified_external`
 * watermark (db/187): the first time the sync sees a file it silently baselines
 * (writes the watermark, sends nothing) so previously-drifted files are never
 * blasted; the portal doors write the same watermark in lock-step so a ClickUp
 * ECHO of a portal change never re-notifies.
 */
const db = require('../db');
const notify = require('./notify');

// Borrower-facing status label (the 9 external buckets).
const STATUS_LABEL = { file_intake: 'File intake', new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
// #88: the DECISION milestones a borrower should be EMAILED about. Every status
// change still posts in-app; only these also email (the in-between progress moves —
// in_review / processing / underwriting — are in-app only, to keep the inbox quiet).
const MAJOR_STATUSES = new Set(['approved', 'clear_to_close', 'funded', 'declined', 'withdrawn']);
// Plain-language, borrower-facing explanation of what a status MEANS and what
// happens next — so a status email is reassuring and actionable, not a bare label
// (owner-directed 2026-07-20). Borrower-safe copy only (no capital-partner names,
// no internal mechanics). Missing entry → no explanation line (graceful).
const BORROWER_STATUS_EXPLAIN = {
  in_review: 'Your loan team is reviewing your file and the documents you provided. We\'ll let you know as soon as we need anything else from you.',
  processing: 'Your file is being prepared for underwriting. Keep an eye out for any document requests so nothing slows down your loan.',
  underwriting: 'An underwriter is reviewing your loan for final approval. If they need anything, it will appear in your conditions.',
  approved: 'Your loan has been approved. Next, we\'ll finish any remaining conditions and prepare to clear you to close.',
  clear_to_close: 'You are clear to close — every condition is satisfied and your closing can be scheduled. Your loan officer will reach out to coordinate the details.',
  funded: 'Your loan has funded — congratulations! If your loan includes renovation draws, you can request your first draw from the portal when you\'re ready.',
  declined: 'After review, we are unable to move forward with this loan at this time. Your loan officer can walk you through why and discuss any options.',
  withdrawn: 'This loan file has been withdrawn. If this wasn\'t expected, contact your loan officer and we\'ll help sort it out.',
};
// The borrower-facing loan journey, as a 6-stage progress path for the email
// stepper. Each internal status maps to a stage index; stages before it are
// done, the mapped stage is current, later stages upcoming. Terminal
// declined/withdrawn statuses show no path (handled by returning null).
const BORROWER_JOURNEY = ['Submitted', 'In review', 'Underwriting', 'Approved', 'Clear to close', 'Funded'];
const STATUS_STAGE = { file_intake: 0, new: 0, in_review: 1, processing: 1, underwriting: 2, approved: 3, clear_to_close: 4, funded: 5 };
function borrowerJourney(status) {
  const idx = STATUS_STAGE[status];
  if (idx == null) return null;   // declined / withdrawn → no progress path
  return BORROWER_JOURNEY.map((label, i) => ({ label, state: i < idx ? 'done' : (i === idx ? 'current' : 'upcoming') }));
}

// Build the notifyAppBorrowers opts for a borrower-facing status transition. One
// definition so every door (portal + inbound) sends byte-identical borrower copy.
function borrowerStatusOpts(appId, fromStatus, toStatus) {
  const label = STATUS_LABEL[toStatus] || toStatus;
  const fromLabel = STATUS_LABEL[fromStatus] || fromStatus;
  const explain = BORROWER_STATUS_EXPLAIN[toStatus];
  const steps = borrowerJourney(toStatus);
  const positive = toStatus === 'funded' || toStatus === 'clear_to_close' || toStatus === 'approved';
  const badgeTone = positive ? 'positive' : (toStatus === 'declined' || toStatus === 'withdrawn' ? 'neutral' : 'teal');
  return {
    type: 'status_change', title: `Your loan status is now: ${label}`,
    body: `Your loan file has moved from "${fromLabel}" to "${label}".`,
    badge: { text: label, tone: badgeTone },
    steps: steps || undefined,   // the visual loan-journey path (null on declined/withdrawn)
    callout: explain ? { title: 'What this means', body: explain, tone: positive ? 'positive' : 'gold' } : undefined,
    applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your file',
    major: MAJOR_STATUSES.has(toStatus),   // #88: only decision statuses email the borrower
  };
}

// NOTE: the PORTAL doors advance `status_notified_external` INLINE in the same
// UPDATE that changes the status (staff.js), so a later ClickUp echo of that
// change is recognized as already-notified — no separate helper needed here.

// INBOUND (ClickUp-originated) status change → notify the borrower, GO-FORWARD
// ONLY. Atomically advance the watermark and decide in ONE statement so two
// overlapping pulls can't both notify. Silent baseline the first time a file is
// seen (prev NULL) so previously-drifted files are never blasted. An echo of a
// portal change (watermark already equals `external`) is a no-op. The borrower's
// loan officer is looped in automatically (notifyAppBorrowers BCCs them on the
// email); the team is NOT separately blasted — a ClickUp-originated change was
// made by the team IN ClickUp, so they already know. Best-effort; never throws
// into the sync.
async function notifyInboundStatusChange(appId, newExternal) {
  if (!appId || !newExternal || !STATUS_LABEL[newExternal]) return;
  try {
    const r = await db.query(
      `WITH cur AS (SELECT status_notified_external AS prev FROM applications WHERE id=$1)
       UPDATE applications a SET status_notified_external=$2
         FROM cur
        WHERE a.id=$1 AND a.deleted_at IS NULL
          AND a.status_notified_external IS DISTINCT FROM $2
       RETURNING cur.prev AS prev`, [appId, newExternal]);
    if (!r.rows[0]) return;            // echo / unchanged / deleted → nothing to send
    const prev = r.rows[0].prev;
    if (prev == null) return;          // first sight of this file → silent baseline (go-forward)
    await notify.notifyAppBorrowers(appId, borrowerStatusOpts(appId, prev, newExternal));
  } catch (_) { /* best-effort — a notify failure must never break the inbound pull */ }
}

module.exports = {
  STATUS_LABEL, MAJOR_STATUSES, BORROWER_STATUS_EXPLAIN, BORROWER_JOURNEY, STATUS_STAGE,
  borrowerJourney, borrowerStatusOpts, notifyInboundStatusChange,
};
