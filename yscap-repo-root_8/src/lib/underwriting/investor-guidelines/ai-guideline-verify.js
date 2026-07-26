'use strict';

/**
 * ai-guideline-verify — the AI SATISFACTION-QUALITY check for investor guidelines.
 *
 * When a note-buyer condition has been SATISFIED on a file, this asks the grounded
 * GPT brain whether the CLEARED evidence actually meets that investor's EXACT rule
 * (the note_buyer_conditions.required_evidence / checks). It is grounded on the
 * canonical Loan File Primer (loan-primer.groundingBlock) so the model reads every
 * loan number correctly and never confuses purchase price / as-is / ARV / loan
 * amount. If GPT judges the evidence does NOT meet the rule, it raises ONE advisory
 * ai_suggestion — it NEVER blocks, never reopens/clears a condition, touches no
 * frozen number (governing rule: the AI never acts, a human does).
 *
 * OFF unless Azure OpenAI is configured (azureOpenai.available()); COST-CAPPED per
 * file (costMeter.allowSpend) so it can never run past the per-file spend cap;
 * langfuse-traced; best-effort — every entry point is guarded and NEVER throws.
 *
 * This runs ON DEMAND (a human triggers it) or on a bounded event — NOT on every
 * file view — to keep GPT spend controlled.
 */

const azureOpenai = require('../../ai/azure-openai');
const langfuse = require('../../ai/langfuse');
const costMeter = require('../../ai/cost-meter');
const aiSug = require('../ai-suggestions');
const primer = require('../loan-primer');

const SOURCE = 'investor_guideline_ai';

// Structured verdict the model must return.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    meets: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
  },
  required: ['meets', 'confidence', 'reason', 'missing'],
};

const SYSTEM_TAIL = `\n\nYou are a meticulous mortgage underwriting reviewer for a note buyer (capital partner).
Judge ONLY whether the cleared evidence meets the stated requirement. Default to meets=true when the
evidence plausibly satisfies the requirement OR you cannot tell — set meets=false ONLY when you can
name a concrete, specific shortfall (put it in "missing"). Never fabricate a shortfall. Be conservative.`;

/**
 * buildInstruction(condition) → string (PURE, never throws).
 * The per-condition instruction: the note buyer's requirement + specific checks,
 * and the task (judge whether the cleared evidence meets it).
 */
function buildInstruction(condition) {
  try {
    const c = condition || {};
    const name = c.name || c.label || 'this condition';
    const req = c.required_evidence || c.requiredEvidence || '(no explicit requirement text was provided)';
    const checkLines = Array.isArray(c.checks)
      ? c.checks.map((k) => `  - ${(k && (k.text || k.detail)) || String(k)}`).filter((s) => s.trim() !== '  -').join('\n')
      : '';
    return [
      `The note buyer requires the following for the condition "${name}":`,
      `REQUIRED EVIDENCE: ${req}`,
      checkLines ? `SPECIFIC CHECKS:\n${checkLines}` : '',
      `This condition has been marked SATISFIED on the file. Using the loan grounding above and the`,
      `cleared document's extracted fields provided below, decide whether the cleared evidence ACTUALLY`,
      `meets the note buyer's requirement, and if not, list exactly what is missing.`,
    ].filter(Boolean).join('\n\n');
  } catch (_e) { return 'Judge whether the cleared evidence meets the note buyer requirement.'; }
}

/**
 * verdictToSuggestion(condition, verdict, opts) → ai-suggestions payload | null (PURE).
 * meets !== false → null (nothing to raise). meets === false → a warning finding.
 * Does NOT include applicationId — the DB layer adds it.
 */
function verdictToSuggestion(condition, verdict, opts) {
  try {
    const v = verdict || {};
    if (v.meets !== false) return null;
    const c = condition || {};
    const name = c.name || c.label || 'this condition';
    const missing = Array.isArray(v.missing) ? v.missing.filter(Boolean) : [];
    const conf = typeof v.confidence === 'number' ? v.confidence : null;
    return {
      source: SOURCE, kind: 'finding', severity: 'warning', important: false,
      title: `AI review: the cleared document may not meet the note buyer's rule for "${name}"`,
      body: `${v.reason || 'The cleared evidence may not meet the note buyer requirement.'}`
        + (missing.length ? ` Missing: ${missing.join('; ')}.` : '')
        + ` This is an advisory — confirm the clear or reopen and request the right evidence.`,
      confidence: conf,
      traceUrl: (opts && opts.traceUrl) || null,
      evidence: { code: 'isg_ai_verify', cond_no: c.cond_no != null ? c.cond_no : null, confidence: conf, missing },
      proposedAction: { type: 'review_condition', checklistItemId: (c.checklistItemId || c.checklist_item_id) || null,
        reason: 'AI read of the cleared evidence says it may not meet the note buyer rule.' },
      dedupeKey: `isg-ai-verify:${c.cond_no != null ? c.cond_no : (c.checklistItemId || c.checklist_item_id || name)}`,
    };
  } catch (_e) { return null; }
}

