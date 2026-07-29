'use strict';
/**
 * document-reasoning — the AI pass that READS a document and works out WHAT IT IS, WHAT IT'S FOR,
 * and WHO each named party is (owner-directed 2026-07-27, the tax-certificate incident: "he should
 * pass the document with AI. What is this document? What are we doing with it? What does it mean?").
 *
 * The problem this exists to solve: the field extractor is SLOT-driven — it reads a document as
 * whatever checklist condition it was filed under, then maps fields by position. So a TAX
 * CERTIFICATE filed under a "title" condition gets read as a title report, its CURRENT OWNER (the
 * seller, pre-close) lands in a "buyer" field, and the tie-out compares that owner to the vesting
 * LLC — a guaranteed-nonsense fatal. A field map cannot tell a tax cert from a title commitment; a
 * reasoning pass can.
 *
 * What it produces, per document (advisory, stored on the extraction):
 *   docNature  — what the document ACTUALLY is (e.g. tax_certificate vs title_commitment vs deed),
 *                independent of the slot it was filed under.
 *   purpose    — one plain sentence: what this document tells an underwriter / what it is for.
 *   asOf       — is it a pre-close snapshot (shows the current/old owner) or post-close.
 *   parties    — every named party with a controlled ROLE (seller / current_owner / buyer /
 *                vesting_entity / assignor / assignee / borrower / lender / title_company / …).
 * The comparison-gate (comparison-gate.js) consumes `parties` to refuse a cross-side comparison.
 *
 * SAFETY (all governing HARD RULES):
 *   - OFF by default. Runs only when UW_DOC_REASONING_ENABLED=1 AND Azure OpenAI is configured.
 *   - ADVISORY ONLY. It never writes a condition, never changes a number, never blocks — its output
 *     only ever makes the tie-out QUIETER (suppress a nonsense comparison). It never raises a finding.
 *   - Cost-capped per file (costMeter.allowSpend) and best-effort: unconfigured / over-cap / timeout /
 *     API error / any exception → returns null (the tie-out then behaves exactly as before). NEVER throws.
 */

const azureOpenai = require('../ai/azure-openai');
const costMeter = require('../ai/cost-meter');

// Master switch — ON by default (owner-directed 2026-07-27, "turn everything on"), still gated by
// Azure being configured + the per-file cost cap. Set UW_DOC_REASONING_ENABLED=0 to turn it off.
function enabled() {
  return String(process.env.UW_DOC_REASONING_ENABLED || '') !== '0';
}

// Bound the OCR we send — a reasoning pass only needs the first pages (parties, title, recitals);
// it does not need a 40-page appraisal in full. Env-tunable.
const OCR_CHAR_LIMIT = Math.max(4000, parseInt(process.env.UW_DOC_REASONING_OCR_LIMIT || '40000', 10) || 40000);
const MAX_TOKENS = Math.max(500, parseInt(process.env.UW_DOC_REASONING_MAX_TOKENS || '1500', 10) || 1500);

// The controlled party-role vocabulary — MUST stay in step with comparison-gate.PARTY_ROLE_SIDE
// (only roles it recognizes contribute to a side; anything else is treated as side-neutral).
const PARTY_ROLES = [
  'seller', 'current_owner', 'owner_of_record', 'grantor', 'assignor', 'transferor', 'prior_owner',
  'buyer', 'purchaser', 'grantee', 'assignee', 'transferee', 'vesting_entity', 'borrowing_entity',
  'borrower', 'proposed_insured', 'guarantor',
  'lender', 'title_company', 'escrow_agent', 'notary', 'witness', 'trustee', 'appraiser',
  'taxing_authority', 'insurer', 'other',
];

// The structured shape the model must return. Azure structured outputs are STRICT — every property
// listed in `required`, additionalProperties:false, no min/max/length constraints.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docNature: { type: 'string' },   // what the document actually is (free-text, guided by the prompt)
    purpose: { type: 'string' },     // one plain sentence — what it tells an underwriter
    asOf: { type: 'string', enum: ['pre_close', 'post_close', 'point_in_time', 'unknown'] },
    matchesFiledType: { type: 'boolean' },  // does its true nature match the slot it was filed under?
    parties: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: PARTY_ROLES },
        },
        required: ['name', 'role'],
      },
    },
    confidence: { type: 'number' },
  },
  required: ['docNature', 'purpose', 'asOf', 'matchesFiledType', 'parties', 'confidence'],
};

