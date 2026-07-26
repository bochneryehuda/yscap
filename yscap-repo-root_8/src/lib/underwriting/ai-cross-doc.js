'use strict';
/**
 * GPT-5 cross-document consistency check (R3.27, owner-directed 2026-07-22).
 *
 * Owner ask: "enhance the data comparison like never before."
 *
 * The pure tie-out (src/lib/underwriting/tieout.js) is deterministic and catches
 * hard mismatches (seller on contract vs title, buyer vs vesting, etc). It does
 * NOT catch subtler cases GPT-5 can spot:
 *   * a name spelled two different ways across three docs the normalizer treats
 *     as different
 *   * a date-of-birth on the ID vs a DOB implied by the credit-report age range
 *   * a property size (sqft / bed / bath) that disagrees on the appraisal vs the
 *     purchase contract vs the loan application in a way units-mode can't equate
 *   * signatures on some docs but not others
 *   * a value on one doc that FOLLOWS a numeric relationship the other says
 *     shouldn't hold (e.g. contract price ≠ appraisal comp sales + credits)
 *
 * The module bundles the file's current extractions into a compact JSON payload,
 * asks GPT-5 (Azure OpenAI, strict JSON) to return a list of concrete
 * contradictions with { concern, docsInvolved[], severity, quote/values }, and
 * posts each as an ai_suggestion (source='cure_analysis', kind='finding'). Best-
 * effort — a paid AI call that errors is dropped silently and never blocks.
 *
 * Runs ONLY on demand (manual trigger from the file view) or once per file per
 * week via a scheduled sweep — never on every file view (would be too expensive).
 */

const azureOpenai = require('../ai/azure-openai');
const langfuse = require('../ai/langfuse');
const aiSug = require('./ai-suggestions');

const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        required: ['concern', 'docsInvolved', 'severity'],
        properties: {
          concern:      { type: 'string', maxLength: 400 },
          docsInvolved: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          severity:     { type: 'string', enum: ['fatal', 'warning', 'info'] },
          values:       { type: ['object', 'null'], additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
          quote:        { type: ['string', 'null'], maxLength: 500 },
          fieldGuess:   { type: ['string', 'null'], maxLength: 80 },
        },
      },
    },
  },
};

const SYSTEM = `You are a mortgage-file cross-document consistency reviewer for PILOT. You will receive one JSON payload containing the CURRENT extractions for every document on file. Your job: find CONCRETE contradictions between documents — values that logically cannot both be true, or names/dates/numbers/entities that disagree in ways a careful human reviewer would flag.

DO NOT invent facts. DO NOT flag missing data. Only flag PROVEN contradictions where two documents show incompatible values for the SAME real-world thing.

For each finding, return:
  concern:      one plain-English sentence a loan officer can read.
  docsInvolved: array of docType strings ("purchase_contract", "title", ...).
  severity:     fatal | warning | info. Fatal only when it blocks closing.
  values:       optional object of doc_type -> value shown.
  quote:        optional short quoted phrase supporting the concern.
  fieldGuess:   optional short field name (e.g. "sellerName", "propertyAddress").

If you find nothing, return { "findings": [] }. Never fabricate.`;

/**
 * Run one cross-doc check for a file. Returns { ok, findings } or { ok:false, reason }.
 * Best-effort — never throws.
 */
async function analyzeFile(client, { applicationId, extractions, appMeta } = {}) {
  if (!azureOpenai.available()) return { ok: false, reason: 'analyzer not configured' };
  if (!Array.isArray(extractions) || extractions.length < 2) {
    return { ok: true, findings: [] };   // nothing to cross-check
  }
  // Compact the payload so we don't blast token budget — one doc per current
  // extraction, first-N chars of any long string values.
  const payload = extractions.slice(0, 20).map(e => ({
    docType: e.doc_type || e.docType,
    documentId: e.document_id,
    fields: compact(e.fields || {}),
  }));
  const trace = langfuse.trace({ name: 'ai-crossdoc:analyze', appId: applicationId, tags: ['crossdoc'] });
  try {
    const r = await azureOpenai.extract({
      system: SYSTEM,
      instructions: `Compare every document below and return concrete contradictions only.\nFile context: ${JSON.stringify(appMeta || {}).slice(0, 400)}\n`,
      schema: RESPONSE_SCHEMA,
      ocrText: JSON.stringify({ documents: payload }),
      maxTokens: 3000,
      trace,
      traceMeta: { opName: 'crossdoc', appId: applicationId },
    });
    if (!r.ok) { trace.end({ output: { error: r.reason } }); return { ok: false, reason: r.reason }; }
    const findings = (r.data && Array.isArray(r.data.findings)) ? r.data.findings : [];
    trace.end({ output: { count: findings.length } });
    // Record each as an ai_suggestion, deduping by (concern hash + docs involved).
    for (const f of findings) {
      try {
        const key = 'crossdoc:' + Buffer.from(`${f.concern}|${(f.docsInvolved || []).join(',')}`).toString('base64').slice(0, 40);
        await aiSug.record(client, {
          applicationId,
          source: 'cure_analysis', kind: 'finding',
          title: `Cross-doc: ${f.concern.slice(0, 100)}`,
          body: `${f.concern}${f.quote ? `\n\nDocument quote: "${f.quote}"` : ''}${f.values ? `\n\nValues seen: ${JSON.stringify(f.values, null, 2)}` : ''}${f.docsInvolved && f.docsInvolved.length ? `\n\nDocuments: ${f.docsInvolved.join(', ')}` : ''}`,
          severity: f.severity || 'warning',
          traceUrl: trace.url ? trace.url() : null,
          evidence: { docs: f.docsInvolved, values: f.values, quote: f.quote, fieldGuess: f.fieldGuess, layer: 'ai_crossdoc' },
          proposedAction: {
            type: 'create_finding',
            fields: { code: 'ai_crossdoc_conflict', severity: f.severity || 'warning', title: f.concern, howTo: f.concern, source: 'ai_crossdoc' },
          },
          dedupeKey: key,
        });
      } catch (_) { /* one bad finding never stops the rest */ }
    }
    return { ok: true, findings };
  } catch (e) { trace.end({ output: { error: e.message } }); return { ok: false, reason: e.message }; }
}

// Trim big string leaves so we don't send tens of MB of OCR text to GPT.
function compact(fields, depth = 0) {
  if (!fields || typeof fields !== 'object') return fields;
  if (Array.isArray(fields)) return fields.slice(0, 30).map((v) => compact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.length > 500) out[k] = v.slice(0, 500) + '…';
    else if (v && typeof v === 'object' && depth < 4) out[k] = compact(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

module.exports = { analyzeFile };
