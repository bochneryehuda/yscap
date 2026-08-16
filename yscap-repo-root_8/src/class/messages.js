'use strict';
/**
 * Class Valuation — talking to them about a live order.
 *
 * Four things a desk does after an order is placed, and they are genuinely four
 * different things at Class even though three share a shape:
 *
 *   note()            a message on the order. Two-way; their reply arrives on the
 *                     NewNotes callback or on a read of their list.
 *   requestRevision() "please fix this on the report", against their closed reason list.
 *   requestRov()      a reconsideration of value. THE SAME ENDPOINT as a revision —
 *                     Class has no ROV call — distinguished by using value-related
 *                     reason codes and by carrying the comparables we are putting
 *                     forward. See revision-reasons.js.
 *   requestCancel()   stop the order. Same reason vocabulary, different endpoint.
 *
 * ── VERSIONS: THE OPPOSITE OF THE ORDERING PATH, AND WORTH SAYING OUT LOUD ──────
 *
 * Placing and reading an order are version-specific (`/orders` vs `/v2/orders`).
 * NONE of the calls in this file are: the guide documents exactly one path for
 * notes, revisions, GSE revisions and cancellations, shared by both UAD versions.
 * So these deliberately do NOT take a version and do NOT consult the order's
 * `api_version` — threading one through would imply a choice that does not exist,
 * and the first person to "fix" it would go looking for a `/v2/notes` that Class
 * never published.
 *
 * What every call here DOES need is the order's `class_order_id`, which only exists
 * once Class has accepted the order. Asking before then is refused with a reason a
 * human can act on, not a 404 from the vendor.
 *
 * WRITE-GATED. All four are writes: they reach Class and change a live order. Each
 * goes through the client's own outbound gate, so a dry run builds and logs the body
 * and sends nothing, exactly as placing an order does.
 */

const db = require('../db');
const client = require('./client');
const reasons = require('./revision-reasons');
const orderBuild = require('./order-build');

const text = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };

// A send failure is a DELIVERY problem, not a lost row — the message/request is
// already written. This shapes the failure the SAME way the order-PLACE path does
// (routes/class.js): our own reason on `detail`, the vendor's own raw body on
// `vendor`. The screen renders both through the very same OrderFailure component it
// uses for a failed order, so a staffer sees the EXACT reason Class gave (e.g. "The
// County field is required.") instead of a bare `request_failed` — the whole point
// of the owner's ask, "not in the dark". `describeOrderError` is what we STORE on the
// row (our message + the meaningful vendor text, capped 500), so the file screen's
// own "why it didn't go through" line carries the reason too.
function sendFailure(e, code, rowId) {
  return {
    ok: false,
    error: (e && e.code) || code,
    id: rowId,
    detail: (e && e.message) || String(e),
    vendor: (e && e.body) || null,
    // kept so an older screen build that reads out.message still shows the reason.
    message: (e && e.message) || String(e),
  };
}

/** Load an order row and say plainly why it cannot be talked to, if it cannot. */
async function loadOrder(dbc, orderRowId) {
  const q = dbc || db;
  const r = await q.query('SELECT * FROM class_orders WHERE id = $1', [orderRowId]);
  const order = r.rows[0];
  if (!order) return { error: 'not_found', message: 'That Class order is not on this file.' };
  if (!order.class_order_id) {
    return { error: 'not_accepted_yet',
      message: 'Class has not given this order a number yet, so there is nothing to attach a message to. Try again once the order is accepted.' };
  }
  return { order };
}

/**
 * Post a note to Class and record it. The row is written FIRST, in the direction
 * that says we wrote it, so a message a human typed is never lost because the send
 * failed — it sits there with the error on it and can be retried.
 */
async function note(orderRowId, content, { staffId } = {}) {
  const body = text(content);
  if (!body) return { ok: false, error: 'empty', message: 'Type a message first.' };
  const { order, error, message } = await loadOrder(null, orderRowId);
  if (error) return { ok: false, error, message };

  const ins = await db.query(
    `INSERT INTO class_notes (class_order_row, application_id, direction, content, author_staff_id)
     VALUES ($1,$2,'FromClient',$3,$4) RETURNING id`,
    [order.id, order.application_id, body, staffId || null]);
  const rowId = ins.rows[0].id;

  try {
    const out = await client.addNote(order.class_order_id, { content: body });
    if (out && out.__dryrun) {
      await db.query('UPDATE class_notes SET send_error = $2 WHERE id = $1',
        [rowId, 'TEST MODE — written here, not sent to Class.']);
      return { ok: true, dryrun: true, id: rowId };
    }
    await db.query('UPDATE class_notes SET sent_at = now(), send_error = NULL, class_note_id = $2 WHERE id = $1',
      [rowId, out && out.noteId != null ? String(out.noteId) : null]);
    return { ok: true, id: rowId, noteId: out && out.noteId };
  } catch (e) {
    await db.query('UPDATE class_notes SET send_error = $2 WHERE id = $1',
      [rowId, orderBuild.describeOrderError(e)]).catch(() => {});
    return sendFailure(e, 'send_failed', rowId);
  }
}

