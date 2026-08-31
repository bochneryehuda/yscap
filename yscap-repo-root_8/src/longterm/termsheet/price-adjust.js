'use strict';
/* ──────────────────────────────────────────────────────────────────────────
   LONG-TERM — EVENING OUT A PRICE, OUT OF OUR OWN COMPENSATION (§40).

   Owner-directed 2026-08-31: *"you should be able to manually even out the
   numbers by manually adding a charge or manually giving a concession. The
   system should automatically give suggestions which should help you even it
   out to straight numbers ... bring it up to the nearest 0.00 or to the nearest
   0.25 or to the nearest 0.50 or 0.75 ... let's say if you type -0.1, it's going
   to bring it down from a 101.1 to a 101.0. And if you type +0.1, it's going to
   bring it up from 101.0 to 101.1."*

   And, asked what actually moves: *"Basically, either reducing our compensation
   or increasing our compensation to even it out. Instead of 2 points lender-paid,
   we'll only make 1.9 points lender-paid, or instead of 2 points, we're going to
   make 2.1."*

   ⛔ IT IS NEVER A RE-PRICE. The investor's rate and their raw price are untouched
   — nothing here goes near the vendor, and the borrower's RATE cannot move. The
   only figure that changes is OURS. That is what makes this safe to hand an
   officer: the worst case is that we earn less than we meant to, never that a
   borrower is quoted a rate the loan did not qualify for.

   ⛔ THE ARITHMETIC IS THE ONE THE OVERLAY ALREADY USES, not a second model:
   `overlay.shiftedPrice` is `displayPrice = rawPrice - comp`. So with the raw
   price held still, moving the display price by δ moves our compensation by −δ,
   which is exactly the owner's two examples and is asserted against `overlay`
   itself in the test rather than restated here:

       typed -0.10  ->  101.1 -> 101.0   and comp 2.000 -> 2.100  (we make MORE)
       typed +0.10  ->  101.0 -> 101.1   and comp 2.000 -> 1.900  (we make LESS)

   The sign is on the PRICE because that is the number the officer is looking at
   and typing toward. `compDelta` is reported alongside every answer so no screen
   ever has to work out the direction for itself — a screen that got that backwards
   would quietly cost us money on every sheet.

   PURE — no database, no requires, no config — so every rule is unit-testable and
   the same function serves the three workflows the owner named (a single term
   sheet, a scenario comparison and a pricing comparison) instead of three copies
   drifting apart.
   ────────────────────────────────────────────────────────────────────────── */

const nn = (v) => typeof v === 'number' && Number.isFinite(v);
/** Points carry three decimals everywhere in this folder; money is rounded later. */
const r3 = (v) => Math.round(v * 1000) / 1000;

/** The compensation modes an adjustment can apply to. RAW is the vendor's own
 *  answer before our compensation exists, so there is nothing of ours to move. */
const ADJUSTABLE_MODES = ['borrowerPaid', 'lenderPaid'];

/** How far we will let one adjustment move, in points. A cap is not bureaucracy:
 *  a typed 25 (meaning 0.25) would otherwise wipe out the compensation and
 *  silently re-shape the whole sheet. Anything past this is REFUSED and named. */
const MAX_DELTA_POINTS = 2;

/** The grids the owner asked to snap to: the quarter-point ladder, and whole points. */
const GRIDS = [
  { key: 'quarter', step: 0.25, label: 'quarter point' },
  { key: 'whole', step: 1, label: 'whole point' },
];

const refuse = (code, message) => ({ ok: false, code, message });

/**
 * Which compensation figure a mode spends. Mirrors `overlay.compShiftPoints`
 * — deliberately the same two keys, because a third reading of "what do we make
 * on this option" is how a screen and a document come to disagree about it.
 */
function compOf(plan, mode) {
  if (!plan || typeof plan !== 'object') return null;
  if (mode === 'lenderPaid') return nn(plan.lenderPaid) ? r3(plan.lenderPaid) : null;
  if (mode === 'borrowerPaid') return nn(plan.ysp) ? r3(plan.ysp) : null;
  return null;
}

/**
 * Apply one adjustment.
 *
 * `deltaPoints` is signed and is about the PRICE: negative lowers the price the
 * borrower is shown and raises what we make; positive raises the price and
 * lowers what we make.
 *
 * Answers `{ok:false, code, message}` rather than throwing, and never returns a
 * half-computed shape — every caller can render the message it is given.
 */
