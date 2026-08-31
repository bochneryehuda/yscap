'use strict';
/**
 * LONG-TERM'S HALF OF THE SHARED PHOTO ID.
 *
 * Owner-directed 2026-08-31: *"If he uploads it on the long term, it should
 * share it to the short term. If it's uploaded to the short term, it should
 * share it to the long term. It's on the profiles and the borrower profile."*
 *
 * The rule itself lives in ONE place — `src/lib/profile-photo-id.js` — because
 * "a new government ID landed on this person" is a fact about a PERSON, and the
 * person record is the shared identity zone both products already read. This
 * file is the two things that rule cannot know without naming a `lt_*` table:
 *
 *   • WHERE Long-Term's own ID conditions are (`registerReopener`), so a
 *     long-term condition signed off against the old ID drops that sign-off the
 *     moment a different ID arrives — exactly as a short-term one always has.
 *
 *   • WHEN a long-term upload IS the person's ID (`adoptFromLoan`), which is the
 *     `lt_photo_id` condition and nothing else.
 *
 * ── WHY THE REGISTRATION EXISTS AT ALL ──────────────────────────────────────
 *
 * The shared module runs inside the LIVE short-term product, and RTL may never
 * name a Long-Term table — not in an import and not in raw SQL (the separation
 * gate's rule 7, which has no ledger escape in that direction, and is right not
 * to: the live product must not depend on the side build). So the shared module
 * cannot go looking for `lt_loans`. It asks instead, and this is the answer.
 *
 * Registering happens on REQUIRE, and this module is required by the Long-Term
 * router — which `src/server.js` already mounts. That is deliberately NOT a new
 * seam: the single permitted crossing in the whole back end is server.js
 * mounting the Long-Term router, and this rides on it rather than adding a
 * second require to server.js.
 *
 * A deployment with no Long-Term router mounted simply has no long-term
 * conditions to reopen, and the shared module reports which finders ran rather
 * than assuming both did.
 *
 * ── WHAT IS NOT DONE HERE, AND WHY ──────────────────────────────────────────
 *
 * `profile-links.js` reads the ID; this writes it. Neither decrypts anything and
 * neither touches a short-term condition directly — the reopen goes through the
 * shared module's own finder, so Long-Term never reaches into RTL's rows.
 *
 * NEVER THROWS out of `adoptFromLoan`'s reopen half. The document is already
 * stored by the time it runs; a reopen that fails must not turn a successful
 * upload into an error on a loan screen.
 */

const db = require('../db');
const profilePhotoId = require('../../lib/profile-photo-id');

/** The Long-Term condition whose answer IS the person's government photo ID. */
const LT_PHOTO_ID_CODE = 'lt_photo_id';

/**
 * WHERE LONG-TERM'S OWN ID CONDITIONS ARE.
 *
 * Scoped in the statement itself to `scope = 'lt_loan'`, so this can only ever
 * return Long-Term rows — a short-term condition is unreachable from here by
 * construction, exactly as the shared Condition Center tables are governed
 * everywhere else.
 */
async function ltGovIdItems(q, borrowerId) {
  const { rows } = await q.query(
    `SELECT ci.id
       FROM checklist_items ci
       JOIN lt_loans l ON l.id = ci.lt_loan_id
      WHERE ci.scope = 'lt_loan'
        AND l.borrower_id = $1::uuid
        AND ci.template_id IN (SELECT id FROM checklist_templates WHERE code = $2)`,
    [String(borrowerId), LT_PHOTO_ID_CODE]);
  return rows.map((r) => String(r.id));
}

profilePhotoId.registerReopener('lt_loan', ltGovIdItems);

/** The loan's borrower, read from the long-term columns only. */
async function borrowerOf(loanId, client) {
  const { rows } = await client.query(
    `SELECT borrower_id FROM lt_loans WHERE id = $1::uuid`, [String(loanId)]);
  return rows[0] ? rows[0].borrower_id : null;
}

/**
 * A LONG-TERM UPLOAD BECOMES THE PERSON'S ID OF RECORD.
 *
 * Called by the Long-Term upload doors AFTER the document has landed, and only
 * for the photo-ID condition — deciding that some other document on some other
 * condition is the person's ID is exactly the guess this must not make.
 *
 * A loan with no borrower linked yet has nowhere to keep it and is reported as
 * such rather than treated as a failure: the document is still filed on the
 * condition, and the ID reaches the profile the moment the borrower is linked
 * and a new one is given.
 *
 * @returns {Promise<{adopted:boolean, why?:string, reopened?:object, failed?:Array}>}
 */
async function adoptFromLoan({ loanId, documentId, conditionCode, q = db } = {}) {
  if (conditionCode !== LT_PHOTO_ID_CODE) return { adopted: false, why: 'not_the_photo_id_condition' };
  if (!loanId || !documentId) return { adopted: false, why: 'nothing_to_adopt' };

  let borrowerId = null;
  try { borrowerId = await borrowerOf(loanId, q); }
  catch (e) { return { adopted: false, why: 'unreadable_loan' }; }
  if (!borrowerId) return { adopted: false, why: 'loan_has_no_borrower_profile' };

  try {
    const out = await profilePhotoId.adopt({ borrowerId, documentId, q });
    return { adopted: !!out.stamped, reopened: out.reopened, failed: out.failed };
  } catch (e) {
    // The upload succeeded; this did not. Reported, never raised onto the screen.
    return { adopted: false, why: 'could_not_record_on_the_profile' };
  }
}

module.exports = { adoptFromLoan, ltGovIdItems, LT_PHOTO_ID_CODE };
