/**
 * DOES THE PRICE BUILD LAND ON THE PRICE WE PRINT — server and browser, one rule.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Owner-reported 2026-09-04: our board and LoanNEX's own screen disagreed by 0.875 on a
 * single adjustment line. That one turned out to be two different loans — the owner's
 * verdict was *"That pricing was not an issue at all. It was perfect. The scenario was
 * different."* — but finding that out took a day, and the reason it took a day is that
 * NOTHING IN THE SYSTEM COULD HAVE TOLD THE TWO APART.
 *
 * The check that was supposed to catch a wrong price could not fail. `breakdown.totalsOf`
 * compares the itemized lines against `adjustmentPoints`; on a LoanNEX row both are
 * derived from the same array (`quote-shape` makes each line's `value` from the vendor's
 * `priceAdjustment`, then makes `adjustmentPoints` by summing those values), so it is the
 * same numbers added twice. Mutation-proven by an audit: a line set to +0.125, to 99, and
 * to null all left `reconciles === true`.
 *
 * And LoanNEX is precisely the vendor where a real disagreement is possible, because a
 * row's PRICE comes from the search call and its ITEMISATION from a separate on-demand
 * call. Nothing compared them. A panel could draw a running total landing 0.875 from the
 * Final price printed directly beneath it, silently, on a row that looked perfect — and
 * the board elects the HIGHER price and sorts highest first, so an overstated row is
 * exactly the one an officer picks.
 *
 * THE CHECK HERE NEEDS NO VENDOR COOPERATION: does base + adjustments equal the points
 * behind the price we are showing? True of every row from every sheet.
 *
 * ── WHY IT RUNS THE BROWSER'S REAL TEXT ────────────────────────────────────
 *
 * The panel computes its own totals in the browser (it is handed `o.priceBuild`, not the
 * server's breakdown), so the rule necessarily exists twice — the `lib/payoff.js`
 * arrangement this repo already uses. A mirror test that asserted the two files merely
 * LOOK alike would prove nothing, so this EXTRACTS the two arithmetic lines from
 * `LtPricer.jsx` and EXECUTES them against the same battery the server's `landingOf`
 * runs. If somebody changes one side's tolerance, its sign, or which fields it reads,
 * this fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const breakdown = require(path.join(repo, 'src/longterm/pricing/breakdown.js'));

let n = 0;
let failures = 0;
const ok = (c, w) => { n += 1; if (c) console.log('  ok  ', w); else { failures += 1; console.log(' FAIL ', w); } };

// ── the browser's own two lines, lifted out of the shipped source and RUN ───
const SRC = readFileSync(path.join(repo, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8');
const gapM = SRC.match(/const landGap = \([\s\S]*?;\n/);
const landM = SRC.match(/const landsOnPrice = .*?;\n/);
ok(!!gapM && !!landM, 'A1 the browser mirror was found in LtPricer.jsx — if this fails the guard is testing nothing');
if (!gapM || !landM) { console.log(`\nFAILURES: ${failures} of ${n}`); process.exit(1); }

/* Built from the REAL text, with only the surrounding names supplied. `nn` is the
   screen's own finite-number test, restated here exactly as `format.js` defines it. */
const browserLanding = new Function('base', 'b', `
  const nn = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  ${gapM[0]}
  ${landM[0]}
  return { gapPoints: landGap, landsOnPrice };
`);

