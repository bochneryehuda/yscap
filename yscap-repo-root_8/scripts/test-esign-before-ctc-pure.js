'use strict';
/**
 * PURE test — the send-before-clear-to-close tiering + disposition
 * (src/lib/esign/gate-disposition.js). No DB / no deps, always runs.
 *
 * Proves the owner's rules:
 *   · 2026-07-23 — the four term-sheet-correctness prerequisites are the FLOOR
 *     tier; the readiness (ctc) tier is the appraisal-review sign-off. A LEGACY
 *     approval (no waived_codes) waives exactly the ctc tier — never the floor.
 *   · 2026-07-24 — an exception can be REQUESTED whenever the package can't
 *     send (floor met or NOT), and an approval names EXACTLY which blockers it
 *     waives (waived_codes + decided_gate). Everything not waived still blocks;
 *     a waiver only holds while the blocker still means what was approved (same
 *     reason), so a post-approval change fails CLOSED.
 *
 *   node scripts/test-esign-before-ctc-pure.js
 */
const R = require('path').resolve(__dirname, '..');
const { gateDisposition, tierOf, waiveWarningOf } = require(R + '/src/lib/esign/gate-disposition');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const APPRAISAL_BACK = 'rtl_cond_appraisaldocs';
const APPRAISAL_REVIEW = 'rtl_p3_apprreview';
const PRODUCT_PRICING = 'rtl_p1_product';
const b = (code, reason = 'x') => ({ code, label: code, reason });
// An APPROVED exception with explicit per-item waivers, pinned to the blockers
// it was decided on (the decide route stores decided_gate from the LIVE gate).
const approvedWaiving = (codes, decidedOutstanding) => ({
  status: 'approved',
  waived_codes: codes,
  decided_gate: { at: 't', outstanding: decidedOutstanding },
});

// ---- tierOf: the four floor codes + fail-closed default ----
ok(tierOf(APPRAISAL_BACK) === 'floor', 'appraisal-back is floor');
ok(tierOf(PRODUCT_PRICING) === 'floor', 'product & pricing is floor');
ok(tierOf('expected_closing') === 'floor', 'closing date is floor');
ok(tierOf('registration_stale') === 'floor', 'stale registration is floor');
ok(tierOf('manual_approval') === 'floor', 'manual-approval is floor');
ok(tierOf('registration') === 'floor', 'unreadable registration is floor');
ok(tierOf(APPRAISAL_REVIEW) === 'ctc', 'appraisal-review is the (only) default-waivable ctc tier');
ok(tierOf('some_future_blocker') === 'floor', 'unknown code fails CLOSED to floor (never silently default-waivable)');
ok(!!waiveWarningOf('registration_stale') && /stale/i.test(waiveWarningOf('registration_stale')), 'floor blockers carry a consequence warning');
ok(!!waiveWarningOf('some_future_blocker'), 'unknown floor code gets the generic warning (copy fails closed too)');

// ---- fully green ----
let d = gateDisposition([], null);
ok(d.ready === true && d.sendAllowed === true && d.floorMet === true, 'nothing outstanding → ready + sendAllowed');
ok(d.waivedByException === false && d.canRequestException === false, 'ready → no exception needed');

// ---- only the waivable review outstanding, no exception ----
d = gateDisposition([b(APPRAISAL_REVIEW)], null);
ok(d.ready === false && d.sendAllowed === false, 'only review outstanding → not sendable without an exception');
ok(d.floorMet === true, 'only review outstanding → floor IS met');
ok(d.ctcOutstanding.length === 1 && d.floorOutstanding.length === 0, 'review classified as ctc-tier');
ok(d.canRequestException === true, 'not ready + no exception → an exception may be requested');

// ---- REQUEST-ANYTIME (2026-07-24): floor NOT met still allows requesting ----
d = gateDisposition([b(APPRAISAL_BACK), b(APPRAISAL_REVIEW)], null);
ok(d.floorMet === false, 'appraisal-back outstanding → floor unmet');
ok(d.canRequestException === true, 'floor unmet no longer blocks REQUESTING an exception (owner 2026-07-24)');
d = gateDisposition([b('registration_stale', 'Pricing inputs changed — Term: 12 → 12 Months.')], null);
ok(d.canRequestException === true, 'a stuck system flag (stale registration) can be exception-requested right away');

// ---- LEGACY approval (no waived_codes): waives the ctc tier, floor enforced ----
d = gateDisposition([b(APPRAISAL_REVIEW)], { status: 'approved' });
ok(d.sendAllowed === true && d.waivedByException === true, 'legacy approval waives the review → sendable');
ok(d.outstanding[0].waived === true, 'legacy approval marks the review blocker waived');
ok(d.canRequestException === false, 'already sendable → nothing to request');
d = gateDisposition([b(APPRAISAL_BACK)], { status: 'approved' });
ok(d.sendAllowed === false, 'legacy approval can NOT waive the floor');
ok(d.floorMet === false && d.floorOutstanding.length === 1, 'appraisal-back is an outstanding floor blocker');
ok(d.canRequestException === true, 'legacy approval that does not cover the picture → a fresh request is allowed');
d = gateDisposition([b(PRODUCT_PRICING), b(APPRAISAL_REVIEW)], { status: 'approved' });
ok(d.sendAllowed === false, 'legacy: a floor blocker present → not sendable even with the review waived');
ok(d.floorOutstanding.length === 1 && d.ctcOutstanding.length === 1, 'both tiers surfaced');
ok(d.unwaivedOutstanding.length === 1 && d.unwaivedOutstanding[0].code === PRODUCT_PRICING, 'unwaived list names exactly what still blocks');

