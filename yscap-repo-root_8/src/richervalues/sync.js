'use strict';
/**
 * Richer Value — status intake, the finished report, and the poller.
 *
 * THEY PUSH AND WE POLL, and both roads lead here. Their webhook posts one small
 * event per change (`{order_type, intake_token, order_token, data:{action_type,
 * action}, datetime}`), which is fast but not guaranteed; the poller reads their
 * status + history endpoints on a timer and is the backstop for a delivery that
 * was lost, arrived while we were deploying, or was never registered because the
 * webhook half is not configured. Neither is allowed to be the only way a report
 * reaches the file — that is the failure mode where ordering works, everything
 * looks fine, and nothing ever comes back.
 *
 * SO EVERY STATE TRANSITION IS IDEMPOTENT AND ORDER-INDEPENDENT. A webhook and a
 * poll arriving in either order, twice, must leave the same row: statuses are
 * mapped not accumulated, the timeline dedupes on a hash of the event itself, the
 * report files itself by content hash, and the values are written through a
 * `values_applied_at` stamp so they are applied exactly once.
 *
 * THE ONE THING THAT IS NOT AUTOMATIC IS RE-WRITING A HUMAN'S NUMBER. When the
 * figures come back PILOT writes them onto the file (owner-directed 2026-08-14) —
 * but through the shared As-Is desk, which refuses on a frozen file and audits
 * what it did. If a person has since decided the As-Is by hand, or the file is
 * past the point where its numbers may move, the write is refused and the order
 * card says so with an "Apply to the file" button for a human to settle. A vendor
 * callback never quietly overrules a person.
 */

const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const switches = require('../lib/integrations/switches');
const client = require('./client');
const results = require('./results');
const documents = require('./documents');
const orderService = require('./order-service');

const RV = () => cfg.richerValue || {};

// ---------------------------------------------------------------------------
// THEIR VOCABULARY → OURS.
//
// Two vocabularies arrive: their status READ answers in Title Case words ("On
// Hold", "Property Analysis") while their WEBHOOK answers in snake_case
// ("property_analysis"). Both are normalized through the same table, keyed on a
// squashed form, so a new spelling of a status we already know needs no change —
// and a status we have NEVER seen maps to `null`, which leaves our own status
// alone rather than guessing it into something wrong.
// ---------------------------------------------------------------------------
const squash = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z]/g, '');

const REPORT_STATUS = {
  preorder: 'intake',
  orderpaymentcompleted: 'ordered',
  ordered: 'ordered',
  datareconciliation: 'in_process',
  propertyanalysis: 'in_process',
  analysisreview: 'in_review',
  review: 'in_review',
  finalization: 'in_review',
  completed: 'completed',
  reportdelivered: 'completed',
  delivered: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  onhold: 'on_hold',
  snagreleased: 'in_process',
  holdreleased: 'in_process',
  revision: 'revision',
  revisionrequested: 'revision',
  revisioncompleted: 'completed',
  newspecs: 'revision',
  marketupdate: 'revision',
  reporttypechanged: 'in_process',
  reporttransferred: 'cancelled',
  rovwithdrawn: 'completed',
};

/** Map one of their report words to ours, or null when we do not recognise it. */
function mapReportStatus(v) { return REPORT_STATUS[squash(v)] || null; }

/**
 * A status is only ever moved FORWARD by an event, with two exceptions that must
 * be able to move it back: a hold and a cancellation. Without this rule a webhook
 * that arrives out of order (they retry, and a retry of an older event is common)
 * would drag a completed order back to "in process" and re-fire everything that
 * hangs off completion.
 */
const RANK = {
  draft: 0, dryrun: 0, placing: 1, intake: 2, ordered: 3, in_process: 4,
  assigned: 4, inspected: 5, in_review: 6, revision: 6, product_available: 7, completed: 8,
};
const ALWAYS_APPLY = new Set(['on_hold', 'cancelled', 'rejected', 'error']);

function nextStatus(current, incoming) {
  if (!incoming) return current;
  if (ALWAYS_APPLY.has(incoming)) return incoming;
  // A cancelled or rejected order is terminal — nothing walks it back.
  if (current === 'cancelled' || current === 'rejected') return current;
  // A hold is left in place until something that is genuinely progress arrives.
  const a = RANK[current] == null ? 0 : RANK[current];
  const b = RANK[incoming] == null ? 0 : RANK[incoming];
  return b >= a ? incoming : current;
}

