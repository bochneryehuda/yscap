'use strict';
/**
 * Pure offline test for the LT PPE overlay-with-reason classifier (src/longterm/ppe/overlay.js), D29.
 * Proves: our matrix may disagree with Lender Price ONLY on an overlay-only fact LP cannot see, and ONLY
 * with a stated reason; every other divergence is a defect. Ties the overlay fact set to the real
 * advanced-facts registry so the two can never drift.  node scripts/test-lt-ppe-overlay.js
 */

const assert = require('assert');
const O = require('../src/longterm/ppe/overlay');
const { overlayOnlyKeys } = require('../src/longterm/ppe/advanced-facts');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const throws = (fn, m) => { assert.throws(fn); n += 1; ok(true, m); };

// --- the overlay fact set is GENERATED from advanced-facts, never hand-kept ---
{
  const reg = overlayOnlyKeys();
  ok(reg.length > 0, 'the advanced-facts registry has overlay-only facts');
  for (const k of reg) ok(O.isOverlayFact(k), `registry overlay fact '${k}' is recognized by overlay.isOverlayFact`);
  eq(O.OVERLAY_FACTS.size, reg.length, 'OVERLAY_FACTS mirrors the registry exactly (no drift)');
  eq(O.isOverlayFact('occupancy'), true, 'occupancy is an overlay fact');
  eq(O.isOverlayFact('rural_property'), true, 'rural_property is an overlay fact');
  // a fact LP CAN see is not an overlay fact
  eq(O.isOverlayFact('ltv'), false, 'ltv (LP-visible) is not an overlay fact');
  eq(O.isOverlayFact('fico'), false, 'fico (LP-visible) is not an overlay fact');
  eq(O.isOverlayFact(null), false, 'null is not an overlay fact (never throws)');
  eq(O.isOverlayFact('nonsense'), false, 'an unknown key is not an overlay fact');
}

// --- overlayDecline enforces the HARD RULE at authoring time ---
{
  const d = O.overlayDecline('occupancy', 'Vacant/Unleased ineligible for cash-out refi (Deephaven DSCR matrix)');
  eq(d.overlay, true, 'overlayDecline stamps overlay:true');
  eq(d.fact, 'occupancy', 'overlayDecline records the fact');
  eq(d.code, 'overlay_occupancy', 'overlayDecline defaults code to overlay_<fact>');
  ok(d.reason.length > 0, 'overlayDecline carries the reason');
  ok(O.isValidOverlayDecline(d), 'a well-formed overlay decline is valid');

  const d2 = O.overlayDecline('rural_property', 'Rural max 65% LTV', { code: 'dhvn_rural', citation: 'matrix' });
  eq(d2.code, 'dhvn_rural', 'an explicit code wins');
  eq(d2.citation, 'matrix', 'extra fields pass through');

  throws(() => O.overlayDecline('ltv', 'not an overlay fact'), 'overlayDecline THROWS on a non-overlay fact');
  throws(() => O.overlayDecline('occupancy', ''), 'overlayDecline THROWS on an empty reason');
  throws(() => O.overlayDecline('occupancy', '   '), 'overlayDecline THROWS on a whitespace-only reason');
}

// --- isValidOverlayDecline rejects malformed overlay claims ---
{
  eq(O.isValidOverlayDecline({ overlay: true, fact: 'occupancy', reason: 'x' }), true, 'valid overlay decline');
  eq(O.isValidOverlayDecline({ overlay: true, fact: 'occupancy' }), false, 'overlay flag but no reason → invalid');
  eq(O.isValidOverlayDecline({ overlay: true, fact: 'ltv', reason: 'x' }), false, 'overlay flag on a non-overlay fact → invalid');
  eq(O.isValidOverlayDecline({ fact: 'occupancy', reason: 'x' }), false, 'no overlay flag → not an overlay decline');
  eq(O.isValidOverlayDecline(null), false, 'null → invalid (never throws)');
}

