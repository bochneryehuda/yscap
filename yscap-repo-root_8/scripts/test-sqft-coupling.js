/**
 * sqft is coupled to the rehab type (src/lib/fields.js sqftForType).
 *
 * The intake forms show the "existing / completed sq ft" inputs only for a
 * square-footage / ground-up rehab but ALWAYS submit them, so switching the rehab
 * type to e.g. "Cosmetic" left stale sqft behind. The pricing engine then flipped
 * sqftAddition on via its `sqft_post > sqft_pre` clause even though the file is no
 * longer an addition. Every write path now routes sqft through sqftForType, which
 * nulls the pair for an irrelevant rehab type — so the pricing engine sees clean
 * data. Pure, no DB.
 */
const { sqftForType, sqftRelevantType } = require('../src/lib/fields');
const { buildInputs } = require('../src/lib/pricing');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- sqftRelevantType / sqftForType ----
assert(sqftRelevantType('Adding square footage') === true, 'Adding square footage is sqft-relevant');
assert(sqftRelevantType('Ground-up construction') === true, 'Ground-up construction is sqft-relevant');
assert(sqftRelevantType('Cosmetic') === false, 'Cosmetic is NOT sqft-relevant');
assert(sqftRelevantType('Moderate') === false, 'Moderate is NOT sqft-relevant');
assert(sqftRelevantType('') === true, 'blank type is left alone (relevant=true, no nulling)');

const kept = sqftForType('Adding square footage', 1000, 2000);
assert(kept.sqftPre === 1000 && kept.sqftPost === 2000, 'sqft kept for a square-footage rehab');
const cleared = sqftForType('Cosmetic', 1000, 2000);
assert(cleared.sqftPre === null && cleared.sqftPost === null, 'sqft nulled when the rehab type is Cosmetic');
const blank = sqftForType('', 500, 600);
assert(blank.sqftPre === 500 && blank.sqftPost === 600, 'sqft left alone for a blank (incomplete) rehab type');

// ---- end-to-end: the guard's output clears the pricing sqftAddition flag ----
// The bug: a Cosmetic file carrying stale sqft prices as an addition.
const stale = buildInputs({ rehab_type: 'Cosmetic', sqft_pre: 1000, sqft_post: 2000 });
assert(stale.sqftAddition === true, 'DEMONSTRATES the trap: Cosmetic + stale sqft → sqftAddition true');
// After the write guard nulls the stale sqft, the same file no longer misprices.
const clean = sqftForType('Cosmetic', 1000, 2000);
const fixed = buildInputs({ rehab_type: 'Cosmetic', sqft_pre: clean.sqftPre, sqft_post: clean.sqftPost });
assert(fixed.sqftAddition === false, 'FIX: after nulling stale sqft, Cosmetic no longer prices as an addition');
// A genuine square-footage addition still prices correctly.
const real = sqftForType('Adding square footage', 1000, 2000);
const realIn = buildInputs({ rehab_type: 'Adding square footage', sqft_pre: real.sqftPre, sqft_post: real.sqftPost });
assert(realIn.sqftAddition === true, 'a real square-footage addition still flags sqftAddition');

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL sqft-coupling assertions passed');
process.exit(failures ? 1 : 0);
