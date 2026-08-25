'use strict';
/**
 * HOW A LONG-TERM LOAN VESTS — the one answer, so two screens cannot give two.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-25): *"on the long summary screen, in the
 * middle of the page, 'Vesting entity' is empty, but on top we do have a vesting
 * entity. Something over there is messed up."*
 *
 * BOTH SCREENS WERE RIGHT ABOUT THEIR OWN SOURCE, AND THAT WAS THE BUG. The plate at
 * the top reads Encompass **field 4008** — the vesting description, mirrored onto
 * `lt_loans.vesting_type` / `vesting_entity_name`. The Loan summary read the 1003's
 * **PARTY rows** (`lt_parties` where `party_type = 'entity'`). They are two different
 * records of one fact, and on this tenant the entity is routinely stated in 4008 while
 * no entity party row exists — so the top of the file named the company and the middle
 * of the same page said there wasn't one.
 *
 * The rail's own header already records this exact class, about a different fact:
 * *"Two answers to one question on two screens is worse than one answer we did not
 * derive."* This is that lesson applied to the vesting.
 *
 * THE RULE IS THE OWNER'S (2026-08-24, field 4008): **"individual" means individual.**
 * Only look for an entity name when 4008 says it vests in one. That is why an entity
 * PARTY row is deliberately NOT allowed to overrule a 4008 that says individual — a
 * loan can carry a party row for a company that guarantees it while the title itself
 * vests in a person, and reading that as the vesting would put a company's name on
 * the wrong loan.
 *
 * WHERE THE NAME COMES FROM, in order, and it always SAYS which:
 *   1. field 4008's own name          — Encompass's answer to the question asked
 *   2. an entity party's legal name   — the 1003's answer, when 4008 named none
 *   3. nothing                        — it vests in an entity nobody has named yet,
 *                                       which is reported as exactly that
 *
 * PURE. No database, no network, no requires — so the file payload, the rail, and
 * every test ask the same thing, and none of them can grow a second opinion.
 */

const txt = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
};

/** Does field 4008 say this loan vests in a person? */
const saysIndividual = (vestingType) => String(vestingType || '').trim().toLowerCase() === 'individual';

/**
 * @param {object} loan     an `lt_loans` row (vesting_type, vesting_entity_name)
 * @param {Array}  parties  the file's parties, as `file.borrowers.parties` shapes them
 *                          ({ partyType, name }) — an empty list is fine and common.
 */
function vestingOf(loan, parties) {
  const l = loan || {};
  const stated = txt(l.vesting_type);
  const entityParties = (Array.isArray(parties) ? parties : [])
    .filter((p) => p && p.partyType === 'entity')
    .map((p) => txt(p.name))
    .filter(Boolean);

  // NOTHING STATED IS NOT "INDIVIDUAL". A loan PILOT has not read in full has no
  // vesting_type at all, and answering "Individual" there would state a fact about
  // the title that nobody has told us — the same class as reading a blank as a zero.
  if (!stated) {
    return {
      type: null,
      entityName: null,
      entityNames: entityParties,
      source: null,
      label: null,
      why: 'Encompass has not said how this loan vests yet.',
    };
  }

  if (saysIndividual(stated)) {
    return {
      type: 'individual',
      entityName: null,
      // The party rows are carried through even here, because a company on the file
      // is worth SEEING — it is simply not the vesting. The screen words that.
      entityNames: entityParties,
      source: 'field_4008',
      label: 'Individual',
      why: null,
    };
  }

  const fromField = txt(l.vesting_entity_name);
  const fromParty = entityParties.length ? entityParties.join(' · ') : null;
  const name = fromField || fromParty;
  return {
    type: 'entity',
    entityName: name,
    entityNames: entityParties,
    source: name ? (fromField ? 'field_4008' : 'party') : null,
    // "Entity" is the honest label when we know it vests in a company and nobody has
    // named it — better than a dash, which reads as "there isn't one".
    label: name || 'Entity',
    why: name ? null : 'Encompass says this loan vests in an entity but has not named it yet.',
  };
}

/** Where a name came from, in words. Never a code on a screen. */
const SOURCE_WORDS = {
  field_4008: 'from the vesting line on the loan',
  party: 'from the borrowing party on the application',
};

module.exports = { vestingOf, saysIndividual, SOURCE_WORDS, _internals: { txt } };
