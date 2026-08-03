/**
 * THE VIEW AND LOCATION CELLS — reading a UAD code, and refusing what is not one.
 *
 * UAD writes these as a semicolon list: a one-letter RATING then up to two
 * FACTOR codes. `N;Res;` is "neutral rating, residential view"; `A;BsySt;` is
 * "adverse rating, busy street". Condition and quality each got a reader; these
 * two never did, and the real 152-report corpus shows both halves of the cost:
 *
 *   · **360 of 769 comparables carry no view or location rating at all**, while
 *     every one of them has a View/Location adjustment line that states one.
 *     `Adverse` is a signal the appraisal tab badges, missing from half the grid.
 *   · **136 comparables show the RAW CODE to a human** — `N;Res;` (110),
 *     `N;Res` (11), `A;BsySt;` (6), `N;res;` (5), `N;Res;2.5%` (4) — rendered
 *     verbatim as the property's "Location".
 *
 * Every string below is a real value counted in that corpus.
 *
 * Pure. Run: node scripts/test-uad-rating-pure.js
 */
'use strict';
const { readUadRating } = require('../src/lib/appraisal/uad-rating');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const R = (t) => readUadRating(t);

// ---------------------------------------------------------------------------
// THE CODE
// ---------------------------------------------------------------------------
for (const [t, rating, factor] of [
  ['N;Res;', 'Neutral', 'Residential'],
  ['N;Res', 'Neutral', 'Residential'],
  ['N;res;', 'Neutral', 'Residential'],
  ['A;BsySt;', 'Adverse', 'BusyRoad'],
  ['A;BsyRd;', 'Adverse', 'BusyRoad'],
  ['N;CtyStr;', 'Neutral', 'CityStreet'],
  ['B;WtrFr;', 'Beneficial', 'Waterfront'],
]) {
  const r = R(t);
  ok(r.rating === rating && r.factor === factor && r.source === 'code',
    `"${t}" reads as ${rating} / ${factor}`);
}
ok(R('N;Res;Res').factor === 'Residential; Residential',
  'every factor is kept, not just the first — the dropped one is usually the price-relevant one');

// AN ADJUSTMENT AMOUNT TYPED INTO THE SAME CELL is stripped before anything is
// read. `N;Res;2.5%` and `AVERAGE-4%` are both in the corpus.
ok(R('N;Res;2.5%').rating === 'Neutral' && R('N;Res;2.5%').factor === 'Residential',
  'an adjustment percentage stuck on the end never becomes part of the value');
ok(R('AVERAGE-4%').rating === 'Neutral' && R('AVERAGE-4%').factor === null,
  'nor on a worded cell — and it does not become a factor either');
ok(R('N;Res;-$5,000').rating === 'Neutral', 'a dollar amount is stripped the same way');

// ---------------------------------------------------------------------------
// THE WORDS
// ---------------------------------------------------------------------------
for (const [t, rating] of [['Average', 'Neutral'], ['AVERAGE', 'Neutral'], ['Typical', 'Neutral'],
  ['Adverse', 'Adverse'], ['Beneficial', 'Beneficial'], ['Neutral', 'Neutral']]) {
  ok(R(t).rating === rating, `"${t}" reads as ${rating}`);
}

// ---------------------------------------------------------------------------
// WHAT MUST STAY NULL
// ---------------------------------------------------------------------------
// A FACTOR IS NOT A RATING. Reading "Residential" as neutral would manufacture a
// judgement the appraiser never wrote — and would manufacture "BusyRoad" as
// neutral too, which is the one that matters.
for (const t of ['Residential', 'Suburban', 'BusyRoad', 'urban', 'RESIDENTIAL', 'Commercial']) {
  const r = R(t);
  ok(r.rating === null && r.factor != null && r.source === 'factor',
    `"${t}" names what you are looking at and states no rating`);
  ok(/states no rating/.test(r.why || ''), `and "${t}" says why in words a person can act on`);
}
ok(R('Residential; BusyRoad').rating === null && /BusyRoad/.test(R('Residential; BusyRoad').factor),
  'two factors and no rating is still no rating');

// A RELATIVE WORD IS ABOUT THAT REPORT'S SUBJECT — the identical rule the
// condition reader applies, for the identical reason.
for (const t of ['similar', 'Similar', 'superior', 'inferior', 'same']) {
  const r = R(t);
  ok(r.rating === null && r.factor === null && /compared/.test(r.why || ''),
    `"${t}" is a comparison, not a view or a location`);
}

for (const t of ['', '   ', null, undefined]) {
  ok(R(t).rating === null && R(t).factor === null, `${JSON.stringify(t)} states nothing`);
}
ok(R('N;Res;').original === 'N;Res;' && R('similar').original === 'similar',
  'the appraiser\'s own text is always kept beside whatever we read from it');

// A ONE-LETTER RATING IS ONLY A RATING WHEN IT STANDS ALONE — otherwise "A"
// would claim every word beginning with A.
ok(R('Adjacent to park').rating !== 'Adverse',
  '"Adjacent to park" is not an ADVERSE rating — a letter is a code only on its own');
ok(R('Busy').rating === null, 'and an unrecognised single word is a factor, never a guess at a rating');

console.log(fail
  ? `\ntest-uad-rating-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-uad-rating-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
