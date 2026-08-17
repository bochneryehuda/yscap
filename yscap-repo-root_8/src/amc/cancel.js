'use strict';
/**
 * Cancel a placed AMC (NAN / AppraisalScope) appraisal order — the NAN mirror of the
 * Class desk's requestCancel.
 *
 * A CANCELLATION IS A MESSAGE TO THEIR TEAM, NOT AN API ACTION (owner-directed
 * 2026-08-17: "Canceling should send a message in the chat message that goes directly
 * to them: 'Hey, please cancel the order.'").
 *
 * WHY THAT IS ALSO THE CORRECT READING OF THEIR PACKAGE. There is no cancel action in
 * it. Every request type AppraisalScope documents is listed in the integration guide's
 * process flow and enumerated in the mapping workbook, and no spelling of "cancel"
 * appears in either, in the Postman collection, or in any of the 25 sample payloads.
 * The previous implementation therefore INVENTED one — `CancelOrder`, wrapped in an
 * env override (`AMC_CANCEL_ACTION`) with a note saying it had to be dialled in live.
 * That is a button that looks like it works and answers a NACK the first time anybody
 * presses it in anger, on a real order, with no way for the person pressing it to know
 * what the right word would have been.
 *
 * `AddComment` IS documented, IS in their samples, and lands in the order's own message
 * thread — which is where their coordinators actually read. So the cancellation travels
 * as a plainly-worded request on that thread. It is honest about what it is: only the
 * AMC can cancel their own order, so asking is asking. Nothing else moves — the order
 * still sits at 'cancel_requested' and only reaches 'cancelled' when the vendor's own
 * status callback returns Cancellation (1051), which mapStatusToLifecycle handles, and
 * the poll worker keeps watching for it in the meantime.
 *
 * Every guarantee the previous version had is kept, because the send goes through
 * `comments.postComment`: the same guarded write channel (nothing leaves while
 * AMC_OUTBOUND_ENABLED is off, recorded-not-sent under AMC_DRYRUN), the same journal
 * to amc_write_log, the same NACK and session-invalidation handling. What it gains is
 * that the request is now VISIBLE — it is in the thread on the order, so a coordinator
 * on either side can see what was asked and when.
 */
const session = require('./session');
const comments = require('./comments');
const orderService = require('./order-service');

const REASON_MAX = 1000;

// ONE definition of what we say, so the thread, the test and anything that later wants
// to show the wording cannot drift. It leads with the ask — their coordinator may be
// skimming a list of messages — and carries the reason, which is what lets them action
// it without a second round trip.
function cancelMessage(reason) {
  const r = String(reason || '').trim();
  return `Please cancel this order.${r ? `\n\nReason: ${r}` : ''}`;
}

/**
 * @param order the amc_orders row (already file-scoped by the caller).
 * @param opts { reason, staffId, staffName }
 * Returns { ok, order?, dryrun?, error?, message?, comment? }. Never throws for an
 * expected refusal (not placed, terminal, outbound-off, vendor NACK); a genuine bug
 * still throws so the route's catch reports it.
 */
async function requestCancel(db, order, opts = {}, deps = {}) {
  const reason = String(opts.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required', message: 'Add a short reason for the cancellation.' };
  if (!order || !order.id) return { ok: false, error: 'not_found' };
  // A cancel needs the ServiceProviderOrderNumber: it identifies the order at the AMC in
  // the message envelope, AND it's what the poll worker uses to confirm the cancellation
  // (GetAppraisalStatus filters on sp_order_number, so a sp-less order could never leave
  // 'cancel_requested'). A placed order always carries it (the ACK sets sp + cdg
  // together); a draft carries neither — nothing to cancel there.
  if (!order.sp_order_number) {
    return { ok: false, error: 'not_placed', message: 'This order was never placed with the AMC, so there’s nothing to cancel there.' };
  }
  if (order.status === 'cancelled' || order.status === 'completed') {
    return { ok: false, error: 'not_cancellable', message: `This order is already ${order.status}.` };
  }
  // A cancel is already in flight — don't send their team a second identical message and,
  // more importantly, don't overwrite the original cancel_reason / cancel_requested_by /
  // cancel_requested_at with a second request's values (who/when first asked is the audit
  // trail). The poll worker is already waiting for the vendor's Cancellation confirmation.
  if (order.status === 'cancel_requested') {
    return { ok: false, error: 'not_cancellable', message: 'A cancellation has already been requested for this order — waiting for the AMC to confirm.' };
  }

  // The message IS the request. postComment owns the guarded write, the dry-run
  // short-circuit, the NACK read, the session invalidation and the journal — so a
  // cancellation is sent exactly the way every other message on this order is sent,
  // and there is no second copy of that logic to drift.
  const sent = await comments.postComment(db, order, {
    staffId: opts.staffId,
    staffName: opts.staffName,
    body: cancelMessage(reason.slice(0, REASON_MAX)),
  }, deps);

  if (!sent || !sent.ok) {
    // NOTHING IS RECORDED AS REQUESTED WHEN THE ASK DID NOT LEAVE. A refused send that
    // still flipped the order to 'cancel_requested' would leave the desk waiting
    // forever for a confirmation of a message their team never received.
    if (sent && sent.error === 'send_failed') {
      await db.query(`UPDATE amc_orders SET last_error = $2, updated_at = now() WHERE id = $1`,
        [order.id, String(sent.message || 'the cancellation could not be sent').slice(0, 2000)]);
    }
    return {
      ok: false,
      error: (sent && sent.error) || 'send_failed',
      message: (sent && sent.message) || 'The cancellation could not be sent to the AMC.',
    };
  }

  // Dry-run: the transport short-circuited without sending. Record the request so the
  // desk reads the same 'cancel_requested' state a live send produces.
  if (sent.dryrun) {
    const upd = await db.query(
      `UPDATE amc_orders SET status = 'cancel_requested', cancel_reason = $2, cancel_requested_at = now(),
          cancel_requested_by = $3, dryrun = true,
          last_error = 'TEST MODE — the cancellation was recorded here, not sent to the AMC.',
          updated_at = now() WHERE id = $1 RETURNING *`,
      [order.id, reason.slice(0, REASON_MAX), opts.staffId || null]);
    return { ok: true, dryrun: true, order: upd.rows[0], comment: sent.comment };
  }

  // Asked. The order flips to 'cancelled' when the vendor's status callback confirms it.
  const upd = await db.query(
    `UPDATE amc_orders SET status = 'cancel_requested', cancel_reason = $2, cancel_requested_at = now(),
        cancel_requested_by = $3, last_error = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [order.id, reason.slice(0, REASON_MAX), opts.staffId || null]);
  await orderService.journal(db, {
    orderId: order.id, appId: order.application_id, action: 'CancelRequest',
    request: { via: 'AddComment', body: cancelMessage(reason) }, response: { commentId: sent.comment && sent.comment.id },
    ok: true, staffId: opts.staffId,
  });
  require('../lib/appraisal-order-mirror').fire(order.application_id);
  return { ok: true, order: upd.rows[0], comment: sent.comment };
}

module.exports = { requestCancel, cancelMessage, _internals: { session } };
