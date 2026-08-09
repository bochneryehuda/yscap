'use strict';
/**
 * CDG (CoreLogic Digital Gateway / AppraisalScope) transport client.
 *
 * Ports the proven Sitewire/ClickUp client discipline: a per-minute token bucket,
 * capped exponential backoff + jitter, a per-request timeout that stays armed across
 * the body read, retry-only-on-transient (429/5xx/network), and errors tagged
 * e.status / e.retryable so a durable poller owns the long game.
 *
 * Two-step auth (CDG "pull" integration): GetToken (OAuth2 client_credentials, Basic
 * auth) → a Bearer access token, cached in-memory with single-flight; then DoLogin →
 * an AppraisalScope api_key that the CALLER embeds in every message body (built by
 * src/amc/cdg.js). This module only carries the Bearer token + posts the JSON.
 *
 * Write safety: AMC_DRYRUN logs the exact body and sends nothing; the AMC_OUTBOUND_ENABLED
 * gate is enforced fail-closed here so a future write path that forgets the check can
 * never send a live write while outbound is off. Nothing talks to the AMC while the
 * master switch AMC_ENABLED is off.
 *
 * All credentials come from src/config.js (Render env only). This module is inert until
 * the feature is wired into a route/worker and switched on.
 */
const cfg = require('../config');
const switches = require('../lib/integrations/switches');

const AMC = () => cfg.amc || {};
const RPM = Math.max(1, parseInt(process.env.AMC_MAX_RPM || '60', 10) || 60);
const MAX_TRIES = Math.max(1, parseInt(process.env.AMC_MAX_TRIES || '3', 10) || 3);
// CDG's own timeout is 90s; keep ours at the same ceiling.
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.AMC_TIMEOUT_MS || '90000', 10) || 90000);
const BASE_BACKOFF_MS = 500, MAX_BACKOFF_MS = 8000, RETRY_AFTER_MAX_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configured() {
  const a = AMC();
  const hasOauth = !!(a.clientId && a.clientSecret);
  const hasLogin = !!(a.loginAccount && a.loginPassword);
  return {
    enabled: switches.on('AMC_ENABLED'),
    outbound: switches.on('AMC_OUTBOUND_ENABLED'),
    dryrun: switches.on('AMC_DRYRUN'),
    hasOauth, hasLogin,
    hasSubdomain: !!a.subdomain,
    ready: !!(a.subdomain && (hasOauth || a.fallbackApiKey) && (hasLogin || a.fallbackApiKey)),
  };
}

// ---- retry classification ----
function isRetryableStatus(s) { return s === 429 || (s >= 500 && s <= 599); }
function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, RETRY_AFTER_MAX_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}
function httpError(label, status, retryAfterSec, body) {
  const err = new Error(`AMC ${label} -> ${status}`);
  err.status = status;
  err.retryable = isRetryableStatus(status) || status === 408;
  if (retryAfterSec) err.retryAfter = retryAfterSec;
  if (body !== undefined) err.body = body;
  return err;
}

let _tokens = RPM, _lastRefill = Date.now();
async function takeToken() {
  for (;;) {
    const now = Date.now();
    _tokens = Math.min(RPM, _tokens + ((now - _lastRefill) / 60000) * RPM);
    _lastRefill = now;
    if (_tokens >= 1) { _tokens -= 1; return; }
    await sleep(Math.ceil((1 - _tokens) * (60000 / RPM)));
  }
}
async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  } finally { clearTimeout(timer); }
}