/**
 * Pull their side of the thread. Their notes carry an id, so re-reading is safe and
 * idempotent — a note we already have is left exactly as it is, including its read
 * receipt (re-marking it unread every time the list refreshed would make the desk's
 * "new message" badge meaningless).
 */
async function syncNotes(orderRowId) {
  const { order, error, message } = await loadOrder(null, orderRowId);
  if (error) return { ok: false, error, message };
  if (!client.configured().enabled) return { ok: false, error: 'disabled' };
  try {
    const out = await client.notes(order.class_order_id);
    // Accept BOTH envelope shapes and BOTH id spellings, exactly as the callback
    // reader does. Their NewNotes callback spells it `noteId`, and `client.addNote`
    // reads that spelling back — so reading only `id` here left `class_note_id` NULL,
    // and the partial unique index (`WHERE class_note_id IS NOT NULL`) then does not
    // apply: `ON CONFLICT DO NOTHING` never fires and EVERY "check for replies" click
    // re-inserts the whole thread with null content. Betting on one shape is the same
    // mistake in the other direction: a bare array would report "0 added" forever and
    // their messages would never appear.
    const list = Array.isArray(out) ? out
      : (Array.isArray(out && out.data) ? out.data : []);
    let added = 0;
    for (const n of list) {
      if (!n || typeof n !== 'object') continue;
      const id = text(n.noteId || n.NoteId || n.id || n.Id);
      const dir = text(n.direction || n.Direction) === 'FromClient' ? 'FromClient' : 'ToClient';
      const r = await db.query(
        `INSERT INTO class_notes (class_order_row, application_id, class_note_id, direction, content, vendor_created_at,
                                  sent_at)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4 = 'FromClient' THEN now() ELSE NULL END)
         ON CONFLICT (class_note_id) WHERE class_note_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [order.id, order.application_id, id, dir, text(n.content || n.Content), text(n.created || n.Created)]);
      if (r.rowCount) added++;
    }
    return { ok: true, added, total: list.length };
  } catch (e) {
    return { ok: false, error: e.code || 'lookup_failed', message: (e && e.message) || String(e) };
  }
}

/**
 * A revision or a reconsideration of value. ONE function, because at Class they are
 * one call — `kind` only decides which reasons are sensible and how the ask is
 * labelled for us afterwards.
 */
async function requestRevision(orderRowId, { kind = 'revision', reasons: raw, note: noteText, supporting, staffId } = {}) {
  const wanted = kind === 'rov' ? 'rov' : 'revision';
  const { reasons: clean, problems } = reasons.normalizeReasons(raw, { kind: wanted });
  if (problems.length) return { ok: false, error: 'bad_reasons', problems };

  const { order, error, message } = await loadOrder(null, orderRowId);
  if (error) return { ok: false, error, message };

  // Class only accepts a fix or a value dispute once the report is IN. An order that is
  // not Completed is rejected by them ("The order … must be in Completed status"), so
  // refuse it HERE, plainly, before the vendor does — the screen greys the button and
  // this is the server backstop. (A CANCEL is different: an unfinished order can be
  // cancelled, so requestCancel deliberately does NOT gate on this.)
  if (order.status !== 'completed') {
    return { ok: false, error: 'not_ready', notReady: true,
      message: 'The appraisal isn’t back yet, so Class can’t take a fix request. You can ask for a fix once the report is in.' };
  }

  // Recorded as an ROV whenever the reasons say so, even if the screen called it an
  // ordinary revision — "did we dispute the value on this file?" must not depend on
  // which button somebody happened to press.
  const recordedKind = wanted === 'rov' || reasons.looksLikeRov(clean) ? 'rov' : 'revision';

  const ins = await db.query(
    `INSERT INTO class_revisions (class_order_row, application_id, kind, reasons, supporting, note, requested_by)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) RETURNING id`,
    [order.id, order.application_id, recordedKind, JSON.stringify(clean),
     supporting ? JSON.stringify(supporting) : null, text(noteText), staffId || null]);
  const rowId = ins.rows[0].id;

  try {
    const out = await client.requestRevision(order.class_order_id, { reasons: clean });
    if (out && out.__dryrun) {
      await db.query('UPDATE class_revisions SET status = $2, last_error = $3 WHERE id = $1',
        [rowId, 'requested', 'TEST MODE — recorded here, not sent to Class.']);
      return { ok: true, dryrun: true, id: rowId, kind: recordedKind, reasons: clean };
    }
    await db.query(
      `UPDATE class_revisions SET status = 'sent', sent_at = now(), transaction_id = $2, vendor_response = $3::jsonb,
              last_error = NULL WHERE id = $1`,
      [rowId, out && out.transactionId != null ? String(out.transactionId) : null, JSON.stringify(out || {})]);
    return { ok: true, id: rowId, kind: recordedKind, reasons: clean, transactionId: out && out.transactionId };
  } catch (e) {
    await db.query(`UPDATE class_revisions SET status = 'error', last_error = $2 WHERE id = $1`,
      [rowId, orderBuild.describeOrderError(e)]).catch(() => {});
    return sendFailure(e, 'request_failed', rowId);
  }
}

/** Ask Class to cancel the order. Same reason vocabulary, its own endpoint. */
async function requestCancel(orderRowId, { reasons: raw, note: noteText, staffId } = {}) {
  const { reasons: clean, problems } = reasons.normalizeReasons(raw, { kind: 'cancel' });
  if (problems.length) return { ok: false, error: 'bad_reasons', problems };
  const { order, error, message } = await loadOrder(null, orderRowId);
  if (error) return { ok: false, error, message };

  const ins = await db.query(
    `INSERT INTO class_revisions (class_order_row, application_id, kind, reasons, note, requested_by)
     VALUES ($1,$2,'cancel',$3::jsonb,$4,$5) RETURNING id`,
    [order.id, order.application_id, JSON.stringify(clean), text(noteText), staffId || null]);
  const rowId = ins.rows[0].id;
  try {
    const out = await client.requestCancel(order.class_order_id, { reasons: clean });
    if (out && out.__dryrun) {
      // Returning early left the row `status='requested'` with no marker, so the file
      // badged a live cancellation request at Class that was never sent. Marked the
      // same way requestRevision marks its own dry run — the two must read alike.
      await db.query(`UPDATE class_revisions SET last_error=$2 WHERE id=$1`,
        [rowId, 'TEST MODE — recorded here, not sent to Class.']).catch(() => {});
      return { ok: true, dryrun: true, id: rowId };
    }
    await db.query(`UPDATE class_revisions SET status='sent', sent_at=now(), vendor_response=$2::jsonb WHERE id=$1`,
      [rowId, JSON.stringify(out || {})]);
    // NOT marked cancelled here. Asking is not the same as them agreeing — the order
    // moves when their StatusChanged callback says Cancelled.
    return { ok: true, id: rowId };
  } catch (e) {
    await db.query(`UPDATE class_revisions SET status='error', last_error=$2 WHERE id=$1`,
      [rowId, orderBuild.describeOrderError(e)]).catch(() => {});
    return sendFailure(e, 'request_failed', rowId);
  }
}

/** Mark their messages on an order as read. Ours are never "unread". */
async function markRead(orderRowId) {
  await db.query(
    `UPDATE class_notes SET read_at = now()
      WHERE class_order_row = $1 AND direction = 'ToClient' AND read_at IS NULL`, [orderRowId]);
  return { ok: true };
}

/** The whole conversation on an order, newest last, plus what is unread. */
async function thread(orderRowId) {
  const notes = (await db.query(
    `SELECT id, class_note_id, direction, content, author_staff_id, sent_at, send_error,
            vendor_created_at, read_at, created_at
       FROM class_notes WHERE class_order_row = $1
      ORDER BY COALESCE(vendor_created_at, created_at) ASC`, [orderRowId])).rows;
  const revisions = (await db.query(
    `SELECT id, kind, reasons, supporting, note, status, transaction_id, last_error,
            requested_by, requested_at, sent_at, resolved_at
       FROM class_revisions WHERE class_order_row = $1
      ORDER BY requested_at DESC`, [orderRowId])).rows;
  const unread = notes.filter((n) => n.direction === 'ToClient' && !n.read_at).length;
  return { notes, revisions, unread };
}

module.exports = { note, syncNotes, requestRevision, requestCancel, markRead, thread, loadOrder };
