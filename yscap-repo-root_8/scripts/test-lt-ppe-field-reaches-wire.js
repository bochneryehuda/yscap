#!/usr/bin/env node
'use strict';
/**
 * LT — EVERY ACCEPTED FIELD EITHER REACHES LENDER PRICE OR IS RECORDED AS NOT DOING SO (§2.96).
 *
 * THE OWNER'S STANDING REQUIREMENT: *"the system understands your scenario exactly and it doesn't get
 * any of your fields wrong."*
 *
 * ⛔ THREE FIELDS WERE ACCEPTED AND SILENTLY DROPPED — and each had a TWIN that worked.
 *
 *     rural               -> reaches the wire        rural_property        -> DROPPED
 *     firstTimeInvestor   -> reaches the wire        first_time_investor   -> DROPPED
 *     fthb                -> reaches the wire        first_time_homebuyer  -> DROPPED
 *
 * One fact under the manifest's two naming conventions — the core contract is camelCase, the D27–D29
 * overlay registry is snake_case — and the route publishes BOTH, so a caller picking the wrong half got
 * a 200 and a quote that had never heard of their input. Fixed by accepting either spelling, in the
 * same shape `short_term_rental || shortTermRental` and `attachmentType || attachment` already use.
 *
 * ⛔ THE DURABLE HALF IS THIS SUITE, NOT THAT FIX. Six more fields are accepted and never transmitted,
 * and until now **nothing could tell a deliberate omission from a forgotten one**. `occupancy` is
 * deliberate and documented at length; `foreign_national` is not. Both looked identical from outside.
 *
 * So: every supported field is MEASURED against the real builder — set it, and see whether the request
 * changes. A field that changes nothing must appear in `NOT_TRANSMITTED` with a written reason. A field
 * that reaches the wire must NOT be listed. The list cannot rot in either direction, and a new field
 * added tomorrow fails this suite until somebody says which kind it is.
 *
 *   node scripts/test-lt-ppe-field-reaches-wire.js
 *
 * PURE — no DB, no network, no vendor call. LT-only.
 */
const { buildSearch } = require('../src/longterm/lenderprice/search-model');
const pricer = require('../src/longterm/routes/dscr-pricer');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const BASE = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
  state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings', city: 'Brooklyn',
  propertyType: 'SingleFamily', units: 1, borrowerType: 'LLC' };

// ⛔ THE PROBE VALUE IS THE MEASUREMENT, AND A LAZY ONE INVENTS DEFECTS. Each value must differ from
// what the base already produces, and must be a value the field really accepts. The first draft of this
// table reported FIVE false drops, every one my error rather than the code's: `ltv: 0.7` IS 350k/500k
// so nothing moved; `attachmentType: 'Detached'` is what SingleFamily already maps to; and
// `bankruptcy` / `mortgageLates` are OBJECT-shaped (`{chapter,…}`, `{last12,…}`) and correctly WARN on
// a string rather than silently ignoring it. A guard that cries wolf teaches its reader to ignore it —
// so the values are taken from the registry's own token sets, not guessed.
const PROBE = {
  purpose: 'CashoutRefinance', value: 600000, appraisedValue: 610000, asIsValue: 590000, loan: 400000,
  ltv: 0.55, fico: 680, dscr: 1.05, propertyType: 'Condo', units: 4, attachment: 'Attached',
  attachmentType: 'Attached', nonWarrantable: true, zip: '75201', state: 'TX', county: 'Dallas',
  countyFps: '48113', city: 'Dallas', countyName: 'Dallas', borrowerType: 'Individual',
  prepayMonths: 24, io: true, escrowWaive: true, fthb: true, date: '2026-01-02',
  rentalTerm: 'short', reservesMonths: 12, term: 40, termYears: 40, lockDays: 45,
  cashoutAmount: 50000, incomeDocType: 'Full Doc', prepayStructure: '3,2,1',
  subordinateLoanAmount: 25000, compPercent: 2.5, apr: 9, selfEmployed: true,
  financedProperties: 5, numberOfBorrowers: 2, monthlyIncome: 20000, monthlyDebt: 6000, dti: 0.4,
  compensationType: 'LenderPaid', waiveLenderFee: true, rural: true, mixedUse: true,
  citizenship: 'Foreign National', tradelines: 'Limited', noMortgageHistory: true,
  bankruptcy: { chapter: 'Chapter 7' }, mortgageLates: { last12: { '30': '2' } }, foreclosure: 'FC_1yr', shortSale: 'SS_1yr',
  deedInLieu: 'DIL_1yr', chargeOff: 'MLCO2yr', forbearance: 'Forbear3mo', crossCollateral: true,
  firstTimeInvestor: true, livingRentFree: true, dscrAssetDepletion: true, lateInLast12Months: true,
  occupancy: 'vacant', rural_property: true, short_term_rental: true, first_time_investor: true,
  first_time_homebuyer: true, foreign_national: true, declining_market: true, renovation: true,
};

