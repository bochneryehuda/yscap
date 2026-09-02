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
 * WHAT A CARD IS, IN THE SHARED DIRECTORY'S OWN VOCABULARY.
 *
 * Owner-directed 2026-08-30: *"The contact should save in the future the type of
 * contact: attorney contact, realtor contact, everything should share the Vendor
 * FileContacts section that we have already in the RTL side."* The type lives ON
 * the card (`service_contacts.contact_type`), so a company entered once as an
 * attorney is an attorney everywhere and forever — which only works if BOTH
 * products write the same word for the same thing.
 *
 * The two vocabularies are genuinely different and both are right for their own
 * side: this desk asks "what job does this company do on THIS loan" (an attorney
 * is the buyer's or ours; a servicer is being paid off), while the directory asks
 * "what kind of company is this" (an attorney is an attorney). So a long-term
 * kind is MAPPED to a directory type when a card is created, rather than either
 * list being bent to the other.
 *
 * EVERY VALUE ON THE RIGHT IS ONE `lib/vendor-directory`'s SUGGEST_TYPES ALREADY
 * CARRIES — the type-ahead answers nothing for a type it does not know, so a card
 * written with a long-term word would be a card nobody could ever find again.
 * `test-lt-orders-pure.js` reads that set out of the shared module and fails the
 * build the day this table names something outside it.
 *
 * Three kinds fold into `other`, and two of them carry a label of their own: the
 * directory has no word for an HOA management company or a landlord, so the
 * long-term LABEL is written to `custom_type` — the field that exists for exactly
 * that — and the card still reads "HOA management company" wherever it is shown.
 * The kind literally called `other` carries none, because there the free text is
 * the PERSON'S ("e.g. Surveyor") and a stored "Other" would overwrite it.
 */
const CONTACT_TYPE_FOR_KIND = Object.freeze({
  title: 'title_company',
  hazard_insurance: 'insurance_agent',
  flood_insurance: 'flood_insurance',
  ny_settlement_agent: 'settlement_agent',
  buyers_attorney: 'attorney',
  our_attorney: 'attorney',
  realtor: 'realtor',
  appraisal: 'appraiser',
  // A payoff goes to whoever HOLDS the loan being paid off — a lender or its
  // servicer. `lender` is the directory's word for that, and it is the one an
  // RTL payoff contact is already filed under.
  payoff: 'lender',
  hoa: 'other',
  landlord: 'other',
  other: 'other',
});

/**
 * The directory type a card for this job is filed under, and the free-text label
 * that goes with it when the directory has no word of its own.
 *
 * @returns {{contactType: string, customType: string|null}|null} null for a kind
 *   this desk does not carry — never a default, because a card filed under a
 *   guessed type is a card found by the wrong search. `customType` is null when
 *   the directory has its own word for the job, and null again for the kind
 *   called `other`, where the free text belongs to the person filling the form.
 */
function directoryTypeFor(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CONTACT_TYPE_FOR_KIND, k)) return null;
  const contactType = CONTACT_TYPE_FOR_KIND[k];
  const named = contactType === 'other' && k !== 'other';
  return { contactType, customType: named ? (VENDOR_KINDS[k] || null) : null };
}

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
    /* THE INVOICE IS TESTED FIRST. A title company names its bill after the thing
       it is for — "Invoice - Title Commitment.pdf" — and with the commitment
       pattern first that bill filed itself as the commitment, so the condition
       read as holding a commitment it did not have (audit 2026-09-02, S5). An
       invoice named for anything is still an invoice. */
    slotMap: [
      [/invoice|bill/i, 'invoice'],
      [/commit/i, 'commitment'],
      [/\bcpl\b|closing\s*protection/i, 'cpl'],
      [/prelim|settlement\s*statement|\bhud(-1)?\b|\bcd\b|closing\s*disclosure/i, 'prelim_settlement'],
      [/wir(e|ing)/i, 'wire_instructions'],
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
    /* What the settlement agent is asked to produce. Named here rather than in
       the letter so the ask and the slots that receive it are one list.

       NO CLOSING PROTECTION LETTER — OWNER-CORRECTED 2026-09-02: *"In NY, there
       is no CPL. We only ask them for their Errors and Omissions Assurance."*
       The New York rule in docs/longterm/OWNER-ORDER-DRAFTS.md said the CPL
       moved from the title order onto this one; it does not move, because there
       is none to move. That draft is corrected at the source — leaving it would
       put the CPL back the next time somebody reads it. What genuinely comes
       from the settlement agent rather than from title is the E&O, which the
       shared title letter already cuts from a New York title ask
       (`lib/order-email.js` NY_TITLE_CUT). Asking an agent for a document their
       state does not issue is how an order stalls on a reply nobody can send. */
    wants: [
      'Engagement letter',
      'Wire instructions',
      'Your errors and omissions (E&O) insurance',
      'Preliminary settlement statement',
    ],
    /* The settlement STATEMENT is named in full. A bare `settlement` swallowed
       "Settlement Agent E&O.pdf" and "Settlement Agent W9.pdf" into the statement
       slot — the agent's own name is on every document they send (audit S5). The
       E&O is tested before it for the same reason.
       NO `cpl` ROW: there is no closing protection letter in New York (owner,
       2026-09-02) and there is no slot to file one into, so a filename merely
       MENTIONING one must fall through to the condition rather than be filed
       against a slot that does not exist. */
    slotMap: [
      [/engag|retain/i, 'engagement'],
      [/wir(e|ing)/i, 'wire_instructions'],
      [/e&o|errors?\s*(and|&)\s*omissions/i, 'eo'],
      [/settlement\s*statement|\bhud(-1)?\b|\bcd\b|closing\s*disclosure/i, 'settlement_statement'],
    ],
  },
  payoff: {
    label: 'Payoff',
    vendorKind: 'payoff',
    condition: 'lt_payoff_ordered',
    docCondition: 'lt_payoff_received',
    letter: 'generic',
    wants: ['Payoff statement good through the estimated closing date', 'Per-diem interest', 'Wire instructions'],
    /* THE STATEMENT LANDS IN THE SLOT THAT IS WAITING FOR IT. Found by the
       A-to-Z audit: this mapped to `null`, so a payoff statement that arrived by
       reply filed on the condition with NO slot — while `lt_payoff_received`
       carries a REQUIRED `payoff` slot, which then still read as missing the
       document sitting right there. There is exactly one slot on that condition,
       so there is nothing for a guess to get wrong. */
    /* NOT a bare `statement`: a servicer's reply often carries the borrower's
       monthly "Mortgage Statement June.pdf" beside the payoff, and that is not the
       payoff — filed as one, the condition read as satisfied by a bill (audit S5). */
    slotMap: [[/payoff|demand/i, 'payoff']],
  },
  condo_questionnaire: {
    label: 'Condo questionnaire',
    vendorKind: 'hoa',
    condition: 'lt_condo_questionnaire_ordered',
    docCondition: 'lt_condo_docs',
    letter: 'generic',
    /* THE OWNER'S OWN LIST, in the owner's own order (2026-08-31, quoting the
       original brief back at me: "from the condo order You dropped certain
       stuff … I think we were also asking for bylaws"):
         Condo Documents Request - Please provide the following:
         -Completed condo questionnaire
         -Current HOA budget
         -Bylaws
         -Master insurance policy or insurance agent contact
       The last one is deliberately an OR: an association that will not release
       the policy will give you the agent who can, and asking for the policy
       alone is what makes that request stall. */
    wants: [
      'The completed condominium questionnaire (our form is attached)',
      'The association’s current budget',
      'The bylaws',
      'The master insurance policy — or the insurance agent’s contact details, if it is easier for you to point us at them',
    ],
    /* The association's own answer to the questionnaire is what the FORM is, so
       `question|cert` must not also swallow a certificate of insurance — hence
       the insurance test runs FIRST in `slotFor` order terms and the
       questionnaire pattern excludes an insurance word. */
    /* The MASTER policy (or a "master insurance" certification of it) or a
       CERTIFICATE of insurance, named as such. A bare `insur` filed "Insurance
       Agent Contact.pdf" — the OTHER half of the owner's either/or, a name and a
       phone number — as the master policy (audit S5). */
    slotMap: [
      [/master\s*(polic|insurance)|certificate\s*of\s*insurance/i, 'master_insurance'],
      [/bylaw|by-law|by\s+law/i, 'bylaws'],
      [/budget/i, 'budget'],
      [/question|cert(ification)?\b/i, 'questionnaire'],
    ],
  },
  vor: {
    label: 'Verification of rent',
    vendorKind: 'landlord',
    condition: 'lt_vor_sent',
    docCondition: 'lt_housing_history',
    letter: 'generic',
    wants: ['The completed verification of rent'],
    /* ORDERED, AND THE ORDER IS THE POINT — the same rule as the condo slots
       above. `lt_housing_history` carries three slots, and a bare
       `verification` would swallow a VERIFICATION OF MORTGAGE into the rent
       slot: a document filed in the wrong slot is worse than an unfiled one,
       because it reads as satisfied. So the two that can be named unambiguously
       are tested FIRST, and the rent verification is what is left. */
    slotMap: [
      [/\bvom\b|verification\s+of\s+mortgage|mortgage\s+verification/i, 'vom_primary'],
      [/rent[\s-]*free|living\s+rent/i, 'rent_free_letter'],
      /* THE COMPLETED VERIFICATION, named as one — never a bare `rent` or
         `verification`. "Rent Ledger.pdf" and "Rent Receipts.pdf" are evidence a
         landlord sends WITH the form and are not the form; filed as it, the
         condition read as verified on a ledger nobody reviewed (audit S5). The
         hyphenated and run-together spellings ("verification-of-rent.pdf", the
         file's own name) are the same document. */
      [/\bvor\b|verification\s*[-\s]*of\s*[-\s]*rent|rent\s*verification/i, 'vor'],
    ],
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
  VENDOR_KINDS, ORDER_KINDS, ORDER_KIND_KEYS, CONTACT_TYPE_FOR_KIND,
  orderKind, isEnabled, slotForFilename, vendorKindFor, directoryTypeFor,
};
