'use strict';
/**
 * Unit tests for the experience / track-record underwriting (experience.js). Pure — no AI, no DB.
 * The owner's rule: a HEAVY-rehab or GROUND-UP deal needs at least one VERIFIED comparable "anchor"
 * project (one tier below the demand counts, ~half the size or bigger, exited within 3 years); a
 * light/moderate deal requires no anchor. A missing/unverified anchor is a CTC-blocking dealbreaker.
 */
const assert = require('assert');
const { assessExperience, _internals } = require('../src/lib/underwriting/experience');

const TODAY = '2026-07-20';
const heavyDeal = { purchasePrice: 300000, asIsValue: 300000, rehabBudget: 200000, loanType: 'Purchase' }; // rehab/asis .67 → heavy
const anchor = { deal_type: 'flip', purchase_price: 280000, rehab_amount: 60000, sale_date: '2025-06-01', is_verified: true }; // moderate, exited 1yr
const codes = (r) => r.findings.map((f) => f.code);

// ---- A heavy deal with NO history → insufficient (blocks CTC) ----
{
  const r = assessExperience(heavyDeal, [], { today: TODAY });
  assert.deepStrictEqual(codes(r), ['experience_insufficient']);
  assert.strictEqual(r.findings[0].severity, 'fatal');
  assert.strictEqual(r.findings[0].blocksCtc, true, 'experience gap blocks clear-to-close');
  assert.strictEqual(r.gated, true, 'a heavy deal is gated');
  assert.strictEqual(r.demandLabel, 'heavy rehab');
}

// ---- A VERIFIED comparable anchor (moderate tier, big enough, recent exit) → clears ----
{
  const r = assessExperience(heavyDeal, [anchor], { today: TODAY });
  assert.deepStrictEqual(codes(r), [], 'a verified adjacent-tier anchor clears the requirement');
  assert.strictEqual(r.hasVerifiedAnchor, true);
  assert.strictEqual(r.anchors.length, 1);
}

// ---- The comparable anchor exists but is UNVERIFIED → blocks with the "verify it" dealbreaker ----
{
  const r = assessExperience(heavyDeal, [{ ...anchor, is_verified: false }], { today: TODAY });
  assert.deepStrictEqual(codes(r), ['experience_anchor_unverified']);
  assert.strictEqual(r.findings[0].blocksCtc, true);
  assert.strictEqual(r.hasVerifiedAnchor, false);
}

// ---- Anchor too OLD (exit >3 years) / too SMALL (<half size) → not comparable → insufficient ----
{
  assert.deepStrictEqual(codes(assessExperience(heavyDeal, [{ ...anchor, sale_date: '2020-01-01' }], { today: TODAY })),
    ['experience_insufficient'], 'a 6-year-old exit is outside the 3-year window');
  assert.deepStrictEqual(codes(assessExperience(heavyDeal, [{ ...anchor, purchase_price: 20000, rehab_amount: 5000 }], { today: TODAY })),
    ['experience_insufficient'], 'a project a fraction of the size is not "in the same range"');
}

// ---- A LIGHT deal requires no anchor → clean even with no history ----
{
  const light = { purchasePrice: 300000, asIsValue: 300000, rehabBudget: 10000, loanType: 'Purchase' };
  const r = assessExperience(light, [], { today: TODAY });
  assert.deepStrictEqual(codes(r), [], 'a light-rehab first-timer is not gated');
  assert.strictEqual(r.gated, false);
}

// ---- GROUND-UP: needs a HEAVY (tier 3) anchor; a moderate one is not enough ----
{
  const gu = { purchasePrice: 400000, asIsValue: 400000, rehabBudget: 0, loanType: 'Ground up' };
  assert.strictEqual(assessExperience(gu, [], { today: TODAY }).demandLabel, 'ground-up construction');
  // A verified HEAVY flip anchors ground-up.
  assert.deepStrictEqual(codes(assessExperience(gu, [{ deal_type: 'flip', purchase_price: 350000, rehab_amount: 200000, sale_date: '2024-09-01', is_verified: true }], { today: TODAY })), []);
  // A verified MODERATE flip does NOT (tier 2 < required 3).
  assert.deepStrictEqual(codes(assessExperience(gu, [{ deal_type: 'flip', purchase_price: 350000, rehab_amount: 60000, sale_date: '2024-09-01', is_verified: true }], { today: TODAY })), ['experience_insufficient']);
}

