'use strict';
/**
 * Trinity Customer API v1.1 client — the ONE place PILOT talks to the physical
 * inspection company. Research + the verified probe log: docs/TRINITY-INSPECTION-API-RESEARCH.md.
 *
 * This is a SEPARATE pipeline from Sitewire (virtual) and TrustPoint (Blue Lake). It
 * requires nothing from either and neither requires anything from it — a file is only
 * ever live on ONE of the three (src/sitewire/routing.js).
 *
 * The discipline is the proven Sitewire/ClickUp one: a per-minute token bucket, capped
 * exponential backoff with jitter, a per-request timeout, retry only on transient
 * (429/5xx/network), and errors tagged e.status / e.retryable so the callers own the
 * long game. On top of that, three Trinity-specific rules learned by PROBING the live
 * sandbox, each of which is fatal if missed:
 *
 *   1. AUTH IS FORM-URLENCODED. A JSON body answers 415. The swagger does not say so.
 *   2. A DOCUMENT'S `data` MUST BE A FULL DATA URI ("data:application/pdf;base64,...").
 *      Raw base64 answers 400 — again, undocumented.
 *   3. `customerKey` IS AN EXACTLY-ONCE KEY. A reused one answers 409. That is a
 *      FEATURE, not a failure: it is what makes a lost response unable to create a
 *      duplicate order, so 409 is surfaced as e.conflict for the caller to resolve.
 *
 * Write safety: writes are gated behind TRINITY_OUTBOUND_ENABLED and a DRY-RUN that
 * logs the exact body and sends nothing. A non-idempotent POST is never retried in-call
 * (the first attempt may have committed before the response was lost) — it fails fast
 * and retryable, and the caller re-drives through the customerKey-guarded path.
 */

const cfg = require('../config');
const switches = require('../lib/integrations/switches');

const AUTH_PATH = '/api/v1.1/auth';
const P = '/api/v1.1';

const RPM        = Math.max(1, parseInt(process.env.TRINITY_MAX_RPM || '60', 10) || 60);
const MAX_TRIES  = Math.max(1, parseInt(process.env.TRINITY_MAX_TRIES || '3', 10) || 3);
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.TRINITY_TIMEOUT_MS || '30000', 10) || 30000);
const BASE_BACKOFF_MS = 500, MAX_BACKOFF_MS = 8000, RETRY_AFTER_MAX_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function base() { return (cfg.trinity && cfg.trinity.baseUrl) || 'https://api.trinityonline.com'; }
/** Credentials are present (nothing can be attempted without them). */
function available() { return !!(cfg.trinity && cfg.trinity.username && cfg.trinity.password); }
/** The master switch — reads + the poller. */
function enabled() { return switches.on('TRINITY_ENABLED'); }
/** The write gate — placing orders, sending documents, posting comments. */
function outboundEnabled() { return switches.on('TRINITY_OUTBOUND_ENABLED'); }
function dryrun() { return switches.on('TRINITY_DRYRUN'); }

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
function isRetryableStatus(s) { return s === 429 || (s >= 500 && s <= 599); }
// A 401 here is an expired/rotated token — recoverable by re-authenticating, which
// call() does once on its own. Beyond that it is an outage the caller should wait out
// rather than dead-letter, matching the Sitewire client's reading of the same codes.
function isOutageStatus(s) { return isRetryableStatus(s) || s === 401 || s === 408 || s === 425; }

function httpError(method, path, status, body, retryAfterSec) {
  const detail = body && (body.detail || body.title) ? ` — ${body.detail || body.title}` : '';
  const err = new Error(`Trinity ${method} ${path} -> ${status}${detail}`);
  err.status = status;
  err.retryable = isOutageStatus(status);
  // 409 is Trinity's exactly-once answer ("An order already exist with this
  // CustomerKey" / "An open order already exist..."). Never a retry — a resolution.
  err.conflict = status === 409;
  if (body !== undefined) err.body = body;
  if (retryAfterSec) err.retryAfter = retryAfterSec;
  return err;
}
function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, RETRY_AFTER_MAX_MS);
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return capped + Math.floor(Math.random() * 250);   // jitter: never a synchronized retry storm
}

// ---------------------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------------------
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

async function fetchWithTimeout(url, opts) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  // Read the body UNDER the same abort: a stalled half-open response body would
  // otherwise hang the poller's drain loop forever (the Sitewire client's lesson).
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    return { res, text };
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// auth — form-urlencoded, 2h token, cached
// ---------------------------------------------------------------------------
let _token = null, _tokenExp = 0;

