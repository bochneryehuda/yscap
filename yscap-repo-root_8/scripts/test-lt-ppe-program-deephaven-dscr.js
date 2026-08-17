#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE PROGRAM "Deephaven DSCR": proves the three dots are connected (owner 2026-08-17) — the
 * investor name is in the program name, and one scenario resolves against BOTH eligibility layers (the
 * product matrix AND the PPP state matrix), each decline labelled with the layer it came from.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { PROGRAM, evaluateProgram, INVESTOR, PROGRAM_NAME } = require('../src/longterm/ppe/program-deephaven-dscr');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const ltv = (pct) => pct * 1000;

console.log('LT PPE — the Deephaven DSCR program (three dots connected)\n');

// ---- identity: the investor name is in the program name, all three layers present --------------
ok(INVESTOR === 'Deephaven' && PROGRAM_NAME === 'Deephaven DSCR' && PROGRAM.name.includes(INVESTOR), 'the investor name is saved in the program name');
ok(typeof PROGRAM.layers.rateSheet === 'function' && typeof PROGRAM.layers.eligibility === 'function' && typeof PROGRAM.layers.ppp.disqualifier === 'function', 'all three layers (rate sheet + eligibility + PPP) hang off the program');

// ---- a clean loan is eligible on every layer ---------------------------------------------------
const clean = evaluateProgram({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: ltv(70), purpose: 'purchase', state: 'NY', borrower_type: 'LLC', units: 1, prepay_months: 60 });
ok(clean.eligible && clean.reasons.length === 0, 'a clean NY LLC purchase (PPP requested, NY allows it) is eligible on all layers');

// ---- an eligibility-matrix decline is labelled to that layer -----------------------------------
const badLtv = evaluateProgram({ loan_amount: 2300000, fico: 700, dscr: 1250, ltv: ltv(75), purpose: 'purchase', state: 'NY', borrower_type: 'LLC', units: 1, prepay_months: 60 });
ok(!badLtv.eligible && badLtv.reasons.some((r) => r.layer === 'eligibility_matrix' && r.code === 'dhvn_grid_ltv'), 'LTV over the grid cap (tier3 700 P/RT = 70%, asked 75%) → an eligibility_matrix decline');

// ---- a PPP-state decline is labelled to the PPP layer (owner's NJ case, END TO END) ------------
const njInd = evaluateProgram({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: ltv(70), purpose: 'purchase', state: 'NJ', borrower_type: 'Individual', units: 1, prepay_months: 60 });
ok(!njInd.eligible && njInd.reasons.some((r) => r.layer === 'ppp_matrix' && /prohibited in NJ/.test(r.declineReason)), 'OWNER CASE end-to-end: NJ individual borrower + PPP → a ppp_matrix decline, even though the eligibility matrix passes it');
ok(njInd.reasons.every((r) => r.code !== 'dhvn_grid_ltv') && njInd.reasons.filter((r) => r.layer === 'eligibility_matrix').length === 0, '  …and the eligibility matrix raised NOTHING on that same loan (it is a PPP-only decline)');

// ---- the SAME NJ deal is eligible for an LLC, or with No-PPP -----------------------------------
ok(evaluateProgram({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: ltv(70), purpose: 'purchase', state: 'NJ', borrower_type: 'LLC', units: 1, prepay_months: 60 }).eligible, 'NJ LLC + PPP → eligible');
ok(evaluateProgram({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: ltv(70), purpose: 'purchase', state: 'NJ', borrower_type: 'Individual', units: 1, prepay_months: 0 }).eligible, 'NJ individual + No-PPP → eligible');

// ---- BOTH layers can decline the same loan (compound) ------------------------------------------
const both = evaluateProgram({ loan_amount: 150000, fico: 760, dscr: 900, ltv: ltv(70), purpose: 'purchase', state: 'NJ', borrower_type: 'Individual', units: 1, prepay_months: 60 });
ok(!both.eligible && both.reasons.some((r) => r.layer === 'eligibility_matrix') && both.reasons.some((r) => r.layer === 'ppp_matrix'), 'a $150k DSCR<1.00 NJ-individual PPP loan is declined by BOTH the matrix ($200k min) and the PPP layer');

// ---- the PPP result rides along for a restricted (not prohibited) state ------------------------
const md = evaluateProgram({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: ltv(70), purpose: 'purchase', state: 'MD', borrower_type: 'LLC', units: 1, prepay_months: 60 });
ok(md.eligible && md.ppp.result === 'restricted' && md.ppp.terms, 'MD (restricted PPP) stays eligible but the program reports the PPP cap terms');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
