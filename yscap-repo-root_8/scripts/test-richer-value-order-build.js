/**
 * PURE test — the Richer Value order builder (src/richervalues/order-build.js)
 * and the report reader (src/richervalues/results.js).
 *
 *   node scripts/test-richer-value-order-build.js
 *
 * WHAT THIS IS PINNING, and why every one of these is a real failure mode:
 *
 * 1. THEIR VALIDATOR IS AN ALLOW-LIST PER BRANCH. Sending a field that does not
 *    belong to the branch you chose fails the WHOLE order — and fails it as an
 *    HTTP 200 carrying `success:false`, so a careless build looks like it worked
 *    right up until nothing arrives. Confirmed live against their training tenant:
 *    a pricing call carrying `gla_include` came back `"gla_include" is not
 *    allowed`. So the tests below spend as much effort on what must NOT be sent as
 *    on what must.
 *
 * 2. NOTHING MAY BE GUESSED. This report prices off the property's own figures,
 *    so an unknown bedroom count has to surface as MISSING for a human to answer.
 *    A builder that quietly defaults one produces a valuation of a house that does
 *    not exist.
 *
 * 3. THE TWO NUMBERS COME BACK AS DATA. There is no MISMO XML on this product, so
 *    `results.js` is the reader — and it is held to the As-Is reader's standard:
 *    never store a guess, and never write two figures that are the wrong way round.
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const B = require(R + '/src/richervalues/order-build');
const RES = require(R + '/src/richervalues/results');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); pass++; };

const has = (built, field) => Object.prototype.hasOwnProperty.call(built.fields, field);
const missingFields = (built) => built.missing.map((m) => m.field);
const droppedFields = (built) => built.dropped.map((d) => d.field);

// A file with every property fact known, so a test can take things AWAY to see
// what each one does rather than adding them one at a time.
const CTX = () => ({
  appId: 'app-1',
  clientLoanNumber: 'YSCAP-1',
  rehabType: 'Moderate',
  expectedClosing: '2099-06-01',
  rehabBudget: 75000,
  purchasePrice: 300000,
  loanAmount: 250000,
  borrowerName: 'Sam Borrower',
  property: {
    addressLine: '4325 SW 70th Ter', addressLine2: null, unitNumber: null,
    city: 'Gainesville', state: 'FL', postalCode: '32608',
    categoryKey: 'sfr', categoryLabel: 'SFR (1 unit)', units: 1,
  },
  specs: {
    aboveGradeSqft: { value: 2000, source: 'file' },
    belowGradeSqft: { value: 0, source: 'file' },
    bedrooms: { value: 3, source: 'warehouse' },
    bathrooms: { value: 2, source: 'warehouse' },
    yearBuilt: { value: 1990, source: 'file' },
    lotSizeSquareFeet: { value: 8000, source: 'warehouse' },
    stories: { value: 1, source: 'warehouse' },
    garageSpaces: { value: 1, source: 'warehouse' },
    conditionUad: null,
  },
  proposed: { aboveGradeSqft: null },
  reportContact: { name: 'Lee Officer', email: 'lee@yscapgroup.com', phone: '7182478701' },
});

const CHOICES = (over = {}) => ({
  companyToken: 'co-token', loanOfficerToken: 'lo-token',
  reportType: 'reno-arv', inspectionType: 'interior-w-exterior', turnaroundTime: 'standard',
  glaInclude: true, licensingRequired: false, includeFloodCertification: false,
  propertyUploadType: 'single', isVacantLand: false, isPartiallyCompleted: false,
  propertyCondition: 'moderate',
  isPropertyOnLockbox: false,
  propertyAccessContacts: [{ name: 'Sam Borrower', phone: '3154487878', email: 'sam@example.com' }],
  now: new Date('2026-08-14T00:00:00Z'),
  ...over,
});

/* ========================================================================== *
 * A. The happy path — a complete order goes out complete.
 * ========================================================================== */
{
  const built = B.buildOrder(CTX(), CHOICES());
  eq(built.canPlace, true, 'A1 a fully-known file can be ordered');
  eq(built.missing.length, 0, 'A2 with nothing missing');
  eq(built.blocked, null, 'A3 and nothing blocking');
  // Their booleans travel as the STRINGS "0"/"1"; a JSON true is refused.
  eq(built.fields.gla_include, '1', 'A4 booleans are sent as "1"/"0", never as JSON booleans');
  eq(built.fields.include_flood_certification, '0', 'A5 a "no" is still answered — the field is always required');
  eq(built.fields.property_upload_type, 'single', 'A6 single-property branch');
  eq(built.fields.bathrooms, '2', 'A7 bathrooms travel as a number, not an int-rounded one');
  ok(has(built, 'lot_size_square_feet'), 'A8 a non-condo sends its lot size');
  eq(built.fields['property_access_contacts[0][phone]'], '3154487878', 'A9 access contacts are sent in their bracketed form');
}

