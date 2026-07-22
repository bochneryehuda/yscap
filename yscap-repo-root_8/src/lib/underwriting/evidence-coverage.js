'use strict';
/**
 * R5.18 — Evidence coverage metrics + citation validation.
 *
 * The review's principle (P0-B): no material fact should be "verified" without
 * durable evidence, and no model output may cite a span that doesn't exist.
 * This module scores a file's provenance completeness and validates citations
 * against the real span set — the pure companion to the DB-level guard in
 * evidence-ledger.assertSpanExists.
 *
 * Pure: no DB, no AI. The caller loads facts + their evidence links + the known
 * span-id set and passes them in.
 */

// A fact is "materially cited" only when it has at least one DIRECT (or
// authoritative api/guideline) evidence link — a corroborating/derived link
// alone is not enough to call a critical fact verified.
const DIRECT_SUPPORT = new Set(['direct', 'api_response', 'guideline_citation']);

/**
 * coverage(facts, links) →
 *   facts: [{ key, material?:bool }]
 *   links: [{ factKey, supportType }]
 * Returns { materialCount, citedCount, uncitedMaterial:[keys], coveragePct }.
 * coveragePct is over MATERIAL facts only (the ones that must be cited).
 */
function coverage(facts, links) {
  const byFact = new Map();
  for (const l of (links || [])) {
    if (!l || l.factKey == null) continue;
    const k = String(l.factKey);
    if (!byFact.has(k)) byFact.set(k, new Set());
    byFact.get(k).add(l.supportType || 'direct');
  }
  const material = (facts || []).filter((f) => f && f.material);
  const uncitedMaterial = [];
  let cited = 0;
  for (const f of material) {
    const supports = byFact.get(String(f.key));
    const hasDirect = supports && Array.from(supports).some((s) => DIRECT_SUPPORT.has(s));
    if (hasDirect) cited++; else uncitedMaterial.push(f.key);
  }
  const materialCount = material.length;
  return {
    materialCount,
    citedCount: cited,
    uncitedMaterial,
    coveragePct: materialCount ? Math.round((cited / materialCount) * 1000) / 10 : 100,
  };
}

/**
 * validateCitations(citedSpanIds, knownSpanIds) → { ok, unknown:[] }.
 * Any cited id not in the known set is a hallucinated citation — rejected.
 */
function validateCitations(citedSpanIds, knownSpanIds) {
  const known = knownSpanIds instanceof Set ? knownSpanIds : new Set(knownSpanIds || []);
  const unknown = [];
  for (const id of (citedSpanIds || [])) {
    if (!known.has(id)) unknown.push(id);
  }
  return { ok: unknown.length === 0, unknown };
}

// A material fact that is not directly cited must be reported as
// unable_to_determine rather than verified (the review's rule). Helper that
// turns a coverage result into the per-fact verification-eligibility map.
function verifiability(facts, links) {
  const cov = coverage(facts, links);
  const uncited = new Set(cov.uncitedMaterial.map(String));
  const out = {};
  for (const f of (facts || [])) {
    if (!f || f.key == null) continue;
    if (!f.material) { out[f.key] = 'not_material'; continue; }
    out[f.key] = uncited.has(String(f.key)) ? 'unable_to_determine' : 'verifiable';
  }
  return out;
}

module.exports = { coverage, validateCitations, verifiability, DIRECT_SUPPORT };
