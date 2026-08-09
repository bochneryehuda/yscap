'use strict';
/**
 * THE SERVER'S ANSWER TO EVERYTHING THE TERM SHEET STUDIO ASKS THE ENGINES.
 *
 * WHY THIS EXISTS (issue #7, phase 1). The pricing engines are readable in the
 * public web root because the BROWSER runs them: `web/(v2/)tools/term-sheet.html`
 * pulls standard-program.js / gold-standard.js / silver-program.js / title-cost.js
 * with <script> tags and `termsheet.js` calls them ~33 times per recompute. The
 * only way to stop serving the guideline book is to stop needing it in the page,
 * which means the SERVER has to be able to answer every question the page asks.
 *
 * `src/lib/pricing.js` already prices a FILE (it takes an `applications` row and
 * returns one normalized quote per program). That is not enough for the studio,
 * which also needs the leverage LADDER behind its slider, the CAPS row it prints,
 * a TITLE estimate, and two pure helpers it uses for display branching. This
 * module answers the studio's whole question for ONE deal, in one call.
 *
 * PHASE 1 CHANGES NOTHING A USER SEES. Nothing calls this yet; the browser still
 * computes locally. It exists so the answer can be proven identical BEFORE any
 * surface depends on it — see scripts/test-pricing-studio-parity.js, which runs
 * this module and the browser's own engine calls over the same battery and
 * requires every field to match.
 *
 * NO FROZEN FILE IS TOUCHED. The engines are required exactly as pricing.js
 * requires them, the markup rides the same frozen `setMarkup` hook and is reset
 * in a `finally`, and no formula, matrix value or rounding rule is reimplemented
 * here. Everything below is a pass-through.
 */
const path = require('path');

let YSP = null, GSP = null, SVP = null, YSTitle = null, loadErr = null;
try {
  // The SAME two surviving copies src/lib/pricing.js loads (issue #8 cut six to
  // two, and test-engine-copies-match.js keeps them byte-identical).
  YSP = require('../../web/tools/standard-program.js');
  GSP = require('../../web/tools/gold-standard.js');
  SVP = require('../../web/tools/silver-program.js');
  YSTitle = require('../../web/tools/title-cost.js');
} catch (e) { loadErr = e && e.message; }

const enginesReady = () => !!(YSP && GSP && SVP && YSTitle);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const engineOf = (program) => (program === 'gold' ? GSP : program === 'silver' ? SVP : YSP);

/* The markup is a per-request input here, not a per-file override: the studio
   already reads the company defaults from /api/pricing-defaults and pushes them
   in with setMarkup() on every recompute, so the caller states what it wants and
   this module applies it through the frozen hook. `null` means "leave the
   engine's own markup alone", which is what an absent value must mean — never 0,
   which would silently price at cost. */
function applyMarkup(program, pct) {
  const e = engineOf(program);
  if (!e || typeof e.setMarkup !== 'function') return false;
  if (pct == null || pct === '' || !Number.isFinite(Number(pct))) return false;
  e.setMarkup(Number(pct));
  return true;
}
function clearMarkup(program) {
  const e = engineOf(program);
  try { if (e && typeof e.setMarkup === 'function') e.setMarkup(null); } catch (_) { /* best-effort reset */ }
}

/* One program's slice of the answer: what it prices, the ladder behind the
   leverage slider, and the caps row the sheet prints. Each piece is independently
   guarded — a ladder that throws must not cost the caller its quote, which is
   exactly how pricing.js already treats it. */
