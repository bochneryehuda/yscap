'use strict';
/**
 * Track-record / experience condition ADVISORY signal (IG-W10, owner-directed 2026-07-24).
 *
 * The experience condition (rtl_p3_reo — "REO / experience sheet completed & verified")
 * asks the team to confirm the borrower's claimed real-estate experience against the
 * uploaded track record. PILOT NEVER signs this condition off itself — a human always
 * clears a Condition Center condition (the owner-directed reversal). Instead PILOT lays an
 * ADVISORY on top of the human layer (pilot-advice-engine), telling the processor whether
 * the file's REGISTERED experience requirement is fully VERIFIED against the track record.
 * Advisory only — this clears nothing and blocks nothing.
 *
 * "PILOT confirmed the experience" is the SAME strict, provable state the sign-off gate
 * uses (experience.js syncExperienceChecklistForApplication `met`), reused here 1:1 so the
 * advisory can never disagree with the gate:
 *   - the file's experience REQUIREMENT is the CURRENT registered product's experience
 *     (flips / holds / ground-up), falling back to the application's claim when nothing is
 *     registered yet — exactly what the sign-off gate reads; AND
 *   - the required deals are each MET by the file's VERIFIED track-record deals in the
 *     frozen 3-year exit window, co-borrower summed (countBorrowersExperience verifiedOnly).
 *
 * So "ready" only ever fires once the required experience is actually VERIFIED; an
 * unverified or short track record advises "not ready" (never a false "ready"). A file with
 * NO experience requirement has nothing to verify — the advisory returns not-applicable and
 * PILOT lays no stamp. There is no "dispute" path: a verification shortfall is the ABSENCE
 * of a (human) verification step, not positive evidence the experience is wrong, so PILOT
 * never disputes a signed-off experience condition (the sign-off sync already reopens one
 * whose verified experience has genuinely dropped). Never throws.
 */
const {
  countBorrowersExperience, fileBorrowerIds, requestedFromApp,
  hasRequirement, requirementMet,
} = require('../experience');

function int(v) { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : 0; }

/**
 * Is the file's REGISTERED experience requirement fully VERIFIED against the track record?
 * @returns {Promise<{hasRequirement:boolean, verifiedMet:boolean, complete:boolean}>}
 *   hasRequirement=false → not applicable (no experience required on this file).
 */
async function experienceCompleteness(client, appId) {
  const out = { hasRequirement: false, verifiedMet: false, complete: false };
  if (!appId) return out;
  try {
    const app = (await client.query(
      `SELECT id, borrower_id, co_borrower_id,
              requested_exp_flips, requested_exp_holds, requested_exp_ground
         FROM applications WHERE id=$1`, [appId])).rows[0];
    if (!app) return out;

    // APPLICABILITY is decided on the application's CLAIM — exactly like the sign-off gate
    // (experience.js: notApplicable = !hasRequirement(requestedFromApp(app))). When NO
    // experience is claimed on the file there is nothing to verify, so PILOT lays no
    // advisory (mirrors the gate auto-satisfying a not-applicable experience condition).
    const required = requestedFromApp(app);
    out.hasRequirement = hasRequirement(required);
    if (!out.hasRequirement) return out;   // nothing claimed → not applicable

    // The THRESHOLD PILOT verifies against = the SAME one the sign-off gate's `met` uses:
    // the CURRENT registered product's experience, falling back to the application's claim
    // when nothing is registered yet (in that pre-registration state the gate blocks
    // sign-off anyway, so the fallback is never the effective gate).
    let gateNeed = required;
    try {
      const cur = await client.query(
        `SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
      if (cur.rows[0]) {
        const pin = cur.rows[0].inputs || {};
        gateNeed = { flips: int(pin.expFlips), holds: int(pin.expHolds), ground: int(pin.expGround) };
      }
    } catch (_) { /* best-effort — fall back to the application claim */ }

    // VERIFIED experience for the FILE = primary borrower + co-borrower, summed, in the
    // frozen 3-year exit window (REUSES experience.js — never re-derived).
    const verified = await countBorrowersExperience(fileBorrowerIds(app), client, { verifiedOnly: true });
    out.verifiedMet = requirementMet(verified, gateNeed);
    out.complete = out.verifiedMet;
  } catch (e) {
    console.error('[experience-advisory] experienceCompleteness', appId, e && e.message);
  }
  return out;
}

module.exports = { experienceCompleteness };
