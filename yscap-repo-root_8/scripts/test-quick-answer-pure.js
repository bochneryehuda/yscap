/**
 * QUICK ANSWER — the refusals are the feature.
 *
 * This is the surface most likely to be mistaken for a Zestimate: an address, a
 * couple of basics, and a number. Everything asserted here is about it declining
 * to be that — no point estimate, never a figure without its denominator, never
 * a range without the recency span, and nothing at all below five matches.
 *
 * Pure. Run: node scripts/test-quick-answer-pure.js
 */
'use strict';
const { quickAnswer, describeQuick, RULES, _internals } = require('../src/lib/research/quick-answer');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const row = (price, date, asis = 1, extra = {}) => Object.assign(
  { last_sale_price: price, last_sale_date: date, asis_comp_count: asis, arv_comp_count: 0,
    gla: 1500, display_address: `${price} Test St` }, extra);

/** Nine sales, the owner's own example shape. */
const NINE = [
  row(385000, '2025-06-10'), row(398000, '2025-08-02'), row(410000, '2025-10-19'),
  row(420000, '2026-01-11'), row(428000, '2026-02-20'), row(436000, '2026-03-05'),
  row(447000, '2026-04-02'), row(458000, '2026-04-28'), row(470000, '2026-05-06'),
];
const ASKED = { radiusMiles: 1, months: 18, units: 1, glaMin: 1200, glaMax: 1900, condition: 'C4' };
const A = (o) => quickAnswer(Object.assign({ today: '2026-08-03', asked: ASKED }, o));

// ---------------------------------------------------------------------------
// IT ANSWERS WHEN IT HONESTLY CAN — AND IN THE RIGHT SHAPE
// ---------------------------------------------------------------------------
{
  const q = A({ rows: NINE });
  ok(q.available, 'nine priced sales produce an answer');
  ok(q.n === 9, 'and the denominator is the nine that actually carried a price');
  ok(q.low === 385000 && q.high === 470000, 'the headline is a RANGE, low to high');
  ok(q.median === 428000, 'with the median quoted inside it');
  ok(q.asIsCount === 9, 'and how many were as-is grids');
  ok(q.gridKnownCount === 9, 'counted over the rows that actually state it');
  ok(q.newestMonthsAgo === 2, `and how long ago the most recent one was (${q.newestMonthsAgo})`);
  ok(q.spanMonths === 10, `and the span the set covers (${q.spanMonths})`);

  // THE SENTENCE IS THE SAFETY FEATURE. Every one of these must be in it.
  const s = q.sentence;
  ok(/^In the 9 properties we hold/.test(s), `the sentence LEADS with the denominator (${s})`);
  ok(/within 1 mile/.test(s) && /in the last 18 months/.test(s),
    'and states where and over what period it looked');
  ok(/between \$385,000 and \$470,000/.test(s), 'and quotes a RANGE');
  ok(/median \$428k/.test(s), 'with the median AFTER the range, never in front of it');
  ok(s.indexOf('between') < s.indexOf('median'), 'never a point estimate — the range comes first');
  ok(/9 of the 9 that say were as-is grids/.test(s), 'and says how many were as-is grids');
  ok(/Most recent 2 months ago/.test(s), 'and always the recency');
  ok(/1-unit/.test(s) && /1,200–1,900 sqft/.test(s) && /in C4/.test(s),
    'and restates what was asked for, so the answer cannot be read as being about something else');
}

// ---------------------------------------------------------------------------
// IT REFUSES BELOW FIVE — AND BLAMES OUR COVERAGE, NOT THE FILTERS
// ---------------------------------------------------------------------------
ok(RULES.MIN_MATCHES === 5, 'the floor is five');
for (const n of [0, 1, 2, 3, 4]) {
  const q = A({ rows: NINE.slice(0, n), heldNearby: 40 });
  ok(!q.available && q.gate === 'too_few', `${n} matches is a refusal, not a range`);
  ok(q.low === null && q.high === null && q.median === null,
    `${n} matches produces NO number of any kind — not a range, not a median`);
  ok(q.sentence === null, `${n} matches produces no sentence to misread`);
}
{
  const q = A({ rows: NINE.slice(0, 3), heldNearby: 40 });
  ok(/out of 40 we hold in the area at all/.test(q.why),
    'the refusal states what we DO hold nearby, so "nothing" is a measured claim');
  ok(/our own reports described/.test(q.why),
    'and blames our coverage rather than the filters');
  ok(!/widen/i.test(q.why) && !/broaden/i.test(q.why),
    'it never tells somebody to widen a search that will not help');
}
{
  const q = A({ rows: [], heldNearby: 0 });
  ok(!q.available && /nothing at all like this nearby/.test(q.why),
    'a town we have never lent in says so');
  ok(/no change to the search will help/.test(q.why),
    'and says outright that no filter change will help — the empty state blames coverage');
}

// ---------------------------------------------------------------------------
// A ROW WITH NO PRICE IS NOT A MATCH, AND IS NOT HIDDEN EITHER
// ---------------------------------------------------------------------------
{
  const rows = NINE.slice(0, 6).concat([row(null, '2026-01-01'), row(0, '2026-01-01')]);
  const q = A({ rows });
  ok(q.n === 6, 'a property with no sale price does not pad the denominator');
  ok(q.coverage.noPrice === 2, 'but it IS counted');
  ok(q.flags.some((f) => f.code === 'no_price'), 'and reported as a flag rather than dropped silently');
  ok(q.coverage.matched === 8 && q.coverage.usable === 6,
    'both numbers are stated — what matched, and what could actually be used');
}
{
  // Four priced + three unpriced is still a refusal, and says so.
  const rows = NINE.slice(0, 4).concat([row(null, '2026-01-01'), row(null, '2026-01-01'), row(null, '2026-01-01')]);
  const q = A({ rows, heldNearby: 12 });
  ok(!q.available, 'seven matches of which only four carry a price is still a refusal');
  ok(/3 more matched but state no sale price/.test(q.why),
    'and the refusal explains why the count it used is smaller than the count it found');
}

