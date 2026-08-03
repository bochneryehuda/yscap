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
const { readUadRating, _internals } = require('../src/lib/appraisal/uad-rating');

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

// ---------------------------------------------------------------------------
// A NUMBERED ROAD KEEPS ITS NUMBER
// ---------------------------------------------------------------------------
// Stripping ANY trailing number ate the roads that live in exactly this cell:
// `I-95` read as the factor "I", `Route 9` as "Route". An amount must carry its
// marker — every one of the 86 distinct View/Location descriptions in the real
// corpus writes one (`2.5%`, `-4%`, `-$5,000`) and NOT ONE ends in a bare digit.
for (const [t, factor] of [['I-95', 'I-95'], ['Route 9', 'Route 9'], ['Rt 9', 'Rt 9'],
  ['US 1', 'US 1'], ['Interstate 80', 'Interstate 80']]) {
  ok(R(t).factor === factor, `"${t}" keeps its number — a road is not an adjustment amount`);
}
ok(R('N;Res;Route 9').factor === 'Residential; Route 9',
  'and beside a code too — the truncated "Residential; Route" named a road nobody can find');
// …while the real amounts, all of which carry a marker, still come off.
for (const t of ['N;Res;2.5%', 'A;Adj.toHighway;2.5%', 'A;ThruSt;2.5%', 'AVERAGE-4%', 'N;Res;-$5,000']) {
  ok(!/[$%]/.test(R(t).factor || ''), `"${t}" still has its amount stripped`);
}

// ---------------------------------------------------------------------------
// THE ABBREVIATIONS THE CORPUS ACTUALLY USES
// ---------------------------------------------------------------------------
// `Avg` was being stored as the PLACE — a screen reading "Location: Avg" — which
// is the exact class this module exists to end. `condition-scale.js` already
// reads `avg` as the same word, so it also made the two readers disagree.
for (const t of ['Avg', 'AVG', 'avg']) {
  ok(R(t).rating === 'Neutral' && R(t).factor === null,
    `"${t}" is the rating, not the place`);
}
// A SLASH SEPARATES. Every slash cell in the corpus is a genuine list.
for (const [t, rating, factor] of [
  ['Avg/Corner', 'Neutral', 'Corner'],
  ['Avg/BsyRd', 'Neutral', 'BusyRoad'],
  ['COMM/APART', null, 'Commercial; APART'],
  ['Pond/Residential', null, 'Pond; Residential'],
  ['Suburban/Busy', null, 'Suburban; Busy'],
]) {
  const r = R(t);
  ok(r.rating === rating && r.factor === factor,
    `"${t}" reads as ${rating || 'no rating'} / ${factor}`);
}
// THE SPELLED-OUT FORM OF A CODE MEANS THE CODE. Without these the same fact
// reached a screen under two different words.
for (const [t, factor] of [['N;Residential', 'Residential'], ['A;Cemetery;', 'Cemetery'],
  ['N;CityStreet;', 'CityStreet'], ['A;BusyRd;', 'BusyRoad'], ['A;Commercial;', 'Commercial']]) {
  ok(R(t).factor === factor, `"${t}" expands to ${factor}, the same as its short code`);
}
// `superior view` was unreachable — RELATIVE matches `superior` first — so it was
// removed rather than left looking like a rule.
ok(R('superior view').rating === null && R('superior').rating === null,
  '"superior view" is a comparison first and last — it never yielded Beneficial');

// ---------------------------------------------------------------------------
// IT READS AN UPLOADED FILE, SO IT MUST NOT BE ATTACKABLE BY ONE
// ---------------------------------------------------------------------------
// The first cut of the adjustment-stripping regex had two ambiguous whitespace
// runs, which made it CUBIC: on `N;Res;<N spaces>x` the engine tries every way of
// splitting the run, at every start offset. Measured through the real `extract()`
// path: 1,000 spaces 0.45 s, 2,000 2.8 s, 3,000 9.9 s — and the bare regex at
// 8,000 spaces took 86 SECONDS. It is applied up to 3× per call and called 4× per
// comparable, and Node is single-threaded, so ONE appraisal XML — which any
// borrower or officer can upload — stalled the whole server.
//
// A timing assertion is a blunt instrument, so the threshold is deliberately
// enormous: linear is microseconds and the bug was minutes, and nothing between
// them is a near miss. It runs on the function AND on the exported regex, because
// the regex being safe on its own is what protects any future caller.
{
  // BOTH PADDINGS. The first cut of this test padded with SPACES only, and passed
  // while a trailing DIGIT run was still quadratic — 50,000 digits cost 34.9
  // SECONDS through the real parse path, because `collapse` bounds a whitespace
  // run and nothing bounded a digit run. A guard that tests one shape of the bug
  // is a guard that ships the other.
  const PADS = [[' ', 'spaces'], ['1', 'digits'], [',', 'commas'], ['$', 'dollars']];
  const took = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  // Both worst cases: a run that ends in an adjustment amount (so the strip
  // actually fires) and one that ends in a non-match (so it fails at every
  // offset, which is what the cubic version choked on).
  let fnMs = 0, worstPad = '';
  for (const [ch, name] of PADS) {
    const pad = ch.repeat(20000);
    const ms = Math.max(took(() => R(`N;Res;${pad}2.5%`)), took(() => R(`N;Res;${pad}x`)));
    if (ms > fnMs) { fnMs = ms; worstPad = name; }
  }
  const AMOUNT = `N;Res;${' '.repeat(20000)}2.5%`;
  const NOMATCH = `N;Res;${' '.repeat(20000)}x`;
  // The exported regex is only ever handed a bounded window by `stripAmount`, so
  // it is timed on the whitespace shape it is genuinely responsible for.
  const reMs = Math.max(took(() => _internals.ADJUSTMENT.test(AMOUNT)),
    took(() => _internals.ADJUSTMENT.test(NOMATCH)));
  ok(fnMs < 250, `20,000 characters of padding is read in ${fnMs.toFixed(1)} ms (worst: ${worstPad}) `
    + '— a cell from an uploaded file can never hang the server');
  // …and the WINDOW is what makes that true, not the regex: a digit run that
  // continues past it is left alone rather than half-stripped.
  ok(_internals.stripAmount(`N;Res;${'1'.repeat(200)}`) === `N;Res;${'1'.repeat(200)}`,
    'a number too long to be an adjustment amount is left whole, never truncated');
  ok(_internals.stripAmount('N;Res;2.5%') === 'N;Res;',
    'while a real amount inside the window still comes off');
  ok(reMs < 250, `and the regex ITSELF is linear (${reMs.toFixed(1)} ms), so a future caller that `
    + 'reaches for it directly is safe too');
  ok(R(AMOUNT).rating === 'Neutral' && R(AMOUNT).factor === 'Residential',
    '…and it still reads correctly — the fix is the regex, not a length cap that gives up');
  // The whitespace run is COLLAPSED for parsing, so an absurd cell reads exactly
  // as the ordinary one does — and the appraiser's own text is still returned.
  ok(R(NOMATCH).rating === 'Neutral' && R(NOMATCH).factor === 'Residential; x',
    'an unrecognised trailing word is still passed through as the appraiser wrote it');
  ok(R(AMOUNT).original === AMOUNT,
    'and `original` is still the appraiser\'s own text, untouched by the collapse');
}

console.log(fail
  ? `\ntest-uad-rating-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-uad-rating-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
