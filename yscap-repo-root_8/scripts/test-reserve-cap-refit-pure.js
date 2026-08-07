/**
 * A LADDER RUNG MUST NOT PUSH THE FINANCED INTEREST RESERVE PAST ITS CAP.
 * PURE — no DB, no network. Owner-directed 2026-08-07.
 *
 * THE DEFECT. `sizeLoan` fits the reserve against `capDesired(val, pmt)` — the
 * program's month cap times the payment. A later loan-to-cost guard then cuts the
 * loan on a rehab-dominant deal and recomputes the payment SMALLER, but never re-ran
 * that fit. So the reserve stayed sized against the old, larger payment and could
 * exceed its own documented ceiling — measured $76,713 (18.67 months) on an 18-month
 * Gold ground-up whose 75%-of-term cap is $55,455, and LARGER in dollars on the
 * smaller loan. The borrower financed, and paid origination and interest on, money
 * that can never accrue as interest within the term, and the note buyer's own
 * workbook cap was exceeded. `silver-shadow-parity` does not check the reserve, so
 * nothing flagged it.
 *
 * WHY IT NEEDED A LEVER TO SHOW UP: at the maximum rung the guard rarely binds. It is
 * the voluntary de-leverage — the whole subject of the price ladder — that shrinks the
 * loan into the guard. A matrix without `targetLTC` reports zero violations and proves
 * nothing, which is exactly what a first pass of this test did.
 *
 * THE BAR (the engines are FROZEN):
 *   A. A deal the guard never touches is BYTE-IDENTICAL to the engine without the fix.
 *   B. The fix can only ever REDUCE — never a larger loan.
 *   C. No priced deal leaves a reserve above its program's own month cap.
 * The baseline is built by STRIPPING the fix from today's engine (never from git —
 * a git baseline goes vacuous the moment the change is committed), and the strip is
 * asserted to have bitten so the proof can never be empty.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const dir = path.join(__dirname, '..', 'web/v2/tools');
const live = fs.readFileSync(path.join(dir, 'standard-program.js'), 'utf8');
const RE = /\n *\/\* RE-FIT THE RESERVE[\s\S]*?\n *\}\n *\}\n( *\}\n)/;
const m = live.match(RE);
if (!m) throw new Error('the re-fit block was not found — this proof cannot be built');
const base = live.replace(RE, '\n' + m[1]);
if (/gFit/.test(base)) throw new Error('the strip left the re-fit behind — the proof would be vacuous');

const bp = path.join(dir, `.std-refit-baseline-${process.pid}.js`);
const gp = path.join(dir, `.gold-refit-baseline-${process.pid}.js`);
let B, GB, L, GL;
try {
  fs.writeFileSync(bp, base);
  fs.writeFileSync(gp, fs.readFileSync(path.join(dir, 'gold-standard.js'), 'utf8')
    .replace(/(['"])\.\/standard-program\.js\1/g, `'./.std-refit-baseline-${process.pid}.js'`));
  B = require(bp); GB = require(gp);
  L = require(path.join(dir, 'standard-program.js'));
  GL = require(path.join(dir, 'gold-standard.js'));
} finally { /* files removed at the end */ }

const shape = (e) => {
  if (!e) return null; const s = e.sizing || {};
  return JSON.stringify({ st: e.status, r: e.noteRate, t: s.totalLoan, a: s.acquisition, rl: s.rehabLoan, ir: s.financedIR, d: s.downPayment });
};

const cases = [];
for (const state of ['NJ', 'TX', 'PA', 'OH'])
  for (const strategy of ['Fix & Flip', 'Ground-up Construction', 'Fix & Hold (BRRRR)'])
    for (const price of [250000, 558000, 900000])
      for (const rehab of [0, 150000, 400000, 800000])
        for (const arv of [900000, 1207500, 1365000, 2760000])
          for (const irMonths of [0, 6, 12])
            for (const fico of [700, 760])
              for (const lev of [0, 0.5, 0.55, 0.65, 0.75, 0.85])
                cases.push(Object.assign({
                  loanType: 'Purchase', strategy, state, propertyType: 'SFR (1 unit)', units: 1,
                  purchasePrice: price, asIsValue: price, arv, rehabBudget: rehab, fico,
                  term: /Ground/.test(strategy) ? 18 : 12, irMonths,
                  expFlips: 10, expHolds: 4, expGround: 10,
                }, lev ? { targetLTC: lev } : {}));

let checked = 0, drift = 0, corrected = 0, grew = 0, overBefore = 0, overAfter = 0, worst = null;
for (const [bE, lE, nm] of [[B, L, 'standard'], [GB, GL, 'gold']]) {
  for (const c of cases) {
    const b = bE.evaluate(c), l = lE.evaluate(c);
    const bs = (b && b.sizing) || {}, ls = (l && l.sizing) || {};
    checked++;
    if (!bs.rehabOverCap) { if (shape(b) !== shape(l)) drift++; }
    else {
      if (shape(b) !== shape(l)) corrected++;
      if ((ls.totalLoan || 0) > (bs.totalLoan || 0) + 0.5) grew++;
    }
    // The program's OWN documented month cap: full term on Standard; the frozen
    // 75%-of-term on Gold ground-up; zero on Gold renovation (no reserve exists).
    const capMo = nm === 'gold' ? (/Ground/.test(c.strategy) ? 0.75 * c.term : 0) : c.term;
    if (capMo > 0) {
      const bPmt = (bs.totalLoan || 0) * ((b.noteRate || 0) / 12);
      const lPmt = (ls.totalLoan || 0) * ((l.noteRate || 0) / 12);
      if ((bs.financedIR || 0) > capMo * bPmt + 1) {
        overBefore++;
        const over = (bs.financedIR || 0) - capMo * bPmt;
        if (!worst || over > worst.over) worst = { over, nm, c };
      }
      if ((ls.financedIR || 0) > capMo * lPmt + 1) overAfter++;
    }
  }
}

assert(checked > 20000, `A0 the matrix is broad — ${checked} evaluations across two engines`);
assert(drift === 0, `A1 a deal the guard never touches is BYTE-IDENTICAL to the engine without the fix (drift: ${drift})`);
assert(grew === 0, `B1 the fix can only ever REDUCE — no loan grew (violations: ${grew})`);
assert(overBefore > 0,
  `C0 the defect is REAL and the matrix reaches it — ${overBefore} deals financed a reserve above their own cap${worst ? ` (worst $${Math.round(worst.over).toLocaleString()} over, ${worst.nm})` : ''}`);
assert(corrected > 0, `C1 …and the fix changes exactly those deals (${corrected})`);
assert(overAfter === 0, `C2 NO priced deal leaves a reserve above its program's month cap (violations: ${overAfter})`);

try { fs.unlinkSync(bp); fs.unlinkSync(gp); } catch (_) {}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
