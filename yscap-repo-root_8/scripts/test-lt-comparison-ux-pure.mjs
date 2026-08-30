// LONG-TERM — THE MONEY RULE ON ISSUING, AND THE COMPARISON SCREEN THAT SURROUNDS IT.
//
// Three owner reports from 2026-08-30, in one place because they are one screen:
//
//   1. THE MONEY ONE, and it is the reason this file exists. *"You allow the system to issue
//      the term sheet even if the DSCR disagrees. This means that if the scenario was 1.25 but
//      the details that I'm entering to issue the term sheet are 1.2, it allows the system to
//      issue the term sheet. This means we are giving him better pricing than we should have
//      given him."*
//
//      A DSCR band is a PRICE BRACKET: the vendor prices 1.25+ better than 1.20+. So issuing a
//      sheet at a rate bought in the 1.25 band, on figures that only reach 1.20, hands the
//      borrower a rate this loan does not qualify for — and nothing downstream catches it,
//      because by then the rate is just a number on a document. The refusal has to be at the
//      SERVER's export gate: it is the one chokepoint every issue goes through, and a screen
//      check alone is a suggestion.
//
//      I HAD SHIPPED THIS AS A WARNING THAT STILL LET THE SHEET OUT, and flagged it as a
//      decision they could reverse. They reversed it, on money grounds, and were right. It is
//      a hard refusal now, with the re-price offered as the way forward — never a dead end.
//
//   2. THE PITI COLUMN. *"There is a CSS issue where the column that we added for principal,
//      interest, taxes, and insurance (the word PITI) is off, and it's not aligned with the
//      dollar amounts."* My own defect: the tick-box widened the rows' action cell and left the
//      header's spacer behind, and the name column absorbs slack, so every figure after it
//      slid left of its heading.
//
//   3. THE RAIL. *"The top of the screen [should] pop up each and every thing that you are
//      adding to the comparisons. The entire time when you are scrolling, that section should
//      be visible, and you can issue the comparison sheet from there."*
//
// The render half of this screen SKIPS on CI (no bundler there), so what can be proven without
// one is proven here: the gate is real JavaScript and is CALLED, and the layout rules are
// asserted against the SOURCE.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dscrFrom, ratioVerdict, DSCR_BAND_TOLERANCE } from '../app-v2/src/longterm/dscrCalc.js';

const require = createRequire(import.meta.url);
const snapshot = require('../src/longterm/termsheet/snapshot.js');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};

