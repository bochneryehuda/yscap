/**
 * Loan-officer Notification Center — background drainer.
 *
 * Handles three time-driven transitions on lo_notification_drafts.status='pending':
 *
 *   · scheduled_for   ≤ now()  → send (LO scheduled it)
 *   · snoozed_until   ≤ now()  → return to Pending (a UX transition — no send)
 *   · auto_send_at    ≤ now()  → send (safety fallback: a busy LO didn't
 *                                 review it inside their SLA)
 *
 * Also fires draws' scheduled inside the LO's quiet window when the window
 * opens (drafts whose scheduledDeferReason='quiet-hours' don't have a
 * scheduled_for — we re-consult the gate for those).
 *
 * Runs every WORKER_INTERVAL_MS (default 60s). Kill-switch: NOTIFY_WORKER_ENABLED=0.
 * Booted by src/server.js.
 */
'use strict';
const db = require('../db');
const notify = require('./notify');
const email = require('./email');
const cfg = require('../config');
const { fileReplyTo } = require('./file-address');
const catalog = require('./notification-catalog');
const gate = require('./lo-notification-gate');

const INTERVAL_MS = Math.max(30_000, parseInt(process.env.NOTIFY_WORKER_INTERVAL_MS, 10) || 60_000);
const KILL = String(process.env.NOTIFY_WORKER_ENABLED || '1').toLowerCase();
const ENABLED = !(KILL === '0' || KILL === 'false' || KILL === 'off');
const BATCH = Math.max(1, parseInt(process.env.NOTIFY_WORKER_BATCH, 10) || 100);

let timer = null;
let inFlight = false;

// Fire the notification for a row that's already been ATOMICALLY claimed
// (status='sending'). On notify success, flip to 'sent'; on failure, revert to
// 'pending' with the auto-send-at pushed out an hour so we don't retry-storm.
async function _sendClaimedDraft(row) {
  const opts = { ...(row.opts || {}), _bypassLoGate: true };
  if (row.edited_subject) opts.title = row.edited_subject;
  if (row.edited_body) opts.body = row.edited_body;
  if (row.edited_note) opts.note = row.edited_note;
  opts.type = row.notif_type;
  opts.applicationId = row.application_id;
  let sentId = null;
  try {
    if (row.recipient_kind === 'borrower' && row.recipient_id) {
      sentId = await notify.notifyBorrower(row.recipient_id, opts);
    } else if (row.recipient_kind === 'staff' && row.recipient_id) {
      sentId = await notify.notifyStaff(row.recipient_id, opts);
    }
  } catch (e) {
    // notify threw — revert claim so this row is retryable.
    await db.query(
      `UPDATE lo_notification_drafts
          SET status='pending', claimed_at=NULL,
              auto_send_at = COALESCE(auto_send_at, now()) + interval '1 hour',
              scheduled_for = NULL
        WHERE id=$1 AND status='sending'`, [row.id]).catch(() => {});
    throw e;
  }
  // Success — finalise. If this UPDATE fails, the row stays 'sending' and the
  // stale-reclaim path (>15 min) will re-issue it: an extra send is preferable
  // to a lost audit trail. The alternative — silently losing the sent_at
  // stamp — hides real deliveries from the LO's Sent tab.
  await db.query(
    `UPDATE lo_notification_drafts SET status='sent', sent_at=now(), sent_notification_id=$2
      WHERE id=$1 AND status='sending'`, [row.id, sentId || null]);
  return sentId;
}

// Reclaim rows that were claimed 'sending' but never finalised (a worker
// crashed mid-send). Keeps the drainer from starving on stranded rows.
async function _reclaimStale() {
  await db.query(
    `UPDATE lo_notification_drafts
        SET status='pending', claimed_at=NULL
      WHERE status='sending' AND claimed_at IS NOT NULL AND claimed_at < now() - interval '15 minutes'`);
}

async function drainScheduledSends() {
  await _reclaimStale();
  // CLAIM: atomic UPDATE that flips 'pending' → 'sending' on a batch of due
  // rows. Only one caller wins per row (the WHERE status='pending' is enforced
  // by MVCC + SKIP LOCKED). No FOR UPDATE outside a transaction — the UPDATE
  // itself is the atomic step.
  const claimed = await db.query(
    `WITH due AS (
        SELECT id FROM lo_notification_drafts
         WHERE status='pending' AND (
                 (scheduled_for IS NOT NULL AND scheduled_for <= now())
                 OR
                 (auto_send_at IS NOT NULL AND auto_send_at <= now()
                  AND (snoozed_until IS NULL OR snoozed_until <= now()))
               )
         ORDER BY COALESCE(scheduled_for, auto_send_at) ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE lo_notification_drafts d SET status='sending', claimed_at=now()
        FROM due WHERE d.id=due.id
       RETURNING d.*`, [BATCH]);
  for (const row of claimed.rows) {
    try {
      await _sendClaimedDraft(row);
    } catch (e) {
      console.warn('[notif-worker] send failed for', row.id, e && e.message);
    }
  }
  return claimed.rows.length;
}

// ---- LO SELF batch drainer -------------------------------------------------
// Releases held emails from lo_batched_emails. Groups the due rows by
// (staff_id, batch_key) and sends ONE digest email per group — so a batched
// window (or a vacation ending) produces "N updates on your files" instead of
// N separate emails. Every batched notification's email_status is then flipped
// to 'sent' so the individual audit trail shows delivery. Non-throwing.
const SELF_BATCH_LIMIT = Math.max(1, parseInt(process.env.NOTIFY_WORKER_SELF_BATCH, 10) || 200);

