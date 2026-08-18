'use strict';
/**
 * LT PPE — THE INFORMATIONAL PRODUCT LAYER (owner-directed 2026-08-17): "when somebody chooses a
 * product, it should know his reserve requirements. If it needs a second appraisal, it should mention
 * on the product that this project needs a second appraisal, and also other stuff like that, which is
 * technically informational."
 *
 * A THIRD, NON-BLOCKING layer beside the eligibility `reasons[]` (declines) and `unverifiable[]`
 * (deferred overlays): the notes/conditions a CHOSEN, ELIGIBLE product carries. It NEVER changes the
 * eligible verdict — it enriches an already-priced product with what it requires (reserves, a possible
 * second appraisal, the delegate-only exception, cash-out-toward-reserves, the small-loan LTV cut).
 *
 * SOURCE DISCIPLINE (never guessed): every value here is transcribed from the published Deephaven DSCR
 * matrix (`matrices/deephaven-dscr-matrix.json`) VERBATIM. What the matrix does NOT literally state is
 * left as a `provenance:'unverified'` note that is DISABLED (never fires on invented numbers) until it
 * is confirmed from the matrix or from Lender Price live (owner D36). The two facts confirmed literal:
 *   • reserves = "3 Months PITIA (loan <= $1mm); 6 Months PITIA (loan > $1mm)"
 *   • small loan = "Loan < $125,000: Max LTV reduced to 75%; Loan < $100k delegated delivery only"
 *   • cash-out  = "$1,000,000 … cash-out may be used towards reserves"
 * A DSCR<1.00 reserve bump and the second-appraisal thresholds are NOT in the matrix JSON, so they are
 * carried as disabled unverified notes rather than fired on guessed thresholds.
 *
 * Facts are the engine's (`lpScenarioToFacts`): loan_amount raw, dscr milli, cashout_amount raw,
 * purpose, etc. PURE: no DB, no network, no clock. LT-only.
 */

const { evalPredicate } = require('./rules');

// Reserves: months of PITIA by loan size (matrix literal). Evaluated top-down; first match wins.
const RESERVE_TIERS = [
  { when: { fact: 'loan_amount', op: 'lte', value: 1000000 }, months: 3 },
  { when: { fact: 'loan_amount', op: 'gt', value: 1000000 }, months: 6 },
];

// Flat informational notes (predicate → message). `kind`: reserve | appraisal | exception | condition.
// `severity`: 'info' (an ordinary note) | 'exception' (LOUD — surfaced separately, needs an exception).
// `enabled:false` = a note whose threshold is NOT in the matrix JSON; carried for the framework, never
// fired on invented numbers (owner "never guess" — confirm from the matrix / LP live first).
const NOTES = [
  {
    code: 'cashout_toward_reserves', kind: 'condition', severity: 'info', enabled: true,
    when: { fact: 'cashout_amount', op: 'gt', value: 0 },
    message: 'Cash-out proceeds may be applied toward the required reserves.',
    provenance: 'matrix',
  },
  {
    code: 'small_loan_ltv_cut', kind: 'condition', severity: 'info', enabled: true,
    when: { fact: 'loan_amount', op: 'lt', value: 125000 },
    message: 'Loan under $125,000: maximum LTV is reduced to 75%.',
    provenance: 'matrix',
  },
  {
    // D34 — the DELEGATE EXCEPTION PRODUCT. Loan < $100k is delegated-delivery only: still ELIGIBLE on
    // every channel, but flagged LOUD as needing a super-admin exception (owner-directed).
    code: 'delegate_only_exception', kind: 'exception', severity: 'exception', enabled: true,
    when: { fact: 'loan_amount', op: 'lt', value: 100000 },
    message: 'Loan under $100,000 is DELEGATED-DELIVERY ONLY — available, but it requires a super-admin exception.',
    channel: 'delegate', requiresException: true, superAdminOnly: true,
    provenance: 'matrix',
  },
  {
    // NOT in the matrix JSON as a literal threshold — the owner's example ("needs a second appraisal").
    // Disabled until the trigger is confirmed from the matrix or LP live (owner D36). Never fires.
    code: 'second_appraisal', kind: 'appraisal', severity: 'info', enabled: false,
    when: null,
    message: 'This loan may require a second appraisal (threshold to be confirmed from the matrix / LP).',
    provenance: 'unverified',
  },
];

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function round(x) { return Math.round(x); }

/**
 * evaluateInformational(facts, opts) — the informational verdict for an already-priced product.
 *   facts — engine facts (loan_amount, dscr, cashout_amount, …).
 *   opts.monthlyPitia — the monthly PITIA from the priced LP option, so the reserve DOLLAR is
 *                       computable (months × PITIA). Omit → months only, amountDollars: null.
 * Returns:
 *   { reserves:{months, amountDollars|null, message, provenance},
 *     informational:[{code,kind,severity,message,provenance,...}],   // the ordinary notes (info)
 *     exceptions:[{code,message,channel,requiresException,superAdminOnly,provenance}] }  // LOUD, needs an exception
 * NEVER throws; a note whose predicate references a missing fact FAILS SAFE (does not fire), exactly
 * like the eligibility layers. Nothing here changes the eligible verdict.
 */
function evaluateInformational(facts, opts = {}) {
  const f = facts || {};
  const monthlyPitia = isNum(opts.monthlyPitia) ? opts.monthlyPitia : null;

  // Reserves — the headline informational number.
  let reserveMonths = null;
  for (const t of RESERVE_TIERS) {
    if (evalPredicate(t.when, f).value) { reserveMonths = t.months; break; }
  }
  const reserves = reserveMonths == null ? null : {
    months: reserveMonths,
    amountDollars: monthlyPitia != null ? round(reserveMonths * monthlyPitia) : null,
    message: monthlyPitia != null
      ? `Reserves required: ${reserveMonths} months PITIA (≈ $${round(reserveMonths * monthlyPitia).toLocaleString('en-US')}).`
      : `Reserves required: ${reserveMonths} months PITIA.`,
    provenance: 'matrix',
  };

  const informational = [];
  const exceptions = [];
  for (const n of NOTES) {
    if (!n.enabled) continue;                       // an unverified note never fires (never guess)
    if (!evalPredicate(n.when, f).value) continue;  // fail-safe on a missing fact
    const item = { code: n.code, kind: n.kind, severity: n.severity, message: n.message, provenance: n.provenance };
    if (n.severity === 'exception') {
      exceptions.push({ ...item, channel: n.channel, requiresException: !!n.requiresException, superAdminOnly: !!n.superAdminOnly });
    } else {
      informational.push(item);
    }
  }

  return { reserves, informational, exceptions };
}

module.exports = { evaluateInformational, _internals: { RESERVE_TIERS, NOTES } };
