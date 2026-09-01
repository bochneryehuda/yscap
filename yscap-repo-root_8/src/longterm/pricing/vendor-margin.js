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
 * One investor's EXTRA, read the same way the global figure is read.
 *
 * Refuses what it cannot use and SAYS SO rather than applying a guess: a
 * half-typed value, a slipped decimal, or an extra so negative it would try to
 * pay the borrower. `base` is passed only so a refusal can say what is still
 * being held back instead of quoting a number out of context.
 */
function readExtra(extra, base) {
  if (extra === undefined || extra === null || extra === '') return { points: 0, problem: null };
  const n = Number(extra);
  if (!Number.isFinite(n)) {
    return { points: 0, problem: { error: 'extra_not_a_number', value: String(extra), message: `This investor's extra margin holdback (${String(extra)}) is not a number, so only the standing ${base} is being held back on it.` } };
  }
  if (Math.abs(n) > MAX_HOLDBACK_POINTS) {
    return { points: 0, problem: { error: 'extra_too_large', value: n, message: `${n} points looks like a slipped decimal (the most an investor's extra may be, either way, is ${MAX_HOLDBACK_POINTS}). Only the standing ${base} is being held back on it.` } };
  }
  return { points: r3(n), problem: null };
}

/** The base and the extra, added — never below zero, and it says when it floored. */
function withExtra(res, ex, base) {
  const problem = res.problem || ex.problem || null;
  if (!ex.points) return { ...res, problem, base, extra: 0, extraApplied: false, floored: false };
  const raw = r3(base + ex.points);
  const floored = raw < 0;
  const points = floored ? 0 : Math.min(raw, MAX_HOLDBACK_POINTS);
  return {
    ...res,
    points: r3(points),
    origin: 'setting',
    base,
    extra: ex.points,
    extraApplied: true,
    floored,
    problem: floored
      ? { error: 'extra_below_zero', value: ex.points, message: `An extra of ${ex.points} against a ${base} holdback would come to ${raw}, and a holdback below zero would ADD to the price. Nothing is being held back on this investor.` }
      : problem,
  };
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
 * ── AND THE PER-INVESTOR EXTRA (owner-directed 2026-08-30) ─────────────────
 * *"We can add extra company margin holdbacks on top of each and every program.
 * If it's a set on LoanNEX, we should be able to increase or decrease the margin
 * holdbacks accordingly."*
 *
 * ⛔ ONE NUMBER PER INVESTOR ANSWERS BOTH SENTENCES, which is why it is signed
 * rather than two separate controls. A POSITIVE extra adds on top of whatever
 * the source holds back; a NEGATIVE one takes it back down, so the standing 0.25
 * on a LoanNEX investor can be moved to 0.10 (−0.15) or removed outright (−0.25)
 * without touching what every other investor is priced on. Two fields — "add"
 * and "reduce" — would be two ways to say one thing, and the file would then
 * have to decide what they mean together.
 *
 * ⛔ THE TOTAL CAN NEVER GO BELOW ZERO. A negative effective holdback is not a
 * smaller holdback, it is a GIVEAWAY: it would ADD to the vendor's price and
 * quote the borrower better execution than the investor offered. So the sum is
 * floored at zero and the floor is REPORTED, never silent — somebody who typed
 * −0.40 against a 0.25 base asked for something arithmetic cannot do, and being
 * told beats a board that quietly did something else.
 *
 * ⛔ AND AN EXTRA REACHES LENDER PRICE, WHILE THE GLOBAL SAVED NUMBER STILL DOES
 * NOT. Those are different things and the distinction is load-bearing: the
 * global figure exists to bring LoanNEX's raw feed onto the same footing as
 * Lender Price's, which ALREADY carries our standard margin — applying it there
 * too would take it twice. A per-investor extra is the owner asking for MORE on
 * one named investor, which is a decision about that investor rather than about
 * the feed, and the owner asked for it on "each and every program".
 *
 * Returns `{ points, origin, problem, base, extra, extraApplied, floored }` —
 * origin is `setting` when a person chose it, `default` when nobody has, and
 * `none` for a source that holds back nothing and has no extra set either.
 */
function resolveHoldback(source, saved, extra) {
  const key = String(source || '').toLowerCase();
  const base = holdbackFor(key);
  const ex = readExtra(extra, base);
  // A source that holds back nothing by design is not configurable into holding
  // something back: Lender Price's feed ALREADY carries our holdback, so a
  // second GLOBAL one here would take it twice. That is a fact about the feed,
  // not a preference, so it is not offered as a setting. A per-investor EXTRA is
  // a different decision and does apply — see the note above.
  if (!(key in MARGIN_HOLDBACK_POINTS) || base === 0) {
    if (ex.points) return withExtra({ points: 0, origin: 'none', problem: null }, ex, 0);
    return { points: base, origin: 'none', problem: ex.problem, base, extra: 0, extraApplied: false, floored: false };
  }
  if (saved === undefined || saved === null || saved === '') {
    return withExtra({ points: base, origin: 'default', problem: null }, ex, base);
  }
  const n = Number(saved);
  if (!Number.isFinite(n)) {
    return withExtra({ points: base, origin: 'default', problem: { error: 'not_a_number', value: String(saved), message: `The saved margin holdback (${String(saved)}) is not a number, so the standing ${base} is still being held back.` } }, ex, base);
  }
  if (n < 0) {
    return withExtra({ points: base, origin: 'default', problem: { error: 'negative', value: n, message: `A margin holdback cannot be negative — that would ADD to the price. The standing ${base} is still being held back.` } }, ex, base);
  }
  if (n > MAX_HOLDBACK_POINTS) {
    return withExtra({ points: base, origin: 'default', problem: { error: 'too_large', value: n, message: `${n} points looks like a slipped decimal (the most that may be set is ${MAX_HOLDBACK_POINTS}). The standing ${base} is still being held back.` } }, ex, base);
  }
  return withExtra({ points: r3(n), origin: 'setting', problem: null }, ex, r3(n));
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
  const o = opts || {};
  /**
   * ⛔ THE PER-INVESTOR SEAM IS A FUNCTION THE CALLER SUPPLIES, not an investor
   * lookup done here (owner-directed 2026-08-30: *"We can add extra company
   * margin holdbacks on top of each and every program"*).
   *
   * Working out which canonical investor a program row belongs to is `merge`'s
   * job and it is not a simple one — two vendors spell one company several ways
   * and a person's recorded links outrank every lookup. Doing it here would be a
   * SECOND resolver, and the day the two disagreed an investor's extra would be
   * applied to somebody else's rows. So the route hands in the one resolver it
   * already uses, and this module stays about the arithmetic.
   *
   * With no `extraFor` supplied, every line below behaves exactly as it did when
   * the holdback was one number for the whole board.
   */
  const extraFor = typeof o.extraFor === 'function' ? o.extraFor : null;
  // The board-wide answer — what this source holds back before any investor's
  // own adjustment. It is what the board is STAMPED with, because that is the
  // honest description of the feed rather than of one row on it.
  const resolved = resolveHoldback(source, o.saved);
  const pts = resolved.points;
  if (!board || !Array.isArray(board.programs)) return board;
  // ALREADY DONE IS DONE. Without this, a caller that applied it and then passed
  // the board through a second helper would hold back 0.50.
  if (board.marginHoldback != null) return board;

  /** One program's own answer: the source's base, moved by that investor's extra. */
  const forProgram = (prog) => {
    if (!extraFor) return resolved;
    let extra = null;
    try { extra = extraFor(prog); } catch (_) { extra = null; }
    return resolveHoldback(source, o.saved, extra);
  };

  // ⛔ A HOLDBACK OF ZERO IS STILL AN ANSWER, and it is stamped. Returning the
  // board untouched here — which is what this did while 0.25 was a constant —
  // makes "the owner removed the holdback" indistinguishable from "nobody has
  // ever configured one" and from "the settings failed to load". Now that the
  // number is settable, telling those apart is the difference between a board
  // priced the way somebody decided and a board priced by an outage. The
  // `origin:'none'` case (Lender Price, which never holds back) still returns
  // untouched, because there is no decision there to record.
  // A source that holds back nothing AND has no investor carrying an extra is
  // returned untouched, byte for byte — which is what keeps the Lender Price
  // path provably unaffected by this module on every board nobody has set an
  // extra on.
  if (!pts && resolved.origin === 'none'
    && !(extraFor && board.programs.some((prog) => forProgram(prog).points))) return board;
  // ⛔ THE BOARD-WIDE FIGURE BEING ZERO DOES NOT MEAN NOTHING IS HELD BACK. With
  // a per-investor extra set, individual programs may still carry one — and the
  // first cut returned here on Lender Price and on a deliberately-removed
  // LoanNEX holdback, so an investor's own extra was silently dropped on exactly
  // the two boards somebody would set one on. Only stamp-and-return when no
  // program has an answer of its own.
  const anyOwn = extraFor && board.programs.some((prog) => forProgram(prog).points);
  if (!pts && !anyOwn) {
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

  const programs = board.programs.map((p) => {
    // ⛔ EACH PROGRAM IS PRICED ON ITS OWN INVESTOR'S ANSWER. A single board-wide
    // number here would apply one investor's extra to every other investor's
    // rows, which is the whole thing the per-investor setting exists to avoid.
    const own = forProgram(p);
    const pts = own.points;
    return {
    ...p,
    // WHAT WAS ACTUALLY TAKEN FROM THIS INVESTOR'S ROWS, on the row that carries
    // them. Stamped even when it equals the board's, so a reader never has to
    // work out whether an extra applied here by comparing two numbers.
    marginHoldback: pts,
    marginHoldbackOrigin: own.origin,
    marginHoldbackBase: own.base,
    marginHoldbackExtra: own.extraApplied ? own.extra : 0,
    marginHoldbackProblem: own.problem,
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
    // ⛔ AND THE ITEMIZED OPTIONS BESIDE THEM, OR THE BOARD AND ITS OWN DETAILS TABLE QUOTE TWO
    // DIFFERENT PRICES. A Lender Price program now carries `options` — the same rungs with the
    // vendor's whole price build attached — and the breakdown screen reads its price from THERE.
    // Shifting the ladder and not the options would leave the row saying 101.25 and the panel that
    // explains that row saying 101.5, which is worse than the empty panel it replaced.
    options: shiftOptions(p.options, pts),
    };
  });
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

/**
 * ONE OPTION'S PRICE BUILD, MOVED BY THE HOLDBACK — base AND final together.
 *
 * ⛔ WHY THE BASE MOVES TOO, and it is not a rounding nicety. The breakdown screen draws a RUNNING
 * TOTAL: base points, then every itemized adjustment added onto it, ending at the final. Shift only
 * the final and that column stops at a number the holdback's own size away from the "Final price"
 * printed under it — an unexplained gap on the one panel whose entire job is to explain the price,
 * on a figure the owner has directed must stay invisible ("baked into the rate"). Shifting the base
 * by the same amount keeps the arithmetic summing with the vendor's own LLPA lines untouched, which
 * is exactly the mechanic the compensation overlay already uses on this screen (`shiftBuild`) and
 * exactly what the owner described investors themselves doing: *"they show the base price higher"*.
 *
 * `adjustmentPoints` is DELIBERATELY NOT TOUCHED. It is the vendor's own stated LLPA total, and the
 * breakdown reconciles the itemized lines against it — moving it would report "these lines do not
 * add up" on every row, turning a hidden margin into a loud accusation against the rate sheet.
 *
 * The pre-holdback numbers ride along as `vendorPrice` / `vendorBasePoints` for the reveal, and are
 * stripped with the rest of the trail on the ordinary board (`investor-routing.stripSource`).
 */
/**
 * THE BASE HALF, ON ITS OWN, because two paths need it and only one of them needs the other half.
 *
 * A LENDER PRICE option arrives from the parser with the vendor's own final price, so `shiftOptions`
 * moves the base AND the final. A LOANNEX option explained on demand arrives with the BOARD's final
 * — already held back, since that is the number the row was quoting — and the vendor's own raw base
 * beside it, so only the base is left to move. Moving the final again there would take the holdback
 * twice. One definition of the base shift either way, or the two panels would round differently.
 */
function shiftBase(pb, pts) {
  const vendorBasePoints = nn(pb.vendorBasePoints) ? Number(pb.vendorBasePoints)
    : (nn(pb.basePoints) ? Number(pb.basePoints) : null);
  if (vendorBasePoints == null) return pb;
  const next = { ...pb, vendorBasePoints: r3(vendorBasePoints), basePoints: r3(vendorBasePoints + pts) };
  // Only when the vendor STATED one — a base price this module invented would be indistinguishable
  // from one the sheet published, and `breakdown.priceOf` already derives it when it is absent.
  if (nn(pb.basePrice)) next.basePrice = r3(100 - next.basePoints);
  return next;
}

/**
 * ONE EXPLAINED OPTION, whose FINAL price already carries the holdback, with its BASE brought into
 * step so the panel's running total still lands on that final.
 *
 * This is the LoanNEX side of the same defect the Lender Price side has: the vendor explains a
 * price with ITS OWN base and ITS OWN adjustments, and the row on the board is quoting a price we
 * have already taken our margin out of. Left alone the panel draws base → adjustments → a final
 * exactly the holdback away from where the column arrives, on the one screen whose whole job is to
 * explain the price, about a figure the owner has directed must stay invisible.
 */
function holdBackExplainedBase(option, pts) {
  if (!option || !option.priceBuild || !pts) return option;
  return { ...option, priceBuild: shiftBase(option.priceBuild, pts) };
}

function shiftOptions(options, pts) {
  if (!Array.isArray(options)) return options;
  return options.map((o) => {
    const pb = o && o.priceBuild;
    if (!pb) return o;
    const vendorPrice = nn(pb.vendorPrice) ? Number(pb.vendorPrice) : (nn(pb.price) ? Number(pb.price) : null);
    // ⛔ EVERY SHIFTED FIGURE NEEDS ITS OWN ANCHOR, OR A SECOND PASS TAKES THE HOLDBACK TWICE.
    // The price is anchored on `vendorPrice`, so it is idempotent; the POINTS were being read back
    // off the already-shifted build and shifted again — 2 → 2.25 → 2.5 — while the price beside them
    // stayed put, so one more pass over the same board would have left the panel's points and price
    // contradicting each other. They are NOT re-derived from the rounded price (`100 − price` can
    // land a thousandth off the number the parser derived from the unrounded one — the same reason
    // the ladder above shifts rather than recomputes), so they get an anchor of their own.
    //
    // HONEST NOTE, MEASURED: the LADDER's own `points` has the same shape and no anchor, so a
    // rung shifted twice would drift the same way. It cannot happen today — `applyToBoard` is
    // called exactly once per board per vendor — and giving the rung an anchor means a fourth
    // field for `investor-routing.stripHoldbackTrail` to remove, so it is written down here
    // rather than quietly widened. If a second pass ever becomes possible, fix the rung too.
    const vendorAdjPts = nn(pb.vendorAdjustedPoints) ? Number(pb.vendorAdjustedPoints)
      : (nn(pb.adjustedPoints) ? Number(pb.adjustedPoints) : null);
    const next = shiftBase({ ...pb }, pts);
    if (vendorPrice != null) {
      next.vendorPrice = r3(vendorPrice);
      next.price = r3(vendorPrice - pts);
      if (vendorAdjPts != null) { next.vendorAdjustedPoints = r3(vendorAdjPts); next.adjustedPoints = r3(vendorAdjPts + pts); }
      else next.adjustedPoints = r3(100 - next.price);
    }
    return { ...o, priceBuild: next, marginHoldback: pts };
  });
}

module.exports = {
  MARGIN_HOLDBACK_POINTS, MAX_HOLDBACK_POINTS,
  holdbackFor, resolveHoldback, applyToBoard, holdBackExplainedBase,
  _internals: { r3, shiftOptions, shiftBase },
};
