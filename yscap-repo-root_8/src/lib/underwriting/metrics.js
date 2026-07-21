'use strict';
/**
 * Derived underwriting metrics — the ratios a fix-&-flip / bridge (RTL) underwriter actually
 * decides on, recomputed from the file's economics and checked against the program's caps. In
 * this lending the max loan is the LESSER of several caps, so we compute them all and report
 * which one BINDS (the constraint that actually limits the loan), plus whether the registered
 * loan exceeds any cap (over-leverage → a finding for the underwriter, never an auto-block).
 *
 *   LTP     INITIAL ADVANCE ÷ purchase price          (acquisition leverage)
 *   LTV     INITIAL ADVANCE ÷ as-is appraised value    (acquisition leverage, as-is)
 *   LTC     TOTAL loan ÷ (purchase + rehab budget)
 *   ARV-LTV TOTAL loan ÷ after-repair value
 *
 * NUMERATOR matters (owner-directed 2026-07-21, root-cause fix): the frozen engine
 * (web/tools/standard-program.js) caps `maxAcqLTV * acqDenom` on the ACQUISITION (initial) advance,
 * while `maxARLTV * arv` and `maxLTC * costBasis` cap the TOTAL loan. A fix-&-flip loan = initial
 * advance + rehab HOLDBACK (+ financed reserve); the holdback is drawn as work completes and is
 * LEGITIMATELY allowed above the purchase/as-is caps. So loan-to-purchase and as-is LTV must use the
 * INITIAL ADVANCE, not the total loan — comparing the total (incl. holdback) to purchase produced a
 * false "loan exceeds the loan-to-purchase cap" over-leverage finding. LTC / ARV-LTV keep the total.
 *
 * Pure: no AI, no DB. Caps are CONFIG (per-program value, not a constant) with RTL defaults; a caller
 * can pass tighter/looser caps per program. A metric whose denominator OR numerator is missing is
 * simply omitted — we never invent a denominator, and never assess acquisition leverage on the wrong
 * numerator (no initial advance → LTP/LTV are skipped rather than computed off the total loan).
 */
const { num } = require('./compare');

// Default caps for a fix-&-flip / bridge program. Fractions of the respective base. `numer` names the
// loan figure the ratio is measured on: 'initial' = the acquisition (initial) advance; 'total' = the
// full loan (initial + holdback + reserve).
const DEFAULT_CAPS = {
  ltp:     { cap: 0.90, base: 'purchasePrice', numer: 'initial', label: 'Loan-to-purchase', baseLabel: 'purchase price' },
  ltv:     { cap: 0.80, base: 'asIsValue',     numer: 'initial', label: 'Loan-to-value (as-is)', baseLabel: 'as-is value' },
  ltc:     { cap: 0.90, base: 'cost',          numer: 'total',   label: 'Loan-to-cost', baseLabel: 'purchase + rehab' },
  arv_ltv: { cap: 0.75, base: 'arv',           numer: 'total',   label: 'Loan-to-ARV (after-repair)', baseLabel: 'after-repair value' },
};

// Build a caps override from a file's REGISTERED engine caps (quote.caps fractions) so the leverage
// metrics measure against the EXACT per-tier caps the loan was sized under — not a generic default.
// A validly-sized registered loan then can never exceed its own caps (no spurious over-leverage
// findings). `maxAcqLtv` is the single acquisition cap the engine applies against min(purchase,
// as-is); it maps onto BOTH LTP (÷purchase) and LTV (÷as-is) here. A missing/invalid cap keeps the
// generic DEFAULT_CAPS value. Returns DEFAULT_CAPS unchanged when no registered caps are supplied.
function capsFromRegistration(regCaps) {
  if (!regCaps) return DEFAULT_CAPS;
  const merged = {};
  for (const [key, cfg] of Object.entries(DEFAULT_CAPS)) merged[key] = { ...cfg };
  const set = (key, v) => { if (v != null && isFinite(Number(v)) && Number(v) > 0) merged[key].cap = Number(v); };
  set('ltp', regCaps.maxAcqLtv);
  set('ltv', regCaps.maxAcqLtv);
  set('ltc', regCaps.maxLtc);
  set('arv_ltv', regCaps.maxArvLtv);
  return merged;
}

function round2(n) { return Math.round(n * 100) / 100; }
function pct(n) { return `${round2(n * 100)}%`; }
function money(n) { return `$${Math.round(n).toLocaleString('en-US')}`; }

