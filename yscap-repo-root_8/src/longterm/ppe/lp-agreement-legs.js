'use strict';
/**
 * LT PPE — the ADAPTERS that wire the two legs of the ≥200-scenario agreement harness
 * (ratesheet-agreement.js) to their real sources, kept OUT of the orchestrator so the orchestrator
 * stays pure and offline-testable. Two legs + one readiness report:
 *
 *   buildOursLeg(program, settings, marginHoldback)  → (scenario) => quote.quoteProgram(...)
 *       OUR engine pricing a scenario off the sheet-under-test (a rateSheetToProgram result).
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
const { advancedFactsFromScenario } = require('./advanced-facts');

// The three credentials client.credentials() reads. Named here only to report WHICH are missing (the
// client exposes a boolean, not the gap). Keep in step with lenderprice/client.js credentials().
const LP_CRED_ENV = ['LP_USERNAME', 'LP_PASSWORD', 'LP_CLIENT_SECRET'];

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

// Lender Price loan purpose → our engine's purpose fact. LP uses "Purchase" / "Refinance" / "Cash out".
function normPurpose(p) {
  const k = String(p == null ? '' : p).toLowerCase().replace(/[^a-z]/g, '');
  if (k.includes('cashout')) return 'cashout';
  if (k.includes('refinance') || k === 'refi') return 'refinance';
  return 'purchase';
}
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
  const dscr = num(sc.dscr);
  const units = num(sc.units);
  return {
    fico: num(sc.fico),
    ltv: ltvRatio != null ? Math.round(ltvRatio * 100000) : null,
    dscr: dscr != null ? Math.round(dscr * 1000) : null,
    loan_amount: loan,
    value,
    purpose: normPurpose(sc.purpose),
    state: sc.state || null,
    property_type: sc.propertyType || 'SingleFamily',
    units: units != null && units > 0 ? units : 1,
    // LP scenario field names: prepayMonths (number), io, escrowWaive (a legacy prepayTerm string is
    // still accepted as a fallback so a hand-built scenario is not silently mis-read).
    prepay_months: num(sc.prepayMonths) != null ? num(sc.prepayMonths) : prepayMonths(sc.prepayTerm),
    cashout_amount: num(sc.cashoutAmount) || 0,
    interest_only: !!(sc.io || sc.interestOnly),
    escrow_waiver: !!(sc.escrowWaive || sc.escrowWaiver),
    lock_days: num(sc.lock_days) || 30,
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
    borrower_type: sc.borrowerType || sc.borrower_type || 'LLC',
    subordinate_amount: num(sc.subordinateLoanAmount) != null ? num(sc.subordinateLoanAmount) : (num(sc.subordinate_amount) || 0),
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
 *   opts.marginHoldback — a resolved per-investor margin (see quote.js).
 *   opts.factsFromLp    — when true, the incoming scenario is a LENDER PRICE scenario and is converted
 *                         to engine facts via lpScenarioToFacts first (so one scenario object drives
 *                         BOTH legs of the harness). Default false: the scenario is already engine facts.
 * (Back-compat: a non-object 3rd arg is still accepted as marginHoldback.)
 */
function buildOursLeg(program, settings, opts) {
  if (!program || typeof program !== 'object') throw new Error('buildOursLeg: no program (the sheet-under-test)');
  const o = (opts && typeof opts === 'object') ? opts : { marginHoldback: opts };
  return function ours(scenario) {
    const arg = { scenario: o.factsFromLp ? lpScenarioToFacts(scenario) : scenario, program, settings: settings || {} };
    if (o.marginHoldback) arg.marginHoldback = o.marginHoldback;
    return quoteProgram(arg);
  };
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

module.exports = { buildOursLeg, buildLpLeg, readiness, lpScenarioToFacts, _internals: { LP_CRED_ENV, normPurpose, prepayMonths } };
