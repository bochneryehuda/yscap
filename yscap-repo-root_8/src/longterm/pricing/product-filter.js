'use strict';
/**
 * LONG-TERM — NARROWING THE LOANNEX BOARD TO THE PRODUCT THE OFFICER ASKED FOR.
 *
 * ── THE OWNER'S ASK ────────────────────────────────────────────────────────
 * 2026-09-01, on a combined board answering with 209 programmes and 12,299 quotes:
 * *"find a way to filter by term: if we need interest-only / if we need fixed / if we need ARM.
 * According to the search, you need to find a way to filter this in a legit way, not by looking at
 * the words, but in a real legit way, out of Lender, out of LoanX."*
 *
 * ── WHY ONE VENDOR IS FILTERED HERE AND THE OTHER IS NOT ───────────────────
 * Lender Price takes all three as SEARCH CRITERIA and answers with the product asked for:
 * `criteria.loanType` (Fixed|ARM) + `loanTypeCriteria`, `criteria.interestOnly`, and
 * `termsCriteria` + `criteria.loanYear`. So its board arrives already narrowed and this module must
 * never touch it — re-filtering an answer the vendor already filtered can only ever remove a row
 * the vendor said belongs.
 *
 * LoanNEX takes NONE of them. Interest-only is a PRODUCT it returns rather than a question it
 * accepts (`loannex/scenario.js` says so at the field), and its search carries no amortization and
 * no term. It answers with everything it has and states what each programme IS. So the narrowing is
 * done HERE, on the vendor's own published fields, and that is what makes the two boards answer the
 * same question instead of one answering a narrower one.
 *
 * ── THE FIELDS ARE THE VENDOR'S OWN, MEASURED, NEVER PARSED OUT OF A NAME ──
 * Read off the recorded `quick-prices` answer (19 programmes, `loannex/capture/quick-prices.json`)
 * and mapped by `loannex/parse.js` at the programme:
 *   `amortizationType`  "ARM" (13) | "Fixed" (6)      — structural, two values, nothing else
 *   `isInterestOnly`    true (11) | false (8)         — a real boolean on every programme
 *   `termInMonths`      360 (13) | 480 (5) | 180 (1)  — a number, not a word
 * Nothing in this file reads a product NAME, a description or a label. That is the owner's
 * *"not by looking at the words"*, and it is why "5/6 ARM (30 Yr. Term)" never has to be understood.
 *
 * ── ⛔ A PROGRAMME IS DROPPED ONLY WHEN IT PROVABLY FAILS ──────────────────
 * A field the vendor left blank, or wrote in a spelling this module does not recognise, CANNOT
 * disqualify a programme: the answer to "does this match?" is then "unknown", and dropping on an
 * unknown hides real pricing from an officer with nothing on the screen to say so. Such a programme
 * is KEPT and COUNTED (`unclassified`), so the board can report that it could not judge it rather
 * than quietly deciding. Every measured programme states all three, so the count is 0 in practice —
 * it exists for the vendor's next release, not for today.
 *
 * PURE: no network, no database, no RTL import.
 */

/** The vendor's two amortization words → our two tokens. Anything else is unknown, never a guess. */
function amortizationKey(v) {
  if (v == null) return null;
  const k = String(v).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (k === 'fixed' || k === 'fixedrate') return 'fixed';
  if (k === 'arm' || k === 'adjustable' || k === 'adjustablerate') return 'arm';
  return null;
}

/** The caller's own choice, in the same two tokens. */
function wantedAmortization(v) {
  const k = amortizationKey(v);
  return k || null;
}

/**
 * WHAT THE SEARCH IS ACTUALLY ASKING FOR — read from the SAME scenario Lender Price was built from,
 * through the SAME two functions that built it.
 *
 * ⛔ IT MIRRORS THE REQUEST, IT DOES NOT RE-DECIDE IT. Both dimensions are resolved by the
 * `search-model` internals passed in, so the set this narrows LoanNEX to is BY CONSTRUCTION the set
 * Lender Price was asked for:
 *
 *   • AMORTIZATION falls back to Fixed when the caller states nothing, because that is not a guess
 *     — `wireDiscipline` has forced `criteria.loanType = 'Fixed'` on every DSCR search since the
 *     profile was written, so an unstated search genuinely IS a fixed-rate search and LoanNEX
 *     answering with ARMs beside it was the two boards answering two different questions.
 *
 *   • THE TERM SET comes from `resolveSearchTerms`, the ONE definition, never from `termYears`.
 *     That function owns the rule that an interest-only search ALSO covers 40 years (several
 *     investors offer an interest-only product only at 40) — a rule the screen deliberately reports
 *     rather than restates. Re-deriving it here would mean a change to that rule narrowed one
 *     vendor's board and not the other's, on the same search, silently.
 *
 * With neither function passed the dimension is simply not narrowed, which is what a caller with no
 * Lender Price request to mirror should get.
 */
