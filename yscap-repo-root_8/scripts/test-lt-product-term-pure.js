'use strict';
/**
 * PROOF that the long-term / short-term rule says what the owner said — and
 * refuses to answer the two things they did not say.
 *
 * The rule decides which product a file belongs to, and the two products are two
 * systems here. Getting it wrong does not throw: it quietly files a bridge loan
 * on the long-term side, or drops a real DSCR loan out of the owner's list with
 * nothing anywhere to say so. So every clause of their sentence is pinned, and
 * so is every clause they did NOT say.
 *
 * It is exercised against the REAL live-tenant taxonomy
 * (src/longterm/encompass/dictionary/program-taxonomy.json — 772 loans, taken
 * 2026-08-14), not a fixture. A fixture would keep passing while the real book
 * moved underneath it, and the whole question this rule answers is "what is
 * actually in the book".
 *
 * PURE: no database, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LONG_TERM_MIN_MONTHS, PRODUCT, classifyProduct, isLongTerm, splitByProduct,
  productSql, termMonthsOf, programSaysShortTerm,
} = require('../src/longterm/product-term');

let checks = 0;
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };
const ok = (c, w) => { assert.ok(c, w); checks++; };

// ---------------------------------------------------------------------------
// A. THE OWNER'S TWO SENTENCES, LITERALLY
// ---------------------------------------------------------------------------
eq(LONG_TERM_MIN_MONTHS, 36, 'the boundary is the 36 months the owner named');

// "any file that has, in the loan program, the word FLIP means that it's RTL"
for (const name of ['Fix & Flip Purchase + reno', 'FLIP', 'fix and flip', 'FiX & FlIp', 'Flip Bridge 2024']) {
  eq(classifyProduct({ programName: name, termMonths: 12 }).product, PRODUCT.SHORT,
    `a program naming Flip is short-term: ${name}`);
}
eq(classifyProduct({ programName: 'Fix & Flip Purchase + reno', termMonths: 12 }).reason,
  'program_says_flip', 'and it says the program is why');

// "Any term that is less than 36 months is short term"
for (const m of [1, 11, 12, 18, 24, 35]) {
  eq(classifyProduct({ programName: 'Investor DSCR 30 YEAR FRM', termMonths: m }).product, PRODUCT.SHORT,
    `${m} months is short-term`);
}
// "all the files that have a term of more than 36 months"
for (const m of [37, 60, 120, 360, 480]) {
  eq(classifyProduct({ programName: 'Investor DSCR 30 YEAR FRM', termMonths: m }).product, PRODUCT.LONG,
    `${m} months is long-term`);
}

// ---------------------------------------------------------------------------
// B. THE TWO THINGS THE OWNER DID NOT SAY — answered honestly, not guessed
// ---------------------------------------------------------------------------
{
  const at = classifyProduct({ programName: 'DSCR ARM', termMonths: 36 });
  eq(at.product, PRODUCT.BOUNDARY, 'EXACTLY 36 months is not silently bucketed — the rule covers under and over, not 36 itself');
  ok(/needs a decision/i.test(at.why), 'and it says a person has to decide it');
  eq(isLongTerm({ programName: 'DSCR ARM', termMonths: 36 }), false,
    'a boundary file is NOT counted as long-term — only a definite yes counts');
}
{
  const none = classifyProduct({ programName: '', termMonths: null });
  eq(none.product, PRODUCT.UNKNOWN, 'no program and no term is unknown, never a guess');
  eq(none.reason, 'no_program_signal_and_no_term', 'with a machine-readable reason');
}
// A blank/absent/garbage term is "no term", never a term of zero.
for (const t of [null, undefined, '', 0, -12, 1.5, 'twelve', NaN, Infinity]) {
  eq(termMonthsOf(t), null, `an unusable term reads as no term: ${String(t)}`);
  eq(classifyProduct({ programName: 'Conventional Fixed', termMonths: t }).product, PRODUCT.UNKNOWN,
    `and classifies as unknown, not short-term: ${String(t)}`);
}

// ---------------------------------------------------------------------------
// C. THE PROGRAM WINS, AND A CONTRADICTION IS SHOWN RATHER THAN SWALLOWED
// ---------------------------------------------------------------------------
{
  const odd = classifyProduct({ programName: 'Fix & Flip Purchase + reno', termMonths: 360 });
  eq(odd.product, PRODUCT.SHORT, 'a Flip program with a 360-month term is still short-term — the owner said Flip MEANS RTL');
  eq(odd.disagrees, true, '…and the disagreement is flagged, never swallowed');
  ok(/does not match a flip/i.test(odd.why), '…in words a person can act on');
  eq(classifyProduct({ programName: 'Fix & Flip Purchase + reno', termMonths: 12 }).disagrees, false,
    'an ordinary flip disagrees with nothing');
}
eq(programSaysShortTerm('Investor DSCR 30 YEAR FRM'), false, 'a DSCR program does not say flip');
eq(programSaysShortTerm(null), false, 'and a missing program says nothing at all');

// ---------------------------------------------------------------------------
// D. AGAINST THE REAL BOOK — 772 loans from the live tenant
// ---------------------------------------------------------------------------
const taxonomy = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'src', 'longterm', 'encompass', 'dictionary', 'program-taxonomy.json'), 'utf8'));

// Expand the taxonomy's { program, termMonths: {months: count} } into one row per loan.
const book = [];
for (const p of taxonomy.programs) {
  const name = p.program === '(blank)' ? '' : p.program;
  for (const [months, count] of Object.entries(p.termMonths || {})) {
    for (let i = 0; i < count; i++) {
      book.push({ programName: name, termMonths: months === 'None' ? null : Number(months), family: p.family });
    }
  }
}
eq(book.length, taxonomy.meta.loansAnalyzed,
  `the expansion reproduces every loan the taxonomy counted (${taxonomy.meta.loansAnalyzed})`);

const split = splitByProduct(book);
eq(split.longTerm.length + split.shortTerm.length + split.boundary.length + split.unknown.length,
  book.length, 'every loan lands in exactly one bucket — nothing is silently dropped from the total');

// THE NUMBERS THE OWNER WILL SEE. These are asserted exactly, so a change to the
// rule that moves the book cannot land quietly.
eq(split.longTerm.length, 507, 'the live book has 507 long-term files by this rule');
eq(split.shortTerm.length, 253, '…253 short-term');
eq(split.boundary.length, 0, '…no file sits exactly on the 36-month boundary');
eq(split.unknown.length, 12, '…and 12 we cannot tell, which are reported rather than assumed');
eq(split.disagreements.length, 0, 'and no file in the real book disagrees with itself');

// THE TWO SIGNALS AGREE ON EVERY REAL LOAN — which is what makes the precedence
// a tie-breaker for odd data rather than a decision that moves the book.
{
  let checkedAgainstFamily = 0;
  for (const row of book) {
    if (row.family === 'long-term (DSCR)') {
      eq(classifyProduct(row).product, PRODUCT.LONG, 'every DSCR-family loan classifies long-term');
      checkedAgainstFamily++;
    } else if (row.family === 'short-term (RTL)') {
      eq(classifyProduct(row).product, PRODUCT.SHORT, 'every RTL-family loan classifies short-term');
      checkedAgainstFamily++;
    }
  }
  ok(checkedAgainstFamily === 741,
    `the taxonomy's own family label is reproduced on all 741 classified loans (got ${checkedAgainstFamily})`);
}

// The one Flip program is the only one the program rule fires on — so the word
// is doing the work the owner expected and nothing else is caught by it.
{
  const byProgram = taxonomy.programs.filter((p) => programSaysShortTerm(p.program)).map((p) => p.program);
  assert.deepStrictEqual(byProgram, ['Fix & Flip Purchase + reno'],
    'exactly one program in the live book names Flip'); checks++;
}

// ---------------------------------------------------------------------------
// E. THE SQL TWIN IS THE SAME RULE — same cases, same order
// ---------------------------------------------------------------------------
{
  const sql = productSql();
  ok(sql.includes(`'${PRODUCT.SHORT}'`) && sql.includes(`'${PRODUCT.LONG}'`)
    && sql.includes(`'${PRODUCT.BOUNDARY}'`) && sql.includes(`'${PRODUCT.UNKNOWN}'`),
    'the SQL twin can return all four verdicts');
  ok(sql.indexOf('flip') < sql.indexOf('IS NULL'),
    'the SQL twin asks about the program BEFORE the term — the same precedence as the JS');
  ok(productSql('p.prog', 'p.tm').includes('p.prog') && productSql('p.prog', 'p.tm').includes('p.tm'),
    'and it is parameterised on the column expressions rather than hard-coding a table shape');
}
// (The two are RUN against the same rows and compared in test-lt-product-term-db.js —
//  a source-shape check like the above cannot prove they agree.)

console.log(`\n✓ lt product-term rule: ${checks} assertions passed`);
console.log(`  the live book splits ${split.longTerm.length} long-term / ${split.shortTerm.length} short-term, `
  + `${split.boundary.length} on the boundary, ${split.unknown.length} we cannot tell`);
