#!/usr/bin/env node
'use strict';
/**
 * LT PPE six difference detectors (Part 3 P3) — pure offline test.
 * Proves the engine reports exactly where we are off vs Lender Price: base price, final price, coupons,
 * margin, LLPA stack (rules), and missing/extra disqualifications — the owner's list. Tolerances come
 * from settings; a difference within tolerance is not reported; both-decline agrees; a missing
 * disqualification carries LP's reasons so a rule can be suggested.
 *
 *   node scripts/test-lt-ppe-parity-detectors.js
 */
const { detectDifferences, _internals } = require('../src/longterm/ppe/parity-detectors');
const settings = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
const cats = (r) => r.differences.map((d) => d.category).sort();
const has = (r, c) => r.differences.some((d) => d.category === c);
const get = (r, c) => r.differences.find((d) => d.category === c);

console.log('LT PPE parity detectors — offline\n');

// A matching pair: base price 101500, LLPA cost 900, margin 250 → final 100350.
const ourRung = { rate: 7125, basePriceMilli: 101500, basePointsMilli: -1500, adjustmentCostMilli: 900, adjustmentPointsMilli: 900, marginMilli: 250, finalPriceMilli: 100350 };
const lpRung = { rate: 7125, priceMilli: 100350, baseRateMilli: 7125, basePointsMilli: -1500, adjustmentPointsMilli: 900, marginMilli: 250, llpas: [{ reason: 'CLTV/FICO', adjType: 'FicoLtvRateAdjustment', valueMilli: 900 }] };
const S = settings.resolveAll().values; // price tol 1, rate tol 0, margin tol 0, base tol 1

const mkOurs = (rung, extra) => ({ eligible: true, ladder: [rung], declines: [], ...(extra || {}) });
const mkLp = (rung) => ({ eligible: true, rungs: [rung] });

// 1) Identical → agree.
{
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: mkLp(lpRung) }, { settings: S });
  ok(r.verdict === 'agree' && r.differences.length === 0, 'identical quote and LP result → agree');
}

// 2) Margin off.
{
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: mkLp({ ...lpRung, marginMilli: 500 }) }, { settings: S });
  ok(has(r, 'margin') && get(r, 'margin').deltaMilli === -250 && get(r, 'margin').ourValue === 250 && get(r, 'margin').lpValue === 500, 'margin 250 vs 500 → margin difference with the delta');
}

// 3) Final price off.
{
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: mkLp({ ...lpRung, priceMilli: 100000 }) }, { settings: S });
  ok(has(r, 'final_price') && get(r, 'final_price').deltaMilli === 350, 'final price 100350 vs 100000 → final_price difference');
}

// 4) Base price off.
{
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: mkLp({ ...lpRung, basePointsMilli: -1000 }) }, { settings: S });
  ok(has(r, 'base_price') && get(r, 'base_price').lpValue === 101000 && get(r, 'base_price').deltaMilli === 500, 'base price 101500 vs 101000 → base_price difference');
}

// 5) LLPA stack total off — carries LP's itemized list.
{
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: mkLp({ ...lpRung, adjustmentPointsMilli: 1200 }) }, { settings: S });
  ok(has(r, 'llpa_total') && get(r, 'llpa_total').deltaMilli === -300, 'LLPA total 900 vs 1200 → llpa_total difference');
  ok(get(r, 'llpa_total').lpLlpas.length === 1 && get(r, 'llpa_total').lpLlpas[0].reason === 'CLTV/FICO', 'the LP itemized LLPAs are attached for review');
}

// 6) Coupon Lender Price offers that we do not price → HIGH (borrower loses an option).
{
  const ours = { eligible: true, ladder: [ourRung], declines: [] };
  const lp = { eligible: true, rungs: [lpRung, { rate: 7250, priceMilli: 101000, basePointsMilli: -1000, adjustmentPointsMilli: 500, marginMilli: 250, llpas: [] }] };
  const r = detectDifferences({ ours, lp }, { settings: S });
  ok(has(r, 'coupon_missing_ours') && get(r, 'coupon_missing_ours').severity === 'high' && get(r, 'coupon_missing_ours').rate === 7250, 'LP coupon 7.250 we do not price → coupon_missing_ours (high)');
}

// 7) Coupon we price that LP does not → LOW.
{
  const ours = { eligible: true, ladder: [ourRung, { rate: 7000, basePriceMilli: 102000, basePointsMilli: -2000, adjustmentCostMilli: 900, marginMilli: 250, finalPriceMilli: 100850 }], declines: [] };
  const r = detectDifferences({ ours, lp: mkLp(lpRung) }, { settings: S });
  ok(has(r, 'coupon_missing_lp') && get(r, 'coupon_missing_lp').severity === 'low' && get(r, 'coupon_missing_lp').rate === 7000, 'our coupon 7.000 LP does not offer → coupon_missing_lp (low)');
}

// 8) MISSING DISQUALIFICATION — we priced it, LP declined it. Carries LP's reasons for a suggestion.
{
  const lpDisqualified = { declined: [{ program: 'DSCR 30 Yr Fixed', reasons: [{ rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' }] }] };
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: { eligible: false, rungs: [] }, lpDisqualified }, { settings: S });
  ok(has(r, 'disqualification_missing') && get(r, 'disqualification_missing').severity === 'high', 'we priced a program LP declined → disqualification_missing (high)');
  ok(get(r, 'disqualification_missing').lpReasons[0].rule === 'FICO - below 660', 'LP reasons attached so a rule can be suggested');
  ok(r.differences.length === 1, 'an eligibility disagreement dominates — price axes are not also reported');
}

// 9) EXTRA DISQUALIFICATION — we declined, LP priced.
{
  const ours = { eligible: false, ladder: [], declines: [{ code: 'x', reason: 'our overlay' }] };
  const r = detectDifferences({ ours, lp: mkLp(lpRung) }, { settings: S });
  ok(has(r, 'disqualification_extra') && get(r, 'disqualification_extra').severity === 'high', 'we declined a program LP priced → disqualification_extra');
}

// 10) Both decline → agree on the outcome.
{
  const ours = { eligible: false, ladder: [], declines: [{ code: 'x', reason: 'no NY' }] };
  const r = detectDifferences({ ours, lp: { eligible: false, rungs: [] } }, { settings: S });
  ok(r.verdict === 'agree', 'both engines decline → agree');
}

// 11) Tolerances suppress a small difference.
{
  const r = detectDifferences({ ours: mkOurs(ourRung), lp: mkLp({ ...lpRung, marginMilli: 500 }) }, { settings: S, marginToleranceMilli: 300 });
  ok(!has(r, 'margin'), 'a 250 margin gap within a 300 tolerance is not reported');
}

// 12) LP applied a margin we do not carry at all.
{
  const ours = { eligible: true, ladder: [{ ...ourRung, marginMilli: null }], declines: [] };
  const r = detectDifferences({ ours, lp: mkLp(lpRung) }, { settings: S });
  ok(has(r, 'margin') && get(r, 'margin').ourValue === null && get(r, 'margin').lpValue === 250, 'LP margin present, ours absent → margin difference (never silently agreed)');
}

// 13) tolerancesOf reads settings, opts override.
{
  const t = _internals.tolerancesOf({ settings: S });
  ok(t.price === 0 && t.rate === 0 && t.margin === 0 && t.basePrice === 0, 'tolerancesOf reads the settings defaults (all exact, owner-directed 2026-08-17)');
  ok(_internals.tolerancesOf({ settings: S, priceToleranceMilli: 5 }).price === 5, 'an explicit opt overrides the settings tolerance');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
