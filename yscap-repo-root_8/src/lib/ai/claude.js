'use strict';
/**
 * Claude (Anthropic) — the "brain" that UNDERSTANDS a document and pulls out the
 * facts an underwriter needs: names, dates, prices, addresses, entities, and the
 * judgment calls ("is this the same seller across three documents?"). Pairs with
 * docai.js: Document AI turns a scanned/blurry page into clean text, Claude reasons
 * over that text (and/or the original PDF/image directly — Claude reads PDFs and
 * images natively) and returns structured fields the findings engine compares.
 *
 * Raw HTTPS via fetch (no @anthropic-ai/sdk), matching every other integration in
 * this repo (DocuSign, Graph, ClickUp, Sitewire are all plain fetch) and the hard
 * "no added npm deps so Render builds cleanly" rule. Best-effort: unconfigured,
 * timeout, or an API error return { ok:false, reason } — never throws, never blocks.
 *
 * Env (Render only, never source):
 *   ANTHROPIC_API_KEY   the key from console.anthropic.com
 *   ANTHROPIC_MODEL     optional model override (default claude-opus-4-8)
 *
 * Model/API notes (Opus 4.8 wire contract): x-api-key + anthropic-version header;
 * NO temperature/top_p/budget_tokens (rejected on 4.8); PDFs ride as `document`
 * blocks (base64, no beta header); reliable JSON comes from `output_config.format`
 * (a json_schema the model is constrained to). We keep max_tokens under the ~16k
 * non-streaming timeout ceiling, so no streaming is needed for extraction.
 */
const cfg = require('../../config');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 8000;

/** True when an API key is configured (surfaced on /api/health). */
function available() {
  return !!(cfg.anthropic && cfg.anthropic.apiKey);
}

/**
 * Low-level call. `content` is an Anthropic user-content array (text/document/image
 * blocks). Returns the raw text the model produced.
 * @returns {Promise<{ ok:boolean, text?:string, usage?:object, reason?:string }>}
 */
async function complete({ system, content, maxTokens, model, outputFormat, timeoutMs } = {}) {
  if (!available()) return { ok: false, reason: 'the AI analyzer is not configured (add the API key)' };
  if (!Array.isArray(content) || !content.length) {
    return { ok: false, reason: 'nothing was sent to the analyzer' };
  }

  const body = {
    model: model || cfg.anthropic.model || DEFAULT_MODEL,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content }],
  };
  if (system) body.system = system;
  // Constrain the reply to a schema so extraction always comes back as clean, valid
  // JSON in the same shape (Opus 4.8 structured outputs).
  if (outputFormat) body.output_config = { format: outputFormat };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 60000);
  let r;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.anthropic.apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
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
  if (j.stop_reason === 'refusal') {
    return { ok: false, reason: 'the analyzer declined to process this document' };
  }
  const text = (j.content || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) return { ok: false, reason: 'the analyzer returned an empty result' };
  return { ok: true, text, usage: j.usage || null, stopReason: j.stop_reason };
}

/**
 * Build the Anthropic content blocks for a document. Prefer sending the ORIGINAL PDF/
 * image straight to Claude (it reads them natively and best) and ALSO attach any text
 * Document AI already extracted (helps on the ugliest scans). Docs/images go before
 * the instruction text, per the API's guidance.
 * @param {{ instructions:string, pdfBase64?:string, imageBase64?:string, imageMime?:string, ocrText?:string }} a
 */
function buildContent(a = {}) {
  const content = [];
  if (a.pdfBase64) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.pdfBase64 } });
  }
  if (a.imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: a.imageMime || 'image/png', data: a.imageBase64 } });
  }
  let text = a.instructions || '';
  if (a.ocrText) {
    // Give the model the OCR'd text as a fallback signal for degraded scans.
    text += `\n\n---\nText already read from this document by OCR (may be imperfect):\n"""\n${String(a.ocrText).slice(0, 120000)}\n"""`;
  }
  content.push({ type: 'text', text });
  return content;
}

/**
 * Extract structured fields from a document. `schema` is a JSON Schema (must set
 * additionalProperties:false and list required; NO min/max/length constraints — those
 * are unsupported by structured outputs). Returns the validated object.
 * @returns {Promise<{ ok:boolean, data?:object, raw?:string, usage?:object, reason?:string }>}
 */
async function extract({ system, instructions, schema, pdfBase64, imageBase64, imageMime, ocrText, model, maxTokens } = {}) {
  if (!schema) return { ok: false, reason: 'no extraction shape (schema) was provided' };
  const content = buildContent({ instructions, pdfBase64, imageBase64, imageMime, ocrText });
  const res = await complete({
    system,
    content,
    model,
    maxTokens,
    outputFormat: { type: 'json_schema', schema },
  });
  if (!res.ok) return res;
  let data;
  try { data = JSON.parse(res.text); }
  catch { return { ok: false, reason: 'the analyzer returned a result we could not read', raw: res.text }; }
  return { ok: true, data, raw: res.text, usage: res.usage };
}

module.exports = { available, complete, extract, buildContent, DEFAULT_MODEL };
