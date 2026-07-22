'use strict';
/**
 * R6.4 — Whole-loan underwriting status vocabulary + issuability gates.
 *
 * The review's cardinal safety fix: a term sheet / XLSX / structure export must
 * NEVER treat "status !== INELIGIBLE" as issuable. MANUAL (pending), NOT_READY,
 * DATA_CONFLICT, and STALE are all stops — none may produce approved or signable
 * terms. Only ELIGIBLE and an explicitly-approved MANUAL_APPROVED may.
 *
 * This module owns the status set + the gates (canIssueTermSheet / canClearToClose
 * / canFund). It is the SINGLE place those decisions are made, so every export
 * path routes through it instead of hand-rolling a `!== INELIGIBLE` check.
 *
 * It maps the FROZEN engine's raw statuses (ELIGIBLE / MANUAL / INELIGIBLE) to
 * the richer whole-loan set WITHOUT changing any pricing number — a pure
 * classification layer on top.
 *
 * Pure: no DB, no AI.
 */

const STATUS = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  MANUAL_PENDING: 'MANUAL_PENDING',
  MANUAL_APPROVED: 'MANUAL_APPROVED',
  INELIGIBLE: 'INELIGIBLE',
  NOT_READY: 'NOT_READY',
  DATA_CONFLICT: 'DATA_CONFLICT',
  STALE: 'STALE',
});
const ALL = Object.freeze(Object.values(STATUS));

// The ONLY statuses that may produce approved/signable terms.
const ISSUABLE = new Set([STATUS.ELIGIBLE, STATUS.MANUAL_APPROVED]);

/**
 * classify({ engineStatus, manualApproved, missingRequired, conflict, stale }) → status
 *   engineStatus: the FROZEN engine's raw result ('ELIGIBLE'|'MANUAL'|'INELIGIBLE')
 * Precedence (a stop beats a pass): INELIGIBLE > STALE > DATA_CONFLICT >
 * NOT_READY > MANUAL(pending/approved) > ELIGIBLE.
 */
function classify(input) {
  const i = input || {};
  const eng = String(i.engineStatus || '').toUpperCase();

  // A non-waivable engine failure is always ineligible.
  if (eng === 'INELIGIBLE') return STATUS.INELIGIBLE;
  // Structure changed after pricing/approval → stale (re-run required).
  if (i.stale) return STATUS.STALE;
  // Material systems/documents disagree → data conflict.
  if (i.conflict) return STATUS.DATA_CONFLICT;
  // Required facts missing → not ready (never treat missing as pass).
  if (i.missingRequired) return STATUS.NOT_READY;
  // Manual review: approved only if an approval is recorded.
  if (eng === 'MANUAL') return i.manualApproved ? STATUS.MANUAL_APPROVED : STATUS.MANUAL_PENDING;
  // Deterministic pass.
  if (eng === 'ELIGIBLE') return STATUS.ELIGIBLE;
  // Unknown/absent engine status is NOT a pass.
  return STATUS.NOT_READY;
}

function isIssuable(status) { return ISSUABLE.has(status); }

// Explicit gates — every export/CTC/funding path calls these.
function canIssueTermSheet(status) { return ISSUABLE.has(status); }
function canClearToClose(status, { hasFatalFinding } = {}) {
  return ISSUABLE.has(status) && !hasFatalFinding;
}
function canFund(status, { staleRun, hasFatalFinding } = {}) {
  return ISSUABLE.has(status) && !staleRun && !hasFatalFinding;
}

// A plain-language reason an action is blocked (for the UI + audit).
function blockReason(status) {
  switch (status) {
    case STATUS.INELIGIBLE: return 'The loan fails a non-waivable program rule.';
    case STATUS.STALE: return 'The structure changed after pricing/approval — re-run underwriting.';
    case STATUS.DATA_CONFLICT: return 'Systems or documents disagree on a material value — resolve the conflict.';
    case STATUS.NOT_READY: return 'Required facts are missing.';
    case STATUS.MANUAL_PENDING: return 'This loan needs a super-admin exception approval before terms can issue.';
    default: return null;
  }
}

module.exports = { STATUS, ALL, ISSUABLE, classify, isIssuable, canIssueTermSheet, canClearToClose, canFund, blockReason };
