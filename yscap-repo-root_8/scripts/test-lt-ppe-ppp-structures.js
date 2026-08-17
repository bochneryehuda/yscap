#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the prepayment-penalty STRUCTURE LIBRARY (ppp-structures.js). Proves the reusable catalog of
 * PPP structures (type × term) the owner named, the LP mapping (and the deliberate "not expressible in
 * LP" null-token cases), the custom softer overlay's +0.375 margin-holdback delta, and the
 * never-invent-a-vendor-token self-check. LT-only, pure, offline.
 */
const S = require('../src/longterm/ppe/ppp-structures');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — prepayment-penalty structure library\n');

// ── the library is complete + well-formed ─────────────────────────────────────────────────────────
ok(Array.isArray(S.PPP_STRUCTURES) && S.PPP_STRUCTURES.length >= 18, 'library carries every named structure');
for (const s of S.PPP_STRUCTURES) {
  const okShape = s.key && s.label && s.type && s.pricingModel && s.tierSet && s.lp && typeof s.overlayOnly === 'boolean'
    && (s.termYears === null || Number.isInteger(s.termYears))
    && Number.isInteger(s.marginHoldbackDeltaMilli);
  if (!okShape) ok(false, `structure ${s && s.key} is well-formed`);
}
ok(true, 'every structure is well-formed');

// keys are unique
const keys = S.PPP_STRUCTURES.map((s) => s.key);
ok(new Set(keys).size === keys.length, 'structure keys are unique');

// ── the owner's exact named structures are present ────────────────────────────────────────────────
for (const k of ['54321', '4321', '321', '21', 'fixed2_1yr', 'flat3', '5432', '543', 'dh_33', 'dh_3', 'fixed5', '33321', '3321', 'none',
  'int6_2', 'int6_3', 'int6_4', 'int6_5']) {
  ok(!!S.getStructure(k), `has structure ${k}`);
}
ok(S.getStructure('nope') === null, 'an unknown key returns null (never throws)');

// ── TYPE × TERM: the step schedule + type params are faithful ─────────────────────────────────────
ok(JSON.stringify(S.getStructure('54321').schedule) === JSON.stringify([5, 4, 3, 2, 1]) && S.getStructure('54321').termYears === 5,
  '54321 is a 5-year step-down [5,4,3,2,1]');
ok(S.getStructure('int6_3').type === 'interest_6mo' && S.getStructure('int6_3').typeParams.basisPct === 80 && S.getStructure('int6_3').typeParams.curtailmentPct === 20,
  '6-months-interest carries the 80% basis + 20% curtailment');
ok(S.getStructure('flat3').type === 'flat' && S.getStructure('flat3').typeParams.pct === 3 && S.getStructure('flat3').termYears === null,
  'flat 3% is a null-term (any-term) flat structure');
ok(S.getStructure('fixed5').pricingModel === 'fixed5_promo' && S.getStructure('fixed5').typeParams.pct === 5,
  '5% Fixed is the fixed5_promo pricing model');

// ── LP mapping: fixed-term uses its own term; any-term takes the passed term ──────────────────────
ok(JSON.stringify(S.lpMapping('54321')) === JSON.stringify({ prepayTermMonths: 60, planType: '54321', smoMonths: 60 }),
  'lpMapping 54321 → 60 months / 54321 token');
ok(JSON.stringify(S.lpMapping('flat3', 3)) === JSON.stringify({ prepayTermMonths: 36, planType: 'Fixed3', smoMonths: 36 }),
  'lpMapping flat3 @3yr → 36 months / Fixed3 (term supplied)');
ok(S.lpMapping('flat3') === null, 'lpMapping of an any-term structure with NO term → null (nothing to resolve months from)');
ok(JSON.stringify(S.lpMapping('none')) === JSON.stringify({ prepayTermMonths: 0, planType: null, smoMonths: 0 }),
  'lpMapping No-PPP → 0 months / null plan');
ok(S.lpMapping('does-not-exist') === null, 'lpMapping of an unknown key → null');

// ── the custom softer overlay: NOT expressible in LP, +0.375 delta, 5yr & 4yr only ────────────────
ok(S.getStructure('33321').overlayOnly === true && S.getStructure('3321').overlayOnly === true,
  'the two custom softer structures are overlay-only');
ok(S.lpMapping('33321').planType === null && S.lpMapping('3321').planType === null,
  'the custom softer structures carry a NULL LP plan token (never an invented token)');
ok(S.lpMapping('33321').prepayTermMonths === 60 && S.lpMapping('3321').prepayTermMonths === 48,
  'they still ride LP as their nearest priceable TERM (5yr=60mo, 4yr=48mo)');
ok(S.marginHoldbackDeltaOf('33321') === 375 && S.marginHoldbackDeltaOf('3321') === 375,
  'each adds a SEPARATE +0.375 (375 milli) margin holdback — owner: 0.25 base + 0.375 extra = 0.625 total');
ok(S.marginHoldbackDeltaOf('54321') === 0 && S.marginHoldbackDeltaOf('flat3') === 0,
  'a standard structure adds NO extra holdback');
// The custom overlay exists ONLY for 5yr and 4yr — no 3/2/1-year custom.
ok(S.PPP_STRUCTURES.filter((s) => s.tierSet === 'custom_softer').every((s) => s.termYears === 5 || s.termYears === 4),
  'the custom softer family is 5yr + 4yr ONLY (no 3/2/1-year custom)');

// ── filtering the library ─────────────────────────────────────────────────────────────────────────
const fiveYr = S.structuresFor({ termYears: 5 });
ok(fiveYr.some((s) => s.key === '54321') && fiveYr.some((s) => s.key === 'flat3') && !fiveYr.some((s) => s.key === '4321'),
  'structuresFor termYears:5 → 5yr structures + any-term ones, not a 4yr one');
const lpOnly = S.structuresFor({ includeOverlay: false });
ok(!lpOnly.some((s) => s.overlayOnly), 'structuresFor includeOverlay:false drops the overlay-only structures');
ok(S.structuresFor({ pricingModel: 'fixed5_promo' }).every((s) => s.pricingModel === 'fixed5_promo'),
  'structuresFor pricingModel filters to the promo model');
ok(S.structuresFor({ tierSet: 'custom_softer' }).length === 2, 'structuresFor tierSet:custom_softer → the two overlays');

// ── the never-invent-a-vendor-token self-check ───────────────────────────────────────────────────
ok(Array.isArray(S.verifyLpTokens()) && S.verifyLpTokens().length === 0,
  'verifyLpTokens: every NON-null LP plan token is a real field-registry token (no invented tokens)');

// ── SOURCED cross-check: the library faithfully implements the AUTHORITATIVE Deephaven PPP matrix
//    PDF's documented STANDARD structures (transcribed in the canonical matrices/deephaven-ppp-matrix
//    .json). The PDF's yearly step-down: 5yr 5/4/3/2/1; 4yr 5/4/3/2; 3yr 5/4/3; 2yr 3/3; 1yr 3. Each
//    must be a real structure in the library — so the library and the authoritative source can't drift.
{
  const path = require('path');
  const J = require(path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'matrices', 'deephaven-ppp-matrix.json'));
  const stepDown = (J.standardStructures || {}).yearlyStepDown || {};
  // a step_down structure's schedule IS its per-year %; a `flat` structure of pct p over N years is the
  // constant schedule [p × N] (the PDF's 2yr "3/3" and 1yr "3" are stored as flat 3% — no LP 3/3 token).
  const effSchedule = (s) => s.type === 'step_down' ? s.schedule
    : (s.type === 'flat' && s.typeParams && s.termYears ? Array(s.termYears).fill(s.typeParams.pct) : null);
  let stepMiss = 0;
  for (const [yr, str] of Object.entries(stepDown)) {
    const term = Number(String(yr).replace(/yr$/i, ''));
    const want = String(str).split('/').map(Number);
    const found = S.PPP_STRUCTURES.some((s) => s.termYears === term && JSON.stringify(effSchedule(s)) === JSON.stringify(want));
    if (!found) { stepMiss += 1; console.log(`    (no library structure for PDF step-down ${yr} = ${str})`); }
  }
  ok(Object.keys(stepDown).length === 5 && stepMiss === 0,
    `every PDF yearly step-down tier (5/4/3/2/1, 5/4/3/2, 5/4/3, 3/3, 3) is a real library structure (${5 - stepMiss}/5)`);
  // the 5% flat promo the PDF names as the wholesale flat option exists as the fixed5_promo model.
  ok(S.getStructure('fixed5') && S.getStructure('fixed5').typeParams.pct === 5 && S.getStructure('fixed5').pricingModel === 'fixed5_promo',
    'the PDF wholesale "5% flat" is the fixed5_promo structure');
  // the authoritative channel restriction is transcribed (not enforced yet — pricing per channel is a
  // live-measured question), so the knowledge is captured and cannot silently vanish.
  ok(/wholesale/i.test((J.standardStructures || {}).wholesaleNote || '') && /5% flat/i.test(J.standardStructures.wholesaleNote),
    'the PDF wholesale/correspondent channel restriction (5% flat + step-down) is recorded in the canonical matrix');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
