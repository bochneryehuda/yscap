'use strict';
/**
 * LONG-TERM — "YOU ARE ALMOST AT A BETTER TIER."
 *
 * ── THE OWNER'S ASK ────────────────────────────────────────────────────────
 * 2026-08-30: *"You can make a nice flag that you're almost at the edge. If you
 * move down your loan amount a little bit, you can be in a better tier, where
 * every 5% is a better tier. If it's almost at a tier, make a pop-up. Also, on
 * the ratio, if the ratio is almost at a tier, then you make a pop-up that if
 * you enhance it a little bit, you're in a better tier."*
 *
 * ── THE TIER IS READ OFF THE SHEET, NOT ASSUMED ────────────────────────────
 * Every priced quote carries the vendor's own grid CELL in words — measured on
 * the live explain capture:
 *
 *     "LTV : 70.01% - 75.00%, DSCR : >= 1.25"
 *     "FICO : 760 - 779, CLTV : 70.01% - 75.00%"
 *
 * That is this investor's own statement of which band this loan landed in, so
 * the better tier is its lower edge and nothing has to be guessed. The owner's
 * "every 5% is a better tier" is used only as the FALLBACK, for a quote whose
 * sheet published no band — and the answer always SAYS which of the two it used,
 * because "your sheet says so" and "our standing assumption says so" are
 * different strengths of claim and an officer moving a borrower's loan amount
 * deserves to know which one they are acting on.
 *
 * ⛔ NOTHING IS EVER INVENTED. A cell this module cannot read contributes
 * nothing; a scenario missing the property value produces no dollar figure; and
 * where there is no tier to reach, the answer is null rather than an encouraging
 * sentence. A flag that tells somebody to cut a borrower's loan for a tier that
 * is not there is worse than no flag.
 *
 * ⛔ AND THE FIGURE IT STATES IS PROVEN, NOT COMPUTED AND HOPED. The loan amount
 * it reports is run back through the REAL rounding rule both connectors send on
 * (`tier-rounding.js`, which lifts an LTV) and stepped down until it genuinely
 * lands inside the better band. Stating a loan amount that is a cent short of
 * working is the one failure this cannot be allowed to have: somebody would
 * re-price at it, land in the same tier, and stop trusting the flag.
 *
 * PURE: no network, no database, no config.
 */

const tierRounding = require('./tier-rounding');

/**
 * THE FALLBACK LTV STEP — the owner's own words, and labelled as theirs.
 * Used only where the vendor published no band of its own.
 */
const STATED_LTV_STEP = 5;

/**
 * THE FALLBACK DSCR TIERS — Lender Price's own band edges, so a fallback can
 * never name a ratio tier that program does not price on. Kept here as data
 * rather than imported to keep this module free of the connector, and held to
 * the real ones by a test that reads `dscrBand` itself.
 */
const STATED_DSCR_TIERS = [0.75, 1.00, 1.25];

/**
 * HOW CLOSE IS "ALMOST".
 *
 * These decide only whether the flag is RAISED, never what it claims — the exact
 * loan amount and the exact ratio are always reported, so the officer judges
 * whether the move is worth making. They are deliberately modest: a flag that
 * fires on a loan four points off its tier is a flag people learn to close.
 */
const LTV_WINDOW_PP = 1.0;    // within one percentage point of the better band
const DSCR_WINDOW = 0.05;     // within five hundredths of the next ratio tier

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The bands a quote's own adjustment cells state, by field.
 *
 * Reads `LTV : 70.01% - 75.00%` and `DSCR : >= 1.25` out of the vendor's text.
 * A cell in any other shape is SKIPPED rather than half-read — this is free text
 * from two different vendors, and a mis-parse here becomes a tier we tell
 * somebody to chase.
 */
