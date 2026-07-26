'use strict';
/**
 * HouseCanary direct-source connector — REAL (#220; Sovereign API landscape Tier 1).
 *
 * HouseCanary's Analytics API is HTTP-Basic-auth (key + secret) — no per-borrower
 * OAuth — so it's another "add the key and it works" source, and a SECOND
 * independent AVM alongside ATTOM (the AVM-consensus module triangulates them).
 * It answers with an authoritative value + rent estimate:
 *   * appraisal.arv          ← property/value       result.value.price_mean
 *   * appraisal.market_rent  ← property/rental_value result.rental_value.price_mean
 *
 * The request-build + response-parse are PURE, exported, and unit-tested; the two
 * best-effort GETs (value + rental) go through the shared guarded door
 * (_http.requestJson: https-only, no private hosts, bounded, retry-5xx, NEVER
 * THROWS). No key or no address → clean {ok:false} skip, never a crash, never a
 * guessed value. Response shapes follow HouseCanary's published Analytics API.
 */
const cfg = require('../../../config');
const http = require('./_http');

const KIND = 'avm';
const DEFAULT_ENDPOINT = 'https://api.housecanary.com';
const VALUE_PATH = '/v2/property/value';
const RENTAL_PATH = '/v2/property/rental_value';

function configured() { return !!(cfg.houseCanary && cfg.houseCanary.key && cfg.houseCanary.secret); }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { const s = v == null ? '' : String(v).trim(); return s || null; }

/** basicAuth(key, secret) → "Basic <base64(key:secret)>"  (PURE) */
function basicAuth(key, secret) {
  return 'Basic ' + Buffer.from(`${String(key || '')}:${String(secret || '')}`).toString('base64');
}

/** addressQuery(ctx) → { address, zipcode } | null  (PURE) — HouseCanary keys on street + zip. */
function addressQuery(ctx) {
  const c = ctx || {};
  const p = c.property || c;
  const address = str(c.address1 || p.street || p.address1 || p.address || c.street);
  const zipcode = str(p.zip || p.postal || c.zip || c.postal);
  if (!address || !zipcode) return null;
  return { address, zipcode };
}

/**
 * buildRequest(conf, ctx, path) → { ok, url?, headers?, reason? }  (PURE, never throws)
 * conf: { key, secret, endpoint }; path = VALUE_PATH | RENTAL_PATH.
 */
function buildRequest(conf, ctx, path) {
  const c = conf || {};
  if (!c.key || !c.secret) return { ok: false, reason: 'HOUSECANARY_KEY + HOUSECANARY_SECRET not set' };
  const addr = addressQuery(ctx);
  if (!addr) return { ok: false, reason: 'no subject property address+zip in context' };
  const base = (str(c.endpoint) || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const qs = `address=${encodeURIComponent(addr.address)}&zipcode=${encodeURIComponent(addr.zipcode)}`;
  return { ok: true, url: `${base}${path}?${qs}`, headers: { Authorization: basicAuth(c.key, c.secret), Accept: 'application/json' } };
}

/** componentResult(json, key) → the component's `result` object, tolerant of top-level or nested shape. */
function componentResult(json, key) {
  const j = json || {};
  const comp = j[key] || (j.result && j.result[key]) || null;
  if (!comp || typeof comp !== 'object') return null;
  // api_code 0 = ok; any other code is a provider-level "no result".
  if (comp.api_code != null && Number(comp.api_code) !== 0) return null;
  return comp.result || null;
}

function confFromFsd(fsd) { // forecast standard deviation → confidence (lower fsd = higher confidence)
  const f = num(fsd);
  if (f == null) return 0.9;
  return Math.max(0, Math.min(1, 1 - f));
}

/** parseValue(json) → { ok, observations }  (PURE) — property/value → appraisal.arv */
function parseValue(json) {
  try {
    const res = componentResult(json, 'property/value');
    const v = res && res.value ? res.value : null;
    const mean = v ? num(v.price_mean) : null;
    if (mean == null || mean <= 0) return { ok: false, observations: [], reason: 'no HouseCanary value' };
    return { ok: true, observations: [{
      fact_key: 'appraisal.arv',
      value_json: { value: mean, low: num(v.price_lower), high: num(v.price_upper), source: 'housecanary_avm' },
      raw_value: mean, confidence: confFromFsd(v.fsd),
    }] };
  } catch (e) { return { ok: false, observations: [], reason: (e && e.message) || 'parse error' }; }
}

/** parseRental(json) → { ok, observations }  (PURE) — property/rental_value → appraisal.market_rent */
function parseRental(json) {
  try {
    const res = componentResult(json, 'property/rental_value');
    const v = res && res.rental_value ? res.rental_value : null;
    const mean = v ? num(v.price_mean) : null;
    if (mean == null || mean <= 0) return { ok: false, observations: [], reason: 'no HouseCanary rent' };
    return { ok: true, observations: [{
      fact_key: 'appraisal.market_rent',
      value_json: { value: mean, low: num(v.price_lower), high: num(v.price_upper), source: 'housecanary_rental_avm' },
      raw_value: mean, confidence: confFromFsd(v.fsd),
    }] };
  } catch (e) { return { ok: false, observations: [], reason: (e && e.message) || 'parse error' }; }
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'HOUSECANARY_KEY + HOUSECANARY_SECRET not set' };
  return { ok: true, reason: 'HouseCanary configured' };
}

/**
 * fetch(appId, ctx, deps?) → { ok, observations?, reason? }  (NEVER THROWS)
 * Two best-effort GETs (value + rental); returns every observation gathered. A
 * failure of either sub-call never throws and never blocks the other.
 */
async function fetch(appId, ctx = {}, deps = {}) {
  try {
    const observations = [];
    const reasons = [];
    for (const [path, parse] of [[VALUE_PATH, parseValue], [RENTAL_PATH, parseRental]]) {
      const req = buildRequest(cfg.houseCanary, ctx, path);
      if (!req.ok) { reasons.push(req.reason); break; } // no key/address → both will fail; stop early
      const res = await http.requestJson(req.url, { method: 'GET', headers: req.headers, fetchImpl: deps.fetchImpl, label: 'housecanary' });
      if (!res.ok) { reasons.push(res.reason || `http ${res.status}`); continue; }
      const p = parse(res.json);
      if (p.ok) observations.push(...p.observations); else reasons.push(p.reason);
    }
    if (observations.length) return { ok: true, observations };
    return { ok: false, reason: reasons[0] || 'no HouseCanary result' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'HouseCanary fetch error' };
  }
}

module.exports = {
  configured, ping, fetch, kind: KIND,
  basicAuth, addressQuery, buildRequest, parseValue, parseRental,
  _internals: { DEFAULT_ENDPOINT, VALUE_PATH, RENTAL_PATH },
};
