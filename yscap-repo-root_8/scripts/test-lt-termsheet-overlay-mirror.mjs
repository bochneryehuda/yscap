/**
 * LT TERM SHEETS — THE MIRROR DRIFT GUARD.
 *
 * `src/longterm/termsheet/overlay.js` is the SERVER's copy of the compensation
 * overlay; `app-v2/src/longterm/compOverlay.js` is the browser's. Two copies of
 * one rule drift, and the one that drifts is the one that leaks — here it would
 * leak as a term sheet whose printed figures disagree with the board the officer
 * was reading when they issued it.
 *
 * So BOTH modules are loaded and run over the same battery, and this fails the
 * build the moment they answer differently about a single figure. It spans every
 * branch on purpose: the two issuable comp positions and raw, prices above, at
 * and below par, a waive whose credit covers the fees and one whose credit
 * cannot, and every refusal.
 *
 * IT RUNS BOTH — never one against a table of expected values. A table is a
 * third copy, and it would go stale in exactly the same way.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const server = require('../src/longterm/termsheet/overlay.js');
const browser = await import('../app-v2/src/longterm/compOverlay.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

console.log('\nboth copies answer the same, everywhere');

const PLANS = [
  { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 },
  { borrowerPaid: 1.5, ysp: 0, lenderPaid: 2.25, applicationFee: 0, commitmentFee: 2095 },
  { borrowerPaid: 0, ysp: 0, lenderPaid: 0, applicationFee: 0, commitmentFee: 0 },
  // Every shape that must fail to NOTHING rather than to a wrong number:
  // `Number(null)` and `Number('')` are both a finite, completely wrong 0.
  null, undefined, {}, 'nonsense', 42,
  { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500 },
  { borrowerPaid: 2, ysp: null, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 },
  { borrowerPaid: 2, ysp: '', lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 },
  { borrowerPaid: 2, ysp: -1, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 },
  { borrowerPaid: 2, ysp: 'x', lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 },
];
const MODES = ['borrowerPaid', 'lenderPaid', 'raw', 'nonsense', null, undefined];
// Above par, at par, below par, and the extremes.
const PRICES = [104.5, 103.75, 102.001, 102, 101.75, 100.5, 100, 99.75, 98.25, 95, 0, -1, null, NaN, 'x'];
const LOANS = [375000, 1000000, 87500, 250000.55, 0, -1, null, 'x'];
const WAIVES = [false, true];
const DEALS = [
  { purpose: 'Purchase', propertyValue: 500000, loanAmount: 375000 },
  { purpose: 'Refinance', propertyValue: 500000, loanAmount: 375000 },
  { purpose: null, propertyValue: null, loanAmount: 375000 },
  {},
];

const norm = (v) => JSON.stringify(v === undefined ? '__undefined__' : v);

let cases = 0;
let mismatch = null;
for (const plan of PLANS) {
  for (const mode of MODES) {
    const a = server.compShiftPoints(mode, plan);
    const b = browser.compShiftPoints(mode, plan);
    cases += 1;
    if (norm(a) !== norm(b) && !mismatch) mismatch = `compShiftPoints(${mode}, ${JSON.stringify(plan)}): ${norm(a)} vs ${norm(b)}`;

    const pa = server.normalizePlan(plan);
    const pb = browser.normalizePlan(plan);
    cases += 1;
    if (norm(pa) !== norm(pb) && !mismatch) mismatch = `normalizePlan(${JSON.stringify(plan)}): ${norm(pa)} vs ${norm(pb)}`;

    for (const price of PRICES) {
      cases += 1;
      if (norm(server.shiftedPrice(price, a)) !== norm(browser.shiftedPrice(price, b)) && !mismatch) {
        mismatch = `shiftedPrice(${price}, ${a})`;
      }
      for (const loan of LOANS) {
        for (const waive of WAIVES) {
          const ca = server.quoteCharges(mode, plan, price, loan, waive);
          const cb = browser.quoteCharges(mode, plan, price, loan, waive);
          cases += 1;
          if (norm(ca) !== norm(cb) && !mismatch) {
            mismatch = `quoteCharges(${mode}, plan, ${price}, ${loan}, ${waive}):\n    server ${norm(ca)}\n    browser ${norm(cb)}`;
          }
          for (const deal of DEALS) {
            cases += 1;
            const sa = server.closingSheet(ca, deal);
            const sb = browser.closingSheet(cb, deal);
            if (norm(sa) !== norm(sb) && !mismatch) {
              mismatch = `closingSheet(${mode}, ${price}, ${loan}, ${waive}, ${JSON.stringify(deal)}):\n    server ${norm(sa)}\n    browser ${norm(sb)}`;
            }
          }
        }
      }
    }
  }
}
check(!mismatch, `${cases.toLocaleString('en-US')} evaluations across every branch — the two copies agree on every figure${mismatch ? `\n       first disagreement: ${mismatch}` : ''}`);

// The battery is only worth anything if it actually REACHES the branches.
const reached = {
  credit: server.quoteCharges('borrowerPaid', PLANS[0], 103.75, 375000, false),
  buydown: server.quoteCharges('borrowerPaid', PLANS[0], 99.75, 375000, false),
  par: server.quoteCharges('borrowerPaid', PLANS[0], 102, 375000, false),
  waiveCovered: server.quoteCharges('lenderPaid', PLANS[0], 104.5, 375000, true),
  waiveShort: server.quoteCharges('lenderPaid', PLANS[0], 100.5, 375000, true),
  raw: server.quoteCharges('raw', PLANS[0], 102, 375000, false),
};
check(reached.credit && reached.credit.credit && reached.credit.credit.dollars > 0, 'the battery reaches a real CREDIT');
check(reached.buydown && reached.buydown.lines.some((l) => /buydown|rate/i.test(l.kind || l.label || '')),
  'and a real BUYDOWN');
check(reached.par && !(reached.par.credit && reached.par.credit.dollars > 0), 'and par, where there is neither');
check(reached.waiveCovered && reached.waiveShort, 'and a waive whose credit covers the fees AND one whose credit cannot');
check(reached.raw === null, 'and raw, which has no charging story at all');

// The one thing that must be true of the SERVER copy alone: raw can never be
// issued. The browser has no issuing door, so it carries no such list.
check(Array.isArray(server.ISSUABLE_MODES) && !server.ISSUABLE_MODES.includes('raw')
  && server.ISSUABLE_MODES.length === 2,
'the server copy alone declares what may be ISSUED, and raw is not on it');
// The two declarations are deliberately DIFFERENT SHAPES — the browser's carries
// the display LABEL for the switch it draws, which the server has no business
// knowing. What must agree is the ORDER, because that is the owner's own: "the
// middle should be raw pricing, and the left should be borrower-paid and the
// right lender-paid".
const browserOrder = browser.COMP_MODES.map((m) => (typeof m === 'string' ? m : m.value));
check(JSON.stringify(server.COMP_MODES) === JSON.stringify(browserOrder),
  `the three positions are in the same order in both copies — ${browserOrder.join(', ')}`);
check(browserOrder[1] === 'raw', '…with raw in the middle, exactly as the owner drew it');

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
