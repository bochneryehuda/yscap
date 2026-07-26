'use strict';
/**
 * R6.15 — Auto-trigger a whole-loan underwriting run on every MATERIAL event,
 * DEBOUNCED (deterministic core, ADVISORY-to-the-scheduler).
 *
 * A whole-loan run (run.js `runWholeLoan`) should recompute whenever something
 * that could change the verdict changes — a document arrives, a condition flips,
 * the status moves, the product is re-registered, the economics shift, a new
 * finding lands. But those events arrive in BURSTS (a borrower uploads six pages,
 * a sync pass touches ten fields), and firing a fresh run per event would be
 * wasteful and racy. This module is the pure decision the scheduler consults:
 * given the events since the last run, the last run's time + context hash, and a
 * debounce window, it answers RUN NOW / DEFER until the burst settles / SKIP
 * (nothing material changed).
 *
 * PURE: no DB, no timers, no I/O. `now` is passed in (epoch ms) so it is fully
 * deterministic and testable; the caller schedules the actual run/defer. It
 * decides WHEN to run — it never runs anything, changes no data, touches no
 * pricing. NEVER THROWS: hostile/garbage events degrade to a safe SKIP/ignore.
 */

// Event kinds that can change the whole-loan verdict → warrant a re-run.
const MATERIAL_EVENTS = Object.freeze(new Set([
  'document_uploaded', 'document_superseded', 'document_deleted',
  'condition_changed', 'condition_added', 'condition_cleared', 'condition_reopened',
  'status_changed', 'internal_status_changed',
  'registration_changed', 'product_registered', 'economics_changed',
  'finding_added', 'finding_resolved',
  'appraisal_imported', 'liquidity_changed', 'entity_verified',
  'note_buyer_changed', 'assignment_changed', 'guideline_changed',
  'fact_confirmed', 'exception_decided',
  // a borrower-info / application-field edit can change sizing + gates even when
  // it isn't a headline economics change; SOW/budget + track-record feed sizing.
  'application_updated', 'borrower_updated', 'fields_changed',
  'rehab_budget_changed', 'sow_changed', 'track_record_changed',
]));

const DEFAULT_DEBOUNCE_MS = 90 * 1000;   // coalesce a burst over ~90s
const DEFAULT_MAX_DEFER_MS = 15 * 60 * 1000; // but never starve a run past 15 min of continuous activity

function isMaterial(kind) {
  try { return MATERIAL_EVENTS.has(String(kind == null ? '' : kind)); } catch (_e) { return false; }
}

// The contract is epoch MILLISECONDS. A bare positive value below this floor is
// implausible as ms (it is before 1973) and is almost certainly epoch SECONDS or
// garbage — accepting it would mis-scale to ~1970 and, combined with a real-ms
// lastRunAt, silently drop the event as "already covered" (a FALSE SKIP → stale
// verdict, the dangerous direction). We reject it rather than guess a ×1000.
const MS_FLOOR = 1e11; // ~1973-03 in epoch ms

// Parse a timestamp (epoch ms number, numeric string, or ISO/date string) to
// epoch ms. Returns null on anything unparseable or an implausible bare value —
// NEVER throws.
function toMs(v) {
  try {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) && !(v > 0 && v < MS_FLOOR) ? v : null;
    const s = String(v).trim();
    if (s === '') return null;
    if (/^\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) && !(n > 0 && n < MS_FLOOR) ? n : null; }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  } catch (_e) { return null; }
}

// The timestamp of one event, tolerating several field names.
function eventAt(e) {
  if (!e || typeof e !== 'object') return null;
  try {
    return toMs(e.at != null ? e.at : (e.ts != null ? e.ts : (e.timestamp != null ? e.timestamp : (e.occurred_at != null ? e.occurred_at : e.created_at))));
  } catch (_e) { return null; }
}
function eventKind(e) {
  if (!e || typeof e !== 'object') return null;
  try { const k = e.kind != null ? e.kind : (e.type != null ? e.type : e.event); return k == null ? null : String(k); }
  catch (_e) { return null; }
}

