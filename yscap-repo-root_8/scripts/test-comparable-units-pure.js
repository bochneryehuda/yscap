/**
 * THE COMPARABLE GRID — the wrong-answer bugs, pinned. (db/426 and Phase 1)
 *
 * On a Fannie Form 1025 the comparable grid states its room line PER UNIT: one
 * `ROOM_ADJUSTMENT` element per dwelling. `extract.js` read the FIRST one, which
 * is UNIT 1, and filed it as the whole property — so a grid stating 14 rooms /
 * 7 beds / 3 baths stored 5 / 3 / 1.
 *
 * That is a wrong answer, not a missing one, and it is the worse of the two:
 * `beds` rolls up onto `properties`, and `scoreComp` DROPS an unknown fact from
 * its denominator while scoring a stated one as a confident match — so a
 * 7-bedroom triplex was offered as a strong comparable for a 3-bedroom house.
 *
 * Pure — no database, no fixture corpus. Run: node scripts/test-comparable-units-pure.js
 */
const { extract } = require('../src/lib/appraisal/extract');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const mk = (rows, form = 'FNM1025') => `<?xml version="1.0"?><VALUATION_RESPONSE>
<REPORT AppraisalFormType="${form}"><PROPERTY><SALES_COMPARISON>
<COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="600000">
 <LOCATION PropertyStreetAddress="9 Triplex Rd" PropertyCity="Newark" PropertyState="NJ" PropertyPostalCode="07103"/>
 ${rows}
</COMPARABLE_SALE></SALES_COMPARISON></PROPERTY></REPORT></VALUATION_RESPONSE>`;

const R = (r, b, ba, amt) => `<ROOM_ADJUSTMENT TotalRoomCount="${r}" TotalBedroomCount="${b}"`
  + ` TotalBathroomCount="${ba}"${amt != null ? ` RoomAdjustmentAmount="${amt}"` : ''}/>`;

const comp = (rows, form) => (extract(mk(rows, form)).comparables || [])[0] || null;
const roomAdj = (c) => (c.adjustments || []).filter((a) => a.type === 'RoomCount').map((a) => a.amount);

// ---------------------------------------------------------------------------
// 1. THE REPORTED CASE. Three unit rows (5/3/1, 5/2/1, 4/2/1) plus the blank row
//    a form pads with. The property is 14 rooms, 7 beds, 3 full baths.
// ---------------------------------------------------------------------------
{
  const c = comp(R(5, 3, '1.0', -1000) + R(5, 2, '1.0') + R(4, 2, '1.0') + R('', '', ''));
  ok(c.totalRooms === 14, 'a 1025 comp\'s rooms are the PROPERTY total (14), not unit 1\'s 5');
  ok(c.beds === 7, 'and its bedrooms are 7, not unit 1\'s 3 — the number that rolls up onto properties');
  ok(c.bathsFull === 3 && c.bathsHalf === 0, 'and its baths add up across the units');
  ok(c.bathsText === '3.0', 'the baths TEXT is composed in the same UAD full.half notation, never a decimal');
  ok(c.units === 3, 'the unit count is the number of rows the appraiser actually wrote');
  ok(Array.isArray(c.unitMix) && c.unitMix.length === 3,
    'and the per-unit breakdown is kept — the fact the owner asked for by name');
  ok(c.unitMix.map((u) => u.beds).join(',') === '3,2,2', 'each unit keeps its own bedroom count');
  ok(c.unitMix[0].baths_full === 1 && c.unitMix[0].unit === 1, 'each unit keeps its own baths, numbered in grid order');
  ok(roomAdj(c).length === 1 && roomAdj(c)[0] === -1000,
    'the dollar line is one adjustment, so the grid still reconciles');
}

// A BLANK ROW IS NOT A UNIT — proven separately, because a form that pads to four
// rows on a two-unit property would otherwise report a 4-family.
{
  const c = comp(R(5, 3, '1.0') + R(5, 2, '1.0') + R('', '', '') + R('', '', ''));
  ok(c.units === 2 && c.unitMix.length === 2, 'padded blank rows are not counted as units');
  ok(c.beds === 5, 'and contribute nothing to the totals');
}