// ---- OAuth access token (Bearer), cached + single-flight ----
let _tok = { value: null, exp: 0 };
let _tokInflight = null;
async function getAccessToken() {
  const a = AMC();
  if (!a.clientId || !a.clientSecret) {
    // No OAuth creds: a lower-env fallback api key may be configured instead.
    if (a.fallbackApiKey) return null;
    throw new Error('AMC_CLIENT_ID / AMC_CLIENT_SECRET are not set');
  }
  const now = Date.now();
  if (_tok.value && now < _tok.exp) return _tok.value;
  if (_tokInflight) return _tokInflight;
  _tokInflight = (async () => {
    const basic = Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64');
    await takeToken();
    const { res, buf } = await fetchWithTimeout(a.oauthUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
    }, TIMEOUT_MS);
    const text = buf.toString('utf8');
    // Keep a non-JSON body as `raw` (same as post() does): an intermediary that rejects
    // the call — a corporate proxy, an egress allowlist — answers text/plain, and that
    // sentence is the difference between "your secret is wrong" and "your firewall is".
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
    if (!res.ok) throw httpError('GetToken', res.status, undefined, data);
    const token = data.accessToken || data.access_token;
    if (!token) throw new Error('AMC GetToken returned no accessToken');
    const ttl = Number(data.expiresIn || data.expires_in || 3600);
    _tok = { value: token, exp: Date.now() + Math.max(30, ttl - 60) * 1000 };
    return token;
  })().finally(() => { _tokInflight = null; });
  return _tokInflight;
}
function invalidateToken() { _tok = { value: null, exp: 0 }; }

// ---- headers ----
async function authHeaders(extra) {
  const a = AMC();
  const h = { Accept: 'application/json', ...(extra || {}) };
  const token = await getAccessToken();
  if (token) h.Authorization = `Bearer ${token}`;
  else if (a.fallbackApiKey) h.apikey = a.fallbackApiKey;   // UAT-only fallback
  return h;
}

// ---- POST a CDG message (lookup / create / update / order-lookup) ----
// opts: { orderId, write, label }. `write` gates outbound + dry-run.
async function post(baseUrl, message, opts = {}) {
  const { orderId, write, label } = opts;
  if (!switches.on('AMC_ENABLED')) {
    const e = new Error('AMC_DISABLED: the AMC integration master switch is off');
    e.code = 'AMC_DISABLED'; throw e;
  }
  // `opts.dryrun` is the CALLER'S already-made decision, and it can only ever force a
  // dry run — never cancel one. A caller that builds its message differently for a dry
  // run (order-service builds it with no api key, because a test run must not need a
  // login) has to be sure the message it built is the one this gate judges: the switch
  // is an in-memory flag refreshed on a timer, so reading it a second time here could
  // legitimately disagree with the first read and post an UNAUTHENTICATED live order
  // carrying real borrower details. Decided once, passed down, and still re-checked.
  if (write && (opts.dryrun === true || switches.on('AMC_DRYRUN'))) {
    console.warn(`[amc][DRYRUN] would POST ${label || 'action'} body=${JSON.stringify(cdgMaskSafe(message))}`);
    return { __dryrun: true };
  }
  if (write && !switches.on('AMC_OUTBOUND_ENABLED')) {
    const e = new Error(`AMC_OUTBOUND_DISABLED: refusing ${label || 'write'} — writes are gated off`);
    e.code = 'AMC_OUTBOUND_DISABLED'; throw e;
  }
  const url = orderId ? `${baseUrl}?orderId=${encodeURIComponent(orderId)}` : baseUrl;
  const payload = JSON.stringify(message);
  let refreshedOn401 = false;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await takeToken();
    let res, buf;
    try {
      const headers = await authHeaders({ 'Content-Type': 'application/json' });
      ({ res, buf } = await fetchWithTimeout(url, { method: 'POST', headers, body: payload }, TIMEOUT_MS));
    } catch (netErr) {
      netErr.retryable = true; lastErr = netErr;
      if (attempt < MAX_TRIES) { await sleep(backoffMs(attempt) + Math.floor(Math.random() * 250)); continue; }
      throw netErr;
    }
    // A 401 usually means the Bearer token expired/rotated — refresh once and retry.
    if (res.status === 401 && !refreshedOn401) { refreshedOn401 = true; invalidateToken(); continue; }
    if (isRetryableStatus(res.status) && attempt < MAX_TRIES) {
      const ra = parseInt(res.headers.get('retry-after') || '0', 10);
      await sleep(backoffMs(attempt, ra) + Math.floor(Math.random() * 250));
      continue;
    }
    const text = buf.toString('utf8');
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw httpError(label || 'POST', res.status, parseInt(res.headers.get('retry-after') || '0', 10) || undefined, data);
    return data;
  }
  throw lastErr || new Error(`AMC ${label || 'POST'} failed after ${MAX_TRIES} attempts`);
}

