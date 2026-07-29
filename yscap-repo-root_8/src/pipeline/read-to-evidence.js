'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-3: turn a real READ into evidence candidates
 * WITH page-level provenance.
 *
 * A ProviderResult (src/pipeline/provider-adapter.js) carries what a reader produced: the document
 * TYPE + confidence, the classifier SEGMENTS (per-page-range type boundaries), and — once an
 * extractor is wired — structured FIELDS. This PURE mapper converts those into the row shape the
 * Stage-5 evidence ledger (evidence-candidate.recordCandidate) accepts, stamping each with the
 * PAGE it was read from and a structured `evidenceSpan` so a staff member can click a fact and see
 * exactly where on the document it came from.
 *
 * NEVER-FABRICATE + never-throws: a value with no page yields pageNumber:null (not a guessed 1);
 * an empty/garbage result yields []. It produces evidence CANDIDATES only — it makes no decision,
 * clears no condition, and (like the whole ledger) is advisory. Field-level agreement/verification
 * is the reconciler's job (evidence-candidate.reconcileStatus), not this mapper's.
 */

function str(v) { return (v == null) ? '' : String(v); }
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function firstArr(v) { return Array.isArray(v) ? v : []; }
function posInt(v) { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0) ? n : null; }

// A hard cap so a pathological read can never flood the ledger with candidates.
const MAX_CANDIDATES = 200;

// Best-effort: which 1-based page did an extractor FIELD come from? Readers differ, so try the
// common shapes (a flat page/pageNumber, or the first bounding region's page). null when unknown.
function fieldPage(field) {
  if (!field || typeof field !== 'object') return null;
  const flat = posInt(field.page != null ? field.page : field.pageNumber);
  if (flat != null) return flat;
  const regions = firstArr(field.boundingRegions);
  for (const r of regions) {
    const p = posInt(r && (r.pageNumber != null ? r.pageNumber : r.page));
    if (p != null) return p;
  }
  return null;
}

// The bounding polygon of a field's first region, if the reader returned one (for "highlight the
// exact spot"). Kept opaque — we don't interpret it, just carry it as provenance.
function fieldPolygon(field) {
  const regions = firstArr(field && field.boundingRegions);
  const r0 = regions[0];
  return (r0 && Array.isArray(r0.polygon)) ? r0.polygon : null;
}

// A field's value in normalized string form (readers use value / content / valueString).
function fieldValueText(field) {
  if (!field || typeof field !== 'object') return null;
  const v = (field.value != null) ? field.value
    : (field.content != null) ? field.content
    : (field.valueString != null) ? field.valueString : null;
  return (v == null) ? null : String(v);
}

// A field's canonical key (key / name / label), lowercased+underscored for a stable fact name.
function fieldKeyOf(field) {
  const raw = str(field && (field.key != null ? field.key : (field.name != null ? field.name : field.label))).trim();
  if (!raw) return '';
  return raw.toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * PURE — map a normalized ProviderResult into evidence-candidate rows (the shape recordCandidate
 * accepts). Returns [] when the read produced nothing usable. Never throws.
 *
 * @param {object} result  a normalized ProviderResult ({ documentType, confidence, segments, fields, provider, service })
 * @param {object} ctx     { jobId, documentId, loanId, family }
 */
function readToEvidence(result, ctx = {}) {
  const out = [];
  try {
    const r = result || {};
    const base = {
      jobId: ctx.jobId || null,
      documentId: ctx.documentId || null,
      loanId: ctx.loanId || null,
      documentFamily: ctx.family || str(r.documentType) || null,
      provider: str(r.provider) || null,
      service: str(r.service) || null,
    };

    // 1) The document TYPE the read decided — provenance = the highest-confidence segment's pages.
    const segments = firstArr(r.segments);
    const docType = str(r.documentType);
    if (docType) {
      let topSeg = null;
      for (const s of segments) {
        if (!topSeg || (num(s && s.confidence) || 0) > (num(topSeg.confidence) || 0)) topSeg = s;
      }
      const segPages = firstArr(topSeg && topSeg.pages).map(posInt).filter((p) => p != null);
      out.push({
        ...base,
        fieldKey: 'document_type',
        fieldLabel: 'Document type',
        valueText: docType,
        confidence: num(r.confidence),
        pageNumber: segPages.length ? segPages[0] : null,
        evidenceSpan: { source: 'classifier', pages: segPages },
        valueJson: { segments: segments.length },
      });
    }

    // 2) Every extractor FIELD — the real facts, each stamped with the page it was read from.
    for (const field of firstArr(r.fields)) {
      if (out.length >= MAX_CANDIDATES) break;
      const key = fieldKeyOf(field);
      const valueText = fieldValueText(field);
      if (!key || valueText == null || valueText === '') continue;   // never record an empty fact
      const page = fieldPage(field);
      const polygon = fieldPolygon(field);
      out.push({
        ...base,
        fieldKey: key,
        fieldLabel: str(field.label || field.name || key) || key,
        valueText,
        confidence: num(field.confidence),
        pageNumber: page,
        evidenceSpan: { source: 'field', page, polygon },
      });
    }
  } catch (_e) { /* pure + never throws — a bad shape yields whatever we mapped so far */ }
  return out.slice(0, MAX_CANDIDATES);
}

module.exports = { readToEvidence, _internals: { fieldPage, fieldPolygon, fieldValueText, fieldKeyOf, MAX_CANDIDATES } };
