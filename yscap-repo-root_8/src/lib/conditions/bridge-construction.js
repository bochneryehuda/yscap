'use strict';
/**
 * A BRIDGE WITHOUT CONSTRUCTION CARRIES NO BUDGET / SCOPE-OF-WORK CONDITIONS
 * (owner-directed 2026-09-03: *"when somebody is putting in a bridge loan
 * without construction, the condition still pops up for him to put in a
 * construction budget scope of work. That condition should be removed from
 * what's populating on a bridge loan. It's still populated on fix and hold, fix
 * and flip, and ground up."*).
 *
 * THIS IS THE JS HALF OF ONE RULE. The SQL twin is `pilot_bridge_without_construction()`
 * in db/691, which the `applications` trigger uses to take the three conditions
 * off a file that becomes a bridge and put them back on one that stops being
 * one. `scripts/test-bridge-construction-db.js` runs both halves over the same
 * battery and fails the build the day they disagree — the mirror rule CLAUDE.md
 * insists on ("a browser twin of a server rule … a test must fail the moment
 * they disagree").
 *
 * THE ORDER OF THE TESTS IS THE FROZEN ENGINE'S. `conditions/field-registry.js
 * normStrategy` (and the pricing engine before it) rules out ground-up first,
 * then the long-term strategies, then fix & hold, and only THEN asks "bridge" —
 * so a program text that says both never lands on the wrong side. The
 * feasibility-fee lesson of 2026-08-26 is why `rehab_type` is NOT read as
 * evidence of construction: the studio hides the rehab-scope control when a
 * deal moves off fix & flip and does not clear it, so a bridge routinely still
 * says "Heavy". What says a bridge builds is its PROGRAM ("… With
 * Construction") or a rehab BUDGET somebody typed.
 *
 * PURE. Reads only the four columns handed to it.
 */

/** The three conditions that exist only because something is being built. */
const CONSTRUCTION_ONLY_CODES = Object.freeze(['rtl_p1_budget', 'rtl_p3_sow1', 'rtl_p3_sow2']);

const low = (v) => String(v == null ? '' : v).toLowerCase();

/**
 * @param {{program?:string, loan_type?:string, rehab_type?:string, rehab_budget?:number|string|null}} row
 * @returns {boolean} true only for a bridge that is NOT building anything.
 */
function isBridgeWithoutConstruction(row) {
  const r = row || {};
  const t = [low(r.program), low(r.loan_type), low(r.rehab_type)].join(' ');
  if (/ground/.test(t) || (/construction/.test(t) && /new/.test(t))) return false;   // ground-up first
  if (/dscr|rental|stabilized|long[-\s]?term|30[-\s]?year/.test(t)) return false;      // not a short-term strategy
  if (/hold|brrrr/.test(t)) return false;                                              // fix & hold builds
  if (!/bridge/.test(t)) return false;                                                 // not a bridge at all
  if (/with\s+construction/.test(t)) return false;                                     // a bridge that says it builds
  // The column is numeric(14,2); a caller handing a typed string ("12,000") is
  // read the way the money parsers read it, so a comma never hides a budget.
  const budget = typeof r.rehab_budget === 'string'
    ? Number(r.rehab_budget.replace(/[^0-9.-]/g, ''))
    : Number(r.rehab_budget);
  if (Number.isFinite(budget) && budget > 0) return false;                             // a budget somebody typed
  return true;
}

module.exports = { CONSTRUCTION_ONLY_CODES, isBridgeWithoutConstruction };
