'use strict';
/**
 * LT PPE — the ADAPTERS that wire the two legs of the ≥200-scenario agreement harness
 * (ratesheet-agreement.js) to their real sources, kept OUT of the orchestrator so the orchestrator
 * stays pure and offline-testable. Two legs + one readiness report:
 *
 *   buildOursLeg(program, settings, marginHoldback)  → (scenario) => quote.quoteProgram(...)
 *       OUR engine pricing a scenario off the sheet-under-test (a rateSheetToProgram result). The
 *       returned function carries `.program` — the sheet it prices from — because the harness's
 *       per-layer disqualifier reconciliation reads a decline's dimension from the RULE that produced
 *       it, and a quote result names its program only as a reference. See the note on the stamp.
 *
 *   buildLpLeg(client, opts)                          → async (scenario) => { full, disqualified }
 *       Lender Price's answer for the same scenario, in the shape lp-normalize-full consumes. `client`
 *       is src/longterm/lenderprice/client — but it is INJECTED, so this module is testable with a stub
 *       and never touches the network itself. A live LP failure THROWS (the orchestrator turns a throw
 *       into an engine_error on that scenario and the batch survives — one timeout never loses the run).
 *
 *   readiness(client, env)                            → { configured, missing[], message }
 *       The honest blocker report: the live run cannot start without the Lender Price login, so this
 *       names exactly which of the three credentials are absent rather than failing obscurely later.
 *
 * The sheet-under-test itself (the Deephaven grid → rateSheetToProgram → program) is DELIBERATELY not
 * built here: the owner's HARD RULE (2026-08-17) is that a rate sheet is agreed with Lender Price on
 * ≥200 scenarios BEFORE it is trusted, so the program is supplied to buildOursLeg by the caller and
 * this module only PLUMBS it. LT-only. No RTL imports.
 */
const { quoteProgram } = require('./quote');
const lpNormalize = require('./lp-normalize');
const { advancedFactsFromScenario } = require('./advanced-facts');
// ZIP → state derivation (committed offline table; PURE, no network). Needed so a realistic zip-only
// scenario carries a state for the state-keyed Layer-2/Layer-3 rules (e.g. NJ PPP): measured live
// 2026-08-17, LP declines an NJ individual PPP that our engine allowed ONLY because `state` was never
// derived from the ZIP here. A caller-supplied state is an assertion and always wins.
const { lookupZip } = require('../lenderprice/zip-county');
const { normalizePurpose } = require('./purpose');

// The three credentials client.credentials() reads. Named here only to report WHICH are missing (the
// client exposes a boolean, not the gap). Keep in step with lenderprice/client.js credentials().
const LP_CRED_ENV = ['LP_USERNAME', 'LP_PASSWORD', 'LP_CLIENT_SECRET'];

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

