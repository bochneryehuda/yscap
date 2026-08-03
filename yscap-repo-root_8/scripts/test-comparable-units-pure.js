/**
 * A 2-4 UNIT COMPARABLE'S ROOM COUNTS — the wrong-answer bug, pinned. (db/426)
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

console.log(failures ? `\ntest-comparable-units-pure: ${failures} FAILED` : '\ntest-comparable-units-pure: all passed');
process.exit(failures ? 1 : 0);