function readCells(lines) {
  const out = { ltv: [], cltv: [], dscr: [] };
  for (const l of Array.isArray(lines) ? lines : []) {
    const text = [l && l.detail, l && l.label].filter((x) => typeof x === 'string').join(' ; ');
    if (!text) continue;
    /* FIELD lo% - hi%   (a closed band)
       ⛔ THE COLON IS OPTIONAL, and that is a CORRECTION rather than a loosening. A Lender
       Price cell writes its band with no colon at all — `flattenAdjustments` produces
       `{group: 'DSCR', reason: 'DSCR 1.20 - 1.24'}` — so requiring one meant this parser
       could not read the ONE sheet that publishes its itemisation at price time, and every
       flag fell back to the standing steps saying "no band was published on this quote".
       It cannot over-match: the field name is still required and so is a real `lo - hi`. */
    const range = /\b(C?LTV|DSCR)\s*:?\s*(\d+(?:\.\d+)?)\s*%?\s*-\s*(\d+(?:\.\d+)?)\s*%?/gi;
    let m;
    while ((m = range.exec(text)) !== null) {
      const key = m[1].toLowerCase();
      const lo = num(m[2]), hi = num(m[3]);
      if (lo == null || hi == null || !(hi >= lo)) continue;
      if (out[key]) out[key].push({ lo, hi, text: m[0] });
    }
    // FIELD >= x   /   FIELD <= x   (an open threshold) — colon optional, same reason
    const thr = /\b(C?LTV|DSCR)\s*:?\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s*%?/gi;
    while ((m = thr.exec(text)) !== null) {
      const key = m[1].toLowerCase();
      const v = num(m[3]);
      if (v == null) continue;
      if (out[key]) out[key].push({ op: m[2], at: v, text: m[0] });
    }
  }
  return out;
}

/**
 * The LTV band this loan sits in, according to the sheet — or null.
 *
 * LTV is preferred over CLTV and they are never mixed: on a loan with
 * subordinate financing they are DIFFERENT numbers, and reporting a CLTV band
 * as though it were the first lien's would send somebody to reduce the wrong
 * loan. Where several cells state a band, the one this loan actually falls
 * inside is the one that describes it.
 */
function sheetBandFor(cells, key, currentPct) {
  const list = (cells && cells[key]) || [];
  const closed = list.filter((b) => b.lo != null && b.hi != null);
  const inside = closed.filter((b) => currentPct >= b.lo - 1e-9 && currentPct <= b.hi + 1e-9);
  if (inside.length === 1) return inside[0];
  if (inside.length > 1) {
    // Several cells agreeing is ordinary (FICO/CLTV and DSCR grids both name the
    // same band). Several DISAGREEING is not something to pick a winner from.
    const first = inside[0];
    return inside.every((b) => b.lo === first.lo && b.hi === first.hi) ? first : null;
  }
  return null;
}

/** The largest loan whose LTV, sent the way we really send it, is at or under `tierPct`. */
function loanForTier(value, tierPct) {
  if (!(value > 0) || !(tierPct > 0)) return null;
  // Start at the arithmetic answer in whole cents, then step DOWN until the
  // figure survives the real rule. Bounded: a handful of cents at most, and a
  // loop that cannot find one answers nothing rather than guessing.
  let cents = Math.floor(value * tierPct);            // value * tier/100, in cents
  for (let i = 0; i < 200 && cents > 0; i++, cents--) {
    const loan = cents / 100;
    const asSent2 = tierRounding.sendAs('ltv', (loan / value) * 100, 2);
    const asSent6 = tierRounding.sendAs('ltv', loan / value, 6) * 100;
    if (asSent2 <= tierPct + 1e-9 && asSent6 <= tierPct + 1e-9) return r2(loan);
  }
  return null;
}

/**
 * The LTV half: is this loan just over a better band, and what gets it there?
 */
function ltvNearTier({ value, loan, ltvPct, cells }) {
  const v = num(value);
  const cur = ltvPct != null ? num(ltvPct) : (v > 0 && num(loan) != null ? (num(loan) / v) * 100 : null);
  if (cur == null || !(cur > 0)) return null;

  const band = sheetBandFor(cells, 'ltv', cur) || sheetBandFor(cells, 'cltv', cur);
  let tier = null, source = null, cellText = null, basis = null;
  if (band) {
    // The sheet's own band starts at `lo`, so the band BELOW it tops out one cent
    // of a percent lower — the vendor's own statement of where the better tier is.
    tier = r2(band.lo - 0.01);
    source = 'sheet';
    cellText = band.text;
    basis = (cells.ltv || []).includes(band) ? 'LTV' : 'CLTV';
  } else {
    // The owner's stated step, and said to be theirs.
    const below = Math.floor((cur - 1e-9) / STATED_LTV_STEP) * STATED_LTV_STEP;
    if (!(below > 0) || below >= cur) return null;
    tier = r2(below);
    source = 'stated';
  }
  if (!(tier > 0) || tier >= cur) return null;
  const gap = r2(cur - tier);
  if (gap > LTV_WINDOW_PP + 1e-9) return null;

  const maxLoan = v > 0 ? loanForTier(v, tier) : null;
  const reduceBy = maxLoan != null && num(loan) != null ? r2(num(loan) - maxLoan) : null;
  return {
    field: 'ltv', current: r2(cur), tier, gap, source, basis, cell: cellText,
    maxLoan, reduceBy,
    message: maxLoan != null && reduceBy != null && reduceBy > 0
      ? `This loan is ${gap.toFixed(2)} of a point over the ${tier.toFixed(2)}% band. Bringing the loan amount down to ${maxLoan.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} — ${reduceBy.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} less — puts it in the better tier.`
      : `This loan is ${gap.toFixed(2)} of a point over the ${tier.toFixed(2)}% band, so a slightly smaller loan prices in the better tier.`,
    // WHERE THE TIER CAME FROM, in words, because the two are different strengths
    // of claim and the person acting on it should know which they have.
    why: source === 'sheet'
      ? `This investor's own rate sheet states the band as ${cellText}.`
      : `No band was published on this quote, so this uses the standing ${STATED_LTV_STEP}% steps.`,
  };
}

