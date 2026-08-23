'use strict';
/**
 * LT test — A VENDOR'S MINUS SIGN SURVIVES THE PARSE.
 *
 * Lender Price sends every price figure as JSON, and turning one into a number
 * of ours had been written THREE times in `src/longterm/lenderprice/`. Two of
 * them were audited and corrected; the third — `client.js`, the one that reads
 * the PRICED RESULT — kept the original expression:
 *
 *     parseFloat(String(v).replace(/[^0-9.]/g, ''))
 *
 * which deletes a MINUS SIGN. So every negative LLPA the vendor sent came back
 * as its positive twin: a price CREDIT of −0.375 read as a CHARGE of +0.375, and
 * a −0.25 lender margin read as +0.25. Not only for strings — the sign is
 * stripped after `String(v)`, so a real JSON number was flipped too.
 *
 * IT WAS SILENT BECAUSE THE HEADLINE FIGURES TAKE A DIFFERENT ROAD. `firstNum`
 * uses `Number()` and keeps the sign, so the price, the note rate and the LLPA
 * stack TOTAL were always right. Only the ITEMISED breakdown flipped — the lines
 * a person reads to understand why a price is what it is. The total and its own
 * itemisation disagreed by twice the figure, on the same screen, and nothing
 * anywhere compared the two.
 *
 * AND NO TEST HAD EVER SENT A NEGATIVE ONE. The existing fixture carries a
 * negative `basePoints` (−3.75) — which goes through the sign-safe road — beside
 * a POSITIVE itemised adjustment. So the suite proved the half that worked.
 * That is the whole lesson: a fixture that only carries the easy sign tests
 * nothing about the hard one.
 *
 * This pins the parse itself, the fact that all three files share ONE
 * definition, and — through the REAL parser on a real-shaped payload — that a
 * credit stays a credit and the itemisation agrees with its own total.
 *
 * No database, no network.
 */

const fs = require('fs');
const path = require('path');

const parseNum = require('../src/longterm/lenderprice/parse-num');
const lp = require('../src/longterm/lenderprice/client');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * The live code, with the commentary taken out.
 *
 * A must-not-appear check has to read what RUNS, not what is written ABOUT it:
 * the comment recording that `replace(/[^0-9.]/g, '')` deleted a minus sign
 * necessarily QUOTES that expression, so a guard reading the whole file fails on
 * the very explanation that stops somebody re-introducing it — and is then
 * "fixed" by deleting the explanation. `test-app-dialog-pure.mjs` strips
 * comments before its own sweep for exactly this reason.
 *
 * Line-based on purpose: it drops whole comment lines rather than trying to
 * parse the language, so it can never mangle a regex literal — and a
 * SIGN-STRIPPING PARSE IS A STATEMENT, never a trailing remark, so nothing that
 * matters can hide from it.
 */
const codeOf = (p) => read(p)
  .split('\n')
  .filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .join('\n');

// ── THE ONE THAT MATTERS: the sign is the meaning ──────────────────────────
console.log('a minus sign is never stripped');

check(parseNum.num(-0.375) === -0.375,
  'THE ONE THAT MATTERS: a negative number the vendor sent stays negative — it is the difference between a credit and a charge');
check(parseNum.num('-0.375') === -0.375, '…and the same figure sent as text');
check(parseNum.num('-1') === -1, '…and a whole negative, which the old parse read as +1');
check(parseNum.num(-0.25) === -0.25, '…and a negative margin, which is what a lender keeps');

console.log('\nformatting is tolerated, corruption is refused');
check(parseNum.num('$1,200') === 1200, 'a formatted amount is a number');
check(parseNum.num('1.5%') === 1.5, '…and so is a percentage');
check(parseNum.num('0.25') === 0.25, '…and a plain decimal');
check(parseNum.num('12abc3') === null,
  '"12abc3" is not 123 — salvaging digits out of a corrupted value prices the loan on a number nobody sent');
check(parseNum.num('1e3') === null, '"1e3" is not 13 — the same corruption written another way');
check(parseNum.num('--0.5') === null, 'and a double sign is not a number');

