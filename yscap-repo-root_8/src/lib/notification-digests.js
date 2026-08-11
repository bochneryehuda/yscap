'use strict';
/**
 * Scheduled notification digests (owner-directed 2026-07-20).
 *
 * Four recurring emails that keep everyone informed WITHOUT bombardment — each
 * self-gates through an audit_log stamp (the same pattern as the sync-review
 * weekly digest) so it sends at most once per period even though the dispatcher
 * runs every 30 minutes and survives restarts / multiple instances:
 *
 *   1. weeklyBorrowerOutstandingOnce — a gentle weekly "here's what's still
 *      needed" to any borrower with open items (per file, ≤ once / 6 days).
 *   2. dailyPipelineDigestOnce       — each morning, every loan officer/processor
 *      gets a snapshot of their files needing attention (per staffer, ≤ once/day).
 *   3. staleFileAlertsOnce           — the assigned team is alerted when a file has
 *      sat at one stage too long (per file, ≤ once / 3 days).
 *   4. weeklyAdminSummaryOnce        — a Monday pipeline health snapshot to admins.
 *
 * Every function is exported so it can be invoked/tested directly (bypassing the
 * time-of-day window in runDue). All best-effort: a failure never throws out of
 * the dispatcher. Master kill-switch: NOTIFY_DIGESTS_ENABLED=0.
 */
const db = require('../db');
const notify = require('./notify');
const drawLabel = require('./draw-label');   // "Draw 2" / "Draws 2, 3" — the ONE way a draw is named in a subject
const workflow = require('./workflow');
const workflowQueues = require('./email/workflow-queues');
const loanExceptions = require('./loan-exceptions');
const { outstandingItems } = require('./reminders');
const { claimOncePerPeriod } = require('./throttle-claim');
// Advisory-only sources must never score or notify — one shared filter (audit 2026-07-27).
const aiSuggestions = require('./underwriting/ai-suggestions');

const STATUS_LABEL = {
  file_intake: 'File intake', new: 'Submitted', in_review: 'In review', processing: 'Processing',
  underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close',
  funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn',
};
const TERMINAL = ['funded', 'declined', 'withdrawn'];

/* ── The throttle belongs in the QUERY, not only in the loop (audit finding, 2026-07-26) ──
 *
 * Ordering a capped batch was only half the fix. Every one of these digests sorts by a "how long
 * has this been waiting" timestamp that SENDING DOES NOT ADVANCE — the delivered_at of an
 * un-accepted finding, the wire_due_at of an unpaid release, the status_changed_at of a stalled
 * file. So the same rows sort to the front on every single pass, the batch's membership never
 * rotates, and past the cap a file waits not on a queue but on an EVENT THE DIGEST ITSELF CANNOT
 * CAUSE (the borrower accepting, the wire going out, the file moving stage). Deterministic, and
 * still starved — for the tail, strictly worse than the arbitrary batch it replaced.
 *
 * The real fix is to stop already-notified rows from consuming a slot at all. Each digest is
 * self-gated to at most one send per file per period; expressing that SAME throttle in the WHERE
 * clause means the cap now bounds only rows that still NEED work. With 200 slots × 8 passes/day ×
 * a 3-day gate, every waiting file is reached long before its next send is even due — so the cap
 * genuinely delays a file instead of hiding it, which is what the ordering was for.
 *
 * `_gate` remains the authority (it is atomic across instances and fails closed); this predicate is
 * a cheap pre-filter over the same audit_log stamp, never a replacement for it.
 */
const DIGEST_ACTION = Object.freeze({
  BORROWER_OUTSTANDING: 'borrower_outstanding_digest',
  STALE_FILE: 'stale_file_alert',
  DRAW_FINDINGS_REMINDER: 'draw_findings_reminder',
  // After the borrower has been nudged CAP times and still not accepted, we STOP
  // emailing them (owner-directed: "the borrower should not get these repeating
  // emails again and again") and hand off to the draw coordinator to follow up.
  DRAW_BORROWER_STUCK: 'draw_borrower_stuck',
  TRUSTPOINT_UNRELEASED: 'trustpoint_unreleased',
  DRAW_RELEASE_OVERDUE: 'draw_release_overdue',
  // Increment C — the four missing per-status draw COORDINATOR reminders (owner-directed 2026-08-04,
  // blueprint docs/DRAW-WORKFLOW-STATUS-RESEARCH.md): every stage that waits on US / the coordinator
  // gets its own self-gated nudge, so a draw never sits silently between borrower approval and funding.
  ORDER_TRUSTPOINT: 'order_trustpoint_reminder',          // 2b: enter the submitted draw into TrustPoint
  ORDER_TRINITY: 'order_trinity_reminder',                // 2p: order the physical inspection on Trinity
  INVESTOR_PENDING_DELIVERY: 'investor_pending_delivery', // 7a: borrower approved, not yet sent to the investor
  WITH_INVESTOR: 'draw_with_investor_reminder',           // 7b: sent to the investor, still awaiting funding
  ORDER_OVERDUE: 'order_overdue_nudge',
  // Per-FILE stamp for the direct-source sweep (the sweep's other stamp,
  // `direct_source_sweep_daily`, is global and only prevents overlapping runs).
  DIRECT_SOURCE_FILE: 'direct_source_file_verified',
  // The gaps in the draw workflow that had NO reminder at all (owner-directed 2026-08-09).
  // Every one covers a stretch where a draw could sit silently: between ordering an inspection and
  // the report arriving, between the report arriving and somebody reading it, between reading it
  // and the borrower being told, after a final approval on a file WE release, an investor fee we
  // are owed, and retainage that is releasable at the end of the job.
  DRAW_INSPECTION_LATE: 'draw_inspection_late',
  DRAW_FINDINGS_UNREVIEWED: 'draw_findings_unreviewed',
  DRAW_APPROVED_UNRECORDED: 'draw_approved_unrecorded',
  INVESTOR_FEE_OWED: 'investor_fee_owed_chase',
  RETAINAGE_RELEASABLE: 'retainage_releasable',
  // A funded loan that was NOT sold at the closing table and still has no purchase advice a month
  // later (owner-directed 2026-08-09: "if it doesn't get a purchase date till 30 days after a
  // funding date, then we should get notified — super admin should get notified, and the closer
  // should get notified").
  PURCHASE_ADVICE_MISSING: 'purchase_advice_missing',
});

/**
 * SQL fragment: this file has NOT been stamped with `action` inside `intervalSql`.
 * @param {string} idExpr      the application-id expression in the outer query (e.g. 'a.id')
 * @param {string} action      a DIGEST_ACTION value — an internal constant, never user input
 * @param {string} intervalSql an interval expression (e.g. `interval '3 days'`, `($1||' hours')::interval`)
 */
function notThrottled(idExpr, action, intervalSql) {
  // The action names are module constants, inlined so each caller keeps its own $-numbering. This
  // assertion is the guard that keeps it that way: anything but a bare identifier is a programming
  // error here, and must never become a path for interpolated input.
  if (!/^[a-z][a-z0-9_]*$/.test(String(action))) throw new Error(`notThrottled: unsafe action ${action}`);
  // `entity_type` is pinned even though `action` already implies it: without the LEADING column of
  // the existing (entity_type, entity_id) index, Postgres cannot use that index at all and falls
  // back to scanning the whole action partition once PER CANDIDATE ROW (measured at 7.7x on a tiny
  // local table — and audit_log is append-only, never pruned, so it only gets worse). Every
  // per-file gate stamp is written with entity_type='application' (it is `claimOncePerPeriod`'s
  // default and no digest overrides it), so this narrows nothing and unlocks the index.
  return `NOT EXISTS (SELECT 1 FROM audit_log l
                       WHERE l.entity_type = 'application' AND l.action = '${action}'
                         AND l.entity_id = ${idExpr}
                         AND l.created_at > now() - ${intervalSql})`;
}

// Current hour + weekday in the team's timezone (America/New_York, matching the
// ClickUp date convention) so digests land in the morning / on Monday, not 3am.
function nyParts(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(now);
    const hour = Number((parts.find((p) => p.type === 'hour') || {}).value);
    const weekday = (parts.find((p) => p.type === 'weekday') || {}).value; // 'Mon'..'Sun'
    return { hour: Number.isFinite(hour) ? hour : 9, weekday: weekday || 'Mon' };
  } catch (_) { return { hour: 9, weekday: 'Mon' }; }
}

// "May I send?" — atomically CLAIM the send: write the throttle stamp ONLY if
// nothing with this (action, entity) was stamped inside the window. Returns true
// only for the ONE caller that won the claim; a concurrent/overlapping pass or a
// second instance loses and returns false. Delegates to the shared
// claimOncePerPeriod, which serializes claimants with a transaction-scoped
// advisory lock so INSERT…WHERE NOT EXISTS is truly atomic across instances (a
// plain INSERT…WHERE NOT EXISTS is NOT — two READ COMMITTED txns both pass the
// check and both send, the owner-reported duplicate sweep 2026-07-20). Fails
// closed. entityId null = a global (non-file-scoped) digest.
async function _gate(action, entityId, interval) {
  return (await _claim(action, entityId, interval)) != null;
}
// Same claim, but returns the audit_log ROW ID rather than a boolean.
//
// A caller that may need to RELEASE its claim (the direct-source sweep claims before spending money
// on vendor calls) must be able to delete the exact row it wrote. Releasing by (action, entity) plus
// a time window instead — which is what this did — is a statement whose safety rests on an argument
// about every other writer of that action rather than on the statement itself, and it silently
// matches nothing if the work outlasts the window. Pinning the id removes the argument.
async function _claim(action, entityId, interval) {
  return claimOncePerPeriod({ action, entityId: entityId || null, interval });
}
/**
 * The SAME claim, for a throttle keyed on the RECIPIENT rather than on a file.
 *
 * There are two shapes here and conflating them made the fairness guard unable to tell them apart.
 * A PER-FILE throttle ("this file was nudged, don't nudge it again for 3 days") governs the rows a
 * capped work query returns, so it MUST also appear in that query's WHERE or an already-notified
 * file keeps taking a slot. A PER-RECIPIENT throttle ("this officer got their daily pipeline note")
 * governs the EMAIL, not the rows: the officer's file list is a top-N summary, and filtering it by
 * the officer's own stamp would be meaningless.
 *
 * Saying which is which in the CODE — rather than keeping a list of exceptions in the test — is what
 * lets the guard demand the SQL throttle from every per-file digest without a whitelist to fall out
 * of date. Use `_gate`/`_claim` for a file; `_gateRecipient` for a person.
 */
async function _gateRecipient(action, staffId, interval) {
  return _gate(action, staffId, interval);
}
// Give back a claim this pass made and did not use. Best-effort BY ID, so it can only ever remove
// the row this caller just wrote — never an older legitimate stamp and never another file's.
async function _releaseClaim(claimId) {
  if (!claimId) return;
  await db.query(`DELETE FROM audit_log WHERE id = $1`, [claimId]).catch(() => {});
}
// The claim row is already written by _gate; _stamp now just enriches it with the
// digest's stats for the audit trail (best-effort — never a second throttle row).
async function _stamp(action, entityId, detail) {
  await db.query(
    entityId
      ? `UPDATE audit_log SET detail=$3::jsonb
           WHERE id = (SELECT id FROM audit_log WHERE action=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 1)`
      : `UPDATE audit_log SET detail=$2::jsonb
           WHERE id = (SELECT id FROM audit_log WHERE action=$1 AND entity_id IS NULL ORDER BY created_at DESC LIMIT 1)`,
    entityId ? [action, entityId, JSON.stringify(detail || {})] : [action, JSON.stringify(detail || {})]).catch(() => {});
}

const money = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US');
const daysAt = (ts) => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000) : null);
const addrOf = (pa) => { pa = pa || {}; return pa.oneLine || pa.street || pa.line1 || '(no address yet)'; };

/* 1) Weekly "what's still needed" — per borrower file with open items. */
async function weeklyBorrowerOutstandingOnce() {
  let sent = 0;
  // ORDER BY, not just LIMIT (found 2026-07-26). A bare `LIMIT 500` lets Postgres return ANY 500
  // rows, and a DIFFERENT 500 on the next run. Past 500 open files that means each run digests an
  // arbitrary, unstable subset — a borrower can be skipped over and over and simply never receive
  // the "here's what's still needed" email, with nothing anywhere saying so. The 6-day throttle
  // made it worse rather than better: the files that DID get picked burned their gate, so the
  // rotation was not even fair by accident.
  //
  // Ordering by the file's LAST digest (never-digested first, then longest-ago) makes the queue
  // both deterministic and fair: whoever has waited longest goes first, and every file comes up
  // eventually. `id` breaks ties so two files stamped in the same instant still have a stable order.
  //
  // AUDIT FIX (2026-07-26) — ordering alone made this WORSE, and could zero the digest entirely.
  // The sort key is the file's last digest stamp, written by `_gate` — which is claimed only AFTER
  // the open-item list comes back non-empty (deliberately: a file with nothing outstanding must not
  // burn its 6-day throttle, owner audit 2026-07-20). So a file that has never had an open item
  // NEVER gets a stamp, keeps last_digest NULL forever, and `NULLS FIRST` pins it at the head of
  // every pass for the life of the file. With 500+ such files — new applications, files whose items
  // were all satisfied before a digest ran — the whole batch is files with nothing to say, the loop
  // sends ZERO emails, and the truncation warning below reports a perfectly healthy-looking pass.
  //
  // So the candidate set is now narrowed in SQL to files that actually HAVE something outstanding
  // (mirroring reminders.outstandingItems) and are not already inside their 6-day throttle. The JS
  // `if (!items.length) continue` guard stays: this predicate is a superset (outstandingItems also
  // drops entries that format to nothing), so SQL narrows, JS decides.
  const hasOpenBorrowerItem = `(
       EXISTS (SELECT 1 FROM checklist_items ci
                WHERE ci.application_id = a.id AND ci.audience IN ('borrower','both')
                  AND ci.status IN ('outstanding','requested','issue'))
    OR EXISTS (SELECT 1 FROM conditions c
                WHERE c.application_id = a.id AND c.audience IN ('borrower','both')
                  AND NULLIF(TRIM(c.borrower_title), '') IS NOT NULL AND c.status IN ('open','borrower_responded')))`;
/* NULLIF, not a bare IS NOT NULL (audit 2026-07-26). `IS NOT NULL` admits the EMPTY STRING, and
   `reminders.outstandingItems` — the function that actually builds the email body — formats a
   condition with an empty title to '' and drops it with `.filter(Boolean)`. So a file whose only
   open borrower item was a condition titled '' passed this predicate, came back with an empty item
   list, hit the `continue` below, and therefore never claimed its throttle stamp. Its `last_digest`
   stayed NULL forever, and `NULLS FIRST` pinned it to the head of every single pass for the life of
   the file — occupying a slot in the cap permanently and sending nothing. That is the exact
   residual shape of the bug this predicate was written to close, narrowed to one column. The
   checklist half above already guards its label with COALESCE/NULLIF; this makes the two halves
   agree, which is the property that matters: the SQL must select exactly the population the body
   builder reports as non-empty. */
  const apps = await db.query(
    // The last-digest stamp is read ONCE in a LATERAL and used for BOTH the throttle and the sort,
    // so the fair-rotation key and the "already sent recently" test can never disagree.
    `SELECT a.id, d.at AS last_digest
       FROM applications a
       LEFT JOIN LATERAL (
         SELECT max(l.created_at) AS at FROM audit_log l
          WHERE l.entity_type = 'application' AND l.action = '${DIGEST_ACTION.BORROWER_OUTSTANDING}' AND l.entity_id = a.id
       ) d ON true
      WHERE a.deleted_at IS NULL AND a.borrower_id IS NOT NULL
        AND a.status <> ALL($1)
        AND (d.at IS NULL OR d.at < now() - interval '6 days')
        AND ${hasOpenBorrowerItem}
      ORDER BY last_digest ASC NULLS FIRST, a.id
      LIMIT 500`, [TERMINAL]);
  // Say so when the cap truncates. A silently-dropped tail is what made this invisible for so long;
  // an operator can now see that the portfolio has outgrown one pass.
  if (apps.rows.length >= 500) {
    try {
      // Count the SAME population the batch was drawn from (due + something outstanding), not every
      // eligible file — a total that counts files with nothing to send would overstate the backlog
      // and make an ordinary pass look like a truncated one.
      const total = (await db.query(
        `SELECT count(*)::int AS n
           FROM applications a
          WHERE a.deleted_at IS NULL AND a.borrower_id IS NOT NULL AND a.status <> ALL($1)
            AND ${notThrottled('a.id', DIGEST_ACTION.BORROWER_OUTSTANDING, "interval '6 days'")}
            AND ${hasOpenBorrowerItem}`, [TERMINAL])).rows[0];
      if (total && total.n > apps.rows.length) {
        console.warn(`[digests] borrower digest considered ${apps.rows.length} of ${total.n} eligible files this pass `
          + '(oldest-waiting first; the rest come up on following passes)');
      }
    } catch (_) { /* the count is only for visibility — never block the digest on it */ }
  }
  for (const a of apps.rows) {
    try {
      // Compute content FIRST, then claim the gate — otherwise a file with zero
      // open items today would burn the 6-day throttle and get NO digest for the
      // rest of the window once it gains an item (owner-reported audit 2026-07-20).
      const items = await outstandingItems(a.id);
      if (!items.length) continue;
      if (!(await _gate(DIGEST_ACTION.BORROWER_OUTSTANDING, a.id, '6 days'))) continue;
      const shown = items.slice(0, 12);
      const lines = shown.map((l, i) => `${i + 1}. ${l}`);
      if (items.length > shown.length) lines.push(`…and ${items.length - shown.length} more, all listed in your portal.`);
      lines.push('Completing these keeps your loan moving. Questions on any of them? Just reply to this email.');
      // A completion meter — the borrower's own checklist items done vs total —
      // turns the list into visible progress ("you're most of the way there").
      let progress = null;
      try {
        const c = (await db.query(
          `SELECT count(*) FILTER (WHERE status='satisfied')::int AS done, count(*)::int AS total
             FROM checklist_items
            WHERE application_id=$1 AND audience IN ('borrower','both') AND waived_at IS NULL`, [a.id])).rows[0];
        if (c && c.total > 0) progress = { done: c.done, total: c.total, label: `${c.done} of ${c.total} items complete` };
      } catch (_) { /* meter is best-effort */ }
      await notify.notifyAppBorrowers(a.id, {
        type: 'digest',
        title: items.length === 1 ? 'One item is still needed on your loan' : `${items.length} items are still needed on your loan`,
        badge: { text: 'Action needed', tone: 'action' },
        body: 'Here’s a quick summary of what your loan team is still waiting on:',
        progress: progress || undefined,
        lines,
        applicationId: a.id, link: `/app/${a.id}`, ctaLabel: 'Complete your items' });
      await _stamp(DIGEST_ACTION.BORROWER_OUTSTANDING, a.id, { open: items.length });
      sent++;
    } catch (e) { console.error('[digest] borrower-outstanding', a.id, e && e.message); }
  }
  return sent;
}

/* 2) Daily pipeline digest — per active loan officer / processor. */
async function dailyPipelineDigestOnce() {
  let sent = 0;
  const staff = await db.query(
    // is_external=false: an external (TPO / broker) user is the loan-officer
    // assignee on their firm's files, so without this they would receive the
    // INTERNAL-format daily pipeline digest. Brokers get their own view through
    // the /api/tpo surface (TPO PORTAL invariant, CLAUDE.md).
    `SELECT DISTINCT s.id, s.email, s.full_name
       FROM staff_users s
       JOIN application_assignees aa ON aa.staff_id=s.id AND aa.removed_at IS NULL
       JOIN applications a ON a.id=aa.application_id AND a.deleted_at IS NULL
      WHERE s.is_active=true AND s.is_external=false AND COALESCE(s.notifications_enabled,true)=true
        AND a.status <> ALL($1)`, [TERMINAL]);
  for (const st of staff.rows) {
    try {
      const files = await db.query(
        `SELECT a.id, a.ys_loan_number, a.property_address, a.status, a.status_changed_at,
                (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id
                   AND ci.audience IN ('borrower','both') AND ci.status IN ('outstanding','requested','issue')) AS open_borrower
           FROM applications a
           JOIN application_assignees aa ON aa.application_id=a.id AND aa.staff_id=$1 AND aa.removed_at IS NULL
          WHERE a.deleted_at IS NULL AND a.status <> ALL($2)
          -- a.id is the TIE-BREAK, not decoration: status_changed_at is far from unique (a bulk
          -- status move stamps many files the same second, and NULLs all tie), so without it the
          -- officer's 40-file snapshot still varies run to run among tied rows. An ORDER BY that
          -- does not end in a unique column is not a total order (audit finding 2026-07-26).
          ORDER BY a.status_changed_at ASC NULLS FIRST, a.id
          LIMIT 40`, [st.id, TERMINAL]);
      if (!files.rows.length) continue;
      // Claim the once-per-day gate only once we know there's content to send
      // (don't burn the window on an empty pass).
      if (!(await _gateRecipient('pipeline_digest_daily', st.id, '20 hours'))) continue;
      const lines = files.rows.map((f) => {
        const d = daysAt(f.status_changed_at);
        return `${f.ys_loan_number || 'Loan # pending'} · ${addrOf(f.property_address)} — ${STATUS_LABEL[f.status] || f.status}`
          + (d != null ? `, ${d}d at this stage` : '')
          + (f.open_borrower ? `, ${f.open_borrower} borrower item(s) open` : '');
      });
      const first = (st.full_name || '').trim().split(/\s+/)[0];
      await notify.notifyStaff(st.id, {
        type: 'digest',
        title: `Your pipeline today: ${files.rows.length} active file${files.rows.length === 1 ? '' : 's'}`,
        badge: { text: `${files.rows.length} active`, tone: 'teal' },
        body: `Good morning${first ? `, ${first}` : ''} — here’s your pipeline snapshot, oldest-at-stage first.`,
        lines,
        link: '/internal/pipeline', ctaLabel: 'Open your pipeline', emailTo: st.email });
      await _stamp('pipeline_digest_daily', st.id, { files: files.rows.length });
      sent++;
    } catch (e) { console.error('[digest] pipeline', st.id, e && e.message); }
  }
  return sent;
}

