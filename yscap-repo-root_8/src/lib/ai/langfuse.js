'use strict';
/**
 * Langfuse tracer (owner-directed 2026-07-22).
 *
 * Records every AI call PILOT makes — the prompt, the input, the output, confidence,
 * cost, and latency — into the Langfuse cloud so staff can click any AI finding and
 * see EXACTLY what the model read and what it thought. Free hobby tier (50k events/mo).
 *
 * Zero npm dependencies — plain fetch, matching every other integration in this repo.
 * Fire-and-forget: an outage or slow response never blocks or throws. Batched flush so
 * we make at most one HTTP call per second per process even under a burst.
 *
 * Env (in Render):
 *   LANGFUSE_PUBLIC_KEY  pk-lf-*
 *   LANGFUSE_SECRET_KEY  sk-lf-*
 *   LANGFUSE_HOST        default https://us.cloud.langfuse.com
 *
 * The public surface is a HIGH-LEVEL wrapper — callers do:
 *   const t = tracer.trace({ name:'committee-review', appId, staffId, tags:['committee'] });
 *   const g = t.generation({ name:'reviewer:credit', model:'gpt-5', input:{...} });
 *   ...
 *   g.end({ output:{...}, usage:{...}, confidence:0.87 });
 *   t.end({ output:{finding_count:3} });
 * A no-op tracer is returned when config is absent — call sites never branch on `enabled`.
 */

const cfg = require('../../config');
const crypto = require('crypto');

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH = 100;
const FETCH_TIMEOUT_MS = 8000;
// PII redaction — never send bare SSNs / full account numbers to the observability plane.
const SSN_BARE = /\b\d{9}\b/g;
const SSN_SEP  = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD     = /\b\d{13,19}\b/g;

let _queue = [];
let _timer = null;
let _flushInFlight = false;

function enabled() {
  return !!(cfg.langfuse && cfg.langfuse.publicKey && cfg.langfuse.secretKey);
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

// Recursive shallow redact — string leaves get SSN/card patterns masked, everything else
// is passed through. Objects/arrays traversed up to a depth cap so nothing ever loops.
function redact(v, depth = 0) {
  if (depth > 6 || v == null) return v;
  if (typeof v === 'string') {
    if (v.length > 200000) v = v.slice(0, 200000) + '…[truncated]';
    return v.replace(SSN_SEP, '***-**-****').replace(SSN_BARE, '*********').replace(CARD, m => '*'.repeat(m.length));
  }
  if (Array.isArray(v)) return v.slice(0, 200).map(x => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      // Belt-and-suspenders: never forward a known PII key even if the value looks clean.
      if (/^(ssn|social_security|passwd|password|api_key|private_key|secret)$/i.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = redact(v[k], depth + 1);
    }
    return out;
  }
  return v;
}

function enqueue(body) {
  if (!enabled()) return;
  _queue.push(body);
  if (_queue.length >= MAX_BATCH) return void flushNow();
  if (!_timer) _timer = setTimeout(flushNow, FLUSH_INTERVAL_MS).unref?.() || setTimeout(flushNow, FLUSH_INTERVAL_MS);
}

async function flushNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_flushInFlight || !_queue.length) return;
  const batch = _queue.splice(0, MAX_BATCH);
  _flushInFlight = true;
  try {
    const auth = 'Basic ' + Buffer.from(cfg.langfuse.publicKey + ':' + cfg.langfuse.secretKey).toString('base64');
    const url = cfg.langfuse.host + '/api/public/ingestion';
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ batch }),
        signal: ac.signal,
      });
    } finally { clearTimeout(to); }
  } catch (_) {
    // Observability MUST NOT break the main path — drop the batch on any failure.
  } finally {
    _flushInFlight = false;
    if (_queue.length) _timer = setTimeout(flushNow, FLUSH_INTERVAL_MS).unref?.() || setTimeout(flushNow, FLUSH_INTERVAL_MS);
  }
}

