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
import { dscrFrom, ratioVerdict, dscrTier, DSCR_TIERS } from '../app-v2/src/longterm/dscrCalc.js';

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

console.log('\nA. the ladder is the owner\'s own, tier for tier');
/* Supplied by the owner on 2026-08-31, verbatim. Pinned at BOTH edges of every tier, because an
   off-by-a-hundredth here silently re-prices — or fails to re-price — a real loan. */
const LADDER = [
  [0.10, 1], [0.49, 1],
  [0.50, 2], [0.74, 2],
  [0.75, 3], [0.84, 3],
  [0.85, 4], [0.99, 4],
  [1.00, 5], [1.09, 5],
  [1.10, 6], [1.14, 6],   // owner-added 2026-08-31: *"I missed one band up to 1.1"*
  [1.15, 7], [1.24, 7],
  [1.25, 8], [1.29, 8],
  [1.30, 9], [1.39, 9],
  [1.40, 10], [1.49, 10],
  [1.50, 11], [2.00, 11],
];
let ladderBad = 0;
for (const [r, want] of LADDER) { if (dscrTier(r) !== want) { ladderBad += 1; console.error(`       ${r} → tier ${dscrTier(r)}, expected ${want}`); } }
ok(ladderBad === 0, `A1 all ${LADDER.length} tier edges land where the owner put them`);
ok(DSCR_TIERS.length === 11, `A2 eleven tiers (${DSCR_TIERS.length})`);
/* ⛔ CONTIGUOUS AND NON-OVERLAPPING, asserted rather than trusted. `dscrTier` returns the FIRST
   matching band, so two overlapping bands are resolved silently by array order — which is exactly
   how a deliberate mutation of one boundary once changed no behaviour at all, its neighbour still
   claiming the ratio. A HOLE is worse: a ratio in the gap gets no tier and the rule stands down on
   a live loan. Both copies self-check at load; this proves the property from the outside too. */
let gaps = 0;
for (let i = 1; i < DSCR_TIERS.length; i += 1) {
  if (DSCR_TIERS[i - 1].to !== DSCR_TIERS[i].from) gaps += 1;
}
ok(gaps === 0, `A2b the ladder has no hole and no overlap (${gaps} bad joins)`);
ok(DSCR_TIERS[0].from === null && DSCR_TIERS[DSCR_TIERS.length - 1].to === null,
  'A2c …and it is open at both ends, so every ratio lands somewhere');
ok(dscrTier(0) === null && dscrTier(-1) === null && dscrTier('x') === null,
  'A3 a ratio that is not a ratio has no tier — never tier 1 by accident');

/* ⛔ A4 — THE BROWSER'S LADDER AND THE SERVER'S ARE COMPARED DIRECTLY, ROW BY ROW AND
   RATIO BY RATIO. This file has always run the server's `exportGate` beside the browser's
   `dscrTier`, which proves they agree about the CASES it happens to try; it did not prove
   the two TABLES are the same. That gap mattered less when the server's copy had one
   reader. It has three now — the re-price refusal, the pricing board's bracket grouping,
   and this mirror — and a board that grouped by one ladder while the export refused by
   another is precisely the disagreement the owner asked to be made impossible
   (2026-09-01: *"if the bracket is changing you should automatically change yourself as
   well"*). So: every edge, both directions, and every hundredth from 0 to 2.00. */
const serverTiers = require('../src/longterm/pricing/dscr-tiers.js');
let rowBad = 0;
if (serverTiers.DSCR_TIERS.length !== DSCR_TIERS.length) rowBad += 1;
else {
  for (let i = 0; i < DSCR_TIERS.length; i += 1) {
    const a = DSCR_TIERS[i]; const b = serverTiers.DSCR_TIERS[i];
    if (a.tier !== b.tier || a.from !== b.from || a.to !== b.to) {
      rowBad += 1;
      console.error(`       row ${i}: browser ${JSON.stringify(a)} vs server ${JSON.stringify(b)}`);
    }
  }
}
ok(rowBad === 0, `A4 the browser ladder and the server ladder are the SAME ${DSCR_TIERS.length} rows`);
let walkBad = 0; let walked = 0;
for (let h = 0; h <= 200; h += 1) {
  const r = Math.round(h) / 100;
  walked += 1;
  if (dscrTier(r) !== serverTiers.dscrTier(r)) {
    walkBad += 1;
    if (walkBad <= 3) console.error(`       ${r.toFixed(2)} → browser ${dscrTier(r)}, server ${serverTiers.dscrTier(r)}`);
  }
}
ok(walkBad === 0, `A5 …and they answer identically for all ${walked} ratios from 0.00 to 2.00`);