/* 2b) WEEKLY LOAN-OFFICER PIPELINE SNAPSHOT (owner-directed 2026-08-07: *"we also need to set up
   a nice email every week to only the loan officers with a snapshot of their pipeline, active
   files, funded files, totals, and details."*).

   Deliberately NOT a second copy of the daily digest above. The daily one is a to-do list —
   oldest-at-stage first, so the top row is the thing to chase today. This one is a WEEK's read:
   the totals first (what is in flight, what closed), then the file-by-file detail.

   ONLY LOAN OFFICERS, by the owner's word. `role='loan_officer'` is the test, so a processor or
   a closer who happens to be assigned to files does not receive it — they have their own Workflow
   nudge, and an officer's book is a sales read, not a task list.

   Every figure is a plain count/sum over the officer's own assigned, non-deleted files. Nothing
   here is a pricing number — `loan_amount` is the registered amount already stored on the row. */
async function weeklyOfficerPipelineOnce() {
  let sent = 0;
  let officers = [];
  try {
    officers = (await db.query(
      `SELECT id, email, full_name FROM staff_users
        WHERE is_active = true AND role = 'loan_officer'
          AND COALESCE(notifications_enabled, true) = true
          AND email IS NOT NULL AND btrim(email) <> ''
        ORDER BY full_name`)).rows;
  } catch (_) { return 0; }

  const money0 = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

  for (const st of officers) {
    try {
      /* ONE query for the officer's whole book — active AND funded — so the totals and the detail
         table can never be computed off two different snapshots taken a moment apart. Funded is
         windowed to the last 90 days: "funded files" on a weekly snapshot means recent closings,
         and an all-time total would grow forever and stop being news. */
      const r = await db.query(
        `SELECT a.id, a.ys_loan_number, a.property_address, a.status, a.status_changed_at,
                a.loan_amount, a.expected_closing, a.funded_date,
                (SELECT count(*)::int FROM checklist_items ci
                  WHERE ci.application_id = a.id AND ci.audience IN ('borrower','both')
                    AND ci.status IN ('outstanding','requested','issue')) AS open_borrower
           FROM applications a
           JOIN application_assignees aa ON aa.application_id = a.id
                AND aa.staff_id = $1 AND aa.removed_at IS NULL AND aa.role = 'loan_officer'
          WHERE a.deleted_at IS NULL
            AND (a.status <> ALL($2)
                 OR (a.status = 'funded' AND a.funded_date IS NOT NULL
                     AND a.funded_date >= (now() - interval '90 days')::date))
          ORDER BY a.status_changed_at ASC NULLS FIRST, a.id
          LIMIT 200`, [st.id, TERMINAL]);

      const all = r.rows;
      const active = all.filter((f) => f.status !== 'funded');
      const funded = all.filter((f) => f.status === 'funded');
      // Nothing in flight AND nothing closed recently → there is no snapshot to send. A weekly
      // email that says "you have no files" every week is the noise this is meant to avoid.
      if (!active.length && !funded.length) continue;
      if (!(await _gateRecipient('officer_pipeline_weekly', st.id, '6 days'))) continue;

      const sum = (rows) => rows.reduce((t, f) => t + (Number(f.loan_amount) || 0), 0);
      const activeVol = sum(active);
      const fundedVol = sum(funded);
      const openItems = active.reduce((t, f) => t + (Number(f.open_borrower) || 0), 0);

      const table = active.length ? {
        title: 'Your active files — longest at their current stage first',
        head: ['Property / file', 'Stage', 'Days', 'Loan amount', 'Borrower items'],
        align: ['left', 'left', 'right', 'right', 'right'],
        rows: active.slice(0, 25).map((f) => {
          const d = daysAt(f.status_changed_at);
          return [
            `${addrOf(f.property_address)}${f.ys_loan_number ? ` · ${String(f.ys_loan_number).toUpperCase()}` : ''}`,
            STATUS_LABEL[f.status] || f.status,
            d != null ? String(d) : '—',
            f.loan_amount != null ? money0(f.loan_amount) : '—',
            f.open_borrower ? String(f.open_borrower) : '—',
          ];
        }),
        note: active.length > 25 ? `…and ${active.length - 25} more active files in your pipeline.` : null,
      } : null;

      const fundedTable = funded.length ? {
        title: 'Funded in the last 90 days',
        head: ['Property / file', 'Funded', 'Loan amount'],
        align: ['left', 'left', 'right'],
        rows: funded.slice(0, 15).map((f) => [
          `${addrOf(f.property_address)}${f.ys_loan_number ? ` · ${String(f.ys_loan_number).toUpperCase()}` : ''}`,
          f.funded_date ? String(f.funded_date).slice(0, 10) : '—',
          f.loan_amount != null ? money0(f.loan_amount) : '—',
        ]),
        note: funded.length > 15 ? `…and ${funded.length - 15} more funded in the window.` : null,
      } : null;

      const first = (st.full_name || '').trim().split(/\s+/)[0];
      await notify.notifyStaff(st.id, {
        type: 'digest',
        title: `Your week: ${active.length} active file${active.length === 1 ? '' : 's'}`,
        badge: { text: 'Weekly snapshot', tone: 'teal' },
        body: `${active.length} active (${money0(activeVol)}) · ${funded.length} funded in 90 days (${money0(fundedVol)})`,
        emailBody: `Here is your book as it stands${first ? `, ${first}` : ''} — what is in flight, what has closed, and where each file is sitting.`,
        figures: {
          primary: { label: 'Active pipeline', value: money0(activeVol), sub: `across ${active.length} file${active.length === 1 ? '' : 's'}`, tone: 'teal' },
          secondary: [
            { label: 'Funded (90 days)', value: money0(fundedVol), tone: 'positive' },
            { label: 'Files funded', value: String(funded.length), tone: 'positive' },
            { label: 'Borrower items open', value: String(openItems) },
          ],
        },
        // Two tables cannot both ride the single `table` slot, so the funded list goes in as a
        // second block through `sections` — a titled block whose body is one line per file. The
        // active list is the one that gets the real table, because it is the one people scan.
        table,
        sections: fundedTable ? [{
          title: fundedTable.title,
          body: [
            ...fundedTable.rows.map((row) => `${row[0]} — funded ${row[1]} · ${row[2]}`),
            ...(fundedTable.note ? [fundedTable.note] : []),
          ],
        }] : null,
        link: '/internal/pipeline', ctaLabel: 'Open your pipeline', emailTo: st.email,
      });
      await _stamp('officer_pipeline_weekly', st.id, { active: active.length, funded: funded.length });
      sent++;
    } catch (e) { console.error('[digest] officer-pipeline-weekly', st.id, e && e.message); }
  }
  return sent;
}

/* 3) Stale-file alerts — the assigned team is nudged when a file hasn't moved. */
async function staleFileAlertsOnce() {
  let sent = 0;
  const staleDays = Math.max(1, Number(process.env.STALE_FILE_DAYS || 10));
  const files = await db.query(
    `SELECT a.id, a.status, a.status_changed_at
       FROM applications a
      WHERE a.deleted_at IS NULL AND a.status <> ALL($1) AND a.status <> 'file_intake'
        -- A PAUSED file is not a stalled one. on_hold is inactive everywhere else in the system
        -- (INACTIVE_FILE_STATUSES: KPIs, tasks, reminders, borrower notifications) and it was the
        -- one place still alerting on it — so a deliberately-parked file emailed its team "stalled
        -- for 380 days" every 3 days. Worse, db/319 preserves the ORIGINAL status_changed_at when
        -- it heals an on-hold file, so those ancient timestamps sort to the very front and would
        -- occupy the cap ahead of every genuinely stuck live file.
        AND a.status <> 'on_hold'
        AND a.status_changed_at IS NOT NULL
        AND a.status_changed_at < now() - ($2 || ' days')::interval
        AND EXISTS (SELECT 1 FROM application_assignees aa WHERE aa.application_id=a.id AND aa.removed_at IS NULL)
        -- Already alerted inside the 3-day gate → do not consume a slot (see notThrottled).
        -- status_changed_at does NOT advance when the alert is sent, so without this the same 200
        -- files sort to the front of every pass forever and file 201 is never reached at all.
        AND ${notThrottled('a.id', DIGEST_ACTION.STALE_FILE, "interval '3 days'")}
      -- STALEST FIRST is both deterministic and the right priority here — the file that has waited
      -- longest is the one most worth telling somebody about.
      ORDER BY a.status_changed_at ASC, a.id
      LIMIT 200`, [TERMINAL, String(staleDays)]);
  for (const f of files.rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.STALE_FILE, f.id, '3 days'))) continue;
      const d = daysAt(f.status_changed_at);
      await notify.notifyAppStaff(f.id, {
        type: 'digest',
        title: `File stalled: ${d} days at "${STATUS_LABEL[f.status] || f.status}"`,
        badge: { text: 'Needs attention', tone: 'action' },
        body: `This file hasn’t changed stages in ${d} days. A quick check-in may be needed to keep it on track — the file details are below.`,
        applicationId: f.id, link: `/internal/app/${f.id}`, ctaLabel: 'Open the loan file' });
      await _stamp(DIGEST_ACTION.STALE_FILE, f.id, { days: d, status: f.status });
      sent++;
    } catch (e) { console.error('[digest] stale', f.id, e && e.message); }
  }
  return sent;
}

