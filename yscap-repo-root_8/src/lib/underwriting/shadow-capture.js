'use strict';
/**
 * #200 — Shadow-decision LIVE FEED (closing the calibration loop's data gap).
 *
 * #194 built the calibration machinery — reliability.ingestOutcome() stamps a
 * shadow decision's human_outcome, and reliability.loadReliabilityReport() scores
 * accuracy / Brier / calibration / dangerous-miss over the shadow decisions whose
 * outcome is known. But NOTHING wrote a shadow_decisions row and NOTHING called
 * ingestOutcome, so the report was always empty. This module is that missing feed:
 *
 *   1. WRITER — every whole-loan run records the AI/engine's would-be decision
 *      (its canonical verdict + the eligibility gates) as the CANDIDATE decision on
 *      ONE open shadow per file (component='whole_loan'). Re-running just refreshes
 *      the open candidate (no flood) until a human outcome lands.
 *   2. OUTCOME — when the file reaches a human-owned terminal state (funded = the
 *      humans cleared it; declined/withdrawn = the humans did not), the realized
 *      outcome is stamped onto that open shadow via reliability.ingestOutcome, and
 *      the calibration report finally has a scored data point.
 *
 * The AI verdict is ADVISORY and non-authoritative — this only OBSERVES what the
 * engine would have said vs. what the humans actually did (a would-have-been-right
 * check), never decides, never blocks. Pure helpers are unit-testable; the DB
 * writers are best-effort and NEVER throw (a calibration write must never break a
 * run or a status change).
 */

const { canonicalVerdict } = require('./shadow-decision');

// Terminal, HUMAN-owned outcomes → the realized verdict for calibration.
// funded = the humans cleared & closed it; declined/withdrawn = they did not.
// Everything else (in-process) is NOT yet an outcome — leave the shadow open.
const OUTCOME_BY_STATUS = Object.freeze({
  funded: 'clear',
  closed: 'clear',
  declined: 'decline',
  denied: 'decline',
  withdrawn: 'decline',
  dead: 'decline',
});

/** outcomeFromStatus(status) → 'clear' | 'decline' | null (PURE). */
function outcomeFromStatus(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return OUTCOME_BY_STATUS[s] || null;
}

// The whole-loan status vocabulary (uw-status.js) → the AI's canonical verdict.
// Compound statuses (MANUAL_PENDING / DATA_CONFLICT / NOT_READY / STALE) aren't in
// canonicalVerdict's single-word list, so map them explicitly here; fall back to
// canonicalVerdict for any other spelling.
const STATUS_VERDICT = Object.freeze({
  eligible: 'clear',
  manual_approved: 'clear',
  manual_pending: 'refer',
  data_conflict: 'refer',
  ineligible: 'decline',
  not_ready: 'unknown',
  stale: 'unknown',
});
function verdictForStatus(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === '') return 'unknown';
  return STATUS_VERDICT[s] || canonicalVerdict(status);
}

/**
 * runToShadowCandidate(run) → candidate_decision jsonb-ready object (PURE).
 * Maps a whole-loan run (assembleRun / a persisted run row) to the calibration
 * candidate shape reliability.loadReliabilityReport reads: { component, verdict,
 * confidence, gates, status }. The verdict is the canonical bucket of the run
 * status (ELIGIBLE→clear, INELIGIBLE→decline, MANUAL_*→refer, NOT_READY→unknown).
 * NEVER THROWS.
 */
function runToShadowCandidate(run) {
  try {
    const r = run || {};
    const status = r.status != null ? String(r.status) : null;
    // camel (assembleRun) or snake (persisted row) gate names.
    const termSheet = r.termSheetEligible === true || r.term_sheet_eligible === true;
    const ctc = r.ctcEligible === true || r.ctc_eligible === true;
    const funding = r.fundingEligible === true || r.funding_eligible === true;
    return {
      component: 'whole_loan',
      verdict: verdictForStatus(status),
      rawVerdict: status,
      // The whole-loan run is deterministic (not a probabilistic model), so there
      // is no model confidence to record — left null; accuracy / dangerous-miss
      // still score, only the Brier / calibration curve need a confidence.
      confidence: null,
      gates: { termSheet, ctc, funding },
      status,
      runId: r.runId != null ? String(r.runId) : (r.id != null ? String(r.id) : null),
    };
  } catch (_e) {
    return { component: 'whole_loan', verdict: 'unknown', rawVerdict: null, confidence: null, gates: {}, status: null, runId: null };
  }
}

/**
 * recordRunShadow(client, { applicationId, run }) → { ok, action } (DB, best-effort).
 * Keeps ONE OPEN (human_outcome IS NULL) whole_loan shadow per file: refreshes its
 * candidate to the newest run, or inserts the first one. Never floods, never throws.
 */
async function recordRunShadow(client, { applicationId, run } = {}) {
  if (!client || !applicationId || !run) return { ok: false, action: 'skip' };
  const candidate = JSON.stringify(runToShadowCandidate(run));
  try {
    // Refresh the newest still-open whole_loan candidate for this file, if any.
    const upd = await client.query(
      `UPDATE shadow_decisions
          SET candidate_decision = $2::jsonb
        WHERE id = (
          SELECT id FROM shadow_decisions
           WHERE application_id = $1
             AND human_outcome IS NULL
             AND candidate_decision->>'component' = 'whole_loan'
           ORDER BY created_at DESC
           LIMIT 1)`,
      [applicationId, candidate]);
    if (upd.rowCount > 0) return { ok: true, action: 'updated' };
    await client.query(
      `INSERT INTO shadow_decisions (application_id, candidate_decision) VALUES ($1, $2::jsonb)`,
      [applicationId, candidate]);
    return { ok: true, action: 'inserted' };
  } catch (_e) { return { ok: false, action: 'error' }; }
}

/**
 * ingestStatusOutcome(client, { applicationId, status, at }) → { ok, stamped } (DB, best-effort).
 * When the file reaches a terminal human-owned status, stamp the realized outcome
 * onto its open whole_loan shadow (via reliability.ingestOutcome). A non-terminal
 * status is a no-op. NEVER THROWS.
 */
async function ingestStatusOutcome(client, { applicationId, status, at } = {}) {
  if (!client || !applicationId) return { ok: false, stamped: 0 };
  const outcome = outcomeFromStatus(status);
  if (!outcome) return { ok: true, stamped: 0 };
  try {
    const reliability = require('./reliability');
    const n = await reliability.ingestOutcome(client, { applicationId, component: 'whole_loan', outcome, at: at || null });
    return { ok: true, stamped: n };
  } catch (_e) { return { ok: false, stamped: 0 }; }
}

module.exports = {
  outcomeFromStatus, runToShadowCandidate, recordRunShadow, ingestStatusOutcome,
  OUTCOME_BY_STATUS,
};
