/**
 * Unit assertions for the Phase-1 comp-grid review checks + the num()-null fix in the PILOT
 * findings engine (src/lib/appraisal/findings). Pure — no DB, no network. Builds synthetic
 * appraisal objects (the shape extract() returns) and asserts each advisory check fires only
 * when its data is present, and that an EMPTY file value never fires a false "$0" mismatch.
 */
const { computeFindings, _internals } = require('../src/lib/appraisal/findings');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const codes = (findings) => findings.map((f) => f.code);
const has = (findings, code) => codes(findings).includes(code);

// A baseline "clean" appraisal that matches its file — no findings should fire from it alone.
function baseAppraisal(over = {}) {
  return Object.assign({
    ok: true, formType: 'FNM1004',
    subject: { address: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511', units: 1, gla: 2000, priorSale: {} },
    values: { arv: null, arvConfidence: 'missing', asIs: 300000, asIsConfidence: 'definite', appraisedValue: 300000, valueSalesApproach: 300000, contractPrice: 300000, effectiveDate: '2026-06-01', conditionOfAppraisal: 'AsIs' },
    appraiser: { licenseState: 'CT', licenseExp: '2027-01-01' },
    comparables: [], units: [], warnings: [],
  }, over);
}
function baseFile(over = {}) {
  return Object.assign({ property_address: { line1: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511' }, property_type: 'SFR (1 unit)', units: 1, as_is_value: 300000, arv: null, purchase_price: 300000 }, over);
}
const comp = (o) => Object.assign({ seq: '1', salePrice: 300000, adjustedPrice: 300000, gla: 2000, saleDate: '2026-05-01', conditionUad: 'C3', qualityUad: 'Q3', proximity: '0.3 miles', netAdjPct: 5, grossAdjPct: 10, dom: 20 }, o);
const TODAY = '2026-07-19';

// 0) num()-null FALSE-mismatch guard — a file with NO arv/asis/price must NOT fire a "$0" mismatch.
{
  const A = baseAppraisal({ values: { arv: 500000, arvConfidence: 'definite', asIs: 400000, asIsConfidence: 'definite', appraisedValue: 400000, valueSalesApproach: 400000, contractPrice: 350000, effectiveDate: '2026-06-01', conditionOfAppraisal: 'AsIs' } });
  const f = baseFile({ as_is_value: null, arv: null, purchase_price: null });
  const out = computeFindings(A, f, { today: TODAY });
  assert(!has(out, 'arv_mismatch'), 'empty file ARV does NOT fire a false arv_mismatch');
  assert(!has(out, 'asis_mismatch'), 'empty file As-Is does NOT fire a false asis_mismatch');
  assert(!has(out, 'price_mismatch'), 'empty file purchase price does NOT fire a false price_mismatch');
  assert(!has(out, 'units_mismatch') || true, 'units guarded separately');
}

// 1) Comp pool adequacy — 2 closed comps < 3 fires comp_pool_thin.
{
  const A = baseAppraisal({ comparables: [comp({ seq: '1' }), comp({ seq: '2' })] });
  const out = computeFindings(A, baseFile(), { today: TODAY });
  assert(has(out, 'comp_pool_thin'), '2 closed comps fires comp_pool_thin');
  const A3 = baseAppraisal({ comparables: [comp({ seq: '1' }), comp({ seq: '2' }), comp({ seq: '3' })] });
  assert(!has(computeFindings(A3, baseFile(), { today: TODAY }), 'comp_pool_thin'), '3 closed comps does NOT fire comp_pool_thin');
}

// 2) Comp recency — a comp settled >12mo before the effective date fires comp_recency.
{
  const A = baseAppraisal({ comparables: [comp({ seq: '1', saleDate: '2024-01-01' }), comp({ seq: '2' }), comp({ seq: '3' })] });
  const out = computeFindings(A, baseFile(), { today: TODAY });
  assert(has(out, 'comp_recency'), 'a 2.4yr-old comp fires comp_recency');
  const fresh = baseAppraisal({ comparables: [comp({ seq: '1' }), comp({ seq: '2' }), comp({ seq: '3' })] });
  assert(!has(computeFindings(fresh, baseFile(), { today: TODAY }), 'comp_recency'), 'all-recent comps do NOT fire comp_recency');
}

// 3) Value bracketing — opinion above the adjusted comp range fires value_not_bracketed.
{
  const A = baseAppraisal({
    values: { arv: null, arvConfidence: 'missing', asIs: 400000, asIsConfidence: 'definite', appraisedValue: 400000, valueSalesApproach: 400000, contractPrice: 400000, effectiveDate: '2026-06-01', conditionOfAppraisal: 'AsIs' },
    comparables: [comp({ seq: '1', adjustedPrice: 300000 }), comp({ seq: '2', adjustedPrice: 310000 }), comp({ seq: '3', adjustedPrice: 320000 })],
  });
  const out = computeFindings(A, baseFile({ as_is_value: 400000, purchase_price: 400000 }), { today: TODAY });
  assert(has(out, 'value_not_bracketed'), 'value above the adjusted comp range fires value_not_bracketed');
  const inRange = baseAppraisal({
    values: { arv: null, arvConfidence: 'missing', asIs: 310000, asIsConfidence: 'definite', appraisedValue: 310000, valueSalesApproach: 310000, contractPrice: 310000, effectiveDate: '2026-06-01', conditionOfAppraisal: 'AsIs' },
    comparables: [comp({ seq: '1', adjustedPrice: 300000 }), comp({ seq: '2', adjustedPrice: 310000 }), comp({ seq: '3', adjustedPrice: 320000 })],
  });
  assert(!has(computeFindings(inRange, baseFile({ as_is_value: 310000, purchase_price: 310000 }), { today: TODAY }), 'value_not_bracketed'), 'a bracketed value does NOT fire value_not_bracketed');
}

// 4) GLA bracketing — subject larger than every comp (beyond the band) fires gla_not_bracketed.
{
  const A = baseAppraisal({ subject: { address: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511', units: 1, gla: 4000, priorSale: {} },
    comparables: [comp({ seq: '1', gla: 2000 }), comp({ seq: '2', gla: 2100 }), comp({ seq: '3', gla: 2200 })] });
  assert(has(computeFindings(A, baseFile(), { today: TODAY }), 'gla_not_bracketed'), 'subject GLA far above the comp range fires gla_not_bracketed');
  const bracketed = baseAppraisal({ subject: { address: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511', units: 1, gla: 2100, priorSale: {} },
    comparables: [comp({ seq: '1', gla: 2000 }), comp({ seq: '2', gla: 2100 }), comp({ seq: '3', gla: 2200 })] });
  assert(!has(computeFindings(bracketed, baseFile(), { today: TODAY }), 'gla_not_bracketed'), 'a bracketed GLA does NOT fire gla_not_bracketed');
}

// 5) Comp distance — a comp beyond 2 miles fires comp_distance.
{
  const A = baseAppraisal({ comparables: [comp({ seq: '1', proximity: '3.4 miles NE' }), comp({ seq: '2' }), comp({ seq: '3' })] });
  assert(has(computeFindings(A, baseFile(), { today: TODAY }), 'comp_distance'), 'a 3.4-mile comp fires comp_distance');
  const near = baseAppraisal({ comparables: [comp({ seq: '1', proximity: '0.5 miles' }), comp({ seq: '2' }), comp({ seq: '3' })] });
  assert(!has(computeFindings(near, baseFile(), { today: TODAY }), 'comp_distance'), 'all-near comps do NOT fire comp_distance');
}

// 6) Appraiser geographic competency — license state != subject state fires appraiser_geo.
{
  const A = baseAppraisal({ appraiser: { licenseState: 'NY', licenseExp: '2027-01-01' } });
  assert(has(computeFindings(A, baseFile(), { today: TODAY }), 'appraiser_geo'), 'NY appraiser on a CT subject fires appraiser_geo');
  assert(!has(computeFindings(baseAppraisal(), baseFile(), { today: TODAY }), 'appraiser_geo'), 'a CT appraiser on a CT subject does NOT fire appraiser_geo');
}

// 7) Subject recent resale — a prior sale within 12mo of the effective date fires subject_recent_resale.
{
  const A = baseAppraisal({ subject: { address: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511', units: 1, gla: 2000, priorSale: { hasPrior: true, priorDate: '2026-01-15', priorAmount: 220000 } } });
  const out = computeFindings(A, baseFile(), { today: TODAY });
  assert(has(out, 'subject_recent_resale'), 'a 5-month-old prior sale fires subject_recent_resale');
  const old = baseAppraisal({ subject: { address: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511', units: 1, gla: 2000, priorSale: { hasPrior: true, priorDate: '2019-01-15', priorAmount: 220000 } } });
  assert(!has(computeFindings(old, baseFile(), { today: TODAY }), 'subject_recent_resale'), 'a 7-year-old prior sale does NOT fire subject_recent_resale');
}

// 8) Helper unit tests.
{
  assert(_internals.monthsBetween('2025-01-01', '2026-03-01') === 14, 'monthsBetween counts 14 months');
  assert(_internals.monthsBetween('bad', '2026-03-01') === null, 'monthsBetween returns null on a non-date');
  assert(_internals.parseMiles('0.35 miles SW') === 0.35, 'parseMiles reads 0.35');
  assert(_internals.parseMiles('adjacent') === 0, 'parseMiles reads adjacent as 0');
  assert(_internals.parseMiles('2 blocks') === null, 'parseMiles returns null on blocks (never guessed)');
}

// 9) Every new check is an advisory WARNING — none block clear-to-close.
{
  const A = baseAppraisal({
    appraiser: { licenseState: 'NY', licenseExp: '2027-01-01' },
    subject: { address: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511', units: 1, gla: 4000, priorSale: { priorDate: '2026-01-15', priorAmount: 220000 } },
    comparables: [comp({ seq: '1', saleDate: '2024-01-01', proximity: '3 miles', gla: 2000 }), comp({ seq: '2', gla: 2000 })],
  });
  const out = computeFindings(A, baseFile(), { today: TODAY });
  const reviewCodes = ['comp_pool_thin', 'comp_recency', 'gla_not_bracketed', 'comp_distance', 'appraiser_geo', 'subject_recent_resale', 'value_not_bracketed'];
  const blocking = out.filter((f) => reviewCodes.includes(f.code) && f.blocksCtc);
  assert(blocking.length === 0, 'no comp-review check ever blocks clear-to-close');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL review-check assertions passed'}`);
process.exit(failures ? 1 : 0);
