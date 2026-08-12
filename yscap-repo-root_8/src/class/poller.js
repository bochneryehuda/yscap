'use strict';
/**
 * Class Valuation — the callback-inbox BACKSTOP, plus an order-poll fallback.
 *
 * Class PUSHES (routes/class-webhook.js), so the receiver drains the inbox the moment
 * a delivery lands. Two things this covers that the push alone does not:
 *
 *  1. A delivery that was STORED but whose processing failed — re-run our own
 *     unprocessed rows so a quiet file is not stuck until the next callback (which may
 *     never come). This is `drain()` + the attachment `sweepPendingOnce()`.
 *
 *  2. A REPLY or a finished REPORT that never arrived because the webhook was not
 *     registered, or a delivery was lost. Owner-directed (2026-08-12): "the check for
 *     replies should automatically check for replies if it doesn't work with webhooks …
 *     it also needs to make sure that it checks if the report came in, updates the
 *     status, inspects it." So `pollOpenOrdersOnce()` walks the OPEN orders and pulls
 *     their notes + attachments straight from Class. This SUPERSEDES the old "we never
 *     poll Class" note — it is a deliberate backstop, not the primary path.
 *
 * WHY IT IS SAFE TO RUN ALONGSIDE THE WEBHOOK (the "competing source of truth" worry):
 * every pull is IDEMPOTENT. Notes dedupe on the Class note id; the report download
 * dedupes on the attachment (document_id-set + sha) under a per-order advisory lock;
 * and completion is gated on the report actually being ingested, the same rule the
 * NAN sync uses. So a poll and a webhook landing on the same order can only ever agree.
 *
 * Deliberately small, self-gated (reads the switch at CALL time), bounded, never throws.
 */

const db = require('../db');
const switches = require('../lib/integrations/switches');

const EVERY_MS = Number(process.env.CLASS_DRAIN_SEC || 300) * 1000;
let timer = null;

async function tick() {
  // Read the switch at CALL time, not at boot — an admin flipping it on must not
  // require a redeploy (the repo's standing rule for every integration switch).
  if (!switches.on('CLASS_ENABLED')) return;
  try {
    const out = await require('./callbacks').drain({ limit: 100 });
    if (out && (out.processed || out.failed)) {
      console.log(`[class] callback drain: ${out.processed} processed, ${out.failed} failed`);
    }
  } catch (e) {
    console.warn('[class] callback drain tick failed:', e && e.message);
  }
  // Backstop the document fetch: an attachment announced but never downloaded (the
  // fetch failed, or the callback arrived before their order id had been written back)
  // is re-attempted here. Same reason the drain exists — a quiet file may otherwise
  // never see another callback. Bounded and never throws.
  try {
    const sw = await require('./documents').sweepPendingOnce();
    if (sw && sw.swept) console.log(`[class] attachment sweep: ${sw.swept} order(s)`);
  } catch (e) {
    console.warn('[class] attachment sweep tick failed:', e && e.message);
  }
  // The order-poll fallback (owner-directed) — replies + report + status, without a
  // webhook. Off-switchable on its own so the callback drain can stay on without it.
  if (process.env.CLASS_POLL_DISABLED === '1') return;
  try {
    const out = await pollOpenOrdersOnce();
    if (out && (out.replies || out.reports)) {
      console.log(`[class] order poll: ${out.replies} new repl${out.replies === 1 ? 'y' : 'ies'}, ${out.reports} report(s) in, across ${out.polled} open order(s)`);
    }
  } catch (e) {
    console.warn('[class] order poll tick failed:', e && e.message);
  }
}

/**
 * Walk the OPEN Class orders and pull, straight from Class, the two things a lost
 * webhook would otherwise strand: their replies, and the finished report. Idempotent
 * (see the header), bounded, never throws.
 */
async function pollOpenOrdersOnce() {
  if (!switches.on('CLASS_ENABLED')) return { polled: 0, skipped: 'disabled' };
  const client = require('./client');
  if (client.configured && !client.configured().enabled) return { polled: 0, skipped: 'disabled' };
  const messages = require('./messages');
  const documents = require('./documents');
  const batch = Math.max(1, Math.min(100, Number(process.env.CLASS_POLL_BATCH || 25)));

  let orders = [];
  try {
    // A live order is one Class has numbered (so there is something to ask about) that
    // has not reached a resting end state. Oldest-touched first, so a stalled order is
    // never starved by busier ones. A completed/cancelled order is terminal — leave it.
    orders = (await db.query(
      `SELECT * FROM class_orders
        WHERE class_order_id IS NOT NULL
          AND status NOT IN ('completed', 'cancelled')
        ORDER BY COALESCE(last_event_at, placed_at, created_at) ASC
        LIMIT $1`, [batch])).rows;
  } catch (e) {
    console.warn('[class] open-order poll query failed:', e && e.message);
    return { polled: 0 };
  }

  let replies = 0, reports = 0;
  for (const order of orders) {
    // 1. Their side of the thread — replies without waiting on a webhook. syncNotes
    //    dedupes on the Class note id, so a note we already have is left untouched.
    try {
      const n = await messages.syncNotes(order.id);
      if (n && n.added) replies += n.added;
    } catch (e) { console.warn('[class] note poll failed for order', order.id, (e && e.message) || e); }

    // 2. The finished report — list + download + parse (idempotent under a per-order
    //    lock). If it came in AND parsed, the order is DONE: mark it completed, exactly
    //    as the webhook StatusChanged→completed path does. Completion is gated on the
    //    report actually being ingested (the same rule the NAN sync uses), so the
    //    "Ask for a fix" control only opens once the appraisal is genuinely in.
    try {
      const ing = await documents.ingestForOrder(db, order);
      if (ing && ing.imported) {
        reports += 1;
        await db.query(
          `UPDATE class_orders SET status = 'completed', last_event_at = now(), updated_at = now()
            WHERE id = $1 AND status <> 'completed'`, [order.id]).catch(() => {});
      }
    } catch (e) { console.warn('[class] report poll failed for order', order.id, (e && e.message) || e); }
  }
  return { polled: orders.length, replies, reports };
}

function start() {
  if (timer) return;
  if (process.env.CLASS_DRAIN_DISABLED === '1') return;
  timer = setInterval(() => { tick().catch(() => {}); }, Math.max(60000, EVERY_MS));
  if (timer.unref) timer.unref();   // never hold the process open
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, pollOpenOrdersOnce };
