'use strict';
/**
 * Google Cloud Document AI reader — the INDEPENDENT SECOND OCR engine (owner-
 * directed 2026-07-21). Runs as a fallback when Azure Document Intelligence
 * returns no text / very short text / an error on a document. Different failure
 * modes than Azure — Google's Enterprise Document OCR handles rotated scans,
 * faxes, and low-quality PDFs that Azure's Layout model can miss.
 *
 * Uses the "Enterprise Document OCR" processor (a cheap, general-purpose OCR
 * processor). The caller creates the processor once in the Google Cloud
 * Console and drops its ID into GOOGLE_DOCAI_PROCESSOR_ID. Auth via a service-
 * account JSON blob in GOOGLE_DOCAI_KEY_JSON (env-only, never source).
 *
 * The return shape is DELIBERATELY THE SAME as Azure's docint.js:
 *   { ok, text, pageCount, pages: [{ pageNumber, width, height, unit, angle, text }] }
 * so a caller / router can treat the two engines interchangeably.
 *
 * Pure fetch + Node crypto — no @google-cloud SDK. Best-effort: unconfigured /
 * oversized / timeout / a service error all return { ok:false, reason }. Never
 * throws and never blocks an upload.
 *
 * Env (Render only, never source):
 *   GOOGLE_DOCAI_KEY_JSON       full service-account JSON (contains private key)
 *   GOOGLE_DOCAI_PROJECT_ID     e.g. yscap-docai
 *   GOOGLE_DOCAI_LOCATION       us | eu
 *   GOOGLE_DOCAI_PROCESSOR_ID   the OCR processor's ID
 */
const cfg = require('../../config');
const { getAccessToken, configured } = require('./gcp-auth');
const { runWithRetry, classifyStatus, retryAfterMs, breakerFor } = require('./resilience');

// Google's synchronous process endpoint accepts documents up to 20 MB (roughly
// 15 pages of a typical PDF). Match Azure's cap so callers see the same limit.
const MAX_BYTES = 20 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 60000;

function processUrl() {
  const c = cfg.docai || {};
  const host = c.location === 'eu' ? 'eu-documentai.googleapis.com' : `${c.location || 'us'}-documentai.googleapis.com`;
  return `https://${host}/v1/projects/${c.projectId}/locations/${c.location || 'us'}/processors/${c.processorId}:process`;
}

// A guess at the MIME type from the caller's hint (Google requires one). PDF is
// the overwhelming majority of underwriting docs; images and Office file types
// pass through. Default to application/pdf so a doc without a mimeType still
// tries — Document AI is tolerant of PDF-as-default.
function normalizeMime(mimeType) {
  const m = String(mimeType || '').toLowerCase().trim();
  if (m.startsWith('image/')) return m;
  if (m.includes('pdf')) return 'application/pdf';
  if (m.includes('tiff')) return 'image/tiff';
  if (m.includes('gif')) return 'image/gif';
  if (m.includes('bmp')) return 'image/bmp';
  if (m.includes('webp')) return 'image/webp';
  if (m.includes('png')) return 'image/png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'image/jpeg';
  return 'application/pdf';
}

async function attemptProcess(b64, mimeType, token) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  let r;
  try {
    r = await fetch(processUrl(), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawDocument: { mimeType: normalizeMime(mimeType), content: b64 },
        skipHumanReview: true,
      }),
      signal: ac.signal,
    });
  } finally { clearTimeout(timer); }
  if (r.status === 200) {
    const j = await r.json().catch(() => ({}));
    return { ok: true, result: j.document || {} };
  }
  const j = await r.json().catch(() => ({}));
  const cls = classifyStatus(r.status);
  const msg = (j && j.error && j.error.message) || `HTTP ${r.status}`;
  return { ok: false, reason: `Google Document AI rejected the document (${msg})`,
    retryable: cls.retryable, breakerFault: cls.breakerFault, outcome: cls.outcome,
    retryAfterMs: retryAfterMs(r.headers), status: r.status };
}

/**
 * Read a document with Google Document AI.
 * @param {{ buffer?: Buffer, base64?: string, mimeType?: string }} args
 * @returns {Promise<{ok:boolean, text?:string, pageCount?:number, pages?:Array, reason?:string, engine:'google-docai'}>}
 */
async function read({ buffer, base64, mimeType } = {}) {
  if (!configured()) {
    return { ok: false, reason: 'Google Document AI is not configured (add the four GOOGLE_DOCAI_* env vars to Render).', engine: 'google-docai' };
  }
  const b64 = base64 || (buffer ? buffer.toString('base64') : null);
  if (!b64) return { ok: false, reason: 'no document bytes were provided', engine: 'google-docai' };
  const size = buffer ? buffer.length : Math.floor((b64.length * 3) / 4);
  if (size > MAX_BYTES) return { ok: false, reason: 'document is too large for Google Document AI (20 MB limit)', engine: 'google-docai' };

  const tokenRes = await getAccessToken();
  if (!tokenRes.ok) return { ok: false, reason: tokenRes.reason, engine: 'google-docai' };

  const submit = await runWithRetry(() => attemptProcess(b64, mimeType, tokenRes.token), {
    breaker: breakerFor('google-docai'),
    deadlineMs: REQUEST_DEADLINE_MS,
    label: 'Google Document AI',
  });
  if (!submit.ok) return { ok: false, reason: submit.reason || 'Google Document AI could not read this document', engine: 'google-docai' };

  const doc = submit.result || {};
  const text = typeof doc.text === 'string' ? doc.text : '';
  if (!text.trim()) return { ok: false, reason: 'Google Document AI found no text in this document', engine: 'google-docai' };

  // Per-page slice — Document AI returns pages[] with dimensions + a layout that
  // covers the whole page. We surface the page-scoped text via textAnchor →
  // textSegments (start/end byte indices into the top-level `text`) so a
  // finding raised from a specific page can point at it, matching Azure's shape.
  const rawPages = Array.isArray(doc.pages) ? doc.pages : [];
  const pages = rawPages.map((p, i) => {
    const pageNumber = Number.isFinite(p && p.pageNumber) ? p.pageNumber : (i + 1);
    let lineText = '';
    const layout = p && p.layout;
    const segs = layout && layout.textAnchor && Array.isArray(layout.textAnchor.textSegments) ? layout.textAnchor.textSegments : [];
    for (const seg of segs) {
      const startIndex = Number(seg && seg.startIndex) || 0;
      const endIndex = Number(seg && seg.endIndex) || 0;
      if (endIndex > startIndex && endIndex <= text.length) lineText += text.slice(startIndex, endIndex);
    }
    const dim = p && p.dimension;
    return {
      pageNumber,
      width: dim && Number.isFinite(dim.width) ? dim.width : null,
      height: dim && Number.isFinite(dim.height) ? dim.height : null,
      unit: dim && typeof dim.unit === 'string' ? dim.unit : null,
      angle: null,   // Document AI doesn't expose page rotation as a scalar
      text: lineText,
    };
  });
  return { ok: true, text, pageCount: pages.length || null, pages, engine: 'google-docai' };
}

/** Auth-only health ping — mints a token; returns { ok, reason? }. Never throws. */
async function ping() {
  if (!configured()) return { ok: false, reason: 'endpoint / key not set' };
  const t = await getAccessToken();
  if (!t.ok) return { ok: false, reason: t.reason };
  return { ok: true };
}

module.exports = { read, ping, configured, MAX_BYTES };