const SYSTEM = `You are a meticulous mortgage-underwriting document analyst. You are handed the text of ONE document and told which checklist slot it was filed under. Your job is NOT to extract every field — it is to understand the document:
 - What IS this document, really? (e.g. a tax certificate, a title commitment, a warranty deed, a purchase agreement, an assignment of contract, a bank statement, an operating agreement.) Judge from the CONTENT, not the slot it was filed under — documents are often mis-filed.
 - What is it FOR — what does it tell an underwriter?
 - Is it a snapshot of the CURRENT/PAST state (pre-close: it names the current owner / seller) or the state AFTER closing (post-close: it names the new owner / buyer)?
 - WHO is every named party, and what is their ROLE? Classify each into the given role vocabulary. This is the most important output.
CRITICAL for roles: a tax certificate, a tax bill, a title commitment, a deed being conveyed FROM, or any pre-close ownership record names the CURRENT OWNER — that party is the SELLER side (role current_owner or seller), NOT the buyer, even if the document calls them "owner". Only classify a party as buyer/purchaser/grantee/assignee/vesting_entity when the document actually shows them ACQUIRING the property.
Never invent a party or a role you cannot see. Use "other" for a role you are unsure of. Set confidence honestly (0..1): high only when the document's nature and its parties are clear from the text.`;

function instructionFor(docType, fields) {
  const filed = String(docType || 'unknown').replace(/_/g, ' ');
  let extra = '';
  try {
    // A tiny hint of what the slot-driven extractor already pulled, so the model can corroborate
    // or contradict it — never a value to trust blindly.
    const f = fields || {};
    const hint = [];
    if (f.propertyAddress) hint.push('a property address');
    if (f.sellerNames || f.sellerName) hint.push('seller name(s)');
    if (f.buyerName || f.buyerNames) hint.push('a "buyer" name');
    if (f.vestedOwners) hint.push('vested owner(s)');
    if (hint.length) extra = `\nThe slot-driven extractor already pulled: ${hint.join(', ')} — corroborate or correct who those parties really are.`;
  } catch (_) { /* hint is optional */ }
  return `This document was filed under the checklist slot: "${filed}". Read the text below and return your understanding of what it actually is and who its parties are.${extra}`;
}

/**
 * Reason about ONE document. Best-effort; returns a reasoning object or null.
 * @param {object} args
 * @param {import('pg').ClientBase} [args.client]  a pg client for the per-file cost cap (optional)
 * @param {string} args.appId
 * @param {string} args.documentId
 * @param {string} args.docType     the slot it was filed under
 * @param {object} args.fields      the slot-driven extraction (for a hint only)
 * @param {string} args.ocrText     the text the reader pulled from the document
 * @returns {Promise<object|null>}
 */
async function reasonAboutDocument({ client, appId, documentId, docType, fields, ocrText } = {}) {
  try {
    if (!enabled()) return null;
    if (!azureOpenai.available()) return null;
    if (!ocrText || String(ocrText).trim().length < 40) return null;   // nothing to reason over
    // Per-file spend cap — fail OPEN on a read error (allowSpend already fails closed on real overage).
    if (appId) {
      const allowed = await costMeter.allowSpend(appId, client).catch(() => true);
      if (!allowed) return null;
    }

    const started = Date.now();
    const res = await azureOpenai.extract({
      system: SYSTEM,
      instructions: instructionFor(docType, fields),
      schema: SCHEMA,
      ocrText: String(ocrText),
      ocrCharLimit: OCR_CHAR_LIMIT,
      maxTokens: MAX_TOKENS,
      traceMeta: { opName: 'doc-reasoning' },
    });

    // Record the spend (best-effort) whether or not the parse succeeded.
    try {
      const u = res && res.usage;
      await costMeter.record({
        applicationId: appId || null, documentId: documentId || null, opName: 'doc-reasoning',
        provider: 'azure-openai', model: (res && res.model) || null,
        tokensIn: (u && (u.prompt_tokens || u.promptTokens)) || 0,
        tokensOut: (u && (u.completion_tokens || u.completionTokens)) || 0,
        durationMs: Date.now() - started, ok: !!(res && res.ok), reason: res && res.reason,
      });
    } catch (_) { /* cost accounting is additive */ }

    if (!res || !res.ok || !res.data) return null;
    return normalize(res.data);
  } catch (_) {
    return null;   // best-effort — a reasoning failure never affects the extraction or the file
  }
}

// Coerce the model output into the stable stored shape (defensive — the model is strict-schema'd,
// but we still guard so a malformed value can never poison the gate downstream).
function normalize(data) {
  const d = data || {};
  const parties = Array.isArray(d.parties)
    ? d.parties
        .filter((p) => p && typeof p === 'object' && p.name)
        .map((p) => ({ name: String(p.name).slice(0, 200), role: String(p.role || 'other').toLowerCase().trim() }))
        .slice(0, 40)
    : [];
  const conf = Number(d.confidence);
  return {
    docNature: d.docNature ? String(d.docNature).slice(0, 120) : null,
    purpose: d.purpose ? String(d.purpose).slice(0, 600) : null,
    asOf: ['pre_close', 'post_close', 'point_in_time', 'unknown'].includes(d.asOf) ? d.asOf : 'unknown',
    matchesFiledType: typeof d.matchesFiledType === 'boolean' ? d.matchesFiledType : null,
    parties,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { reasonAboutDocument, enabled, _internals: { normalize, SCHEMA, PARTY_ROLES } };