const BOARD = readFileSync(new URL('../app-v2/src/longterm/LtPricer.jsx', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../app-v2/src/longterm/TermSheetPanel.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../app-v2/src/styles.css', import.meta.url), 'utf8');
/* Comments are stripped before every "must not appear" assertion: the code that fixed each of
   these necessarily QUOTES the broken shape while explaining itself, and a guard reading its own
   explanation fails on the fix and then gets "fixed" by deleting the explanation. */
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const B = bare(BOARD);
const P = bare(PANEL);

/* A term sheet the gate would otherwise pass: one member, every figure present, a party named.
   Each case below moves ONE number, so a refusal can only be about that number. */
const sheet = (over = {}) => ({
  docKind: 'term_sheet',
  prepared: { borrowerName: 'Sample Borrower', propertyAddress: '1 Test St' },
  members: [{
    monthlyPI: over.pi === undefined ? 2000 : over.pi,
    scenario: {
      dscr: over.priced === undefined ? 1.25 : over.priced,
      rentMonthly: over.rent === undefined ? 4000 : over.rent,
      taxMonthly: 400,
      insuranceMonthly: 200,
      hoaMonthly: over.hoa === undefined ? 0 : over.hoa,
    },
  }],
});

console.log('\nA. the owner\'s own case — figures that price BELOW the band the option was bought in');
/* PI 2000 + tax 400 + ins 200 = 2600 of housing. Rent 4000 → 1.538, comfortably above.
   Rent 3120 → exactly 1.20 against an option priced at 1.25: the owner's numbers. */
const below = snapshot.exportGate(sheet({ rent: 3120, priced: 1.25 }));
ok(below.ok === false, 'A1 a 1.20 file against a 1.25 price is REFUSED');
ok(below.error === 'dscr_below_priced', 'A2 …by name, so a caller can tell it from a missing field');
ok(Math.abs(below.repriceAt - 1.2) < 0.005, `A3 …and it says which ratio to re-price at (${below.repriceAt})`);
ok(Math.abs(below.pricedAt - 1.25) < 0.005, 'A4 …beside the one the option was priced at');
ok(/1\.20/.test(below.message) && /1\.25/.test(below.message),
  'A5 the sentence carries BOTH ratios — a refusal naming neither cannot be acted on');
ok(/qualif/i.test(below.message), 'A6 …and says WHY: the loan does not qualify for that band');

console.log('\nB. and it refuses ONLY that — everything else still issues');
ok(snapshot.exportGate(sheet({ rent: 3120, priced: 1.20 })).ok === true,
  'B1 the same 1.20 figures against an option PRICED at 1.20 issue normally');
ok(snapshot.exportGate(sheet({ rent: 4480, priced: 1.20 })).ok === true,
  'B2 figures that come out ABOVE the priced band issue — a better file is never refused');
ok(snapshot.exportGate(sheet()).ok === true, 'B3 the ordinary sheet is untouched');
/* The tolerance exists because the two sides are rounded for display and a hundredth of a
   basis point is not a price bracket. It must be small enough that a real band step (0.05)
   can never hide inside it. */
const hair = snapshot.exportGate(sheet({ rent: 3245, priced: 1.2481 }));
ok(hair.ok === true, 'B4 a rounding hair below the priced ratio is not a band change');
ok(snapshot.exportGate(sheet({ rent: 3120, priced: 1.25 })).ok === false,
  'B5 …but a real 0.05 step still is (the control for B4)');

console.log('\nC. it never invents a refusal out of figures it does not have');
ok(snapshot.exportGate(sheet({ pi: null })).error !== 'dscr_below_priced',
  'C1 no monthly payment → this rule stands down (it cannot work out a ratio at all)');
const noRent = snapshot.exportGate(sheet({ rent: null }));
ok(noRent.ok === false && noRent.error !== 'dscr_below_priced',
  'C2 a missing rent is the ordinary missing-field refusal, not a ratio accusation');
/* Association dues are part of the housing payment the ratio divides by, so the SAME rent
   and the SAME price can qualify without them and fail with them. That pair is the proof
   they are counted — a single case could pass for either reason. */
ok(snapshot.exportGate(sheet({ rent: 3120, priced: 1.15, hoa: 0 })).ok === true,
  'C3 rent 3120 over a 2600 payment is 1.20 and clears a 1.15 band');
ok(snapshot.exportGate(sheet({ rent: 3120, priced: 1.15, hoa: 200 })).ok === false,
  'C4 …the same figures with 200 of dues are 1.11 and do NOT — dues are counted');
ok(snapshot.exportGate(sheet({ priced: 0 })).error !== 'dscr_below_priced',
  'C5 an option with no priced ratio is not accused of missing one');

console.log('\nD. the screen offers the way through — a re-price, never a dead end');
ok(/onReprice/.test(P) && /onReprice/.test(B), 'D1 the board carries out the re-price');
ok(/Re-?price/i.test(P), 'D2 the refusal carries a button, not just a sentence — never a dead end');
ok(/ratioVerdict/.test(B), 'D3 the screen judges the ratio with the SHARED rule, not its own');
ok(!/const agree = computed === priced\.toFixed\(2\)/.test(B),
  'D4 …and the old equality test is gone — it blocked files that came out BETTER than priced');

console.log('\nD2. the screen and the server never disagree about the same loan');
/* THE WHOLE REASON THIS SECTION EXISTS: the refusal is the server's and the warning is the
   browser's, so they are two copies of one money rule. A screen that blocks what the server
   would issue costs a good sheet; one that promises what the server refuses wastes the
   officer's time at the last step. Both are run over the same battery here.

   The battery deliberately walks THROUGH the band edge in hundredths, which is the only
   place two roundings can part company. */
let mirrorBad = 0;
let mirrorRan = 0;
/* ⛔ ONE LOAN, BOTH RULES. The browser reaches its ratio through its own calculator and the
   server is handed THAT calculator's payment — so what is being compared is the two BAND
   rules over the same loan, not two amortisation routines. Feeding the server a payment the
   browser never computed would prove nothing about whether they agree on a real file.

   The rents walk THROUGH each band edge in small steps, which is the only place two
   roundings can part company. */
for (const priced of [1.0, 1.1, 1.15, 1.2, 1.25, 1.3, 1.5]) {
  for (const [loanAmount, ratePct, termYears, io_] of [
    [400000, 6.75, 30, false], [400000, 7.25, 40, false], [312500, 6.5, 30, true],
  ]) {
    for (const hoa of [0, 125]) {
      const tax = 400; const ins = 200;
      for (let rent = 1800; rent <= 5200; rent += 5) {
        const out = dscrFrom({
          loanAmount, ratePct, termYears, interestOnly: io_,
          rentMonthly: rent, taxMonthly: tax, insuranceMonthly: ins, hoaMonthly: hoa,
        });
        if (out.dscr == null || out.pi == null) continue;
        mirrorRan += 1;
        const serverRefuses = snapshot.exportGate({
          docKind: 'term_sheet',
          prepared: { borrowerName: 'X', propertyAddress: 'Y' },
          members: [{
            monthlyPI: out.pi,
            scenario: {
              dscr: priced, rentMonthly: rent, taxMonthly: tax,
              insuranceMonthly: ins, hoaMonthly: hoa,
            },
          }],
        }).error === 'dscr_below_priced';
        const clientBlocks = ratioVerdict(out.dscr, priced) === 'below';
        if (clientBlocks !== serverRefuses) {
          mirrorBad += 1;
          if (mirrorBad <= 3) {
            console.error(`       priced=${priced} rent=${rent} hoa=${hoa} pi=${out.pi} `
              + `server=${serverRefuses} screen=${clientBlocks} ratio=${out.dscr}`);
          }
        }
      }
    }
  }
}
ok(mirrorRan > 4000, `D5 (the battery really ran — ${mirrorRan} loans)`);
ok(mirrorBad === 0, `D6 the screen and the server agree on every one of them (${mirrorBad} disagreed)`);
ok(DSCR_BAND_TOLERANCE === 0.005,
  'D7 the tolerance is a hundredth — small enough that a real 0.05 band step cannot hide in it');

console.log('\nE. the PITI column lines up with its own heading');
ok(/const ACT_W = /.test(B), 'E1 the action column has ONE definition');
ok(!/flex: '0 0 132px'/.test(B.replace(/const ACT_W[^\n]*\n/, '')),
  'E2 …and no hand-typed copy of it survives anywhere on the board');
const eligibleHead = (B.match(/className="ltq-head"[\s\S]*?<\/div>/) || [])[0] || '';
ok(/Monthly P&amp;I/.test(eligibleHead), 'E3 (located the eligible board\'s heading row)');
ok(/flex: ACT_W \}/.test(eligibleHead),
  'E4 its trailing spacer is the SAME width as the rows\' action cell — the whole bug');
/* Both row shapes: the lender's front row and its other programmes. If either drifts, the
   figures on that row slide out from under the headings above them. */
ok((B.match(/className="ltq-act" style=\{\{ flex: ACT_W,/g) || []).length === 2,
  'E5 both eligible row shapes read the same constant');
ok(/flex: ACT_W_PLAIN \}/.test(B) && (B.match(/ACT_W_PLAIN/g) || []).length >= 3,
  'E6 the ineligible board (no tick-box) has its own narrower column, header and row agreeing');

console.log('\nF. the comparison stays on screen the whole time');
ok(/className="lt-comp-rail"/.test(P), 'F1 the comparison panel is the pinned rail');
ok(/\.lt-comp-rail\{position:sticky/.test(CSS), 'F2 …and the stylesheet pins it');
ok(/--lt-comp-h/.test(P), 'F3 the rail publishes its own MEASURED height');
ok(/getBoundingClientRect/.test(P) && /ResizeObserver/.test(P),
  'F4 …measured from its own box and re-measured when it changes size');
ok(/\.lt-strip\{position:sticky;top:calc\(72px \+ var\(--lt-comp-h/.test(CSS),
  'F5 the search strip below moves down by exactly that, never by a constant');
ok(/setProperty\('--lt-comp-h', '0px'\)/.test(P),
  'F6 …and the offset is cleared when the rail leaves the page');
ok(/max-height:min\(46vh,420px\);overflow-y:auto/.test(CSS),
  'F7 the rail is capped and scrolls inside itself — a pin that ate the viewport would be worse');
ok(/@media\(max-width:900px\)\{\s*\.lt-comp-rail\{position:static/.test(CSS),
  'F8 …and it goes static on a phone, where a pin has no room to earn');

console.log('\nG. everything collected is visible from there, and issuable from there');
ok(/\{children\}\n\s*<\/div>/.test(P),
  'G1 the collected options and the issue form live INSIDE the rail — one list, not a copy');
ok(/option\$\{count === 1 \? '' : 's'\} collected/.test(P),
  'G2 the rail header states how many are in');
ok(/lt-comp-body/.test(P) && /lt-comp-body/.test(CSS),
  'G3 the scrolling body is the part that is capped, so the header is never scrolled away');

console.log('\nH. the chooser folds away once it has been answered');
/* The rail is pinned, so every pixel it keeps is board an officer cannot see — and two
   paragraphs explaining a choice already made are the first thing that should fold. */
ok(/picked \? \(/.test(P), 'H1 a chosen workflow renders the compact form');
ok(/onChoose\(null\)/.test(P), 'H2 …with a way back to the full chooser');
ok(/COMPARISON_WORKFLOWS\.map/.test(P), 'H3 …and the full chooser is still there when nothing is chosen');

console.log('\nI. the tick-box is on the row, on both row shapes');
ok((B.match(/<PickBox /g) || []).length === 2, 'I1 the lender\'s front row and its other programmes both carry it');
ok(/ts\.picking/.test(B), 'I2 …and it only appears while a comparison is being built');

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
