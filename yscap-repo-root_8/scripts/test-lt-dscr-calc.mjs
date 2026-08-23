/**
 * THE DSCR CALCULATOR — the browser mirror held against the server's own rule.
 *
 * The ratio is settled, owner-confirmed knowledge (src/longterm/encompass/formulas.js,
 * confirmed 2026-08-14): DSCR = Round(monthly qualifying rent / proposed total monthly
 * housing expense, 2), the denominator being the true PITIA. The screen cannot require
 * server code, so app-v2/src/longterm/dscrCalc.js mirrors it — and a mirror nobody checks
 * is how two definitions of one number come to disagree, with the one that drifts being the
 * one somebody quotes off. So this runs BOTH over a battery and fails on any disagreement.
 *
 * Pure: no database, no network, no bundler. Runs on CI.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const requireRepo = createRequire(path.join(repo, 'package.json'));

let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const near = (a, b, eps = 0.005) => a != null && b != null && Math.abs(a - b) <= eps;

const D = await import(new URL('../app-v2/src/longterm/dscrCalc.js', import.meta.url));
const server = requireRepo('./src/longterm/encompass/formulas.js');

console.log('\nthe ratio is the tenant\'s own, and the mirror agrees with the server');

// ── 1. THE MIRROR vs THE SERVER, over a battery ─────────────────────────────
{
  let checked = 0; let disagreed = 0;
  for (const rent of [0.01, 900, 2450, 2850, 3500, 6000, 12000, 100000]) {
    for (const pitia of [1, 1700.81, 1983.47, 2954.69, 4549.20, 4949.12, 9999.99]) {
      // Drive OUR module through a zero-rate interest-only loan whose P&I is exactly the
      // gap, so the two are asked about the identical pair of numbers rather than about
      // two calculations that merely ought to land in the same place.
      const mine = D.dscrFrom({
        loanAmount: 1, ratePct: 0, interestOnly: true, termYears: 30,
        rentMonthly: rent, taxMonthly: pitia, insuranceMonthly: 0, hoaMonthly: 0,
      });
      const theirs = server.computeDscr(rent, pitia);
      checked += 1;
      if (!near(mine.dscr, theirs, 0.0001)) { disagreed += 1; console.log(`   ${rent}/${pitia}: mine ${mine.dscr} vs server ${theirs}`); }
    }
  }
  ok(checked === 56 && disagreed === 0,
    `M1 the browser mirror and the server agree on all ${checked} ratios`);
}

// The owner-verified example rows recorded in formulas.js, recomputed here.
{
  const rows = [[2450, 1700.81, 1.44], [6000, 4949.12, 1.21], [2850, 4549.20, 0.63], [4575, 1983.47, 2.31]];
  let good = 0;
  for (const [rent, pitia, want] of rows) {
    const mine = D.dscrFrom({ loanAmount: 1, ratePct: 0, interestOnly: true, termYears: 30,
      rentMonthly: rent, taxMonthly: pitia, insuranceMonthly: 0, hoaMonthly: 0 });
    if (mine.dscr === want) good += 1; else console.log(`   ${rent}/${pitia} -> ${mine.dscr}, recorded ${want}`);
  }
  ok(good === rows.length, 'M2 …and reproduces every row the tenant\'s own verification recorded');
}

// ── 2. THE PAYMENT ──────────────────────────────────────────────────────────
console.log('\nthe payment: interest-only, fully amortising, and the edges');
{
  // Interest only is loan x monthly rate and does NOT move with the term, because during an
  // interest-only period nothing is being repaid.
  const a = D.monthlyPI({ loanAmount: 375000, ratePct: 7.375, termYears: 30, interestOnly: true });
  const b = D.monthlyPI({ loanAmount: 375000, ratePct: 7.375, termYears: 15, interestOnly: true });
  ok(near(a, 2304.69) && a === b, `P1 interest-only is loan x rate (${a}) and is the same on any term`);

  // Fully amortising, checked against the closed form computed independently here.
  const P = 375000; const r = 7.375 / 100 / 12; const n = 360;
  const want = (P * r) / (1 - Math.pow(1 + r, -n));
  const got = D.monthlyPI({ loanAmount: P, ratePct: 7.375, termYears: 30, interestOnly: false });
  ok(near(got, want), `P2 fully amortising matches the level-payment formula (${got})`);

  // A shorter term costs MORE a month — the direction is the whole reason the term is on screen.
  const t15 = D.monthlyPI({ loanAmount: P, ratePct: 7.375, termYears: 15, interestOnly: false });
  const t40 = D.monthlyPI({ loanAmount: P, ratePct: 7.375, termYears: 40, interestOnly: false });
  ok(t15 > got && got > t40, `P3 15yr (${t15}) > 30yr (${got}) > 40yr (${t40})`);

  // A zero rate would divide by zero in the formula; it is answered directly instead.
  ok(D.monthlyPI({ loanAmount: 360000, ratePct: 0, termYears: 30, interestOnly: false }) === 1000,
    'P4 a zero rate is the principal spread over the term, not a division by zero');

  // NEVER A GUESS.
  ok(D.monthlyPI({ loanAmount: 0, ratePct: 7, termYears: 30 }) === null
    && D.monthlyPI({ loanAmount: 375000, termYears: 30 }) === null
    && D.monthlyPI({ loanAmount: 375000, ratePct: 7 }) === null
    && D.monthlyPI({ loanAmount: 375000, ratePct: -1, termYears: 30 }) === null,
  'P5 a missing or absurd input yields NO payment rather than a guess');
}

// ── 3. MONTHLY vs YEARLY ────────────────────────────────────────────────────
console.log('\nthe yearly switch');
{
  ok(D.perMonth(1800, 'yearly') === 150 && D.perMonth(150, 'monthly') === 150,
    'Y1 a yearly figure is divided by twelve; a monthly one is left alone');
  // An unreadable basis shows what was typed rather than quietly dividing it by twelve — the
  // field says "monthly" on its face, so that is the safe reading.
  ok(D.perMonth(150, undefined) === 150 && D.perMonth(150, 'nonsense') === 150,
    'Y2 an unrecognised basis reads as monthly, never as a silent divide');
  ok(D.perMonth(null, 'yearly') === null && D.perMonth('abc', 'yearly') === null,
    'Y3 a blank stays blank');
}

// ── 4. A BLANK IS NEVER A ZERO ──────────────────────────────────────────────
console.log('\na blank is never a zero — and the screen is told what is missing');
{
  const noRent = D.dscrFrom({ loanAmount: 375000, ratePct: 7, termYears: 30, taxMonthly: 500, insuranceMonthly: 150 });
  ok(noRent.dscr === null && noRent.missing.includes('rent'), 'B1 no rent -> no ratio, and it says so');

  const noTax = D.dscrFrom({ loanAmount: 375000, ratePct: 7, termYears: 30, rentMonthly: 3500, insuranceMonthly: 150 });
  ok(noTax.dscr === null && noTax.missing.includes('property tax'),
    'B2 a missing tax is NOT treated as zero tax, which would flatter the ratio');

  const noRate = D.dscrFrom({ loanAmount: 375000, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  ok(noRate.dscr === null && noRate.missing.includes('rate'), 'B3 no rate -> no ratio');

  // HOA is the ONE default, and it is the owner's: blank means none.
  const noHoa = D.dscrFrom({ loanAmount: 375000, ratePct: 7.375, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  const zeroHoa = D.dscrFrom({ loanAmount: 375000, ratePct: 7.375, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150, hoaMonthly: 0 });
  ok(noHoa.dscr != null && noHoa.dscr === zeroHoa.dscr, 'B4 a blank HOA is zero, which is the owner\'s own default');

  ok(D.dscrFrom(null).dscr === null && D.dscrFrom(undefined).missing.length > 0,
    'B5 no input at all is answered, not thrown');

  // WHAT IS MISSING MUST BE THE THING THAT IS MISSING. Sending somebody to the rate box because
  // the loan amount happened to be filled in is a message that wastes their time.
  const noLoan = D.dscrFrom({ ratePct: 7, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  ok(noLoan.missing.includes('loan amount') && !noLoan.missing.includes('rate'),
    'B6 no loan amount names the loan amount, not the rate');
  const noTerm = D.dscrFrom({ loanAmount: 375000, ratePct: 7, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  ok(noTerm.dscr === null && noTerm.missing.includes('loan term') && !noTerm.missing.includes('rate'),
    'B7 an amortising payment with no term names the term, not the rate');
  // …and interest-only genuinely does not need one, which is the whole reason B7 can be true.
  const ioNoTerm = D.dscrFrom({ loanAmount: 375000, ratePct: 7, interestOnly: true, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  ok(ioNoTerm.dscr != null, 'B8 …while interest-only needs no term at all');
}

// ── 5. IT MOVES WITH THE SCENARIO ───────────────────────────────────────────
console.log('\nthe ratio follows the scenario — that is the point of it being live');
{
  const base = { loanAmount: 375000, ratePct: 7.375, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 };
  const amort = D.dscrFrom(base);
  const io = D.dscrFrom({ ...base, interestOnly: true });
  ok(io.dscr > amort.dscr, `S1 ticking interest-only RAISES the ratio (${amort.dscr} -> ${io.dscr})`);

  const t40 = D.dscrFrom({ ...base, termYears: 40 });
  ok(t40.dscr > amort.dscr, `S2 a longer term raises it too (${amort.dscr} -> ${t40.dscr})`);

  const cheaper = D.dscrFrom({ ...base, ratePct: 6.5 });
  ok(cheaper.dscr > amort.dscr, `S3 a lower rate raises it (${amort.dscr} -> ${cheaper.dscr})`);

  // On interest-only the TERM cannot matter, because nothing is being repaid.
  const io15 = D.dscrFrom({ ...base, interestOnly: true, termYears: 15 });
  ok(io15.dscr === io.dscr, 'S4 …but on interest-only the term changes nothing');

  ok(near(amort.pitia, amort.pi + amort.tax + amort.insurance + amort.hoa),
    'S5 the parts add up to the total the ratio divides by');
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