function wantFrom(sc = {}, lpInternals = {}, opts = {}) {
  const s = sc || {};
  /**
   * ⛔ INTEREST-ONLY FOLLOWS THE REQUEST LENDER PRICE WAS ACTUALLY SENT, not only the scenario.
   *
   * Owner-reported 2026-09-02: *"Interest-only program still comes up even when I'm not
   * searching for interest-only… Make sure when we search for interest only, it comes up interest
   * only, and when we don't search for interest only, it doesn't come up interest only."*
   *
   * MEASURED: the screen's `toScenario` sends a yes/no button ONLY when it is on — an off switch
   * is OMITTED, not sent as `false` (that is deliberate on the Lender Price side: an omitted flag
   * inherits the tenant's own default, and the DSCR base carries `interestOnly: false`). So with
   * the switch off, Lender Price was asked for an amortising board while this read `io: null`,
   * narrowed nothing, and LoanNEX's interest-only programmes stayed on — the two boards answering
   * two different questions, which is the exact drift this module exists to prevent.
   *
   * The scenario still wins when it SAYS something; when it says nothing, the answer is what the
   * request Lender Price was ACTUALLY sent carries (`opts.lpCriteria.interestOnly` — `priceBoth`
   * hands over the criteria of the WIRE body the client returns, falling back to the static build
   * only when Lender Price failed and there is no wire body), and only with neither is the
   * dimension left un-narrowed. This is the same mirror rule amortization already follows below —
   * an unstated search resolves the way the other vendor's request resolved it, never a guess of
   * our own.
   */
  const lpc = opts && opts.lpCriteria && typeof opts.lpCriteria === 'object' ? opts.lpCriteria : null;
  const io = s.io === true ? true : (s.io === false ? false
    : (lpc && typeof lpc.interestOnly === 'boolean' ? lpc.interestOnly : null));

  let amortization = null;
  if (typeof lpInternals.mapAmortization === 'function') {
    const asked = lpInternals.mapAmortization(s.amortization);
    // `undefined` means the caller stated something unreadable — `validateInputs` has already
    // refused that scenario, so reaching here at all means it is null (nothing stated).
    amortization = asked ? amortizationKey(asked) : (asked === undefined ? null : 'fixed');
  }

  let termMonths = null;
  if (typeof lpInternals.resolveSearchTerms === 'function') {
    const years = lpInternals.resolveSearchTerms(s, Number(s.termYears) || null);
    if (Array.isArray(years) && years.length) {
      const months = years.map((y) => Math.round(Number(y) * 12)).filter((n) => Number.isFinite(n) && n > 0);
      if (months.length) termMonths = months;
    }
  }

  /**
   * ⛔ THE RATE LOCK IS THE FOURTH DIMENSION, and it is read off the REQUEST, never re-decided.
   *
   * The same class of defect as interest-only, on a dimension nobody had noticed. Lender Price
   * narrows on `dayLocksCriteria` and the officer sets a lock on EVERY search (the field defaults
   * to 30 days), so Lender Price answers at the asked lock and at no other. LoanNEX accepts no lock
   * in its search and answers at ALL of them at once — 15, 30, 45 and 60 in the same board.
   *
   * MEASURED on the recorded board: asking 15 / 30 / 45 / 60 left the LoanNEX list byte-identical
   * every time (26 programmes, 1553 rungs), and the prices are NOT the same across locks — 1661
   * rate-points carry more than one lock, mean spread 0.206 points, max 0.500, which is twice the
   * whole margin holdback. Acra's 30-year fixed at 6.25 is 101.036 at 15 days, 100.886 at 30 and
   * 100.736 at 45. So a 15-day LoanNEX rung was sitting beside a 30-day Lender Price quote looking
   * a sixth of a point better for no reason a human could see.
   *
   * WHICH REQUEST, and why the model root rather than `criteria`: `search-model` writes the lock to
   * `m.dayLocksCriteria` (and mirrors it to `brokerCriteria.dayLocks`) at the body ROOT, resolving
   * `sc.lockDays` against the DSCR profile's own 30-day default. Reading it there — rather than
   * re-deriving it from `sc.lockDays` — is what makes the set this narrows to the set Lender Price
   * was actually asked for, exactly as interest-only now does. `brokerCriteria.dayLocks` is the
   * fallback for a body that carries the one and not the other; the scenario's own `lockDays` is
   * the last resort, for a caller with no Lender Price request to mirror at all.
   *
   * With none of the three present the dimension is simply not narrowed.
   */
  const req = opts && opts.lpRequest && typeof opts.lpRequest === 'object' ? opts.lpRequest : null;
  let lockDays = null;
  if (req) {
    const list = Array.isArray(req.dayLocksCriteria) ? req.dayLocksCriteria : null;
    const fromList = list && list.length ? Number(list[0]) : null;
    const fromBroker = req.brokerCriteria && typeof req.brokerCriteria === 'object'
      ? Number(req.brokerCriteria.dayLocks) : null;
    const asked = Number.isFinite(fromList) && fromList > 0 ? fromList
      : (Number.isFinite(fromBroker) && fromBroker > 0 ? fromBroker : null);
    if (asked != null) lockDays = asked;
  }
  if (lockDays == null) {
    const own = Number(s.lockDays);
    if (Number.isFinite(own) && own > 0) lockDays = own;
  }

  return { amortization, io, termMonths, lockDays };
}

