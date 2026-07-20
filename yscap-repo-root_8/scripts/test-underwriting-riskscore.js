'use strict';
/**
 * Unit tests for the fraud / red-flag risk score (risk-score.js). Pure — no AI/DB.
 * Verifies weighted aggregation, distinct-code counting (no runaway), derived economic signals,
 * banding, the HIGH-band advisory, and explainability (score = Σ reason weights).
 */
const assert = require('assert');
const { computeRiskScore, SIGNAL_WEIGHTS } = require('../src/lib/underwriting/risk-score');

const f = (code, title, severity = 'warning') => ({ code, title: title || code, severity, status: 'open' });

// ---- A clean file → score 0, low band, no advisory ----
{
  const r = computeRiskScore({ findings: [], economics: {} });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.band, 'low');
  assert.strictEqual(r.finding, null);
  assert.strictEqual(r.sarRecommended, false);
}

// ---- Score = sum of DISTINCT signal weights; repeated code counts once ----
{
  const r = computeRiskScore({ findings: [
    f('id_name_mismatch'),          // 20
    f('id_name_mismatch'),          // duplicate → not double-counted
    f('bank_account_not_borrower'), // 15
    f('needs_manual_review'),       // not a weighted signal → 0
  ] });
  assert.strictEqual(r.score, 35, '20 + 15, duplicate ignored');
  // Explainability: score equals the sum of the reasons' weights.
  assert.strictEqual(r.reasons.reduce((s, x) => s + x.weight, 0), r.score);
  // Ranked by weight desc.
  assert.strictEqual(r.reasons[0].code, 'id_name_mismatch');
}

// ---- OFAC confirmed alone pushes HIGH + a SAR advisory finding ----
{
  const r = computeRiskScore({ findings: [f('ofac_confirmed_match', 'OFAC confirmed match', 'fatal')] });
  assert.strictEqual(r.score, 45);
  assert.strictEqual(r.band, 'high');
  assert.ok(r.sarRecommended);
  assert.ok(r.finding && r.finding.code === 'elevated_fraud_risk');
  assert.strictEqual(r.finding.severity, 'warning', 'the risk advisory is non-blocking');
  assert.strictEqual(r.finding.blocksCtc, false);
}

// ---- Score caps at 100 ----
{
  const many = Object.keys(SIGNAL_WEIGHTS).map((code) => f(code));
  const r = computeRiskScore({ findings: many });
  assert.strictEqual(r.score, 100, 'capped at 100');
  assert.strictEqual(r.band, 'high');
}

// ---- Derived economic signals: inflated ARV + overpayment vs as-is ----
{
  const r = computeRiskScore({ findings: [], economics: { purchasePrice: 400000, asIsValue: 330000, arv: 650000 } });
  const codes = r.reasons.map((x) => x.code).sort();
  // arv 650k > 400k*1.5 (600k) → arv_inflation (15); price 400k > 330k*1.15 (379.5k) → overpayment (12).
  assert.deepStrictEqual(codes, ['arv_inflation', 'overpayment_vs_asis']);
  assert.strictEqual(r.score, 27);
  assert.strictEqual(r.band, 'elevated');
  // Both carry human evidence.
  assert.ok(r.reasons.every((x) => x.evidence && /%/.test(x.evidence)));
}

// ---- A conservative deal fires no economic signal ----
{
  const r = computeRiskScore({ findings: [], economics: { purchasePrice: 400000, asIsValue: 410000, arv: 520000 } });
  assert.strictEqual(r.reasons.length, 0, 'ARV 520k < 600k and price 400k < as-is*1.15 → nothing');
}

// ---- Banding boundaries ----
{
  assert.strictEqual(computeRiskScore({ findings: [f('bank_account_other_entity')] }).band, 'low');       // 10 → low
  assert.strictEqual(computeRiskScore({ findings: [f('id_name_mismatch')] }).band, 'elevated');           // 20 → elevated
  assert.strictEqual(computeRiskScore({ findings: [f('ofac_confirmed_match')] }).band, 'high');            // 45 → high
}

// ---- Tie-out (cross-document) mismatches score (deep-audit regression) ----
// The live tie-out engine emits `tieout_<factKey>` codes; the weight table used to key on the
// dead cross-document.js codes, so a file riddled with cross-document disagreements scored 0.
{
  const r = computeRiskScore({ findings: [
    f('tieout_purchase_price'), f('tieout_seller_name'), f('tieout_entity_name'),
  ] });
  assert.strictEqual(r.score, 39, 'tie-out price(15)+seller(12)+entity(12) score 39 — previously 0 (dead codes)');
  assert.strictEqual(r.band, 'elevated', 'three fatal tie-out mismatches land ELEVATED');
  assert.ok(r.reasons.some((x) => x.code === 'tieout_purchase_price'), 'tie-out price is a scored reason');
  // Adding the property-address mismatch pushes it into HIGH (SAR territory).
  const r2 = computeRiskScore({ findings: [
    f('tieout_purchase_price'), f('tieout_seller_name'), f('tieout_entity_name'), f('tieout_property_address'),
  ] });
  assert.strictEqual(r2.band, 'high', 'four fatal tie-out mismatches reach HIGH');
  assert.strictEqual(r2.sarRecommended, true);
}

console.log('test-underwriting-riskscore: weighted fraud scoring + banding + advisory pass');