// ---------------------------------------------------------------------------
// IT SAYS WHEN THE ANSWER IS WEAK — WITHOUT REFUSING TO GIVE IT
// ---------------------------------------------------------------------------
{
  // A set spread more than 60% of its median: the range IS the answer, and it
  // has to say it is wide rather than let a reader average it in their head.
  const wide = [row(200000, '2026-01-01'), row(250000, '2026-02-01'), row(400000, '2026-03-01'),
    row(600000, '2026-04-01'), row(900000, '2026-05-01')];
  const q = A({ rows: wide });
  ok(q.available, 'a widely spread set still answers — a wide range is the honest answer');
  ok(q.flags.some((f) => f.code === 'wide'), 'and is flagged as wide');
  ok(/treat the range as a range and not as a value/.test(
    (q.flags.find((f) => f.code === 'wide') || {}).message || ''),
  'in words that say what to do with it');
}
{
  const old = NINE.map((r) => row(r.last_sale_price, '2023-05-01'));
  const q = A({ rows: old });
  ok(q.available, 'an old set still answers');
  ok(q.flags.some((f) => f.code === 'stale'), 'and says it describes an earlier market');
  ok(/Most recent 3[0-9] months ago/.test(q.sentence), `and the sentence carries it too (${q.sentence})`);
}

// ---------------------------------------------------------------------------
// "0 OF 18" IS A CONFIDENT WRONG ANSWER, NOT A MISSING ONE
// ---------------------------------------------------------------------------
{
  // The real defect: `comp_set` lives on the OBSERVATION and a property row does
  // not carry one, so every row read null and the tally reported "0 of 18 were
  // as-is grids" — saying all eighteen were after-repair grids when we had not
  // looked. A set that states nothing must say nothing.
  const silent = NINE.map((r) => ({ last_sale_price: r.last_sale_price,
    last_sale_date: r.last_sale_date, gla: 1500 }));
  const q = A({ rows: silent });
  ok(q.available, 'a set that never states which grid it sat on still answers on price');
  ok(q.asIsCount === null && q.gridKnownCount === 0,
    'but claims no tally at all rather than reporting zero');
  ok(!/as-is grids/.test(q.sentence),
    `and the sentence stays silent about it (${q.sentence})`);
}
{
  // A MIXED set counts only the ones that say.
  const mixed = [row(400000, '2026-01-01', 1), row(410000, '2026-02-01', 0, { arv_comp_count: 2 }),
    row(420000, '2026-03-01', 1), row(430000, '2026-04-01', 1),
    { last_sale_price: 440000, last_sale_date: '2026-05-01', gla: 1500 }];
  const q = A({ rows: mixed });
  ok(q.n === 5 && q.gridKnownCount === 4 && q.asIsCount === 3,
    `the tally counts only the rows that state it (${q.asIsCount} of ${q.gridKnownCount}, n=${q.n})`);
  ok(/3 of the 4 that say were as-is grids/.test(q.sentence),
    `and the sentence says which denominator it is using (${q.sentence})`);
}

// ---------------------------------------------------------------------------
// NOTHING IS INVENTED, AND NOTHING THROWS
// ---------------------------------------------------------------------------
for (const junk of [undefined, null, {}, { rows: null }, { rows: 'x' }, { rows: [null, undefined, 5] }]) {
  let q = null, threw = null;
  try { q = quickAnswer(junk); } catch (e) { threw = e; }
  ok(!threw, `${JSON.stringify(junk)} does not throw`);
  ok(q && q.available === false && q.median === null,
    `${JSON.stringify(junk)} refuses without inventing a number`);
}
ok(describeQuick(null) === null, 'no answer produces no sentence');
ok(describeQuick({ n: 0 }) === null, 'and neither does an empty one');
{
  // A set with no dates at all still answers on price, and simply does not claim
  // a recency it cannot support.
  const undated = NINE.map((r) => row(r.last_sale_price, null));
  const q = A({ rows: undated });
  ok(q.available && q.newestMonthsAgo === null && q.spanMonths === null,
    'undated sales answer on price and claim no recency');
  ok(!/Most recent/.test(q.sentence), 'and the sentence does not invent one');
}
{
  // The month arithmetic, which the recency claim rests on.
  const m = _internals.monthsBetween;
  ok(m('2026-01-15', '2026-08-03') === 6, 'six full months, not seven — the day of the month counts');
  ok(m('2026-01-15', '2026-08-15') === 7, 'and seven on the day it completes');
  ok(m('2025-12-31', '2026-01-01') === 0, 'a day across a year boundary is not a month');
  ok(m(null, '2026-01-01') === null && m('x', '2026-01-01') === null,
    'and an unreadable date is null, never a guessed zero');
}
{
  ok(_internals.approx(428000) === '$428k', 'a median is said the way a person says it');
  ok(_internals.approx(1240000) === '$1.24m', 'including over a million');
}

console.log(fail
  ? `\ntest-quick-answer-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-quick-answer-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
