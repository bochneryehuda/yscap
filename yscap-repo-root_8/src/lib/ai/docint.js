'use strict';
/**
 * Microsoft Azure AI Document Intelligence reader — the "best-in-class OCR" that reads
 * even scanned, faxed, or blurry documents (far beyond the old OCR.space fallback,
 * which caps at ~1MB and only reads clean pages). Given a document's bytes it returns
 * clean text + a page count, which the GPT-5 "brain" (azure-openai.js) then understands
 * and extracts. Runs in the owner's existing Microsoft/Azure account (one bill, one login).
 *
 * Pure REST via fetch (no @azure SDK) with a simple resource key — the same "fetch"
 * shape as every other integration here, and simpler than the Google flow (no JWT: a
 * Document Intelligence resource authenticates with one subscription key). Best-effort:
 * unconfigured, oversized, timeout, or a service error all return { ok:false, reason }.
 * It NEVER throws and NEVER blocks an upload.
 *
 * The v4.0 (2024-11-30 GA) analyze is ASYNC: POST returns 202 + an Operation-Location
 * URL; we poll that until the read succeeds, then read analyzeResult.content.
 *
 * Env (Render only, never source):
 *   AZURE_DOCINT_ENDPOINT     e.g. https://<resource>.cognitiveservices.azure.com
 *   AZURE_DOCINT_KEY          the resource key (Ocp-Apim-Subscription-Key)
 *   AZURE_DOCINT_MODEL        prebuilt model id (default 'prebuilt-read' — pure OCR)
 *   AZURE_DOCINT_API_VERSION  API version (default '2024-11-30')
 */
const cfg = require('../../config');

// The synchronous submit accepts large files, but we cap to keep memory + latency
// sane; bigger documents can move to the batch path later.
const MAX_BYTES = 50 * 1024 * 1024;
const POLL_MS = 1500;        // Document Intelligence recommends ~1s between polls
const MAX_POLL_MS = 90000;   // give a long scanned/many-page doc time to finish

/** True when an endpoint + key are configured (surfaced on /api/health). */
function configured() {
  return !!(cfg.docint && cfg.docint.endpoint && cfg.docint.key);
}

function analyzeUrl() {
  const base = String(cfg.docint.endpoint || '').replace(/\/+$/, '');
  const model = cfg.docint.model || 'prebuilt-read';
  const ver = cfg.docint.apiVersion || '2024-11-30';
  return `${base}/documentintelligence/documentModels/${model}:analyze?_overload=analyzeDocument&api-version=${ver}`;
}

async function pollResult(operationUrl, deadline) {
  while (Date.now() < deadline) {
    const wait = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, wait));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    let r;
    try {
      r = await fetch(operationUrl, {
        headers: { 'Ocp-Apim-Subscription-Key': cfg.docint.key },
        signal: ac.signal,
      });
    } catch (e) {
      // A transient poll error isn't fatal — keep trying until the deadline.
      clearTimeout(timer);
      continue;
    } finally {
      clearTimeout(timer);
    }
    // Honor throttling / transient server errors — keep polling until the deadline
    // rather than misreading a 429 body as "still running" and spinning to timeout.
    if (r.status === 429 || r.status >= 500) continue;
    if (!r.ok) return { ok: false, reason: `the reader errored while reading (HTTP ${r.status})` };
    const j = await r.json().catch(() => ({}));
    const status = (j.status || '').toLowerCase();
    if (status === 'succeeded') return { ok: true, result: j.analyzeResult || {} };
    if (status === 'failed') {
      const msg = (j.error && j.error.message) || 'the reader failed to read this document';
      return { ok: false, reason: msg };
    }
    // 'running' / 'notStarted' -> keep polling
  }
  return { ok: false, reason: 'the reader took too long on this document' };
}

/**
 * Read a document with Azure Document Intelligence.
 * @param {{ buffer?: Buffer, base64?: string, mimeType?: string }} args
 * @returns {Promise<{ ok:boolean, text?:string, pageCount?:number, reason?:string }>}
 */
async function read({ buffer, base64 } = {}) {
  if (!configured()) {
    return { ok: false, reason: 'the OCR reader is not configured (add the Azure endpoint + key)' };
  }
  const b64 = base64 || (buffer ? buffer.toString('base64') : null);
  if (!b64) return { ok: false, reason: 'no document bytes were provided' };
  const size = buffer ? buffer.length : Math.floor((b64.length * 3) / 4);
  if (size > MAX_BYTES) return { ok: false, reason: 'document is too large for the reader' };

  // Submit. Document Intelligence auto-detects the file type from the bytes, so the
  // request Content-Type is JSON and the file rides as base64Source.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  let r;
  try {
    r = await fetch(analyzeUrl(), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': cfg.docint.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Source: b64 }),
      signal: ac.signal,
    });
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError'
      ? 'the reader timed out accepting this document'
      : `the reader could not be reached (${e.message})` };
  } finally {
    clearTimeout(timer);
  }

  if (r.status !== 202) {
    const j = await r.json().catch(() => ({}));
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: `the reader rejected this document (${msg})`, retriable: r.status === 429 || r.status >= 500 };
  }
  const operationUrl = r.headers.get('operation-location');
  if (!operationUrl) return { ok: false, reason: 'the reader did not return a result location' };

  const poll = await pollResult(operationUrl, Date.now() + MAX_POLL_MS);
  if (!poll.ok) return { ok: false, reason: poll.reason };

  const text = typeof poll.result.content === 'string' ? poll.result.content : '';
  const pageCount = Array.isArray(poll.result.pages) ? poll.result.pages.length : null;
  if (!text.trim()) return { ok: false, reason: 'the reader found no text in this document' };
  return { ok: true, text, pageCount };
}

/**
 * Auth-only health ping — lists document models (needs the endpoint + key, no document).
 * Confirms the Render values are entered correctly. Never throws.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function ping() {
  if (!configured()) return { ok: false, reason: 'endpoint or key not set' };
  const base = String(cfg.docint.endpoint || '').replace(/\/+$/, '');
  const ver = cfg.docint.apiVersion || '2024-11-30';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(`${base}/documentintelligence/documentModels?api-version=${ver}`, {
      headers: { 'Ocp-Apim-Subscription-Key': cfg.docint.key }, signal: ac.signal,
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: `bad key (HTTP ${r.status})` };
    if (r.status === 404) return { ok: false, reason: 'endpoint URL looks wrong (HTTP 404)' };
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

module.exports = { read, ping, configured, MAX_BYTES };
