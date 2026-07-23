'use strict';
/**
 * #205 — the durable AI-CALL AUDIT RECORD (canonical, version-stamped core).
 *
 * The decision certificate (decision-certificate.js, #R5.63) proves WHAT the loan
 * decision relied on. This is the other half a regulator asks for: WHAT EVERY AI
 * CALL DID — which model + version, on which inputs, producing which output, at
 * what cost — as a durable, tamper-evident record that survives the request.
 *
 * langfuse traces to an external tool and cost-meter tallies cents, but neither is
 * a durable, in-house, HASHABLE audit unit. This module defines that unit:
 *
 *   • VERSION-STAMPED — provider + model + modelVersion + the artifact versions
 *     (prompt / schema / rule / normalizer) the call ran under, so the exact brain
 *     that produced an output is always identifiable and a later model swap can't
 *     silently rewrite history.
 *   • CONTENT-ADDRESSED, NOT RAW — the prompt and the input/output are stored as
 *     sha256 DIGESTS (+ a redacted preview), never as raw bytes. Two calls with the
 *     same input hash identically; PII/secrets never land in the audit log.
 *   • TAMPER-EVIDENT — hashRecord() is a stable hash of the canonical record, so a
 *     stored record can be proven unaltered (mirrors decision-certificate hashing).
 *
 * PURE core (buildRecord / hashRecord / redactText / digest): no DB, no clock (the
 * caller stamps `at`), no I/O. NEVER THROWS. The durable DB writer/loader is a thin
 * follow-on that persists this exact shape.
 */
const crypto = require('crypto');
let _lf = null;
// reuse the existing redaction rules (SSN/card/secret patterns) — pure, no DB.
function redactor() {
  if (_lf === null) {
    try { _lf = require('../ai/langfuse'); } catch (_e) { _lf = { _redact: null }; }
  }
  return _lf && typeof _lf._redact === 'function' ? _lf._redact : null;
}

const SCHEMA_VERSION = 'ai_call_record.v1';
const PREVIEW_MAX = 240; // chars of redacted preview kept for eyeballing; never the full text

function low(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function str(v) { const s = v == null ? '' : String(v); return s; }
function int(v, d) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : (d == null ? null : d); }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** redactText(s) → the string with SSN/card/secret patterns masked. PURE, never throws. */
function redactText(s) {
  try {
    const t = str(s);
    const r = redactor();
    return r ? String(r(t)) : t;
  } catch (_e) { return ''; }
}

/**
 * digest(value) → sha256 hex of a stable serialization of `value`, computed over
 * the REDACTED text so a digest never encodes raw PII. PURE, never throws.
 * A string is hashed directly (redacted); an object is stably stringified first.
 */
function digest(value) {
  try {
    if (value === null || value === undefined) return null;
    const text = typeof value === 'string' ? value : stableStringify(value);
    return crypto.createHash('sha256').update(redactText(text)).digest('hex');
  } catch (_e) { return null; }
}

// deterministic JSON: object keys sorted recursively (mirrors decision-certificate).
function stableStringify(obj) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };
  try { return JSON.stringify(norm(obj)); } catch (_e) { return 'null'; }
}

function preview(s) {
  const red = redactText(s);
  return red.length > PREVIEW_MAX ? red.slice(0, PREVIEW_MAX) : red;
}

/**
 * buildRecord(call) → a canonical AI-call audit record  (PURE, NEVER THROWS)
 *   call: {
 *     provider, model, modelVersion, op|opName|component,
 *     appId|applicationId, documentId, runId,
 *     prompt|promptText, promptId, promptVersion,
 *     input|inputText, output|outputText,
 *     tokensIn|usage.prompt_tokens, tokensOut|usage.completion_tokens,
 *     costCents, latencyMs|durationMs, ok, reason, outcome,
 *     artifactVersions:{prompt,schema,rule,model,normalizer,...}, at (ISO string)
 *   }
 * Returns { schemaVersion, provider, model, modelVersion, op, appId, documentId,
 *   runId, prompt:{id,version,hash,preview}, inputDigest, outputDigest,
 *   outputPreview, usage:{tokensIn,tokensOut,tokensTotal}, costCents, latencyMs,
 *   ok, reason, outcome, artifactVersions, at }.  Raw prompt/input/output are NEVER
 * stored — only digests + a redacted preview.
 */