// ---------------------------------------------------------------------------
// 2. A 1004 IS UNCHANGED. One row is the PROPERTY, and it must behave exactly as
//    it did before — this is the shape the overwhelming majority of comps take.
// ---------------------------------------------------------------------------
{
  const c = comp(R(7, 3, '2.1', -2500), 'FNM1004');
  ok(c.totalRooms === 7 && c.beds === 3, 'a single-row grid reads exactly as it always did');
  ok(c.bathsFull === 2 && c.bathsHalf === 1 && c.bathsText === '2.1',
    'and its baths text is the grid\'s OWN string, not one we composed');
  ok(c.units === null, 'ONE ROW PROVES NOTHING about the unit count — a 1004 has exactly one row, so '
    + 'claiming "1 unit" from it would state a fact the grid never gave us');
  ok(c.unitMix === null, 'and there is no per-unit breakdown to report');
  ok(roomAdj(c)[0] === -2500, 'the room adjustment is untouched');
}

// ---------------------------------------------------------------------------
// 3. A DUPLEX WITH TWO IDENTICAL UNITS. This is the case that killed the first
//    draft's "is one of these rows a summary?" heuristic — "one row equals the
//    sum of the others" is TRIVIALLY TRUE of any two equal rows, so 5+5 was read
//    as "a total of 5 over one unit" and reported HALF the property. Two matched
//    units is the commonest 2-4 shape there is.
// ---------------------------------------------------------------------------
{
  const c = comp(R(5, 3, '1.0') + R(5, 3, '1.0'));
  ok(c.totalRooms === 10 && c.beds === 6 && c.bathsFull === 2,
    'two IDENTICAL units add up to the whole duplex, never to one of them');
  ok(c.units === 2 && c.unitMix.length === 2, 'and both are counted');
}

// The same trap one size up: three units where one happens to equal the other
// two combined. 10/5/5 is unresolvable — "a total of 10 over two units" reads
// exactly like "three units totalling 20" — and no signal in MISMO 2.6 tells
// them apart, so every row is a unit.
{
  const c = comp(R(10, 4, '2.0') + R(5, 2, '1.0') + R(5, 2, '1.0'));
  ok(c.totalRooms === 20 && c.beds === 8 && c.units === 3,
    'an arithmetically ambiguous row is still a unit — the grid wrote three rows, so there are three');
}

// ---------------------------------------------------------------------------
// 4. NEVER FABRICATE. No rows means no answer — not a zero, not the subject's.
// ---------------------------------------------------------------------------
{
  const c = comp('');
  ok(c.totalRooms === null && c.beds === null && c.bathsFull === null,
    'a grid stating no room line reports nothing rather than zero');
  ok(c.units === null && c.unitMix === null, 'and claims no units');
  ok(roomAdj(c).length === 0, 'and invents no adjustment');
}

// A row carrying ONLY an adjustment dollar figure and no counts is not a unit
// either — it has nothing to say about the property's size.
{
  const c = comp(R('', '', '', -750));
  ok(c.totalRooms === null && c.beds === null, 'a counts-free row states no size');
  ok(c.units === null, 'and is not a unit');
}

// ---------------------------------------------------------------------------
// 5. THE HALF-BATH NOTATION SURVIVES SUMMING. 2.1 + 1.1 is 3 full and 2 half,
//    which is "3.2" — never 3.2 as a decimal fraction, and never 2.2.
// ---------------------------------------------------------------------------
{
  const c = comp(R(6, 3, '2.1') + R(4, 2, '1.1'));
  ok(c.bathsFull === 3 && c.bathsHalf === 2, 'full and half baths are summed separately');
  ok(c.bathsText === '3.2', 'and the text says 3 full + 2 half in UAD notation');
}

