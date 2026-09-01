'use strict';
/**
 * LONG-TERM — THE DSCR BRACKET LADDER. ONE TABLE, ONE READING, SHARED.
 *
 * PURE. No database, no vendor, no config, no requires.
 *
 * ⛔ THIS IS THE LADDER THAT DECIDES A RE-PRICE, AND IT IS DELIBERATELY THE SAME
 * ONE THE PRICING BOARD GROUPS BY (owner-directed 2026-09-01, in the owner's own
 * words: *"you know internally the brackets that we require reprice. Don't
 * rebuild that bracket. I want to stay that bracket, just share that bracket,
 * because if the bracket is changing you should automatically change yourself as
 * well."*).
 *
 * It lived inside `termsheet/snapshot.js`, which is where the re-price rule lives
 * and is still its only judge. It was MOVED here rather than copied so that the
 * board and the re-price refusal can never come to disagree about what a bracket
 * IS — the entire point of the owner's instruction. `snapshot.js` requires it and
 * re-exports it, so every existing reader is unchanged.
 *
 * ⛔ THE OWNER SUPPLIED THESE NUMBERS (2026-08-31): *"So if anything is changing
 * from one bracket to the next one, then it needs a reprice, but make sure it's
 * very easy."* Eleven tiers, each stated as [from, to) on the ratio ROUNDED TO
 * TWO — which is what a DSCR is here (Round([1005]/[912], 2), owner-confirmed)
 * and what both the paper and a band edge carry. Rounding first is what makes
 * 1.2449 and 1.24 one claim, and what stops a hair of float landing a loan in the
 * wrong tier.
 *
 * `app-v2/src/longterm/dscrCalc.js` carries the BROWSER's copy, because a screen
 * cannot require server code (the `lib/payoff.js` arrangement this repo uses
 * throughout). `test-lt-comparison-ux-pure` runs BOTH over every ratio from 0 to
 * 2.00 in hundredths and fails on any disagreement. **Change one, change the
 * other.**
 */

const DSCR_TIERS = [
  { tier: 1,  from: null, to: 0.50 },   // < 0.50 — very low
  { tier: 2,  from: 0.50, to: 0.75 },
  { tier: 3,  from: 0.75, to: 0.85 },
  { tier: 4,  from: 0.85, to: 1.00 },
  { tier: 5,  from: 1.00, to: 1.10 },
  { tier: 6,  from: 1.10, to: 1.15 },   // owner-added 2026-08-31: *"I missed one band up to 1.1"*
  { tier: 7,  from: 1.15, to: 1.25 },
  { tier: 8,  from: 1.25, to: 1.30 },
  { tier: 9,  from: 1.30, to: 1.40 },
  { tier: 10, from: 1.40, to: 1.50 },
  { tier: 11, from: 1.50, to: null },   // >= 1.50 — strongest
];

/* ⛔ THE LADDER MUST BE CONTIGUOUS AND MUST NOT OVERLAP, AND THAT IS CHECKED RATHER THAN TRUSTED.
   `dscrTier` returns the FIRST band a ratio falls in, so two bands that overlap are resolved
   silently by array order — a real hazard, found when a deliberate mutation of one boundary
   changed no behaviour at all because its neighbour still claimed the ratio. A ladder with a hole
   is worse still: a ratio in the gap gets no tier and the rule quietly stands down on a live loan.
   Verified once at load, so a bad edit fails loudly here instead of mispricing quietly. */
function assertLadder(tiers) {
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    const prev = tiers[i - 1];
    if (i === 0 && t.from !== null) throw new Error('DSCR ladder: the first band must be open below');
    if (i === tiers.length - 1 && t.to !== null) throw new Error('DSCR ladder: the last band must be open above');
    if (prev && prev.to !== t.from) {
      throw new Error(`DSCR ladder: tier ${prev.tier} ends at ${prev.to} but tier ${t.tier} starts at ${t.from}`);
    }
  }
  return tiers;
}
assertLadder(DSCR_TIERS);

/** Which tier a ratio sits in, or null when it is not a usable ratio. */
function dscrTier(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n <= 0) return null;
  const r = Math.round(n * 100) / 100;
  for (const t of DSCR_TIERS) {
    if ((t.from == null || r >= t.from) && (t.to == null || r < t.to)) return t.tier;
  }
  return null;
}

/** The band's own row, or null. */
function tierRow(tier) {
  return DSCR_TIERS.find((t) => t.tier === tier) || null;
}

/**
 * How a bracket is NAMED to a reader, from its own edges rather than a second
 * hand-typed list — so a boundary the owner moves re-words itself.
 *
 * A DSCR is carried to two decimals everywhere here, so the edges print that way
 * too: "1.25" and not "1.3", or the label and the ladder would read as two
 * different numbers on one screen.
 */
function tierLabel(tier) {
  const t = tierRow(tier);
  if (!t) return null;
  if (t.from == null) return `Below ${t.to.toFixed(2)}`;
  if (t.to == null) return `${t.from.toFixed(2)} and above`;
  return `${t.from.toFixed(2)} – ${t.to.toFixed(2)}`;
}

module.exports = { DSCR_TIERS, dscrTier, tierRow, tierLabel, _internals: { assertLadder } };
