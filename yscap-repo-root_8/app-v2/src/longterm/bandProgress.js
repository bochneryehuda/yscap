/**
 * WHERE THE BAND SEARCH HAS GOT TO — the rules behind the progress bar, in plain
 * JavaScript so CI can RUN them.
 *
 * ── THE OWNER'S ASK ────────────────────────────────────────────────────────
 * 2026-09-04: *"when you search a full scenario, it populates everything right away
 * and then it searches the more scenarios and populates according to the brackets.
 * It should stay everything like it is now, but on top there should be a progress
 * bar somewhere, nicely designed on top, where the progress is bracketing all the
 * brackets and all the scenarios according to the brackets. You shouldn't feel like
 * the system forgot about you. It's just taking long, and meanwhile you see the
 * original rates."*
 *
 * So: nothing about the board changes. The immediate answer still lands first and
 * the bands still fill in underneath it. What is added is that the screen can now
 * SAY where that is up to, band by band, instead of one sentence that reads the same
 * at second one and second twenty.
 *
 * ── THE DENOMINATOR IS FIXED, AND THAT IS THE WHOLE DESIGN ─────────────────
 * A bar whose total can grow is a bar that slides backwards, and a bar that slides
 * backwards reads as work being undone. The obvious denominator here — "bands we
 * have decided to search" — does exactly that: the loop DISCOVERS bands as it goes,
 * so it starts at three and may reach seven.
 *
 * There are exactly ELEVEN DSCR bands (`dscrCalc.DSCR_TIERS`, the ladder the term
 * sheet's own re-price rule uses) and the server prices each at most once. So the
 * denominator is eleven, always, and the numerator is how many of the eleven have
 * been SETTLED — answered, answered empty, failed, or, once the run ends, shown to be
 * out of this loan's reach. Every band ends in exactly one of those, none of them
 * can be left, and the bar therefore only ever moves forward and always finishes.
 *
 * ── FIVE OUTCOMES, NEVER ONE SILENCE ──────────────────────────────────────
 * `answered` (the sheet came back with rates for this band's own search), `empty`
 * (the band was asked and nothing came back), `failed` (the vendor did not answer — a
 * fact about the vendor, not about the loan), `out_of_reach` (never asked, because the
 * search stopped widening before it got there) and `searching`. Collapsing `empty` and
 * `failed` is the defect the server's own `failedBrackets` exists to prevent, and it
 * would be re-introduced here by a bar that only counted.
 *
 * PURE — a reducer over the events `pricing/bracket-run` reports. No React, no DOM,
 * no clock. `scripts/test-lt-band-progress-pure.mjs` runs it directly.
 */

import { DSCR_TIERS } from './dscrCalc.js';

/** How many bands there are. Read from the ladder, never typed as an 11. */
export const TOTAL_BANDS = DSCR_TIERS.length;

/** The states a band ends in. A band in one of these is SETTLED and never moves again. */
export const TERMINAL = ['answered', 'empty', 'failed', 'out_of_reach'];

/** Nothing has happened yet. */
export function emptyProgress() {
  return { total: TOTAL_BANDS, seedTier: null, bands: {}, done: false, rounds: 0 };
}

const isTerminal = (st) => TERMINAL.indexOf(st) >= 0;

/**
 * Fold one report into the state.
 *
 * ⛔ A TERMINAL BAND IS NEVER RE-OPENED. The server prices each band once, but a
 * retried stream, a duplicated line or a late `round` naming a band that has already
 * answered would otherwise take a finished band back to `searching` — and the bar
 * would go backwards for exactly the reason this module's header says it must not.
 * Unknown events are ignored rather than throwing: a newer server may report more.
 */
