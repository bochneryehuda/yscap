'use strict';
/**
 * Microsoft Azure OpenAI (GPT-5) — the "brain" that UNDERSTANDS a document and pulls
 * out the facts an underwriter needs: names, dates, prices, addresses, entities, and
 * the judgment calls ("is this the same seller across three documents?"). Pairs with
 * docint.js (Azure Document Intelligence): the reader turns a scanned/blurry page into
 * clean text, GPT-5 reasons over that text — and, for photos like a driver's license,
 * over the image directly (GPT reads images natively) — and returns structured fields
 * the findings engine compares. Runs in the owner's existing Azure account (one bill).
 *
 * Raw HTTPS via fetch (no @azure/openai SDK), matching every other integration in this
 * repo (DocuSign, Graph, ClickUp, Sitewire are all plain fetch) and the hard "no added
 * npm deps so Render builds cleanly" rule. Best-effort: unconfigured, timeout, or an
 * API error return { ok:false, reason } — never throws, never blocks.
 *
 * NOTE vs Claude: Azure OpenAI chat does not ingest PDFs directly, so the reader
 * (docint.js) does the OCR first and GPT reasons over that text. Images (IDs, photos)
 * can go straight to GPT as an image_url part.
 *
 * Env (Render only, never source):
 *   AZURE_OPENAI_ENDPOINT     e.g. https://<resource>.openai.azure.com
 *   AZURE_OPENAI_KEY          the resource key (api-key header)
 *   AZURE_OPENAI_DEPLOYMENT   the deployment name you give your GPT-5 model
 *   AZURE_OPENAI_API_VERSION  API version (default '2025-04-01-preview')
 *
 * Wire contract: POST {endpoint}/openai/deployments/{deployment}/chat/completions
 * ?api-version=... ; header `api-key`; reliable JSON via response_format json_schema
 * (strict). GPT-5 uses `max_completion_tokens` (not max_tokens) and only the default
 * temperature, so we omit temperature entirely.
 */
const cfg = require('../../config');
const { runWithRetry, classifyStatus, retryAfterMs, breakerFor } = require('./resilience');

const DEFAULT_API_VERSION = '2025-04-01-preview';
// GPT-5 spends hidden reasoning tokens out of this same budget, so keep it generous
// and default reasoning effort LOW for extraction (we want reading, not deliberation).
const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_REASONING = 'low';
// Overall wall-clock budget for one completion INCLUDING retries (the per-attempt timeout is
// separate, below). The retry loop starts no new attempt past this, so total time is bounded by
// the deadline plus at most one in-flight attempt — it stops and surfaces the last failure for
// human review, never silently dropping the document.
const OPENAI_DEADLINE_MS = 90000;

/** True when endpoint + key + deployment are configured (surfaced on /api/health). */
function available() {
  return !!(cfg.azureOpenai && cfg.azureOpenai.endpoint && cfg.azureOpenai.key && cfg.azureOpenai.deployment);
}

function chatUrl() {
  const base = String(cfg.azureOpenai.endpoint || '').replace(/\/+$/, '');
  const dep = cfg.azureOpenai.deployment;
  const ver = cfg.azureOpenai.apiVersion || DEFAULT_API_VERSION;
  return `${base}/openai/deployments/${encodeURIComponent(dep)}/chat/completions?api-version=${ver}`;
}

/**
 * Low-level call. `userContent` is a string OR an array of content parts
 * (text / image_url). Returns the raw text the model produced.
 * @returns {Promise<{ ok:boolean, text?:string, usage?:object, reason?:string }>}
 */
// ONE HTTP attempt at a completion. Returns a classified result the retry loop understands:
// success is { ok, text, ... }; a transient failure carries retryable/breakerFault so the
// loop backs off; a document-specific failure (content filter, truncation, empty) is terminal
// and neutral to the breaker. A network drop / our timeout THROWS — runWithRetry classifies it.
async function attemptComplete(body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 60000);
  let r;
  try {
    r = await fetch(chatUrl(), {
      method: 'POST',
      headers: { 'api-key': cfg.azureOpenai.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A PROMPT-side content filter returns HTTP 400 with a content_filter code — route it to
    // human review, never a retry (a property of THIS document, not a transient outage).
    const code = (j.error && (j.error.code || (j.error.innererror && j.error.innererror.code))) || '';
    if (/content_filter|ResponsibleAIPolicy/i.test(String(code))) {
      return { ok: false, reason: 'this document was blocked by a content filter — needs manual review', blocked: true, retryable: false, breakerFault: false, outcome: 'content_filtered' };
    }
    const cls = classifyStatus(r.status);
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: `the analyzer reported an error (${msg})`,
      retriable: cls.retryable, retryable: cls.retryable, breakerFault: cls.breakerFault,
      outcome: cls.outcome, retryAfterMs: retryAfterMs(r.headers), status: r.status };
  }
  const choice = (j.choices || [])[0] || {};
  const msg = choice.message || {};
  // Structured outputs can return a refusal instead of content; Azure content filters surface
  // as finish_reason 'content_filter'. Treat both as a clean "declined" (terminal, not a fault).
  if (msg.refusal) return { ok: false, reason: `the analyzer declined: ${msg.refusal}`, blocked: true, retryable: false, breakerFault: false, outcome: 'content_filtered' };
  if (choice.finish_reason === 'content_filter') {
    return { ok: false, reason: 'the analyzer was blocked by a content filter on this document', blocked: true, retryable: false, breakerFault: false, outcome: 'content_filtered' };
  }
  // Hit the token ceiling before finishing — under strict JSON this yields invalid/partial
  // output. NOT retryable as-is (the same request re-fails); extract() retries with a bigger
  // budget. Terminal + neutral to the breaker (the endpoint answered fine).
  if (choice.finish_reason === 'length') {
    return { ok: false, reason: 'the analyzer ran out of room before finishing (truncated)', truncated: true, retryable: false, breakerFault: false, outcome: 'truncated' };
  }
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!text) return { ok: false, reason: 'the analyzer returned an empty result', retryable: false, breakerFault: false, outcome: 'empty' };
  return { ok: true, text, usage: j.usage || null, finishReason: choice.finish_reason };
}

