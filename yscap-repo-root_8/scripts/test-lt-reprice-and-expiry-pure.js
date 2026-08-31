'use strict';
/**
 * LT — THE RE-PRICE RULE ON EVERY OPTION, AND ONE CLOCK ON EVERY DOCUMENT.
 *
 * Two owner decisions of 2026-08-31, both of which CHANGE BEHAVIOUR, and both of
 * which reverse or widen something that was deliberate before. A behaviour
 * change with no test is a behaviour change that reverts silently the next time
 * somebody tidies the function, so each is pinned here with a control.
 *
 *   1. *"on the scenario sheet, when you're adding a few different scenarios,
 *      the reprice rule is the rule. The ratio is changing for different rates,
 *      so every scenario is true."*  — and, asked whether it should block or
 *      warn, the owner chose BLOCK.
 *
 *   2. *"It says that the pricing expires in 72 hours on some of the sheets.
 *      Everything expires in 24 hours."*
 *
 * ⛔ EVERY FIXTURE HERE IS BUILT ON A MEASURED RATIO, NEVER A GUESSED ONE. A
 * first draft of these checks asserted "this comparison is clean" on options
 * whose own figures put them in different bands — so the CONTROL refused, and it
 * refused for the right reason. The true ratio is computed from the built
 * member and the claimed ratio is set from it, which is the only way a control
 * here is worth anything.
 *
 * PURE: no database, no network, no PDF.
 */

const snapshot = require('../src/longterm/termsheet/snapshot');
const routeSrc = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'src', 'longterm', 'routes', 'term-sheet.js'), 'utf8');

let bad = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { bad += 1; console.error('  FAIL ' + m); } };
const section = (t) => console.log('\n' + t);

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const RENT = 4161; const TAX = 620; const INS = 145;
const base = (o) => Object.assign({
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000, ltv: 75,
  termYears: 30, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: RENT, taxMonthly: TAX, insuranceMonthly: INS, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
}, o || {});
const q = (label, ratePct, rawPrice, scenario) => ({
  label, consumerLabel: 'Platinum ' + label, product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct, rawPrice, scenario, pricedAt: '2026-08-31T13:30:00.000Z',
});
const PREP = { borrowerName: 'Miriam Rosenberg', propertyAddress: '14 Oak Street, Lakewood, NJ 08701' };
const build = (sels) => snapshot.buildSnapshot({ selections: sels, plan: PLAN, prepared: PREP });
const gate = (sels) => snapshot.exportGate(build(sels).snapshot);

/** The ratio this rate and loan ACTUALLY produce, off the built member. */
function trueRatio(ratePct, loan) {
  const b = build([q('X', ratePct, 102, base({ loan, dscr: 1.24 }))]);
  const m = b.snapshot.members[0];
  return Math.round((RENT / (m.monthlyPI + TAX + INS)) * 100) / 100;
}
const tA = trueRatio(7.375, 375000);
const tB = trueRatio(6.875, 375000);
const tB65 = trueRatio(6.99, 325000);
const tC = trueRatio(6.75, 300000);

// =============================================================================
section('A. the fixtures are measured, so a control here means something');
// =============================================================================
{
  ok(tA === 1.24 && tB === 1.29 && tC === 1.53,
    `the three rates really do produce three different ratios (${tA}, ${tB}, ${tC})`);
  /* That the first two sit in DIFFERENT bands is not asserted through a private
     function — it is asserted through the RULE, in section B: claiming A's ratio
     on B refuses. A test that reached into the module for `dscrTier` would be
     proving the ladder, which `test-lt-comparison-ux-pure` already walks in
     hundredths from 0 to 2.00. Here the point is only that the two figures are
     far enough apart for the mutation to bite, and the ladder puts the boundary
     at 1.25, between them. */
  ok(tA < 1.25 && tB >= 1.25,
    `…and they straddle the 1.25 band edge (${tA} below, ${tB} at or above), which is what makes B2 bite`);
}