console.log('\nB. the owner\'s own case, and the nagging that had to stop');
/* housing = 2000 PI + 400 tax + 200 insurance = 2600, so rent = ratio × 2600. */
const at = (ratio) => 2600 * ratio;
const gate = (priced, ratio) => snapshot.exportGate(sheet({ priced, rent: at(ratio) }));
const owner = gate(1.25, 1.20);
ok(owner.ok === false, 'B1 priced 1.25, figures 1.20 → REFUSED (tier 8 → tier 7)');
ok(owner.error === 'dscr_below_priced', 'B2 …named, so a caller can tell it from a missing field');
ok(owner.direction === 'down' && owner.pricedTier === 8 && owner.actualTier === 7,
  `B3 …and it says which way and between which tiers (${owner.pricedTier}→${owner.actualTier})`);
ok(/1\.20/.test(owner.message) && /1\.25/.test(owner.message), 'B4 the sentence carries both ratios');

/* ⛔ THE WHOLE POINT OF THE LADDER. Before it, ANY drop refused — so a 1.45 sheet issued on 1.42
   figures sent the officer back to re-price for a move that buys exactly the same price. */
ok(gate(1.45, 1.42).ok === true, 'B5 priced 1.45, figures 1.42 → ISSUES (both tier 10, same price)');
ok(gate(1.25, 1.29).ok === true, 'B6 priced 1.25, figures 1.29 → ISSUES (both tier 8)');
ok(gate(1.30, 1.29).ok === false, 'B7 …but 1.30 → 1.29 crosses a band and REFUSES');
ok(gate(1.15, 1.24).ok === true, 'B8 the whole of 1.15–1.24 is one band');
ok(gate(1.15, 1.14).ok === false, 'B9 …and one hundredth below it is another');
/* The band the owner added on 2026-08-31 — without it 1.05 and 1.12 were one band. */
ok(gate(1.05, 1.12).ok === false, 'B10 1.05 → 1.12 crosses the added 1.10 boundary and REFUSES');
ok(gate(1.05, 1.09).ok === true && gate(1.10, 1.14).ok === true,
  'B11 …while each side of it is still one band');

console.log('\nC. it re-prices in BOTH directions, which is the owner\'s rule');
const up = gate(1.20, 1.35);
ok(up.ok === false, 'C1 figures that rise into a HIGHER band also refuse');
ok(up.direction === 'up', 'C2 …reported as up, not as a shortfall');
ok(/better pricing/.test(up.message),
  'C3 …and the wording says the borrower qualifies for better, never accusing anybody');
ok(!/no longer qualifies/.test(up.message), 'C4 …and never uses the downward wording for it');

console.log('\nC2. it never invents a refusal out of figures it does not have');
ok(snapshot.exportGate(sheet({ pi: null })).error !== 'dscr_below_priced',
  'C5 no monthly payment → this rule stands down (it cannot work out a ratio at all)');
const noRent = snapshot.exportGate(sheet({ rent: null }));
ok(noRent.ok === false && noRent.error !== 'dscr_below_priced',
  'C6 a missing rent is the ordinary missing-field refusal, not a band accusation');
/* Dues are part of the housing payment the ratio divides by, so the SAME rent and price can sit in
   one band without them and a lower one with them. The pair is the proof they are counted. */
ok(snapshot.exportGate(sheet({ priced: 1.20, rent: 3120, hoa: 0 })).ok === true,
  'C7 rent 3120 over a 2600 payment is 1.20 — tier 6, as priced');
ok(snapshot.exportGate(sheet({ priced: 1.20, rent: 3120, hoa: 200 })).ok === false,
  'C8 …the same figures with 200 of dues are 1.11 — a lower band — and refuse. Dues are counted.');

