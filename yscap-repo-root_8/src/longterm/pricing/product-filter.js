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
function wantFrom(sc = {}, lpInternals = {}) {
  const s = sc || {};
  const io = s.io === true ? true : (s.io === false ? false : null);

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
  return { amortization, io, termMonths };
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
  return out;
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
  const dropped = { amortization: 0, interestOnly: 0, term: 0 };
  if (!programs) return { board, kept: 0, dropped, unclassified: 0, narrowed: false };

  const nothingAsked = !want.amortization
    && want.io !== true && want.io !== false
    && !(Array.isArray(want.termMonths) && want.termMonths.length);
  if (nothingAsked) return { board, kept: programs.length, dropped, unclassified: 0, narrowed: false };

  const keep = [];
  let unclassified = 0;
  for (const p of programs) {
    const v = programVerdict(p, want);
    if (v.unclassified) unclassified += 1;
    if (v.keep) keep.push(p);
    else if (v.failed && dropped[v.failed] !== undefined) dropped[v.failed] += 1;
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
    unclassified,
    narrowed: true,
  };
}

module.exports = { wantFrom, narrowBoard, programVerdict, _internals: { amortizationKey, wantedAmortization } };
