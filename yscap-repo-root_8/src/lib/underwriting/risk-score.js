'use strict';
/**
 * File-level fraud / red-flag risk score.
 *
 * The engine already raises many individual signals — a tampered PDF, an OFAC hit, an identity
 * mismatch, a price disagreement, cash back to the buyer at closing. On their own each is one
 * line on the desk; together they're a PATTERN. This rolls them into a single explainable
 * 0–100 score with ranked reason codes, aligned to FinCEN mortgage-fraud / real-estate SAR
 * indicators (straw buyer, value inflation, occupancy fraud, document integrity).
 *
 * Explainable by construction: score = Σ of the weights of the DISTINCT signals present (capped
 * at 100), and every point is traceable to a reason with its evidence. It does NOT re-decide the
 * gate — the underlying findings keep their own severities; this adds ONE advisory when the score
 * lands HIGH (enhanced review / SAR consideration), never a hard block.
 *
 * Pure: no AI, no DB. Fed the file's OPEN findings + its economics.
 */

// Signal weights: a finding CODE -> points it contributes to the risk score (counted ONCE per
// distinct code so a repeated code can't run the score away). Grouped by FinCEN indicator family.
const SIGNAL_WEIGHTS = {
  // Sanctions / integrity — near-decisive.
  ofac_confirmed_match: 45,
  pdf_tampering_signs: 30,
  settlement_cash_back: 25,          // undisclosed cash to the buyer at closing
  ofac_potential_match: 15,
  background_criminal: 12,
  // Identity / straw-buyer signals.
  id_name_mismatch: 20,
  id_dob_mismatch: 20,
  bank_account_not_borrower: 15,     // the funds aren't the borrower's
  bank_account_other_entity: 10,
  bank_large_deposit: 8,             // an unsourced large deposit (gifted / third-party funds)
  values_unconfirmed_in_document: 10, // extracted value not found in the document (possible fabrication)
  beneficial_owner_unidentified: 10,
  // Value inflation / non-arm's-length (price + party inconsistencies).
  title_short_seasoning: 15,         // rapid resale / property-flip signal
  cross_price_mismatch: 15,
  contract_price_mismatch: 12,
  contract_buyer_mismatch: 12,
  cross_seller_mismatch: 12,
  underlying_price_mismatch: 10,
  assignment_fee_over_cap: 10,
  occupancy_owner_occupied_flag: 12, // occupancy vs stated use
  // Credit distress (weaker signals).
  credit_judgment_lien: 8,
  credit_major_derogatory: 6,
};

// Derived economic red flags (not tied to a single finding) — computed from the file economics.
// Each returns a {code, label, weight, evidence} when it fires.
function economicSignals(econ = {}) {
  const out = [];
  const price = numOrNull(econ.purchasePrice);
  const asIs = numOrNull(econ.asIsValue);
  const arv = numOrNull(econ.arv);
  // Inflated ARV: an after-repair value far above the purchase price is the classic value-
  // inflation lever (mirrors the FHA >100% resale second-appraisal trigger).
  if (price != null && arv != null && price > 0 && arv > price * 1.5) {
    out.push({ code: 'arv_inflation', label: 'After-repair value far above purchase price', weight: 15,
      evidence: `ARV ${money(arv)} is ${Math.round((arv / price - 1) * 100)}% over the ${money(price)} purchase price` });
  }
  // Overpayment vs as-is: paying well above as-is value can signal a non-arm's-length / straw deal.
  if (price != null && asIs != null && asIs > 0 && price > asIs * 1.15) {
    out.push({ code: 'overpayment_vs_asis', label: 'Purchase price well above as-is value', weight: 12,
      evidence: `Price ${money(price)} is ${Math.round((price / asIs - 1) * 100)}% over the ${money(asIs)} as-is value` });
  }
  return out;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function money(n) { return `$${Math.round(n).toLocaleString('en-US')}`; }

function bandFor(score) {
  if (score >= 45) return 'high';
  if (score >= 20) return 'elevated';
  return 'low';
}

/**
 * @param {object} args
 *   findings   [{code, title, severity, status}]  the file's OPEN findings (per-doc + derived)
 *   economics  {purchasePrice, asIsValue, arv}
 * @returns {{ score, band, sarRecommended, reasons, finding }}
 *   reasons = [{code, label, weight, evidence}] sorted by weight desc.
 *   finding = one advisory finding when band==='high', else null.
 */
function computeRiskScore({ findings = [], economics = {} } = {}) {
  const open = findings.filter((f) => (f.status || 'open') === 'open');
  const reasons = [];
  const seen = new Set();
  // Finding-derived signals: each distinct weighted code contributes once.
  for (const f of open) {
    const w = SIGNAL_WEIGHTS[f.code];
    if (w == null || seen.has(f.code)) continue;
    seen.add(f.code);
    reasons.push({ code: f.code, label: f.title || f.code, weight: w, evidence: f.title || null });
  }
  // Derived economic signals.
  for (const s of economicSignals(economics)) {
    if (seen.has(s.code)) continue;
    seen.add(s.code);
    reasons.push(s);
  }

  reasons.sort((x, y) => y.weight - x.weight);
  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.weight, 0));
  const band = bandFor(score);

  const finding = band === 'high' ? {
    source: 'risk', code: 'elevated_fraud_risk', severity: 'warning', status: 'open',
    field: 'risk_score', docValue: `${score}/100 (${band})`, fileValue: null, blocksCtc: false,
    title: 'Elevated fraud / red-flag risk on this file',
    howTo: `The combined risk signals score ${score}/100. Review the ranked reasons (${reasons.slice(0, 3).map((r) => r.code).join(', ')}${reasons.length > 3 ? ', …' : ''}) and consider enhanced due diligence / a SAR review before proceeding.`,
    actions: ['post_condition', 'request_document', 'decline', 'dismiss'],
  } : null;

  return { score, band, sarRecommended: band === 'high', reasons, finding };
}

module.exports = { computeRiskScore, SIGNAL_WEIGHTS, _internals: { economicSignals, bandFor } };