function programBlock(program, deal, markupPct) {
  const e = engineOf(program);
  if (!e) return { program, available: false, reason: 'engine not loaded' };
  const applied = applyMarkup(program, markupPct);
  try {
    const out = { program, available: true };

    try {
      out.evaluate = e.evaluate(deal);
      // The studio's own rule, mirrored from pricing.js quoteProgram: an admin
      // forcing a price turns an INELIGIBLE into a MANUAL rather than a refusal.
      if (deal && deal.forcePrice && out.evaluate && out.evaluate.status === 'INELIGIBLE') {
        out.evaluate.status = 'MANUAL';
        out.evaluate.exitShortfall = 0;
      }
    } catch (err) { out.evaluate = null; out.evaluateError = String(err && err.message || err); }

    // Gold has no ladder — its leverage is not slider-driven — so asking for one
    // is not an error, it is simply absent. Standard and Silver both ship one.
    if (typeof e.priceLadder === 'function') {
      try {
        const pl = e.priceLadder(deal);
        out.ladder = (pl && pl.eligible && pl.rows && pl.rows.length)
          ? { eligible: true, maxLtc: pl.maxLtc, binding: pl.binding, rows: pl.rows }
          : { eligible: false, rows: [] };
      } catch (err) { out.ladder = { eligible: false, rows: [] }; out.ladderError = String(err && err.message || err); }
    }

    /* The caps row is keyed on what evaluate() just decided, so it can only be
       asked for once there IS an evaluation.

       KNOWN, MEASURED, NOT FIXED HERE (audit 2026-08-03) — `out.caps` is
       ALWAYS null on SILVER. This call uses Standard's 4-argument signature
       `caps(regime, loanType, strategyCode, tier)`; Silver's is
       `caps(prodTok, loanType, tier)` (silver-program.js), and a Silver
       evaluation has no `regime` at all (it has `market`), so the lookup misses
       and returns undefined — silently, with no throw for the catch to notice.
       It is harmless today: Silver's own `evaluate()` already returns the same
       `progMax` row as `evaluate.caps`, which IS shipped, and nothing consumes
       the block-level `silver.caps` (the browser seam that would is off unless
       a page is opened with ?engine=server).

       It is left alone ON PURPOSE rather than fixed in passing, for two
       reasons. (1) scripts/test-pricing-studio-parity.js makes the IDENTICAL
       4-argument call on the browser side, so both sides get null and 4.1M
       fields agree — the proof copies the bug instead of catching it, and
       correcting one side without the other would fail parity for a change
       that moves no guideline number. (2) The same audit measured that the
       block-level `caps` row IS the leverage matrix row verbatim, so making
       Silver's populate would ADD guideline exposure on a public door while
       that exposure is still an open question (see the header). Settle both
       together — before phase 4 deletes the engines from the web root and this
       door becomes the only channel. */
    if (typeof e.caps === 'function' && out.evaluate) {
      try {
        const ev = out.evaluate;
        out.caps = e.caps(ev.regime, ev.loanType, ev.strategyCode, ev.tier);
      } catch (err) { out.caps = null; out.capsError = String(err && err.message || err); }
    }
    return out;
  } finally {
    if (applied) clearMarkup(program);
  }
}

/**
 * The whole studio answer for one deal.
 *
 * `deal` is the object the browser's own `gather()` builds — same keys, same
 * meanings — so the two sides can be compared field for field.
 * `markups` is `{ standard, gold, silver }` as DECIMAL fractions (0.005 = 0.5%),
 * matching what the studio already passes to setMarkup(). Omit one to leave that
 * engine on its own built-in markup.
 *
 * Never throws: every branch is guarded and the shape is always the same, so a
 * caller can render "we could not price that" instead of crashing.
 */
function studioQuote(deal, markups) {
  const d = deal || {};
  const m = markups || {};
  if (!enginesReady()) {
    return { available: false, reason: 'pricing engines unavailable' + (loadErr ? ': ' + loadErr : '') };
  }
  const out = { available: true, standard: null, gold: null, silver: null, title: null, derived: {} };

  out.standard = programBlock('standard', d, m.standard);
  out.gold = programBlock('gold', d, m.gold);
  out.silver = programBlock('silver', d, m.silver);

  /* Title is quoted off the SIZED loan, so it depends on the program the caller
     is showing. Quote it for each program that produced a loan — the studio
     prints whichever one is on screen, and sending all three costs nothing. */
  out.title = {};
  /* WHAT EACH TITLE FIGURE WAS COMPUTED FOR — a sibling, never folded into the
     title object itself, so `title[p]` stays byte-identical to the engine's own
     return value and the parity proof keeps comparing like for like.

     The page asks for title through a GLOBAL — `YSTitle.estimate(state, loan,
     loanType)` — which says nothing about which program is asking. A client
     reading these answers back therefore has to identify the right one, and
     the only honest way to do that is to match on everything the estimate
     depends on. Guessing by loan amount alone hands back another program's
     title whenever two programs size differently (audit 2026-08-03 measured
     $3,600 vs $3,615, and on an ineligible deal a cash-to-close $2,520 short). */
  out.titleFor = {};
  for (const p of ['standard', 'gold', 'silver']) {
    const blk = out[p];
    const sized = blk && blk.evaluate && blk.evaluate.sizing;
    const total = sized ? num(sized.totalLoan) : 0;
    if (!total) { out.title[p] = null; out.titleFor[p] = null; continue; }
    try {
      out.title[p] = YSTitle.estimate(d.state, total, d.loanType);
      out.titleFor[p] = { loan: total, state: d.state, loanType: d.loanType };
    } catch (_) { out.title[p] = null; out.titleFor[p] = null; }
  }

  /* The two pure helpers the page uses for display branching — which is a
     ground-up deal, which is a bridge, and how many projects the claimed
     experience adds up to. They are engine functions, so the answer has to come
     from the engine rather than be re-implemented on a screen. */
  try { out.derived.strategyCode = YSP.normStrategy(d.strategy); } catch (_) { out.derived.strategyCode = null; }
  try {
    out.derived.projectCount = YSP.projectCount(out.derived.strategyCode, {
      flips: num(d.expFlips), holds: num(d.expHolds), ground: num(d.expGround),
    });
  } catch (_) { out.derived.projectCount = null; }

  return out;
}

module.exports = { studioQuote, enginesReady, loadErr: () => loadErr, _internals: { programBlock, applyMarkup, clearMarkup } };
