'use strict';
/**
 * LT PPE — the findings LEDGER logic (§10.4, §10.6). PURE: no DB, no clock (nowMs injected). Turns a
 * parity disagreement into a durable finding record and reconciles a fresh shadow run against the
 * stored ledger so a fixed/dismissed finding NEVER re-opens itself (mirrors the RTL finding ledger).
 *
 * IDENTITY is the whole point: a finding is keyed by (investor, program, scenario, kind, coupon) so
 * the same disagreement on the next run merges onto the same row (recurrence++), a settled row is
 * carried forward WITHOUT reopening, and a fixed/verified row that reappears is flagged `regressed`
 * (the fix did not hold — surfaced, never silently reopened). A finding that stops appearing is
 * reported as `disappeared` so the caller can auto-close it (§10.6: a data-driven finding that is
 * gone is resolved, never left dangling).
 *
 * The DB store (a later, migration-backed layer) persists what this returns; sanitizing the payloads
 * (no credentials/PII, §10.4) is the caller's job — this module passes them through opaquely.
 *
 * LT-only. No RTL imports.
 */

const OPEN = new Set(['open', 'triaged']);
const SETTLED = new Set(['fixed', 'verified', 'wontfix']);
// kinds carrying a coupon in their identity (eligibility/engine_error do not)
const RATE_KINDS = new Set(['price_mismatch', 'rate_mismatch', 'rung_missing_ours', 'rung_missing_theirs']);

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/**
 * Stable identity for a finding. Same disagreement -> same key across runs.
 *   { investor, program, scenario, kind, rate }
 */
function findingKey(f = {}) {
  const parts = [norm(f.investor), norm(f.program), norm(f.scenario), norm(f.kind)];
  if (RATE_KINDS.has(f.kind) && f.rate != null) parts.push(String(f.rate));
  if (f.kind === 'engine_error' && f.side) parts.push(norm(f.side));
  return parts.join('|');
}

/**
 * Build persistable finding records from ONE scenario's parity comparison.
 *   cmp: { agree, findings } from parity.compareScenario / shadow.runOne.
 *   ctx: { scenario (label or object), investor, program, ourPayload?, theirPayload?, nowMs }
 * Returns [] when the scenario agreed. Each record is born `open`, recurrence 1.
 */
function recordsFromComparison(cmp = {}, ctx = {}) {
  const findings = Array.isArray(cmp.findings) ? cmp.findings : [];
  const now = typeof ctx.nowMs === 'number' ? ctx.nowMs : null;
  const scenarioLabel = typeof ctx.scenario === 'string' ? ctx.scenario : (ctx.scenarioLabel || '');
  return findings.map((f) => {
    const key = findingKey({ investor: ctx.investor, program: ctx.program, scenario: scenarioLabel, kind: f.kind, rate: f.rate, side: f.side });
    return {
      key,
      investor: ctx.investor || null,
      program: ctx.program || null,
      scenario: scenarioLabel,
      scenarioFacts: (ctx.scenario && typeof ctx.scenario === 'object') ? ctx.scenario : null,
      kind: f.kind,
      diff: f, // the structured disagreement (axis, deltas) — see parity findings
      ourPayload: ctx.ourPayload == null ? null : ctx.ourPayload,
      theirPayload: ctx.theirPayload == null ? null : ctx.theirPayload,
      status: 'open',
      firstSeenMs: now,
      lastSeenMs: now,
      recurrence: 1,
      regressed: false,
    };
  });
}

/**
 * Merge one incoming finding against its stored counterpart (same key).
 * Returns { record, action } where action ∈ new | recurred | carried_settled | carried_wontfix.
 * A settled finding (fixed/verified/wontfix) is CARRIED FORWARD, never reopened; a fixed/verified one
 * that reappears is marked `regressed` so a broken fix is visible.
 */
function mergeOne(existing, incoming) {
  if (!existing) return { record: incoming, action: 'new' };
  const lastSeenMs = incoming.lastSeenMs != null ? incoming.lastSeenMs : existing.lastSeenMs;
  const recurrence = (existing.recurrence || 0) + 1;
  if (SETTLED.has(existing.status)) {
    const regressed = existing.status === 'fixed' || existing.status === 'verified';
    return {
      record: { ...existing, lastSeenMs, recurrence, regressed: regressed || !!existing.regressed, diff: incoming.diff },
      action: existing.status === 'wontfix' ? 'carried_wontfix' : 'carried_settled',
    };
  }
  // open / triaged: keep the human's status, refresh the sighting + latest diff
  return { record: { ...existing, lastSeenMs, recurrence, diff: incoming.diff }, action: 'recurred' };
}

/**
 * Reconcile a whole run's incoming findings against the stored ledger.
 *   existing: [...] stored records (each with a .key).
 *   incoming: [...] fresh records from recordsFromComparison across the run.
 *   opts: { nowMs, closeDisappeared=true } — a stored OPEN finding not seen this run is reported as
 *          disappeared (caller auto-closes it); a settled one that disappears is simply not re-touched.
 * Returns { records, summary:{ new, recurred, carried, regressed, disappeared } } — `records` is the
 * full merged set to persist (excluding disappeared, which are returned separately for closing).
 */
function reconcile(existing = [], incoming = [], opts = {}) {
  const byKey = new Map();
  for (const e of existing) if (e && e.key) byKey.set(e.key, e);
  const seen = new Set();
  const records = [];
  const summary = { new: 0, recurred: 0, carried: 0, regressed: 0, disappeared: 0 };
  const disappeared = [];

  for (const inc of incoming) {
    if (!inc || !inc.key) continue;
    seen.add(inc.key);
    const { record, action } = mergeOne(byKey.get(inc.key), inc);
    if (action === 'new') summary.new += 1;
    else if (action === 'recurred') summary.recurred += 1;
    else summary.carried += 1;
    if (record.regressed) summary.regressed += 1;
    records.push(record);
  }

  for (const e of existing) {
    if (!e || !e.key || seen.has(e.key)) continue;
    if (OPEN.has(e.status)) { disappeared.push(e); summary.disappeared += 1; }
    // a settled finding that didn't recur is left untouched (already persisted)
  }

  return { records, disappeared, summary };
}

module.exports = {
  OPEN_STATUSES: OPEN, SETTLED_STATUSES: SETTLED, RATE_KINDS,
  findingKey, recordsFromComparison, mergeOne, reconcile,
};
