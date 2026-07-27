'use strict';
/**
 * finding-ai-review — the AI GATE on every finding (owner-directed 2026-07-27).
 *
 * The owner: "before you post that finding to the document review section as a real finding, pass it
 * through the AI — show it the finding, the ENTIRE loan file, and the document you used — and ask if
 * the finding is reasonable or it's messed up because you don't understand. Save that feedback and
 * remember it. Don't post a finding/condition unless it passed the AI and the AI said yes it's a
 * real concerning finding. And ask the AI what resolution it suggests and what document to request,
 * and build your suggestions on top of the findings from that."
 *
 * So for every finding PILOT raises, this asks a grounded GPT reviewer — given the whole loan file
 * (loan-primer.groundingBlock) + the source document the finding is based on + PILOT's finding and
 * its reasoning — three things:
 *   1. Is this a REAL, concerning finding an underwriter should act on, or a false alarm / a
 *      mechanical misunderstanding (comparing a seller to a buyer, a formatting difference, a value
 *      that is actually fine in context)?  → verdict: confirmed | rejected | uncertain
 *   2. If real, what is the suggested RESOLUTION?
 *   3. What DOCUMENT (if any) should we request?
 * The verdict is REMEMBERED (finding_ai_reviews, db/337) keyed on the finding's fingerprint, so a
 * re-read is not re-billed and a confidently-rejected finding stays suppressed instead of popping
 * back on the next view — the same "a decision must stick" guarantee the human ledger (db/333) gives.
 *
 * GATE SEMANTICS (advisory, never blocks — governing "AI findings are advisory only" rule):
 *   - The gate can ONLY suppress a false alarm from the shown list, or enrich a real finding with the
 *     AI's suggested resolution/document. It never creates a finding, never clears a condition,
 *     never blocks CTC/funding, and touches no frozen number.
 *   - A finding is SUPPRESSED only on a CONFIDENT 'rejected' verdict. 'confirmed' and 'uncertain' both
 *     stay visible (uncertain flagged) — the AI removes what it is sure is nonsense, but a real
 *     finding is never hidden merely because the AI wasn't sure.
 *   - FAIL-OPEN: when the AI is off / unconfigured / over the per-file cost cap / errors, NOTHING is
 *     suppressed (every finding shows exactly as today). A broken AI must never blind the underwriter.
 *
 * OFF-switch: FINDING_AI_REVIEW_ENABLED=0 (ON by default, still gated by Azure being configured +
 * the per-file cost cap). Best-effort — every entry point is guarded and NEVER throws.
 */

const crypto = require('crypto');
const azureOpenai = require('../ai/azure-openai');
const costMeter = require('../ai/cost-meter');
const primer = require('./loan-primer');
const { claimOf } = require('./finding-claims');

// ON by default (owner-directed "turn everything on"); disable with FINDING_AI_REVIEW_ENABLED=0.
function enabled() {
  return String(process.env.FINDING_AI_REVIEW_ENABLED || '') !== '0';
}

// Bound how many NEW findings we send to GPT per file per pass (cost). Memoized verdicts are free,
// so over successive views the whole file gets reviewed; one pass is capped. Env-tunable.
const MAX_REVIEWS_PER_PASS = Math.max(1, parseInt(process.env.FINDING_AI_REVIEW_MAX || '12', 10) || 12);
const OCR_CHAR_LIMIT = Math.max(4000, parseInt(process.env.FINDING_AI_REVIEW_OCR_LIMIT || '24000', 10) || 24000);
const MAX_TOKENS = Math.max(400, parseInt(process.env.FINDING_AI_REVIEW_MAX_TOKENS || '1200', 10) || 1200);

const VERDICTS = ['confirmed', 'rejected', 'uncertain'];

// The structured verdict the model must return. Azure structured outputs are STRICT.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    isRealConcern: { type: 'boolean' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    suggestedResolution: { type: 'string' },
    suggestedDocument: { type: 'string' },
    suggestedSeverity: { type: 'string', enum: ['fatal', 'warning', 'info', 'unchanged'] },
  },
  required: ['verdict', 'isRealConcern', 'confidence', 'reasoning', 'suggestedResolution', 'suggestedDocument', 'suggestedSeverity'],
};

