/**
 * test-esign-tracking.js — the pure phase/waiting-on derivation behind the
 * internal DocuSign tracking page. No DB, no network: exercises the exact
 * logic the staff cockpit renders (DocuSign has no native "awaiting
 * counter-signature" status — we derive it; see the spec §11).
 *
 * Run: node scripts/test-esign-tracking.js
 */
const assert = require('assert');
const { esignPhase, waitingOn } = require('../src/lib/esign/tracking');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// --- terminal envelope statuses short-circuit, regardless of recipients ---
eq(esignPhase('completed', [], true), 'completed', 'completed status → completed');
eq(esignPhase('declined', [], true), 'declined', 'declined status → declined');
eq(esignPhase('voided', [], true), 'voided', 'voided status → voided');
eq(esignPhase('error', [], true), 'error', 'error status → error');
eq(esignPhase('not_sent', [], true), 'draft', 'not_sent status → draft');

// --- no counter-signature required (e.g. Heter Iska): always awaiting borrower
//     while in flight, never awaiting_countersign ---
eq(esignPhase('sent', [{ role: 'borrower', routingOrder: 1, status: 'sent' }], false),
  'awaiting_borrower', 'no countersign → awaiting_borrower');

// --- term-sheet package: borrower(s) at order 1, admin counter-signer at 2 ---
const borrowerSent = [
  { role: 'borrower', routingOrder: 1, status: 'sent' },
  { role: 'co_borrower', routingOrder: 1, status: 'delivered' },
  { role: 'admin', routingOrder: 2, status: 'created', isCountersigner: true },
];
eq(esignPhase('sent', borrowerSent, true), 'awaiting_borrower',
  'order-1 not all signed → awaiting_borrower');

const borrowersDoneAdminPending = [
  { role: 'borrower', routingOrder: 1, signedAt: '2026-07-19T10:00:00Z' },
  { role: 'co_borrower', routingOrder: 1, status: 'completed' },
  { role: 'admin', routingOrder: 2, status: 'delivered', isCountersigner: true },
];
eq(esignPhase('delivered', borrowersDoneAdminPending, true), 'awaiting_countersign',
  'all order-1 signed + admin pending → awaiting_countersign');

// A single borrower (no co-borrower) who has signed, admin pending.
eq(esignPhase('sent', [
  { role: 'borrower', routingOrder: 1, status: 'completed' },
  { role: 'admin', routingOrder: 2, status: 'sent', isCountersigner: true },
], true), 'awaiting_countersign', 'lone borrower signed + admin pending → awaiting_countersign');

// If a borrower declined, the envelope status becomes 'declined' upstream; but
// mid-flight (status still 'sent') with one order-1 not done we stay awaiting.
eq(esignPhase('sent', [
  { role: 'borrower', routingOrder: 1, status: 'completed' },
  { role: 'co_borrower', routingOrder: 1, status: 'sent' },
  { role: 'admin', routingOrder: 2, status: 'created', isCountersigner: true },
], true), 'awaiting_borrower', 'one co-borrower still out → awaiting_borrower');

// Empty recipients but countersign required + in flight → can't be countersign yet.
eq(esignPhase('sent', [], true), 'awaiting_borrower', 'no recipients yet → awaiting_borrower');

// --- waitingOn: the lowest routing order not yet done ---
{
  const w = waitingOn(borrowersDoneAdminPending, 'awaiting_countersign');
  ok(w && w.role === 'admin', 'waitingOn returns the admin when borrowers done');
}
{
  const w = waitingOn(borrowerSent, 'awaiting_borrower');
  ok(w && Number(w.routingOrder) === 1, 'waitingOn returns an order-1 recipient first');
}
{
  // co_borrower delivered (viewing) but not signed → still the next waited-on if
  // borrower already signed.
  const recs = [
    { role: 'borrower', name: 'A', routingOrder: 1, status: 'completed' },
    { role: 'co_borrower', name: 'B', routingOrder: 1, status: 'delivered' },
  ];
  const w = waitingOn(recs, 'awaiting_borrower');
  eq(w && w.name, 'B', 'waitingOn skips the signed borrower to the pending co-borrower');
}
eq(waitingOn(borrowersDoneAdminPending, 'completed'), null, 'no waiting-on when completed');
eq(waitingOn([], 'draft'), null, 'no waiting-on when draft');
eq(waitingOn(borrowerSent, 'declined'), null, 'no waiting-on when declined');

console.log(`\n✓ esign tracking: ${n} assertions passed`);
