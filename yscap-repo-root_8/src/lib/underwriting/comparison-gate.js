'use strict';
/**
 * comparison-gate — the STRUCTURAL guardrail that stops the tie-out from comparing two parties
 * who are on OPPOSITE SIDES of the deal (owner-directed 2026-07-27, the tax-certificate incident).
 *
 * The bug the owner reported: PILOT flagged a fatal "the final title vesting doesn't match" by
 * comparing the vesting LLC (buyer side) against the OWNER named on a TAX CERTIFICATE — but a tax
 * cert names the CURRENT owner, i.e. the SELLER before closing, never the buyer. The field extractor
 * is SLOT-driven (it reads a document by the checklist condition it was filed under), so it dropped
 * the current owner into a "buyer" field and the tie-out compared it to the vesting entity. That is
 * a guaranteed-nonsense comparison — two parties who can never be the same person.
 *
 * The fix is to reason about WHAT each document is and WHO each named party is (their ROLE), then
 * refuse a comparison that pits a seller-side party against a buyer-side fact (or vice-versa). The
 * per-document reasoning (document-reasoning.js) supplies the party roles; this module is the PURE,
 * deterministic decision over that reasoning.
 *
 * ADVISORY-ONLY, one direction: this gate can only ever SUPPRESS a comparison (make the tie-out
 * quieter) — it can never create a finding, raise severity, block anything, or touch a number. When
 * the reasoning is absent, low-confidence, or malformed, every claim is 'ok' (byte-identical to the
 * ungated tie-out), so a file with the reasoning layer OFF behaves exactly as before. Consistent
 * with the governing rule: the AI never acts, it only helps a human see less nonsense.
 *
 * PURE — no requires, no I/O, never throws.
 */

// A party's ROLE on a document → which SIDE of the transaction they sit on. The controlled
// vocabulary the document-reasoning pass classifies parties into. Anything not listed is 'neutral'
// (a title company, a lender, a notary, a witness) and contributes to neither side.
const PARTY_ROLE_SIDE = {
  // Seller side — whoever currently holds / is conveying title.
  seller: 'seller',
  current_owner: 'seller',
  owner_of_record: 'seller',
  grantor: 'seller',
  assignor: 'seller',
  transferor: 'seller',
  prior_owner: 'seller',
  // Buyer side — whoever is acquiring / will hold title / is being underwritten.
  buyer: 'buyer',
  purchaser: 'buyer',
  grantee: 'buyer',
  assignee: 'buyer',
  transferee: 'buyer',
  vesting_entity: 'buyer',
  borrowing_entity: 'buyer',
  borrower: 'buyer',
  proposed_insured: 'buyer',
  guarantor: 'buyer',
};

// A canonical tie-out FACT (facts.js) → the side its named party represents. Only party facts are
// listed; every OTHER fact (property_address, purchase_price, as_is_value, arv, assignment_fee,
// underlying_price, units, property_type, occupancy, …) is side-NEUTRAL and never gated — an address
// or a price is the same value regardless of who is on which side.
const FACT_PARTY_SIDE = {
  entity_name: 'buyer',      // the vesting / borrowing entity — buyer side
  borrower_name: 'buyer',
  borrower_dob: 'buyer',
  borrower_address: 'buyer',
  seller_name: 'seller',
};

function sideOfRole(role) {
  if (!role) return null;
  return PARTY_ROLE_SIDE[String(role).toLowerCase().trim()] || null;
}

/**
 * What sides does this document actually NAME, per its reasoning? Derived deterministically from the
 * classified parties' roles. Returns { buyer, seller } booleans. A malformed/empty reasoning yields
 * { buyer:false, seller:false } — which makes the gate a no-op (nothing to compare against).
 */
function documentSides(reasoning) {
  const out = { buyer: false, seller: false };
  const parties = reasoning && Array.isArray(reasoning.parties) ? reasoning.parties : [];
  for (const p of parties) {
    const side = sideOfRole(p && p.role);
    if (side === 'buyer') out.buyer = true;
    else if (side === 'seller') out.seller = true;
  }
  return out;
}

// Below this the reasoning is treated as too uncertain to suppress on — default to comparing
// (the conservative direction: a missed suppression only leaves a nonsense finding a human can
// still dismiss; an over-eager suppression could hide a real one).
const MIN_CONFIDENCE = 0.6;

/**
 * claimComparable(factKey, reasoning) → 'ok' | 'suppress'
 *
 * Decide whether a document's claim for `factKey` should PARTICIPATE in the tie-out comparison,
 * given the per-document reasoning about who its named parties are.
 *
 * 'suppress' ONLY when we are confident the document names parties on the OPPOSITE side from the
 * fact — the tax-cert case (a buyer-side fact whose document names only seller-side parties). In
 * every other case ('neutral' fact, no/low-confidence reasoning, the document actually names the
 * fact's own side) the answer is 'ok'. Never throws.
 */
function claimComparable(factKey, reasoning) {
  try {
    const factSide = FACT_PARTY_SIDE[factKey];
    if (!factSide) return 'ok';                       // side-neutral fact → always compare
    if (!reasoning || typeof reasoning !== 'object') return 'ok';
    const conf = Number(reasoning.confidence);
    if (Number.isFinite(conf) && conf < MIN_CONFIDENCE) return 'ok';
    const sides = documentSides(reasoning);
    // The document names the OPPOSITE side and NOT the fact's own side → the value the extractor
    // pulled into this field belongs to the other party. Comparing it is guaranteed nonsense.
    if (factSide === 'buyer' && sides.seller && !sides.buyer) return 'suppress';
    if (factSide === 'seller' && sides.buyer && !sides.seller) return 'suppress';
    return 'ok';
  } catch (_) {
    return 'ok';   // advisory guard — a bug here must never change (or hide) a comparison
  }
}

/**
 * Apply the gate to one document's claim set: return a COPY with every cross-side party claim
 * removed. Used by the tie-out when threading a source's reasoning in. A source with no reasoning
 * returns its claims untouched.
 * @param {object} claims  the {factKey: value} map from facts.claimsFor
 * @param {object} reasoning  the per-document reasoning object (or null)
 * @returns {{ claims: object, suppressed: string[] }}
 */
function gateClaims(claims, reasoning) {
  if (!claims || typeof claims !== 'object' || !reasoning) return { claims: claims || {}, suppressed: [] };
  const out = {};
  const suppressed = [];
  for (const [k, v] of Object.entries(claims)) {
    if (claimComparable(k, reasoning) === 'suppress') { suppressed.push(k); continue; }
    out[k] = v;
  }
  return { claims: out, suppressed };
}

module.exports = {
  claimComparable,
  gateClaims,
  documentSides,
  _internals: { PARTY_ROLE_SIDE, FACT_PARTY_SIDE, sideOfRole, MIN_CONFIDENCE },
};
