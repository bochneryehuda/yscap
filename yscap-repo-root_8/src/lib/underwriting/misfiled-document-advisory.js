'use strict';
/**
 * misfiled-document-advisory — put the AI's OWN classification to work (owner-directed 2026-07-27:
 * "go more with logic, less rules; add more AI").
 *
 * ROOT CAUSE this addresses: PILOT reads a document as whatever CHECKLIST SLOT it was filed under
 * (slot-driven extraction). A tax certificate filed under the "title" slot is read with the title
 * schema, so its fields land in the wrong places and feed wrong values into the tie-out and the
 * chains — the whole tax-cert class of nonsense. The per-document AI reasoning pass
 * (document-reasoning.js) ALREADY works out what a document ACTUALLY is (`docNature`) and whether
 * that matches the slot it was filed under (`matchesFiledType`) — but nothing consumed those two
 * fields. This advisory does: when the AI is confident a document does NOT match its filed slot, it
 * raises ONE plain-language heads-up — "this looks like a {what it really is}, not the {slot} it was
 * filed under — re-read it / move it to the right condition."
 *
 * ADVISORY ONLY, never blocks: it records an `ai_suggestions` row (a human decides whether to
 * re-read / move the document); it NEVER re-classifies a document itself, never creates or edits a
 * condition, never changes a number. It withdraws itself when the document no longer reads mis-filed
 * (re-read correctly or moved). Best-effort — NEVER throws. It only fires on reasoning the model was
 * CONFIDENT about, so it can't nag on an uncertain guess.
 */

const aiSug = require('./ai-suggestions');

const SOURCE = 'misfiled_document';
// Only raise when the model is genuinely confident the document is mis-filed — a low-confidence
// "maybe" must never nag. Env-tunable.
const MIN_CONFIDENCE = Math.max(0, Math.min(1, parseFloat(process.env.MISFILED_DOC_MIN_CONFIDENCE || '0.75') || 0.75));

// A readable name for a checklist slot / doc type.
function label(t) { return String(t || 'document').replace(/_/g, ' '); }
function naturalName(n) { return String(n || '').replace(/_/g, ' ').trim(); }

function dedupeKeyFor(documentId) { return `misfiled_document:${documentId}`; }

// Parse the stored reasoning jsonb (pg may hand it back as an object or a string).
function parseReasoning(r) {
  if (!r) return null;
  if (typeof r === 'object') return r;
  try { return JSON.parse(r); } catch (_) { return null; }
}

/**
 * Should THIS extraction raise a mis-filed heads-up? Returns { raise:boolean, docNature? }.
 * PURE. Raises ONLY when the reasoning is present, confident (>= MIN_CONFIDENCE), explicitly says
 * matchesFiledType === false, and names what the document actually is (a different thing than the
 * slot). Never guesses.
 */
function assess(docType, reasoning) {
  const r = parseReasoning(reasoning);
  if (!r) return { raise: false };
  if (r.matchesFiledType !== false) return { raise: false };            // matches, or unknown → nothing
  const conf = Number(r.confidence);
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) return { raise: false };
  const nature = naturalName(r.docNature);
  if (!nature) return { raise: false };
  // Guard against a nature that is really the same slot worded differently ("title report" vs
  // "title") — don't raise when the natures normalize to the same token as the slot.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(nature).includes(norm(docType)) || norm(docType).includes(norm(nature))) return { raise: false };
  return { raise: true, docNature: nature, purpose: r.purpose ? String(r.purpose).slice(0, 400) : null };
}

async function retractForDocument(client, appId, documentId, why) {
  try {
    const r = await client.query(
      `UPDATE ai_suggestions SET status='dismissed', status_reason=$3, updated_at=now()
        WHERE application_id=$1 AND source=$2 AND dedupe_key=$4 AND status='open' RETURNING id`,
      [appId, SOURCE, `Withdrawn automatically: ${why}`, dedupeKeyFor(documentId)]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}

/**
 * The advisory pass for one file. Reads every current extraction's stored reasoning and raises /
 * withdraws the mis-filed heads-up per document. NEVER throws.
 * @returns {Promise<{raised:number, retracted:number}>}
 */
async function syncMisfiledDocumentAdvisory(client, appId) {
  const out = { raised: 0, retracted: 0 };
  if (!client || !appId) return out;
  try {
    const { rows } = await client.query(
      `SELECT document_id, doc_type, reasoning FROM document_extractions
        WHERE application_id=$1 AND is_current AND reasoning IS NOT NULL`, [appId]);
    for (const e of rows) {
      if (e.document_id == null) continue;
      const a = assess(e.doc_type, e.reasoning);
      if (!a.raise) {
        // Not mis-filed (or no longer) → withdraw any open advisory for this document.
        out.retracted += await retractForDocument(client, appId, e.document_id, 'the document now reads as the type it was filed under');
        continue;
      }
      const slot = label(e.doc_type);
      const res = await aiSug.record(client, {
        applicationId: appId,
        documentId: e.document_id,
        source: SOURCE,
        kind: 'finding',
        severity: 'warning',
        title: `This document looks like a ${a.docNature}, not the ${slot} it was filed under`,
        body: `PILOT read this document and believes it is actually a ${a.docNature}${a.purpose ? ` (${a.purpose})` : ''}, but it was filed under the "${slot}" step — so it is being read with the wrong template, which can produce wrong values on the file. Re-read it as a ${a.docNature}, or move it to the right condition. PILOT will not do this on its own.`,
        evidence: { docNature: a.docNature, filedAs: e.doc_type },
        proposedAction: { type: 'reclassify_document', documentId: e.document_id, suggestedType: a.docNature },
        dedupeKey: dedupeKeyFor(e.document_id),
      });
      if (res && res.id) out.raised += 1;
    }
  } catch (_) { /* best-effort — a mis-filed advisory never breaks the file view */ }
  return out;
}

module.exports = { syncMisfiledDocumentAdvisory, _internals: { assess, dedupeKeyFor, MIN_CONFIDENCE } };
