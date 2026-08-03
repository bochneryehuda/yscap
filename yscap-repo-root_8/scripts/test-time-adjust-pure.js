/**
 * THE TIME ADJUSTMENT — the two corrections, and everything it refuses.
 *
 * This replaces the single most dangerous wrong answer in the build: a trend
 * measured on our own fifty sales, bunched into one month, that produced 3.95% A
 * MONTH and pre-filled +$190,750 on a $400,000 comparable. So the assertions
 * that matter most are the ones about it declining — no index, an uncovered
 * period, an implausible reading — and the one that proves the contract date
 * genuinely changes the answer.
 *
 * Pure. Run: node scripts/test-time-adjust-pure.js
 */
'use strict';
const { timeAdjustment, describeTimeAdjustment, marketDateOf, indexAt, RULES, _internals } =
  require('../src/lib/research/time-adjust');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

/** A calm market: 1% a quarter, from 2024 Q1 to 2026 Q1. */
const SERIES = [];
{
  let v = 300;
  for (let y = 2024; y <= 2026; y++) {
    for (let q = 1; q <= 4; q++) {
      if (y === 2026 && q > 1) break;
      SERIES.push({ year: y, quarter: q, index_sa: Number(v.toFixed(4)), index_nsa: Number((v * 0.99).toFixed(4)) });
      v *= 1.01;
    }
  }
}
const T = (comp, o = {}) => timeAdjustment(Object.assign(
  { comp, effectiveDate: '2026-02-15', series: SERIES, region: 'NJ' }, o));

// ---------------------------------------------------------------------------
// IT ADJUSTS, AND IT SHOWS ITS WORKING
// ---------------------------------------------------------------------------
{
  const a = T({ sale_date: '2025-02-10', sale_price: 400000 });
  ok(a.available, 'a sale a year back against a published index produces an adjustment');
  ok(a.pct > 0 && a.pct < 6, `a 1%-a-quarter market gives about 4% over a year (${a.pct}%)`);
  ok(a.amount === Math.round(400000 * a.pct / 100), 'and the dollar figure is that percentage of the sale');
  ok(a.months === 12, 'over the right number of months');
  ok(a.fromIndex && a.toIndex && a.toIndex > a.fromIndex, 'with both index readings shown, so it is checkable');
  ok(a.source === 'FHFA HPI', 'and the source is named — a figure has to be traceable to a publication');
}

// ---------------------------------------------------------------------------
// THE CONTRACT DATE, NOT THE SETTLEMENT — AND IT CHANGES THE ANSWER
// ---------------------------------------------------------------------------
{
  const settled = T({ sale_date: '2025-06-30', sale_price: 400000 });
  const contracted = T({ sale_date: '2025-06-30', contract_date: '2025-03-31', sale_price: 400000 });
  ok(settled.dateBasis === 'settlement' && contracted.dateBasis === 'contract',
    'the basis is reported either way');
  ok(contracted.months > settled.months,
    `the contract date is EARLIER, so more months of market movement are corrected for `
    + `(${contracted.months} vs ${settled.months})`);
  ok(contracted.pct > settled.pct,
    'and the adjustment is correspondingly larger — this is real money in a moving market');
  ok(/CONTRACT date, which is the market the price actually evidences/.test(contracted.sentence),
    'the sentence says which date it measured from, and why that one');
  ok(/states no contract date, so the true market date may be one to three months earlier/
    .test(settled.sentence),
  'and a settlement-only sale says outright what it could not know');
}
{
  const m = marketDateOf({ sale_date: '2025-06-30', contract_date: '2025-03-31' });
  ok(m.basis === 'contract' && m.date === '2025-03' && m.stated === true,
    'the contract date wins whenever it is stated');
  ok(marketDateOf({ sale_date: '2025-06-30' }).basis === 'settlement',
    'and the settlement date is the fallback, not the preference');
  ok(marketDateOf({}).date === null, 'with nothing stated reading as nothing, never today');
  ok(marketDateOf({ contract_month: '2025-03' }).basis === 'contract',
    'a contract MONTH is as good as a date — UAD states it that way');
}

