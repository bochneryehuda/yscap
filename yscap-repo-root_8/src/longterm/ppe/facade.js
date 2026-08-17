'use strict';
/**
 * LT PPE — the pricing FAÇADE (§9.2): the "runs together, Lender Price wins" model. PURE
 * orchestration; ALL IO is injected (LP call, our engine, finding persistence, per-investor mode), so
 * it is offline-testable and the route wires the real ones.
 *
 * SHADOW mode (the default, long-lived state, §11.1): both engines run, LENDER PRICE IS THE BUSINESS
 * ANSWER, our engine runs beside it, and every disagreement is compared and recorded. LIVE mode: our
 * engine is authoritative and LP is not called (or only as a canary spot-check, configurable).
 *
 * TWO GUARANTEES from §9.2 / §10.6, both encoded here:
 *   1. The response is NEVER blocked waiting on the shadow comparison to be STORED — the compare is
 *      fast/inline, the persist is fire-and-forget and can never throw into the caller.
 *   2. A shadow failure NEVER breaks the business answer — if OUR engine throws in shadow mode, LP's
 *      answer still returns and an engine_error finding is recorded. Only LP failing (when LP is the
 *      authoritative side) propagates.
 *
 * LT-only. No RTL imports.
 */

const parity = require('./parity');
const lpNormalize = require('./lp-normalize');
const finding = require('./finding');

// Fire-and-forget: run fn, swallow any rejection/throw so the business response is never affected.
function detach(fn) {
  try {
    const p = fn();
    if (p && typeof p.then === 'function') p.then(() => {}, () => {});
  } catch (_) { /* a shadow persist must never surface to the caller */ }
}

/**
 * Price one scenario for one investor/program with the shadow model.
 *   req:  { scenario, investor, program }
 *   deps:
 *     mode(investor)        -> 'shadow' | 'live'  (default 'shadow')
 *     priceLp(scenario)     -> parsed LP result (lp.parse shape). Required in shadow mode and for a
 *                              live canary; its failure in shadow mode propagates (LP is the answer).
 *     ourQuote(scenario)    -> our quote.js result. Required.
 *     recordFinding(records)-> persist; fire-and-forget, may be async, never awaited.
 *     nowMs                 -> injected clock for finding timestamps.
 *   opts: { priceToleranceMilli, rateToleranceMilli, canary=false }
 *
 * Returns (shadow): { mode:'shadow', authoritative:'lp', answer:<parsed LP>, shadow:{ agreed, findings } }
 *         (live):   { mode:'live', authoritative:'ours', answer:<our quote>, shadow:<canary>|null }
 */
async function priceWithShadow(req = {}, deps = {}, opts = {}) {
  const scenario = req.scenario || {};
  const investor = req.investor || null;
  const program = req.program || null;
  const mode = (typeof deps.mode === 'function' ? deps.mode(investor) : deps.mode) || 'shadow';
  const cmpOpts = { priceToleranceMilli: opts.priceToleranceMilli, rateToleranceMilli: opts.rateToleranceMilli };
  const scenarioLabel = scenario._label || parityLabel(scenario);

  if (mode === 'live') {
    const answer = await deps.ourQuote(scenario); // authoritative; its failure IS the business failure
    let canary = null;
    if (opts.canary && typeof deps.priceLp === 'function') {
      let parsedLp;
      try { parsedLp = await deps.priceLp(scenario); } catch (_) { parsedLp = undefined; } // a canary LP failure never breaks the live answer
      if (parsedLp !== undefined) {
        canary = await compareSafely(answer, scenario, deps, program, cmpOpts, { investor, scenarioLabel, nowMs: deps.nowMs, parsedLp });
      }
    }
    return { mode: 'live', authoritative: 'ours', answer, shadow: canary };
  }

  // shadow: LP is the business answer and is required.
  const parsed = await deps.priceLp(scenario); // propagate on failure — LP is authoritative here
  const shadow = await compareSafely(null, scenario, deps, program, cmpOpts, { investor, scenarioLabel, nowMs: deps.nowMs, parsedLp: parsed, ourFromDeps: true });
  return { mode: 'shadow', authoritative: 'lp', answer: parsed, shadow };
}

// Runs our engine + normalizes both sides + compares + fires the finding persist. NEVER throws:
// an our-engine failure becomes an engine_error finding and { agreed:false }.
async function compareSafely(ourAnswerMaybe, scenario, deps, program, cmpOpts, ctx) {
  let ourQuote = ourAnswerMaybe;
  let ourErr = null;
  if (ctx.ourFromDeps || ourQuote == null) {
    try { ourQuote = await deps.ourQuote(scenario); } catch (e) { ourErr = e; }
  }

  let cmp;
  if (ourErr) {
    cmp = { agree: false, findings: [{ kind: 'engine_error', side: 'ours', detail: `our engine threw: ${String(ourErr && ourErr.message || ourErr).slice(0, 200)}`, scenario: ctx.scenarioLabel }] };
  } else {
    const oursLadder = parity.normalizeOurQuote(ourQuote);
    const theirsLadder = ctx.parsedLp !== undefined
      ? lpNormalize.normalizeLpParsed(ctx.parsedLp, { program })
      : parity.normalizeLadder(null);
    // Thread our raw declines to the comparator so an our-ineligible / LP-eligible divergence resting
    // entirely on reasoned overlay-only facts is typed as OVERLAY (an intentional override), not a
    // defect (D29). normalizeOurQuote drops declines[], so they must be passed alongside the ladder.
    const ourDeclines = Array.isArray(ourQuote && ourQuote.declines) ? ourQuote.declines : undefined;
    cmp = parity.compareScenario(oursLadder, theirsLadder, { ...cmpOpts, scenario: ctx.scenarioLabel, ourDeclines });
  }

  if (!cmp.agree && typeof deps.recordFinding === 'function') {
    const records = finding.recordsFromComparison(cmp, {
      scenario, scenarioLabel: ctx.scenarioLabel, investor: ctx.investor, program, nowMs: ctx.nowMs,
    });
    detach(() => deps.recordFinding(records));
  }
  return { agreed: cmp.agree, findings: cmp.findings };
}

function parityLabel(scenario) {
  // reuse scenario-matrix's describe via parity? keep a tiny inline to avoid a cycle
  if (!scenario || typeof scenario !== 'object') return String(scenario == null ? '' : scenario);
  return Object.keys(scenario).filter((k) => k[0] !== '_').map((k) => `${k}=${scenario[k]}`).join(' ');
}

module.exports = { priceWithShadow, _internals: { compareSafely, detach, parityLabel } };
