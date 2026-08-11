'use strict';
/**
 * Cancel a placed AMC (NAN / AppraisalScope) appraisal order — the NAN mirror of the
 * Class desk's requestCancel.
 *
 * Staff ask the AMC to cancel an order they placed, with a plain reason. This rides the
 * SAME guarded write channel as CreateAppraisal (client.write): nothing is sent while
 * AMC_OUTBOUND_ENABLED is off (fail-closed) or AMC_DRYRUN is on (recorded, not sent),
 * and every attempt is journaled to amc_write_log. Asking is NOT agreeing — the order
 * only moves to 'cancelled' when the vendor's own status callback returns Cancellation
 * (1051), which mapStatusToLifecycle already handles; in between it reads
 * 'cancel_requested' and the sync worker keeps polling for the confirmation.
 *
 * The exact CDG cancel action name is confined to ONE env-overridable descriptor
 * (AMC_CANCEL_ACTION in cdg.buildCancelOrder, default 'CancelOrder') and MUST be
 * confirmed against the live tenant before enabling outbound — same posture as the
 * flood-order contract.
 */
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');
const orderService = require('./order-service');

const REASON_MAX = 1000;

/**
 * @param order the amc_orders row (already file-scoped by the caller).
 * @param opts { reason, staffId }
 * Returns { ok, order?, dryrun?, error?, message?, httpStatus?, detail? }. Never throws
 * for an expected refusal (not placed, terminal, outbound-off, vendor NACK); a genuine
 * bug still throws so the route's catch reports it.
 */
async function requestCancel(db, order, opts = {}) {
  const reason = String(opts.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required', message: 'Add a short reason for the cancellation.' };
  if (!order || !order.id) return { ok: false, error: 'not_found' };
  // A cancel needs the ServiceProviderOrderNumber: it identifies the order at the AMC in
  // the CancelOrder envelope's serviceProviderSystem, AND it's what the poll worker uses
  // to confirm the cancellation (GetAppraisalStatus filters on sp_order_number, so a
  // sp-less order could never leave 'cancel_requested'). A placed order always carries it
  // (the ACK sets sp + cdg together); a draft carries neither — nothing to cancel there.
  if (!order.sp_order_number) {
    return { ok: false, error: 'not_placed', message: 'This order was never placed with the AMC, so there’s nothing to cancel there.' };
  }
  if (order.status === 'cancelled' || order.status === 'completed') {
    return { ok: false, error: 'not_cancellable', message: `This order is already ${order.status}.` };
  }
  // A cancel is already in flight — don't re-send another CancelOrder to the vendor and,
  // more importantly, don't overwrite the original cancel_reason / cancel_requested_by /
  // cancel_requested_at with a second request's values (who/when first asked is the audit
  // trail). The poll worker is already waiting for the vendor's Cancellation confirmation.
  if (order.status === 'cancel_requested') {
    return { ok: false, error: 'not_cancellable', message: 'A cancellation has already been requested for this order — waiting for the AMC to confirm.' };
  }

  const authCtx = await session.authContext();   // DoLogin (needs AMC_ENABLED); throws if off
  const built = cdg.buildCancelOrder({
    apiKey: authCtx.apiKey,
    subdomain: authCtx.subdomain,
    spOrderNumber: order.sp_order_number,
    clientOrderNumber: order.client_order_number,
    text: reason.slice(0, REASON_MAX),
  });

  let resp;
  try {
    // The action rides ?orderId=<cdg order number> exactly as an AddForm does.
    resp = await client.write(built, { orderId: order.cdg_order_number || undefined, label: 'CancelOrder' });
  } catch (e) {
    const failure = orderService.describeSendFailure(e);
    if (e && e.status === 401) session.invalidate();
    await db.query(`UPDATE amc_orders SET last_error = $2, last_status_response = $3, updated_at = now() WHERE id = $1`,
      [order.id, failure.text.slice(0, 2000), JSON.stringify(failure.detail)]);
    await orderService.journal(db, { orderId: order.id, appId: order.application_id, action: 'CancelOrder', request: built, response: failure.detail, ok: false, error: failure.text, staffId: opts.staffId });
    return { ok: false, error: e && e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: failure.text, httpStatus: failure.detail.httpStatus, detail: failure.detail };
  }

  // Dry-run: the transport short-circuited without sending. Record the request so the
  // desk reads the same 'cancel_requested' state a live send produces.
  if (resp && resp.__dryrun) {
    const upd = await db.query(
      `UPDATE amc_orders SET status = 'cancel_requested', cancel_reason = $2, cancel_requested_at = now(),
          cancel_requested_by = $3, dryrun = true,
          last_error = 'TEST MODE — the cancellation was recorded here, not sent to the AMC.',
          updated_at = now() WHERE id = $1 RETURNING *`,
      [order.id, reason.slice(0, REASON_MAX), opts.staffId || null]);
    await orderService.journal(db, { orderId: order.id, appId: order.application_id, action: 'CancelOrder', request: built, response: { dryrun: true }, ok: true, staffId: opts.staffId });
    return { ok: true, dryrun: true, order: upd.rows[0] };
  }

  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    await db.query(`UPDATE amc_orders SET last_error = $2, last_status_response = $3, updated_at = now() WHERE id = $1`,
      [order.id, err.description || err.code || 'AMC error', JSON.stringify(resp)]);
    await orderService.journal(db, { orderId: order.id, appId: order.application_id, action: 'CancelOrder', request: built, response: resp, ok: false, error: err.description || err.code, staffId: opts.staffId });
    return { ok: false, error: 'amc_nack', message: err.description || err.code };
  }

  // Accepted. Record the request; the order flips to 'cancelled' when the vendor's
  // status callback confirms it (Cancellation / 1051).
  const upd = await db.query(
    `UPDATE amc_orders SET status = 'cancel_requested', cancel_reason = $2, cancel_requested_at = now(),
        cancel_requested_by = $3, last_status_response = $4, last_error = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [order.id, reason.slice(0, REASON_MAX), opts.staffId || null, JSON.stringify(resp)]);
  await orderService.journal(db, { orderId: order.id, appId: order.application_id, action: 'CancelOrder', request: built, response: resp, ok: true, staffId: opts.staffId });
  return { ok: true, order: upd.rows[0] };
}

module.exports = { requestCancel };
