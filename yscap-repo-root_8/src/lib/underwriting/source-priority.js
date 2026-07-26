'use strict';
/**
 * R6.2 — Source-of-truth hierarchy + discrepancy-emitting resolver.
 *
 * When two systems disagree about a loan-structure fact, the engine must NOT
 * silently choose one. It applies a DECLARED governing-source order and emits a
 * discrepancy so a human sees the conflict. This module owns that order + the
 * resolve() that returns the governing value AND any discrepancy.
 *
 * Order (owner/review-directed, highest authority first):
 *   1 registration      the current approved product registration (the exact
 *                       structure being underwritten)
 *   2 pricing_engine    the deterministic Standard/Gold/Manual engine io
 *   3 application       staff/borrower-entered transaction facts
 *   4 appraisal         the current imported appraisal XML
 *   5 document          the current governing documents (contract/title/etc.)
 *   6 encompass         the reconciled LOS copy (read-only)
 *   7 clickup           the reconciled workflow copy
 *   8 sharepoint        the controlled document mirror
 *
 * Pure: no DB, no AI. Consumes provenance-wrapped facts (provenance.js).
 */

const prov = require('./provenance');

const ORDER = Object.freeze([
  'registration', 'pricing_engine', 'application', 'appraisal',
  'document', 'encompass', 'clickup', 'sharepoint',
]);
const RANK = ORDER.reduce((m, s, i) => { m[s] = i; return m; }, {});

function rankOf(source) {
  return Object.prototype.hasOwnProperty.call(RANK, source) ? RANK[source] : ORDER.length; // unknown = lowest
}

// Are two present values equal after light normalization (numbers within a cent;
// strings case/space-insensitive)? Used to decide whether a disagreement is real.
function valuesAgree(a, b) {
  if (a === b) return true;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 0.005;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * resolve(fieldKey, candidates) → { value, governingSource, chosen, discrepancy }
 *   candidates: array of provenance-wrapped facts (each with a .source).
 * Picks the highest-authority PRESENT candidate as governing. If a LOWER- or
 * equal-authority present candidate disagrees with it, emits a discrepancy
 * (never silently drops the disagreement). Absent candidates are ignored.
 */
function resolve(fieldKey, candidates) {
  const present = (candidates || []).filter((c) => prov.isPresent(c));
  if (!present.length) {
    return { value: null, governingSource: null, chosen: null, discrepancy: null };
  }
  // Highest authority (lowest rank) wins; ties broken by confidence.
  present.sort((a, b) => {
    const r = rankOf(a.source) - rankOf(b.source);
    if (r !== 0) return r;
    return prov.moreConfident(a, b) ? -1 : 1;
  });
  const chosen = present[0];
  // Any OTHER present candidate that disagrees is a discrepancy.
  const disagreeing = present.slice(1).filter((c) => !valuesAgree(c.value, chosen.value));
  const discrepancy = disagreeing.length ? {
    field: fieldKey,
    governing: { source: chosen.source, value: chosen.value, sourceId: chosen.sourceId || null },
    conflicts: disagreeing.map((c) => ({ source: c.source, value: c.value, sourceId: c.sourceId || null })),
  } : null;
  return { value: chosen.value, governingSource: chosen.source, chosen, discrepancy };
}

// Resolve a whole map {field: [candidates]} → { values, discrepancies }.
function resolveAll(byField) {
  const values = {};
  const discrepancies = [];
  for (const [field, cands] of Object.entries(byField || {})) {
    const r = resolve(field, cands);
    values[field] = r;
    if (r.discrepancy) discrepancies.push(r.discrepancy);
  }
  return { values, discrepancies };
}

module.exports = { ORDER, RANK, rankOf, valuesAgree, resolve, resolveAll };
