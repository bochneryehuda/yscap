'use strict';
/**
 * MONEY THAT CARRIES CENTS NEVER DISPLAYS ROUNDED — the structural guard for the class the
 * owner reported on 2026-08-24 ("Origination points 1.50% · $5,513" for 1.50% of $367,500,
 * which is $5,512.50).
 *
 * THE RULE, which this repo settled on 2026-07-16 and which is NOT "everything gets cents":
 *
 *   · FEES, CASH-TO-CLOSE and LIQUIDITY show EXACT cents. They are computed to the cent, they
 *     are what a borrower actually pays or must show, and a rounded one disagrees with the term
 *     sheet, the Excel export and the studio about the same number.
 *   · The LOAN AMOUNT, the INITIAL ADVANCE, the REHAB HOLDBACK and the FINANCED RESERVE are
 *     WHOLE DOLLARS **by rule** — the frozen 2026-07-09 reconciliation rule floors them so the
 *     breakdown sums to the total to the penny. Giving THOSE cents would break that rule, so
 *     this file guards both directions.
 *
 * WHY A REGISTRY AND NOT A SWEEP. "Find every money formatter and demand cents" is the wrong
 * test — it would fail the frozen whole-dollar figures, which are correct. What can be checked
 * mechanically is: for each surface we have decided about, the NAMED figure is rendered through
 * the formatter its rule requires. Adding a surface means adding a row here, which is the point:
 * the decision gets made once, in the open, instead of being re-litigated per screen.
 *
 * COMMENTS ARE STRIPPED FIRST. Every one of these files necessarily explains the cents rule in
 * prose, and a guard that read comments would pass on an explanation alone — and would then be
 * "fixed" by deleting the explanation.
 *
 * PURE: no database, no network. Run: node scripts/test-money-cents-pure.js
 */

const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };

