'use strict';
/**
 * Whole-loan RUN DIFF formatter (deterministic core, ADVISORY / presentational).
 *
 * run-trigger.js (R6.15) decides WHEN to re-underwrite; run.js/decision.js
 * (R6.14) produce a fresh whole-loan decision every time it fires. When a new run
 * lands, the file view (and a "what changed" email / activity line) wants the
 * PLAIN-ENGLISH delta from the PREVIOUS run: did the status move, did a gate open
 * or close, which findings appeared, cleared, or got worse. This is that diff.
 *
 * It takes two decision.decide() results — `prev` and `curr` — and reports:
 *   - the status change (from → to),
 *   - each gate's movement (term sheet / CTC / funding: gained | lost | same),
 *   - the finding delta keyed by (code, subject): added, removed (cleared), and
 *     changed (severity up/down, or a blocks_* flag flipped),
 *   - a rolled-up summary (counts before/after + net) and a one-line headline.
 *
 * A `borrowerSafe` option surfaces NO raw finding text (a note-buyer / capital-
 * partner name can be ANY free-form string and the scrub list is fixed) — every
 * added/removed/changed finding becomes a generic, count-only entry. Same rule as
 * findings-export.js / decision-explainer.js.
 *
 * PURE: no DB, no AI, no I/O. It COMPARES two already-computed decisions; it
 * decides nothing, re-runs nothing, changes no status, touches no frozen pricing.
 * Advisory / presentational. NEVER THROWS — hostile input degrades to a safe,
 * empty-but-valid diff.
 */

const SEV_RANK = { fatal: 0, hard_stop: 0, blocking: 0, warning: 1, advisory: 1, info: 2, unknown: 3 };
function sevRank(s) { const r = SEV_RANK[norm(s)]; return r == null ? 3 : r; }
function norm(s) { try { return String(s == null ? '' : s).trim().toLowerCase(); } catch (_e) { return ''; } }

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

// Pull a decision's finding list, tolerating shape drift (registry, else
// blockingFindings, else findings). Returns [] on anything hostile.
function findingsOf(decision) {
  try {
    const d = obj(decision);
    let list = arr(d.registry);
    if (!list.length) list = arr(d.blockingFindings);
    if (!list.length) list = arr(d.findings);
    return list.filter((f) => f && typeof f === 'object');
  } catch (_e) { return []; }
}

// Stable identity for a finding across runs: code + subject (matches the
// finding-registry dedup key). Falls back to the title when there is no code, so
// two runs of the same untitled finding still line up.
function keyOf(f) {
  try {
    const ff = obj(f);
    const code = str(ff.code) || str(ff.id);
    const subject = str(ff.subject);
    if (code) return `c:${code.toLowerCase()}|s:${subject.toLowerCase()}`;
    const title = str(ff.title) || str(ff.message);
    return `t:${title.toLowerCase()}|s:${subject.toLowerCase()}`;
  } catch (_e) { return 't:|s:'; }
}

function blocksOf(f) {
  const ff = obj(f);
  return { term_sheet: ff.blocks_term_sheet === true, ctc: ff.blocks_ctc === true, funding: ff.blocks_funding === true };
}
function blocksEqual(a, b) { return a.term_sheet === b.term_sheet && a.ctc === b.ctc && a.funding === b.funding; }

// A borrower-safe, count-only view of a finding (no raw text ever). Staff view
// keeps code/title/subject.
function findingBrief(f, borrowerSafe) {
  const ff = obj(f);
  const severity = norm(ff.severity) || 'unknown';
  if (borrowerSafe) return { severity, title: 'An item', code: null, subject: null };
  return {
    severity,
    title: str(ff.title) || str(ff.message) || str(ff.code) || 'Finding',
    code: str(ff.code) || str(ff.id) || null,
    subject: str(ff.subject) || null,
  };
}

// The three whole-loan gates, tolerating snake/camel field names.
function gateOf(d, camel, snake) {
  const dd = obj(d);
  return dd[camel] === true || dd[snake] === true;
}
function gateDir(from, to) {
  if (from === to) return 'same';
  return to ? 'gained' : 'lost';
}

/**
 * diffRuns(prev, curr, opts?) → {
 *   statusChanged: boolean,
 *   status: { from, to },
 *   gates: { term_sheet:{from,to,direction}, ctc:{...}, funding:{...} },
 *   gatesGained: [..], gatesLost: [..],
 *   findings: {
 *     added:   [{severity,title,code,subject}],
 *     removed: [{severity,title,code,subject}],
 *     changed: [{title,code,subject, severityFrom, severityTo, direction:'worse'|'better'|'same', blocksChanged:bool}],
 *   },
 *   counts: { added, removed, changed, worsened, improved },
 *   headline: string,
 *   changed: boolean,   // anything at all moved
 * }
 *   prev, curr: decision.decide() results (curr is the NEW run)
 *   opts: { borrowerSafe? }
 * NEVER THROWS.
 */
