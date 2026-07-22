'use strict';
/**
 * R5.49 — Underwriting error postmortem (Prompt G).
 *
 * When a confirmed system outcome disagrees with the authorized HUMAN outcome,
 * this locates the earliest failed component and structures a TESTABLE
 * correction proposal — it does NOT change production behavior. The output is a
 * proposal a human reviews + an evaluation run gates (R5.42/R5.46); it never
 * edits a rule, prompt, threshold, or model.
 *
 * Two parts:
 *  - build(input): the deterministic scaffold (earliest failed component from
 *    the tagged causes, the artifact to change, a regression-fixture stub),
 *    which ships value without an LLM.
 *  - promptFor(input): the Prompt G system+user messages for LLM refinement of
 *    the explanation — constrained to output a proposal only.
 *
 * Pure: no DB, no AI call here (the caller runs the LLM with promptFor()).
 */

const taxonomy = require('./error-taxonomy');

// Map a primary error cause → the artifact type that would be changed to fix it
// (the R5.42 artifact_versions vocabulary). A proposal targets exactly one.
const CAUSE_TO_ARTIFACT = {
  packet_boundary: 'splitter',
  classification: 'classifier',
  ocr: 'ocr',
  field_extraction: 'schema',
  evidence_alignment: 'normalizer',
  document_version: 'source_hierarchy',
  normalization: 'normalizer',
  party_role: 'normalizer',
  timing: 'normalizer',
  fact_reconciliation: 'source_hierarchy',
  guideline_selection: 'guideline',
  deterministic_rule: 'rule',
  ai_reasoning: 'prompt',
  root_cause_clustering: 'root_cause',
  condition_requirement: 'condition_intent',
  condition_aggregation: 'condition_intent',
};

/**
 * build({ symptom, expected, actual, taggedCauses, safeguardsChecked, isException })
 * → a structured proposal (never applied).
 */
function build(input) {
  const i = input || {};
  const primary = taxonomy.earliest(i.taggedCauses || []);
  const artifact = primary ? (CAUSE_TO_ARTIFACT[primary] || null) : null;
  return {
    symptom: i.symptom || null,
    expected: i.expected ?? null,
    actual: i.actual ?? null,
    earliestFailedComponent: primary,
    earliestComponentLabel: primary ? taxonomy.labelOf(primary) : null,
    artifactToChange: artifact,
    // A file-specific exception is NOT a general defect → no artifact change.
    isException: !!i.isException,
    // A regression fixture stub the caller can persist as an evaluation_case.
    regressionFixture: {
      input_snapshot: i.inputSnapshot || {},
      expected: i.expected ?? null,
      label_source: 'postmortem',
      risk_tier: i.riskTier || 'high',
    },
    // The proposal is advisory — it is NEVER auto-applied.
    applied: false,
    recommendation: i.isException
      ? 'File-specific exception — record the exception; do NOT change any artifact.'
      : (artifact
        ? `Propose a change to the ${artifact} artifact; gate it through an evaluation run before any release.`
        : 'Insufficient tagging to isolate a component — request instrumentation, do not guess.'),
  };
}

const SYSTEM_PROMPT = `You analyze a confirmed difference between the system outcome and the authorized human outcome. Your goal is to locate the earliest failed component and propose a TESTABLE correction. You do NOT change production behavior.

Rules:
1. Do not accept the human outcome as a universal rule.
2. Separate a file-specific exception from a general defect.
3. Cite execution-trace steps and evidence IDs.
4. If root cause cannot be isolated, request instrumentation rather than proposing a speculative change.
5. Output a PROPOSAL only; never edit a rule, prompt, threshold, or model deployment.
6. Classify the primary cause using the supplied error taxonomy; identify the earliest failed component, why existing safeguards did not catch it, the exact artifact candidate to change, the regression cases required, and the risks + slices most likely to regress.`;

function promptFor(input) {
  const i = input || {};
  const user = {
    symptom: i.symptom || null,
    expected: i.expected ?? null,
    actual: i.actual ?? null,
    execution_trace: i.executionTrace || [],
    tagged_causes: i.taggedCauses || [],
    safeguards_checked: i.safeguardsChecked || [],
    taxonomy: taxonomy.CAUSES.map((c) => c.key),
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(user) };
}

module.exports = { build, promptFor, CAUSE_TO_ARTIFACT, SYSTEM_PROMPT };
