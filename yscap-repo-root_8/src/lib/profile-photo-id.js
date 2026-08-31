'use strict';
/**
 * A GOVERNMENT PHOTO ID BELONGS TO THE PERSON, NOT TO A LOAN — one definition,
 * both products.
 *
 * Owner-directed 2026-08-31, answering two questions in one sentence — should a
 * photo ID given on a long-term loan reopen the ID condition on that person's
 * short-term files, and what does a long-term answer become on their permanent
 * record:
 *
 *   *"Basically, share the same condition: If he uploads it on the long term,
 *    it should share it to the short term. If it's uploaded to the short term,
 *    it should share it to the long term. It's on the profiles and the borrower
 *    profile."*
 *
 * ── WHAT WAS ACTUALLY MISSING ───────────────────────────────────────────────
 *
 * The READ half already worked in both directions: the ID lives on
 * `borrowers.photo_id_document_id` (the shared identity zone), the short-term
 * checklist auto-satisfies its gov-ID condition from it, and
 * `src/longterm/conditions-center/profile-links.js` reads the same column so a
 * long-term screen says "you have already given us this". So a borrower was
 * never asked twice.
 *
 * TWO things were missing, and they are the two halves of the owner's sentence:
 *
 *   1. A photo ID uploaded on a LONG-TERM loan never reached the profile at
 *      all, so the short-term side could not see it. `profile-links.js` named
 *      that in its own header as an unbuilt open question. This is the answer.
 *
 *   2. A NEW ID has always REOPENED the short-term ID conditions — a sign-off
 *      attested to the OLD ID, so it cannot stand once a different one arrives
 *      (the same "new evidence reopens the condition" rule a new document
 *      version follows). That reopen was written inline at the short-term door
 *      and knew only about short-term files, so a long-term ID condition
 *      already signed off kept its sign-off against an ID that had been
 *      replaced.
 *
 * ── WHY THIS IS ONE MODULE AND NOT TWO ──────────────────────────────────────
 *
 * The 2026-08-30 share-the-code directive: *"We don't want to reinvent the
 * code. We want to use the same exact condition center, and when we update
 * something, it should update on both."* A second copy of "a new ID landed on
 * this person" is a second copy of the reopen rule, and the copy that drifts is
 * the one that leaves a condition signed off against paperwork that is gone.
 *
 * ── HOW IT REACHES BOTH PRODUCTS WITHOUT EITHER REACHING INTO THE OTHER ─────
 *
 * The two-product law is absolute in ONE direction that matters here: RTL is the
 * live product and may never name a `lt_*` table, in an import OR in raw SQL
 * (`scripts/check-product-separation.js` rule 7, which carries no ledger escape
 * for that direction). Finding a borrower's long-term ID conditions means
 * joining `lt_loans`, so this module cannot do it and must not try.
 *
 * So each product REGISTERS how to find its own — `registerReopener(name, fn)`,
 * called from Long-Term's own code where naming `lt_loans` is legal. The
 * short-term finder is built in, because naming `applications` from RTL code is
 * simply RTL code. Neither product's finder can see the other's rows, which is
 * the same structural separation `condition-owner.js` gives every other shared
 * Condition Center module.
 *
 * A product that has not registered is not an error — it is a deployment where
 * that product is not mounted — so `adopt` reports which finders ran rather than
 * assuming both did.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not decide WHEN an ID has landed. That is the door's judgement: the
 * short-term profile door is reached only by an upload the borrower made as
 * their ID, and the long-term side asks only for an upload onto its own photo-ID
 * condition. Adopting on every document that happens to sit on an ID condition
 * would make a second page of a licence, or a passport uploaded beside it,
 * silently become the person's ID of record.
 *
 * It also does not touch the short-term STAFF upload door. Uploading onto the
 * short-term ID condition from the staff file screen does not reach the profile
 * today, and making it do so would be changing the live product's behaviour to
 * build the side one — which rule 5 of the two-product law forbids and nobody
 * asked for. It is written down in the session report as an observation instead.
 *
 * ── FAILURE POSTURE ─────────────────────────────────────────────────────────
 *
 * The STAMP re-throws: it is the whole point of the call, and a door that
 * answered "saved" having failed to record the ID would be lying. A REOPENER
 * never throws out of here — one product's reopen failing must never fail the
 * other product's upload, and the condition it could not reopen is reported so
 * the caller can say so rather than discovering it later.
 */

const { reopenConditionEvidence } = require('./checklist-evidence');
const { OWN_FILE_SQL } = require('./change-requests');

