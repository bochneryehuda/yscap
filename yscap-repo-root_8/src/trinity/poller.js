'use strict';
/**
 * Trinity POLLER — the correctness machinery.
 *
 * Trinity's webhooks carry no signature and no shared secret, and their own docs
 * describe them as notifications that "only provide the IDs, event type, and a short
 * description". A delivery that never arrives is never noticed by the sender. So the
 * poll is not a backup for the webhook — it is the thing that is actually relied on,
 * and the webhook merely makes it prompt.
 *
 * Volume is tiny by construction: only OPEN orders are polled (a completed or cancelled
 * one is never asked about again), oldest-first, a small batch per tick. A file with no
 * live physical draw costs nothing.
 *
 * Nothing in this loop delivers anything to a borrower.
 */

const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const ingest = require('./ingest');

let _timer = null, _drain = null;

const OPEN_STATES = ['requested', 'ordered', 'scheduled', 'inspected'];
const BATCH = Math.max(1, parseInt(process.env.TRINITY_POLL_BATCH || '15', 10) || 15);

/** One sweep of the open orders. */
async function pollOnce() {
  if (!client.available() || !client.enabled()) return { skipped: 'off' };
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, application_id FROM trinity_inspection_orders
        WHERE trinity_order_id IS NOT NULL
          AND status = ANY($1::text[])
        ORDER BY polled_at NULLS FIRST, id
        LIMIT $2`, [OPEN_STATES, BATCH])).rows;
  } catch (e) {
    console.warn('[trinity] poll query failed:', e && e.message);
    return { error: e.message };
  }
  let synced = 0, failed = 0;
  for (const r of rows) {
    try { await ingest.syncOrder(r.application_id, r.id); synced++; }
    catch (e) { failed++; console.warn('[trinity] sync failed for order', r.id, e && e.message); }
  }
  return { synced, failed, considered: rows.length };
}

/**
 * Drain the webhook inbox. A delivery is only ever a NUDGE — nothing in the body is
 * believed. We resolve the order it names and then re-read everything from the
 * authenticated API, which is why a spoofed delivery can do nothing worse than make us
 * look at one of our own orders a little early.
 */
async function drainWebhooksOnce(limit = 50) {
  let rows;
  try {
    rows = (await db.query(
      `UPDATE trinity_webhook_events SET claimed_at = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM trinity_webhook_events
           WHERE processed_at IS NULL
             AND attempts < 4
             AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
           ORDER BY received_at LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING id, event, trinity_order_id`, [limit])).rows;
  } catch (e) { return { error: e.message }; }
  if (!rows.length) return { processed: 0 };

  let processed = 0, skipped = 0;
  for (const ev of rows) {
    try {
      if (!ev.trinity_order_id) { skipped++; await markDone(ev.id, 'no order id in the delivery'); continue; }
      const o = (await db.query(
        `SELECT id, application_id FROM trinity_inspection_orders WHERE trinity_order_id = $1`,
        [ev.trinity_order_id])).rows[0];
      // An order we do not know about is not ours to act on — the sweeps own discovery.
      if (!o) { skipped++; await markDone(ev.id, 'not one of our orders'); continue; }
      await ingest.syncOrder(o.application_id, o.id);
      await markDone(ev.id, null);
      processed++;
    } catch (e) {
      await db.query(`UPDATE trinity_webhook_events SET error=$2, claimed_at=NULL WHERE id=$1`,
        [ev.id, String(e && e.message).slice(0, 300)]).catch(() => {});
    }
  }
  return { processed, skipped };
}
async function markDone(id, note) {
  await db.query(`UPDATE trinity_webhook_events SET processed_at=now(), error=$2, claimed_at=NULL WHERE id=$1`,
    [id, note ? String(note).slice(0, 300) : null]).catch(() => {});
}

function start() {
  if (_timer) return;
  const sec = Math.max(60, (cfg.trinity && cfg.trinity.pollSec) || 600);
  const tick = async () => {
    try { await pollOnce(); } catch (e) { console.warn('[trinity] poll tick:', e && e.message); }
  };
  const drainTick = async () => {
    try { await drainWebhooksOnce(); } catch (e) { console.warn('[trinity] webhook drain:', e && e.message); }
  };
  _timer = setInterval(tick, sec * 1000);
  _drain = setInterval(drainTick, 30000);
  if (_timer.unref) _timer.unref();
  if (_drain.unref) _drain.unref();
  console.log(`[trinity] poller started (every ${sec}s; webhook drain every 30s)`);
}
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_drain) { clearInterval(_drain); _drain = null; }
}

module.exports = { start, stop, pollOnce, drainWebhooksOnce };
