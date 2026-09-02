'use strict';
/**
 * Class Valuation — the money picture on an order, and what the API lets us do about it.
 *
 * WHAT CLASS'S API CAN AND CANNOT DO WITH MONEY (their Orders API guide, rev 0.17,
 * pp.31-32 and 50-52 — read before changing anything here):
 *   • There is NO card charge. Nothing in the API takes a card number and moves money.
 *   • At ORDER time, `paymentDetails.paymentMethod` chooses how the order is paid:
 *       Invoice     — billed to YS Capital's account with Class (their default);
 *       PaymentLink — Class EMAILS THE BORROWER a hosted payment page
 *                     (`recipientEmail` required; their `PaymentLinkSentToBorrower`
 *                     callback confirms it went out);
 *       Prepay      — paid up front, outside the API.
 *     That is the one automatic borrower-collection the API offers, and it is chosen
 *     when the order is placed (src/class/order-build.js carries it) — it cannot be
 *     triggered later on an existing order.
 *   • `GET /orders/{id}/payment-details` reads the fee, additional fees, total, paid and
 *     outstanding amounts. That is the "how much and is it paid" a desk needs.
 *   • `POST /orders/{id}/add-creditcard-payment` RECORDS a card payment taken somewhere
 *     else — holder name, amount, LAST FOUR, authorization code. It processes nothing.
 *     It is how a charge the back office ran on the card on file gets onto the order
 *     so Class stops chasing the borrower.
 *   • There is no fee QUOTE before an order exists. The fee appears on payment-details
 *     once the order is placed, and `ClientFeeChanged` announces a later change. So
 *     "the fee before ordering" is an ESTIMATE from this account's own history — the
 *     last fees Class charged for the same product — which `recentFees` provides for
 *     the product picker. It is labelled as such on the screen.
 *
 * Everything here is best-effort and never throws into a poll or a callback: a fee we
 * could not read is left as it was, with `payment_checked_at` untouched.
 */

const db = require('../db');
const client = require('./client');

// ---------------------------------------------------------------------------
// PURE — the vendor's reply → our columns.
// ---------------------------------------------------------------------------
function cents(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * payment-details → { total_cents, paid_cents, outstanding_cents, client_fee_cents,
 * additional_fees }. Their envelope sometimes wraps the object in `data`, so both are
 * read. A field they did not send stays undefined so an UPDATE never blanks a value
 * we already had.
 */
function parsePaymentDetails(resp) {
  const d = resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)
    ? resp.data : (resp || {});
  const out = {};
  const fee = cents(d.clientFee != null ? d.clientFee : d.ClientFee);
  const total = cents(d.totalAmount != null ? d.totalAmount : d.TotalAmount);
  const paid = cents(d.paidAmount != null ? d.paidAmount : d.PaidAmount);
  const owed = cents(d.outstandingBalance != null ? d.outstandingBalance : d.OutstandingBalance);
  if (fee != null) out.client_fee_cents = fee;
  if (total != null) out.total_cents = total;
  if (paid != null) out.paid_cents = paid;
  if (owed != null) out.outstanding_cents = owed;
  const extra = Array.isArray(d.additionalFees) ? d.additionalFees : (Array.isArray(d.AdditionalFees) ? d.AdditionalFees : null);
  if (extra) {
    out.additional_fees = extra.map((f) => ({
      description: f && (f.description || f.Description) != null ? String(f.description || f.Description) : null,
      amount_cents: cents(f && (f.amount != null ? f.amount : f.Amount)),
      date: f && (f.date || f.Date) ? String(f.date || f.Date) : null,
    }));
  }
  return out;
}

/** The plain-language line under a balance. */
function describeBalance(o) {
  if (!o) return null;
  const money = (c) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (o.outstanding_cents != null && Number(o.outstanding_cents) <= 0 && (o.total_cents != null || o.paid_at)) return 'Paid in full at Class Valuation.';
  if (o.outstanding_cents != null && Number(o.outstanding_cents) > 0) {
    const how = o.payment_method === 'PaymentLink'
      ? (o.payment_link_sent_at ? ' Class emailed the borrower their payment page.' : ' Class will email the borrower a payment page.')
      : (o.payment_method === 'Invoice' ? ' Billed to the YS Capital account.' : '');
    return `${money(o.outstanding_cents)} still owed at Class Valuation.${how}`;
  }
  if (o.client_fee_cents != null) return `Fee ${money(o.client_fee_cents)} — not yet reconciled with Class.`;
  return null;
}

// ---------------------------------------------------------------------------
// Reads and writes.
// ---------------------------------------------------------------------------
const RECHECK_MS = Math.max(60, parseInt(process.env.CLASS_PAYMENT_RECHECK_SEC || '3600', 10) || 3600) * 1000;

/**
 * Read payment-details for a numbered order and store what came back. `force` skips
 * the once-an-hour throttle (a staffer opening the Pay modal wants the live number).
 * Returns the stored picture, or { ok:false, error } — never throws.
 */
