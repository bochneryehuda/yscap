/**
 * WHAT OUR APPRAISERS CHARGE FOR A SQUARE FOOT — and the five rules that make it
 * a defensible claim instead of an indefensible one.
 *
 * The warehouse holds ~9× more adjustment evidence than sale evidence, which is
 * the largest single opportunity in the research build. It only pays off if the
 * claim is *"this report used $18 a foot; our other 59 reports used $40–50"* —
 * a statement about OUR APPRAISERS, every number of which we were handed in
 * writing — rather than *"a square foot is worth $50 in Newark"*, which this
 * sample cannot support.
 *
 * THE ONE THAT MOVES THE NUMBERS MOST is the decline. An appraiser who saw a
 * 200-foot gap and adjusted $0 made a JUDGEMENT, and averaging it in as "$0 a
 * foot" turns a considered decision into evidence about price. Measured on the
 * real corpus: 621 of 767 Age lines and 326 of 767 BasementArea lines are
 * exactly that, and 47 of NJ's own square-foot lines.
 *
 * Pure. Run: node scripts/test-adjustment-corpus-pure.js
 */
'use strict';
const AC = require('../src/lib/research/adjustment-corpus');
const { summarizeRates, compareRate, rateOf, RULES } = AC;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

/** One adjustment line: $`amount` for a `delta`-foot difference. */
const line = (amount, delta, report, appraiser, basis = 'sqft') => ({
  amount, unit_delta: delta, unit_delta_basis: basis,
  appraisal_id: report, appraiser_id: appraiser,
});
/** n lines at a given rate, each from its own report and appraiser. */
const spread = (rates, tag = '') => rates.map((r, i) =>
  line(r * 100, 100, `${tag}r${i}`, `${tag}a${i}`));

// ---------------------------------------------------------------------------
// ONE LINE → ONE RATE, OR A REASON THERE IS NONE
// ---------------------------------------------------------------------------
ok(rateOf(line(5000, 100, 'r', 'a')).rate === 50, '$5,000 over a 100-foot gap is $50 a foot');
ok(rateOf(line(-5000, -100, 'r', 'a')).rate === 50,
  'and the signs cancel — a comparable BIGGER than the subject is adjusted DOWN, same rate');

// RULE 1 — THE ONE THAT MATTERS MOST.
{
  const d = rateOf(line(0, 200, 'r', 'a'));
  ok(d.decline === true && d.rate === null,
    'a 200-foot gap adjusted at $0 is a DECLINE — a judgement that it did not matter here');
  ok(/adjusted nothing/.test(d.why || ''), 'and it says so, rather than reading as missing data');
}
ok(rateOf(line(0, 5, 'r', 'a')).decline === false,
  '…but $0 over a FIVE-foot gap is not a judgement about anything — there was nothing to adjust for');

// The arithmetic traps.
ok(rateOf(line(500, 5, 'r', 'a')).rate === null,
  'a rate from a tiny difference is arithmetic, not a market signal — $500 over 5 feet is not "$100 a foot"');
ok(rateOf(line(5000, -100, 'r', 'a')).rate === null,
  'an adjustment running AGAINST the difference is a data error — it is how a corpus starts reporting '
  + 'that space is worth less than nothing');
ok(rateOf(line(100000, 100, 'r', 'a')).rate === null,
  'and nobody adjusts a thousand dollars a foot — one such row drags a median further than ten pull it back');
for (const bad of [line(null, 100, 'r', 'a'), line(5000, null, 'r', 'a'), {}, null]) {
  ok(rateOf(bad).rate === null, 'a malformed line yields no rate and does not throw');
}

// ---------------------------------------------------------------------------
// THE SUMMARY, AND EVERYTHING THAT TRAVELS WITH IT
// ---------------------------------------------------------------------------
{
  const s = summarizeRates(spread([40, 45, 50, 55, 60, 65]));
  ok(s.available, 'six rates from six reports by six appraisers is a usable sample');
  ok(s.median === 52.5, `the median is the middle, not a mean (${s.median})`);
  // RULE 2 — the IQR, never a σ.
  ok(s.q1 != null && s.q3 != null && s.q1 < s.median && s.median < s.q3,
    'and the spread is the QUARTILES — a σ would imply a normal distribution and a calibrated model, '
    + 'and this is a small, skewed, human sample');
  ok(!('sd' in s) && !('stdev' in s), 'a standard deviation is never even offered');
  ok(/half of them were between/.test(s.sentence || ''),
    'the sentence says what the quartiles MEAN, so a reader can act on it without believing anything '
    + 'about the shape');
  // RULE 3 — the counts that qualify it.
  ok(/\d+ of our reports/.test(s.sentence) && /\d+ appraisers/.test(s.sentence),
    'and every count that qualifies the number travels WITH it — a median with no n and no report '
    + 'count is the indefensible version of this claim');
}