async function complete({ system, userContent, maxTokens, responseFormat, timeoutMs } = {}) {
  if (!available()) return { ok: false, reason: 'the AI analyzer is not configured (add the Azure OpenAI endpoint, key, and deployment)' };
  if (!userContent || (Array.isArray(userContent) && !userContent.length)) {
    return { ok: false, reason: 'nothing was sent to the analyzer' };
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });

  // GPT-5 uses max_completion_tokens (not max_tokens) and only the default
  // temperature — so we send neither temperature nor max_tokens. reasoning_effort
  // keeps hidden reasoning from eating the output budget on extraction.
  const body = {
    messages,
    max_completion_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    reasoning_effort: (cfg.azureOpenai && cfg.azureOpenai.reasoningEffort) || DEFAULT_REASONING,
  };
  if (responseFormat) body.response_format = responseFormat;

  // Bounded retry on transient 429/5xx/network, honoring Azure's Retry-After, behind a
  // per-endpoint circuit breaker. A missing config / content-filter / truncation is terminal
  // and returned on the first try. Never throws — a network drop becomes a classified result.
  const res = await runWithRetry(() => attemptComplete(body, timeoutMs), {
    breaker: breakerFor('azure-openai'),
    deadlineMs: OPENAI_DEADLINE_MS,
    label: 'the analyzer',
  });
  // A transient give-up (deadline / breaker-open) reads as a plain timeout to callers.
  if (!res.ok && res.retryable && !res.reason) res.reason = 'the analyzer timed out';
  return res;
}

/**
 * Build the user content for a document: the instruction + the reader's OCR text, plus
 * (optionally) the original image for photo documents like an ID.
 * @param {{ instructions:string, ocrText?:string, imageBase64?:string, imageMime?:string }} a
 */
function buildUserContent(a = {}) {
  const parts = [];
  let text = a.instructions || '';
  if (a.ocrText) {
    text += `\n\n---\nText read from this document by the OCR reader (may be imperfect):\n"""\n${String(a.ocrText).slice(0, 120000)}\n"""`;
  }
  parts.push({ type: 'text', text });
  // Only attach a REAL image — Azure chat rejects application/pdf as image_url. A PDF
  // scan (common for IDs) rides on the OCR text instead of a broken image part.
  if (a.imageBase64 && /^image\//i.test(a.imageMime || '')) {
    parts.push({ type: 'image_url', image_url: { url: `data:${a.imageMime};base64,${a.imageBase64}` } });
  }
  return parts;
}

/**
 * Extract structured fields from a document. `schema` is a JSON Schema (must set
 * additionalProperties:false and list every property in required — Azure structured
 * outputs are strict; NO min/max/length constraints). Returns the validated object.
 * @returns {Promise<{ ok:boolean, data?:object, raw?:string, usage?:object, reason?:string }>}
 */
async function extract({ system, instructions, schema, ocrText, imageBase64, imageMime, maxTokens } = {}) {
  if (!schema) return { ok: false, reason: 'no extraction shape (schema) was provided' };
  const userContent = buildUserContent({ instructions, ocrText, imageBase64, imageMime });
  const responseFormat = { type: 'json_schema', json_schema: { name: 'extraction', schema, strict: true } };
  let res = await complete({ system, userContent, maxTokens, responseFormat });
  // One retry with a bigger budget if the model was truncated mid-JSON.
  if (!res.ok && res.truncated) {
    res = await complete({ system, userContent, maxTokens: (maxTokens || DEFAULT_MAX_TOKENS) * 2, responseFormat });
  }
  if (!res.ok) return res;
  let data;
  try { data = JSON.parse(res.text); }
  catch { return { ok: false, reason: 'the analyzer returned a result we could not read', raw: res.text }; }
  return { ok: true, data, raw: res.text, usage: res.usage };
}

/**
 * Auth+deployment health ping — a tiny chat call. Confirms the endpoint, key, AND the
 * deployment name are all correct together (401 = bad key, 404 = wrong deployment/endpoint).
 * Never throws. @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function ping() {
  if (!available()) return { ok: false, reason: 'endpoint, key, or deployment not set' };
  const res = await complete({
    userContent: 'Reply with the word OK.',
    maxTokens: 256,   // GPT-5 spends hidden reasoning tokens from this budget — leave room
    timeoutMs: 20000,
  });
  // A truncation means the model REPLIED (auth + deployment are fine) but ran past the tiny
  // budget on hidden reasoning — that's a healthy endpoint, not a config failure.
  if (res.ok || res.truncated) return { ok: true };
  if (/HTTP 401/.test(res.reason || '')) return { ok: false, reason: 'bad key (HTTP 401)' };
  if (/HTTP 404/.test(res.reason || '')) return { ok: false, reason: 'deployment name or endpoint looks wrong (HTTP 404)' };
  return { ok: false, reason: res.reason };
}

module.exports = { available, complete, extract, buildUserContent, ping };
