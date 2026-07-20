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
const { outstandingItems } = require('./reminders');

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
// nothing with this (action, entity) was stamped inside the window, in a single
// INSERT…WHERE NOT EXISTS…RETURNING. Returns true only for the ONE caller that
// won the claim; a concurrent/overlapping pass or a second instance loses and
// returns false. (The old shape SELECTed then stamped AFTER sending, so two
// overlapping passes could both pass the check and both send — owner-reported
// duplicate sweep 2026-07-20.) entityId null = a global (non-file-scoped) digest.
async function _gate(action, entityId, interval) {
  try {
    const q = entityId
      ? await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           SELECT 'system', NULL, $1, 'application', $2, '{}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action=$1 AND entity_id=$2 AND created_at > now() - $3::interval)
           RETURNING id`, [action, entityId, interval])
      : await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           SELECT 'system', NULL, $1, 'application', NULL, '{}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action=$1 AND entity_id IS NULL AND created_at > now() - $2::interval)
           RETURNING id`, [action, interval]);
    return !!q.rows[0];   // won the claim (row stamped) → OK to send
  } catch (_) { return false; }   // on any DB error, DON'T send (fail closed)
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

/* 5) Draw result awaiting the borrower — a delivered inspection result the borrower hasn't accepted or
   disputed is HOLDING THEIR MONEY (the release clock only starts on accept), so nudge them if it's sat a
   few days. Borrower-safe (notifyAppBorrowers scrubs); per file, ≤ once / 2 days. draw_findings exist only
   for PILOT-managed files (delivered via the created-only reconcile), so this is go-forward-only by data.
   The EXISTS on an ACTIVE created link both re-asserts go-forward-only at the query level and honors CLAUDE.md
   Sitewire rule 10 — a finished/paid-off project is excluded, so a leftover finding on a closed loan never nudges. */
async function drawFindingsAwaitingBorrowerOnce() {
  let sent = 0;
  // NaN-safe: a non-numeric DRAW_FINDINGS_REMINDER_DAYS must fall back to the default, not become 'NaN'
  // (which would make ('NaN'||' days')::interval throw and silently disable the nudge).
  const wd = Number(process.env.DRAW_FINDINGS_REMINDER_DAYS || 3);
  const waitDays = Number.isFinite(wd) ? Math.max(1, wd) : 3;
  const rows = (await db.query(
    `SELECT f.application_id, count(*)::int AS n, min(f.delivered_at) AS oldest
       FROM draw_findings f
       JOIN applications a ON a.id=f.application_id AND a.deleted_at IS NULL AND a.status NOT IN ('withdrawn','declined','on_hold')
      WHERE f.status='delivered' AND f.delivered_at IS NOT NULL
        AND f.delivered_at < now() - ($1 || ' days')::interval
        AND EXISTS (SELECT 1 FROM sitewire_property_links pl WHERE pl.application_id=f.application_id
                      AND pl.matched_by='created' AND COALESCE(pl.lifecycle_state,'active')='active')
      GROUP BY f.application_id
      LIMIT 300`, [String(waitDays)])).rows;
  for (const r of rows) {
    try {
      if (!(await _gate('draw_findings_reminder', r.application_id, '2 days'))) continue;
      const d = daysAt(r.oldest);
      await notify.notifyAppBorrowers(r.application_id, {
        type: 'draw_findings',
        title: r.n === 1 ? 'Your draw inspection result is waiting for you' : `${r.n} draw inspection results are waiting for you`,
        badge: { text: 'Action needed', tone: 'action' },
        body: `Your inspection result${r.n === 1 ? ' has' : 's have'} been ready for ${d} day${d === 1 ? '' : 's'}. Your draw is released once you review and accept ${r.n === 1 ? 'it' : 'them'} — please take a moment to review ${r.n === 1 ? 'it' : 'them'} (or dispute a line) in your portal.`,
        callout: { title: 'Why this matters', body: 'The release clock for your draw only starts once you accept — reviewing promptly gets your money to you sooner.', tone: 'action' },
        applicationId: r.application_id, link: `/app/${r.application_id}`, ctaLabel: 'Review your draw' });
      await _stamp('draw_findings_reminder', r.application_id, { awaiting: r.n, days: d });
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

/* Time-gated dispatcher — morning window for staff/admin, business hours for the
   borrower digest; each function's own audit-gate enforces the true frequency. */
async function runDue() {
  const { hour, weekday } = nyParts();
  if (hour >= 7 && hour < 11) {
    await dailyPipelineDigestOnce().catch((e) => console.error('[digests] pipeline', e && e.message));
    await staleFileAlertsOnce().catch((e) => console.error('[digests] stale', e && e.message));
    await drawReleaseOverdueOnce().catch((e) => console.error('[digests] draw-release', e && e.message));
    if (weekday === 'Mon') await weeklyAdminSummaryOnce().catch((e) => console.error('[digests] admin', e && e.message));
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
  drawFindingsAwaitingBorrowerOnce, drawReleaseOverdueOnce,
};
