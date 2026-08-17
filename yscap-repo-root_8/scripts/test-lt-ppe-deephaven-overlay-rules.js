#!/usr/bin/env node
'use strict';
/**
 * LT PPE — DEEPHAVEN DSCR ADVANCED-OVERLAY ENFORCEMENT (owner D36, the D29 enforcement step).
 * Proves each UNAMBIGUOUS overlay cut fires as a VALID stamped overlay decline, that an absent fact never
 * declines, that an ordinary scenario (no Advanced facts) fires nothing, that the ambiguous cuts stay
 * FLAGGED (never guessed), that the E3 classifier scores an overlay-only divergence as OVERLAY not
 * DEFECT, and that the program composition surfaces overlay declines on the `overlay` layer while an
 * ordinary scenario stays byte-identical.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { evaluateOverlayDeclines, _cuts } = require('../src/longterm/ppe/deephaven-overlay-rules');
const overlay = require('../src/longterm/ppe/overlay');
const { evaluateProgram } = require('../src/longterm/ppe/program-deephaven-dscr');
const { lpScenarioToFacts } = require('../src/longterm/ppe/lp-agreement-legs');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const ltv = (pct) => pct * 1000;        // 75% → 75000 milli (matches lpScenarioToFacts + the grid)
// engine facts with every overlay fact OFF by default, then whatever the test overrides.
const base = (o) => ({ fico: 760, ltv: ltv(70), dscr: 1250, loan_amount: 400000, units: 1, purpose: 'purchase', state: 'NY', borrower_type: 'LLC', ...o });
const codes = (r) => r.declines.map((d) => d.code).sort();
const hasCode = (r, c) => r.declines.some((d) => d.code === c);

console.log('LT PPE — Deephaven DSCR Advanced-overlay enforcement (D36)\n');

// ---- 0. every emitted decline is a VALID overlay decline (the E3 classifier scores it OVERLAY) ------
{
  const r = evaluateOverlayDeclines(base({ short_term_rental: true, dscr: 1000, fico: 680, ltv: ltv(80), units: 2, first_time_investor: true, rural_property: true }));
  ok(r.declines.length > 0 && r.declines.every((d) => overlay.isValidOverlayDecline(d)), 'every emitted decline is a VALID overlay decline (overlay flag + real overlay fact + stated reason)');
  ok(r.declines.every((d) => typeof d.reason === 'string' && d.reason.trim().length > 0 && d.citation), 'every decline carries a non-empty reason + a citation');
}

// ---- 1. Short-Term Rental — every unambiguous cut fires, independently -------------------------------
ok(hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, dscr: _cuts.STR_MIN_DSCR - 1 })), 'overlay_str_min_dscr'), 'STR DSCR just below 1.15 → overlay_str_min_dscr');
ok(!hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, dscr: _cuts.STR_MIN_DSCR })), 'overlay_str_min_dscr'), 'STR DSCR exactly 1.15 → no DSCR decline (Min is inclusive)');
ok(hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, fico: 719 })), 'overlay_str_min_fico'), 'STR FICO 719 → overlay_str_min_fico');
ok(!hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, fico: 720 })), 'overlay_str_min_fico'), 'STR FICO 720 → no FICO decline (Min is inclusive)');
ok(hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, ltv: ltv(75) + 1 })), 'overlay_str_max_ltv'), 'STR LTV just over 75% → overlay_str_max_ltv');
ok(!hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, ltv: ltv(75) })), 'overlay_str_max_ltv'), 'STR LTV exactly 75% → no LTV decline (Max is inclusive)');
ok(hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, units: 2 })), 'overlay_str_units'), 'STR on a 2-unit → overlay_str_units');
ok(!hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, units: 1 })), 'overlay_str_units'), 'STR on a 1-unit → no units decline');
ok(hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, first_time_investor: true })), 'overlay_str_no_fti'), 'STR + first-time investor → overlay_str_no_fti');
ok(hasCode(evaluateOverlayDeclines(base({ short_term_rental: true, rural_property: true })), 'overlay_str_no_rural'), 'STR + rural → overlay_str_no_rural');
// a CLEAN STR loan (all cuts satisfied) fires nothing from the STR block
ok(evaluateOverlayDeclines(base({ short_term_rental: true, dscr: 1200, fico: 740, ltv: ltv(70), units: 1 })).declines.length === 0, 'a clean STR loan (DSCR 1.20, FICO 740, LTV 70, 1 unit) → no overlay declines');

// ---- 2. First-Time Investor — DSCR/FICO cuts fire; the STR<->FTI rule is not double-counted ---------
ok(hasCode(evaluateOverlayDeclines(base({ first_time_investor: true, dscr: 999 })), 'overlay_fti_min_dscr'), 'FTI DSCR below 1.00 → overlay_fti_min_dscr');
ok(hasCode(evaluateOverlayDeclines(base({ first_time_investor: true, fico: 699 })), 'overlay_fti_min_fico'), 'FTI FICO 699 → overlay_fti_min_fico');
ok(evaluateOverlayDeclines(base({ first_time_investor: true, dscr: 1000, fico: 700 })).declines.length === 0, 'a clean FTI loan (DSCR 1.00, FICO 700) → no overlay declines');
{
  // FTI + STR: the incompatibility is enforced ONCE (by the STR block), not twice.
  const r = evaluateOverlayDeclines(base({ first_time_investor: true, short_term_rental: true, dscr: 1200, fico: 740 }));
  ok(codes(r).filter((c) => c === 'overlay_str_no_fti').length === 1 && !hasCode(r, 'overlay_fti_min_dscr'), 'FTI + STR (both otherwise clean) → the STR<->FTI incompatibility fires exactly once');
}

// ---- 3. Rural — the Max 65% LTV cut fires; DSCR>1.0 / acreage stay FLAGGED --------------------------
ok(hasCode(evaluateOverlayDeclines(base({ rural_property: true, ltv: ltv(65) + 1 })), 'overlay_rural_max_ltv'), 'Rural LTV just over 65% → overlay_rural_max_ltv');
ok(!hasCode(evaluateOverlayDeclines(base({ rural_property: true, ltv: ltv(65) })), 'overlay_rural_max_ltv'), 'Rural LTV exactly 65% → no LTV decline');
ok(evaluateOverlayDeclines(base({ rural_property: true, ltv: ltv(65), dscr: 950 })).stillFlagged.some((s) => /DSCR > 1.0x/.test(s.overlay)), 'Rural DSCR>1.0 + acreage stay FLAGGED (never guessed) even at DSCR 0.95');

// ---- 4. Declining market — the RELATIVE -5-point cut reads the grid cap ----------------------------
ok(hasCode(evaluateOverlayDeclines(base({ declining_market: true, ltv: ltv(76) }), { gridMaxLtvMilli: ltv(80) }), 'overlay_declining_ltv'), 'declining market, grid cap 80%, asked 76% → decline (80-5=75)');
ok(!hasCode(evaluateOverlayDeclines(base({ declining_market: true, ltv: ltv(75) }), { gridMaxLtvMilli: ltv(80) }), 'overlay_declining_ltv'), 'declining market, grid cap 80%, asked 75% → no decline (exactly at the reduced cap)');
ok(evaluateOverlayDeclines(base({ declining_market: true, ltv: ltv(76) })).stillFlagged.some((s) => /Declining market: Max LTV -5%/.test(s.overlay)), 'declining market with NO grid cap supplied → the cut is FLAGGED, not enforced (fail-safe)');
ok(evaluateOverlayDeclines(base({ declining_market: true, ltv: ltv(76) })).declines.length === 0, 'declining market with no grid cap → no decline (never invents a cap)');

// ---- 5. Foreign National — max loan + DSCR fire; the LTV caps 70/60 stay FLAGGED --------------------
ok(hasCode(evaluateOverlayDeclines(base({ foreign_national: true, loan_amount: _cuts.FN_MAX_LOAN + 1 })), 'overlay_fn_max_loan'), 'FN loan over $1.5M → overlay_fn_max_loan');
ok(!hasCode(evaluateOverlayDeclines(base({ foreign_national: true, loan_amount: _cuts.FN_MAX_LOAN })), 'overlay_fn_max_loan'), 'FN loan exactly $1.5M → no loan decline');
ok(hasCode(evaluateOverlayDeclines(base({ foreign_national: true, dscr: 999 })), 'overlay_fn_min_dscr'), 'FN DSCR below 1.00 → overlay_fn_min_dscr');
ok(evaluateOverlayDeclines(base({ foreign_national: true })).stillFlagged.some((s) => /LTV caps 70\/60/.test(s.overlay)), 'FN LTV caps 70/60 stay FLAGGED (which cap applies is not stated)');

// ---- 6. Fail-safe: an ABSENT numeric fact never declines -------------------------------------------
ok(evaluateOverlayDeclines({ short_term_rental: true }).declines.length === 0, 'STR with NO fico/ltv/dscr/units at all → no declines (never disqualify on data we do not have)');
ok(evaluateOverlayDeclines({ foreign_national: true }).declines.length === 0, 'FN with no loan/dscr → no declines');

// ---- 7. An ordinary scenario (every overlay fact OFF) fires NOTHING --------------------------------
{
  const ordinary = evaluateOverlayDeclines(base({}));
  ok(ordinary.declines.length === 0 && ordinary.enforced.length === 0 && ordinary.stillFlagged.length === 0, 'an ordinary scenario (no Advanced facts) → nothing enforced, nothing flagged, nothing declined');
  // ...and the same through lpScenarioToFacts (which defaults every overlay fact off)
  const viaLp = evaluateOverlayDeclines(lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, purpose: 'Purchase', state: 'NY' }));
  ok(viaLp.declines.length === 0, 'an ordinary LP scenario through lpScenarioToFacts → no overlay declines (facts default off)');
}

// ---- 8. The ambiguous / uncarried-fact overlays are FLAGGED, never enforced ------------------------
ok(evaluateOverlayDeclines(base({ occupancy: 'vacant' })).stillFlagged.some((s) => /D27/.test(s.needs)) && evaluateOverlayDeclines(base({ occupancy: 'vacant' })).declines.length === 0, 'occupancy vacant (D27) → flagged, never a decline');
ok(evaluateOverlayDeclines(base({ first_time_homebuyer: true })).stillFlagged.some((s) => /borrower-count/.test(s.needs)) && evaluateOverlayDeclines(base({ first_time_homebuyer: true })).declines.length === 0, 'first-time homebuyer → flagged (needs a borrower-count fact), never a decline');
ok(evaluateOverlayDeclines(base({ renovation: true })).stillFlagged.some((s) => /seasoning/.test(s.needs)) && evaluateOverlayDeclines(base({ renovation: true })).declines.length === 0, 'renovation → flagged (needs a seasoning fact), never a decline');

// ---- 9. The E3 classifier scores an overlay-only divergence as OVERLAY, not DEFECT -----------------
{
  // ours declines on STR (LP prices it — LP cannot see the STR flag). ourDeclines are the module's stamps.
  const r = evaluateOverlayDeclines(base({ short_term_rental: true, ltv: ltv(80) }));
  const cls = overlay.classifyEligibilityDivergence({ oursEligible: false, theirsEligible: true, ourDeclines: r.declines });
  ok(cls.classification === overlay.CLASS.OVERLAY && cls.overlayReasons.length === r.declines.length, 'our-ineligible / LP-eligible on STR overlay declines → classified OVERLAY (not a parity defect)');
}

// ---- 10. PROGRAM composition: overlay declines land on the `overlay` layer, matrix raises nothing ---
{
  // an STR loan that PASSES the eligibility matrix (fico 760, ltv 70, dscr 1.25) but violates STR (LTV 78)
  const sc = { loan_amount: 400000, fico: 760, dscr: 1250, ltv: ltv(78), purpose: 'purchase', state: 'NY', borrower_type: 'LLC', units: 1, prepay_months: 60, short_term_rental: true };
  const p = evaluateProgram(sc);
  ok(!p.eligible && p.reasons.some((r) => r.layer === 'overlay' && r.code === 'overlay_str_max_ltv'), 'PROGRAM: an STR loan over 75% LTV → ineligible with an `overlay`-layer decline');
  ok(p.reasons.filter((r) => r.layer === 'eligibility_matrix').length === 0, '  …and the eligibility matrix raised NOTHING on that same loan (LTV 78 is within its own grid cap)');
  ok(p.overlay && p.overlay.declines.length >= 1 && p.overlay.enforced.some((e) => e.overlay === 'short_term_rental'), '  …and the program surfaces the overlay enforcement detail');
}

// ---- 11. PROGRAM: an ordinary scenario stays eligible (byte-identical to before) -------------------
{
  const clean = evaluateProgram(lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, purpose: 'Purchase', state: 'NY', borrowerType: 'LLC', prepayMonths: 60 }));
  ok(clean.eligible && clean.reasons.length === 0 && clean.overlay.declines.length === 0, 'PROGRAM: an ordinary NY LLC purchase (no Advanced facts) is eligible, no overlay declines');
}

// ---- 12. PROGRAM: declining market reads the grid cap for THIS cell --------------------------------
{
  // tier1 fico 700 P/RT DSCR>=1 grid cap = 80%. Declining market cuts it to 75%. Ask 78% → decline.
  const p = evaluateProgram({ loan_amount: 400000, fico: 700, dscr: 1250, ltv: ltv(78), purpose: 'purchase', state: 'NY', borrower_type: 'LLC', units: 1, prepay_months: 60, declining_market: true });
  ok(!p.eligible && p.reasons.some((r) => r.layer === 'overlay' && r.code === 'overlay_declining_ltv'), 'PROGRAM: declining market cuts the grid cap 80%→75%; asked 78% → overlay decline');
  const okDeal = evaluateProgram({ loan_amount: 400000, fico: 700, dscr: 1250, ltv: ltv(75), purpose: 'purchase', state: 'NY', borrower_type: 'LLC', units: 1, prepay_months: 60, declining_market: true });
  ok(okDeal.eligible, 'PROGRAM: the same declining-market deal at 75% (the reduced cap) → eligible');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
