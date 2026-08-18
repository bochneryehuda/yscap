'use strict';
/**
 * GROUND-UP CONSTRUCTION IS INSPECTED ON SITE — the one rule, in one place
 * (owner-directed 2026-08-18: "any kind of Ground Up construction project
 * should be defaulted to physical inspection. We don't allow using the
 * virtual … it should not allow you to set it up as virtual. It needs to be
 * set up as physical on Sitewire and follow the physical Trinity process.
 * This is for all other note buyers and investors other than Bluelake —
 * Bluelake follows their own process directly with TrustPoint, and we don't
 * touch that process.").
 *
 * PURE — no requires, no IO — like routing.js and trinity/eligibility.js,
 * and for the same recorded reason: a rule with two implementations drifts,
 * and the drifted one is the one that leaks. Four call sites consult it (a
 * source guard pins all four):
 *   1. the coordinator's Start-draw door (routes/sitewire.js) — a 'mobile'
 *      choice on a ground-up Sitewire file is refused 422;
 *   2. the live-property controls (orchestrator.updatePropertyControls) — the
 *      same refusal AFTER the property is pushed, so the rule cannot be undone
 *      from the desk;
 *   3. the birth push (orchestrator.pushFile) — a resolved 'mobile' method on
 *      a ground-up file is FORCED to 'traditional' (or parked when the
 *      partner's rule forbids physical — a genuine conflict is never silently
 *      overridden);
 *   4. the reconcile drift check — a ground-up property found VIRTUAL inside
 *      Sitewire itself raises a review + a warning email ("a Ground Up
 *      construction is not allowed on virtual draws — it follows the Trinity
 *      process").
 *
 * "NON-BLUELAKE" IS STRUCTURAL, NEVER A LENDER-STRING MATCH: Blue Lake is
 * platform === 'trustpoint' (routing.platformOf — its own header calls it the
 * ONE reader), and a handled-externally partner is 'external'. Only a
 * platform === 'sitewire' file is ours to police. `resolved === false` means
 * "we could not look up the routing" and the policy stands DOWN — a file we
 * cannot read must not be re-methoded on a guess (the same discipline
 * trinity/eligibility.js documents for the money side).
 *
 * The construction type comes from transforms.constructionType — the draw
 * side's own reader — never a fresh /ground/ regex.
 */

/**
 * @param {object} ctx { constructionType, platform, resolved }
 * @returns {'traditional'|null} the REQUIRED method, or null when the policy
 *          does not apply (not ground-up, not our platform, or unresolvable).
 */
function requiredMethodFor(ctx) {
  const c = ctx || {};
  if (c.resolved === false) return null;
  if (c.platform !== 'sitewire') return null;
  if (c.constructionType !== 'ground_up') return null;
  return 'traditional';
}

/** True exactly when choosing/holding 'mobile' would break the rule. */
function groundUpVirtualForbidden(ctx, method) {
  return requiredMethodFor(ctx) === 'traditional' && String(method || '') === 'mobile';
}

/** The plain-language refusal, one wording for every surface. */
function reasonPhysicalRequired() {
  return 'This is a ground-up construction project — it must be inspected ON SITE (physical). '
    + 'Virtual inspections are not available on ground-up builds: the physical inspection is '
    + 'ordered through Trinity, exactly like the other physical files.';
}

module.exports = { requiredMethodFor, groundUpVirtualForbidden, reasonPhysicalRequired };
