'use strict';
/**
 * R6.6 — Assignment-fee analysis (deterministic core).
 *
 * INDEPENDENTLY verifies the frozen assignment-fee math the engine already
 * applied, so the whole-loan run can confirm it and flag a mismatch. It does
 * NOT change the frozen rule — it RE-DERIVES it and compares.
 *
 * FROZEN RULE (owner-directed, HARD FREEZE 2026-07-17): the financeable
 * assignment fee is capped at 15% of the SELLER'S ORIGINAL contract price
 * (never the fee-inclusive total). Gold adds a $75,000 dollar ceiling on top:
 * financeable = lesser of $75,000 or 15% of the seller price.
 *   recognizedPrice = sellerPrice + financeableFee
 *   excessOutOfPocket = actualFee - financeableFee   (brought to closing)
 *
 * Pure: no DB, no AI. Missing inputs → incomplete (never a fabricated 0).
 */

const SELLER_PCT_CAP = 0.15;      // 15% of the seller's original price
const GOLD_DOLLAR_CEILING = 75000; // Gold's additional dollar ceiling

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * analyze({ sellerPrice, actualFee, program, registeredFinanceableFee?,
 *           registeredRecognizedPrice? }) → {
 *   financeableFee, recognizedPrice, excessOutOfPocket, capReason, findings:[] }
 */
function analyze(input) {
  const i = input || {};
  const sellerPrice = num(i.sellerPrice);
  const actualFee = num(i.actualFee);
  const findings = [];

  if (sellerPrice == null || actualFee == null) {
    return { financeableFee: null, recognizedPrice: null, excessOutOfPocket: null,
      capReason: null, findings, incomplete: true, reason: 'Seller price or assignment fee is unknown.' };
  }

  const pctCap = round2(SELLER_PCT_CAP * sellerPrice);
  const isGold = String(i.program || '').toLowerCase() === 'gold';
  let cap = pctCap;
  let capReason = `15% of the seller's original price (${fmt(pctCap)})`;
  if (isGold && GOLD_DOLLAR_CEILING < pctCap) {
    cap = GOLD_DOLLAR_CEILING;
    capReason = `Gold ceiling: lesser of $75,000 or 15% of the seller price (${fmt(GOLD_DOLLAR_CEILING)})`;
  }

  const financeableFee = Math.min(actualFee, cap);
  const recognizedPrice = round2(sellerPrice + financeableFee);
  const excessOutOfPocket = round2(Math.max(0, actualFee - financeableFee));

  if (actualFee > cap) {
    findings.push({ code: 'assignment_fee_over_cap', severity: 'info',
      title: 'Assignment fee exceeds the financeable cap',
      explanation: `The ${fmt(actualFee)} fee is over the financeable cap (${capReason}); ${fmt(financeableFee)} is financed and ${fmt(excessOutOfPocket)} is brought to closing as extra cash.` });
  }

  // Compare to the registered figures — a mismatch means the quote used a
  // different basis (e.g. the fee-inclusive total, the pre-freeze bug).
  const regFin = num(i.registeredFinanceableFee);
  if (regFin != null && Math.abs(regFin - financeableFee) > 0.5) {
    findings.push({ code: 'assignment_fee_mismatch', severity: 'warning',
      title: 'Registered financeable assignment fee differs',
      explanation: `Independently the financeable fee is ${fmt(financeableFee)} (15% of the seller price), but the registration recorded ${fmt(regFin)} — verify the basis.` });
  }

  return { financeableFee, recognizedPrice, excessOutOfPocket, capReason, findings, incomplete: false };
}

function round2(n) { return Math.round(n * 100) / 100; }
function fmt(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US'); }

module.exports = { analyze, SELLER_PCT_CAP, GOLD_DOLLAR_CEILING };