console.log('\nD. the screen offers the way through — a re-price, never a dead end');
ok(/onReprice/.test(P) && /onReprice/.test(B), 'D1 the board carries out the re-price');
ok(/Re-?price/i.test(P), 'D2 the refusal carries a button, not just a sentence — never a dead end');
ok(/ratioVerdict/.test(B), 'D3 the screen judges the ratio with the SHARED rule, not its own');
ok(!/const agree = computed === priced\.toFixed\(2\)/.test(B),
  'D4 …and the old equality test is gone — it blocked files that came out BETTER than priced');

/* ⛔ A BUTTON THAT CANNOT BE PRESSED MUST NOT LOOK LIKE ONE THAT CAN (owner-reported
   2026-08-31: *"it sounds like the Issue Term Sheet button is a real button, but when I
   try to click it, nothing happens because it's black."*).

   The `disabled` attribute was ALREADY there and the refusal ALREADY worked — so every
   behaviour test passed while the screen lied to the officer. What was missing is
   entirely in the PAINT, which is why these read the style and not the logic. */
ok(/btnBlocked/.test(P), 'DB1 there is a real blocked treatment, distinct from the primary one');
ok(/cursor: 'not-allowed'/.test(P),
  'DB2 …answering the press at the moment of the press, before anything is read');
ok(/ratioBlocks \? btnBlocked\(\) : btn\('primary'\)/.test(P),
  'DB3 …and the issue button actually WEARS it when the ratio blocks — the defect was that it stayed gold');
ok(/Because the ratio is low, you need to reprice before you can issue the term sheet\./.test(PANEL),
  "DB4 the hover says WHY, in the owner's own words");
/* ⛔ THE TITLE MUST NOT SIT ON THE DISABLED BUTTON. A disabled control receives no mouse
   events in several browsers, so a `title` there is a tooltip that never fires — the
   owner's request would read as implemented in the source and do nothing on the screen.
   This asserts the wrapper carries it, which is the only reason the wrapper exists. */
ok(/<span title=\{ratioBlocks \? RATIO_BLOCK_HINT : undefined\}/.test(P),
  'DB5 ⛔ …carried by a WRAPPER, because a disabled button never fires a hover');
ok(!/<button[^>]*title=\{ratioBlocks/.test(P),
  'DB6 …and never pinned on the button itself, which is the version that silently does nothing');

console.log('\nDC. a collected option says what it COSTS, not only what it rates at');
/* Owner-directed 2026-08-31: *"It also needs to come up with how much the program is,
   like how many points it is, 101, 98, whatever, if it's lender-paid or borrower-paid."*
   The paid-by half was already on the row; the PRICE was not, so two options at one
   rate read as the same deal while one is at 98 and the other at 101.5. */
ok(/m\.charges && m\.charges\.displayPrice != null/.test(P),
  'DC1 the strip shows each collected option\'s price');
ok(/m\.charges\.displayPrice/.test(P) && !/strip[\s\S]{0,200}rawPrice - /.test(P),
  'DC2 ⛔ …read off the member\'s OWN stored charges, never recomputed on the screen');
ok(!/<span[^>]*>\{[^}]*p\.rawPrice[^}]*\}<\/span>/.test(P),
  'DC3 ⛔ …and it is never the RAW vendor price, which is the number before our compensation');
ok(/lender paid.*borrower paid/s.test(P),
  'DC4 …beside how it is paid, which the row already carried');

console.log('\nD2. the screen and the server never disagree about the same loan');
/* THE WHOLE REASON THIS SECTION EXISTS: the refusal is the server's and the warning is the
   browser's, so they are two copies of one money rule. A screen that blocks what the server
   would issue costs a good sheet; one that promises what the server refuses wastes the
   officer's time at the last step. Both are run over the same battery here.

   The battery deliberately walks THROUGH the band edge in hundredths, which is the only
   place two roundings can part company. */
let mirrorBad = 0;
let mirrorRan = 0;
/* ⛔ ONE LOAN, BOTH COPIES OF THE LADDER. The refusal is the server's and the warning is the
   browser's, so they are two copies of one money rule: a screen that blocks what the server would
   issue costs a good sheet, and one that promises what the server refuses wastes the officer's
   time at the last step. Every ratio from 0.01 to 2.00 in hundredths is run through BOTH — which
   walks every tier edge in the owner's ladder, in both directions. */
