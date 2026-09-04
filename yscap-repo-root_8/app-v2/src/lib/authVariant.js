/**
 * PILOT ENGINE wears its own name on the sign-in page, and it is the SAME
 * sign-in page (owner-directed 2026-09-04: *"the log in page should have a
 * regular pilot design of the pilot log in page but some added design for the
 * new name"*).
 *
 * PURE — no React, no imports — so both rules below can be PROVEN by calling
 * them rather than by grepping the screens that use them. Both are small and
 * both are load-bearing:
 *
 * ⛔ `staff` STAYS TRUE FOR THE ENGINE. Every staff-only piece of the sign-in
 * panel hangs off it. Let it go false and the engine's door quietly renders the
 * BORROWER panel — telling a loan officer this is the borrower platform, on the
 * one screen where the wording is doing real work.
 *
 * ⛔ THE ENGINE IS MATCHED AS A ROUTE, NOT AS A PREFIX. A bare
 * `startsWith('/engine')` also matches `/engineering`, so an unrelated route
 * added later would silently be branded Pilot Engine.
 */

/**
 * Which sign-in panel a variant draws.
 * @param {string} variant  'borrower' | 'staff' | 'tpo' | 'engine'
 */
export function authVariantFlags(variant) {
  const engine = variant === 'engine';
  return {
    engine,
    // Pilot Engine IS the staff console's own sign-in, named differently.
    staff: variant === 'staff' || engine,
    tpo: variant === 'tpo',
  };
}

/** Is this where the visitor was heading a Pilot Engine screen? */
export function isEngineDest(dest) {
  const p = String(dest == null ? '' : dest);
  return p === '/engine' || p.startsWith('/engine/');
}