function buildRecord(call) {
  try {
    const c = call && typeof call === 'object' ? call : {};
    const u = c.usage && typeof c.usage === 'object' ? c.usage : {};
    const tokensIn = int(c.tokensIn != null ? c.tokensIn : u.prompt_tokens, 0);
    const tokensOut = int(c.tokensOut != null ? c.tokensOut : u.completion_tokens, 0);
    const promptText = c.prompt != null ? c.prompt : c.promptText;
    const inputVal = c.input != null ? c.input : c.inputText;
    const outputVal = c.output != null ? c.output : c.outputText;

    const av = c.artifactVersions && typeof c.artifactVersions === 'object' ? c.artifactVersions : {};
    const artifactVersions = {};
    for (const k of Object.keys(av).sort()) artifactVersions[k] = av[k] == null ? null : String(av[k]);

    return {
      schemaVersion: SCHEMA_VERSION,
      provider: low(c.provider) || null,
      model: str(c.model) || null,
      modelVersion: str(c.modelVersion) || null,
      op: str(c.op || c.opName || c.component) || null,
      appId: c.appId != null ? String(c.appId) : (c.applicationId != null ? String(c.applicationId) : null),
      documentId: c.documentId != null ? String(c.documentId) : null,
      runId: c.runId != null ? String(c.runId) : null,
      prompt: {
        id: c.promptId != null ? String(c.promptId) : null,
        version: c.promptVersion != null ? String(c.promptVersion) : null,
        hash: promptText != null ? digest(promptText) : null,
        preview: promptText != null ? preview(str(promptText)) : null,
      },
      inputDigest: inputVal != null ? digest(inputVal) : null,
      outputDigest: outputVal != null ? digest(outputVal) : null,
      outputPreview: outputVal != null ? preview(typeof outputVal === 'string' ? outputVal : stableStringify(outputVal)) : null,
      usage: { tokensIn, tokensOut, tokensTotal: tokensIn + tokensOut },
      costCents: numOrNull(c.costCents),
      latencyMs: int(c.latencyMs != null ? c.latencyMs : c.durationMs, null),
      ok: c.ok === undefined ? true : !!c.ok,
      reason: c.reason != null ? redactText(String(c.reason)) : null,
      outcome: c.outcome != null ? (typeof c.outcome === 'string' ? redactText(c.outcome) : c.outcome) : null,
      artifactVersions,
      at: c.at != null ? String(c.at) : null, // caller stamps the time; the module never touches the clock
    };
  } catch (_e) {
    return {
      schemaVersion: SCHEMA_VERSION, provider: null, model: null, modelVersion: null, op: null,
      appId: null, documentId: null, runId: null,
      prompt: { id: null, version: null, hash: null, preview: null },
      inputDigest: null, outputDigest: null, outputPreview: null,
      usage: { tokensIn: 0, tokensOut: 0, tokensTotal: 0 },
      costCents: null, latencyMs: null, ok: false, reason: 'record build error', outcome: null,
      artifactVersions: {}, at: null,
    };
  }
}

/**
 * hashRecord(record) → sha256 hex of the canonical record MINUS its own hash, so a
 * stored record can be proven unaltered. Excludes volatile `at` from the identity
 * hash? NO — `at` is part of what happened; it's included. PURE, never throws.
 */
function hashRecord(record) {
  try {
    const r = record && typeof record === 'object' ? record : {};
    const copy = Object.assign({}, r);
    delete copy.recordHash;
    return crypto.createHash('sha256').update(stableStringify(copy)).digest('hex');
  } catch (_e) { return null; }
}

/** stamp(record) → record + recordHash (the tamper-evident seal). PURE, never throws. */
function stamp(record) {
  try {
    const r = buildIfRaw(record);
    return Object.assign({}, r, { recordHash: hashRecord(r) });
  } catch (_e) { return record; }
}

// if given a raw call (no schemaVersion), normalize it first.
function buildIfRaw(record) {
  if (record && typeof record === 'object' && record.schemaVersion === SCHEMA_VERSION) return record;
  return buildRecord(record);
}

module.exports = { buildRecord, hashRecord, stamp, redactText, digest, stableStringify, SCHEMA_VERSION, _internals: { PREVIEW_MAX, preview } };
