'use strict';
/**
 * R5.29 — Semantic condition requirement reviewer (Prompt E).
 *
 * Used ONLY when a condition requirement cannot be fully expressed by the cure
 * engine's deterministic assertions. It evaluates ONE named requirement against
 * a page-cited evidence set + a versioned guideline rule, and may return only a
 * constrained outcome — it does not decide the whole loan and creates no new
 * conditions.
 *
 * Pure: no DB, no AI call here. promptFor() returns { system, user } for the
 * caller to run; validateResult() enforces the constrained-outcome + citation
 * contract on the model's reply so a hallucinated span or an out-of-vocabulary
 * outcome is rejected.
 */

const OUTCOMES = new Set([
  'satisfied', 'not_satisfied', 'partially_satisfied', 'wrong_document',
  'stale_evidence', 'conflicting_evidence', 'unable_to_determine',
]);

const SYSTEM_PROMPT = `You evaluate ONE mortgage condition requirement against a supplied, page-cited evidence set and a versioned guideline rule. You do NOT decide the entire loan and you do NOT create new conditions.

Allowed outcomes: satisfied | not_satisfied | partially_satisfied | wrong_document | stale_evidence | conflicting_evidence | unable_to_determine.

Rules:
1. Evaluate ONLY the named requirement.
2. The correct document type alone is never enough.
3. Use only supplied facts, evidence IDs, and guideline rules.
4. If a required fact is absent, return unable_to_determine unless the requirement explicitly requires the document to contain it.
5. If current authoritative evidence conflicts, return conflicting_evidence.
6. If the evidence is superseded or outside the required freshness period, return stale_evidence.
7. Do not infer authority, ownership, liquidity, or coverage from general wording.
8. Explain what exact evidence would resolve any non-satisfied outcome.
9. Cite every supporting and contradicting evidence span by ID.
10. Never cite an evidence ID that was not supplied.`;

function promptFor(input) {
  const i = input || {};
  const user = {
    requirement_id: i.requirementId || null,
    requirement: i.requirement || null,
    acceptable_evidence: i.acceptableEvidence || [],
    unacceptable_evidence: i.unacceptableEvidence || [],
    freshness_days: i.freshnessDays ?? null,
    evidence_spans: (i.evidenceSpans || []).map((s) => ({
      id: s.id, quote: s.quote ?? null, page: s.pageNumber ?? null, value: s.normalizedValue ?? null,
    })),
    facts: i.facts || {},
    guideline_rule: i.guidelineRule || null,
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(user) };
}

/**
 * validateResult(result, suppliedSpanIds) → { ok, errors:[] }. Enforces:
 * a valid outcome, cited spans exist, and a non-satisfied outcome explains the
 * resolving evidence.
 */
function validateResult(result, suppliedSpanIds) {
  const errors = [];
  const r = result || {};
  if (!OUTCOMES.has(r.outcome)) errors.push(`invalid outcome "${r.outcome}"`);
  const known = suppliedSpanIds instanceof Set ? suppliedSpanIds : new Set(suppliedSpanIds || []);
  for (const id of (r.evidenceSpanIds || [])) {
    if (!known.has(id)) errors.push(`cited span "${id}" was not supplied (hallucinated citation)`);
  }
  // A non-satisfied outcome must say what would resolve it.
  if (r.outcome && r.outcome !== 'satisfied' && !(typeof r.explanation === 'string' && r.explanation.trim())) {
    errors.push('a non-satisfied outcome must explain what evidence would resolve it');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { promptFor, validateResult, OUTCOMES, SYSTEM_PROMPT };
