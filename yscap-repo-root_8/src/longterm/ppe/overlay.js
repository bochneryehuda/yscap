'use strict';
/**
 * LT PPE — THE OVERLAY-WITH-REASON CLASSIFIER (owner D29, 2026-08-17): "our advanced facts are an
 * OVERLAY ON TOP OF Lender Price — LP often does not even SEE them (it does not know a property is
 * vacant or rural), so our matrix can OVERRIDE LP's verdict — but ONLY WITH A STATED REASON."
 *
 * The problem this solves for the E3 agreement gate: the parity comparator scores an
 * our-ineligible / LP-eligible disagreement as a `eligibility_mismatch` defect. That is CORRECT when we
 * decline on a fact LP can also see (FICO, LTV, DSCR, loan amount, property type, state PPP) — a genuine
 * bug. But it is WRONG when we decline BECAUSE of an overlay-only fact LP cannot see: there the
 * disagreement is INTENTIONAL and expected, and counting it as a defect would make our agreement score
 * lie. So a divergence has to be classified into three buckets, not two:
 *   • AGREE            — our verdict matches LP's.
 *   • OVERLAY          — we (correctly) decline on an overlay-only fact, WITH a stated reason. Expected,
 *                        never a defect. This is the only legitimate way to disagree with LP.
 *   • DEFECT           — anything else: we decline on a fact LP CAN see (a real mismatch), OR we decline
 *                        on an overlay fact with NO stated reason (the HARD RULE violation — "only WITH a
 *                        reason"), OR we price something LP declines (an overlay can only make us STRICTER
 *                        than LP, never looser, so ours-eligible / LP-ineligible is always a defect).
 *
 * THE OVERLAY FACT SET IS GENERATED, NOT HAND-KEPT (CLAUDE.md build-rule #4): it is derived live from
 * advanced-facts.overlayOnlyKeys() (the `overlayOnly:true` registry). Add an overlay fact there and it
 * is recognized here for free; a fact whose cuts LP is later measured to enforce itself leaves the
 * overlay set on its own. Note `overlayOnly` is about ELIGIBILITY, not price: a fact Lender Price is
 * measured to PRICE (registry `lpPrices:true`, e.g. short-term rental) is still overlay-only here,
 * because pricing an adjustment is no evidence of enforcing a cut (task #82).
 *
 * SOURCE DISCIPLINE: this module classifies a divergence and enforces the reason requirement. It does
 * NOT decide WHICH scenarios an overlay declines (the specific numeric cuts — −5% LTV, 65% cap, DSCR
 * 1.15 — are the D27/D36 enforcement step, gated on confirming each from the matrix / LP live). It is
 * the mechanism those cuts plug into: an overlay rule emits `overlayDecline(fact, reason)`, and this
 * classifier keeps that reasoned disagreement out of the defect count.
 *
 * PURE: no DB, no network, no clock. LT-only; no RTL import.
 */

const { overlayOnlyKeys } = require('./advanced-facts');

// The overlay-only fact keys, derived from the advanced-facts registry (single source of truth).
const OVERLAY_FACTS = new Set(overlayOnlyKeys());

// True when a fact key is an OVERLAY-ONLY fact — i.e. one Lender Price cannot see. Null/unknown → false.
function isOverlayFact(key) { return OVERLAY_FACTS.has(String(key == null ? '' : key)); }

// A non-empty, human-meaningful reason string.
function hasReason(v) { return typeof v === 'string' && v.trim().length > 0; }

/**
 * Build an OVERLAY decline record — the shape an overlay rule emits so this classifier can recognize it
 * as an intentional, reasoned disagreement rather than a parity bug. THROWS on misuse (a decline that
 * claims to be an overlay MUST name a real overlay fact and carry a reason — the HARD RULE is enforced
 * at authoring time, not silently accepted and then flagged downstream):
 *   overlayDecline('occupancy', 'Vacant/Unleased ineligible for cash-out refi (Deephaven DSCR matrix)')
 * Returns { code, fact, reason, overlay:true, ...extra }. `code` defaults to `overlay_<fact>`.
 */
function overlayDecline(fact, reason, extra = {}) {
  const key = String(fact == null ? '' : fact);
  if (!isOverlayFact(key)) throw new Error(`overlay:not_an_overlay_fact:${key}`);
  if (!hasReason(reason)) throw new Error(`overlay:missing_reason:${key}`);
  return { code: (extra && extra.code) || `overlay_${key}`, ...extra, fact: key, reason: reason.trim(), overlay: true };
}

// Is a decline record an overlay decline that is authored CORRECTLY (overlay flag + real overlay fact +
// stated reason)? A decline that CLAIMS overlay:true but is missing a reason or names a non-overlay fact
// is deliberately NOT counted here — the caller reports it as an unreasoned/invalid overlay defect.
function isValidOverlayDecline(d) {
  return !!(d && d.overlay === true && isOverlayFact(d.fact) && hasReason(d.reason));
}

// Reasons of a valid overlay decline are the human-facing justification the owner requires.
function overlayReasonsOf(declines) {
  const list = Array.isArray(declines) ? declines : [];
  return list.filter(isValidOverlayDecline).map((d) => ({ fact: d.fact, reason: d.reason, code: d.code || null }));
}