console.log('\na thing that is not a number is not a number');
for (const [label, v] of [['true', true], ['an array', []], ['[1.15]', [1.15]], ['a Date', new Date(0)], ['an object', {}]]) {
  check(parseNum.num(v) === null,
    `${label} reads as absent — Number(${label}) is a finite, perfectly innocent figure, which is how one lands on a screen`);
}
check(parseNum.num('') === null && parseNum.num(null) === null && parseNum.num(undefined) === null,
  'and a blank is absent rather than zero');

console.log('\nabsent and unreadable are told apart where a caller needs it');
check(parseNum.strictNum(null) === null && parseNum.strictNum('') === null, 'absent is null');
check(parseNum.strictNum('12abc3') === undefined && parseNum.strictNum(true) === undefined,
  'present-but-unreadable is undefined, so a validator can refuse it instead of pricing as though the field were blank');
check(parseNum.strictNum('-1.125') === -1.125, '…and a real figure is just the figure, sign and all');

// ── ONE DEFINITION, not three that disagree ────────────────────────────────
//
// This is the shape of the defect, not a tidiness preference: the fix was
// applied to two of the three copies and the third kept pricing.
console.log('\nall three vendor readers share the one definition');

const USERS = [
  'src/longterm/lenderprice/client.js',
  'src/longterm/lenderprice/field-registry.js',
  'src/longterm/lenderprice/search-model.js',
];
for (const f of USERS) {
  const src = codeOf(f);
  check(/require\('\.\/parse-num'\)/.test(src), `${path.basename(f)} takes its number parse from parse-num.js`);
  check(!/replace\(\/\[\^0-9\.\]/.test(src),
    `…and no longer carries the sign-stripping expression`);
  check(!/^function num\(v\) \{/m.test(src) && !/^function strictNum\(v\) \{/m.test(src),
    `…and does not re-declare one of its own, which is how the three drifted apart`);
}

// ── Through the REAL parser, on a real-shaped priced payload ───────────────
//
// The parse being right in isolation is not the claim. The claim is that a
// credit reaches the screen as a credit.
console.log('\nand a credit survives the real parser, agreeing with its own total');

const leafWith = (adj) => ({
  results: {
    lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'Deephaven Mortgage', shortName: 'DHVN' }] },
    qualifiedNonQMData: {
      key: [], keyLabel: 'ROOT', type: null,
      childs: [{
        type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
        childs: [{
          type: 'RateKey', keyLabel: '7.125',
          childs: [{
            type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"', childs: [],
            leafs: [{
              companyName: 'Deephaven Mortgage', programName: 'DSCR 30 Yr Fixed', productName: 'DSCR 30 Yr Fixed',
              rate: 7.125, baseRates: 7.125, basePoints: -3.75,
              adjustmentPoints: adj, adjustedPoints: -3.75 + adj,
              groupAdjustmentProperties: [{
                name: 'LTV/FICO',
                adjustments: [{ key: 'FICO 780+ credit', adjType: 'FicoLtvRateAdjustment', type: 'LLPA', valueType: 'Points', adj }],
              }],
              holdBackResult: { lender: { adjustments: [{ key: 'NDC Margin', type: 'Margin', valueType: 'Points', adj: -0.25 }] } },
            }],
          }],
        }],
      }],
    },
  },
});
const optionOf = (adj) => {
  const f = lp.parseFull(leafWith(adj));
  const opts = f.options || (f.programs && f.programs[0] && f.programs[0].options) || [];
  return opts[0];
};

const credit = optionOf(-0.9);
check(!!credit, 'the real parser found the priced option');
check(credit && credit.adjustments[0].value === -0.9,
  'THE ONE THAT MATTERS: a −0.9 point credit is itemised as −0.9, not +0.9');
check(credit && credit.priceBuild.adjustmentPoints === credit.adjustments[0].value,
  '…and the itemisation agrees with the stack total above it — they disagreed by twice the figure, on one screen');
check(credit && credit.holdback.lender[0].value === -0.25,
  'a negative lender margin keeps its sign too');

const charge = optionOf(0.9);
check(charge && charge.adjustments[0].value === 0.9 && charge.priceBuild.adjustmentPoints === 0.9,
  'and a real CHARGE is unchanged — the fix moved the negative case only');
check(charge && charge.priceBuild.basePoints === -3.75,
  '…while the sign-safe road that always worked still works, so nothing was traded for this');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
