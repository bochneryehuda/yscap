/**
 * ORDER DOCUMENT SLOTS — ONE definition of "which slot may a document that came
 * back on an order be put in", shared by the Orders desk and the CONDITION the
 * order files into (owner-directed 2026-08-03).
 *
 * WHY THIS MODULE EXISTS (the bug it closes)
 * ------------------------------------------
 * A condition can declare NAMED SLOTS (`checklist_templates.slots`). The insurance
 * condition `rtl_cond_insurance` declares two — "Insurance binder" and "Insurance
 * invoice" — and the file screen renders a slotted condition as EXACTLY those
 * slots, matching a document to a slot by an exact `slot_label === slot.label`
 * compare. The Orders desk had its OWN, hand-typed list of classification labels
 * ('Binder', 'Invoice', 'Quote', …). Two consequences, both live:
 *
 *   1. Classifying a returned document as "Binder" on the Orders desk wrote a
 *      label the condition's binder slot does not recognise, so the document
 *      stayed invisible there — the condition went on reading "not uploaded".
 *   2. A returned document arrives UNASSIGNED by design (`slot_label` NULL) so a
 *      human classifies it. A slotted condition renders only its named slots, so
 *      an unassigned document was invisible on the condition as well.
 *
 * Together those are the owner's report: "we just got back insurance documents
 * and it was not automatically attached to the insurance condition". The
 * documents WERE attached (order-inbox has always set `checklist_item_id`) —
 * the condition simply had nowhere to draw them.
 *
 * THE FIX IS A DERIVATION, NOT A SECOND LIST. `slotsFor()` reads the condition
 * template's OWN slots out of the database and puts them FIRST, so choosing
 * "Insurance binder" on the Orders desk is the same act as dropping a file into
 * the condition's binder slot. A hand-kept copy could drift the moment an admin
 * edits the template; a derivation cannot. The extra, descriptive labels below
 * (Quote, CPL, …) are the ones the condition has no slot for — a document
 * carrying one stays "in the condition but not in a slot", which is exactly the
 * owner's third option: "or if it should stay on a random slot within the
 * insurance condition".
 *
 * Nothing here decides whether a condition can be SIGNED OFF. That gate lives in
 * `signOffGate` and matches slot labels by lower-case SUBSTRING ('binder',
 * 'invoice'), so both the legacy labels and the condition's own labels satisfy
 * it — which is why the mismatch above was a display bug and never let an
 * unfulfilled insurance condition clear.
 */
'use strict';

/** The real document condition each order type files into. */
const CONDITION_CODE = { title: 'rtl_cond_title', insurance: 'rtl_cond_insurance' };

/**
 * The `documents.doc_kind` a vendor's returned documents are filed under.
 *
 * Lives here, beside CONDITION_CODE, because it answers the same shape of
 * question ("what does this order type map to?") and because it had already been
 * written out by hand in the two JS places that consume it — order-inbox's insert
 * and the Orders desk's returned-document lists. A third copy for the reopen rule
 * would have been the point at which they drift.
 *
 * NO `attorney` ENTRY, deliberately. The closing chain files its documents as
 * `closing_correspondence`, which is running correspondence rather than a vendor
 * delivery — and `staff.js` builds the per-order returned-document lists from
 * `Object.values()` of this map, so adding it would start showing every closing
 * email's attachments as a title/insurance style order return. The two SQL copies
 * that remain (`staff.js`'s desk CASE and `tpr-export.js`'s categoriser) are not
 * folded in here for the same reason: each carries an attorney arm this map must
 * not have.
 *
 * Frozen: one object now backs three modules, so a stray write would change the
 * meaning of a document kind everywhere at once.
 */
const RETURN_DOC_KIND = Object.freeze({ title: 'title_order_return', insurance: 'insurance_order_return' });

/**
 * What the condition template declares TODAY, used only when the template row
 * cannot be read (a brand-new database, a transient error). Kept identical to
 * db/051's seed so a fallback can never invent a slot the condition does not
 * have. Title declares none — it is a free-form, any-number-of-documents
 * condition, which is why a title order needs no classification step at all.
 */
const FALLBACK_CONDITION_SLOTS = {
  insurance: ['Insurance binder', 'Insurance invoice'],
  title: [],
};

/**
 * Descriptive labels the CONDITION has no named slot for. A document given one of
 * these is still on the condition and still previewable there — it just sits in
 * the condition's "other documents" group rather than in a named slot. These are
 * the vendor's own vocabulary, so the team can say what a document IS even when
 * it is not one of the two the condition is waiting for.
 */
const EXTRA_SLOTS = {
  title: ['Title commitment', 'CPL', 'Tax certificate', 'Wiring instructions', 'Preliminary settlement statement', 'Other'],
  insurance: ['Quote', 'Declaration page', 'Flood policy', 'Other'],
};

