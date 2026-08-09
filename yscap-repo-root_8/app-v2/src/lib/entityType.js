/**
 * WHAT KIND OF COMPANY THIS IS — the portal's mirror of `src/lib/entity-type.js`.
 *
 * The server module is the authority; this is the browser copy, the same
 * arrangement `lib/payoff.js` and `lib/dealBasis.js` already use (the portal
 * cannot `require` server code, and a screen must be able to draw the picker
 * before it has asked anything). `scripts/test-entity-type-pure.js` reads BOTH
 * files and fails the moment they disagree, so the mirror cannot drift.
 *
 * WHY IT EXISTS AT ALL. PILOT's table for a borrowing company is called `llcs`
 * and every screen assumed the name was the whole truth — so a corporation was
 * asked for an operating agreement it does not have, and no loan document could
 * say whether the entity has MEMBERS holding a percentage or SHAREHOLDERS
 * holding shares. Owner-directed 2026-08-09.
 *
 * NEVER hard-code one of these words in a screen. Ask this module.
 */

export const ENTITY_TYPES = [
  { key: 'llc', label: 'LLC', longLabel: 'Limited liability company',
    governingDocWord: 'operating agreement', ownerNoun: 'member', ownerNounPlural: 'members', usesShares: false },
  { key: 'corporation', label: 'Corporation', longLabel: 'Corporation (Inc / S-Corp)',
    governingDocWord: 'bylaws', ownerNoun: 'shareholder', ownerNounPlural: 'shareholders', usesShares: true },
  { key: 'partnership', label: 'Partnership', longLabel: 'Partnership (LP / LLP / general)',
    governingDocWord: 'partnership agreement', ownerNoun: 'partner', ownerNounPlural: 'partners', usesShares: false },
  { key: 'trust', label: 'Trust', longLabel: 'Trust',
    governingDocWord: 'trust agreement', ownerNoun: 'trustee', ownerNounPlural: 'trustees', usesShares: false },
];

export const DEFAULT_ENTITY_TYPE = 'llc';

const AUTHORIZED_SIGNATORY = 'Authorized Signatory';

/**
 * The titles an owner may hold, per type — a FIXED list, never a text box. This
 * value prints under a signature line on a recorded instrument and DocLab merges
 * it verbatim, so "managing member", "Managing Member" and "MGR" must not all be
 * reachable. `Authorized Signatory` is on every list so the picker can never
 * become a dead end that forces somebody into a wrong answer.
 */
export const ENTITY_TITLES = {
  llc: ['Managing Member', 'Member', 'Manager', 'Managing Partner', 'President', AUTHORIZED_SIGNATORY],
  corporation: ['President', 'Vice President', 'Secretary', 'Treasurer',
    'Chief Executive Officer', 'Chief Financial Officer', 'Director', 'Shareholder', AUTHORIZED_SIGNATORY],
  partnership: ['General Partner', 'Managing Partner', 'Limited Partner', 'Partner', AUTHORIZED_SIGNATORY],
  trust: ['Trustee', 'Co-Trustee', 'Successor Trustee', 'Grantor', 'Beneficiary', AUTHORIZED_SIGNATORY],
};

const BY_KEY = ENTITY_TYPES.reduce((m, t) => { m[t.key] = t; return m; }, {});

/** The stored key for anything a human or a form might have typed. '' if unreadable. */
export function normalizeEntityType(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return DEFAULT_ENTITY_TYPE;
  if (BY_KEY[s]) return s;
  if (/^l\.?l\.?c\.?$/.test(s) || s.includes('limited liability')) return 'llc';
  if (s.startsWith('corp') || s.includes('inc') || s.includes('s-corp') || s.includes('corporation')) return 'corporation';
  if (s.includes('partnership') || s === 'lp' || s === 'llp') return 'partnership';
  if (s.includes('trust')) return 'trust';
  return '';
}

/**
 * Everything a screen needs to describe one entity without knowing the rules.
 * `ownershipLabel` is the one that matters: asking a corporation for its
 * "membership interest" is asking the wrong question, and asking an LLC for a
 * share count is asking for a number that does not exist.
 */
export function describeEntity(entity) {
  const t = BY_KEY[normalizeEntityType(entity && (entity.entity_type || entity.entityType))] || BY_KEY[DEFAULT_ENTITY_TYPE];
  return {
    ...t,
    ownershipLabel: t.usesShares ? 'Shares' : 'Ownership %',
    titles: ENTITY_TITLES[t.key] || ENTITY_TITLES[DEFAULT_ENTITY_TYPE],
    confirmed: !!(entity && (entity.entity_type_confirmed || entity.entityTypeConfirmed)),
  };
}

/** The titles this type offers. */
export function titlesFor(type) {
  return ENTITY_TITLES[normalizeEntityType(type) || DEFAULT_ENTITY_TYPE] || ENTITY_TITLES[DEFAULT_ENTITY_TYPE];
}

/**
 * True when nobody has actually CHOSEN this entity's type — db/494 stamped the
 * whole back book `llc` so the loans already in flight kept working, and
 * "we assumed" is a different fact from "a person said so". A screen about to
 * act on the type should say which it is holding rather than state a guess.
 */
export function entityTypeAssumed(entity) {
  return !!entity && !(entity.entity_type_confirmed || entity.entityTypeConfirmed);
}