/**
 * Does ONE programme match? Answers per dimension so the board can say WHICH narrowing dropped what
 * — "209 programmes became 41" with no reason is the same silence this replaces.
 */
function programVerdict(p, want = {}) {
  const out = { keep: true, failed: null, unclassified: false };
  if (!p || typeof p !== 'object') return out;

  if (want.amortization) {
    const k = amortizationKey(p.amortizationType);
    if (k == null) out.unclassified = true;
    else if (k !== want.amortization) { out.keep = false; out.failed = 'amortization'; return out; }
  }
  if (want.io === true || want.io === false) {
    const v = p.isInterestOnly;
    if (typeof v !== 'boolean') out.unclassified = true;
    else if (v !== want.io) { out.keep = false; out.failed = 'interestOnly'; return out; }
  }
  if (Array.isArray(want.termMonths) && want.termMonths.length) {
    const n = Number(p.termInMonths);
    if (!Number.isFinite(n) || n <= 0) out.unclassified = true;
    else if (!want.termMonths.includes(n)) { out.keep = false; out.failed = 'term'; return out; }
  }
  /**
   * THE LOCK, asked of the programme as a whole: does it price at this lock AT ALL? A programme
   * that offers only 30 and 45 cannot answer a 15-day search, and keeping it would put a rung at
   * some other lock on the board — the very thing this dimension exists to stop.
   *
   * A programme carrying NO lock information anywhere is `unclassified` and KEPT, the same
   * direction the other three fail in: a board we cannot judge is not a board we silently shorten.
   */
  if (Number.isFinite(want.lockDays) && want.lockDays > 0) {
    const offered = Array.isArray(p.lockDaysOffered)
      ? p.lockDaysOffered.map(Number).filter((n) => Number.isFinite(n)) : [];
    if (!offered.length) out.unclassified = true;
    else if (!offered.includes(want.lockDays)) { out.keep = false; out.failed = 'lock'; return out; }
  }
  return out;
}

/**
 * ONE programme, with only the rungs that price at the asked lock — a NEW programme object with a
 * NEW rung array, never a mutation of the parsed board. The result's programme is under
 * `narrowed`, NOT `program`: WORD-1 forbids this module touching a `.program` / `.product` /
 * `.name` field, and it is right to — the owner's condition is that this filter reads structure
 * and never words. A key of my own that happens to collide with a vendor text field is my problem
 * to rename, not the guard's to relax.
 *
 * WHY THIS IS NOT ENOUGH TO DO AT PROGRAMME LEVEL. The other three dimensions are properties of
 * the PROGRAMME (its amortization, whether it is interest-only, its term), so keeping or dropping
 * the programme settles them. The lock is a property of the RUNG: one programme carries the same
 * rate at 15, 30, 45 and 60 days at four different prices. Keeping the programme and leaving its
 * rungs alone would leave three quarters of the board priced at a lock nobody asked for, and the
 * board's best-price figures (`maxPrice`, `minPoints`) computed off them.
 *
 * A rung with NO lock recorded is KEPT and counted unclassified — the same direction as above.
 *
 * ⛔ EVERY AGGREGATE IS RECOMPUTED the way `loannex/parse.js` computes it, for the same reason
 * `narrowBoard` recomputes the board's: a `maxPrice` left behind from the full rung list would
 * have the row advertising a price at a lock that is no longer on it.
 */