/* ========================================================================== *
 * B. THE FORBIDDEN FIELDS. Each of these fails the whole order at their end.
 * ========================================================================== */
{
  // A condo has no lot of its own.
  const ctx = CTX(); ctx.property.categoryKey = 'condo';
  const built = B.buildOrder(ctx, CHOICES({ residentialPropertyType: 'condo' }));
  ok(!has(built, 'lot_size_square_feet'), 'B1 a condo never sends a lot size');
  ok(droppedFields(built).includes('lot_size_square_feet'), 'B2 and says so, rather than dropping it silently');
  ok(!missingFields(built).includes('lot_size_square_feet'), 'B3 and does not then ask for it');
}
{
  // The borrower's name rides with flood certification and is refused without it.
  const built = B.buildOrder(CTX(), CHOICES({ includeFloodCertification: false, borrowerName: 'Sam Borrower' }));
  ok(!has(built, 'borrower_name'), 'B4 no flood certificate → no borrower name');
  ok(droppedFields(built).includes('borrower_name'), 'B5 and it is reported as left out');

  const withFlood = B.buildOrder(CTX(), CHOICES({ includeFloodCertification: true }));
  eq(withFlood.fields.borrower_name, 'Sam Borrower', 'B6 flood certificate → the borrower name goes with it');
}
{
  // Vacant land turns the whole "there is a structure" branch off.
  const built = B.buildOrder(CTX(), CHOICES({ isVacantLand: true, isPartiallyCompleted: true, partiallyCompletedPercentage: 40 }));
  eq(built.fields.is_property_vacant_land, '1', 'B7 vacant land is stated');
  ok(!has(built, 'is_property_partially_completed'), 'B8 and the under-construction question is not asked');
  ok(!has(built, 'partially_completed_estimated_percentage'), 'B9 nor its percentage');
}
{
  // A historical valuation date is refused unless the flag says so.
  const built = B.buildOrder(CTX(), CHOICES({ effectiveDate: '2026-01-01' }));
  ok(!has(built, 'effective_date'), 'B10 a past valuation date is not sent without the flag');
  ok(droppedFields(built).includes('effective_date'), 'B11 and is reported as left out');
}
{
  // Lockbox details belong to an interior inspection an inspector attends.
  const built = B.buildOrder(CTX(), CHOICES({
    inspectionType: 'interior-homeowner-direct',
    lockboxCode: '1234', lockboxLocation: 'front-door', gateCode: 'A1',
  }));
  ok(!has(built, 'is_property_on_lockbox'), 'B12 a homeowner-led inspection sends no lockbox question');
  ok(!has(built, 'lockbox_code'), 'B13 nor a lockbox code');
  ok(droppedFields(built).includes('lockbox_code'), 'B14 and says why');
}
{
  // A gate code without the question that introduces it.
  const built = B.buildOrder(CTX(), CHOICES({ isPropertyOnLockbox: true, lockboxCode: '1', lockboxLocation: 'front-door', lockboxEntrance: 'front-door', communityGateCodeNeeded: false, gateCode: 'A1' }));
  ok(!has(built, 'gate_code'), 'B15 no gate code unless one is needed');
  eq(built.fields.community_gate_code_needed, '0', 'B16 but the question itself is answered');
}

