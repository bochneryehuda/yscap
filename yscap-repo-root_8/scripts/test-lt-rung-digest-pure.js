#!/usr/bin/env node
'use strict';
/**
 * LT PPE #49 part 3 — the RUNG-DIGEST AUDIT (rung-digest.js). PURE, offline, no DB, no network, no
 * RTL imports. Builds OUR side with the REAL quote.quoteProgram (not a fixture that agrees with
 * itself) and an LP-normalized side by hand.
 *
 * Proves the digest lines up base / per-dimension adjustments / total / margin / final for each coupon
 * so a human can eyeball where two sides diverge, matches rungs by coupon, and surfaces coupons on one
 * side only.
 *
 * PROVEN TO FAIL (mutation): nudging ONE LP rung price by 125 milli makes exactly that rung's
 * final.deltaMilli and the digest's worstDeltaMilli non-zero; nudging ONE LP LLPA makes exactly that
 * dimension's adjustment row non-zero. The CONTROL (aligned engines) is all-zero on either side.
 */
const { quoteProgram } = require('../src/longterm/ppe/quote');
const { buildRungDigest } = require('../src/longterm/ppe/rung-digest');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const program = {
  code: 'TEST',
  baseGrid: [{ rate: 7000, lockDays: 30, basePriceMilli: 101000 }, { rate: 7250, lockDays: 30, basePriceMilli: 102000 }],
  rules: [
    { code: 'llpa_fico', kind: 'pricing', when: { fact: 'fico', op: 'between', value: [740, 760] }, adjustment: { dimension: 'fico', adjMilli: 250, unit: 'points', reason: 'FICO 740-759' } },
    { code: 'llpa_ltv', kind: 'pricing', when: { fact: 'ltv', op: 'gte', value: 75000 }, adjustment: { dimension: 'ltv', adjMilli: 500, unit: 'points', reason: 'LTV>=75' } },
  ],
};
const settings = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none' };
const scenario = { fico: 740, ltv: 75000, loan_amount: 500000, lock_days: 30 };

const ours = quoteProgram({ scenario, program, settings });
// SANITY on our own side: 7000 rung → 101000 − 750(adj) − 250(margin) = 100000; 7250 → 101000.
// (base points = par − base price → 7000: -1000, 7250: -2000)

// An LP side built to AGREE exactly — same units (points / price milli).
function lpAligned() {
  const llpas = [{ reason: 'FICO', adjType: 'FicoRateAdjustment', valueMilli: 250 }, { reason: 'LTV', adjType: 'LtvRateAdjustment', valueMilli: 500 }];
  return { eligible: true, rungs: [
    { rate: 7000, basePointsMilli: -1000, adjustmentPointsMilli: 750, marginMilli: 250, priceMilli: 100000, llpas },
    { rate: 7250, basePointsMilli: -2000, adjustmentPointsMilli: 750, marginMilli: 250, priceMilli: 101000, llpas },
  ] };
}

console.log('#49.3 rung-digest audit — base + per-adjustment digest for eyeballing divergence');

// ---- CONTROL: aligned engines ⇒ every delta zero ----
const d = buildRungDigest(ours, lpAligned());
ok(d.rungs.length === 2 && d.rungs.every((r) => r.matched), 'DIG-1 both coupons matched by rate');
ok(d.worstDeltaMilli === 0, 'DIG-2 aligned engines ⇒ worst delta is zero');
ok(d.rungs.every((r) => r.base.deltaMilli === 0 && r.final.deltaMilli === 0), 'DIG-3 base + final agree on every rung');
const r0 = d.rungs[0];
ok(r0.base.oursPointsMilli === -1000 && r0.base.theirsPointsMilli === -1000, 'DIG-4 base points line up (par − price on our side)');
ok(r0.final.oursPriceMilli === 100000 && r0.final.theirsPriceMilli === 100000, 'DIG-5 final price lines up');
const dims = r0.adjustments.map((a) => a.dimension).sort();
ok(dims.join(',') === 'fico,ltv', 'DIG-6 adjustments broken out per dimension (fico, ltv) via the shared classifier');
ok(r0.adjustments.every((a) => a.deltaMilli === 0 && a.oursMilli === a.theirsMilli), 'DIG-7 every per-dimension LLPA agrees');
ok(r0.margin.oursMilli === 250 && r0.margin.deltaMilli === 0, 'DIG-8 margin lined up');
ok(typeof d.toText === 'function' && /coupon 7000/.test(d.toText()) && /fico/.test(d.toText()), 'DIG-9 toText renders a human-scannable table');
ok(d.missingOurs.length === 0 && d.missingTheirs.length === 0, 'DIG-10 no unmatched coupons');

// ---- MUTATION A: one LP rung price off by 125 ⇒ exactly that rung diverges ----
const lpA = lpAligned(); lpA.rungs[0].priceMilli = 100125;
const dA = buildRungDigest(ours, lpA);
ok(dA.rungs[0].final.deltaMilli === -125, 'MUTA-1 the mutated rung final.deltaMilli = ours − theirs = −125');
ok(dA.worstDeltaMilli === -125, 'MUTA-2 worstDeltaMilli reflects the divergence');
ok(dA.rungs[1].final.deltaMilli === 0, 'MUTA-3 the OTHER rung is untouched (localized)');
ok(d.worstDeltaMilli === 0, 'MUTA-4 CONTROL — the aligned digest is still all-zero (green on either side)');

// ---- MUTATION B: one LP LLPA off ⇒ exactly that dimension row diverges ----
const lpB = lpAligned(); lpB.rungs[0].llpas[0].valueMilli = 375; // fico 250 → 375
const dB = buildRungDigest(ours, lpB);
const ficoRow = dB.rungs[0].adjustments.find((a) => a.dimension === 'fico');
const ltvRow = dB.rungs[0].adjustments.find((a) => a.dimension === 'ltv');
ok(ficoRow.oursMilli === 250 && ficoRow.theirsMilli === 375 && ficoRow.deltaMilli === -125, 'MUTB-1 the fico adjustment row shows the −125 divergence (eyeball the exact dimension)');
ok(ltvRow.deltaMilli === 0, 'MUTB-2 the ltv row is unaffected');

// ---- unmatched coupon surfaced, never dropped ----
const lpOne = { eligible: true, rungs: [lpAligned().rungs[0]] };
const dC = buildRungDigest(ours, lpOne);
ok(dC.missingTheirs.includes(7250) && dC.rungs.find((r) => r.rate === 7250).matched === false, 'MISS-1 our coupon 7250 that LP did not return is surfaced');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
