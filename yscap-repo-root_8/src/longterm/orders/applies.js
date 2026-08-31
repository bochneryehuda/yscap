'use strict';
/**
 * DOES THIS ORDER BELONG TO THIS FILE AT ALL?
 *
 * A THIRD question, separate from the two the desk already answers, and keeping
 * the three apart is the whole point:
 *
 *   · `enabled`  — is this order switched on for the company? (a SETTING)
 *   · `blockers` — is anything missing before it can go? (a TODO)
 *   · `applies`  — is this the KIND of file this order is for? (a FACT)
 *
 * Owner-directed 2026-08-31: *"The Flood Insurance Order should be grayed out
 * unless you switch this switch so that this property is in a flood zone"*,
 * *"The New York Settlement Agent Order should be grayed out. And collapsed. Be
 * visible that doesn't belong for this file"*, and *"Same for a condo. A file
 * that is not a condo should be grayed out."*
 *
 * VISIBLE AND GREYED, NEVER HIDDEN. A desk that silently drops three of its
 * seven cards reads as a desk that broke; one that shows all seven and says
 * "not this file" reads as a desk that checked. That is the same call the
 * condition centre makes for a contact row, and the same reason.
 *
 * THE RULE IS THE CONDITION CENTRE'S, AND IT IS NOT RESTATED HERE AT ALL.
 *
 * This module used to carry its own small table of facts — /condo/i on the GSE
 * property type, NY-or-New-York on the state — kept in step with
 * `conditions-center/field-registry.js` by a test that ran both. Its own header
 * named the hazard: *"a copy that agrees today and drifts tomorrow is how one
 * screen greys a card the other one requires."* It drifted, and not by
 * disagreeing: the A-TO-Z AUDIT (2026-08-31) found the table had no entry AT ALL
 * for the payoff order or the verification of rent, so both showed as belonging
 * on every file — including the purchases and the owner-occupied files whose
 * conditions the engine never attaches. A second table cannot be kept in step
 * with a rule it does not know exists.
 *
 * So the FACT now comes from the engine: an order belongs on this file when the
 * CONDITION IT ANSWERS is on this file. The engine attached it from the owner's
 * own rule, `routes/orders.js` re-runs `evaluateLoan` immediately before the desk
 * is read, and there is no longer any second statement of the rule to drift. What
 * stays here is only the WORDING — the sentence a person reads on a greyed card —
 * and which fact the card's own switch writes.
 *
 * AN ORDER WITH NO ENTRY BELOW APPLIES TO EVERY FILE, deliberately: the title and
 * insurance conditions are `autoApply: 'always'`, so their presence would answer
 * "true" every time anyway, and saying so plainly beats a lookup that can only
 * ever agree.
 *
 * THREE-VALUED, and the third value is the point. `null` means the file does not
 * say yet — a property with no type on it is not a "no". An unknown applies:
 * showing an order somebody cannot use costs a click, and hiding one they need
 * costs a closing.
 */

/**
 * THE WORDING for each gated order, and the fact its own switch writes.
 *
 * `fact` names the thing a person would have to change for the answer to change
 * — it is what the desk's switch is labelled from, not what is read here.
 * Everything absent from this table applies to every file.
 */
const kinds = require('./kinds');

const GATES = Object.freeze({
  flood_insurance: {
    fact: 'inFloodZone',
    no: 'This property is not marked as being in a flood zone.',
    unknown: 'Nobody has said yet whether this property is in a flood zone.',
    // The one gate a person can change from here, so its wording says so.
    settable: true,
  },
  ny_settlement_agent: {
    fact: 'propertyState',
    no: 'This is not a New York file, and only New York files use a settlement agent.',
    unknown: 'The property’s state is not on the file yet.',
  },
  condo_questionnaire: {
    fact: 'propertyType',
    no: 'This property is not a condominium.',
    unknown: 'The property type is not on the file yet.',
  },
  payoff: {
    fact: 'loanPurpose',
    no: 'This is a purchase, so there is no existing loan to pay off.',
    unknown: 'The loan purpose is not on the file yet.',
  },
  vor: {
    fact: 'borrowerRents',
    no: 'The borrower is not renting, so there is no landlord to ask about their rent.',
    unknown: 'It is not on the file yet whether the borrower rents.',
  },
});

/**
 * @param {string} kind   an ORDER_KINDS key
 * @param {object} d      `orders/data.getOrderData` output
 * @returns {{applies: boolean|null, why: string|null, fact: string|null, settable: boolean}}
 */
function appliesTo(kind, d) {
  const k = String(kind || '').trim();
  const gate = GATES[k];
  if (!gate) return { applies: true, why: null, fact: null, settable: false };

  const def = kinds.orderKind(k);
  const code = def && def.condition;
  const codes = d && Array.isArray(d.conditionCodes) ? d.conditionCodes : null;

  /* UNREADABLE IS NOT A NO. An empty list means this file has no conditions; a
     null means PILOT could not read them, and greying an order out on that would
     tell somebody an order does not belong when nobody has looked. */
  if (!code || !codes) {
    return { applies: null, why: gate.unknown, fact: gate.fact, settable: !!gate.settable };
  }
  const on = codes.includes(code);
  return {
    applies: on,
    why: on ? null : gate.no,
    fact: gate.fact,
    settable: !!gate.settable,
  };
}

module.exports = { appliesTo, GATES };
