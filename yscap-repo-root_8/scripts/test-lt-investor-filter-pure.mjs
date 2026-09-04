#!/usr/bin/env node
/**
 * LT test — THE INVESTOR FILTER'S PURE RULES (owner-directed 2026-08-27).
 *
 * The overlay that narrows the Pricing Engine's BOARD — never its search. These
 * rules decide which rows are drawn and what the screen must say about it, and
 * they live in a plain-JS module (app-v2/src/longterm/investorFilter.js) for the
 * same reason priceBuild.js does: a rule inside the screen is a rule CI cannot
 * run. This suite RUNS them:
 *
 *   1. no selection = the answer untouched, byte for byte
 *   2. a selection keeps the chosen investors AND every unresolved row — hiding
 *      a row nobody chose to hide is the silent drop this engine exists not to do
 *   3. what is hidden is COUNTED, for the screen to say out loud
 *   4. a selected investor absent from the answer is NAMED
 *   5. Expand All's key set genuinely covers every section
 *
 * Pure: no DOM, no build, no network.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = await import(new URL('../app-v2/src/longterm/investorFilter.js', import.meta.url));
const PB = await import(new URL('../app-v2/src/longterm/priceBuild.js', import.meta.url));

let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };

console.log('LT — the investor filter rules (display overlay, never a search input)\n');

const PROGRAMS = [
  { lender: 'Verus', investorKey: 'verus', whiteLabel: 'Pearl', program: 'A' },
  { lender: 'Deephaven Mortgage', investorKey: 'deephaven', whiteLabel: 'Diamond', program: 'B' },
  { lender: 'Deephaven Mortgage', investorKey: 'deephaven', whiteLabel: 'Diamond', program: 'C' },
  { lender: 'Mystery Lender', investorKey: null, whiteLabel: null, program: 'D' },
];

// 1) NO SELECTION = UNTOUCHED.
{
  const a = F.filterPrograms(PROGRAMS, null);
  ok(a.programs === PROGRAMS && a.hidden === 0 && a.total === 4,
    'IF-1 null selection returns the SAME array — the unfiltered board cannot drift');
  const b = F.filterPrograms(PROGRAMS, new Set());
  ok(b.programs === PROGRAMS && b.hidden === 0,
    'IF-2 an EMPTY selection means all investors too — empty is not "nobody"');
  ok(!F.selectionActive(null) && !F.selectionActive(new Set()) && F.selectionActive(new Set(['verus'])),
    'IF-3 selectionActive is true only when something is actually ticked');
}

// 2) A SELECTION KEEPS THE CHOSEN + EVERY UNRESOLVED ROW.
{
  const a = F.filterPrograms(PROGRAMS, new Set(['verus']));
  ok(a.programs.length === 2 && a.programs[0].investorKey === 'verus' && a.programs[1].investorKey === null,
    'IF-4 selecting Pearl keeps Pearl AND the unresolved row — a lender nobody has mapped is never hidden');
  ok(a.hidden === 2 && a.total === 4, 'IF-5 …and the two hidden Diamond rows are COUNTED');
  const b = F.filterPrograms(PROGRAMS, new Set(['deephaven', 'verus']));
  ok(b.programs.length === 4 && b.hidden === 0, 'IF-6 selecting everything present hides nothing');
  ok(F.filterPrograms('garbage', new Set(['x'])).programs.length === 0,
    'IF-7 a non-array yields empty rather than throwing');
}

// 3) THE INELIGIBLE SIDE — same rule, same shape.
{
  const L = [
    { lender: 'NewRez, LLC Wholesale', investorKey: 'newrez', items: [] },
    { lender: 'Amwest', investorKey: 'amwest', items: [] },
    { lender: 'Nobody Knows', investorKey: null, items: [] },
  ];
  const a = F.filterDisqualifiedLenders(L, new Set(['newrez']));
  ok(a.lenders.length === 2 && a.hidden === 1,
    'IF-8 the declined board keeps the chosen investor and the unresolved lender, and counts the hidden one');
  ok(F.filterDisqualifiedLenders(L, null).lenders === L,
    'IF-9 …and passes the answer through untouched with no selection');
}

// 4) TOGGLE — a new Set every time, never a mutation.
{
  const s = new Set(['a']);
  const on = F.toggleKey(s, 'b');
  ok(on !== s && on.has('a') && on.has('b') && s.size === 1,
    'IF-10 toggling on returns a NEW set and leaves the old one alone');
  const off = F.toggleKey(on, 'a');
  ok(off.size === 1 && off.has('b'), 'IF-11 toggling off removes exactly that key');
  ok(F.toggleKey(null, 'x').has('x'), 'IF-12 toggling from "all" starts a fresh selection');
}

// 5) A SELECTED INVESTOR ABSENT FROM THE ANSWER IS NAMED.
{
  const roster = [{ key: 'verus', whiteLabel: 'Pearl' }];
  const full = [
    { key: 'verus', whiteLabel: 'Pearl', investorLabel: 'Verus Mortgage Capital' },
    { key: 'corrfirst', whiteLabel: 'Prime', investorLabel: 'CorrFirst' },
  ];
  const m = F.missingFromAnswer(new Set(['verus', 'corrfirst']), roster, full);
  ok(m.length === 1 && m[0].key === 'corrfirst' && m[0].whiteLabel === 'Prime'
    && m[0].investorLabel === 'CorrFirst',
  'IF-13 CorrFirst selected but absent is named, with both its names');
  ok(F.missingFromAnswer(null, roster, full).length === 0,
    'IF-14 …and with no selection there is nothing to say');
  const unknown = F.missingFromAnswer(new Set(['ghost']), roster, []);
  ok(unknown.length === 1 && unknown[0].whiteLabel === 'ghost',
    'IF-15 a key the sheet does not know still surfaces (as its key) rather than vanishing');
}

// 6) THE OVERLAY SENTENCE — says display-only, and only when narrowing.
{
  ok(F.overlaySummary(null, 5) === null, 'IF-16 no selection, no sentence');
  const s = F.overlaySummary(new Set(['a', 'b']), 7);
  ok(/Showing 2 investors — display only/.test(s) && /7 programs hidden/.test(s)
    && /Lender Price was asked for everything/.test(s),
  'IF-17 the sentence counts, says DISPLAY ONLY, and names the un-narrowed search');
  ok(/Showing 1 investor — display only/.test(F.overlaySummary(new Set(['a']), 0)),
    'IF-18 …and reads grammatically at one');
}

// 7) EXPAND ALL — every rate row, and every multi-programme lender within one.
{
  const rates = [
    { key: '5.750', quotes: [
      { lender: 'A', price: 99 }, { lender: 'A', price: 98 }, { lender: 'B', price: 97 },
    ] },
    { key: '5.875', quotes: [{ lender: 'C', price: 100 }] },
  ];
  const { rateKeys, lenderKeys } = F.expandAllKeys(rates, PB.groupByLender);
  ok(rateKeys.length === 2 && rateKeys.includes('5.750') && rateKeys.includes('5.875'),
    'IF-19 every rate row opens');
  ok(lenderKeys.length === 1 && lenderKeys[0] === '5.750|A',
    'IF-20 …and only the multi-programme lender gets its dropdown opened — a single-programme one has nothing to open');
  ok(F.expandAllKeys(null, PB.groupByLender).rateKeys.length === 0,
    'IF-21 a non-array yields nothing rather than throwing');
  const bare = F.expandAllKeys(rates, undefined);
  ok(bare.rateKeys.length === 2 && bare.lenderKeys.length === 0,
    'IF-22 with no grouping handed in, the rates still open and no lender key is invented');
}

// 8) THE INELIGIBLE BOARD CARRIES BOTH NAMES TOO — the server's white-label decoration on a
//    disqualified LENDER entry survives the reshape, so the board's tag reads it off `best`
//    exactly as the eligible board does (owner-directed 2026-08-27: internally the team sees the
//    REAL name AND the white-label name on BOTH boards; only clients see the white-label alone).
{
  const stack = PB.buildIneligibleStack([
    { lender: 'Deephaven', investorKey: 'deephaven', whiteLabel: 'Diamond',
      items: [{ program: 'DSCR 30yr Fixed', rate: 7.5, reasons: ['dscr'] }] },
    { lender: 'Amwest', items: [{ program: 'Mystery', rate: 7.5, reasons: [] }] },
  ]);
  const row = stack.rates[0];
  const dh = row && row.lenders.find((g) => g.lender === 'Deephaven');
  const aw = row && row.lenders.find((g) => g.lender === 'Amwest');
  ok(dh && dh.best && dh.best.whiteLabel === 'Diamond',
    'IF-23 a disqualified lender\'s white-label rides the reshape onto `best`, where the board\'s tag reads it');
  ok(dh && dh.best && dh.best.program === 'DSCR 30yr Fixed',
    'IF-24 …beside the vendor\'s REAL programme name, which is never replaced');
  ok(aw && aw.best && aw.best.whiteLabel === null,
    'IF-25 …and an unmapped lender carries NULL — never a guessed name');
}

console.log(`\n${failures === 0 ? 'OK — the overlay rules hold' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
