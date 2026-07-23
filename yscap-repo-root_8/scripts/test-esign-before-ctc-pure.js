'use strict';
/**
 * PURE test — the send-before-clear-to-close tiering + disposition
 * (src/lib/esign/gate-disposition.js). No DB / no deps, always runs.
 *
 * Proves the owner's rule (2026-07-23): the four term-sheet-correctness
 * prerequisites are a HARD FLOOR an exception can NEVER waive; only the remaining
 * clear-to-close readiness (the internal appraisal-review sign-off) is waivable,
 * and only by an APPROVED exception once the floor is met.
 *
 *   node scripts/test-esign-before-ctc-pure.js
 */
const R = require('path').resolve(__dirname, '..');
const { gateDisposition, tierOf } = require(R + '/src/lib/esign/gate-disposition');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const APPRAISAL_BACK = 'rtl_cond_appraisaldocs';
const APPRAISAL_REVIEW = 'rtl_p3_apprreview';
const PRODUCT_PRICING = 'rtl_p1_product';
const b = (code) => ({ code, label: code, reason: 'x' });

// ---- tierOf: the four floor codes + fail-closed default ----
ok(tierOf(APPRAISAL_BACK) === 'floor', 'appraisal-back is floor');
ok(tierOf(PRODUCT_PRICING) === 'floor', 'product & pricing is floor');
ok(tierOf('expected_closing') === 'floor', 'closing date is floor');
ok(tierOf('registration_stale') === 'floor', 'stale registration is floor');
ok(tierOf('manual_approval') === 'floor', 'manual-approval is floor');
ok(tierOf('registration') === 'floor', 'unreadable registration is floor');
ok(tierOf(APPRAISAL_REVIEW) === 'ctc', 'appraisal-review is the (only) waivable ctc tier');
ok(tierOf('some_future_blocker') === 'floor', 'unknown code fails CLOSED to floor (never silently waivable)');

// ---- fully green ----
let d = gateDisposition([], null);
ok(d.ready === true && d.sendAllowed === true && d.floorMet === true, 'nothing outstanding → ready + sendAllowed');
ok(d.waivedByException === false && d.canRequestException === false, 'ready → no exception needed');

// ---- only the waivable review outstanding, no exception ----
d = gateDisposition([b(APPRAISAL_REVIEW)], null);
ok(d.ready === false && d.sendAllowed === false, 'only review outstanding → not sendable without an exception');
ok(d.floorMet === true, 'only review outstanding → floor IS met');
ok(d.ctcOutstanding.length === 1 && d.floorOutstanding.length === 0, 'review classified as ctc-tier');
ok(d.canRequestException === true, 'floor met + not ready + no exception → an exception may be requested');

// ---- same, with an APPROVED exception → sendable, floor still shown enforced ----
d = gateDisposition([b(APPRAISAL_REVIEW)], { status: 'approved' });
ok(d.sendAllowed === true && d.waivedByException === true, 'approved exception waives the review → sendable');
ok(d.canRequestException === false, 'already approved → cannot re-request');

// ---- a FLOOR blocker + an approved exception → STILL not sendable (floor is never waived) ----
d = gateDisposition([b(APPRAISAL_BACK)], { status: 'approved' });
ok(d.sendAllowed === false, 'approved exception can NOT waive the floor');
ok(d.floorMet === false && d.floorOutstanding.length === 1, 'appraisal-back is an outstanding floor blocker');
ok(d.canRequestException === false, 'floor unmet → cannot request an exception');

// ---- floor blocker + waivable blocker + approved exception → still blocked by floor ----
d = gateDisposition([b(PRODUCT_PRICING), b(APPRAISAL_REVIEW)], { status: 'approved' });
ok(d.sendAllowed === false, 'a floor blocker present → not sendable even with the review waived');
ok(d.floorOutstanding.length === 1 && d.ctcOutstanding.length === 1, 'both tiers surfaced');

// ---- a PENDING (requested) exception does not yet permit sending ----
d = gateDisposition([b(APPRAISAL_REVIEW)], { status: 'requested' });
ok(d.sendAllowed === false, 'a pending (requested) exception does not permit sending');
ok(d.canRequestException === false, 'a pending request blocks a duplicate request');

// ---- a DENIED exception behaves like none (floor met → may re-request) ----
d = gateDisposition([b(APPRAISAL_REVIEW)], { status: 'denied' });
ok(d.sendAllowed === false, 'a denied exception does not permit sending');
ok(d.canRequestException === true, 'a denied exception may be re-requested once floor is met');

// ---- a WITHDRAWN/CLEARED exception behaves like none ----
ok(gateDisposition([b(APPRAISAL_REVIEW)], { status: 'withdrawn' }).canRequestException === true, 'withdrawn → may request again');
ok(gateDisposition([b(APPRAISAL_REVIEW)], { status: 'cleared' }).sendAllowed === false, 'a cleared (archived) approval no longer permits sending');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