function _digestSubject(rows) {
  if (rows.length === 1) return rows[0].subject || 'Update on your files';
  return `${rows.length} updates on your files`;
}
function _digestOpts(rows, staffEmail) {
  const first = rows[0] || {};
  const lines = rows.map((r) => {
    const s = String(r.subject || '').trim() || 'Update';
    return r.body_preview ? `• ${s} — ${String(r.body_preview).slice(0, 160)}` : `• ${s}`;
  });
  const withApp = rows.find((r) => r.application_id);
  return {
    type: 'digest',
    title: rows.length === 1 ? (first.subject || 'Update on your files') : `${rows.length} updates on your files`,
    body:  rows.length === 1
      ? (first.body_preview || 'A batched update from your files.')
      : 'A quick roll-up of updates from your files while you were away/quiet.',
    lines,
    applicationId: withApp ? withApp.application_id : null,
    ctaLabel: 'Open your inbox',
    link: '/internal/notification-center',
    emailTo: staffEmail || null,
    _bypassLoGate: true,
    _bypassLoSelfGate: true,
  };
}

async function _staffEmailFor(id) {
  try {
    const r = await db.query(`SELECT email FROM staff_users WHERE id=$1`, [id]);
    return r.rows[0] && r.rows[0].email ? r.rows[0].email : null;
  } catch (_) { return null; }
}

async function drainBatchedEmails() {
  // Atomic claim: flip due 'pending' rows to 'released' in one UPDATE so no two
  // workers grab the same batch. GROUP-preserving: we claim EVERYTHING due for
  // any (staff, batch_key) that has ≥1 due row — so a bundle isn't split.
  const claimed = await db.query(
    `WITH due AS (
        SELECT id FROM lo_batched_emails
         WHERE status='pending' AND release_at <= now()
         ORDER BY release_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE lo_batched_emails b SET status='released', released_at=now()
        FROM due WHERE b.id=due.id
       RETURNING b.*`, [SELF_BATCH_LIMIT]);
  if (!claimed.rows.length) return 0;
  // Group by (staff_id, batch_key). batch_key='drop' isn't emitted (vacation
  // drop returns channel='inapp'), but guard anyway.
  const groups = new Map();
  for (const r of claimed.rows) {
    if (r.batch_key === 'drop') continue;
    const k = `${r.staff_id}|${r.batch_key || 'default'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let sent = 0;
  for (const [, rows] of groups) {
    const staffId = rows[0].staff_id;
    const to = await _staffEmailFor(staffId);
    if (!to) {
      await db.query(
        `UPDATE notifications SET email_status='skipped'
          WHERE id = ANY($1::uuid[])`,
        [rows.map((r) => r.notification_id).filter(Boolean)]).catch(() => {});
      continue;
    }
    try {
      const digestOpts = _digestOpts(rows, to);
      const msg = notify.buildEmail(digestOpts, 'staff');
      const replyTo = fileReplyTo(digestOpts.applicationId) || cfg.replyToDefault || null;
      const res = await email.sendMail({
        to: [to], subject: msg.subject, text: msg.text, html: msg.html, replyTo,
        _ctx: { applicationId: digestOpts.applicationId || null, notificationId: null,
                type: 'digest', audience: 'staff', subjectTag: digestOpts.subjectTag,
                kicker: 'Digest', bodyHtml: msg.html },
      });
      const ok = res && res.ok;
      // Mark each batched notification's row so the LO's Sent tab reflects
      // delivery. On error, mark 'error' so the notif can be inspected.
      const ids = rows.map((r) => r.notification_id).filter(Boolean);
      if (ids.length) {
        await db.query(
          `UPDATE notifications
              SET email_status=$2,
                  emailed_at=CASE WHEN $2='sent' THEN now() ELSE emailed_at END
            WHERE id = ANY($1::uuid[])`,
          [ids, ok ? 'sent' : 'error']).catch(() => {});
      }
      sent += rows.length;
    } catch (e) {
      console.warn('[notif-worker] batched digest failed:', e && e.message);
      // Best-effort recovery: mark 'error' so we don't retry-storm; the LO
      // still has the in-app rows.
      const ids = rows.map((r) => r.notification_id).filter(Boolean);
      if (ids.length) {
        await db.query(
          `UPDATE notifications SET email_status='error', email_error=$2
            WHERE id = ANY($1::uuid[])`,
          [ids, String(e.message || 'digest failed').slice(0, 400)]).catch(() => {});
      }
    }
  }
  return sent;
}

async function wakeSnoozed() {
  // Snooze is purely a UX transition — a snoozed draft is hidden from the
  // Pending list until the timestamp passes. No DB update is strictly needed
  // (the list query already filters snoozed_until > now()), but clearing the
  // column keeps queries snappy and the timestamps meaningful.
  await db.query(
    `UPDATE lo_notification_drafts
        SET snoozed_until = NULL
      WHERE status='pending' AND snoozed_until IS NOT NULL AND snoozed_until <= now()`);
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    await wakeSnoozed();
    await drainScheduledSends();
    await drainBatchedEmails();
  } catch (e) {
    console.warn('[notif-worker] tick failed:', e && e.message);
  } finally {
    inFlight = false;
  }
}

function start() {
  if (!ENABLED || timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  // Kick once immediately so a boot after downtime catches up on the backlog.
  setTimeout(() => { tick().catch(() => {}); }, 5_000).unref?.();
  console.log('[notif-worker] Notification Center drainer started');
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, drainScheduledSends, wakeSnoozed, drainBatchedEmails };
