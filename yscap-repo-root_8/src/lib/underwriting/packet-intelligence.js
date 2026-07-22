'use strict';
/**
 * R5.57 — Packet intelligence orchestrator (deterministic core, ADVISORY).
 *
 * A borrower uploads ONE combined PDF — a "packet" — with a bank statement, a title
 * commitment, an appraisal, a note, all stacked together, some pages blank, some
 * sideways, some scanned twice. Several pure modules already each answer ONE
 * question about that packet:
 *   • page-quality        which pages are blank / rotated / low-res / unreadable
 *   • page-fingerprint    which pages are exact/near DUPLICATES (dedupe)
 *   • continuation-group  which consecutive pages STACK into one logical document
 *                         (+ an auto-orient plan for sideways pages)
 *   • page-range-enforcer whether the proposed document boundaries are in-bounds/
 *                         non-overlapping (coverage + gaps)
 *
 * This module RUNS them together on one packet and folds their outputs into a single
 * advisory report — a normalized issue list (blank / rotated / unreadable / duplicate
 * / gap) + plain recommendations (dedupe these, auto-orient page N, re-scan page M,
 * a human should place the unassigned pages) — so a reviewer sees the whole packet's
 * health in one place instead of four.
 *
 * Pure: no DB, no AI, no I/O — it orchestrates the sibling pure modules and
 * summarizes. Advisory: it PLANS + FLAGS; it splits nothing, rotates nothing,
 * deletes no duplicate, files nothing. Never throws (every sub-call is guarded).
 */

const quality = require('./page-quality');
const fingerprint = require('./page-fingerprint');
const continuation = require('./continuation-group');
const rangeEnforcer = require('./page-range-enforcer');

function safe(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch (_e) { return fallback; } }

/**
 * analyzePacket(pages, opts?) → {
 *   totalPages,
 *   quality: { summary, pages },              // page-quality rollup
 *   duplicates: { clusters, duplicatePageCount, uniquePageCount },
 *   documents: { groups, count },             // continuation-group stacking
 *   orientPlan: [{ pageNumber, from, to }],   // sideways/upside-down → upright
 *   coverage: { totalPages, gaps, overlaps } | null,   // only when opts.documents given
 *   issues: [{ kind, severity, pages:[n], advice }],   // normalized, one list
 *   recommendations: [string],
 *   needsReview: bool,                        // any non-advisory (blocking) issue
 * }
 *   pages: [{ page_number?, text?|ocrText?, rotation?, dpi?, widthPx?, heightPx?,
 *             imageHash?, verdict? }]   (verdict is computed here if absent)
 *   opts: { documents?: [{ id, pages|start,end }], totalPages? }  // to also run the
 *          boundary/coverage check against a proposed split.
 * Runs page-quality, then feeds the verdict-enriched pages to continuation-group +
 * page-fingerprint, and (when a proposed split is supplied) the range enforcer.
 * Never throws.
 */
