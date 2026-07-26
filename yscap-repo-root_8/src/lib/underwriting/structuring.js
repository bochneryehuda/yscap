'use strict';
/**
 * Counterfactual Structuring Engine — Sovereign (blueprint sec. 12).
 *
 * When a file is ineligible or below-cap under its current structure, PILOT
 * doesn't just say "no." It walks a set of ALTERNATIVE STRUCTURES through the
 * frozen pricing engine and reports which levers would make the deal work:
 *   * reduce the loan amount (by 1%, 2%, 5%, 10%)
 *   * switch program (Standard ⇄ Gold Standard)
 *   * swap product / term
 *   * lower the requested LTV / LTC / ARV (admin-only, so scoped)
 *
 * For each alternative it runs the SAME frozen engine the register flow
 * uses (never re-implements a formula) and reports:
 *   status (ELIGIBLE / MANUAL / INELIGIBLE)
 *   note rate + total loan + initial advance
 *   binding cap
 *   delta vs the baseline (dollars + basis points)
 *   what documents / conditions the alternative would require
 *
 * Read-only — no persistence, no side effects. Pure over the pricing wrapper.
 */

const pricing = require('../pricing');

// The lever set. Each function produces an { label, inputs } delta from a
// baseline input object; the caller runs the pricing engine on the modified
// inputs and returns the resulting quote next to the label.
const LEVERS = Object.freeze({
  loan_minus_1pct:  (baseline) => ({ label: 'Reduce total loan by 1%',   inputs: { ...baseline, loanAmount: Math.floor(baseline.loanAmount * 0.99) } }),
  loan_minus_2pct:  (baseline) => ({ label: 'Reduce total loan by 2%',   inputs: { ...baseline, loanAmount: Math.floor(baseline.loanAmount * 0.98) } }),
  loan_minus_5pct:  (baseline) => ({ label: 'Reduce total loan by 5%',   inputs: { ...baseline, loanAmount: Math.floor(baseline.loanAmount * 0.95) } }),
  loan_minus_10pct: (baseline) => ({ label: 'Reduce total loan by 10%',  inputs: { ...baseline, loanAmount: Math.floor(baseline.loanAmount * 0.90) } }),
  swap_program:     (baseline, currentProgram) => ({
    label: `Switch to ${currentProgram === 'gold' ? 'Standard' : 'Gold Standard'} program`,
    inputs: baseline,   // program is passed separately in quoteProgram
    swap: currentProgram === 'gold' ? 'standard' : 'gold',
  }),
  longer_term:      (baseline) => ({ label: 'Longer term (24 months)', inputs: { ...baseline, term: 24 } }),
  interest_only:    (baseline) => ({ label: 'Interest-only', inputs: { ...baseline, interestOnly: true } }),
});

/**
 * Explore counterfactuals for a file.
 * @param {object} baselineInputs — pricing inputs (built by pricing.buildInputs)
 * @param {string} currentProgram — 'standard' | 'gold' | 'manual'
 * @param {object} baselineQuote  — the current registered quote (for delta math)
 * @param {object} opts           — { levers: [name...] to run — defaults to a safe subset }
 * @returns {Array<{key, label, ok, program, status, quote, delta, blocking}>}
 */
function explore(baselineInputs, currentProgram, baselineQuote, opts = {}) {
  if (!baselineInputs || typeof baselineInputs !== 'object') return [];
  if (!pricing.enginesReady()) return [];
  const levers = opts.levers || Object.keys(LEVERS);
  const baseTotal = Number(baselineQuote && baselineQuote.totalLoan) || Number(baselineInputs.loanAmount) || 0;
  const baseRate  = Number(baselineQuote && baselineQuote.noteRate) || null;
  const results = [];
  for (const key of levers) {
    const factory = LEVERS[key];
    if (!factory) continue;
    let alt;
    try { alt = factory(baselineInputs, currentProgram); } catch (_) { continue; }
    const program = alt.swap || currentProgram || 'standard';
    let quote;
    try { quote = pricing.quoteProgram(program === 'manual' ? 'standard' : program, alt.inputs); }
    catch (_) { quote = null; }
    if (!quote) { results.push({ key, label: alt.label, ok: false, program, status: 'ERROR' }); continue; }
    const total = Number(quote.totalLoan) || 0;
    const rate  = Number(quote.noteRate) || null;
    const dTotal = total - baseTotal;
    const dRateBps = (rate != null && baseRate != null) ? Math.round((rate - baseRate) * 10000) : null;
    results.push({
      key,
      label: alt.label,
      ok: true,
      program: quote.program,
      status: quote.status,
      eligible: quote.eligible !== false,
      quote: {
        totalLoan: total,
        noteRate: rate,
        initialAdvance: quote.sizing ? quote.sizing.initialAdvance : null,
        cashToClose: quote.cashToClose != null ? quote.cashToClose : null,
      },
      delta: {
        totalLoan: dTotal,
        totalLoanPct: baseTotal > 0 ? Math.round((dTotal / baseTotal) * 10000) / 100 : null,
        noteRateBps: dRateBps,
      },
      reasons: (quote.reasons || []).map((r) => ({ level: r.level, msg: r.msg })),
    });
  }
  // Return the ELIGIBLE alternatives first, MANUAL next, INELIGIBLE last.
  const order = { ELIGIBLE: 0, MANUAL: 1, INELIGIBLE: 2, ERROR: 3 };
  results.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return results;
}

module.exports = { LEVERS, explore };
