'use strict';
/**
 * R6.14 — Whole-loan final-decision resolver (deterministic core).
 *
 * The single place a whole-loan run turns (program status + independent
 * calculations + consolidated findings + system reconciliations) into ONE final
 * status and the term-sheet / CTC / funding eligibility gates. Every export /
 * CTC / funding action is gated on THIS — never a hand-rolled "!== INELIGIBLE".
 *
 * Composes uw-status (the status classification + issuability gates) with the
 * consolidated finding registry (R6.9). Pure: no DB, no AI. It DECIDES; the
 * caller applies (stores the run, blocks the action).
 */

const uwStatus = require('./uw-status');
const findingRegistry = require('./finding-registry');

/**
 * decide(input) → {
 *   status, termSheetEligible, ctcEligible, fundingEligible,
 *   blockingFindings:[], reasons:[]
 * }
 *   input: {
 *     engineStatus,            // FROZEN engine raw status (ELIGIBLE|MANUAL|INELIGIBLE)
 *     manualApproved,          // is a MANUAL exception approved?
 *     missingRequired,         // are required facts missing?
 *     staleRegistration,       // priced on since-changed inputs?
 *     discrepancies:[],        // source-of-truth disagreements (source-priority)
 *     findings:[],             // raw findings from every desk
 *     staleRun,                // is this run itself stale (superseded)?
 *   }
 */
function decide(input) {
  const i = input || {};
  const registry = findingRegistry.consolidate(i.findings || []);
  const sum = findingRegistry.summarize(registry);

  // A material source-of-truth disagreement is a DATA_CONFLICT.
  const hasConflict = Array.isArray(i.discrepancies) && i.discrepancies.length > 0;

  const status = uwStatus.classify({
    engineStatus: i.engineStatus,
    manualApproved: i.manualApproved,
    missingRequired: i.missingRequired,
    conflict: hasConflict,
    stale: i.staleRegistration,
  });

  const reasons = [];
  const blockReason = uwStatus.blockReason(status);
  if (blockReason) reasons.push(blockReason);
  if (hasConflict) reasons.push(`${i.discrepancies.length} system/document disagreement(s) to resolve.`);
  if (sum.hasFatal) reasons.push(`${sum.fatal} fatal finding(s) open.`);

  const termSheetEligible = uwStatus.canIssueTermSheet(status) && !sum.blocksTermSheet;
  const ctcEligible = uwStatus.canClearToClose(status, { hasFatalFinding: sum.blocksCtc })
    && !hasConflict;
  const fundingEligible = uwStatus.canFund(status, { staleRun: i.staleRun, hasFatalFinding: sum.blocksFunding })
    && !hasConflict;

  const blockingFindings = registry.filter((f) => f.blocks_term_sheet || f.blocks_ctc || f.blocks_funding || String(f.severity).toLowerCase() === 'fatal');

  return {
    status,
    termSheetEligible,
    ctcEligible,
    fundingEligible,
    registry,
    summary: sum,
    blockingFindings,
    reasons,
  };
}

module.exports = { decide };