function diffRuns(prev, curr, opts = {}) {
  try {
    const borrowerSafe = !!(opts && opts.borrowerSafe);
    const p = obj(prev);
    const c = obj(curr);

    // --- status ---
    const statusFrom = str(p.status) || null;
    const statusTo = str(c.status) || null;
    const statusChanged = statusFrom !== statusTo;

    // --- gates ---
    const gateDefs = [
      ['term_sheet', 'termSheetEligible', 'term_sheet_eligible'],
      ['ctc', 'ctcEligible', 'ctc_eligible'],
      ['funding', 'fundingEligible', 'funding_eligible'],
    ];
    const gates = {};
    const gatesGained = [];
    const gatesLost = [];
    for (const [name, camel, snake] of gateDefs) {
      const from = gateOf(p, camel, snake);
      const to = gateOf(c, camel, snake);
      const direction = gateDir(from, to);
      gates[name] = { from, to, direction };
      if (direction === 'gained') gatesGained.push(name);
      else if (direction === 'lost') gatesLost.push(name);
    }

    // --- findings, keyed by (code, subject) ---
    const prevMap = new Map();
    for (const f of findingsOf(p)) { const k = keyOf(f); if (!prevMap.has(k)) prevMap.set(k, f); }
    const currMap = new Map();
    for (const f of findingsOf(c)) { const k = keyOf(f); if (!currMap.has(k)) currMap.set(k, f); }

    const added = [];
    const removed = [];
    const changed = [];
    let worsened = 0;
    let improved = 0;

    for (const [k, f] of currMap) {
      if (!prevMap.has(k)) { added.push(findingBrief(f, borrowerSafe)); continue; }
      const pf = prevMap.get(k);
      const sevFrom = norm(pf.severity) || 'unknown';
      const sevTo = norm(f.severity) || 'unknown';
      const rankFrom = sevRank(sevFrom);
      const rankTo = sevRank(sevTo);
      const blocksChanged = !blocksEqual(blocksOf(pf), blocksOf(f));
      if (sevFrom === sevTo && !blocksChanged) continue; // unchanged
      // lower rank number = more severe, so rankTo < rankFrom means it got WORSE.
      let direction = 'same';
      if (rankTo < rankFrom) { direction = 'worse'; worsened++; }
      else if (rankTo > rankFrom) { direction = 'better'; improved++; }
      const brief = findingBrief(f, borrowerSafe);
      changed.push({ ...brief, severityFrom: sevFrom, severityTo: sevTo, direction, blocksChanged });
    }
    for (const [k, f] of prevMap) {
      if (!currMap.has(k)) removed.push(findingBrief(f, borrowerSafe));
    }

    const counts = {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      worsened,
      improved,
    };

    const changedAtAll = statusChanged
      || gatesGained.length > 0 || gatesLost.length > 0
      || counts.added > 0 || counts.removed > 0 || counts.changed > 0;

    return {
      statusChanged,
      status: { from: statusFrom, to: statusTo },
      gates,
      gatesGained,
      gatesLost,
      findings: { added, removed, changed },
      counts,
      headline: headlineOf({ statusChanged, statusFrom, statusTo, gatesGained, gatesLost, counts }),
      changed: changedAtAll,
    };
  } catch (_e) {
    return emptyDiff();
  }
}

function emptyDiff() {
  return {
    statusChanged: false,
    status: { from: null, to: null },
    gates: {
      term_sheet: { from: false, to: false, direction: 'same' },
      ctc: { from: false, to: false, direction: 'same' },
      funding: { from: false, to: false, direction: 'same' },
    },
    gatesGained: [],
    gatesLost: [],
    findings: { added: [], removed: [], changed: [] },
    counts: { added: 0, removed: 0, changed: 0, worsened: 0, improved: 0 },
    headline: 'No change since the last review.',
    changed: false,
  };
}

const GATE_LABEL = { term_sheet: 'term sheet', ctc: 'clear-to-close', funding: 'funding' };
function gateList(names) { try { return names.map((n) => GATE_LABEL[n] || n).join(', '); } catch (_e) { return ''; } }
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

// A single plain-language line summarizing the most important movement.
function headlineOf({ statusChanged, statusFrom, statusTo, gatesGained, gatesLost, counts }) {
  try {
    const parts = [];
    if (statusChanged && statusTo) parts.push(`Status moved to ${statusTo}${statusFrom ? ` (was ${statusFrom})` : ''}.`);
    if (gatesLost.length) parts.push(`No longer clear for ${gateList(gatesLost)}.`);
    if (gatesGained.length) parts.push(`Now clear for ${gateList(gatesGained)}.`);
    if (counts.added) parts.push(`${plural(counts.added, 'new item')} to review.`);
    if (counts.worsened) parts.push(`${plural(counts.worsened, 'item')} got more serious.`);
    if (counts.removed) parts.push(`${plural(counts.removed, 'item')} cleared.`);
    if (counts.improved) parts.push(`${plural(counts.improved, 'item')} eased.`);
    // A finding can CHANGE without a severity-rank move — a blocks_* flag flip, or
    // a same-rank relabel (e.g. warning→advisory). Those are counted in
    // `counts.changed` but not in worsened/improved, so surface the remainder here
    // to keep the headline self-consistent with `changed`.
    const otherChanged = Math.max(0, (counts.changed || 0) - (counts.worsened || 0) - (counts.improved || 0));
    if (otherChanged) parts.push(`${plural(otherChanged, 'item')} updated.`);
    if (!parts.length) return 'No change since the last review.';
    return parts.join(' ');
  } catch (_e) { return 'No change since the last review.'; }
}

module.exports = {
  diffRuns,
  _internals: { keyOf, findingsOf, sevRank, blocksOf, blocksEqual, findingBrief, headlineOf, gateDir },
};