// --- No-op trace + generation returned when Langfuse is off, so call sites are agnostic ---
const NOOP_GENERATION = { id: null, end: () => {}, event: () => {}, span: () => NOOP_SPAN, generation: () => NOOP_GENERATION };
const NOOP_SPAN = { id: null, end: () => {}, event: () => {}, generation: () => NOOP_GENERATION };
const NOOP_TRACE = { id: null, end: () => {}, event: () => {}, span: () => NOOP_SPAN, generation: () => NOOP_GENERATION, url: () => null };

/**
 * Start a trace — one logical operation as a staff/AI sees it (a committee review,
 * an OCR read, a document split). May contain many generations/spans. Returns an
 * object with .generation() / .span() / .event() / .end() / .url().
 * @param {{name:string, appId?:string, documentId?:string, staffId?:string,
 *          input?:any, tags?:string[], metadata?:object, userId?:string}} a
 */
function trace(a = {}) {
  if (!enabled()) return NOOP_TRACE;
  const id = newId();
  const startedAt = nowIso();
  enqueue({
    id: newId(),
    type: 'trace-create',
    timestamp: startedAt,
    body: {
      id,
      timestamp: startedAt,
      name: String(a.name || 'ai-op'),
      userId: a.userId || (a.staffId ? `staff:${a.staffId}` : null) || null,
      sessionId: a.appId ? `file:${a.appId}` : null,
      input: a.input != null ? redact(a.input) : undefined,
      tags: Array.isArray(a.tags) ? a.tags.slice(0, 20) : undefined,
      metadata: redact({
        applicationId: a.appId || null,
        documentId: a.documentId || null,
        staffId: a.staffId || null,
        project: cfg.langfuse.project,
        ...(a.metadata || {}),
      }),
      release: process.env.RENDER_GIT_COMMIT || undefined,
    },
  });

  const url = () => `${cfg.langfuse.host}/project/${encodeURIComponent(cfg.langfuse.project)}/traces/${id}`;

  return {
    id,
    url,
    /** Attach a generation (an LLM call — has model / prompt / output / usage). */
    generation(g = {}) { return _generation(id, null, g); },
    /** Attach a span (a non-LLM step: DB read, HTTP call, tool). */
    span(s = {}) { return _span(id, null, s); },
    /** Attach a discrete event (a point-in-time note: "picked X because Y"). */
    event(e = {}) { _event(id, null, e); },
    /** Close the trace with the final output. */
    end(a2 = {}) {
      enqueue({
        id: newId(),
        type: 'trace-create',
        timestamp: nowIso(),
        body: {
          id,
          output: a2.output != null ? redact(a2.output) : undefined,
          metadata: a2.metadata ? redact(a2.metadata) : undefined,
        },
      });
    },
  };
}

function _generation(traceId, parentId, g) {
  const id = newId();
  const start = nowIso();
  enqueue({
    id: newId(),
    type: 'generation-create',
    timestamp: start,
    body: {
      id, traceId, parentObservationId: parentId || undefined,
      name: String(g.name || 'llm'),
      startTime: start,
      model: g.model || undefined,
      modelParameters: g.modelParameters ? redact(g.modelParameters) : undefined,
      input: g.input != null ? redact(g.input) : undefined,
      metadata: g.metadata ? redact(g.metadata) : undefined,
    },
  });
  return {
    id,
    end(a = {}) {
      enqueue({
        id: newId(),
        type: 'generation-update',
        timestamp: nowIso(),
        body: {
          id, traceId,
          endTime: nowIso(),
          output: a.output != null ? redact(a.output) : undefined,
          usage: a.usage ? _normalizeUsage(a.usage) : undefined,
          level: a.level || (a.error ? 'ERROR' : undefined),
          statusMessage: a.statusMessage || (a.error ? String(a.error).slice(0, 500) : undefined),
          metadata: a.metadata ? redact(_mergeConfidence(a.metadata, a.confidence)) : (a.confidence != null ? { confidence: a.confidence } : undefined),
        },
      });
    },
    event(e = {}) { _event(traceId, id, e); },
    span(s = {}) { return _span(traceId, id, s); },
    generation(g2 = {}) { return _generation(traceId, id, g2); },
  };
}

