'use strict';
/**
 * R5.66 — Predictive underwriting (deterministic core).
 *
 * Turns the underwriting-memory peer summary (R5.55/R5.56 — similar FUNDED
 * deals) into a forward-looking forecast for the file: how many conditions to
 * expect, an estimated time-to-close, and a fundability signal. It is
 * INFORMATIONAL — a tile that helps an underwriter set expectations, never an
 * action and never a decision.
 *
 * HONESTY: peers are funded-only, so this does NOT claim a hard "funding
 * probability" (that would be survivorship bias). It reports a fundability
 * SIGNAL (low/moderate/high) grounded in how many close funded peers exist +
 * how strong the best match is, and always states the peer count it's based on.
 * When there isn't enough history, it says so rather than inventing a number.
 *
 * Pure: no DB, no AI. forecast(summary, opts) → structured forecast or a
 * low-confidence "not enough history" result.
 */

const MIN_PEERS_FOR_SIGNAL = 5;     // below this, we don't assert a signal

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * forecast(summary, opts)
 *   summary: the underwriting-memory summarizePeers() output (or null)
 *     { count, avgConditions, avgLoanAmount, avgLtvPct, topInvestor, bestMatchPct }
 *   opts.avgClosingDays  (optional) mean days-to-close across the peers
 * Returns {
 *   hasEnoughHistory, peerCount, expectedConditions, expectedClosingDays,
 *   fundabilitySignal, confidence, basis
 * }
 */
function forecast(summary, opts = {}) {
  const s = summary || {};
  const peerCount = Number(s.count) || 0;
  const bestMatch = Number(s.bestMatchPct) || 0;

  if (peerCount < MIN_PEERS_FOR_SIGNAL) {
    return {
      hasEnoughHistory: false,
      peerCount,
      expectedConditions: s.avgConditions != null ? round1(s.avgConditions) : null,
      expectedClosingDays: Number.isFinite(opts.avgClosingDays) ? Math.round(opts.avgClosingDays) : null,
      fundabilitySignal: 'insufficient_history',
      confidence: 'low',
      basis: peerCount === 0
        ? 'No similar funded deals on record yet.'
        : `Only ${peerCount} similar funded deal${peerCount === 1 ? '' : 's'} — too few to call a signal.`,
    };
  }

  // Fundability signal: strong when many close peers funded. Grounded, not a
  // probability — a file that looks like many funded deals is more likely
  // fundable, but this never asserts a percentage.
  let fundabilitySignal = 'moderate';
  if (peerCount >= 12 && bestMatch >= 80) fundabilitySignal = 'high';
  else if (peerCount < 8 || bestMatch < 65) fundabilitySignal = 'moderate';
  // (never 'low' from funded peers — absence of a signal is 'insufficient_history')

  // Confidence in the forecast scales with peer count + best-match strength.
  // The 'high' floor mirrors the 'high' SIGNAL floor (>=12 peers) so a strong
  // signal is never paired with only-medium confidence.
  let confidence = 'medium';
  if (peerCount >= 12 && bestMatch >= 85) confidence = 'high';
  else if (peerCount < 8) confidence = 'low';

  return {
    hasEnoughHistory: true,
    peerCount,
    expectedConditions: s.avgConditions != null ? round1(s.avgConditions) : null,
    expectedClosingDays: Number.isFinite(opts.avgClosingDays) ? Math.round(opts.avgClosingDays) : null,
    fundabilitySignal,
    confidence,
    basis: `Based on ${peerCount} similar funded deal${peerCount === 1 ? '' : 's'}`
      + (s.avgConditions != null ? ` averaging ${round1(s.avgConditions)} conditions` : '')
      + (s.topInvestor ? ` · most common investor: ${s.topInvestor.label}` : '')
      + '.',
  };
}

// A one-line plain-language headline for the tile.
function headline(f) {
  if (!f || !f.hasEnoughHistory) return 'Not enough similar funded deals yet to forecast this file.';
  const parts = [];
  if (f.expectedConditions != null) parts.push(`~${f.expectedConditions} conditions expected`);
  if (f.expectedClosingDays != null) parts.push(`~${f.expectedClosingDays}-day close`);
  const sig = { high: 'strong', moderate: 'moderate', insufficient_history: 'unknown' }[f.fundabilitySignal] || f.fundabilitySignal;
  parts.push(`${sig} fundability signal`);
  return parts.join(' · ');
}

module.exports = { forecast, headline, MIN_PEERS_FOR_SIGNAL };
