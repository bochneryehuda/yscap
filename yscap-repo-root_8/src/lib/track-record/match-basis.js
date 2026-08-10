'use strict';
/**
 * HOW a found property matched the borrower — the transparency the owner asked
 * for (2026-08-10, the "MAJOR enhancement"):
 *
 *   "Every single record should come up: why you matched it, how you matched it
 *    … we should have a personal name and the entity name … if you find
 *    properties related to any entity on the profile but you see a lot of
 *    different people's names and you don't see our borrower's name, set up a
 *    high-level warning that it's matching the entity but not the personal name
 *    — it's very possible it's a few companies with like names."
 *
 * ═══ THE SIGNAL IS THE SEARCH BRANCH, PLUS THE ENTITY'S OWN PEOPLE ══════════
 * The public-records search runs two ways, and which one surfaced a property is
 * the strongest thing we know about how it matched:
 *   · PERSON branch — the deed named the borrower's PERSONAL name. Confident:
 *     the vendor resolved the person and returned that person's deeds.
 *   · ENTITY branch — the deed named a COMPANY on the profile. That the company
 *     name matches is not the same as the company being the borrower's, so the
 *     vendor's associated-people list answers the second question: is the
 *     borrower among the people behind it? If yes, the entity is confirmed
 *     theirs. If NOT, and OTHER people are, it may be a different company with
 *     the same name — a HIGH-LEVEL PENDING WARNING.
 *
 * ═══ ADVISORY ONLY — NEVER AUTO-DECIDE OUT OF THE FOOTPRINT ═════════════════
 * The owner: "it should not decide by her own that it's out of the footprint."
 * So a warning is displayed and the property still goes through the same human
 * review; nothing is auto-declined. And when we CANNOT check (the vendor
 * returned no people), we do NOT warn — an unknown is never treated as a "no".
 *
 * PURE: the person-name matcher is INJECTED (`namesMatch`), so this reasons
 * about the shapes with no dependency on the underwriting comparer or a database.
 */

const str = (v) => String(v == null ? '' : v).trim();

/** The short badge text for each basis — plain words for a non-developer. */
const LABELS = {
  personal: 'Matched by personal name',
  both: 'Matched by personal name + company',
  entity_only: 'Matched by company only',
};

/**
 * @param {object} a
 * @param {'person'|'entity'} a.branch      which search branch surfaced it
 * @param {string} a.personalName           the borrower's personal name
 * @param {string} a.entityName             the company on the deed (candidate's own, or the searched entity)
 * @param {Array}  a.entityPeople           the entity's associated people ({name,type}) — entity branch only
 * @param {function} a.namesMatch           (a,b)=>bool person-name matcher (injected; e.g. compare.namesMatchLoose)
 * @returns {object} the match basis, ready to store as jsonb and render
 */
function computeMatchBasis({ branch, personalName, entityName, entityPeople, namesMatch } = {}) {
  const person = str(personalName);
  const entity = str(entityName);
  const match = typeof namesMatch === 'function' ? namesMatch : () => false;
  const safeMatch = (nm) => { try { return !!match(nm, person); } catch (_) { return false; } };
  const people = (Array.isArray(entityPeople) ? entityPeople : [])
    .map((p) => str(p && (typeof p === 'string' ? p : (p.name || p.partyName))))
    .filter(Boolean);

  if (branch === 'person') {
    /* A non-empty entity means "also matched a company on the profile" — UNLESS
       that "entity" is really the borrower's OWN personal name (a deal bought in
       their own name, where firstOurName returned the person). Never call a
       person their own company. Belt-and-suspenders: the importer already
       resolves this at stage time, but the pure rule must hold on its own. */
    const both = !!entity && !safeMatch(entity);
    return {
      personalMatched: true,
      entityMatched: both,
      personalName: person || null,
      entityName: entity || null,
      basis: both ? 'both' : 'personal',
      label: LABELS[both ? 'both' : 'personal'],
      warn: false,
      peopleKnown: null,
      otherPeopleCount: 0,
      why: both
        ? `Matched to the borrower's personal name${person ? ` (${person})` : ''} and to the company ${entity} on the profile.`
        : `Matched to the borrower's personal name${person ? ` (${person})` : ''} on the deed.`,
    };
  }

  // ── ENTITY branch ────────────────────────────────────────────────────────
  const peopleKnown = people.length > 0;
  const personInPeople = !!person && people.some(safeMatch);
  const others = person ? people.filter((nm) => !safeMatch(nm)) : people;
  const warn = !personInPeople && others.length > 0;
  const basis = personInPeople ? 'both' : 'entity_only';
  let why;
  if (personInPeople) {
    why = `Matched to the company ${entity} on the profile, and ${person} is on record as one of the people behind it.`;
  } else if (warn) {
    why = `Matched to the company ${entity} on the profile — but ${person || 'the borrower'}'s personal name is NOT among the ${others.length} ${others.length === 1 ? 'person' : 'people'} the records show behind this company. It may be a different company with the same name (companies with like names are filed in different states). Confirm this is really theirs before importing.`;
  } else {
    why = `Matched to the company ${entity} on the profile.`;
  }
  return {
    personalMatched: personInPeople,
    entityMatched: true,
    personalName: personInPeople ? person : null,
    entityName: entity || null,
    basis,
    label: LABELS[basis],
    warn,
    peopleKnown,
    otherPeopleCount: others.length,
    why,
  };
}

module.exports = { computeMatchBasis, LABELS };
