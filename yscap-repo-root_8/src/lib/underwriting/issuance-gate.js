'use strict';
/**
 * R6.18 — The single issuance gate every export / CTC / funding path consults.
 *
 * The review's cardinal compliance rule: NO term sheet, XLSX/structure export,
 * clear-to-close, or funding action may proceed on a `status !== INELIGIBLE`
 * hand-check. Every one of those actions calls THIS gate, which reads the
 * whole-loan run's final decision (decision.js) and answers allowed/blocked with
 * the reasons + the blocking findings. It FAILS CLOSED: no run, an error, or an
 * unknown action all deny.
 *
 * Actions: 'term_sheet' | 'ctc' | 'funding'.
 *
 * Pure core (gateFor) + a thin DB reader (gateFromLatestRun) so routes can gate
 * without re-running the whole underwriting pass on every click.
 */

const ACTIONS = Object.freeze(['term_sheet', 'ctc', 'funding']);

/**
 * gateFor(decision, action) → { allowed, action, status, reason, blockers }.
 *   decision: a decision.decide() result OR a stored run row exposing
 *             { status, termSheetEligible|term_sheet_eligible, ctcEligible|ctc_eligible,
 *               fundingEligible|funding_eligible, reasons, blockingFindings }.
 * PURE. Unknown action / missing decision → denied (fail closed).
 */
function gateFor(decision, action) {
  if (!ACTIONS.includes(action)) {
    return { allowed: false, action, status: null, reason: 'Unknown issuance action — denied.', blockers: [] };
  }
  if (!decision) {
    return { allowed: false, action, status: null, reason: 'No underwriting decision on file — run underwriting first.', blockers: [] };
  }
  const eligible = eligibilityOf(decision, action);
  const status = decision.status || null;
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
  const blockers = blockersFor(decision, action);
  if (eligible) return { allowed: true, action, status, reason: null, blockers: [] };
  return {
    allowed: false,
    action,
    status,
    reason: reasons[0] || `${labelOf(action)} is not permitted at status ${status}.`,
    blockers,
  };
}

// Read the per-action eligibility flag, tolerating both the camelCase decision
// shape and the snake_case stored-run row shape.
function eligibilityOf(d, action) {
  switch (action) {
    case 'term_sheet': return pick(d, 'termSheetEligible', 'term_sheet_eligible');
    case 'ctc': return pick(d, 'ctcEligible', 'ctc_eligible');
    case 'funding': return pick(d, 'fundingEligible', 'funding_eligible');
    default: return false;
  }
}
function pick(o, camel, snake) {
  if (o[camel] !== undefined) return !!o[camel];
  if (o[snake] !== undefined) return !!o[snake];
  return false;
}

function blockersFor(d, action) {
  const list = Array.isArray(d.blockingFindings) ? d.blockingFindings : [];
  if (action === 'term_sheet') return list.filter((f) => f.blocks_term_sheet || String(f.severity).toLowerCase() === 'fatal');
  if (action === 'ctc') return list.filter((f) => f.blocks_ctc || String(f.severity).toLowerCase() === 'fatal');
  if (action === 'funding') return list.filter((f) => f.blocks_funding || String(f.severity).toLowerCase() === 'fatal');
  return list;
}

function labelOf(action) {
  return ({ term_sheet: 'Issuing a term sheet', ctc: 'Clear-to-close', funding: 'Funding' })[action] || 'This action';
}

/**
 * gateFromLatestRun(applicationId, action, db) → gate result (async).
 * Reads the CURRENT (non-superseded) underwriting run for the file and gates on
 * its stored decision. Fails CLOSED on no run / DB error. A STALE-run guard: a
 * funding action additionally requires the run not be superseded (it is, by the
 * `superseded_at IS NULL` filter) AND fresh — the current run is always the
 * freshest, so freshness is implicit here; the run orchestrator re-runs on every
 * material event (R6.15) so the current run reflects the latest state.
 */
async function gateFromLatestRun(applicationId, action, db) {
  if (!applicationId) return { allowed: false, action, status: null, reason: 'No file — denied.', blockers: [] };
  try {
    const r = await db.query(
      `SELECT status, term_sheet_eligible, ctc_eligible, funding_eligible
         FROM underwriting_runs
        WHERE application_id = $1 AND superseded_at IS NULL
        ORDER BY created_at DESC LIMIT 1`, [applicationId]);
    const run = r.rows[0];
    if (!run) {
      return { allowed: false, action, status: null, reason: 'No current underwriting run — run underwriting before this action.', blockers: [] };
    }
    // Pull the run's blocking findings for the reasons (best-effort).
    let blockingFindings = [];
    try {
      const fr = await db.query(
        `SELECT code, severity, title, blocks_term_sheet, blocks_ctc, blocks_funding
           FROM underwriting_run_findings f
           JOIN underwriting_runs ru ON ru.id = f.run_id
          WHERE ru.application_id = $1 AND ru.superseded_at IS NULL
            AND (f.severity = 'fatal' OR f.blocks_term_sheet OR f.blocks_ctc OR f.blocks_funding)`, [applicationId]);
      blockingFindings = fr.rows;
    } catch (_e) { /* findings are advisory for the reason text */ }
    return gateFor({ ...run, blockingFindings }, action);
  } catch (_e) {
    // Fail closed on any DB error — never let an unreadable decision permit issuance.
    return { allowed: false, action, status: null, reason: 'Underwriting decision could not be read — denied for safety.', blockers: [] };
  }
}

module.exports = { gateFor, gateFromLatestRun, ACTIONS };