/**
 * Labels an earlier version of the Orders desk wrote, mapped by MEANING onto
 * whatever the condition calls that slot today. Matching is by substring on the
 * lower-cased label — the same test `signOffGate` uses — so "Binder",
 * "binder", "Insurance Binder" and a future "Hazard binder" all land on the
 * condition's binder slot. Anything not recognised is left alone rather than
 * guessed onto a slot it may not belong in.
 */
const LEGACY_MEANING = ['binder', 'invoice'];

function norm(s) { return String(s == null ? '' : s).trim(); }
function lower(s) { return norm(s).toLowerCase(); }

/**
 * Canonicalise a chosen slot label against the labels this order actually
 * offers. PURE — no database, so the whole truth table is unit-testable.
 *
 * @param {string} raw      what the caller chose ('' / null clears the slot)
 * @param {string[]} allowed the labels offered for this order, condition-first
 * @returns {{ok:true, slot:string|null} | {ok:false, reason:string}}
 */
function canonicalizeSlot(raw, allowed) {
  const list = (Array.isArray(allowed) ? allowed : []).map(norm).filter(Boolean);
  const want = norm(raw);
  // Empty is a deliberate "put it back to unassigned" — always allowed, and the
  // state every returned document starts in.
  if (!want) return { ok: true, slot: null };
  const exact = list.find((l) => lower(l) === lower(want));
  if (exact) return { ok: true, slot: exact };
  // A legacy label ("Binder") means the same thing as the condition's own
  // ("Insurance binder"), so accept it and store the condition's spelling —
  // otherwise the document would sit outside the slot it plainly belongs in.
  for (const meaning of LEGACY_MEANING) {
    if (!lower(want).includes(meaning)) continue;
    const hit = list.find((l) => lower(l).includes(meaning));
    if (hit) return { ok: true, slot: hit };
  }
  return { ok: false, reason: 'unknown_slot' };
}

/**
 * The named slots a CONDITION declares, newest state, read from its template.
 * Returns labels only (the file screen matches on the label). Never throws — an
 * unreadable template falls back to the seeded shape rather than reporting a
 * condition with no slots, which would quietly turn the binder/invoice picker
 * into free text.
 *
 * @param {object} dbc   a pg client/pool with .query
 * @param {string} code  a checklist_templates.code
 */
async function conditionSlotLabels(dbc, code, fallback = []) {
  try {
    const r = await dbc.query(`SELECT slots FROM checklist_templates WHERE code=$1 LIMIT 1`, [code]);
    const raw = r.rows[0] && r.rows[0].slots;
    if (!Array.isArray(raw)) return fallback.slice();
    const labels = raw.map((s) => norm(s && (s.label || s.key))).filter(Boolean);
    return labels.length ? labels : fallback.slice();
  } catch (_) { return fallback.slice(); }
}

/**
 * Every slot this order's returned documents may be assigned to, in the order
 * the picker should offer them: the CONDITION's own named slots first (choosing
 * one of these puts the document in that slot on the condition), then the
 * descriptive labels the condition has no slot for.
 *
 * @returns {Promise<{conditionSlots:string[], extraSlots:string[], all:string[], conditionCode:string}>}
 */
async function slotsFor(dbc, orderType) {
  const code = CONDITION_CODE[orderType];
  if (!code) return { conditionSlots: [], extraSlots: [], all: [], conditionCode: null };
  const conditionSlots = await conditionSlotLabels(dbc, code, FALLBACK_CONDITION_SLOTS[orderType] || []);
  const extras = (EXTRA_SLOTS[orderType] || [])
    // Never offer the same slot twice because a descriptive label happens to
    // match one the template already declares.
    .filter((e) => !conditionSlots.some((c) => lower(c) === lower(e)));
  return {
    conditionSlots,
    extraSlots: extras,
    all: conditionSlots.concat(extras),
    conditionCode: code,
  };
}

/**
 * The slots a document sitting on an arbitrary CONDITION may be assigned to.
 * Used by the file screen's "other documents in this condition" picker, so a
 * document that came back unlabelled can be dropped into the binder or the
 * invoice slot from the condition itself — the same act, the same labels, as
 * classifying it on the Orders desk.
 *
 * A condition with no declared slots (Title) returns an empty list: it is
 * free-form, every document already shows, and there is nothing to choose.
 */
async function slotsForConditionTemplate(dbc, code) {
  if (!code) return [];
  const orderType = Object.keys(CONDITION_CODE).find((k) => CONDITION_CODE[k] === code) || null;
  if (orderType) return (await slotsFor(dbc, orderType)).all;
  return conditionSlotLabels(dbc, code, []);
}

module.exports = {
  CONDITION_CODE, RETURN_DOC_KIND, EXTRA_SLOTS, FALLBACK_CONDITION_SLOTS,
  canonicalizeSlot, conditionSlotLabels, slotsFor, slotsForConditionTemplate,
};
