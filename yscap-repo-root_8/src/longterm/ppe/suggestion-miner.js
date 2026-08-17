'use strict';
/**
 * LT PPE — the suggestion MINER (Part 3 P2). The thin glue that turns a Lender Price disqualified
 * result into persisted per-investor rule suggestions: analyzeDisqualifications (P-DQ) →
 * rule-store.saveSuggestions (P5-store). `db` is a pg pool/client.
 *
 * WHY (owner-directed 2026-08-17): "look at an actual disqualifying scenario … the manual review engine
 * should suggest rules that we should add so our system exactly matches Lender Price." This is what a
 * deliberate "mine suggestions from this disqualifying scenario" action runs. It is BEST-EFFORT and
 * never throws — mining suggestions must never break the disqualify flow it rides on — and it writes
 * only PROPOSALS (rule-store dedups + never reopens a decided one; a human accepts).
 *
 * LT-only. No RTL imports.
 */

const { analyzeDisqualifications } = require('./disqualify-analysis');
const ruleStore = require('./rule-store');

/**
 * Mine + save suggestions from an ALREADY-PARSED Lender Price disqualified result
 * (client.parseDisqualified(raw) output). Returns:
 *   { ok, saved, investorCount, suggestionCount, unmappedCount, investors:[{investor, suggestions, unmapped}], error? }
 * Never throws: a failure returns { ok:false, error }.
 */
async function mineFromParsed(db, scope, parsedDisq) {
  try {
    const analysis = analyzeDisqualifications(parsedDisq);
    if (!analysis.ready || !analysis.investors.length) {
      return { ok: true, saved: 0, investorCount: 0, suggestionCount: 0, unmappedCount: 0, investors: [], note: 'no disqualifications to mine' };
    }
    const res = await ruleStore.saveSuggestions(db, scope, analysis);
    return {
      ok: true,
      saved: res.saved,
      investorCount: analysis.summary.investorCount,
      suggestionCount: analysis.summary.suggestionCount,
      unmappedCount: analysis.summary.unmappedCount,
      // a compact per-investor view (counts only) so a caller can report without re-querying
      investors: analysis.investors.map((i) => ({ investor: i.investor, suggestions: i.suggestions.length, unmapped: i.unmapped.length })),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { mineFromParsed };