// ---------------------------------------------------------------------------------------------
// ⛔ FIELDS THE DOOR ACCEPTS AND THE REQUEST DELIBERATELY DOES NOT CARRY. A written entry, with a
// reason — not a mute switch. An entry for a field that DOES reach the wire fails, and a field that
// reaches nothing and is not listed fails. Neither direction can rot.
// ---------------------------------------------------------------------------------------------
const NOT_TRANSMITTED = {
  ltv:
    'DELIBERATE — §35.2 the AMOUNT TRIANGLE. `value`, `loan` and `ltv` are three views of two facts, so '
    + 'with a value and a loan present the LTV is DERIVED and transmitted from them; an explicit one '
    + 'moves nothing because it is already implied. It is not lost, it is redundant.',
  incomeDocType:
    'ACCEPTED, APPLIED, THEN OVERWRITTEN — same shape as compensationType below. `applyRegistry` writes '
    + "`dyn.IncomeDocType` from the caller and the DSCR profile then forces 'DSCR' as part of its "
    + 'identity, so a caller asking for Full Doc is silently given DSCR. Not a lost field — a field the '
    + 'profile owns. Unlocking it belongs with the work that lets the mirror search products other than '
    + 'investment fixed-rate DSCR.',
  occupancy:
    'DELIBERATE, and documented at length in search-model beside the code that does it (D27). Vacant vs '
    + 'leased is retained as a first-class ELIGIBILITY fact on an internal channel — the overlay, the '
    + "route's effectiveScenario echo and any future measured rule all read it — WITHOUT putting a "
    + 'guessed token on the wire. The repo has measured what an unpublished token costs (a fake reserves '
    + 'token lost a whole lender program), so nothing is invented here.',
  declining_market:
    'MEASURED AND INERT — no longer an open gap, and no longer a bridge worth building (§2.97). '
    + '`GLOBAL_DECLININGMARKET` IS on the wire: the base body carries it on every request with '
    + '`value: null`. Probed live 2026-08-18 by patching the built body directly with five candidate '
    + "tokens — 'true', boolean true, 'Yes', 'Y', 'Declining' — against the same scenario. EVERY one "
    + 'was inert: 19 programs, 499 rungs, 499 ladder points, zero moved, max delta 0. None was rejected '
    + 'either, so this is not the hazard where an unpublished token silently costs a lender program — '
    + 'the vendor holds the field and prices nothing on it. There is nothing for a scenario field to '
    + 'change, so `advanced-facts` records `lpPrices: false` (a measurement) and no bridge is added.',
  renovation:
    'OPEN GAP. No captured vendor field is known for it, so unlike the two above there is not even a '
    + 'token to bridge to. It is an overlay fact our own engine may cut on; the vendor is not told.',
  apr:
    'BY DESIGN — a pure pass-through to our own Layer-3 prepayment matrix, which keys Illinois on it. '
    + 'It is an input to OUR rules, never a thing to ask Lender Price about.',
  compensationType:
    'ACCEPTED, APPLIED, THEN OVERWRITTEN — and that is the defect, not the omission. `applyRegistry` '
    + 'writes `criteria.compensationType` from the caller and `wireDiscipline` then forces '
    + "'BorrowerCompPlan' as part of the DSCR profile identity, so a caller asking for LenderPaid is "
    + 'silently given BorrowerPaid. Recorded here so it is visible; unlocking it belongs with the '
    + 'profile work that lets the mirror search products other than investment fixed-rate DSCR.',
};

// ---- A: the measurement ---------------------------------------------------------------------------
console.log('-- A: every supported field, measured against the real builder --');
const supported = [...pricer.SUPPORTED_FIELDS];
ok(supported.length >= 60, `the route publishes ${supported.length} supported fields`);
const baseBody = JSON.stringify(buildSearch(BASE));
const transmitted = []; const dropped = []; const unprobed = [];
for (const key of supported) {
  if (!(key in PROBE)) { unprobed.push(key); continue; }
  let changed = false;
  try { changed = JSON.stringify(buildSearch({ ...BASE, [key]: PROBE[key] })) !== baseBody; } catch (_) { changed = true; }
  (changed ? transmitted : dropped).push(key);
}
// ⛔ AN UNPROBED FIELD IS A HOLE IN THIS SUITE, not a pass. Without this the table could quietly stop
// covering a field and the suite would still go green — the exact "reported as covered, never
// exercised" shape §2.94 was about.
ok(unprobed.length === 0, `every supported field has a probe value${unprobed.length ? ` — MISSING: ${unprobed.join(', ')}` : ''}`);
ok(transmitted.length >= 50, `${transmitted.length} fields reach the wire`);

