'use strict';
/**
 * P2 — Packet analyzer (deterministic core, ADVISORY).
 *
 * A borrower rarely uploads one clean document — they upload a COMBINED PDF: a
 * bank statement, then a driver's license, then a title commitment, with a blank
 * separator page and an upside-down scan in the middle. Every downstream feature
 * (extraction, conditions, findings) is poisoned if that packet isn't sorted
 * correctly first. This module is the deterministic BRAIN of the packet
 * pipeline: given the per-page features of an uploaded PDF it produces ONE
 * analysis — which pages are blank/rotated/unreadable, which consecutive pages
 * form ONE logical document, what each logical document IS (classification), a
 * suggested split plan, and which logical documents are DUPLICATES of each other.
 *
 * It composes the pure modules already built — page-quality (per-page verdicts),
 * continuation-group (logical grouping + auto-orient), and the deterministic
 * classifier — so it runs with NO trained Azure custom model, NO DB, NO AI. It
 * is the always-available fallback/complement to the Azure custom classifier.
 *
 * Pure + advisory: it SUGGESTS boundaries + classifications a human (and the
 * splitter) confirm. It never splits, rotates, dedupes, or files anything.
 */
const pageQuality = require('./page-quality');
const { groupPages } = require('./continuation-group');
const { classify } = require('./classify');

// Normalize a block of text for duplicate comparison: lowercase, collapse
// whitespace, drop non-alphanumerics. Two scans of the SAME document normalize
// to (nearly) the same string even with minor OCR noise.
function normText(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A cheap similarity: shared-token Jaccard over the normalized text. Enough to
// catch a duplicate scan / re-upload without an embedding model.
function similarity(a, b) {
  const ta = new Set(normText(a).split(' ').filter(Boolean));
  const tb = new Set(normText(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const DUP_SIMILARITY = 0.85; // ≥ this shared-token overlap → a likely duplicate

/**
 * analyzePacket(pages) → {
 *   pages:      [{ pageNumber, verdict, qualityScore, blankScore, docType }],
 *   logicalDocuments: [{ index, pages:[n], docType, confidence, reason, blank }],
 *   segments:   [{ docType, pages:[n], confidence }]      // split plan (non-blank groups with a type)
 *   separators: [n]                                       // blank separator pages
 *   orientPlan: [{ pageNumber, from, to }]                // pages to auto-rotate
 *   duplicates: [{ a, b, similarity }]                    // logical-doc index pairs that look duplicated
 *   summary:    { totalPages, logicalDocuments, distinctTypes, needsAttention, isCombined }
 * }
 *   pages: array in packet order; each { page_number?, text, ocr_status?, rotation?, ... }
 * Deterministic: same input → same analysis.
 */
function analyzePacket(pages) {
  const list = Array.isArray(pages) ? pages : [];

  // 1. Per-page quality (blank / rotated / unreadable / low-res / ok).
  const quality = pageQuality.assessPacket(list);
  const qByPage = {};
  quality.pages.forEach((p) => { qByPage[p.pageNumber] = p; });

  // 2. Logical grouping (continuation pages stay together; blanks separate) +
  // orient plan. The grouper keys off each page's page-quality verdict (a blank
  // ends a group; a rotated/upside-down page feeds the orient plan), so annotate
  // each page with the verdict computed above before grouping.
  const annotated = list.map((p, i) => {
    const pageNumber = p && p.page_number != null ? Number(p.page_number) : i + 1;
    const q = qByPage[pageNumber];
    return Object.assign({}, p, { verdict: (p && p.verdict) || (q && q.verdict) || undefined });
  });
  const grouped = groupPages(annotated);

  // Map a page number → its text (for per-group classification + dup detection).
  const textByPage = {};
  list.forEach((p, i) => { textByPage[p && p.page_number != null ? Number(p.page_number) : i + 1] = (p && typeof p.text === 'string') ? p.text : ''; });

  // 3. Classify each non-separator group from its combined text + any page docType hint.
  const logicalDocuments = grouped.groups.map((g, index) => {
    const isBlank = g.reason === 'separator';
    const combinedText = (g.pages || []).map((n) => textByPage[n] || '').join('\n');
    let docType = null, confidence = 0;
    if (!isBlank) {
      const c = classify({ text: combinedText });
      docType = c.docType;
      confidence = c.confidence === 'high' ? 0.9 : c.confidence === 'medium' ? 0.65 : c.docType ? 0.4 : 0;
    }
    return { index, pages: g.pages || [], docType, confidence, reason: g.reason, blank: isBlank };
  });

  // 4. Duplicate detection — non-blank logical docs whose text is ~identical.
  const duplicates = [];
  const nonBlank = logicalDocuments.filter((d) => !d.blank);
  for (let i = 0; i < nonBlank.length; i++) {
    for (let j = i + 1; j < nonBlank.length; j++) {
      const a = nonBlank[i], b = nonBlank[j];
      const ta = a.pages.map((n) => textByPage[n] || '').join('\n');
      const tb = b.pages.map((n) => textByPage[n] || '').join('\n');
      const sim = similarity(ta, tb);
      if (sim >= DUP_SIMILARITY) duplicates.push({ a: a.index, b: b.index, similarity: +sim.toFixed(3) });
    }
  }

  // 5. Split plan = the non-blank groups that got a type (what the splitter would file).
  const segments = logicalDocuments
    .filter((d) => !d.blank && d.docType)
    .map((d) => ({ docType: d.docType, pages: d.pages, confidence: d.confidence }));

  const separators = logicalDocuments.filter((d) => d.blank).flatMap((d) => d.pages);
  const distinctTypes = new Set(segments.map((s) => s.docType));

  return {
    pages: quality.pages.map((p) => ({
      pageNumber: p.pageNumber, verdict: p.verdict, qualityScore: p.qualityScore, blankScore: p.blankScore,
      docType: (logicalDocuments.find((d) => d.pages.includes(p.pageNumber)) || {}).docType || null,
    })),
    logicalDocuments,
    segments,
    separators,
    orientPlan: grouped.orientPlan || [],
    duplicates,
    summary: {
      totalPages: list.length,
      logicalDocuments: logicalDocuments.filter((d) => !d.blank).length,
      distinctTypes: distinctTypes.size,
      needsAttention: quality.summary.needsAttention,
      // A "combined PDF" worth splitting = 2+ distinct document types detected.
      isCombined: distinctTypes.size >= 2,
    },
  };
}

module.exports = { analyzePacket, similarity, _internals: { normText, DUP_SIMILARITY } };
