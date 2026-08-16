#!/usr/bin/env node
'use strict';
/**
 * §29.10/§31.3 — RENTAL-TERM override + SemiDetached attachment (pure, offline).
 *
 * Two confirmed-token field gaps the audit lists (no vendor guess required):
 *   • Rental term: the builder forced Long_Term_Rental_Property with NO override. Both upstream tokens
 *     are confirmed live — Long_Term_Rental_Property (§30.6) and Short_Term_Rental_Property (§31.3) — so
 *     an explicit rentalTerm may now select short-term; an OMITTED rentalTerm still forces long-term
 *     (the DSCR profile default, §29.1); an unknown value is REJECTED (422), never priced as long-term.
 *   • Attachment: SemiDetached is the confirmed live token (§31.3) the validator used to reject.
 *
 * PROVEN TO FAIL: revert `setDyn('AddlOccupancyType', mapRentalTerm(sc.rentalTerm))` back to the forced
 * long-term literal and the SHORT-* assertions go red; drop 'SemiDetached' from ATTACHMENT_TYPES and
 * SEMI-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const rental = (m) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap.AddlOccupancyType && m.dynamicPropertiesMap.AddlOccupancyType.value);
const loc = { state: 'NJ', countyFps: '34039' };

console.log('§29.10/§31.3 rental-term override + SemiDetached attachment');

// ---- rental term: omitted → long-term (profile default) -------------------
const omitted = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25 });
ok(rental(omitted) === 'Long_Term_Rental_Property', 'LONG-1 omitted rentalTerm forces the long-term profile default');

// ---- rental term: explicit short-term wins (both tokens confirmed) --------
for (const v of ['short', 'Short Term', 'short_term', 'ShortTermRental']) {
  const m = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, rentalTerm: v });
  ok(rental(m) === 'Short_Term_Rental_Property', `SHORT-1 rentalTerm ${JSON.stringify(v)} → Short_Term_Rental_Property`);
}
for (const v of ['long', 'Long Term', 'long_term']) {
  const m = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, rentalTerm: v });
  ok(rental(m) === 'Long_Term_Rental_Property', `LONG-2 rentalTerm ${JSON.stringify(v)} → Long_Term_Rental_Property`);
}

// ---- rental term: unknown → 422, never priced as long-term ---------------
const bad = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, rentalTerm: 'weekly', ...loc });
ok(bad.ok === false && bad.status === 422 && bad.error === 'unknown_rental_term' && bad.field === 'rentalTerm',
  'REJECT-1 an unknown rentalTerm is rejected 422 (never silently long-term)');
// a good rentalTerm passes validateScenario end to end
const good = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, rentalTerm: 'short', ...loc });
ok(good.ok === true && rental(good.request) === 'Short_Term_Rental_Property', 'REJECT-2 a valid rentalTerm passes validateScenario and is built');

// ---- rental term overrides even a mutated live base's stale value --------
const base = JSON.parse(JSON.stringify(sm.BASE));
base.dynamicPropertiesMap = base.dynamicPropertiesMap || {};
base.dynamicPropertiesMap.AddlOccupancyType = { fieldId: 'AddlOccupancyType', value: 'Short_Term_Rental_Property' };
const overBase = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25 }, { base }); // omit → long-term
ok(rental(overBase) === 'Long_Term_Rental_Property', 'BASE-1 an omitted rentalTerm forces long-term even over a base carrying short-term');

// ---- SemiDetached attachment is accepted; still passed through independently ----
const semiOk = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, attachment: 'SemiDetached', ...loc });
ok(semiOk.ok === true, 'SEMI-1 SemiDetached attachment is accepted (was rejected before)');
const semiBuilt = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, attachment: 'SemiDetached' });
ok(semiBuilt.property.attachmentType === 'SemiDetached', 'SEMI-2 SemiDetached is transmitted verbatim as the property attachment');
// a genuinely bogus attachment still 422s
const attBad = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, attachment: 'Floating', ...loc });
ok(attBad.ok === false && attBad.error === 'invalid_attachment', 'SEMI-3 an unknown attachment is still rejected 422');
ok(sm._internals.ATTACHMENT_TYPES.join(',') === 'Detached,Attached,SemiDetached', 'SEMI-4 the allow-list is exactly the three confirmed tokens');

// ---- the DOCUMENTED name, and real INDEPENDENCE from the property type -----
// The independence was implemented under the key `attachment` while the audit's contract — and the
// upstream path — name it `attachmentType`. So a caller following the contract had their value
// silently DROPPED in favour of the property type's default: not refused, dropped, which is the
// silent-substitution class this whole audit is about. Nothing guarded it until a mutation that
// removed the fix left every suite green.
const semiTyped = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, attachmentType: 'SemiDetached' });
ok(semiTyped.property.attachmentType === 'SemiDetached',
  'SEMI-5 `attachmentType` (the documented API name) is honoured');

// THE INDEPENDENCE ITSELF: Condo's own default attachment is Attached, and the caller's explicit
// Detached must beat it — this is the exact live capture (condo + independently selected Detached).
const condoDetached = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, propertyType: 'Condo', attachmentType: 'Detached' });
ok(condoDetached.property.propertyType === 'Condos' && condoDetached.property.attachmentType === 'Detached',
  'SEMI-6 an explicit attachment OVERRIDES the property type\'s default (Condo + Detached)');
// …and with none supplied the type's default still applies, so the override is an override and not
// a replacement of the mapping.
const condoDefault = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, propertyType: 'Condo' });
ok(condoDefault.property.attachmentType === 'Attached',
  'SEMI-7 …while an omitted attachment still takes the type\'s own default');

// A key the BUILDER honours but the VALIDATOR ignores is the one way an unchecked value reaches the
// vendor — worse than a key neither knows about. Both spellings must be validated AND routed.
const typedBad = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, attachmentType: 'Floating', ...loc });
ok(typedBad.ok === false && typedBad.error === 'invalid_attachment' && typedBad.field === 'attachmentType',
  'SEMI-8 an unknown `attachmentType` is refused 422, naming that field');
{
  const { unsupportedFields } = require('../src/longterm/routes/dscr-pricer')._internals;
  ok(unsupportedFields({ purpose: 'Purchase', attachmentType: 'Detached' }).length === 0,
    'SEMI-9 …and the route accepts it, so the documented name is reachable through the API at all');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
