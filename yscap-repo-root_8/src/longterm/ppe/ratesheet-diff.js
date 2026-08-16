'use strict';
/**
 * LT PPE — rate-sheet / ruleset CHANGE DETECTION (MEGA plan §7.2, §7.4). PURE: no DB, no network, no
 * clock. Capture-then-decide: an upstream observation is canonicalized into a flat map of addressable
 * cells (`rule_key → canonical_value`), content-addressed (sha256), and diffed as a KEYED
 * set-difference — so a change is a localized, human-readable per-cell delta, never a blob compare.
 * Then §7.4 classifies each change as auto-apply (safe numeric refresh within guardrails) vs human
 * review (rule changes, or any guardrail tripped).
 *
 * The canonicalizer is VERSION-STAMPED (§7.2): a canonicalizer change must never masquerade as a data
 * change — when the version moves, the diff is a `rebaseline`, not a list of cell changes.
 *
 * Uses Node's built-in crypto only (no native dep — same discipline as storage-s3/backup).
 * LT-only. No RTL imports.
 */

const crypto = require('crypto');

const CANONICALIZER_VERSION = 1; // bump when canonicalize() changes; forces a re-baseline, not a diff.
const DEFAULT_VOLATILE = ['timestamp', 'ts', 'requestId', 'request_id', 'token', 'fetchedAt', 'asOf'];

// Deep canonical form: strip volatile keys, sort object keys, round numbers to `roundTo` (a factor,
// e.g. 1 = integer), leave arrays in place but canonicalize elements (arrays of cells are already
// keyed maps upstream; a value-array is order-significant here unless the caller pre-sorts).
function canonicalize(value, opts = {}) {
  const volatile = new Set(opts.volatileKeys || DEFAULT_VOLATILE);
  const roundTo = opts.roundTo == null ? 1 : opts.roundTo;
  const walk = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v / roundTo) * roundTo : null;
    if (typeof v === 'boolean' || typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) { if (!volatile.has(k)) out[k] = walk(v[k]); }
      return out;
    }
    return null;
  };
  return walk(value);
}

// Stable JSON of a canonical object (keys already sorted by canonicalize).
function stableJson(canon) { return JSON.stringify(canon); }

// Content hash of a cell value (canonicalized first).
function hashCell(value, opts = {}) {
  return crypto.createHash('sha256').update(stableJson(canonicalize(value, opts))).digest('hex');
}

/**
 * Diff two flat rule maps ({ ruleKey → value }).
 *   opts: { canonicalizerVersion, prevCanonicalizerVersion, roundTo, volatileKeys }
 * When the canonicalizer version differs from the previous run's, the result is a REBASELINE (no
 * per-cell changes emitted — a canonicalizer bump must not read as data churn).
 * Returns { rebaselined, added:[key], removed:[key], changed:[{key, before, after, beforeHash, afterHash}],
 *           unchanged:count, canonicalizerVersion }.
 */
