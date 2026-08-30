'use strict';
/**
 * LONG-TERM — THE MARGIN HOLDBACK WE ADD OURSELVES.
 *
 * ── THE OWNER'S INSTRUCTION, IN WRITING ────────────────────────────────────
 * 2026-08-30, answering a direct question about whether the 0.25 was Button
 * Finance's alone or wider:
 *
 *   *"Every investor from LoanNEX needs to get the 0.25 margin hold back added,
 *   the same way you see in certain programs that Lender Price is adding it
 *   manually. On LoanNEX, everybody, you need to add this manually."*
 *
 * That is the explicit written authorization the standing pricing rule requires.
 * It is recorded here, in the owner's own words, because this module moves a
 * number a borrower is quoted and the authority for it must sit beside the code.
 *
 * ── WHAT IT IS, AND WHY IT IS NOT A PREFERENCE ─────────────────────────────
 * Lender Price's feed already carries our holdback on certain programs — the
 * vendor bakes it in. LoanNEX's feed does NOT: what it returns is the raw
 * investor price. Left alone, the two feeds are not the same measurement, and a
 * LoanNEX quote would read 0.25 better than a Lender Price quote for reasons
 * that have nothing to do with the investor. So this is not a fee being added;
 * it is the second feed being brought onto the same footing as the first.
 *
 * A HIGHER PRICE IS BETTER EXECUTION, so a holdback SUBTRACTS from the price
 * (and adds to the points, which is the same statement). 0.25 in points.
 *
 * ── APPLIED ONCE, AT ONE PLACE, BEFORE ANYTHING READS THE BOARD ────────────
 * It is applied to the parsed BOARD, immediately after the vendor's answer is
 * normalised and before the merge, the comparison, the quote shape or the
 * compensation overlay see it. Every one of those then works on the held-back
 * number automatically. Applying it in two places is how a holdback comes to be
 * taken twice, and `applyToBoard` refuses to run on a board it has already
 * marked — so a second call is a no-op rather than a second 0.25.
 *
 * ⛔ APPLYING IT AFTER THE COMPARISON WOULD BE THE SUBTLE VERSION OF THE SAME
 * BUG: the merge would elect on raw LoanNEX prices and the board would then
 * display held-back ones, so the reason given for an election would not match
 * the numbers beside it.
 *
 * ── THE RAW NUMBER IS NEVER LOST ───────────────────────────────────────────
 * Every rung keeps `vendorPrice` — exactly what the vendor sent — beside the
 * held-back `price`, plus `marginHoldback` saying how much moved. A number we
 * changed must always be reconcilable to the number we were given.
 *
 * PURE: no network, no database, no RTL import.
 */

/**
 * Points held back per source. Lender Price is ZERO here **not because there is
 * no holdback** but because its feed already carries it — taking it again would
 * double it. That distinction is the whole reason this table is keyed by SOURCE
 * rather than being a single constant.
 */
const MARGIN_HOLDBACK_POINTS = {
  loannex: 0.25,
  lenderprice: 0,
};

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
/**
 * Is this actually a number?
 *
 * ⛔ `Number.isFinite(Number(v))` IS NOT THAT TEST, and the difference is not
 * academic here. `Number(null)`, `Number('')`, `Number(false)` and `Number([])`
 * are all 0, so the loose form calls every one of them a finite number — and
 * this module then does arithmetic on it. Measured on the loose form:
 *   · a rung with a real price and `points: null` came out with points 0.25
 *     instead of −1.25, so its price and points summed to 101.5 rather than 100
 *     — a board contradicting itself, which is the one thing the shift-don't-
 *     recompute rule above exists to prevent;
 *   · a rung with `price: null` was given a FABRICATED price of −0.25, on a
 *     quote the vendor never priced.
 * The LoanNEX parser happens to skip both shapes today, so neither is reachable
 * through it — but this function is exported and a vendor payload is not ours to
 * promise. A number is a number, or a string that spells one; nothing else.
 */
const nn = (v) => (typeof v === 'number'
  ? Number.isFinite(v)
  : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))));

