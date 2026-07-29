'use strict';
/**
 * Clear Capital ClearAVM direct-source connector — REAL (#149 / R5.52; Sovereign
 * API landscape Tier 1). The THIRD independent AVM (after ATTOM + HouseCanary), so
 * the AVM consensus is a real triangulation, not two views of the same data.
 *
 * Clear Capital's ClearAVM is an API-KEY source (no per-borrower OAuth), so it is a
 * "lights up the moment you add the key" connector: set CLEARCAPITAL_KEY and it
 * starts answering. It returns an independent value estimate + a confidence range
 * for the subject property, fed to the twin as an api_verification observation of
 * appraisal.arv (kind='avm').
 *
 * The request is a POST of the subject address; the response value is read
 * TOLERANTLY (several plausible field paths) so it survives minor envelope
 * differences, and a response with no usable value is a clean {ok:false} — we NEVER
 * invent a number. The one thing not fully knowable without a live account — the
 * exact endpoint PATH — is env-overridable (CLEARCAPITAL_AVM_PATH) and documented,
 * so onboarding is a config change, not a code change.
 *
 * The request-build + response-parse are PURE, exported, and unit-tested; the HTTP
 * call goes through the shared guarded door (_http.requestJson: https-only, no
 * private hosts, bounded, retry-on-5xx, NEVER THROWS).
 */
const cfg = require('../../../config');
const http = require('./_http');

const KIND = 'avm';
const DEFAULT_ENDPOINT = 'https://api.clearcapital.com';
const DEFAULT_AVM_PATH = '/uve/v1.0.0/avm';

function configured() { return !!(cfg.clearCapital && cfg.clearCapital.key); }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { const s = v == null ? '' : String(v).trim(); return s || null; }

/**
 * addressParts(ctx) → { street, city, state, zip } | null   (PURE)
 * Accepts either explicit street/city/state/zip or a nested {property:{...}} shape
 * from the file context (the hub passes the file's property block).
 */
function addressParts(ctx) {
  const c = ctx || {};
  const p = c.property || {};
  const street = str(c.street || c.address1 || p.street || p.address1);
  const city = str(c.city || p.city);
  const state = str(c.state || p.state);
  const zip = str(c.zip || c.postal || p.zip || p.postal);
  if (!street || !zip) return null; // need at least street + zip to value a property
  return { street, city, state, zip };
}

/**
 * buildAvmRequest(conf, ctx) → { ok, url?, method?, headers?, body?, reason? }  (PURE)
 * conf: { key, endpoint, avmPath }.  Never throws. POST the address; auth by bearer
 * token header. A minor envelope shift is absorbed by the tolerant parser below.
 */
function buildAvmRequest(conf, ctx) {
  const c = conf || {};
  if (!c.key) return { ok: false, reason: 'CLEARCAPITAL_KEY not set' };
  const addr = addressParts(ctx);
  if (!addr) return { ok: false, reason: 'no subject property address in context' };
  const base = (str(c.endpoint) || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const path = str(c.avmPath) || DEFAULT_AVM_PATH;
  return {
    ok: true,
    url: `${base}${path.startsWith('/') ? '' : '/'}${path}`,
    method: 'POST',
    headers: { Authorization: `Bearer ${String(c.key)}`, Accept: 'application/json' },
    body: { address: addr.street, city: addr.city, state: addr.state, zip: addr.zip },
  };
}

// scan a small set of plausible dotted paths for the first finite number.
function pickNum(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path.split('.')) {
      if (cur && typeof cur === 'object' && key in cur) cur = cur[key];
      else { ok = false; break; }
    }
    if (ok) { const n = num(cur); if (n != null) return n; }
  }
  return null;
}

const VALUE_PATHS = ['value', 'avm.value', 'estimatedValue', 'estimated_value', 'valuation.value', 'result.value', 'clearAvm.value', 'clearAVM.value', 'price'];
const LOW_PATHS = ['low', 'value_low', 'avm.low', 'valuation.low', 'confidence.low', 'valueRange.low', 'range.low'];
const HIGH_PATHS = ['high', 'value_high', 'avm.high', 'valuation.high', 'confidence.high', 'valueRange.high', 'range.high'];
// A PLAIN confidence/score (higher = better). FSD is handled separately below
// because it is an ERROR band (lower = better) and must be inverted.
const CONF_PATHS = ['confidence', 'confidence_score', 'confidenceScore', 'score', 'avm.confidence'];
const FSD_PATHS = ['fsd', 'forecast_standard_deviation'];

/**
 * parseAvmResponse(json) → { ok, observations:[{fact_key,value_json,raw_value,confidence}], reason? }
 * (PURE, never throws). A response with no usable value is a clean {ok:false} — we
 * never invent a number.
 */
function parseAvmResponse(json) {
  try {
    const j = json && typeof json === 'object' ? json : null;
    if (!j) return { ok: false, observations: [], reason: 'empty Clear Capital response' };
    const value = pickNum(j, VALUE_PATHS);
    if (value == null || value <= 0) {
      const msg = str(j.message || j.error || (j.status && (j.status.message || j.status.msg)));
      return { ok: false, observations: [], reason: msg ? `Clear Capital: ${msg}` : 'no AVM value in Clear Capital response' };
    }
    const low = pickNum(j, LOW_PATHS);
    const high = pickNum(j, HIGH_PATHS);
    // Confidence: a PLAIN confidence/score (higher = better; 0..100 normalizes to
    // 0..1, already-0..1 passes through) wins; ELSE FSD (forecast standard
    // deviation, an ERROR band where LOWER = better) is inverted to 1-fsd. Missing
    // → a sane default. Advisory metadata only — it never touches the AVM value.
    let conf = pickNum(j, CONF_PATHS);
    if (conf != null) {
      if (conf > 1 && conf <= 100) conf = conf / 100;
    } else {
      const fsd = pickNum(j, FSD_PATHS);
      if (fsd != null) conf = 1 - (fsd > 1 ? fsd / 100 : fsd); // lower FSD → higher confidence
    }
    if (conf == null) conf = 0.85;
    conf = Math.max(0, Math.min(1, conf));
    const observations = [{
      fact_key: 'appraisal.arv',
      value_json: { value, low, high, source: 'clearcapital_avm' },
      raw_value: value,
      confidence: conf,
    }];
    return { ok: true, observations };
  } catch (e) {
    return { ok: false, observations: [], reason: (e && e.message) || 'parse error' };
  }
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'CLEARCAPITAL_KEY not set' };
  return { ok: true, reason: 'Clear Capital configured' };
}

/**
 * fetch(appId, ctx, deps?) → { ok, observations?, reason? }   (NEVER THROWS)
 * deps.fetchImpl lets tests inject a fake HTTP; production uses the guarded _http door.
 */
async function fetch(appId, ctx = {}, deps = {}) {
  try {
    const req = buildAvmRequest(cfg.clearCapital, ctx);
    if (!req.ok) return { ok: false, reason: req.reason };
    const res = await http.requestJson(req.url, {
      method: req.method, headers: req.headers, body: req.body,
      fetchImpl: deps.fetchImpl, label: 'clearcapital-avm',
    });
    if (!res.ok) return { ok: false, reason: res.reason || `Clear Capital http ${res.status}` };
    return parseAvmResponse(res.json);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'Clear Capital fetch error' };
  }
}

module.exports = {
  configured, ping, fetch, kind: KIND,
  buildAvmRequest, parseAvmResponse, addressParts,
  _internals: { DEFAULT_ENDPOINT, DEFAULT_AVM_PATH, pickNum },
};
