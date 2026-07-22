'use strict';
/**
 * R5.31 — Condition reopen decision (deterministic core).
 *
 * A cleared condition must NOT stay cleared once the evidence it was cleared on
 * is no longer valid. The existing db/071 trigger reopens P&P/SOW on an
 * economics change; this generalizes the rule to the four review triggers:
 *
 *   source_superseded  a document the clearance relied on was superseded
 *   evidence_expired   a freshness-bound condition's evidence aged past its window
 *   fact_changed       a supporting canonical fact changed value
 *   guideline_changed  the guideline version the condition was cleared under changed
 *
 * decide() returns whether to reopen, the trigger, and a plain-language reason —
 * it NEVER reopens without a concrete trigger (no churn), and only reopens a
 * condition that was actually cleared.
 *
 * Pure: no DB, no AI. The caller collects the signals (from the evidence ledger
 * supersession, the freshness rule, the twin, the guideline diff) and applies
 * the returned decision through the normal audited path.
 */

// Freshness windows (days) by condition kind — how long cleared evidence stays
// valid. A null window = never expires on age alone.
const FRESHNESS_DAYS = {
  assets: 60,          // bank statements: ~2 months
  bank_statement: 60,
  good_standing: 90,   // certificate of good standing
  title: 120,
  insurance: 365,
  credit: 120,
  flood: 365,
};

function windowFor(kind) {
  const k = String(kind || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(FRESHNESS_DAYS, k) ? FRESHNESS_DAYS[k] : null;
}

/**
 * decide(condition, signals) →
 *   condition: { cleared:bool, kind?, clearedAt?, guidelineVersionId? }
 *   signals:   { supersededSourceIds?:[], expiredAsOf?:Date|string, changedFactKeys?:[],
 *                guidelineChangedTo?:string, asOf?:Date|string }
 * Returns { reopen:bool, trigger?, reason? }.
 */
function decide(condition, signals) {
  const c = condition || {};
  const s = signals || {};
  // Only a currently-cleared condition can reopen (no churn on open ones).
  if (!c.cleared) return { reopen: false };

  // 1) a source the clearance relied on was superseded.
  if (Array.isArray(s.supersededSourceIds) && s.supersededSourceIds.length) {
    return { reopen: true, trigger: 'source_superseded',
      reason: 'A document this condition was cleared on has been replaced by a newer version — re-verify against the current document.' };
  }

  // 2) freshness: cleared evidence aged past the condition's window.
  const win = windowFor(c.kind);
  if (win != null && c.clearedAt) {
    const clearedMs = new Date(c.clearedAt).getTime();
    const asOfMs = s.asOf ? new Date(s.asOf).getTime() : (s.expiredAsOf ? new Date(s.expiredAsOf).getTime() : null);
    if (Number.isFinite(clearedMs) && Number.isFinite(asOfMs)) {
      const ageDays = (asOfMs - clearedMs) / 86400000;
      if (ageDays > win) {
        return { reopen: true, trigger: 'evidence_expired',
          reason: `The evidence is ${Math.floor(ageDays)} days old, past this condition's ${win}-day freshness window — request an updated document.` };
      }
    }
  }

  // 3) a supporting canonical fact changed.
  if (Array.isArray(s.changedFactKeys) && s.changedFactKeys.length) {
    return { reopen: true, trigger: 'fact_changed',
      reason: `A supporting value changed (${s.changedFactKeys.slice(0, 3).join(', ')}) — the clearance was based on the prior value.` };
  }

  // 4) the guideline version the condition was cleared under changed.
  if (s.guidelineChangedTo && c.guidelineVersionId && s.guidelineChangedTo !== c.guidelineVersionId) {
    return { reopen: true, trigger: 'guideline_changed',
      reason: 'The guideline this condition was cleared under has a new version — re-confirm under the current rules.' };
  }

  return { reopen: false };
}

module.exports = { decide, windowFor, FRESHNESS_DAYS };