function analyzePacket(pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const o = opts && typeof opts === 'object' ? opts : {};

  // 1. QUALITY — verdict per page + rollup.
  const q = safe(() => quality.assessPacket(list), { pages: [], summary: {} });
  const qPages = Array.isArray(q.pages) ? q.pages : [];
  // page number for a row: the assessed pageNumber, else 1-indexed position.
  const pageNumAt = (i) => (qPages[i] && qPages[i].pageNumber != null ? qPages[i].pageNumber : i + 1);

  // 2. enrich each source page with its computed verdict so continuation-group can
  //    see blanks/rotations (it reads p.verdict) without the caller pre-computing it.
  const enriched = list.map((p, i) => Object.assign({}, p, {
    verdict: (p && p.verdict) || (qPages[i] && qPages[i].verdict) || 'ok',
    rotation: p && p.rotation != null ? p.rotation : (qPages[i] && qPages[i].rotation),
    page_number: p && p.page_number != null ? p.page_number : pageNumAt(i),
  }));

  // 3. STACKING + auto-orient.
  const grp = safe(() => continuation.groupPages(enriched), { groups: [], orientPlan: [] });
  const groups = Array.isArray(grp.groups) ? grp.groups : [];
  const orientPlan = Array.isArray(grp.orientPlan) ? grp.orientPlan : [];

  // 4. DUPLICATES.
  const dup = safe(() => fingerprint.groupDuplicates(enriched), { clusters: [], duplicatePageCount: 0, uniquePageCount: list.length });
  const clusters = Array.isArray(dup.clusters) ? dup.clusters : [];

  // 5. optional BOUNDARY/COVERAGE check against a proposed split.
  let coverage = null;
  if (Array.isArray(o.documents)) {
    const plan = safe(() => rangeEnforcer.planSlices(o.documents, { totalPages: o.totalPages != null ? o.totalPages : list.length }), null);
    if (plan && plan.coverage) {
      const cov = plan.coverage;
      // an interior gap AND a trailing-unassigned tail are both "pages no document
      // claims" — fold the trailing range into the gap page list (bounded/summarized
      // by the enforcer so a huge tail is a {from,to} range, never enumerated here).
      const tail = cov.trailingUnassigned;
      const gaps = (cov.gaps || []).slice();
      let trailingUnassigned = null;
      if (tail && tail.from != null && tail.to != null) {
        trailingUnassigned = { from: tail.from, to: tail.to, count: tail.count };
        // enumerate the tail into the gap list only when it's small (avoid blowing up
        // on an absurd totalPages — the enforcer already summarized it).
        if (tail.count > 0 && tail.count <= 50) for (let p = tail.from; p <= tail.to; p++) gaps.push(p);
      }
      coverage = { totalPages: cov.totalPages, gaps, trailingUnassigned, overlaps: cov.overlaps || [], ok: !!plan.ok };
    }
  }

  // --- fold everything into ONE normalized issue list + recommendations ---
  const issues = [];
  const recs = [];
  const sum = q.summary || {};
  const pagesWith = (v) => qPages.filter((p) => p.verdict === v).map((p) => p.pageNumber);

  const unreadable = pagesWith('unreadable');
  if (unreadable.length) { issues.push({ kind: 'unreadable', severity: 'blocking', pages: unreadable, advice: 'These pages could not be read — request a clean re-scan.' }); recs.push(`Re-scan ${unreadable.length} unreadable page(s): ${unreadable.join(', ')}.`); }
  const locked = pagesWith('password_protected');
  if (locked.length) { issues.push({ kind: 'password_protected', severity: 'blocking', pages: locked, advice: 'These pages are password-protected — request an unlocked copy.' }); recs.push(`Request an unlocked copy for page(s): ${locked.join(', ')}.`); }
  const rotated = pagesWith('rotated').concat(pagesWith('upside_down')).sort((a, b) => a - b);
  if (rotated.length) { issues.push({ kind: 'rotated', severity: 'advisory', pages: rotated, advice: 'These pages are sideways/upside-down — auto-orient before review.' }); recs.push(`Auto-orient ${rotated.length} page(s): ${rotated.join(', ')}.`); }
  const lowRes = pagesWith('low_res');
  if (lowRes.length) { issues.push({ kind: 'low_res', severity: 'advisory', pages: lowRes, advice: 'Low resolution — extraction may be unreliable.' }); }
  const blank = pagesWith('blank');
  if (blank.length) { issues.push({ kind: 'blank', severity: 'advisory', pages: blank, advice: 'Blank/separator pages — usually safe to drop.' }); }

  for (const cl of clusters) {
    const kept = cl.pages && cl.pages.length ? cl.pages[0] : null;
    issues.push({ kind: 'duplicate', severity: 'advisory', pages: cl.pages || [], advice: cl.exact ? 'Exact duplicate pages — keep one, drop the rest.' : 'Near-duplicate pages — confirm which to keep.' });
    if (kept != null) recs.push(`${cl.exact ? 'Duplicate' : 'Near-duplicate'} pages ${(cl.pages || []).join(', ')} — keep page ${kept}.`);
  }
  if (coverage && coverage.gaps && coverage.gaps.length) {
    issues.push({ kind: 'gap', severity: 'advisory', pages: coverage.gaps, advice: 'Pages assigned to no document — a human should place them.' });
  }
  if (coverage && coverage.overlaps && coverage.overlaps.length) {
    issues.push({ kind: 'overlap', severity: 'blocking', pages: coverage.overlaps.map((x) => x.page), advice: 'A page is claimed by two documents — the split is wrong.' });
  }

  const needsReview = issues.some((it) => it.severity === 'blocking');

  return {
    totalPages: qPages.length || list.length,
    quality: { summary: sum, pages: qPages },
    duplicates: { clusters, duplicatePageCount: dup.duplicatePageCount || 0, uniquePageCount: dup.uniquePageCount != null ? dup.uniquePageCount : list.length },
    documents: { groups, count: groups.length },
    orientPlan,
    coverage,
    issues,
    recommendations: recs,
    needsReview,
  };
}

module.exports = { analyzePacket };