function applyAdjustment({ plan, mode, rawPrice, deltaPoints }) {
  if (!ADJUSTABLE_MODES.includes(mode)) {
    return refuse('mode_not_adjustable',
      'Raw pricing is the vendor’s own number before our compensation, so there is nothing of ours to even out. Switch to borrower-paid or lender-paid.');
  }
  if (!nn(rawPrice)) return refuse('no_price', 'That option has no price to adjust.');
  if (!nn(deltaPoints)) return refuse('no_delta', 'Type how much to move the price by, in points.');
  if (deltaPoints === 0) return refuse('no_delta', 'That would not move anything.');
  if (Math.abs(deltaPoints) > MAX_DELTA_POINTS) {
    return refuse('delta_too_large',
      `An adjustment is capped at ${MAX_DELTA_POINTS} points. ${fmtPts(deltaPoints)} is almost certainly a decimal slip.`);
  }

  const comp = compOf(plan, mode);
  if (comp == null) {
    return refuse('no_comp', 'This option has no compensation recorded, so there is nothing to take the adjustment out of.');
  }

  const priceBefore = r3(rawPrice - comp);
  const priceAfter = r3(priceBefore + deltaPoints);
  /* ⛔ THE COMPENSATION ABSORBS IT, WHICH IS THE OWNER'S OWN RULE — the raw price
     never moves, so this is the only place the difference can come from. */
  const compAfter = r3(comp - deltaPoints);

  /* ⛔ WE CANNOT PAY THE BORROWER TO TAKE THE LOAN. A negative compensation is not
     a smaller fee, it is us writing a cheque, and it is far more likely to be a
     mistyped sign than an intention. Refused, naming the most it can give away. */
  if (compAfter < 0) {
    return refuse('comp_negative',
      `That would take our compensation below zero (${fmtPts(compAfter)}). The most you can give away here is ${fmtPts(comp)}.`);
  }

  return {
    ok: true,
    mode,
    rawPrice: r3(rawPrice),
    priceBefore,
    priceAfter,
    compBefore: comp,
    compAfter,
    /* Reported, never left for a screen to derive: the direction is the one thing
       a caller can invert without noticing, and inverting it costs us money. */
    compDelta: r3(compAfter - comp),
    deltaPoints: r3(deltaPoints),
    /** Plain words for the screen, so all three workflows say it identically. */
    summary: `Price ${priceBefore.toFixed(3)} → ${priceAfter.toFixed(3)} · `
      + `our compensation ${comp.toFixed(3)} → ${compAfter.toFixed(3)} `
      + `(${compAfter > comp ? 'we make more' : 'we give up'} ${fmtPts(Math.abs(compAfter - comp))})`,
  };
}

/** Points, written the way this folder writes them. */
function fmtPts(v) {
  if (!nn(v)) return '—';
  return `${v > 0 ? '' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(3)} points`;
}

/**
 * THE SUGGESTIONS — the round numbers this price is nearest to, in both
 * directions, each with what it would cost or gain us.
 *
 * ⛔ A SUGGESTION THAT DOES NOT MOVE IS NOT OFFERED. A price already sitting on a
 * quarter would otherwise produce a "round to 101.250" button that does nothing,
 * which reads as a broken control rather than as "already even".
 *
 * HONEST NOTE, MEASURED: that `delta === 0` line is REDUNDANT today. Removing it
 * fails no assertion, because `applyAdjustment` refuses a zero delta (`no_delta`)
 * and the `applied.ok` filter below drops the candidate anyway. It is kept as a
 * cheap local guard so this function's own correctness does not depend on which
 * inputs `applyAdjustment` happens to refuse — but it does NOT bite, and saying so
 * is better than implying a second layer of protection that is not there. The
 * filter below is the one doing the work, and IT is mutation-proven (D7b–D7d).
 *
 * ⛔ AND ONE THAT WOULD BE REFUSED IS NOT OFFERED EITHER. Every candidate is run
 * through `applyAdjustment`, so a suggestion can never be a button that answers
 * with an error — the cap and the negative-compensation rule are applied once,
 * in one place, to both the typed path and the suggested one.
 */
function roundingSuggestions({ plan, mode, rawPrice }) {
  const comp = compOf(plan, mode);
  if (!nn(rawPrice) || comp == null || !ADJUSTABLE_MODES.includes(mode)) return [];
  const price = r3(rawPrice - comp);
  const out = [];
  const seen = new Set();
  for (const grid of GRIDS) {
    for (const dir of ['down', 'up']) {
      const target = dir === 'down'
        ? r3(Math.floor(price / grid.step) * grid.step)
        : r3(Math.ceil(price / grid.step) * grid.step);
      const delta = r3(target - price);
      if (delta === 0) continue;
      const key = target.toFixed(3);
      if (seen.has(key)) continue;
      const applied = applyAdjustment({ plan, mode, rawPrice, deltaPoints: delta });
      if (!applied.ok) continue;
      seen.add(key);
      out.push({
        key: `${grid.key}:${dir}`,
        grid: grid.key,
        gridLabel: grid.label,
        direction: dir,
        target,
        deltaPoints: delta,
        compAfter: applied.compAfter,
        compDelta: applied.compDelta,
        label: `${dir === 'down' ? 'Down' : 'Up'} to ${target.toFixed(2)}`,
        detail: applied.summary,
      });
    }
  }
  return out.sort((a, b) => a.target - b.target);
}

module.exports = {
  applyAdjustment,
  roundingSuggestions,
  ADJUSTABLE_MODES,
  MAX_DELTA_POINTS,
  GRIDS,
  _internals: { compOf, fmtPts },
};
