'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-4: version resolution + canonical fact selection.
 *
 * The Stage-5 evidence ledger (document_pipeline_evidence, src/pipeline/evidence-candidate.js) holds
 * many EvidenceCandidates for the same fact — the account holder read off page 2 of one bank
 * statement, the same holder read again off a newer statement, a coverage amount from two vendors,
 * etc. This module answers the next question: for each fact, WHICH single value is the canonical,
 * most-trusted one right now, and WHY? That is:
 *   - "version resolution": a candidate explicitly marked `superseded` (by evidence-candidate.supersede,
 *     i.e. replaced by a newer reading of the same fact) is DROPPED from selection; among the rest a
 *     newer reading (by createdAt) wins ties, so a newer document version's value floats to the top.
 *   - "canonical fact selection": the best-trusted live candidate becomes the verified fact.
 *
 * PURE + never-throws. It READS candidates only; it records NO decision, clears NO condition, touches
 * NO frozen number and NO borrower surface. It is the shadow "verified facts" view — advisory, exactly
 * like the ledger it reads.
 *
 * Selection order per fact (strongest first):
 *   1. verification STATUS rank — manual_verified > verified > partially_verified > unverified >
 *      contradicted  (a `superseded` candidate is excluded before ranking).
 *   2. CONFIDENCE — higher wins.
 *   3. RECENCY — the newer candidate (createdAt) wins.
 */

// Status trust rank (higher = more trusted). `superseded` is intentionally absent — such a candidate
// is excluded from selection entirely. An unknown status ranks lowest (0).
const STATUS_RANK = Object.freeze({
  manual_verified: 5,
  verified: 4,
  partially_verified: 3,
  unverified: 2,
  contradicted: 1,
});

function rankOf(status) { return STATUS_RANK[status] || 0; }
function numOr(v, d) { return (typeof v === 'number' && Number.isFinite(v)) ? v : d; }

// Parse a createdAt (Date | ISO string | epoch) into a comparable number; unknown → 0 (oldest).
function timeOf(v) {
  if (v == null) return 0;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : 0; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

// The value a candidate carries, tolerating both the ledger shape (valueText) and a raw {value}.
function candValue(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.valueText != null) return c.valueText;
  if (c.value != null) return c.value;
  return null;
}

// The grouping key for "the same fact". Scoped by documentFamily so the "document_type" fact of a
// bank statement is not merged with an insurance binder's. fieldKey is already normalized upstream.
function factKey(c) {
  const fam = (c && c.family != null) ? String(c.family) : '';
  const key = (c && c.fieldKey != null) ? String(c.fieldKey) : '';
  return fam + '\u0000' + key;
}

