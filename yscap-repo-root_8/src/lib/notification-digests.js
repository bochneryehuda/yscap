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
const workflow = require('./workflow');
const { outstandingItems } = require('./reminders');
const { claimOncePerPeriod } = require('./throttle-claim');

const STATUS_LABEL = {
  file_intake: 'File intake', new: 'Submitted', in_review: 'In review', processing: 'Processing',
  underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close',
  funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn',
};
const TERMINAL = ['funded', 'declined', 'withdrawn'];

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
  return (await claimOncePerPeriod({ action, entityId: entityId || null, interval })) != null;
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
  const apps = await db.query(
    `SELECT id FROM applications
      WHERE deleted_at IS NULL AND borrower_id IS NOT NULL
        AND status <> ALL($1) LIMIT 500`, [TERMINAL]);
  for (const a of apps.rows) {
    try {
      // Compute content FIRST, then claim the gate — otherwise a file with zero
      // open items today would burn the 6-day throttle and get NO digest for the
      // rest of the window once it gains an item (owner-reported audit 2026-07-20).
      const items = await outstandingItems(a.id);
      if (!items.length) continue;
      if (!(await _gate('borrower_outstanding_digest', a.id, '6 days'))) continue;
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
      await _stamp('borrower_outstanding_digest', a.id, { open: items.length });
      sent++;
    } catch (e) { console.error('[digest] borrower-outstanding', a.id, e && e.message); }
  }
  return sent;
}

