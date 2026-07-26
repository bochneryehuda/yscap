'use strict';

// Server mirror of app-v2/src/lib/enums.js unitsMode / unitsForType. The frontend
// couples the unit count to the property type on the intake forms, but a few
// SERVER write paths change property_type WITHOUT the form deriving units (the
// borrower completeness panel, a direct API call, an approved change request), so
// a single-family type wouldn't auto-fill "1 unit" and a switch to multi could
// leave a stale "1" behind. This is the same rule, server-side, so those paths
// stay consistent with the forms. Keep the two in lockstep if either changes.
//
//   'single'   → SFR / Condo / Townhouse: units is always 1.
//   'select24' → "Multi 2-4": a 2 / 3 / 4 count.
//   'multi'    → "Multi 5+" / "Mixed use": 5 or more.
//   'open'     → anything else (e.g. "New Construction" from ClickUp): free — never
//                forced to 1 and never cleared.
function unitsMode(propType) {
  const p = String(propType || '');
  if (/2.?4/.test(p)) return 'select24';
  if (/5\s*\+|mixed/i.test(p)) return 'multi';
  if (/sfr|single|condo|town/i.test(p)) return 'single';
  return 'open';
}

// Resolve the unit count when the property type is (re)written. Single-unit types
// are always exactly 1; switching to a KNOWN multi type clears a carried-over "1"
// (a single-family default posing as a real count); unknown ('open') types and a
// blank type are left untouched. Returns the next units value (number or null).
function unitsForPropertyType(propType, prevUnits) {
  if (!propType) return prevUnits == null ? null : prevUnits;
  const mode = unitsMode(propType);
  if (mode === 'single') return 1;
  if (mode === 'open') return prevUnits == null ? null : prevUnits;
  // select24 / multi: drop a stale single-family "1"; keep any real count.
  return Number(prevUnits) === 1 ? null : (prevUnits == null ? null : prevUnits);
}

module.exports = { unitsMode, unitsForPropertyType };
