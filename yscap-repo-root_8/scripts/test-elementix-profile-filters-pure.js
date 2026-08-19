#!/usr/bin/env node
'use strict';
/**
 * THE ELEMENTIX PROFILE'S FILTERS AND SORT — the whole truth table, offline.
 *
 * WHY THIS FILE EXISTS. The mega profile puts 829 mortgages on one tab and the
 * filter bar is the part of it that can LIE. Every failure mode here renders as
 * a perfectly ordinary table that a loan officer would read as fact:
 *
 *   · a date range that silently drops the rows whose date the vendor never sent
 *     ("only 3 loans in 2025" — when 40 more could not be judged at all);
 *   · a "still open" filter that folds a row which cannot answer in with the
 *     rows that answered "no payoff on record";
 *   · a sort that reads a missing amount as zero, so the cheapest loans and the
 *     unknown ones share the bottom of the list;
 *   · a filter over a TRUNCATED section, which answers a different question from
 *     the one it appears to answer, and looks identical;
 *   · a filter matching nothing, drawn as an empty tab — which on this screen
 *     means "Elementix has none".
 *
 * None of those is visible in a screenshot and none of them throws. So the whole
 * decision lives in `app-v2/src/lib/elementixRows.js` as pure functions and this
 * walks them: the three-valued payoff answer, both sort directions with unknowns
 * last in BOTH, an empty result told apart from an empty section, and the
 * sentences the screen prints about a partial set.
 *
 * §7 additionally reads the COMPONENT and asserts it has no second copy of the
 * decision, and that the paid door it now carries cannot fire on render.
 *
 * PURE: no database, no network, no browser. The module under test is an ES
 * module inside `app-v2` (which is `"type":"module"`), so it is loaded with a
 * dynamic import — the REAL module and the REAL COLUMNS, never a re-typed copy.
 *
 * Run: node scripts/test-elementix-profile-filters-pure.js
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail += 1; console.error(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`}`);
const ids = (view) => view.rows.map((r) => r.id);

(async () => {

const R = await import(pathToFileURL(path.join(ROOT, 'app-v2/src/lib/elementixRows.js')).href);
const { COLUMNS, NO_FILTERS, UNKNOWN_STATE, applyRowView, facetsFor, viewSummary,
  nextSort, sortLabel, payoffStatus, payoffLabel, filtersActive, ymd } = R;

const COLS = COLUMNS.mortgages;

/* FIVE ROWS THAT COVER EVERY CORNER, in the vendor's own measured shapes:
   `mortgageAmount` is a DECIMAL STRING; a person mortgage row spells the
   property `propertyAddresses`; `satisfactionDate` is PRESENT-AND-NULL on a
   live loan; and a row from a different shape has no satisfaction key at all. */
const ROWS = [
  { id: 'm1', recordingDate: '2026-07-06', mortgageAmount: '539000.00', lenderName: 'Alpha Funding',
    satisfactionDate: null, maturityDate: '2027-06-01', countyName: 'Bergen County',
    propertyAddresses: [{ addressFull: '140 FRANCISCO AVE, RUTHERFORD, NJ 07070' }], _source: { state: 'NJ' } },
  { id: 'm2', recordingDate: '2024-01-15', mortgageAmount: '125000', lenderName: 'CoreVest Finance',
    satisfactionDate: '2025-03-02', _source: { state: 'NJ' } },
  { id: 'm3', recordingDate: '2025-06-01', mortgageAmount: null, lenderName: 'Roc Capital',
    satisfactionDate: null, _source: { state: 'fl' } },          // lower case ON PURPOSE
  { id: 'm4', recordingDate: null, mortgageAmount: '900000', lenderName: 'Alpha Funding',
    satisfactionDate: null, _source: { state: 'FL' } },
  // NO `satisfactionDate` KEY AND NO `_source` — the row that cannot answer.
  { id: 'm5', recordingDate: '2023-02-02', mortgageAmount: '400000', lenderName: 'Unknown Co' },
];

