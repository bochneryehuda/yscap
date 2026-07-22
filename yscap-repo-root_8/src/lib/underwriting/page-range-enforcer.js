'use strict';
/**
 * R5.10 — Storage-boundary page-range enforcement (deterministic core, ADVISORY).
 *
 * After the splitter/adjudicator (R5.9) decides where each logical document
 * starts and ends, SOMETHING has to guarantee those boundaries map to REAL,
 * in-bounds, non-overlapping pages before a byte of the packet is sliced or
 * mirrored. If two documents claim the same page, or a range runs past the last
 * page of the file, a physical slice would silently produce a corrupt or
 * cross-contaminated sub-document (bank statement page bleeding into the title).
 * This module is that boundary check: it validates every logical document's page
 * range against the packet's true page count, flags OVERLAPS (a page owned by
 * two documents) and GAPS (a page owned by none), and emits a per-document SLICE
 * PLAN — physical (extract a real sub-PDF via pdf-slice) or virtual (a page-range
 * reference into the original) — that a caller can trust never reads out of bounds.
 *
 * Pure: no DB, no AI, no I/O — it plans/validates; pdf-slice.js does the actual
 * byte extraction from the plan. Advisory: it PRODUCES a plan + flags a human
 * reviews; it slices nothing and stores nothing itself. Never throws.
 */

const MODES = Object.freeze({ PHYSICAL: 'physical', VIRTUAL: 'virtual' });

// Normalize a document's page range to a sorted, de-duplicated list of 1-based
// integer page numbers, from either { pages:[n...] } or { start, end }.
function pagesOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.pages) && doc.pages.length) {
    return [...new Set(doc.pages.map(Number).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  }
  const s = Number(doc.start), e = Number(doc.end != null ? doc.end : doc.start);
  if (!Number.isInteger(s) || s < 1) return [];
  const end = Number.isInteger(e) && e >= s ? e : s;
  const out = [];
  for (let p = s; p <= end; p++) out.push(p);
  return out;
}

// Is a page list contiguous (no internal gap)? A non-contiguous document (e.g.
// pages 1,2,5) needs an explicit multi-range physical slice, not one span.
function isContiguous(pages) {
  for (let i = 1; i < pages.length; i++) if (pages[i] !== pages[i - 1] + 1) return false;
  return true;
}

// Collapse a sorted page list into contiguous [start,end] runs (the ranges a
// physical slicer actually cuts).
function toRuns(pages) {
  const runs = [];
  for (const p of pages) {
    const last = runs[runs.length - 1];
    if (last && p === last.end + 1) last.end = p;
    else runs.push({ start: p, end: p });
  }
  return runs;
}

/**
 * planSlices(documents, opts?) → {
 *   ok,                                        // true iff every plan is valid AND no overlaps
 *   plans: [{ id, pages, runs, start, end, pageCount, contiguous, mode, valid, reason }],
 *   coverage: { totalPages, assignedPages, gaps:[page], overlaps:[{ page, docs:[id] }],
 *               outOfBounds:[{ id, pages:[page] }] },
 * }
 *   documents: [{ id, pages:[n] | start,end, mode?, needsPhysical? }]
 *   opts: { totalPages?, defaultMode?:'virtual'|'physical' }
 * A range outside [1, totalPages] is INVALID (never sliced). Two documents sharing
 * a page is an OVERLAP (a page can't belong to two documents) → ok:false. A page
 * owned by no document is a GAP (advisory — a dropped page a human should place).
 * mode: a doc's explicit `mode`, else physical when `needsPhysical`, else the
 * opts.defaultMode (default 'virtual' — reference the original, don't duplicate bytes).
 */
function planSlices(documents, opts = {}) {
  const docs = Array.isArray(documents) ? documents.filter((d) => d && d.id != null) : [];
  const defaultMode = opts.defaultMode === MODES.PHYSICAL ? MODES.PHYSICAL : MODES.VIRTUAL;

  // Determine the packet's true page count: explicit, else the max page any
  // document references (so a bounds check is always possible).
  let maxSeen = 0;
  for (const d of docs) { const ps = pagesOf(d); if (ps.length) maxSeen = Math.max(maxSeen, ps[ps.length - 1]); }
  const totalPages = Number.isInteger(Number(opts.totalPages)) && Number(opts.totalPages) > 0
    ? Number(opts.totalPages) : maxSeen;

  // Ownership map for overlap/gap detection.
  const owners = new Map(); // page → [ids]
  const outOfBounds = [];
  const plans = [];

  for (const d of docs) {
    const allPages = pagesOf(d);
    const inBounds = allPages.filter((p) => p >= 1 && p <= totalPages);
    const oob = allPages.filter((p) => p < 1 || p > totalPages);
    if (oob.length) outOfBounds.push({ id: d.id, pages: oob });

    for (const p of inBounds) { const arr = owners.get(p) || []; arr.push(d.id); owners.set(p, arr); }

    const contiguous = isContiguous(allPages);
    const mode = d.mode === MODES.PHYSICAL || d.mode === MODES.VIRTUAL ? d.mode
      : (d.needsPhysical ? MODES.PHYSICAL : defaultMode);
    let valid = true, reason = 'in bounds';
    if (!allPages.length) { valid = false; reason = 'no valid pages'; }
    else if (oob.length) { valid = false; reason = `pages out of bounds (1..${totalPages}): ${oob.join(', ')}`; }

    plans.push({
      id: d.id,
      pages: allPages,
      runs: toRuns(inBounds),
      start: allPages.length ? allPages[0] : null,
      end: allPages.length ? allPages[allPages.length - 1] : null,
      pageCount: allPages.length,
      contiguous,
      mode,
      valid,
      reason,
    });
  }

  // Overlaps: any page owned by more than one document.
  const overlaps = [];
  for (const [page, ids] of owners) if (ids.length > 1) overlaps.push({ page, docs: [...new Set(ids)] });
  overlaps.sort((a, b) => a.page - b.page);

  // Gaps: an in-bounds page owned by nobody.
  const gaps = [];
  for (let p = 1; p <= totalPages; p++) if (!owners.has(p)) gaps.push(p);

  const assignedPages = owners.size;
  const ok = plans.every((p) => p.valid) && overlaps.length === 0;

  return {
    ok,
    plans,
    coverage: { totalPages, assignedPages, gaps, overlaps, outOfBounds },
  };
}

module.exports = { planSlices, MODES, _internals: { pagesOf, isContiguous, toRuns } };