async function authenticate(force = false) {
  if (!available()) {
    const e = new Error('TRINITY_USERNAME / TRINITY_PASSWORD are not set');
    e.code = 'TRINITY_NOT_CONFIGURED';
    throw e;
  }
  // Refresh at 80% of life so a long call never straddles an expiry.
  if (!force && _token && Date.now() < _tokenExp) return _token;
  const body = new URLSearchParams({
    username: cfg.trinity.username,
    password: cfg.trinity.password,
    grant_type: 'password',
  }).toString();
  await takeToken();
  const { res, text } = await fetchWithTimeout(base() + AUTH_PATH, {
    method: 'POST',
    // VERIFIED: JSON here answers 415. This content type is the contract.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = { detail: String(text).slice(0, 200) }; }
    throw httpError('POST', AUTH_PATH, res.status, parsed);
  }
  const json = JSON.parse(text);
  if (!json || !json.accessToken) throw new Error('Trinity auth returned no accessToken');
  _token = json.accessToken;
  const lifeMs = Math.max(60, Number(json.expiresIn) || 7200) * 1000;
  _tokenExp = Date.now() + lifeMs * 0.8;
  return _token;
}

/** Drop the cached token (used by the one-shot 401 retry and by the tests). */
function resetToken() { _token = null; _tokenExp = 0; }

// ---------------------------------------------------------------------------
// the one call path
// ---------------------------------------------------------------------------
async function call(path, { method = 'GET', body, noRetry = false, _reauthed = false } = {}) {
  const isWrite = method !== 'GET';

  // DRY-RUN wins over the write gate (checked first) so it is always safe to leave on
  // while verifying a payload against the real contract.
  if (isWrite && dryrun()) {
    console.warn(`[trinity][DRYRUN] would ${method} ${path} body=${body ? JSON.stringify(body).slice(0, 4000) : '(none)'}`);
    return { __dryrun: true };
  }
  // Defense in depth: every caller checks the gate too, but fail CLOSED here so a
  // future write path that forgets can never send a live write while outbound is off.
  if (isWrite && !outboundEnabled()) {
    const e = new Error(`TRINITY_OUTBOUND_DISABLED: refusing ${method} ${path} — Trinity writes are gated off`);
    e.code = 'TRINITY_OUTBOUND_DISABLED';
    throw e;
  }

  // A non-idempotent POST must NOT be retried in-call: the first attempt may have
  // COMMITTED before the response was lost, and a retry would ask Trinity to create a
  // second order. It fails fast + retryable; the caller re-drives through the
  // customerKey path, where a 409 identifies the order that already exists.
  const retryInCall = method !== 'POST' && !noRetry;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await takeToken();
    const token = await authenticate();
    let res, text;
    try {
      ({ res, text } = await fetchWithTimeout(base() + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: payload,
      }));
    } catch (e) {
      lastErr = e; lastErr.retryable = true;
      if (!retryInCall || attempt === MAX_TRIES) throw lastErr;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 204 || text === '') return null;

    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { detail: String(text).slice(0, 300) }; }

    if (res.ok) return parsed;

    // One free re-auth: a rotated/expired token is the ordinary cause of a 401 and it
    // is fixed by asking for a new one, not by waiting.
    if (res.status === 401 && !_reauthed) {
      resetToken();
      return call(path, { method, body, noRetry, _reauthed: true });
    }

    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10) || 0;
    const err = httpError(method, path, res.status, parsed, retryAfter);
    lastErr = err;
    if (!retryInCall || !isRetryableStatus(res.status) || attempt === MAX_TRIES) throw err;
    await sleep(backoffMs(attempt, retryAfter));
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// reference data
// ---------------------------------------------------------------------------
async function defaultCompany() { return call(`${P}/companies/default`); }
async function forms() { return call(`${P}/forms`); }
async function orderStatuses() { return call(`${P}/orders/statuses`); }
async function documentGroups() { return call(`${P}/documents/groups`); }

/** Our company id — configured, else resolved once and cached for the process. */
let _companyId = null;
async function companyId() {
  if (cfg.trinity && cfg.trinity.companyId) return cfg.trinity.companyId;
  if (_companyId) return _companyId;
  const c = await defaultCompany();
  if (!c || !c.id) throw new Error('Trinity returned no default company');
  _companyId = c.id;
  return _companyId;
}

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------
function formId() { return (cfg.trinity && cfg.trinity.formId) || 19; }

