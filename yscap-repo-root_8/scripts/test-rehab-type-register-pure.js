/**
 * The rehab type the Term Sheet Studio priced must land ON the loan file.
 *
 * Owner-reported 2026-07-27: "you always need to select what kind of rehab it is
 * — heavy, light, cosmetic, expansion — but it doesn't get saved into the file,
 * and after you register on Products & Pricing the loan application screen still
 * shows nothing." Root cause: persistProductRegistration wrote back loan amount,
 * rate, rehab BUDGET, term, ARV and the assignment split — but never
 * `applications.rehab_type`, so the studio's scope choice died in the
 * product_registrations row and every consumer of the column (the application
 * screen, the generated loan application, ClickUp's Rehab Type dropdown, the
 * Sitewire construction type, the tapes) stayed blank.
 *
 * The write-back is deliberately one-directional-safe: it fills a blank file and
 * follows a REAL scope change, but never flattens a more specific label the
 * borrower chose (Cosmetic and Moderate both price as a light rehab). Pure, no DB.
 */
const { rehabTypeWriteback, rehabTypeFromInputs, REHAB_TYPE } = require('../src/lib/product-registration');
const { buildInputs } = require('../src/lib/pricing');
const { sqftForType } = require('../src/lib/fields');
const crosswalk = require('../src/clickup/crosswalk');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const FF = { strategy: 'Fix & Flip', rehabBudget: 50000 };

// ---- what the registered scenario says the rehab is ----
assert(rehabTypeFromInputs({ ...FF }) === 'Moderate',
  'a light/moderate fix & flip registers as Moderate');
assert(rehabTypeFromInputs({ ...FF, heavyRehab: true }) === 'Heavy / gut rehab',
  'the studio\'s Heavy scope registers as Heavy / gut rehab');
assert(rehabTypeFromInputs({ ...FF, sqftAddition: true }) === 'Adding square footage',
  'the "adding square footage" checkbox registers as Adding square footage');
assert(rehabTypeFromInputs({ ...FF, heavyRehab: true, sqftAddition: true }) === 'Adding square footage',
  'an expansion outranks heavy — a footprint change is the more specific scope');
assert(rehabTypeFromInputs({ strategy: 'Ground-up Construction', rehabBudget: 300000 }) === 'Ground-up construction',
  'a ground-up scenario registers as Ground-up construction');
assert(rehabTypeFromInputs({ strategy: 'Fix & Hold (BRRRR)', rehabBudget: 40000 }) === 'Moderate',
  'fix & hold is a renovation strategy and still records a scope');

// No opinion → the file keeps whatever it has.
assert(rehabTypeFromInputs({ strategy: 'Bridge / Stabilized', rehabBudget: 0 }) === null,
  'a bridge deal has no rehab scope to stamp');
assert(rehabTypeFromInputs({ strategy: 'Bridge / Stabilized', rehabBudget: 90000 }) === null,
  'a bridge deal is never stamped even if a stray budget rides along');
assert(rehabTypeFromInputs({ strategy: 'Fix & Flip', rehabBudget: 0 }) === null,
  'no rehab money → no invented scope');

// ---- THE BUG: a blank file gets filled on register ----
assert(rehabTypeWriteback({ rehabType: null }, { ...FF }) === 'Moderate',
  'FIX: a file with no rehab type gets the registered scope (was left blank)');
assert(rehabTypeWriteback({ rehabType: '  ' }, { ...FF, heavyRehab: true }) === 'Heavy / gut rehab',
  'FIX: a whitespace-only rehab type counts as blank');
assert(rehabTypeWriteback({ rehabType: null }, { strategy: 'Bridge / Stabilized' }) === null,
  'a blank bridge file stays blank — nothing to say');

// ---- a REAL scope change follows the studio ----
assert(rehabTypeWriteback({ rehabType: 'Cosmetic' }, { ...FF, heavyRehab: true }) === 'Heavy / gut rehab',
  'escalating the scope to Heavy in the studio moves the file');
assert(rehabTypeWriteback({ rehabType: 'Heavy / gut rehab' }, { ...FF }) === 'Moderate',
  'dropping back to a light scope moves the file too');