export function progressReduce(state, ev) {
  const s = state || emptyProgress();
  if (!ev || typeof ev !== 'object') return s;
  const bands = { ...s.bands };
  const put = (tier, st) => {
    const t = Number(tier);
    if (!Number.isInteger(t)) return;
    if (isTerminal(bands[t])) return;
    bands[t] = st;
  };

  switch (ev.phase) {
    case 'start':
      return {
        ...emptyProgress(),
        total: Number.isInteger(ev.totalBands) && ev.totalBands > 0 ? ev.totalBands : TOTAL_BANDS,
        seedTier: Number.isInteger(ev.seedTier) ? ev.seedTier : null,
      };
    case 'round':
      for (const t of (Array.isArray(ev.tiers) ? ev.tiers : [])) put(t, 'searching');
      return { ...s, bands, rounds: s.rounds + 1 };
    case 'bracket':
      /* ⛔ `answered`, NOT `priced`, AND THE DIFFERENCE IS REAL. This says the rate
         sheet came back with rates for the search we sent AT THIS BAND. Which band each
         of those rates ends up in is a different question — the board re-files every rate
         under the band its OWN ratio reaches (`bracket-board.buildBoard`), which is the
         entire point of the exercise — so a band can be answered and still hold nothing
         on the finished board, and can hold rates that came out of a neighbour's search.
         Calling this "priced" would put a number beside the bar that the board underneath
         it contradicts, which is how a screen comes to disagree with itself. */
      put(ev.tier, ev.ok === true ? (Number(ev.rates) > 0 ? 'answered' : 'empty') : 'failed');
      return { ...s, bands };
    case 'finished': {
      // Everything the run never reached is settled now, as out of this loan's reach.
      // This is what fills the bar on a deal that only ever spans three bands.
      for (let t = 1; t <= s.total; t += 1) if (!isTerminal(bands[t])) bands[t] = 'out_of_reach';
      return { ...s, bands, done: true };
    }
    default:
      return s;
  }
}

/** How a band is named to a reader — from the ladder's own edges, never a second list. */
export function bandLabel(tier) {
  const t = DSCR_TIERS.find((x) => x.tier === Number(tier));
  if (!t) return null;
  if (t.from == null) return `Below ${t.to.toFixed(2)}`;
  if (t.to == null) return `${t.from.toFixed(2)}+`;
  return `${t.from.toFixed(2)}–${t.to.toFixed(2)}`;
}

/**
 * The state a bar can be drawn from — one object, so the component holds no rules.
 *
 * `pct` is settled-of-total and is rounded DOWN, never up: a bar reading 100% with a
 * band still out is the one thing it must never say. It is clamped at 99 until the
 * run really is done, for the same reason — eleven-elevenths of a rounding is not
 * finished.
 */
export function progressView(state) {
  const s = state || emptyProgress();
  const chips = [];
  let settled = 0;
  let searching = 0;
  let answered = 0;
  let empty = 0;
  let failed = 0;
  for (let t = 1; t <= s.total; t += 1) {
    const st = s.bands[t] || 'waiting';
    if (isTerminal(st)) settled += 1;
    if (st === 'searching') searching += 1;
    if (st === 'answered') answered += 1;
    if (st === 'empty') empty += 1;
    if (st === 'failed') failed += 1;
    chips.push({ tier: t, label: bandLabel(t), state: st, seed: t === s.seedTier });
  }
  // The bands actually ASKED ABOUT — the three outcomes a search has, never the ones
  // the run stopped short of.
  const searched = answered + empty + failed;
  const raw = s.total > 0 ? Math.floor((settled / s.total) * 100) : 0;
  /* ⛔ THE LOCAL IS `percent`, NOT `pct`, AND THE NAME IS THE POINT. `pct` is a
     FORMATTER exported by `format.js` — it takes a whole percent and prints it —
     and `test-lt-pipeline-columns-pure.js` fails the build for any file in this
     folder that declares a `const pct`, precisely so a screen never reaches for
     a local number when it meant the shared formatter (or the other way round:
     `pct` and `rate` take different units, and swapping them prints 0.97% or
     7250.0%). The RETURNED key stays `pct`, so nothing that reads this changes. */
  const percent = s.done ? 100 : Math.min(99, raw);
  return {
    total: s.total, settled, searching, searched, answered, empty, failed, done: !!s.done, pct: percent, chips,
    /* ⛔ THE SENTENCE SAYS WHAT IS HAPPENING, NOT WHAT A PERCENTAGE IS. "72%" answers
       nothing an officer can act on. Three states, because they are three different
       moments and one wording covering them is what made the old single sentence read the
       same at second one and second twenty.
       ⛔ AND IT NEVER SAYS HOW MANY BANDS HAVE RATES. That is the BOARD's answer, arrived
       at by re-filing every rate under the band its own ratio reaches; a count here would
       be a second, earlier opinion sitting directly above the first. */
    line: s.done
      // "1 of 11 DSCR bands" — the plural belongs to the ELEVEN, not to the one, so this
      // does not inflect. "1 of 11 DSCR band searched" is what inflecting it produced.
      ? `${searched} of ${s.total} DSCR bands searched · the board below groups every rate by the band it reaches`
      : (settled === 0 && searching === 0
        ? 'Starting the band searches…'
        : `${settled} of ${s.total} DSCR bands done${searching ? ` · ${searching} searching now` : ''}`),
  };
}
