'use strict';
/**
 * src/lib/min-origination.js — THE MINIMUM ORIGINATION FEE, IN ONE PLACE.
 *
 * OWNER-DIRECTED 2026-09-04: *"We're going to enforce right now a minimum origination fee of 2,500
 * dollars pre-filled which means should not be pre-set it should be pre-filled … if the loan amount
 * is 100,000 it's going to be more than the origination set by percentage because no matter the
 * percentage it's not going to get to 2500 and 2500 is the minimum."* Every RTL program — Standard,
 * Gold, Silver, Speed and Manual.
 *
 * The research pass behind this, including the measurements quoted below and the decisions that are
 * the owner's, is `docs/MINIMUM-ORIGINATION-FEE-RESEARCH.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS TOUCHES NO FROZEN ENGINE, WHICH IS WHAT MAKES IT SAFE. Each engine exports `ORIG_PCT` as
 * a CONSTANT and never reads it in `sizeLoan` — verified in `standard-program.js`, where it appears
 * only at its declaration and in the exported `constants` block. The loan amount, the note rate,
 * every cap, the initial advance, the holdback and the financed reserve are all computed ABOVE the
 * origination line and never read it. So a floor on that fee is a pure closing-cost change of
 * exactly the same class as the construction feasibility fee and the legal-fee ladder: no engine
 * file moves, and no authorization of a frozen guideline number is required.
 *
 * AND WHY IT REACHES CASH-TO-CLOSE AND THE LIQUIDITY REQUIREMENT WITH NOTHING EXTRA WIRED:
 *
 *     origination ──► closingDueAtClose ──► cashToClose ──► liquidityRequired
 *
 * A fee can never be missing from a total that is built by adding, which is the same reasoning
 * `scripts/lib/fee-roster.js` records for treating those two as totals proven by ARITHMETIC rather
 * than surfaces proven by a source token. The owner's *"it needs to calculate in the cash to close
 * and the liquidity requirement"* is therefore satisfied at the one line where the floor is applied.
 *
 * WHAT IT ACTUALLY CHANGES, MEASURED. At the 1.25% default the minimum is reached at a $200,000
 * loan, so it binds below that and on NOTHING above it. The owner's own example: a $100,000 loan
 * pays $1,250 today and $2,500 with the minimum — an effective 2.500%.
 *
 * PURE — no database, no config, no requires — so every rule here is unit-testable, and the server,
 * the studio's browser mirror and the admin screen read ONE definition.
 */

/** The owner's number. OWNER-SET: changing it changes what a real borrower is charged. It is the
 *  bottom of a three-step chain (per-file override → company default → this), never a hard wire —
 *  *"pre-filled … should not be pre-set"*. */
const MIN_ORIGINATION_FEE = 2500;

/** A guard against a decimal slip typed into an admin box. A minimum origination fee is a few
 *  thousand dollars; a mis-keyed 250000 would make every small loan unquotable, and silently. Above
 *  this the value is REFUSED (the chain falls through to the next step) rather than applied. */
const MAX_MIN_ORIGINATION_FEE = 25000;

/* `Number('  ')` is 0, not NaN — so a box holding nothing but spaces would resolve to a minimum of
   ZERO and silently waive the fee on every file. A blank of any shape is NOT a number here. Found
   by section C3 of the pure test before this shipped. */
const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A percentage as a person writes it: 1.25%, 2.5%, never 2.50000000001%. */
function pctStr(frac) {
  const p = Math.round(Number(frac) * 100 * 1000) / 1000;
  return p + '%';
}

/**
 * Resolve WHICH minimum governs, from the same three-step chain every other fee in this system
 * uses. Kept here rather than in the caller so the server, the studio and the admin screen cannot
 * answer "what is the minimum on this file" differently.
 *
 *   per-file override  →  company default  →  MIN_ORIGINATION_FEE
 *
 * A value that is blank, unreadable, negative or implausibly large is NOT a minimum and falls
 * through to the next step — EXCEPT an explicit 0, which is a real decision (an approved exception
 * waiving the minimum outright) and is honoured. That asymmetry is the whole reason this is a
 * function and not a `||` chain: `0 || next` would silently un-waive an approved waiver.
 */
function resolveMinFee(perFile, companyDefault) {
  for (const candidate of [perFile, companyDefault]) {
    const n = num(candidate);
    if (n == null) continue;
    if (n < 0 || n > MAX_MIN_ORIGINATION_FEE) continue;
    return round2(n);
  }
  return MIN_ORIGINATION_FEE;
}

