'use strict';
/**
 * Whole-loan NEXT-ACTIONS worklist (deterministic core, ADVISORY / presentational).
 *
 * decision.decide() (R6.14) says WHERE a loan stands (status, gates, blocking
 * findings); condition-aging.js says which conditions are open and which are
 * overdue. A processor looking at the file wants the two folded into ONE ordered
 * "what to do next" list: clear the blocking findings first, then the overdue
 * conditions, then the rest of the open conditions, then the non-blocking
 * warnings. This is that worklist — the actionable companion to decision-explainer
 * (which explains the verdict) and findings-digest (which categorizes it).
 *
 * Each action carries a priority tier, a kind (finding | condition), a short
 * title, a plain "why it matters" line, and flags (blocking / overdue). The list
 * is ordered by tier, then by severity / days-open, so the top of the list is
 * always the most important next move.
 *
 * This is a STAFF/processor surface. It reports the finding + condition text the
 * caller passes (staff-side titles/labels); it is NOT borrower-facing, so there
 * is no borrowerSafe mode (a borrower worklist should be built from curated
 * borrower_labels upstream, the same way the rest of the app separates
 * borrower_label from the internal label).
 *
 * PURE: no DB, no AI, no I/O. `now` is passed in (for the condition aging) so it
 * is deterministic. It reads and orders — it decides nothing, clears no condition,
 * changes no status, touches no frozen pricing. NEVER THROWS — hostile input
 * degrades to a safe empty worklist.
 */

let aging = null;
try { aging = require('./condition-aging'); } catch (_e) { aging = null; }

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
function norm(s) { try { return String(s == null ? '' : s).trim().toLowerCase(); } catch (_e) { return ''; } }
const FATAL = new Set(['fatal', 'hard_stop', 'blocking']);
function isFatal(sev) { return FATAL.has(norm(sev)); }

// Priority tiers (lower runs first).
const TIER = Object.freeze({ BLOCKING_FINDING: 1, OVERDUE_CONDITION: 2, OPEN_CONDITION: 3, WARNING_FINDING: 4 });

function findingsOf(decision) {
  try {
    const d = obj(decision);
    // The full registry first — a worklist needs the WARNING findings too, not
    // just the blocking subset (blockingFindings excludes non-blocking warnings).
    let list = arr(d.registry);
    if (!list.length) list = arr(d.findings);
    if (!list.length) list = arr(d.blockingFindings);
    return list.filter((f) => f && typeof f === 'object');
  } catch (_e) { return []; }
}
function isBlockingFinding(f) {
  const ff = obj(f);
  return ff.blocks_term_sheet === true || ff.blocks_ctc === true || ff.blocks_funding === true || isFatal(ff.severity);
}
function findingTitle(f) { const ff = obj(f); return str(ff.title) || str(ff.message) || str(ff.code) || 'Finding'; }
function findingRef(f) { const ff = obj(f); return str(ff.code) || str(ff.id) || null; }

// Turn a blocking or warning finding into an action.
function findingAction(f) {
  try {
    const ff = obj(f);
    const blocking = isBlockingFinding(ff);
    const gates = [];
    if (ff.blocks_term_sheet === true) gates.push('term sheet');
    if (ff.blocks_ctc === true) gates.push('clear-to-close');
    if (ff.blocks_funding === true) gates.push('funding');
    const why = blocking
      ? (gates.length ? `Blocks ${gates.join(', ')}.` : 'A blocking issue to resolve.')
      : 'A flagged item to review.';
    return {
      priority: blocking ? TIER.BLOCKING_FINDING : TIER.WARNING_FINDING,
      kind: 'finding',
      title: findingTitle(ff),
      why,
      blocking,
      overdue: false,
      severity: norm(ff.severity) || 'unknown',
      ref: findingRef(ff),
      // The registry's identity is (code, subject) — carry the subject so dedupe
      // never collapses two DISTINCT findings that share a code (e.g.
      // title_defect::title vs title_defect::survey are two separate actions).
      subject: str(ff.subject) || str(ff.field) || null,
    };
  } catch (_e) { return null; }
}

// Statuses that mean a RAW (un-aged) condition is done — mirrors
// condition-aging's CLOSED_STATUSES so the no-aging-module fallback drops
// closed conditions exactly like the aged path does.
const RAW_CLOSED = new Set(['satisfied', 'cleared', 'waived', 'signed_off', 'signedoff', 'resolved', 'complete', 'completed', 'done', 'closed']);

// Turn an aged OPEN condition row into an action.
function conditionAction(row) {
  try {
    const r = obj(row);
    if (r.open === false) return null; // closed conditions are not work
    // A raw row (no aging pass) carries `status`, not `open` — treat a closed
    // status as not-work too, so the fallback path honors the same rule.
    if (r.open == null && RAW_CLOSED.has(norm(r.status).replace(/[\s-]+/g, '_'))) return null;
    const overdue = r.overdue === true;
    const days = Number.isFinite(r.daysOpen) ? r.daysOpen : null;
    const why = overdue
      ? `Overdue by ${plural(Number.isFinite(r.overdueBy) ? r.overdueBy : 0, 'day')} (open ${plural(days || 0, 'day')}).`
      : (days != null ? `Open ${plural(days, 'day')}.` : 'An open condition.');
    return {
      priority: overdue ? TIER.OVERDUE_CONDITION : TIER.OPEN_CONDITION,
      kind: 'condition',
      title: str(r.title) || str(r.label) || str(r.id) || 'Condition',
      why,
      blocking: false,
      overdue,
      daysOpen: days,
      ref: str(r.id) || null,
    };
  } catch (_e) { return null; }
}

