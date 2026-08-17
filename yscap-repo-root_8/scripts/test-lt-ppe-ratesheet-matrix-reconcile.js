#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE RATE SHEET AND THE ELIGIBILITY MATRIX MUST NOT DISAGREE SILENTLY.
 *
 * We now hold the investor's program limits in TWO independently-sourced places:
 *   • the RATE SHEET   — matrices/deephaven-dscr-ratesheet-corr-t0.json, the vendor's own Corr T0
 *                        DSCR tab (effective 2026-08-14), "Other Program Requirements";
 *   • the MATRIX       — src/longterm/ppe/deephaven-matrix.js (Layer 2), encoded from the published
 *                        product matrix (Deephaven Correspondent Flow, effective 2026-08-04).
 *
 * Two sources for one number is exactly the shape this repo's standing rule warns about: "two copies
 * of a rule drift, and the one that drifts is the one that leaks." They are deliberately kept
 * SEPARATE here (Layer 2 must stay independent of Lender Price so it can catch an LP mistake — see
 * that module's header), so the answer is NOT to collapse them; it is to make a drift IMPOSSIBLE TO
 * MISS. This suite fails the build on ANY disagreement that is not explicitly recorded below with a
 * reason, so a new rate sheet that moves a limit surfaces as a red test rather than as a loan quoted
 * on a number the investor no longer honours.
 *
 * ADDING A DIVERGENCE HERE IS NOT A WAY TO SILENCE THE TEST — it is a way to say, in writing, that a
 * human looked at it and what they decided. An entry with a stale/blank reason should be treated as
 * unreviewed.
 *
 * PURE: reads the JSON + the module. No network, no DB, no live Lender Price.
 */
const fs = require('fs');
const path = require('path');

const SHEET = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs/longterm/ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json'), 'utf8'));
const MATRIX_JSON = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs/longterm/ppe-research/matrices/deephaven-dscr-matrix.json'), 'utf8'));

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(` FAIL  ${label}`); } }

// ---------------------------------------------------------------------------------------------
// The KNOWN, REVIEWED divergences. Each needs the two values and a real reason.
// ---------------------------------------------------------------------------------------------
const RECORDED_DIVERGENCES = [
  {
    what: 'minimumLoanAmount',
    sheet: 100000,
    matrix: 75000,
    resolved: true,
    reason:
      'RESOLVED BY THE OWNER (2026-08-17) — the two numbers are BOTH right and describe different ' +
      'things, so this is not a conflict and neither document is stale. Owner\'s words: "anything ' +
      'below $100,000 is an internal exception, but you can do ... $75,000 on this program. It is ' +
      'eligible, but under $100,000, it\'s a manual product and it needs an exception. You can price ' +
      'it regularly out of their rate sheet and out of the Lender Price pricer, but you just need to ' +
      'mark that it\'s a manual exceptional product." So: $75,000 is the true program FLOOR (below it, ' +
      'ineligible); $100,000 is the threshold below which the loan is still ELIGIBLE and PRICED ' +
      'NORMALLY but must be STAMPED as a manual/exception product. That is exactly the existing D34 ' +
      'exception-product mechanism — see EXCEPTION_BAND below, which is what enforces it.',
  },
];

// The owner's rule, encoded as data so the guard can assert the BEHAVIOUR rather than restate prose.
const EXCEPTION_BAND = { floor: 75000, exceptionBelow: 100000 };

// ---------------------------------------------------------------------------------------------
// 1. Max loan — the one both documents state, and they agree. If this ever goes red, a rate sheet
//    changed a hard limit under us.
// ---------------------------------------------------------------------------------------------
const sheetMaxLoan = SHEET.otherProgramRequirements.maximumLoanAmount;
const matrixMaxLoan = Math.max(...JSON.stringify(MATRIX_JSON).match(/"maxLoan":\s*(\d+)/g).map((s) => Number(s.split(':')[1])));
ok(sheetMaxLoan === 2500000, `rate sheet states max loan $2,500,000 (${sheetMaxLoan})`);
ok(matrixMaxLoan === sheetMaxLoan, `matrix's largest maxLoan agrees with the rate sheet (${matrixMaxLoan} === ${sheetMaxLoan})`);

