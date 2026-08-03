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

// ---------------------------------------------------------------------------
// 10. THE ONLY PROPERTY TYPE A COMPARABLE GRID EVER PROVES (task item 1.7).
//     `appraisal_comparables.property_type` has existed since db/409 §7 and was
//     written by NOTHING — 0 of 83 rows — which reads on screen as "the report
//     didn't say" when the truth was "we never looked". No MISMO element states
//     it, but a grid that wrote a room line PER UNIT has stated how many
//     dwellings there are, and that IS the answer to "one-family or 2-4?".
// ---------------------------------------------------------------------------
{
  const { comparableRowFrom } = require('../src/lib/appraisal/import');
  const typeOf = (rows) => comparableRowFrom(comp(rows)).property_type;
  ok(typeOf(R(5, 3, '1.0') + R(5, 2, '1.0')) === 'Multi 2–4', 'two unit rows is a 2-4 family');
  ok(typeOf(R(5, 3, '1.0') + R(5, 2, '1.0') + R(4, 2, '1.0') + R(4, 2, '1.0')) === 'Multi 2–4',
    'and so is four');
  ok(typeOf(Array.from({ length: 6 }, () => R(4, 2, '1.0')).join('')) === 'Multi 5+',
    'six unit rows is a 5+');
  ok(typeOf(R(7, 3, '2.1')) === null,
    'ONE room row proves nothing — a 1004 grid has exactly one whatever the property is, so '
    + 'reading "SFR" out of it would be inventing a fact');
  ok(typeOf('') === null, 'and a grid with no room line at all says nothing');
  // It speaks the PORTAL's vocabulary, so a comparable and a subject can never
  // describe the same building in two different words.
  const { LABEL_OF } = require('../src/lib/property-type');
  ok(typeOf(R(5, 3, '1.0') + R(5, 2, '1.0')) === LABEL_OF.multi_2_4,
    'in the portal\'s own vocabulary, not a private spelling');
}