/* 2) Daily pipeline digest — per active loan officer / processor. */
async function dailyPipelineDigestOnce() {
  let sent = 0;
  const staff = await db.query(
    `SELECT DISTINCT s.id, s.email, s.full_name
       FROM staff_users s
       JOIN application_assignees aa ON aa.staff_id=s.id AND aa.removed_at IS NULL
       JOIN applications a ON a.id=aa.application_id AND a.deleted_at IS NULL
      WHERE s.is_active=true AND COALESCE(s.notifications_enabled,true)=true
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
          ORDER BY a.status_changed_at ASC NULLS FIRST
          LIMIT 40`, [st.id, TERMINAL]);
      if (!files.rows.length) continue;
      // Claim the once-per-day gate only once we know there's content to send
      // (don't burn the window on an empty pass).
      if (!(await _gate('pipeline_digest_daily', st.id, '20 hours'))) continue;
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

/* 3) Stale-file alerts — the assigned team is nudged when a file hasn't moved. */
async function staleFileAlertsOnce() {
  let sent = 0;
  const staleDays = Math.max(1, Number(process.env.STALE_FILE_DAYS || 10));
  const files = await db.query(
    `SELECT a.id, a.status, a.status_changed_at
       FROM applications a
      WHERE a.deleted_at IS NULL AND a.status <> ALL($1) AND a.status <> 'file_intake'
        AND a.status_changed_at IS NOT NULL
        AND a.status_changed_at < now() - ($2 || ' days')::interval
        AND EXISTS (SELECT 1 FROM application_assignees aa WHERE aa.application_id=a.id AND aa.removed_at IS NULL)
      LIMIT 200`, [TERMINAL, String(staleDays)]);
  for (const f of files.rows) {
    try {
      if (!(await _gate('stale_file_alert', f.id, '3 days'))) continue;
      const d = daysAt(f.status_changed_at);
      await notify.notifyAppStaff(f.id, {
        type: 'digest',
        title: `File stalled: ${d} days at "${STATUS_LABEL[f.status] || f.status}"`,
        badge: { text: 'Needs attention', tone: 'action' },
        body: `This file hasn’t changed stages in ${d} days. A quick check-in may be needed to keep it on track — the file details are below.`,
        applicationId: f.id, link: `/internal/app/${f.id}`, ctaLabel: 'Open the loan file' });
      await _stamp('stale_file_alert', f.id, { days: d, status: f.status });
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
        ORDER BY q.asked_at ASC
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
  const rows = (await db.query(
    `SELECT f.application_id, count(*)::int AS n, min(f.delivered_at) AS oldest
       FROM draw_findings f
       JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE f.status='delivered' AND f.delivered_at IS NOT NULL
        AND f.delivered_at < now() - ($1 || ' hours')::interval
        AND EXISTS (SELECT 1 FROM sitewire_property_links pl WHERE pl.application_id=f.application_id
                      AND pl.matched_by='created' AND COALESCE(pl.lifecycle_state,'active')='active')
      GROUP BY f.application_id
      LIMIT 300`, [String(waitHours)])).rows;
  for (const r of rows) {
    try {
      // At most one nudge per `waitHours` per file (the atomic gate), so within the
      // business-hours window the borrower is reminded every few hours until they act.
      if (!(await _gate('draw_findings_reminder', r.application_id, `${waitHours} hours`))) continue;
      await notify.notifyAppBorrowers(r.application_id, {
        type: 'draw_findings',
        title: r.n === 1 ? 'Your draw inspection result is waiting for you' : `${r.n} draw inspection results are waiting for you`,
        badge: { text: 'Action needed', tone: 'action' },
        body: `Your inspection result${r.n === 1 ? ' is' : 's are'} ready and waiting for you. Your draw is released once you review and accept ${r.n === 1 ? 'it' : 'them'} — please take a moment to review ${r.n === 1 ? 'it' : 'them'} (or dispute a line) in your portal.`,
        callout: { title: 'Why this matters', body: 'The release clock for your draw only starts once you accept — reviewing promptly gets your money to you sooner.', tone: 'action' },
        applicationId: r.application_id, link: `/app/${r.application_id}`, ctaLabel: 'Review your draw' });
      await _stamp('draw_findings_reminder', r.application_id, { awaiting: r.n, hours: waitHours });
      sent++;
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
async function drawReleaseOverdueOnce() {
  let sent = 0;
  const rows = (await db.query(
    `SELECT f.application_id, count(*)::int AS n, min(f.wire_due_at) AS due
       FROM draw_findings f
       JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE f.status='accepted' AND f.wire_due_at IS NOT NULL AND f.wire_due_at < now()
        AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd
                          WHERE dd.funded_status='released' AND dd.kind='draw'
                            AND dd.sitewire_draw_id = f.sitewire_draw_id)
        AND EXISTS (SELECT 1 FROM sitewire_property_links pl WHERE pl.application_id=f.application_id
                      AND pl.matched_by='created' AND COALESCE(pl.lifecycle_state,'active')='active')
      GROUP BY f.application_id
      LIMIT 300`)).rows;
  for (const r of rows) {
    try {
      if (!(await _gate('draw_release_overdue', r.application_id, '2 days'))) continue;
      const d = daysAt(r.due);
      await notify.notifyAppStaff(r.application_id, {
        type: 'draw',
        title: r.n === 1 ? 'Draw release overdue' : `${r.n} draw releases overdue`,
        badge: { text: 'Overdue', tone: 'action' },
        body: `The borrower accepted ${r.n === 1 ? 'a draw' : `${r.n} draws`} and the release ${d != null && d > 0 ? `is ${d} day${d === 1 ? '' : 's'} past the target` : 'is now due'}, but no release has been recorded in PILOT yet. Please confirm the wire and record the release.`,
        applicationId: r.application_id, link: `/internal/app/${r.application_id}/draws`, ctaLabel: 'Open the draw desk' });
      await _stamp('draw_release_overdue', r.application_id, { overdue: r.n, days: d });
      sent++;
    } catch (e) { console.error('[digest] draw-release-overdue', r.application_id, e && e.message); }
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
      if (!r.to_staff_id || !(await _gate('workflow_overdue', r.to_staff_id, '20 hours'))) continue;
      await notify.notifyStaff(r.to_staff_id, {
        type: 'workflow_ready',
        title: r.overdue === 1 ? 'A file in your Workflow is overdue' : `${r.overdue} files in your Workflow are overdue`,
        badge: { text: 'Overdue', tone: 'action' },
        body: `You have ${r.overdue} file${r.overdue === 1 ? '' : 's'} in your Workflow past ${r.overdue === 1 ? 'its' : 'their'} target time. Open your Workflow to pick ${r.overdue === 1 ? 'it' : 'them'} up or send ${r.overdue === 1 ? 'it' : 'them'} back.`,
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
        ORDER BY updated_at DESC`);
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
      `SELECT DISTINCT a.id
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
      `SELECT id FROM applications
        WHERE deleted_at IS NULL AND status NOT IN ('withdrawn','cancelled','funded','declined')
          AND status IS DISTINCT FROM 'file_intake'
        ORDER BY updated_at DESC
        LIMIT $1`, [BATCH]);
    for (const row of targets.rows) {
      try {
        const client = await db.getClient();
        try {
          await client.query('BEGIN');
          const r = await hub.verifyFile(client, row.id, {});
          await client.query('COMMIT');
          files += 1;
          calls += (r && r.results ? r.results.filter((x) => x.ok || x.reason).length : 0);
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        finally { client.release(); }
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
        ORDER BY df.created_at DESC
        LIMIT $1`, [BATCH_LIMIT]);
    for (const f of q.rows) {
      try {
        const context = {
          borrowerName: [f.first_name, f.last_name].filter(Boolean).join(' ') || null,
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
        ORDER BY a.updated_at DESC
        LIMIT $1`, [BATCH]);
    for (const row of q.rows) {
      const c = await db.getClient();
      try {
        await c.query('BEGIN');
        const exts = await c.query(
          `SELECT doc_type, document_id, fields FROM document_extractions
            WHERE application_id=$1 AND status='ok' ORDER BY created_at DESC LIMIT 40`, [row.id]);
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
async function runDue() {
  const { hour, weekday } = nyParts();
  if (hour >= 7 && hour < 11) {
    await dailyPipelineDigestOnce().catch((e) => console.error('[digests] pipeline', e && e.message));
    await staleFileAlertsOnce().catch((e) => console.error('[digests] stale', e && e.message));
    await workflowAgingOnce().catch((e) => console.error('[digests] workflow-aging', e && e.message));
    await drawReleaseOverdueOnce().catch((e) => console.error('[digests] draw-release', e && e.message));
    await trainingRunOnce().catch((e) => console.error('[digests] training-run', e && e.message));
    await certificateSurveyOnce().catch((e) => console.error('[digests] cert-survey', e && e.message));
    await directSourceSweepOnce().catch((e) => console.error('[digests] direct-source-sweep', e && e.message));
    await autoReadSweepOnce().catch((e) => console.error('[digests] auto-read-sweep', e && e.message));
    await section1071SweepOnce().catch((e) => console.error('[digests] section-1071', e && e.message));
    await autoCommitteeReviewOnce().catch((e) => console.error('[digests] auto-committee', e && e.message));
    await aiCrossdocSweepOnce().catch((e) => console.error('[digests] ai-crossdoc-sweep', e && e.message));
    if (weekday === 'Mon') await weeklyAdminSummaryOnce().catch((e) => console.error('[digests] admin', e && e.message));
    if (weekday === 'Mon') await weeklyAdminAiQuestionsOnce().catch((e) => console.error('[digests] admin-ai-questions', e && e.message));
  }
  if (hour >= 8 && hour < 18) {
    await weeklyBorrowerOutstandingOnce().catch((e) => console.error('[digests] borrower', e && e.message));
    await drawFindingsAwaitingBorrowerOnce().catch((e) => console.error('[digests] draw-findings', e && e.message));
  }
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
  drawFindingsAwaitingBorrowerOnce, drawReleaseOverdueOnce, workflowAgingOnce,
  trainingRunOnce, certificateSurveyOnce, autoCommitteeReviewOnce, directSourceSweepOnce, autoReadSweepOnce, section1071SweepOnce,
  aiCrossdocSweepOnce, weeklyAdminAiQuestionsOnce,
};
