'use strict';
/**
 * R6.19 — Master Whole-Loan AI Underwriter prompt (non-autonomous EXPLAINER).
 *
 * The deterministic whole-loan RUN (run.js) already produced the authoritative
 * status + gates + findings. This module builds the prompt for an AI that
 * EXPLAINS that decision in plain language, drafts suggested conditions, and
 * names missing evidence — it NEVER decides the loan and NEVER invents or
 * replaces a program number. Its output is a SUGGESTION a human acts on, routed
 * through the existing non-autonomous suggestion pipeline (like every other AI
 * module here). The frozen engines + the deterministic run stay authoritative.
 *
 * Pure: builds { system, user } and validates the AI's response shape. It does
 * NOT call any model (the caller does, through the guarded ai-client).
 */

// The owner's master runtime prompt, constrained to an explainer role. The
// governing principles below are load-bearing: they forbid the AI from changing
// any number or overriding the deterministic decision.
const SYSTEM_PROMPT = `You are the internal YS Capital Whole-Loan AI Underwriter's EXPLAINER for business-purpose RTL loans.

A deterministic engine has ALREADY produced the authoritative underwriting decision (status, term-sheet/CTC/funding eligibility) and the consolidated findings. Your job is NOT to re-decide the loan. Your job is to:
  1. Explain, in plain language, WHY the loan is at its current status and what is blocking each action.
  2. Draft suggested conditions a human underwriter can add (never auto-apply).
  3. Identify missing evidence and inconsistencies worth a human's attention.

Governing principles (ABSOLUTE):
  - NEVER invent or change a guideline, rate, fee, leverage limit, reserve requirement, eligibility rule, or any program number. The frozen Standard/Gold/Manual engines are the sole authority for those.
  - NEVER override, upgrade, or contradict the deterministic decision. If the decision is MANUAL_PENDING, NOT_READY, DATA_CONFLICT, STALE, INELIGIBLE, or has a blocking finding, you may explain it but you may NOT say the loan is approved or issuable.
  - Treat missing facts as missing (NOT_READY) — never assume a value.
  - Every statement you make must be grounded in the supplied context, decision, or findings; cite the finding code or the source field. Do not speculate beyond the supplied data.
  - Everything you output is a SUGGESTION for a human to accept or reject. You take no action.

Return ONLY strict JSON of the shape:
{
  "summary": "one plain-language sentence on the loan's status and the single most important blocker",
  "explanations": [ { "topic": "<what>", "plain": "<plain-language explanation>", "findingCode": "<code or null>" } ],
  "suggestedConditions": [ { "title": "<short>", "why": "<grounded reason>", "findingCode": "<code or null>" } ],
  "missingEvidence": [ { "item": "<what is missing>", "why": "<why it matters>" } ]
}
Do not include a decision, a status, a rate, a loan amount, or any number that is not already present in the supplied data.`;

// Fields we hand the model — the deterministic decision + a compact view of the
// context + findings. We deliberately do NOT ask it to recompute anything.
function promptFor(input) {
  const i = input || {};
  const run = i.run || i; // accept a run result or {run}
  const decision = run.decision || {};
  const user = {
    status: run.status || decision.status || null,
    gates: {
      termSheetEligible: !!run.termSheetEligible,
      ctcEligible: !!run.ctcEligible,
      fundingEligible: !!run.fundingEligible,
    },
    decisionReasons: run.reasons || decision.reasons || [],
    // Findings are the deduped registry — code/severity/title/explanation only
    // (no room for the model to invent new ones).
    findings: (run.findings || []).map((f) => ({
      code: f.code, severity: f.severity, category: f.category || null,
      title: f.title || f.code, explanation: f.explanation || null,
      blocksTermSheet: !!f.blocks_term_sheet, blocksCtc: !!f.blocks_ctc, blocksFunding: !!f.blocks_funding,
    })),
    // Governing structure values (read-only) — labelled so the model knows these
    // are the authoritative numbers it must NOT change.
    governingValues: (i.context && i.context.values) || run.governingValues || null,
    discrepancies: (i.context && i.context.discrepancies) || [],
    instruction: 'Explain this decision and suggest conditions/missing evidence. Do NOT change any number or override the decision.',
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(user) };
}

// Validate the model's response: it must be explanation-only and must not carry
// a fabricated decision/status/number field. Returns { ok, value|reason }.
// A field that looks like the model tried to RE-DECIDE (status/eligibility/rate/
// loan amount at the top level) is rejected — the deterministic decision governs.
const FORBIDDEN_TOP_KEYS = ['status', 'termSheetEligible', 'ctcEligible', 'fundingEligible', 'eligible', 'noteRate', 'rate', 'loanAmount', 'totalLoan', 'approved', 'decision'];

function validateResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, reason: 'not an object' };
  for (const k of FORBIDDEN_TOP_KEYS) {
    if (k in result) return { ok: false, reason: `the explainer may not return "${k}" — the deterministic decision governs` };
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  const value = {
    summary: typeof result.summary === 'string' ? result.summary : '',
    explanations: arr(result.explanations).filter((e) => e && typeof e.plain === 'string'),
    suggestedConditions: arr(result.suggestedConditions).filter((c) => c && typeof c.title === 'string'),
    missingEvidence: arr(result.missingEvidence).filter((m) => m && typeof m.item === 'string'),
  };
  return { ok: true, value };
}

module.exports = { promptFor, validateResult, SYSTEM_PROMPT, FORBIDDEN_TOP_KEYS };
