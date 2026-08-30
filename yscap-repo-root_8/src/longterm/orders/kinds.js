'use strict';
/**
 * LONG-TERM — WHAT CAN BE ORDERED, WHO FULFILS IT, AND WHERE THE ANSWER LANDS.
 *
 * One row per order kind, and it is the ONE definition. Everything else on this
 * desk is derived from it: which condition the order answers, which vendor card it
 * is addressed to, which slots a returned document can fill, what the letter is
 * called, and — for insurance — which of two letters this deal wants.
 *
 * ── WHY A REGISTRY AND NOT A SWITCH ─────────────────────────────────────────
 *
 * The owner's rule for this whole build was *"everything should be setup with not
 * setting it on a hard level … everything should be able to be configured
 * differently in settings. The system is only prefilled with the rules of the
 * system."* A registry is what makes that true: the condition library, the desk,
 * the letter and the inbound router all read the same row, so adding a kind is one
 * entry rather than an edit in five places, four of which somebody will miss.
 *
 * ── THE VOCABULARY IS SHARED WITH TWO OTHER FILES, AND DRIFT IS SILENT ──────
 *
 * `db/644`'s CHECK constraints mirror `ORDER_KINDS` and `VENDOR_KINDS`, and
 * `conditions-center/library.js` names the same `orderType` / `contactType` values
 * in each order condition's config. None of the three can see the others, and every
 * possible disagreement fails LATE and QUIETLY — a kind the registry offers that
 * the CHECK refuses fails at the moment somebody presses Order, on a real file,
 * with a Postgres error. `scripts/test-lt-orders-pure.js` reads all three out of
 * the source and fails the build the day they disagree.
 *
 * PURE. No database, no network, no config.
 */

/** The contact TYPES a long-term file can carry, and what each one is called.
    Mirrors `lt_file_contacts.config.contactTypes` in the condition library plus the
    two the library collects on their own conditions (the HOA management company,
    the landlord). A card is a `service_contacts` row — the SHARED directory. */
const VENDOR_KINDS = Object.freeze({
  title: 'Title company',
  hazard_insurance: 'Hazard insurance agent',
  flood_insurance: 'Flood insurance agent',
  ny_settlement_agent: 'Settlement agent',
  buyers_attorney: 'Buyer’s attorney',
  realtor: 'Realtor',
  our_attorney: 'Our attorney',
  hoa: 'HOA management company',
  landlord: 'Landlord',
  appraisal: 'Appraisal management company',
  payoff: 'Servicer being paid off',
  other: 'Other',
});

/**
 * THE ORDERS.
 *
 *  · `condition`   the condition this order answers — the row that goes from
 *                  outstanding to received when the order sends. One place, so the
 *                  desk and the condition centre can never tell a different story.
 *  · `vendorKind`  which card it is addressed to.
 *  · `docCondition`/`slotMap` where a RETURNED document is filed. `slotMap` maps a
 *                  filename fragment to a named slot; anything it cannot place is
 *                  filed on the condition with NO slot rather than guessed into the
 *                  wrong one — a binder filed as an invoice is worse than an
 *                  unfiled binder, because it reads as satisfied.
 *  · `letter`      which shape of letter the shared builder should draw. Only
 *                  `title` and `insurance` have a letter of their own today; every
 *                  other kind draws the generic one, which states the deal and asks
 *                  for the named deliverables.
 *  · `enabled`     false means built and switched off — it shows on the desk with
 *                  its reason rather than being hidden, so nobody thinks it is
 *                  missing. It is only what we SHIP with: the live answer comes from
 *                  the condition's own template (`orders/switches.js`), so an order
 *                  is turned on and off in settings rather than in a release.
 */
