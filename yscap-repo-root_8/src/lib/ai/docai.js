'use strict';
/**
 * Google Document AI reader — the "best-in-class OCR" muscle that reads even scanned,
 * faxed, or blurry documents (far beyond the old OCR.space fallback, which caps at
 * ~1MB and only reads clean pages). Given a document's bytes it returns clean text +
 * a page count, which the Claude "brain" (claude.js) then understands and extracts.
 *
 * Pure REST via fetch (no @google-cloud SDK) using a token from google-auth.js — the
 * same "fetch + built-in crypto" shape as every other integration here. Best-effort:
 * unconfigured, oversized, timeout, or a service error all return a structured result
 * ({ ok:false, reason }) — it NEVER throws and NEVER blocks an upload.
 *
 * Env (Render only, never source):
 *   GOOGLE_DOCAI_CREDENTIALS[_B64]  the service-account key (see google-auth.js)
 *   GOOGLE_DOCAI_PROJECT_ID         the GCP project number/id that owns the processor
 *   GOOGLE_DOCAI_LOCATION           processor region, e.g. 'us' or 'eu' (default 'us')
 *   GOOGLE_DOCAI_PROCESSOR_ID       the Document OCR processor id created in the console
 */
const cfg = require('../../config');
const auth = require('./google-auth');

// Document AI's synchronous ("process") endpoint accepts up to ~20MB / (for the OCR
// processor) 15 pages online. Bigger/longer documents need the batch path (a later
// step); until then we say so plainly rather than pretend we read them.
const MAX_SYNC_BYTES = 20 * 1024 * 1024;

/** True when both a service account AND a processor are configured. */
function configured() {
  return auth.configured()
    && !!cfg.docai.projectId
    && !!cfg.docai.processorId;
}

function processorUrl() {
  const loc = cfg.docai.location || 'us';
  return `https://${loc}-documentai.googleapis.com/v1/projects/${cfg.docai.projectId}` +
         `/locations/${loc}/processors/${cfg.docai.processorId}:process`;
}

/**
 * Read a document with Document AI.
 * @param {{ buffer?: Buffer, base64?: string, mimeType: string }} args
 * @returns {Promise<{ ok:boolean, text?:string, pageCount?:number, reason?:string }>}
 */
async function read({ buffer, base64, mimeType } = {}) {
  if (!configured()) {
    return { ok: false, reason: 'Google Document AI is not configured (add the key + processor id)' };
  }
  if (!mimeType) return { ok: false, reason: 'no document type (mimeType) was provided' };

  const b64 = base64 || (buffer ? buffer.toString('base64') : null);
  if (!b64) return { ok: false, reason: 'no document bytes were provided' };
  const size = buffer ? buffer.length : Math.floor((b64.length * 3) / 4);
  if (size > MAX_SYNC_BYTES) {
    return { ok: false, reason: 'document is too large for the instant reader — needs the large-file path' };
  }

  let token;
  try { token = await auth.getAccessToken(); }
  catch (e) { return { ok: false, reason: e.message }; }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000); // OCR of many pages can be slow
  let r;
  try {
    r = await fetch(processorUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        skipHumanReview: true,
        rawDocument: { content: b64, mimeType },
      }),
      signal: ac.signal,
    });
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError'
      ? 'the reader timed out on this document'
      : `the reader could not be reached (${e.message})` };
  } finally {
    clearTimeout(timer);
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: `the reader reported an error (${msg})` };
  }

  const doc = j.document || {};
  const text = typeof doc.text === 'string' ? doc.text : '';
  const pageCount = Array.isArray(doc.pages) ? doc.pages.length : null;
  if (!text.trim()) return { ok: false, reason: 'the reader found no text in this document' };
  return { ok: true, text, pageCount };
}

module.exports = { read, configured, MAX_SYNC_BYTES };
