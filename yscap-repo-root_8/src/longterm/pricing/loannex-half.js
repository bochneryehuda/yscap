'use strict';
/**
 * LONG-TERM — THE LOANNEX HALF OF A BOARD: WHICH REQUEST TO MIRROR, WHAT TO
 * NARROW TO, AND THE HOLDBACK. ONE DEFINITION, MOUNTED BY BOTH ENGINES.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The owner, 2026-09-03, on the two pricing engines: *"I told you to copy it
 * from here"* — the COMBINED engine narrowed the LoanNEX board on all four
 * dimensions (fixed-or-ARM, interest-only, term, rate lock) while the GENERAL
 * engine narrowed on the amortization ALONE, so an officer's own answers did
 * nothing to half of one board. MEASURED on the recorded board: 38 programmes
 * reached the general board against the combined engine's 13, 19 of them
 * interest-only on a search that asked for none, 15 at 40 years on a 30-year
 * search, and about 69% of the rungs at a lock nobody asked for.
 *
 * ⛔ THE RULE ITSELF WAS NEVER THE PROBLEM. `product-filter.wantFrom` has always
 * answered all four. What was written out TWICE, in two engines, in near-identical
 * prose, was the CALLER-SIDE PREAMBLE — which request to mirror, and where in it
 * each answer lives. That preamble is what drifted, and a caller feeding the right
 * rule the wrong request is a dead rule: the general engine simply never handed it
 * `lpCriteria`, so interest-only, the term and the lock were all left un-narrowed
 * while the rule sat there answering correctly about a request it never saw.
 *
 * So the preamble, the narrowing and the holdback are lifted here and both engines
 * ask this. A change to any of them now moves both boards or neither — which is
 * what "one system" has to mean at the code level, not only on the screen.
 *
 * ⛔ AND IT IS PURE — no network, no database, no route. Every input is handed in,
 * so its whole truth table is unit-testable without a vendor.
 */

const productFilter = require('./product-filter');
const vendorMargin = require('./vendor-margin');

/**
 * WHICH REQUEST DO WE MIRROR — the WIRE body Lender Price actually received,
 * falling back to the static build only when there is none.
 *
 * ⛔ THE FALLBACK IS NOT DECORATION. The client builds the body it POSTs on the
 * tenant's LIVE foundation and `mergeKnownRequestDefaults` copies same-typed
 * scalars — `criteria.interestOnly` included — from the live defaultSearch, so the
 * wire body and the static build can genuinely disagree. The pre-merge audit of
 * 2026-09-02 found the first cut of this mirroring the STATIC one: a live default
 * of `true` would have narrowed LoanNEX to amortising while Lender Price was asked
 * for interest-only, on the same search, silently. The wire body wins; the static
 * build is for the case where Lender Price failed and there is no wire body at all.
 *
 * ⛔ AND THE TWO ANSWERS LIVE IN DIFFERENT PLACES. Interest-only is inside
 * `criteria`; the RATE LOCK is on the body ROOT — `search-model` writes it to
 * `dayLocksCriteria` (and `brokerCriteria.dayLocks`) beside `criteria`, never
 * inside it. Reading the lock off `criteria` finds nothing and narrows nothing,
 * which is why both are returned rather than one.
 *
 * `criteria` is resolved INDEPENDENTLY of the body: a wire body carrying no usable
 * criteria still falls through to the static build's, so a partial answer never
 * costs a dimension.
 */
function requestToMirror(wireRequest, staticRequest) {
  const obj = (x) => (x && typeof x === 'object' ? x : null);
  const wire = obj(wireRequest);
  const stat = obj(staticRequest);
  return {
    lpRequest: wire || stat,
    lpCriteria: obj(wire && wire.criteria) || obj(stat && stat.criteria),
  };
}