const view = (filters, sort, opts) => applyRowView({
  rows: ROWS, cols: COLS, filters: { ...NO_FILTERS, ...(filters || {}) }, sort, ...(opts || {}),
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n1. PAID OFF / STILL OPEN / CANNOT TELL — three answers, never two');
{
  ok(payoffStatus({ satisfactionDate: '2025-03-02' }) === 'paid', 'a recorded satisfaction date is PAID OFF');
  ok(payoffStatus({ satisfactionId: 'sat-1' }) === 'paid', '…a payoff on record with no date is still paid off');
  ok(payoffStatus({ satisfactionDate: null }) === 'open',
    'the field present and EMPTY is "no payoff on record" — the honest reading of still open');
  ok(payoffStatus({ satisfaction_date: '' }) === 'open', '…snake_case spelling included');
  ok(payoffStatus({}) === 'unknown',
    'a row that does not carry the field AT ALL cannot answer — and is not called open');
  ok(payoffStatus(null) === 'unknown' && payoffStatus('nope') === 'unknown',
    'a missing or non-object row is unknown, never a crash');

  /* THE MEASURED TRAP: the captured shape says `loanStatus` "can be null even on
     a live loan, so an absent status is not evidence the loan is closed". If the
     rule ever starts reading it, a vendor gap becomes a claim about a borrower's
     loan. Pinned from the SOURCE, because a behaviour test cannot see a field
     that is merely being consulted. */
  const src = fs.readFileSync(path.join(ROOT, 'app-v2/src/lib/elementixRows.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/loanStatus/.test(code), 'the payoff rule never reads `loanStatus` — the vendor says it is not evidence');

  ok(payoffLabel({ satisfactionDate: '2025-03-02' }) === '2025-03-02', 'the cell prints the payoff DATE when there is one');
  ok(payoffLabel({ satisfactionDate: null }) === 'Open', '…"Open" for a loan with none on record');
  ok(payoffLabel({}) === '—', '…and a DASH, not "Open", for the row that cannot answer');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. THE CONTROLS ARE DERIVED FROM THE COLUMNS, never hand-listed');
{
  const f = facetsFor(ROWS, COLS);
  eq(f.states, ['FL', 'NJ'], 'the states come off the rows\' own source pill, normalised and sorted');
  ok(f.stateless === 1, '…and the one row with no state is COUNTED, not dropped from the picture');
  eq(f.dateCols, ['Recorded', 'Matures'], 'the date range is offered for the date columns this tab declares');
  /* TWO money columns on the mortgages tab, not one. `Price paid` was added
     when the redesign started rendering `deedConsideration` -- what they paid
     for the property -- beside `mortgageAmount`, what they borrowed on it. That
     is the pair an officer is really comparing, and it means this tab now
     offers a CHOICE of money field exactly as the properties tab always has.
     The point of this assertion is unchanged: the filter bar is derived from
     the columns the tab declares and is never hand-listed. */
  eq(f.moneyCols, ['Amount', 'Price paid'], '…the amount range for its money columns');
  eq(f.payoff, { paid: 1, open: 3, unknown: 1 }, 'the payoff tally is stated BEFORE anybody clicks');
  ok(f.payoff.paid + f.payoff.open + f.payoff.unknown === ROWS.length,
    '…and the three add up to every row held — nothing is uncounted');

  const people = facetsFor([{ name: 'A' }], COLUMNS.associated_people);
  eq(people.dateCols, [], 'a tab with no date column is offered no date range');
  eq(people.payoff, null, '…and no payoff filter, because no column can answer it');

  const props = facetsFor([{}], COLUMNS.properties);
  eq(props.dateCols, ['Bought', 'Sold'], 'properties offer a choice of date field');
  eq(props.moneyCols, ['Paid', 'Sold for'], '…and a choice of money field');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. NOTHING SET IS NOT A FILTER — the count line must not over-claim');
{
  ok(filtersActive(NO_FILTERS) === false, 'an untouched bar is not "filtering"');
  ok(filtersActive({ ...NO_FILTERS, dateCol: 'Recorded' }) === false,
    'a date FIELD picked with no dates typed narrows nothing, so it is not active');
  ok(filtersActive({ ...NO_FILTERS, amountCol: 'Amount' }) === false, '…same for the amount field');
  ok(filtersActive({ ...NO_FILTERS, amountCol: 'Amount', min: '0' }) === true,
    'a minimum of ZERO is a real filter — 0 is a number, not "unset"');
  ok(filtersActive({ ...NO_FILTERS, q: '  ' }) === false, 'whitespace typed into the search box is not a filter');

  const v = view();
  eq(viewSummary(v, { noun: 'mortgages' }).main, '5 mortgages held',
    'with nothing set the line states what is HELD, and claims no narrowing');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. THE FILTERS — and the rows a filter CANNOT judge');
{
  eq(ids(view({ state: 'NJ' })), ['m1', 'm2'], 'state narrows to that state');
  eq(ids(view({ state: 'FL' })), ['m3', 'm4'], '…matching case-insensitively on the vendor\'s own spelling');
  eq(ids(view({ state: UNKNOWN_STATE })), ['m5'],
    'the rows with NO state are reachable as their own answer, not stranded');

  eq(ids(view({ q: 'alpha' })), ['m1', 'm4'], 'free text still searches the row');
  eq(ids(view({ q: 'bergen county' })), ['m1'],
    '…including a field no column shows — the whole row, not just what is on screen');

  // ---- the date range
  const d = view({ dateCol: 'Recorded', from: '2024-01-01', to: '2026-12-31' });
  eq(ids(d), ['m1', 'm2', 'm3'], 'a date range keeps the rows inside it');
  ok(d.shown === 3 && d.held === 5, '…and reports 3 of 5 held');
  eq(d.notes.dateUnknown, { column: 'Recorded', count: 1 },
    'THE ROW WITH NO DATE IS NOT SILENTLY GONE — it is counted and named');
  ok(!/Recorded/.test(JSON.stringify(view({ dateCol: 'Recorded' }).notes)),
    'no note is raised when no range was actually typed');
  eq(ids(view({ dateCol: 'Recorded', from: '2026-01-01' })), ['m1'], 'a one-sided range works from');
  eq(ids(view({ dateCol: 'Recorded', to: '2023-12-31' })), ['m5'], '…and to');
  eq(ids(view({ dateCol: 'Recorded', from: '2024-01-15', to: '2024-01-15' })), ['m2'],
    'the range is INCLUSIVE at both ends — a single-day range finds that day');
  eq(ids(view({ dateCol: 'Matures', from: '2027-01-01' })), ['m1'],
    'switching the date field filters the OTHER date, not the first one');

  // ---- the amount range
  const a = view({ amountCol: 'Amount', min: '200000' });
  eq(ids(a), ['m1', 'm4', 'm5'], 'an amount floor reads the vendor\'s DECIMAL STRING as a number');
  eq(a.notes.amountUnknown, { column: 'Amount', count: 1 }, '…and the row with no amount is counted, not hidden');
  eq(ids(view({ amountCol: 'Amount', min: '125000', max: '539000' })), ['m1', 'm2', 'm5'],
    'a floor and a ceiling are both inclusive');

  // ---- two ranges at once: each note counts only what IT could not judge
  const both = view({ dateCol: 'Recorded', from: '2024-01-01', amountCol: 'Amount', min: '200000' });
  eq(ids(both), ['m1'], 'two ranges narrow together');
  eq(both.notes.dateUnknown, { column: 'Recorded', count: 1 }, '…the undated row is attributed to the DATE range');
  eq(both.notes.amountUnknown, { column: 'Amount', count: 1 }, '…the amountless row to the AMOUNT range');
  ok(both.notes.dateUnknown.count + both.notes.amountUnknown.count === 2,
    'and a row excluded for a REAL reason is in neither note — the sentences never over-claim');

  // ---- the payoff filter
  eq(ids(view({ payoff: 'paid' })), ['m2'], 'paid off = a satisfaction on record');
  eq(ids(view({ payoff: 'open' })), ['m1', 'm3', 'm4'], 'still open = the field present and empty');
  eq(ids(view({ payoff: 'unknown' })), ['m5'], 'AND THE THIRD STATE IS REACHABLE ON ITS OWN');
  ok(view({ payoff: 'paid' }).shown + view({ payoff: 'open' }).shown + view({ payoff: 'unknown' }).shown === ROWS.length,
    'the three filters partition every row held — none is counted twice, none is lost');

  // ---- filters combine
  eq(ids(view({ state: 'NJ', payoff: 'open' })), ['m1'], 'filters combine rather than replace one another');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. SORTING — both directions, and nothing missing sorts as something');
{
  eq(ids(view({}, { h: 'Amount', dir: 'desc' })), ['m4', 'm1', 'm5', 'm2', 'm3'],
    'largest first — and the row with NO amount is last, not first');
  eq(ids(view({}, { h: 'Amount', dir: 'asc' })), ['m2', 'm5', 'm1', 'm4', 'm3'],
    'smallest first — and the unknown is STILL last, not mistaken for the smallest');

  eq(ids(view({}, { h: 'Recorded', dir: 'desc' })), ['m1', 'm3', 'm2', 'm5', 'm4'],
    'newest first — the undated row last');
  eq(ids(view({}, { h: 'Recorded', dir: 'asc' })), ['m5', 'm2', 'm3', 'm1', 'm4'],
    'oldest first — the undated row still last, never read as the year zero');

  eq(ids(view({}, { h: 'Lender', dir: 'asc' })), ['m1', 'm4', 'm2', 'm3', 'm5'],
    'text sorts A to Z, and ties keep the vendor\'s own order (stable)');
  eq(ids(view({}, { h: 'Lender', dir: 'desc' })), ['m5', 'm3', 'm2', 'm1', 'm4'],
    '…Z to A, and the tie is STILL in the vendor\'s order — a reversed sort is not a reversed list');

  eq(ids(view({}, { h: 'Paid off', dir: 'asc' })), ['m2', 'm1', 'm3', 'm4', 'm5'],
    'sorting the payoff column puts paid off first — and "cannot tell" last');
  eq(ids(view({}, { h: 'Paid off', dir: 'desc' })), ['m1', 'm3', 'm4', 'm2', 'm5'],
    '…the other way puts still-open first, and "cannot tell" is last AGAIN');

  ok(ids(view({}, { h: 'Not a column', dir: 'asc' })).join() === 'm1,m2,m3,m4,m5',
    'a sort on a column that is not there leaves the list alone rather than emptying it');

  // sorting NEVER changes the membership
  const sortedFiltered = view({ state: 'NJ' }, { h: 'Amount', dir: 'desc' });
  eq(ids(sortedFiltered), ['m1', 'm2'], 'a sort re-orders the FILTERED rows and adds none back');

  // the input array is not re-ordered under the caller
  eq(ROWS.map((r) => r.id), ['m1', 'm2', 'm3', 'm4', 'm5'], 'the rows handed in are never mutated');

  // the click cycle and what it is called
  const amount = COLS.find((c) => c.h === 'Amount');
  const lender = COLS.find((c) => c.h === 'Lender');
  eq(nextSort(null, amount), { h: 'Amount', dir: 'desc' }, 'the first click on a money column means largest first');
  eq(nextSort({ h: 'Amount', dir: 'desc' }, amount), { h: 'Amount', dir: 'asc' }, '…the second reverses it');
  eq(nextSort({ h: 'Amount', dir: 'asc' }, amount), null, '…the third returns the tab to the order Elementix sent');
  eq(nextSort(null, lender), { h: 'Lender', dir: 'asc' }, 'a text column starts A to Z');
  eq(nextSort({ h: 'Amount', dir: 'asc' }, lender), { h: 'Lender', dir: 'asc' }, 'clicking a different column starts it fresh');

  ok(sortLabel({ h: 'Amount', dir: 'desc' }, COLS) === 'Amount, largest first', 'the current sort is stated in words');
  ok(sortLabel({ h: 'Recorded', dir: 'asc' }, COLS) === 'Recorded, oldest first', '…in the words that suit a date');
  ok(sortLabel({ h: 'Lender', dir: 'desc' }, COLS) === 'Lender, Z to A', '…and the words that suit a name');
  ok(sortLabel(null, COLS) === null, 'no sort, no sentence');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. AN EMPTY RESULT IS NOT AN EMPTY TAB — and a partial set says so');
{
  const none = view({ q: 'zzzz-nobody' });
  ok(none.shown === 0, 'a filter matching nothing shows nothing…');
  ok(none.emptyReason === 'no-match', '…and says WHY it is empty: these filters match nothing');
  ok(none.held === 5, '…while still reporting the 5 rows it holds, so the tab cannot read as "Elementix has none"');

  const empty = applyRowView({ rows: [], cols: COLS, filters: NO_FILTERS });
  ok(empty.emptyReason === 'no-rows', 'a section that genuinely holds nothing is a DIFFERENT empty');
  ok(empty.active === false && empty.held === 0, '…with no filters to blame');

  // ---- the truncated set
  const cut = view({ q: 'alpha' }, null, { truncated: true });
  const s = viewSummary(cut, { noun: 'mortgages' });
  ok(s.main === 'Showing 2 of 5 mortgages held', 'the count is shown out of held, in words');
  ok(/only the ones we pulled in/.test(s.truncatedNote || ''),
    'A FILTER OVER A TRUNCATED SET SAYS SO — the set itself is partial');
  ok(/narrowing part of the list/.test(s.truncatedNote || ''),
    '…and says that filtering it answers a narrower question than it looks like');

  const cutIdle = viewSummary(view({}, null, { truncated: true }), { noun: 'mortgages' });
  ok(/only the ones we pulled in/.test(cutIdle.truncatedNote || '') && !/narrowing/.test(cutIdle.truncatedNote || ''),
    '…and with no filter on, it still says the set is partial, without claiming a filter');

  const whole = viewSummary(view({ q: 'alpha' }), { noun: 'mortgages' });
  ok(whole.truncatedNote === null, 'a COMPLETE section makes no such claim — that would be its own lie');

  const notes = viewSummary(view({ dateCol: 'Recorded', from: '2024-01-01' }), { noun: 'mortgages' }).unknownNotes;
  ok(notes.length === 1 && /1 more have no Recorded date/.test(notes[0]) && /not counted either way/.test(notes[0]),
    'the unjudgeable rows get a sentence of their own, not a footnote nobody reads');

  const cutEmpty = view({ q: 'zzzz-nobody' }, null, { truncated: true });
  ok(cutEmpty.emptyReason === 'no-match' && cutEmpty.truncated === true,
    'filtering a truncated set down to nothing is still "nothing matches", never "there is none"');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. THE REAL COLUMNS, AND THE SCREEN THAT DRAWS THEM');
{
  ok(COLUMNS.foreclosures === COLUMNS.mortgages,
    'foreclosures ARE mortgage rows, so they get the same columns and the same filters');

  for (const [key, cols] of Object.entries(COLUMNS)) {
    const bad = cols.filter((c) => !c.h || typeof c.get !== 'function');
    ok(bad.length === 0, `${key}: every column has a heading and reads the row through a function`);
    const typed = cols.filter((c) => c.kind && c.kind !== 'payoff');
    const missing = typed.filter((c) => typeof c.raw !== 'function');
    ok(missing.length === 0,
      `${key}: every date/money/number column carries a RAW reader — sorting a formatted "$1,000,000" would order it below "$90,000"`);
  }
  const payoffCols = COLUMNS.mortgages.filter((c) => c.kind === 'payoff');
  ok(payoffCols.length === 1 && typeof payoffCols[0].raw === 'function',
    'mortgages declare exactly one payoff column, and it answers the three-valued question');

  const amount = COLS.find((c) => c.h === 'Amount');
  ok(amount.raw({ mortgageAmount: '539000.00' }) === 539000, 'a money reader parses the vendor\'s decimal STRING');
  ok(amount.raw({}) === null, '…and answers null, not 0, when the row has no figure');
  const recorded = COLS.find((c) => c.h === 'Recorded');
  ok(recorded.raw({ recordingDate: '2026-07-06T00:00:00.000Z' }) === '2026-07-06', 'a date reader takes an ISO timestamp');
  ok(recorded.raw({ recordingDate: 'sometime in July' }) === null, '…and refuses to guess at prose');
  ok(ymd('7/4/2026') === '2026-07-04', 'a US-style date is read as the day it names');
  ok(ymd('2026-07-06') < ymd('2026-07-07'), 'days compare as days — no Date object, no timezone shifting a boundary');

  // ---- the component has no second copy of any of this
  const jsx = fs.readFileSync(path.join(ROOT, 'app-v2/src/components/ElementixProfile.jsx'), 'utf8');
  ok(/from '\.\.\/lib\/elementixRows\.js'/.test(jsx), 'the screen imports the decision rather than restating it');
  for (const name of ['applyRowView', 'facetsFor', 'viewSummary', 'nextSort', 'sortLabel', 'payoffStatus', 'haystack']) {
    ok((jsx.match(new RegExp(`function ${name}\\b`, 'g')) || []).length === 0,
      `${name} is not re-declared in the component — one definition, never a second copy`);
  }
  ok(!/rows\.filter\(/.test(jsx), 'the component never filters the rows itself');

  // ---- every control is 16px, or iOS zooms the page on focus
  const controls = [];
  let at = 0;
  for (;;) {
    const i = jsx.slice(at).search(/<(input|select)\b/);
    if (i < 0) break;
    const start = at + i;
    const end = jsx.indexOf('/>', start);
    controls.push(jsx.slice(start, end < 0 ? start + 400 : end));
    at = (end < 0 ? start + 400 : end) + 2;
  }
  ok(controls.length >= 8, `the screen carries ${controls.length} form controls`);
  const small = controls.filter((c) => !/style=\{CTRL\}/.test(c) && !/fontSize: 16/.test(c));
  ok(small.length === 0,
    `every one of them is 16px — anything smaller and iPhone Safari zooms the page on focus${small.length ? `: ${small[0].slice(0, 70)}` : ''}`);
  ok(/fontSize: 16/.test(jsx.slice(jsx.indexOf('const CTRL'), jsx.indexOf('const CTRL') + 260)),
    'the shared control style is 16px at its one definition');

  // ---- the paid door cannot fire on its own
  const code = jsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok((code.match(/api\.elxSkipTrace\(/g) || []).length === 1, 'the paid call is made from exactly ONE place');
  ok(/reason\.trim\(\)\.length < 4/.test(code), '…which refuses a reason under four characters');
  ok(/askConfirm\(/.test(code.slice(code.indexOf('const go ='), code.indexOf('api.elxSkipTrace'))),
    '…and asks for an explicit confirmation before it, in that order');
  const effects = code.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) || [];
  ok(effects.length > 0 && effects.every((e) => !/costCheck|elxSkipTrace|elxAddLead/.test(e)),
    'no effect on this screen touches the cost check or the paid door — nothing spends on render');
  ok(!/costCheck\(/.test(code.slice(code.indexOf('const load ='), code.indexOf('const search ='))),
    '…and opening the profile does not ask the price either');
  ok(/api\.elxFor\(kind, recordId\)/.test(code.slice(code.indexOf('const afterLookup'))),
    'the DETAIL is re-read through the scoped door after a lookup — never taken from the cost route');
  ok(!/stored\.phones|stored\.emails\b/.test(code),
    'the cost route is read for COUNTS only; it does not carry the numbers and is not asked for them');
}

  console.log(fail
    ? `\n${fail} FAILURE(S)`
    : '\nOK  the filters narrow honestly, the unknowns are their own answer, both sorts keep them last, and a partial set says so');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