// ---------------------------------------------------------------------------
// IT REFUSES RATHER THAN INVENTS
// ---------------------------------------------------------------------------
{
  const a = T({ sale_date: '2025-02-10', sale_price: 400000 }, { series: [] });
  ok(!a.available && a.gate === 'no_index', 'no index for that market is a refusal');
  ok(/a rate about nowhere/.test(a.why),
    'and it refuses to stand a national figure in for a state');
  ok(a.pct === null && a.amount === null, 'with no number of any kind offered');
}
{
  const a = T({ sale_date: '2019-05-01', sale_price: 400000 });
  ok(!a.available && a.gate === 'before_index',
    'a sale older than the published index is refused rather than measured against its first point');
}
{
  // THE LAG IS THE COMMON CASE. The index publishes about two months after a
  // quarter closes, so a sale from last month has no index yet.
  const a = T({ sale_date: '2026-06-01', sale_price: 400000 }, { effectiveDate: '2026-08-03' });
  ok(!a.available && a.gate === 'after_index',
    'a sale more recent than the last published quarter is refused');
  ok(/inventing a value for the gap/.test(a.why), 'and says why inventing one would be wrong');
}
{
  // …but the RECENT END being short is allowed, and reported. An effective date
  // of "today" is normally past the last published quarter; refusing on that
  // would make the adjustment useless on every current valuation.
  const a = T({ sale_date: '2025-02-10', sale_price: 400000 }, { effectiveDate: '2026-08-03' });
  ok(a.available, 'a valuation dated today still gets an adjustment');
  ok(a.uncoveredMonths > 0, `with the unpublished months counted (${a.uncoveredMonths})`);
  ok(/not yet published, so they are not in this figure/.test(a.sentence),
    'and stated in the sentence rather than quietly absorbed');
}
{
  // The reading that produced the original disaster.
  const wild = [{ year: 2025, quarter: 1, index_sa: 100 }, { year: 2025, quarter: 4, index_sa: 190 }];
  const a = T({ sale_date: '2025-02-10', sale_price: 400000 },
    { series: wild, effectiveDate: '2025-11-15' });
  ok(!a.available && a.gate === 'implausible',
    'a reading that says the market moved 60%+ is refused as OUR error, not the market being wild');
  ok(/the reading is wrong rather than the market being extraordinary/.test(a.why),
    'in exactly those words');
  ok(a.amount === null, 'and no dollar figure is pre-filled — the original defect was +$190,750');
}
{
  const flat = [{ year: 2025, quarter: 1, index_sa: 300 }, { year: 2026, quarter: 1, index_sa: 300.4 }];
  const a = T({ sale_date: '2025-02-10', sale_price: 400000 }, { series: flat });
  ok(a.available && a.pct === 0 && a.belowFloor,
    'a market that barely moved gives ZERO, not a $137 line implying precision nobody has');
  ok(/barely moved/.test(a.sentence),
    'and says why it is zero — "no adjustment because nothing moved" and "nobody worked this line" '
    + 'are different things');
}
{
  ok(!T({ sale_price: 400000 }).available, 'a comparable with no date at all is refused');
  ok(T({ sale_date: '2025-02-10' }).available, 'a comparable with no PRICE still yields a percentage');
  ok(T({ sale_date: '2025-02-10' }).amount === null, 'but no dollar figure it cannot compute');
  ok(!T({ sale_date: '2025-02-10' }, { effectiveDate: null }).available,
    'and no effective date is a refusal too');
}

// ---------------------------------------------------------------------------
// A QUARTERLY INDEX READ MONTHLY
// ---------------------------------------------------------------------------
{
  const q1 = _internals.quarterMonthIndex(2025, 1);
  const q2 = _internals.quarterMonthIndex(2025, 2);
  ok(q2 - q1 === 3, 'quarters are three months apart');
  const at = indexAt(SERIES, q1, {});
  ok(at && Math.abs(at.value - SERIES.find((r) => r.year === 2025 && r.quarter === 1).index_sa) < 1e-9,
    'a quarter midpoint reads that quarter exactly');
  const mid = indexAt(SERIES, q1 + 1, {});
  ok(mid.value > at.value && mid.interpolated === true,
    'a month between two quarters is interpolated, and says so — stepping between quarters would make '
    + 'two sales one day apart look three months apart');
}
{
  // SEASONALLY ADJUSTED BY DEFAULT: a March-to-June move is partly just spring,
  // and the adjustment is about trend, not about the calendar.
  const sa = T({ sale_date: '2025-02-10', sale_price: 400000 });
  const nsa = T({ sale_date: '2025-02-10', sale_price: 400000 }, { prefer: 'nsa' });
  ok(sa.prefer === 'sa' && nsa.prefer === 'nsa', 'either series can be asked for');
  ok(sa.available && nsa.available, 'and both answer');
}
{
  const onlyNsa = SERIES.map((r) => ({ year: r.year, quarter: r.quarter, index_nsa: r.index_nsa }));
  const a = T({ sale_date: '2025-02-10', sale_price: 400000 }, { series: onlyNsa });
  ok(a.available, 'a series with only the unadjusted numbers still works');
}

// ---------------------------------------------------------------------------
// NOTHING THROWS
// ---------------------------------------------------------------------------
for (const junk of [undefined, null, {}, { comp: null }, { comp: 5, series: 'x' }]) {
  let a = null, threw = null;
  try { a = timeAdjustment(junk); } catch (e) { threw = e; }
  ok(!threw, `${JSON.stringify(junk)} does not throw`);
  ok(a && a.available === false && a.pct === null,
    `${JSON.stringify(junk)} refuses without inventing a number`);
}
ok(describeTimeAdjustment(null) === null, 'no adjustment produces no sentence');
ok(RULES.MAX_MONTHLY_PCT === 3 && RULES.MAX_TOTAL_PCT === 60 && RULES.MIN_PCT === 0.5,
  'the ceilings and the floor are the stated ones');

console.log(fail
  ? `\ntest-time-adjust-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-time-adjust-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
