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
 * The verdict is REMEMBERED (finding_ai_reviews, db/338) keyed on the finding's fingerprint, so a
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
const anthropic = require('../ai/anthropic');
const costMeter = require('../ai/cost-meter');
const primer = require('./loan-primer');
const { claimOf } = require('./finding-claims');

// ON by default (owner-directed "turn everything on"); disable with FINDING_AI_REVIEW_ENABLED=0.
function enabled() {
  return String(process.env.FINDING_AI_REVIEW_ENABLED || '') !== '0';
}

// THE SECOND AI (owner-directed 2026-07-27: "add ChatGPT AND add some other AI"). When a SECOND,
// INDEPENDENT model (Claude / Anthropic) is configured, we get its own verdict on the SAME finding —
// but ONLY when the primary (GPT) wants to HIDE the finding, because that is the single high-stakes
// decision (a false-alarm suppression is the only thing that can hide a real problem). Two
// independent models have different blind spots, so we require CONSENSUS to hide: the finding is
// suppressed only when BOTH confidently reject it; if they DISAGREE the finding stays visible and is
// flagged for a human. This is strictly safer than one model, and it FAILS OPEN — with no second
// model configured, behavior is byte-identical to the single-model gate. Disable with
// FINDING_AI_SECOND_OPINION_ENABLED=0.
function secondOpinionEnabled() {
  return String(process.env.FINDING_AI_SECOND_OPINION_ENABLED || '') !== '0' && anthropic.available();
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
FIRST, understand the WHOLE DEAL before you judge anything — read the loan file and work out the complete picture: is this an ASSIGNMENT/wholesale deal or a straight purchase (on an assignment the purchase contract names the wholesaler, NOT our vesting entity, and the price on the contract may be the seller's underlying price, not the fee-inclusive total); the PURCHASE PRICE; the LOAN AMOUNT; the AS-IS value and the ARV; the LTV, LTC and LTARV; the rehab budget; the program and the note buyer. A finding only makes sense in the context of these numbers — e.g. a "price doesn't match" is not a real problem if the two prices are the seller price and the fee-inclusive total on an assignment, and a value that looks off may be exactly right once you see the as-is vs ARV vs loan amount relationship. Analyze the finding AGAINST this full economic picture.
THEN decide whether this is a REAL, concerning finding a human underwriter should act on — or a FALSE ALARM: a mechanical misunderstanding by an automated system that compared the wrong things or doesn't understand context. Automated findings are frequently wrong in exactly these ways: comparing a seller/current owner to the buyer, treating a formatting or spelling difference as a mismatch, flagging a value that is actually correct in context (e.g. an assignment's seller price vs the fee-inclusive total, or a value that is fine given the deal's LTV/LTC/ARV), or asking for a document that is already on the file. Be SKEPTICAL of the automated finding.
Return verdict:
 - "confirmed" = this is a genuine concern; a human should act on it.
 - "rejected" = this is a false alarm / a misunderstanding; it should NOT be shown to the underwriter.
 - "uncertain" = you genuinely cannot tell from what you were given.
Set confidence honestly (0..1). Set isRealConcern to match the verdict. If confirmed or uncertain, give the concrete suggested resolution and the specific document to request (empty string if none). Ground STRICTLY on what you were given — never invent a fact, a number, or a document that is not present. When in doubt between rejected and uncertain, choose uncertain (a real finding must never be hidden on a guess).`;

/**
 * A stable fingerprint of a finding's identity — the same finding on a re-read maps to the same
 * memory row; a finding whose compared values change gets a fresh review. PURE.
 */
// Findings arrive in TWO shapes and BOTH must be read (pre-merge audit 2026-07-27): DERIVED findings
// (tie-out, chains) are camelCase — docValue/fileValue/howTo/documentId; PERSISTED per-document
// findings (document_findings, SELECT *) are snake_case — doc_value/file_value/how_to/document_id.
// The persisted per-document findings are exactly the ones the owner wants judged against their
// SOURCE DOCUMENT, so reading only camelCase silently stripped their values + source doc from the
// prompt. These accessors read either shape.
function docValueOf(f) { return f && f.docValue != null ? f.docValue : (f ? f.doc_value : undefined); }
function fileValueOf(f) { return f && f.fileValue != null ? f.fileValue : (f ? f.file_value : undefined); }
function howToOf(f) { return f && f.howTo != null ? f.howTo : (f ? f.how_to : undefined); }
function documentIdOf(f) { if (!f) return null; const v = f.documentId != null ? f.documentId : f.document_id; return v != null ? v : null; }

function fingerprintOf(finding) {
  const f = finding || {};
  const dv = docValueOf(f); const fv = fileValueOf(f); const did = documentIdOf(f);
  const parts = [
    claimOf(f) || '',
    String(f.code || ''),
    String(f.field || ''),
    String(dv == null ? '' : dv),
    String(fv == null ? '' : fv),
    String(f.title || ''),
    String(did == null ? '' : did),
  ];
  return crypto.createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
}

/**
 * Should a finding with this stored/fresh review be SHOWN? Suppress only on a confident 'rejected'
 * — AND, when a SECOND model weighed in, only when it did NOT disagree. If the two models disagree
 * (the second didn't also reject) the finding stays VISIBLE for a human. No second opinion → the
 * single-model rule (byte-identical to before the second model was added).
 */
function shouldShow(review) {
  if (!review) return true;                 // no verdict yet → show (fail-open)
  const primaryReject = review.verdict === 'rejected' && review.is_real_concern === false;
  if (!primaryReject) return true;          // confirmed / uncertain / anything ambiguous → show
  // The primary wants to hide it. If a second model weighed in and did NOT also reject → models
  // disagree → keep it visible (a human decides). Consensus-to-reject (or no second model) → hide.
  if (review.verdict2 != null && review.verdict2 !== 'rejected') return true;
  return false;
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

// A compact "the deal at a glance" recap of the deal economics, placed right next to the finding so
// the model analyzes it against the full picture (owner-directed 2026-07-27: "feed it the entire
// picture — assignment, purchase, loan, LTV/LTC/ARV, as-is, ARV — before it says false alarm").
// The whole loan file is ALSO sent (the grounding block below); this puts the key numbers front and
// centre. Built from the loan-primer's structured fields; PURE.
function economicsRecap(fields) {
  try {
    const f = fields || {};
    const money = primer._internals && primer._internals.money ? primer._internals.money : (v) => (v == null || v === '' ? '(missing)' : `$${v}`);
    const pct = primer._internals && primer._internals.pct ? primer._internals.pct : (v) => (v == null || v === '' ? '(missing)' : `${v}%`);
    const parts = [];
    parts.push(`deal type: ${f.is_assignment ? 'ASSIGNMENT / wholesale (contract buyer = the wholesaler, NOT our vesting entity)' : 'straight purchase'}`);
    parts.push(`purchase price ${money(f.purchase_price)}`);
    if (f.is_assignment) parts.push(`seller contract ${money(f.underlying_contract_price)} + assignment fee ${money(f.assignment_fee)}`);
    parts.push(`loan amount ${money(f.loan_amount)}`);
    parts.push(`as-is value ${money(f.as_is_value)}`);
    parts.push(`ARV ${money(f.arv)}`);
    parts.push(`rehab budget ${money(f.rehab_budget)}`);
    parts.push(`LTV ${pct(f.ltv)}`);
    parts.push(`LTC ${pct(f.loan_to_cost)}`);
    parts.push(`LTARV ${pct(f.loan_to_arv)}`);
    parts.push(`program ${f.registered_program || f.program_strategy || '(unregistered)'}`);
    return `THE DEAL AT A GLANCE — ${parts.join('; ')}.`;
  } catch (_) { return ''; }
}

// A short, human-readable rendering of the finding + its source document for the prompt.
function describeFinding(finding, sourceDoc) {
  const f = finding || {};
  const lines = [];
  lines.push(`PILOT finding: ${f.title || f.code || 'a finding'}`);
  if (f.code) lines.push(`Code: ${f.code}`);
  if (f.severity) lines.push(`PILOT severity: ${f.severity}`);
  if (f.field) lines.push(`Field: ${f.field}`);
  const fv = fileValueOf(f); const dv = docValueOf(f); const ht = howToOf(f);
  if (fv != null && fv !== '') lines.push(`What the loan file says: ${fv}`);
  if (dv != null && dv !== '') lines.push(`What the document says: ${dv}`);
  if (ht) lines.push(`PILOT's reasoning / how-to: ${ht}`);
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
async function reviewOne({ finding, sourceDoc, groundingText, economics, appId, documentId }) {
  try {
    const started = Date.now();
    const instructions = `${economics ? economics + '\n\n' : ''}${describeFinding(finding, sourceDoc)}\n\nBelow is the ENTIRE loan file for context. Understand the whole deal from it — the economics above are a summary — and judge the finding above STRICTLY against the full picture.`;
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

/**
 * THE SECOND OPINION — ask the independent second model (Claude / Anthropic) the SAME question, with
 * the SAME whole-file grounding. Best-effort; returns a normalized verdict or null. Anthropic has no
 * `extract`, so we build the same user content and ask `complete` for strict JSON (a forced tool
 * under the hood), then parse it. anthropic.complete records its own cost + trace.
 */
async function secondOpinionOne({ finding, sourceDoc, groundingText, economics, appId, documentId }) {
  try {
    if (!anthropic.available()) return null;
    const instructions = `${economics ? economics + '\n\n' : ''}${describeFinding(finding, sourceDoc)}\n\nBelow is the ENTIRE loan file for context. Understand the whole deal from it and judge the finding above STRICTLY against the full picture.`;
    const userContent = azureOpenai.buildUserContent({ instructions, ocrText: groundingText || '', ocrCharLimit: OCR_CHAR_LIMIT });
    const responseFormat = { type: 'json_schema', json_schema: { name: 'verdict', schema: SCHEMA } };
    const res = await anthropic.complete({
      system: SYSTEM, userContent, maxTokens: MAX_TOKENS, responseFormat,
      traceMeta: { opName: 'finding-ai-review-2nd', appId: appId || null, documentId: documentId || null },
    });
    if (!res || !res.ok || !res.text) return null;
    let data; try { data = JSON.parse(res.text); } catch (_) { return null; }
    return normalize(data);
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
          reasoning, suggested_resolution, suggested_document, suggested_severity, model, grounding_hash,
          verdict2, confidence2, reasoning2, model2)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (application_id, fingerprint) DO UPDATE SET
         verdict=EXCLUDED.verdict, is_real_concern=EXCLUDED.is_real_concern, confidence=EXCLUDED.confidence,
         reasoning=EXCLUDED.reasoning, suggested_resolution=EXCLUDED.suggested_resolution,
         suggested_document=EXCLUDED.suggested_document, suggested_severity=EXCLUDED.suggested_severity,
         grounding_hash=EXCLUDED.grounding_hash,
         verdict2=EXCLUDED.verdict2, confidence2=EXCLUDED.confidence2, reasoning2=EXCLUDED.reasoning2,
         model2=EXCLUDED.model2, updated_at=now()`,
      [appId, fingerprint, claimOf(finding) || null, finding.code || null,
       review.verdict, review.is_real_concern, review.confidence, review.reasoning,
       review.suggested_resolution, review.suggested_document, review.suggested_severity,
       'azure-openai', groundingHash || null,
       review.verdict2 || null, review.confidence2 != null ? review.confidence2 : null,
       review.reasoning2 || null, review.model2 || null]);
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
    // new work, so a fully-reviewed file costs nothing on re-view. Assemble the primer ONCE so we get
    // both the full grounding text AND the structured economics recap (the deal at a glance) the
    // model reads next to each finding — the "feed it the entire picture" the owner asked for.
    let groundingText = '';
    let economics = '';
    try {
      const primerObj = await primer.assembleLoanPrimer(appId, db || client);
      groundingText = `${primer.PRIMER_TEXT}\n\n----------------------------------------\n\n${primer.fileSummaryText(primerObj)}`;
      economics = economicsRecap(primerObj && primerObj.fields);
    } catch (_) { groundingText = ''; economics = ''; }
    const groundingHash = crypto.createHash('sha256').update(String(groundingText || '')).digest('hex').slice(0, 16);

    let reviewed = 0; const counts = { confirmed: 0, rejected: 0, uncertain: 0 };
    for (const finding of todo) {
      if (reviewed >= MAX_REVIEWS_PER_PASS) break;
      // Per-file spend cap — checked before each paid call (fail-open on a read error).
      const allowed = await costMeter.allowSpend(appId, client).catch(() => true);
      if (!allowed) break;
      const did = documentIdOf(finding);
      const sourceDoc = did != null && sourceDocsById ? sourceDocsById.get(String(did)) : null;
      const review = await reviewOne({ finding, sourceDoc, groundingText, economics, appId, documentId: did });
      if (!review) continue;   // AI failed on this one → leave it un-memoized (shows, fail-open)
      // THE SECOND OPINION — only when the primary wants to HIDE this finding (verdict 'rejected'):
      // that is the one decision that can hide a real problem, so it's the one that deserves a second
      // independent model. If the second model does NOT also reject, shouldShow keeps the finding
      // visible. Cost-gated again (fail-open) so the two-model check never runs past the file cap.
      if (review.verdict === 'rejected' && secondOpinionEnabled()) {
        const allow2 = await costMeter.allowSpend(appId, client).catch(() => true);
        if (allow2) {
          const second = await secondOpinionOne({ finding, sourceDoc, groundingText, economics, appId, documentId: did });
          if (second) {
            review.verdict2 = second.verdict;
            review.confidence2 = second.confidence;
            review.reasoning2 = second.reasoning;
            review.model2 = 'anthropic';
          }
        }
      }
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
          // The second, independent model's take (Claude) when it weighed in — so the desk can show
          // "a second AI agrees / disagrees". Present only on findings the primary tried to hide.
          secondModel: review.verdict2 != null ? {
            verdict: review.verdict2, confidence: review.confidence2, reasoning: review.reasoning2,
            agrees: review.verdict2 === review.verdict,
          } : null,
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
  _internals: { normalize, describeFinding, economicsRecap, SCHEMA, MAX_REVIEWS_PER_PASS },
};