// --- classifyEligibilityDivergence: the three buckets ---
{
  // AGREE — both eligible
  let r = O.classifyEligibilityDivergence({ oursEligible: true, theirsEligible: true, ourDeclines: [] });
  eq(r.classification, O.CLASS.AGREE, 'both eligible → agree');
  // AGREE — both ineligible
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: false, ourDeclines: [{ code: 'x', reason: 'y' }] });
  eq(r.classification, O.CLASS.AGREE, 'both ineligible → agree');

  // OVERLAY — we decline on an overlay fact, WITH a reason; LP prices it
  const ovl = O.overlayDecline('occupancy', 'Vacant/Unleased ineligible for cash-out refi');
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: [ovl] });
  eq(r.classification, O.CLASS.OVERLAY, 'reasoned overlay decline vs LP-eligible → OVERLAY (not a defect)');
  eq(r.defectReasons.length, 0, 'an overlay divergence has no defect reasons');
  eq(r.overlayReasons.length, 1, 'the overlay reason is surfaced');
  eq(r.overlayReasons[0].fact, 'occupancy', 'the overlay reason names the fact');

  // OVERLAY — multiple overlay declines, all reasoned
  const ovl2 = O.overlayDecline('rural_property', 'Rural max 65% LTV');
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: [ovl, ovl2] });
  eq(r.classification, O.CLASS.OVERLAY, 'all-overlay, all-reasoned → OVERLAY');
  eq(r.overlayReasons.length, 2, 'both overlay reasons surfaced');

  // DEFECT — we decline on a fact LP CAN see (a real mismatch)
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: [{ code: 'dhvn_max_ltv', reason: 'ltv max 80 exceeded' }] });
  eq(r.classification, O.CLASS.DEFECT, 'declining on an LP-visible fact → DEFECT');
  eq(r.defect, O.DEFECT.ELIGIBILITY_MISMATCH, 'sub-reason is eligibility_mismatch');
  ok(r.defectReasons.length === 1, 'the defect reason is surfaced');

  // DEFECT — you cannot bury a real mismatch behind an overlay reason
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: [ovl, { code: 'dhvn_max_ltv', reason: 'ltv max 80 exceeded' }] });
  eq(r.classification, O.CLASS.DEFECT, 'an overlay decline PLUS a real mismatch → DEFECT');
  eq(r.defect, O.DEFECT.ELIGIBILITY_MISMATCH, 'the mismatch is not hidden by the overlay');

  // DEFECT — an overlay decline with NO stated reason (the HARD RULE violation)
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: [{ overlay: true, fact: 'occupancy' }] });
  eq(r.classification, O.CLASS.DEFECT, 'overlay decline with no reason → DEFECT');
  eq(r.defect, O.DEFECT.UNREASONED_OVERLAY, 'sub-reason is unreasoned_overlay');

  // DEFECT — an overlay decline naming a non-overlay fact
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: [{ overlay: true, fact: 'ltv', reason: 'x' }] });
  eq(r.classification, O.CLASS.DEFECT, 'overlay flag on a non-overlay fact → DEFECT');
  eq(r.defect, O.DEFECT.UNREASONED_OVERLAY, 'a bogus overlay claim is unreasoned_overlay');

  // DEFECT — ours eligible, LP ineligible (an overlay can only TIGHTEN, never loosen)
  r = O.classifyEligibilityDivergence({ oursEligible: true, theirsEligible: false, ourDeclines: [] });
  eq(r.classification, O.CLASS.DEFECT, 'ours-eligible / LP-ineligible → DEFECT (overlay only tightens)');
  eq(r.defect, O.DEFECT.OURS_ELIGIBLE_THEIRS_NOT, 'sub-reason is ours_eligible_theirs_ineligible');
}

// --- defensive: missing/garbage input never throws ---
{
  let r = O.classifyEligibilityDivergence();
  eq(r.classification, O.CLASS.AGREE, 'no input reads as both-ineligible → agree (fails safe, never throws)');
  r = O.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true });
  eq(r.classification, O.CLASS.DEFECT, 'ineligible with no declines array vs LP-eligible → DEFECT (nothing to justify it)');
  eq(r.defect, O.DEFECT.UNREASONED_OVERLAY, 'no declines to justify the override → unreasoned_overlay');
}

console.log(`ok - lt ppe overlay-with-reason classifier (${n} assertions)`);
