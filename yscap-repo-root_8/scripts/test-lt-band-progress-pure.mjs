#!/usr/bin/env node
/**
 * LT test — THE BAND SEARCH'S PROGRESS BAR (owner-directed 2026-09-04).
 *
 * The owner's ask, in full: *"when you search a full scenario, it populates everything
 * right away and then it searches the more scenarios and populates according to the
 * brackets. It should stay everything like it is now, but on top there should be a
 * progress bar somewhere, nicely designed on top, where the progress is bracketing all
 * the brackets and all the scenarios according to the brackets. You shouldn't feel like
 * the system forgot about you."*
 *
 * Three things have to hold, and all three are properties rather than pixels:
 *
 *   1. THE BAR NEVER GOES BACKWARDS. Proved by walking a real event sequence — the
 *      discovery loop widens as it goes — and asserting monotonicity at every step.
 *      This is the whole reason the denominator is the fixed eleven-band ladder rather
 *      than "the bands we have decided to search", and a change back to the obvious
 *      design fails here.
 *   2. IT ALWAYS FINISHES. A deal that only spans three bands must still reach 100%,
 *      or the bar reads as the search having given up.
 *   3. THE FIVE OUTCOMES STAY APART. "the vendor did not answer" and "this loan reaches
 *      no rate here" are different facts, and the finished board already refuses to
 *      collapse them (`failedBrackets`); a bar that only counted would re-introduce it.
 *
 * ⛔ THE SERVER'S EVENTS ARE NOT RETYPED HERE. The sequence is produced by running the
 * REAL `pricing/bracket-run.priceByBracket` against an injected vendor, so the browser's
 * reducer is fed exactly what the server emits. A hand-written fixture would pass for
 * ever after the server stopped sending one of them.
 *
 * Pure: no DOM, no network, no database.
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const P = await import(new URL('../app-v2/src/longterm/bandProgress.js', import.meta.url));
const bracketRun = require(path.join(ROOT, 'src/longterm/pricing/bracket-run.js'));
const tiers = require(path.join(ROOT, 'src/longterm/pricing/dscr-tiers.js'));

let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };

console.log('LT — the DSCR band search reports where it has got to\n');

/* ── A. THE LADDER IS ONE LADDER ────────────────────────────────────────────
   The bar's denominator is the ladder the term sheet's own re-price rule uses. Two
   copies exist (a browser cannot require server code) and this is the point where a
   drift between them would silently mis-size every bar. */
ok(P.TOTAL_BANDS === tiers.DSCR_TIERS.length,
  `A1 the bar counts the SERVER's ladder, not a number typed here (${P.TOTAL_BANDS})`);
ok(P.TOTAL_BANDS === 11, 'A1a …which is eleven bands today');
for (const t of tiers.DSCR_TIERS) {
  const mine = P.bandLabel(t.tier);
  const theirs = tiers.tierLabel(t.tier);
  // The browser prints "1.50+" where the server prints "1.50 and above" — a deliberate
  // difference of length, not of meaning. What must agree is the EDGES.
  const edges = (s) => (String(s).match(/\d+\.\d\d/g) || []).join(',');
  if (edges(mine) !== edges(theirs)) ok(false, `A2 band ${t.tier} is named on the same edges (${mine} vs ${theirs})`);
}
ok(true, 'A2 every band is named from the same edges as the server names it');

/* ── B. A REAL RUN, THROUGH THE REAL LOOP ───────────────────────────────────
   The vendor is injected, so this is the server's own sequencing with no network.
   The figures put this deal near the middle of the ladder; the fake sheet answers
   with rates that keep the frontier widening for a couple of rounds and then stop. */
const FIGURES = {
  rentMonthly: 4200, taxMonthly: 500, insuranceMonthly: 150, hoaMonthly: 0,
  loanAmount: 400000, termYears: 30, interestOnly: false,
};
const parsedWith = (rates) => ({
  programs: rates.map((r, i) => ({
    lender: `L${i}`, options: [{ priceBuild: { noteRate: r, price: 100 }, monthlyPayment: { monthlyPI: 2400 } }],
  })),
});

const events = [];
const run = async (opts = {}) => {
  events.length = 0;
  return bracketRun.priceByBracket(FIGURES, opts.runSearch, {
    concurrency: 2,
    onProgress: (e) => events.push(e),
  });
};