function _span(traceId, parentId, s) {
  const id = newId();
  const start = nowIso();
  enqueue({
    id: newId(),
    type: 'span-create',
    timestamp: start,
    body: {
      id, traceId, parentObservationId: parentId || undefined,
      name: String(s.name || 'span'),
      startTime: start,
      input: s.input != null ? redact(s.input) : undefined,
      metadata: s.metadata ? redact(s.metadata) : undefined,
    },
  });
  return {
    id,
    end(a = {}) {
      enqueue({
        id: newId(),
        type: 'span-update',
        timestamp: nowIso(),
        body: {
          id, traceId,
          endTime: nowIso(),
          output: a.output != null ? redact(a.output) : undefined,
          level: a.level || (a.error ? 'ERROR' : undefined),
          statusMessage: a.statusMessage || (a.error ? String(a.error).slice(0, 500) : undefined),
          metadata: a.metadata ? redact(a.metadata) : undefined,
        },
      });
    },
    event(e = {}) { _event(traceId, id, e); },
    generation(g = {}) { return _generation(traceId, id, g); },
  };
}

function _event(traceId, parentId, e) {
  const id = newId();
  enqueue({
    id: newId(),
    type: 'event-create',
    timestamp: nowIso(),
    body: {
      id, traceId, parentObservationId: parentId || undefined,
      name: String(e.name || 'event'),
      startTime: nowIso(),
      input: e.input != null ? redact(e.input) : undefined,
      output: e.output != null ? redact(e.output) : undefined,
      level: e.level || undefined,
      statusMessage: e.statusMessage || undefined,
      metadata: e.metadata ? redact(e.metadata) : undefined,
    },
  });
}

// Azure/OpenAI usage → Langfuse shape (input/output/total).
function _normalizeUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const inp = Number(u.prompt_tokens ?? u.promptTokens ?? u.input ?? 0);
  const out = Number(u.completion_tokens ?? u.completionTokens ?? u.output ?? 0);
  const total = Number(u.total_tokens ?? u.totalTokens ?? (inp + out));
  return { input: inp, output: out, total, unit: 'TOKENS' };
}

function _mergeConfidence(md, conf) {
  if (conf == null) return md;
  const out = { ...(md || {}) };
  out.confidence = conf;
  return out;
}

/**
 * Wrap an async producer so its result is auto-recorded as a generation on the caller's
 * trace. Convenience for the common shape:
 *   await tracer.wrap(t, {name:'extract', model:'gpt-5', input:{...}}, () => aoai.extract({...}))
 *     — its return value is passed to `outputOf` (default r.data ?? r.text) and confidence
 *       to `confidenceOf` if provided. A throw is logged as ERROR and rethrown.
 */
async function wrap(t, spec, fn) {
  const g = t.generation({
    name: spec.name, model: spec.model, input: spec.input,
    modelParameters: spec.modelParameters, metadata: spec.metadata,
  });
  try {
    const r = await fn();
    const output = spec.outputOf ? spec.outputOf(r) : (r && (r.data ?? r.text ?? r.output ?? r));
    const usage  = spec.usageOf ? spec.usageOf(r) : (r && r.usage);
    const conf   = spec.confidenceOf ? spec.confidenceOf(r) : undefined;
    g.end({ output, usage, confidence: conf });
    return r;
  } catch (err) {
    g.end({ level: 'ERROR', error: err && err.message || String(err) });
    throw err;
  }
}

// Flush on process exit — best-effort catch of any final events during graceful shutdown.
if (typeof process !== 'undefined' && process.on) {
  process.on('beforeExit', () => { flushNow().catch(() => {}); });
}

module.exports = { enabled, trace, wrap, flushNow, _redact: redact };