for (const priced of [0.4, 0.6, 0.8, 0.9, 1.05, 1.2, 1.27, 1.35, 1.45, 1.6]) {
  for (let step = 1; step <= 200; step += 1) {
    const ratio = Math.round(step) / 100;
    const rent = 2600 * ratio;
    mirrorRan += 1;
    const serverRefuses = snapshot.exportGate({
      docKind: 'term_sheet',
      prepared: { borrowerName: 'X', propertyAddress: 'Y' },
      members: [{
        monthlyPI: 2000,
        scenario: { dscr: priced, rentMonthly: rent, taxMonthly: 400, insuranceMonthly: 200, hoaMonthly: 0 },
      }],
    }).error === 'dscr_below_priced';
    const clientBlocks = ['below', 'above'].includes(ratioVerdict(ratio, priced));
    if (clientBlocks !== serverRefuses) {
      mirrorBad += 1;
      if (mirrorBad <= 3) {
        console.error(`       priced=${priced} ratio=${ratio} server=${serverRefuses} screen=${clientBlocks}`);
      }
    }
  }
}
ok(mirrorRan >= 2000, `D5 (the battery really ran — ${mirrorRan} loans)`);
ok(mirrorBad === 0, `D6 the screen and the server agree on every one of them (${mirrorBad} disagreed)`);
ok(dscrTier(1.2449) === dscrTier(1.24) && dscrTier(1.245) === dscrTier(1.25),
  'D7 the ratio is rounded to two before it is placed — the tenant\'s own DSCR definition');

console.log('\nE. the PITI column lines up with its own heading');
ok(/const ACT_W = /.test(B), 'E1 the action column has ONE definition');
ok(!/flex: '0 0 132px'/.test(B.replace(/const ACT_W[^\n]*\n/, '')),
  'E2 …and no hand-typed copy of it survives anywhere on the board');
const eligibleHead = (B.match(/className="ltq-head"[\s\S]*?<\/div>/) || [])[0] || '';
ok(/Monthly P&amp;I/.test(eligibleHead), 'E3 (located the eligible board\'s heading row)');
/* ⛔ RE-POINTED, AND THE CLAIM GOT STRONGER (2026-09-01, the un-forking). The width is no
   longer the constant read twice — it is ONE expression, `actW`, derived once per row from the
   engine (a board with the term-sheet cart reserves the tick-box's width; one without it does
   not). The bug this guards is the heading and the rows reserving DIFFERENT widths; reading one
   expression in both places makes that impossible rather than merely currently untrue, which is
   what the constant did. Both are still checked by name so a hard-coded pixel value fails. */
ok(/flex: actW \}/.test(eligibleHead),
  'E4 its trailing spacer is the SAME width as the rows\' action cell — the whole bug');
/* Both row shapes: the lender's front row and its other programmes. If either drifts, the
   figures on that row slide out from under the headings above them. */
