'use strict';
/**
 * Pure test for the ROV support helpers (src/amc/rov.js). No DB, no network:
 * the unit band, the comp shaping, the structured detail, and the narrative that
 * rides the AMC AddRevision.
 */
const rov = require('../src/amc/rov');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ---- unit band (owner's rule) ----
ok(rov.unitBand(1).units_min === 1 && rov.unitBand(1).units_max === 1, '1 unit → 1-1');
ok(rov.unitBand(3).units_min === 2 && rov.unitBand(3).units_max === 4, '3 units → 2-4');
ok(rov.unitBand(6).units_min === 5 && rov.unitBand(6).units_max === undefined, '6 units → 5+');
ok(rov.unitBand(0) === null && rov.unitBand(null) === null && rov.unitBand('x') === null, 'unknown units → no band (never guess)');

// ---- comp shaping ----
{
  const c = rov.compRow({ id: 'p1', display_address: '10 Oak St, Brooklyn, NY', last_sale_price: '450000', last_sale_date: '2026-05-01T00:00:00Z', gla: '1800', beds: '3', baths_full: '2', baths_half: '1', units: '1', year_built: '1998', distance_miles: '0.42' });
  ok(c.propertyId === 'p1' && c.address === '10 Oak St, Brooklyn, NY', 'comp id + address');
  ok(c.salePrice === 450000 && c.saleDate === '2026-05-01', 'comp sale price + date (date sliced)');
  ok(c.gla === 1800 && c.beds === 3 && c.bathsFull === 2 && c.distanceMiles === 0.42, 'comp specs numeric');
}

// ---- structured detail ----
{
  const d = rov.buildRovDetail({ appraisedValue: '400000', opinionValue: 460000, note: '  low comps  ', comps: [
    { propertyId: 'p1', address: '10 Oak St', salePrice: '450000', saleDate: '2026-05-01', gla: 1800, beds: 3, bathsFull: 2, bathsHalf: 1, distanceMiles: 0.42 },
  ] });
  ok(d.appraisedValue === 400000 && d.opinionValue === 460000, 'detail values coerced to numbers');
  ok(d.note === 'low comps', 'detail note trimmed');
  ok(d.comps.length === 1 && d.comps[0].salePrice === 450000, 'detail comps shaped');
}

// ---- narrative ----
{
  const detail = rov.buildRovDetail({ appraisedValue: 400000, opinionValue: 460000, note: 'Please reconsider.', comps: [
    { address: '10 Oak St, Brooklyn, NY', salePrice: 450000, saleDate: '2026-05-01', gla: 1800, beds: 3, bathsFull: 2, bathsHalf: 1, distanceMiles: 0.42 },
    { address: '12 Elm St, Brooklyn, NY', salePrice: 470000, saleDate: '2026-06-15', gla: 1900, beds: 3, bathsFull: 2 },
  ] });
  const text = rov.buildRovNarrative(detail);
  ok(/Reconsideration of Value \(ROV\) request\./.test(text), 'narrative headline');
  ok(/appraised value of \$400,000/.test(text), 'narrative cites the appraised value');
  ok(/opinion of value of \$460,000/.test(text), 'narrative cites the opinion value');
  ok(/1\. 10 Oak St, Brooklyn, NY — sold \$450,000 on 2026-05-01 \(1800 sq ft, 3 bd, 2\.1 ba\), 0\.42 mi from the subject\./.test(text), 'narrative comp line 1');
  ok(/2\. 12 Elm St, Brooklyn, NY — sold \$470,000 on 2026-06-15 \(1900 sq ft, 3 bd, 2 ba\)\./.test(text), 'narrative comp line 2 (no distance)');
  ok(/Please reconsider\.$/.test(text), 'narrative ends with the note');
}

// ---- narrative with no comps still asks for reconsideration ----
{
  const text = rov.buildRovNarrative(rov.buildRovDetail({ appraisedValue: 400000, opinionValue: 460000, comps: [] }));
  ok(/reconsideration to a value of \$460,000/.test(text), 'no-comps narrative still states the requested value');
}

console.log(`\n[test-amc-rov-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
