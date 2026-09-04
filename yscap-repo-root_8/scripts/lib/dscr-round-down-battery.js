'use strict';
/**
 * THE BATTERY BEHIND THE ROUND-DOWN NUMBERS — IN THE TREE, SO THEY CAN BE REPRODUCED.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * `src/longterm/pricing/bracket-board.js` quotes measured counts for the
 * owner-authorised 2026-09-03 change (*"Round it down, same as everywhere
 * else"*) — how many ratios moved, how many bands moved, how many SEARCHED
 * ratios moved and which way. The script that produced the originals was never
 * committed, and the header said so; what it could not say is that the numbers
 * are therefore UNREPRODUCIBLE. Four attempts at "11 rents × 8 loan amounts × 6
 * tax figures × 4 insurance figures × 3 HOA figures × 51 rates" are on the
 * record and no two of them agree —
 *
 *     5fcfaf43             161,915 moved · 9,722 band · 5,176 searched (no split stated)
 *     bc5a893d             —                —          5,165 searched (3,951↓ 1,214↑)
 *     re-audit 2026-09-03  —                —          5,690 searched (4,202↓ 1,488↑)
 *     this battery         161,448 moved · 9,033 band · 5,308 searched (3,942↓ 1,366↑)
 *
 * — four attempts at one battery, because the paragraph records the SHAPE of the
 * battery and not one of its values. A count nobody can re-derive is a claim, not a
 * measurement. (Each row above is read off git rather than remembered; an earlier
 * draft of this table merged the first two rows and lost 5,176.)
 *
 * ⛔ SO THE AXES LIVE HERE, AS DATA, and the suite MEASURES them on every run
 * rather than quoting them from memory. The header now cites this file and the
 * one command that reproduces it. Change an axis and the numbers change with it
 * — which is correct, and the suite will print the new ones.
 *
 * ── WHAT IS ACTUALLY LOAD-BEARING ──────────────────────────────────────────
 * Not the totals. Every attempt above agrees exactly on the THREE measured safety
 * properties, and those are what the suite asserts hard:
 *   · not one ratio a rate achieves moves UP,
 *   · not one band moves to a BETTER one,
 *   · not one band is lost, and none is newly reached.
 *
 * ⛔ `outside` IS NOT ONE OF THEM AND IS NOT EVIDENCE. `sendRatioFor` returns null
 * unless the rounded ratio is already in the band it was asked for, and `measure`
 * skips the nulls — so that count is zero by construction, whatever the rounding
 * does. It is returned as a CONTRACT tripwire for the day that return line changes,
 * never as a measurement. Two drafts of the board's header counted it as a fourth
 * safety property; the audit of 2026-09-04 pushed every searched ratio a whole band
 * out of place and it still read 0.
 *
 * The totals are reported so a reader gets the measured fact; the properties are
 * what the change rests on.
 *
 * PURE: no database, no network, no vendor. The engines are injected.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { stripComments } = require('./strip-comments');

/* ⛔ THIS MODULE NAMES NO PRODUCT PATH OF ITS OWN — the CALLER passes the board it is
   measuring, exactly as it passes the engines. `scripts/lib` is shared ground between
   two products that may not reach into each other (CLAUDE.md rule 4: only
   `scripts/test-lt-*.js` may import Long-Term). A `path.join(__dirname, '..', '..',
   'src', 'longterm', …)` here would slip past the separation gate — which reads
   `require` targets, not composed paths — while being exactly what the rule forbids.
   The precedent this sits beside, `strip-comments.js`, is product-neutral for the same
   reason. */

/**
 * ⛔ THE STRIP MATCHES THE LEVER'S SHAPE, NOT ITS EXACT TEXT, and that is not
 * convenience — it is what stops the whole comparison degenerating. A literal
 * string match fails the moment somebody edits the ARGUMENT (`… / pitia + 0.005`),
 * the baseline is then the UNCHANGED source, BEFORE === AFTER, and "not one ratio
 * went up" passes because nothing was compared. MEASURED: that exact mutation made
 * the suite's N3 pass for the wrong reason.
 *
 * The FIELD is matched loosely too. A lever asking for the wrong field ('ltv' cuts
 * the other way) must still be STRIPPED, or the guard refuses to build a baseline
 * and the safety assertions stand down on the very mutation they exist to catch.
 */
const LEVER_RE = () => /tierRounding\.sendAs\('[a-z]+',\s*([^;]*?),\s*2\)/g;

/**
 * THE ENGINE AS IT WAS — built by NEUTRALISING this board's own changed line,
 * never by reading git (a git baseline proves inertness only until the change is
 * committed, after which it compares the engine to itself).
 *
 * Returns the pieces as well as the engine so the caller can ASSERT the strip
 * really happened. One definition of "what BEFORE means", shared by the suite and
 * by anyone re-running the measurement.
 */
