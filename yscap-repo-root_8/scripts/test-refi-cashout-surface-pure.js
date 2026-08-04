'use strict';
/**
 * REFINANCE CASH-OUT SURFACING (owner-directed 2026-08-04).
 *
 * The engine sizes a refinance correctly, but the SERVER never surfaced the
 * cash-out proceeds: a cash-out borrower's "terms are ready" email showed
 * "Estimated cash to close: $0" and no cash-in-hand line. This pins the two
 * fixes, both PURE (no DB):
 *   1. the pricing quote carries `refi.cashOut` — the mirror of `refi.shortfall`,
 *      so exactly one of {what the borrower brings, what they receive} is > 0;
 *   2. borrowerTermsEmail shows "cash to you" on a cash-out and the ordinary
 *      "cash to close" on a rate-and-term / purchase.
 */
const pricing = require('../src/lib/pricing');
const { borrowerTermsEmail } = require('../src/lib/product-registration');

let failed = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; }

function appRow(loanType, asIs, payoff) {
  return {
    loan_type: loanType, program: 'standard',
    as_is_value: asIs, arv: asIs, rehab_budget: 0,
    payoff_amount: payoff, estimated_cash_out: null,
    units: 1, property_type: 'Single Family',
    property_address: { state: 'NJ', city: 'Newark', line1: '1 Main St' },
    requested_exp_flips: 3, requested_exp_holds: 0, requested_exp_ground: 0,
  };
}
const exp = { flips: 3, holds: 0, ground: 0, total: 3 };
function quote(loanType, asIs, payoff) {
  const all = pricing.quoteAll(appRow(loanType, asIs, payoff), exp, {});
  return all.standard || all.gold || all.silver || Object.values(all)[0];
}
function emailLine(q, cashOut) {
  const e = borrowerTermsEmail({ quote: q, total: q.sizing.totalLoan, termMonths: 12, cashOut });
  return (e.meta || []).find((m) => /cash to (you|close)/i.test(m.label)) || null;
}

// ---- CASH-OUT: funds advanced exceed payoff + closing -> borrower RECEIVES cash.
const co = quote('Cash-Out Refinance', 500000, 150000);
ok(co.refi != null, 'cash-out: quote carries a refi block');
ok(co.refi.cashOut > 0, `cash-out: refi.cashOut > 0 (got ${co.refi.cashOut})`);
ok(co.refi.shortfall === 0, `cash-out: refi.shortfall is 0 (got ${co.refi.shortfall})`);
ok(co.cashToClose === 0, 'cash-out: cash-to-close is 0 (borrower brings nothing)');
{
  const line = emailLine(co, co.refi.cashOut);
  ok(line && /cash to you/i.test(line.label), 'cash-out: borrower email shows "cash to you", not "$0 to close"');
  ok(line && line.value.includes(String(Math.round(co.refi.cashOut).toLocaleString('en-US'))),
     'cash-out: the email figure is the cash-out amount');
}

// ---- RATE-AND-TERM: funds advanced short of payoff -> borrower BRINGS the gap, no cash out.
const rt = quote('Refinance - Rate & Term', 300000, 250000);
ok(rt.refi.shortfall > 0, `rate-&-term: refi.shortfall > 0 (got ${rt.refi.shortfall})`);
ok(rt.refi.cashOut === 0, `rate-&-term: refi.cashOut is 0 — no cash in hand (got ${rt.refi.cashOut})`);
{
  const line = emailLine(rt, rt.refi.cashOut);
  ok(line && /cash to close/i.test(line.label), 'rate-&-term: borrower email shows "cash to close" (the shortfall), never cash-to-you');
}

// ---- MIRROR INVARIANT: exactly one of {shortfall, cashOut} is positive on a refi.
for (const q of [co, rt]) {
  const both = (q.refi.shortfall > 0) && (q.refi.cashOut > 0);
  const neither = !(q.refi.shortfall > 0) && !(q.refi.cashOut > 0);
  ok(!both, 'mirror: shortfall and cashOut are never both positive');
  ok(!neither || (q.refi.payoff === q.refi.fundedAtClose + q.refi.closing),
     'mirror: at least one is positive unless the deal exactly balances');
}

// ---- PURCHASE control: no refi block, ordinary cash-to-close, byte-identical.
const p = quote('Purchase', 400000, 0);
ok(p.refi == null, 'purchase: no refi block (unchanged)');
{
  const line = emailLine(p, null);
  ok(line && /cash to close/i.test(line.label), 'purchase: email shows "cash to close" (unchanged)');
}

// ---- A TYPED cash-out override wins over the structural figure (payoff.cashOutOfRecord order).
{
  const typed = 42000;
  const line = emailLine(co, typed);
  ok(line && line.value.includes('42,000'), 'typed cash-out override is what the borrower email shows');
}

console.log(failed ? `\n${failed} assertion(s) failed` : '\nALL refinance cash-out surfacing assertions passed');
process.exit(failed ? 1 : 0);