// Local value-normalizer for the "contested" check — mirrors evidence-candidate.normValue so the two
// modules agree on what counts as the same value. Kept local so this module stays dependency-free.
function normValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  const s = String(v).trim();
  if (!s) return null;
  const money = s.replace(/[$,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(money)) return String(parseFloat(money));
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

// Is candidate A strictly better than B by the selection order? (status → confidence → recency)
function betterThan(a, b) {
  const ra = rankOf(a.status), rb = rankOf(b.status);
  if (ra !== rb) return ra > rb;
  const ca = numOr(a.confidence, -1), cb = numOr(b.confidence, -1);
  if (ca !== cb) return ca > cb;
  return timeOf(a.createdAt) > timeOf(b.createdAt);
}

/**
 * PURE — select the canonical value for every fact from a list of evidence candidates.
 * @param {Array} candidates  rows shaped like evidence-candidate.listCandidates().candidates
 * @param {object} opts        { includeAlternatives?:boolean (default true), maxFacts?:number (default 500) }
 * @returns {{ facts: Array, totalCandidates:number, consideredCandidates:number, supersededDropped:number,
 *             factCount:number, contestedCount:number }}
 *   each fact: { fieldKey, fieldLabel, family, value, status, confidence, provider, service,
 *                documentId, pageNumber, evidenceSpan, candidateId, contested, alternativesCount,
 *                alternatives?:[{candidateId, value, status, confidence, provider, documentId, pageNumber}] }
 */
function selectCanonicalFacts(candidates, opts = {}) {
  const includeAlternatives = opts.includeAlternatives !== false;
  const maxFacts = numOr(opts.maxFacts, 500);
  const out = {
    facts: [], totalCandidates: 0, consideredCandidates: 0, supersededDropped: 0,
    factCount: 0, contestedCount: 0,
  };
  try {
    const list = Array.isArray(candidates) ? candidates : [];
    out.totalCandidates = list.length;
    const groups = new Map();
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      // Version resolution: an explicitly-superseded candidate never competes.
      if (c.status === 'superseded') { out.supersededDropped++; continue; }
      if (!c.fieldKey) continue;                       // no fact identity → skip
      const key = factKey(c);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
      out.consideredCandidates++;
    }

    for (const group of groups.values()) {
      if (out.facts.length >= maxFacts) break;
      let best = null;
      for (const c of group) { if (!best || betterThan(c, best)) best = c; }
      if (!best) continue;
      // "contested" = at least one OTHER candidate in the group read a different value than the
      // winner (a genuine disagreement a reviewer should see), or the winner is itself contradicted.
      const winnerVal = normValue(candValue(best));
      let contested = best.status === 'contradicted';
      if (!contested) {
        for (const c of group) {
          if (c === best) continue;
          const v = normValue(candValue(c));
          if (v != null && winnerVal != null && v !== winnerVal) { contested = true; break; }
        }
      }
      const fact = {
        fieldKey: best.fieldKey || null,
        fieldLabel: best.fieldLabel || best.fieldKey || null,
        family: best.family || null,
        value: candValue(best),
        status: best.status || 'unverified',
        confidence: numOr(best.confidence, null),
        provider: best.provider || null,
        service: best.service || null,
        documentId: best.documentId || null,
        pageNumber: (best.pageNumber == null ? null : Number(best.pageNumber)),
        evidenceSpan: best.evidenceSpan || {},
        candidateId: best.id || null,
        contested,
        alternativesCount: group.length - 1,
      };
      if (includeAlternatives && group.length > 1) {
        fact.alternatives = group
          .filter((c) => c !== best)
          .slice(0, 20)
          .map((c) => ({
            candidateId: c.id || null,
            value: candValue(c),
            status: c.status || null,
            confidence: numOr(c.confidence, null),
            provider: c.provider || null,
            documentId: c.documentId || null,
            pageNumber: (c.pageNumber == null ? null : Number(c.pageNumber)),
          }));
      }
      if (contested) out.contestedCount++;
      out.facts.push(fact);
    }
    // Deterministic ordering for a stable UI: contested first, then by fieldKey.
    out.facts.sort((a, b) => {
      if (a.contested !== b.contested) return a.contested ? -1 : 1;
      return String(a.fieldKey || '').localeCompare(String(b.fieldKey || ''));
    });
    out.factCount = out.facts.length;
  } catch (_e) { /* pure + never throws — return whatever we resolved so far */ }
  return out;
}

/**
 * Best-effort DB reader: list a loan's evidence candidates then select the canonical facts across
 * every document + version. NEVER throws → an empty result on any error. Advisory read-only.
 */
async function canonicalFactsForLoan(db, loanId, opts = {}) {
  try {
    if (!db || typeof db.query !== 'function' || !loanId) return selectCanonicalFacts([], opts);
    const ec = require('./evidence-candidate');
    const { candidates } = await ec.listCandidates(db, { loanId, limit: opts.limit || 500 });
    return selectCanonicalFacts(candidates, opts);
  } catch (_e) {
    return selectCanonicalFacts([], opts);
  }
}

module.exports = {
  selectCanonicalFacts,
  canonicalFactsForLoan,
  _internals: { STATUS_RANK, rankOf, betterThan, factKey, timeOf, normValue, candValue },
};