/* 4) Weekly admin pipeline summary. */
async function weeklyAdminSummaryOnce() {
  if (!(await _gate('admin_weekly_summary', null, '6 days'))) return 0;
  const s = (await db.query(
    `SELECT
       (SELECT count(*)::int FROM applications WHERE created_at > now()-interval '7 days' AND deleted_at IS NULL) AS new_files,
       (SELECT count(*)::int FROM applications WHERE status='funded' AND status_changed_at > now()-interval '7 days') AS funded,
       (SELECT count(*)::int FROM applications WHERE deleted_at IS NULL AND loan_officer_id IS NULL AND status <> ALL($1)) AS unassigned,
       (SELECT count(*)::int FROM applications WHERE deleted_at IS NULL AND status <> ALL($1)) AS active`,
    [TERMINAL])).rows[0];
  let openReviews = 0;
  try { openReviews = Number((await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE resolved_at IS NULL`)).rows[0].c) || 0; } catch (_) {}
  const admins = await db.query(`SELECT id, email FROM staff_users WHERE role IN ('admin','super_admin') AND is_active=true`);
  for (const ad of admins.rows) {
    try {
      await notify.notifyStaff(ad.id, {
        type: 'digest',
        title: 'Weekly pipeline summary',
        badge: { text: 'Weekly', tone: 'teal' },
        hero: { label: 'Active pipeline', value: String(s.active), sub: `${s.funded} funded · ${s.new_files} new this week`, tone: 'teal' },
        body: 'Here’s this week’s snapshot of the whole pipeline.',
        meta: [
          { label: 'New files (last 7 days)', value: String(s.new_files) },
          { label: 'Funded (last 7 days)', value: String(s.funded) },
          { label: 'Active files', value: String(s.active) },
          { label: 'Needing assignment', value: String(s.unassigned) },
          { label: 'Open sync reviews', value: String(openReviews) },
        ],
        link: '/internal/pipeline', ctaLabel: 'Open the console', emailTo: ad.email });
    } catch (e) { console.error('[digest] admin-summary', ad.id, e && e.message); }
  }
  await _stamp('admin_weekly_summary', null, { ...s, openReviews });
  return admins.rows.length;
}

/* R4.13 — Weekly admin+ digest of the top-5 riskiest files by AI risk score.
   Same weighted math as R4.1 (fatal=25, warning=8, info=2, other=4, capped at
   100). Silent when no file has any open finding. Once per week, admin+ only,
   audit-log gated. */
async function weeklyTopRiskyFilesOnce() {
  if (!(await _gate('admin_weekly_top_risky', null, '6 days'))) return 0;
  let top;
  try {
    top = await db.query(
      `SELECT a.id, a.ys_loan_number, a.property_address, a.status AS app_status,
              a.program, u.full_name AS lo_name, u.email AS lo_email,
              b.first_name, b.last_name,
              LEAST(100, COALESCE(SUM(CASE severity WHEN 'fatal' THEN 25 WHEN 'warning' THEN 8 WHEN 'info' THEN 2 ELSE 4 END),0))::int AS score,
              COUNT(*) FILTER (WHERE severity='fatal')::int AS fatals
         FROM applications a
         JOIN ai_suggestions s ON s.application_id = a.id
         LEFT JOIN staff_users u ON u.id = a.loan_officer_id
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','cancelled','declined','funded')
          AND s.status IN ('open','marked_important','escalated','asked_admin')
          AND ${aiSuggestions.notScoredSql('s')}
        GROUP BY a.id, a.ys_loan_number, a.property_address, a.status, a.program,
                 u.full_name, u.email, b.first_name, b.last_name
       HAVING COUNT(*) > 0
        ORDER BY score DESC, a.id
        LIMIT 5`);
  } catch (_) { return 0; }
  if (!top.rows.length) { await _stamp('admin_weekly_top_risky', null, { none: true }); return 0; }
  const admins = await db.query(
    `SELECT id, email FROM staff_users WHERE role IN ('admin','super_admin') AND is_active=true`);
  if (!admins.rows.length) return 0;
  const lines = top.rows.map((r) => {
    const addr = (r.property_address && (r.property_address.line1 || r.property_address.address || r.property_address.oneLine)) || String(r.id).slice(0, 8);
    const bucket = r.score >= 80 ? 'CRITICAL' : r.score >= 50 ? 'ELEVATED' : r.score >= 20 ? 'moderate' : 'low';
    return `• ${addr} — ${r.first_name || ''} ${r.last_name || ''} · ${r.program || 'no program'} · LO ${r.lo_name || 'unassigned'} · score ${r.score} (${bucket}) · ${r.fatals} fatal`;
  });
  for (const ad of admins.rows) {
    try {
      await notify.notifyStaff(ad.id, {
        type: 'digest',
        title: 'Riskiest files this week (AI aggregate)',
        badge: { text: 'Weekly', tone: 'crit' },
        hero: { label: 'Highest risk', value: String(top.rows[0].score), sub: `${top.rows.length} file${top.rows.length === 1 ? '' : 's'} above threshold`, tone: 'crit' },
        body: 'Below are the files with the highest weighted AI risk score right now. Consider bulk-dismissing false positives, muting recurring codes, or asking the super-admin on any that require judgment.',
        lines,
        link: '/internal/insights', ctaLabel: 'Open Insights', emailTo: ad.email });
    } catch (e) { console.error('[digest] admin-weekly-top-risky', ad.id, e && e.message); }
  }
  await _stamp('admin_weekly_top_risky', null, { admins: admins.rows.length, top: top.rows.map(r => ({ id: r.id, score: r.score })) });
  return admins.rows.length;
}

/* R5.64 — AI QA Department: a nightly "did we miss anything?" desk audit.
   Owner-directed (9.8/10): the QA layer reviews the underwriter, not the loan.
   Runs deterministic quality checks over currently-active files and rolls the
   results up to super-admins ONCE/day. Every check is a real quality signal
   the desk should look at — never an autonomous action. Silent when clean.

   Checks (all data-driven, no AI cost):
     1. duplicate open conditions  — the SAME condition template open more than
        once on a file (a data-cleanliness / double-ask problem).
     2. cleared-without-evidence   — a DOCUMENT condition marked satisfied /
        signed-off with NO current document attached (cleared with no proof).
     3. advanced-with-open-fatal   — a file at approved/CTC/funded that still
        has an OPEN fatal AI suggestion (a fatal that was never resolved).
   Self-gates via audit_log ('qa_desk_audit', ~once/20h). */
async function qaDeskAuditOnce() {
  if (!(await _gate('qa_desk_audit', null, '20 hours'))) return 0;
  let dupes = { rows: [] }, noEvidence = { rows: [] }, openFatal = { rows: [] };
  try {
    [dupes, noEvidence, openFatal] = await Promise.all([
      // 1) same condition template open ≥2× on one active file.
        /* ORDER BY … a.id is a TOTAL order (audit 2026-07-26: `t.code` alone is not — the query
           groups by a.id as WELL as t.code, so two different files carrying the same code and the
           same count tie and come back in whatever order the plan happens to produce).
           `count(*) OVER ()` reports how many groups matched IN TOTAL, so a truncated batch says so
           instead of reading as the whole answer — see the note on the sibling queries below. */
        db.query(
        `SELECT a.id AS application_id, a.property_address, t.code, COUNT(*)::int AS n,
                count(*) OVER ()::int AS total_matches
           FROM checklist_items ci
           JOIN applications a ON a.id = ci.application_id AND a.deleted_at IS NULL
           JOIN checklist_templates t ON t.id = ci.template_id
          WHERE a.status NOT IN ('withdrawn','cancelled','declined','funded')
            AND ci.status IN ('outstanding','requested','received','issue')
          GROUP BY a.id, a.property_address, t.code
         HAVING COUNT(*) > 1
          ORDER BY n DESC, t.code, a.id
          LIMIT 25`),
      // 2) a document condition cleared with no current document attached.
        /* NEWEST CLEARANCE FIRST, and the total is reported (audit 2026-07-26).
           This was `ORDER BY a.id LIMIT 25` — ordered, and totally ordered, and STILL an instance of
           the exact starvation this session set out to kill. A file's id is a UUID that never
           changes, and this audit writes nothing that removes a row from the set, so the same lowest
           25 ids were reported to the super-admins every night for the life of the deployment and a
           file whose id sorted 26th was permanently invisible. Ordering a capped batch is only a fix
           when the sort key ADVANCES.
           The key that advances here is the CLEARANCE itself: a condition signed off today is a
           mistake worth catching today, so newest-first is both the right audit semantics and a
           moving key. `count(*) OVER ()` then makes the cap honest — the digest can say "25 of 340"
           rather than presenting a truncated sample as the whole finding. A historical backlog is a
           one-off cleanup, which the total makes visible; it is not something a nightly note should
           silently pretend does not exist. */
        db.query(
        `SELECT a.id AS application_id, a.property_address, ci.label,
                count(*) OVER ()::int AS total_matches
           FROM checklist_items ci
           JOIN applications a ON a.id = ci.application_id AND a.deleted_at IS NULL
          WHERE a.status NOT IN ('withdrawn','cancelled','declined')
            AND COALESCE(ci.item_kind,'document') = 'document'
            AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM documents d
               WHERE d.checklist_item_id = ci.id AND d.is_current = true
                 AND COALESCE(d.review_status,'') <> 'rejected')
          ORDER BY COALESCE(ci.signed_off_at, ci.updated_at, ci.created_at) DESC NULLS LAST, ci.id
          LIMIT 25`),
      // 3) a file advanced to approved/CTC/funded with an OPEN fatal AI suggestion.
        /* Same treatment: severity first (a file with six open fatals outranks one with a single
           fatal), then the MOST RECENT fatal — an advancing key, so a newly raised fatal on a file
           that already advanced to CTC surfaces at once instead of queueing behind an untouched
           backlog. a.id remains only as the final tie-break, never as the whole order. */
        db.query(
        `SELECT a.id AS application_id, a.property_address, a.status AS app_status,
                COUNT(*)::int AS open_fatal, max(s.created_at) AS newest_fatal_at,
                count(*) OVER ()::int AS total_matches
           FROM ai_suggestions s
           JOIN applications a ON a.id = s.application_id AND a.deleted_at IS NULL
          WHERE s.severity = 'fatal'
            AND s.status IN ('open','marked_important','escalated','asked_admin')
            AND ${aiSuggestions.notScoredSql('s')}
            AND a.status IN ('approved','clear_to_close','funded')
          GROUP BY a.id, a.property_address, a.status
          ORDER BY open_fatal DESC, max(s.created_at) DESC NULLS LAST, a.id
          LIMIT 25`),
    ]);
  } catch (_) { await _stamp('qa_desk_audit', null, { error: true }); return 0; }

  // The count that goes in the SUBJECT and the tile is the REAL one. Each query is capped at 25, so
  // summing `rows.length` announced "12 quality items to review" for a backlog of 340 — the exact
  // defect the body fix addressed, surviving on the most prominent surface of all (audit
  // 2026-07-27). `shownTotal` stays only to decide whether there is anything at all to send.
  const shownTotal = dupes.rows.length + noEvidence.rows.length + openFatal.rows.length;
  if (shownTotal === 0) { await _stamp('qa_desk_audit', null, { clean: true }); return 0; }

  const admins = await db.query(
    `SELECT id, email FROM staff_users WHERE role IN ('admin','super_admin') AND is_active=true`);
  if (!admins.rows.length) return 0;

  const addr = (pa, id) => (pa && (pa.line1 || pa.address || pa.oneLine)) || String(id).slice(0, 8);
  /* NO SILENT CAPS (audit 2026-07-26). Each of these three queries is capped at 25 and the note then
     printed the SHOWN count as if it were the finding. "12 conditions cleared with no document"
     read as twelve when it could have been the first 25 of three hundred, and an admin who worked
     all twelve would reasonably believe the queue was empty. `count(*) OVER ()` rides back on the
     row, so the count says how many there really are and names the cap when one applied. */
  // How many there really are, regardless of what the cap returned.
  const realTotal = (rows) => ((rows[0] && Number.isFinite(rows[0].total_matches)) ? rows[0].total_matches : rows.length);
  const BULLETS = 8;                       // how many the body actually prints
  const headline = (rows, one, many, ranked) => {
    const total = realTotal(rows);
    const listed = Math.min(rows.length, BULLETS);
    const noun = total === 1 ? one : many;
    // Say the number the reader can actually SEE, and say honestly HOW those were chosen. The first
    // version claimed "showing the 25 most recent" while printing 8 bullets, and said "most recent"
    // for two tiles whose queries lead on severity, not on recency (audit 2026-07-27).
    return total > listed ? `${total} ${noun} (listing ${listed}, ${ranked})` : `${total} ${noun}`;
  };
  // The real, uncapped total across all three checks — the number the subject line and the tile
  // must carry, so nobody works a "12-item" queue that is actually 340.
  const grandTotal = realTotal(dupes.rows) + realTotal(noEvidence.rows) + realTotal(openFatal.rows);
  const lines = [];
  // ADVISORY ONLY (owner-directed 2026-07-27). Advancing past an open PILOT fatal is
  // NORMAL now — findings do not gate clear-to-close, so "⛔ advanced with an OPEN
  // fatal" would fire on ordinary files every single night, read as a policy breach,
  // and re-frame findings as something that should have blocked. Kept as genuinely
  // useful information (PILOT was unhappy on a file that closed — worth a look), but
  // stated as a note, and it no longer drives the digest's alarm tone.
  const aiAdvisory = require('../lib/underwriting/advisory-policy').advisoryOnly();
  if (openFatal.rows.length) {
    lines.push(aiAdvisory
      ? `👀 ${headline(openFatal.rows, 'file', 'file(s)', 'most findings first')} moved ahead with a serious PILOT finding still open (advisory — worth a look, nothing was bypassed):`
      : `⛔ ${headline(openFatal.rows, 'file', 'file(s)', 'most fatals first')} advanced with an OPEN fatal AI finding:`);
    for (const r of openFatal.rows.slice(0, 8)) lines.push(`   • ${addr(r.property_address, r.application_id)} — ${r.app_status} · ${r.open_fatal} ${aiAdvisory ? 'serious' : 'fatal'}`);
  }
  if (noEvidence.rows.length) {
    lines.push(`📄 ${headline(noEvidence.rows, 'condition', 'condition(s)', 'most recently cleared first')} cleared with no document attached:`);
    for (const r of noEvidence.rows.slice(0, 8)) lines.push(`   • ${addr(r.property_address, r.application_id)} — "${String(r.label || '').slice(0, 60)}"`);
  }
  if (dupes.rows.length) {
    lines.push(`🔁 ${headline(dupes.rows, 'duplicate open condition', 'duplicate open condition(s)', 'most copies first')}:`);
    for (const r of dupes.rows.slice(0, 8)) lines.push(`   • ${addr(r.property_address, r.application_id)} — ${r.code} ×${r.n}`);
  }

  const alarmTone = (aiAdvisory
    ? (noEvidence.rows.length || dupes.rows.length)
    : openFatal.rows.length) ? 'crit' : 'gold';
  for (const ad of admins.rows) {
    try {
      await notify.notifyStaff(ad.id, {
        type: 'digest',
        title: `AI QA — ${grandTotal} quality item${grandTotal === 1 ? '' : 's'} to review`,
        // The RED tone belongs to the two real data-quality problems (a condition
        // cleared with no document, a duplicated condition). An advisory finding on
        // an advanced file is a note, not an alarm — see the aiAdvisory block above.
        badge: { text: 'QA', tone: alarmTone },
        hero: { label: 'To review', value: String(grandTotal), sub: `${realTotal(openFatal.rows)} ${aiAdvisory ? 'advisory' : 'fatal-advanced'} · ${realTotal(noEvidence.rows)} no-evidence · ${realTotal(dupes.rows)} duplicate`, tone: alarmTone },
        body: 'PILOT reviewed the desk overnight and found the items below worth a look. These are quality signals, not automatic changes — open each file and decide.',
        lines,
        link: '/internal/insights', ctaLabel: 'Open Insights', emailTo: ad.email });
    } catch (e) { console.error('[digest] qa-desk-audit', ad.id, e && e.message); }
  }
  await _stamp('qa_desk_audit', null, {
    total: grandTotal, shown: shownTotal,
    dupes: realTotal(dupes.rows), noEvidence: realTotal(noEvidence.rows), openFatal: realTotal(openFatal.rows),
  });
  return admins.rows.length;
}

/* R4.17 — Weekly per-LO AI digest. Each active loan officer (or processor)
   gets ONE email listing the files THEY own that have open AI findings,
   ordered by weighted risk score (same fatal=25/warn=8/info=2/other=4 math
   as R4.1/R4.13). Silent for an LO with no findings. Once per week per LO,
   audit_log-gated (entity_id = staff uuid). LO is the assignee we mirror to
   application_assignees — matches how staff scope everything else. */
async function weeklyLoAiDigestOnce() {
  let officers;
  try {
    officers = await db.query(
      `SELECT DISTINCT u.id, u.email, u.full_name
         FROM staff_users u
         JOIN applications a ON a.loan_officer_id = u.id
         JOIN ai_suggestions s ON s.application_id = a.id
        WHERE u.is_active = true
          AND u.is_external = false
          AND u.role IN ('loan_officer','processor','admin','super_admin')
          AND a.deleted_at IS NULL
          AND a.status NOT IN ('withdrawn','cancelled','declined','funded')
          AND s.status IN ('open','marked_important','escalated','asked_admin')
          AND ${aiSuggestions.notScoredSql('s')}`);
  } catch (_) { return 0; }
  let sent = 0;
  for (const lo of officers.rows) {
    if (!(await _gateRecipient('lo_weekly_ai_digest', lo.id, '6 days'))) continue;
    let files;
    try {
      files = await db.query(
        `SELECT a.id, a.property_address,
                LEAST(100, COALESCE(SUM(CASE severity WHEN 'fatal' THEN 25 WHEN 'warning' THEN 8 WHEN 'info' THEN 2 ELSE 4 END),0))::int AS score,
                COUNT(*)::int AS open_findings,
                COUNT(*) FILTER (WHERE severity='fatal')::int AS fatals,
                b.first_name, b.last_name
           FROM applications a
           JOIN ai_suggestions s ON s.application_id = a.id
           LEFT JOIN borrowers b ON b.id = a.borrower_id
          WHERE a.loan_officer_id = $1
            AND a.deleted_at IS NULL
            AND a.status NOT IN ('withdrawn','cancelled','declined','funded')
            AND s.status IN ('open','marked_important','escalated','asked_admin')
            AND ${aiSuggestions.notScoredSql('s')}
          GROUP BY a.id, a.property_address, b.first_name, b.last_name
          ORDER BY score DESC, a.id
          LIMIT 10`, [lo.id]);
    } catch (_) { continue; }
    if (!files.rows.length) { await _stamp('lo_weekly_ai_digest', lo.id, { files: 0 }); continue; }
    const totalFatals = files.rows.reduce((n, r) => n + (r.fatals || 0), 0);
    const lines = files.rows.map((r) => {
      const addr = (r.property_address && (r.property_address.line1 || r.property_address.address || r.property_address.oneLine)) || String(r.id).slice(0, 8);
      const bucket = r.score >= 80 ? 'CRITICAL' : r.score >= 50 ? 'ELEVATED' : 'moderate';
      const who = require('./person-name').displayName(r);
      return `• ${addr}${who ? ` — ${who}` : ''} · score ${r.score} (${bucket}) · ${r.open_findings} open${r.fatals ? ` · ${r.fatals} fatal` : ''}`;
    });
    try {
      await notify.notifyStaff(lo.id, {
        type: 'digest',
        title: `Your files with open AI findings (${files.rows.length})`,
        badge: { text: 'Weekly', tone: totalFatals ? 'crit' : 'gold' },
        hero: { label: 'Highest risk', value: String(files.rows[0].score), sub: `${files.rows.length} file${files.rows.length === 1 ? '' : 's'} · ${totalFatals} fatal`, tone: totalFatals ? 'crit' : 'gold' },
        body: 'PILOT found things worth a look on the files below. Each item is a suggestion — nothing has been changed. Open the file, review the AI Findings panel, then decide.',
        lines,
        link: '/internal/staff', ctaLabel: 'Open your pipeline', emailTo: lo.email });
      sent++;
    } catch (e) { console.error('[digest] lo-weekly-ai', lo.id, e && e.message); }
    await _stamp('lo_weekly_ai_digest', lo.id, { files: files.rows.length, totalFatals });
  }
  return sent;
}

/* R3.43 — Weekly super-admin digest of pending AI questions. Every super-admin
   with is_active=true gets ONE email per week listing every ai_admin_questions
   row still waiting for their answer, oldest first. Silent when no pending
   questions. Self-gates via audit_log stamp so it fires at most once per week
   across restarts / instances. The R3.7 inbox link is CTA. */
async function weeklyAdminAiQuestionsOnce() {
  if (!(await _gate('admin_weekly_ai_questions', null, '6 days'))) return 0;
  let pending;
  try {
    pending = await db.query(
      `SELECT q.id, q.agent, q.question, q.asked_at,
              a.id AS application_id, a.property_address, a.status AS app_status,
              b.first_name, b.last_name,
              EXTRACT(EPOCH FROM (now() - q.asked_at))/86400 AS age_days
         FROM ai_admin_questions q
         JOIN applications a ON a.id = q.application_id AND a.deleted_at IS NULL
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE q.answered_at IS NULL
        ORDER BY q.asked_at ASC, q.id
        LIMIT 50`);
  } catch (_) { return 0; }   // schema not present yet on this deploy
  if (!pending.rows.length) { await _stamp('admin_weekly_ai_questions', null, { pending: 0 }); return 0; }
  const admins = await db.query(
    `SELECT id, email FROM staff_users WHERE role='super_admin' AND is_active=true`);
  if (!admins.rows.length) return 0;
  const lines = pending.rows.slice(0, 20).map((q) => {
    const addr = (q.property_address && (q.property_address.line1 || q.property_address.address || q.property_address.oneLine)) || String(q.application_id).slice(0, 8);
    const days = Math.max(1, Math.floor(Number(q.age_days) || 0));
    const snippet = String(q.question || '').replace(/\s+/g, ' ').slice(0, 120);
    return `• ${addr} · ${q.first_name || ''} ${q.last_name || ''} · ${q.agent} (${days}d old): ${snippet}`;
  });
  const total = pending.rows.length;
  for (const ad of admins.rows) {
    try {
      await notify.notifyStaff(ad.id, {
        type: 'digest',
        title: `${total} AI question${total === 1 ? '' : 's'} waiting for you`,
        badge: { text: 'Weekly', tone: 'gold' },
        hero: { label: 'Pending questions', value: String(total), sub: `Oldest ${Math.max(1, Math.floor(Number(pending.rows[0].age_days) || 0))}d ago`, tone: 'gold' },
        body: `The AI has ${total} question${total === 1 ? '' : 's'} that need your answer. Open the AI Inbox to reply — each answer becomes training signal for the specific agent that asked it.`,
        lines,
        link: '/internal/ai-inbox', ctaLabel: 'Open the AI Inbox', emailTo: ad.email });
    } catch (e) { console.error('[digest] admin-weekly-ai', ad.id, e && e.message); }
  }
  await _stamp('admin_weekly_ai_questions', null, { pending: total, admins: admins.rows.length });
  return admins.rows.length;
}

/* 5) Draw result awaiting the borrower — a delivered inspection result the borrower hasn't accepted or
   disputed is HOLDING THEIR MONEY (the release clock only starts on accept), so nudge them if it's sat a
   few days. Borrower-safe (notifyAppBorrowers scrubs); per file, ≤ once / 2 days. draw_findings exist only
   for PILOT-managed files (delivered via the created-only reconcile), so this is go-forward-only by data.
   The EXISTS on an ACTIVE created link both re-asserts go-forward-only at the query level and honors CLAUDE.md
   Sitewire rule 10 — a finished/paid-off project is excluded, so a leftover finding on a closed loan never nudges. */
async function drawFindingsAwaitingBorrowerOnce() {
  let sent = 0;
  // Owner-directed 2026-07-20: the release is WAITING on the borrower's accept, so
  // keep nudging them EVERY FEW HOURS (not days) until they accept or dispute —
  // the moment they act, the finding leaves 'delivered' status and drops out of
  // this query, so the nudges stop on their own. The dispatcher only runs this in
  // the 8am–6pm NY window, so "every few hours" never means a 3am email.
  // NaN-safe: a non-numeric DRAW_FINDINGS_REMINDER_HOURS must fall back to the
  // default, not become 'NaN' (which would make ('NaN'||' hours')::interval throw
  // and silently disable the nudge).
  const wh = Number(process.env.DRAW_FINDINGS_REMINDER_HOURS || 4);
  const waitHours = Number.isFinite(wh) ? Math.max(1, wh) : 4;
  // BORROWER NUDGE CAP (owner-directed: "the borrower keeps receiving these emails …
  // prevent it from being sent to him again and again … the borrower should not get
  // these repeating emails again and again for every draw"). The old sweep had a
  // rate limiter but NO stop — a borrower who never acts was emailed every few
  // business hours forever. After CAP nudges we STOP emailing the borrower and hand
  // the draw off to the draw coordinator to follow up (call them / mark approved).
  const cn = Number(process.env.DRAW_FINDINGS_BORROWER_CAP || 5);
  const CAP = Number.isFinite(cn) ? Math.max(1, Math.round(cn)) : 5;
  const rows = (await db.query(
    // The candidate set is delivered findings on an active PILOT-managed file that are NOT already
    // inside EITHER throttle: the borrower waitHours throttle (under-cap nudges) OR the coordinator
    // 2-day hand-off throttle (over-cap). Including both keeps an already-handled file from holding a
    // LIMIT slot — delivered_at never advances, so without it the most-stuck files starve the queue
    // (the exact defect the ORDER BY + notThrottled were added to prevent).
    `WITH due AS (
       -- one_draw is the draw to decorate the nudge with, and it is meaningful ONLY when this
       -- file has exactly one result waiting: with two, a single draw's figures would headline
       -- one of them and quietly misrepresent the other.
       SELECT f.application_id, count(*)::int AS n, min(f.delivered_at) AS oldest,
              array_agg(f.sitewire_draw_id) AS draw_ids,
              CASE WHEN count(*) = 1 THEN min(f.sitewire_draw_id) END AS one_draw
         FROM draw_findings f
         JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
        WHERE f.status='delivered' AND f.delivered_at IS NOT NULL
          AND f.delivered_at < now() - ($1 || ' hours')::interval
          AND EXISTS (SELECT 1 FROM sitewire_property_links pl WHERE pl.application_id=f.application_id
                        AND pl.matched_by='created' AND COALESCE(pl.lifecycle_state,'active')='active')
          AND ${notThrottled('f.application_id', DIGEST_ACTION.DRAW_FINDINGS_REMINDER, "($1 || ' hours')::interval")}
          AND ${notThrottled('f.application_id', DIGEST_ACTION.DRAW_BORROWER_STUCK, "interval '2 days'")}
        GROUP BY f.application_id
     )
     -- nudges = how many borrower reminders were already sent THIS delivered episode (since the
     -- oldest currently-delivered finding). Stamps from a prior, already-accepted draw are before
     -- that oldest delivery, so a new delivery always starts the borrower over with a fresh CAP.
     SELECT d.application_id, d.n, d.oldest, d.one_draw, d.draw_ids,
            (SELECT count(*) FROM audit_log l
               WHERE l.entity_type='application' AND l.action='${DIGEST_ACTION.DRAW_FINDINGS_REMINDER}'
                 AND l.entity_id=d.application_id AND l.created_at >= d.oldest)::int AS nudges
       FROM due d
      -- Deterministic order: an unordered LIMIT lets Postgres return an arbitrary 300 of the waiting
      -- files, so past the cap a borrower could be skipped on every pass. Oldest-waiting first.
      ORDER BY d.oldest ASC, d.application_id
      LIMIT 300`, [String(waitHours)])).rows;
  for (const r of rows) {
    try {
      if (r.nudges < CAP) {
        // Still under the cap: nudge the BORROWER, at most once per `waitHours` (the atomic gate).
        if (!(await _gate(DIGEST_ACTION.DRAW_FINDINGS_REMINDER, r.application_id, `${waitHours} hours`))) continue;
        // The nudge carries the money it is nudging about (draw rule 15) — the amount waiting on
        // their confirmation is the whole reason to open it. Only when ONE result is waiting; with
        // several there is no single headline figure, so the reminder stays a plain reminder.
        let blocks = null;
        if (r.n === 1 && r.one_draw != null) {
          blocks = await require('../sitewire/draw-email-blocks')
            .drawEmailBlocks(db, r.application_id, { sitewireDrawId: Number(r.one_draw), borrower: true });
        }
        await notify.notifyAppBorrowers(r.application_id, {
          type: 'draw_findings',
          title: r.n === 1 ? 'Your draw inspection result is waiting for you' : `${r.n} draw inspection results are waiting for you`,
          drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
          badge: { text: 'Action needed', tone: 'action' },
          figures: (blocks && blocks.figures) || null,
          facts: (blocks && blocks.facts) || null,
          body: `Your inspection result${r.n === 1 ? ' is' : 's are'} ready and waiting for you. Your draw is released once you review and accept ${r.n === 1 ? 'it' : 'them'} — please take a moment to review ${r.n === 1 ? 'it' : 'them'} (or dispute a line) in your portal.`,
          callout: { title: 'Why this matters', body: 'The release clock for your draw only starts once you accept — reviewing promptly gets your money to you sooner.', tone: 'action' },
          applicationId: r.application_id, link: `/app/${r.application_id}`, ctaLabel: 'Review your draw' });
        await _stamp(DIGEST_ACTION.DRAW_FINDINGS_REMINDER, r.application_id, { awaiting: r.n, hours: waitHours, nudge: r.nudges + 1, cap: CAP });
        sent++;
      } else {
        // Cap reached: STOP emailing the borrower. Hand off to the draw coordinator(s) to follow up,
        // at most once / 2 days (the coordinator gate). This is what turns an endless borrower nudge
        // into a single "please call them or mark it approved" for the person who owns the file's draws.
        if (!(await _gate(DIGEST_ACTION.DRAW_BORROWER_STUCK, r.application_id, '2 days'))) continue;
        const drawRecipients = require('./draw-recipients');
        const coords = await drawRecipients.coordinatorsOrDesk(r.application_id);
        const stuckTitle = r.n === 1 ? 'A borrower hasn’t accepted their draw — please follow up' : `A borrower hasn’t accepted ${r.n} draws — please follow up`;
        const stuckBody = `We reminded the borrower ${CAP} times and their draw inspection result${r.n === 1 ? ' is' : 's are'} still waiting to be accepted — so we’ve stopped emailing them. Please reach out to the borrower, or mark the draw approved on their behalf if they’ve already agreed.`;
        const stuckOpts = { type: 'draw', badge: { text: 'Follow up', tone: 'action' }, title: stuckTitle,
          drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids), body: stuckBody, applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' };
        if (coords.length) {
          for (const c of coords) {
            try { await notify.notifyStaff(c.id, { ...stuckOpts, emailTo: c.email }); }
            catch (e) { console.error('[digest] draw-borrower-stuck notify', c.id, e && e.message); }
          }
        } else {
          // No draw coordinator on the file AND an empty desk — never silently drop the follow-up
          // (audit LOW; owner's "don't leave things silent" theme). Reach the file's own staff team
          // so a stuck draw is always covered by someone. Same 2-day throttle already claimed above.
          console.warn('[digest] draw-borrower-stuck: no draw coordinator/desk for', r.application_id, '— falling back to the file team');
          try { await notify.notifyAppStaff(r.application_id, stuckOpts); }
          catch (e) { console.error('[digest] draw-borrower-stuck fallback', r.application_id, e && e.message); }
        }
        await _stamp(DIGEST_ACTION.DRAW_BORROWER_STUCK, r.application_id, { awaiting: r.n, nudges: r.nudges, cap: CAP, coordinators: coords.length });
        sent++;
      }
    } catch (e) { console.error('[digest] draw-findings-await', r.application_id, e && e.message); }
  }
  return sent;
}

/* 6) Draw release overdue — the borrower ACCEPTED, the wire SLA (wire_due_at) has passed, and no release
   is recorded for THAT draw. Nudge the assigned team so a borrower's approved money doesn't slip. Per file,
   ≤ once/2 days. The suppression is now an EXACT per-draw match (dd.sitewire_draw_id = f.sitewire_draw_id):
   a kind='draw' release always names its draw (audit F-2 — required on the money route + backfilled by
   db/184), so a release on one draw of a multi-draw file no longer silences a genuinely-overdue OTHER draw.
   (The portfolio monitor flags this passively; this is the active push.) Staff surface — not borrower-safe-gated.
   The active-link EXISTS mirrors the passive monitor (rule 10): a finished/paid-off project is excluded, so an
   accepted finding whose wire was handled outside PILOT on a closed loan never alerts the team forever. */
/* TrustPoint phase 5 (§5C, D2 — the SLA inverts): on an ADMINISTERED file the note
   buyer wires the draw, not PILOT. An APPROVED TrustPoint draw with no observed
   release after N days (TRUSTPOINT_UNRELEASED_DAYS, default 5) means someone should
   chase the administrator so the borrower isn't left waiting. Self-gated per file,
   at most every 2 days; the moment the poll observes the disbursement it stops. */
async function trustpointUnreleasedOnce() {
  let sent = 0;
  const days = Math.max(1, Math.round(Number(process.env.TRUSTPOINT_UNRELEASED_DAYS) || 5));
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT t.application_id, count(*)::int AS n, min(COALESCE(t.approved_at, t.first_seen_at)) AS oldest,
              array_agg(t.number) AS draw_numbers
         FROM trustpoint_draws t
         JOIN applications a ON a.id=t.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
        WHERE t.status='APPROVED' AND t.disbursed_at IS NULL
          -- first_seen_at, never updated_at: PILOT's own stamps (fee check, write-back)
          -- bump updated_at and would keep restarting the clock (audit-5 #9)
          AND COALESCE(t.approved_at, t.first_seen_at) < now() - ($1 || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd WHERE dd.trustpoint_draw_id = t.tp_draw_id)
          -- a finished / paid-off project is intentionally done — no chasing (audit-5 #6)
          AND NOT EXISTS (SELECT 1 FROM sitewire_property_links pl
                            WHERE pl.application_id = t.application_id
                              AND COALESCE(pl.lifecycle_state,'active') <> 'active')
          -- Chased inside the 2-day gate → not due; do not consume a slot. approved_at/first_seen_at
          -- never advance from chasing, so the same files would otherwise hold the front forever.
          AND ${notThrottled('t.application_id', DIGEST_ACTION.TRUSTPOINT_UNRELEASED, "interval '2 days'")}
        GROUP BY t.application_id
        -- Deterministic order: an unordered LIMIT could skip the same waiting file forever.
        ORDER BY oldest ASC, t.application_id
        LIMIT 200`, [String(days)])).rows;
  } catch (_) { return 0; }
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.TRUSTPOINT_UNRELEASED, r.application_id, '2 days'))) continue;
      const d = daysAt(r.oldest);
      await notify.notifyAppStaff(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'Approved draw not released yet' : `${r.n} approved draws not released yet`,
        drawTag: drawLabel.drawTagFor(r.draw_numbers),
        badge: { text: 'Chase release', tone: 'action' },
        body: `${r.n === 1 ? 'A draw' : `${r.n} draws`} on this file ${r.n === 1 ? 'was' : 'were'} approved by the draw administrator ${d != null && d > 0 ? `${d} day${d === 1 ? '' : 's'} ago ` : ''}but no funds release has been observed yet. The wire comes from the note buyer's side — please follow up with them so the borrower isn't left waiting.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' });
      await _stamp(DIGEST_ACTION.TRUSTPOINT_UNRELEASED, r.application_id, { unreleased: r.n, days: d });
      sent++;
    } catch (e) { console.error('[digest] trustpoint-unreleased', r.application_id, e && e.message); }
  }
  return sent;
}

async function drawReleaseOverdueOnce() {
  let sent = 0;
  const rows = (await db.query(
    `SELECT f.application_id, count(*)::int AS n, min(f.wire_due_at) AS due,
            array_agg(f.sitewire_draw_id) AS draw_ids
       FROM draw_findings f
       JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE f.status='accepted' AND f.wire_due_at IS NOT NULL AND f.wire_due_at < now()
        AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd
                          WHERE dd.funded_status='released' AND dd.kind='draw'
                            AND dd.sitewire_draw_id = f.sitewire_draw_id)
        AND EXISTS (SELECT 1 FROM sitewire_property_links pl WHERE pl.application_id=f.application_id
                      AND pl.matched_by='created' AND COALESCE(pl.lifecycle_state,'active')='active')
        -- Alerted inside the 2-day gate → not due; do not consume a slot. wire_due_at is a fixed
        -- date that never advances, so the most-overdue files would otherwise hold every slot.
        AND ${notThrottled('f.application_id', DIGEST_ACTION.DRAW_RELEASE_OVERDUE, "interval '2 days'")}
      GROUP BY f.application_id
      -- Deterministic order: most-overdue wire first, so the cap can never hide the same file forever.
      ORDER BY due ASC, f.application_id
      LIMIT 300`)).rows;
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.DRAW_RELEASE_OVERDUE, r.application_id, '2 days'))) continue;
      const d = daysAt(r.due);
      await notify.notifyAppStaff(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'Draw release overdue' : `${r.n} draw releases overdue`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Overdue', tone: 'action' },
        body: `The borrower accepted ${r.n === 1 ? 'a draw' : `${r.n} draws`} and the release ${d != null && d > 0 ? `is ${d} day${d === 1 ? '' : 's'} past the target` : 'is now due'}, but no release has been recorded in PILOT yet. Please confirm the wire and record the release.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' });
      await _stamp(DIGEST_ACTION.DRAW_RELEASE_OVERDUE, r.application_id, { overdue: r.n, days: d });
      sent++;
    } catch (e) { console.error('[digest] draw-release-overdue', r.application_id, e && e.message); }
  }
  return sent;
}

