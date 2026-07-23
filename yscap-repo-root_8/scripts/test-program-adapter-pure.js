'use strict';
/**
 * R6.5 — pure tests for the program adapter. Guarantees: the adapter reads the
 * frozen engine's status/reasons/sizing verbatim (never re-derives a number),
 * classifies MANUAL as a STOP until approved, treats a stale registration as
 * STALE, and never lets an unknown/ERROR engine status pass.
 */
const assert = require('assert');
const pa = require('../src/lib/underwriting/program-adapter');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const eligibleQuote = {
  program: 'gold', programLabel: 'Gold Standard', productLabel: 'Gold Standard', status: 'ELIGIBLE',
  eligible: true, noteRate: 0.1099, liquidityRequired: 55000,
  reasons: [{ level: 'INFO', msg: 'Priced on tier 2.' }],
  sizing: { totalLoan: 465000, initialAdvance: 365000, rehabHoldback: 100000, financedReserve: 0, downPayment: 40000, monthlyPayment: 4200 },
  caps: { maxLoan: 3000000, minFico: 660, maxAcqLtv: 0.9, maxArvLtv: 0.75, maxLtc: 0.9 },
};

// --- ELIGIBLE passes through unchanged ---
let d = pa.adaptQuote(eligibleQuote);
assert.strictEqual(d.engineStatus, 'ELIGIBLE');
assert.strictEqual(d.wholeLoanStatus, 'ELIGIBLE');
assert.strictEqual(d.sizing.totalLoan, 465000, 'sizing read verbatim from the engine');
assert.strictEqual(d.noteRate, 0.1099, 'note rate read verbatim');
assert.strictEqual(d.caps.maxLtc, 0.9);
assert.strictEqual(d.manualReasons.length, 0);
ok('an ELIGIBLE engine quote adapts to ELIGIBLE with sizing/rate/caps read verbatim');

// --- MANUAL is a STOP until approved ---
const manualQuote = { ...eligibleQuote, status: 'MANUAL', eligible: true,
  reasons: [{ level: 'MANUAL', msg: 'Assignment fee over cap — needs review.' }, { level: 'INFO', msg: 'x' }] };
d = pa.adaptQuote(manualQuote, { manualApproved: false });
assert.strictEqual(d.wholeLoanStatus, 'MANUAL_PENDING', 'MANUAL not approved → pending (a stop)');
assert.deepStrictEqual(d.manualReasons, ['Assignment fee over cap — needs review.'], 'the MANUAL reason is surfaced');
d = pa.adaptQuote(manualQuote, { manualApproved: true });
assert.strictEqual(d.wholeLoanStatus, 'MANUAL_APPROVED', 'an approved MANUAL is issuable');
ok('a MANUAL engine quote is a STOP (MANUAL_PENDING) until explicitly approved');

// --- INELIGIBLE surfaces the blocking reasons ---
const inelQuote = { ...eligibleQuote, status: 'INELIGIBLE', eligible: false,
  reasons: [{ level: 'INELIGIBLE', msg: 'FICO below minimum.' }] };
d = pa.adaptQuote(inelQuote);
assert.strictEqual(d.wholeLoanStatus, 'INELIGIBLE');
assert.deepStrictEqual(d.blockingReasons, ['FICO below minimum.']);
assert.strictEqual(d.eligible, false);
ok('an INELIGIBLE engine quote adapts to INELIGIBLE with the blocking reason surfaced');

// --- a pricing ERROR is never issuable ---
d = pa.adaptQuote({ status: 'ERROR', reasons: [{ level: 'INELIGIBLE', msg: 'pricing error' }] });
assert.strictEqual(d.engineStatus, 'INELIGIBLE', 'ERROR maps to INELIGIBLE');
assert.strictEqual(d.wholeLoanStatus, 'INELIGIBLE');
ok('a pricing ERROR is treated as INELIGIBLE (never issuable)');

// --- an unknown/absent engine status never passes ---
d = pa.adaptQuote({ status: undefined, reasons: [] });
assert.strictEqual(d.engineStatus, null);
assert.strictEqual(d.wholeLoanStatus, 'NOT_READY', 'unknown status → NOT_READY, never a pass');
ok('an unknown/absent engine status classifies as NOT_READY (never passes)');

// --- fromRegistration reads the stored quote + honors reg.stale ---
const reg = { id: 'reg-1', program: 'gold', stale: true, is_manual: false, quote: eligibleQuote };
d = pa.fromRegistration(reg);
assert.strictEqual(d.wholeLoanStatus, 'STALE', 'a stale registration classifies STALE even on an ELIGIBLE quote');
assert.strictEqual(d.sizing.totalLoan, 465000, 'the registered sizing is read, not re-priced');
d = pa.fromRegistration({ ...reg, stale: false });
assert.strictEqual(d.wholeLoanStatus, 'ELIGIBLE', 'a current registration classifies on its quote');
ok('fromRegistration reads the stored engine quote and honors the stale flag (no re-price)');

// --- data conflict / not-ready flow through the classifier ---
d = pa.adaptQuote(eligibleQuote, { conflict: true });
assert.strictEqual(d.wholeLoanStatus, 'DATA_CONFLICT', 'a source conflict overrides an ELIGIBLE quote');
d = pa.adaptQuote(eligibleQuote, { missingRequired: true });
assert.strictEqual(d.wholeLoanStatus, 'NOT_READY');
ok('a data conflict / missing required fact overrides an ELIGIBLE engine quote');

// --- topReason picks the most severe ---
d = pa.adaptQuote(manualQuote);
assert.strictEqual(d.topReason.level, 'MANUAL', 'topReason is the most severe engine reason');
ok('topReason surfaces the most severe engine reason');


// --- fix 2026-07-23: an unknown/absent engine status is NEVER eligible ---
d = pa.adaptQuote({ status: 'SOMETHING_NEW' });
assert.strictEqual(d.eligible, false, 'an unrecognized engine status is not eligible');
d = pa.adaptQuote({});
assert.strictEqual(d.eligible, false, 'an absent engine status is not eligible');
d = pa.adaptQuote(null);
assert.strictEqual(d.eligible, false, 'a null quote is not eligible');
ok('eligible fails safe on unknown/absent/null engine status');

console.log(`\nR6.5 program-adapter pure — ${passed} checks passed`);