const SYSTEM = `You are a SENIOR mortgage-underwriting QA reviewer checking the work of PILOT, an automated finding system. PILOT raised a finding on a loan file. You are given the ENTIRE loan file, the SOURCE DOCUMENT the finding is based on, and PILOT's finding with its reasoning.
Decide whether this is a REAL, concerning finding a human underwriter should act on — or a FALSE ALARM: a mechanical misunderstanding by an automated system that compared the wrong things or doesn't understand context. Automated findings are frequently wrong in exactly these ways: comparing a seller/current owner to the buyer, treating a formatting or spelling difference as a mismatch, flagging a value that is actually correct in context (e.g. an assignment's seller price vs the fee-inclusive total), or asking for a document that is already on the file. Be SKEPTICAL of the automated finding.
Return verdict:
 - "confirmed" = this is a genuine concern; a human should act on it.
 - "rejected" = this is a false alarm / a misunderstanding; it should NOT be shown to the underwriter.
 - "uncertain" = you genuinely cannot tell from what you were given.
Set confidence honestly (0..1). Set isRealConcern to match the verdict. If confirmed or uncertain, give the concrete suggested resolution and the specific document to request (empty string if none). Ground STRICTLY on what you were given — never invent a fact, a number, or a document that is not present. When in doubt between rejected and uncertain, choose uncertain (a real finding must never be hidden on a guess).`;

/**
 * A stable fingerprint of a finding's identity — the same finding on a re-read maps to the same
 * memory row; a finding whose compared values change gets a fresh review. PURE.
 */
function fingerprintOf(finding) {
  const f = finding || {};
  const parts = [
    claimOf(f) || '',
    String(f.code || ''),
    String(f.field || ''),
    String(f.docValue == null ? '' : f.docValue),
    String(f.fileValue == null ? '' : f.fileValue),
    String(f.title || ''),
    String(f.documentId == null ? '' : f.documentId),
  ];
  return crypto.createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
}

/** Should a finding with this stored/fresh review be SHOWN? Suppress only a confident 'rejected'. */
function shouldShow(review) {
  if (!review) return true;                 // no verdict yet → show (fail-open)
  if (review.verdict === 'rejected' && review.is_real_concern === false) return false;
  return true;                              // confirmed / uncertain / anything ambiguous → show
}

/** Read the remembered verdicts for a set of fingerprints. Returns Map(fingerprint → row). */
async function readMemory(client, appId, fingerprints) {
  const out = new Map();
  if (!client || !appId || !Array.isArray(fingerprints) || !fingerprints.length) return out;
  try {
    const { rows } = await client.query(
      `SELECT * FROM finding_ai_reviews WHERE application_id=$1 AND fingerprint = ANY($2::text[])`,
      [appId, fingerprints]);
    for (const r of rows) out.set(r.fingerprint, r);
  } catch (_) { /* memory unreadable → treat as empty (fail-open) */ }
  return out;
}