// Strip /* */ and // comments. Crude on purpose: it only has to stop PROSE satisfying an
// assertion, and every pattern below is real code (a call, an assignment) that a comment
// cannot accidentally contain in the exact shape asserted.
const codeOf = (rel) => fs.readFileSync(path.join(R, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// A formatter that shows exactly two decimals. Matched on the OPTION, never on a name, because
// the name differs per file (money2 / usd2 / m2 / fmtUSD2) and a name proves nothing anyway.
const CENTS_FORMATTER = /minimumFractionDigits:\s*2/;

/* ---------------------------------------------------------------- the registry
 * file            — the surface
 * label           — what a reader would call it
 * cents           — [regex, human name] pairs: this figure MUST render through a 2-decimal
 *                   formatter. The regex matches the CALL, so it proves the wiring, not the
 *                   existence of a helper nobody uses.
 * whole           — [regex, human name] pairs: this figure MUST NOT gain cents (frozen rule).
 */
const SURFACES = [
  {
    file: 'src/lib/file-overview.js',
    label: 'File overview slide-over (staff, borrower AND TPO broker — one builder, three surfaces)',
    cents: [
      [/money2\(origDollars\)/, 'origination fee dollars — the owner’s own report'],
      [/money2\(ledger\.estimateCashToClose\)/, 'cash to close'],
      [/money2\(ledger\.reserveRequirement\)/, 'reserves to show'],
      [/money2\(ledger\.closingBuffer\)/, 'the 1% closing-cost buffer'],
      [/money2\(ledger\.requiredLiquidity\)/, 'total liquidity required'],
    ],
    // The four figures the frozen 2026-07-09 reconciliation rule FLOORS so the breakdown sums
    // to the total to the penny. Naming them by their real expressions matters: an earlier cut
    // of this guard named `a.loan_amount`, which this file never renders, so the assertion
    // passed while proving nothing — caught by running the mutation, not by reading it.
    whole: [
      [/money2\(s\.totalLoan\)/, 'the total loan is floored whole by the frozen rule'],
      [/money2\(s\.initialAdvance\)/, 'the initial advance is floored whole'],
      [/money2\(s\.rehabHoldback\)/, 'the construction holdback is floored whole'],
      [/money2\(s\.financedReserve\)/, 'the financed reserve is floored whole'],
      [/money2\(a\.rehab_budget\)/, 'the construction budget is a whole-dollar deal value'],
    ],
  },
  {
    file: 'src/lib/liquidity.js',
    label: 'The assets condition’s liquidity breakdown (borrower-facing)',
    cents: [[/money2\(/, 'the liquidity figures']],
    whole: [],
  },
  {
    file: 'src/lib/underwriting/asset-ledger.js',
    label: 'The underwriting bank-liquidity panel',
    cents: [[/minimumFractionDigits:\s*2/, 'the verified-funds figures']],
    whole: [],
  },
  {
    file: 'src/lib/pricing-overrides.js',
    label: 'describeOverrides — the admin-approval card and its notification',
    cents: [[/minimumFractionDigits:\s*2/, 'a typed fee override']],
    whole: [],
  },
  {
    file: 'src/lib/email/pricing-email.js',
    label: 'The internal pricing-approval email',
    cents: [[/minimumFractionDigits:\s*2/, 'a typed fee override, worded identically to the card']],
    whole: [],
  },
  {
    file: 'src/lib/product-registration.js',
    label: 'The borrower "your terms are ready" email',
    cents: [[/minimumFractionDigits:\s*2/, 'every closing-cost row AND the total together']],
    whole: [],
  },
  {
    file: 'app-v2/src/components/RateTermCashCard.jsx',
    label: 'The rate-&-term $2,000 cash card',
    cents: [
      [/usd2\(c\.cashToBorrower\)/, 'cash to the borrower — compared to the limit AT FULL PRECISION'],
      [/usd2\(c\.payoff\)/, 'the payoff'],
      [/usd2\(c\.closingCosts\)/, 'the closing costs'],
      [/usd2\(c\.itemizedClosingCosts\)/, 'the validated closing costs'],
      [/usd2\(it\.amount\)/, 'each itemized fee'],
    ],
    whole: [
      [/usd2\(c\.initialAdvance\)/, 'the initial advance is floored whole by the frozen rule'],
    ],
  },
];

console.log('\nA. every surface we have decided about renders its figures by the right rule');
for (const s of SURFACES) {
  const code = codeOf(s.file);
  ok(`${s.label}: defines a 2-decimal formatter at all`, CENTS_FORMATTER.test(code));
  for (const [re, what] of s.cents) {
    ok(`${s.label}: ${what} shows cents`, re.test(code));
  }
  for (const [re, what] of s.whole) {
    ok(`${s.label}: ${what}`, !re.test(code));
  }
}

// ---------------------------------------------------------------- B. the rule itself, exercised
console.log('\nB. the formatter rule, run rather than asserted');
{
  // The owner's own number, and the half-dollar that started this.
  const cents = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  ok('1.50% of $367,500 reads $5,512.50, not $5,513', cents(367500 * 0.015) === '$5,512.50');
  ok('...and the whole-dollar formatter is what got it wrong', whole(367500 * 0.015) === '$5,513');
  // The rate-&-term case: a file OVER the limit must not read as AT the limit.
  ok('$2,000.40 to the borrower reads over the $2,000 limit', cents(2000.4) === '$2,000.40');
  ok('...where the whole-dollar formatter hid it', whole(2000.4) === '$2,000');
  // A figure that IS whole still reads cleanly with cents — so applying the rule costs nothing.
  ok('a genuinely whole fee still reads correctly with cents', cents(1200) === '$1,200.00');
}

// ---------------------------------------------------------------- C. nothing silently un-registered
console.log('\nC. the registry cannot rot');
{
  for (const s of SURFACES) {
    ok(`${s.file} still exists`, fs.existsSync(path.join(R, s.file)));
  }
  ok('every registered surface names at least one figure', SURFACES.every((s) => s.cents.length > 0));
}

console.log(`\ntest-money-cents-pure: ${fail ? 'FAILED' : 'OK'} (${pass} assertions${fail ? `, ${fail} failed` : ''})`);
process.exit(fail ? 1 : 0);
