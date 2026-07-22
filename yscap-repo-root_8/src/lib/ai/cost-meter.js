'use strict';
/**
 * AI cost meter (R2.11, owner-directed 2026-07-22).
 *
 * Records one row per AI call in ai_cost_events with an integer-cents cost
 * estimate. Provides per-file rollups + an optional per-file cap the caller
 * can consult BEFORE spending more on a file. Best-effort — DB failures never
 * throw and never block an AI call.
 *
 * Rough per-1K-token pricing (USD, June-2026 published rates, may shift):
 *   GPT-5 (deployment):       $0.005 in / $0.015 out
 *   Doc Intelligence prebuilt: $0.001 per page (approx)
 *   Doc Intelligence custom:   $0.005 per page (approx)
 * These are DEFAULTS a super-admin can tune via env.
 */

const cfg = require('../../config');
let _db = null;
const db = () => (_db || (_db = require('../../db')));

const RATE_GPT5_IN_PER_1K   = Number(process.env.AI_COST_GPT5_IN_PER_1K   || 0.005);
const RATE_GPT5_OUT_PER_1K  = Number(process.env.AI_COST_GPT5_OUT_PER_1K  || 0.015);
// Per-file cap in USD. NULL / <=0 = no cap (default). When set, remainingBudgetUsd()
// returns 0 once the file has spent >= cap, and a caller can gate further AI work.
const PER_FILE_CAP_USD = Number(process.env.AI_PER_FILE_CAP_USD || 0);

/** Cost in INTEGER cents (best-effort). Returns 0 for unknown providers. */
function estimateCents({ provider, tokensIn = 0, tokensOut = 0 }) {
  const model = provider || '';
  if (/azure_openai|openai/.test(model)) {
    const usd = (tokensIn * RATE_GPT5_IN_PER_1K + tokensOut * RATE_GPT5_OUT_PER_1K) / 1000;
    return Math.round(usd * 100);
  }
  return 0;
}

/** Record ONE ai_cost_events row. Best-effort; never throws. */
async function record({
  applicationId, documentId, opName, provider, model,
  tokensIn = 0, tokensOut = 0, durationMs, ok = true, reason,
}) {
  try {
    const c = db();
    const total = Number(tokensIn) + Number(tokensOut);
    const cost = estimateCents({ provider, tokensIn: Number(tokensIn), tokensOut: Number(tokensOut) });
    await c.query(
      `INSERT INTO ai_cost_events
         (application_id, document_id, op_name, provider, model,
          tokens_in, tokens_out, tokens_total, cost_cents, duration_ms, ok, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [applicationId || null, documentId || null, String(opName || 'ai').slice(0, 80),
       String(provider || '').slice(0, 40), model ? String(model).slice(0, 80) : null,
       Number(tokensIn) || 0, Number(tokensOut) || 0, total, cost,
       durationMs != null ? Number(durationMs) : null, !!ok, reason ? String(reason).slice(0, 300) : null]);
    return { cost_cents: cost };
  } catch (_) { return { cost_cents: 0 }; }
}

/** Per-file rollup — total spend + counts. */
async function fileSummary(appId, client) {
  const c = client || db();
  try {
    const r = await c.query(
      `SELECT COALESCE(SUM(cost_cents),0)::int AS cents,
              COUNT(*)::int AS n,
              COALESCE(SUM(tokens_total),0)::int AS tokens,
              MAX(created_at) AS last_at
         FROM ai_cost_events WHERE application_id=$1`, [appId]);
    const row = r.rows[0] || { cents: 0, n: 0, tokens: 0, last_at: null };
    const cap = PER_FILE_CAP_USD > 0 ? Math.round(PER_FILE_CAP_USD * 100) : null;
    return {
      cents: row.cents, usd: (row.cents / 100).toFixed(2), count: row.n, tokens: row.tokens,
      lastAt: row.last_at, capCents: cap,
      capUsd: cap != null ? PER_FILE_CAP_USD : null,
      remainingCents: cap != null ? Math.max(0, cap - row.cents) : null,
      overCap: cap != null ? row.cents >= cap : false,
    };
  } catch (_) { return { cents: 0, usd: '0.00', count: 0, tokens: 0, lastAt: null, capCents: null, capUsd: null, remainingCents: null, overCap: false }; }
}

/** Convenience for a caller that wants to gate spending. Returns true when a call is allowed. */
async function allowSpend(appId, client) {
  const s = await fileSummary(appId, client);
  return !s.overCap;
}

module.exports = { estimateCents, record, fileSummary, allowSpend, PER_FILE_CAP_USD };
