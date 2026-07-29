'use strict';
/**
 * Anthropic Claude — the INDEPENDENT SECOND reasoning provider for the review
 * committee (#215). The committee's whole premise is adversarial verification: a
 * finding is only as trustworthy as the DIFFERENT eyes that tried to refute it.
 * When every specialist runs on the same Azure OpenAI deployment, they share the
 * same blind spots — a "committee of one model." Wiring a genuinely different
 * provider (Claude) for some of the panel makes the independence real.
 *
 * Mirrors azure-openai.js exactly so the committee can call either through one
 * interface: `available()` + `complete({ system, userContent, maxTokens,
 * responseFormat, timeoutMs, trace, traceMeta }) → { ok, text, usage, reason }`.
 * Raw HTTPS via fetch (no @anthropic-ai/sdk — the hard no-added-deps rule). Best-
 * effort: unconfigured / timeout / API error returns { ok:false, reason } — NEVER
 * throws, never blocks. OFF until ANTHROPIC_API_KEY is set, so with no key the
 * committee is byte-identical to today (all Azure).
 *
 * Structured output: the committee passes an OpenAI-style
 * responseFormat = { type:'json_schema', json_schema:{ name, schema } }. Anthropic
 * has no response_format; the faithful equivalent is a FORCED TOOL whose
 * input_schema IS that JSON schema (tool_choice pins it), and the tool_use block's
 * `input` is the validated object — we return it JSON.stringified as `text` so the
 * caller's `JSON.parse(text)` works unchanged.
 */
const cfg = require('../../config');
const { runWithRetry, classifyStatus, retryAfterMs, breakerFor } = require('./resilience');
const langfuse = require('./langfuse');
const costMeter = require('./cost-meter');

const DEFAULT_MAX_TOKENS = 1024;
const DEADLINE_MS = 90000;

/** True when an Anthropic API key is configured (surfaced on the config-health page). */
function available() {
  return !!(cfg.anthropic && cfg.anthropic.key);
}

function messagesUrl() {
  const base = (cfg.anthropic && cfg.anthropic.baseUrl) || 'https://api.anthropic.com';
  return `${String(base).replace(/\/+$/, '')}/v1/messages`;
}

// Build the request body. When a JSON schema is requested, force a single tool
// whose input_schema is that schema so Claude returns a structured object.
function buildBody({ system, userText, maxTokens, responseFormat }) {
  const body = {
    model: (cfg.anthropic && cfg.anthropic.model) || 'claude-sonnet-5',
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: userText }],
  };
  if (system) body.system = system;
  const schema = responseFormat && responseFormat.json_schema && responseFormat.json_schema.schema;
  if (schema) {
    const name = (responseFormat.json_schema.name || 'structured_output').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'structured_output';
    body.tools = [{ name, description: 'Return the answer as a structured object matching the schema.', input_schema: schema }];
    body.tool_choice = { type: 'tool', name };
    body._forcedTool = name; // internal marker (stripped before send) so the parser knows to read tool_use
  }
  return body;
}

// Pull the answer text out of an Anthropic messages response. For a forced tool,
// the answer is the tool_use block's `input` object (returned JSON-stringified so
// the caller parses it exactly like an OpenAI json_schema string). Otherwise it's
// the concatenated text blocks.
function extractText(j, forcedTool) {
  const content = (j && Array.isArray(j.content)) ? j.content : [];
  if (forcedTool) {
    const tu = content.find((b) => b && b.type === 'tool_use' && (!forcedTool || b.name === forcedTool)) ||
               content.find((b) => b && b.type === 'tool_use');
    if (tu && tu.input != null) { try { return JSON.stringify(tu.input); } catch (_e) { return ''; } }
    return '';
  }
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}

// Normalize Anthropic usage → the { prompt_tokens, completion_tokens } shape the
// cost meter/traces already understand.
function normUsage(u) {
  if (!u) return null;
  return { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) };
}

