'use strict';

/**
 * Xactus (Xactus360) credit-report HTTP adapter — MISMO 2.3.1 over HTTPS.
 *
 * Xactus is a B2B provider: access is per-client with an assigned API endpoint
 * (XACTUS_ENDPOINT) and a PER-USER login (LoginAccountIdentifier + password)
 * carried as HTTP Basic on each request. This module is ONLY the transport +
 * auth: it POSTs a request body built by ../credit/mismo2-request and hands the
 * raw response back to ../credit/mismo2-response to parse. It never builds or
 * parses XML itself, and it never touches the database.
 *
 * Billing/idempotency contract (critical): an order/reissue POST is BILLABLE and
 * NOT idempotent at the vendor. This adapter therefore NEVER retries a POST on
 * its own — a timeout or 5xx is surfaced to the caller as an error with enough
 * context to decide (a Reissue can be safely re-attempted because it re-pulls an
 * existing file; a brand-new Submit cannot). Retry policy lives in the caller,
 * not here.
 *
 * Auth: HTTP Basic (operatorIdentifier:secret). Some Xactus deployments also
 * accept the login as URL/query params; Basic is the documented default and the
 * only form used here.
 */
const cfg = require('../../config').xactus;

const MISMO_CONTENT_TYPE = 'text/xml; charset=utf-8';

/** Is the platform-level endpoint configured? (Per-user login is separate.) */
function configured() { return !!cfg.endpoint; }

function basicAuth(operatorIdentifier, secret) {
  return 'Basic ' + Buffer.from(`${operatorIdentifier}:${secret}`).toString('base64');
}

class XactusError extends Error {
  constructor(message, { kind, httpStatus, body, retriable, retryAfterMs } = {}) {
    super(message);
    this.name = 'XactusError';
    this.kind = kind || 'error';         // 'network'|'timeout'|'http'|'auth'|'rate_limit'|'empty'|'config'
    this.httpStatus = httpStatus || null;
    this.body = body || null;            // raw response text (may be XML with an error layer)
    this.retriable = !!retriable;        // network/timeout/rate_limit/5xx; caller still decides given the action
    this.retryAfterMs = retryAfterMs != null ? retryAfterMs : null;  // honored Retry-After (ms), when the vendor sent one
  }
}

/**
 * Parse an HTTP Retry-After header into milliseconds. Accepts delta-seconds
 * ("120") or an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns null when
 * absent/unparseable, 0 for a past date, and caps at 1 hour so a bogus far-future
 * value can't wedge the breaker open.
 */
function parseRetryAfter(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const CAP = 3600 * 1000;
  if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10) * 1000, CAP);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const d = t - Date.now(); return d > 0 ? Math.min(d, CAP) : 0; }
  return null;
}

/**
 * POST a prebuilt MISMO request body to Xactus under the given credential.
 *
 * @param {object} o
 *   requestXml         (string, required)  — body from buildCreditRequest()
 *   operatorIdentifier (string, required)  — the acting user's LoginAccountIdentifier
 *   secret             (string, required)  — the acting user's password (plaintext, in-memory only)
 *   endpoint           (string)            — override the configured base URL (tests)
 *   path               (string)            — request path appended to endpoint (default '')
 *   timeoutMs          (number)            — network budget (default cfg.timeoutMs)
 *   transport          (function)          — injectable fetch (tests); defaults to global fetch
 * @returns {Promise<{ httpStatus:number, contentType:string, body:string }>}
 * @throws  {XactusError} on config/network/timeout/http-level failure. A 200 with
 *          an in-XML error layer is NOT thrown here — the parser surfaces it.
 */
