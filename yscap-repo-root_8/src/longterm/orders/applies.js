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
 * THE RULES ARE THE CONDITION CENTRE'S, restated in ONE place rather than
 * three: `is_condo` is /condo/i on the GSE property type and `is_new_york` is
 * NY-or-New-York on the state, exactly as `conditions-center/field-registry.js`
 * reads them. The order desk cannot import that registry (it reads a whole rule
 * context it has no use for), so the two are kept in step by a test that runs
 * BOTH over the same values — a copy that agrees today and drifts tomorrow is
 * how one screen greys a card the other one requires.
 *
 * THREE-VALUED, and the third value is the point. `null` means the file does not
 * say yet — a property with no type on it is not a "no". An unknown applies:
 * showing an order somebody cannot use costs a click, and hiding one they need
 * costs a closing.
 */

/** Which single fact gates each order kind. Everything absent from here applies
    to every file — most orders are not about a kind of property at all. */
const GATES = Object.freeze({
  flood_insurance: {
    fact: 'inFloodZone',
    read: (d) => (d.inFloodZone === true ? true : (d.inFloodZone === false ? false : null)),
    no: 'This property is not marked as being in a flood zone.',
    unknown: 'Nobody has said yet whether this property is in a flood zone.',
    // The one gate a person can change from here, so its wording says so.
    settable: true,
  },
  ny_settlement_agent: {
    fact: 'propertyState',
    read: (d) => {
      const s = String(d.propertyState || '').trim();
      if (!s) return null;
      return /^(ny|new\s*york)$/i.test(s);
    },
    no: 'This is not a New York file, and only New York files use a settlement agent.',
    unknown: 'The property’s state is not on the file yet.',
  },
  condo_questionnaire: {
    fact: 'propertyType',
    read: (d) => {
      const t = String(d.propertyType || '').trim();
      if (!t) return null;
      return /condo/i.test(t);
    },
    no: 'This property is not a condominium.',
    unknown: 'The property type is not on the file yet.',
  },
});

/**
 * @param {string} kind   an ORDER_KINDS key
 * @param {object} d      `orders/data.getOrderData` output
 * @returns {{applies: boolean|null, why: string|null, fact: string|null, settable: boolean}}
 */
function appliesTo(kind, d) {
  const gate = GATES[String(kind || '').trim()];
  if (!gate) return { applies: true, why: null, fact: null, settable: false };
  let v = null;
  try { v = gate.read(d || {}); } catch (_) { v = null; }
  if (v === true) return { applies: true, why: null, fact: gate.fact, settable: !!gate.settable };
  if (v === false) return { applies: false, why: gate.no, fact: gate.fact, settable: !!gate.settable };
  return { applies: null, why: gate.unknown, fact: gate.fact, settable: !!gate.settable };
}

module.exports = { appliesTo, GATES };