/**
 * The most a holdback may be set to, in points.
 *
 * Not a policy about what is sensible — it is a DECIMAL-SLIP GUARD. A holdback
 * is quoted in points, so somebody meaning 0.25 and typing 25 would take a
 * quarter of the loan off every price on the board. Ten points is far above
 * anything anybody would ever hold back and far below a slipped decimal, so it
 * catches the typo without ever refusing a real number.
 */
const MAX_HOLDBACK_POINTS = 10;

/** The holdback for a source; an unknown source holds back NOTHING. */
function holdbackFor(source) {
  const h = MARGIN_HOLDBACK_POINTS[String(source || '').toLowerCase()];
  return nn(h) ? Number(h) : 0;
}

/**
 * WHAT THIS SOURCE HOLDS BACK, AND WHERE THAT ANSWER CAME FROM.
 *
 * Owner-directed 2026-08-30: *"there should always be in the settings the
 * possibility to move up the margin hold back, remove the margin hold back, or
 * move it down."* So the 0.25 is a PRE-FILL rather than a constant, and this is
 * the one place a saved value is turned into the number the board is priced on.
 *
 * ⛔ AN UNREADABLE SETTING FALLS BACK TO THE OWNER'S NUMBER, NEVER TO ZERO, and
 * that asymmetry is the whole safety property. Every other setting in this
 * engine can fail toward "do nothing"; this one cannot, because doing nothing
 * here means handing the borrower 0.25 of better execution that nobody decided
 * to give them. A typo, a half-written value, a settings store that will not
 * answer — all of them keep the standing 0.25 and SAY they were refused.
 *
 * ⛔ REMOVING IT IS A DECISION, NOT AN ABSENCE. A deliberate 0 is honoured and
 * still reported as `origin:'setting'`, so a board with no holdback on it can
 * always be told apart from a board where the setting failed to load. That is
 * why 0 is returned with a stamp rather than short-circuiting.
 *
 * Returns `{ points, origin, problem }` — origin is `setting` when a person
 * chose it, `default` when nobody has, and `none` for a source that never holds
 * back at all (Lender Price, whose feed already carries ours).
 */
function resolveHoldback(source, saved) {
  const key = String(source || '').toLowerCase();
  const base = holdbackFor(key);
  // A source that holds back nothing by design is not configurable into holding
  // something back: Lender Price's feed ALREADY carries our holdback, so a
  // second one here would take it twice. That is a fact about the feed, not a
  // preference, so it is not offered as a setting.
  if (!(key in MARGIN_HOLDBACK_POINTS) || base === 0) {
    return { points: base, origin: 'none', problem: null };
  }
  if (saved === undefined || saved === null || saved === '') {
    return { points: base, origin: 'default', problem: null };
  }
  const n = Number(saved);
  if (!Number.isFinite(n)) {
    return { points: base, origin: 'default', problem: { error: 'not_a_number', value: String(saved), message: `The saved margin holdback (${String(saved)}) is not a number, so the standing ${base} is still being held back.` } };
  }
  if (n < 0) {
    return { points: base, origin: 'default', problem: { error: 'negative', value: n, message: `A margin holdback cannot be negative — that would ADD to the price. The standing ${base} is still being held back.` } };
  }
  if (n > MAX_HOLDBACK_POINTS) {
    return { points: base, origin: 'default', problem: { error: 'too_large', value: n, message: `${n} points looks like a slipped decimal (the most that may be set is ${MAX_HOLDBACK_POINTS}). The standing ${base} is still being held back.` } };
  }
  return { points: r3(n), origin: 'setting', problem: null };
}

/**
 * Apply the holdback to one normalised board, in place of a copy.
 *
 * Returns a NEW board (the input is not mutated) whose every rung carries:
 *   price          — the held-back price, which is what everything downstream reads
 *   points         — 100 − price, kept in step
 *   vendorPrice    — the vendor's own number, untouched
 *   marginHoldback — how much was held back, so the two reconcile
 *
 * A board with nothing to hold back comes back UNCHANGED (same object), so the
 * Lender Price path is provably untouched by this module.
 */
