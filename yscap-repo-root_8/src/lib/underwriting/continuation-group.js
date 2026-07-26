'use strict';
/**
 * R5.58 — Continuation-page grouping + auto-orient plan (deterministic core, ADVISORY).
 *
 * A combined packet often contains multi-page documents — a 4-page bank
 * statement, a 6-page title commitment. Naively splitting on every page break
 * would shatter one statement into four "documents" (and could double-count the
 * same statement). This module GROUPS consecutive pages that belong to the same
 * logical document using deterministic signals, and produces an auto-orient plan
 * for sideways/upside-down pages — all as SUGGESTIONS the splitter + a human
 * confirm. It never splits, rotates, or files anything itself.
 *
 * Grouping signals (any strong one continues the current group; a strong NEW-doc
 * signal starts a new one):
 *   • "Page X of Y" pagination that increments within the same Y.
 *   • A shared account-number / statement-period / document-id across pages.
 *   • A blank separator page ENDS the current group (a common divider).
 *   • A page whose header/type differs starts a new group.
 *
 * Pure: no DB, no AI. Consumes per-page features (text + a light classification).
 */

// "Page 2 of 5" / "Page 2/5" / "2 of 5" — capture (n, total).
const PAGE_OF_RE = /\bpage\s*(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})\b|\b(\d{1,3})\s*of\s*(\d{1,3})\b/i;
// Account-number-ish token (mask-tolerant): 6+ trailing digits or a masked tail.
const ACCT_RE = /(?:account|acct|a\/c)[^\d]{0,12}(?:x|\*|•|\d){2,}(\d{3,})/i;
// A statement period like "January 2026" or "01/01/2026 - 01/31/2026".
const PERIOD_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i;

function textOf(p) { return typeof p.text === 'string' ? p.text : ''; }
function pageOf(text) {
  const m = PAGE_OF_RE.exec(text || '');
  if (!m) return null;
  const n = Number(m[1] || m[3]); const total = Number(m[2] || m[4]);
  if (!Number.isFinite(n) || !Number.isFinite(total) || total < 1 || n < 1 || n > total) return null;
  return { n, total };
}
function acctTail(text) { const m = ACCT_RE.exec(text || ''); return m ? m[1] : null; }
function period(text) { const m = PERIOD_RE.exec(text || ''); return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null; }
function docType(p) { return p.documentType || p.doc_type || null; }

// Do two pages share a same-document key (account tail OR statement period)?
function sharesKey(a, b) {
  const ta = acctTail(textOf(a)), tb = acctTail(textOf(b));
  if (ta && tb && ta === tb) return true;
  const pa = period(textOf(a)), pb = period(textOf(b));
  if (pa && pb && pa === pb) return true;
  return false;
}

/**
 * groupPages(pages) → { groups:[{pages:[pageNumber], reason, continues}], orientPlan:[{pageNumber, from, to}] }.
 *   pages: array in packet order; each { page_number?, text, verdict?, rotation? }
 *          (verdict from page-quality: 'blank' ends a group; 'rotated'/'upside_down'
 *          feed the orient plan). A blank page is emitted as its own separator group.
 * Deterministic: same input → same grouping.
 */
function groupPages(pages) {
  const list = (pages || []).map((p, i) => Object.assign({}, p, { _num: p && p.page_number != null ? Number(p.page_number) : i + 1 }));
  const groups = [];
  const orientPlan = [];
  let cur = null; // { pages:[], reason, lastPageOf }

  const startNew = (p, reason) => { cur = { pages: [p._num], reason, lastPageOf: pageOf(textOf(p)) }; groups.push(cur); };

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const prev = i > 0 ? list[i - 1] : null;

    // Auto-orient plan: a sideways/upside-down page should be rotated to upright.
    const rot = ((Math.round(Number(p.rotation) / 90) * 90) % 360 + 360) % 360;
    if (p.verdict === 'upside_down' || rot === 180) orientPlan.push({ pageNumber: p._num, from: 180, to: 0 });
    else if (p.verdict === 'rotated' || rot === 90 || rot === 270) orientPlan.push({ pageNumber: p._num, from: rot || 90, to: 0 });

    // A blank page is a separator — it ends the current group and stands alone.
    if (p.verdict === 'blank') { groups.push({ pages: [p._num], reason: 'separator', continues: false }); cur = null; continue; }

    if (!cur) { startNew(p, 'new_document'); continue; }

    // Continuation signals vs prev / the group.
    const po = pageOf(textOf(p));
    const prevPo = cur.lastPageOf;
    let continues = false;
    let why = null;
    if (po && prevPo && po.total === prevPo.total && po.n === prevPo.n + 1) { continues = true; why = 'pagination'; }
    else if (prev && sharesKey(prev, p)) { continues = true; why = 'shared_account_or_period'; }
    // A clearly different document type breaks continuation.
    const dtPrev = docType(prev), dtCur = docType(p);
    if (dtPrev && dtCur && dtPrev !== dtCur) { continues = false; }

    if (continues) { cur.pages.push(p._num); cur.reason = why; cur.lastPageOf = po || cur.lastPageOf; cur.continues = true; }
    else { startNew(p, 'new_document'); }
  }

  return { groups: groups.map((g) => ({ pages: g.pages, reason: g.reason, continues: !!g.continues })), orientPlan };
}

module.exports = { groupPages, _internals: { pageOf, acctTail, period, sharesKey } };
