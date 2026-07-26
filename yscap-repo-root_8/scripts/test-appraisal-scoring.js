/**
 * Unit assertions for the PILOT collateral scoring module (src/lib/appraisal/scoring):
 * the explainable 1–5 collateral read and the ARV-defensibility cross-check. Pure — no DB.
 */
const { collateralScore, arvDefensibility, compImpliedValue } = require('../src/lib/appraisal/scoring');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- collateralScore ----
// A pristine C2/Q2 file with a full comp set + clean valuation scores high.
{
  const s = collateralScore({ a: { condition_uad: 'C2', quality_uad: 'Q2', as_is_confidence: 'definite', flood_zone: 'X', zoning_compliance: 'Legal' },
    comps: [{ sale_price: 1 }, { sale_price: 1 }, { sale_price: 1 }], summary: { fatal: 0 } });
  assert(s.score >= 4, `pristine collateral scores high (got ${s.score})`);
  assert(s.factors.some((f) => /Condition C2/.test(f.label) && f.effect > 0), 'C2 condition is a positive factor');
  assert(s.band === 'Strong' || s.band === 'Solid', `band reads ${s.band}`);
}
// A distressed C5/Q5 file in a flood zone with a fatal finding scores low.
{
  const s = collateralScore({ a: { condition_uad: 'C5', quality_uad: 'Q5', as_is_confidence: 'from_narrative', flood_zone: 'AE', zoning_compliance: 'Legal non-conforming' },
    comps: [{ sale_price: 1 }], summary: { fatal: 2 } });
  assert(s.score <= 2, `distressed collateral scores low (got ${s.score})`);
  assert(s.factors.some((f) => f.effect < 0), 'negative factors are listed');
}
// Score always clamps to 1..5 and every factor is explained.
{
  const s = collateralScore({ a: { condition_uad: 'C6', quality_uad: 'Q6', flood_zone: 'VE', zoning_compliance: 'illegal' }, comps: [], summary: { fatal: 5 } });
  assert(s.score >= 1 && s.score <= 5, 'score clamps to 1..5');
  assert(s.factors.every((f) => f.label && f.detail), 'every factor has a label + plain detail');
}
// Missing signals → a neutral read (no crash, no fabricated precision).
{
  const s = collateralScore({ a: { condition_uad: null, quality_uad: null, as_is_confidence: null }, comps: [], summary: {} });
  assert(s && s.score === 3, 'no signals → neutral 3');
}
assert(collateralScore({ a: null }) === null, 'no appraisal → null');

// ---- arvDefensibility ----
// Uplift ~1x the budget → strong.
{
  const d = arvDefensibility({ arv: 575000, asIs: 430000, rehab: 120000 });
  assert(d && d.band === 'strong', `uplift 145k on 120k rehab is strong (got ${d && d.band})`);
}
// Uplift ~2x → moderate.
{
  const d = arvDefensibility({ arv: 575000, asIs: 430000, rehab: 75000 });
  assert(d && d.band === 'moderate', `uplift ~1.9x is moderate (got ${d && d.band})`);
}
// Uplift far exceeds the budget → thin (the inflated-ARV signal).
{
  const d = arvDefensibility({ arv: 700000, asIs: 400000, rehab: 50000 });
  assert(d && d.band === 'thin', `uplift 6x the rehab is thin (got ${d && d.band})`);
}
// No uplift (ARV <= As-Is) → no_uplift.
{
  const d = arvDefensibility({ arv: 400000, asIs: 420000, rehab: 50000 });
  assert(d && d.band === 'no_uplift', 'ARV below As-Is is no_uplift');
}
// Uplift but no budget on a reno deal → no_budget; on a non-reno deal → null (nothing to judge).
{
  assert(arvDefensibility({ arv: 500000, asIs: 400000, rehab: null, isReno: true }).band === 'no_budget', 'uplift + no budget on reno → no_budget');
  assert(arvDefensibility({ arv: 500000, asIs: 400000, rehab: null, isReno: false }) === null, 'uplift + no budget on non-reno → null');
}
// Missing ARV or As-Is → null (never guessed).
{
  assert(arvDefensibility({ arv: null, asIs: 400000, rehab: 50000 }) === null, 'no ARV → null');
  assert(arvDefensibility({ arv: 500000, asIs: null, rehab: 50000 }) === null, 'no As-Is → null');
}

// ---- compImpliedValue (independent comp-implied value) ----
{
  const comps = [{ adjusted_price: 300000, price_per_gla: 150 }, { adjusted_price: 310000, price_per_gla: 155 }, { adjusted_price: 320000, price_per_gla: 160 }];
  const iv = compImpliedValue({ comps, subjectGla: 2000 });
  assert(iv && iv.median === 310000, `median of adjusted comps is 310k (got ${iv && iv.median})`);
  assert(iv.low === 300000 && iv.high === 320000, 'low/high bracket the adjusted comps');
  assert(iv.perGlaValue === 310000, 'median $/GLA (155) × 2000 sqft = 310k');
  assert(iv.n === 3, 'counts 3 comps');
}
assert(compImpliedValue({ comps: [{ adjusted_price: 1 }, { adjusted_price: 2 }] }) === null, 'fewer than 3 adjusted comps → null (never guessed)');
assert(compImpliedValue({ comps: [{ is_subject: true, adjusted_price: 9 }, { adjustedPrice: 300000 }, { adjustedPrice: 310000 }, { adjustedPrice: 320000 }] }).n === 3, 'subject comp excluded; parsed-shape (adjustedPrice) accepted');
{
  const iv = compImpliedValue({ comps: [{ adjusted_price: 300000 }, { adjusted_price: 310000 }, { adjusted_price: 320000 }], subjectGla: null });
  assert(iv && iv.perGlaValue === null, 'no subject GLA → no $/GLA value (not guessed), median still returned');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL scoring assertions passed'}`);
process.exit(failures ? 1 : 0);
