'use strict';
/**
 * #200 — Admin-question SLA clock (deterministic core, ADVISORY / presentational).
 *
 * An AI agent escalates a question to a super-admin (ai_admin_questions). Until now
 * those questions had no CLOCK — a blocking question could sit unanswered for days
 * with nothing surfacing it. This adds an SLA read: for each OPEN question it
 * computes how long it has been waiting, its due time, and whether it is overdue —
 * so the admin queue can sort worst-first and a digest can nudge on breaches.
 *
 * The due time is the question's explicit `decision_deadline` when one was set
 * (db/264), else `asked_at + the SLA hours for that agent`. FRAUD-class questions
 * (a straw-buyer / non-arm's-length / double-pledge escalation) get the tightest
 * clock; routine cure/committee questions a normal day; low-urgency twin/entity
 * questions two days. NEVER a schema change — this is computed on read, exactly
 * like condition-aging.
 *
 * PURE: no DB, no I/O. `now` is passed in for determinism. It reads and ranks — it
 * answers nothing, decides nothing, changes no status. NEVER THROWS.
 */

const DEFAULT_SLA_HOURS = 24;
// Tighter for fraud-class escalations; looser for low-urgency context questions.
const SLA_HOURS_BY_AGENT = Object.freeze({
  assignment_fraud: 8,
  party_collusion: 8,
  double_pledge: 8,
  fraud: 8,
  authenticity: 12,
  identity_chain: 12,
  cure: 24,
  cure_analysis: 24,
  committee: 24,
  entity_chain: 48,
  twin: 48,
});
const HOUR_MS = 3600 * 1000;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function toMs(v) {
  try {
    if (v == null) return null;
    if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  } catch (_e) { return null; }
}
function nowMs(now) { const t = toMs(now); return t != null ? t : Date.now(); }
function agentKey(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s-]+/g, '_'); }

function slaHoursFor(agent, opts) {
  const o = opts || {};
  const key = agentKey(agent);
  const override = o.slaHoursByAgent && num(o.slaHoursByAgent[key]);
  if (override != null && override > 0) return override;
  if (SLA_HOURS_BY_AGENT[key] != null) return SLA_HOURS_BY_AGENT[key];
  const dflt = num(o.slaHours);
  return dflt != null && dflt > 0 ? dflt : DEFAULT_SLA_HOURS;
}

/**
 * ageQuestion(row, opts) → { …row-lite, open, hoursOpen, slaHours, dueAt, overdue, overdueByHours }
 * A single OPEN admin question's clock. A row already answered (answered_at set) is
 * closed → open:false, no clock. NEVER THROWS.
 */
function ageQuestion(row, opts = {}) {
  try {
    const r = row || {};
    const now = nowMs(opts.now);
    const answered = toMs(r.answered_at || r.answeredAt);
    if (answered != null) {
      return { id: r.id || null, agent: r.agent || null, open: false, hoursOpen: null, slaHours: null, dueAt: null, overdue: false, overdueByHours: 0 };
    }
    const asked = toMs(r.asked_at || r.askedAt) || now;
    const slaHours = slaHoursFor(r.agent, opts);
    // Explicit per-question deadline wins; else asked_at + the agent's SLA.
    const explicitDue = toMs(r.decision_deadline || r.decisionDeadline);
    const dueMs = explicitDue != null ? explicitDue : asked + slaHours * HOUR_MS;
    const hoursOpen = Math.max(0, Math.round(((now - asked) / HOUR_MS) * 10) / 10);
    const overdue = now > dueMs;
    const overdueByHours = overdue ? Math.round(((now - dueMs) / HOUR_MS) * 10) / 10 : 0;
    return {
      id: r.id || null,
      agent: r.agent || null,
      open: true,
      hoursOpen,
      slaHours,
      dueAt: new Date(dueMs).toISOString(),
      overdue,
      overdueByHours,
    };
  } catch (_e) {
    return { id: (row && row.id) || null, agent: (row && row.agent) || null, open: true, hoursOpen: null, slaHours: null, dueAt: null, overdue: false, overdueByHours: 0 };
  }
}

/**
 * ageQuestions(rows, opts) → { rows: [row + _sla], summary } (PURE).
 * Enriches each row with an `_sla` block (leaving the original fields intact) and
 * rolls up an open/overdue/dueSoon summary. `dueSoon` = open, not overdue, due
 * within opts.dueSoonHours (default 4). NEVER THROWS.
 */
function ageQuestions(rows, opts = {}) {
  try {
    const list = Array.isArray(rows) ? rows : [];
    const now = nowMs(opts.now);
    const dueSoonMs = (num(opts.dueSoonHours) != null && opts.dueSoonHours > 0 ? opts.dueSoonHours : 4) * HOUR_MS;
    let open = 0; let overdue = 0; let dueSoon = 0; let oldestHours = 0;
    const out = list.map((r) => {
      const sla = ageQuestion(r, opts);
      if (sla.open) {
        open++;
        if (sla.overdue) overdue++;
        else if (sla.dueAt && (toMs(sla.dueAt) - now) <= dueSoonMs) dueSoon++;
        if (sla.hoursOpen != null && sla.hoursOpen > oldestHours) oldestHours = sla.hoursOpen;
      }
      return Object.assign({}, r, { _sla: sla });
    });
    return { rows: out, summary: { total: list.length, open, overdue, dueSoon, oldestHoursOpen: oldestHours } };
  } catch (_e) {
    return { rows: Array.isArray(rows) ? rows : [], summary: { total: 0, open: 0, overdue: 0, dueSoon: 0, oldestHoursOpen: 0 } };
  }
}

module.exports = { ageQuestion, ageQuestions, slaHoursFor, DEFAULT_SLA_HOURS, SLA_HOURS_BY_AGENT };