// ---------------------------------------------------------------------------
// 11. THE FORM IS ALWAYS PASSED IN PRODUCTION, so every claim about identity has
//     to be tested WITH one. Section 10 above calls `comparableRowFrom(comp)`
//     with no form — a shape that exists at no call site (import.js, desk.js and
//     xml-import.js all pass `A.formType`), so it proved nothing about what the
//     database actually stores. Measured against 769 comparables read out of the
//     real SharePoint corpus: 768 state a unit count and 769 a property type.
// ---------------------------------------------------------------------------
{
  const { comparableRowFrom } = require('../src/lib/appraisal/import');
  const { LABEL_OF } = require('../src/lib/property-type');
  const id = (c, form) => { const r = comparableRowFrom(c, form); return `${r.units}/${r.property_type}/${r.identity_basis}`; };
  const styled = (text, extra) => Object.assign({ adjustments: [{ type: 'DesignStyle', description: text }] }, extra || {});

  // --- the form, when nothing measured the comparable ---
  ok(id({}, 'FNM1004') === '1/SFR (1 unit)/form', 'a 1004 comparable is one dwelling by definition');
  ok(id({}, 'FNM1073') === '1/Condo/form', 'a 1073 comparable is a condo');
  ok(id({}, 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`,
    'a 1025 gives the 2-4 band and NOT a door count — the exact count needs a real source');
  ok(id({}, null) === 'null/null/null', 'no form and no grid states nothing at all');

  // --- A 1004D IS NOT A 1004 (measured: 1400-1402 Stratford, a two-family) ---
  ok(id({}, 'FNM1004D') === 'null/null/null',
    'a 1004D is the Appraisal UPDATE form — it attaches to a 1004, a 1025 or a 1073 and proves nothing');
  ok(id(styled('DT2.5;2 Family'), 'FNM1004D') === `2/${LABEL_OF.multi_2_4}/style`,
    'so the appraiser\'s own words decide it, and a two-family stops being stored as a house');

  // --- the design style, and everything it refuses ---
  ok(id(styled('3 FAMILY'), 'FNM1025') === `3/${LABEL_OF.multi_2_4}/style`, '"3 FAMILY" is three doors');
  ok(id(styled('4-PLEX'), 'FNM1025') === `4/${LABEL_OF.multi_2_4}/style`, '"4-PLEX" is four');
  ok(id(styled('Duplex'), 'FNM1025') === `2/${LABEL_OF.multi_2_4}/style`, 'a duplex is two');
  ok(id(styled('SD2;1/2 Duplex'), 'FNM1004') === '1/SFR (1 unit)/form',
    'but "1/2 Duplex" is ONE SIDE of a two-unit building — 9 comparables in the corpus, every one a '
    + 'single-family house that a bare /duplex/ match would have doubled');
  ok(id(styled('DOUBLE BLOCK'), 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`,
    '"DOUBLE BLOCK" means the whole pair to some appraisers and one side to others, so it is left unanswered');
  ok(id(styled('DT2;Colonial'), 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`, 'a style word is not a count');
  ok(id(styled('2 Family'), 'FNM1073') === '1/Condo/form',
    'and a style outside the form\'s own band is refused, never allowed to contradict it');

  // --- the grid outranks everything, and NAMES THE TYPE ---
  // TWO DIFFERENT RULES HIDE BEHIND "THE FORM'S BAND", and the first draft of
  // this assertion had them backwards — it asserted that a grid-stated 2 on a
  // 1004 RELABELS the comparable "Multi 2–4", which throws away the one thing
  // that form proves outright.
  ok(id({ units: 2 }, 'FNM1004') === '2/SFR (1 unit)/grid',
    'a 1004 is written for ONE dwelling, so a grid-stated 2 is a MIS-PARSE: the count is kept so the '
    + 'contradiction stays visible, and the form keeps the label');
  ok(id({ units: 2 }, 'FNM1073') === '2/Condo/grid',
    'and a 1073 comparable never stops being a condo because its room rows were double-counted');
  ok(id({ units: 5 }, 'FNM1025') === `5/${LABEL_OF.multi_5_plus}/grid`,
    'but a 1025\'s 2-4 band describes the SUBJECT — a five-unit COMPARABLE is unusual, not '
    + 'impossible, and the corpus has them, so the stated count names the type');
  ok(id({ units: 3 }, 'FNM1025') === `3/${LABEL_OF.multi_2_4}/grid`,
    'and inside the band the count still names the type');
  ok(id(Object.assign(styled('4-PLEX'), { units: 3 }), 'FNM1025') === `3/${LABEL_OF.multi_2_4}/grid`,
    'the grid outranks the appraiser\'s style word');

  // --- the arithmetic, and the two ways it used to invent a number ---
  ok(id({ salePrice: 600000, pricePerUnit: 200000 }, 'FNM1025') === `3/${LABEL_OF.multi_2_4}/price`,
    '600k over 200k a door is three doors');
  ok(id({ salePrice: 600000, pricePerUnit: 202000 }, 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`,
    'a ratio of 2.97 proves nothing — per-unit figures are rounded');
  ok(id({ salePrice: 600000, pricePerUnit: 75000 }, 'URAR') === 'null/null/null',
    'an UNRECOGNISED form constrains nothing, so it may not license a guess: this used to store EIGHT units / "Multi 5+"');
  ok(id({ salePrice: 8, pricePerUnit: 1 }, 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`,
    'and a sub-dollar price satisfies a $1 tolerance for EVERY divisor, so the arithmetic is refused below a real price');
  ok(id({ salePrice: 600000, pricePerUnit: 200 }, 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`,
    'a price per FOOT mistaken for a price per door divides to 3000, far outside any band');
  for (const bad of [0, -1, NaN, null, undefined]) {
    ok(id({ salePrice: 600000, pricePerUnit: bad }, 'FNM1025') === `null/${LABEL_OF.multi_2_4}/form`,
      `a per-unit figure of ${String(bad)} proves nothing`);
  }

  // --- the year built the grid never states ---
  ok(comparableRowFrom({ ageYears: 106, yearBuilt: '1920' }, 'FNM1004').year_built === 1920,
    'the year built rides the comparable row (db/432)');
  ok(comparableRowFrom({ ageYears: 106 }, 'FNM1004').year_built == null,
    'and stays null when the report gave no effective date to subtract the age from');

  // A MISSING AGE IS NOT AN AGE OF ZERO. `Number(null)` is 0, and 0 is finite, so
  // a Number.isFinite guard alone dated every comparable whose grid states no age
  // to the report's own year -- measured as "built 2026" across the corpus, and
  // caught by CI. An age the grid really DOES state as 0 is new construction and
  // must still come through.
  const yb = (rows, eff) => {
    const xml = '<?xml version="1.0"?><VALUATION_RESPONSE><REPORT AppraisalFormType="FNM1004">'
      + '<VALUATION' + (eff ? ' AppraisalEffectiveDate="' + eff + '"' : '') + '/><PROPERTY><SALES_COMPARISON>'
      + '<COMPARABLE_SALE PropertySequenceIdentifier="1" PropertySalesAmount="500000">'
      + '<LOCATION PropertyStreetAddress="1 Age Rd" PropertyCity="Newark" PropertyState="NJ"/>'
      + rows + '</COMPARABLE_SALE></SALES_COMPARISON></PROPERTY></REPORT></VALUATION_RESPONSE>';
    const c = (extract(xml).comparables || [])[0];
    return c ? c.yearBuilt : undefined;
  };
  const AGE = (d) => '<SALE_PRICE_ADJUSTMENT _Type="Age" _Description="' + d + '" _Amount="0"/>';
  ok(yb('', '2026-05-01') == null, 'no Age line at all: the year built stays NULL, not the report year');
  ok(yb(AGE('60'), '2026-05-01') === '1966', 'a stated age of 60 on a 2026 report is 1966');
  ok(yb(AGE('0'), '2026-05-01') === '2026', 'and a stated age of ZERO is real new construction, not a missing value');
  ok(yb(AGE('60'), null) == null, 'with no effective date there is nothing to subtract the age from');
}

// ---------------------------------------------------------------------------
// 12. THE VENDOR THAT WRITES A TOTAL ROW HAS NOW BEEN SEEN — and counting rows
//     made every one of its comparables ONE UNIT TOO MANY.
//
//     Class Appraisal and OneStop emit an UNNUMBERED leading row carrying the
//     property's totals, ahead of rows that DO carry `UnitSequenceIdentifier`.
//     Measured over 149 real reports, scored against the appraiser's OWN
//     `SalesPricePerUnitAmount` — an independent witness the parser never
//     consults for a grid-stated count: 133 of 350 multi-unit comparables
//     carried a WRONG unit count. After the fix, 350 of 350 agree.
//
//     The discriminator is STRUCTURAL, which is why it is safe where the removed
//     draft (section 3) was not: that one compared COUNTS and could not tell a
//     total row from a duplex of two identical units. This asks whether the grid
//     numbers its units at all — and when no row is numbered, nothing is dropped.
// ---------------------------------------------------------------------------
{
  const N = (seq, r, b, ba) => `<ROOM_ADJUSTMENT UnitSequenceIdentifier="${seq}" TotalRoomCount="${r}"`
    + ` TotalBedroomCount="${b}" TotalBathroomCount="${ba}"/>`;

  // The real Class Appraisal shape: an unnumbered total, three numbered units,
  // and a trailing empty slot.
  const cls = comp(R(4, 2, '1.0') + N(1, 4, 2, '1.0') + N(2, 4, 2, '1.0') + N(3, 2, 1, '1.0')
    + '<ROOM_ADJUSTMENT UnitSequenceIdentifier="4"/>');
  ok(cls.units === 3, 'the unnumbered total row is not a dwelling — three numbered units is three units, not four');
  ok(cls.unitMix.length === 3 && cls.unitMix.map((u) => u.unit).join(',') === '1,2,3',
    'and the mix carries each unit ONCE, under the appraiser\'s own number — it used to open with unit 1 twice');
  ok(cls.beds === 5 && cls.totalRooms === 10,
    'the totals are summed over the UNITS only, so the summary row is not double-counted');

  // A grid that numbers nothing is untouched — the shape every other vendor emits.
  const plain = comp(R(5, 3, '1.0') + R(5, 2, '1.0'));
  ok(plain.units === 2 && plain.beds === 5, 'a grid that numbers nothing behaves exactly as before');

  // THE CASE THE REMOVED DRAFT FAILED: a duplex of two identical units. No row is
  // numbered, so nothing is dropped and it is still two units — not "a total of 5".
  const duplex = comp(R(5, 2, '1.0') + R(5, 2, '1.0'));
  ok(duplex.units === 2 && duplex.beds === 4,
    'a duplex with two identical units is still two units — the trap that killed the value-based draft');

  // A numbered grid with NO summary row loses nothing.
  const numbered = comp(N(1, 5, 3, '1.0') + N(2, 5, 2, '1.0'));
  ok(numbered.units === 2, 'a fully-numbered grid with no summary row is unchanged');

  // The appraiser's own arithmetic is the witness this was scored against.
  const { comparableRowFrom } = require('../src/lib/appraisal/import');
  const row = comparableRowFrom(Object.assign({}, cls, { salePrice: 600000, pricePerUnit: 200000 }), 'FNM1025');
  ok(row.units === 3 && Math.round(600000 / 200000) === row.units,
    'and the count now agrees with the price per unit the appraiser stated beside it');
}

// ---------------------------------------------------------------------------
// 13. THE RE-PARSE MUST ACCOUNT FOR EVERY COLUMN THE PARSER WRITES.
//
//     `backfillComparableParseOnce` stamps `comp_parse_version` and then never
//     revisits the report, so a column added to `comparableRowFrom` and left out
//     of `REPARSED` is drained out of the back-book repair PERMANENTLY and needs
//     a further version bump to recover. That already happened once: db/430's
//     four facts and db/431's `identity_basis` were added to the writer and not
//     to the list, while the version was bumped — so every stored report would
//     have been stamped "re-parsed" with all five still NULL.
//
//     The file carried a comment saying every parser-owned column must be listed
//     and listed 19 of 53. An invariant nothing asserts is a wish, so this is the
//     assertion: every column the writer emits is either RE-PARSED or explicitly
//     named as deliberately left alone. Adding a column now fails here until a
//     human decides which it is.
// ---------------------------------------------------------------------------
{
  const { comparableRowFrom } = require('../src/lib/appraisal/import');
  const { REPARSED, NOT_REPARSED } = require('../src/lib/appraisal/desk')._internals;
  const written = Object.keys(comparableRowFrom({}, 'FNM1025'));
  const covered = new Set([...REPARSED, ...NOT_REPARSED]);
  const uncovered = written.filter((k) => !covered.has(k));
  ok(uncovered.length === 0,
    `every column comparableRowFrom writes is accounted for (uncovered: ${uncovered.join(', ') || 'none'})`);
  const phantom = [...covered].filter((k) => !written.includes(k));
  ok(phantom.length === 0,
    `and nothing is listed that the writer never emits (phantom: ${phantom.join(', ') || 'none'})`);
  const both = REPARSED.filter((k) => NOT_REPARSED.includes(k));
  ok(both.length === 0, `no column is both re-parsed and left alone (${both.join(', ') || 'none'})`);
  // The three facts that must always travel together.
  for (const k of ['units', 'property_type', 'identity_basis']) {
    ok(REPARSED.includes(k), `${k} is re-parsed — the identity trio moves as one`);
  }
}

console.log(failures ? `\ntest-comparable-units-pure: ${failures} FAILED` : '\ntest-comparable-units-pure: all passed');
process.exit(failures ? 1 : 0);
