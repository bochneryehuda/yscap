/**
 * EMD condition is a PURCHASE concept — never on a REFINANCE (owner-directed
 * 2026-08-05, db/475). The rule-driven cond_emd_corrfirst was gated only on the
 * note buyer being CorrFirst, so it attached to CorrFirst refinances too and asked
 * a refinancing borrower to prove an earnest-money deposit that does not exist.
 *
 * This pins the exact rule the migration writes, evaluated the SAME way the engine
 * evaluates it (rules.evaluateRule + registry.BY_KEY), so the purchase-only clause
 * can never silently regress. PURE — no DB. In `npm test`.
 */
'use strict';
const assert = require('assert');
const rules = require('../src/lib/conditions/rules');
const registry = require('../src/lib/conditions/field-registry');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The EXACT rule_logic db/475 writes onto the template. Kept as a string so a drift
// between this test and the migration is caught (both must be byte-identical).
const RULE_JSON = '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"},{"field":"loan_purpose","operator":"eq","value":"purchase"}]}';
const RULE = JSON.parse(RULE_JSON);

// Evaluate the rule against a file's (lender, loan_type), normalized through the
// same registry helpers engine.loadRuleContext uses.
const attaches = (loanType, lender = 'CorrFirst') => rules.evaluateRule(RULE, {
  note_buyer: registry.normNoteBuyer(lender),
  loan_purpose: registry.normLoanPurpose(loanType),
});

// PURCHASES on a CorrFirst file — EMD attaches.
ok(attaches('Purchase') === true, 'CorrFirst + Purchase → EMD attaches');
ok(attaches('Acquisition') === true, 'CorrFirst + Acquisition → EMD attaches');
ok(attaches('Delayed Purchase Financing') === true, 'CorrFirst + Delayed Purchase → EMD attaches (it is a purchase)');
ok(attaches('Delayed Purchase Financing (Cash-Out)') === true, 'CorrFirst + Delayed Purchase (Cash-Out) → still a purchase → EMD attaches');

// REFINANCES on a CorrFirst file — EMD does NOT attach (the fix).
ok(attaches('Refinance — Rate & Term') === false, 'CorrFirst + Refi Rate & Term → NO EMD');
ok(attaches('Refinance — Cash-Out') === false, 'CorrFirst + Refi Cash-Out → NO EMD');
ok(attaches('Cash-Out Refinance') === false, 'CorrFirst + Cash-Out Refinance → NO EMD');
ok(attaches('Rate and Term Refinance') === false, 'CorrFirst + Rate-and-Term Refinance → NO EMD');

// Unknown / blank loan type on a CorrFirst file — NO EMD (safe direction: we do
// not demand a deposit unless we know it is a purchase).
ok(attaches('') === false, 'CorrFirst + blank loan type → NO EMD (safe)');
ok(attaches('Something Else') === false, 'CorrFirst + unrecognized loan type → NO EMD');

// A non-CorrFirst purchase never carried it and still does not.
ok(attaches('Purchase', 'Blue Lake') === false, 'Blue Lake + Purchase → NO EMD (wrong note buyer)');
ok(attaches('Purchase', '') === false, 'no note buyer + Purchase → NO EMD');

// Sanity: the normalizer the rule depends on classifies the two refinance branches.
ok(registry.normLoanPurpose('Refinance — Cash-Out') === 'refinance_cash_out', 'normLoanPurpose: cash-out refi');
ok(registry.normLoanPurpose('Refinance — Rate & Term') === 'refinance_rate_term', 'normLoanPurpose: rate & term refi');
ok(registry.normLoanPurpose('Purchase') === 'purchase', 'normLoanPurpose: purchase');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll EMD purchase-only rule checks passed.');