// =============================================================================
section('B. every option is checked — not only the first, and not only on a term sheet');
// =============================================================================
{
  const clean2 = gate([q('A', 7.375, 102, base({ dscr: tA })), q('B', 6.875, 99.75, base({ dscr: tB }))]);
  ok(clean2.ok, 'CONTROL a comparison whose options are each priced at their own ratio exports');

  const bad2 = gate([q('A', 7.375, 102, base({ dscr: tA })), q('B', 6.875, 99.75, base({ dscr: tA }))]);
  ok(!bad2.ok && bad2.error === 'dscr_below_priced',
    '⛔ THE ONE THAT MATTERS: the SECOND option alone being out of band refuses the whole export');
  ok(bad2.position === 1 && bad2.label === 'B',
    `…and it says WHICH option (${bad2.label}, position ${bad2.position}) — three ratios and no name is not actionable`);
  ok(/Option B/.test(bad2.message || ''), '…in the sentence a person reads, not only in a code');

  const clean3 = gate([
    q('A', 7.375, 102, base({ dscr: tA })),
    q('B', 6.99, 100.25, base({ loan: 325000, ltv: 65, dscr: tB65 })),
    q('C', 6.75, 99.5, base({ loan: 300000, ltv: 60, dscr: tC })),
  ]);
  ok(clean3.ok && clean3.kind === snapshot.DOC_KINDS.SCENARIO,
    'CONTROL an honest three-scenario sheet exports, and is a scenario comparison');

  const bad3 = gate([
    q('A', 7.375, 102, base({ dscr: tA })),
    q('B', 6.99, 100.25, base({ loan: 325000, ltv: 65, dscr: tB65 })),
    q('C', 6.75, 99.5, base({ loan: 300000, ltv: 60, dscr: 1.05 })),
  ]);
  ok(!bad3.ok && bad3.position === 2 && bad3.label === 'C',
    '⛔ and on a SCENARIO sheet — the document where the rule never ran at all — the third one is caught');
  ok(bad3.kind === snapshot.DOC_KINDS.SCENARIO,
    '…and the refusal still says which kind of document it was, so a screen can word itself');
}

// =============================================================================
section('C. it refuses rather than warns, and a term sheet is unchanged');
// =============================================================================
{
  const one = gate([q('A', 7.375, 102, base({ dscr: 1.45 }))]);
  ok(!one.ok && one.error === 'dscr_below_priced', 'a single term sheet still refuses, exactly as before');
  ok(!/Option/.test(one.message || ''),
    '…and does NOT name an option, because with one there is nothing to disambiguate');
  ok(gate([q('A', 7.375, 102, base({ dscr: tA }))]).ok, 'CONTROL an honest term sheet still exports');
}

// =============================================================================
section('D. a half-filled scenario is told what is MISSING, never accused of a mismatch');
// =============================================================================
{
  /* ⛔ THIS IS THE REGRESSION THE REORDER COULD HAVE CAUSED. The rule used to run
     only after the completeness checks; it now runs before them. That is safe
     ONLY because `ratioProblem` stands down the moment a figure it needs is
     absent — checked here rather than assumed, because if that guard ever moves
     this is the assertion that catches it. */
  const half = gate([q('A', 7.375, 102, base({ dscr: 1.45, taxMonthly: null, insuranceMonthly: null }))]);
  ok(!half.ok && half.error === 'term_sheet_incomplete',
    'a term sheet with no taxes or insurance is told what is missing');
  ok(!/DSCR band/.test(half.message || ''),
    '⛔ …and is NOT accused of a band change it has not got the figures to have');
}

// =============================================================================
section('E. one clock, every document');
// =============================================================================
{
  /* The route decides the window. Read as source rather than called, because
     calling it needs a company settings row and the claim under test is that
     there is no longer a SECOND branch to disagree with the first. */
  const fn = routeSrc.slice(routeSrc.indexOf('function expiryHoursFor'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  /* ⛔ THE COMMENTS ARE STRIPPED BEFORE THIS IS READ. A first cut matched
     `expiryDays` and failed — on the note inside the function EXPLAINING that
     the setting is retired. A guard that a truthful comment can break is a
     guard that teaches people to delete comments, so it reads the code. */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(/termSheet\.expiryHours/.test(code), 'the window comes from the term-sheet hours setting');
  ok((code.match(/setting\(/g) || []).length === 1,
    '⛔ THE ONE THAT MATTERS: it reads exactly ONE setting — there is no second one to drift on');
  ok(!/expiryDays/.test(code), '…and that one is not the retired days setting');
  ok(!/DOC_KINDS\.TERM_SHEET/.test(code),
    '…and there is no branch on the document kind at all — one clock cannot disagree with itself');
  ok(/, 24\)/.test(body) && /: 24;/.test(body), 'and 24 hours is the default, both ways in');
  ok(/RETIRED/.test(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'longterm', 'settings', 'encompass-settings.js'), 'utf8')
    .split("key: 'termSheet.expiryDays'")[1].slice(0, 400)),
    'the retired setting SAYS it is retired, so a stored value does not look live');
}

console.log('');
if (bad) { console.error(bad + ' FAILED'); process.exit(1); }
console.log('ALL PASSED');