async function refreshOrder(dbh, order, { force = false } = {}) {
  const q = dbh || db;
  if (!order || !order.class_order_id) return { ok: false, error: 'not_numbered' };
  if (!force && order.payment_checked_at && (Date.now() - new Date(order.payment_checked_at).getTime()) < RECHECK_MS) {
    return { ok: true, fresh: false, order };
  }
  let resp;
  try { resp = await client.paymentDetails(order.class_order_id); }
  catch (e) { return { ok: false, error: e.code || 'read_failed', message: String((e && e.message) || e) }; }
  const patch = parsePaymentDetails(resp);
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c} = $${i + 2}${c === 'additional_fees' ? '::jsonb' : ''}`);
  sets.push('payment_checked_at = now()', 'updated_at = now()');
  // Their balance reaching zero is a payment, whoever took it — mark paid_at once
  // (never overwrite the callback's timestamp), and never un-pay on a read.
  if (patch.outstanding_cents != null && patch.outstanding_cents <= 0 && (patch.total_cents || 0) > 0) {
    sets.push('paid_at = COALESCE(paid_at, now())');
  }
  const vals = cols.map((c) => (c === 'additional_fees' ? JSON.stringify(patch[c]) : patch[c]));
  const r = await q.query(`UPDATE class_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [order.id, ...vals]);
  return { ok: true, fresh: true, order: r.rows[0] || order, raw: resp };
}

/**
 * Tell Class a card payment was taken elsewhere (the back office ran the card on
 * file). Records it on the order at Class, then re-reads the balance so the row says
 * what Class now says. Amount in DOLLARS as their API takes it.
 */
async function recordCardPayment(dbh, order, { nameCardHolder, amount, last4, authorizationCode } = {}) {
  const q = dbh || db;
  if (!order || !order.class_order_id) return { ok: false, error: 'not_numbered' };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'bad_amount', message: 'The amount has to be a positive number of dollars.' };
  const four = String(last4 || '').replace(/\D/g, '').slice(-4);
  if (four.length !== 4) return { ok: false, error: 'bad_last4', message: 'Class records the LAST FOUR digits of the card only.' };
  const body = {
    nameCardHolder: String(nameCardHolder || '').trim() || null,
    amount: Math.round(amt * 100) / 100,
    cardNumber: four,
    authorizationCode: String(authorizationCode || '').trim() || null,
  };
  let resp;
  try { resp = await client.recordCardPayment(order.class_order_id, body); }
  catch (e) {
    if (e && e.code === 'CLASS_OUTBOUND_DISABLED') return { ok: false, error: 'outbound_disabled', message: String(e.message || e) };
    return { ok: false, error: e.code || 'record_failed', message: String((e && e.message) || e), vendor: e && e.body };
  }
  if (resp && resp.__dryrun) return { ok: true, dryrun: true, body };
  await q.query(`UPDATE class_orders SET payment_recorded_at = now(), updated_at = now() WHERE id = $1`, [order.id]).catch(() => {});
  const fresh = await refreshOrder(q, { ...order, payment_checked_at: null }, { force: true });
  return { ok: true, body, order: fresh.ok ? fresh.order : order };
}

/**
 * THE FEE BEFORE ORDERING, as far as this account's history allows: per product id,
 * the last fees Class actually charged us (payment-details / ClientFeeChanged) on
 * orders in the current environment. Returns { [productId]: { lastCents, count,
 * lowCents, highCents } } for the picker to print "last time $X". No history → no
 * entry, and the screen says the fee will show once the order is placed.
 */
async function recentFees(dbh, { limitPerProduct = 5 } = {}) {
  const q = dbh || db;
  const r = await q.query(
    `SELECT product_id, client_fee_cents, placed_at
       FROM (
         SELECT product_id, client_fee_cents, placed_at,
                row_number() OVER (PARTITION BY product_id ORDER BY COALESCE(placed_at, created_at) DESC) AS rn
           FROM class_orders
          WHERE product_id IS NOT NULL AND client_fee_cents IS NOT NULL AND client_fee_cents > 0
            AND dryrun = false AND status NOT IN ('error', 'dryrun')
       ) t
      WHERE rn <= $1
      ORDER BY product_id, rn`, [Math.max(1, limitPerProduct)]);
  const out = {};
  for (const row of r.rows) {
    const k = String(row.product_id);
    const c = Number(row.client_fee_cents);
    if (!out[k]) out[k] = { lastCents: c, count: 0, lowCents: c, highCents: c };
    out[k].count += 1;
    out[k].lowCents = Math.min(out[k].lowCents, c);
    out[k].highCents = Math.max(out[k].highCents, c);
  }
  return out;
}

module.exports = {
  refreshOrder, recordCardPayment, recentFees,
  // pure — exported for the unit tests
  parsePaymentDetails, describeBalance, cents,
  PAYMENT_METHODS: ['Invoice', 'PaymentLink', 'Prepay'],
};