// A short, human-readable rendering of the finding + its source document for the prompt.
function describeFinding(finding, sourceDoc) {
  const f = finding || {};
  const lines = [];
  lines.push(`PILOT finding: ${f.title || f.code || 'a finding'}`);
  if (f.code) lines.push(`Code: ${f.code}`);
  if (f.severity) lines.push(`PILOT severity: ${f.severity}`);
  if (f.field) lines.push(`Field: ${f.field}`);
  if (f.fileValue != null && f.fileValue !== '') lines.push(`What the loan file says: ${f.fileValue}`);
  if (f.docValue != null && f.docValue !== '') lines.push(`What the document says: ${f.docValue}`);
  if (f.howTo) lines.push(`PILOT's reasoning / how-to: ${f.howTo}`);
  if (sourceDoc) {
    lines.push('');
    lines.push(`The source document PILOT used (${sourceDoc.docType || 'document'}):`);
    if (sourceDoc.reasoning) {
      const r = sourceDoc.reasoning;
      if (r.docNature) lines.push(`  What this document actually is: ${r.docNature}`);
      if (r.purpose) lines.push(`  What it is for: ${r.purpose}`);
      if (Array.isArray(r.parties) && r.parties.length) {
        lines.push(`  Named parties: ${r.parties.map((p) => `${p.name} (${p.role})`).join('; ')}`);
      }
    }
    if (sourceDoc.fields) {
      let ff = sourceDoc.fields;
      try { ff = typeof ff === 'string' ? ff : JSON.stringify(ff); } catch (_) { ff = String(ff); }
      lines.push(`  Extracted fields: ${String(ff).slice(0, 4000)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Ask the AI to review ONE finding. Best-effort; returns a normalized verdict object or null.
 * Does NOT read/write memory — the caller (reviewFindings) handles memory + persistence + cost gate.
 */
async function reviewOne({ finding, sourceDoc, groundingText, appId, documentId }) {
  try {
    const started = Date.now();
    const instructions = `${describeFinding(finding, sourceDoc)}\n\nBelow is the ENTIRE loan file for context. Judge the finding above STRICTLY against it.`;
    const res = await azureOpenai.extract({
      system: SYSTEM,
      instructions,
      schema: SCHEMA,
      ocrText: groundingText || '',
      ocrCharLimit: OCR_CHAR_LIMIT,
      maxTokens: MAX_TOKENS,
      traceMeta: { opName: 'finding-ai-review' },
    });
    try {
      const u = res && res.usage;
      await costMeter.record({
        applicationId: appId || null, documentId: documentId || null, opName: 'finding-ai-review',
        provider: 'azure-openai', model: (res && res.model) || null,
        tokensIn: (u && (u.prompt_tokens || u.promptTokens)) || 0,
        tokensOut: (u && (u.completion_tokens || u.completionTokens)) || 0,
        durationMs: Date.now() - started, ok: !!(res && res.ok), reason: res && res.reason,
      });
    } catch (_) { /* cost accounting is additive */ }
    if (!res || !res.ok || !res.data) return null;
    return normalize(res.data);
  } catch (_) {
    return null;
  }
}

// Coerce the model output into the stored shape (defensive; the model is strict-schema'd).
function normalize(data) {
  const d = data || {};
  const verdict = VERDICTS.includes(d.verdict) ? d.verdict : 'uncertain';
  const conf = Number(d.confidence);
  return {
    verdict,
    is_real_concern: typeof d.isRealConcern === 'boolean' ? d.isRealConcern : (verdict === 'confirmed'),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    reasoning: d.reasoning ? String(d.reasoning).slice(0, 2000) : null,
    suggested_resolution: d.suggestedResolution ? String(d.suggestedResolution).slice(0, 1000) : null,
    suggested_document: d.suggestedDocument ? String(d.suggestedDocument).slice(0, 400) : null,
    suggested_severity: ['fatal', 'warning', 'info', 'unchanged'].includes(d.suggestedSeverity) ? d.suggestedSeverity : 'unchanged',
  };
}

async function persist(client, appId, finding, fingerprint, review, groundingHash) {
  try {
    await client.query(
      `INSERT INTO finding_ai_reviews
         (application_id, fingerprint, claim_key, code, verdict, is_real_concern, confidence,
          reasoning, suggested_resolution, suggested_document, suggested_severity, model, grounding_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (application_id, fingerprint) DO UPDATE SET
         verdict=EXCLUDED.verdict, is_real_concern=EXCLUDED.is_real_concern, confidence=EXCLUDED.confidence,
         reasoning=EXCLUDED.reasoning, suggested_resolution=EXCLUDED.suggested_resolution,
         suggested_document=EXCLUDED.suggested_document, suggested_severity=EXCLUDED.suggested_severity,
         grounding_hash=EXCLUDED.grounding_hash, updated_at=now()`,
      [appId, fingerprint, claimOf(finding) || null, finding.code || null,
       review.verdict, review.is_real_concern, review.confidence, review.reasoning,
       review.suggested_resolution, review.suggested_document, review.suggested_severity,
       null, groundingHash || null]);
  } catch (_) { /* persistence is best-effort — a failed write just means a re-review next pass */ }
}

/**
 * THE BACKGROUND PASS. Review any of `findings` that don't already have a fresh remembered verdict,
 * grounded on the whole loan file, and persist the verdicts. Bounded + cost-capped + best-effort;
 * NEVER throws. Call it off the hot path (a setImmediate / analyze tail) — the display path reads the
 * remembered verdicts synchronously via annotateFindings().
 *
 * @returns {Promise<{reviewed:number, confirmed:number, rejected:number, uncertain:number, skipped:string}>}
 */
async function reviewFindings({ client, appId, findings, db, sourceDocsById } = {}) {
  const empty = { reviewed: 0, confirmed: 0, rejected: 0, uncertain: 0, skipped: null };
  try {
    if (!enabled()) return { ...empty, skipped: 'disabled' };
    if (!azureOpenai.available()) return { ...empty, skipped: 'ai_unavailable' };
    if (!client || !appId || !Array.isArray(findings) || !findings.length) return { ...empty, skipped: 'nothing_to_do' };

    // Only real, code-bearing findings are reviewable (a fingerprint needs a stable identity).
    const reviewable = findings.filter((f) => f && (f.code || f.title));
    const fps = reviewable.map(fingerprintOf);
    const mem = await readMemory(client, appId, fps);
    // A finding is reviewed once and REMEMBERED by its fingerprint; the fingerprint already captures
    // the finding's own compared values, so a verdict only needs redoing when the finding itself
    // changes (→ new fingerprint → no memory row). So the work is exactly the findings with no row.
    const todo = reviewable.filter((f, i) => !mem.has(fps[i]));
    if (!todo.length) return { ...empty, skipped: 'all_fresh' };

    // The whole loan file, once (shared across every finding this pass) — built only when there IS
    // new work, so a fully-reviewed file costs nothing on re-view.
    let groundingText = '';
    try { groundingText = await primer.groundingBlock(appId, db || client); } catch (_) { groundingText = ''; }
    const groundingHash = crypto.createHash('sha256').update(String(groundingText || '')).digest('hex').slice(0, 16);

    let reviewed = 0; const counts = { confirmed: 0, rejected: 0, uncertain: 0 };
    for (const finding of todo) {
      if (reviewed >= MAX_REVIEWS_PER_PASS) break;
      // Per-file spend cap — checked before each paid call (fail-open on a read error).
      const allowed = await costMeter.allowSpend(appId, client).catch(() => true);
      if (!allowed) break;
      const sourceDoc = finding.documentId != null && sourceDocsById ? sourceDocsById.get(String(finding.documentId)) : null;
      const review = await reviewOne({ finding, sourceDoc, groundingText, appId, documentId: finding.documentId });
      if (!review) continue;   // AI failed on this one → leave it un-memoized (shows, fail-open)
      await persist(client, appId, finding, fingerprintOf(finding), review, groundingHash);
      reviewed++;
      counts[review.verdict] = (counts[review.verdict] || 0) + 1;
    }
    return { reviewed, ...counts, skipped: null };
  } catch (_) {
    return { ...empty, skipped: 'error' };
  }
}

/**
 * THE DISPLAY PASS (synchronous, no GPT). Given the assembled findings + the remembered verdicts,
 * return { shown, suppressed, byFingerprint } — `shown` are the findings to display, each ENRICHED
 * with `aiReview` ({verdict, confidence, reasoning, suggestedResolution, suggestedDocument}); a
 * confidently-rejected finding is moved to `suppressed`. Fail-open: a finding with no verdict shows.
 * Best-effort; never throws.
 */
function annotateFindings(findings, memory) {
  const shown = []; const suppressed = [];
  try {
    const mem = memory instanceof Map ? memory : new Map();
    for (const f of (findings || [])) {
      if (!f) continue;
      const review = mem.get(fingerprintOf(f));
      const annotated = review ? Object.assign({}, f, {
        aiReview: {
          verdict: review.verdict, confidence: review.confidence, reasoning: review.reasoning,
          suggestedResolution: review.suggested_resolution, suggestedDocument: review.suggested_document,
          suggestedSeverity: review.suggested_severity,
        },
      }) : f;
      if (shouldShow(review)) shown.push(annotated); else suppressed.push(annotated);
    }
  } catch (_) {
    return { shown: findings || [], suppressed: [], byFingerprint: new Map() };
  }
  return { shown, suppressed };
}

/** Read all remembered verdicts for a file, keyed by fingerprint — for the display pass. */
async function memoryForFile(client, appId, findings) {
  const fps = (findings || []).filter(Boolean).map(fingerprintOf);
  return readMemory(client, appId, fps);
}

/**
 * Read EVERY remembered verdict for a file (not filtered by fingerprint), keyed by fingerprint. Used
 * by the display path so both the consolidated list AND each per-section array filter against the
 * same memory. Best-effort → empty Map on error (fail-open). */
async function memoryAllForFile(client, appId) {
  const out = new Map();
  if (!client || !appId) return out;
  try {
    const { rows } = await client.query(`SELECT * FROM finding_ai_reviews WHERE application_id=$1`, [appId]);
    for (const r of rows) out.set(r.fingerprint, r);
  } catch (_) { /* unreadable → empty (fail-open) */ }
  return out;
}

module.exports = {
  enabled, fingerprintOf, shouldShow, reviewFindings, annotateFindings,
  memoryForFile, memoryAllForFile, readMemory,
  _internals: { normalize, describeFinding, SCHEMA, MAX_REVIEWS_PER_PASS },
};
