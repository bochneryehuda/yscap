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

console.log('\nthe ratio is the tenant\'s own — CUT DOWN, never rounded up to meet it');

/**
 * ⛔ THIS PAIR ASSERTED EQUALITY WITH THE TENANT'S FIELD AND IS RE-POINTED, NOT LOOSENED.
 *
 * The owner, 2026-08-30: *"The DSCR should always be rounded down, and the LTV should
 * always be rounded up, so we should never see better."* So our figure is DELIBERATELY
 * not the tenant's: `Round(x, 2)` — Encompass's own `CUST01FV` formula, owner-confirmed
 * 2026-08-14 and recorded in `formulas.js` as settled knowledge that must not be
 * re-derived — rounds to NEAREST, and can therefore land a cent ABOVE what the property
 * actually earns. Ours may never do that.
 *
 * The two answer DIFFERENT QUESTIONS and both are right: `computeDscr` answers *"what does
 * Encompass's field say?"*, which is a fact about a foreign system; ours answers *"what may
 * we search, show and quote on?"*, which is the owner's rule. What must still hold — and
 * what the drift this suite exists to catch would break — is the RELATIONSHIP between them:
 * never above, never more than one cent below, and exactly the raw ratio cut down.
 */
{
  let checked = 0; let above = 0; let farOff = 0; let notCut = 0;
  const cutDown = (x) => Math.floor((x * 100) + 1e-9) / 100;
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
      // ⛔ THE ONE THAT MATTERS: a figure ABOVE the tenant's is the owner's "seeing better".
      if (mine.dscr > theirs + 1e-9) { above += 1; console.log(`   ABOVE ${rent}/${pitia}: mine ${mine.dscr} vs tenant ${theirs}`); }
      // …and a figure far BELOW it would be a different bug — a cut is one cent, never more.
      if (theirs - mine.dscr > 0.01 + 1e-9) { farOff += 1; console.log(`   FAR ${rent}/${pitia}: mine ${mine.dscr} vs tenant ${theirs}`); }
      // And it is the RAW ratio cut down, not the tenant's already-rounded figure cut down —
      // 0.999 rounds to 1.00 and cutting THAT leaves 1.00, which is exactly the cent this
      // rule exists to refuse.
      if (!near(mine.dscr, cutDown(rent / pitia), 1e-9)) { notCut += 1; console.log(`   NOTCUT ${rent}/${pitia}: mine ${mine.dscr} vs cut ${cutDown(rent / pitia)}`); }
    }
  }
  ok(checked === 56 && above === 0,
    `M1 over all ${checked} ratios ours is NEVER above the tenant's — the owner's "never see better"`);
  ok(farOff === 0 && notCut === 0,
    'M1b …and is exactly the raw ratio cut to the cent, never the tenant\'s rounded figure cut again');
}

/* The owner-verified example rows recorded in `formulas.js` — the tenant's OWN stored
   ratios — with what our rule makes of each. Two of the four differ by a cent, and those
   two are the rule working: 2850/4549.20 is 0.6265, which Encompass stores as 0.63 and we
   may not quote as 0.63. Every figure below is computed by hand from the recorded pair,
   never read off a run. */
{
  const rows = [
    [2450, 1700.81, 1.44, 1.44], // 1.4405 — agrees
    [6000, 4949.12, 1.21, 1.21], // 1.2123 — agrees
    [2850, 4549.20, 0.63, 0.62], // 0.6265 — the tenant rounds UP; we may not
    [4575, 1983.47, 2.31, 2.30], // 2.3066 — the tenant rounds UP; we may not
  ];
  let good = 0; let sane = 0;
  for (const [rent, pitia, tenant, want] of rows) {
    const mine = D.dscrFrom({ loanAmount: 1, ratePct: 0, interestOnly: true, termYears: 30,
      rentMonthly: rent, taxMonthly: pitia, insuranceMonthly: 0, hoaMonthly: 0 });
    if (mine.dscr === want) good += 1; else console.log(`   ${rent}/${pitia} -> ${mine.dscr}, expected ${want}`);
    // A CONTROL on the fixture itself: the tenant's recorded figure must be what
    // `computeDscr` actually answers, or the row above is being compared to a typo.
    if (server.computeDscr(rent, pitia) === tenant) sane += 1;
  }
  ok(sane === rows.length, 'M2a CONTROL: every recorded row is what the tenant\'s own formula answers');
  ok(good === rows.length, 'M2 …and ours is each one cut down — never a cent better than the property earns');
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

  /* ⛔ B3 WAS RE-POINTED, NOT LOOSENED (owner-directed 2026-09-01: *"we shouldn't need to put in a
     target rate… go by the average"*). It used to assert that no rate meant NO ratio, which was
     the right assertion under the old rule and is now the defect the owner reported. The rate is
     the ONE input that became optional, so the assertion moved to what is now true and is
     STRONGER for it: a blank rate produces a real ratio, at the shared assumed coupon, and SAYS
     it assumed — the last part being what stops an assumed rate reading as a chosen one. Every
     other blank on either side of it (B1, B2, B4-B8) is untouched and still refused. */
  const noRate = D.dscrFrom({ loanAmount: 375000, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  ok(noRate.dscr !== null && !noRate.missing.includes('rate'),
    `B3 no rate -> the ratio is still worked out (${noRate.dscr})`);
  ok(noRate.rateAssumed === true && noRate.ratePctUsed === D.TYPICAL_RATE_PCT,
    `B3b …at the assumed ${D.TYPICAL_RATE_PCT}%, and it says so rather than passing it off as chosen`);
  const badRate = D.dscrFrom({ loanAmount: 375000, ratePct: -2, termYears: 30, rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: 150 });
  ok(badRate.dscr === null && badRate.missing.includes('rate'),
    'B3c ⛔ …while a rate that IS typed and is wrong is still refused, never assumed past');

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
