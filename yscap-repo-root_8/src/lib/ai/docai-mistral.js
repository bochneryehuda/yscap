'use strict';
/**
 * Mistral OCR — the THIRD OCR engine (owner-directed 2026-07-21). Called
 * only when Azure Document Intelligence AND Google Document AI both fail to
 * read a document, or a caller forces it. Mistral's strength is dense
 * layouts (tables, signatures, multi-column) and it's a genuine third
 * independent perspective — same document, different failure modes.
 *
 * Return shape MATCHES Azure's docint.js and Google's docai-google.js:
 *   { ok, text, pageCount, pages: [{ pageNumber, width, height, unit, angle, text }] }
 * so the router can treat every engine interchangeably.
 *
 * Pure fetch — no @mistralai SDK (keeps the no-native-deps rule intact).
 * Best-effort: unconfigured / oversized / timeout / a service error all
 * return { ok:false, reason }. Never throws.
 *
 * Env (Render only, never source):
 *   MISTRAL_API_KEY        — from console.mistral.ai
 *   MISTRAL_OCR_ENDPOINT   — default https://api.mistral.ai
 *   MISTRAL_OCR_MODEL      — default mistral-ocr-latest
 */
const cfg = require('../../config');
const { runWithRetry, classifyStatus, retryAfterMs, breakerFor } = require('./resilience');

// The API accepts up to ~50 MB documents; match Azure's cap so callers see
// the same limit across engines.
const MAX_BYTES = 50 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 60000;

function configured() {
  return !!(cfg.mistralOcr && cfg.mistralOcr.key && cfg.mistralOcr.endpoint);
}

function ocrUrl() {
  const base = String(cfg.mistralOcr.endpoint || '').replace(/\/+$/, '');
  return `${base}/v1/ocr`;
}

function normalizeMime(mimeType) {
  const m = String(mimeType || '').toLowerCase().trim();
  if (m.startsWith('image/')) return m;
  if (m.includes('pdf')) return 'application/pdf';
  if (m.includes('png')) return 'image/png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'image/jpeg';
  return 'application/pdf';
}

async function attemptOcr(b64, mimeType) {
  const dataUrl = `data:${normalizeMime(mimeType)};base64,${b64}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 55000);
  let r;
  try {
    r = await fetch(ocrUrl(), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.mistralOcr.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.mistralOcr.model || 'mistral-ocr-latest',
        document: { type: 'document_url', document_url: dataUrl },
        include_image_base64: false,
      }),
      signal: ac.signal,
    });
  } finally { clearTimeout(timer); }
  if (r.status === 200) {
    const j = await r.json().catch(() => ({}));
    return { ok: true, result: j || {} };
  }
  const j = await r.json().catch(() => ({}));
  const cls = classifyStatus(r.status);
  const msg = (j && (j.message || (j.error && j.error.message))) || `HTTP ${r.status}`;
  return { ok: false, reason: `Mistral OCR rejected the document (${msg})`,
    retryable: cls.retryable, breakerFault: cls.breakerFault, outcome: cls.outcome,
    retryAfterMs: retryAfterMs(r.headers), status: r.status };
}

/**
 * Read a document with Mistral OCR.
 * @param {{ buffer?: Buffer, base64?: string, mimeType?: string }} args
 * @returns {Promise<{ok:boolean, text?:string, pageCount?:number, pages?:Array, reason?:string, engine:'mistral-ocr'}>}
 */
async function read({ buffer, base64, mimeType } = {}) {
  if (!configured()) {
    return { ok: false, reason: 'Mistral OCR is not configured (add MISTRAL_API_KEY to Render).', engine: 'mistral-ocr' };
  }
  const b64 = base64 || (buffer ? buffer.toString('base64') : null);
  if (!b64) return { ok: false, reason: 'no document bytes were provided', engine: 'mistral-ocr' };
  const size = buffer ? buffer.length : Math.floor((b64.length * 3) / 4);
  if (size > MAX_BYTES) return { ok: false, reason: 'document is too large for Mistral OCR (50 MB limit)', engine: 'mistral-ocr' };

  const submit = await runWithRetry(() => attemptOcr(b64, mimeType), {
    breaker: breakerFor('mistral-ocr'),
    deadlineMs: REQUEST_DEADLINE_MS,
    label: 'Mistral OCR',
  });
  if (!submit.ok) return { ok: false, reason: submit.reason || 'Mistral OCR could not read this document', engine: 'mistral-ocr' };

  const result = submit.result || {};
  // Mistral returns { pages: [{ index, markdown, dimensions: {dpi, height, width}, ... }] }.
  const rawPages = Array.isArray(result.pages) ? result.pages : [];
  if (!rawPages.length) return { ok: false, reason: 'Mistral OCR returned no pages', engine: 'mistral-ocr' };
  const pages = rawPages.map((p, i) => {
    const pageNumber = Number.isFinite(p && p.index) ? p.index + 1 : (i + 1);
    const text = typeof (p && p.markdown) === 'string' ? p.markdown : (typeof (p && p.text) === 'string' ? p.text : '');
    const dim = p && (p.dimensions || p.dimension);
    return {
      pageNumber,
      width: dim && Number.isFinite(dim.width) ? dim.width : null,
      height: dim && Number.isFinite(dim.height) ? dim.height : null,
      unit: dim && dim.dpi ? 'dpi' : null,
      angle: null,
      text,
    };
  });
  const text = pages.map((p) => p.text || '').join('\n\n').trim();
  if (!text) return { ok: false, reason: 'Mistral OCR returned no text', engine: 'mistral-ocr' };
  return { ok: true, text, pageCount: pages.length, pages, engine: 'mistral-ocr' };
}

// Auth-only health ping — POSTs a tiny 1x1 blank PDF-ish payload isn't
// necessary; a HEAD/GET on the models endpoint confirms the key.
async function ping() {
  if (!configured()) return { ok: false, reason: 'MISTRAL_API_KEY not set' };
  const base = String(cfg.mistralOcr.endpoint || '').replace(/\/+$/, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers: { 'Authorization': `Bearer ${cfg.mistralOcr.key}` }, signal: ac.signal,
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: `bad key (HTTP ${r.status})` };
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

module.exports = { read, ping, configured, MAX_BYTES };