/* ========================================================================== *
 * C. NOTHING IS GUESSED. An unknown fact is MISSING, not a default.
 * ========================================================================== */
{
  const ctx = CTX(); ctx.specs.bedrooms = { value: null, source: null };
  const built = B.buildOrder(ctx, CHOICES());
  ok(missingFields(built).includes('bedrooms'), 'C1 an unknown bedroom count is missing');
  eq(built.canPlace, false, 'C2 and the order cannot go');
  ok(!has(built, 'bedrooms'), 'C3 and nothing is sent for it');
}
{
  // A KNOWN zero is a real answer, not an unknown. This is the one that a naive
  // truthiness check gets wrong on every property with no basement.
  const ctx = CTX(); ctx.specs.belowGradeSqft = { value: 0, source: 'file' };
  const built = B.buildOrder(ctx, CHOICES());
  eq(built.fields.below_grade_sqft, '0', 'C4 a below-grade area of zero is sent as zero');
  ok(!missingFields(built).includes('below_grade_sqft'), 'C5 and is not reported as missing');
}
{
  // 2–4 units with no unit count: which of duplex/triplex/quadruplex is unknowable.
  const ctx = CTX(); ctx.property.categoryKey = 'multi_2_4'; ctx.property.units = null;
  const built = B.buildOrder(ctx, CHOICES({ propertyCondition: 'moderate' }));
  ok(missingFields(built).includes('residential_property_type'), 'C6 a 2–4 with no unit count is not guessed');
  eq(B.residentialTypeFor('multi_2_4', 3), 'triplex', 'C7 but a known 3 is a triplex');
  eq(B.residentialTypeFor('multi_2_4', null), null, 'C8 and an unknown count answers null');
}
{
  // 5+ units is not something this product covers at all — a refusal, not a gap.
  const ctx = CTX(); ctx.property.categoryKey = 'multi_5_plus';
  const built = B.buildOrder(ctx, CHOICES());
  ok(built.blocked && /5\+/.test(built.blocked), 'C9 a 5+ unit property is refused in plain words');
  eq(built.canPlace, false, 'C10 and cannot be ordered');
}

