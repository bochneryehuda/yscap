'use strict';
/**
 * Pure (no-DB) test: a data tape — and the screen you pick loans on — identifies
 * a loan by OUR loan number, never the investor's.
 *
 * Owner-directed 2026-08-24: "we always prefer our loan number and keep the
 * investor's loan number somewhere else in the back."
 *
 * THE REPORT. A funded file the pipeline, search and its own header all call
 * YSCAP258134680 appeared on the bulk-tape screen as "32536". That is not an
 * internal number and not a fallback: `applications.investor_loan_number` is
 * pulled from ClickUp's separate "Investor Loan No" custom field
 * (clickup/mapper.js, dir:'pull'), so it is the CAPITAL PROVIDER's own number for
 * the loan — here CorrFirst's. The screen, and the Fidelis tape, simply preferred
 * it over ours.
 *
 * WHY IT IS WORTH A GUARD RATHER THAN A ONE-LINE FLIP. `investor_loan_number` is
 * a SINGLE column that records no WHICH-investor. Since the bulk tape began
 * letting any loan go on any provider's tape (owner-directed 2026-08-23), a loan
 * carrying CorrFirst's number would have shipped that number to FIDELIS as the
 * loan number — a stranger's identifier on their sheet, able to collide with one
 * of their own loans. Fidelis was the only tape that did this; EMCAP and Blue
 * Lake have always sent ours.
 *
 * Pinned here:
 *   A. every tape's loan-number column, and every tape filename, prefers
 *      `ys_loan_number` — including when an investor number is present, which is
 *      the case that was broken;
 *   B. the investor's number is still the FALLBACK (a file with no YS number is
 *      identified, not left blank);
 *   C. the bulk-mismatch report and the investor email agree with the tapes;
 *   D. the picker screen leads with ours and keeps the investor's in the back.
 *
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fidelis = require('../src/lib/tapes/fidelis');
const emcap = require('../src/lib/tapes/emcap');
const bluelake = require('../src/lib/tapes/bluelake');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// The owner's own file: our number, and CorrFirst's number on the same loan.
const YS = 'YSCAP258134680';
const INV = '32536';

function loan(over) {
  const app = Object.assign({
    ys_loan_number: YS, investor_loan_number: INV,
    program: 'Fix & Flip w/ Construction', loan_type: 'Purchase', rehab_type: 'heavy',
    property_type: 'SFR', property_address: {}, units: 1,
    purchase_price: 150000, as_is_value: 150000, arv: 260000, rehab_budget: 60000,
    loan_amount: 150000, rate_pct: null, term: '12', requested_ir_amount: 0,
    accrual_type: 'non_dutch', rental_income: 0, costs_already_paid: 0,
    sqft_pre: 1200, sqft_post: 1600, actual_closing: '2026-01-02',
    est_closing_date: '2026-01-02', first_payment_date: '2026-03-01',
    maturity_date: '2027-02-01', estimated_rental_income: 1800,
  }, (over && over.app) || {});
  return {
    found: true, app,
    fico: 742, address: { line1: '2927 Canton St', city: 'Detroit', state: 'MI', zip: '48207' },
    borrower: { first: 'Reuven Chaim', last: 'Steimetz', citizenship: 'US Citizen', fico: 742 },
    coBorrower: null, vesting: { llc: 'Steimetz Holdings LLC', individual: false },
    registration: { program: 'standard', total_loan: 150000 },
    quote: { noteRate: 0.10625, origPct: 0.02, sizing: { totalLoan: 150000, initialAdvance: 90000, rehabHoldback: 60000, financedReserve: 0 } },
    appraisal: { form_type: 'FNM1004', as_is_value: 150000, arv_value: 260000, units: 1, gla: 1200, beds: 3, baths_full: 1, baths_half: 0 },
    exp: { flips: 2, holds: 0, ground: 0, total: 2, verified: { flips: 2, holds: 0, ground: 0 }, verifiedTotal: 2 },
    repeatBorrower: false, noteBuyerRaw: 'CorrFirst', releases: [], supplemental: {},
  };
}
const cellOf = (tape, l, col) => tape.buildRow(l).find((c) => c.col === col);

// ---- A. the loan-number column on every tape --------------------------------
// [tape, the column its own header calls the loan number]
const LOAN_NO_COLUMN = [[fidelis, 'A'], [emcap, 'A'], [bluelake, 'D']];
for (const [tape, col] of LOAN_NO_COLUMN) {
  const withBoth = cellOf(tape, loan(), col);
  ok(withBoth.value === YS,
    `${tape.key}: ${col} carries OUR loan number even when the investor's is on the file — got ${JSON.stringify(withBoth.value)}`);
  ok(withBoth.value !== INV, `${tape.key}: ${col} is never the investor's number`);

  // B. still identified when we have no number of our own.
  const noYs = cellOf(tape, loan({ app: { ys_loan_number: null } }), col);
  ok(noYs.value === INV, `${tape.key}: ${col} falls back to the investor's number when ours is missing`);

  // Neither number → blank, never the string "null"/"undefined".
  const neither = cellOf(tape, loan({ app: { ys_loan_number: null, investor_loan_number: null } }), col);
  ok(neither.value === '', `${tape.key}: ${col} is blank when the file carries no loan number at all`);
}

// ---- A2. the filenames --------------------------------------------------------
for (const tape of [fidelis, emcap, bluelake]) {
  const name = tape.filename(loan());
  ok(name.indexOf(YS) > -1, `${tape.key}: the file is named by OUR loan number — got ${name}`);
  ok(name.indexOf(INV) === -1, `${tape.key}: the investor's number is not the filename — got ${name}`);
  const fb = tape.filename(loan({ app: { ys_loan_number: null } }));
  ok(fb.indexOf(INV) > -1, `${tape.key}: the filename falls back to the investor's number when ours is missing`);
}

// ---- C. the bulk-mismatch report + the investor email agree ------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tapes', 'index.js'), 'utf8');
  ok(/loanNo:\s*loan\.app\.ys_loan_number\s*\|\|\s*loan\.app\.investor_loan_number/.test(src),
    'the bulk "these were skipped" report names a loan by OUR number');
  const send = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tapes', 'investor-send.js'), 'utf8');
  ok(/app\.ys_loan_number\s*\|\|\s*app\.investor_loan_number/.test(send),
    'the investor email subject names a loan by OUR number');
}

// ---- C2. SOURCE GUARD over the WHOLE RTL codebase ---------------------------
/* The behaviour tests above prove today's three tapes. This catches the fourth
   tape somebody adds next year, a revert of any of the three, and — because the
   owner widened the rule to "across the board for all the tape exports, for all
   the term sheets, for all the emails" (2026-08-24) — ANY RTL module that starts
   identifying a loan by the investor's number.

   Long-Term is deliberately excluded: `lt_loan_investors.investor_loan_number`
   is a per-investor column on that product's own table, a different thing from
   this single RTL column, and the two products never share a rule.

   Comments are stripped first: the explanation of this very fix necessarily
   spells the wrong order, and a guard that read comments would fail on its own
   reason and then get "fixed" by deleting the explanation. */
{
  const ROOT = path.join(__dirname, '..');
  const SKIP_DIRS = new Set(['node_modules', '.git', 'longterm', 'portal', 'assets', 'dist', 'build']);
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!/\.(js|jsx)$/.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(ROOT, full);
      if (rel.startsWith('scripts' + path.sep)) continue;          // tests may name the wrong order
      const src = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      // ours-must-win, in either the snake_case (server) or camel (client) shape
      if (/investor_loan_number\s*\|\|\s*[\w.]*\bys_loan_number/.test(src)
        || /investorLoanNumber\s*\|\|\s*[\w.]*\bysLoanNumber/.test(src)) offenders.push(rel);
    }
  };
  for (const top of ['src', 'app-v2/src', 'app/src', 'web/v2/tools', 'web/tools']) {
    const d = path.join(ROOT, top);
    if (fs.existsSync(d)) walk(d);
  }
  ok(offenders.length === 0,
    `no RTL module identifies a loan by the investor's number before ours — offenders: ${offenders.join(', ') || 'none'}`);
}

// ---- D. the picker screen ----------------------------------------------------
{
  const screen = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'StaffTapes.jsx'), 'utf8');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(/const loanNo\s*=\s*\(l\)\s*=>\s*l\.ys_loan_number\s*\|\|\s*l\.investor_loan_number/.test(code),
    'the tape picker leads with OUR loan number (this is the line the owner was looking at)');
  ok(!/const loanNo\s*=\s*\(l\)\s*=>\s*l\.investor_loan_number/.test(code),
    'the tape picker no longer leads with the investor number');
  // …and the investor's number is still ON the screen, in the back.
  ok(/const investorNo\s*=/.test(code) && /investorNo\(l\)/.test(code),
    'the investor number is kept in the back on the row, not thrown away');
  ok(/Investor #/.test(screen), 'the secondary line says whose number it is');
}

console.log(`test-tape-loan-number-pure: OK (${passed} assertions)`);
