/**
 * THE PRICING PROGRAM'S NAME — one map, not a ternary chain per screen.
 *
 * Before the Speed Program joined (2026-09-03) the portal carried ELEVEN copies of
 *   `p === 'gold' ? 'Gold Standard…' : p === 'silver' ? 'Silver…' : … : 'Standard…'`
 * across five screens and two components. A fourth program would have meant a
 * sixth branch in each of them, and the audit that found the eleven found they
 * had already drifted (one printed "Gold", one "Manual", one "Manual Program" for
 * the same key). So: every label a person sees for a pricing-program KEY comes
 * from here, and adding a program is one row in two maps.
 *
 * These are the RTL PRICING programs (the frozen engines' keys — what
 * `product_registrations.program` / `applications.registered_program` store).
 * They are NOT the deal-strategy list in `enums.js PROGRAMS` (Fix & Flip / Bridge /
 * DSCR), and not `labels.js programLabel`, which titles the borrower's strategy.
 *
 * Borrower-facing by construction: a program's name, never a note buyer's.
 */
export const PROGRAM_LABEL = Object.freeze({
  standard: 'Standard Program',
  gold: 'Gold Standard Program',
  silver: 'Silver Program',
  speed: 'Speed Program',
  manual: 'Manual Program',
});

export const PROGRAM_SHORT = Object.freeze({
  standard: 'Standard',
  gold: 'Gold Standard',
  silver: 'Silver',
  speed: 'Speed',
  manual: 'Manual',
});

/** The pricing-program keys, in the order the studio lays them out. */
export const PRICING_PROGRAM_KEYS = Object.freeze(Object.keys(PROGRAM_LABEL));

/**
 * The label for a program key. `short` gives the card / badge form ("Silver")
 * instead of the full one ("Silver Program"). An unknown, blank or missing key
 * reads as Standard — exactly the fallback every replaced chain ended on — so a
 * legacy row with no program still prints what it always printed.
 */
export function programLabel(key, { short = false } = {}) {
  const map = short ? PROGRAM_SHORT : PROGRAM_LABEL;
  const k = String(key == null ? '' : key).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : map.standard;
}