/* ========================================================================== *
 * D. THE CONDITIONAL REQUIREMENTS.
 * ========================================================================== */
{
  const built = B.buildOrder(CTX(), CHOICES({ isPartiallyCompleted: true }));
  ok(missingFields(built).includes('partially_completed_estimated_percentage'), 'D1 under construction asks how far along');
  const withPct = B.buildOrder(CTX(), CHOICES({ isPartiallyCompleted: true, partiallyCompletedPercentage: 55 }));
  eq(withPct.fields.partially_completed_estimated_percentage, '55', 'D2 and takes it once given');
  const bad = B.buildOrder(CTX(), CHOICES({ isPartiallyCompleted: true, partiallyCompletedPercentage: 140 }));
  ok(missingFields(bad).includes('partially_completed_estimated_percentage'), 'D3 140% is refused');
}
{
  const built = B.buildOrder(CTX(), CHOICES({ isPropertyOnLockbox: true }));
  for (const f of ['lockbox_code', 'lockbox_location', 'lockbox_entrance']) {
    ok(missingFields(built).includes(f), `D4 on a lockbox → ${f} is required`);
  }
}
{
  // An interior inspection with no lockbox needs somebody to open the door.
  const built = B.buildOrder(CTX(), CHOICES({ isPropertyOnLockbox: false, propertyAccessContacts: [] }));
  ok(missingFields(built).includes('property_access_contacts'), 'D5 not on a lockbox → an access contact is required');
}
{
  // A homeowner-led inspection is done through a texted link.
  const built = B.buildOrder(CTX(), CHOICES({
    inspectionType: 'interior-homeowner-direct',
    propertyAccessContacts: [{ name: 'Sam Borrower', email: 'sam@example.com' }],
  }));
  ok(built.missing.some((m) => /mobile number/i.test(m.label || '')),
    'D6 a homeowner-led inspection needs a mobile number, not just a name');
}
{
  // Their phone fields are EXACTLY ten digits. A number we cannot make into one
  // is REPORTED, never trimmed and sent — they text it to arrange the visit.
  const ctx = CTX(); ctx.reportContact.phone = '+44 20 7946 0000';
  const built = B.buildOrder(ctx, CHOICES());
  ok(missingFields(built).includes('report_contact_phone'), 'D7 a non-US phone is reported, not mangled');
  eq(B._internals.tenDigits('+1 (315) 448-7878'), '3154487878', 'D8 a US number with a country code is accepted');
  eq(B._internals.tenDigits('315-448-787'), null, 'D9 nine digits is not a phone number');
}
{
  // A closing date in the past is a real and common state on a file; their API
  // refuses it, so it is surfaced rather than pushed forward.
  const ctx = CTX(); ctx.expectedClosing = '2020-01-01';
  const built = B.buildOrder(ctx, CHOICES());
  ok(missingFields(built).includes('closing_date'), 'D10 a closing date already gone by is reported');
  ok(built.missing.find((m) => m.field === 'closing_date').why.includes('2020-01-01'),
    'D11 and the message names the date that is wrong');
}
{
  const built = B.buildOrder(CTX(), CHOICES({ historicalEffectiveDate: true, effectiveDate: '2026-08-13' }));
  ok(missingFields(built).includes('effective_date'), 'D12 a historical date must be 15+ days back');
  const okDate = B.buildOrder(CTX(), CHOICES({ historicalEffectiveDate: true, effectiveDate: '2026-06-01' }));
  eq(okDate.fields.effective_date, '2026-06-01', 'D13 and is taken when it is');
}
{
  // Their own catalogue decides whether a report needs a budget, so a report that
  // does not need one never nags for it.
  const ctx = CTX(); ctx.rehabBudget = null;
  const needs = B.buildOrder(ctx, CHOICES({ needsRenovationBudget: true }));
  ok(missingFields(needs).includes('borrower_budget'), 'D14 a renovation report asks for the budget');
  const doesnt = B.buildOrder(ctx, CHOICES({ needsRenovationBudget: false }));
  ok(!missingFields(doesnt).includes('borrower_budget'), 'D15 a report that does not need one never asks');
}

/* ========================================================================== *
 * E. THE CONDITION MAPPING — derived from their OWN published table, and
 *    reported as an assumption either way.
 * ========================================================================== */
{
  eq(B.propertyConditionFromUad('C4'), 'moderate', 'E1 C4 is their "worn"');
  eq(B.propertyConditionFromUad('C1'), 'new-construction', 'E2 C1 is newly built');
  eq(B.propertyConditionFromUad('C3.5'), 'maintained', 'E3 C3.5 is well kept');
  eq(B.propertyConditionFromUad('good condition'), null, 'E4 a word that is not a rating is not guessed');
  eq(B.propertyConditionFromRehab('Heavy'), 'poor', 'E5 a heavy rehab starts at poor');
  eq(B.propertyConditionFromRehab('something else'), null, 'E6 an unknown tier is not guessed into the middle');

  const ctx = CTX(); ctx.specs.conditionUad = 'C5';
  const built = B.buildOrder(ctx, CHOICES({ propertyCondition: undefined }));
  eq(built.fields.property_condition, 'poor', 'E7 a rating on file derives the condition');
  ok(built.assumptions.some((a) => a.field === 'property_condition'), 'E8 and it is flagged for a human to check');
}