function applyToBoard(board, source, opts) {
  const resolved = resolveHoldback(source, opts && opts.saved);
  const pts = resolved.points;
  if (!board || !Array.isArray(board.programs)) return board;
  // ALREADY DONE IS DONE. Without this, a caller that applied it and then passed
  // the board through a second helper would hold back 0.50.
  if (board.marginHoldback != null) return board;

  // ⛔ A HOLDBACK OF ZERO IS STILL AN ANSWER, and it is stamped. Returning the
  // board untouched here — which is what this did while 0.25 was a constant —
  // makes "the owner removed the holdback" indistinguishable from "nobody has
  // ever configured one" and from "the settings failed to load". Now that the
  // number is settable, telling those apart is the difference between a board
  // priced the way somebody decided and a board priced by an outage. The
  // `origin:'none'` case (Lender Price, which never holds back) still returns
  // untouched, because there is no decision there to record.
  if (!pts && resolved.origin === 'none') return board;
  if (!pts) {
    return {
      ...board,
      marginHoldback: 0,
      marginHoldbackOrigin: resolved.origin,
      marginHoldbackProblem: resolved.problem,
      marginHoldbackNote: resolved.origin === 'setting'
        ? `No margin holdback is being taken on ${source} quotes — it was deliberately set to zero. Lender Price's feed still carries its own, so the two feeds are NOT on the same footing while this stands.`
        : `No margin holdback is configured for ${source}.`,
    };
  }

  const programs = board.programs.map((p) => ({
    ...p,
    rungs: (p.rungs || []).map((r) => {
      if (!r || !nn(r.price)) return r;
      const vendorPrice = nn(r.vendorPrice) ? Number(r.vendorPrice) : Number(r.price);
      const price = r3(vendorPrice - pts);
      // POINTS ARE SHIFTED, NOT RECOMPUTED. `100 − price` off the ROUNDED price
      // can land a thousandth away from the points the parser derived from the
      // unrounded one, and a board whose price and points disagree by 0.001 is a
      // board somebody will spend an afternoon on. A holdback moves the price
      // down and the points up by exactly the same amount, so shift.
      const points = nn(r.points) ? r3(Number(r.points) + pts) : r3(100 - price);
      return { ...r, vendorPrice: r3(vendorPrice), price, points, marginHoldback: pts };
    }),
  }));
  // The board's own summary figures are derived from the rungs, so they move too
  // — a `maxPrice` still quoting the raw number would contradict every row.
  for (const p of programs) {
    // `r &&` because a null rung in the array threw here and took the WHOLE
    // board with it — the rung loop above returns a null rung untouched, and
    // then this read its `.points`.
    p.minPoints = p.rungs.reduce((m, r) => (r && nn(r.points) && (m == null || r.points < m) ? r.points : m), null);
    p.maxPrice = p.rungs.reduce((m, r) => (r && nn(r.price) && (m == null || r.price > m) ? r.price : m), null);
  }
  return {
    ...board,
    programs,
    marginHoldback: pts,
    // WHERE THE NUMBER CAME FROM, on the board itself. A price that moved must
    // be able to say who moved it: the owner's standing 0.25, somebody's saved
    // change, or the standing number still in force because a saved one was
    // refused — and in that last case the refusal travels with it rather than
    // being logged somewhere nobody reads.
    marginHoldbackOrigin: resolved.origin,
    marginHoldbackProblem: resolved.problem,
    marginHoldbackNote: `${pts} in points is held back on every ${source} quote${resolved.origin === 'setting' ? ' (set in the combined engine settings)' : ' (owner-directed)'}: Lender Price's feed already carries it and this one does not, so the two are brought onto the same footing before anything compares them.`,
  };
}

module.exports = {
  MARGIN_HOLDBACK_POINTS, MAX_HOLDBACK_POINTS,
  holdbackFor, resolveHoldback, applyToBoard,
  _internals: { r3 },
};
