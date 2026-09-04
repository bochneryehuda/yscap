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
const KNOWN = ['borrower', 'staff', 'tpo', 'engine'];

export function authVariantFlags(variant) {
  /* ⛔ AN UNKNOWN VARIANT FAILS CLOSED TO THE STAFF PANEL, NEVER THE BORROWER
     ONE. A pre-merge audit caught this returning borrower flags for 'ENGINE',
     'enginee' and undefined — so a one-character typo at a call site quietly
     told a loan officer this is the borrower platform, which is the precise
     outcome the rest of this file exists to prevent. Every caller today is one
     of the four internal/external doors; if a fifth is added, it announces
     itself here rather than silently rendering the wrong panel. */
  const known = KNOWN.includes(variant);
  const engine = variant === 'engine';
  return {
    engine,
    // Pilot Engine IS the staff console's own sign-in, named differently.
    staff: variant === 'staff' || engine || !known,
    tpo: variant === 'tpo',
    known,
  };
}

/** Is this where the visitor was heading a Pilot Engine screen? */
export function isEngineDest(dest) {
  /* THE PATH ONLY. `StaffPrivate` builds `from` as `pathname + search`, so a
     bookmark like `#/engine?tab=2` arrives with its query attached — and the
     bare comparison then read it as NOT the engine, branding that sign-in
     "Internal console". Case-insensitive for the same reason the route guard is:
     React Router serves `/Engine` from `/engine`. */
  const p = String(dest == null ? '' : dest).split(/[?#]/)[0].toLowerCase();
  return p === '/engine' || p.startsWith('/engine/');
}
