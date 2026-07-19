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

const DEFAULT_API_VERSION = '2025-04-01-preview';
const DEFAULT_MAX_TOKENS = 8000;

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
async function complete({ system, userContent, maxTokens, responseFormat, timeoutMs } = {}) {
  if (!available()) return { ok: false, reason: 'the AI analyzer is not configured (add the Azure OpenAI endpoint, key, and deployment)' };
  if (!userContent || (Array.isArray(userContent) && !userContent.length)) {
    return { ok: false, reason: 'nothing was sent to the analyzer' };
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });

  // GPT-5 uses max_completion_tokens (not max_tokens) and only the default
  // temperature — so we send neither temperature nor max_tokens.
  const body = { messages, max_completion_tokens: maxTokens || DEFAULT_MAX_TOKENS };
  if (responseFormat) body.response_format = responseFormat;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 60000);
  let r;
  try {
    r = await fetch(chatUrl(), {
      method: 'POST',
      headers: {
        'api-key': cfg.azureOpenai.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError'
      ? 'the analyzer timed out'
      : `the analyzer could not be reached (${e.message})` };
  } finally {
    clearTimeout(timer);
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: `the analyzer reported an error (${msg})` };
  }
  const choice = (j.choices || [])[0] || {};
  const msg = choice.message || {};
  // Structured outputs can return a refusal instead of content; Azure content filters
  // surface as finish_reason 'content_filter'. Treat both as a clean "declined".
  if (msg.refusal) return { ok: false, reason: `the analyzer declined: ${msg.refusal}` };
  if (choice.finish_reason === 'content_filter') {
    return { ok: false, reason: 'the analyzer was blocked by a content filter on this document' };
  }
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!text) return { ok: false, reason: 'the analyzer returned an empty result' };
  return { ok: true, text, usage: j.usage || null, finishReason: choice.finish_reason };
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
  if (a.imageBase64) {
    parts.push({ type: 'image_url', image_url: { url: `data:${a.imageMime || 'image/png'};base64,${a.imageBase64}` } });
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
  const res = await complete({
    system,
    userContent,
    maxTokens,
    responseFormat: { type: 'json_schema', json_schema: { name: 'extraction', schema, strict: true } },
  });
  if (!res.ok) return res;
  let data;
  try { data = JSON.parse(res.text); }
  catch { return { ok: false, reason: 'the analyzer returned a result we could not read', raw: res.text }; }
  return { ok: true, data, raw: res.text, usage: res.usage };
}

module.exports = { available, complete, extract, buildUserContent };
