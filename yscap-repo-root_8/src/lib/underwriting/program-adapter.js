'use strict';
/**
 * R6.5 — Program adapter (the frozen engine → whole-loan program decision).
 *
 * The whole-loan run needs the PROGRAM verdict (eligible / manual / ineligible,
 * the sized structure, the caps, the reasons). That verdict is owned ENTIRELY by
 * the frozen pricing engines (standard-program.js / gold-standard.js), reached
 * through src/lib/pricing.js. This module is the thin ADAPTER that turns an
 * engine quote into the normalized shape the whole-loan decision consumes — it
 * NEVER re-implements a rule, never invents a number, never re-prices to
 * override. It reads the engine's output and classifies it.
 *
 * HARD RULE: no rule duplication. The only numbers here come from the engine
 * quote. The only NEW thing is classification (raw engine status → whole-loan
 * status vocabulary) + splitting the engine's own reasons by severity.
 *
 * Two entry points:
 *   • adaptQuote(quote, opts)      PURE — adapt an already-computed engine quote.
 *   • fromRegistration(reg, opts)  adapt the STORED registration quote (the
 *                                  authoritative frozen-engine result captured at
 *                                  registration — the whole-loan run reads THIS,
 *                                  it does not re-price).
 *
 * A live re-price (priceProgram) is available for a fresh what-if / staleness
 * check, but it must produce the SAME numbers the registration holds — it can
 * detect drift, never replace the registered structure.
 */

const uwStatus = require('./uw-status');

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The frozen engine's raw status → the three canonical engine statuses the
// whole-loan classifier understands. Anything unrecognized is treated as a
// non-pass (NOT_READY downstream) — an unknown engine result never passes.
function normalizeEngineStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'ELIGIBLE') return 'ELIGIBLE';
  if (s === 'MANUAL') return 'MANUAL';
  if (s === 'INELIGIBLE') return 'INELIGIBLE';
  if (s === 'ERROR') return 'INELIGIBLE'; // a pricing error is never issuable
  return null;
}

const LEVEL_RANK = { INELIGIBLE: 3, MANUAL: 2, ELIGIBLE: 1, INFO: 0 };
function levelRank(l) { return LEVEL_RANK[String(l || '').toUpperCase()] || 0; }

/**
 * adaptQuote(quote, opts?) → normalized program decision (PURE).
 *   quote: a pricing.js quoteProgram/normalize result, OR a stored
 *          registration.quote (same shape) — { status, reasons:[{level,msg}],
 *          sizing:{totalLoan,...}, caps, liquidityRequired, noteRate, ... }.
 *   opts:  { manualApproved, missingRequired, conflict, stale } — passed through
 *          to the status classifier (defaults: all false/undefined).
 * Returns {
 *   engineStatus,                 // raw frozen status, uppercased
 *   wholeLoanStatus,              // classified (uw-status)
 *   eligible,                     // engine's own eligible flag
 *   manualReasons:[msg],          // the engine reasons that make it MANUAL
 *   blockingReasons:[msg],        // the engine reasons that make it INELIGIBLE
 *   reasons:[{level,msg}],        // every engine reason (verbatim)
 *   sizing, caps, noteRate, program, productLabel, liquidityRequired,
 * }
 */
function adaptQuote(quote, opts) {
  const q = quote || {};
  const o = opts || {};
  const engineStatus = normalizeEngineStatus(q.status);

  const reasons = Array.isArray(q.reasons)
    ? q.reasons.map((r) => ({ level: String(r.level || '').toUpperCase(), msg: r.msg }))
    : [];
  const manualReasons = reasons.filter((r) => r.level === 'MANUAL').map((r) => r.msg);
  const blockingReasons = reasons.filter((r) => r.level === 'INELIGIBLE').map((r) => r.msg);

  const wholeLoanStatus = uwStatus.classify({
    engineStatus,
    manualApproved: !!o.manualApproved,
    missingRequired: !!o.missingRequired,
    conflict: !!o.conflict,
    stale: !!o.stale,
  });

  const s = q.sizing || {};
  const sizing = {
    totalLoan: num(s.totalLoan),
    initialAdvance: num(s.initialAdvance),
    rehabHoldback: num(s.rehabHoldback),
    financedReserve: num(s.financedReserve),
    downPayment: num(s.downPayment),
    monthlyPayment: num(s.monthlyPayment),
    assignmentExcessOOP: num(s.assignmentExcessOOP),
  };

  return {
    engineStatus,
    wholeLoanStatus,
    // Fail-safe (fix 2026-07-23): an UNKNOWN/absent engine status must never
    // read as eligible. Eligible only when the engine SAID eligible (status
    // ELIGIBLE, or an explicit true flag alongside a recognized status).
    eligible: engineStatus === 'ELIGIBLE'
      ? (q.eligible !== undefined ? !!q.eligible : true)
      : (q.eligible === true && engineStatus !== null),
    manualReasons,
    blockingReasons,
    reasons,
    sizing,
    caps: q.caps || null,
    noteRate: num(q.noteRate),
    program: q.program || null,
    productLabel: q.productLabel || q.programLabel || null,
    liquidityRequired: num(q.liquidityRequired),
    // The single most severe reason (for a one-line explanation).
    topReason: reasons.slice().sort((a, b) => levelRank(b.level) - levelRank(a.level))[0] || null,
  };
}

/**
 * fromRegistration(reg, opts?) → the adapted program decision for a stored
 * registration. Reads reg.quote (the frozen engine's captured result) — the
 * whole-loan run's authoritative program verdict. `reg.stale`/`reg.is_manual`
 * feed the classifier so a stale/manual registration classifies correctly
 * WITHOUT re-pricing.
 */
function fromRegistration(reg, opts) {
  if (!reg) return null;
  const o = opts || {};
  return adaptQuote(reg.quote || {}, {
    manualApproved: o.manualApproved,
    missingRequired: o.missingRequired,
    conflict: o.conflict,
    // A registration flagged stale (db/096 trigger) OR passed stale by the run.
    stale: o.stale !== undefined ? o.stale : !!reg.stale,
  });
}

/**
 * priceProgram(app, experience, overrides, opts?) → adapted decision from a LIVE
 * frozen-engine quote. For a what-if / staleness cross-check only. It calls the
 * frozen engine through pricing.js (never re-implements it); the resulting
 * numbers must match the registration's — use it to DETECT drift, never to
 * replace the registered structure. `pricing` is lazy-required so this module
 * stays loadable without a DB/engine present (the pure adapter has no deps).
 */
function priceProgram(app, experience, overrides, opts) {
  const pricing = require('../pricing');
  const program = String((app && (app.program || app.loan_type)) || '').toLowerCase().indexOf('gold') > -1 ? 'gold' : 'standard';
  const input = pricing.buildInputs(app, experience, overrides || {});
  const quote = pricing.quoteProgram(program, input);
  return adaptQuote(quote, opts);
}

module.exports = {
  adaptQuote,
  fromRegistration,
  priceProgram,
  normalizeEngineStatus,
  _internals: { num, levelRank },
};