/**
 * buildNextActions(input, opts?) → {
 *   actions: [{ priority, kind, title, why, blocking, overdue, severity?, daysOpen?, ref }],
 *   summary: { total, blocking, overdue, findings, conditions },
 *   headline: string,
 * }
 *   input: {
 *     decision,                        // a decision.decide() result
 *     conditions,                      // raw conditions (aged internally) OR pre-aged rows
 *     agedConditions,                  // optional: an ageConditions() result to use directly
 *     now, slaDays, slaBySeverity,     // passed to condition-aging when aging `conditions`
 *   }
 *   opts: { limit? (cap the list, default 50), includeWarnings? (default true) }
 * NEVER THROWS.
 */
function buildNextActions(input, opts = {}) {
  try {
    const i = obj(input);
    const includeWarnings = !(opts && opts.includeWarnings === false);
    const limit = Number.isFinite(opts && opts.limit) && opts.limit >= 0 ? Math.floor(opts.limit) : 50;

    // --- findings → actions ---
    const findingActions = [];
    for (const f of findingsOf(i.decision)) {
      const a = findingAction(f);
      if (!a) continue;
      if (!a.blocking && !includeWarnings) continue;
      // only fatal/blocking or explicit warning severities become actions; info is noise
      if (!a.blocking && a.severity === 'info') continue;
      findingActions.push(a);
    }

    // --- conditions → actions (age them if raw conditions were passed) ---
    let rows = [];
    const preAged = obj(i.agedConditions);
    if (Array.isArray(preAged.conditions)) {
      rows = preAged.conditions;
    } else if (Array.isArray(i.conditions) && aging && typeof aging.ageConditions === 'function') {
      rows = arr(aging.ageConditions(i.conditions, { now: i.now, slaDays: i.slaDays, slaBySeverity: i.slaBySeverity }).conditions);
    } else if (Array.isArray(i.conditions)) {
      rows = i.conditions; // no aging module: treat each as an open row as-is
    }
    const conditionActions = [];
    for (const r of rows) {
      const a = conditionAction(r);
      if (a) conditionActions.push(a);
    }

    // --- dedupe (a finding ref or condition ref should appear once) + order ---
    const all = dedupe([...findingActions, ...conditionActions]);
    all.sort(orderActions);
    const capped = all.slice(0, limit);
    // re-number the visible priority as a 1..N rank for display convenience while
    // keeping the tier in `priority`.
    const actions = capped;

    const summary = {
      total: actions.length,
      blocking: actions.filter((a) => a.blocking).length,
      overdue: actions.filter((a) => a.overdue).length,
      findings: actions.filter((a) => a.kind === 'finding').length,
      conditions: actions.filter((a) => a.kind === 'condition').length,
    };
    return { actions, summary, headline: headlineOf(summary) };
  } catch (_e) {
    return { actions: [], summary: { total: 0, blocking: 0, overdue: 0, findings: 0, conditions: 0 }, headline: 'Nothing to do right now.' };
  }
}

function dedupe(list) {
  try {
    const seen = new Set();
    const out = [];
    for (const a of list) {
      if (!a) continue;
      // Identity: kind + ref + SUBJECT (a finding's registry identity is
      // (code, subject), so two distinct findings sharing a code but about
      // different subjects must NOT collapse). Refless items key on the title.
      const key = `${a.kind}|${(a.ref || '').toLowerCase()}|${a.ref ? norm(a.subject) : norm(a.title)}`;
      if (a.ref || a.title) { if (seen.has(key)) continue; seen.add(key); }
      out.push(a);
    }
    return out;
  } catch (_e) { return arr(list).filter(Boolean); }
}

// Order: by tier, then within a tier the more urgent first (blocking findings by
// fatal-first, conditions by most-overdue / oldest first).
const SEV_RANK = { fatal: 0, hard_stop: 0, blocking: 0, warning: 1, advisory: 1, info: 2, unknown: 3 };
function sevRank(s) { const r = SEV_RANK[norm(s)]; return r == null ? 3 : r; }
function orderActions(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.kind === 'finding' && b.kind === 'finding') return sevRank(a.severity) - sevRank(b.severity);
  if (a.kind === 'condition' && b.kind === 'condition') {
    const ao = Number.isFinite(a.daysOpen) ? a.daysOpen : -1;
    const bo = Number.isFinite(b.daysOpen) ? b.daysOpen : -1;
    return bo - ao; // oldest first
  }
  return 0;
}

function plural(n, one, many) { const k = Number.isFinite(n) ? n : 0; return `${k} ${k === 1 ? one : (many || one + 's')}`; }

function headlineOf(s) {
  try {
    if (!s || s.total === 0) return 'Nothing to do right now.';
    const parts = [];
    if (s.blocking) parts.push(`${plural(s.blocking, 'blocking item')} to clear`);
    if (s.overdue) parts.push(`${plural(s.overdue, 'overdue condition')}`);
    const rest = s.total - s.blocking - s.overdue;
    if (rest > 0) parts.push(`${plural(rest, 'more item')}`);
    if (!parts.length) parts.push(`${plural(s.total, 'item')} to work`);
    return parts.join(' · ') + '.';
  } catch (_e) { return 'Nothing to do right now.'; }
}

module.exports = {
  buildNextActions,
  TIER,
  _internals: { findingAction, conditionAction, findingsOf, isBlockingFinding, dedupe, orderActions, headlineOf },
};