// ---------------------------------------------------------------------------------------------
// 2. Min loan — they DISAGREE, and the disagreement must be RECORDED (not merely present).
// ---------------------------------------------------------------------------------------------
const sheetMinLoan = SHEET.otherProgramRequirements.minimumLoanAmount;
const matrixMinGe1 = Number((JSON.stringify(MATRIX_JSON).match(/"minLoanDscrGe1":\s*(\d+)/) || [])[1]);
const rec = RECORDED_DIVERGENCES.find((d) => d.what === 'minimumLoanAmount');
ok(!!rec, `min loan differs (sheet ${sheetMinLoan} vs matrix ${matrixMinGe1}) and it is RECORDED`);
ok(rec && rec.sheet === sheetMinLoan && rec.matrix === matrixMinGe1,
  `the record quotes the CURRENT values (recorded ${rec && rec.sheet}/${rec && rec.matrix}, actual ${sheetMinLoan}/${matrixMinGe1})`);
ok(rec && typeof rec.reason === 'string' && rec.reason.length > 80,
  'the record carries a real written reason, not a placeholder');
ok(rec && rec.resolved === true, 'the min-loan question is RESOLVED by the owner, not still open');

// The owner's rule as BEHAVIOUR: the two numbers bracket an exception band, and the band must line up
// with both source documents — the floor with the matrix, the exception threshold with the rate sheet.
// If a future rate sheet moves either number, these go red rather than the band quietly going stale.
ok(EXCEPTION_BAND.floor === matrixMinGe1,
  `the program FLOOR is the matrix's minimum — below it, ineligible ($${EXCEPTION_BAND.floor})`);
ok(EXCEPTION_BAND.exceptionBelow === sheetMinLoan,
  `the EXCEPTION threshold is the rate sheet's minimum — below it, eligible + priced but stamped a manual exception ($${EXCEPTION_BAND.exceptionBelow})`);
ok(EXCEPTION_BAND.floor < EXCEPTION_BAND.exceptionBelow,
  'the band is non-empty (floor < exception threshold), so there is a real "priced but needs an exception" range');

// ---------------------------------------------------------------------------------------------
// 3. The requirements the rate sheet states that Layer 2 does NOT encode at all. These are not
//    "wrong" — they are UNENCODED, and the honest position is that they must be named, so nobody
//    reads a green eligibility result as "every stated requirement was checked".
// ---------------------------------------------------------------------------------------------
const matrixSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/ppe/deephaven-matrix.js'), 'utf8');
const UNENCODED_BY_LAYER2 = [
  { key: 'mortgageHistory', sheetValue: SHEET.otherProgramRequirements.mortgageHistory, probe: /0x30x12/ },
  { key: 'bankruptcySeasoning', sheetValue: SHEET.otherProgramRequirements.bankruptcySeasoning, probe: /bankrupt/i },
  { key: 'fcSsDilSeasoning', sheetValue: SHEET.otherProgramRequirements.fcSsDilSeasoning, probe: /foreclos|fc\/ss|dil/i },
];
for (const u of UNENCODED_BY_LAYER2) {
  ok(!!u.sheetValue, `the rate sheet states ${u.key} (${u.sheetValue})`);
  // Assert the CURRENT truth: Layer 2 does not encode it. If someone encodes it later this flips red
  // and the line simply moves out of this list — which is the point.
  ok(!u.probe.test(matrixSrc), `${u.key} is NOT encoded in Layer 2 — named here rather than assumed checked`);
}

// ---------------------------------------------------------------------------------------------
// 4. The sheet's effective date must be recorded, because a limit is only meaningful with one.
// ---------------------------------------------------------------------------------------------
ok(/^2026-08-14T/.test(SHEET.sheetMeta.effectiveDateUtc), `the rate sheet carries its effective date (${SHEET.sheetMeta.effectiveDateUtc})`);

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
