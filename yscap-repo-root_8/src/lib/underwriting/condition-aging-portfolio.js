'use strict';
/**
 * Condition-aging PORTFOLIO rollup (deterministic core, ADVISORY / presentational).
 *
 * condition-aging.js ages ONE file's conditions (days open, buckets, overdue vs
 * SLA, a per-file summary). This rolls MANY of those per-file summaries up into a
 * book-level SLA snapshot for the pipeline dashboard / an ops digest: how many
 * files have overdue conditions, the total open / overdue counts across the book,
 * the oldest open condition anywhere, a summed bucket histogram, and a ranked
 * "worst files" list (most-overdue, then oldest) so a manager sees where to push.
 *
 * It consumes the OUTPUT of ageConditions() (each entry carries a `.summary`, or
 * IS a summary) — it re-derives nothing and re-ages nothing; feed it the summaries
 * you already computed. Advisory: it counts and ranks — it clears nothing, changes
 * no status, sends nothing.
 *
 * This is a STAFF/ops surface (a portfolio manager's queue), not a borrower one —
 * it carries no free-form finding text, only per-file counts + the file label the
 * caller supplies. There is intentionally no borrowerSafe mode (a portfolio view
 * is never shown to a borrower).
 *
 * PURE: no DB, no AI, no I/O. NEVER THROWS — hostile input degrades to a safe
 * empty snapshot.
 */

const BUCKET_KEYS = Object.freeze(['0-3', '4-7', '8-14', '15+']);

function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }
function obj(v) { try { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_e) { return {}; } }
function str(v) {
  try {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  } catch (_e) { return null; }
}
// A safe non-negative integer from a possibly-hostile numeric field.
function count(v) {
  try {
    if (v == null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (_e) { return 0; }
}

// Pull the per-file summary out of an entry, tolerating a few shapes:
//   { id, label, summary:{...} }  (ageConditions result under .summary — or the
//   whole ageConditions result, which HAS a .summary), or a bare summary object.
function summaryOf(entry) {
  try {
    const e = obj(entry);
    if (e.summary && typeof e.summary === 'object') return obj(e.summary);
    if (e.aging && typeof e.aging === 'object' && e.aging.summary) return obj(e.aging.summary);
    // a bare summary (has open/overdue/buckets directly)
    if ('open' in e || 'overdue' in e || 'buckets' in e) return e;
    return {};
  } catch (_e) { return {}; }
}

/**
 * rollupAging(files, opts?) → {
 *   files: { total, withOpen, withOverdue },
 *   conditions: { open, overdue, closed, total, oldestDaysOpen },
 *   buckets: { '0-3':n, '4-7':n, '8-14':n, '15+':n },
 *   worstFiles: [{ id, label, open, overdue, oldestDaysOpen }],  // ranked, capped
 *   headline: string,
 * }
 *   files: [{ id?, label?, summary } | ageConditions()-result | bare-summary]
 *   opts: { limit? (worstFiles cap, default 10) }
 * NEVER THROWS.
 */
function rollupAging(files, opts = {}) {
  try {
    const limit = count(opts && opts.limit) || 10;
    const list = arr(files);
    const buckets = { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 };
    let filesWithOpen = 0, filesWithOverdue = 0;
    let openTotal = 0, overdueTotal = 0, closedTotal = 0, condTotal = 0, oldest = 0;
    const perFile = [];

    for (const entry of list) {
      // Per-file guard: one bad entry (a throwing getter on its own field)
      // degrades just itself, not the whole portfolio rollup.
      try {
        const e = obj(entry);
        const s = summaryOf(entry);
        const open = count(s.open);
        const overdue = count(s.overdue);
        const closed = count(s.closed);
        const total = count(s.total) || (open + closed);
        const fileOldest = count(s.oldestDaysOpen);
        const b = obj(s.buckets);
        for (const k of BUCKET_KEYS) buckets[k] += count(b[k]);

        if (open > 0) filesWithOpen++;
        if (overdue > 0) filesWithOverdue++;
        openTotal += open;
        overdueTotal += overdue;
        closedTotal += closed;
        condTotal += total;
        if (fileOldest > oldest) oldest = fileOldest;

        perFile.push({
          id: str(e.id) || str(e.applicationId) || str(e.app_id) || null,
          label: str(e.label) || str(e.name) || str(e.address) || null,
          open,
          overdue,
          oldestDaysOpen: fileOldest,
        });
      } catch (_e) { /* skip a single unreadable file, keep the rest */ }
    }

    // Rank: most overdue first, then oldest, then most open. Only files with
    // something OPEN are worth surfacing.
    const worstFiles = perFile
      .filter((f) => f.open > 0 || f.overdue > 0)
      .sort((a, b) => (b.overdue - a.overdue) || (b.oldestDaysOpen - a.oldestDaysOpen) || (b.open - a.open))
      .slice(0, limit);

    const out = {
      files: { total: list.length, withOpen: filesWithOpen, withOverdue: filesWithOverdue },
      conditions: { open: openTotal, overdue: overdueTotal, closed: closedTotal, total: condTotal, oldestDaysOpen: oldest },
      buckets,
      worstFiles,
    };
    out.headline = headlineOf(out);
    return out;
  } catch (_e) {
    return emptyRollup();
  }
}

function emptyRollup() {
  return {
    files: { total: 0, withOpen: 0, withOverdue: 0 },
    conditions: { open: 0, overdue: 0, closed: 0, total: 0, oldestDaysOpen: 0 },
    buckets: { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 },
    worstFiles: [],
    headline: 'No open conditions across the portfolio.',
  };
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

function headlineOf(r) {
  try {
    if (!r || r.conditions.open === 0) return 'No open conditions across the portfolio.';
    const parts = [`${plural(r.conditions.open, 'open condition')} across ${plural(r.files.withOpen, 'file')}`];
    if (r.conditions.overdue > 0) parts.push(`${plural(r.conditions.overdue, 'overdue')} on ${plural(r.files.withOverdue, 'file')}`);
    if (r.conditions.oldestDaysOpen > 0) parts.push(`oldest ${plural(r.conditions.oldestDaysOpen, 'day')} open`);
    return parts.join(' · ') + '.';
  } catch (_e) { return 'No open conditions across the portfolio.'; }
}

module.exports = {
  rollupAging,
  BUCKET_KEYS,
  _internals: { summaryOf, count, headlineOf },
};