// ---------------------------------------------------------------------------
// 6. PRICE PER FOOT WAS DEAD ON EVERY 2-4 UNIT COMP. A 1025 measures the
//    BUILDING, so it writes the same fact under `…PerGrossBuildingArea…`, and
//    only the living-area spelling was ever read: a 1004 read $154.59 and a 1025
//    read null, on an owner-named field.
// ---------------------------------------------------------------------------
{
  const mkPrice = (attrs) => `<?xml version="1.0"?><VALUATION_RESPONSE>
<REPORT AppraisalFormType="FNM1025"><PROPERTY><SALES_COMPARISON>
<COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="600000" ${attrs}>
 <LOCATION PropertyStreetAddress="9 Triplex Rd" PropertyCity="Newark" PropertyState="NJ" PropertyPostalCode="07103"/>
</COMPARABLE_SALE></SALES_COMPARISON></PROPERTY></REPORT></VALUATION_RESPONSE>`;
  const of = (attrs) => (extract(mkPrice(attrs)).comparables || [])[0];

  const gla = of('SalesPricePerGrossLivingAreaAmount="154.59"');
  ok(gla.pricePerGla === 154.59 && gla.pricePerGlaBasis === 'gla',
    'a 1004-style comp still reads its price per LIVING foot, and says that is what it is');

  const gba = of('SalesPricePerGrossBuildingAreaAmount="121.40"');
  ok(gba.pricePerGla === 121.40, 'a 1025 comp finally reads its price per BUILDING foot instead of null');
  ok(gba.pricePerGlaBasis === 'gba',
    'AND SAYS SO — $150 a foot of living area and $150 a foot of building area describe different '
    + 'properties, so comparing them silently would be a wrong answer');

  const both = of('SalesPricePerGrossLivingAreaAmount="154.59" SalesPricePerGrossBuildingAreaAmount="121.40"');
  ok(both.pricePerGla === 154.59 && both.pricePerGlaBasis === 'gla',
    'a file carrying both is read as living area, matching how gla_basis already resolves');

  const neither = of('');
  ok(neither.pricePerGla === null && neither.pricePerGlaBasis === null,
    'and a grid stating neither claims neither');
}

// ---------------------------------------------------------------------------
// 7. A COMPARABLE'S GARAGE WAS STRUCTURALLY ALWAYS NULL. The keyword list was
//    matched against the MISMO `SALE_PRICE_ADJUSTMENT/@_Type` enum, and 2.6
//    writes that line as `Parking` or `CarStorage` — neither of which was there,
//    so the fact never reached a single comparable on a compliant file.
// ---------------------------------------------------------------------------
{
  const { _internals } = require('../src/lib/research/ingest');
  const from = _internals && _internals.fromAdjustments;
  if (typeof from !== 'function') {
    ok(false, 'ingest exposes fromAdjustments for testing');
  } else {
    const txt = (v) => { const t = v == null ? '' : String(v).trim(); return t === '' ? null : t; };
    for (const type of ['Parking', 'CarStorage', 'Garage', 'GarageCarport', 'Carport']) {
      ok(from([{ type, description: '2 car attached', amount: -5000 }], 'garage', txt) === '2 car attached',
        `a garage line typed "${type}" is read`);
    }
    ok(from([{ type: 'Basement', description: 'full', amount: 0 }], 'garage', txt) === null,
      'and an unrelated line is not mistaken for one');
  }
}

// ---------------------------------------------------------------------------
// 8. A POST-REHAB REFINANCE IS NOT AN AFTER-REPAIR REPORT. "The repairs were
//    completed" reads identically on a file where the work really IS done and
//    the appraiser really IS valuing the house as it stands — and letting that
//    override an explicit `AsIs` threw the as-is value away and stamped every
//    comparable `arv`, on the commonest file this lender takes after a flip.
// ---------------------------------------------------------------------------
{
  const mkVal = (cond, narrative) => `<?xml version="1.0"?><VALUATION_RESPONSE>
<REPORT AppraisalFormType="FNM1004"><PROPERTY/>
<VALUATION PropertyAppraisedValueAmount="450000" AppraisalEffectiveDate="05/02/2026"/>
<_CONDITION_OF_APPRAISAL _Type="${cond}"/>
<REPORT_SUMMARY _Comment="${narrative}"/>
</REPORT></VALUATION_RESPONSE>`;
  const basisOf = (cond, narrative) => extract(mkVal(cond, narrative)).values.basis;

  ok(basisOf('AsIs', 'All repairs were completed in 2024.') === 'ASIS',
    'an explicit AsIs report saying the repairs are DONE stays AS-IS — that is a finished flip, not a projection');
  ok(basisOf('AsIs', 'The renovation has been completed and the property is in good order.') === 'ASIS',
    'and so does the other phrasing of the same finished-work sentence');
  ok(basisOf('AsIs', 'Appraised under the hypothetical condition that the repairs have been completed.') === 'ARV',
    'but an explicit HYPOTHETICAL condition still overrules the enum — that IS an after-repair value');
  ok(basisOf('SubjectToRepairs', 'Nothing in particular.') === 'ARV',
    'and a subject-to enum is after-repair whatever the narrative says');
  ok(basisOf('', 'All repairs were completed in 2024.') === 'ARV',
    'with NO stated condition the looser sentence still infers after-repair — there the alternative is a coin flip');
  ok(basisOf('', 'A quiet street near the park.') === 'ASIS',
    'and an ordinary narrative with no stated condition reads as as-is');
}