// RULE 1, AT THE SUMMARY LEVEL — the declines are counted and never averaged in.
{
  const rates = spread([40, 45, 50, 55, 60, 65]);
  const withDeclines = rates.concat([line(0, 300, 'd1', 'da1'), line(0, 400, 'd2', 'da2')]);
  const a = summarizeRates(rates);
  const b = summarizeRates(withDeclines);
  ok(b.declines === 2 && a.declines === 0, 'declines are counted');
  ok(b.median === a.median,
    'and they do NOT move the median — averaging a considered $0 in as a rate of zero would drag '
    + 'every one of these toward nothing');
  ok(/saw the same difference and adjusted nothing/.test(b.sentence || ''),
    'and they are REPORTED, because "two more looked and chose not to" is the most useful thing here');
}

// RULE 4 — no one appraiser is the market.
{
  // Nine lines from one prolific appraiser, three from three others.
  const hog = [80, 82, 84, 86, 88, 90, 92, 94, 96].map((r, i) => line(r * 100, 100, `h${i}`, 'HOG'));
  const rest = [40, 42, 44].map((r, i) => line(r * 100, 100, `o${i}`, `O${i}`));
  const s = summarizeRates(hog.concat(rest));
  ok(s.capped === true, 'one appraiser past 40% of the sample is capped');
  ok(s.median < 80,
    `and their personal rate is no longer reported back as what everybody does (median ${s.median})`);
  ok(s.appraisers === 4, 'they still COUNT — once, as the one opinion they are');
  ok(/count once here/.test(s.sentence || ''), 'and the thinning is disclosed, never silent');
}
{
  const even = summarizeRates(spread([40, 45, 50, 55, 60, 65]));
  ok(even.capped === false, 'a balanced sample is not capped, and does not claim to be');
}

// ---------------------------------------------------------------------------
// RULE 5 — IT REFUSES, WHICH IS THE ORDINARY ANSWER
// ---------------------------------------------------------------------------
{
  const s = summarizeRates(spread([40, 45, 50]));
  ok(!s.available && s.gate === 'too_few_rates', 'three rates is an anecdote, not a pattern');
}
{
  // Six rates, all from ONE report — three lines of one grid.
  const s = summarizeRates([50, 52, 54, 56, 58, 60].map((r, i) => line(r * 100, 100, 'one', `a${i}`)));
  ok(!s.available && s.gate === 'too_few_reports', 'six lines from one report is a report, not a pattern');
}
{
  const s = summarizeRates([50, 52, 54, 56, 58, 60].map((r, i) => line(r * 100, 100, `r${i}`, 'same')));
  ok(!s.available && s.gate === 'one_appraiser',
    'and six reports by one appraiser is their habit, not what our appraisers do');
}
{
  const s = summarizeRates([]);
  ok(!s.available && s.n === 0, 'nothing at all is a refusal, not a zero rate');
  ok(summarizeRates(null).available === false && summarizeRates(undefined).available === false,
    'and junk is refused without throwing');
}
{
  // ONLY declines. There is no rate, and the refusal says what was actually seen.
  const s = summarizeRates([line(0, 200, 'r1', 'a1'), line(0, 300, 'r2', 'a2'), line(0, 250, 'r3', 'a3')]);
  ok(!s.available && s.declines === 3,
    'a market where everybody LOOKED and nobody adjusted has no rate — and that is itself the finding');
  ok(/adjusted nothing/.test(s.why || ''), 'and the refusal reports it rather than saying "no data"');
}
// EVERY refusal names a stable gate AND says why in words.
for (const rows of [[], spread([40, 45, 50]),
  [50, 52, 54, 56, 58, 60].map((r, i) => line(r * 100, 100, 'one', `a${i}`))]) {
  const s = summarizeRates(rows);
  ok(!s.available && typeof s.gate === 'string' && s.gate && s.why, 'a refusal carries a gate and a reason');
}

// ---------------------------------------------------------------------------
// THE DELIVERABLE — WHERE THIS REPORT SITS, NEVER WHAT IS CORRECT
// ---------------------------------------------------------------------------
{
  const s = summarizeRates(spread([40, 45, 50, 55, 60, 65]));
  const low = compareRate(18, s);
  ok(low && low.inside === false && low.where === 'below the usual range',
    'a report well under the others is placed, not judged');
  ok(/This report used \$18/.test(low.sentence) && /half of them were between/.test(low.sentence),
    'and the sentence carries BOTH numbers — the reviewer is being pointed at a document, '
    + 'not handed an estimate');
  ok(compareRate(52, s).inside === true, 'a report inside the quartiles says so');
  ok(compareRate(200, s).where === 'above the usual range', 'and one well above says that');
  ok(!/should|correct|wrong|too low|too high/i.test(low.sentence),
    'nothing anywhere says what the rate SHOULD have been — that is the indefensible claim');
  ok(compareRate(50, { available: false }) === null && compareRate(null, s) === null,
    'and with nothing to compare against it says nothing');
}

// The unit is named from the data, never assumed.
{
  const gba = summarizeRates(spread([40, 45, 50, 55, 60, 65]).map((l) =>
    Object.assign({}, l, { unit_delta_basis: 'sqft_gba' })));
  ok(/square foot of building/.test(gba.sentence || ''),
    'a 1025 grid states GROSS BUILDING area, and saying "a square foot" of that would compare it '
    + 'with living area on a 1004');
}

console.log(fail
  ? `\ntest-adjustment-corpus-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-adjustment-corpus-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