/* ========================================================================== *
 * F. THE PREVIEW ROWS — every field that would be sent, and the tokens masked.
 * ========================================================================== */
{
  const built = B.buildOrder(CTX(), CHOICES());
  const rows = B.fieldRows(built, { bedrooms: 4 });
  const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
  ok(rows.length >= Object.keys(built.fields).length, 'F1 every built field gets a row');
  eq(byField.company_token.value, '••••••••', 'F2 a vendor token is never rendered');
  eq(byField.bedrooms.provenance, 'overridden', 'F3 a typed value reads as overridden');
  eq(byField.include_flood_certification.value, 'No', 'F4 a "0" is rendered as No, not as 0');
  eq(byField.gla_include.value, 'Yes', 'F5 and a "1" as Yes');
  ok(byField['property_access_contacts[0][name]'].label.includes('Access contact 1'),
    'F6 a bracketed contact field gets a readable label');

  const withMissing = B.buildOrder({ ...CTX(), specs: { ...CTX().specs, bedrooms: { value: null, source: null } } }, CHOICES());
  const mrows = B.fieldRows(withMissing, {});
  ok(mrows.some((r) => r.field === 'bedrooms' && r.provenance === 'missing'), 'F7 a missing field still gets a row');
}

/* ========================================================================== *
 * G. THE INSPECTION KINDS — which block of fields applies.
 * ========================================================================== */
{
  eq(B.inspectionKind('interior-w-exterior'), 'interior', 'G1');
  eq(B.inspectionKind('interior-homeowner-direct'), 'direct', 'G2');
  eq(B.inspectionKind('exterior'), 'exterior', 'G3');
  eq(B.inspectionKind('none'), 'none', 'G4');
  eq(B.inspectionKind('something-they-added-later'), 'unknown', 'G5 an unseen slug is unknown, never assumed');
  eq(B.lockboxApplies('interior-w-exterior'), true, 'G6 lockbox fields apply to an attended interior visit');
  eq(B.lockboxApplies('exterior'), false, 'G7 and to nothing else');
  eq(B.contactsRequired('interior-homeowner-direct', true), true, 'G8 a homeowner-led visit always needs a contact');
  eq(B.contactsRequired('interior-w-exterior', true), false, 'G9 on a lockbox, no contact is required');
  eq(B.contactsRequired('exterior', false), false, 'G10 an exterior visit needs nobody');
  // An UNKNOWN kind sends neither block — the safe reading, because a forbidden
  // field fails the order while a missing one fails with a message naming it.
  eq(B.lockboxApplies('something-new'), false, 'G11 an unknown kind sends no lockbox block');
  eq(B.contactsRequired('something-new', false), false, 'G12 and demands no contact');
}

/* ========================================================================== *
 * H. READING THE FINISHED REPORT.
 * ========================================================================== */
