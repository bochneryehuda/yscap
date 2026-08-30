'use strict';
/**
 * Azure Document Intelligence (formerly Form Recognizer) — extract text / layout /
 * fields from a document. Zero-SDK: raw fetch against the data-plane REST API,
 * mirroring the client discipline used elsewhere here (per-request timeout,
 * transient-only retry with backoff, bounded async polling). Secrets come from
 * config (Render env), NEVER from source or the browser.
 *
 * Flow: POST {model}:analyze -> 202 + Operation-Location header -> poll that URL
 * until the job succeeds/fails. Default model is prebuilt-read (OCR + full text);
 * pass a different prebuilt id (prebuilt-layout, prebuilt-invoice, …) or a custom
 * model per call.
 *
 * To activate (env): AZURE_DOCINT_ENDPOINT + AZURE_DOCINT_KEY. API version is
 * baked to a stable GA default (2024-11-30) in config; override only if the
 * resource is pinned elsewhere (AZURE_DOCINT_API_VERSION).
 */
const cfg = require('../../config').azureDocInt;

const POST_TRIES = 3, BASE_BACKOFF_MS = 600, MAX_BACKOFF_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configured() { return !!(cfg.endpoint && cfg.key); }
function ensure() {
  if (!configured()) {
    throw new Error('Azure Document Intelligence not configured — set AZURE_DOCINT_ENDPOINT / AZURE_DOCINT_KEY');
  }
}

function backoff(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 30000);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.floor(Math.random() * 200);
}

function httpError(op, status, body) {
  const e = new Error(`Document Intelligence ${op} -> ${status}: ${String(body).slice(0, 200)}`);
  e.status = status;
  e.retryable = status === 429 || (status >= 500 && status <= 599);
  return e;
}

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

/**
 * Analyze a document. Provide EXACTLY one source:
 *   { base64Source }  — base64 of the raw file bytes (no data: prefix), OR
 *   { bytes }         — a Buffer / Uint8Array (base64-encoded for you), OR
 *   { urlSource }     — a publicly reachable URL Azure fetches server-side.
 * Options: model (prebuilt/custom id), pages ('1-3').
 * Returns { content, pages, tables, keyValuePairs, documents, model, apiVersion, raw }.
 */
async function analyze({ base64Source, bytes, urlSource, model, pages } = {}) {
  ensure();
  const m = model || cfg.model;
  if (bytes && !base64Source) base64Source = Buffer.from(bytes).toString('base64');
  if (!base64Source && !urlSource) throw new Error('analyze: provide base64Source, bytes, or urlSource');

  const qs = new URLSearchParams({ 'api-version': cfg.apiVersion });
  if (pages) qs.set('pages', pages);
  const url = `${cfg.endpoint}/documentintelligence/documentModels/${encodeURIComponent(m)}:analyze?${qs}`;
  const payload = JSON.stringify(base64Source ? { base64Source } : { urlSource });

  // Submit — retry only on transient failures (429 / 5xx / network).
  let opLoc, lastErr;
  for (let attempt = 1; attempt <= POST_TRIES; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': cfg.key, 'Content-Type': 'application/json' },
        body: payload,
      }, cfg.timeoutMs);
    } catch (netErr) {
      lastErr = netErr;
      if (attempt < POST_TRIES) { await sleep(backoff(attempt)); continue; }
      throw new Error(`Document Intelligence submit failed: ${netErr.message}`);
    }
    if (res.status === 202) {
      opLoc = res.headers.get('operation-location');
      break;
    }
    const t = await res.text().catch(() => '');
    const err = httpError('analyze', res.status, t);
    if (err.retryable && attempt < POST_TRIES) {
      await sleep(backoff(attempt, parseInt(res.headers.get('retry-after') || '0', 10)));
      lastErr = err; continue;
    }
    throw err;
  }
  if (!opLoc) throw (lastErr || new Error('Document Intelligence: no Operation-Location returned'));

  return pollResult(opLoc, m);
}

// Poll the operation-location until the job resolves. Network blips during the
// poll are retried (not fatal) until the overall maxPollMs budget is spent.
async function pollResult(opLoc, model) {
  const deadline = Date.now() + cfg.maxPollMs;
  let delay = 1000;
  for (;;) {
    let res;
    try {
      res = await fetchWithTimeout(opLoc, { headers: { 'Ocp-Apim-Subscription-Key': cfg.key } }, cfg.timeoutMs);
    } catch (netErr) {
      if (Date.now() > deadline) throw new Error(`Document Intelligence: poll network error after budget: ${netErr.message}`);
      await sleep(delay); delay = Math.min(delay * 1.5, 5000); continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = httpError('poll', res.status, t);
      if (err.retryable && Date.now() < deadline) { await sleep(delay); delay = Math.min(delay * 1.5, 5000); continue; }
      throw err;
    }
    const j = await res.json();
    const status = (j.status || '').toLowerCase();
    if (status === 'succeeded') {
      const a = j.analyzeResult || {};
      return {
        content:       a.content || '',
        pages:         a.pages || [],
        tables:        a.tables || [],
        keyValuePairs: a.keyValuePairs || [],
        documents:     a.documents || [],
        model:         a.modelId || model,
        apiVersion:    a.apiVersion || cfg.apiVersion,
        raw:           j,
      };
    }
    if (status === 'failed') {
      const e = j.error || {};
      throw new Error(`Document Intelligence analysis failed: ${e.message || JSON.stringify(e) || 'unknown error'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Document Intelligence: timed out after ${cfg.maxPollMs}ms (last status: ${status || 'unknown'})`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);   // gentle backoff, capped at 5s
  }
}

module.exports = { name: 'azure-docint', configured, analyze };