// ---------------------------------------------------------------------------
// 9. THE SUBJECT'S CONDITION IN THE APPRAISER'S OWN WORDS, and the as-is rating
//    mined from the narrative (db/429).
//
//    THE SPLIT IS BY FORM, NOT BY PROPERTY TYPE: UAD was mandated for exactly
//    1004, 1073, 1075 and 2055, and the 1025 was explicitly left out — so on the
//    whole 2-4 book the grid condition is the appraiser's own words, and they
//    were being dropped by the UAD whitelist with nowhere to land.
// ---------------------------------------------------------------------------
{
  const subj = (cond, qual) => `<?xml version="1.0"?><VALUATION_RESPONSE>
<REPORT AppraisalFormType="FNM1025"><PROPERTY/><VALUATION PropertyAppraisedValueAmount="450000"/>
<SALES_COMPARISON><COMPARABLE_SALE PropertySequenceIdentifier="0">
 <COMPARISON_DETAIL GSEOverallConditionType="${cond}" GSEQualityOfConstructionRatingType="${qual}"/>
</COMPARABLE_SALE></SALES_COMPARISON></REPORT></VALUATION_RESPONSE>`;
  let a = extract(subj('Average', 'Avg-Good'));
  ok(a.subject.conditionUad === null && a.subject.conditionText === 'Average',
    'a WORDED subject condition is kept beside the code slot, not discarded');
  ok(a.subject.qualityUad === null && a.subject.qualityText === 'Avg-Good',
    'and so is a worded quality rating');
  a = extract(subj('C4', 'Q3'));
  ok(a.subject.conditionUad === 'C4' && a.subject.conditionText === null,
    'a real UAD code still goes in the code slot and leaves the word slot empty — the review checks '
    + 'compare codes and must never see free text');
}

// The as-is rating out of the condition narrative — the ONE place it exists on a
// renovation report, where the grid states the finished house.
{
  const narrative = (comment) => `<?xml version="1.0"?><VALUATION_RESPONSE>
<REPORT AppraisalFormType="FNM1025">
<PROPERTY><PROPERTY_ANALYSIS _Type="PropertyCondition" _Comment="${comment}"/></PROPERTY>
<VALUATION PropertyAppraisedValueAmount="450000"/><_CONDITION_OF_APPRAISAL _Type="SubjectToRepairs"/>
<SALES_COMPARISON><COMPARABLE_SALE PropertySequenceIdentifier="0">
 <COMPARISON_DETAIL GSEOverallConditionType="C3"/></COMPARABLE_SALE></SALES_COMPARISON>
</REPORT></VALUATION_RESPONSE>`;
  const asIs = (c) => (extract(narrative(c)).enrich || {}).condition_uad_as_is || null;
  ok(asIs('C4 for as-is value. C3 for As repaired value.') === 'C4',
    'the as-is code is read from the clause that names the as-is basis');
  ok(asIs('As is the property rates C4; as repaired C2.') === 'C4',
    'in either clause order — a fixed character window read past the punctuation and lost this one');
  ok(asIs('The as-is condition is C4.') === 'C4', 'and from a plain single statement');
  // …and every way it must REFUSE. A wrong condition grade moves real money: one
  // grade over 1,500 sq ft at a $12-18/sqft rate is $18,000-27,000 per comp.
  ok(asIs('C4 or C5 as is depending on the inspection.') === null,
    'TWO codes in one clause is an appraiser who did not commit, and neither do we');
  ok(asIs('As is C4. As is C5 after further review.') === null, 'two clauses disagreeing states nothing');
  ok(asIs('C3 as repaired.') === null, 'the repaired rating alone is never read as the as-is one');
  ok(asIs('Subject to completion; C2 as complete.') === null, 'nor an as-complete rating');
  ok(asIs('Property is in average condition throughout.') === null, 'no code means no answer');
  ok(asIs('') === null, 'and no narrative means no answer');
  ok((extract(narrative('C4 for as-is value.')).enrich || {}).condition_comment === 'C4 for as-is value.',
    'the sentence itself is kept as the evidence behind the code');
}

console.log(failures ? `\ntest-comparable-units-pure: ${failures} FAILED` : '\ntest-comparable-units-pure: all passed');
process.exit(failures ? 1 : 0);
