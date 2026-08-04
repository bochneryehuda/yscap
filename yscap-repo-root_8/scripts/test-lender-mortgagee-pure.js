'use strict';
/*
 * The insurance/title mortgagee-address check recognizes the RCN servicer notice
 * address (Elite Commercial Servicing) as OURS — but only when the file's note buyer
 * is actually RCN (owner-directed 2026-08-04, #18 follow-up). PILOT itself requests
 * that address on an RCN vendor order (lib/orders.js), so a returned RCN binder must
 * not raise a spurious "unrecognized mortgagee address" nudge. Non-RCN files are
 * unchanged: the Brooklyn address is ours, a stray Richmond address is not.
 */
const assert = require('assert');
const L = require('../src/lib/underwriting/lender');
const { isRcnNoteBuyer } = require('../src/lib/conditions/field-registry');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

const BROOKLYN = 'YS CAPITAL GROUP ISAOA/ATIMA, 5 New Monrose Ave #Bsmt, Brooklyn, NY 11211';
const RCN = 'YS Capital Group, ISAOA ATIMA, c/o Elite Commercial Servicing, LLC, PO Box 15126, Richmond, VA 23227-0526';
const RCN_BOXONLY = 'YS Capital Group ISAOA ATIMA PO Box 15126 Richmond VA 23227-0526';
const OTHER_RICHMOND = 'YS Capital Group ISAOA ATIMA 100 Main St Richmond VA 23230'; // a stranger's Richmond address

/* 1) The standard Brooklyn clause is ours, RCN flag or not (regression). */
assert.equal(L.clauseAddressState(BROOKLYN), 'ours', 'the Brooklyn clause is ours');
assert.equal(L.clauseAddressState(BROOKLYN, { rcn: true }), 'ours', 'Brooklyn is ours even on an RCN file');
ok('the standard Brooklyn mortgagee address is always recognized as ours');

/* 2) The RCN servicer address is UNRECOGNIZED on a non-RCN file (the old behavior —
      a Richmond address on a Blue Lake file really would be a stranger's). */
assert.equal(L.clauseAddressState(RCN), 'present', 'the RCN address is "present" (unrecognized) without the rcn flag');
ok('the Elite Commercial Servicing address is NOT recognized on a non-RCN file');

/* 3) On an RCN file the same address reads as OURS — no spurious nudge. */
assert.equal(L.clauseAddressState(RCN, { rcn: true }), 'ours', 'the RCN servicer address is ours on an RCN file');
assert.equal(L.clauseAddressState(RCN_BOXONLY, { rcn: true }), 'ours', 'the PO-box form is recognized on an RCN file');
assert.equal(L.clauseHasAddress(RCN, { rcn: true }), true, 'clauseHasAddress recognizes the RCN address with the flag');
assert.equal(L.clauseHasAddress(RCN, {}), false, 'clauseHasAddress does NOT recognize the RCN address without the flag');
ok('#18 follow-up: the RCN servicer address reads as ours ONLY on an RCN file');

/* 4) A DIFFERENT Richmond address is never mistaken for the servicer, even on an RCN
      file — loss notices to a stranger must still be flagged. */
assert.equal(L.hasRcnServicerAddress(OTHER_RICHMOND), false, 'a stranger\'s Richmond address is not the servicer');
assert.equal(L.clauseAddressState(OTHER_RICHMOND, { rcn: true }), 'present', 'a stranger\'s Richmond address is still flagged on an RCN file');
assert.equal(L.hasRcnServicerAddress(RCN), true, 'the real servicer address is recognized');
assert.equal(L.hasRcnServicerAddress(''), false, 'empty text is not the servicer address');
// A stranger whose STREET NUMBER contains 15126 in Richmond 23227 must NOT read as
// the servicer — the box is always written "PO Box 15126", so a bare street number
// with those digits is not a match (pre-merge audit low-severity false positive).
const STRANGER_15126 = 'YS Capital Group ISAOA ATIMA 15126 Forest Hill Ave Richmond VA 23227';
assert.equal(L.hasRcnServicerAddress(STRANGER_15126), false, 'a street number containing 15126 is not the PO box');
assert.equal(L.clauseAddressState(STRANGER_15126, { rcn: true }), 'present', 'a stranger at 15126-something is still flagged on an RCN file');
ok('a different Richmond address (even one with 15126 in the street number) is never mistaken for the servicer');

/* 5) The RCN detection agrees with the order-clause side (one shared helper). */
for (const s of ['RCN', 'RCN Capital', 'RCN Capital, LLC']) assert.ok(isRcnNoteBuyer(s), `RCN detected: ${s}`);
assert.ok(!isRcnNoteBuyer('Blue Lake') && !isRcnNoteBuyer(''), 'non-RCN buyers are not RCN');
ok('the note-buyer RCN detection is the shared field-registry helper');

console.log(`\nAll lender mortgagee-address checks passed (${n}).`);
process.exit(0);
