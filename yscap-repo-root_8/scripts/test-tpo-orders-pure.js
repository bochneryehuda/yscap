/**
 * TPO broker ordering — the gate + borrower-safe state, PURE (no DB).
 *
 * Owner-directed 2026-08-11: a broker may order TITLE & INSURANCE for their firm's file,
 * EXCEPT when the note buyer is RCN (then it is staff-only). Flood is NEVER a broker
 * order. This pins:
 *   • only title/insurance are order kinds (flood + anything else refused);
 *   • RCN (every spelling) blocks the broker; bluelake/fidelis/emcap/null do not;
 *   • the borrower-safe state NEVER contains the note buyer, and reveals RCN only as
 *     "your loan team handles this" (staffHandled) — never why;
 *   • canOrder needs a non-RCN buyer, a vendor with an email, and a placeable status.
 */
const assert = require('assert');
const t = require('../src/lib/tpo-orders');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// ── order kinds: title/insurance only; flood is never a broker order ──────────────
ok(t.isTpoOrderKind('title') === true, 'title is a broker order kind');
ok(t.isTpoOrderKind('insurance') === true, 'insurance is a broker order kind');
ok(t.isTpoOrderKind('flood') === false, 'flood is NEVER a broker order kind');
ok(t.isTpoOrderKind('attorney') === false, 'attorney is not a broker order kind');
ok(t.isTpoOrderKind('') === false && t.isTpoOrderKind(undefined) === false, 'junk is not an order kind');

// ── RCN blocks the broker; the three program buyers + null do not ─────────────────
for (const rcn of ['RCN', 'RCN Capital', 'rcn capital, llc', 'RCNCapital']) {
  ok(t.brokerOrderingBlocked(rcn) === true, `RCN spelling "${rcn}" blocks broker ordering`);
}
for (const other of ['Blue Lake Capital', 'Fidelis Investors LLC', 'EMCAP Financial', 'Blue Lake', null, undefined, '']) {
  ok(t.brokerOrderingBlocked(other) === false, `"${other}" does NOT block broker ordering`);
}

// ── blocker text is broker-safe (never names a note buyer) and covers each key ─────
for (const kind of ['title', 'insurance']) {
  for (const code of ['loan_number', 'contact', 'usps', 'other']) {
    const txt = t.brokerBlockerText(code, kind);
    ok(typeof txt === 'string' && txt.length > 0, `blocker text for ${kind}/${code} is present`);
    ok(!/rcn|fidelis|blue\s*lake|emcap|corrfirst|note\s*buyer|capital\s*partner/i.test(txt),
      `blocker text for ${kind}/${code} never names a note buyer`);
  }
}
ok(t.brokerFixable('contact') === true, 'the broker can fix a missing contact');
ok(t.brokerFixable('usps') === false && t.brokerFixable('loan_number') === false, 'usps/loan_number are our team’s steps');

// ── tpoOrderState: borrower-safe, RCN → staffHandled, canOrder gating ─────────────
const vendor = { company_name: 'Acme Title', contact_name: 'Pat', email: 'pat@acme.test', phone: '555-1' };
const ready = { hasLoanNumber: true, uspsGate: false, uspsImported: false, lender: 'Blue Lake Capital',
  vendors: { title: vendor, insurance: null } };

const st = t.tpoOrderState(ready, [], 'title');
ok(!('lender' in st), 'the borrower-safe state NEVER carries the note buyer key');
ok(JSON.stringify(st).toLowerCase().indexOf('blue lake') === -1 && JSON.stringify(st).toLowerCase().indexOf('lender') === -1,
  'the state string never mentions the note buyer / lender');
ok(st.staffHandled === false, 'a non-RCN file is not staff-handled');
ok(st.canOrder === true, 'title is orderable: non-RCN, vendor+email, not ordered');
ok(st.vendor && st.vendor.company_name === 'Acme Title' && st.vendor.email === 'pat@acme.test',
  'the broker sees their OWN title vendor (safe to show)');

const ins = t.tpoOrderState(ready, [], 'insurance');
ok(ins.canOrder === false && ins.blockers.some((b) => b.code === 'contact'),
  'insurance is blocked with no agent — and says "add the contact"');

// RCN → staffHandled, never orderable, no blockers leaked, no note buyer in the payload
const rcnData = { ...ready, lender: 'RCN Capital', vendors: { title: vendor, insurance: vendor } };
const rcnSt = t.tpoOrderState(rcnData, [], 'title');
ok(rcnSt.staffHandled === true, 'an RCN file is staff-handled');
ok(rcnSt.canOrder === false, 'an RCN file is never broker-orderable');
ok(rcnSt.blockers.length === 0, 'an RCN file shows no blocker detail — just "your loan team handles this"');
ok(JSON.stringify(rcnSt).toLowerCase().indexOf('rcn') === -1, 'the RCN note buyer is NEVER in the payload');

// an already-placed order is not re-orderable (but not staff-handled)
const placed = t.tpoOrderState(ready, [{ order_type: 'title', status: 'ordered' }], 'title');
ok(placed.status === 'ordered' && placed.canOrder === false, 'an already-ordered title is not re-orderable via canOrder');

// a cancelled order can be re-placed
const cancelled = t.tpoOrderState(ready, [{ order_type: 'title', status: 'cancelled' }], 'title');
ok(cancelled.canOrder === true, 'a cancelled order can be placed again');

console.log(`\nTPO orders (pure): ${n} checks passed`);