function diffRulesets(prev = {}, next = {}, opts = {}) {
  const version = opts.canonicalizerVersion == null ? CANONICALIZER_VERSION : opts.canonicalizerVersion;
  if (opts.prevCanonicalizerVersion != null && opts.prevCanonicalizerVersion !== version) {
    return { rebaselined: true, added: [], removed: [], changed: [], unchanged: 0, canonicalizerVersion: version };
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const added = []; const removed = []; const changed = []; let unchanged = 0;
  for (const key of keys) {
    const inPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const inNext = Object.prototype.hasOwnProperty.call(next, key);
    if (inPrev && !inNext) { removed.push(key); continue; }
    if (!inPrev && inNext) { added.push(key); continue; }
    const bh = hashCell(prev[key], opts);
    const ah = hashCell(next[key], opts);
    if (bh === ah) { unchanged += 1; } else {
      changed.push({ key, before: prev[key], after: next[key], beforeHash: bh, afterHash: ah });
    }
  }
  added.sort(); removed.sort(); changed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { rebaselined: false, added, removed, changed, unchanged, canonicalizerVersion: version };
}

/**
 * Classify a diff into auto-apply vs review (§7.4).
 *   opts: { maxDeltaMilli=250, maxPct=0.05, maxCellsChanged=Infinity }
 * A numeric cell (both before & after finite numbers) changing WITHIN both the absolute and percent
 * bounds is auto-apply; anything else (a rule change, an add/remove, or a bound exceeded) is review.
 * If the TOTAL changed+added+removed count exceeds maxCellsChanged, EVERYTHING escalates to review
 * (a schema break / bad fetch — §7.4), reported via `bulkEscalated`.
 */
function classifyDiff(diff = {}, opts = {}) {
  const maxDelta = opts.maxDeltaMilli == null ? 250 : opts.maxDeltaMilli;
  const maxPct = opts.maxPct == null ? 0.05 : opts.maxPct;
  const maxCells = opts.maxCellsChanged == null ? Infinity : opts.maxCellsChanged;

  const changed = diff.changed || [];
  const added = diff.added || [];
  const removed = diff.removed || [];
  const touched = changed.length + added.length + removed.length;
  const bulkEscalated = touched > maxCells;

  const autoApply = []; const review = [];
  const pushReview = (item, reason) => review.push({ ...item, reason });

  for (const key of added) pushReview({ key, kind: 'added' }, 'a new cell needs review');
  for (const key of removed) pushReview({ key, kind: 'removed' }, 'a removed cell needs review');

  for (const c of changed) {
    const before = c.before; const after = c.after;
    const numeric = typeof before === 'number' && typeof after === 'number' && Number.isFinite(before) && Number.isFinite(after);
    if (!numeric) { pushReview({ ...c, kind: 'rule' }, 'a non-numeric (rule) change needs review'); continue; }
    const delta = after - before;
    const pct = before === 0 ? Infinity : Math.abs(delta) / Math.abs(before);
    if (Math.abs(delta) > maxDelta) { pushReview({ ...c, kind: 'numeric', delta }, `delta ${delta} exceeds ${maxDelta}`); continue; }
    if (pct > maxPct) { pushReview({ ...c, kind: 'numeric', delta, pct }, `change ${(pct * 100).toFixed(1)}% exceeds ${(maxPct * 100).toFixed(1)}%`); continue; }
    autoApply.push({ ...c, kind: 'numeric', delta });
  }

  if (bulkEscalated) {
    // a schema break / bad fetch: nothing is trusted for auto-apply
    return { autoApply: [], review: [...review, ...autoApply.map((a) => ({ ...a, reason: 'bulk change escalated — possible bad fetch' }))], bulkEscalated, touched };
  }
  return { autoApply, review, bulkEscalated, touched };
}

/**
 * Monotonicity guardrail (§7.3/§7.4): on a base-price ladder, price should be non-decreasing as the
 * note rate increases (a lower rate costs more, i.e. a lower price). Returns the violating adjacent
 * pairs (empty = ok). `tolerance` allows tiny inversions from rounding.
 */
function priceMonotonicityViolations(rungs, opts = {}) {
  const tol = opts.tolerance == null ? 0 : opts.tolerance;
  const sorted = (Array.isArray(rungs) ? rungs.slice() : []).filter((r) => r && typeof r.rate === 'number' && typeof r.price === 'number')
    .sort((a, b) => a.rate - b.rate);
  const out = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].price < sorted[i - 1].price - tol) {
      out.push({ lowerRate: sorted[i - 1].rate, higherRate: sorted[i].rate, lowerPrice: sorted[i - 1].price, higherPrice: sorted[i].price });
    }
  }
  return out;
}

module.exports = {
  CANONICALIZER_VERSION,
  canonicalize, hashCell, stableJson, diffRulesets, classifyDiff, priceMonotonicityViolations,
};