// ONE HTTP attempt. Returns a classified result the retry loop understands; a
// network drop / our timeout THROWS so runWithRetry classifies it. Terminal,
// document-specific failures (stop_reason, empty) are neutral to the breaker.
async function attemptComplete(body, timeoutMs) {
  const forcedTool = body._forcedTool || null;
  const send = Object.assign({}, body); delete send._forcedTool;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 60000);
  let r;
  try {
    r = await fetch(messagesUrl(), {
      method: 'POST',
      headers: {
        'x-api-key': cfg.anthropic.key,
        'anthropic-version': (cfg.anthropic && cfg.anthropic.apiVersion) || '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(send),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const cls = classifyStatus(r.status);
    const msg = (j && j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: `the analyzer reported an error (${msg})`,
      retryable: cls.retryable, breakerFault: cls.breakerFault,
      outcome: cls.outcome, retryAfterMs: retryAfterMs(r.headers), status: r.status };
  }
  // A refusal / content stop is terminal + neutral to the breaker (the endpoint answered fine).
  if (j && j.stop_reason === 'refusal') {
    return { ok: false, reason: 'the analyzer declined this content — needs manual review', blocked: true, retryable: false, breakerFault: false, outcome: 'content_filtered' };
  }
  if (j && j.stop_reason === 'max_tokens') {
    return { ok: false, reason: 'the analyzer ran out of room before finishing (truncated)', truncated: true, retryable: false, breakerFault: false, outcome: 'truncated' };
  }
  const text = extractText(j, forcedTool);
  if (!text) return { ok: false, reason: 'the analyzer returned an empty result', retryable: false, breakerFault: false, outcome: 'empty' };
  return { ok: true, text, usage: normUsage(j.usage), finishReason: j.stop_reason };
}

/**
 * complete(opts) → { ok, text?, usage?, reason? }. Mirrors azure-openai.complete.
 * `userContent` may be a string or an array of parts (text parts are concatenated;
 * Anthropic image parts are not wired here — the committee sends text only). Never throws.
 */
async function complete({ system, userContent, maxTokens, responseFormat, timeoutMs, trace, traceMeta } = {}) {
  if (!available()) return { ok: false, reason: 'the second AI provider is not configured (add ANTHROPIC_API_KEY)' };
  const userText = Array.isArray(userContent)
    ? userContent.filter((p) => p && (p.type === 'text' || typeof p === 'string')).map((p) => (typeof p === 'string' ? p : p.text || '')).join('\n')
    : (userContent || '');
  if (!userText) return { ok: false, reason: 'nothing was sent to the analyzer' };

  const body = buildBody({ system, userText, maxTokens, responseFormat });
  const traceMd = traceMeta || {};
  const ownTrace = !trace && langfuse.enabled() ? langfuse.trace({
    name: traceMd.name || 'anthropic', appId: traceMd.appId, documentId: traceMd.documentId,
    staffId: traceMd.staffId, tags: traceMd.tags, metadata: traceMd,
  }) : null;
  const gen = (trace || ownTrace || langfuse.trace({ name: 'noop' })).generation({
    name: traceMd.opName || 'complete', model: body.model,
    modelParameters: { max_tokens: body.max_tokens },
    input: { system: system || null, hasResponseFormat: !!responseFormat, provider: 'anthropic' },
  });

  const res = await runWithRetry(() => attemptComplete(body, timeoutMs), {
    breaker: breakerFor('anthropic'), deadlineMs: DEADLINE_MS, label: 'the analyzer',
  });
  if (!res.ok && res.retryable && !res.reason) res.reason = 'the analyzer timed out';

  gen.end({
    output: res.ok ? { text: res.text, finishReason: res.finishReason } : null,
    usage: res.usage || undefined,
    level: res.ok ? undefined : 'ERROR',
    statusMessage: res.ok ? undefined : (res.reason || res.outcome),
  });
  if (ownTrace) ownTrace.end({ output: { ok: res.ok, reason: res.ok ? undefined : res.reason } });

  const u = res.usage || {};
  costMeter.record({
    applicationId: traceMd.appId, documentId: traceMd.documentId,
    opName: traceMd.opName || 'complete', provider: 'anthropic',
    model: body.model, tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0,
  });

  return { ok: !!res.ok, reason: res.ok ? null : (res.reason || res.outcome), text: res.ok ? res.text : undefined, usage: res.usage || null };
}

module.exports = { available, complete, _internals: { buildBody, extractText, normUsage } };