function narrowProgramRungs(p, lockDays) {
  const rungs = p && Array.isArray(p.rungs) ? p.rungs : null;
  if (!rungs || !Number.isFinite(lockDays) || lockDays <= 0) {
    return { narrowed: p, kept: rungs ? rungs.length : 0, dropped: 0, unclassified: 0 };
  }
  const keep = [];
  let unclassified = 0;
  for (const r of rungs) {
    const d = r && r.lockDays != null ? Number(r.lockDays) : null;
    if (d == null || !Number.isFinite(d)) { unclassified += 1; keep.push(r); continue; }
    if (d === lockDays) keep.push(r);
  }
  if (keep.length === rungs.length) {
    return { narrowed: p, kept: keep.length, dropped: 0, unclassified };
  }
  return {
    narrowed: {
      ...p,
      rungs: keep,
      rungCount: keep.length,
      /* The LOWEST rate among the survivors, computed rather than read off `keep[0]`. `parse.js`
         sorts rungs by rate and filtering preserves that, so the first element is the right answer
         TODAY — but this module would then be silently depending on another module's sort, and the
         cost of not depending on it is one reduce. */
      minRate: keep.reduce((m, r) => (r.rate != null && (m == null || r.rate < m) ? r.rate : m), null),
      minPoints: keep.reduce((m, r) => (r.points != null && (m == null || r.points < m) ? r.points : m), null),
      maxPrice: keep.reduce((m, r) => (r.price != null && (m == null || r.price > m) ? r.price : m), null),
      lockDaysOffered: [...new Set(keep.map((r) => r.lockDays).filter((d) => d != null))].sort((a, b) => a - b),
    },
    kept: keep.length,
    dropped: rungs.length - keep.length,
    unclassified,
  };
}

/**
 * The LoanNEX board, narrowed — a NEW board with a NEW programme array, never a mutation.
 *
 * The board is read by the merge, the routing, the counts, the option shape AND the programme rows
 * the screen draws, so narrowing it HERE, once, before any of them, is what makes every one of
 * those agree. Filtering later would leave the counts describing a board nobody sees.
 */
function narrowBoard(board, want = {}) {
  const programs = (board && Array.isArray(board.programs)) ? board.programs : null;
  const dropped = { amortization: 0, interestOnly: 0, term: 0, lock: 0 };
  // Rungs are counted separately from programmes because they are a different quantity: the lock
  // removes RUNGS from programmes that stay on the board. Reporting them in the same bucket would
  // read as "the lock dropped 3733 programmes" over a board of 90.
  const droppedRungs = { lock: 0 };
  if (!programs) {
    return { board, kept: 0, dropped, droppedRungs, unclassified: 0, unclassifiedRungs: 0, narrowed: false };
  }

  const lock = Number.isFinite(want.lockDays) && want.lockDays > 0 ? want.lockDays : null;
  const nothingAsked = !want.amortization
    && want.io !== true && want.io !== false
    && !(Array.isArray(want.termMonths) && want.termMonths.length)
    && lock == null;
  if (nothingAsked) {
    return { board, kept: programs.length, dropped, droppedRungs, unclassified: 0, unclassifiedRungs: 0, narrowed: false };
  }

  const keep = [];
  let unclassified = 0;
  let unclassifiedRungs = 0;
  for (const p of programs) {
    const v = programVerdict(p, want);
    if (v.unclassified) unclassified += 1;
    if (!v.keep) {
      if (v.failed && dropped[v.failed] !== undefined) dropped[v.failed] += 1;
      continue;
    }
    // The programme prices at this lock; now keep only the rungs that DO.
    const trimmed = narrowProgramRungs(p, lock);
    droppedRungs.lock += trimmed.dropped;
    unclassifiedRungs += trimmed.unclassified;
    /**
     * A programme whose every rung was unclassified-or-matching keeps all of them; one left with
     * NOTHING is off the board, and it is counted under `lock` because that is what removed it.
     * `programVerdict` catches almost all of these off `lockDaysOffered`; this catches the case
     * where the programme advertised the lock but carries no rung at it.
     */
    if (trimmed.kept === 0) { dropped.lock += 1; continue; }
    keep.push(trimmed.narrowed);
  }
  return {
    /**
     * ⛔ EVERY COUNT THE BOARD CARRIES IS RECOMPUTED, in the SAME way `loannex/parse.js` computes
     * them. Narrowing the programme list and leaving `lenderCount` / `rungCount` behind would leave
     * the board describing a set nobody is looking at — the header would say 209 programmes over a
     * list of 41, which is the exact complaint this narrowing answers.
     */
    board: {
      ...board,
      programs: keep,
      programCount: keep.length,
      lenderCount: new Set(keep.map((p) => p && p.lender)).size,
      rungCount: keep.reduce((n, p) => n + (Number(p && p.rungCount) || 0), 0),
    },
    kept: keep.length,
    dropped,
    droppedRungs,
    unclassified,
    unclassifiedRungs,
    narrowed: true,
  };
}

module.exports = { wantFrom, narrowBoard, programVerdict, _internals: { amortizationKey, wantedAmortization, narrowProgramRungs } };