/**
 * THE GOVERNMENT-ID CONDITION CODES, AND THEY ARE NOT ONE LIST BECAUSE THEY DO
 * NOT LIVE IN ONE PLACE.
 *
 * `rtl_p1_id` sits on a SHORT-TERM LOAN FILE (scope 'application'). `gov_id` —
 * the original, from db/002 — sits on the PERSON (scope 'borrower_profile'),
 * which is product-neutral: it belongs to nobody's loan and is reachable from
 * both products, exactly like the ID document itself. `signOffGate` has always
 * accepted either as the gov-ID reuse exception; what was missing is that only
 * the first one ever reopened.
 *
 * Keeping them apart is not tidiness — it is the difference between a finder
 * that joins a product's loan table and one that reads the person directly, and
 * a profile-scoped row put through the loan finder simply never matches.
 */
const RTL_GOV_ID_CODES = ['rtl_p1_id'];
const PROFILE_GOV_ID_CODES = ['gov_id'];

/** name -> async (q, borrowerId) => string[] item ids. Registered by each product. */
const reopeners = new Map();

/**
 * A product says how to find ITS government-ID conditions for a person.
 * Registering twice under one name replaces it, so a module reloaded in a test
 * cannot stack two copies of the same finder.
 */
function registerReopener(name, fn) {
  if (!name || typeof fn !== 'function') return false;
  reopeners.set(String(name), fn);
  return true;
}

/** Which products have said how to find their conditions. For reporting only. */
function registeredReopeners() {
  return [...reopeners.keys()].sort();
}

/**
 * The short-term finder. Scoped through `OWN_FILE_SQL` — the SAME predicate the
 * short-term door has always used, so this reaches exactly the files it always
 * reached: the person's own, a file they are the co-borrower on, and a file
 * belonging to a profile confirmed to be them.
 */
async function rtlGovIdItems(q, borrowerId) {
  const { rows } = await q.query(
    `SELECT ci.id
       FROM checklist_items ci
       JOIN applications a ON a.id = ci.application_id
      WHERE ci.scope = 'application'
        AND ci.template_id IN (SELECT id FROM checklist_templates WHERE code = ANY($2))
        AND (${OWN_FILE_SQL('a', '$1')})`,
    [borrowerId, RTL_GOV_ID_CODES]);
  return rows.map((r) => String(r.id));
}

/**
 * The PERSON'S OWN ID condition — product-neutral, so it needs no loan table and
 * belongs to neither product. This is the row the owner's *"it's on the profiles
 * and the borrower profile"* is literally about, and it is why this finder is
 * built in rather than registered: reading a `borrower_profile`-scoped condition
 * is not a crossing in either direction.
 */
async function profileGovIdItems(q, borrowerId) {
  const { rows } = await q.query(
    `SELECT ci.id
       FROM checklist_items ci
      WHERE ci.scope = 'borrower_profile'
        AND ci.borrower_id = $1
        AND ci.template_id IN (SELECT id FROM checklist_templates WHERE code = ANY($2))`,
    [borrowerId, PROFILE_GOV_ID_CODES]);
  return rows.map((r) => String(r.id));
}

/**
 * A NEW GOVERNMENT ID HAS LANDED ON THIS PERSON.
 *
 * Records it as the person's ID of record and reopens every government-ID
 * condition they carry, on every product that has said how to find its own.
 *
 * @param {object}  o
 * @param {string}  o.borrowerId  the person the ID belongs to
 * @param {string}  o.documentId  the stored document these bytes became
 * @param {object} [o.q]          any query runner (pool or transaction client)
 * @returns {Promise<{stamped:boolean, reopened:Object<string,number>, failed:Array<{product:string,why:string}>}>}
 */
async function adopt({ borrowerId, documentId, q = require('../db') } = {}) {
  const out = { stamped: false, reopened: {}, failed: [] };
  if (!borrowerId || !documentId) return out;

  // THE STAMP. Re-throws deliberately — see the failure posture above.
  await q.query(
    `UPDATE borrowers SET photo_id_document_id=$2, updated_at=now() WHERE id=$1`,
    [borrowerId, documentId]);
  out.stamped = true;

  const finders = [
    ['application', rtlGovIdItems],
    ['borrower_profile', profileGovIdItems],
    ...reopeners.entries(),
  ];
  for (const [product, find] of finders) {
    try {
      const ids = (await find(q, borrowerId)) || [];
      for (const id of ids) await reopenConditionEvidence(q, id, 'received');
      out.reopened[product] = ids.length;
    } catch (e) {
      // One product's reopen failing must never fail the other product's upload.
      out.failed.push({ product, why: String((e && e.message) || e) });
    }
  }
  return out;
}

module.exports = {
  adopt,
  registerReopener,
  registeredReopeners,
  RTL_GOV_ID_CODES,
  PROFILE_GOV_ID_CODES,
  _internals: { rtlGovIdItems, profileGovIdItems, reopeners },
};