// THE FINDING KIND a reasoned override is recorded under, and the ONE test for it. It lives HERE,
// beside the classifier that decides an override, rather than in the comparator, the ledger and the
// scoreboard separately — three copies of a string is how one of them stops agreeing that an override
// is an override, and every consumer of this kind has to make the SAME decision about it: an override
// is not agreement, not a mismatch, and not work anybody can do.
//
// `isOverlayFinding` reads the FINDING rather than a carried flag on the result, because a per-scenario
// result travels through a JSON store and a summarizer that have both dropped a boolean before.
const FINDING_KIND = 'eligibility_overlay';
function isOverlayFinding(f) { return !!f && f.kind === FINDING_KIND; }

const CLASS = {
  AGREE: 'agree',            // verdicts match — no divergence
  OVERLAY: 'overlay',        // we decline on an overlay-only fact, WITH a reason — expected, not a defect
  DEFECT: 'defect',          // a real parity defect (see `defect` sub-reason)
};

// Sub-reasons for a DEFECT, so the reviewer/scoreboard knows WHY a divergence is a bug.
const DEFECT = {
  ELIGIBILITY_MISMATCH: 'eligibility_mismatch',       // we decline on a fact LP can see too
  UNREASONED_OVERLAY: 'unreasoned_overlay',           // we decline on an overlay fact with NO stated reason
  OURS_ELIGIBLE_THEIRS_NOT: 'ours_eligible_theirs_ineligible', // LP declines, we price (overlays only tighten)
};

/**
 * Classify one eligibility divergence into AGREE / OVERLAY / DEFECT.
 *   { oursEligible:boolean, theirsEligible:boolean, ourDeclines:[{ overlay?, fact?, reason?, code? }] }
 * Returns { classification, defect?, overlayReasons:[], defectReasons:[], detail }.
 *   - overlayReasons: the stated reasons for a legitimate overlay divergence (empty otherwise).
 *   - defectReasons : the decline reasons that make it a defect (empty when AGREE/OVERLAY).
 * A divergence is an OVERLAY only when it is our-ineligible / LP-eligible AND EVERY one of our declines
 * is a valid overlay decline. A single non-overlay decline (or an overlay decline missing its reason)
 * makes the whole divergence a DEFECT — you cannot bury a real mismatch behind an overlay reason.
 */
function classifyEligibilityDivergence({ oursEligible, theirsEligible, ourDeclines } = {}) {
  const ours = oursEligible === true;
  const theirs = theirsEligible === true;
  const declines = Array.isArray(ourDeclines) ? ourDeclines : [];

  // Verdicts match → agreement (both eligible, or both ineligible).
  if (ours === theirs) {
    return { classification: CLASS.AGREE, overlayReasons: [], defectReasons: [], detail: `both ${ours ? 'eligible' : 'ineligible'}` };
  }

  // We price it, LP declines it. An overlay only ever makes us STRICTER than LP (we know a fact LP does
  // not), so it can never explain us being LOOSER. This is always a defect to investigate.
  if (ours && !theirs) {
    return {
      classification: CLASS.DEFECT,
      defect: DEFECT.OURS_ELIGIBLE_THEIRS_NOT,
      overlayReasons: [],
      defectReasons: ['we say eligible, Lender Price says ineligible — an overlay can only tighten, so this is a real divergence'],
      detail: 'ours eligible, Lender Price ineligible',
    };
  }

  // ours ineligible, LP eligible — the interesting case. Every decline must be a valid overlay decline
  // for this to be a legitimate, reasoned override of LP.
  const nonOverlay = declines.filter((d) => !(d && d.overlay === true));
  const claimedOverlayBad = declines.filter((d) => d && d.overlay === true && !isValidOverlayDecline(d));

  if (nonOverlay.length) {
    // We decline on at least one fact LP can also see → a real eligibility mismatch.
    return {
      classification: CLASS.DEFECT,
      defect: DEFECT.ELIGIBILITY_MISMATCH,
      overlayReasons: overlayReasonsOf(declines),
      defectReasons: nonOverlay.map((d) => (d && (d.reason || d.code)) || 'ineligible (no reason)'),
      detail: 'we decline on a fact Lender Price prices on',
    };
  }

  // No declines at all, or an overlay decline that is tagged but lacks a stated reason (or names a
  // non-overlay fact). The HARD RULE: an overlay may disagree with LP only WITH a reason — an
  // unreasoned override (including a silent one, with zero declines) is a defect, never a free overlay.
  if (declines.length === 0 || claimedOverlayBad.length) {
    return {
      classification: CLASS.DEFECT,
      defect: DEFECT.UNREASONED_OVERLAY,
      overlayReasons: overlayReasonsOf(declines),
      defectReasons: declines.length === 0
        ? ['we say ineligible, Lender Price says eligible, with no stated reason to override LP']
        : claimedOverlayBad.map((d) => `overlay decline on '${(d && d.fact) || '?'}' has no stated reason`),
      detail: declines.length === 0 ? 'override of Lender Price with no stated reason' : 'overlay divergence without a stated reason',
    };
  }

  // Every decline is a valid overlay decline → an intentional, reasoned override of Lender Price.
  return {
    classification: CLASS.OVERLAY,
    overlayReasons: overlayReasonsOf(declines),
    defectReasons: [],
    detail: `overlay override: ${declines.map((d) => d.fact).join(', ')}`,
  };
}

module.exports = {
  OVERLAY_FACTS,
  FINDING_KIND,
  isOverlayFinding,
  CLASS,
  DEFECT,
  isOverlayFact,
  overlayDecline,
  isValidOverlayDecline,
  overlayReasonsOf,
  classifyEligibilityDivergence,
};
