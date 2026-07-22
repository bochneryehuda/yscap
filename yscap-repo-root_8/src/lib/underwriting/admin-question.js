'use strict';
/**
 * R5.40 / R5.41 (core) — admin-question builder + validator.
 *
 * A question the AI escalates to a super-admin must be NARROW and safe:
 *   • tied to ONE blocked decision (blocked_component)
 *   • answerable from displayed evidence (evidence_span_ids required)
 *   • mutually-exclusive options (>=2)
 *   • case-scoped by DEFAULT (never a permanent rule automatically)
 *   • no option may create a permanent rule directly — the strongest an option
 *     can do is REQUEST a rule proposal (which still passes evaluation gates).
 *
 * This module validates + shapes that structure so a producer can't write a
 * vague or unsafe question. Pure: no DB, no AI. The DB shape is db/264.
 */

const ANSWER_SCOPES = new Set(['case_only', 'similar_cases_advisory', 'propose_rule']);

function isNonEmpty(s) { return typeof s === 'string' && s.trim() !== ''; }

/**
 * validate(q) → { ok, errors:[] }. Enforces the safety rules above.
 *   q: { question, blockedComponent, options:[{key,label,effect?,recommended?}],
 *        evidenceSpanIds:[], answerScope?, recommendedOption?, dedupeKey? }
 */
function validate(q) {
  const errors = [];
  q = q || {};
  if (!isNonEmpty(q.question)) errors.push('question text is required');
  if (isNonEmpty(q.question) && q.question.length > 400) errors.push('question is too long (must be narrow)');
  if (!isNonEmpty(q.blockedComponent)) errors.push('blockedComponent is required (a question must tie to ONE blocked decision)');

  const opts = Array.isArray(q.options) ? q.options : [];
  if (opts.length < 2) errors.push('at least 2 mutually-exclusive options are required');
  const keys = new Set();
  for (const o of opts) {
    if (!o || !isNonEmpty(o.key) || !isNonEmpty(o.label)) { errors.push('each option needs a key + label'); continue; }
    if (keys.has(o.key)) errors.push(`duplicate option key "${o.key}"`);
    keys.add(o.key);
  }
  // Evidence is mandatory — a question must be answerable from displayed evidence.
  if (!Array.isArray(q.evidenceSpanIds) || q.evidenceSpanIds.length === 0) {
    errors.push('evidenceSpanIds is required (the reviewer answers from the evidence)');
  }
  // Scope must be valid + defaults to case_only.
  const scope = q.answerScope || 'case_only';
  if (!ANSWER_SCOPES.has(scope)) errors.push(`invalid answerScope "${scope}"`);
  // recommendedOption, if given, must be one of the options.
  if (isNonEmpty(q.recommendedOption) && !keys.has(q.recommendedOption)) {
    errors.push('recommendedOption must be one of the option keys');
  }
  // No option may claim to create a permanent rule directly.
  for (const o of opts) {
    if (o && o.effect && /create.*(permanent|global).*rule|auto.?apply.*rule/i.test(String(o.effect))) {
      errors.push(`option "${o.key}" must not create a permanent rule directly (use propose_rule scope)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * build(q) → a normalized row payload for ai_admin_questions (db/264). Throws if
 * invalid — a producer can never persist a malformed/unsafe question.
 */
function build(q) {
  const v = validate(q);
  if (!v.ok) throw new Error('admin-question: ' + v.errors.join('; '));
  return {
    question: q.question.trim(),
    question_type: q.questionType || null,
    blocked_component: q.blockedComponent,
    option_schema: q.options,
    evidence_span_ids: q.evidenceSpanIds,
    recommended_option: q.recommendedOption || null,
    recommended_rationale: q.recommendedRationale || null,
    answer_scope: q.answerScope || 'case_only',
    learning_eligibility: (q.answerScope === 'propose_rule') ? 'propose_rule' : 'case_only',
    dedupe_key: q.dedupeKey || null,
  };
}

module.exports = { validate, build, ANSWER_SCOPES };
