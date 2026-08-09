/**
 * THE RENT SCHEDULE — the second comparable grid (task-list items 2.4 / 2.4b).
 *
 * A small-income appraisal carries `MULTIFAMILY_RENTALS` beside the sales grid:
 * sequence 0 is the SUBJECT, every sequence after it is a RENTAL comparable with
 * its own address, gross monthly rent, gross building area, rent-control status
 * and a per-unit breakdown that states SQUARE FOOTAGE. The sales grid's
 * `ROOM_ADJUSTMENT` never states an area, which is why the owner's "each and
 * every unit how many square footage" was answerable for the subject and not for
 * a comparable.
 *
 * Measured across 149 real production reports: 95 carry the grid, and it yields
 * 290 rental comparables — 100% with an address, 99.7% with per-unit square
 * footage. On 62 of them the appraiser described the SAME building in BOTH grids
 * of one report, which is what `mergeUnitAreas` carries across.
 *
 * Pure — no database. Run: node scripts/test-rental-grid-pure.js
 */
const { extract } = require('../src/lib/appraisal/extract');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// A report shaped exactly like the real ones: a sales grid AND a rent schedule.
const RU = (seq, rooms, beds, baths, sqft, rent) =>
  `<RENTAL_UNIT UnitSequenceIdentifier="${seq}" TotalRoomCount="${rooms}" TotalBedroomCount="${beds}"`
  + ` TotalBathroomCount="${baths}" SquareFeetCount="${sqft}" MonthlyRentAmount="${rent}"/>`;
const FEAT = (t, d) => `<RENTAL_FEATURE _Type="${t}" _Description="${d}"/>`;

const mk = ({ rentals = '', eff = '2026-05-01', form = 'FNM1025' } = {}) =>
  `<?xml version="1.0"?><VALUATION_RESPONSE><REPORT AppraisalFormType="${form}">
   <VALUATION AppraisalEffectiveDate="${eff}"/>
   <PROPERTY><SALES_COMPARISON>
     <COMPARABLE_SALE PropertySequenceIdentifier="1" PropertySalesAmount="500000">
       <LOCATION PropertyStreetAddress="9 Sales Rd" PropertyCity="Newark" PropertyState="NJ" PropertyPostalCode="07103"/>
       <ROOM_ADJUSTMENT UnitSequenceIdentifier="1" TotalRoomCount="5" TotalBedroomCount="3" TotalBathroomCount="1.0"/>
       <ROOM_ADJUSTMENT UnitSequenceIdentifier="2" TotalRoomCount="4" TotalBedroomCount="2" TotalBathroomCount="1.0"/>
     </COMPARABLE_SALE>
   </SALES_COMPARISON>
   <MULTIFAMILY_RENTALS>${rentals}</MULTIFAMILY_RENTALS>
   </PROPERTY></REPORT></VALUATION_RESPONSE>`;

const rentalsOf = (xml) => (extract(xml).rentalComps || []);