const REPORT = () => ({
  data: {
    responses: [{
      order_token: 'ot-1',
      results: {
        valuation_summary: { current_condition: 'Poor', estimated_as_is_value: '$90,000' },
        renovation_strategies: [
          { title: 'ARV', min: '$164,700', partial: '$191,700', full: '$225,400', best: '$164,700' },
          { title: 'As Is Value', min: '$90,000', partial: '$90,000', full: '$90,000', best: '$90,000' },
          { title: 'Rehab', min: '$51,620', partial: '$70,419', full: '$94,037', best: '$51,620' },
          { title: 'Gross Return', min: '16.30%', partial: '19.50%', full: '22.48%', best: '16.30%' },
          { title: 'Annualized Return', min: '1.43x', partial: '1.24x', full: '1.39x', best: '1.43x' },
        ],
      },
      confidence_score: { rv_confidence: '41', data_quality: '81.9', reliabilityScore: 'Moderate' },
      market_information: { demand_score: 87, demand_score_level: 'Very Strong' },
      subject_condition_rating: { overall_condition: '5.00', kitchen: 'N/A' },
    }],
  },
});
{
  const r = RES.readEnvelope(REPORT(), 'ot-1');
  eq(r.asIs, 90000, 'H1 the As-Is comes off their valuation summary');
  eq(r.arv, 164700, 'H2 the ARV comes off the strategy grid');
  eq(r.arvBasis, 'best', 'H3 and from the strategy THEY recommend, recorded as such');
  eq(r.valuesUsable, true, 'H4 both figures are usable');
  eq(r.rehab.best, 51620, 'H5 the recommended rehab cost is read too');
  eq(r.confidence.reliability, 'Moderate', 'H6 their reliability label survives');
  eq(r.condition.kitchen, null, 'H7 their "N/A" is read as unknown, never as the text "N/A"');
}
{
  // A percentage and a multiplier are not money. Picking a grid row by POSITION
  // instead of by title is what would put "16.30%" in a value field.
  eq(RES._internals.money('16.30%'), null, 'H8 a percentage is not money');
  eq(RES._internals.money('1.43x'), null, 'H9 nor a multiplier');
  eq(RES._internals.money('$164,700'), 164700, 'H10 a formatted dollar figure is');
  eq(RES._internals.money(99776), 99776, 'H11 and so is a plain number');
  eq(RES._internals.money(''), null, 'H12 an empty string is NOT zero');
}
{
  // Two figures the wrong way round mean one was misread. NEVER swap them —
  // which one is wrong is not knowable from here.
  const bad = REPORT();
  bad.data.responses[0].results.renovation_strategies[0].best = '$50,000';
  const r = RES.readEnvelope(bad, 'ot-1');
  eq(r.asIs, 90000, 'H13 both figures are still reported');
  eq(r.arv, 50000, 'H14 exactly as the vendor stated them');
  eq(r.valuesUsable, false, 'H15 but they are not usable');
  ok(/not above/i.test(r.unusableReason), 'H16 and the reason says which way round they are');
}
{
  const empty = { data: { responses: [{ order_token: 'ot-1', results: {} }] } };
  const r = RES.readEnvelope(empty, 'ot-1');
  eq(r.asIs, null, 'H17 an empty report reads as unknown');
  eq(r.valuesUsable, false, 'H18 and is not usable');
  ok(/As-Is value or an ARV that PILOT could read/i.test(r.unusableReason),
    'H19 with a reason that names both figures, so a human knows to open the PDF for both');
}
{
  // A batch envelope carrying OTHER properties must never be read onto this file.
  const two = REPORT();
  two.data.responses.push({ order_token: 'ot-2', results: { valuation_summary: { estimated_as_is_value: '$1' } } });
  eq(RES.readEnvelope(two, 'ot-3'), null, 'H20 several responses and none of them ours → nothing is read');
  eq(RES.readEnvelope(two, 'ot-2').asIs, 1, 'H21 but ours is found among them');
  // One response whose token does not echo: the request was already scoped by
  // both tokens, so it IS ours — flagged, not swallowed.
  const one = REPORT();
  const r = RES.readEnvelope(one, 'different');
  eq(r.tokenMismatch, true, 'H22 a single response with a mismatched token is flagged');
  eq(r.asIs, 90000, 'H23 and still read, because the request scoped it');
}
{
  // A per-square-foot figure or a doubled zero is not a property value.
  const tiny = REPORT();
  tiny.data.responses[0].results.valuation_summary.estimated_as_is_value = '$52';
  eq(RES.readEnvelope(tiny, 'ot-1').valuesUsable, false, 'H24 an implausibly small value is refused');
}
{
  eq(RES.summaryLine(null), 'Richer Value has not sent the finished figures yet.', 'H25 no report says so plainly');
  const line = RES.summaryLine(RES.readEnvelope(REPORT(), 'ot-1'));
  ok(line.includes('$90,000') && line.includes('$164,700'), 'H26 the summary quotes both figures');
}

console.log(`test-richer-value-order-build: ${pass} assertions passed`);
