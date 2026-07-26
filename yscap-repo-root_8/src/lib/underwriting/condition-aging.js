'use strict';
/**
 * Condition AGING / SLA calculator (deterministic core, ADVISORY).
 *
 * A file's conditions each have a clock: how long has it been OPEN, and is it
 * past the turn-time we hold ourselves to? This computes, per condition, the days
 * it has been open, an aging bucket, and an overdue flag against an SLA (per
 * condition, per severity, or a default), plus a file-level roll-up (how many
 * open, how many overdue, the oldest, a bucket histogram). It's the pure math
 * behind a pipeline "aging" column, a stale-file nudge, and an SLA report.
 *
 * OPEN conditions age from opened_at to `now`; a CLOSED condition (satisfied /
 * cleared / waived / signed-off) freezes its age at close time and is never
 * overdue. Advisory: it flags and buckets — it clears nothing, changes no
 * status, sends nothing.
 *
 * PURE: no DB, no AI, no I/O. `now` is passed in (epoch ms or ISO/date string)
 * so it is deterministic and testable. NEVER THROWS — hostile input degrades to
 * a safe empty result.
 */

const DAY_MS = 86400000;

// Statuses that mean the condition is DONE (frozen clock, never overdue).
const CLOSED_STATUSES = new Set([
  'satisfied', 'cleared', 'waived', 'signed_off', 'signedoff', 'resolved', 'complete', 'completed', 'done', 'closed',
]);

// Aging buckets by days open (inclusive lower bound).
const BUCKETS = Object.freeze([
  { key: '0-3', min: 0, max: 3 },
  { key: '4-7', min: 4, max: 7 },
  { key: '8-14', min: 8, max: 14 },
  { key: '15+', min: 15, max: Infinity },
]);
const DEFAULT_SLA_DAYS = 7;

function toMs(v) {
  try {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (s === '') return null;
    // a bare date 'YYYY-MM-DD' or full ISO both parse; a bare epoch-ms string too.
    if (/^\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  } catch (_e) { return null; }
}
function str(v) { try { return v == null ? null : (typeof v === 'string' ? (v.trim() || null) : String(v)); } catch (_e) { return null; } }
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }
function num(v) { try { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; } catch (_e) { return null; } }

function isClosed(status) { try { return CLOSED_STATUSES.has(String(status == null ? '' : status).toLowerCase().replace(/[\s-]+/g, '_')); } catch (_e) { return false; } }
function bucketOf(days) { for (const b of BUCKETS) { if (days >= b.min && days <= b.max) return b.key; } return '15+'; }

// The opened / closed timestamps, tolerating several field names.
function openedMs(c) { return toMs(firstDefined(c, ['opened_at', 'openedAt', 'created_at', 'createdAt', 'requested_at'])); }
function closedMs(c) { return toMs(firstDefined(c, ['cleared_at', 'clearedAt', 'satisfied_at', 'signed_off_at', 'signedOffAt', 'resolved_at', 'closed_at', 'completed_at'])); }
function firstDefined(o, keys) { try { for (const k of keys) { if (o && o[k] != null) return o[k]; } return null; } catch (_e) { return null; }; }

// Per-condition SLA: an explicit sla_days on the condition wins; else a severity
// map from opts; else the default.
function slaFor(c, opts) {
  try {
    const explicit = num(firstDefined(c, ['sla_days', 'slaDays']));
    if (explicit != null && explicit >= 0) return explicit;
    const sev = String(firstDefined(c, ['severity']) || '').toLowerCase();
    const map = opts && opts.slaBySeverity && typeof opts.slaBySeverity === 'object' ? opts.slaBySeverity : null;
    if (map && map[sev] != null && num(map[sev]) != null) return num(map[sev]);
    const dflt = opts && num(opts.slaDays) != null ? num(opts.slaDays) : DEFAULT_SLA_DAYS;
    return dflt;
  } catch (_e) { return DEFAULT_SLA_DAYS; }
}

/**
 * ageConditions(conditions, opts) → {
 *   conditions: [{ id, status, open, daysOpen, bucket, overdue, slaDays, overdueBy }],
 *   summary: { total, open, closed, overdue, oldestDaysOpen, buckets:{'0-3':n,...} }
 * }
 *   conditions: [{ id?, status?, opened_at?, cleared_at?/satisfied_at?/..., severity?, sla_days? }]
 *   opts: { now, slaDays?, slaBySeverity? }
 * OPEN conditions age to `now`; CLOSED ones freeze at close time and are never
 * overdue. Deterministic. NEVER THROWS.
 */
function ageConditions(conditions, opts = {}) {
  try {
    const now = toMs(opts && opts.now);
    const list = arr(conditions);
    const buckets = { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 };
    let open = 0, closed = 0, overdue = 0, oldest = 0;

    const out = list.map((c) => rowOf(c, now, opts)).filter(Boolean);
    for (const r of out) {
      if (r.open) open++; else closed++;
      // the aging histogram + oldest are over OPEN conditions only (a closed
      // condition is no longer aging).
      if (r.open && r.daysOpen != null) {
        if (BUCKETS.some((b) => b.key === r.bucket)) buckets[r.bucket]++;
        if (r.daysOpen > oldest) oldest = r.daysOpen;
      }
      if (r.overdue) overdue++;
    }
    return {
      conditions: out,
      summary: { total: out.length, open, closed, overdue, oldestDaysOpen: oldest, buckets },
    };
  } catch (_e) {
    return { conditions: [], summary: { total: 0, open: 0, closed: 0, overdue: 0, oldestDaysOpen: 0, buckets: { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 } } };
  }
}

function rowOf(c, now, opts) {
  try {
    const cc = c || {};
    const status = str(cc.status) || 'open';
    const closedCondition = isClosed(status);
    const opened = openedMs(cc);
    const endMs = closedCondition ? (closedMs(cc) != null ? closedMs(cc) : now) : now;
    let daysOpen = null;
    if (opened != null && endMs != null) daysOpen = Math.max(0, Math.floor((endMs - opened) / DAY_MS));
    const slaDays = slaFor(cc, opts);
    // overdue only applies to an OPEN condition with a known age past its SLA.
    const overdue = !closedCondition && daysOpen != null && daysOpen > slaDays;
    return {
      id: str(cc.id) || str(cc.code) || str(cc.template_code) || null,
      status,
      open: !closedCondition,
      daysOpen,
      bucket: daysOpen != null ? bucketOf(daysOpen) : null,
      overdue,
      slaDays,
      overdueBy: overdue ? daysOpen - slaDays : 0,
    };
  } catch (_e) { return null; }
}

module.exports = {
  ageConditions,
  CLOSED_STATUSES,
  BUCKETS,
  DEFAULT_SLA_DAYS,
  _internals: { toMs, isClosed, bucketOf, slaFor, rowOf },
};