/* ══ Increment C — the four missing per-status COORDINATOR reminders (owner-directed 2026-08-04;
 *    blueprint docs/DRAW-WORKFLOW-STATUS-RESEARCH.md) ══
 *
 * The draw workflow now knows, for every status, WHO it is waiting for and WHO to remind. Increment B
 * capped the borrower nudge; these four cover the stages that wait on US / the draw coordinator, so a
 * draw never sits silently between the borrower approving and the money moving. Each is a self-gated
 * sweep in the exact shape of drawFindingsAwaitingBorrowerOnce: scope to an ACTIVE PILOT-managed
 * (matched_by='created') link, put the throttle in the WHERE (not only the gate — a per-file digest
 * whose sort key does not advance starves its tail otherwise), deterministic oldest-first ORDER, and
 * the atomic _gate claim. Every query is wrapped so a phantom column never silently disables the
 * sweep from inside a swallowing catch (the #248 class); the DB test exercises the real columns. */

// Send a coordinator-facing draw reminder to the file's OWN draw coordinator(s) when one is assigned,
// else the whole active draw desk, and — never silent — the file's own staff team when even the desk
// is empty (the same hand-off shape Increment B's over-cap branch uses). ONE definition, so all four
// sweeps route "who owns this file's draws" through draw-recipients.coordinatorsOrDesk. Best-effort
// per recipient.
async function notifyCoordinators(appId, opts, tag) {
  const coords = await require('./draw-recipients').coordinatorsOrDesk(appId).catch(() => []);
  if (coords.length) {
    for (const c of coords) {
      try { await notify.notifyStaff(c.id, { ...opts, emailTo: c.email }); }
      catch (e) { console.error(`[digest] ${tag} notify`, c.id, e && e.message); }
    }
    return coords.length;
  }
  console.warn(`[digest] ${tag}: no draw coordinator/desk for`, appId, '— falling back to the file team');
  try { await notify.notifyAppStaff(appId, opts); }
  catch (e) { console.error(`[digest] ${tag} fallback`, appId, e && e.message); }
  return 0;
}

// The go-forward-only + not-finished/paid-off guard every draw sweep shares (CLAUDE.md Sitewire rules
// 2 + 10): the file has a PILOT-created Sitewire link whose project is still active. Inlined per query
// so each keeps its own $-numbering; `appIdExpr` is the outer table's application-id column.
function activeManagedLink(appIdExpr) {
  return `EXISTS (SELECT 1 FROM sitewire_property_links pl
                   WHERE pl.application_id = ${appIdExpr}
                     AND pl.matched_by = 'created' AND COALESCE(pl.lifecycle_state,'active') = 'active')`;
}

/* ══ The stretches of the draw workflow that had NO reminder at all (owner-directed 2026-08-09) ══
 *
 * Each is the same shape as the Increment C sweeps above — scope to an ACTIVE PILOT-managed link,
 * put the throttle in the WHERE as well as the gate (a per-file digest whose sort key does not
 * advance starves its tail otherwise), deterministic oldest-first ORDER, and the atomic _gate claim.
 * Every one is self-gating, so it can never bombard, and every one names the ONE action that clears
 * it. They all read their "how long is too long" from the draw settings, so an admin changes the
 * cadence on the settings screen rather than in code.
 */

/** One company-level day count from the draw settings, with the catalog's own fallback. Never throws. */
async function settingDays(key) {
  // Delegates to the ONE reader in draw-settings, so a sweep and the screen that describes it can
  // never disagree about the threshold. Same fail-to-0 contract as before: an unreadable setting
  // sends nothing rather than nagging on a guessed number.
  try { return await require('../sitewire/draw-settings').daysSettingFor(key); } catch (_) { return 0; }
}

/* A) INSPECTION ORDERED, NO REPORT. A draw sitting in an inspecting state past the inspection SLA
   with no findings row — nobody was chasing the inspector, because nothing anywhere knew it was
   late. Clears itself the moment the findings land. */
async function drawInspectionLateOnce() {
  let sent = 0;
  const days = await settingDays('inspection_sla_days');
  if (!(days > 0)) return 0;                       // 0 turns the reminder off entirely
  const rows = (await db.query(
    `SELECT d.application_id, count(*)::int AS n, min(d.submitted_at) AS oldest,
            array_agg(d.sitewire_draw_id) AS draw_ids
       FROM sitewire_draws d
       JOIN applications a ON a.id=d.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE d.status IN ('inspecting','pending','pending_capital_partner')
        AND d.submitted_at IS NOT NULL
        AND d.submitted_at < now() - (($1)::text || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM draw_findings f WHERE f.sitewire_draw_id = d.sitewire_draw_id)
        AND ${activeManagedLink('d.application_id')}
        AND ${notThrottled('d.application_id', DIGEST_ACTION.DRAW_INSPECTION_LATE, "interval '2 days'")}
      GROUP BY d.application_id
      ORDER BY oldest ASC, d.application_id
      LIMIT 300`, [String(days)])).rows;
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.DRAW_INSPECTION_LATE, r.application_id, '2 days'))) continue;
      const age = daysAt(r.oldest);
      sent += await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'Inspection report is late' : `${r.n} inspection reports are late`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Chase the inspector', tone: 'action' },
        body: `${r.n === 1 ? 'A draw has been' : `${r.n} draws have been`} waiting on the inspection for ${age != null ? `${age} day${age === 1 ? '' : 's'}` : 'longer than expected'} — the report was expected within ${days} day${days === 1 ? '' : 's'}. Chase the inspector, or record the report if it has already arrived.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk',
      }, 'draw-inspection-late');
      await _stamp(DIGEST_ACTION.DRAW_INSPECTION_LATE, r.application_id, { draws: r.n, days: age });
    } catch (e) { console.error('[digest] draw-inspection-late', r.application_id, e && e.message); }
  }
  return sent;
}

/* B) THE REPORT IS IN AND NOBODY HERE HAS CONFIRMED THEY READ IT.
   This is the gap the review stamp was built for. Note WHAT the state actually is, because it is
   not what it first looks like: a `draw_findings` row is created BY the delivery (reconcile.js
   inserts it with status='delivered' and delivered_at=now()), so "findings exist but have not gone
   to the borrower" is structurally impossible and a sweep looking for it could never fire. The
   real, common state is the opposite and worse — the results have ALREADY reached the borrower and
   nobody at the company ever confirmed they read the inspector's report. So this chases the review
   itself, and its wording says so. */
async function drawFindingsUnreviewedOnce() {
  let sent = 0;
  const days = await settingDays('decision_sla_days');
  if (!(days > 0)) return 0;
  const rows = (await db.query(
    `SELECT f.application_id, count(*)::int AS n, min(f.created_at) AS oldest,
            array_agg(f.sitewire_draw_id) AS draw_ids
       FROM draw_findings f
       JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE f.reviewed_at IS NULL
        AND f.created_at < now() - (($1)::text || ' days')::interval
        -- A draw the borrower has already settled needs no retrospective review chase; the money
        -- question has moved on and a nudge there is noise.
        AND f.status = 'delivered'
        AND ${activeManagedLink('f.application_id')}
        AND ${notThrottled('f.application_id', DIGEST_ACTION.DRAW_FINDINGS_UNREVIEWED, "interval '2 days'")}
      GROUP BY f.application_id
      ORDER BY oldest ASC, f.application_id
      LIMIT 300`, [String(days)])).rows;
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.DRAW_FINDINGS_UNREVIEWED, r.application_id, '2 days'))) continue;
      const age = daysAt(r.oldest);
      sent += await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'Nobody has reviewed this inspection' : `${r.n} inspections have not been reviewed`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Read it', tone: 'action' },
        body: `The inspector's results went to the borrower ${age != null ? `${age} day${age === 1 ? '' : 's'} ago` : 'a while ago'} and nobody here has confirmed they read them. Open the draw, check the amounts and the photos against the report, and mark it reviewed — if something is wrong, it is far cheaper to catch now than after the money moves.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk',
      }, 'draw-findings-unreviewed');
      await _stamp(DIGEST_ACTION.DRAW_FINDINGS_UNREVIEWED, r.application_id, { draws: r.n, days: age });
    } catch (e) { console.error('[digest] draw-findings-unreviewed', r.application_id, e && e.message); }
  }
  return sent;
}

/* C) DELIBERATELY ABSENT — "reviewed but not yet delivered to the borrower" CANNOT HAPPEN.
   The plan for this batch listed it, and reading the schema disproved it: `draw_findings` rows are
   created BY the delivery (reconcile.js inserts status='delivered', delivered_at=now()), so a
   review stamp can only ever be written on an already-delivered row. A sweep for that state would
   have executed cleanly, matched nothing forever, and looked like a working reminder. Recorded here
   rather than silently dropped, so nobody re-adds it. If findings ever start being persisted BEFORE
   delivery, this is the reminder to write. */

/* D) FINALLY APPROVED, MONEY NEVER RECORDED — on a file WE release.
   On an investor-released file PILOT writes the ledger itself at final approve, so a missing row
   there means the automatic write did not run and the same nudge is the right answer. The one case
   this must NOT nag about is a MANUAL delivery, where the money genuinely moved outside PILOT.
   `wire_due_at` already drives the separate overdue alert, so this is scoped to draws that have NO
   findings row to carry one (a draw approved without the borrower-accept path). */
async function drawApprovedUnrecordedOnce() {
  let sent = 0;
  const rows = (await db.query(
    `SELECT d.application_id, count(*)::int AS n, min(d.approved_at) AS oldest,
            array_agg(d.sitewire_draw_id) AS draw_ids
       FROM sitewire_draws d
       JOIN applications a ON a.id=d.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE d.status = 'approved' AND d.approved_at IS NOT NULL
        AND d.approved_at < now() - interval '2 days'
        AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd WHERE dd.kind='draw' AND dd.sitewire_draw_id = d.sitewire_draw_id)
        -- the accepted-findings path has its own overdue alert keyed on wire_due_at; do not double up
        AND NOT EXISTS (SELECT 1 FROM draw_findings f WHERE f.sitewire_draw_id = d.sitewire_draw_id AND f.wire_due_at IS NOT NULL)
        -- a MANUAL delivery moved the money outside PILOT on purpose
        AND COALESCE((SELECT pl.investor_funding_mode FROM sitewire_property_links pl
                       WHERE pl.application_id = d.application_id AND pl.matched_by='created'), '') <> 'manual'
        AND ${activeManagedLink('d.application_id')}
        AND ${notThrottled('d.application_id', DIGEST_ACTION.DRAW_APPROVED_UNRECORDED, "interval '3 days'")}
      GROUP BY d.application_id
      ORDER BY oldest ASC, d.application_id
      LIMIT 300`)).rows;
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.DRAW_APPROVED_UNRECORDED, r.application_id, '3 days'))) continue;
      const age = daysAt(r.oldest);
      sent += await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'An approved draw has no money recorded' : `${r.n} approved draws have no money recorded`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Record it', tone: 'action' },
        body: `${r.n === 1 ? 'A draw was' : `${r.n} draws were`} finally approved ${age != null ? `${age} day${age === 1 ? '' : 's'} ago` : 'a while ago'} but nothing has been recorded in the money ledger. Record the release on the draw desk — until it is there, the loan's data tape understates what has been drawn.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk',
      }, 'draw-approved-unrecorded');
      await _stamp(DIGEST_ACTION.DRAW_APPROVED_UNRECORDED, r.application_id, { draws: r.n, days: age });
    } catch (e) { console.error('[digest] draw-approved-unrecorded', r.application_id, e && e.message); }
  }
  return sent;
}

/* E) AN INVESTOR STILL OWES US OUR DRAW FEE. Only ever a report and a nudge — nothing anywhere waits
   on it. Scoped per FILE so the reminder lands with the people who know that deal. */
async function investorFeeOwedOnce() {
  let sent = 0;
  const days = await settingDays('fee_owed_chase_days');
  if (!(days > 0)) return 0;
  const rows = (await db.query(
    `SELECT dd.application_id, count(*)::int AS n, sum(dd.fee_receivable_cents)::bigint AS owed,
            min(COALESCE(dd.release_date, dd.created_at::date)) AS oldest,
            max(dd.note_buyer_label) AS buyer,
            array_agg(dd.sitewire_draw_id) AS draw_ids
       FROM draw_disbursements dd
       JOIN applications a ON a.id=dd.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined')
      WHERE dd.fee_status = 'owed'
        AND COALESCE(dd.release_date, dd.created_at::date) <= CURRENT_DATE - (($1)::text || ' days')::interval
        AND ${notThrottled('dd.application_id', DIGEST_ACTION.INVESTOR_FEE_OWED, "interval '7 days'")}
      GROUP BY dd.application_id
      ORDER BY oldest ASC, dd.application_id
      LIMIT 300`, [String(days)])).rows;
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.INVESTOR_FEE_OWED, r.application_id, '7 days'))) continue;
      const age = daysAt(r.oldest);
      const amt = '$' + (Number(r.owed || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      sent += await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: `${r.buyer || 'The investor'} still owes us ${amt}`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Chase the fee', tone: 'action' },
        body: `${r.buyer || 'The investor'} released ${r.n === 1 ? 'a draw' : `${r.n} draws`} on this property directly to the borrower and still owes us ${amt} in draw fees${age != null ? `, the oldest from ${age} day${age === 1 ? '' : 's'} ago` : ''}. Chase it, then mark it received on the fees-owed list.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk',
      }, 'investor-fee-owed');
      await _stamp(DIGEST_ACTION.INVESTOR_FEE_OWED, r.application_id, { draws: r.n, owed_cents: Number(r.owed || 0), days: age });
    } catch (e) { console.error('[digest] investor-fee-owed', r.application_id, e && e.message); }
  }
  return sent;
}

/* F) RETAINAGE IS RELEASABLE. A project marked finished or paid off that is still holding retainage
   — the borrower's own money, sitting with us because nobody pressed the button. Deliberately keyed
   on the LIFECYCLE state rather than a guess about completion: a human said the job is done. */
