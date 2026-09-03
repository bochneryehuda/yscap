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
const tierRounding = require('../src/longterm/pricing/tier-rounding');
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

/**
 * The ratio this rate and loan ACTUALLY produce, off the built member — CUT DOWN,
 * because that is the rule the document is judged by (owner-directed 2026-08-30:
 * *"the DSCR should always be rounded down… so we should never see better."*).
 *
 * ⛔ IT CUTS WITH ITS OWN ARITHMETIC, NOT BY CALLING THE PRODUCTION RULE, and that
 * is deliberate. A helper that asked `tier-rounding` the same question the module
 * under test asks would MOVE WITH IT: mutate the rule back to round-to-nearest and
 * every fixture here would quietly follow, and the controls would pass while the
 * document was judged by the wrong rule. The four measured literals in section A
 * are what make this independent copy worth anything, and A3 checks the two agree.
 *
 * A plain floor is safe for these four ratios because none of them lands on a whole
 * cent; the production rule's float-slack guard is what covers the ones that do, and
 * section E is where that half is exercised.
 */
function trueRatio(ratePct, loan) {
  const b = build([q('X', ratePct, 102, base({ loan, dscr: 1.24 }))]);
  const m = b.snapshot.members[0];
  return Math.floor((RENT / (m.monthlyPI + TAX + INS)) * 100) / 100;
}
const tA = trueRatio(7.375, 375000);
const tB = trueRatio(6.875, 375000);
const tB65 = trueRatio(6.99, 325000);
const tC = trueRatio(6.75, 300000);

// =============================================================================
section('A. the fixtures are measured, so a control here means something');
// =============================================================================
{
  ok(tA === 1.24 && tB === 1.28 && tC === 1.53,
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
  /* The helper above cuts with its own arithmetic so a mutation of the production
     rule cannot drag the fixtures along with it. This is the other half of that
     bargain: on these four ratios the two must still answer the same thing, or the
     fixtures are describing a document the rule would judge differently. */
  ok([[7.375, 375000, tA], [6.875, 375000, tB], [6.99, 325000, tB65], [6.75, 300000, tC]]
    .every(([rate, loan, expected]) => {
      const m = build([q('X', rate, 102, base({ loan, dscr: 1.24 }))]).snapshot.members[0];
      return tierRounding.sendAs('dscr', RENT / (m.monthlyPI + TAX + INS), 2) === expected;
    }),
    '…and the rule the document is judged by cuts them to exactly those figures');
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
section('E. the term sheet cuts the DSCR down — the same rule the screen and the search use');
// =============================================================================
{
  /* ⛔ WHY THIS EXISTS. The browser calculator started CUTTING the DSCR down on
     2026-09-03 (the owner's rule of 2026-08-30) while this rule went on ROUNDING TO
     NEAREST — so the two halves of one comparison were judged by two different
     rules, and a loan could be refused for a band change that only the disagreement
     had created. MEASURED over 140,007 (searched, achieved) pairs: refusals went
     from 6.675% before that day to 6.997% with the halves split — 1,800 pairs newly
     refused and 1,350 no longer refused. Judged by ONE rule it is 6.785%.

     ⛔ AND THE MEMBER IS BUILT BY HAND HERE, WHICH IS NOT HOW THE REST OF THIS FILE
     WORKS. Everywhere else a fixture goes through `buildSnapshot`, because a member
     nobody builds is a member nobody ships. This section needs a ratio landed on an
     exact half-cent, which the rate-and-loan route cannot reach — so E0 first proves
     the hand-built shape carries exactly the fields the real builder puts on a member
     for this rule to read, and nothing here depends on a field the builder omits. */
  const built = build([q('X', 7.375, 102, base({ dscr: tA }))]).snapshot.members[0];
  const REACH = ['rentMonthly', 'taxMonthly', 'insuranceMonthly', 'hoaMonthly'];
  ok(typeof built.monthlyPI === 'number'
    && REACH.every((k) => Object.prototype.hasOwnProperty.call(built.scenario || {}, k)),
    'E0 the hand-built member below is the shape the real builder produces for this rule');

  /* housing = 1500 + 350 + 150 = 2000, rent 2490 → 1.2450 exactly: the half-cent
     where the two rules genuinely part company, and they part ACROSS a band edge. */
  const hand = (dscr) => ({
    docKind: snapshot.DOC_KINDS.TERM_SHEET,
    members: [{
      label: 'A',
      monthlyPI: 1500,
      scenario: { dscr, rentMonthly: 2490, taxMonthly: 350, insuranceMonthly: 150, hoaMonthly: 0 },
    }],
    prepared: PREP,
  });
  const RAW = 2490 / 2000;
  ok(Math.round(RAW * 100) / 100 === 1.25 && Math.floor(RAW * 100) / 100 === 1.24,
    `E1 the fixture is measured: ${RAW} rounds to 1.25 and cuts to 1.24 — two different bands`);

  /* ⛔ THE ONE THAT MATTERS. Searched at 1.24 (what the screen now shows), achieved
     1.2450. Under round-to-nearest this was refused with "re-price at 1.25" — a band
     this loan has not earned, demanded of an officer whose own screen said 1.24. */
  const same = snapshot.exportGate(hand(1.24));
  ok(same.ok,
    'E2 an option searched at 1.24 whose figures come to 1.2450 EXPORTS — the two halves agree');

  /* The second half of the rule, pinned on its own: the PRICED figure is cut by the
     same rule. A mutation that fixes only the achieved ratio and leaves this one
     rounding passes E2 and fails here. */
  const carried = snapshot.exportGate(hand(1.249));
  ok(carried.ok,
    'E3 …and a searched 1.249 is cut to 1.24 too, so the two halves cannot be judged apart');

  /* The owner's rule stated as a property rather than a case: whatever the document
     is refused with, the ratio it names is never better than the one the figures
     actually produce. Read at the door a person reads, over 601 ratios. */
  let worse = 0; let checked = 0;
  for (let k = 1000; k <= 1600; k += 1) {
    const raw = k / 1000;
    const g = snapshot.exportGate({
      docKind: snapshot.DOC_KINDS.TERM_SHEET,
      members: [{
        label: 'A', monthlyPI: 1500,
        scenario: { dscr: 0.60, rentMonthly: raw * 2000, taxMonthly: 350, insuranceMonthly: 150, hoaMonthly: 0 },
      }],
      prepared: PREP,
    });
    if (g.ok || typeof g.repriceAt !== 'number') continue;
    checked += 1;
    if (g.repriceAt > raw + 1e-12) worse += 1;
  }
  ok(checked > 500 && worse === 0,
    `E4 over ${checked} refusals the ratio it demands is never better than the figures produce (${worse} were)`);
}

// =============================================================================
section('F. one clock, every document');
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