// ---- PER-ITEM waivers (2026-07-24): exactly the named codes are waived ----
// Waive the stale-registration flag (the owner's stuck-system case) while P&P
// stays required — "this one is waived, but you still need to re-register."
let out = [b('registration_stale', 'stale-r'), b(PRODUCT_PRICING, 'pp-r')];
d = gateDisposition(out, approvedWaiving(['registration_stale'], out));
ok(d.sendAllowed === false, 'waiving one blocker does not send while another is outstanding');
ok(d.outstanding.find((o) => o.code === 'registration_stale').waived === true, 'the named blocker is waived');
ok(d.unwaivedOutstanding.length === 1 && d.unwaivedOutstanding[0].code === PRODUCT_PRICING, 'the un-waived blocker still blocks');
ok(d.canRequestException === true, 'approved-but-insufficient → a fresh request may supersede');

// Waive EVERY outstanding blocker (incl. floor, explicitly) → sendable.
out = [b('registration_stale', 'stale-r'), b(APPRAISAL_REVIEW, 'rev-r')];
d = gateDisposition(out, approvedWaiving(['registration_stale', APPRAISAL_REVIEW], out));
ok(d.sendAllowed === true && d.waivedByException === true, 'explicitly waiving every outstanding blocker (floor included) → sendable');
ok(d.ready === false, 'still not "ready" — it sends only by exception');

// A FLOOR code is waivable ONLY by explicit naming — never implicitly.
out = [b(APPRAISAL_BACK, 'appr-r'), b(APPRAISAL_REVIEW, 'rev-r')];
d = gateDisposition(out, approvedWaiving([APPRAISAL_REVIEW], out));
ok(d.sendAllowed === false, 'un-named floor blocker still blocks under an explicit approval');
ok(d.outstanding.find((o) => o.code === APPRAISAL_BACK).waived === false, 'floor blocker not waived when not named');

// ---- FAIL-CLOSED pinning: the waiver dies if the blocker changed meaning ----
// Approved when the stale reason was the cosmetic echo; later the registration
// goes stale again for a REAL change (different reason) → NOT waived.
d = gateDisposition(
  [b('registration_stale', 'Pricing inputs changed — Loan amount: $500,000 → $600,000.')],
  approvedWaiving(['registration_stale'], [b('registration_stale', 'Pricing inputs changed — Term: 12 → 12 Months.')]));
ok(d.sendAllowed === false, 'a waived blocker that now fires for a DIFFERENT reason blocks again (fail closed)');
ok(d.outstanding[0].waived === false, 'the drifted blocker is not waived');
ok(d.canRequestException === true, 'the changed picture can be re-requested');

// A blocker that is NEW since the decision (not in decided_gate) is never waived
// even if its code somehow appears in waived_codes.
d = gateDisposition(
  [b('expected_closing', 'closing-r')],
  approvedWaiving(['expected_closing'], [b(APPRAISAL_REVIEW, 'rev-r')]));
ok(d.sendAllowed === false, 'a blocker that was not outstanding at decision time is not covered');

// Unchanged blockers stay waived when ONE of several was resolved meanwhile.
d = gateDisposition(
  [b(APPRAISAL_REVIEW, 'rev-r')],
  approvedWaiving([APPRAISAL_REVIEW, 'expected_closing'], [b(APPRAISAL_REVIEW, 'rev-r'), b('expected_closing', 'closing-r')]));
ok(d.sendAllowed === true, 'a waived blocker resolving on its own never un-permits the send');

// ---- a PENDING (requested) exception does not yet permit sending ----
d = gateDisposition([b(APPRAISAL_REVIEW)], { status: 'requested' });
ok(d.sendAllowed === false, 'a pending (requested) exception does not permit sending');
ok(d.canRequestException === false, 'a pending request blocks a duplicate request');

// ---- a DENIED exception behaves like none (may re-request) ----
d = gateDisposition([b(APPRAISAL_REVIEW)], { status: 'denied' });
ok(d.sendAllowed === false, 'a denied exception does not permit sending');
ok(d.canRequestException === true, 'a denied exception may be re-requested');

// ---- a WITHDRAWN/CLEARED exception behaves like none ----
ok(gateDisposition([b(APPRAISAL_REVIEW)], { status: 'withdrawn' }).canRequestException === true, 'withdrawn → may request again');
ok(gateDisposition([b(APPRAISAL_REVIEW)], { status: 'cleared' }).sendAllowed === false, 'a cleared (archived) approval no longer permits sending');
ok(gateDisposition([b(APPRAISAL_REVIEW)], { status: 'cleared', waived_codes: [APPRAISAL_REVIEW], decided_gate: { outstanding: [b(APPRAISAL_REVIEW)] } }).sendAllowed === false,
  'cleared status kills explicit waivers too (only status=approved counts)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