// Lender Price loan purpose → our engine's purpose fact, through the ONE canonical normalizer.
//
// §2.84 — this used to end `return 'purchase';`, so null, undefined, '', a number, and every typo
// became a PURCHASE. It also over-caught: `'Limited Cash Out'` and `'No Cash-Out Refinance'` are the
// industry's names for a RATE/TERM refinance, and `k.includes('cashout')` read both as cash-out.
// Both directions are silent mispricing, and both are the reason `mapPurpose` on the vendor door was
// made to refuse rather than default. Now an unknown purpose is `null` — which the engine reads as an
// unknown price-bearing fact and declines to price, instead of quoting a loan it misread.
function normPurpose(p) { return normalizePurpose(p); }
// "60 Months" / "No Prepay" → a number of months (0 = no prepay). Unreadable → null.
function prepayMonths(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (/no\s*prepay|none/.test(s)) return 0;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * A Lender Price SCENARIO (value/loan/fico/dscr/purpose/state/… — the client.price shape) → OUR engine's
 * pricing FACTS, in the SCALES the rate-sheet grid already uses (deephaven-grid.js): fico RAW, ltv
 * MILLI-PERCENT (ratio × 100000, so 0.75 → 75000), dscr MILLI (× 1000, so 1.25 → 1250), dollars raw.
 * The long-tail facts (state / purpose / property_type / units / prepay_months / cashout_amount /
 * interest_only / escrow_waiver / lock_days) are named so the grid's predicate rules can read them; the
 * grid must emit its band bounds + predicates in this SAME vocabulary (they are built together). ltv is
 * DERIVED from loan/value when not supplied, exactly as the LP validator derives it. PURE.
 */
function lpScenarioToFacts(s) {
  const sc = s || {};
  const value = num(sc.value);
  const loan = num(sc.loan);
  let ltvRatio = num(sc.ltv);
  if (ltvRatio != null && ltvRatio > 1) ltvRatio = ltvRatio / 100; // accept a percentage
  if (ltvRatio == null && value != null && value > 0 && loan != null) ltvRatio = loan / value;
  // Subordinate financing (one definition, reused by cltv below and subordinate_amount).
  const subAmt = num(sc.subordinateLoanAmount) != null ? num(sc.subordinateLoanAmount)
    : (num(sc.subordinate_amount) || 0);
  // COMBINED loan-to-value: (first lien + any recorded subordinate) / value, in the SAME milli-percent
  // units as ltv (80% → 80000). Accept an explicit sc.cltv (ratio or percent) first; otherwise DERIVE
  // it. Needed so a CapAdjustment / "CLTV exceeded" disqualifier the crosswalk maps to fact `cltv` can
  // actually be evaluated end to end — without a cltv fact the predicate reads an absent key and
  // rules._evalLeaf fails SAFE to false, so the rule never declines (a silent dead map that fails to
  // replicate the LP CLTV decline). With no subordinate, cltv == ltv, which is correct.
  let cltvRatio = num(sc.cltv);
  if (cltvRatio != null && cltvRatio > 1) cltvRatio = cltvRatio / 100; // accept a percentage
  if (cltvRatio == null && value != null && value > 0 && loan != null) cltvRatio = (loan + subAmt) / value;
  const dscr = num(sc.dscr);
  const units = num(sc.units);
  return {
    fico: num(sc.fico),
    ltv: ltvRatio != null ? Math.round(ltvRatio * 100000) : null,
    cltv: cltvRatio != null ? Math.round(cltvRatio * 100000) : null,
    dscr: dscr != null ? Math.round(dscr * 1000) : null,
    loan_amount: loan,
    value,
    purpose: normPurpose(sc.purpose),
    // A caller-supplied state is authoritative; otherwise DERIVE it from the ZIP (offline table), so a
    // zip-only scenario still carries a state for the state-keyed matrix/PPP rules. null when neither.
    state: sc.state || (sc.zip != null ? (lookupZip(sc.zip) || {}).state : null) || null,
    property_type: sc.propertyType || 'SingleFamily',
    units: units != null && units > 0 ? units : 1,
    // LP scenario field names: prepayMonths (number), io, escrowWaive (a legacy prepayTerm string is
    // still accepted as a fallback so a hand-built scenario is not silently mis-read).
    prepay_months: num(sc.prepayMonths) != null ? num(sc.prepayMonths) : prepayMonths(sc.prepayTerm),
    cashout_amount: num(sc.cashoutAmount) || 0,
    interest_only: !!(sc.io || sc.interestOnly),
    escrow_waiver: !!(sc.escrowWaive || sc.escrowWaiver),
    // non-warrantable (condo/project) — the LP `nonWarrantable` flag. Feeds the Deephaven
    // `Other - Non-Warrantable` add-on LLPA (measured live 2026-08-17), which REPLACES the plain Condo
    // line on a non-warrantable condo (the condo add-on is gated `non_warrantable != true`).
    non_warrantable: !!(sc.nonWarrantable || sc.non_warrantable || sc.nonWarrantableProject),
    // A STATED LOCK NOW REACHES THE ENGINE — as the PRICING key, never as the rung key.
    //
    // The LP scenario names the lock `lockDays`, and nothing here read it: a scenario asking Lender
    // Price for a 45-day lock was priced HERE as the 30-day default, so the two legs answered about two
    // different loans. Same class as the short-term-rental miss (§2.14) — a fact transmitted to the
    // vendor that our own engine never sees.
    //
    // THE OBVIOUS FIX IS WRONG, AND `deephaven-dscr-prepay-maxprice` says so in its own header: the two
    // facts are deliberately distinct. `lock_days` is the RUNG-SELECTION key — `quote.selectRungs`
    // filters the base ladder by it, and the sheet publishes ONE ladder, at 30 days — while
    // `lock_term_days` is what the 45/60-day adjustment prices on. Setting `lock_days: 45` therefore
    // matches no rung at all and yields `eligible: true` with an EMPTY ladder: a priced loan with no
    // price, which is a worse silent failure than the one being fixed. So the ladder key stays at its
    // default and the requested period rides on its own fact, exactly as that sheet's own `lockTermFacts`
    // emits the pair. This also makes `dhvn_lock_45` / `dhvn_lock_60` reachable — measured as never
    // firing precisely because nothing ever emitted the fact they key on.
    lock_days: num(sc.lock_days) != null ? num(sc.lock_days) : 30,
    lock_term_days: num(sc.lockDays) != null ? num(sc.lockDays)
      : (num(sc.lock_term_days) != null ? num(sc.lock_term_days) : 30),
    // Layer-2/Layer-3 facts the pricer carries but this converter used to DROP, so a live LP scenario
    // could never trip the subordinate-not-allowed rule (deephaven-matrix reads f.subordinate_amount)
    // nor the borrower-type-dependent PPP rules (deephaven-ppp-matrix reads borrower_type — e.g. NJ
    // natural-person → PPP prohibited). Both are ordinary scenario inputs (SUPPORTED_FIELDS
    // subordinateLoanAmount / borrowerType). A missing subordinate amount is 0 so the not-allowed rule
    // stays silent unless a real second exists.
    //
    // BORROWER TYPE DEFAULTS TO LLC (owner-directed 2026-08-17): "our default should be borrower_type
    // LLC entity, so the New Jersey individual will not be hurt by default … this was the previous
    // default rule … you can only change this borrower type if you go into Advanced." So an OMITTED
    // borrower type is the DSCR profile's entity default (LLC) — matching the LP request's own
    // GLOBAL_BorrowerType='LLC' — and a NJ loan therefore CARRIES a prepay penalty by default (an LLC
    // is allowed one); only an Advanced switch to an individual/natural-person triggers the NJ/IL
    // natural-person prohibition. It is NEVER left null (which would fail-open on a wildcard and also
    // skip the NJ rule) — the default is a concrete, owner-set LLC.
    // THE ASSUMPTION AND THE ASSERTION ARE KEPT APART IN THE DATA (defect A8.5, 2026-08-18). Before,
    // the default collapsed into `borrower_type` and an ASSUMED LLC was byte-identical to an LLC the
    // scenario actually stated — so a guess travelled downstream as a fact and the PPP answer for a
    // New Jersey loan (where the borrower type decides whether a prepayment penalty is legal at all)
    // could not say which one it had used. `borrower_type` keeps its old EFFECTIVE meaning so nothing
    // reading it changes; the two new facts say where that value came from.
    borrower_type: sc.borrowerType || sc.borrower_type || 'LLC',
    borrower_type_stated: sc.borrowerType || sc.borrower_type || null,
    borrower_type_assumed: !(sc.borrowerType || sc.borrower_type),
    subordinate_amount: subAmt,
    // APR (Layer-3 PPP) — ONE state PPP rule keys on a HIGH-cost APR: ILLINOIS (the
    // natural-person `aprGt` rule in deephaven-ppp-matrix). APR is a DERIVED figure (note rate + fees),
    // so this is a PURE PASS-THROUGH: emit it only when a scenario explicitly supplies one, and leave
    // it null otherwise. The PPP matrix FAILS OPEN on a null apr (an `aprGt` rule requires isNum(apr)),
    // so an ordinary scenario without an apr is unchanged — only a scenario that actually carries a
    // high APR can now trip the natural-person high-cost prohibition end-to-end. No value is invented.
    apr: num(sc.apr),
    // The ADVANCED overlay facts (D27–D29), registry-driven so the Advanced section, the fact
    // converter, and the overlay all read one list: occupancy (leased/vacant), rural_property,
    // short_term_rental, first_time_investor, first_time_homebuyer, foreign_national, declining_market,
    // renovation. Lender Price does NOT price on these — they are the OVERLAY-ONLY class our matrix can
    // override LP on, with a reason. Booleans default false, occupancy defaults 'leased'. Enforcement
    // of each specific cut is gated on confirming it from the matrix / LP live (D36); this carries them.
    ...advancedFactsFromScenario(sc),
  };
}

/**
 * OUR leg: price a scenario off the supplied program (the sheet-under-test) + settings.
 * Returns the quote.quoteProgram result verbatim ({ eligible, ladder[], declines[] }).
 *   opts.marginHoldback — a resolved per-investor margin (see quote.js), OR a FUNCTION of the
 *                         engine facts returning one. A function is what a real caller passes:
 *                         the investor's margin/holdback layer is read ONCE at the seam where the
 *                         program is loaded, and its per-scenario rules must still evaluate against
 *                         THIS scenario's facts — a single frozen object would apply one scenario's
 *                         rule verdict to all 299 in the battery. A function returning null (nothing
 *                         configured) leaves the quote byte-identical, exactly like passing nothing.
 *                         It is handed the ENGINE facts, after the LP conversion, so a margin rule
 *                         reads the same fact names every other rule in the engine reads.
 *   opts.factsFromLp    — when true, the incoming scenario is a LENDER PRICE scenario and is converted
 *                         to engine facts via lpScenarioToFacts first (so one scenario object drives
 *                         BOTH legs of the harness). Default false: the scenario is already engine facts.
 * (Back-compat: a non-object 3rd arg is still accepted as marginHoldback.)
 */
/**
 * A PPP prohibition turned into a decline on the quote, in exactly the shape `quoteProgram` produces for
 * its own eligibility rules — `{ eligible:false, ladder:[], declines:[{code, reason, source}] }` — so
 * every consumer downstream (the harness's `ourEligible`, the reconciler, the summary) reads it the same
 * way it reads a base decline. The `source` is `ppp_matrix` rather than `base`, which is what makes the
 * new layer visible in a report instead of masquerading as a sheet rule.
 *
 * Never mutates the quote: the caller's object may be shared, and a verdict that changed under a reader
 * is a debugging nightmare in a batch of 299.
 */
function declineForPpp(quote, dq) {
  const prior = Array.isArray(quote && quote.declines) ? quote.declines : [];
  return {
    ...quote,
    eligible: false,
    ladder: [],
    declines: [...prior, {
      code: dq.code,
      reason: dq.declineReason,
      dimension: dq.dimension,
      citation: dq.citation,
      source: 'ppp_matrix',
    }],
  };
}

/**
 * The "we could not tell" marker, in the same shape a decline carries so a report can render it beside
 * one — but with `unresolved: true` and NO `reason` masquerading as a decline reason. Never mutates the
 * quote (see `declineForPpp`). The quote stays PRICED; what says so is `pppUnresolved`, which a reader
 * must look at. `eligible` alone is no longer the whole answer on the PPP dimension.
 */
function flagUnresolvedPpp(quote, unres) {
  return { ...quote, pppUnresolved: { ...unres, source: 'ppp_matrix' } };
}

/** The same fact treated as a decline, for a caller whose policy is to refuse an unanswerable state. */
function declineForUnresolvedPpp(quote, unres) {
  const prior = Array.isArray(quote && quote.declines) ? quote.declines : [];
  return {
    ...quote,
    eligible: false,
    ladder: [],
    pppUnresolved: { ...unres, source: 'ppp_matrix' },
    declines: [...prior, {
      code: unres.code,
      reason: unres.reason,
      dimension: unres.dimension,
      citation: unres.citation,
      source: 'ppp_matrix',
      unresolved: true,
    }],
  };
}

/** The policies a caller may declare for an unanswerable state. There is deliberately no default. */
const UNRESOLVED_PPP_POLICIES = Object.freeze(['flag', 'decline']);

/**
 * OUR leg for the agreement harness.
 *
 * `opts.pppDescriptor` — an investor PROGRAM DESCRIPTOR (`program-registry.programFor(...)`) whose
 * prepayment-penalty layer should be asked about every scenario ALONGSIDE the sheet's own rules.
 *
 * WHY THIS IS NEEDED AT ALL. The harness prices a SHEET; the state prepayment-penalty law lives in an
 * investor PROGRAM (Layer 3, `deephaven-ppp-matrix`), and the two are different objects with different
 * shapes. So this leg has always answered with `quoteProgram` alone, and the PPP layer was never asked —
 * measured: the canonical battery's own scenario flagged INELIGIBLE for "NJ Individual PPP prohibited"
 * came back from this leg PRICED, while `pppDisqualifier` on the identical facts returned
 * `dhvn_ppp_prohibited_nj`. That is the dangerous direction — we quote a loan the investor will not buy —
 * and the gate was structurally blind to it, because the sheet carries no borrower-type rule at all.
 *
 * PPP ONLY, DELIBERATELY. The descriptor also carries a Layer-2 ELIGIBILITY matrix, and folding that in
 * here would silently answer an OPEN OWNER QUESTION: the rate sheet prices cells the matrix refuses, and
 * which one governs is the owner's call, not this function's (§2.10, task #81). PPP is a different case —
 * the sheet is SILENT on it, so asking the matrix fills a silence rather than overriding a price.
 *
 * OPT-IN. With no descriptor the leg is byte-identical to before, so no existing caller's gate moves
 * without being asked. A descriptor that cannot answer is rejected HERE, at wiring time, rather than
 * being ignored once per scenario — a silently-dropped descriptor would be exactly the defect this fixes.
 */
function buildOursLeg(program, settings, opts) {
  if (!program || typeof program !== 'object') throw new Error('buildOursLeg: no program (the sheet-under-test)');
  const o = (opts && typeof opts === 'object') ? opts : { marginHoldback: opts };
  const desc = o.pppDescriptor || null;
  if (desc && (typeof desc.pppInputFromFacts !== 'function' || typeof desc.pppDisqualifier !== 'function')) {
    throw new Error('buildOursLeg: pppDescriptor must expose pppInputFromFacts() and pppDisqualifier()');
  }
  // A PPP LAYER THAT CANNOT SAY "WE COULD NOT TELL" IS REFUSED HERE (defect A8.1). Same reasoning as
  // the descriptor check above it: a layer that is silently missing the third answer would price every
  // unanswerable state as allowed, once per scenario, saying so nowhere.
  if (desc && typeof desc.pppUnresolved !== 'function') {
    throw new Error('buildOursLeg: pppDescriptor must expose pppUnresolved() — an unanswerable state may not read as allowed');
  }
  // AND THE CALLER MUST DECLARE WHAT TO DO ABOUT IT. There is no default on purpose: 'flag' (price it,
  // mark it for a human) and 'decline' (refuse the quote) are the two sides of an OPEN OWNER QUESTION
  // (LENDER-PRICE-PARITY-STATUS.md §2.54), so this module refuses to pick one on the owner's behalf.
  const unresolvedPolicy = o.onUnresolvedPpp;
  if (desc && !UNRESOLVED_PPP_POLICIES.includes(unresolvedPolicy)) {
    throw new Error(`buildOursLeg: opts.onUnresolvedPpp must be one of ${UNRESOLVED_PPP_POLICIES.join(' | ')} when a pppDescriptor is supplied — an unresolved state prepayment rule may not be silently treated as allowed`);
  }
  const ours = function ours(scenario) {
    const facts = o.factsFromLp ? lpScenarioToFacts(scenario) : scenario;
    const arg = { scenario: facts, program, settings: settings || {} };
    const mh = typeof o.marginHoldback === 'function' ? o.marginHoldback(facts) : o.marginHoldback;
    if (mh) arg.marginHoldback = mh;
    const quote = quoteProgram(arg);
    if (!desc) return quote;
    // A quote the sheet ALREADY declined stays as it is: it is ineligible either way, and appending a
    // second reason would double-count the scenario in the by-dimension tallies.
    if (!quote || quote.eligible !== true) return quote;
    const pppInput = desc.pppInputFromFacts(facts);
    const dq = desc.pppDisqualifier(pppInput);
    if (dq) return declineForPpp(quote, dq);
    const unres = desc.pppUnresolved(pppInput);
    if (!unres) return quote;
    return unresolvedPolicy === 'decline' ? declineForUnresolvedPpp(quote, unres) : flagUnresolvedPpp(quote, unres);
  };
  // THE LEG CARRIES THE SHEET IT PRICES FROM, and that is the whole point of stamping it here.
  //
  // A quote result names its program only as a REFERENCE (`{code,name,investorCode}` — quote.js), which
  // is enough to label a row and not enough to read a decline's DIMENSION: that comes from the RULE
  // that produced the decline, never from the reason text (agreement-dimensions.dimensionOfRule). So
  // the agreement harness's per-layer disqualifier reconciliation needs the program itself, and the
  // only place it exists at that moment is inside this closure.
  //
  // Stamping it is what keeps ONE source for one fact. The alternative is for every caller to hand the
  // orchestrator the same program a second time in its opts — and the day one caller passes a
  // different one, the run reconciles declines against a sheet it did not price with, and says so
  // nowhere. `runOne` still honours an explicit `opts.program` first, for a caller (every offline test)
  // that builds its own `ours` function and has no leg to stamp.
  ours.program = program;
  return ours;
}

/**
 * LENDER PRICE leg: for a scenario, get the FULL pricing result and (optionally) the disqualify tree,
 * parsed into the shapes lp-normalize-full.normalizeLpFull / normalizeLpDisqualified consume.
 *   client — { price(scenario), priceDisqualified(scenario,opts), parseFull(raw), parseDisqualified(raw) }
 *   opts   — { withDisqualify=true, disqMaxWaitMs } — the disqualify poll is what proves an INELIGIBLE
 *            scenario returns a matching disqualifier (the owner's explicit requirement); it can be
 *            switched off for a rungs-only pass.
 * Throws on a hard LP failure so the orchestrator records it as an engine_error for THAT scenario.
 */
function buildLpLeg(client, opts = {}) {
  if (!client || typeof client.price !== 'function' || typeof client.parseFull !== 'function') {
    throw new Error('buildLpLeg: client must expose price() and parseFull()');
  }
  const withDisqualify = opts.withDisqualify !== false;
  return async function lp(scenario) {
    const pr = await client.price(scenario);
    if (!pr || !pr.ok) {
      throw new Error(`LP price failed: ${(pr && (pr.message || pr.error)) || 'unknown'}`);
    }
    const full = client.parseFull(pr.raw);

    let disqualified = { ready: false, lenders: [] };
    if (withDisqualify && typeof client.priceDisqualified === 'function' && typeof client.parseDisqualified === 'function') {
      const dq = await client.priceDisqualified(scenario, { maxWaitMs: opts.disqMaxWaitMs });
      // A disqualify TIMEOUT (ready:false) is NOT a hard failure — LP computes it asynchronously over a
      // few minutes. We still parse whatever tree came back; an unready poll simply yields no declines.
      if (dq && dq.ok) disqualified = client.parseDisqualified(dq.disqualified || dq.qualified) || disqualified;
    }
    return { full, disqualified };
  };
}

/**
 * THE CANARY / SHADOW leg: a scenario -> the canonical LADDER `parity.compareScenario` reads
 * (`{ eligible, rungs:[{rate, priceMilli}] }`).
 *
 * WHY THIS EXISTS — the defect it closes. The canary battery (`routes/ppe.js runBattery`) wired its
 * Lender Price leg as `theirs: (sc) => lp.price(sc)`, which is the RAW VENDOR ENVELOPE
 * (`{ ok, raw, request, searchKey, provenance }`) and not a ladder at all. An envelope carries no
 * `eligible` flag and no rungs, so `parity.isComparable` correctly read it as "this engine produced no
 * result" and EVERY scenario came back `incomparable`. Measured on the canonical 299-scenario battery
 * (`agreement-scenarios.buildAgreementScenarios`) before the fix: 299 incomparable, 0 comparable,
 * `agreementRate` NULL — and the run was still persisted and the endpoint still answered 200. A canary
 * that compared nothing reported like a canary that ran. It read as correct because `lp.price` is a
 * scenario-taking async function returning an object, which is exactly what the leg's signature asks
 * for. `buildLpLeg` above already did the same three-step chain for the agreement harness's RICH
 * comparison; this is that chain for the SHALLOW ladder one, so neither leg is hand-wired at a route.
 *
 * A SCOPE IS REQUIRED, and it is refused here rather than defaulted. Lender Price answers one request
 * with EVERY program it sells (17 on the live Deephaven capture) while our engine prices ONE, so an
 * unscoped ladder is a merge of somebody else's product catalogue — a comparison that cannot mean
 * anything, reported as if it did. `lp-scope.js` is the vocabulary and `lp-normalize` does the
 * matching; nothing here invents a program name.
 *
 * FAIL CLOSED, AND SAY WHICH STEP FAILED. `client.price` reports a refusal IN BAND
 * (`{ ok:false, reason }` — a bad scenario, a vendor 500, an open circuit breaker) rather than
 * throwing. That is NOT an answer and must never be scored as one, so this THROWS with the vendor's
 * own reason: `shadow.runOne` turns it into an `engine_error` finding on the `theirs` side carrying
 * that reason, so the reason reaches the ledger and the scenario is never counted as agreement. A raw
 * that parses to ZERO matched programs is a different thing entirely — that IS Lender Price's answer
 * ("nothing in scope prices this deal") — so it normalizes to `{ eligible:false }` and is compared.
 *
 * `client` is INJECTED, like `buildLpLeg`'s, so this is offline-testable and never reaches a network.
 */
function buildCanaryLpLeg(client, opts = {}) {
  if (!client || typeof client.price !== 'function' || typeof client.parse !== 'function') {
    throw new Error('buildCanaryLpLeg: client must expose price() and parse()');
  }
  const scope = opts.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Object.keys(scope).length) {
    throw new Error('buildCanaryLpLeg: a Lender Price scope is required — an unscoped ladder merges every program Lender Price returned, which our single-program ladder cannot be compared against');
  }
  const filter = { ...scope };
  if (opts.rateScale != null) filter.rateScale = opts.rateScale;
  if (opts.priceScale != null) filter.priceScale = opts.priceScale;
  return async function theirs(scenario) {
    const pr = await client.price(scenario);
    if (!pr || pr.ok !== true) {
      const why = (pr && (pr.message || pr.error || pr.reason)) || 'unknown';
      throw new Error(`LP price failed: ${why}`);
    }
    if (pr.raw == null) throw new Error('LP price answered ok with no search body to parse');
    let parsed;
    try { parsed = client.parse(pr.raw); } catch (e) {
      throw new Error(`LP capture could not be parsed: ${String((e && e.message) || e).slice(0, 160)}`);
    }
    return lpNormalize.normalizeLpParsed(parsed, filter);
  };
}

/**
 * The readiness / blocker report for the live run. `configured` is client.configured(); `missing` names
 * the absent credentials so the operator sees exactly what to set. `env` is injected for testability.
 */
function readiness(client, env) {
  const e = env || process.env;
  const configured = !!(client && typeof client.configured === 'function' && client.configured());
  const missing = LP_CRED_ENV.filter((k) => !e[k]);
  const message = configured
    ? 'Lender Price login present — the live agreement run can start.'
    : `Lender Price login is NOT present in this environment (${missing.join(', ') || 'unknown'} unset). `
      + 'Set the three credentials as environment variables, then re-run — nothing else is needed.';
  return { configured, missing, message };
}

module.exports = {
  buildOursLeg, buildLpLeg, buildCanaryLpLeg, readiness, lpScenarioToFacts, UNRESOLVED_PPP_POLICIES,
  _internals: { LP_CRED_ENV, normPurpose, prepayMonths, declineForPpp, flagUnresolvedPpp, declineForUnresolvedPpp },
};
