'use strict';
/**
 * LONG-TERM — THE VESTING ENTITY IS THE BORROWER'S, NOT THIS LOAN'S.
 *
 * The owner, twice: *"if that LLC is already verified somehow on his profile or
 * even if it is not verified, even if it has some documentation on his profile
 * already like formation documents, operating units, whatever it has — that
 * information should automatically be pre-filled in this condition"*, and
 * *"If this upload is already uploaded in this entity slot on the profile, then
 * it should be pre-filled with the documents already there and verified
 * already."*
 *
 * ── SHARED, NOT COPIED — the owner's own instruction ────────────────────────
 *
 * *"You should basically share the logic. Don't copy it. We need to share that
 * logic from there."* So this module is a thin READER over `src/lib/llc.js`,
 * authorized per item in `docs/LONG-TERM-AUTHORIZED-COPIES.md`. It re-implements
 * nothing, and that is what buys the rules a copy would have quietly lost:
 *
 *   · the CERTIFICATE OF GOOD STANDING is optional AND EXPIRES after 30 days —
 *     the slot reopens and stops populating onto files, while the entity stays
 *     verified, because good standing was never required in the first place;
 *   · a LAYERED entity verifies bottom-up, every owner in the chain first;
 *   · what is asked for differs by entity TYPE — an LLC's operating agreement,
 *     a corporation's bylaws and stock certificate, a partnership's or a trust's
 *     own papers, and a revocable trust that legitimately has no EIN and no
 *     formation state.
 *
 * Any one of those re-derived here would be a second answer to "is this company
 * verified?", and the one that drifts is the one that lets an unverified company
 * take title.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It never CREATES an entity and never marks one verified. Reading the profile
 * to show what is already there is a different act from putting a new company on
 * a person's permanent record. This module answers one question: what does this
 * borrower already have for this company, and how much of the condition is
 * therefore already done?
 *
 * ITS WRITE HALF IS `entity-profile.js`, the sibling — put the company on the
 * profile (a button, never automatic) and file its documents onto the company's
 * OWN slots. Read them as a pair: the `itemId` this module now returns per slot
 * is what the write half's upload door targets, so a document lands ON the
 * profile the first time rather than being copied there afterwards.
 *
 * NEVER THROWS. An unreadable profile answers "nothing on file", which shows the
 * condition as it would have been shown anyway — never an error on a loan screen,
 * and never a false "already verified".
 */

const llc = require('../../lib/llc');

/** The slots this condition shows, in the order a person works them. Keyed to
    the SHARED template codes so a slot added on the entity screen appears here
    without a second list to keep in step. */
const SLOT_FOR_CODE = Object.freeze({
  rtl_llc_formation: 'formation',
  rtl_llc_opagmt: 'agreement',
  rtl_llc_ein: 'ein',
  rtl_llc_goodstanding: 'good_standing',
});

/** Is a slot's document actually there and accepted? `getSlots` already applies
    the good-standing expiry, so an expired certificate arrives as an EMPTY slot
    and is reported as missing — which is the honest answer. */
function slotFilled(row) {
  return !!(row && row.document_id && row.review_status === 'accepted');
}

/**
 * What the borrower already holds for this company.
 *
 * @param {string} borrowerId  the shared person record
 * @param {string} entityName  the vesting name on the long-term file
 * @param {object} client      a pg client (the LONG-TERM pool — every shared
 *   helper takes an optional trailing client precisely so a caller can say which
 *   database it is asking)
 *
 * @returns {Promise<{
 *   found: boolean, llcId: string|null, verified: boolean,
 *   slots: Array<{key,itemId,label,filled,documentId,filename,status,note}>,
 *   filled: string[], missing: string[], stillNeeded: string[],
 *   unreadable: boolean, why: string|null
 * }>}
 */