/**
 * @param {object} econ  { loanAmount, initialAdvance, purchasePrice, asIsValue, arv, rehabBudget }
 *   loanAmount    = TOTAL registered loan (initial + holdback + reserve) — the LTC/ARV numerator.
 *   initialAdvance = the acquisition (initial) advance — the LTP/LTV numerator. When absent, the
 *                    acquisition-leverage metrics (numer:'initial') are SKIPPED, never computed off
 *                    the total loan (that was the bug).
 * @param {object} caps  optional override of DEFAULT_CAPS (merged shallowly per key)
 * @returns {{ loanAmount, initialAdvance, metrics:Array, maxLoan, binding, findings:Array }}
 *   metrics[i] = { key, label, base, baseAmount, numer, loanAmount, value, cap, capAmount, over, pass }
 */
function computeMetrics(econ = {}, caps = DEFAULT_CAPS) {
  const loan = num(econ.loanAmount);
  const initial = num(econ.initialAdvance);
  const price = num(econ.purchasePrice);
  const asIs = num(econ.asIsValue);
  const arv = num(econ.arv);
  const rehab = num(econ.rehabBudget);
  // Cost = purchase + rehab (rehab treated as 0 when absent, but only if we have a price).
  const cost = price != null ? price + (rehab != null ? rehab : 0) : null;
  const bases = { purchasePrice: price, asIsValue: asIs, arv, cost };
  // The loan figure each ratio is measured on: acquisition metrics use the initial advance, the
  // rest use the total loan. `null` numerator → the metric is skipped (never guess).
  const numers = { initial, total: loan };

  const metrics = [];
  let maxLoan = null;
  let binding = null;
  for (const [key, cfg] of Object.entries(caps)) {
    const baseAmount = bases[cfg.base];
    if (baseAmount == null || baseAmount <= 0) continue;   // no denominator → skip, never guess
    const numerKey = cfg.numer || 'total';
    const numerAmount = numers[numerKey];
    if (numerAmount == null) continue;                     // no numerator (e.g. no initial advance) → skip
    const capAmount = round2(cfg.cap * baseAmount);
    const value = round2(numerAmount / baseAmount);
    const over = numerAmount > capAmount + 0.5 ? round2(numerAmount - capAmount) : 0;
    metrics.push({ key, label: cfg.label, base: cfg.base, baseLabel: cfg.baseLabel, numer: numerKey,
      baseAmount, loanAmount: numerAmount, value, cap: cfg.cap, capAmount, over, pass: over === 0 });
    // The binding max-loan is a TOTAL-loan ceiling; only the total-loan caps constrain it directly
    // (an acquisition cap limits the initial advance, not the whole loan).
    if (numerKey === 'total' && (maxLoan == null || capAmount < maxLoan)) { maxLoan = capAmount; binding = key; }
  }

  // Over-leverage findings: the relevant loan figure exceeds a cap. A WARNING (not a hard block) —
  // over-leverage is a documented-exception decision an underwriter makes, not an auto-decline.
  const findings = [];
  for (const m of metrics) {
    if (m.over > 0) {
      const numerLabel = m.numer === 'initial' ? 'initial advance' : 'loan';
      findings.push({ source: 'metrics', code: `over_${m.key}`, severity: 'warning', status: 'open',
        field: m.key, docValue: `${pct(m.value)} (${money(m.loanAmount)})`, fileValue: `${pct(m.cap)} cap = ${money(m.capAmount)}`,
        blocksCtc: false,
        title: `${m.numer === 'initial' ? 'Initial advance' : 'Loan'} exceeds the ${m.label} cap`,
        howTo: `The ${numerLabel} (${money(m.loanAmount)}) is ${pct(m.value)} of ${m.baseLabel} (${money(m.baseAmount)}), above the ${pct(m.cap)} cap (${money(m.capAmount)}). Reduce the ${numerLabel} to ${money(m.capAmount)} or document an approved exception.`,
        actions: ['grant_exception', 'post_condition', 'request_revision', 'dismiss'] });
    }
  }
  // If the loan clears every individual cap but still exceeds the binding max (defensive; the
  // per-metric checks already catch this), surface the binding constraint informationally.
  return { loanAmount: loan, initialAdvance: initial, metrics, maxLoan, binding, findings };
}

module.exports = { computeMetrics, capsFromRegistration, DEFAULT_CAPS, _internals: { round2, pct, money } };
