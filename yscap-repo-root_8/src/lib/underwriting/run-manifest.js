'use strict';
/**
 * #214 — per-run REVIEW MANIFEST (orchestration proof).
 *
 * Every whole-loan run should be able to PROVE which underwriting components
 * actually contributed to its decision. This module records that manifest and,
 * when a required component did not contribute, surfaces it as an ORDINARY
 * ADVISORY — never a super-admin gate, never a hard block (owner-directed
 * never-block rule, #217; #214 says an incomplete run is an ADVISORY). The
 * decision still stands and any staff member can proceed; the advisory simply
 * tells the human the run was incomplete so they can treat it as provisional and
 * re-run once the missing piece is available.
 *
 * PURE + dependency-light (compare.num only). NEVER THROWS.
 */
const { num } = require('./compare');

// The components a COMPLETE whole-loan run is expected to include.
//   required=true  → its absence makes the decision PROVISIONAL → one advisory.
//   required=false → optional/conditional; absence is recorded, never an advisory.
const COMPONENTS = Object.freeze([
  { key: 'context_ready',       label: 'Loan file complete (required fields present)', required: true },
  { key: 'program_pricing',     label: 'Registered program pricing decision',         required: true },
  { key: 'structure_ledger',    label: 'Structure ledger (LTC / LTV / ARV)',          required: true },
  { key: 'verification',        label: 'Independent verification sweep',              required: false },
  { key: 'assignment_analysis', label: 'Assignment-fee re-derivation',               required: false },
]);

function statusOf(key, s) {
  switch (key) {
    case 'context_ready':    return s.contextReady ? 'present' : 'absent';
    case 'program_pricing':  return s.programDecision ? 'present' : 'absent';
    case 'structure_ledger': return s.hasLoanBasis ? 'present' : 'absent';
    case 'verification':     return s.verificationAttested ? 'present' : 'absent';
    case 'assignment_analysis':
      return !s.isAssignment ? 'not_applicable' : (s.assignmentRan ? 'present' : 'absent');
    default: return 'absent';
  }
}

/**
 * buildManifest(signals) → {
 *   components: [{ key, label, required, status: 'present'|'absent'|'not_applicable' }],
 *   present: [keys], missingRequired: [keys], complete: boolean
 * }  (PURE, NEVER THROWS)
 * signals: { contextReady, programDecision, hasLoanBasis, verificationAttested,
 *            isAssignment, assignmentRan } (all best-effort booleans).
 */
function buildManifest(signals) {
  const s = signals || {};
  try {
    const components = COMPONENTS.map((c) => ({
      key: c.key, label: c.label, required: c.required, status: statusOf(c.key, s),
    }));
    const present = components.filter((c) => c.status === 'present').map((c) => c.key);
    const missingRequired = components.filter((c) => c.required && c.status === 'absent').map((c) => c.key);
    return { components, present, missingRequired, complete: missingRequired.length === 0 };
  } catch (_e) {
    return { components: [], present: [], missingRequired: [], complete: true };
  }
}

/**
 * signalsFromRun(inputs, calculations) → the boolean signals for buildManifest,
 * derived from what assembleRun already has. PURE, NEVER THROWS.
 */
function signalsFromRun(inputs, calculations) {
  const i = inputs || {};
  const ctx = i.context || {};
  const vals = ctx.values || {};
  const isAssignment = !!vals.is_assignment;
  return {
    contextReady: !!ctx.ready,
    programDecision: !!i.programDecision,
    // A structure ledger is only meaningful with a loan basis to underwrite.
    hasLoanBasis: num(vals.loan_amount) > 0 || num(vals.total_loan) > 0,
    // The caller attests whether the independent-verification sweep ran (0 findings
    // ≠ didn't run), defaulting to true so we never falsely claim it was skipped.
    verificationAttested: i.verificationAttested !== false,
    isAssignment,
    // assembleRun runs the assignment re-derivation whenever the deal is an
    // assignment, so "ran" tracks applicability unless the caller says otherwise.
    assignmentRan: isAssignment && i.assignmentRan !== false,
  };
}

/**
 * manifestFindings(manifest) → advisory finding[]  (PURE, NEVER THROWS)
 * ONE consolidated ADVISORY when required components are missing. It NEVER blocks
 * anything (blocks_term_sheet/ctc/funding all false) — an incomplete run is a
 * heads-up, not a gate; a super-admin (or any staff) proceeds past it freely.
 */
function manifestFindings(manifest) {
  const m = manifest || {};
  const missing = Array.isArray(m.missingRequired) ? m.missingRequired : [];
  if (!missing.length) return [];
  const labelOf = (k) => {
    const c = (m.components || []).find((x) => x.key === k);
    return c ? c.label : k;
  };
  const list = missing.map(labelOf).join('; ');
  return [{
    code: 'run_incomplete',
    subject: 'orchestration',
    severity: 'warning',
    category: 'orchestration',
    title: 'This underwriting run was incomplete',
    explanation: `The run reached a decision without every required component: ${list}. Treat the decision as provisional and re-run once the missing piece is available. This is a heads-up, not a block — you can proceed.`,
    source: 'orchestration',
    governing_rule: 'a complete whole-loan run includes the loan context, program pricing, and structure ledger',
    blocks_term_sheet: false, blocks_ctc: false, blocks_funding: false,
  }];
}

module.exports = { COMPONENTS, buildManifest, signalsFromRun, manifestFindings };
