#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the per-layer disqualifier reconciler (disqualify-reconcile.js). Proves it classifies our
 * three-layer eligibility verdict vs Lender Price's live verdict into agree / LP-bug (ticket) /
 * our-encoding-bug / legitimate-overlay — modelling how LP actually reports ineligibility (by absence;
 * product-variant level; often no reason string). LT-only, pure, offline.
 */
const { reconcileScenario, summarize } = require('../src/longterm/ppe/disqualify-reconcile');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — per-layer disqualifier reconciler\n');

// both price → agree
let r = reconcileScenario({ eligible: true, reasons: [] }, { priced: true, disqualifyReasons: [] });
ok(r.outcome === 'both_eligible' && r.classification === 'agree' && !r.ticketWorthy, 'both price → agree (both_eligible)');

// both decline, LP gives no reason (the common case: LP declines by absence) → agree on the verdict
r = reconcileScenario({ eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'dhvn_max_ltv_global', dimension: 'ltv', declineReason: 'Max LTV 80%' }] }, { priced: false, disqualifyReasons: [] });
ok(r.outcome === 'both_ineligible' && r.classification === 'agree' && /absence/.test(r.detail), 'both decline, LP by absence (no reason) → agree on the verdict');

// both decline AND LP's reason maps to the same dimension → agree, matched on dimension
r = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'dhvn_max_loan', dimension: 'loan_amount', declineReason: 'Maximum Loan Amount $2.5MM' }] },
  { priced: false, disqualifyReasons: [{ rule: 'Loan Amount - > 2,500,000', adjType: 'LoanAmountRateAdjustment' }] });
ok(r.outcome === 'both_ineligible' && r.classification === 'agree' && r.dimension === 'loan_amount', 'both decline + LP reason maps to same dimension (loan_amount) → agree, matched');

// LP declines on a HARD matrix dimension we say is eligible → probable LP bug (ticket)
r = reconcileScenario(
  { eligible: true, reasons: [] },
  { priced: false, disqualifyReasons: [{ rule: 'Minimum Loan Amount 100,000', adjType: 'LoanAmountRateAdjustment' }] });
ok(r.outcome === 'lp_declines_we_price' && r.classification === 'lp_bug' && r.ticketWorthy === true, 'LP declines on a mapped matrix dimension we price → LP bug (ticket) — owner\'s "open a ticket" case');

// LP declines for a reason we cannot map (a stricter LP overlay not on the matrix) → legitimate_overlay, no ticket (anti-cry-wolf)
r = reconcileScenario(
  { eligible: true, reasons: [] },
  { priced: false, disqualifyReasons: [{ rule: 'Full Doc Only', adjType: null }, { rule: 'Second Home Only', adjType: null }] });
ok(r.outcome === 'lp_declines_we_price' && r.classification === 'legitimate_overlay' && !r.ticketWorthy, 'LP declines for an unmappable overlay reason → legitimate_overlay, NOT a ticket (anti-cry-wolf)');

// WE decline (hard matrix rule) but LP prices → our_encoding_bug (we are too strict)
r = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'dhvn_min_loan_lt1', dimension: 'loan_amount', declineReason: 'Min Loan $200,000 (DSCR<1.00)' }] },
  { priced: true, disqualifyReasons: [] });
ok(r.outcome === 'lp_prices_we_decline' && r.classification === 'our_encoding_bug', 'we decline (hard rule) but LP prices → our_encoding_bug (review our rule vs the matrix)');

// WE decline on an OVERLAY dimension but LP prices → legitimate_overlay (we cannot verify the overlay)
r = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'dhvn_rural', dimension: 'rural', declineReason: 'Rural: DSCR must be > 1.00' }] },
  { priced: true, disqualifyReasons: [] });
ok(r.outcome === 'lp_prices_we_decline' && r.classification === 'legitimate_overlay', 'we decline on an overlay we cannot verify but LP prices → legitimate_overlay (not our bug)');

// a PPP-layer decline both ways matched on the prepay dimension
r = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'ppp_matrix', code: 'dhvn_ppp_prohibited_nj', dimension: 'prepay_state', declineReason: 'PPP prohibited in NJ' }] },
  { priced: false, disqualifyReasons: [{ rule: 'Prepayment Ineligible', adjType: null }] });
ok(r.outcome === 'both_ineligible' && r.classification === 'agree', 'PPP: both decline (LP "Prepayment Ineligible" unmapped) → agree on the verdict');

// summarize a batch
const batch = [
  reconcileScenario({ eligible: true, reasons: [] }, { priced: true, disqualifyReasons: [] }),
  reconcileScenario({ eligible: true, reasons: [] }, { priced: false, disqualifyReasons: [{ rule: 'Minimum Loan Amount 100,000', adjType: 'LoanAmountRateAdjustment' }] }),
  reconcileScenario({ eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'dhvn_max_loan', dimension: 'loan_amount', declineReason: 'x' }] }, { priced: false, disqualifyReasons: [] }),
];
const s = summarize(batch);
ok(s.total === 3 && s.agree === 2 && s.lp_bug === 1 && s.tickets.length === 1, 'summarize: tallies agree/lp_bug and collects the ticket');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
