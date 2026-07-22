'use strict';
/**
 * R6.6 — Refinance economic analysis (deterministic core).
 *
 * The audit demands the engine catch "a rate-&-term that behaves economically
 * as cash-out", "cash-out missing a payoff", and "cash-out above verified hard
 * costs". This classifies the refinance ECONOMICS independently of how it was
 * labeled, and flags the mismatches — it does NOT re-price.
 *
 * Definitions:
 *   netToBorrower = loanProceeds - payoff - existingDebt - closingCosts
 *   A refinance is economically CASH-OUT when netToBorrower exceeds a de-minimis
 *   threshold (default $2,000 — the incidental-cash tolerance most investors
 *   allow on a "rate & term").
 *
 * Pure: no DB, no AI. A missing input yields an "incomplete" result (never a
 * fabricated 0), because cash-out cannot be enforced without payoff + proceeds.
 */

const CASH_OUT_DEMINIMIS = 2000;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * analyze({ statedType, loanProceeds, payoff, existingDebt, closingCosts,
 *           verifiedHardCosts, escalationThreshold }) → {
 *   economicType, netToBorrower, mismatch, findings:[] }
 *   statedType: 'rate_term' | 'cash_out' | null (how it was labeled)
 */
function analyze(input) {
  const i = input || {};
  const proceeds = num(i.loanProceeds);
  const payoff = num(i.payoff);
  const findings = [];

  // Can't classify without proceeds + payoff — a refinance with no payoff on
  // file is itself a finding (the audit's "cash-out missing payoff").
  if (proceeds == null) {
    return incomplete('Loan proceeds are unknown — cannot classify the refinance.', findings);
  }
  if (payoff == null) {
    findings.push({ code: 'refi_missing_payoff', severity: 'warning',
      title: 'Payoff amount is missing', explanation: 'A refinance requires a payoff figure to confirm the net cash to the borrower and enforce cash-out limits.' });
    return incomplete('Payoff is unknown — cannot confirm cash-out treatment.', findings);
  }

  const existingDebt = num(i.existingDebt) || 0;
  const closingCosts = num(i.closingCosts) || 0;
  const netToBorrower = Math.round((proceeds - payoff - existingDebt - closingCosts) * 100) / 100;
  const economicType = netToBorrower > CASH_OUT_DEMINIMIS ? 'cash_out' : 'rate_term';

  // Label vs economics mismatch.
  const stated = i.statedType ? String(i.statedType).toLowerCase() : null;
  let mismatch = false;
  if (stated && stated !== economicType) {
    mismatch = true;
    findings.push({ code: 'refi_type_mismatch', severity: 'warning',
      title: `Stated ${stated.replace('_', ' & ')} behaves as ${economicType.replace('_', ' & ')}`,
      explanation: `The loan nets the borrower ${fmt(netToBorrower)} after payoff/debt/closing — that is economically a ${economicType.replace('_', ' & ')}, not a ${stated.replace('_', ' & ')}.` });
  }

  // Cash-out above verified hard costs (reimbursement cap) — audit scenario.
  const verifiedHardCosts = num(i.verifiedHardCosts);
  if (economicType === 'cash_out' && verifiedHardCosts != null && netToBorrower > verifiedHardCosts) {
    findings.push({ code: 'cashout_above_verified_costs', severity: 'warning',
      title: 'Cash-out exceeds verified hard costs',
      explanation: `Net cash to the borrower (${fmt(netToBorrower)}) exceeds the verified hard costs (${fmt(verifiedHardCosts)}); the excess needs a documented basis.` });
  }

  // Cash-out above an escalation threshold — needs super-admin review.
  const escalationThreshold = num(i.escalationThreshold);
  if (economicType === 'cash_out' && escalationThreshold != null && netToBorrower > escalationThreshold) {
    findings.push({ code: 'cashout_over_threshold', severity: 'warning',
      title: 'Cash-out over the review threshold',
      explanation: `Net cash-out (${fmt(netToBorrower)}) exceeds the ${fmt(escalationThreshold)} threshold and requires a super-admin review.` });
  }

  return { economicType, netToBorrower, mismatch, findings, incomplete: false };
}

function incomplete(reason, findings) {
  return { economicType: null, netToBorrower: null, mismatch: false, findings, incomplete: true, reason };
}
function fmt(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US'); }

module.exports = { analyze, CASH_OUT_DEMINIMIS };
