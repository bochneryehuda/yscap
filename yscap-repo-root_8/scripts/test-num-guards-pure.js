'use strict';
/**
 * Numeric null/blank-coercion guards (fix 2026-07-23) — regression tests for the
 * reproduced Number(null)===0 bug class across six underwriting modules.
 */
const assert = require('assert');
let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. structure-underwriter: a missing numerator is NULL, never a passing 0.00
const su = require('../src/lib/underwriting/structure-underwriter');
const r = su.computeRatios({ totalLoan: null, initialAdvance: null, recognizedPurchasePrice: 500000, asIsValue: 500000, arv: 600000, rehabBudget: 100000 });
assert.strictEqual(r.acquisitionLtv, null, 'null initialAdvance → null ratio (was a fabricated passing 0)');
assert.strictEqual(r.arvLtv, null, 'null totalLoan → null ratio');
// and the ledger reports incomplete, not pass
const led = su.ledger({ totalLoan: null, initialAdvance: null, recognizedPurchasePrice: 500000, asIsValue: 500000, arv: 600000, rehabBudget: 100000 },
  { maxAcquisitionLtv: 0.8, maxArvLtv: 0.75, maxLtc: 0.925, maxAsIsLtv: 0.8 });
assert.ok(Array.isArray(led));
assert.ok(led.every((row) => row.severity !== 'pass'), 'no ledger row passes on a fabricated 0');
assert.ok(led.some((row) => row.severity === 'incomplete'), 'missing inputs read as incomplete');
// costBasis: null no longer blocks the purchase+rehab fallback
const r2 = su.computeRatios({ totalLoan: 550000, recognizedPurchasePrice: 500000, rehabBudget: 100000, costBasis: null });
assert.ok(Math.abs(r2.ltc - 550000 / 600000) < 1e-3, 'costBasis:null falls back to purchase+rehab (was ltc:null; ratios round to 4dp)');
ok('structure-underwriter: null numerators → null/incomplete; costBasis:null falls back');

// 2. assignment-analysis: null seller price → incomplete, no fabricated findings
const aa = require('../src/lib/underwriting/assignment-analysis');
const a = aa.analyze({ sellerPrice: null, actualFee: 20000, program: 'standard', registeredFinanceableFee: 15000 });
assert.strictEqual(a.incomplete, true, 'sellerPrice:null → incomplete (was a $0 basis + false findings)');
assert.ok(!(a.findings || []).some((f) => f.code === 'assignment_fee_over_cap'), 'no false over-cap on missing inputs');
ok('assignment-analysis: missing inputs → incomplete, never a fabricated $0 basis');

// 3. system-reconciliation: formatted mirrors agree; whitespace is not-mirrored
const sr = require('../src/lib/underwriting/system-reconciliation');
assert.strictEqual(sr._internals.agree(250000, '250,000'), true, "'250,000' agrees with 250000");
assert.strictEqual(sr._internals.agree(250000, '$250,000'), true, "'$250,000' agrees with 250000");
assert.strictEqual(sr._internals.agree(250000, '  '), null, 'a whitespace mirror value is not-comparable, not a mismatch');
ok('system-reconciliation: formatted money agrees; blank is not-mirrored');

// 4. compare: blank-after-strip is null, never a $0
const cmp = require('../src/lib/underwriting/compare');
assert.strictEqual(cmp.num('$'), null);
assert.strictEqual(cmp.num('  '), null);
assert.strictEqual(cmp.num('()'), null);
assert.strictEqual(cmp.num('($1,234.00)'), -1234, 'accounting negative still parses');
ok('compare: $/whitespace/() → null (no false fatal $0 tie-out), negatives intact');

// 5. rehab-budget: the sign survives — a negative contingency/total cannot pass.
// (rehab-budget requires src/db.js → pg; in a sandbox without node_modules the
// require fails — skip this section there, it always runs in CI after install.)
let rb = null;
try { rb = require('../src/lib/rehab-budget'); } catch (_e) { rb = null; }
if (rb) {
  assert.strictEqual(rb.toNum(-5000), -5000, 'a negative number keeps its sign');
  assert.strictEqual(rb.toNum('-5,000'), -5000, 'a formatted negative keeps its sign');
  assert.strictEqual(rb.toNum('$75,000.50'), 75000.5, 'positive money still parses');
  assert.strictEqual(rb.goldContingencyOk({ subtotal: 100000, contingency: -5000 }), false,
    'a NEGATIVE contingency no longer satisfies the 5% requirement');
  assert.strictEqual(rb.eqCents(rb.toNum(-80000), 80000), false,
    'a sign-flipped total no longer "exactly matches" the budget');
  ok('rehab-budget: toNum preserves the sign — negative values cannot pass the SOW gates');
} else {
  console.log('  SKIP rehab-budget sign checks (pg module unavailable in this sandbox)');
}

// 6. bank-statement-checks: string page numbers arm the missing-page detector
const bs = require('../src/lib/underwriting/bank-statement-checks');
const found = bs.computeBankFindings(
  { accountHolderName: 'Test LLC', pageNumbers: ['1', '2', '4', '5'], declaredPageCount: 5 },
  { borrowerName: 'Test LLC', entityName: 'Test LLC' });
assert.ok((found || []).some((f) => f.code === 'bank_missing_page'), 'string page numbers still detect the missing page 3');
ok('bank-statement-checks: string page numbers no longer disarm the detector');

// 7. appraisal-underwriter: whitespace value is unreadable, not $0
const uw = require('../src/lib/underwriting/appraisal-underwriter');
assert.strictEqual(uw.valueSupports(' ', 500000).supported, null,
  "a whitespace appraisal value is 'not verifiable', never a $0 shortfall");
ok('appraisal-underwriter: whitespace values are not-verifiable');

console.log(`\nnum-guards pure — ${passed} checks passed`);
