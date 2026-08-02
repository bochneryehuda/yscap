'use strict';
/*
 * test-registration-file-match-pure.js — the registration-must-match-the-
 * application guard (owner-directed 2026-07-31: an SFR file was priced and
 * registered as "2-4 units"; a disagreement must FAIL the registration).
 *
 * Pure — no DB. Covers:
 *   • the reported case: app SFR vs studio "2-4 units" → conflict
 *   • the reverse: app Multi 2–4 vs studio "SFR (1 unit)" → conflict
 *   • same-bucket variants NEVER conflict (Condo ≡ "SFR (1 unit)" — the studio
 *     can only say 1-unit; spelling/dash variants of 2–4)
 *   • units, loan type (purchase vs refi), strategy (ground-up vs fix&flip),
 *     and state ("New York" ≡ "NY" never conflicts; NY vs NJ does)
 *   • never-guess: blank / unknown / absent values stay silent
 *   • source-priority.valuesAgree treats "Multi 2–4" ≡ "2-4 units" for
 *     property_type (the false registration_input_drift class)
 */

const assert = require('assert');
const guard = require('../src/lib/registration-guard');
const { registrationFileConflicts, conflictMessage, _internals } = guard;
const sp = require('../src/lib/underwriting/source-priority');

let n = 0;
function ok(cond, label) {
  n += 1;
  if (!cond) { console.error(`✗ ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
}

const app = (over) => ({
  property_type: 'SFR', units: 1, loan_type: 'Purchase', program: 'Fix & Flip',
  property_address: { state: 'NJ' }, ...over,
});

// ---- the reported bug ----
{
  const c = registrationFileConflicts(app(), { propertyType: '2-4 units' });
  ok(c.length === 1 && c[0].key === 'property_type', 'app SFR vs studio "2-4 units" → property_type conflict');
  ok(/application/i.test(conflictMessage(c)) && /2-4 units/.test(conflictMessage(c)), 'message names both sides');
}
{
  const c = registrationFileConflicts(app({ property_type: 'Multi 2–4', units: 3 }), { propertyType: 'SFR (1 unit)' });
  ok(c.length === 1 && c[0].key === 'property_type', 'app Multi 2–4 vs studio SFR → conflict (reverse direction)');
}

// ---- same bucket never conflicts ----
ok(registrationFileConflicts(app({ property_type: 'Condo' }), { propertyType: 'SFR (1 unit)' }).length === 0,
  'Condo ≡ "SFR (1 unit)" — same 1-unit bucket, no conflict');
ok(registrationFileConflicts(app({ property_type: 'Townhouse' }), { propertyType: 'SFR (1 unit)' }).length === 0,
  'Townhouse ≡ "SFR (1 unit)" — no conflict');
ok(registrationFileConflicts(app({ property_type: 'Multi 2-4', units: 2 }), { propertyType: '2-4 units' }).length === 0,
  'hyphen "Multi 2-4" ≡ "2-4 units" — no conflict');
ok(registrationFileConflicts(app({ property_type: 'multi_2_4', units: 4 }), { propertyType: '2-4 units' }).length === 0,
  'enum key "multi_2_4" ≡ "2-4 units" — no conflict');
ok(registrationFileConflicts(app({ property_type: 'Duplex', units: 2 }), { propertyType: '2-4 units' }).length === 0,
  '"Duplex" ≡ "2-4 units" — no conflict');

// ---- 5+/mixed against the studio's two tokens IS a conflict ----
ok(registrationFileConflicts(app({ property_type: 'Multi 5+', units: 6 }), { propertyType: 'SFR (1 unit)' })
  .some((c) => c.key === 'property_type'), 'Multi 5+ vs studio SFR → conflict');
ok(registrationFileConflicts(app({ property_type: 'Mixed use' }), { propertyType: '2-4 units' })
  .some((c) => c.key === 'property_type'), 'Mixed use vs studio 2-4 → conflict');

// ---- never-guess ----
ok(registrationFileConflicts(app({ property_type: null }), { propertyType: '2-4 units' }).length === 0,
  'blank file property type → silent (nothing to disagree with)');
ok(registrationFileConflicts(app({ property_type: 'New Construction Lot' }), { propertyType: '2-4 units' }).length === 0,
  'unclassifiable file value → silent (never a guessed refusal)');
ok(registrationFileConflicts(app(), {}).length === 0, 'no overrides → silent');
ok(registrationFileConflicts(app(), { propertyType: '' }).length === 0, 'empty override → silent');

// ---- units ----
{
  const c = registrationFileConflicts(app({ units: 3, property_type: 'Multi 2–4' }), { units: 2, propertyType: '2-4 units' });
  ok(c.length === 1 && c[0].key === 'units', 'units 3 vs 2 → units conflict (same bucket ok)');
}
ok(registrationFileConflicts(app({ units: null }), { units: 4 }).length === 0, 'file has no units → silent');
ok(registrationFileConflicts(app({ units: 2 }), { units: '2' }).length === 0, 'equal units as string → no conflict');

// ---- loan type ----
{
  const c = registrationFileConflicts(app({ loan_type: 'Refinance' }), { loanType: 'Purchase' });
  ok(c.length === 1 && c[0].key === 'loan_type', 'file Refinance vs studio Purchase → conflict');
}
ok(registrationFileConflicts(app({ loan_type: 'Cash-out Refinance' }), { loanType: 'Refinance' }).length === 0,
  'cash-out refi ≡ refinance class — no conflict');
ok(registrationFileConflicts(app({ loan_type: null }), { loanType: 'Purchase' }).length === 0,
  'blank file loan type → silent');

// ---- strategy ----
{
  const c = registrationFileConflicts(app({ program: 'Ground Up Construction' }), { strategy: 'fix-flip' });
  ok(c.length === 1 && c[0].key === 'strategy', 'file ground-up vs studio fix&flip → conflict');
}
ok(registrationFileConflicts(app({ program: 'Fix & Flip' }), { strategy: 'fix-flip' }).length === 0,
  '"Fix & Flip" ≡ "fix-flip" — no conflict');
ok(registrationFileConflicts(app({ program: 'Something Custom' }), { strategy: 'fix-flip' }).length === 0,
  'unclassifiable program → silent');

// ---- state ----
ok(registrationFileConflicts(app({ property_address: { state: 'New York' } }), { state: 'NY' }).length === 0,
  '"New York" ≡ "NY" — no conflict');
{
  const c = registrationFileConflicts(app({ property_address: { state: 'NY' } }), { state: 'NJ' });
  ok(c.length === 1 && c[0].key === 'state', 'NY vs NJ → state conflict');
}
ok(registrationFileConflicts(app({ property_address: {} }), { state: 'NJ' }).length === 0,
  'file has no state → silent');

// ---- multiple conflicts stack ----
{
  const c = registrationFileConflicts(
    app({ property_type: 'SFR', loan_type: 'Refinance' }),
    { propertyType: '2-4 units', loanType: 'Purchase' });
  ok(c.length === 2, 'two conflicts both reported');
  ok(conflictMessage(c).split('\n').length >= 3, 'message lists each conflict on its own line');
}

// ---- internals sanity ----
ok(_internals.propertyBucket('SFR (1 unit)') === '1' && _internals.propertyBucket('2-4 units') === '2_4',
  'buckets: studio vocabulary maps');
ok(_internals.propertyBucket('FNM1025') === null, 'a form code never buckets (never guess)');
ok(_internals.loanTypeClass('Rate/Term Refinance') === 'refinance', 'rate/term is refinance class');
ok(_internals.strategyClass('New Construction') === 'ground', 'new construction is ground class');

// ---- source-priority semantic agree (the false-drift class) ----
ok(sp.valuesAgree('Multi 2–4', '2-4 units', 'property_type') === true,
  'valuesAgree: "Multi 2–4" ≡ "2-4 units" for property_type');
ok(sp.valuesAgree('SFR', '2-4 units', 'property_type') === false,
  'valuesAgree: SFR vs 2-4 still disagrees');
ok(sp.valuesAgree('12', '12 Months', 'term') === true,
  'valuesAgree: "12" ≡ "12 Months" for term');
ok(sp.valuesAgree('New York', 'NY', 'property_state') === true,
  'valuesAgree: "New York" ≡ "NY" for property_state');
ok(sp.valuesAgree('Multi 2–4', '2-4 units') === false,
  'valuesAgree without fieldKey keeps the raw compare (no behavior change elsewhere)');

console.log(`\nAll ${n} registration-file-match checks passed.`);
