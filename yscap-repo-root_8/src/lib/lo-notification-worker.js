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

module.exports = { start, stop, tick, drainScheduledSends, wakeSnoozed };