// ---------------------------------------------------------------------------
// The timeline. One row per distinct event, deduped on a hash of the event
// itself so a poll that re-reads the same history ten times records it once.
// ---------------------------------------------------------------------------
function timelineKey(e) {
  return crypto.createHash('sha1')
    .update([e.type || '', e.status || '', e.datetime || '', e.comment || ''].join('|'))
    .digest('hex');
}

async function recordTimeline(orderRow, history) {
  const rows = Array.isArray(history) ? history : [];
  for (const e of rows) {
    if (!e) continue;
    try {
      await db.query(
        `INSERT INTO rv_status_events (rv_order_row, application_id, event_type, status, comment, occurred_at, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (rv_order_row, dedupe_key) DO NOTHING`,
        [orderRow.id, orderRow.application_id, e.type || null, e.status || null,
          e.comment || null, e.datetime || null, timelineKey(e)]);
    } catch (_) { /* one unrecordable event must never stop the rest */ }
  }
}

// ---------------------------------------------------------------------------
// Syncing ONE order.
// ---------------------------------------------------------------------------
/**
 * Read everything their API can tell us about one order and settle the row.
 * Every step is independently caught: a report that will not download must not
 * stop the status from being recorded, and a status read that fails must not stop
 * a finished report from being filed on the next pass.
 *
 * @returns {Promise<{changed:boolean, status:string, filed?:boolean, valuesApplied?:boolean}>}
 */