// ---------------------------------------------------------------------------
// 1. A REAL RENTAL COMPARABLE, read whole.
// ---------------------------------------------------------------------------
{
  const xml = mk({ rentals:
    `<MULTIFAMILY_RENTAL PropertySequenceIdentifier="0" MonthlyRentAmount="3,500"
       RentPerGrossBuildingAreaAmount="1.31" RentControlStatusType="No" GrossBuildingAreaSquareFeetCount="2,667">
       <LOCATION PropertyStreetAddress="134 Butler St" PropertyStreetAddress2="New Haven, CT 06511"/>
       ${RU(1, 4, 2, '1.0', '1,008', '1,700')}${RU(2, 7, 4, '2.0', '1,659', '1,800')}
       ${FEAT('Age', '126')}${FEAT('Condition', 'C3')}${FEAT('Lease', 'Monthly')}${FEAT('UtilitiesIncluded', 'Water /Sewer')}
     </MULTIFAMILY_RENTAL>
     <MULTIFAMILY_RENTAL PropertySequenceIdentifier="1" MonthlyRentAmount="2,750"
       RentPerGrossBuildingAreaAmount="1.00" RentControlStatusType="Yes" GrossBuildingAreaSquareFeetCount="2,747"
       DataSourceDescription="Pubrec/Mls/Crs">
       <LOCATION PropertyStreetAddress="766 Winchester Ave" PropertyStreetAddress2="New Haven, CT 06511"
                 ProximityToSubjectDescription="0.27 miles SE"/>
       ${RU(1, 5, 3, '1.0', '1,029', '0')}${RU(2, 7, 5, '2.0', '1,718', '2,750')}
       <RENTAL_UNIT UnitSequenceIdentifier="3" TotalRoomCount="" TotalBedroomCount="" TotalBathroomCount="" SquareFeetCount="" MonthlyRentAmount=""/>
       <RENTAL_UNIT UnitSequenceIdentifier="4" TotalRoomCount="" TotalBedroomCount="" TotalBathroomCount="" SquareFeetCount="" MonthlyRentAmount=""/>
       ${FEAT('Age', '126')}${FEAT('Condition', 'Average')}${FEAT('Lease', 'M-T-M')}
     </MULTIFAMILY_RENTAL>` });
  const rs = rentalsOf(xml);
  ok(rs.length === 2, 'both entries are read — the subject at sequence 0 and the rental comparable after it');

  const subj = rs.find((r) => r.isSubject);
  ok(!!subj && subj.seq === '0', 'sequence 0 is flagged as the SUBJECT, so nothing counts it as somebody else\'s building');

  const c = rs.find((r) => !r.isSubject);
  ok(c.address === '766 Winchester Ave' && c.city === 'New Haven' && c.state === 'CT' && c.zip === '06511',
    'the address is read whole, including the "City, ST ZIP" second line the sales grid uses');
  ok(c.proximity === '0.27 miles SE', 'and how far it is from the subject');
  ok(c.monthlyRent === 2750, 'the gross monthly rent, comma-separated in the source');
  ok(c.gba === 2747 && c.rentPerGba === 1, 'the gross building area and the rent per foot');
  ok(c.rentControlled === true, 'a rent-controlled building says so');
  ok(subj.rentControlled === false, 'and one that is not says that — the enum is Yes/No');
  ok(c.dataSource === 'Pubrec/Mls/Crs', 'where the appraiser got it');
  ok(c.conditionText === 'Average' && c.conditionUad === null,
    'a WORDED condition is kept as text — the review checks compare UAD codes and must never see free text');
  ok(subj.conditionUad === 'C3' && subj.conditionText === null, 'and a UAD code is kept as a code');
  ok(c.ageYears === 126 && c.yearBuilt === '1900',
    'the age the grid states, and the year built derived from it plus the report\'s effective date');
  ok(c.leaseTerms === 'M-T-M', 'the lease terms');

  // THE PER-UNIT BREAKDOWN — the whole point of item 2.4b.
  ok(c.units === 2, 'the padded unit rows are not dwellings, so a duplex is two units and not four');
  ok(c.unitMix.length === 2, 'and the mix carries exactly the two real ones');
  ok(c.unitMix[0].sqft === 1029 && c.unitMix[1].sqft === 1718,
    'WITH SQUARE FOOTAGE PER UNIT — the fact the sales grid never states');
  ok(c.unitMix[0].beds === 3 && c.unitMix[1].beds === 5, 'and beds per unit');
  ok(c.unitMix[1].monthly_rent === 2750, 'and what each unit rents for');
  ok(c.unitMix[0].unit === '1' && c.unitMix[1].unit === '2',
    'under the appraiser\'s OWN unit numbers, never a position');
}

// ---------------------------------------------------------------------------
// 2. WHAT IT REFUSES.
// ---------------------------------------------------------------------------
{
  // A padded slot names nothing and states no rent.
  const padded = rentalsOf(mk({ rentals:
    `<MULTIFAMILY_RENTAL PropertySequenceIdentifier="1"><LOCATION/></MULTIFAMILY_RENTAL>` }));
  ok(padded.length === 0, 'an entry that names no property and states no rent is a padded slot, and is dropped');

  // A real one with an address but no rent is KEPT — it is still a property.
  const noRent = rentalsOf(mk({ rentals:
    `<MULTIFAMILY_RENTAL PropertySequenceIdentifier="1">
       <LOCATION PropertyStreetAddress="1 Quiet Ln" PropertyCity="Newark" PropertyState="NJ"/>
     </MULTIFAMILY_RENTAL>` }));
  ok(noRent.length === 1 && noRent[0].address === '1 Quiet Ln',
    'but a row that names a property is kept even with no rent — it is still a real building');

  // A MISSING AGE IS NOT AN AGE OF ZERO — the `Number(null)` trap.
  const noAge = rentalsOf(mk({ rentals:
    `<MULTIFAMILY_RENTAL PropertySequenceIdentifier="1" MonthlyRentAmount="2000">
       <LOCATION PropertyStreetAddress="2 Ageless Way" PropertyCity="Newark" PropertyState="NJ"/>
     </MULTIFAMILY_RENTAL>` }));
  ok(noAge[0].yearBuilt == null && noAge[0].ageYears == null,
    'no Age line means no year built — never the report\'s own year (Number(null) is 0, and 0 is finite)');

  // An unreadable rent-control value is left unanswered, never read as "no".
  const rc = rentalsOf(mk({ rentals:
    `<MULTIFAMILY_RENTAL PropertySequenceIdentifier="1" MonthlyRentAmount="2000" RentControlStatusType="Unknown">
       <LOCATION PropertyStreetAddress="3 Maybe St" PropertyCity="Newark" PropertyState="NJ"/>
     </MULTIFAMILY_RENTAL>` }));
  ok(rc[0].rentControlled === null, 'an unreadable rent-control value is left NULL, never assumed to be "no"');

  // A report with no rent schedule at all yields an empty list, not a throw.
  ok(rentalsOf(mk({})).length === 0, 'a report with no rent schedule yields nothing and does not throw');
}