function baselineEngine(boardPath) {
  if (!boardPath) throw new Error('baselineEngine(boardPath): the caller names the board it is measuring');
  /* ⛔ EVERYTHING HERE READS THE COMMENT-STRIPPED SOURCE, and the baseline is COMPILED
     from it. The first cut matched the raw file, so ONE COMMENT LINE quoting the lever
     it describes — in a repo whose comments routinely quote the code they explain —
     made the count read 3 instead of 2 and turned eleven assertions red on correct
     code. A guard that goes red because somebody documented something teaches its
     reader to delete the documentation. (`N8` in the suite already read the stripped
     source for exactly this reason; this did not.) The stripper is the SHARED one: the
     two-regex idiom is a skeleton key that can swallow a whole file and make a
     "must not appear" rule pass over nothing. */
  const rawSrc = fs.readFileSync(boardPath, 'utf8');
  const bbSrc = stripComments(rawSrc);
  const found = bbSrc.match(LEVER_RE()) || [];
  const inRatio = /function ratioAtRate\([\s\S]*?\n\}/.exec(bbSrc);
  const ratioLever = inRatio ? (inRatio[0].match(LEVER_RE()) || []) : [];
  const baseSrc = ratioLever.length === 1
    ? bbSrc.replace(ratioLever[0], ratioLever[0].replace(LEVER_RE(), 'Math.round(($1) * 100) / 100'))
    : bbSrc;
  const afterRatio = /function ratioAtRate\([\s\S]*?\n\}/.exec(baseSrc);
  const stripped = baseSrc !== bbSrc && !!afterRatio && !LEVER_RE().test(afterRatio[0]);
  const mod = new Module(boardPath, null);
  mod.filename = boardPath;
  mod.paths = Module._nodeModulePaths(path.dirname(boardPath));
  mod._compile(baseSrc, boardPath);
  return { BEFORE: mod.exports, found, ratioLever, baseSrc, bbSrc, rawSrc, stripped, path: boardPath };
}

/**
 * THE AXES. Real-shaped figures a DSCR rental deal actually carries: rents from a
 * small condo to a large multi, loan amounts across the book, and tax / insurance /
 * HOA figures including ZERO on each, because a deal with no HOA is the ordinary
 * case and a battery that never sends one would not exercise it.
 *
 * The rate ladder is every eighth from 5.25% to 11.5% — the span this board's own
 * sheets quote, so no rate here is one the engine would never see.
 */
const AXES = Object.freeze({
  rents: Object.freeze([1500, 1800, 2100, 2400, 2490, 2750, 3000, 3400, 3850, 4400, 5000]),
  loans: Object.freeze([120000, 150000, 180000, 240000, 300000, 420000, 540000, 640000]),
  taxes: Object.freeze([0, 180, 300, 450, 650, 800]),
  insurances: Object.freeze([0, 65, 120, 165]),
  hoas: Object.freeze([0, 150, 340]),
  termYears: 30,
});

/** Every eighth from 5.25% to 11.5%, settled to three decimals so the loop cannot drift. */
function rates() {
  const out = [];
  for (let r = 5.25; r <= 11.5 + 1e-9; r += 0.125) out.push(Math.round(r * 1000) / 1000);
  return out;
}

/** The deals themselves, read through the board's OWN reader so nothing here invents a shape. */
function dealsFrom(boardMod) {
  const out = [];
  for (const rentMonthly of AXES.rents) {
    for (const loanAmount of AXES.loans) {
      for (const taxMonthly of AXES.taxes) {
        for (const insuranceMonthly of AXES.insurances) {
          for (const hoaMonthly of AXES.hoas) {
            const fg = boardMod.readFigures({
              rentMonthly, taxMonthly, insuranceMonthly, hoaMonthly,
              loanAmount, termYears: AXES.termYears,
            });
            if (fg) out.push(fg);
          }
        }
      }
    }
  }
  return out;
}

/**
 * RUN IT. Two sweeps over one set of deals:
 *   · the RATIO a rate achieves, before vs after (the one-way property), and
 *   · the ratio the band is SEARCHED at, before vs after (the split, and the
 *     band-integrity property).
 *
 * Returns counts only — it asserts nothing, so the caller decides what is a
 * failure and what is merely reported.
 */
function measure({ boardMod, BEFORE, tiers }) {
  const deals = dealsFrom(boardMod);
  const rateList = rates();

  let combos = 0, moved = 0, up = 0, bandWorse = 0, bandBetter = 0, nullsBefore = 0, nullsAfter = 0;
  let firstUp = null;
  for (const fg of deals) {
    for (const rate of rateList) {
      const b = BEFORE.ratioAtRate(fg, rate);
      const a = boardMod.ratioAtRate(fg, rate);
      combos += 1;
      if (b == null) nullsBefore += 1;
      if (a == null) nullsAfter += 1;
      if (b == null || a == null) continue;
      if (a !== b) moved += 1;
      if (a > b) { up += 1; if (!firstUp) firstUp = { loan: fg.loanAmount, rate, before: b, after: a }; }
      const tb = tiers.dscrTier(b), ta = tiers.dscrTier(a);
      if (ta !== tb) { if (ta < tb) bandWorse += 1; else bandBetter += 1; }
    }
  }

  const rateRows = rateList.map((r) => ({ rate: r }));
  let pairs = 0, lost = 0, gained = 0, sUp = 0, sDown = 0, outside = 0;
  let firstSearchedUp = null, firstOutside = null;
  for (const fg of deals) {
    for (const row of tiers.DSCR_TIERS) {
      const t = row.tier != null ? row.tier : row;
      const b = BEFORE.sendRatioFor(t, fg, rateRows);
      const a = boardMod.sendRatioFor(t, fg, rateRows);
      pairs += 1;
      if (b != null && a == null) lost += 1;
      else if (b == null && a != null) gained += 1;
      if (b == null || a == null) continue;
      if (a > b) { sUp += 1; if (!firstSearchedUp) firstSearchedUp = { tier: t, loan: fg.loanAmount, before: b, after: a }; }
      else if (a < b) sDown += 1;
      if (tiers.dscrTier(a) !== t) { outside += 1; if (!firstOutside) firstOutside = { tier: t, ratio: a }; }
    }
  }

  return {
    deals: deals.length, rates: rateList.length,
    combos, moved, up, bandWorse, bandBetter, nullsBefore, nullsAfter, firstUp,
    pairs, lost, gained, searchedUp: sUp, searchedDown: sDown, searchedMoved: sUp + sDown,
    outside, firstSearchedUp, firstOutside,
  };
}

module.exports = { AXES, rates, dealsFrom, measure, baselineEngine, _internals: { LEVER_RE } };