/**
 * decideTrigger(input) → {
 *   action: 'run' | 'defer' | 'skip',
 *   reason,
 *   materialEvents: [{ kind, at }],   // the material events considered (post-lastRun)
 *   dueAt,                            // epoch ms the run should fire (present on 'defer'/'run')
 *   waitMs,                           // ms until dueAt (0 on 'run')
 *   trigger,                          // the label to pass to runWholeLoan (the newest material kind)
 * }
 *   input: {
 *     events: [{ kind|type|event, at|ts|timestamp|occurred_at|created_at }],
 *     now,                 // epoch ms (required for a real decision; missing → skip)
 *     lastRunAt,           // epoch ms of the last run (null = never run)
 *     lastContextHash,     // the source hash the last run captured (dedup)
 *     contextHash,         // the CURRENT source hash (if equal → nothing really changed)
 *     debounceMs,          // burst window, default 90s
 *     maxDeferMs,          // hard ceiling so continuous activity still runs, default 15m
 *     force,               // caller override → always 'run' now (a manual re-run)
 *   }
 * Deterministic. NEVER THROWS.
 */
function decideTrigger(input) {
  try {
    const o = input && typeof input === 'object' ? input : {};
    const now = toMs(o.now);
    const debounceMs = Number.isFinite(o.debounceMs) && o.debounceMs >= 0 ? o.debounceMs : DEFAULT_DEBOUNCE_MS;
    const maxDeferMs = Number.isFinite(o.maxDeferMs) && o.maxDeferMs >= 0 ? o.maxDeferMs : DEFAULT_MAX_DEFER_MS;
    const lastRunAt = toMs(o.lastRunAt);

    // A forced/manual run fires immediately, regardless of events.
    if (o.force === true) {
      return { action: 'run', reason: 'forced/manual run', materialEvents: [], dueAt: now, waitMs: 0, trigger: 'manual_run' };
    }
    if (now == null) {
      return { action: 'skip', reason: 'no current time supplied', materialEvents: [], dueAt: null, waitMs: null, trigger: null };
    }

    // Keep only MATERIAL events that happened AFTER the last run (an event the
    // last run already saw can't warrant a new one). An event with no parseable
    // time is counted as material-now (we can't prove it's stale) but does not
    // move the debounce clock.
    const raw = Array.isArray(o.events) ? o.events : [];
    const material = [];
    for (const e of raw) {
      const kind = eventKind(e);
      if (!isMaterial(kind)) continue;
      const at = eventAt(e);
      if (at != null && lastRunAt != null && at <= lastRunAt) continue; // already covered
      material.push({ kind, at });
    }

    if (material.length === 0) {
      return { action: 'skip', reason: 'no material events since the last run', materialEvents: [], dueAt: null, waitMs: null, trigger: null };
    }

    // Dedup: if the current context hash equals what the last run captured, the
    // material events did not actually change any underwriting input → skip.
    if (o.contextHash != null && o.lastContextHash != null && String(o.contextHash) === String(o.lastContextHash)) {
      return { action: 'skip', reason: 'context unchanged since last run (same source hash)', materialEvents: material, dueAt: null, waitMs: null, trigger: null };
    }

    const trigger = newestKind(material) || 'event';

    // Debounce over the burst: the run is due debounceMs after the LATEST
    // material event, so a still-arriving burst keeps pushing it out — but never
    // past maxDeferMs after the EARLIEST material event (so continuous activity
    // still gets a run). Events with no timestamp can't be debounced → run now.
    const times = material.map((m) => m.at).filter((t) => t != null);
    if (times.length === 0) {
      return { action: 'run', reason: 'material events with no timestamp — running now', materialEvents: material, dueAt: now, waitMs: 0, trigger };
    }
    const latest = Math.max(...times);
    const earliest = Math.min(...times);
    const debounceDue = latest + debounceMs;
    const ceilingDue = earliest + maxDeferMs;
    const dueAt = Math.min(debounceDue, ceilingDue);

    if (now >= dueAt) {
      return { action: 'run', reason: now >= ceilingDue ? 'max defer reached — running despite ongoing activity' : 'debounce window elapsed', materialEvents: material, dueAt, waitMs: 0, trigger };
    }
    return { action: 'defer', reason: 'within debounce window — waiting for the burst to settle', materialEvents: material, dueAt, waitMs: Math.max(0, dueAt - now), trigger };
  } catch (_e) {
    return { action: 'skip', reason: 'trigger decision failed safe', materialEvents: [], dueAt: null, waitMs: null, trigger: null };
  }
}

// The kind of the newest (latest-timestamped) material event; falls back to the
// last in list order when times are absent.
function newestKind(material) {
  let best = null, bestAt = -Infinity;
  for (const m of material) {
    const at = m.at == null ? -Infinity : m.at;
    if (at >= bestAt) { bestAt = at; best = m.kind; }
  }
  return best;
}

module.exports = {
  decideTrigger,
  isMaterial,
  MATERIAL_EVENTS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_DEFER_MS,
  _internals: { toMs, eventAt, eventKind, newestKind },
};