/* ── the battery: every shape a real row takes, plus the incident ──────────── */
const CASES = [
  { what: 'a healthy LoanNEX row (the owner\'s quote, priced correctly)',
    basePoints: -0.59, adjustmentPoints: -0.75, adjustedPoints: -1.34, lands: true },
  { what: 'THE INCIDENT SHAPE: a build 0.875 from the price above it',
    basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: -1.965, lands: false, gap: 0.875 },
  { what: 'a Lender Price row, which states both halves itself',
    basePoints: 0.25, adjustmentPoints: 0.5, adjustedPoints: 0.75, lands: true },
  { what: 'a row whose sheet published no base at all',
    basePoints: null, adjustmentPoints: -0.75, adjustedPoints: -1.34, lands: null },
  { what: 'a row with no itemisation fetched yet',
    basePoints: -0.59, adjustmentPoints: null, adjustedPoints: -1.34, lands: null },
  { what: 'a row carrying no final points',
    basePoints: -0.59, adjustmentPoints: -0.75, adjustedPoints: null, lands: null },
  { what: 'a hair inside the tolerance — floating-point noise is not a defect',
    basePoints: -0.59, adjustmentPoints: -0.75, adjustedPoints: -1.3401, lands: true },
  { what: 'a hair OUTSIDE it — a tenth of a point is real money',
    basePoints: -0.59, adjustmentPoints: -0.75, adjustedPoints: -1.44, lands: false, gap: 0.1 },
  { what: 'a zero-adjustment row still has to land',
    basePoints: -0.25, adjustmentPoints: 0, adjustedPoints: -0.25, lands: true },
];

for (const c of CASES) {
  const pb = { basePoints: c.basePoints, adjustmentPoints: c.adjustmentPoints, adjustedPoints: c.adjustedPoints };
  const server = breakdown.breakdown({ priceBuild: pb, adjustments: [] }).landing;
  const browser = browserLanding({ basePoints: c.basePoints }, pb);

  ok(server.landsOnPrice === c.lands,
    `B ${c.what} — server says ${JSON.stringify(server.landsOnPrice)}`);
  /* ⛔ THE MIRROR, RUN. Not "the two files look similar" — the browser's own
     expression, executed, against the server's answer on the same input. */
  ok(browser.landsOnPrice === server.landsOnPrice,
    `C …and the browser's own line agrees (${JSON.stringify(browser.landsOnPrice)})`);
  if (c.gap != null) {
    ok(Math.abs(Math.abs(server.gapPoints) - c.gap) < 0.0005,
      `D …and the gap is NAMED, not just flagged (${server.gapPoints})`);
    ok(Math.abs(Math.abs(browser.gapPoints) - c.gap) < 0.0005,
      'E …by both sides, to the same thousandth');
  }
}

/* ── the vendor's own second opinion, which used to be computed and binned ── */
{
  const pb = { basePoints: -0.59, adjustmentPoints: -0.75, adjustedPoints: -1.34 };
  const yes = breakdown.breakdown({ priceBuild: pb, adjustments: [], evidence: { reconciles: true } }).landing;
  const no = breakdown.breakdown({ priceBuild: pb, adjustments: [], evidence: { reconciles: false } }).landing;
  const unknown = breakdown.breakdown({ priceBuild: pb, adjustments: [] }).landing;
  ok(yes.vendorReconciles === true, 'F1 the rate sheet\'s own arithmetic is carried through when it agrees');
  ok(no.vendorReconciles === false, 'F2 …and when it does NOT — the signal that was computed and read by nothing');
  ok(unknown.vendorReconciles === null,
    'F3 …and a sheet that stated no price of its own is UNKNOWN, never a clean bill of health');
}

/* ── the panel must actually DRAW it, or this is a rule nobody sees ────────── */
{
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/landsOnPrice === false &&/.test(CODE),
    'G1 the panel draws the refusal when the build does not land on its own price');
  ok(/tone="bad"[\s\S]{0,400}?lands on|lands on[\s\S]{0,400}?tone="bad"/.test(CODE)
     || /k="…but the build lands on"[\s\S]{0,200}tone="bad"/.test(CODE),
    'G2 …in the red row, not as a footnote');
  /* ⛔ AND IT NO LONGER CALLS OUR OWN ARITHMETIC THE VENDOR'S. On a LoanNEX row
     `adjustmentPoints` is this page's sum of the lines above it, not a total the rate
     sheet sent — captioning it with the vendor's name told a reader checking our price
     that the vendor had vouched for it. */
  ok(!/Adjustments total \(\$\{engineName\}\)/.test(CODE),
    'G3 the adjustments total is no longer captioned with the rate sheet\'s name');
  ok(/k="Adjustments total"/.test(CODE), 'G4 …it is captioned as what it is');
}

console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `FAILURES: ${failures} of ${n}`}`);
process.exit(failures ? 1 : 0);
