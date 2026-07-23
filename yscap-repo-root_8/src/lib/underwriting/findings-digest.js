'use strict';
/**
 * Whole-loan FINDINGS DIGEST — category rollup (deterministic core, ADVISORY /
 * presentational).
 *
 * findings-export.js flattens the consolidated finding registry into portable
 * CSV rows; decision-explainer.js turns the decision into plain blockers + next
 * steps. This is the third view: a GROUPED-BY-CATEGORY rollup for a summary tile /
 * chip / at-a-glance dashboard — "what KINDS of issues does this loan have, and
 * which category is worst." For each category (title / appraisal / income /
 * entity / …) it reports how many findings, the worst severity in that group, a
 * per-severity breakdown, and whether anything in it blocks a gate; plus a
 * top-level rollup (worst severity overall, per-severity totals, blocking count,
 * category count) and a one-line headline.
 *
 * A `borrowerSafe` option surfaces NO raw finding text (a note-buyer / capital-
 * partner name can be ANY free-form string and the scrub list is fixed) — the
 * category KEY itself is a controlled taxonomy value, but per-category example
 * titles are dropped and any unknown/free-form category label is collapsed to a
 * generic "other" bucket so nothing free-form leaks. Same rule as
 * findings-export.js / decision-explainer.js / run-diff.js.
 *
 * PURE: no DB, no AI, no I/O. It SUMMARIZES an already-computed decision; it
 * decides nothing, changes no status, touches no frozen pricing. Advisory /
 * presentational. NEVER THROWS — hostile input degrades to a safe empty digest.
 */

// Severity ranking: lower number = more severe.
const SEV_ORDER = ['fatal', 'warning', 'info'];
const SEV_ALIAS = { hard_stop: 'fatal', blocking: 'fatal', advisory: 'warning', unknown: 'info', '': 'info' };
function normSev(s) {
  try {
    const v = String(s == null ? '' : s).trim().toLowerCase();
    if (SEV_ORDER.includes(v)) return v;
    return SEV_ALIAS[v] || 'info';
  } catch (_e) { return 'info'; }
}
function sevRank(s) { const i = SEV_ORDER.indexOf(normSev(s)); return i < 0 ? SEV_ORDER.length : i; }
// Worst (most severe) of two severities.
function worstSev(a, b) {
  if (a == null) return b == null ? null : normSev(b);
  if (b == null) return normSev(a);
  return sevRank(a) <= sevRank(b) ? normSev(a) : normSev(b);
}

// A controlled category taxonomy. An incoming category is normalized to one of
// these; anything else becomes 'other' (so a free-form label can never leak in
// borrowerSafe mode and the buckets stay stable).
const KNOWN_CATEGORIES = new Set([
  'title', 'appraisal', 'income', 'assets', 'liquidity', 'credit', 'entity',
  'identity', 'collateral', 'insurance', 'structure', 'pricing', 'guideline',
  'fraud', 'compliance', 'document', 'condition', 'other',
]);
const CATEGORY_LABEL = {
  title: 'Title', appraisal: 'Appraisal', income: 'Income', assets: 'Assets',
  liquidity: 'Liquidity', credit: 'Credit', entity: 'Entity / vesting',
  identity: 'Identity', collateral: 'Collateral', insurance: 'Insurance',
  structure: 'Loan structure', pricing: 'Pricing', guideline: 'Guideline',
  fraud: 'Fraud signals', compliance: 'Compliance', document: 'Documents',
  condition: 'Conditions', other: 'Other',
};
function normCategory(c) {
  try {
    const v = String(c == null ? '' : c).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return KNOWN_CATEGORIES.has(v) ? v : 'other';
  } catch (_e) { return 'other'; }
}

function obj(v) { try { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_e) { return {}; } }
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }
function str(v) {
  try {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  } catch (_e) { return ''; }
}

function findingsOf(decision) {
  try {
    const d = obj(decision);
    let list = arr(d.registry);
    if (!list.length) list = arr(d.blockingFindings);
    if (!list.length) list = arr(d.findings);
    return list.filter((f) => f && typeof f === 'object');
  } catch (_e) { return []; }
}