/**
 * The origination fee actually charged, and everything a surface needs to explain it.
 *
 *   { totalLoan, origPct, minFee }  →
 *   { amount, pctAmount, pct, minimum, applied, shortfall, effectivePct, label, note }
 *
 * `amount` is the DOLLARS CHARGED and keeps the exact meaning `quote.closingCosts.origination`
 * already has, so DocLab, the tapes, the emails, the tie-outs and the reporting need no change.
 *
 * THE ROUNDING ORDER IS LOAD-BEARING. The percentage figure is rounded to the cent FIRST and the
 * comparison happens against that rounded number, because the rounded number is the one that gets
 * PRINTED. Comparing the unrounded product instead would let a $2,499.996 fee — which prints as
 * $2,500.00 — be labelled "minimum applied" on a term sheet that shows the two figures as equal,
 * and would leave the fees a borrower can read failing to add up to the total beneath them by a
 * cent. Both figures here are already at 2dp, so nothing downstream can drift.
 */
function originationFor(input) {
  const inp = input || {};
  const totalLoan = Math.max(0, num(inp.totalLoan) || 0);
  const pct = Math.max(0, num(inp.origPct) || 0);
  const minimum = Math.max(0, num(inp.minFee) != null ? num(inp.minFee) : MIN_ORIGINATION_FEE);

  /* NO LOAN, NO FEE. `origination` has always been 0 on an unsized deal and it stays 0: a minimum
     fee on a loan that does not exist is nonsense, and it would otherwise put $2,500 of cash-to-
     close on every blank pricing screen. */
  if (totalLoan <= 0) {
    return Object.freeze({
      totalLoan: 0, amount: 0, pctAmount: 0, pct, minimum, applied: false, shortfall: 0,
      effectivePct: 0, label: null, note: null,
    });
  }

  const pctAmount = round2(totalLoan * pct);
  const applied = minimum > pctAmount;
  const amount = applied ? round2(minimum) : pctAmount;

  return Object.freeze({
    /* CARRIED, never re-derived. the derivation page shows the arithmetic ("1.25% of $100,000.00 = …") and
       recovering it as `pctAmount / pct` is wrong at pct 0 and floating-point fragile everywhere
       else — a derivation page that misstates the number it is deriving FROM is worse than none. */
    totalLoan,
    amount,
    pctAmount,
    pct,
    minimum,
    applied,
    shortfall: applied ? round2(amount - pctAmount) : 0,
    /* The percentage this fee ACTUALLY represents. Read by Blue Lake's data tape (owner-directed
       2026-09-04: *"Send them a higher percentage, according to how much this is the real
       percentage for $2,500"*) and by the staff-facing derivation. DERIVED from the two numbers on
       the row rather than stored, so it can never disagree with the dollars beside it — and equal
       to `pct` by construction whenever the minimum did not bind, which is what makes the tape
       byte-identical on every loan the minimum does not reach. */
    /* EXACTLY `pct` when the minimum did not bind, and only computed when it did. Dividing the
       ROUNDED dollars by the loan does NOT give the stated rate back: 1.25% of $200,001 rounds to
       $2,500.01, and $2,500.01 / $200,001 is 0.0124999875 — so a tape that reads this would send
       1.2499987…% where it has always sent exactly 1.25%, on every loan the minimum never touches.
       That is a change to what an investor receives, dressed as a no-op. Found by section A3 of the
       pure test before this shipped. */
    effectivePct: applied ? amount / totalLoan : pct,
    label: applied ? LABEL_MINIMUM : null,
    note: applied ? minimumNote({ minimum, pct, pctAmount }) : null,
  });
}

/* ── WORDING ─────────────────────────────────────────────────────────────────────────────────── */
/* The owner was explicit that this is NOT a new line: *"needs to be a new line of the term sheet
   like not a new line but wording next to the origination fee that's because of the minimum."* So
   the origination row keeps its place and gains a qualifier.

   THREE THINGS THIS WORDING NEVER DOES. It never calls the floor a penalty — it is a minimum on a
   fee, exactly as the 3-month minimum earned interest is never a "prepayment penalty" (the standing
   rule). It never names a note buyer or capital partner. And the BORROWER-facing row never states
   an effective percentage: two percentages on one line invites "so which rate am I being charged?",
   so the effective figure lives on the derivation page and the staff panel, where the reader is an
   underwriter.

   AND NOTHING PRINTS WHEN THE MINIMUM DOES NOT BIND. A note that appears on every file teaches
   people to stop reading notes; every surface is byte-identical to today on a loan at or above the
   crossover. */
const LABEL_MINIMUM = 'Origination fee (minimum applied)';
const LABEL_PLAIN = 'Origination fee';

/** The sub-line under the row — the term sheet, the studio, the staff panel. */
function minimumNote({ minimum, pct, pctAmount }) {
  return `This loan's origination fee is our ${money(minimum)} program minimum, which is more than `
       + `${pctStr(pct)} of the loan amount (${money(pctAmount)}).`;
}

module.exports = {
  MIN_ORIGINATION_FEE,
  MAX_MIN_ORIGINATION_FEE,
  LABEL_MINIMUM,
  LABEL_PLAIN,
  resolveMinFee,
  originationFor,
  minimumNote,
  _internals: { round2, pctStr, money },
};
