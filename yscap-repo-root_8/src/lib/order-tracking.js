'use strict';
/**
 * AN ORDER HAS AN OWNER AND A HISTORY (owner-directed 2026-08-03).
 *
 * `file_orders` recorded who an order went to and when. It could not answer who is
 * chasing it, what has happened to it, or when it finished — so a title order that
 * went out three weeks ago and a title order that went out this morning looked
 * exactly alike on the desk. This module is the owner and the record.
 *
 * WHO CHASES, in the owner's own words: "and also any staff members". The DEFAULT
 * is the file's processor — they are the person whose job this already is — but
 * ANY active staff member may be assigned, and an assignment is a recorded event
 * rather than a silent column write. The resolver follows the proven
 * ownership-by-inference shape from `draw-recipients.coordinatorsOrDesk`: read who
 * actually holds the work, with a fallback so an order is never uncovered.
 *
 * Best-effort by contract: nothing here may ever fail a send, a webhook or a
 * human's click. A history that is one row short is a smaller problem than an
 * order that could not be placed.
 */

const db = require('../db');
// The order↔condition map is IMPORTED, never restated. A second copy of a code
// mapping is the "silently dead mapping" class CLAUDE.md documents: the day one
// side is renamed the other still matches zero rows, and every consumer reads
// "clean" rather than "broken".
const { CONDITION_CODE, RETURN_DOC_KIND } = require('./order-slots');

/** The three order types this desk tracks. */
const ORDER_TYPES = ['title', 'insurance', 'attorney'];

/**
 * WRITE ONE LINE OF THE ORDER'S HISTORY. Never throws, ever.
 *
 * Takes an optional `client` so a caller already inside a transaction records on
 * ITS connection — otherwise the event would be written by a second connection
 * and would survive a rollback that undid the thing it describes.
 *
 * @param {object} p {applicationId, orderType, kind, actorId?, detail?, orderId?, client?}
 */