ok((B.match(/className="ltq-act" style=\{\{ flex: actW,/g) || []).length === 2,
  'E5 both eligible row shapes read the same constant');
ok(/flex: ACT_W_PLAIN \}/.test(B) && (B.match(/ACT_W_PLAIN/g) || []).length >= 3,
  'E6 the ineligible board (no tick-box) has its own narrower column, header and row agreeing');

/* ⛔ RE-POINTED 2026-09-01, AND THE SUBJECT REVERSED — so it is stated here rather than
   quietly softened. This section asserted that the comparison rail was PINNED and that the
   search strip was pushed down by the rail's own measured height. Both were built to
   2026-08-30's *"the entire time when you are scrolling, that section should be visible …
   you don't need to scroll back up."*

   The owner read the result on 2026-09-01: *"the entire pricing screen is extremely,
   terribly messy. It's three separate sections stacked on top of each other, and you can't
   see any of the three … at the bottom of everything, you can't even access it to see
   rates, and you can't scroll."* MEASURED at 1440x1000: the app header (72), the rail
   pinned under it (171) and the strip pinned under THAT (199) held 442 points of the
   viewport at all times, and the first rate row sat at y=810 — one rate visible on the
   screen whose entire job is the board. F7 already knew the hazard ("a pin that ate the
   viewport would be worse"); the 46vh cap did not save it, because two capped pins still
   add up.

   So ONE band is pinned now — the strip, which carries what an officer uses WHILE reading
   the board — and the rail sits below the board, unpinned and folded until it is wanted.
   The 2026-08-30 requirement is answered, not dropped: the collected count rides on the
   pinned strip and jumps here in one press (F5/F6 below). */
console.log('\nF. one band is pinned, and the collection is one press from it');
ok(/className="lt-comp-rail"/.test(P), 'F1 the comparison panel is still its own area');
ok(/\.lt-comp-rail\{position:static/.test(CSS),
  'F2 …and the stylesheet no longer pins it — two pinned bands cannot both be the top of the page');
ok(/\.lt-strip\{position:sticky;top:72px/.test(CSS),
  'F3 the search strip is the ONE pinned band, under the app header alone');
/* ⛔ COMMENTS STRIPPED FIRST. The change that removed this variable necessarily NAMES it
   while explaining why it is gone, in both files — so an assertion over the raw text
   would fail on its own explanation and then be "fixed" by deleting the explanation.
   What is asserted is that nothing DECLARES, READS or WRITES it any more. */
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
ok(!/--lt-comp-h/.test(noComments(CSS)) && !/--lt-comp-h/.test(noComments(P)),
  'F4 the rail\'s offset variable is gone from BOTH the sheet and the component — one bundle, no half state');
ok(/id="lt-comparison"/.test(P), 'F5 the comparison area is addressable');
ok(/scroll-margin-top/.test(CSS),
  'F6 …and lands clear of the pinned strip rather than under it');
ok(/max-height:min\(46vh,420px\);overflow-y:auto/.test(CSS),
  'F7 the collected list is still capped and scrolls inside itself');
ok(/aria-expanded=\{open\}/.test(P) && /setOpen\(true\)/.test(P),
  'F8 the body folds away, and opens itself the moment something is collected');

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

console.log('\nI. the Add-to-comparison button is on the row, on both row shapes, always');
/* Owner-directed 2026-09-02: *"the small box that was on the right side to add to the
   comparison… disappeared… You should be able to do that right away… It can just be a
   button, but it needs to be very clean, modern, user-friendly, and simple. Next to each
   and every quote."* It used to be a tick-box that appeared only once a workflow had been
   chosen — which, to a person pricing a deal, is a control that is not there. */
const Bsrc = B.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
ok((Bsrc.match(/<CompareButton /g) || []).length === 2, 'I1 the lender\'s front row and its other programmes both carry it');
ok(!/ts\.picking|picking:/.test(Bsrc), 'I2 ⛔ …and nothing gates it on a "picking" mode any more — it is there the moment the cart is');
ok((Bsrc.match(/\{ts && ts\.enabled && (g\.best && )?\(\s*<CompareButton/g) || []).length === 2,
  'I3 …its only condition being that this board has a cart at all');
const Psrc = P.replace(/\/\*[\s\S]*?\*\//g, ' ');
ok(/export function CompareButton/.test(Psrc) && !/export function PickBox/.test(Psrc),
  'I4 the tick-box is gone and the button has taken its place');
ok(/'Add to comparison'/.test(Psrc) && /'In comparison'/.test(Psrc),
  'I5 it says what it does in words — "Add to comparison", then "In comparison"');
ok(/aria-pressed=\{on\}/.test(Psrc) && /press to take it out/.test(Psrc),
  'I6 …carries its state for a screen reader, and says what the NEXT press does');
ok(!/type="checkbox"/.test(/export function CompareButton[\s\S]*?\n}\n/.exec(Psrc)[0]),
  'I7 …and there is no checkbox left inside it');
ok(/minHeight: 44/.test(/export function CompareButton[\s\S]*?\n}\n/.exec(Psrc)[0]) && /\.btn\{min-height:44px/.test(CSS),
  'I8 it is the same height as the Details button beside it, so the two read as one pair');

console.log('\nJ. a comparison is DOWNLOADED as a comparison, not as a term sheet');
// Owner-reported 2026-08-31: *"the comparison, when you want to export it, is basically issued
// and downloaded as the term sheet. It needs to be called the comparison sheet."*
//
// ⛔ THE SERVER-SIDE HALF SHIPPED AND COULD NOT BE SEEN. The PDF route names the file from
// `snapshot.KIND_WORDS`, so a comparison genuinely leaves as `comparison-sheet-TS-XXXXXX.pdf` —
// and `a.download` OVERRIDES `Content-Disposition`, so the browser saved the caller's
// hard-coded `term-sheet-…` name anyway. Half a fix on a naming bug is no fix: the officer
// still ends up with a comparison in their downloads called a term sheet.
{
  const words = snapshot.KIND_WORDS;
  ok(words[snapshot.DOC_KINDS.COMPARISON] === 'comparison sheet'
    && words[snapshot.DOC_KINDS.SCENARIO] === 'scenario comparison',
    'J1 the server has one table of what each document is called');
  /* ⛔ RE-POINTED, NOT LOOSENED (2026-08-31). This used to look for
     `KIND_WORDS[lay.docKind` inside the ROUTE. The drawing moved into
     `termsheet/deliver.renderSheet` so that the emailed copy and the downloaded
     copy cannot be two different documents, and the expression went with it — so
     the guard started failing on a naming rule that had not changed. Its stated
     subject is "the download is named from the one table", so it now asserts that
     in BOTH halves, which is strictly stronger than the line it replaces: the
     renderer derives the name from KIND_WORDS, and the route sends THAT name. */
  const ROUTE = bare(readFileSync(new URL('../src/longterm/routes/term-sheet.js', import.meta.url), 'utf8'));
  const DELIVER = bare(readFileSync(new URL('../src/longterm/termsheet/deliver.js', import.meta.url), 'utf8'));
  ok(/KIND_WORDS\[/.test(DELIVER) && /filename: `\$\{slug\}-\$\{row\.code\}\.pdf`/.test(DELIVER),
    'J2 the one renderer names the file from that table');
  ok(/Content-Disposition[^\n]*doc\.filename/.test(ROUTE),
    'J2b …and the download door sends THAT name, never one of its own');

  const HTTP = readFileSync(new URL('../app-v2/src/longterm/http.js', import.meta.url), 'utf8');
  ok(/filenameFromDisposition\(res\.headers\.get\('Content-Disposition'\)\) \|\| filename/.test(HTTP),
    'J3 ⛔ the browser honours that name, falling back to the caller\'s only when there is none');

  // The parser is read out of the source and run, so this asserts the RULE rather
  // than that the file contains a function with the right name.
  const m = /export function filenameFromDisposition[\s\S]*?\n}\n/.exec(HTTP);
  // eslint-disable-next-line no-eval
  const parse = m ? eval(`(${m[0].replace('export function', 'function')})`) : null;
  ok(!!parse, 'J4 the parser is there to run');
  ok(parse('attachment; filename="comparison-sheet-TS-4KH92B.pdf"') === 'comparison-sheet-TS-4KH92B.pdf',
    'J5 a comparison keeps the name the server gave it');
  ok(parse("attachment; filename*=UTF-8''sc%C3%A9nario.pdf") === 'scénario.pdf',
    'J6 …including a non-ASCII name, which only the RFC 5987 form can carry');
  ok(parse('attachment') === null && parse('') === null && parse(null) === null,
    'J7 no header means fall back, never an empty filename');
  // A filename reaches the file system. Even a header we send ourselves is
  // sanitised, or a header that is ever wrong becomes a path.
  ok(parse('attachment; filename="../../etc/passwd"') === null,
    'J8 ⛔ a traversal attempt is refused outright rather than tidied into a name');
  ok(parse('attachment; filename="a/b/c.pdf"') === 'abc.pdf', 'J9 …and separators are stripped');
}


console.log('\nK. ⛔ the band an option was PRICED IN is the option\'s own stamp — on both sides of the mirror');
/* Owner-reported 2026-09-02: *"the 5.75 was actually priced on the 1.25 band… You
   should not look at the original scenario. You should look at what was the actual
   pricing on."* The banded board stamps each option with the ratio its band was bought
   at; the form's DSCR is only where the search started. The server prefers the stamp
   (`buildMember`), so the screen's own pre-check must prefer it too — a screen judging
   against the form while the server judges against the stamp promises a refusal the
   issue then allows, or the reverse. Both preferences are pinned here, and then the
   two verdicts are run side by side through the REAL build path. */
{
  const PRICER = readFileSync(new URL('../app-v2/src/longterm/LtPricer.jsx', import.meta.url), 'utf8');
  const body = PRICER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/pricedDscr:\s*o\s*&&\s*nn\(o\.dscr\)\s*\?\s*o\.dscr\s*:\s*null/.test(body),
    'K1 a collected option carries the board\'s stamp as `pricedDscr` (null when the board did not bracket)');
  const check = /ratioCheck:\s*\(\)\s*=>\s*\{([\s\S]*?)ratioVerdict\(/.exec(body);
  ok(!!check && /const priced\s*=\s*o\s*&&\s*nn\(o\.dscr\)\s*\?\s*o\.dscr\s*:\s*toNumber\(f\.dscr\)/.test(check[1]),
    'K2 ⛔ the screen\'s pre-check judges against the option\'s stamp first and the form only when there is none');
  ok(!!check && !/const priced\s*=\s*toNumber\(f\.dscr\)\s*;/.test(check[1]),
    'K3 …and the old reading — the form alone — is gone from it');

  /* THE MIRROR, THROUGH THE REAL PATH. A selection is built the way the browser now
     builds it (the form's ratio as the scenario, the stamp as `pricedDscr`), turned
     into a member by the real `buildMember`, and the real gate is asked. Beside it the
     screen's `ratioVerdict` is asked with the SAME stamp. They must agree on every
     loan — and the decoy form ratio must never be the one either side judges on. */
  const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
  const PREP = { borrowerName: 'Sample Borrower', propertyAddress: '1 Test St' };
  const TAX = 400, INS = 200;
  const sel = (over) => ({
    label: 'A', consumerLabel: 'Platinum A', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
    ratePct: 7.125, rawPrice: 100, pricedAt: '2026-09-02T00:00:00.000Z',
    scenario: {
      purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000, ltv: 75,
      termYears: 30, fico: 740, state: 'NJ', zip: '08701', taxMonthly: TAX, insuranceMonthly: INS,
      hoaMonthly: 0, prepayMonths: 60, prepayStructure: '5 Year', ...over,
    },
  });
  // The payment this rate and loan really produce, off a built member — so the rents
  // below are chosen against the same figure the gate divides by.
  const probe = snapshot.buildMember({ ...sel({ dscr: 1.2, rentMonthly: 3000 }), pricedDscr: 1.2 }, PLAN);
  ok(probe.ok && Number.isFinite(probe.member.monthlyPI), 'K4 (the probe member builds, so the battery can run)');
  const PI = probe.ok ? probe.member.monthlyPI : 2000;
  let ran = 0, disagree = 0, decoyWon = 0;
  for (const stamp of [0.8, 0.95, 1.05, 1.12, 1.2, 1.27, 1.35, 1.45, 1.6]) {
    // A form ratio in a DIFFERENT band from the stamp — the owner's exact shape.
    const decoy = dscrTier(stamp) === dscrTier(1.14) ? 1.45 : 1.14;
    for (let step = 60; step <= 180; step += 3) {
      const ratio = step / 100;
      const rent = Math.round(ratio * (PI + TAX + INS) * 100) / 100;
      const built = snapshot.buildSnapshot({
        selections: [{ ...sel({ dscr: decoy, rentMonthly: rent }), pricedDscr: stamp }], plan: PLAN, prepared: PREP,
      });
      if (!built.ok) continue;
      ran += 1;
      const g = snapshot.exportGate(built.snapshot);
      const serverRefuses = g.error === 'dscr_below_priced';
      const actual = Math.round((rent / (built.snapshot.members[0].monthlyPI + TAX + INS)) * 100) / 100;
      const screenBlocks = ['below', 'above'].includes(ratioVerdict(actual, stamp));
      if (serverRefuses !== screenBlocks) { disagree += 1; if (disagree <= 3) console.error(`       stamp=${stamp} decoy=${decoy} ratio=${ratio} server=${serverRefuses} screen=${screenBlocks}`); }
      // The decoy must never be the figure the server judged on.
      if (serverRefuses && g.pricedAt === decoy) decoyWon += 1;
      if (built.snapshot.members[0].scenario.dscr !== stamp) decoyWon += 1;
    }
  }
  ok(ran >= 300, `K5 (the battery really ran — ${ran} loans, each with a decoy form ratio in another band)`);
  ok(disagree === 0, `K6 ⛔ the screen and the server agree on every one of them (${disagree} disagreed)`);
  ok(decoyWon === 0, `K7 ⛔ and the form's decoy ratio never became the one judged on (${decoyWon} times it did)`);
}

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