// ---------------------------------------------------------------------------
// 3. ITEM 2.4b — carrying the per-unit AREA onto the sales comparable.
// ---------------------------------------------------------------------------
{
  const { mergeUnitAreas } = require('../src/lib/research/ingest')._internals;
  const sales = [
    { unit: '1', rooms: 5, beds: 3, baths_full: 1, baths_half: 0, baths: '1.0' },
    { unit: '2', rooms: 4, beds: 2, baths_full: 1, baths_half: 0, baths: '1.0' },
  ];
  const rent = [
    { unit: '1', sqft: 1029, monthly_rent: 1700 },
    { unit: '2', sqft: 1718, monthly_rent: 1800 },
  ];

  const merged = mergeUnitAreas(sales, rent);
  ok(merged[0].sqft === 1029 && merged[1].sqft === 1718,
    'the area the rent schedule states lands on the sales comparable, matched by the appraiser\'s unit number');
  ok(merged[0].beds === 3 && merged[0].rooms === 5,
    'and everything the sales grid already stated is untouched');
  ok(merged[0].monthly_rent === 1700, 'the per-unit rent comes across too');

  // IT ONLY EVER FILLS A BLANK.
  const stated = mergeUnitAreas(
    [{ unit: '1', sqft: 900 }, { unit: '2', sqft: 950 }],
    [{ unit: '1', sqft: 1029 }, { unit: '2', sqft: 1718 }]);
  ok(stated[0].sqft === 900 && stated[1].sqft === 950,
    'a value the sales grid already stated is NEVER overwritten');

  // EVERY REFUSAL — putting unit 3's area on unit 2 is worse than a blank.
  ok(mergeUnitAreas(sales, [{ unit: '1', sqft: 1029 }]) === sales,
    'a different number of dwellings is refused — the pairing would be a guess');
  ok(mergeUnitAreas(sales, [{ unit: '1', sqft: 1 }, { unit: '1', sqft: 2 }]) === sales,
    'a repeated unit number on the rent side is refused');
  ok(mergeUnitAreas(sales, [{ unit: '1', sqft: 1029 }, { unit: '3', sqft: 1718 }]) === sales,
    'a unit number present on one side and not the other is refused');
  ok(mergeUnitAreas(sales, null) === sales, 'no rent schedule leaves the sales mix exactly as it was');
  ok(mergeUnitAreas(null, rent) === null, 'and no sales mix yields nothing to merge into');
  ok(mergeUnitAreas('not json', rent) === 'not json', 'an unreadable sales mix is returned untouched');
  ok(mergeUnitAreas(JSON.stringify(sales), rent)[0].sqft === 1029,
    'a mix that arrives as a JSON string (a database read) is handled');

  // NOTHING TO ADD MEANS NOTHING CHANGES — same object back, so no write churn.
  const full = [{ unit: '1', sqft: 900, monthly_rent: 10 }];
  ok(mergeUnitAreas(full, [{ unit: '1', sqft: 1, monthly_rent: 2 }]) === full,
    'when there is nothing to fill, the original is returned unchanged');

  // A LATER UNIT'S FILL MUST NOT BE CREDITED TO AN EARLIER ONE.
  const partial = mergeUnitAreas(
    [{ unit: '1', sqft: 900 }, { unit: '2' }],
    [{ unit: '1', sqft: 111 }, { unit: '2', sqft: 222 }]);
  ok(partial[0].sqft === 900 && partial[1].sqft === 222,
    'unit 1 keeps its stated area while unit 2 gains one — the fill is per unit, not per grid');
}

console.log(failures ? `\ntest-rental-grid-pure: ${failures} FAILED` : '\ntest-rental-grid-pure: all passed');
process.exit(failures ? 1 : 0);
