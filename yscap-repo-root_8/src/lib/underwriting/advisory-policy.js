'use strict';
/**
 * AI FINDINGS ARE ADVISORY ONLY (owner-directed 2026-07-27; HARD RULE).
 *
 * THE DIRECTION, in the owner's words: "the entire AI findings section should be
 * advisory only, strictly advisory only … it should not hold you back from CTC …
 * should not hold you back from clearing your condition … should not hold you back
 * from sending out the terms package … it should really be advisory only for
 * anybody that wants to take a look on it. Till we don't feel more comfortable
 * with it we're not going to enforce it."
 *
 * So PILOT keeps FINDING everything it finds — same checks, same codes, same
 * severities (a fatal is still labelled fatal, and still looks like a dealbreaker
 * on the desk) — but NOTHING it finds may stop a human:
 *   • signing off ANY condition (incl. `underwriting_review_cleared` /
 *     `appraisal_review_cleared`),
 *   • clearing a file to close, or funding it,
 *   • issuing / exporting a term sheet, tape, MISMO or TPR package,
 *   • and it never appears in the "what's outstanding before clear-to-close" list
 *     as a BLOCKER (it appears in a separate, clearly-advisory list instead).
 *
 * ONE SWITCH, so re-enforcing later is an env change and not an archaeology
 * project: `AI_FINDINGS_ENFORCE=1` restores the previous gating everywhere this
 * module is consulted. Default (unset / anything else) = ADVISORY ONLY.
 *
 * Read at CALL time, never cached at require time, so a test can flip it and so a
 * restart is the only thing needed to change the posture.
 *
 * The DB-level backstops (db/154 appraisal guard, db/202 underwriting guard,
 * db/155 reopen-on-fatal) cannot read an env var, so db/332 retires those
 * triggers outright; re-running db/154/202/155 re-arms them if the switch is ever
 * flipped back. See db/332_ai_findings_advisory_only.sql.
 *
 * Pure + dependency-free (no pg, no config) so every consumer can require it.
 */

const ENV_KEY = 'AI_FINDINGS_ENFORCE';

/**
 * THE APPRAISAL REVIEW IS THE OWNER-DIRECTED EXCEPTION (2026-07-30) — it is ENFORCED.
 *
 * The owner's words: "double check and triple check all the findings that you find from the
 * XML appraisal should be on the appraisal findings page and that should be enforced and
 * everything should need to be signed off … you cannot clear this condition you cannot get a
 * CTC till you clear the appraisal findings."
 *
 * So the `appraisal_review_cleared` condition (and ONLY that condition — the document/
 * underwriting review stays advisory under the 2026-07-27 rule above) is a REAL gate again:
 *   • it cannot be signed off while a fatal appraisal finding is open,
 *   • it cannot be signed off until the As-Is value is confirmed on the file,
 *   • it counts as a real blocker in advancementBlockers, so no clear-to-close without it.
 * The deliberate way through remains the super-admin condition override (db/344) — never a
 * silent bypass.
 *
 * Kill switch: `APPRAISAL_FINDINGS_ENFORCE=0` drops the appraisal review back to advisory
 * (an env change, no deploy). Default (unset / anything else) = ENFORCED.
 */
const APPRAISAL_ENV_KEY = 'APPRAISAL_FINDINGS_ENFORCE';

/** True only when the owner has explicitly re-armed enforcement (AI_FINDINGS_ENFORCE=1). */
function enforcing() {
  return String(process.env[ENV_KEY] == null ? '' : process.env[ENV_KEY]).trim() === '1';
}

/** True in the default posture: PILOT advises, humans decide. */
function advisoryOnly() { return !enforcing(); }

/**
 * The APPRAISAL review gate (owner-directed 2026-07-30): enforced by default, regardless of
 * the AI_FINDINGS_ENFORCE switch. Only `APPRAISAL_FINDINGS_ENFORCE=0` turns it off.
 * Read at CALL time like everything else here.
 */
function appraisalReviewEnforced() {
  return String(process.env[APPRAISAL_ENV_KEY] == null ? '' : process.env[APPRAISAL_ENV_KEY]).trim() !== '0';
}

/**
 * Resolve the mode for one call site. `opts.enforce` (an explicit boolean) always
 * wins so a caller — or a test — can pin the behavior; otherwise the env decides.
 */
function enforceFor(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof o.enforce === 'boolean') return o.enforce;
  if (typeof o.advisoryOnly === 'boolean') return !o.advisoryOnly;
  return enforcing();
}

// The one sentence every advisory-only surface says, in the owner's plain language.
const ADVISORY_NOTE =
  'PILOT’s findings are advisory. Review them, but they do not hold up signing off a condition, '
  + 'clearing to close, funding, or sending a package.';

module.exports = { enforcing, advisoryOnly, enforceFor, appraisalReviewEnforced, ADVISORY_NOTE, ENV_KEY, APPRAISAL_ENV_KEY };
