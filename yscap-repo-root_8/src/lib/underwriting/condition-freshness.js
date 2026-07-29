'use strict';
/**
 * #191 activation 3 — condition FRESHNESS reopen planning (pure).
 *
 * Evidence goes stale: a bank statement proves liquidity for ~60 days, a
 * credit report holds ~120, an insurance binder a year. This module decides
 * WHICH cleared conditions have outlived their evidence window — using the
 * R5.31 condition-reopen engine (the single source of the freshness windows)
 * — and returns a capped, ordered PLAN. It never touches the DB: the sweep
 * host applies the plan through the audited reopen path
 * (checklist-evidence.reopenConditionEvidence + an [auto] note), exactly like
 * every other automated reopen in this repo.
 *
 * Safety posture (owner rules):
 *   • WAIVED conditions are never reopened — a waiver is a human decision.
 *   • Only conditions with a mapped, time-sensitive template code are
 *     considered; everything else (incl. the FROZEN SOW/budget gates) is
 *     structurally out of scope — their codes are simply absent from the map.
 *   • The plan is capped so a first activation drains a backlog gradually
 *     instead of reopening a whole portfolio at once.
 */

const conditionReopen = require('./condition-reopen');

// Template code → the condition-reopen freshness KIND (windows live THERE —
// never a second copy of the day counts). Conservative on purpose: only
// clearly time-sensitive evidence. rtl_p1_budget / rtl_p3_sow* (the frozen
// SOW gates) must NEVER appear here.
const KIND_BY_TEMPLATE_CODE = Object.freeze({
  rtl_p3_assets: 'bank_statement',
  rtl_p3_credit: 'credit',
  rtl_p3_credit2: 'credit',
  rtl_cond_credit: 'credit',
  rtl_cond_insurance: 'insurance',
  rtl_cond_flood: 'flood',
  rtl_cond_title: 'title',
});

/**
 * planFreshnessReopens(rows, { now, limit }) → [{ id, applicationId, kind,
 *   trigger, reason, basisAt, basisKind, daysStale }]
 * rows: [{ id, application_id?, template_code, status, signed_off_at,
 *          waived_at, effective_at? }] — cleared checklist items (the caller
 * pre-filters to active files). Oldest-basis first; capped at `limit` (25).
 *
 * FRESHNESS BASIS (owner-directed 2026-07-29): the window is measured from the
 * date the EVIDENCE is effective, not the date staff happened to sign it off.
 * For a credit report that is the report's own "ready to report" / effective
 * date (credit_reports.report_date), passed in as `effective_at` — a 120-day-old
 * report signed off yesterday is already stale. When no `effective_at` is
 * supplied (bank statements, title, insurance, flood — we don't track a separate
 * evidence date), the sign-off date remains the basis, byte-identical to before.
 */
function planFreshnessReopens(rows, opts = {}) {
  const now = opts.now || new Date();
  const limit = Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 25;
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    if (r.waived_at) continue;                       // a waiver is a human decision
    if (!r.signed_off_at) continue;                  // only signed-off clearances age
    const kind = KIND_BY_TEMPLATE_CODE[String(r.template_code || '')];
    if (!kind) continue;
    // Prefer the evidence's own effective date; fall back to the sign-off date.
    const usingEffective = !!r.effective_at;
    const basisAt = r.effective_at || r.signed_off_at;
    const decision = conditionReopen.decide(
      { cleared: true, kind, clearedAt: basisAt },
      { asOf: now });
    if (!decision || !decision.reopen) continue;
    const basisMs = new Date(basisAt).getTime();
    const daysStale = Number.isFinite(basisMs)
      ? Math.floor((now.getTime() - basisMs) / 86400000) : null;
    out.push({
      id: r.id,
      applicationId: r.application_id || null,
      kind,
      trigger: decision.trigger,
      reason: decision.reason,
      basisAt,
      basisKind: usingEffective ? 'effective_date' : 'signed_off',
      clearedAt: basisAt,          // back-compat alias for existing callers
      daysStale,
    });
  }
  // Oldest basis first so the most-stale evidence reopens soonest.
  out.sort((a, b) => new Date(a.basisAt) - new Date(b.basisAt));
  return out.slice(0, limit);
}

/** The borrower/staff-safe [auto] note the sweep writes on a reopened item. */
function autoNoteFor(plan) {
  const days = plan && Number.isFinite(plan.daysStale) ? `${plan.daysStale} days ago` : 'a while ago';
  if (plan && plan.kind === 'credit') {
    return `[auto] The credit report on file is dated ${days} and has passed its 120-day freshness window — please pull a current credit report. The prior report is saved; nothing is lost.`;
  }
  return `[auto] The document that cleared this condition was accepted ${days} and has passed its freshness window — please provide a current version. Your earlier upload is saved; nothing is lost.`;
}

module.exports = { planFreshnessReopens, autoNoteFor, KIND_BY_TEMPLATE_CODE };