// A READ (lookup / order-lookup / status / documents) — hits the order endpoint,
// never gated by the write gate.
function read(message, opts = {}) { return post(AMC().orderUrl, message, { ...opts, write: false }); }
// A WRITE (create / addform / comment / revision / upload) — gated by AMC_OUTBOUND_ENABLED.
function write(message, opts = {}) { return post(AMC().orderUrl, message, { ...opts, write: true }); }
// DoLogin hits the "direct" endpoint; it's a read (returns the api key), master-gated only.
function login(message, opts = {}) { return post(AMC().loginUrl, message, { ...opts, write: false }); }

// ---- document upload (multipart) → getdocument retrieval URLs ----
// files: [{ fileName, contentType, bytes(Buffer) }]. Returns
// [{ name, fileName, uploadStatus, retrievalUrl, errorTraceID }].
async function postDocuments(files) {
  if (!switches.on('AMC_ENABLED')) { const e = new Error('AMC_DISABLED'); e.code = 'AMC_DISABLED'; throw e; }
  if (switches.on('AMC_DRYRUN')) {
    console.warn(`[amc][DRYRUN] would upload ${files.length} document(s) to /postdocuments`);
    return files.map((f, i) => ({ name: `part${i}`, fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: `dryrun://getdocument/${i}`, errorTraceID: null }));
  }
  if (!switches.on('AMC_OUTBOUND_ENABLED')) { const e = new Error('AMC_OUTBOUND_DISABLED'); e.code = 'AMC_OUTBOUND_DISABLED'; throw e; }
  const form = new FormData();
  files.forEach((f, i) => {
    const blob = new Blob([f.bytes], { type: f.contentType || 'application/octet-stream' });
    form.append(`part${i}`, blob, f.fileName || `file${i}`);
  });
  await takeToken();
  const headers = await authHeaders();   // multipart boundary set by fetch from FormData
  const { res, buf } = await fetchWithTimeout(AMC().postDocumentsUrl, { method: 'POST', headers, body: form }, TIMEOUT_MS);
  const text = buf.toString('utf8');
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw httpError('postdocuments', res.status, undefined, data);
  return Array.isArray(data.documents) ? data.documents : [];
}

// ---- document retrieval (bytes) ----
async function getDocument(url) {
  if (!switches.on('AMC_ENABLED')) { const e = new Error('AMC_DISABLED'); e.code = 'AMC_DISABLED'; throw e; }
  await takeToken();
  const headers = await authHeaders();
  const { res, buf } = await fetchWithTimeout(url, { method: 'GET', headers }, TIMEOUT_MS);
  if (!res.ok) throw httpError('getdocument', res.status);
  return { bytes: buf, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

// A shallow api-key mask for the dry-run log (full masking lives in cdg.maskRequest).
function cdgMaskSafe(message) {
  try {
    const refs = message && message.message && message.message.clientSystem && message.message.clientSystem.referenceIdentifiers;
    if (Array.isArray(refs)) {
      return { ...message, message: { ...message.message, clientSystem: { ...message.message.clientSystem,
        referenceIdentifiers: refs.map((r) => (r && r.referenceIdentifierType === 'ApiKey' ? { ...r, referenceIdentifierValue: '***' } : r)) } } };
    }
  } catch { /* fall through */ }
  return message;
}

module.exports = {
  configured, read, write, login,
  getAccessToken, invalidateToken,
  postDocuments, getDocument,
};