// ---- A HOLD anchor exits on the LEASE/REFI date, not a sale ----
{
  const holdAnchor = { deal_type: 'fix-and-hold', purchase_price: 280000, rehab_amount: 60000, rent_date: '2025-03-01', is_verified: true };
  assert.deepStrictEqual(codes(assessExperience(heavyDeal, [holdAnchor], { today: TODAY })), [], 'a leased hold within 3 years anchors');
  assert.strictEqual(_internals.exitDateOf(holdAnchor), '2025-03-01');
  assert.strictEqual(_internals.exitDateOf({ deal_type: 'flip', sale_date: '2025-01-01' }), '2025-01-01');
}

// ---- (audit MAJOR-1) a big-dollar rehab that's a SMALL share of a high value is NOT heavy ----
{
  // $160k rehab on a $2M multifamily = 8% → light intensity → NOT gated (was wrongly hard-blocked).
  const big = assessExperience({ purchasePrice: 2000000, asIsValue: 2000000, rehabBudget: 160000, loanType: 'Purchase', propertyType: 'Multi 5+' }, [], { today: TODAY });
  assert.strictEqual(big.gated, false, 'a low-ratio rehab on a high-value asset is not gated');
  assert.deepStrictEqual(codes(big), []);
  // But the SAME $160k on a $250k house (64%) is a genuine gut job → heavy → gated.
  assert.strictEqual(assessExperience({ purchasePrice: 250000, asIsValue: 250000, rehabBudget: 160000, loanType: 'Purchase' }, [], { today: TODAY }).gated, true);
  assert.strictEqual(_internals.tierOf(150000, 400000, false), 3, '$150k on $400k (37%) is heavy');
  assert.strictEqual(_internals.tierOf(160000, 2000000, false), 1, '$160k on $2M (8%) is light');
}
// ---- (audit MAJOR-2b) a mislabeled row still counts its real exit date (no false "never exited") ----
{
  assert.strictEqual(_internals.exitDateOf({ deal_type: 'rental', sale_date: '2025-01-01' }), '2025-01-01', 'a sold "rental" falls back to its sale date');
  assert.strictEqual(_internals.exitDateOf({ deal_type: 'flip', refi_date: '2025-02-01' }), '2025-02-01', 'a "flip" recorded with a refi still exits');
  const anchor2 = { deal_type: 'rental', purchase_price: 280000, rehab_amount: 60000, sale_date: '2025-05-01', is_verified: true };
  assert.deepStrictEqual(codes(assessExperience(heavyDeal, [anchor2], { today: TODAY })), [], 'a verified comparable mislabeled deal still anchors');
}

// ---- tier classification + calendar months ----
{
  assert.strictEqual(_internals.tierOf(200000, 300000, false), 3, 'ratio .67 is heavy');
  assert.strictEqual(_internals.tierOf(60000, 300000, false), 2, 'ratio .2 is moderate');
  assert.strictEqual(_internals.tierOf(5000, 300000, false), 1, 'ratio .017 is light');
  assert.strictEqual(_internals.tierOf(0, 300000, true), 4, 'ground-up flag wins');
  assert.strictEqual(_internals.monthsBetween('2025-07-20', '2026-07-20'), 12);
  assert.strictEqual(_internals.monthsBetween('2025-07-21', '2026-07-20'), 11, 'day-of-month not yet reached → one fewer month');
}

console.log('test-underwriting-experience: demand tier, anchor comparability, verification gate, exit window pass');