// A vendor that always answers, with rates spread widely enough to keep discovering.
const answering = async () => ({ ok: true, parsed: parsedWith([6.5, 7.25, 8.5, 10.0]), meta: {} });
const out = await run({ runSearch: answering });
ok(out.ok === true, `B1 the loop ran and built a board (${(out.brackets || []).length} bands with rates)`);
ok(events.length > 0, `B2 …and reported as it went (${events.length} events)`);
ok(events[0] && events[0].phase === 'start', 'B3 the first report is the start, carrying the ladder size');
ok(events[0].totalBands === P.TOTAL_BANDS, 'B3a …and the ladder size it carries is the ladder');
ok(events[events.length - 1].phase === 'finished', 'B4 …and the last one says the run is over');
ok(events.some((e) => e.phase === 'round') && events.some((e) => e.phase === 'bracket'),
  'B5 …with a report when a band is committed to and another when it answers');
ok(out.totalBands === P.TOTAL_BANDS && Array.isArray(out.searchedBrackets) && out.searchedBrackets.length > 0,
  `B6 the ANSWER also carries what was searched, so a caller that missed the stream can still say (${(out.searchedBrackets || []).length} bands)`);

/* ── C. THE BAR NEVER GOES BACKWARDS, AND ALWAYS FINISHES ───────────────────
   Walked over the real sequence, asserting at every single step. */
{
  let st = P.emptyProgress();
  let last = -1;
  let regressed = 0;
  let overshot = 0;
  for (const e of events) {
    st = P.progressReduce(st, e);
    const v = P.progressView(st);
    if (v.pct < last) regressed += 1;
    if (v.pct === 100 && !v.done) overshot += 1;
    last = v.pct;
  }
  const final = P.progressView(st);
  ok(regressed === 0, `C1 ⛔ the bar never moves backwards across the whole run (${events.length} steps, ${regressed} regressions)`);
  ok(overshot === 0, 'C2 ⛔ …and never reads 100% while a band is still out');
  ok(final.done === true && final.pct === 100,
    `C3 …and it finishes, on a deal that only reached ${out.searchedBrackets.length} of ${P.TOTAL_BANDS} bands`);
  ok(final.settled === P.TOTAL_BANDS,
    'C3a …because a band the search never reached is settled as out of reach, not left waiting');
  /* ⛔ THE BAR COUNTS SEARCHES, THE BOARD COUNTS RATES, AND THEY ARE NOT THE SAME NUMBER.
     A band's own search can come back with four rates none of which BELONG in that band —
     the whole reason the board re-files every rate under the band its own ratio reaches.
     The first cut of this assertion required the two to be equal and failed on the very
     first real run (4 answered against 1 band with rates), which is exactly the confusion
     an officer would have had reading a bar that said "4 priced" above a board showing
     one. So the bar says `answered`, never `priced`, and this pins the relationship
     rather than an equality that is not true. */
  ok(final.answered > 0 && final.searched === out.searchedBrackets.length,
    `C4 the bar's count is the bands actually SEARCHED, which is the server's own list (${final.searched})`);
  ok(final.answered >= (out.brackets || []).length,
    `C4a …and never claims fewer searches than the board has bands with rates (${final.answered} answered, ${(out.brackets || []).length} on the board)`);
  ok(!/priced/i.test(final.line),
    `C4b ⛔ …and the sentence never says "priced", which would be a second opinion sitting above the board's own ("${final.line}")`);
}

/* ── C5. THE GUARD CAN FAIL — the monotonicity check is not vacuous.
   A denominator that grows with the frontier is precisely the design this module
   rejected, so it is built here and shown to regress. Without this, C1 would pass on
   a bar that slid backwards on every discovery round. */
{
  let known = 0; let answered = 0; let last = -1; let regressed = 0;
  for (const e of events) {
    if (e.phase === 'round') known += (e.tiers || []).length;
    if (e.phase === 'bracket') answered += 1;
    const pct = known > 0 ? Math.floor((answered / known) * 100) : 0;
    if (pct < last) regressed += 1;
    last = pct;
  }
  ok(regressed > 0,
    `C5 ⛔ CONTROL: the obvious denominator — bands committed so far — really does slide backwards (${regressed} times), so C1 is measuring something`);
}