/**
 * The DSCR half: is the ratio just under a better tier, and by how much?
 *
 * There is deliberately NO "raise the rent by $X" here. The ratio moves on rent,
 * taxes, insurance, association dues and the payment itself, so naming one lever
 * would be picking one of five without being asked — the gap is stated and the
 * officer decides which one to move.
 */
function dscrNearTier({ dscr, cells }) {
  const cur = num(dscr);
  if (cur == null || !(cur > 0)) return null;

  const stated = ((cells && cells.dscr) || [])
    .map((c) => (c.op ? c.at : c.lo))
    .filter((x) => x != null && x > cur);
  const fromSheet = stated.length ? Math.min(...stated) : null;
  const fromStanding = STATED_DSCR_TIERS.filter((t) => t > cur).sort((a, b) => a - b)[0];
  const tier = fromSheet != null ? fromSheet : (fromStanding == null ? null : fromStanding);
  if (tier == null) return null;

  const gap = Math.round((tier - cur) * 1000) / 1000;
  if (gap > DSCR_WINDOW + 1e-9) return null;
  const source = fromSheet != null ? 'sheet' : 'stated';
  return {
    field: 'dscr', current: cur, tier, gap, source,
    message: `The ratio is ${gap.toFixed(2)} under ${tier.toFixed(2)}. Getting it to ${tier.toFixed(2)} prices in the better tier.`,
    why: source === 'sheet'
      ? 'This investor\'s own rate sheet names that ratio.'
      : 'No ratio band was published on this quote, so this uses the standing tiers.',
  };
}

/**
 * BOTH HALVES, for one quote. Never throws — a flag is a nicety and must never
 * be able to take a board down with it.
 */
function nearTier(input) {
  try {
    const i = input || {};
    const cells = readCells(i.lines);
    return { ltv: ltvNearTier({ ...i, cells }), dscr: dscrNearTier({ ...i, cells }) };
  } catch (_) {
    return { ltv: null, dscr: null };
  }
}

/**
 * EVERY GRID CELL A BOARD ALREADY CARRIES — the input `nearTier` reads its real bands from.
 *
 * ⛔ IT LIVES HERE BECAUSE IT IS THIS MODULE'S OWN INPUT, and it was a private helper in
 * `routes/combined-pricer.js` while the GENERAL engine needed the same thing. A second copy
 * of "which cells does a board carry" is how one engine's hint names an investor's real tier
 * and the other's falls back to the standing steps, on the same board.
 *
 * NEVER THROWS. A hint beside a board is never worth the board.
 */
function cellsOnBoard(board) {
  const out = [];
  try {
    for (const p of (board && board.programs) || []) {
      /* ⛔ BOTH SHAPES. A priced row is `options` on a Lender Price board and `rungs` on a
         LoanNEX one, and this read `rungs` alone — so on a Lender Price board, which is the
         ONE board that carries its itemisation at price time, it found nothing. See the
         header above: that is the whole reason it was returning an empty list. */
      const rows = (p && (p.options || p.rungs)) || [];
      for (const r of rows) {
        for (const a of (r && a_of(r)) || []) {
          if (!a || typeof a !== 'object') continue;
          /* `reason` is what a Lender Price cell calls its own label (`flattenAdjustments`
             writes `{group, reason, value}`); `label`/`name` cover the other shapes. */
          out.push({ label: a.label || a.reason || a.name || null, detail: a.detail || a.description || a.group || null });
        }
      }
    }
  } catch (_) { /* a hint is never worth a board */ }
  return out;
}
/** The itemised cells on one priced row, whichever key that row carries them under. */
function a_of(r) { return r.adjustments || r.rateAdjustments || null; }

module.exports = {
  cellsOnBoard,
  nearTier, STATED_LTV_STEP, STATED_DSCR_TIERS, LTV_WINDOW_PP, DSCR_WINDOW,
  _internals: { readCells, sheetBandFor, loanForTier, ltvNearTier, dscrNearTier },
};