async function retainageReleasableOnce() {
  let sent = 0;
  const rows = (await db.query(
    `SELECT pl.application_id, pl.lifecycle_at,
            (COALESCE((SELECT sum(dd.retainage_held_cents) FROM draw_disbursements dd
                        WHERE dd.application_id=pl.application_id AND dd.kind='draw'), 0)
             - COALESCE((SELECT sum(dd2.net_release_cents) FROM draw_disbursements dd2
                        WHERE dd2.application_id=pl.application_id AND dd2.kind='retainage_release'), 0))::bigint AS holding
       FROM sitewire_property_links pl
       JOIN applications a ON a.id=pl.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined')
      WHERE pl.matched_by='created' AND COALESCE(pl.lifecycle_state,'active') IN ('finished','paid_off')
        AND ${notThrottled('pl.application_id', DIGEST_ACTION.RETAINAGE_RELEASABLE, "interval '7 days'")}
      ORDER BY pl.lifecycle_at ASC NULLS LAST, pl.application_id
      LIMIT 300`)).rows;
  for (const r of rows) {
    const holding = Number(r.holding || 0);
    if (holding <= 0) continue;                    // nothing held — never a reminder about $0
    try {
      if (!(await _gate(DIGEST_ACTION.RETAINAGE_RELEASABLE, r.application_id, '7 days'))) continue;
      const amt = '$' + (holding / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      sent += await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: `${amt} of retainage is ready to release`,
        badge: { text: 'Release it', tone: 'action' },
        body: `This project is marked complete and we are still holding ${amt} of the borrower's retainage. Release it on the draw desk.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk',
      }, 'retainage-releasable');
      await _stamp(DIGEST_ACTION.RETAINAGE_RELEASABLE, r.application_id, { holding_cents: holding });
    } catch (e) { console.error('[digest] retainage-releasable', r.application_id, e && e.message); }
  }
  return sent;
}

/* G) THE PURCHASE ADVICE NEVER ARRIVED (owner-directed 2026-08-09: "there should be a workflow for
   this stuff that doesn't have a purchase date — if it doesn't get a purchase date till 30 days
   after a funding date, then we should get notified; super admin should get notified, and the
   closer should get notified").

   THE WHOLE SWEEP IS BUILT AROUND NOT FIRING ON A TABLE-FUNDED LOAN. A loan sold at the closing
   table is never going to receive a purchase advice — that is what table funding MEANS — so
   chasing one would put a monthly email on every Fidelis deal we ever close, forever, which is the
   fastest way to teach a team to ignore this alert. Three independent things have to say the loan
   is still to be sold before anyone is told:
     · the closer's own warehouse pick is not the Table Funding line (closing_workflow.table_funded,
       the reliable local signal — a human on our own desk chose it);
     · Encompass's funding channel does not say table funding either (belt and braces, for a file
       where the two disagree — the disagreement itself is surfaced on the Encompass panel);
     · neither place we record a purchase advice has one — the Encompass-read date on the file AND
       the closer's own hand-entered `purchasing_advice` row. Missing the second would chase files
       where a human had already recorded the advice by hand, which is precisely the desk this is
       meant to help.

   RTL only, structurally: `applications` IS the RTL product's table — the long-term side has its
   own `lt_*` tables and does not appear here at all.

   Self-gating (≤ once per file per week) and business-hours like every other sweep. The threshold
   is the owner's 30 days, with an env override for a deployment that wants to be told sooner. */
const PURCHASE_ADVICE_CHASE_DAYS = () => Math.max(1, Number(process.env.PURCHASE_ADVICE_CHASE_DAYS || 30));

async function purchaseAdviceMissingOnce() {
  let sent = 0;
  const days = PURCHASE_ADVICE_CHASE_DAYS();
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT a.id, a.ys_loan_number, a.funded_date, a.lender, a.closer_id,
              (CURRENT_DATE - a.funded_date)::int AS age,
              -- The Encompass funding channel, read from the flat by-number map the reader writes
              -- on every pull, falling back to the customFields[] array a pull made before that
              -- wiring would have stored. Text only — the JS side normalizes it through the ONE
              -- shared value map, so this never has to know the tenant's exact wording.
              -- jsonb_typeof guard: jsonb_array_elements RAISES on anything that is not an array,
              -- and one stored copy whose customFields came back as an object would throw the whole
              -- query — which this function's catch would swallow into a permanent, confident
              -- "nothing to chase". A shape we did not expect must cost us that one file's
              -- fallback, never the sweep.
              COALESCE(
                a.encompass_extra->'_fieldValues'->>'CX.TABLEFUNDER',
                (SELECT cf->>'value'
                   FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(a.encompass_extra->'customFields') = 'array'
                               THEN a.encompass_extra->'customFields' ELSE '[]'::jsonb END) cf
                  WHERE cf->>'fieldName' = 'CX.TABLEFUNDER' LIMIT 1)
              ) AS channel_raw
         FROM applications a
         LEFT JOIN closing_workflow cw ON cw.application_id = a.id
         LEFT JOIN purchasing_advice pa ON pa.application_id = a.id
        WHERE a.deleted_at IS NULL
          AND a.status = 'funded'
          AND a.funded_date IS NOT NULL
          AND a.funded_date <= CURRENT_DATE - (($1)::text || ' days')::interval
          AND COALESCE(cw.table_funded, false) = false
          AND a.purchase_advice_date IS NULL
          AND pa.advice_date IS NULL
          AND ${notThrottled('a.id', DIGEST_ACTION.PURCHASE_ADVICE_MISSING, "interval '7 days'")}
        ORDER BY a.funded_date ASC, a.id
        LIMIT 200`, [String(days)])).rows;
  } catch (e) { console.error('[digest] purchase-advice-missing query', e && e.message); return 0; }

  for (const r of rows) {
    try {
      const FC = require('./funding-channel');
      // Encompass's own answer, through the shared normalizer. Belt and braces on top of the
      // warehouse check already applied in SQL.
      if (FC.soldAtTable({ channel: FC.channelKey(r.channel_raw) })) continue;
      // …and the question about the BUYER rather than the file (owner-directed 2026-08-09): RCN,
      // Roc Capital and Temple View are table funded as a matter of course, so a missing purchase
      // advice on one of their files is a data-entry gap, not a loan waiting to be sold. Fidelis is
      // NOT excluded — that is the owner's "case-by-case", and its table-funded files are already
      // skipped by the check above, which is a fact about the file rather than about the buyer.
      if (!FC.chaseMissingPurchaseAdvice(r.lender)) continue;
      if (!(await _gate(DIGEST_ACTION.PURCHASE_ADVICE_MISSING, r.id, '7 days'))) continue;
      const age = Number(r.age || 0);
      const who = r.lender ? String(r.lender) : 'the investor';
      const payload = {
        type: 'purchase_advice_missing',
        title: `No purchase advice ${age} days after funding`,
        badge: { text: 'Chase the sale', tone: 'action' },
        body: `This loan funded ${age} days ago and was not table funded, so it still has to be sold to ${who} — and no purchase advice date has come back. Chase it, or record the advice on the file if it has already arrived.`,
        applicationId: r.id,
        link: `/internal/app/${r.id}`,
        ctaLabel: 'Open the loan file',
      };
      // THE CLOSER FIRST, then the super admins — and the closer is EXCLUDED from the admin
      // fan-out when they are one, so a closer who is also a super admin gets one email, not two
      // (the same plural exclusion notifyAdmins already applies for the file team).
      const told = [];
      if (r.closer_id) {
        try { await notify.notifyStaff(r.closer_id, payload); told.push(String(r.closer_id)); sent += 1; }
        catch (e) { console.error('[digest] purchase-advice-missing closer', r.id, e && e.message); }
      }
      // SUPER ADMINS ONLY, and never the shared NOTIFY_ADMINS inbox — that list is hand-typed
      // ADDRESSES with no role attached, so it is the one list that could carry somebody the owner
      // did not name here. Every admin still SEES it in PILOT; only super admins are emailed.
      const admins = await notify.notifyAdmins({
        ...payload, exceptStaffIds: told, emailRoles: ['super_admin'], skipSharedInbox: true,
      });
      sent += Array.isArray(admins) ? admins.length : (admins ? 1 : 0);
      await _stamp(DIGEST_ACTION.PURCHASE_ADVICE_MISSING, r.id, { days: age, buyer: r.lender || null });
    } catch (e) { console.error('[digest] purchase-advice-missing', r.id, e && e.message); }
  }
  return sent;
}

/* 7) order_trustpoint (blueprint 2b) — a draw submitted through the portal composer on a TrustPoint
   (Blue Lake physical) file that the coordinator has NOT yet hand-entered into TrustPoint. The
   portal_draw_requests row IS the state: platform 'trustpoint' + status 'submitted' + no tp_draw_id
   means "waiting to be entered". The status leaves 'submitted' the moment the coordinator enters it,
   so the reminder stops on its own. Remind daily. */
async function orderTrustpointOnce() {
  let sent = 0;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT p.application_id, count(*)::int AS n, min(p.created_at) AS oldest,
              array_agg(p.id) AS portal_ids
         FROM portal_draw_requests p
         JOIN applications a ON a.id=p.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
        WHERE p.platform='trustpoint' AND p.status='submitted' AND p.tp_draw_id IS NULL
          AND ${activeManagedLink('p.application_id')}
          AND ${notThrottled('p.application_id', DIGEST_ACTION.ORDER_TRUSTPOINT, "interval '20 hours'")}
        GROUP BY p.application_id
        ORDER BY oldest ASC, p.application_id
        LIMIT 200`)).rows;
  } catch (e) { console.error('[digest] order-trustpoint query', e && e.message); return 0; }
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.ORDER_TRUSTPOINT, r.application_id, '20 hours'))) continue;
      await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'A draw is waiting to be entered into TrustPoint' : `${r.n} draws are waiting to be entered into TrustPoint`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.portal_ids, 'portal'),
        badge: { text: 'Enter in TrustPoint', tone: 'action' },
        body: `The borrower submitted ${r.n === 1 ? 'a draw' : `${r.n} draws`} on this file and ${r.n === 1 ? 'it has' : 'they have'} not been entered into TrustPoint yet. Please enter ${r.n === 1 ? 'it' : 'them'} so the inspection can be ordered and the borrower's draw can move forward.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' }, 'order-trustpoint');
      await _stamp(DIGEST_ACTION.ORDER_TRUSTPOINT, r.application_id, { pending: r.n });
      sent++;
    } catch (e) { console.error('[digest] order-trustpoint', r.application_id, e && e.message); }
  }
  return sent;
}

/* 8) order_trinity (blueprint 2p) — a physical inspection ordered from Trinity that is still at
   'requested' (the coordinator has not placed the order yet). The trinity_inspection_orders row IS the
   state; it leaves 'requested' the moment the order is placed, so the reminder stops on its own.
   Remind daily. */
async function orderTrinityOnce() {
  let sent = 0;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT t.application_id, count(*)::int AS n, min(t.created_at) AS oldest,
              array_agg(t.portal_draw_request_id) AS portal_ids
         FROM trinity_inspection_orders t
         JOIN applications a ON a.id=t.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
        WHERE t.status='requested'
          AND ${activeManagedLink('t.application_id')}
          AND ${notThrottled('t.application_id', DIGEST_ACTION.ORDER_TRINITY, "interval '20 hours'")}
        GROUP BY t.application_id
        ORDER BY oldest ASC, t.application_id
        LIMIT 200`)).rows;
  } catch (e) { console.error('[digest] order-trinity query', e && e.message); return 0; }
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.ORDER_TRINITY, r.application_id, '20 hours'))) continue;
      await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'A physical inspection is waiting to be ordered on Trinity' : `${r.n} physical inspections are waiting to be ordered on Trinity`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.portal_ids, 'portal'),
        badge: { text: 'Order on Trinity', tone: 'action' },
        body: `${r.n === 1 ? 'A physical inspection has' : `${r.n} physical inspections have`} been requested on this file but not yet ordered from Trinity. Please place the order so the borrower's draw can move forward.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' }, 'order-trinity');
      await _stamp(DIGEST_ACTION.ORDER_TRINITY, r.application_id, { pending: r.n });
      sent++;
    } catch (e) { console.error('[digest] order-trinity', r.application_id, e && e.message); }
  }
  return sent;
}

/* 9) investor_pending_delivery (blueprint 7a) — the borrower AGREED to a draw (accepted or resolved)
   and it has NOT been delivered to the investor yet. Once the borrower agrees, the draw goes to the
   note buyer (investor-delivery.js); until a delivery is actually SENT (an errored delivery does not
   count), remind the coordinator every 2 days. Scoped to files that HAVE a note buyer — with no
   investor there is nobody to deliver to, and nagging "deliver to the investor" on such a file is noise
   (the missing-note-buyer condition surfaces that gap separately). A draw already at final approval is
   done. */
async function investorPendingDeliveryOnce() {
  let sent = 0;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT f.application_id, count(*)::int AS n, min(COALESCE(f.accepted_at, f.delivered_at)) AS oldest,
              array_agg(f.sitewire_draw_id) AS draw_ids
         FROM draw_findings f
         JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
        WHERE f.status IN ('accepted','resolved')
          AND NULLIF(btrim(a.lender), '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM draw_investor_deliveries dd
                            WHERE dd.sitewire_draw_id=f.sitewire_draw_id AND dd.status='sent')
          AND NOT EXISTS (SELECT 1 FROM sitewire_draws sd
                            WHERE sd.sitewire_draw_id=f.sitewire_draw_id AND sd.status='approved')
          AND ${activeManagedLink('f.application_id')}
          AND ${notThrottled('f.application_id', DIGEST_ACTION.INVESTOR_PENDING_DELIVERY, "interval '2 days'")}
        GROUP BY f.application_id
        ORDER BY oldest ASC, f.application_id
        LIMIT 300`)).rows;
  } catch (e) { console.error('[digest] investor-pending query', e && e.message); return 0; }
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.INVESTOR_PENDING_DELIVERY, r.application_id, '2 days'))) continue;
      await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'A draw is approved and ready to send to the investor' : `${r.n} draws are approved and ready to send to the investor`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Deliver to investor', tone: 'action' },
        body: `The borrower has agreed to ${r.n === 1 ? 'a draw' : `${r.n} draws`} on this file and ${r.n === 1 ? 'it is' : 'they are'} waiting to be delivered to the investor. Please send the delivery so the borrower's funds are not held up.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' }, 'investor-pending');
      await _stamp(DIGEST_ACTION.INVESTOR_PENDING_DELIVERY, r.application_id, { pending: r.n });
      sent++;
    } catch (e) { console.error('[digest] investor-pending', r.application_id, e && e.message); }
  }
  return sent;
}

/* 10) with_investor (blueprint 7b) — the draw WAS delivered to the investor and we are waiting on their
   funding. Remind the coordinator starting +48h after the delivery, then every 2 days, until the draw
   reaches final approval (sitewire_draws.status='approved', approval.FINAL_STATUSES). A re-send is a new
   delivery row, so the +48h clock is measured from the LATEST send.

   OVERLAP WITH drawReleaseOverdueOnce — considered and accepted (audit 2026-08-05), deliberately NOT
   coupled. A draw can be past its wire SLA (release-overdue fires "record the release") AND delivered to
   the investor >48h with no funding back (this fires "chase the investor"). In the DEFAULT reimbursement
   mode those are two DIFFERENT actions — WE release the net to the borrower, the investor reimburses US —
   so both nudges are legitimately distinct and must not be merged (suppressing either would drop a real
   follow-up). In investor_direct mode they are adjacent (the investor makes the release), but both still
   point the coordinator at the same next step, so nobody is ever misled. This is unlike Increment B's
   borrower bombardment (the SAME email repeated forever); here it is at most two distinct actionable
   items on the internal desk. Left decoupled to avoid mode-dependent suppression logic in the existing,
   already-tested release sweep. */
