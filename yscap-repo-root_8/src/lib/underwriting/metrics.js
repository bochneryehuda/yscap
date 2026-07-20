'use strict';
/**
 * Derived underwriting metrics — the ratios a fix-&-flip / bridge (RTL) underwriter actually
 * decides on, recomputed from the file's economics and checked against the program's caps. In
 * this lending the max loan is the LESSER of several caps, so we compute them all and report
 * which one BINDS (the constraint that actually limits the loan), plus whether the registered
 * loan exceeds any cap (over-leverage → a finding for the underwriter, never an auto-block).
 *
 *   LTP     loan ÷ purchase price
 *   LTV     loan ÷ as-is appraised value     (as-is)
 *   LTC     loan ÷ (purchase + rehab budget)
 *   ARV-LTV loan ÷ after-repair value
 *
 * Pure: no AI, no DB. Caps are CONFIG (per the research, every threshold is a per-program value,
 * not a constant) with sensible RTL defaults; a caller can pass tighter/looser caps per program.
 * A metric whose inputs are missing is simply omitted — we never invent a denominator.
 */
const { num } = require('./compare');

// Default caps for a fix-&-flip / bridge program. Fractions of the respective base.
const DEFAULT_CAPS = {
  ltp:     { cap: 0.90, base: 'purchasePrice', label: 'Loan-to-purchase', baseLabel: 'purchase price' },
  ltv:     { cap: 0.80, base: 'asIsValue',     label: 'Loan-to-value (as-is)', baseLabel: 'as-is value' },
  ltc:     { cap: 0.90, base: 'cost',          label: 'Loan-to-cost', baseLabel: 'purchase + rehab' },
  arv_ltv: { cap: 0.75, base: 'arv',           label: 'Loan-to-ARV (after-repair)', baseLabel: 'after-repair value' },
};

function round2(n) { return Math.round(n * 100) / 100; }
function pct(n) { return `${round2(n * 100)}%`; }
function money(n) { return `$${Math.round(n).toLocaleString('en-US')}`; }

/**
 * @param {object} econ  { loanAmount, purchasePrice, asIsValue, arv, rehabBudget }
 * @param {object} caps  optional override of DEFAULT_CAPS (merged shallowly per key)
 * @returns {{ loanAmount, metrics:Array, maxLoan, binding, findings:Array }}
 *   metrics[i] = { key, label, base, baseAmount, value, cap, capAmount, over, pass }
 */
function computeMetrics(econ = {}, caps = DEFAULT_CAPS) {
  const loan = num(econ.loanAmount);
  const price = num(econ.purchasePrice);
  const asIs = num(econ.asIsValue);
  const arv = num(econ.arv);
  const rehab = num(econ.rehabBudget);
  // Cost = purchase + rehab (rehab treated as 0 when absent, but only if we have a price).
  const cost = price != null ? price + (rehab != null ? rehab : 0) : null;
  const bases = { purchasePrice: price, asIsValue: asIs, arv, cost };

  const metrics = [];
  let maxLoan = null;
  let binding = null;
  for (const [key, cfg] of Object.entries(caps)) {
    const baseAmount = bases[cfg.base];
    if (baseAmount == null || baseAmount <= 0) continue;   // no denominator → skip, never guess
    const capAmount = round2(cfg.cap * baseAmount);
    const value = loan != null ? round2(loan / baseAmount) : null;
    const over = loan != null && loan > capAmount + 0.5 ? round2(loan - capAmount) : 0;
    metrics.push({ key, label: cfg.label, base: cfg.base, baseLabel: cfg.baseLabel,
      baseAmount, value, cap: cfg.cap, capAmount, over, pass: over === 0 });
    if (maxLoan == null || capAmount < maxLoan) { maxLoan = capAmount; binding = key; }
  }

  // Over-leverage findings: the registered loan exceeds a cap. A WARNING (not a hard block) —
  // over-leverage is a documented-exception decision an underwriter makes, not an auto-decline.
  const findings = [];
  for (const m of metrics) {
    if (m.over > 0) {
      findings.push({ source: 'metrics', code: `over_${m.key}`, severity: 'warning', status: 'open',
        field: m.key, docValue: `${pct(m.value)} (${money(loan)})`, fileValue: `${pct(m.cap)} cap = ${money(m.capAmount)}`,
        blocksCtc: false,
        title: `Loan exceeds the ${m.label} cap`,
        howTo: `The loan (${money(loan)}) is ${pct(m.value)} of ${m.baseLabel} (${money(m.baseAmount)}), above the ${pct(m.cap)} cap (${money(m.capAmount)}). Reduce the loan to ${money(m.capAmount)} or document an approved exception.`,
        actions: ['grant_exception', 'post_condition', 'request_revision', 'dismiss'] });
    }
  }
  // If the loan clears every individual cap but still exceeds the binding max (defensive; the
  // per-metric checks already catch this), surface the binding constraint informationally.
  return { loanAmount: loan, metrics, maxLoan, binding, findings };
}

module.exports = { computeMetrics, DEFAULT_CAPS, _internals: { round2, pct, money } };