// ---- B: the two directions ------------------------------------------------------------------------
console.log('\n-- B: dropped fields must be recorded; recorded fields must be dropped --');
for (const key of dropped) {
  const reason = NOT_TRANSMITTED[key];
  ok(typeof reason === 'string' && reason.length > 80,
    `"${key}" reaches nothing — is it recorded, with a real reason? ${reason ? '' : '(NOT RECORDED)'}`);
}
for (const key of Object.keys(NOT_TRANSMITTED)) {
  ok(dropped.includes(key),
    `"${key}" is recorded as not-transmitted, and really is — a record for a field that now reaches the wire would be stale`);
}
ok(dropped.length === Object.keys(NOT_TRANSMITTED).length,
  `the two lists balance exactly (${dropped.length} dropped, ${Object.keys(NOT_TRANSMITTED).length} recorded)`);
// Deliberate and open must be distinguishable, or the list is just a longer silence.
ok(/DELIBERATE/.test(NOT_TRANSMITTED.occupancy) && /OPEN GAP/.test(NOT_TRANSMITTED.renovation),
  'the record says which omissions are DECISIONS and which are GAPS — the distinction nothing could make before');
// §2.97 — `foreign_national` LEFT this list, and that departure is asserted rather than merely implied:
// it was the most expensive drop the §2.96 sweep found (13 programs quoted that the borrower cannot
// have, and 4.125 points on Deephaven), so a regression that re-silenced it must fail here loudly and
// not merely as an off-by-one in the balance count above.
ok(!Object.prototype.hasOwnProperty.call(NOT_TRANSMITTED, 'foreign_national'),
  'foreign_national is NOT recorded as not-transmitted — it was bridged in §2.97');
ok(dropped.includes('foreign_national') === false,
  'foreign_national reaches the wire (measured: it swaps 13 of 19 programs and moves Deephaven 4.125 points)');

// ---- C: the twins, both directions ---------------------------------------------------------------
console.log('\n-- C: one fact, two spellings, one answer --');
for (const [camel, snake] of [['rural', 'rural_property'], ['firstTimeInvestor', 'first_time_investor'], ['fthb', 'first_time_homebuyer']]) {
  const a = JSON.stringify(buildSearch({ ...BASE, [camel]: true }));
  const b = JSON.stringify(buildSearch({ ...BASE, [snake]: true }));
  ok(a !== baseBody, `${camel} reaches the wire`);
  ok(b !== baseBody, `${snake} reaches the wire too (it did NOT before)`);
  ok(a === b, `…and both spellings send the IDENTICAL request — one fact, one answer`);
  // The route accepts both, which is why the drop was silent rather than a 422.
  ok(!pricer._internals.unsupportedFields({ [camel]: true }).length
    && !pricer._internals.unsupportedFields({ [snake]: true }).length,
    `…and the route accepts both spellings, which is what made the drop silent`);
}
// ⛔ THE BRIDGE MUST NOT FIRE ON ABSENCE, or every scenario would start carrying the fact — and this
// assertion was VACUOUS on its first draft: it compared `buildSearch({...BASE})` to `baseBody`, which
// is the same expression, so it was true whatever the bridge did. A mutation making the bridge fire
// unconditionally passed it. The real property is about the BODY's contents, so that is what is read:
// the captured base carries no `criteria.rural` at all, and a scenario that states neither spelling
// must not introduce one.
{
  const bare = buildSearch({ ...BASE });
  ok(!('rural' in (bare.criteria || {})),
    'a scenario stating NEITHER spelling introduces no `criteria.rural` key — the bridge does not fire on absence');
  ok('rural' in (buildSearch({ ...BASE, rural_property: false }).criteria || {}),
    '…while stating it as FALSE does introduce the key — absence and an explicit false are different answers');
}
ok(JSON.stringify(buildSearch({ ...BASE, rural_property: false })) !== JSON.stringify(buildSearch({ ...BASE, rural_property: true })),
  'and false is not the same as true — the bridge carries the VALUE, not merely the presence');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