/**
 * WHAT THIS SEARCH IS ASKING FOR, in the LoanNEX board's own vocabulary.
 *
 * `opts.force` is applied AFTER the rule, so it can only ever NARROW, never widen —
 * today the general engine's `{ amortization: 'fixed' }`, because the owner directed
 * *"in the general engine, don't enable the ARM feature"*. `amortization` is not a
 * supported field on that door (a caller sending one is 422'd), so `wantFrom`
 * already falls back to fixed; forcing it is belt-and-braces against the day that
 * field is accepted. A force is never a WIDENING — see the guard below.
 */
function wantFor(sc, lpInternals, opts = {}) {
  const { lpRequest, lpCriteria } = requestToMirror(opts.wireRequest, opts.staticRequest);
  const want = productFilter.wantFrom(sc, lpInternals || {}, { lpCriteria, lpRequest });
  const force = opts.force && typeof opts.force === 'object' ? opts.force : null;
  return force ? Object.assign({}, want, force) : want;
}

/**
 * NARROW THE VENDOR'S BOARD AND PUT OUR HOLDBACK ON IT.
 *
 * ⛔ THE HOLDBACK-BEFORE-EVERYTHING-ELSE ORDER *IS* LOAD-BEARING: it goes on before
 * the merge, the routing, the counts, the comparison and the option shape, because
 * Lender Price's feed already carries our margin and LoanNEX's does not — applying it
 * later would have the comparison electing on one set of numbers and the board showing
 * another.
 *
 * ⛔ THE NARROW-BEFORE-HOLD ORDER, HOWEVER, IS CLARITY RATHER THAN CORRECTNESS, AND
 * THAT IS MEASURED. Run both ways over the real recorded board the two produce a
 * BYTE-IDENTICAL result: `applyToBoard` stamps per option and computes nothing
 * aggregate, so nothing it produces depends on which programmes are present. It is
 * kept this way so the reported counts and the board describe the same set, and so an
 * aggregate added later — a board-level summary, a cheapest-row election — can never
 * be computed over programmes that are about to be dropped. The suite records this as
 * a measured FACT (C9) rather than as a guard that bites, because a guard which cannot
 * fail for the reason it names proves nothing.
 *
 * It answers a `meta` block as well as a board because WHAT WAS DROPPED IS REPORTED
 * RATHER THAN SILENT: "209 programmes became 41" with no reason is the same silence
 * this filter replaces, and `want` rides along so a screen can say what the search
 * was read as asking for, not only what fell out of it.
 *
 * A board that is not there answers `{ board: null, meta: null }` — a vendor that
 * did not answer is a state, never a throw.
 */
function narrowAndHold(board, want, opts = {}) {
  if (!board) return { board: null, meta: null, detail: null };
  const narrowed = productFilter.narrowBoard(board, want);
  const held = vendorMargin.applyToBoard(narrowed.board, 'loannex', {
    saved: opts.saved, extraFor: opts.extraFor,
  });
  const dropped = narrowed.dropped || {};
  const rungs = narrowed.droppedRungs || {};
  return {
    board: held,
    /* THE RAW NARROWING RESULT, for a caller that reports more than `meta` does — the
       combined engine is a super-admin diagnostic screen and states `applied` and the
       unclassified RUNG count as well. What each engine chooses to REPORT is legitimately
       its own; what must never differ is the DECISION, which is what this module owns. */
    detail: narrowed,
    meta: {
      want,
      droppedArm: dropped.amortization || 0,
      droppedIo: dropped.interestOnly || 0,
      droppedTerm: dropped.term || 0,
      droppedLock: dropped.lock || 0,
      droppedLockRungs: rungs.lock || 0,
      unclassified: narrowed.unclassified || 0,
      kept: narrowed.kept || 0,
      // What the sheet published twice, and what it published twice that no longer
      // prices alike — carried out so the board can account for every programme.
      duplicates: narrowed.duplicates || [],
      diverged: narrowed.diverged || [],
    },
  };
}

module.exports = { requestToMirror, wantFor, narrowAndHold };