async function syncOne(order, { staffId = null } = {}) {
  const out = { changed: false, status: order.status };
  if (!order.intake_token) return out;

  const patch = {};
  let status = order.status;

  // ---- status ------------------------------------------------------------
  try {
    const r = await client.orderStatus(order.intake_token, order.order_token);
    const d = (r && r.data) || {};
    const reportStatus = d.order && d.order.status;
    const inspection = d.inspection || {};
    if (reportStatus) {
      patch.vendor_status = String(reportStatus);
      status = nextStatus(status, mapReportStatus(reportStatus));
    }
    if (inspection.status) patch.vendor_inspection_status = String(inspection.status);
    if (inspection.scheduled_date) patch.inspection_scheduled_date = inspection.scheduled_date;
  } catch (e) {
    // Their "no order has been created for this intake token yet" is an ordinary
    // state for an unpaid intake, not an error worth carding.
    const msg = (e && e.message) || String(e);
    if (!/no order has been created/i.test(msg)) patch.last_error = msg.slice(0, 500);
  }

  // ---- timeline ----------------------------------------------------------
  try {
    const h = await client.orderHistory(order.intake_token, order.order_token);
    const list = (h && h.data && h.data.history) || [];
    await recordTimeline(order, list);
  } catch (_) { /* the timeline is a record, never the thing that fails a sync */ }

  // ---- the order token, once the intake has been paid --------------------
  if (!order.order_token) {
    try {
      const t = await client.orderTokens(order.intake_token);
      const tokens = (t && t.data && t.data.order_tokens) || [];
      if (tokens.length === 1 && tokens[0].order_token) {
        patch.order_token = tokens[0].order_token;
        order = { ...order, order_token: tokens[0].order_token };
        status = nextStatus(status, 'ordered');
      }
    } catch (_) { /* an unpaid intake simply has none yet */ }
  }

  // ---- the finished figures ---------------------------------------------
  // Asked for as soon as the status says the report is done. Their endpoint
  // answers "not completed yet" until then, which is an expected state.
  let read = null;
  if (order.order_token && (status === 'completed' || status === 'product_available')) {
    try {
      const r = await client.retrieveResponse(order.intake_token, order.order_token);
      read = results.readEnvelope(r, order.order_token);
      if (read) {
        patch.results = JSON.stringify((r && r.data) || {});
        patch.as_is_value = read.asIs;
        patch.arv = read.arv;
        patch.arv_basis = read.arvBasis;
        status = nextStatus(status, 'completed');
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (!/not completed yet/i.test(msg)) patch.last_error = msg.slice(0, 500);
    }
  }

  patch.last_polled_at = 'now()';
  if (status !== order.status) { patch.status = status; out.changed = true; }
  await applyPatch(order.id, patch);
  out.status = status;

  // ---- the report PDF ----------------------------------------------------
  // AFTER the status write, so a report that will not download cannot lose the
  // status we just learned.
  if (order.order_token && (status === 'completed' || status === 'product_available')) {
    const fresh = await orderService.getOrder(db, order.id);
    try {
      const filed = await documents.fileReport(db, fresh);
      out.filed = !!filed.filed;
    } catch (e) { console.error('[rv] filing the report failed (non-fatal):', (e && e.message) || e); }

    // ---- the values onto the loan file ----------------------------------
    if (read && read.valuesUsable && RV().autoApplyValues !== false && !fresh.values_applied_at) {
      try {
        const applied = await orderService.applyValues(db, { ...fresh, results: (await orderService.getOrder(db, order.id)).results }, { staffId });
        out.valuesApplied = !!applied.ok;
        if (!applied.ok) {
          // A refusal here is nearly always the file freeze or a human's own
          // decision, and both are correct outcomes — recorded so the desk can
          // show it with an "Apply to the file" button rather than silently
          // leaving the appraisal condition unable to clear.
          await db.query(`UPDATE rv_orders SET last_error=$2 WHERE id=$1`,
            [order.id, `The figures came back but PILOT did not put them on the file: ${applied.error}`]);
        }
      } catch (e) { console.error('[rv] applying the values failed (non-fatal):', (e && e.message) || e); }
    }
  }

  return out;
}

/** Apply a patch object where `now()` is a literal SQL expression. */
async function applyPatch(id, patch) {
  const sets = [];
  const vals = [id];
  for (const [k, v] of Object.entries(patch)) {
    if (v === 'now()') { sets.push(`${k}=now()`); continue; }
    vals.push(v);
    sets.push(`${k}=$${vals.length}${k === 'results' ? '::jsonb' : ''}`);
  }
  if (!sets.length) return;
  try { await db.query(`UPDATE rv_orders SET ${sets.join(', ')} WHERE id=$1`, vals); } catch (e) {
    console.error('[rv] could not update order', id, (e && e.message) || e);
  }
}

// ---------------------------------------------------------------------------
// The webhook inbox drain.
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 6;

/**
 * Turn ONE stored delivery into a state change. Their event carries the action
 * and nothing else — no status figures, no report — so it is a NUDGE: it moves
 * our status and then asks their API for the detail. That is deliberate; a push
 * we treat as authoritative is a push we cannot verify.
 */
async function processEvent(row) {
  const order = await findOrder(row);
  if (!order) {
    // A delivery for an order we have never heard of is kept, not dropped — that
    // is evidence (a test event, an order placed from their own screens) and it
    // is worth being able to look at later.
    await db.query(`UPDATE rv_order_events SET processed_at=now(), process_error='no matching order' WHERE id=$1`, [row.id]);
    return { matched: false };
  }

  await db.query(`UPDATE rv_order_events SET rv_order_row=$2, application_id=$3 WHERE id=$1`,
    [row.id, order.id, order.application_id]);

  const actionType = String(row.action_type || '');
  const action = String(row.action || '');
  const patch = { last_event_at: 'now()' };

  if (actionType === 'inspection') {
    patch.vendor_inspection_status = action || null;
  } else {
    const mapped = mapReportStatus(action);
    if (mapped) {
      const status = nextStatus(order.status, mapped);
      if (status !== order.status) patch.status = status;
    }
  }
  await applyPatch(order.id, patch);

  // Then go and ASK, so the row reflects what they actually hold rather than what
  // one event implied. `syncOne` is idempotent, which is what makes this safe to
  // run on every delivery.
  const fresh = await orderService.getOrder(db, order.id);
  await syncOne(fresh);

  await db.query(`UPDATE rv_order_events SET processed_at=now(), process_error=NULL WHERE id=$1`, [row.id]);
  return { matched: true, orderId: order.id };
}

/**
 * Find the order a delivery belongs to. Their order token is unique once it
 * exists; the intake token is the only join key before that. NEVER guessed — an
 * event carrying neither is left unmatched rather than applied to the newest
 * order on some file, which is exactly the shortcut the Class desk documents as
 * the one not to take.
 */
async function findOrder(row) {
  if (row.order_token) {
    const r = await db.query(`SELECT * FROM rv_orders WHERE order_token=$1`, [row.order_token]);
    if (r.rows[0]) return r.rows[0];
  }
  if (row.intake_token) {
    const r = await db.query(`SELECT * FROM rv_orders WHERE intake_token=$1`, [row.intake_token]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/**
 * Work through the unprocessed inbox. A failure BACKS OFF rather than retrying in
 * a tight loop, and after MAX_ATTEMPTS the delivery is marked dead — so one poison
 * event can never head-of-line-block everything behind it.
 */
async function drain({ limit = 25 } = {}) {
  if (!switches.on('RV_ENABLED')) return { processed: 0, skipped: 'disabled' };
  let processed = 0;
  let failed = 0;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT * FROM rv_order_events
        WHERE processed_at IS NULL AND dead_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY received_at ASC LIMIT $1`, [limit])).rows;
  } catch (_) { return { processed: 0, skipped: 'unreadable' }; }

  for (const row of rows) {
    try {
      await processEvent(row);
      processed += 1;
    } catch (e) {
      failed += 1;
      const attempts = (row.attempts || 0) + 1;
      const backoffMin = Math.min(60, 2 ** attempts);
      try {
        await db.query(
          `UPDATE rv_order_events
              SET attempts=$2, process_error=$3,
                  next_attempt_at = now() + ($4 || ' minutes')::interval,
                  dead_at = CASE WHEN $2 >= $5 THEN now() ELSE NULL END
            WHERE id=$1`,
          [row.id, attempts, String((e && e.message) || e).slice(0, 500), String(backoffMin), MAX_ATTEMPTS]);
      } catch (_) { /* best-effort */ }
    }
  }
  return { processed, failed };
}

// ---------------------------------------------------------------------------
// The poller.
// ---------------------------------------------------------------------------
const OPEN_STATUSES = ['placing', 'intake', 'ordered', 'in_process', 'assigned', 'inspected',
  'in_review', 'revision', 'product_available', 'on_hold', 'error'];

/**
 * One pass: drain anything they pushed, then re-read the orders still moving,
 * oldest-checked first. Bounded, self-gated on the master switch (read at CALL
 * time, so turning it back on resumes with no restart) and it never throws.
 */
async function pollOnce() {
  if (!switches.on('RV_ENABLED')) return { skipped: 'disabled' };
  const drained = await drain({ limit: 25 });

  let rows = [];
  try {
    rows = (await db.query(
      `SELECT * FROM rv_orders
        WHERE status = ANY($1::text[]) AND intake_token IS NOT NULL
        ORDER BY last_polled_at NULLS FIRST LIMIT $2`,
      [OPEN_STATUSES, RV().pollBatch || 25])).rows;
  } catch (_) { return { drained, polled: 0, skipped: 'unreadable' }; }

  let polled = 0;
  let changed = 0;
  for (const order of rows) {
    try {
      const r = await syncOne(order);
      polled += 1;
      if (r.changed) changed += 1;
    } catch (e) {
      console.error('[rv] sync failed for order', order.id, (e && e.message) || e);
      try { await db.query(`UPDATE rv_orders SET last_polled_at=now(), last_error=$2 WHERE id=$1`,
        [order.id, String((e && e.message) || e).slice(0, 500)]); } catch (_) { /* best-effort */ }
    }
  }
  return { drained, polled, changed };
}

let timer = null;
function start() {
  if (timer) return timer;
  const every = Math.max(60, RV().pollSec || 300) * 1000;
  timer = setInterval(() => {
    pollOnce().catch((e) => console.error('[rv] poll failed:', (e && e.message) || e));
  }, every);
  if (timer.unref) timer.unref();
  console.log(`[rv] Richer Value poller started (every ${Math.round(every / 1000)}s)`);
  return timer;
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  start, stop, pollOnce, syncOne, drain, processEvent, findOrder,
  mapReportStatus, nextStatus, recordTimeline,
  OPEN_STATUSES,
  _internals: { squash, timelineKey, applyPatch, RANK, REPORT_STATUS },
};
