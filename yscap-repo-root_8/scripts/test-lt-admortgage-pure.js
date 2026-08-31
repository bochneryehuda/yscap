'use strict';
/**
 * LONG-TERM — A&D MORTGAGE (AIM) adapter: the offline proof.
 *
 * Pure. No network, no database. Runs anywhere, including CI. Everything here is
 * checked against the CAPTURED schema, so a failure means our mapping changed —
 * not that A&D moved.
 *
 *   node scripts/test-lt-admortgage-pure.js
 */
const assert = require('assert');

const S = require('../src/longterm/admortgage/schema');
const scenario = require('../src/longterm/admortgage/scenario');
const { parse, parseRefusal, _internals: P } = require('../src/longterm/admortgage/parse');
const quoteShape = require('../src/longterm/pricing/quote-shape');
const vendorMargin = require('../src/longterm/pricing/vendor-margin');
const mergeMod = require('../src/longterm/pricing/merge');
const routing = require('../src/longterm/pricing/investor-routing');

const FIELDS = S.CAPTURED.groups['33001'].fields;
let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok  ${name}`); };

console.log('\n— the scenario: defaults, and the one rule that is not obvious —');

t('the canonical DSCR default scenario maps with NO problems', () => {
  const r = scenario.buildParams({}, FIELDS);
  assert.deepStrictEqual(r.problems, [], JSON.stringify(r.problems));
});

t('DTI "Not required" goes on the wire as 0 — NOT the option id 256', () => {
  const r = scenario.buildParams({}, FIELDS);
  assert.strictEqual(r.params[12], '0');
  assert.notStrictEqual(r.params[12], '256');
  assert.strictEqual(r.effective.dti, 'Not required');
});

t('a DSCR scenario ALWAYS pairs the sentinel, even when the caller sets a DTI', () => {
  // The pairing is not the caller's to get wrong: any numeric DTI beside a DSCR
  // income type is a 400 from A&D.
  const r = scenario.buildParams({ incomeDoc: 'DSCR', dti: 43 }, FIELDS);
  assert.strictEqual(r.params[12], '0');
});

t('a NON-DSCR scenario sends the caller\'s real DTI', () => {
  const r = scenario.buildParams({ incomeDoc: 'fulldoc', dti: 43 }, FIELDS);
  assert.strictEqual(r.params[12], '43');
  assert.strictEqual(r.effective.incomeDoc, '2Y Full Doc');
});

t('the shared DSCR profile drives every omitted field', () => {
  const r = scenario.buildParams({}, FIELDS).effective;
  assert.strictEqual(r.occupancy, 'Investment');       // profile.occupancy
  assert.strictEqual(r.propertyType, '1 Unit SFR');    // profile.propertyType
  assert.strictEqual(r.incomeDoc, 'DSCR >= 1.25');     // profile.dscr = 1.5
  assert.strictEqual(r.term, '30 Year Fixed');         // profile.termYears = 30
  assert.strictEqual(r.lockDays, '30 Days');           // profile.lockDays = 30
  assert.strictEqual(r.prepayMonths, '5Y PPP');        // profile.prepayMonths = 60
});

t('prepay 0 survives as "No PPP" and is NOT overwritten by the 60-month default', () => {
  const r = scenario.buildParams({ prepayMonths: 0 }, FIELDS);
  assert.strictEqual(r.effective.prepayMonths, 'No PPP');
});

console.log('\n— the DSCR ratio → band mapping, every band and both seams —');

const BANDS = [
  [2.00, 'DSCR >= 1.25'], [1.25, 'DSCR >= 1.25'],
  [1.24, 'DSCR 1.10 - 1.24'], [1.10, 'DSCR 1.10 - 1.24'],
  [1.09, 'DSCR 1.00 - 1.09'], [1.00, 'DSCR 1.00 - 1.09'],
  [0.99, 'DSCR 0.75 - 0.99'], [0.75, 'DSCR 0.75 - 0.99'],
  [0.74, 'DSCR < 0.75'], [0.10, 'DSCR < 0.75'],
];
for (const [ratio, want] of BANDS) {
  t(`DSCR ${ratio} → ${want}`, () => assert.strictEqual(scenario.dscrBandLabel(ratio), want));
}

t('the seams round to 2dp — and this is OUR rule, recorded as unconfirmed by A&D', () => {
  assert.strictEqual(scenario.dscrBandLabel(1.245), 'DSCR >= 1.25');
  assert.strictEqual(scenario.dscrBandLabel(1.2449), 'DSCR 1.10 - 1.24');
  assert.strictEqual(scenario.dscrBandLabel(0.995), 'DSCR 1.00 - 1.09');
  assert.strictEqual(scenario.dscrBandLabel(0.9949), 'DSCR 0.75 - 0.99');
});

t('a non-numeric DSCR is refused by name, never banded', () => {
  const r = scenario.buildParams({ dscr: 'abc' }, FIELDS);
  assert.ok(r.problems.some((p) => p.as === 'dscr' && p.error === 'not_a_number'), JSON.stringify(r.problems));
});

console.log('\n— fail closed: what A&D cannot express is refused, never approximated —');

for (const pt of ['Townhouse', 'Cooperative', 'ManufacturedHousing', 'MultiFamily', 'Modular']) {
  t(`property type ${pt} is REFUSED (A&D offers no equivalent)`, () => {
    const r = scenario.buildParams({ propertyType: pt }, FIELDS);
    assert.ok(r.problems.some((p) => p.as === 'propertyType'), `${pt} was silently accepted`);
  });
}

t('a FICO outside A&D\'s published interval is refused, NOT clamped', () => {
  const r = scenario.buildParams({ fico: 500 }, FIELDS);
  const p = r.problems.find((x) => x.as === 'fico');
  assert.ok(p && p.error === 'out_of_range', JSON.stringify(r.problems));
  assert.strictEqual(p.min, 620);
});

t('a lock A&D does not offer is refused and SAYS what is offered', () => {
  const r = scenario.buildParams({ lockDays: 90 }, FIELDS);
  const p = r.problems.find((x) => x.as === 'lockDays');
  assert.ok(p && Array.isArray(p.offered) && p.offered.includes('30 Days'));
});

console.log('\n— the parse: the price build, measured —');

const RAW = {
  data: [{
    id: 7, label: 'DSCR 30 Year Fixed', bestRateStackRowId: 3,
    description: '<ul><li>Pricing as of: 08/27/26 - 09:46 AM (EST)</li><li>All programs unavailable in: HI, PR</li></ul><p>Adjustments:</p><ul><li>x</li></ul>',
    totalAdjustments: '0.625', lockPeriod: '30 Days',
    adjustments: { 'DSCR >= 1.25 / LTV 65.01 - 70.00': '0.250', '5Y PPP and Investment / LTV 65.01 - 70.00': '0.375' },
    rateStackRows: [
      { id: 0, rate: '5.750', monthlyPayment: '$4,000.00', discount: '3.000', discountAmount: '$22,500.00' },
      { id: 3, rate: '6.125', monthlyPayment: '$3,038.06', discount: '0.125', discountAmount: '$625.00' },
      { id: 8, rate: '7.500', monthlyPayment: '$3,500.00', discount: '-2.500', discountAmount: '-$18,750.00' },
      { id: 9, rate: '7.625', monthlyPayment: '$3,550.00', discount: '-2.500', discountAmount: '-$18,750.00' },
    ],
  }],
};

t('price is the complement of A&D\'s stated points', () => {
  const b = parse(RAW, { lockDays: 30, dscr: 1.5, termMonths: 360 });
  const r = b.programs[0].rungs.find((x) => x.rate === 6.125);
  assert.strictEqual(r.points, 0.125);
  assert.strictEqual(r.price, 99.875);
  assert.strictEqual(r.priceDerived, true);
});

t('basePoints = points + totalAdjustments on an UNCLIPPED rung', () => {
  const b = parse(RAW, { lockDays: 30 });
  const r = b.programs[0].rungs.find((x) => x.rate === 6.125);
  assert.strictEqual(r.basePoints, 0.75);     // 0.125 + 0.625
  assert.strictEqual(r.basePrice, 99.25);
  assert.strictEqual(r.clipped, false);
});

t('a rung on the rebate cap carries basePoints NULL, never a fabricated base', () => {
  const b = parse(RAW, { lockDays: 30 });
  const capped = b.programs[0].rungs.filter((x) => x.clipped);
  assert.strictEqual(capped.length, 2, 'both -2.500 rungs should be detected as clipped');
  for (const r of capped) { assert.strictEqual(r.basePoints, null); assert.strictEqual(r.basePrice, null); }
  assert.strictEqual(b.programs[0].priceCeiling, 102.5);
});

t('a ladder whose minimum appears ONCE is not treated as clipped', () => {
  const one = JSON.parse(JSON.stringify(RAW));
  one.data[0].rateStackRows = one.data[0].rateStackRows.slice(0, 3);   // -2.500 appears once
  const b = parse(one, {});
  assert.strictEqual(b.programs[0].rungs.every((r) => r.clipped === false), true);
  assert.strictEqual(b.programs[0].priceCeiling, null);
});

t('the rate-sheet stamp is pulled out of A&D\'s HTML blob', () => {
  const b = parse(RAW, {});
  assert.strictEqual(b.programs[0].rateSheetAsOf, '08/27/26 - 09:46 AM (EST)');
  assert.ok(b.programs[0].overlays.includes('All programs unavailable in: HI, PR'));
});

t('a 200 with an EMPTY array is a real outcome and says A&D gave no reason', () => {
  const b = parse({ data: [] }, {});
  assert.strictEqual(b.programCount, 0);
  assert.ok(b.notes.includes('no_programs_offered_no_reason_given'));
});

t('A&D\'s 400 becomes the same disqualify shape the other two vendors produce', () => {
  const r = parseRefusal({ title: 'To get at least one available program, change: DSCR >= 1.25 or DTI 00.00% - 43.00%.', errorNumber: '7CC46' });
  assert.strictEqual(r.lenders.length, 1);
  assert.deepStrictEqual(r.changeWhat, ['DSCR >= 1.25', 'DTI 00.00% - 43.00%']);
});

t('every number A&D formats as a display string is parsed, and junk is null', () => {
  assert.strictEqual(P.money('$3,078.59'), 3078.59);
  assert.strictEqual(P.money('-$1,875.00'), -1875);
  assert.strictEqual(P.money(''), null);
  assert.strictEqual(P.money('n/a'), null);
  assert.strictEqual(P.money(null), null);
});

console.log('\n— one quote shape: the screen must not be able to tell —');

t('an A&D option carries exactly the same keys as a Lender Price option', () => {
  const board = parse(RAW, { lockDays: 30, dscr: 1.5, termMonths: 360 });
  const adOpts = quoteShape.optionsFromAdMortgage(board, { loanAmount: 750000, fico: 740, ltv: 75 });
  const lpOpts = quoteShape.optionsFromLenderPrice([{ lender: 'X', program: 'Y', priceBuild: {}, terms: {} }]);
  assert.deepStrictEqual(Object.keys(adOpts[0]).sort(), Object.keys(lpOpts[0]).sort());
});

t('A&D\'s LLPAs arrive INLINE — adjustments is a list, never null', () => {
  const board = parse(RAW, {});
  const o = quoteShape.optionsFromAdMortgage(board, {})[0];
  assert.ok(Array.isArray(o.adjustments) && o.adjustments.length === 2);
  assert.strictEqual(o.evidence.fetched, true);
  assert.deepStrictEqual(Object.keys(o.adjustments[0]).sort(),
    ['adjType', 'group', 'reason', 'type', 'value', 'valueType']);
  assert.strictEqual(o.adjustments[0].valueType, 'Points');
});

t('adjustmentPoints is stated in Lender Price\'s own sign, so the columns match', () => {
  const board = parse(RAW, {});
  const o = quoteShape.optionsFromAdMortgage(board, {}).find((x) => x.priceBuild.noteRate === 6.125);
  // LP: adjustedPoints = basePoints + adjustmentPoints, where adjustmentPoints = -Σ values.
  assert.strictEqual(o.priceBuild.adjustmentPoints, -0.625);
  const sum = o.adjustments.reduce((a, b) => a + b.value, 0);
  assert.strictEqual(Math.round((o.priceBuild.basePoints - sum) * 1000) / 1000, o.priceBuild.adjustedPoints);
});

t('a clipped rung says its build does not reconcile rather than showing one that does not', () => {
  const board = parse(RAW, {});
  const o = quoteShape.optionsFromAdMortgage(board, {}).find((x) => x.priceBuild.noteRate === 7.5);
  assert.strictEqual(o.evidence.appliesToThisRate, false);
  assert.strictEqual(o.evidence.reason, 'rebate_cap_reached_build_does_not_reconcile');
  assert.strictEqual(o.priceBuild.basePoints, null);
});

console.log('\n— the 0.25 margin holdback —');

t('A&D holds back 0.25, on the same rule as LoanNEX', () => {
  assert.strictEqual(vendorMargin.holdbackFor('admortgage'), 0.25);
  assert.strictEqual(vendorMargin.holdbackFor('loannex'), 0.25);
  assert.strictEqual(vendorMargin.holdbackFor('lenderprice'), 0);
});

t('the holdback moves the price down and the points up by exactly 0.25', () => {
  const board = parse(RAW, { lockDays: 30 });
  const held = vendorMargin.applyToBoard(board, 'admortgage', {});
  const r = held.programs[0].rungs.find((x) => x.rate === 6.125);
  assert.strictEqual(r.vendorPrice, 99.875);
  assert.strictEqual(r.price, 99.625);
  assert.strictEqual(r.points, 0.375);
  assert.strictEqual(r.marginHoldback, 0.25);
});

t('the holdback is SHOWN as its own LLPA line, so the build still reconciles', () => {
  const board = parse(RAW, { lockDays: 30 });
  const held = vendorMargin.applyToBoard(board, 'admortgage', {});
  const p = held.programs[0];
  const ours = p.adjustments.find((a) => a.ours === true);
  assert.ok(ours, 'the holdback must appear in the itemization');
  assert.strictEqual(ours.value, -0.25);
  // basePoints − Σ(all values, ours included) === the held-back points
  const r = p.rungs.find((x) => x.rate === 6.125);
  const sum = p.adjustments.reduce((a, b) => a + b.value, 0);
  assert.strictEqual(Math.round((r.basePoints - sum) * 1000) / 1000, r.points);
});

t('applying it twice is a no-op — 0.25, never 0.50', () => {
  const board = parse(RAW, { lockDays: 30 });
  const once = vendorMargin.applyToBoard(board, 'admortgage', {});
  const twice = vendorMargin.applyToBoard(once, 'admortgage', {});
  const a = once.programs[0].rungs.find((x) => x.rate === 6.125);
  const b = twice.programs[0].rungs.find((x) => x.rate === 6.125);
  assert.strictEqual(a.price, b.price);
  assert.strictEqual(b.price, 99.625);
  assert.strictEqual(twice.programs[0].adjustments.filter((x) => x.ours === true).length, 1);
});

console.log('\n— three sources, not two —');

t('the merge knows all three', () => {
  assert.deepStrictEqual(mergeMod.SOURCES, ['lenderprice', 'loannex', 'admortgage']);
  assert.strictEqual(mergeMod.SOURCE_LABELS.admortgage, 'A&D Mortgage');
});

t('A&D is a settable source, beside the other two', () => {
  const settings = require('../src/longterm/pricing/investor-settings');
  assert.ok(settings.SOURCES.includes('admortgage'), JSON.stringify(settings.SOURCES));
});

t('an investor pinned to A&D gets A&D and NOTHING else', () => {
  const all = ['lenderprice', 'loannex', 'admortgage'];
  assert.deepStrictEqual(routing.sourcesUnder('admortgage', all), ['admortgage']);
  assert.deepStrictEqual(routing.sourcesUnder('lenderprice', all), ['lenderprice']);
  assert.deepStrictEqual(routing.sourcesUnder('loannex', all), ['loannex']);
});

t('an investor pinned to a source that did NOT answer comes back empty — never a quiet fallback', () => {
  // The whole point: somebody who set an investor to A&D must not be shown
  // Lender Price's number believing it is A&D's.
  assert.deepStrictEqual(routing.sourcesUnder('admortgage', ['lenderprice', 'loannex']), []);
});

t("'both' still means do-not-restrict, and now lets all three through", () => {
  const all = ['lenderprice', 'loannex', 'admortgage'];
  assert.deepStrictEqual(routing.sourcesUnder('both', all).sort(), [...all].sort());
  assert.deepStrictEqual(routing.sourcesUnder('all', all).sort(), [...all].sort());
});

t('a board with all three sources merges and elects on matched points', () => {
  const mk = (src, lender, price) => ({
    source: src, lender, investor: lender, program: 'P', product: 'P',
    termInMonths: 360, amortizationType: 'Fixed',
    rungs: [{ rate: 6.5, price, points: 100 - price, lockDays: 30 }],
  });
  const merged = mergeMod.merge({
    lenderprice: { source: 'lenderprice', programs: [mk('lenderprice', 'A&D Mortgage LLC', 99.0)] },
    loannex: { source: 'loannex', programs: [mk('loannex', 'A&D Mortgage LLC', 99.5)] },
    admortgage: { source: 'admortgage', programs: [mk('admortgage', 'A&D Mortgage LLC', 100.0)] },
  });
  const e = merged.investors[0];
  assert.deepStrictEqual(e.presentIn.sort(), ['admortgage', 'lenderprice', 'loannex']);
  assert.strictEqual(e.chosen, 'admortgage', `elected ${e.chosen}: ${e.reason}`);
  assert.ok(/A&D Mortgage prices better/.test(e.reason), e.reason);
  assert.strictEqual(merged.summary.inAllSources, 1);
});

t('the two-source comparison keeps its old field names and meaning', () => {
  const mk = (lender, price) => ({
    lender, investor: lender, program: 'P', product: 'P', termInMonths: 360, amortizationType: 'Fixed',
    rungs: [{ rate: 6.5, price, points: 100 - price, lockDays: 30 }],
  });
  const cmp = mergeMod.compare([mk('X', 99.0)], [mk('X', 99.5)]);
  assert.strictEqual(cmp.loannexWins, 1);
  assert.strictEqual(cmp.lenderpriceWins, 0);
  assert.strictEqual(cmp.meanDeltaPrice, 0.5);   // positive = LoanNEX better, as always
});

console.log(`\n${n} assertions passed.\n`);