async function withInvestorOnce() {
  let sent = 0;
  let rows = [];
  try {
    rows = (await db.query(
      // The +48h test is PER DRAW, not per file. A file can carry several draws with the investor at
      // different ages, so `max(sent_at)` across the whole file would let a FRESH delivery hide an OLDER
      // overdue one — a 6-day-overdue draw #1 masked by a 3-hour-old draw #2, and the coordinator is
      // never reminded to chase #1 (audit 2026-08-05). The CTE takes each DRAW's latest send (so a
      // re-send still measures from the newest row); the outer query keeps only the draws whose latest
      // send is already past +48h, counts those overdue draws, and reports the OLDEST of them (so the
      // message's "delivered N days ago" and the oldest-first ordering both name the worst one).
      // `latest` picks each draw's MOST-RECENT sent delivery and its funding_mode; a re-send still
      // measures from the newest row. A draw whose latest delivery is MANUAL is handled by the
      // coordinator outside PILOT (owner-directed) — it is excluded so PILOT never nags about a
      // step somebody is already doing off-platform.
      `WITH latest AS (
         SELECT DISTINCT ON (dd.application_id, dd.sitewire_draw_id)
                dd.application_id, dd.sitewire_draw_id, dd.sent_at AS last_send, dd.funding_mode
           FROM draw_investor_deliveries dd
          WHERE dd.status='sent'
          ORDER BY dd.application_id, dd.sitewire_draw_id, dd.sent_at DESC
       ),
       with_inv AS (
         -- NB: the outer CTE is aliased dl, NOT l -- the shared notThrottled() helper builds its
         -- subquery as "FROM audit_log l", so an outer l here would be shadowed inside that subquery
         -- and l.application_id would bind to audit_log (which has no such column), throwing 42703 and
         -- silently killing this reminder for every draw (caught in the #11 pre-merge audit, 2026-08-05).
         SELECT dl.application_id, dl.sitewire_draw_id, dl.last_send
           FROM latest dl
           JOIN applications a ON a.id=dl.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
          WHERE dl.funding_mode <> 'manual'
            -- still waiting on the investor: the borrower's agreement is still standing AND the draw has
            -- not reached final approval. A finding that left accepted/resolved is no longer with them.
            AND EXISTS (SELECT 1 FROM draw_findings f
                          WHERE f.sitewire_draw_id=dl.sitewire_draw_id AND f.status IN ('accepted','resolved'))
            AND NOT EXISTS (SELECT 1 FROM sitewire_draws sd
                              WHERE sd.sitewire_draw_id=dl.sitewire_draw_id AND sd.status='approved')
            AND ${activeManagedLink('dl.application_id')}
            AND ${notThrottled('dl.application_id', DIGEST_ACTION.WITH_INVESTOR, "interval '2 days'")}
       )
       SELECT application_id, count(*)::int AS n, min(last_send) AS delivered,
              array_agg(sitewire_draw_id) AS draw_ids
         FROM with_inv
        WHERE last_send < now() - interval '48 hours'
        GROUP BY application_id
        ORDER BY delivered ASC, application_id
        LIMIT 300`)).rows;
  } catch (e) { console.error('[digest] with-investor query', e && e.message); return 0; }
  for (const r of rows) {
    try {
      if (!(await _gate(DIGEST_ACTION.WITH_INVESTOR, r.application_id, '2 days'))) continue;
      const d = daysAt(r.delivered);
      await notifyCoordinators(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'A draw is with the investor awaiting funding' : `${r.n} draws are with the investor awaiting funding`,
        drawTag: await drawLabel.drawTagForDraws(db, r.application_id, r.draw_ids),
        badge: { text: 'Awaiting investor', tone: 'action' },
        body: `${r.n === 1 ? 'A draw was' : `${r.n} draws were`} delivered to the investor ${d != null && d > 0 ? `${d} day${d === 1 ? '' : 's'} ago ` : ''}and no funding has come back yet. Please follow up with the investor so the borrower is not left waiting.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' }, 'with-investor');
      await _stamp(DIGEST_ACTION.WITH_INVESTOR, r.application_id, { pending: r.n, days: d });
      sent++;
    } catch (e) { console.error('[digest] with-investor', r.application_id, e && e.message); }
  }
  return sent;
}

/**
 * AN ORDER THAT IS LATE GETS CHASED — the clock the Orders desk never had
 * (owner-directed 2026-08-03).
 *
 * Orders is the one place PILOT waits on somebody OUTSIDE the company, and until
 * now it was also the only place with no clock, no owner and no nudge: we emailed
 * a title company and a human had to remember. Vendor turnaround is the
 * operational problem lenders name most often, so this is the sweep that makes
 * "which orders are late?" a question the system answers instead of a person.
 *
 * TWO DIFFERENT JOBS, deliberately worded differently (order-sla.pendingOn):
 *   · status 'ordered'      → the VENDOR owes us. Chase them.
 *   · status 'documents_in' → they answered; the work came back to US, and the job
 *     is classifying and accepting what arrived. Telling somebody to "chase the
 *     title company" when the title company already replied is exactly how a desk
 *     teaches people to ignore it.
 *
 * WHO IS TOLD escalates rather than repeating (order-sla.chaseTier): the assignee
 * first, then the whole file team, then the administrators. A nudge that always
 * lands in the same inbox stops being read, which is the failure this exists to
 * prevent.
 *
 * The SQL pre-filter is deliberately COARSE — `ordered_at` older than the SLA in
 * CALENDAR days, which is a strict superset of "N business days have passed", so
 * it can over-select but never under-select. The precise business-day test then
 * runs in JS through the SAME `orderState` the card and the desk use, so a row can
 * never be late on one screen and on time on another. The throttle appears in the
 * WHERE as well as the gate (a per-file digest must, or an already-nudged file
 * keeps taking a slot — see notThrottled).
 */
async function orderOverdueOnce() {
  const orderSla = require('./order-sla');
  const { hour } = nyParts();
  // Business hours only: an order nudge at 3am helps nobody and trains people to
  // filter the sender.
  if (hour < 8 || hour > 18) return 0;
  let sent = 0;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT o.id, o.application_id, o.order_type, o.status, o.ordered_at, o.due_on, o.sla_days,
              o.assigned_to, o.vendor_name,
              -- Falls back to the EMAIL exactly as the desk does. Keying on
              -- full_name alone meant an active staffer with a blank name (one
              -- of the two account-creation doors does not require one) read as
              -- 'inactive' to the ladder — the nudge skipped them and blasted
              -- the file team, stamping assigneeInactive on a live account.
              COALESCE(NULLIF(btrim(COALESCE(su.full_name,'')),''), su.email) AS assigned_name
         FROM file_orders o
         JOIN applications a ON a.id = o.application_id
          AND a.deleted_at IS NULL
          -- FUNDED FILES ARE IN. A vendor still owes the final policy and the
          -- recorded mortgage after the loan funds, which is why the follow-up and
          -- reply doors stay open past funding and why the desk keeps those rows.
          -- Excluding them here made the nudge disagree with the desk about the
          -- same order: it was listed as outstanding and never chased. An order
          -- that reaches here on a funded file is one whose condition was never
          -- signed off — genuinely unfinished — and a human can end it from the
          -- card with "Mark finished" when the work really is done.
          AND a.status NOT IN ('withdrawn','declined','on_hold')
         LEFT JOIN staff_users su ON su.id = o.assigned_to AND su.is_active = true
        WHERE o.status IN ('ordered','documents_in')
          AND o.ordered_at IS NOT NULL
          -- Coarse superset of "past due". N business days is always at least N
          -- calendar days, so the SLA arm never filters out something genuinely
          -- late — but a HUMAN-PINNED due date can be EARLIER than the SLA implies
          -- ("they said tomorrow" on a rush title order), and that row is overdue
          -- before the SLA window opens. Without the second arm the nudge arrived
          -- up to sla_days late on exactly the orders somebody cared most about.
          AND (o.ordered_at < now() - ((COALESCE(o.sla_days, 2))::text || ' days')::interval
               OR (o.due_on IS NOT NULL AND o.due_on < (now() AT TIME ZONE 'America/New_York')::date))
          AND ${notThrottled('o.application_id', DIGEST_ACTION.ORDER_OVERDUE, "interval '2 days'")}
        -- Deterministic, oldest first, so the cap can never hide the same order
        -- forever. The id LAST makes it a TOTAL order: without a unique final term
        -- two orders placed in the same instant tie and the cap returns them in
        -- whatever order the plan felt like, which is how one of them starves.
        ORDER BY o.ordered_at ASC, o.order_type, o.id
        LIMIT 300`)).rows;
  } catch (e) { console.error('[digest] order-overdue query', e && e.message); return 0; }

  const now = new Date();
  for (const r of rows) {
    let claimId = null;
    let delivered = 0;   // declared out here so the catch can see it
    try {
      const st = orderSla.orderState(r, now);
      if (!st.overdue) continue;   // the coarse filter over-selected — correct, and cheap
      // The throttle is keyed on the FILE (matching notThrottled above, which has
      // to be — audit_log's per-file index is what makes it fast). Two late orders
      // on one file therefore share a slot; the body names the one that is worst,
      // which is the one somebody should pick up first anyway.
      // Claimed BY ID, so a send that throws can give the exact row back (below)
      // rather than leaving the file silenced for two days with nothing delivered.
      claimId = await _claim(DIGEST_ACTION.ORDER_OVERDUE, r.application_id, '2 days');
      if (!claimId) continue;
      const label = orderSla.ORDER_LABEL[r.order_type] || r.order_type;
      const vendorWord = orderSla.VENDOR_LABEL[r.order_type] || 'the vendor';
      const ours = st.pendingOn === 'us';
      const days = st.daysLate;
      const who = r.assigned_name ? `${r.assigned_name} has it` : 'Nobody is assigned to it';
      /* THE LADDER IS ACTUALLY WALKED, not just described and recorded.
         `st.chase` was computed, written into the audit detail as `tier`, and then
         ignored: every nudge at every tier went through one unconditional
         `notifyAppStaff`, which fans out to `application_assignees` ONLY. Since an
         order may be assigned to ANY active staff member (owner-directed, "and
         also any staff members"), a coordinator who is not on the file team got a
         nudge that said "Jane Smith has it" delivered to everyone EXCEPT Jane —
         the one person being asked to act. */
      const payload = {
        type: 'order_overdue',
        title: ours
          ? `${label}: ${days} day${days === 1 ? '' : 's'} of documents waiting to be filed`
          : `${label} order is ${days} day${days === 1 ? '' : 's'} late`,
        badge: { text: days > 5 ? 'Very late' : 'Late', tone: 'action' },
        body: ours
          ? `${r.vendor_name ? `${r.vendor_name} has` : `${vendorWord.replace(/^the /, 'The ')} has`} sent documents back on the ${label.toLowerCase()} order and they are still waiting to be classified and accepted — ${days} business day${days === 1 ? '' : 's'} past when we expected this order to be finished. ${who}.`
          // "…on 20 days ago" — the `on` belonged to the 'this file' branch and rode
          // along on the normal path, so EVERY nudge read ungrammatically.
          : `We asked ${r.vendor_name || vendorWord} for the ${label.toLowerCase()} ${st.daysOut != null ? `${st.daysOut} day${st.daysOut === 1 ? '' : 's'} ago` : 'on this file'} and nothing has come back. It is ${days} business day${days === 1 ? '' : 's'} past the date we expected an answer. ${who} — please chase ${r.vendor_name ? 'them' : vendorWord}.`,
        applicationId: r.application_id,
        link: `/internal/app/${r.application_id}${r.order_type === 'title' ? '#sec-order-title' : r.order_type === 'insurance' ? '#sec-order-insurance' : '#sec-order-closing'}`,
        ctaLabel: 'Open the order',
      };
      /* WHO IS TOLD, by tier. The ASSIGNEE is told at every tier, because
         escalating past the owner would tell everyone except the person doing the
         work. Higher tiers ADD the file team and then the administrators.

         THE ASSIGNEE MUST BE ACTIVE, and that is judged on `assigned_name`, not on
         `assigned_to`. The row's join is `… AND su.is_active = true`, so a
         DEPARTED staffer leaves the id set and the name NULL. Branching on the id
         meant: notifyStaff wrote an in-app row on an account that cannot sign in
         (notify.js skips the email for an inactive staffer), and the file-team arm
         was skipped BECAUSE the id was truthy — so at the first tier the nudge
         reached NOBODY, and the audit stamp recorded that the assignee had been
         told. The assign route already refuses a deactivated staffer for exactly
         this reason: "indistinguishable from nobody, except that it LOOKS
         covered". An order owned by somebody who has left is an UNOWNED order, and
         the team is told.

         NOTE, deliberately accepted: an order may be assigned to any active staff
         member (owner-directed), including one not on the file, so this can email
         the file's identity to somebody whose "Open the order" link will refuse
         them. Telling the assigned person is the whole point of an assignment;
         withholding the nudge would be the worse failure. */
      const tier = st.chase;
      const assignee = r.assigned_name ? r.assigned_to : null;
      /* ONE COPY PER PERSON. `exceptStaffId` covers only the file-team arm, and
         nothing stopped notifyAdmins repeating what the other two already sent —
         so an admin who is on the file, or an order assigned TO an admin, produced
         two identical emails and two in-app rows every time, every two days, for as
         long as the order stayed late. */
      const told = [];
      // `notifyStaff` returns null when the staffer muted this file or the
      // loan-officer gate parked the message as a draft — counting the CALL rather
      // than the delivery meant the "nobody was reached, tell the admins" fallback
      // below could never fire for a muted assignee.
      if (assignee) {
        const one = await notify.notifyStaff(assignee, { ...payload });
        told.push(String(assignee));          // never write to them twice regardless
        if (one) delivered++;
      }
      /* `|| !delivered` is the third condition and it is the one that keeps the
         ladder a LADDER. At the first tier with a present assignee this arm is
         false — correct while that assignee actually heard us. When they did not
         (they muted the file, or the loan-officer gate held the message), the
         admin arm below fires on the same `!delivered`, so a ONE-day-late order
         went straight past the file team to every administrator in the company.
         The team is the next rung up from the assignee, not a rung to skip. */
      if (tier === 'team' || tier === 'admins' || !assignee || !delivered) {
        const team = await notify.notifyAppStaff(r.application_id, { ...payload, exceptStaffId: assignee || null, exceptStaffIds: told });
        /* TWO DIFFERENT NUMBERS, and this rung needs both.
           `.length` is who is ON the file — everybody there goes on `told`, so the
           admin rung below never writes to one of them a second time just because
           their copy was muted or held. `.delivered` is who actually HEARD us, and
           only that may satisfy the throttle: counting the call itself meant a
           fan-out over a file with no active assignee registered as a delivery, so
           a later rung throwing kept the claim and silenced the file for two days
           having told nobody at all. */
        if (Array.isArray(team) && team.length) told.push(...team.map(String));
        // Through the helper, never `team.delivered`: a missing count must be LOUD
        // and fall back to "assume they heard us", because reading it as zero means
        // "escalate to every administrator" two lines down.
        delivered += notify.deliveredCount(team);
      }
      /* NOBODY TO TELL → THE ADMINS, which is what every other fan-out in this
         repo already does (`if (!sent || !sent.length) await notify.notifyAdmins`
         — esign/dead-letter, three places in esign/webhook). 188 of the files on
         this database have no active assignee; without this, a late order on one
         of them told literally nobody at every tier below `admins` while stamping
         the audit row as though the nudge had gone out. */
      if (tier === 'admins' || !delivered) {
        // Counted the same way as the other two rungs: `notifyAdmins` returns one
        // entry per administrator and a NULL for each one who muted the file, so
        // `delivered++` on the call itself claimed a delivery on a database with
        // no active administrator at all — the one case where the release below
        // is the only thing standing between a late order and total silence.
        const admins = await notify.notifyAdmins({ ...payload, exceptStaffIds: told });
        delivered += Array.isArray(admins) ? admins.filter(Boolean).length : 0;
      }
      await _stamp(DIGEST_ACTION.ORDER_OVERDUE, r.application_id, {
        orderType: r.order_type, daysLate: days, tier, pendingOn: st.pendingOn,
        toldAssignee: !!assignee,
        // An assignment left behind by somebody who has gone is worth seeing.
        assigneeInactive: !!(r.assigned_to && !r.assigned_name),
        /* HOW MANY PEOPLE THIS ACTUALLY REACHED. The stamp is what the audit trail
           shows, and it used to say a nudge went out whatever happened: on a
           database with no active administrator, an absent or muted assignee and
           an empty file team, every rung reaches nobody, nothing throws, and the
           file was recorded as nudged and then silenced for two days. The claim is
           deliberately still KEPT here — releasing it would re-run the whole
           ladder every half hour, which on a configured NOTIFY_ADMINS inbox means
           a copy every half hour — so the honest number is the fix: a run of
           `delivered: 0` rows is the signal that the roster, not the sweep, is
           what needs attention. */
        delivered,
        toldNobody: delivered === 0,
      });
      sent++;
    } catch (e) {
      /* RELEASE THE CLAIM — but ONLY when nothing went out. The stamp is written
         BEFORE the send, so a send that threw used to leave the file silenced for
         two days with nothing delivered. Now that the ladder is THREE sends, an
         unconditional release is its own bug: if the assignee's nudge landed and
         the team's then threw, releasing means the next pass re-sends to the
         assignee, who is the one person guaranteed to have received it. Keeping
         the claim costs at most one delayed escalation; releasing it costs a
         duplicate. Released BY ID, so it can only ever remove this pass's row. */
      if (!delivered) await _releaseClaim(claimId);
      console.error('[digest] order-overdue', r.application_id, e && e.message,
        delivered ? `(${delivered} already delivered — the throttle is KEPT so nobody is told twice)` : '');
    }
  }
  return sent;
}

/* THE WORKFLOW, phase two: nudge anyone whose personal Workflow has OVERDUE
   hand-offs (past their SLA due date), once/day per person. Keeps files moving
   without a manager having to chase — mirrors the draw-overdue self-gate. */
async function workflowAgingOnce() {
  let sent = 0;
  let rows = [];
  try { rows = await workflow.overdueByRecipient(); } catch (_) { return 0; }
  for (const r of rows) {
    try {
      if (!r.to_staff_id || !(await _gateRecipient('workflow_overdue', r.to_staff_id, '20 hours'))) continue;
      /* NAME THE FILES, ONE CARD PER WORKFLOW (owner-directed 2026-08-07: *"emails like this
         should have a list of the files and the status of each and every file and whose loan
         officer in every single file … nicely design every workflow separately"*). The old body
         was a count and a link — everything it knew, it made the reader go and look up again; the
         first pass at the fix was one merged list, which reads as ONE job arbitrarily split.
         `workflowQueues.buildQueueTables` (pure) splits the rows by workflow family so a
         processor's queue, a closer's queue and a draw coordinator's queue arrive as three
         separate cards, each saying what that queue is for, and — for draws only — carrying only
         the files where somebody is actually waiting on money.

         Best-effort: if the detail query fails the nudge still goes with its count, because a
         person with overdue work being told nothing is the worse outcome. */
      let items = [];
      try { items = await workflow.overdueItemsFor(r.to_staff_id); } catch (_) { items = []; }
      let queues = { tables: [], shown: 0, parked: 0 };
      try {
        queues = workflowQueues.buildQueueTables(items, workflow.typeConfig, { perTable: 8 });
      } catch (e) { console.error('[digest] workflow-queues', e && e.message); }
      /* The count in the headline is the recipient's REAL overdue total. The cards can hold fewer
         (the per-card cap, and the parked draw files) — so when they do, say so rather than let the
         two numbers silently disagree. */
      const unlisted = Math.max(0, (Number(r.overdue) || 0) - queues.shown - queues.parked);
      await notify.notifyStaff(r.to_staff_id, {
        type: 'workflow_ready',
        title: r.overdue === 1 ? 'A file in your Workflow is overdue' : `${r.overdue} files in your Workflow are overdue`,
        badge: { text: 'Overdue', tone: 'action' },
        body: `You have ${r.overdue} file${r.overdue === 1 ? '' : 's'} in your Workflow past ${r.overdue === 1 ? 'its' : 'their'} target time.`,
        emailBody: `These hand-offs are past the target time they were meant to be picked up or sent back in. They are grouped below by the queue they belong to — pick one up, or send it back to whoever submitted it.${unlisted ? ` ${unlisted} more ${unlisted === 1 ? 'is' : 'are'} waiting in your Workflow.` : ''}`,
        tables: queues.tables.length ? queues.tables : null,
        link: '/internal/workflow', ctaLabel: 'Open my Workflow' });
      await _stamp('workflow_overdue', r.to_staff_id, { overdue: r.overdue });
      sent++;
    } catch (e) { console.error('[digest] workflow-aging', r.to_staff_id, e && e.message); }
  }
  return sent;
}

/* Sovereign 4/4 nightly training-loop aggregation (owner-directed 2026-07-21).
   Runs learning.runTraining once per day inside the morning window so any new
   correction patterns from the prior 24 hours become CANDIDATE improvements
   in the training queue (super-admin still has to promote — nothing auto-
   promotes to production). Self-gated to at most one run per day via _gate. */