const ORDER_KINDS = Object.freeze({
  title: {
    label: 'Title',
    vendorKind: 'title',
    condition: 'lt_order_title',
    docCondition: 'lt_title_docs',
    letter: 'title',
    slotMap: [
      [/commit/i, 'commitment'],
      [/\bcpl\b|closing\s*protection/i, 'cpl'],
      [/prelim|settlement\s*statement|\bhud\b|\bcd\b/i, 'prelim_settlement'],
      [/wir(e|ing)/i, 'wire_instructions'],
      [/invoice|bill/i, 'invoice'],
    ],
  },
  insurance: {
    label: 'Insurance',
    vendorKind: 'hazard_insurance',
    condition: 'lt_order_insurance',
    docCondition: 'lt_insurance_docs',
    letter: 'insurance',
    slotMap: [
      [/binder|dec(laration)?s?\b|evidence/i, 'binder'],
      [/invoice|receipt|paid|bill/i, 'invoice'],
    ],
  },
  flood_insurance: {
    label: 'Flood insurance',
    vendorKind: 'flood_insurance',
    condition: 'lt_order_flood_insurance',
    docCondition: 'lt_flood_insurance_docs',
    letter: 'insurance',
    slotMap: [
      [/binder|dec(laration)?s?\b|evidence/i, 'binder'],
      [/invoice|receipt|paid|bill/i, 'invoice'],
    ],
  },
  ny_settlement_agent: {
    label: 'New York settlement agent',
    vendorKind: 'ny_settlement_agent',
    condition: 'lt_order_ny_settlement_agent',
    docCondition: 'lt_ny_settlement_docs',
    letter: 'generic',
    // What the settlement agent is asked to produce. Named here rather than in the
    // letter so the ask and the slots that receive it are one list.
    wants: ['Engagement letter', 'Wire instructions', 'Preliminary settlement statement'],
    slotMap: [
      [/engag|retain/i, 'engagement'],
      [/wir(e|ing)/i, 'wire_instructions'],
      [/settlement|statement|\bhud\b|\bcd\b/i, 'settlement_statement'],
    ],
  },
  payoff: {
    label: 'Payoff',
    vendorKind: 'payoff',
    condition: 'lt_payoff_ordered',
    docCondition: 'lt_payoff_received',
    letter: 'generic',
    wants: ['Payoff statement good through the estimated closing date', 'Per-diem interest', 'Wire instructions'],
    slotMap: [[/payoff|demand|statement/i, null]],
  },
  condo_questionnaire: {
    label: 'Condo questionnaire',
    vendorKind: 'hoa',
    condition: 'lt_condo_questionnaire_ordered',
    docCondition: 'lt_condo_docs',
    letter: 'generic',
    wants: ['Completed condominium questionnaire', 'The association’s master insurance certificate', 'The current budget'],
    slotMap: [
      [/question|cert(ification)?\b/i, 'questionnaire'],
      [/insur|master/i, 'master_insurance'],
      [/budget/i, 'budget'],
    ],
  },
  vor: {
    label: 'Verification of rent',
    vendorKind: 'landlord',
    condition: 'lt_vor_sent',
    docCondition: 'lt_housing_history',
    letter: 'generic',
    wants: ['The completed verification of rent'],
    slotMap: [[/vor|verification|rent/i, null]],
  },
});

/** Every order kind, in the order a file works through them. */
const ORDER_KIND_KEYS = Object.freeze(Object.keys(ORDER_KINDS));

/** One kind's definition, or null. NEVER throws and never invents a kind — an
    unrecognised kind must read as "there is no such order", not as a default one. */
function orderKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ORDER_KINDS, k) ? { key: k, ...ORDER_KINDS[k] } : null;
}

/** Is this kind switched on? A kind with no `enabled` key is on. */
function isEnabled(kind) {
  const k = orderKind(kind);
  return !!k && k.enabled !== false;
}

/**
 * WHICH SLOT A RETURNED DOCUMENT FILLS — by its own filename, and never a guess.
 *
 * Returns the slot key, or null for "file it on the condition with no slot". Null
 * is the SAFE answer and is chosen deliberately whenever the name says nothing:
 * a binder filed into the invoice slot reads as an invoice that has arrived, and a
 * condition whose slots are all full reads as satisfied — so a wrong slot is worse
 * than no slot, which merely leaves a person to place it.
 */
function slotForFilename(kind, filename) {
  const k = orderKind(kind);
  if (!k || !Array.isArray(k.slotMap) || !k.slotMap.length) return null;
  const name = String(filename || '');
  if (!name.trim()) return null;
  for (const [re, slot] of k.slotMap) {
    if (re.test(name)) return slot;
  }
  return null;
}

/** The vendor card kind an order of this kind is addressed to, or null. */
function vendorKindFor(kind) {
  const k = orderKind(kind);
  return k ? k.vendorKind : null;
}

module.exports = {
  VENDOR_KINDS, ORDER_KINDS, ORDER_KIND_KEYS,
  orderKind, isEnabled, slotForFilename, vendorKindFor,
};