async function recordEvent({ applicationId, orderType, kind, actorId = null, detail = null, orderId = null, client = null } = {}) {
  const q = client || db;
  if (!applicationId || !orderType || !kind) return null;
  try {
    // Resolve the order row when the caller did not hand us one. A missing order
    // means there is nothing to hang history on — silently skip rather than
    // inventing a row, because that would be the FIRST thing wrong on this file.
    let id = orderId;
    if (!id) {
      const r = await q.query(
        `SELECT id FROM file_orders WHERE application_id=$1 AND order_type=$2`, [applicationId, orderType]);
      id = r.rows[0] ? r.rows[0].id : null;
    }
    if (!id) return null;
    const r = await q.query(
      `INSERT INTO file_order_events (order_id, application_id, order_type, kind, actor_id, detail)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::jsonb,'{}'::jsonb)) RETURNING id`,
      [id, applicationId, orderType, kind, actorId || null, detail ? JSON.stringify(detail) : null]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (e) {
    console.error('[order-tracking] could not record an order event:', (e && e.message) || e);
    return null;
  }
}

/**
 * WHO SHOULD CHASE THIS ORDER BY DEFAULT — the file's processor.
 *
 * They are the person whose job the vendor follow-up already is. Falls back to the
 * primary loan officer so an order on a file with no processor still has a name on
 * it: an order nobody owns is exactly the order nobody chases, which is the whole
 * problem this desk was built to fix. Returns null only when the file has neither,
 * and a null assignee is handled everywhere as "the team" rather than as an error.
 *
 * A DEACTIVATED staffer is never returned — assigning work to somebody who has
 * left is indistinguishable from assigning it to nobody, except that it looks
 * covered.
 */
async function defaultAssignee(applicationId) {
  if (!applicationId) return null;
  try {
    const r = await db.query(
      `SELECT su.id
         FROM applications a
         JOIN staff_users su ON su.id = a.processor_id
        WHERE a.id = $1 AND su.is_active = true
        UNION ALL
       SELECT su.id
         FROM applications a
         JOIN staff_users su ON su.id = a.loan_officer_id
        WHERE a.id = $1 AND su.is_active = true
          AND a.processor_id IS NULL
        LIMIT 1`, [applicationId]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (_) { return null; }
}

/**
 * Put the default owner on an order that has none. Called when an order is PLACED
 * — the moment the chasing starts.
 *
 * FILL-ONLY: it never moves an assignment a human made. Re-sending an order, or a
 * later pass, must not quietly take the order off the person who took it on.
 */
async function ensureAssignee(applicationId, orderType, { client = null } = {}) {
  const q = client || db;
  try {
    const who = await defaultAssignee(applicationId);
    if (!who) return null;
    const r = await q.query(
      `UPDATE file_orders
          SET assigned_to = $3, assigned_at = now(), updated_at = now()
        WHERE application_id = $1 AND order_type = $2 AND assigned_to IS NULL
      RETURNING id`, [applicationId, orderType, who]);
    return r.rows[0] ? who : null;
  } catch (_) { return null; }
}

/**
 * THE VENDOR ANSWERED. Stamps the FIRST reply only — the responsiveness half of a
 * vendor scorecard, and a different fact from when the documents finally landed
 * (a title company that acknowledges in an hour and delivers in three days is not
 * the same vendor as one that is silent for three days and then delivers).
 *
 * Fill-only, so a later reply can never overwrite the first.
 */
async function noteFirstResponse(applicationId, orderType, { at = null, client = null } = {}) {
  const q = client || db;
  try {
    const r = await q.query(
      `UPDATE file_orders
          SET first_response_at = COALESCE($3::timestamptz, now()), updated_at = now()
        WHERE application_id = $1 AND order_type = $2
          AND first_response_at IS NULL
          AND status IN ('ordered','documents_in')
      RETURNING id`, [applicationId, orderType, at]);
    if (!r.rows[0]) return false;
    await recordEvent({ applicationId, orderType, kind: 'replied', orderId: r.rows[0].id, client });
    return true;
  } catch (_) { return false; }
}

/**
 * FINISH AN ORDER. 'completed' has been in the status vocabulary since db/211 and
 * nothing ever wrote it for title or insurance, so every deal we have ever closed
 * still sat on the desk looking like outstanding work — which is how a queue stops
 * being read.
 *
 * 'completed', NEVER 'cancelled'. The two are not interchangeable: `cancelled` is
 * an explicit human stand-down that closes the follow-up and reply doors, so
 * finishing an order with it would shut the team out of writing to a vendor about
 * a loan that is merely done. (closing-prep.retireClosedOrdersOnce documents the
 * same distinction for the attorney order — this is its title/insurance half.)
 */
async function completeOrder(applicationId, orderType, { actorId = null, reason = null, client = null } = {}) {
  const q = client || db;
  try {
    const r = await q.query(
      `UPDATE file_orders
          SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE application_id = $1 AND order_type = $2 AND status IN ('ordered','documents_in')
      RETURNING id`, [applicationId, orderType]);
    if (!r.rows[0]) return false;
    await recordEvent({
      applicationId, orderType, kind: 'completed', actorId,
      orderId: r.rows[0].id, detail: reason ? { reason } : null, client,
    });
    return true;
  } catch (_) { return false; }
}

/**
 * PUT A FINISHED ORDER BACK ON THE DESK.
 *
 * Reopen answers two different mistakes and must handle both: an order somebody
 * CANCELLED and now needs after all, and an order that was marked COMPLETED
 * (by hand, or by the sweep on a condition that was later pushed back) while the
 * vendor still owes us something. Offering it only for 'cancelled' left the second
 * case with no way back — the desk's own "Mark finished" button was a one-way door.
 *
 * THE STATUS IT GOES BACK TO IS NOT ALWAYS 'ordered', and this is the same
 * reasoning db/457's one-shot repair spells out: `order-sla.pendingOn` reads
 * 'ordered' as "the vendor owes us an answer", so reopening an order whose
 * commitment is already sitting on the file makes the overdue nudge email the team
 * "we asked Acme Title 40 days ago and nothing came back" about documents they can
 * see. It is db/457's own CASE, so the migration and the button agree:
 *   · the vendor answered → 'documents_in'
 *   · otherwise           → 'ordered'
 *
 * "The vendor answered" is `first_response_at` OR a returned document actually on
 * the file. Both, because they can disagree: `first_response_at` is stamped by the
 * inbound path, so a document a staffer filed by hand onto the order's condition
 * leaves it NULL — and a document you can see is the stronger evidence of the two.
 *
 * DELIBERATELY NO 'not_ordered' ARM. A missing `ordered_at` looks like "this was
 * never sent", and it is not: the closing-prep cancel route re-creates a lost row
 * bare so that Cancel stays reachable once outside counsel has been written to, and
 * that row carries no timestamp. Reopening it as 'not_ordered' would tell
 * `closing-prep.orderIsLive` the attorney was never engaged, which shuts the
 * follow-up and reply doors on a file with a live chain — the exact trap the
 * recovery exists to avoid. The order cannot be reopened unless it was cancelled or
 * completed, and both of those are things you can only do to an order that was
 * placed, so 'ordered' is the honest floor.
 *
 * Only from 'cancelled' or 'completed': reopening a live order is a no-op that
 * would rewrite its status out from under whatever it was doing.
 *
 * RETURNS A VERDICT, not a bare status — `{ok, status, reason}` where reason is
 * 'not_reopenable' (there was no cancelled/completed row) or 'error' (the write
 * itself failed). A single null for both let the routes tell somebody "this one is
 * already open" during a database blip, which is a lie about their own file and
 * leaves them refreshing a card that still says Cancelled. Never throws.
 */
async function reopenOrder(applicationId, orderType, { actorId = null, reason = null, client = null } = {}) {
  const q = client || db;
  try {
    const r = await q.query(
      `UPDATE file_orders o
          SET status = CASE
                WHEN o.first_response_at IS NOT NULL THEN 'documents_in'
                -- NULL, not ''. The attorney order has no returned-document kind
                -- of its own, and COALESCE(d.doc_kind,'') = '' matches every
                -- ORDINARY upload on the file — doc_kind is NULL for almost all of
                -- them — so an attorney order on any file holding a single document
                -- reopened as 'documents_in'. Comparing to NULL is never true, so
                -- with no mapped kind this arm simply does not apply.
                WHEN $3::text IS NOT NULL AND EXISTS (
                  SELECT 1 FROM documents d
                   WHERE d.application_id = o.application_id
                     AND d.doc_kind = $3::text
                     AND d.is_current = true
                ) THEN 'documents_in'
                ELSE 'ordered' END,
              -- The order is open again, so it has no completion. Nothing PRICES
              -- off this column today (the scorecard measures turnaround from
              -- ordered_at to first_response_at), but it is what the card prints
              -- as "finished on", and an order being chased must not also show a
              -- date it was finished.
              completed_at = NULL,
              updated_at = now()
        WHERE o.application_id = $1 AND o.order_type = $2
          AND o.status IN ('cancelled', 'completed')
      RETURNING o.id, o.status`, [applicationId, orderType, RETURN_DOC_KIND[orderType] || null]);
    if (!r.rows[0]) return { ok: false, status: null, reason: 'not_reopenable' };
    await recordEvent({
      applicationId, orderType, kind: 'reopened', actorId,
      orderId: r.rows[0].id, detail: reason ? { reason } : null, client,
    });
    return { ok: true, status: r.rows[0].status, reason: null };
  } catch (e) {
    console.error('[order-tracking] reopen', applicationId, orderType, (e && e.message) || e);
    return { ok: false, status: null, reason: 'error' };
  }
}

/**
 * RETIRE THE TITLE AND INSURANCE ORDERS THE FILE HAS FINISHED WITH.
 *
 * An order is done when the condition it exists to satisfy is signed off — that
 * is the file itself saying the documents arrived and were accepted.
 *
 * FUNDING DOES NOT RETIRE AN ORDER AT ALL, and that is the whole safety of this
 * sweep. It used to: the deal is over, so close everything. That quietly hid real
 * work, because the final title policy and the recorded mortgage routinely arrive
 * AFTER the loan funds — which is exactly why the follow-up and reply doors stay
 * open past funding. Within thirty minutes such an order read `completed`, the
 * desk hid it (its carve-out needs documents that by definition had not arrived)
 * and the nudge skipped it, so nobody would ever chase that vendor again.
 *
 * The first attempt at this narrowed funding to "an order the vendor has
 * ANSWERED" — and an audit was right that this is the same mistake wearing a
 * disguise. `first_response_at` is stamped the moment the FIRST document is
 * filed, which is precisely the 'documents_in' signal the paragraph below
 * forbids: an insurance agent who sends the binder and never the invoice sets it,
 * so the order was retired with half the condition outstanding — and on the very
 * files the fix was written for, where the commitment came back long before
 * funding, it was set already and changed nothing.
 *
 * So there is ONE finish line, the one this module always named: the condition is
 * signed off. That is the file itself saying the documents arrived and were
 * accepted. It costs nothing on a healthy file — title is a clear-to-close gate,
 * so a funded loan's condition is signed off and the order retires normally — and
 * a funded loan whose condition was NEVER signed off is an anomaly that should be
 * looked at, not swept off the desk.
 *
 * Deliberately NOT keyed on 'documents_in': documents arriving is the vendor's
 * half. The insurance condition needs a binder AND an invoice, and a title
 * commitment can come back needing a re-issue, so calling the order finished the
 * moment anything arrived would retire orders that still have work in them.
 *
 * Bounded, idempotent, never throws. Returns how many it retired.
 */
async function retireSatisfiedOrdersOnce({ limit = 200 } = {}) {
  let done = 0;
  try {
    const r = await db.query(
      // Only what the loop needs. `file_status` and a second copy of the condition
      // subquery were still being selected after the funding arm was removed —
      // nothing read either, and the subquery was being executed twice per row.
      `SELECT o.id, o.application_id, o.order_type
         FROM file_orders o
         JOIN applications a ON a.id = o.application_id
        WHERE o.order_type IN ('title','insurance')
          AND o.status IN ('ordered','documents_in')
          AND a.deleted_at IS NULL
          -- THE QUALIFYING TEST IS IN THE **WHERE**, NOT IN THE LOOP BELOW.
          -- It used to run in JavaScript AFTER the LIMIT, so an order that can
          -- never qualify re-occupied the same slot on every tick: with 250 open
          -- orders, a file that funds today sits at position 240 by ordered_at, is
          -- never inside the window of 200, and is never retired — it sits on the
          -- desk forever. That is the silt-up CLAUDE.md documents for the closing
          -- catch-up sweep ("a handful of long-closed deals permanently crowded out
          -- the live file"), which was fixed there by filtering in SQL.
          AND (
            (SELECT bool_or(ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL)
               FROM checklist_items ci
               JOIN checklist_templates t ON t.id = ci.template_id
              WHERE ci.application_id = o.application_id
                AND t.code = CASE o.order_type WHEN 'title' THEN $1 ELSE $2 END) IS TRUE
          )
          -- A HUMAN'S REOPEN OUTRANKS THE SWEEP. Reopening a finished order is a
          -- real button on the card, and without this the very next pass (or the
          -- next deploy) closed it again with nothing recorded to say why — the
          -- person would reopen it, walk away, and find it shut. Only a reopen that
          -- is NEWER than the last completion counts, so an order reopened, worked
          -- and legitimately finished again still retires.
          AND NOT EXISTS (
            SELECT 1 FROM file_order_events e
             WHERE e.order_id = o.id AND e.kind = 'reopened'
               AND e.created_at > COALESCE(
                     (SELECT max(c.created_at) FROM file_order_events c
                       WHERE c.order_id = o.id AND c.kind = 'completed'), 'epoch'::timestamptz))
        ORDER BY o.ordered_at ASC NULLS LAST, o.id
        LIMIT $3`, [CONDITION_CODE.title, CONDITION_CODE.insurance, Math.max(1, Math.min(1000, Number(limit) || 200))]);
    for (const row of r.rows) {
      // There is only one way to qualify now, so there is only one reason.
      const ok = await completeOrder(row.application_id, row.order_type, {
        reason: `the ${row.order_type} condition was signed off`,
      });
      if (ok) done += 1;
    }
  } catch (e) {
    console.error('[order-tracking] retire sweep:', (e && e.message) || e);
  }
  return done;
}

/** The order's own timeline, newest first. Never throws. */
async function listEvents(applicationId, orderType, { limit = 50 } = {}) {
  try {
    const r = await db.query(
      `SELECT e.id, e.kind, e.detail, e.created_at, e.actor_id,
              NULLIF(btrim(COALESCE(su.full_name,'')),'') AS actor_name
         FROM file_order_events e
         LEFT JOIN staff_users su ON su.id = e.actor_id
        WHERE e.application_id = $1 AND e.order_type = $2
        -- id breaks a created_at tie so a capped read is deterministic.
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $3`, [applicationId, orderType, Math.max(1, Math.min(200, Number(limit) || 50))]);
    return r.rows;
  } catch (_) { return []; }
}

module.exports = {
  ORDER_TYPES,
  recordEvent, defaultAssignee, ensureAssignee, noteFirstResponse,
  completeOrder, reopenOrder, retireSatisfiedOrdersOnce, listEvents,
};