async function trainingRunOnce() {
  if (!(await _gate('training_run_daily', null, '20 hours'))) return 0;
  try {
    const client = await db.getClient();
    let result;
    try {
      await client.query('BEGIN');
      result = await require('./underwriting/learning').runTraining(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    await _stamp('training_run_daily', null, result || {});
    return (result && result.inserted) || 0;
  } catch (e) { console.error('[digests] training-run', e && e.message); return 0; }
}

/* Sovereign continuous CTC surveillance (owner-directed 2026-07-21). Walks
   every file with a VALID decision certificate; any canonical fact change
   since issue flips the certificate to 'validation_required' so a coordinator
   re-verifies before the file advances. Self-gated to at most once per day. */
/* R2.10 — Nightly Section 1071 coverage classification sweep (owner-directed
   2026-07-22). Runs the classifier over every ACTIVE file so the coverage
   verdict (covered-report-PILOT / covered-report-partner / not-covered-* /
   pending) is always current on the compliance dashboard. The classifier
   only reads applications columns + one env flag, so it's cheap; the
   institution-not-covered branch short-circuits to a no-op verdict when
   INSTITUTION_1071_COVERED is unset (the default today). Self-gated to
   at most once per 20 hours. */
async function section1071SweepOnce() {
  if (!(await _gate('section_1071_sweep_daily', null, '20 hours'))) return 0;
  let touched = 0, changed = 0;
  try {
    const s1071 = require('./underwriting/section-1071');
    const targets = await db.query(
      `SELECT id FROM applications
        WHERE deleted_at IS NULL AND status NOT IN ('withdrawn','cancelled','declined')
        ORDER BY updated_at DESC, id`);
    for (const row of targets.rows) {
      try {
        const client = await db.getClient();
        try {
          await client.query('BEGIN');
          const r = await s1071.classifyAndPersist(client, row.id);
          await client.query('COMMIT');
          touched += 1;
          if (r && r.changed) changed += 1;
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        finally { client.release(); }
      } catch (e) { console.error('[digests] section-1071', row.id, e && e.message); }
    }
    await _stamp('section_1071_sweep_daily', null, { touched, changed });
    return changed;
  } catch (e) { console.error('[digests] section-1071', e && e.message); return changed; }
}

/* R2.9 — Nightly auto-read sweep (owner-directed 2026-07-22). Walks every
   active file with UNREAD document(s) uploaded in the last 24 hours and
   drives them through the exact same auto-read pipeline the /:appId/auto-read
   button drives — same paid cooldown, same idempotency cache, same per-doc
   error containment. So a freshly-uploaded bank statement / appraisal /
   title binder gets read WITHOUT waiting for someone to open the file and
   click the button.
   Bounded: AUTO_READ_SWEEP_BATCH_FILES (default 20 files/run) × the route's
   own AUTOREAD_MAX_PER_CALL cap on documents/file. Skips entirely when the
   reader/analyzer isn't configured OR the master kill-switch is off. Self-
   gated to at most once per 4 hours (fresher than daily — an uploaded doc
   should be read within hours, not a day). */
async function autoReadSweepOnce() {
  if (!(await _gate('auto_read_sweep_hourly', null, '4 hours'))) return 0;
  const BATCH = Number(process.env.AUTO_READ_SWEEP_BATCH_FILES || 20);
  let filesRead = 0, totalDocs = 0;
  try {
    const uw = require('../routes/underwriting');
    if (!uw.AUTOREAD_ENABLED) { await _stamp('auto_read_sweep_hourly', null, { skipped: 'AUTOREAD disabled' }); return 0; }
    // Target files with at least one CURRENT, non-rejected, non-chat-attachment
    // document uploaded in the last 24h that has no current extraction and whose
    // application is active. Cheap indexed query.
    const targets = await db.query(
      `SELECT a.id, min(d.created_at) AS oldest_doc
         FROM applications a
         JOIN documents d ON (d.application_id = a.id
                              OR EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.id = d.checklist_item_id AND ci.application_id = a.id))
        WHERE a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','cancelled','funded','declined','file_intake')
          AND d.is_current = true
          AND COALESCE(d.review_status, '') <> 'rejected'
          AND COALESCE(d.source_type, '') <> 'chat_attachment'
          AND d.created_at > now() - interval '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM document_extractions ex
             WHERE ex.document_id = d.id AND ex.application_id = a.id AND ex.is_current
          )
        GROUP BY a.id
        -- GROUP BY (not DISTINCT) so the batch can be ORDERED: an unordered LIMIT let Postgres
        -- return an arbitrary BATCH of the waiting files, so with more than BATCH files waiting a
        -- document could be passed over on every sweep and never read. Longest-waiting first.
        ORDER BY oldest_doc ASC, a.id
        LIMIT $1`, [BATCH]);
    for (const row of targets.rows) {
      try {
        const app = await uw.fileForById(row.id);
        if (!app) continue;
        const queue = await uw.buildAutoReadQueue(app);
        const batch = queue.slice(0, uw.AUTOREAD_MAX_PER_CALL);
        for (const item of batch) {
          try {
            const doc = await uw.fileDocById(app, item.id);
            if (!doc) continue;
            await uw.analyzeOneDocument(app, doc, item.expectedType, { actorId: null });
            totalDocs += 1;
          } catch (e) { console.error('[digests] auto-read-sweep doc', row.id, item.id, e && e.message); }
        }
        if (batch.length > 0) filesRead += 1;
      } catch (e) { console.error('[digests] auto-read-sweep file', row.id, e && e.message); }
    }
    await _stamp('auto_read_sweep_hourly', null, { filesRead, totalDocs });
    return filesRead;
  } catch (e) { console.error('[digests] auto-read-sweep', e && e.message); return filesRead; }
}

/* UN-FUNDED RE-READ SWEEP (owner decision 2026-07-27). One bounded slice per
   tick: re-read a few alive, not-yet-funded files whose stored reads predate
   the current reader generation, so the findings-cleanup extraction fixes
   (liquidity / credit / appraisal / OFAC+fraud deep reads) reach files that
   were already analysed. All the safety — bounded batch, per-file cost cap,
   generation-stamp idempotency, off-switch, reader-off no-op, re-reads-only
   (never clears a condition / moves a status / notifies) — lives in the sweep
   module. Best-effort; a failure here never disturbs the rest of the dispatch. */
async function unfundedRereadSweepOnce() {
  try {
    const r = await require('./underwriting/reread-sweep').sweepOnce();
    return (r && r.filesRead) || 0;
  } catch (e) { console.error('[digests] reread-sweep', e && e.message); return 0; }
}

/* R2.8 — Nightly direct-source verification sweep (Sovereign extension,
   owner-directed 2026-07-22). Walks every active file whose PILOT status is
   past 'file_intake' and calls direct-source-hub.verifyFile per file — the
   hub, in turn, calls every CONFIGURED connector (Plaid, Xactus,
   property_data, HouseCanary, Clear Capital, ATTOM) and feeds
   api_verification observations to the twin. Unconfigured connectors are
   cleanly skipped (no HTTP), so this is a safe no-op until the first vendor
   key lands in Render — at which point the sweep automatically starts
   producing verified twin facts.
   Bounded: DIRECT_SOURCE_SWEEP_BATCH (default 40 files/run) so an outage
   burst never runs away. Self-gated to at most once per 20 hours. */
async function directSourceSweepOnce() {
  if (!(await _gate('direct_source_sweep_daily', null, '20 hours'))) return 0;
  const BATCH = Number(process.env.DIRECT_SOURCE_SWEEP_BATCH || 40);
  let files = 0, calls = 0;
  try {
    // Any live vendor connector configured? If not, skip entirely — no HTTP,
    // no notify, no work. Cheap early-return so a keyless environment stays
    // silent.
    const hub = require('./integrations/direct-source-hub');
    const configuredCount = Object.values(hub.CONNECTORS || {}).filter((c) => { try { return c.configured(); } catch { return false; } }).length;
    if (configuredCount === 0) { await _stamp('direct_source_sweep_daily', null, { skipped: 'no vendor keys configured' }); return 0; }
    const targets = await db.query(
      // AUDIT FIX (2026-07-26) — this was the worst instance of the whole class. `ORDER BY
      // updated_at DESC LIMIT 40` means the sweep re-verifies the 40 most RECENTLY TOUCHED files,
      // over and over, and a file outside that window is never direct-source verified at all — not
      // "eventually", never. Busy files were being re-checked daily while quiet ones went unchecked
      // for their entire life, and each re-check is a paid vendor call.
      //
      // Now it is a real queue: LEAST-RECENTLY-VERIFIED first (never-verified first), with files
      // verified inside the last 7 days excluded so they do not consume a slot. Every active file
      // is reached, none is re-billed within the week, and the batch rotates on its own.
      `SELECT a.id, v.at AS last_verified
         FROM applications a
         LEFT JOIN LATERAL (
           SELECT max(l.created_at) AS at FROM audit_log l
            WHERE l.entity_type = 'application' AND l.action = '${DIGEST_ACTION.DIRECT_SOURCE_FILE}' AND l.entity_id = a.id
         ) v ON true
        WHERE a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','cancelled','funded','declined')
          AND a.status IS DISTINCT FROM 'file_intake'
          AND (v.at IS NULL OR v.at < now() - interval '7 days')
        ORDER BY last_verified ASC NULLS FIRST, a.id
        LIMIT $1`, [BATCH]);
    for (const row of targets.rows) {
      try {
        // Claim the per-file slot BEFORE spending money on vendor calls. This is the same atomic
        // claim every other digest uses, and it is what makes the ordering above a real rotation:
        // the stamp it writes is the sort key, so a verified file moves to the back of the queue.
        const claimId = await _claim(DIGEST_ACTION.DIRECT_SOURCE_FILE, row.id, '7 days');
        if (!claimId) continue;
        let verified = false;
        // RELEASE ON EVERY PATH THAT VERIFIED NOTHING — including a THROW (audit 2026-07-26).
        //
        // The first version released only when `verifyFile` returned cleanly with no ok result, and
        // rethrew on an exception. That covered the least likely failure and missed the most likely
        // ones: `getClient()` exhausting the pool, BEGIN/COMMIT failing, or a connector throwing
        // rather than reporting `{ok:false}`. Any of those escaped past the release, so the file
        // kept a "verified" stamp and sat out of the queue for seven days having been verified by
        // nobody — the precise outcome the release exists to prevent, reached by the more common
        // route. The `finally` makes the property structural: nothing verified, claim goes back.
        try {
          const client = await db.getClient();
          try {
            await client.query('BEGIN');
            const r = await hub.verifyFile(client, row.id, {});
            await client.query('COMMIT');
            files += 1;
            calls += (r && r.results ? r.results.filter((x) => x.ok || x.reason).length : 0);
            // Did ANY connector actually return something? `verifyFile` swallows connector errors
            // and reports them as {ok:false, reason}, so a vendor outage or a rotated key does not
            // throw — it comes back as a full set of failures.
            verified = !!(r && Array.isArray(r.results) && r.results.some((x) => x && x.ok));
          } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
          finally { client.release(); }
        } finally {
          if (!verified) await _releaseClaim(claimId);
        }
      } catch (e) { console.error('[digests] direct-source-sweep', row.id, e && e.message); }
    }
    await _stamp('direct_source_sweep_daily', null, { files, calls, configuredCount });
    return files;
  } catch (e) { console.error('[digests] direct-source-sweep', e && e.message); return files; }
}

async function certificateSurveyOnce() {
  if (!(await _gate('cert_survey_daily', null, '20 hours'))) return 0;
  try {
    const client = await db.getClient();
    let result;
    try {
      await client.query('BEGIN');
      result = await require('./underwriting/certificate').surveyAllValidCertificates(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    await _stamp('cert_survey_daily', null, result || {});
    // R2.4 — fan out a "signed snapshot needs re-verification" notification
    // to the assigned team for every flagged file. Best-effort per file; a
    // single notify failure never breaks the batch.
    const flagged = (result && result.flaggedByFile) || [];
    for (const f of flagged) {
      try {
        const milestones = (f.milestones || []).map((m) => String(m).replace(/_/g, ' ')).join(', ');
        await notify.notifyAppStaff(f.application_id, {
          type: 'sync_review',
          title: 'A signed snapshot on this file needs re-verification',
          body: `The daily surveillance sweep noticed ${f.totalChanges} canonical fact change(s) since the last snapshot was stamped for: ${milestones}. Re-verify the file's numbers, then stamp a fresh snapshot from the file's Sovereign panel.`,
          applicationId: f.application_id,
          link: `/internal/app/${f.application_id}#sec-underwriting`,
        });
      } catch (e) { console.error('[digests] cert-survey notify', f.application_id, e && e.message); }
    }
    return (result && result.flagged) || 0;
  } catch (e) { console.error('[digests] cert-survey', e && e.message); return 0; }
}

/* Sovereign 3/4 — auto-run the multi-model committee on every OPEN FATAL
   finding that hasn't been panel-reviewed yet (owner-directed 2026-07-21).
   Fatals block clear-to-close; giving them an independent adversarial review
   automatically means the reviewer sees the panel's opinion the moment they
   open the file. Bounded batch (BATCH_LIMIT, default 20) so an outage burst
   never runs away. Best-effort per finding — a specialist error is recorded
   as a failed vote, never thrown. Self-gated to at most every 6 hours (the
   committee call costs a paid model round-trip per specialist per finding). */
async function autoCommitteeReviewOnce() {
  // Owner hard rule (2026-07-22): the AI does NOT act on its own. The scheduled
  // committee sweep is gated OFF by default — super-admins still run the panel
  // on demand from the file view, and the panel's verdict becomes an AI
  // SUGGESTION (kind='finding') that a human decides on. Set AI_AUTO_COMMITTEE=1
  // if the owner explicitly opts back in.
  const cfg = require('../config');
  if (!cfg.aiAutoCommittee) return 0;
  if (!(await _gate('auto_committee_fatal', null, '6 hours'))) return 0;
  const BATCH_LIMIT = Number(process.env.AUTO_COMMITTEE_BATCH || 20);
  let reviewed = 0;
  try {
    // Pick open fatal findings on active files that haven't been reviewed.
    const q = await db.query(
      `SELECT df.id, df.code, df.severity, df.title, df.field, df.doc_value, df.file_value, df.how_to,
              df.application_id AS app_id,
              a.property_address, a.program, a.loan_amount,
              b.first_name, b.last_name,
              l.llc_name AS entity_name
         FROM document_findings df
         JOIN applications a ON a.id = df.application_id
         LEFT JOIN borrowers b ON b.id = a.borrower_id
         LEFT JOIN llcs l ON l.id = a.llc_id
        WHERE df.status='open' AND df.severity='fatal'
          AND df.committee_reviewed_at IS NULL
          AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','cancelled','funded')
        ORDER BY df.created_at DESC, df.id
        LIMIT $1`, [BATCH_LIMIT]);
    for (const f of q.rows) {
      try {
        const context = {
          borrowerName: require('./person-name').displayName(f) || null,
          entityName:   f.entity_name || null,
          propertyAddress: f.property_address && (f.property_address.line1 || f.property_address.address) || null,
          program:      f.program || null,
          loanAmount:   f.loan_amount || null,
        };
        const opinion = await require('./ai/committee').review({
          id: f.id, code: f.code, severity: f.severity, title: f.title,
          docValue: f.doc_value, fileValue: f.file_value, field: f.field, howTo: f.how_to,
        }, context);
        // Persist the review + snapshot the committee's action back onto the finding.
        const c = await db.getClient();
        try {
          await c.query('BEGIN');
          await c.query(
            `INSERT INTO finding_committee_reviews
               (application_id, finding_id, committee_version, action, original_severity,
                adjudicated_severity, confidence, reasoning, votes_json, dissents_json,
                abstained_json, failed_json, requested_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13)`,
            [f.app_id, f.id, opinion.committee_version || 'v1',
             opinion.committee.action, opinion.committee.original_severity,
             opinion.committee.adjudicated_severity, opinion.committee.confidence,
             opinion.committee.reasoning, JSON.stringify(opinion.committee.votes || []),
             JSON.stringify(opinion.committee.dissents || []),
             JSON.stringify(opinion.committee.abstained || []),
             JSON.stringify(opinion.committee.failed || []),
             null]);
          await c.query(
            `UPDATE document_findings
                SET committee_action=$2, committee_severity=$3, committee_confidence=$4,
                    committee_reviewed_at=now()
              WHERE id=$1`,
            [f.id, opinion.committee.action, opinion.committee.adjudicated_severity,
             opinion.committee.confidence]);
          await c.query('COMMIT');
          reviewed += 1;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      } catch (e) { console.error('[digests] auto-committee', f.id, e && e.message); }
    }
    await _stamp('auto_committee_fatal', null, { reviewed, batchLimit: BATCH_LIMIT });
    return reviewed;
  } catch (e) { console.error('[digests] auto-committee', e && e.message); return reviewed; }
}

/* R3.35 — Nightly AI cross-doc consistency sweep (opt-in). Runs the GPT-5
   cross-doc consistency check on every active file at most once/monthly.
   Gated behind AI_CROSSDOC_SWEEP_ENABLED=1 (default OFF — this is a paid
   AI call per file, so nothing runs until the owner opts in). */
async function aiCrossdocSweepOnce() {
  if (process.env.AI_CROSSDOC_SWEEP_ENABLED !== '1') return 0;
  if (!(await _gate('ai_crossdoc_sweep', null, '24 hours'))) return 0;
  const BATCH = Number(process.env.AI_CROSSDOC_SWEEP_BATCH || 5);
  let ran = 0;
  try {
    // Pick oldest files that haven't been crossdoc-scanned in the last 30 days.
    const q = await db.query(
      `SELECT a.id FROM applications a
        WHERE a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','cancelled','funded','declined')
          AND NOT EXISTS (SELECT 1 FROM audit_log al
                            WHERE al.entity_type='application' AND al.entity_id=a.id
                              AND al.action='ai_crossdoc_sweep_ran'
                              AND al.created_at > now() - interval '30 days')
        ORDER BY a.updated_at DESC, a.id
        LIMIT $1`, [BATCH]);
    for (const row of q.rows) {
      const c = await db.getClient();
      try {
        await c.query('BEGIN');
        // Fix 2026-07-23: extraction status is 'analyzed' (db/200), never 'ok' —
        // the nightly cross-doc sweep saw zero extractions on every file.
        const exts = await c.query(
          `SELECT doc_type, document_id, fields FROM document_extractions
            WHERE application_id=$1 AND is_current AND status='analyzed' ORDER BY created_at DESC, document_id LIMIT 40`, [row.id]);
        if (exts.rows.length >= 2) {
          await require('./underwriting/ai-cross-doc').analyzeFile(c, {
            applicationId: row.id, extractions: exts.rows,
            appMeta: { source: 'nightly_sweep' },
          });
          ran += 1;
        }
        // Stamp so we don't re-scan too soon.
        await c.query(
          `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
           VALUES ('system','ai_crossdoc_sweep_ran','application',$1,$2::jsonb)`,
          [row.id, JSON.stringify({ at: new Date().toISOString(), extractions: exts.rows.length })]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('[digests] ai-crossdoc-sweep', row.id, e && e.message); }
      finally { c.release(); }
    }
    await _stamp('ai_crossdoc_sweep', null, { ran, batch: BATCH });
    return ran;
  } catch (e) { console.error('[digests] ai-crossdoc-sweep', e && e.message); return ran; }
}

/* Time-gated dispatcher — morning window for staff/admin, business hours for the
   borrower digest; each function's own audit-gate enforces the true frequency. */
// -------------------------------------------------------------------------
// #191 activation 3 — condition FRESHNESS reopen sweep (daily, capped).
// Cleared conditions whose evidence has outlived its freshness window
// (bank statements 60d, credit 120d, title 120d, insurance/flood 365d —
// windows live in condition-reopen.js, never here) reopen through the SAME
// audited path every automated reopen uses: checklist-evidence.
// reopenConditionEvidence + an [auto] note + an audit_log row. Waived
// conditions never reopen (human decision); the frozen SOW gates are
// structurally out of scope (their codes aren't in the freshness map);
// capped per run so a first activation drains a backlog gradually.
// Kill switch: CONDITION_FRESHNESS_ENABLED=0.
// -------------------------------------------------------------------------
async function conditionFreshnessReopenOnce() {
  if (process.env.CONDITION_FRESHNESS_ENABLED === '0') return;
  if (!(await _gate('condition_freshness_reopen', null, '20 hours'))) return;
  const freshness = require('./underwriting/condition-freshness');
  const { reopenConditionEvidence } = require('./checklist-evidence');
  const codes = Object.keys(freshness.KIND_BY_TEMPLATE_CODE);
  // For credit conditions the freshness clock runs off the report's OWN
  // effective date (credit_reports.report_date), not the staff sign-off date —
  // a 120-day-old report signed off yesterday is already stale. We take the
  // LATEST report_date attached to the condition item (reissues supersede) and
  // pass it as effective_at; planFreshnessReopens falls back to signed_off_at
  // for every other kind (no separate evidence date is tracked).
  const rows = await db.query(
    `SELECT ci.id, ci.application_id, ci.status, ci.signed_off_at, ci.waived_at,
            ct.code AS template_code,
            cr.report_date AS effective_at
       FROM checklist_items ci
       JOIN checklist_templates ct ON ct.id = ci.template_id
       JOIN applications a ON a.id = ci.application_id
       LEFT JOIN LATERAL (
         SELECT r.report_date
           FROM credit_reports r
          WHERE r.checklist_item_id = ci.id
            AND r.report_date IS NOT NULL
          ORDER BY r.report_date DESC
          LIMIT 1
       ) cr ON true
      WHERE ct.code = ANY($1)
        AND ci.signed_off_at IS NOT NULL
        AND ci.waived_at IS NULL
        AND a.deleted_at IS NULL
        AND a.status NOT IN ('funded','declined','withdrawn')
      ORDER BY ci.signed_off_at ASC, ci.id
      LIMIT 400`, [codes]);
  const plans = freshness.planFreshnessReopens(rows.rows, { now: new Date(), limit: 25 });
  let reopened = 0;
  for (const plan of plans) {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      // Re-check under the tx so a just-refreshed condition isn't clobbered.
      const cur = (await c.query(
        `SELECT signed_off_at, waived_at FROM checklist_items WHERE id=$1 FOR UPDATE`, [plan.id])).rows[0];
      // `continue` still runs the finally{} below, which releases — a second
      // c.release() here would throw synchronously in pg-pool and abort the
      // whole run mid-plan. ROLLBACK only; the finally releases exactly once.
      if (!cur || !cur.signed_off_at || cur.waived_at) { await c.query('ROLLBACK'); continue; }
      await reopenConditionEvidence(c, plan.id, 'outstanding');
      await c.query(
        `UPDATE checklist_items
            SET notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
                updated_at = now()
          WHERE id = $1`, [plan.id, freshness.autoNoteFor(plan)]);
      await c.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system','condition_freshness_reopened','checklist_item',$1,$2::jsonb)`,
        [plan.id, JSON.stringify({ applicationId: plan.applicationId, kind: plan.kind,
          trigger: plan.trigger, daysStale: plan.daysStale, clearedAt: plan.clearedAt })]);
      await c.query('COMMIT');
      reopened += 1;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.error('[digests] freshness-reopen', plan.id, e && e.message);
    } finally { c.release(); }
  }
  if (reopened) console.log(`[digests] freshness reopened ${reopened} condition(s)`);
}

/* ── Exception-workflow redesign (2026-07-24): the register's two clocks ──
   (1) exceptionAgingOnce — open exception requests past their review SLA
       (due_at) nudge every super-admin once a day: an unanswered exception is
       a stalled file, and the requester can't move it themselves.
   (2) exceptionExpirySweepOnce — flips approved, TIME-BOXED exceptions past
       their expires_at to 'expired' (the e-sign gate honors only
       status='approved', so an expired one fails CLOSED on its own) and tells
       the file's team. Only expirable types are swept — a guaranty waiver can
       never be flipped by a clock (engine-enforced too). The flip itself is
       once-per-row by construction (status change), so no extra gate. */
async function exceptionAgingOnce() {
  let rows = [];
  try { rows = await loanExceptions.agingOpen(); } catch (_) { return 0; }
  if (!rows.length) return 0;
  if (!(await _gate('exception_aging_digest', null, '20 hours'))) return 0;
  const labels = Object.fromEntries(Object.entries(loanExceptions.EXCEPTION_TYPES).map(([k, v]) => [k, v.label]));
  /* THE LIST IS A TABLE, NOT A PARAGRAPH OF BULLETS (owner-directed 2026-08-07: *"e-mails like
     this should be much nicer designed"*). The old body packed every waiting exception into one
     newline-joined run of "• Send before clear-to-close — 276 Blake St, New Haven · waiting 10d"
     inside a single paragraph — which mail clients reflow, so on a phone the bullets wrapped into
     each other and the ages ran together. Each row now has its own line and its own age column,
     and the OLDEST is first: the whole point of a review-target digest is that the top row is the
     one hurting most. The plain-text body keeps a readable list for any client that strips HTML. */
  const shown = rows.slice(0, 12);
  const ageOf = (r) => {
    const days = Math.floor(Number(r.open_hours || 0) / 24);
    return days >= 1 ? `${days}d` : `${Math.round(Number(r.open_hours || 0))}h`;
  };
  const addrOf = (r) => {
    const a = r.property_address;
    const addr1 = !a ? '' : (typeof a === 'string' ? a : [a.line1 || a.address, a.city].filter(Boolean).join(', '));
    return addr1 || r.ys_loan_number || 'a file';
  };
  const table = {
    title: 'Waiting on a decision — oldest first',
    head: ['Property / file', 'Exception', 'Waiting'],
    align: ['left', 'left', 'right'],
    rows: shown.map((r) => [addrOf(r), labels[r.exception_type] || r.exception_type, ageOf(r)]),
    note: rows.length > shown.length
      ? `…and ${rows.length - shown.length} more in the Exceptions box.`
      : null,
  };
  const supers = await db.query(`SELECT id FROM staff_users WHERE role='super_admin' AND is_active=true`);
  let sent = 0;
  for (const su of supers.rows) {
    try {
      await notify.notifyStaff(su.id, {
        type: 'exception_aging',
        title: rows.length === 1 ? 'An exception request is waiting past its review target'
          : `${rows.length} exception requests are waiting past their review target`,
        badge: { text: 'Review due', tone: 'action' },
        // The in-app row keeps a short summary; the email gets the sentence + the table.
        body: `${rows.length} policy-exception request${rows.length === 1 ? ' has' : 's have'} been open longer than the review target.`,
        emailBody: 'These policy-exception requests have been open longer than the review target. The person who raised them cannot move them — only an approver can decide.',
        table,
        link: '/internal/exceptions', ctaLabel: 'Open the Exceptions box',
      });
      sent++;
    } catch (e) { console.error('[digest] exception-aging', su.id, e && e.message); }
  }
  await _stamp('exception_aging_digest', null, { open: rows.length, notified: sent });
  return sent;
}

async function exceptionExpirySweepOnce() {
  let flipped = [];
  try { flipped = await loanExceptions.expireDueApprovals(); } catch (_) { return 0; }
  let sent = 0;
  for (const r of flipped) {
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system','loan_exception_expired','application',$1,$2::jsonb)`,
        [r.application_id, JSON.stringify({ exceptionId: r.id, exceptionType: r.exception_type, expiresAt: r.expires_at })]).catch(() => {});
      const labels = Object.fromEntries(Object.entries(loanExceptions.EXCEPTION_TYPES).map(([k, v]) => [k, v.label]));
      await notify.notifyAppStaff(r.application_id, {
        type: 'exception_expired',
        title: `An approved exception expired (${labels[r.exception_type] || r.exception_type})`,
        body: `The approved "${labels[r.exception_type] || r.exception_type}" exception (EX-${r.exception_seq}) on this file passed its validity date and has EXPIRED — it no longer grants anything. If it's still needed, request it again so a super-admin can re-approve it against the current state of the deal.`,
        applicationId: r.application_id,
        link: `/internal/app/${r.application_id}`, ctaLabel: 'Open the loan file',
      });
      sent++;
    } catch (e) { console.error('[digest] exception-expiry', r.id, e && e.message); }
  }
  return sent;
}

/**
 * THE DAILY BACKUP WATCH — the thing that notices the off-site backup has stopped.
 *
 * WHY IT LIVES HERE, in the web service, rather than in either backup job.
 *
 * The nightly backup emails only when it FAILS, and a job that never runs never fails. Suspend the
 * cron, break its image, get the schedule wrong, lapse the billing — and it goes completely silent,
 * which is indistinguishable from a quiet healthy night. That hole was already known: the WEEKLY
 * restore drill carries a freshness check (`manifest.freshness`, PR #973) and is the only thing that
 * reports either way. But weekly is the wrong resolution for a nightly job — a backup that stops on
 * a Monday is not noticed until the drill runs on Sunday, and those six days are exactly the window
 * in which somebody believes they are protected and is not.
 *
 * Neither cron can close that gap: a job that is not running cannot report its own absence. The web
 * service can — it is awake every 30 minutes, and `backup_runs` is an ordinary table it already
 * reads for /api/health. So the check costs one query a day and needs no new service, no new
 * credential, and nothing in the request path.
 *
 * THREE RULES, each of which is the difference between a useful alarm and noise nobody reads:
 *   · SILENCE IS THE HEALTHY STATE. A protected system sends nothing. The one "all good" worth
 *     reading is the drill's, because it is the only message that proves a restore actually works.
 *   · IT ONLY WATCHES A BACKUP THAT HAS EVER WORKED. With no successful run ever recorded, this is
 *     a deployment where the backup was never turned on (the env vars live on the cron services, not
 *     here, so configuration cannot be read from this process) — and a daily "you have no backup" to
 *     someone who never asked for one is the fastest way to train them to ignore the alarm. A
 *     configured-but-failing job already emails on its own failure; the silent stop is what is
 *     uncovered, and it can only happen to a backup that once ran.
 *   · A STALE DRILL IS A SEPARATE, QUIETER MESSAGE. A backup that is being taken but not tested is a
 *     different problem from no backup at all, with a different urgency and a different action —
 *     collapsing them into one alarm is how the important one gets diluted. Own gate, own wording,
 *     and it never fires while the louder one is firing.
 *
 * Best-effort throughout: this can never throw into the dispatcher, and never touches a backup.
 */
async function backupFreshnessWatchOnce() {
  const b = require('../config').backup || {};
  const maxAgeHours = Number(b.watchMaxAgeHours);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return 0;   // deliberately switched off

  const report = require('./backup/report');
  let s;
  try {
    s = await report.protectionStatus(db, {
      staleAfterHours: maxAgeHours,
      verifyStaleAfterDays: Number(b.watchVerifyStaleDays) || 10,
    });
  } catch (e) {
    // A backstop only. `report.lastSuccess` already swallows its own query errors and returns null,
    // so an unreadable ledger normally arrives below as `lastBackupAt: null` rather than as a throw.
    console.error('[digests] backup-watch: could not read the backup ledger:', e && e.message);
    return 0;
  }

  // NO SUCCESSFUL BACKUP ON RECORD → SAY NOTHING. This single line carries TWO safety properties,
  // which is why it must not be "simplified" into the !protected branch below:
  //   · not configured ≠ broken (rule 2 above), and
  //   · a ledger we could not READ looks exactly like this, because lastSuccess() catches its own
  //     errors and returns null. So a database blip degrades to silence instead of announcing that
  //     the backups have stopped — a false alarm about the one system nobody can afford to
  //     distrust is worse than a missed day, and the next tick simply tries again.
  // Both cases are "we have nothing to say", and neither is "you are unprotected".
  if (!s.lastBackupAt) return 0;

  const ageH = s.lastBackupAgeHours;
  const ageText = ageH == null ? 'an unknown time'
    : ageH < 48 ? `${Math.round(ageH)} hours`
    : `${Math.round(ageH / 24)} days`;

  if (!s.protected) {
    // One per morning while it stays broken — a daily nudge, not an hourly one.
    if (!(await _gate('backup_freshness_alert', null, '20 hours'))) return 0;
    await report.alert({
      ok: false,
      subject: `The off-site backup has stopped — the last one was ${ageText} ago`,
      lines: [
        `The last successful backup of the database finished ${ageText} ago.`,
        `A backup is expected every night, so something has stopped it.`,
        '',
        `What this means: everything entered since that backup is not in any off-site copy yet.`,
        `The live system is working normally and no data has been lost — but if something happened`,
        `to it right now, that work would not come back.`,
        '',
        s.lastVerifiedAt
          ? `The last backup that was actually test-restored was on ${new Date(s.lastVerifiedAt).toDateString()}.`
          : `No backup has been test-restored yet.`,
      ],
      action: 'Open the Render dashboard and check the "ys-capital-backup" job — see whether its last '
            + 'run failed or whether it stopped running at all. The restore instructions are in '
            + 'docs/DATABASE-BACKUP-AND-RESTORE.md.',
    });
    return 1;
  }

  // Backups are current. Is anyone still proving they restore?
  if (!s.verificationFresh) {
    if (!(await _gate('backup_verify_stale_alert', null, '6 days'))) return 0;
    await report.alert({
      ok: false,
      subject: 'Backups are running, but none has been test-restored recently',
      lines: [
        `The nightly backup is working — the last one was ${ageText} ago.`,
        s.lastVerifiedAt
          ? `But the weekly test restore has not run since ${new Date(s.lastVerifiedAt).toDateString()}.`
          : `But no test restore has ever completed.`,
        '',
        `What this means: we are still taking copies, and we have not recently proven one of them`,
        `can actually be restored. This is a lower priority than a stopped backup — but the test is`,
        `the only thing that proves the copies are usable.`,
      ],
      action: 'Check the "ys-capital-backup-verify" job in the Render dashboard.',
    });
    return 1;
  }

  return 0;   // protected and recently proven — say nothing
}

async function runDue() {
  const { hour, weekday } = nyParts();
  // The un-funded re-read sweep runs on EVERY tick, around the clock: it sends nothing to anyone
  // (re-reads + re-records only), so the time of day does not matter, and a steady slice each tick
  // is what keeps the existing book moving onto the corrected reads. Its own generation stamp makes
  // it a no-op once the book is caught up.
  await unfundedRereadSweepOnce().catch((e) => console.error('[digests] reread-sweep', e && e.message));
  if (hour >= 7 && hour < 11) {
    // First: is the off-site backup still running? A stopped backup is silent by nature, so this
    // check is the only thing between "it stopped" and "we found out when we needed it".
    await backupFreshnessWatchOnce().catch((e) => console.error('[digests] backup-watch', e && e.message));
    await dailyPipelineDigestOnce().catch((e) => console.error('[digests] pipeline', e && e.message));
    await staleFileAlertsOnce().catch((e) => console.error('[digests] stale', e && e.message));
    await workflowAgingOnce().catch((e) => console.error('[digests] workflow-aging', e && e.message));
    await exceptionAgingOnce().catch((e) => console.error('[digests] exception-aging', e && e.message));
    await drawReleaseOverdueOnce().catch((e) => console.error('[digests] draw-release', e && e.message));
    await trustpointUnreleasedOnce().catch((e) => console.error('[digests] trustpoint-unreleased', e && e.message));
    // Increment C — the four per-status draw COORDINATOR reminders. TrustPoint/Trinity nudge daily;
    // investor delivery / awaiting-investor every 2 days. Each self-gates, so a steady morning tick
    // gives the intended cadence without a manager having to chase.
    await orderTrustpointOnce().catch((e) => console.error('[digests] order-trustpoint', e && e.message));
    await orderTrinityOnce().catch((e) => console.error('[digests] order-trinity', e && e.message));
    await investorPendingDeliveryOnce().catch((e) => console.error('[digests] investor-pending', e && e.message));
    await withInvestorOnce().catch((e) => console.error('[digests] with-investor', e && e.message));
    // The six stretches that had no reminder at all (owner-directed 2026-08-09). Each self-gates on
    // its own period, so a steady morning tick gives the intended cadence.
    await drawInspectionLateOnce().catch((e) => console.error('[digests] draw-inspection-late', e && e.message));
    await drawFindingsUnreviewedOnce().catch((e) => console.error('[digests] draw-findings-unreviewed', e && e.message));
    await drawApprovedUnrecordedOnce().catch((e) => console.error('[digests] draw-approved-unrecorded', e && e.message));
    await investorFeeOwedOnce().catch((e) => console.error('[digests] investor-fee-owed', e && e.message));
    await retainageReleasableOnce().catch((e) => console.error('[digests] retainage-releasable', e && e.message));
    await purchaseAdviceMissingOnce().catch((e) => console.error('[digests] purchase-advice-missing', e && e.message));
    await trainingRunOnce().catch((e) => console.error('[digests] training-run', e && e.message));
    await certificateSurveyOnce().catch((e) => console.error('[digests] cert-survey', e && e.message));
    await directSourceSweepOnce().catch((e) => console.error('[digests] direct-source-sweep', e && e.message));
    await autoReadSweepOnce().catch((e) => console.error('[digests] auto-read-sweep', e && e.message));
    await section1071SweepOnce().catch((e) => console.error('[digests] section-1071', e && e.message));
    await autoCommitteeReviewOnce().catch((e) => console.error('[digests] auto-committee', e && e.message));
    await aiCrossdocSweepOnce().catch((e) => console.error('[digests] ai-crossdoc-sweep', e && e.message));
    await qaDeskAuditOnce().catch((e) => console.error('[digests] qa-desk-audit', e && e.message));
    await conditionFreshnessReopenOnce().catch((e) => console.error('[digests] freshness-reopen', e && e.message));
    if (weekday === 'Mon') await weeklyAdminSummaryOnce().catch((e) => console.error('[digests] admin', e && e.message));
    if (weekday === 'Mon') await weeklyAdminAiQuestionsOnce().catch((e) => console.error('[digests] admin-ai-questions', e && e.message));
    if (weekday === 'Mon') await weeklyTopRiskyFilesOnce().catch((e) => console.error('[digests] admin-top-risky', e && e.message));
    if (weekday === 'Mon') await weeklyLoAiDigestOnce().catch((e) => console.error('[digests] lo-weekly-ai', e && e.message));
    // The loan officers' own weekly book snapshot (owner-directed 2026-08-07). Monday morning,
    // alongside the other weeklies; it self-gates on a 6-day window so a Monday that misses the
    // window (a deploy, an outage) still catches up on the Tuesday rather than skipping a week.
    if (weekday === 'Mon') await weeklyOfficerPipelineOnce().catch((e) => console.error('[digests] officer-pipeline-weekly', e && e.message));
  }
  if (hour >= 8 && hour < 18) {
    await weeklyBorrowerOutstandingOnce().catch((e) => console.error('[digests] borrower', e && e.message));
    await drawFindingsAwaitingBorrowerOnce().catch((e) => console.error('[digests] draw-findings', e && e.message));
    // The expiry sweep runs through the business day so a lapsed approval flips
    // within hours (the flip is once-per-row by construction — status change).
    await exceptionExpirySweepOnce().catch((e) => console.error('[digests] exception-expiry', e && e.message));
    // The closing-chain backstop runs through the business day so a date a
    // non-announcing door introduced reaches the attorney the same day — and never
    // at 3am. Its dedupe keys make every re-run a no-op.
    await closingChainCatchupOnce().catch((e) => console.error('[digests] closing-chain', e && e.message));
    // Take the finished deals off the Orders desk. Emails nobody — it is desk
    // hygiene — but it runs here because the sweep already holds the once-per-tick
    // cadence and re-running it is free (it only moves rows still in an active
    // state). Ordered AFTER the catch-up on purpose: the catch-up already ignores a
    // dead deal, and retiring first would make the ordering look load-bearing when
    // it is not.
    await require('./closing-prep').retireClosedOrdersOnce().catch((e) => console.error('[digests] closing-orders-retire', e && e.message));
    // The title/insurance half of the same hygiene: an order whose condition has
    // been signed off, or whose loan has funded, is finished. Nothing ever wrote
    // 'completed' for those two, so every deal we have ever closed sat on the desk
    // looking like outstanding work — which is how a queue stops being read.
    await require('./order-tracking').retireSatisfiedOrdersOnce().catch((e) => console.error('[digests] order-retire', e && e.message));
    /* Abandoned Elementix approvals. `sweepPending()` had ZERO callers, so a
       half-finished browser approval sat in the table forever — harmless until
       somebody debugging a connection reads a stale pending row as the current
       attempt. It is its own no-op when Elementix was never configured. */
    await require('../elementix/oauth').sweepPending().catch((e) => console.error('[digests] elementix-pending', e && e.message));
    // …and THEN chase what is genuinely still out. Ordered after the retires on
    // purpose: nudging somebody about an order the same tick is about to retire is
    // the noise this desk exists to remove.
    await orderOverdueOnce().catch((e) => console.error('[digests] order-overdue', e && e.message));
  }
}

/**
 * CLOSING-CHAIN BACKSTOP (owner-directed 2026-07-28).
 *
 * The three automatic closing-chain updates are fired from the doors that make each
 * fact true — the closing-date route, the workflow hand-off, the ClickUp inbound
 * sync, the status transition, the e-sign completion. This sweep catches whatever
 * those doors miss: `product-registration` can introduce a file's FIRST expected
 * closing date through a COALESCE (it is not a "closing date" route and has no
 * business announcing one), a door could fail mid-request after the UPDATE
 * committed, and a door added next year will not know about any of this.
 *
 * It is safe to run repeatedly precisely BECAUSE the announcement is claimed under a
 * dedupe key: a date already announced costs one refused insert. Bounded to files
 * that HAVE a closing chain, so it touches nothing on the rest of the book.
 */
async function closingChainCatchupOnce() {
  let sent = 0;
  try {
    const closingPrep = require('./closing-prep');
    const rows = (await db.query(
      // ALREADY-ANNOUNCED ROWS ARE EXCLUDED IN SQL, not by calling announce() and
      // letting the dedupe key refuse it. Each announce() costs ~8 round trips
      // (thread + file data + recipients + ensureThread + seq + the claim) BEFORE the
      // key is consulted, and this runs every 30 minutes over the whole book — so the
      // steady state was thousands of queries per tick to send nothing. The claim is
      // still the guarantee; this is just not asking it the same question all day.
      `SELECT ct.application_id,
              to_char(COALESCE(a.expected_closing, a.est_closing_date), 'YYYY-MM-DD') AS day,
              a.status,
              -- The date the chain was LAST told, compared to the date the file now
              -- holds. A plain "has this exact date ever been announced" test would
              -- stay silent when a date moves and then moves BACK, leaving the
              -- attorney holding the superseded day.
              (SELECT split_part(m.dedupe_key, '->', 2)
                 FROM closing_thread_messages m
                WHERE m.thread_id = ct.id AND m.event_kind = 'closing_date'
                  AND m.status IN ('sent','carried') AND m.dedupe_key IS NOT NULL
                ORDER BY m.sent_at DESC NULLS LAST, m.id DESC LIMIT 1)
                IS DISTINCT FROM to_char(COALESCE(a.expected_closing, a.est_closing_date), 'YYYY-MM-DD')
              AS needs_date,
              NOT EXISTS (
                SELECT 1 FROM closing_thread_messages m
                 WHERE m.thread_id = ct.id AND m.status IN ('sent','carried')
                   AND m.dedupe_key = 'clear_to_close'
              ) AS needs_ctc
         FROM closing_threads ct
         JOIN applications a ON a.id = ct.application_id AND a.deleted_at IS NULL
         -- ONLY A FILE WHOSE ORDER ACTUALLY WENT OUT.
         --
         -- sendOnThread opens the chain BEFORE it sends, so a closing-prep order
         -- that failed (provider down, nothing built) still leaves a closing_threads
         -- row behind — and cancelling an order deliberately keeps the chain intact.
         -- Without this join the sweep found those chains, fell back to the default
         -- attorney group inbox because no recipient had ever been recorded, and made
         -- FIRST CONTACT with the outside law firm by telling them the closing date
         -- had moved on a deal they had never heard of. The order row is the proof
         -- that a human deliberately engaged this attorney.
         JOIN file_orders fo ON fo.application_id = ct.application_id
                            AND fo.order_type = 'attorney'
                            AND fo.status NOT IN ('not_ordered','cancelled')
        -- AND THE DEAL MUST STILL BE LIVE. announce() refuses a funded / declined /
        -- withdrawn file outright, so selecting one here can only ever burn a slot
        -- under the cap on a question whose answer cannot change. Same list as the
        -- gate itself (closing-prep.DEAD_DEAL_SQL) so the two can never disagree.
        WHERE a.status NOT IN ${closingPrep.DEAD_DEAL_SQL}
          AND (COALESCE(a.expected_closing, a.est_closing_date) IS NOT NULL
               OR a.status = 'clear_to_close')
        -- ORDERED because it is CAPPED: the quietest chains come first, so a large
        -- book can never leave the same tail of files permanently unexamined. A chain
        -- that actually receives an update has its last_activity_at bumped and moves
        -- to the back on its own.
        -- …and it ends on the row's own id, so chains that TIE on both timestamps
        -- still come back in a stable order rather than an arbitrary one.
        ORDER BY ct.last_activity_at ASC NULLS FIRST, ct.created_at ASC, ct.id ASC
        LIMIT 500`)).rows;
    for (const r of rows) {
      if (r.day && r.needs_date) {
        const res = await closingPrep.announce({
          applicationId: r.application_id, eventKind: 'closing_date',
          dedupeKey: `closing_date:${r.day}`, extra: { date: r.day },
        }).catch(() => null);
        if (res && res.ok && !res.skipped) sent += 1;
      }
      if (r.status === 'clear_to_close' && r.needs_ctc) {
        const res = await closingPrep.announce({
          applicationId: r.application_id, eventKind: 'clear_to_close',
          dedupeKey: 'clear_to_close', extra: { closingDate: r.day || null },
        }).catch(() => null);
        if (res && res.ok && !res.skipped) sent += 1;
      }
    }
    // THE EXECUTED TERM SHEET needs its own recovery, because it is the one update
    // whose fact does not live on the applications row — it lives on the envelope,
    // so the loop above cannot see it. Without this, a provider blip at the exact
    // moment a term sheet finished signing left the attorney drafting from the
    // initial terms forever. Re-driven through the e-sign module's OWN announcer so
    // it attaches the document THAT envelope produced, never a second guess at it.
    const TERM_SHEET_RECOVERY_CAP = 50;
    const stale = (await db.query(
      `SELECT e.*
         FROM esign_envelopes e
         JOIN closing_threads ct ON ct.application_id = e.application_id
         JOIN applications a ON a.id = e.application_id AND a.deleted_at IS NULL
         JOIN file_orders fo ON fo.application_id = e.application_id
                            AND fo.order_type = 'attorney'
                            AND fo.status NOT IN ('not_ordered','cancelled')
        -- THE DEAL MUST STILL BE LIVE — this arm is where the starvation actually
        -- bit. announce() refuses a funded / declined / withdrawn file, so those
        -- envelopes could never gain a 'sent' row and never left this result set;
        -- ordered oldest-first under a LIMIT of 50, a handful of long-closed deals
        -- permanently crowded out the live file whose announcement had failed —
        -- which is the ONLY thing this query exists to recover.
        WHERE a.status NOT IN ${closingPrep.DEAD_DEAL_SQL}
          AND e.purpose = 'term_sheet_package' AND e.status = 'completed'
          AND COALESCE(e.is_test,false) = false
          -- KEYED ON THE ENVELOPE, matching the announcement's own dedupe key. Keyed
          -- on the thread instead, the first executed term sheet excluded the file
          -- forever — so a re-issued and re-executed package whose announcement
          -- failed could never be recovered, which is the one job of this sweep.
          AND NOT EXISTS (
            SELECT 1 FROM closing_thread_messages m
             WHERE m.thread_id = ct.id
               AND m.dedupe_key = 'executed_term_sheet:' || e.id::text
               AND m.status IN ('sent','carried'))
        ORDER BY e.completed_at ASC NULLS FIRST, e.id ASC
        LIMIT ${TERM_SHEET_RECOVERY_CAP}`)).rows;
    // NO SILENT CAPS. With the deal-live filter above, every row here is one a retry
    // can genuinely settle — so a full page means real backlog, not silt. Saying so
    // is what makes a future starvation visible instead of looking like calm.
    if (stale.length >= TERM_SHEET_RECOVERY_CAP) {
      console.warn(`[digests] executed-term-sheet recovery hit its cap of ${TERM_SHEET_RECOVERY_CAP} — more may be waiting; the next tick continues from the oldest.`);
    }
    for (const env of stale) {
      try {
        // Count what was actually sent — an unconditional bump made the log line
        // report recoveries that never happened.
        const res = await require('./esign/webhook').announceExecutedTermSheet(db, env);
        if (res && res.ok && !res.skipped) sent += 1;
      } catch (_) { /* next tick tries again */ }
    }
  } catch (_) { return 0; }
  if (sent) console.log(`[digests] closing-chain catch-up sent ${sent} update(s)`);
  return sent;
}

let started = false;
function start() {
  if (started) return;
  if (process.env.NOTIFY_DIGESTS_ENABLED === '0') { console.log('[digests] disabled (NOTIFY_DIGESTS_ENABLED=0)'); return; }
  started = true;
  // Boot pass shortly after startup, then every 30 minutes (unref so it never
  // holds the process open). The audit-gate keeps the real cadence daily/weekly.
  setTimeout(() => runDue().catch((e) => console.error('[digests] boot', e && e.message)), 90000);
  setInterval(() => runDue().catch((e) => console.error('[digests] tick', e && e.message)), 30 * 60 * 1000).unref();
  console.log('[digests] scheduled notification digests started');
}

module.exports = {
  start, runDue, nyParts,
  weeklyBorrowerOutstandingOnce, dailyPipelineDigestOnce, staleFileAlertsOnce, weeklyAdminSummaryOnce,
  drawFindingsAwaitingBorrowerOnce, drawReleaseOverdueOnce, trustpointUnreleasedOnce, workflowAgingOnce, conditionFreshnessReopenOnce,
  orderTrustpointOnce, orderTrinityOnce, investorPendingDeliveryOnce, withInvestorOnce,
  drawInspectionLateOnce, drawFindingsUnreviewedOnce,
  drawApprovedUnrecordedOnce, investorFeeOwedOnce, retainageReleasableOnce, purchaseAdviceMissingOnce,
  orderOverdueOnce,
  trainingRunOnce, certificateSurveyOnce, autoCommitteeReviewOnce, directSourceSweepOnce, autoReadSweepOnce, unfundedRereadSweepOnce, section1071SweepOnce,
  aiCrossdocSweepOnce, weeklyAdminAiQuestionsOnce, weeklyTopRiskyFilesOnce, weeklyLoAiDigestOnce,
  qaDeskAuditOnce, exceptionAgingOnce, exceptionExpirySweepOnce, closingChainCatchupOnce,
  weeklyOfficerPipelineOnce,
  backupFreshnessWatchOnce,
  // Exposed so a test can prove the sweeps and the screens that describe them read the SAME
  // threshold — the whole point of routing both through draw-settings.daysSettingFor.
  _internals: { settingDays },
};