/* ── D. THE FIVE OUTCOMES STAY APART ────────────────────────────────────────
   A vendor that refuses every band must not read as a loan that reaches no rates. */
{
  const refusing = async () => ({ ok: false, error: 'lp_price_failed', message: 'no' });
  const r = await run({ runSearch: refusing });
  let st = P.emptyProgress();
  for (const e of events) st = P.progressReduce(st, e);
  const v = P.progressView(st);
  ok(r.ok === true && (r.failedBrackets || []).length > 0,
    `D1 a refusing rate sheet still produces a board, with the failures NAMED (${(r.failedBrackets || []).length})`);
  ok(v.failed > 0 && v.empty === 0,
    `D2 ⛔ …and the bar calls them FAILED, never empty — "the sheet did not answer" is not "this loan reaches nothing" (${v.failed} failed, ${v.empty} empty)`);
  ok(v.answered === 0, 'D3 …and nothing is claimed to have come back with rates');
  ok(v.done === true && v.pct === 100, 'D4 …and the run still visibly finishes rather than hanging at part-full');
}
{
  // A vendor that answers with NO rates at all — asked, and this loan reaches nothing.
  const barren = async () => ({ ok: true, parsed: parsedWith([]), meta: {} });
  await run({ runSearch: barren });
  let st = P.emptyProgress();
  for (const e of events) st = P.progressReduce(st, e);
  const v = P.progressView(st);
  ok(v.empty > 0 && v.failed === 0,
    `D5 ⛔ the reverse case is told apart too — asked and empty, with nothing called a failure (${v.empty} empty, ${v.failed} failed)`);
}

/* ── E. THE REDUCER IS TOTAL, AND A SETTLED BAND STAYS SETTLED ──────────────
   A duplicated or re-ordered line — a retried stream, a proxy that replayed — must not
   take a finished band back to "searching", which is how a bar goes backwards. */
{
  let st = P.progressReduce(P.emptyProgress(), { phase: 'start', totalBands: 11, seedTier: 7 });
  st = P.progressReduce(st, { phase: 'round', tiers: [6, 7, 8] });
  st = P.progressReduce(st, { phase: 'bracket', tier: 7, ok: true, rates: 4 });
  const before = P.progressView(st).pct;
  st = P.progressReduce(st, { phase: 'round', tiers: [6, 7, 8] });   // the same round again
  ok(P.progressView(st).pct === before && st.bands[7] === 'answered',
    'E1 a repeated round cannot re-open a band that has already answered');
  ok(P.progressReduce(st, null) === st && P.progressReduce(st, { phase: 'nonsense' }) === st,
    'E2 an unknown or missing event changes nothing rather than throwing');
  ok(P.progressView(null).total === P.TOTAL_BANDS,
    'E3 …and the view of nothing is a whole ladder waiting, never a crash');
  const seeded = P.progressView(st).chips.find((c) => c.seed);
  ok(seeded && seeded.tier === 7,
    'E4 the deal’s OWN band is marked, so a reader can see where the search started from');
}

/* ── F. IT SAYS SOMETHING A PERSON CAN READ ─────────────────────────────────
   A percentage answers nothing an officer can act on. */
{
  let st = P.progressReduce(P.emptyProgress(), { phase: 'start', totalBands: 11, seedTier: 7 });
  ok(/^Starting/.test(P.progressView(st).line),
    'F1 before a single band is even committed to it says the searches are starting, never a bare 0%');
  st = P.progressReduce(st, { phase: 'round', tiers: [6, 7, 8] });
  ok(/3 searching now/.test(P.progressView(st).line),
    `F1a …and the moment bands are out it says how many ("${P.progressView(st).line}")`);
  st = P.progressReduce(st, { phase: 'bracket', tier: 7, ok: true, rates: 3 });
  const line = P.progressView(st).line;
  ok(/\bof 11\b/.test(line) && /searching now/.test(line),
    `F2 …and once they do it says how far through it is and that it is still going ("${line}")`);
  st = P.progressReduce(st, { phase: 'finished' });
  ok(/searched/.test(P.progressView(st).line) && !/%/.test(P.progressView(st).line),
    `F3 …and when it is over it states what was done, not a progress figure ("${P.progressView(st).line}")`);
}

console.log(`\n${failures ? `FAILED (${failures})` : 'OFFLINE: all passed'}`);
process.exit(failures ? 1 : 0);
