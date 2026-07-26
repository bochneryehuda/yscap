/**
 * Property-type → unit-count logic (app-v2/src/lib/enums.js).
 *
 * Owner-reported: single-family must auto-fill 1 unit (locked) and "Multi 2–4"
 * must be a 2/3/4 dropdown. The proactive follow-up found a second class of bug:
 * a property type we don't recognize as single/2-4/5+ (e.g. "New Construction",
 * "Commercial", "Land" — all real ClickUp inbound values, shown on the staff
 * Edit-details form via withCurrent) was mis-classified as single-unit, LOCKING
 * units to 1 and OVERWRITING a real multi-unit count to 1 on save. Unknown types
 * must be 'open' (free entry) — never locked, never forced to 1.
 *
 * Pure functions, no DB — runs everywhere.
 */
import { unitsMode, unitsForType } from '../app-v2/src/lib/enums.js';

let failures = 0;
const eq = (got, exp, m) => { const ok = got === exp; console.log(`${ok ? 'PASS' : 'FAIL'} ${m} (got ${JSON.stringify(got)} exp ${JSON.stringify(exp)})`); if (!ok) failures++; };

// ---- unitsMode ----
eq(unitsMode('SFR'), 'single', 'SFR → single');
eq(unitsMode('SFR (1 unit)'), 'single', 'SFR (1 unit) label → single');
eq(unitsMode('Condo'), 'single', 'Condo → single');
eq(unitsMode('Townhouse'), 'single', 'Townhouse → single');
eq(unitsMode('Multi 2-4'), 'select24', 'Multi 2-4 (hyphen) → select24');
eq(unitsMode('Multi 2–4'), 'select24', 'Multi 2–4 (en-dash) → select24');
eq(unitsMode('Multi 5+'), 'multi', 'Multi 5+ → multi');
eq(unitsMode('Mixed Use'), 'multi', 'Mixed Use → multi');
eq(unitsMode('Mixed use'), 'multi', 'Mixed use → multi');
// The bug class: unknown / non-enum types must be 'open', not 'single'.
eq(unitsMode('New Construction'), 'open', 'New Construction → open (NOT single)');
eq(unitsMode('Commercial'), 'open', 'Commercial → open');
eq(unitsMode('Land'), 'open', 'Land → open');
eq(unitsMode(''), 'open', 'blank → open (no lock before a type is picked)');
eq(unitsMode(null), 'open', 'null → open');

// ---- unitsForType ----
eq(unitsForType('SFR', ''), '1', 'SFR forces 1');
eq(unitsForType('Condo', '3'), '1', 'Condo forces 1 even over a stale 3');
eq(unitsForType('Multi 2-4', '1'), '', 'switching to 2-4 clears a carried single "1"');
eq(unitsForType('Multi 2-4', '3'), '3', 'Multi 2-4 keeps a real count');
eq(unitsForType('Multi 5+', '1'), '', 'switching to 5+ clears a carried single "1"');
eq(unitsForType('Multi 5+', '6'), '6', 'Multi 5+ keeps a real count');
// The bug class: an unknown type must NOT force or clear the count.
eq(unitsForType('New Construction', '4'), '4', 'New Construction keeps a real 4 (was overwritten to 1)');
eq(unitsForType('New Construction', '1'), '1', 'New Construction keeps a legit 1 (not cleared)');
eq(unitsForType('New Construction', ''), '', 'New Construction with no count stays empty');
eq(unitsForType('', '4'), '4', 'no type chosen — count left untouched');

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL units-mode assertions passed');
process.exit(failures ? 1 : 0);
