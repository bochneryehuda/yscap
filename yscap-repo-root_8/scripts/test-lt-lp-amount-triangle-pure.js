#!/usr/bin/env node
'use strict';
/**
 * §35.2/§36.2 — THE AMOUNT TRIANGLE + purpose-specific amount rules (pure, offline).
 *
 * The owner quotes deals in a short form — "Purchase, 760 FICO, $400,000 loan, 75% LTV, ZIP 11211" —
 * with no property value. Value, loan and LTV are three views of two facts, so any TWO determine the
 * third and the server must derive it rather than demand it.
 *
 * The rules proven here:
 *   • loan + ltv -> value; value + ltv -> loan; value + loan -> ltv (the existing behavior).
 *   • ONE amount alone is REFUSED (insufficient_amounts) — deriving from one is a guess, and sending
 *     a null purchase price upstream answers 500 or mis-prices.
 *   • LTV is accepted as 75 or 0.75 and always normalized to the 0.75 decimal the vendor expects.
 *   • A conflicting supplied LTV is still rejected (never silently replaced).
 *   • An unknown PURPOSE is reported as an unknown purpose, not masked by the amount rule.
 *   • A cash-out amount is rejected on a Purchase / rate-and-term Refinance (§36.3/§36.4) — it
 *     describes a different transaction than the purpose states.
 *
 * PROVEN TO FAIL: remove the loan+ltv branch from deriveAmounts and DERIVE-VALUE goes red; drop the
 * known<2 refusal and ONE-* go red; drop the purpose pre-check and PURPOSE-1 reports the wrong code;
 * drop the cash-out purpose rule and CASHOUT-* go red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const loc = { zip: '11211', state: 'NY', countyFps: '36047' };
const near = (a, b) => a != null && Math.abs(a - b) < 0.011;

console.log('§35.2/§36.2 amount triangle + purpose amount rules');

// ---- the owner's own short form: loan + LTV, no value ----------------------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 400000, ltv: 75, ...loc });
  ok(r.ok === true, 'DERIVE-VALUE the short form (loan + LTV, no value) is accepted');
  const c = r.request.criteria;
  ok(near(c.purchasePrice, 533333.33), `DERIVE-VALUE2 value derived as 533333.33 (got ${c.purchasePrice})`);
  ok(c.loanAmount === 400000, 'DERIVE-VALUE3 the supplied loan is transmitted unchanged');
  ok(c.ltv === 0.75, 'DERIVE-VALUE4 LTV 75 normalized to the 0.75 decimal form');
}
// ---- value + LTV -> loan ---------------------------------------------------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 500000, ltv: 75, ...loc });
  ok(r.ok === true && r.request.criteria.loanAmount === 375000, 'DERIVE-LOAN value + LTV derives the loan (375000)');
  ok(r.request.criteria.purchasePrice === 500000, 'DERIVE-LOAN2 the supplied value is unchanged');
}
// ---- value + loan -> LTV (the pre-existing behavior, unchanged) ------------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 500000, loan: 375000, ...loc });
  ok(r.ok === true && r.request.criteria.ltv === 0.75, 'DERIVE-LTV value + loan still derives LTV 0.75');
}
// ---- a fractional LTV is taken as-is, not divided again --------------------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 350000, ltv: 0.7, ...loc });
  ok(r.ok === true && r.request.criteria.ltv === 0.7, 'NORM-1 a 0.70 LTV stays 0.70 (not 0.007)');
  ok(near(r.request.criteria.purchasePrice, 500000), 'NORM-2 …and derives a 500000 value');
}

// ---- ONE amount alone is refused ------------------------------------------
for (const [label, sc] of [
  ['loan only', { loan: 400000 }],
  ['value only', { value: 500000 }],
  ['ltv only', { ltv: 75 }],
  ['none', {}],
]) {
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, ...sc, ...loc });
  ok(r.ok === false && r.status === 422 && r.error === 'insufficient_amounts',
    `ONE-${label} is refused 422 insufficient_amounts (never derived from one figure)`);
}

// ---- a conflicting LTV is still rejected, never silently replaced ----------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 500000, loan: 400000, ltv: 50, ...loc });
  ok(r.ok === false && r.error === 'ltv_conflict', 'CONFLICT-1 a supplied LTV that disagrees with loan/value is rejected');
}
// ---- an out-of-range LTV is still rejected before the triangle rule --------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, ltv: 105, ...loc });
  ok(r.ok === false && r.error === 'ltv_out_of_range', 'RANGE-1 an LTV over 100% is still range-rejected (not masked by the triangle rule)');
}

// ---- an unknown purpose is reported as an unknown purpose ------------------
{
  const r = sm.validateScenario({ purpose: 'banana', ...loc });
  ok(r.ok === false && r.error === 'unknown_loan_purpose',
    'PURPOSE-1 an unknown purpose is reported as unknown_loan_purpose, not masked by the missing amounts');
}

// ---- §36.3/§36.4 cash-out amount belongs only to a cash-out refinance ------
{
  const buy = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, cashoutAmount: 50000, ...loc });
  ok(buy.ok === false && buy.status === 422 && buy.error === 'cashout_not_allowed',
    'CASHOUT-1 a cash-out amount on a Purchase is rejected (not silently dropped)');
  const rt = sm.validateScenario({ purpose: 'Refinance', fico: 760, value: 5e5, loan: 4e5, cashoutAmount: 50000, ...loc });
  ok(rt.ok === false && rt.error === 'cashout_not_allowed',
    'CASHOUT-2 a cash-out amount on a rate-and-term Refinance is rejected');
  const co = sm.validateScenario({ purpose: 'Cash out', fico: 760, value: 6e5, loan: 42e4, cashoutAmount: 50000, ...loc });
  ok(co.ok === true, 'CASHOUT-3 a cash-out amount on a Cash out refinance is accepted');
  // zero / absent is never a "cash-out on a purchase" complaint
  const zero = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, cashoutAmount: 0, ...loc });
  ok(zero.ok === true, 'CASHOUT-4 a zero cash-out amount on a Purchase is not a conflict');
}

// ---- the pure helper reports what it derived (for the response echo) -------
{
  const t = sm._internals.deriveAmounts({ loan: 400000, ltv: 75 });
  ok(t.derived.includes('value') && t.supplied.loan === true && t.supplied.value === false,
    'ECHO-1 deriveAmounts reports which figure it derived and which were supplied');
  ok(t.known === 3, 'ECHO-2 …and that all three are known after derivation');
  const one = sm._internals.deriveAmounts({ loan: 400000 });
  ok(one.known === 1 && one.derived.length === 0, 'ECHO-3 one figure derives nothing (never a guess)');
  // never throws on junk
  ok(sm._internals.deriveAmounts({ value: 'abc', loan: null, ltv: undefined }).known === 0, 'ECHO-4 unparseable input derives nothing and does not throw');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