assert(rehabTypeWriteback({ rehabType: 'Cosmetic' }, { ...FF, sqftAddition: true }) === 'Adding square footage',
  'checking "adding square footage" moves the file');
assert(rehabTypeWriteback({ rehabType: 'Moderate' }, { strategy: 'Ground-up Construction', rehabBudget: 250000 }) === 'Ground-up construction',
  'a ground-up registration overrides a contradictory renovation label');

// ---- but a compatible label is NEVER flattened ----
assert(rehabTypeWriteback({ rehabType: 'Cosmetic' }, { ...FF }) === null,
  'KEY: re-registering the same light scope leaves "Cosmetic" alone (not rewritten to Moderate)');
assert(rehabTypeWriteback({ rehabType: 'Moderate' }, { ...FF }) === null,
  'an unchanged Moderate file is not rewritten (change triggers stay quiet)');
assert(rehabTypeWriteback({ rehabType: 'Heavy / gut rehab' }, { ...FF, heavyRehab: true }) === null,
  'an unchanged Heavy file is not rewritten');
assert(rehabTypeWriteback({ rehabType: 'Ground-up construction' }, { strategy: 'Ground-up Construction', rehabBudget: 250000 }) === null,
  'an unchanged ground-up file is not rewritten');
// A legacy file carrying stale square footage already PRICES as an addition, so
// the studio prefills the box checked — that echo must not relabel the file.
assert(rehabTypeWriteback({ rehabType: 'Cosmetic', sqftPre: 1000, sqftPost: 2000 }, { ...FF, sqftAddition: true }) === null,
  'stale sq ft on a Cosmetic file is an echo of the file itself — the label is left alone');

// ---- the file stays self-consistent when the scope DOES move ----
// Registering "Heavy" over an addition must not leave sq ft behind, or the next
// quote's `sqft_post > sqft_pre` clause flips sqftAddition back on (test-sqft-coupling).
const moved = rehabTypeWriteback({ rehabType: 'Adding square footage', sqftPre: 1000, sqftPost: 2000 }, { ...FF, heavyRehab: true });
assert(moved === 'Heavy / gut rehab', 'un-checking the expansion moves the file off Adding square footage');
const coupled = sqftForType(moved, 1000, 2000);
assert(coupled.sqftPre === null && coupled.sqftPost === null, 'and the stale sq ft is nulled with it');
assert(buildInputs({ rehab_type: moved, sqft_pre: coupled.sqftPre, sqft_post: coupled.sqftPost }).sqftAddition === false,
  'so the next quote no longer prices it as an addition');

// ---- round-trip: every label we write is one pricing + ClickUp understand ----
for (const label of Object.values(REHAB_TYPE)) {
  const inp = buildInputs({ rehab_type: label, program: 'Fix & Flip w/ Construction' });
  assert(typeof inp.heavyRehab === 'boolean' && typeof inp.sqftAddition === 'boolean',
    `"${label}" round-trips through buildInputs`);
  assert(!!crosswalk.toClickUpLabel('rehab_type', label),
    `"${label}" has a ClickUp Rehab Type twin (never parks the inbound enum guard)`);
}
// The scope a written label implies must match the scenario that produced it.
const heavyIn = buildInputs({ rehab_type: REHAB_TYPE.heavy });
assert(heavyIn.heavyRehab === true && heavyIn.sqftAddition === false, 'Heavy / gut rehab prices as heavy, not an addition');
const sqftIn = buildInputs({ rehab_type: REHAB_TYPE.sqft });
assert(sqftIn.sqftAddition === true, 'Adding square footage prices as an addition');
const guIn = buildInputs({ rehab_type: REHAB_TYPE.groundUp });
assert(guIn.heavyRehab === true && guIn.sqftAddition === true, 'Ground-up construction prices as heavy + addition');
const cosIn = buildInputs({ rehab_type: REHAB_TYPE.cosmetic });
assert(cosIn.heavyRehab === false && cosIn.sqftAddition === false, 'Cosmetic prices as a light rehab');

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL rehab-type registration assertions passed');
process.exit(failures ? 1 : 0);
