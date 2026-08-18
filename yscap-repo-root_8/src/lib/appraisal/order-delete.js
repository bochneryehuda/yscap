'use strict';
/**
 * MAY THIS APPRAISAL ORDER ATTEMPT BE DELETED? (owner-directed 2026-08-18:
 * "failed and draft attempts to place appraisal orders have no option to delete
 * them … we need an option to delete the failed attempts with all vendors and
 * the draft ones, but not the successful ones.")
 *
 * ONE decision, shared by all three vendor routers (NAN/AppraisalScope, Class,
 * Richer Values), because a rule with three implementations drifts. The rule:
 *
 *   · only a DRAFT, an ERROR or a DRYRUN attempt may be deleted — anything the
 *     vendor has seen must be CANCELLED, not deleted (deleting it would leave
 *     the vendor working an order nothing tracks);
 *   · an order carrying a VENDOR IDENTIFIER is treated as placed whatever its
 *     status says — the identifier is proof the request reached the vendor;
 *   · an order carrying MONEY (paid, or a payment charge started/settled) is
 *     never deleted — the payment record must be resolved first;
 *   · a FILED DOCUMENT on the order means the attempt produced something a
 *     human may rely on — refuse rather than orphan it.
 *
 * FAILS CLOSED: an unknown vendor, an unreadable row, or any signal we cannot
 * judge answers "no" with a reason. Cancelled/rejected orders stay — they are
 * vendor-side facts with a journal.
 */

const DELETABLE_STATUSES = new Set(['draft', 'error', 'dryrun']);

// Vendor identifiers whose presence means "the vendor has this order".
const VENDOR_IDS = {
  amc: ['sp_order_number', 'cdg_order_number'],
  class: ['class_order_id', 'transaction_id'],
  rv: ['intake_token', 'order_token'],
};

function has(v) { return v != null && String(v).trim() !== ''; }

/**
 * PURE. { ok:true } or { ok:false, reason, message } — message is what the
 * screen shows, in plain words.
 * @param {'amc'|'class'|'rv'} vendor
 * @param {object} row the vendor's own order row
 * @param {object} [deps] impure facts the route gathered:
 *        { paymentIntent: row|null, filedDocuments: number }
 */
function mayDelete(vendor, row, deps) {
  const d = deps || {};
  if (!row) return { ok: false, reason: 'not_found', message: 'This order attempt no longer exists.' };
  const ids = VENDOR_IDS[vendor];
  if (!ids) return { ok: false, reason: 'unknown_vendor', message: 'This order comes from a vendor this action does not know — it cannot be deleted safely.' };
  const status = String(row.status || '').toLowerCase();
  if (!DELETABLE_STATUSES.has(status)) {
    return { ok: false, reason: 'not_deletable_status',
      message: status === 'cancelled' || status === 'rejected'
        ? 'A cancelled or rejected order is a record of what happened at the vendor — it stays on file.'
        : 'Only a draft or a failed attempt can be deleted. A placed order must be cancelled instead, so the vendor stops working it.' };
  }
  for (const k of ids) {
    if (has(row[k])) {
      return { ok: false, reason: 'vendor_has_it',
        message: 'This attempt reached the vendor (it carries their order number) — cancel it instead of deleting it, so the vendor stops working it.' };
    }
  }
  if (has(row.paid_at) || (row.paid_amount != null && Number(row.paid_amount) > 0)) {
    return { ok: false, reason: 'money_involved', message: 'A payment is recorded on this attempt — settle the payment record before anything is deleted.' };
  }
  const pi = d.paymentIntent;
  if (pi && (has(pi.settled_at) || has(pi.vendor_transaction_id) || has(pi.charge_started_at))) {
    return { ok: false, reason: 'money_involved', message: 'A payment was started or settled on this attempt — settle the payment record before anything is deleted.' };
  }
  if (Number(d.filedDocuments) > 0) {
    return { ok: false, reason: 'documents_filed',
      message: 'A document from this attempt was filed onto the loan — delete refused so nothing a human may rely on is orphaned.' };
  }
  return { ok: true };
}

module.exports = { mayDelete, DELETABLE_STATUSES, VENDOR_IDS, _internals: { has } };