function isBlocking(f) {
  const ff = obj(f);
  return ff.blocks_term_sheet === true || ff.blocks_ctc === true || ff.blocks_funding === true || normSev(ff.severity) === 'fatal';
}

// A short, staff-only example title for a category (never in borrowerSafe).
function titleOf(f) {
  const ff = obj(f);
  return str(ff.title) || str(ff.message) || str(ff.code) || 'Finding';
}

/**
 * digestFindings(decision, opts?) → {
 *   categories: [{
 *     category, label, count, worstSeverity, blocking,
 *     bySeverity: { fatal, warning, info },
 *     examples: [title, ...]   // [] in borrowerSafe
 *   }],  // ordered worst-severity-first, then most-findings, then label
 *   totals: { total, bySeverity:{fatal,warning,info}, blocking, categories, worstSeverity },
 *   headline: string,
 * }
 *   decision: a decision.decide() result (uses .registry, else .blockingFindings, else .findings)
 *   opts: { borrowerSafe?, maxExamples? (default 2) }
 * NEVER THROWS.
 */
function digestFindings(decision, opts = {}) {
  try {
    const borrowerSafe = !!(opts && opts.borrowerSafe);
    const maxExamples = Number.isFinite(opts && opts.maxExamples) && opts.maxExamples >= 0 ? Math.floor(opts.maxExamples) : 2;
    const list = findingsOf(decision);

    const groups = new Map(); // category → accumulator
    const totalsBySev = { fatal: 0, warning: 0, info: 0 };
    let blockingTotal = 0;
    let overallWorst = null;

    for (const f of list) {
      const cat = normCategory(obj(f).category);
      const sev = normSev(obj(f).severity);
      const blk = isBlocking(f);
      if (!groups.has(cat)) {
        groups.set(cat, { category: cat, label: CATEGORY_LABEL[cat] || 'Other', count: 0, worstSeverity: null, blocking: false, bySeverity: { fatal: 0, warning: 0, info: 0 }, examples: [] });
      }
      const g = groups.get(cat);
      g.count++;
      g.bySeverity[sev]++;
      g.worstSeverity = worstSev(g.worstSeverity, sev);
      if (blk) g.blocking = true;
      if (!borrowerSafe && g.examples.length < maxExamples) g.examples.push(titleOf(f));

      totalsBySev[sev]++;
      if (blk) blockingTotal++;
      overallWorst = worstSev(overallWorst, sev);
    }

    const categories = Array.from(groups.values()).sort((a, b) => {
      const s = sevRank(a.worstSeverity) - sevRank(b.worstSeverity);
      if (s !== 0) return s;
      if (b.count !== a.count) return b.count - a.count;
      return String(a.label).localeCompare(String(b.label));
    });

    const totals = {
      total: list.length,
      bySeverity: totalsBySev,
      blocking: blockingTotal,
      categories: categories.length,
      worstSeverity: overallWorst,
    };

    return { categories, totals, headline: headlineOf(totals, categories) };
  } catch (_e) {
    return { categories: [], totals: { total: 0, bySeverity: { fatal: 0, warning: 0, info: 0 }, blocking: 0, categories: 0, worstSeverity: null }, headline: 'No findings.' };
  }
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

function headlineOf(totals, categories) {
  try {
    if (!totals || totals.total === 0) return 'No findings.';
    const parts = [];
    parts.push(`${plural(totals.total, 'finding')} across ${plural(totals.categories, 'category', 'categories')}`);
    if (totals.bySeverity.fatal) parts.push(`${totals.bySeverity.fatal} fatal`);
    if (totals.blocking) parts.push(`${plural(totals.blocking, 'blocking')}`);
    const worst = categories && categories[0];
    let s = parts.join(' · ') + '.';
    if (worst && worst.worstSeverity === 'fatal') s += ` Worst: ${worst.label}.`;
    return s;
  } catch (_e) { return 'No findings.'; }
}

module.exports = {
  digestFindings,
  KNOWN_CATEGORIES,
  CATEGORY_LABEL,
  _internals: { normSev, sevRank, worstSev, normCategory, isBlocking, findingsOf, headlineOf },
};
