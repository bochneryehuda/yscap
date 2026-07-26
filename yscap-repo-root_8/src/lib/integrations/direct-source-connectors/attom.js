'use strict';
/**
 * ATTOM Data Solutions connector — REAL (#220; Sovereign API landscape Tier 1/2).
 *
 * ATTOM is an API-KEY-ONLY property-intelligence source (no per-borrower OAuth),
 * so it is the cleanest "lights up the moment you add the key" connector: set
 * ATTOM_API_KEY and it starts answering. It returns an AUTHORITATIVE property
 * value + property facts that outrank document-only observations:
 *   * appraisal.arv           ← ATTOM AVM value  (kind='avm' → feeds AVM consensus)
 *   * property.year_built      ← summary.yearbuilt
 *   * property.last_sale_price ← sale.amount.saleamt
 *   * property.last_sale_date  ← sale.saleTransDate
 *
 * The request-build and response-parse are PURE, exported, and unit-tested; the
 * HTTP call goes through the shared guarded door (_http.requestJson: https-only,
 * no private hosts, bounded, retry-on-5xx, NEVER THROWS). fetch() reads the
 * subject address from ctx (the hub passes it); with no key or no address it
 * returns a clean {ok:false} skip — never a crash, never a guessed value.
 *
 * Response shape follows ATTOM's published /propertyapi/v1.0.0/avm/detail schema.
 */
const cfg = require('../../../config');
const http = require('./_http');

const KIND = 'avm';
const DEFAULT_ENDPOINT = 'https://api.gateway.attomdata.com';
const AVM_PATH = '/propertyapi/v1.0.0/avm/detail';

function configured() { return !!(cfg.attom && cfg.attom.key); }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { const s = v == null ? '' : String(v).trim(); return s || null; }

/**
 * addressParts(ctx) → { address1, address2 } | null   (PURE)
 * ATTOM wants line-1 (street) + line-2 (city, ST zip). Accept either explicit
 * address1/address2 or a {street, city, state, zip} shape from the file context.
 */
function addressParts(ctx) {
  const c = ctx || {};
  const a1 = str(c.address1 || c.street || (c.property && (c.property.address1 || c.property.street)));
  let a2 = str(c.address2 || (c.property && c.property.address2));
  if (!a2) {
    const city = str(c.city || (c.property && c.property.city));
    const state = str(c.state || (c.property && c.property.state));
    const zip = str(c.zip || c.postal || (c.property && (c.property.zip || c.property.postal)));
    const cs = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    a2 = cs || null;
  }
  if (!a1 || !a2) return null;
  return { address1: a1, address2: a2 };
}

/**
 * buildAvmRequest(conf, ctx) → { ok, url?, headers?, reason? }   (PURE)
 * conf: { key, endpoint }.  Never throws.
 */
function buildAvmRequest(conf, ctx) {
  const c = conf || {};
  if (!c.key) return { ok: false, reason: 'ATTOM_API_KEY not set' };
  const addr = addressParts(ctx);
  if (!addr) return { ok: false, reason: 'no subject property address in context' };
  const base = (str(c.endpoint) || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const qs = `address1=${encodeURIComponent(addr.address1)}&address2=${encodeURIComponent(addr.address2)}`;
  return {
    ok: true,
    url: `${base}${AVM_PATH}?${qs}`,
    headers: { apikey: String(c.key), Accept: 'application/json' },
  };
}

/**
 * parseAvmResponse(json) → { ok, observations:[{fact_key,value_json,raw_value,confidence}], reason? }
 * (PURE, never throws). Maps ATTOM's property[0] to fact observations. A response
 * with no usable AVM value is a clean {ok:false} — we never invent a number.
 */
function parseAvmResponse(json) {
  try {
    const j = json || {};
    const prop = Array.isArray(j.property) && j.property[0] ? j.property[0] : null;
    if (!prop) {
      const msg = j.status && (j.status.msg || j.status.message);
      return { ok: false, observations: [], reason: msg ? `ATTOM: ${msg}` : 'no property in ATTOM response' };
    }
    const observations = [];
    const avmVal = prop.avm && prop.avm.amount ? num(prop.avm.amount.value) : null;
    if (avmVal != null && avmVal > 0) {
      // ATTOM confidence score (scr) is 0..100; normalize to 0..1 when present.
      const scr = prop.avm && prop.avm.amount ? num(prop.avm.amount.scr) : null;
      const conf = scr != null ? Math.max(0, Math.min(1, scr / 100)) : 0.9;
      const range = prop.avm && prop.avm.amount && prop.avm.amount.valueRange ? prop.avm.amount.valueRange : {};
      observations.push({
        fact_key: 'appraisal.arv',
        value_json: { value: avmVal, low: num(range.low), high: num(range.high), source: 'attom_avm' },
        raw_value: avmVal, confidence: conf,
      });
    }
    const yb = prop.summary ? num(prop.summary.yearbuilt || prop.summary.yearBuilt) : null;
    if (yb != null && yb > 1700) observations.push({ fact_key: 'property.year_built', value_json: { value: yb }, raw_value: yb, confidence: 0.95 });

    const saleAmt = prop.sale && prop.sale.amount ? num(prop.sale.amount.saleamt || prop.sale.amount.saleAmt) : null;
    if (saleAmt != null && saleAmt > 0) observations.push({ fact_key: 'property.last_sale_price', value_json: { value: saleAmt }, raw_value: saleAmt, confidence: 0.95 });

    const saleDate = prop.sale ? str(prop.sale.saleTransDate || prop.sale.salesearchdate) : null;
    if (saleDate) observations.push({ fact_key: 'property.last_sale_date', value_json: { value: saleDate }, raw_value: saleDate, confidence: 0.95 });

    if (!observations.length) return { ok: false, observations: [], reason: 'ATTOM response had no usable AVM/property fields' };
    return { ok: true, observations };
  } catch (e) {
    return { ok: false, observations: [], reason: (e && e.message) || 'parse error' };
  }
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'ATTOM_API_KEY not set' };
  return { ok: true, reason: 'ATTOM configured' };
}

/**
 * fetch(appId, ctx, deps?) → { ok, observations?, reason? }   (NEVER THROWS)
 * deps.fetchImpl lets tests inject a fake HTTP; production uses global fetch via
 * the guarded _http door.
 */
async function fetch(appId, ctx = {}, deps = {}) {
  try {
    const req = buildAvmRequest(cfg.attom, ctx);
    if (!req.ok) return { ok: false, reason: req.reason };
    const res = await http.requestJson(req.url, { method: 'GET', headers: req.headers, fetchImpl: deps.fetchImpl, label: 'attom-avm' });
    if (!res.ok) return { ok: false, reason: res.reason || `ATTOM http ${res.status}` };
    return parseAvmResponse(res.json);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'ATTOM fetch error' };
  }
}

module.exports = { configured, ping, fetch, kind: KIND, buildAvmRequest, parseAvmResponse, addressParts, _internals: { DEFAULT_ENDPOINT, AVM_PATH } };