/**
 * loadFileExtractedFields(client, appId) → { [docType]: fields } (DB, best-effort).
 * The file's CURRENT per-document extracted fields (newest row per doc_type), so the
 * grounded verifier can read the SPECIFIC document numbers — e.g. a hazard policy's
 * dwelling-coverage amount, an operating agreement's members — that the loan-level
 * primer may not carry as a canonical twin fact. NEVER throws; returns {} on any error
 * or missing input. Bounded (≤40 doc types) so it can't balloon the GPT context.
 */
async function loadFileExtractedFields(client, appId) {
  try {
    if (!client || typeof client.query !== 'function' || !appId) return {};
    const { rows } = await client.query(
      `SELECT doc_type, fields FROM document_extractions
        WHERE application_id = $1 AND is_current = true AND fields IS NOT NULL
        ORDER BY created_at DESC`, [appId]);
    const out = {};
    for (const r of (rows || [])) {
      const dt = (r && r.doc_type) || 'document';
      if (out[dt] || !r || !r.fields || typeof r.fields !== 'object') continue; // newest per doc_type wins
      out[dt] = r.fields;
      if (Object.keys(out).length >= 40) break;
    }
    return out;
  } catch (_e) { return {}; }
}

/**
 * verifySatisfiedCondition(client, { applicationId, condition, docFields, db }) → result (DB/GPT).
 * Grounded GPT satisfaction check for ONE satisfied note-buyer condition. NEVER throws.
 * Returns { ok, meets?, raised?, reason? }.
 */
async function verifySatisfiedCondition(client, { applicationId, condition, docFields, db } = {}) {
  try {
    if (!azureOpenai.available()) return { ok: false, reason: 'not configured' };
    if (!applicationId || !condition) return { ok: false, reason: 'missing input' };
    // Per-file cost cap — never spend past the cap. Fail OPEN (allow) only on a
    // read error, since allowSpend already fails closed internally on real overage.
    const allowed = await costMeter.allowSpend(applicationId, client).catch(() => true);
    if (allowed === false) return { ok: false, reason: 'cost cap reached' };

    const grounding = await primer.groundingBlock(applicationId, db || client).catch(() => primer.PRIMER_TEXT);
    const instruction = buildInstruction(condition);
    const trace = langfuse.trace({ name: 'isg-ai-verify', appId: applicationId, tags: ['investor_guideline'] });
    try {
      const res = await azureOpenai.extract({
        system: grounding + SYSTEM_TAIL,
        instructions: instruction,
        schema: VERDICT_SCHEMA,
        ocrText: JSON.stringify({ clearedDocumentFields: docFields || {} }).slice(0, 8000),
        maxTokens: 1200,
        trace,
        traceMeta: { opName: 'isg-ai-verify', appId: applicationId },
      });
      if (!res || !res.ok || !res.data) { if (trace.end) trace.end({ output: { error: (res && res.reason) || 'no verdict' } }); return { ok: false, reason: (res && res.reason) || 'no verdict' }; }
      const verdict = res.data;
      if (verdict.meets !== false) { if (trace.end) trace.end({ output: { meets: true } }); return { ok: true, meets: true }; }
      const payload = verdictToSuggestion(condition, verdict, { traceUrl: trace.url ? trace.url() : null });
      if (payload) {
        await aiSug.record(client, Object.assign({ applicationId, checklistItemId: (condition.checklistItemId || condition.checklist_item_id) || null }, payload)).catch(() => {});
      }
      if (trace.end) trace.end({ output: { meets: false } });
      return { ok: true, meets: false, raised: !!payload };
    } catch (e) { if (trace.end) trace.end({ output: { error: e && e.message } }); return { ok: false, reason: (e && e.message) || 'error' }; }
  } catch (_e) { return { ok: false, reason: 'error' }; }
}

module.exports = { verifySatisfiedCondition, loadFileExtractedFields, buildInstruction, verdictToSuggestion, VERDICT_SCHEMA, SOURCE };
