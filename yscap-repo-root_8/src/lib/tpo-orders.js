'use strict';
/**
 * TPO broker order gate + borrower-safe order state (owner-directed 2026-08-11).
 *
 * A TPO broker may order TITLE and INSURANCE for their firm's file — but NOT when the
 * note buyer is RCN (then the option is BLOCKED for the broker and our staff place it),
 * and NEVER flood (there is no flood order type at all; flood certificate + flood
 * insurance stay staff-only). This module holds the two decisions and the broker-safe
 * shaping so a route can never leak the note buyer or reveal WHY an RCN file is blocked.
 *
 * Pure — no DB, no throw — so the whole gate is unit-testable.
 */
const { isRcnNoteBuyer } = require('./conditions/field-registry');
const orders = require('./orders');

// The only order kinds a broker may place. Flood is deliberately absent: flood is never
// a broker order, and there is no `flood` order type in the system at all.
const TPO_ORDER_KINDS = ['title', 'insurance'];
function isTpoOrderKind(k) { return k === 'title' || k === 'insurance'; }

// The NOTE BUYER decides whether a broker may order at all. Everyone EXCEPT RCN: a
// broker orders title & insurance; when the note buyer is RCN the option is blocked for
// the broker and handled by our staff. The note buyer is NEVER revealed to the broker —
// only the fact that our team handles it. `isRcnNoteBuyer` prefix-matches every RCN
// spelling (RCN, RCN Capital, ...), so a hand-set RCN file is caught.
function brokerOrderingBlocked(lender) { return isRcnNoteBuyer(lender); }

// A broker-safe, one-line reason for each blocker key. NEVER names the note buyer. The
// USPS/loan-number steps are our team's (a broker can't verify a USPS address or mint a
// loan number), so they read as "your loan team is finishing this", not an instruction
// the broker can't act on.
function brokerBlockerText(code, kind) {
  const vendor = kind === 'title' ? 'title company' : 'insurance agent';
  switch (code) {
    case 'loan_number': return 'Your loan team is still finalizing the file — this will be ready shortly.';
    case 'contact':     return `Add the ${vendor} for this file, then you can place the order.`;
    case 'usps':        return 'Your loan team is verifying the property address before anything goes out.';
    default:            return 'This order is not ready yet.';
  }
}

// Which blocker keys a BROKER can clear themselves (add the vendor). The others are our
// team's steps — surfaced as read-only "your loan team is finishing this".
function brokerFixable(code) { return code === 'contact'; }

/**
 * Borrower-safe per-kind order state for the TPO panel. NEVER returns the note buyer
 * (`data.lender`) or the mortgagee clause — the vendor shown is the broker's OWN title /
 * insurance company (safe to show). `data` = orders.getOrderData(appId); `orderRows` =
 * the file_orders rows for this file (order_type + status).
 */
function tpoOrderState(data, orderRows, kind) {
  const row = (orderRows || []).find((o) => o.order_type === kind) || null;
  const status = row ? String(row.status || 'not_ordered') : 'not_ordered';
  const vendor = data && data.vendors ? data.vendors[kind] : null;
  const staffHandled = brokerOrderingBlocked(data && data.lender);
  const blk = staffHandled ? [] : orders.blockers(kind, data);
  const canOrder = !staffHandled
    && (status === 'not_ordered' || status === 'cancelled')
    && blk.length === 0;
  return {
    kind,
    status,
    staffHandled,                                        // RCN → our team places it (why is never shown)
    canOrder,
    blockers: blk.map((code) => ({ code, fixable: brokerFixable(code), text: brokerBlockerText(code, kind) })),
    vendor: vendor ? {                                   // the broker's OWN vendor — safe to show
      company_name: vendor.company_name || null,
      contact_name: vendor.contact_name || null,
      // Every address the order goes to (db/224's array folded with the legacy
      // scalar), so the broker's card shows what will actually be mailed.
      email: require('./vendor-directory').allEmails(vendor)[0] || null,
      emails: require('./vendor-directory').allEmails(vendor),
      phone: vendor.phone || null,
    } : null,
  };
}

module.exports = {
  TPO_ORDER_KINDS,
  isTpoOrderKind,
  brokerOrderingBlocked,
  brokerBlockerText,
  brokerFixable,
  tpoOrderState,
};
