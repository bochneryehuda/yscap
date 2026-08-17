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

// The three credentials client.credentials() reads. Named here only to report WHICH are missing (the
// client exposes a boolean, not the gap). Keep in step with lenderprice/client.js credentials().
const LP_CRED_ENV = ['LP_USERNAME', 'LP_PASSWORD', 'LP_CLIENT_SECRET'];

/**
 * OUR leg: price a scenario off the supplied program (the sheet-under-test) + settings.
 * Returns the quote.quoteProgram result verbatim ({ eligible, ladder[], declines[] }).
 */
function buildOursLeg(program, settings, marginHoldback) {
  if (!program || typeof program !== 'object') throw new Error('buildOursLeg: no program (the sheet-under-test)');
  return function ours(scenario) {
    const arg = { scenario, program, settings: settings || {} };
    if (marginHoldback) arg.marginHoldback = marginHoldback;
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

module.exports = { buildOursLeg, buildLpLeg, readiness, _internals: { LP_CRED_ENV } };