async function forEntity(borrowerId, entityName, client) {
  const empty = {
    found: false, llcId: null, verified: false, slots: [],
    filled: [], missing: [], stillNeeded: [], unreadable: false, why: null,
  };
  if (!borrowerId || !String(entityName || '').trim()) return empty;

  let llcId = null;
  try {
    llcId = await llc.findLlcByName(borrowerId, entityName, client);
  } catch (e) {
    // UNREADABLE IS NOT "NOTHING ON FILE", and the difference matters: one means
    // the borrower has never given us this company, the other means we could not
    // look. Saying the first when the second is true is the confident wrong
    // answer — it would ask a borrower for documents they already sent.
    return { ...empty, unreadable: true, why: 'PILOT could not read the borrower’s profile just now, so it did not check what is already on file.' };
  }
  if (!llcId) return empty;

  let bundle = null;
  try {
    bundle = await llc.getLlcBundle(llcId, client);
  } catch (e) {
    return { ...empty, llcId, unreadable: true, why: 'PILOT found the company on the profile but could not read its documents.' };
  }
  /* THE BUNDLE **IS** THE COMPANY ROW, SPREAD — `getLlcBundle` returns
     `{ ...llc, entity, members, slots, completeness }`, so there is no
     `bundle.llc` key and never was. Reading one made this whole module answer
     "not on the profile" for EVERY company on EVERY long-term file, silently,
     since the day it shipped: `findLlcByName` found the company and the very
     next line threw the answer away. Every RTL caller of `getLlcBundle` treats
     it as the row; this was the one that did not. `id` is the presence test
     because `getLlcBundle` returns null — not a row without an id — when there
     is no such company. */
  if (!bundle || !bundle.id) return { ...empty, llcId };

  const rows = Array.isArray(bundle.slots) ? bundle.slots : [];
  const slots = [];
  const filled = [];
  const missing = [];
  for (const r of rows) {
    const key = SLOT_FOR_CODE[String(r.code || '')];
    if (!key) continue;                       // a slot this condition does not show
    const isFilled = slotFilled(r);
    slots.push({
      key,
      /* THE SLOT'S OWN CHECKLIST ITEM. This is what lets the long-term screen
         file a document ONTO the company rather than onto the loan: the upload
         door takes this id with the company's, and the shared module scopes the
         one to the other. Without it the screen could only ever say what is
         missing, which is the read-only half this module started as. */
      itemId: r.item_id ? String(r.item_id) : null,
      label: r.label || key,
      filled: isFilled,
      documentId: r.document_id || null,
      filename: r.filename || null,
      status: r.review_status || null,
      // `getSlots` puts the good-standing expiry note here, which is the one
      // thing a person needs to see about an otherwise-complete entity.
      note: r.note || null,
    });
    (isFilled ? filled : missing).push(key);
  }

  // WHAT IS STILL NEEDED IS THE SHARED MODULE'S ANSWER, not ours — it knows the
  // entity's TYPE, so it asks a trust for its trust papers and not for articles
  // of formation it will never have.
  let stillNeeded = [];
  try {
    stillNeeded = llc.missingForVerification(bundle, bundle.members || [], rows) || [];
  } catch (_) {
    stillNeeded = [];
  }

  return {
    found: true,
    llcId,
    verified: !!bundle.is_verified,
    slots,
    filled,
    missing,
    stillNeeded,
    unreadable: false,
    why: null,
  };
}

/**
 * Does what is already on the profile FINISH this condition?
 *
 * VERIFIED IS THE BAR, and it is deliberately not "the documents are there":
 * verification is a person having READ the operating agreement and confirmed the
 * borrower controls the company, which is the actual question. Documents present
 * but unverified pre-fill the condition and leave it open — which is exactly what
 * the owner asked for, because it saves the borrower sending them again without
 * pretending the review happened.
 */
function satisfiedByProfile(prefill) {
  if (!prefill || prefill.unreadable) return { ok: false, why: prefill && prefill.why ? prefill.why : null };
  if (!prefill.found) return { ok: false, why: null };
  if (!prefill.verified) {
    return {
      ok: false,
      why: prefill.filled.length
        ? 'The company is on the borrower’s profile with some documents already, but it has not been verified yet.'
        : null,
    };
  }
  return { ok: true, why: 'This company is already verified on the borrower’s profile.' };
}

module.exports = { forEntity, satisfiedByProfile, SLOT_FOR_CODE, _internals: { slotFilled } };
