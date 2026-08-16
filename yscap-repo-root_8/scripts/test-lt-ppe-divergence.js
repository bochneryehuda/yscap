'use strict';
/**
 * Pure offline test for the LT PPE divergence diagnoser (src/longterm/ppe/divergence.js).
 * Uses the REAL pricing.priceRung reconstruction record.  node scripts/test-lt-ppe-divergence.js
 */

const assert = require('assert');
const D = require('../src/longterm/ppe/divergence');
const pricing = require('../src/longterm/ppe/pricing');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

// A real priced rung: par base, two LLPAs (250 + 500 milli-pts of cost), 250 margin.
const rec = pricing.priceRung({
  rate: 7000,
  basePriceMilli: 100000,
  marginMilli: 250,
  adjustments: [
    { code: 'fico_720', category: 'credit', adjMilli: 250 },
    { code: 'ltv_75', category: 'ltv', adjMilli: 500 },
  ],
  roundingIncrementMilli: 1,
});

// helper: a parity-shaped price finding for a given gap (our - theirs)
const priceFinding = (gapMilli) => ({
  kind: 'price_mismatch', rate: 7000,
  ourPriceMilli: rec.finalPriceMilli,
  theirPriceMilli: rec.finalPriceMilli - gapMilli,
  deltaMilli: gapMilli,
});

// ---- a gap that exactly equals one LLPA -> STRONG, fingers that LLPA ----
{
  const dx = D.explainPriceDivergence(priceFinding(500), rec, { toleranceMilli: 1 });
  eq(dx.kind, 'price_mismatch', 'price: kind carried');
  eq(dx.gapMilli, 500, 'price: gap measured from deltaMilli');
  eq(dx.direction, 'ours_higher', 'price: positive gap -> ours higher');
  eq(dx.confidence, 'strong', 'price: a gap equal to one component is strong');
  eq(dx.topSuspect.component, 'adjustment', 'price: the suspect is an LLPA');
  ok(dx.topSuspect.label.includes('ltv_75'), 'price: it names the 500-milli LTV LLPA, not the 250 one');
  ok(dx.summary.includes('exactly equals'), 'price: summary states an exact match');
}

// ---- the margin exactly accounts for the gap ----
{
  const dx = D.explainPriceDivergence(priceFinding(250), rec, { toleranceMilli: 1 });
  // 250 matches BOTH the fico LLPA and the margin; either is a legitimate strong suspect,
  // but it must be a 250-milli component and strong.
  eq(dx.confidence, 'strong', 'margin/fico: exact 250 gap is strong');
  eq(dx.topSuspect.magnitudeMilli, 250, 'margin/fico: the suspect is a 250-milli component');
}

// ---- a gap close-but-not-equal -> POSSIBLE within tolerance ----
{
  const dx = D.explainPriceDivergence(priceFinding(252), rec, { toleranceMilli: 3 });
  eq(dx.confidence, 'possible', 'possible: within tolerance of the 250 component');
  eq(dx.topSuspect.magnitudeMilli, 250, 'possible: closest component is 250');
  ok(dx.summary.includes('likely place to look'), 'possible: summary hedges');
}

// ---- a gap matching nothing -> NONE, honest summary ----
{
  const dx = D.explainPriceDivergence(priceFinding(9999), rec, { toleranceMilli: 1 });
  eq(dx.confidence, 'none', 'none: no component near a 9999 gap');
  ok(dx.summary.includes('No single component'), 'none: summary says the gap is spread / base differs');
  ok(dx.direction === 'ours_higher', 'none: direction still reported');
}

// ---- ours LOWER (negative gap) ----
{
  const dx = D.explainPriceDivergence(priceFinding(-500), rec, { toleranceMilli: 1 });
  eq(dx.direction, 'ours_lower', 'negative gap -> ours lower');
  eq(dx.confidence, 'strong', 'magnitude match works on a negative gap too');
}

// ---- a clamp is itself a suspect ----
{
  const clampedRec = pricing.priceRung({
    rate: 7000, basePriceMilli: 100000, marginMilli: 0,
    adjustments: [{ code: 'big', category: 'x', adjMilli: 5000 }],
    floorMilli: 98000, // raw = 95.000 -> clamped up to 98.000 (a 3000-milli clamp)
    roundingIncrementMilli: 1,
  });
  ok(clampedRec.clamped, 'setup: the rung actually clamped');
  const dx = D.explainPriceDivergence(priceFinding(3000), clampedRec, { toleranceMilli: 1 });
  eq(dx.confidence, 'strong', 'clamp: a gap equal to the clamp delta is strong');
  eq(dx.topSuspect.component, 'clamp', 'clamp: the price floor/cap clamp is fingered');
}

// ---- no reconstruction available -> honest, never crashes ----
{
  const dx = D.explainPriceDivergence(priceFinding(500), null, {});
  eq(dx.buildUp, null, 'no-rec: no build-up');
  eq(dx.candidates.length, 0, 'no-rec: no candidates');
  eq(dx.confidence, 'none', 'no-rec: confidence none');
  ok(dx.summary.includes('reconstruction record is unavailable'), 'no-rec: summary says so');
}

// ---- buildUp reflects the real record ----
{
  const dx = D.explainPriceDivergence(priceFinding(500), rec, {});
  eq(dx.buildUp.basePriceMilli, 100000, 'buildUp: base');
  eq(dx.buildUp.adjustmentCostMilli, 750, 'buildUp: total LLPA cost 250+500');
  eq(dx.buildUp.marginMilli, 250, 'buildUp: margin');
  eq(dx.buildUp.finalPriceMilli, rec.finalPriceMilli, 'buildUp: final matches the record');
}

// ---- dispatch: the simple kinds ----
{
  eq(D.diagnose({ kind: 'rung_missing_ours', rate: 7250 }).kind, 'rung_missing_ours', 'dispatch: missing-ours');
  ok(D.diagnose({ kind: 'rung_missing_ours', rate: 7250 }).summary.includes('coverage gap'), 'dispatch: missing-ours framed as coverage gap');
  ok(D.diagnose({ kind: 'rung_missing_theirs', rate: 7250 }).summary.includes('eligibility'), 'dispatch: missing-theirs points at eligibility');
  ok(D.diagnose({ kind: 'eligibility_mismatch' }).summary.includes('rule trace'), 'dispatch: eligibility points at the rule trace');
  ok(D.diagnose({ kind: 'engine_error', side: 'ours', detail: 'boom' }).summary.includes('our bug'), 'dispatch: engine_error is our bug, not a disagreement');
  // dispatch routes a price_mismatch through the full diagnoser
  const px = D.diagnose(priceFinding(500), { reconstruction: rec });
  eq(px.confidence, 'strong', 'dispatch: price_mismatch gets the full diagnosis');
}

console.log(`ok - lt ppe divergence diagnoser (${n} assertions)`);