/** Create the project+order in one call. NEVER retried in-call (see call()). */
async function createOrder(payload) {
  return call(`${P}/forms/${formId()}/new`, { method: 'POST', body: payload });
}
async function getOrder(id) { return call(`${P}/orders/${encodeURIComponent(id)}`); }
async function getBudget(id) { return call(`${P}/forms/${formId()}/orders/${encodeURIComponent(id)}/budget`); }
async function getPhotos(id) { return call(`${P}/orders/${encodeURIComponent(id)}/photos`); }
async function getDocuments(id) { return call(`${P}/orders/${encodeURIComponent(id)}/documents`); }
/** The finished report. Answers 404 with detail "The report for this order is not ready." */
async function getReport(id) { return call(`${P}/orders/${encodeURIComponent(id)}/documents/report`); }
async function getProjectOrders(projectId) { return call(`${P}/projects/${encodeURIComponent(projectId)}/orders`); }

/**
 * Recover an order id from our exactly-once key — the answer to a 409 on create.
 * OData page size is capped at 100; we only ever expect one.
 */
async function findOrderByCustomerKey(key) {
  const q = `$filter=${encodeURIComponent(`customerKey eq '${String(key).replace(/'/g, "''")}'`)}&$top=2`;
  const rows = await call(`${P}/orders?${q}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function findProjectByNumber(projectNumber) {
  const q = `$filter=${encodeURIComponent(`projectNumber eq '${String(projectNumber).replace(/'/g, "''")}'`)}&$top=2`;
  const rows = await call(`${P}/projects?${q}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Ask for an order to be cancelled. VERIFIED: this returns 200 and the order stays in
 * its current status — it is a REQUEST, not an act. The caller records that we asked
 * and waits for the status to actually reach Canceled (14).
 */
async function requestCancel(id, actionBy) {
  return call(`${P}/orders/${encodeURIComponent(id)}/cancel`, { method: 'PUT', body: { actionBy } });
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------
/**
 * Attach a document. `data` MUST be a full data URI — raw base64 answers 400 with
 * "Data should be in URI format and must include mime type in base64" (verified).
 * `groupId` additionally validates the file EXTENSION, so the caller must pick a
 * filename the group accepts (a .csv into group 2 is refused; .xlsx is fine).
 */
async function addDocument(orderId, { buffer, base64, contentType, fileName, groupId, customerKey, uploader }) {
  const b64 = base64 != null ? String(base64) : Buffer.from(buffer).toString('base64');
  const data = `data:${contentType || 'application/octet-stream'};base64,${b64}`;
  return call(`${P}/orders/${encodeURIComponent(orderId)}/documents/json`, {
    method: 'POST',
    body: { data, fileName, groupId, customerKey: customerKey || undefined, uploader },
  });
}

// ---------------------------------------------------------------------------
// comments — the two-way message channel with the Trinity team
// ---------------------------------------------------------------------------
async function addComment(orderId, { content, important = false, visibleToVendor = true, commenter }) {
  return call(`${P}/orders/${encodeURIComponent(orderId)}/comments`, {
    method: 'POST',
    body: { content, important, visibleToVendor, commenter },
  });
}
async function getComments(orderId) { return call(`${P}/orders/${encodeURIComponent(orderId)}/comments`); }

// ---------------------------------------------------------------------------
// webhooks
// ---------------------------------------------------------------------------
async function subscribe(webhookUrl, eventTypes) {
  return call(`${P}/subscribe`, { method: 'POST', body: { webhookUrl, eventTypes: eventTypes || ['All'] } });
}
async function subscriptions() { return call(`${P}/subscriptions`); }
async function unsubscribe(id) { return call(`${P}/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

/** A cheap authenticated round trip for the API-health card. */
async function ping() {
  const c = await defaultCompany();
  return { ok: !!(c && c.id), company: c && c.name, companyId: c && c.id };
}

module.exports = {
  available, enabled, outboundEnabled, dryrun,
  authenticate, resetToken, call,
  defaultCompany, forms, orderStatuses, documentGroups, companyId, formId,
  createOrder, getOrder, getBudget, getPhotos, getDocuments, getReport, getProjectOrders,
  findOrderByCustomerKey, findProjectByNumber, requestCancel,
  addDocument, addComment, getComments,
  subscribe, subscriptions, unsubscribe, ping,
  _internals: { httpError, backoffMs, isOutageStatus, isRetryableStatus },
};
