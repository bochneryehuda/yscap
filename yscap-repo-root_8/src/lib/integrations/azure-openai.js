'use strict';
/**
 * Azure OpenAI (GPT-5) — reasoning over extracted document content. Zero-SDK: raw
 * fetch against the v1 data-plane API (/openai/v1/chat/completions), api-key auth,
 * per-request timeout, transient-only retry with backoff. Secrets come from config
 * (Render env), NEVER from source or the browser.
 *
 * The `model` sent to Azure is the Foundry DEPLOYMENT name (AZURE_OPENAI_DEPLOYMENT,
 * default 'gpt-5'), NOT the base model id. GPT-5 is a reasoning model, so we send
 * max_completion_tokens (never the legacy max_tokens) and omit temperature (only the
 * model default is accepted). Pass json:true for a strict JSON-object response.
 *
 * To activate (env): AZURE_OPENAI_ENDPOINT (base …openai.azure.com/),
 * AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT. API version is baked to 'preview' in
 * config (override AZURE_OPENAI_API_VERSION).
 */
const cfg = require('../../config').azureOpenai;

const MAX_TRIES = 3, BASE_BACKOFF_MS = 600, MAX_BACKOFF_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configured() { return !!(cfg.endpoint && cfg.key && cfg.deployment); }
function ensure() {
  if (!configured()) {
    throw new Error('Azure OpenAI not configured — set AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_KEY / AZURE_OPENAI_DEPLOYMENT');
  }
}

function backoff(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 30000);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.floor(Math.random() * 200);
}

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

/**
 * Run a chat / reasoning completion. Provide either { messages } (a full role array)
 * or { system, user } (built into a system+user chat). Options:
 *   json            — force a strict JSON-object response (response_format)
 *   maxOutputTokens — cap the completion (mapped to max_completion_tokens)
 * Returns { text, finishReason, usage, model, raw }.
 */
async function reason({ system, user, messages, json = false, maxOutputTokens } = {}) {
  ensure();
  let msgs = messages;
  if (!msgs) {
    if (user == null) throw new Error('reason: provide messages or user');
    msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push({ role: 'user', content: user });
  }
  const body = { model: cfg.deployment, messages: msgs };
  if (json) body.response_format = { type: 'json_object' };
  if (maxOutputTokens) body.max_completion_tokens = maxOutputTokens;

  const url = `${cfg.endpoint}/openai/v1/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`;
  const payload = JSON.stringify(body);

  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'api-key': cfg.key, 'Content-Type': 'application/json' },
        body: payload,
      }, cfg.timeoutMs);
    } catch (netErr) {
      lastErr = new Error(`Azure OpenAI request failed: ${netErr.message}`);
      if (attempt < MAX_TRIES) { await sleep(backoff(attempt)); continue; }
      throw lastErr;
    }
    if (res.ok) {
      const j = await res.json();
      const choice = (j.choices || [])[0] || {};
      return {
        text:         (choice.message && choice.message.content) || '',
        finishReason: choice.finish_reason,
        usage:        j.usage,
        model:        j.model || cfg.deployment,
        raw:          j,
      };
    }
    // Retry only on transient (429 / 5xx); surface other 4xx immediately.
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    const t = await res.text().catch(() => '');
    if (retryable && attempt < MAX_TRIES) {
      await sleep(backoff(attempt, parseInt(res.headers.get('retry-after') || '0', 10)));
      lastErr = new Error(`Azure OpenAI ${res.status}: ${t.slice(0, 200)}`);
      continue;
    }
    const e = new Error(`Azure OpenAI ${res.status}: ${t.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  throw lastErr || new Error('Azure OpenAI: exhausted retries');
}

/** Convenience: JSON-in / JSON-out reasoning. Parses the model's JSON reply into
 *  `.data` (null + parseError:true if the reply wasn't valid JSON). */
async function reasonJson(opts) {
  const r = await reason({ ...opts, json: true });
  try { return { ...r, data: JSON.parse(r.text) }; }
  catch { return { ...r, data: null, parseError: true }; }
}

module.exports = { name: 'azure-openai', configured, reason, reasonJson };
