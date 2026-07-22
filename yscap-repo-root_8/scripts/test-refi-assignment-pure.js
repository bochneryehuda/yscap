'use strict';
/**
 * R6.6 — pure tests for the refinance + assignment analyzers. Guarantees: a
 * rate-&-term that nets cash is caught as economically cash-out, a missing
 * payoff is a finding (not a silent 0), and the assignment cap re-derives the
 * FROZEN 15%-of-seller-price rule (+ Gold's $75k ceiling).
 */
const assert = require('assert');
const refi = require('../src/lib/underwriting/refinance-analysis');
const asg = require('../src/lib/underwriting/assignment-analysis');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- refinance ---
// a "rate & term" that nets the borrower cash is economically cash-out.
let r = refi.analyze({ statedType: 'rate_term', loanProceeds: 300000, payoff: 200000, closingCosts: 10000 });
assert.strictEqual(r.economicType, 'cash_out', 'nets $90k → cash-out');
assert.strictEqual(r.netToBorrower, 90000);
assert.strictEqual(r.mismatch, true);
assert.ok(r.findings.some((f) => f.code === 'refi_type_mismatch'));
ok('a rate-&-term netting cash is caught as economically cash-out');

// a true rate-&-term (net within de-minimis) is rate_term.
r = refi.analyze({ statedType: 'rate_term', loanProceeds: 205000, payoff: 200000, closingCosts: 4000 });
assert.strictEqual(r.economicType, 'rate_term', 'nets $1k (< $2k de-minimis) → rate & term');
assert.strictEqual(r.mismatch, false);
ok('a small incidental net stays rate-&-term (de-minimis)');

// missing payoff → a finding, never a silent 0.
r = refi.analyze({ statedType: 'rate_term', loanProceeds: 300000 });
assert.strictEqual(r.incomplete, true);
assert.ok(r.findings.some((f) => f.code === 'refi_missing_payoff'));
assert.strictEqual(r.netToBorrower, null, 'no fabricated net');
ok('a missing payoff is a finding (never a silent 0)');

// cash-out above verified hard costs.
r = refi.analyze({ statedType: 'cash_out', loanProceeds: 300000, payoff: 150000, verifiedHardCosts: 100000 });
assert.ok(r.findings.some((f) => f.code === 'cashout_above_verified_costs'), 'net 150k > verified 100k');
ok('cash-out above verified hard costs is flagged');

// cash-out over the escalation threshold.
r = refi.analyze({ statedType: 'cash_out', loanProceeds: 300000, payoff: 100000, escalationThreshold: 150000 });
assert.ok(r.findings.some((f) => f.code === 'cashout_over_threshold'));
ok('cash-out over the review threshold is flagged');

// --- assignment ---
// FROZEN rule: financeable = 15% of the SELLER price; excess out of pocket.
let a = asg.analyze({ sellerPrice: 100000, actualFee: 20000, program: 'standard' });
assert.strictEqual(a.financeableFee, 15000, '15% of $100k seller price');
assert.strictEqual(a.recognizedPrice, 115000, 'seller + financeable fee');
assert.strictEqual(a.excessOutOfPocket, 5000, '$20k fee - $15k financeable');
assert.ok(a.findings.some((f) => f.code === 'assignment_fee_over_cap'));
ok('assignment financeable fee = 15% of the SELLER price (frozen rule) + excess out of pocket');

// Gold: lesser of $75k or 15% of seller price.
a = asg.analyze({ sellerPrice: 600000, actualFee: 90000, program: 'gold' });
assert.strictEqual(a.financeableFee, 75000, 'Gold $75k ceiling < 15% of $600k ($90k)');
ok('Gold applies the $75,000 ceiling');

// a fee within cap → fully financeable, no excess.
a = asg.analyze({ sellerPrice: 100000, actualFee: 10000, program: 'standard' });
assert.strictEqual(a.financeableFee, 10000);
assert.strictEqual(a.excessOutOfPocket, 0);
assert.strictEqual(a.findings.length, 0);
ok('a fee within the cap is fully financeable, no excess');

// mismatch vs the registered figure (e.g. the pre-freeze fee-inclusive bug).
a = asg.analyze({ sellerPrice: 100000, actualFee: 20000, program: 'standard', registeredFinanceableFee: 18000 });
assert.ok(a.findings.some((f) => f.code === 'assignment_fee_mismatch'), 'registered 18k (15% of 120k total) != independent 15k');
ok('a registered fee on the wrong basis is flagged as a mismatch');

// missing inputs → incomplete, no fabricated 0.
a = asg.analyze({ sellerPrice: 100000 });
assert.strictEqual(a.incomplete, true);
assert.strictEqual(a.financeableFee, null);
ok('missing assignment inputs → incomplete (no fabricated 0)');

console.log(`\nR6.6 refi + assignment pure — ${passed} checks passed`);