async function orderReport(o = {}) {
  const endpoint = (o.endpoint != null ? o.endpoint : cfg.endpoint);
  if (!endpoint) throw new XactusError('Xactus endpoint is not configured (set XACTUS_ENDPOINT)', { kind: 'config' });
  if (!o.requestXml || typeof o.requestXml !== 'string') throw new XactusError('orderReport: requestXml required', { kind: 'config' });
  if (!o.operatorIdentifier) throw new XactusError('orderReport: operatorIdentifier required', { kind: 'config' });
  if (o.secret == null || o.secret === '') throw new XactusError('orderReport: secret required', { kind: 'config' });

  const url = String(endpoint).replace(/\/+$/, '') + (o.path || '');
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : cfg.timeoutMs;
  const doFetch = o.transport || fetch;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try {
    r = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(o.operatorIdentifier, o.secret),
        'Content-Type': MISMO_CONTENT_TYPE,
        Accept: MISMO_CONTENT_TYPE,
      },
      body: o.requestXml,
      signal: ac.signal,
    });
  } catch (e) {
    // AbortError => our timeout; anything else => a transport failure. Both are
    // "we don't know if the vendor processed it" — mark retriable so the caller
    // can decide per action, but NEVER auto-retry a billable POST here.
    const isAbort = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
    throw new XactusError(
      isAbort ? `Xactus request timed out after ${timeoutMs}ms` : `Xactus request failed: ${e.message}`,
      { kind: isAbort ? 'timeout' : 'network', retriable: true });
  } finally {
    clearTimeout(timer);
  }

  const contentType = (r.headers && typeof r.headers.get === 'function' && r.headers.get('content-type')) || '';
  let body = '';
  try { body = await r.text(); } catch (_) { body = ''; }

  // An HTTP 401/403 is an authentication/authorization failure at the transport
  // (bad login), distinct from a valid-login-but-data-error which returns 200
  // with an in-XML error. Surface auth explicitly so the caller can flag the
  // credential invalid instead of blaming the borrower's data.
  const retryAfterMs = parseRetryAfter(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null);
  if (r.status === 401 || r.status === 403) {
    throw new XactusError(`Xactus authentication failed (HTTP ${r.status})`, { kind: 'auth', httpStatus: r.status, body });
  }
  // 429 = rate-limited: the vendor REJECTED the request (nothing billed) and asks
  // us to back off. Retriable, and carries Retry-After so the caller can wait the
  // requested time instead of hammering. It is NOT a generic 4xx (must be caught
  // before the >=400 bucket, which would mark it non-retriable).
  if (r.status === 429) {
    throw new XactusError('Xactus rate-limited the request (HTTP 429) — not billed; retry later.', { kind: 'rate_limit', httpStatus: 429, body, retriable: true, retryAfterMs });
  }
  if (r.status >= 500) {
    throw new XactusError(`Xactus server error (HTTP ${r.status})`, { kind: 'http', httpStatus: r.status, body, retriable: true, retryAfterMs });
  }
  if (r.status >= 400) {
    throw new XactusError(`Xactus rejected the request (HTTP ${r.status})`, { kind: 'http', httpStatus: r.status, body });
  }
  if (!body || !body.trim()) {
    throw new XactusError('Xactus returned an empty response body', { kind: 'empty', httpStatus: r.status });
  }
  return { httpStatus: r.status, contentType, body };
}

/**
 * Lightweight credential check for verify-on-save. Because a real order is
 * billable, this does NOT place an order: it can only confirm the endpoint
 * ACCEPTS the login (does not answer 401/403). When the platform exposes a
 * dedicated no-charge auth/echo path, point `verifyPath` at it. With no probe
 * path and no configured endpoint, it returns { ok:null } (format-valid but
 * unverified) so saving still works before go-live.
 *
 * @returns {Promise<{ ok:boolean|null, status:('ok'|'invalid'|'unverified'), message:string, httpStatus?:number }>}
 */
async function verifyCredential(o = {}) {
  if (!o.operatorIdentifier || o.secret == null || o.secret === '') {
    return { ok: false, status: 'invalid', message: 'Missing login identifier or password.' };
  }
  const endpoint = (o.endpoint != null ? o.endpoint : cfg.endpoint);
  const verifyPath = o.verifyPath || cfg.verifyPath || '';
  if (!endpoint || !verifyPath) {
    // Cannot probe without a no-charge endpoint; treat as saved-but-unverified.
    return { ok: null, status: 'unverified', message: 'Saved. Credential will be verified on first use.' };
  }
  const url = String(endpoint).replace(/\/+$/, '') + verifyPath;
  const doFetch = o.transport || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 15000);
  try {
    const r = await doFetch(url, {
      method: o.verifyMethod || 'GET',
      headers: { Authorization: basicAuth(o.operatorIdentifier, o.secret), Accept: MISMO_CONTENT_TYPE },
      signal: ac.signal,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: 'The login was rejected by Xactus.', httpStatus: r.status };
    if (r.status === 429) return { ok: null, status: 'unverified', message: 'Xactus was rate-limited; credential saved unverified.', httpStatus: r.status };
    if (r.status >= 500) return { ok: null, status: 'unverified', message: 'Xactus was unreachable; credential saved unverified.', httpStatus: r.status };
    return { ok: true, status: 'ok', message: 'Login verified with Xactus.', httpStatus: r.status };
  } catch (e) {
    return { ok: null, status: 'unverified', message: 'Xactus was unreachable; credential saved unverified.' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { name: 'xactus', configured, orderReport, verifyCredential, basicAuth, parseRetryAfter, XactusError, MISMO_CONTENT_TYPE };
