'use strict';
/**
 * R5.55 / R5.56 — Underwriting Memory.
 *
 * The owner's stated industry-beating differentiator: turn every funded loan
 * into institutional knowledge — "we've funded N loans; THIS one is X% similar
 * to K of them, which averaged … conditions, … LTV, investor …". Not prompt
 * memory — MORTGAGE memory over the file's own attributes.
 *
 * This module is deterministic attribute similarity (no embeddings, no AI): a
 * weighted match over program / loan type / property type / LTV band / loan-size
 * band. The pure scorer is unit-tested; the DB side loads funded peers and
 * aggregates the matches. It reads only — it never changes a file.
 */

const num = (n) => (n == null || isNaN(Number(n)) ? null : Number(n));
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Weights sum to 10; the score is the matched weight / 10, as a 0..1 fraction.
const W = { program: 3, loanType: 2, propertyType: 2, ltvBand: 2, sizeBand: 1 };

// LTV = loan / value (as-is preferred, else ARV). Null when no value on file.
function ltvOf(a) {
  const loan = num(a.loan_amount);
  const val = num(a.as_is_value) != null ? num(a.as_is_value) : num(a.arv);
  if (loan == null || val == null || val <= 0) return null;
  return loan / val;
}

/**
 * Similarity of a peer loan to the subject loan, 0..1. Pure.
 * @param {object} subject  { program, loan_type, property_type, loan_amount, as_is_value, arv }
 * @param {object} peer     same shape
 * @returns {{score:number, matched:string[]}}
 */
function scoreSimilarity(subject, peer) {
  let got = 0;
  const matched = [];
  if (norm(subject.program) && norm(subject.program) === norm(peer.program)) { got += W.program; matched.push('program'); }
  if (norm(subject.loan_type) && norm(subject.loan_type) === norm(peer.loan_type)) { got += W.loanType; matched.push('loan_type'); }
  if (norm(subject.property_type) && norm(subject.property_type) === norm(peer.property_type)) { got += W.propertyType; matched.push('property_type'); }
  const sLtv = ltvOf(subject), pLtv = ltvOf(peer);
  if (sLtv != null && pLtv != null && Math.abs(sLtv - pLtv) <= 0.10) { got += W.ltvBand; matched.push('ltv'); }
  const sAmt = num(subject.loan_amount), pAmt = num(peer.loan_amount);
  if (sAmt != null && pAmt != null && sAmt > 0 && Math.abs(sAmt - pAmt) / sAmt <= 0.30) { got += W.sizeBand; matched.push('loan_size'); }
  return { score: got / 10, matched };
}

/**
 * Aggregate a set of scored peers into the memory summary. Pure.
 * @param {Array<{app, score, conditionCount?, lender?}>} scored
 */
function summarizePeers(scored) {
  if (!scored || !scored.length) return null;
  const amts = [], ltvs = [], conds = [];
  const investors = new Map();
  for (const s of scored) {
    const a = s.app || {};
    const amt = num(a.loan_amount); if (amt != null) amts.push(amt);
    const l = ltvOf(a); if (l != null) ltvs.push(l);
    if (s.conditionCount != null) conds.push(Number(s.conditionCount));
    const inv = norm(s.lender || a.lender);
    if (inv) investors.set(inv, (investors.get(inv) || 0) + 1);
  }
  const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
  let topInvestor = null, topN = 0;
  for (const [k, n] of investors) if (n > topN) { topInvestor = k; topN = n; }
  return {
    count: scored.length,
    avgLoanAmount: avg(amts) != null ? Math.round(avg(amts)) : null,
    avgLtvPct: avg(ltvs) != null ? Math.round(avg(ltvs) * 1000) / 10 : null,
    avgConditions: avg(conds) != null ? Math.round(avg(conds) * 10) / 10 : null,
    topInvestor: topInvestor ? { label: topInvestor, count: topN } : null,
    bestMatchPct: Math.round(Math.max(...scored.map((s) => s.score)) * 100),
  };
}

/**
 * Impure: find funded peers similar to a file + aggregate. Best-effort, never throws.
 * Only funded, non-deleted files are considered; the subject file is excluded.
 * `minScore` (default 0.5) keeps only genuinely-similar peers.
 */
async function findSimilarFunded(client, appId, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.5;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 25;
  try {
    const subjR = await client.query(
      `SELECT id, program, loan_type, property_type, loan_amount, as_is_value, arv, lender FROM applications WHERE id=$1`, [appId]);
    const subject = subjR.rows[0];
    if (!subject) return null;
    const peersR = await client.query(
      `SELECT a.id, a.program, a.loan_type, a.property_type, a.loan_amount, a.as_is_value, a.arv, a.lender,
              (SELECT COUNT(*) FROM checklist_items ci WHERE ci.application_id = a.id)::int AS condition_count
         FROM applications a
        WHERE a.status = 'funded' AND a.deleted_at IS NULL AND a.id <> $1
        LIMIT 2000`, [appId]);
    const scored = [];
    for (const p of peersR.rows) {
      const { score, matched } = scoreSimilarity(subject, p);
      if (score >= minScore) scored.push({ app: p, score, matched, conditionCount: p.condition_count, lender: p.lender });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    return {
      subjectHasAttributes: !!(norm(subject.program) || norm(subject.loan_type)),
      totalFunded: peersR.rows.length,
      similar: top.map((s) => ({ score: Math.round(s.score * 100), matched: s.matched, conditionCount: s.conditionCount })),
      summary: summarizePeers(top),
    };
  } catch (_) { return null; }
}

module.exports = { scoreSimilarity, summarizePeers, findSimilarFunded, _internals: { ltvOf } };
