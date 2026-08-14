'use strict';
/**
 * Richer Values Order Intake API — the guarded transport.
 *
 * ONE way in and out, so every safety property is enforced in a single place: the
 * three switches, the dry-run, the write gate, the token lifecycle, the timeout,
 * the retry rule and the masking. No route may call `fetch` directly.
 *
 * WHAT THIS VENDOR IS. Their "Order Intake API" sells EVALUATIONS, not URAR
 * appraisals — the product we order is `reno-arv` ("Renovation Analysis"), which
 * returns an As-Is value together with an After Repair Value. It is cheaper than a
 * full appraisal and it does NOT produce a MISMO XML data file, which is why the
 * ordering desk records the file's "no appraisal XML" waiver automatically (see
 * src/richervalues/order-service.js and db/548).
 *
 * AUTH IS EITHER A TOKEN OR A LOGIN, AND THE LOGIN GIVES MORE. The vendor issues a
 * long-lived bearer token, and also a create-token endpoint that mints one from a
 * username + password. We accept both because they are not equivalent: the
 * create-token REPLY also names the COMPANY token and the API user's own token,
 * which almost every other call needs and which a raw bearer cannot tell us. So a
 * deployment configured with only a login resolves everything by itself, while one
 * configured with only a token must also be given `RV_COMPANY_TOKEN`.
 *
 * THEIR ENVELOPE LIES ABOUT HTTP. Every reply is `{success, message, data, meta,
 * errors}` and a REFUSAL can arrive as an HTTP 200 carrying `success:false` (their
 * validation failures do exactly this, with the offending fields listed in
 * `errors[]`). So a 2xx is never on its own proof the thing worked — `request()`
 * inspects the envelope, and lifts `errors[]` onto the thrown error so the desk can
 * name the field the vendor refused instead of showing "something went wrong".
 *
 * A NON-JSON BODY IS KEPT — the lesson the AMC integration paid for. A corporate
 * proxy or an egress allowlist refuses with an HTTP status that looks exactly like
 * a credential rejection, and its explanation is plain text. Throw that body away
 * and "your network blocked this" is indistinguishable from "your token is wrong",
 * and the expensive mistake is re-issuing a perfectly good credential.
 *
 * WHAT THE WRITE GATE MEANS HERE. `RV_OUTBOUND_ENABLED` guards a real order being
 * PLACED — money, and an inspector dispatched to someone's property. Reads (the
 * catalogue, pricing, an order's status, its finished report) are gated only by the
 * master switch, exactly as on the other two desks, so a preflight or a price check
 * can run with ordering still switched off.
 */

const cfg = require('../config');
const switches = require('../lib/integrations/switches');

const MAX_TRIES = 3;
const BASE_BACKOFF_MS = 500;
const TOKEN_SKEW_SEC = 300;          // renew well before expiry rather than race it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RV = () => cfg.richerValue || {};

// ---------------------------------------------------------------------------
// Hosts. ONE table, every value overridable. Both were read off the vendor's own
// documentation ("Base URL": production and sandbox/training).
// ---------------------------------------------------------------------------
const HOSTS = {
  production: 'https://intake.richervalues.com',
  training:   'https://training-intake.richervalues.com',
};

function baseUrl() {
  const c = RV();
  if (c.baseUrl) return c.baseUrl;
  return HOSTS[c.environment] || HOSTS.training;
}

function hosts() {
  const c = RV();
  const env = HOSTS[c.environment] ? c.environment : 'training';
  return {
    environment: env,
    baseUrl: baseUrl(),
    // An env override counts as chosen by the operator; otherwise it is the
    // vendor's own documented host for that environment.
    overridden: !!c.baseUrl,
  };
}

// ---------------------------------------------------------------------------
// Configuration report — booleans only, never a credential value.
// ---------------------------------------------------------------------------
function configured() {
  const c = RV();
  const hasToken = !!c.apiToken;
  const hasLogin = !!(c.username && c.password);
  return {
    enabled: switches.on('RV_ENABLED'),
    outbound: switches.on('RV_OUTBOUND_ENABLED'),
    dryrun: switches.on('RV_DRYRUN'),
    hasToken,
    hasLogin,
    // Either credential form is enough to talk to them at all.
    ready: hasToken || hasLogin,
    // …but a raw token alone cannot tell us WHICH company to order for, so a
    // deployment with only a token must also carry RV_COMPANY_TOKEN. Reported
    // separately so a preflight can say exactly what is missing.
    hasCompanyToken: !!c.companyToken,
    // A RAW TOKEN SHORT-CIRCUITS THE LOGIN (getAccessToken returns c.apiToken
    // before it ever signs in), so with RV_API_TOKEN set nothing can DERIVE a
    // company token or a loan-officer token — even when a username/password is
    // also configured. Reporting orderReady off `hasLogin` alone therefore said
    // "ready to order" on a deployment whose every order would fail for want of
    // a company token. Identity is derivable ONLY on the login-alone path.
    orderReady: (hasToken || hasLogin) && !!(c.companyToken || (hasLogin && !hasToken)),
    environment: hosts().environment,
    baseUrl: baseUrl(),
    // The webhook half is independent: ordering works without it, but nothing will
    // tell us the order progressed except the poller.
    webhookReady: !!(c.webhookUrl && ((c.webhookUser && c.webhookPassword) || c.webhookToken)),
    autoApplyValues: c.autoApplyValues !== false,
    paymentMethod: c.paymentMethod || 'CARD_ON_FILE',
    defaults: {
      reportType: c.defaultReportType || 'reno-arv',
      inspectionType: c.defaultInspectionType || 'interior-w-exterior',
      turnaroundTime: c.defaultTurnaround || 'standard',
      glaInclude: c.defaultGlaInclude !== false,
      licensingRequired: !!c.defaultLicensing,
      includeFloodCertification: !!c.defaultFloodCert,
    },
  };
}

// ---------------------------------------------------------------------------
// Errors. `retryable` decides the retry; `body` is ALWAYS carried so a caller can
// tell a firewall's plain-text refusal from the vendor's own JSON rejection, and
// `fieldErrors` carries their per-field validation list so a desk can say WHICH
// field they refused rather than "data validation failed".
// ---------------------------------------------------------------------------
function httpError(label, status, body, retryAfterSec) {
  const e = new Error(`Richer Values ${label} failed: HTTP ${status}`);
  e.status = status;
  e.body = body;
  e.fieldErrors = fieldErrorsOf(body);
  e.retryable = status === 429 || (status >= 500 && status <= 599);
  if (retryAfterSec) e.retryAfterSec = retryAfterSec;
  return e;
}
function gateError(code, message) { const e = new Error(`${code}: ${message}`); e.code = code; return e; }

/**
 * Their validation failures arrive as `errors: [{message, key, label, value}]`.
 * Normalized to `{field, message}` and NEVER carrying `value` — a rejected field
 * can be an email or a phone number, and this list is shown on a screen and stored
 * in the write journal.
 */
function fieldErrorsOf(body) {
  const list = body && Array.isArray(body.errors) ? body.errors : [];
  const out = [];
  for (const e of list) {
    if (!e) continue;
    if (typeof e === 'string') { out.push({ field: null, message: e }); continue; }
    const field = e.key || e.child || e.label || null;
    const message = e.message || e.msg || null;
    if (field || message) out.push({ field: field ? String(field) : null, message: message ? String(message) : null });
  }
  return out;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  } finally { clearTimeout(t); }
}

// Parse a body WITHOUT ever discarding it. A non-JSON reply is kept verbatim under
// `raw` — see the header; this is the whole point.
function readBody(buf) {
  const text = buf.toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 800) }; }
}

// ---------------------------------------------------------------------------
// Token. A configured raw token is used as-is. A configured login is exchanged
// once and cached in-process; a 401 invalidates it once.
// ---------------------------------------------------------------------------
let _token = null;          // { value, expiresAtMs, company, user }
let _inFlight = null;       // single-flight, so a burst mints one token

function invalidateToken() { _token = null; }

/**
 * The identity the vendor hands back with a minted token: the company we order for
 * and the API user's own token (which doubles as a loan-officer token). Only ever
 * populated by the login path — a raw bearer token cannot tell us either.
 */
function mintedIdentity() {
  return _token ? { company: _token.company || null, user: _token.user || null } : { company: null, user: null };
}

async function getAccessToken() {
  if (!switches.on('RV_ENABLED')) throw gateError('RV_DISABLED', 'the Richer Values integration master switch is off');
  const c = RV();
  if (c.apiToken) return c.apiToken;
  if (!c.username || !c.password) {
    throw gateError('RV_NOT_CONFIGURED',
      'set RV_API_TOKEN, or RV_USERNAME + RV_PASSWORD so a token can be created');
  }
  if (_token && _token.expiresAtMs - TOKEN_SKEW_SEC * 1000 > Date.now()) return _token.value;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    const url = `${baseUrl()}/api/v1/auth/create-token`;
    const { res, buf } = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: c.username, password: c.password }),
    }, c.timeoutMs);
    const data = readBody(buf);
    if (!res.ok || data.success === false) throw httpError('create-token', res.status, data);
    const tok = data && data.data && data.data.token;
    if (!tok) throw httpError('create-token', res.status, data);   // 200 with no token is still a failure
    // Their token carries no documented expiry, so it is cached for an hour and
    // re-minted rather than held forever — a rotated credential must not need a
    // redeploy to take effect.
    _token = {
      value: tok,
      expiresAtMs: Date.now() + 3600 * 1000,
      company: (data.data.company && data.data.company.token) || null,
      user: (data.data.user && data.data.user.token) || null,
    };
    return tok;
  })().finally(() => { _inFlight = null; });

  return _inFlight;
}

/**
 * WHICH COMPANY WE ORDER FOR. Configuration wins (an operator naming a company is
 * always deliberate); otherwise the one the minted token named. Returns null when
 * neither is available, and every caller treats that as "not configured" rather
 * than guessing — an order placed against the wrong company is not recoverable.
 */
async function companyToken() {
  const c = RV();
  if (c.companyToken) return c.companyToken;
  if (c.username && c.password) {
    try { await getAccessToken(); } catch (_) { return null; }
    return mintedIdentity().company;
  }
  return null;
}

/**
 * The vendor user an order is placed by — their REQUIRED `loan_officer_token`.
 * Configuration wins; otherwise the API user's own token from the minted reply
 * (the API user IS a loan officer on their side, confirmed against the live
 * training tenant). A caller may pass a preferred token, which always wins.
 */
async function loanOfficerToken(preferred) {
  if (preferred) return preferred;
  const c = RV();
  if (c.loanOfficerToken) return c.loanOfficerToken;
  if (c.username && c.password) {
    try { await getAccessToken(); } catch (_) { return null; }
    return mintedIdentity().user;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The one request path.
//   opts.write  — this call CHANGES something at Richer Values. Gated by
//                 RV_OUTBOUND_ENABLED and short-circuited by RV_DRYRUN.
//   opts.form   — a plain object sent as multipart/form-data (their order intake
//                 is multipart even when it carries no file).
//   opts.label  — what to call it in an error.
// ---------------------------------------------------------------------------
async function request(method, path, { body, form, query, write, label } = {}) {
  if (!switches.on('RV_ENABLED')) throw gateError('RV_DISABLED', 'the Richer Values integration master switch is off');

  // Dry-run is checked BEFORE the write gate, so it is always safe to leave on
  // while verifying — exactly the AMC and Class ordering.
  if (write && switches.on('RV_DRYRUN')) {
    console.warn(`[rv][DRYRUN] would ${method} ${path} ${JSON.stringify(maskSafe(form || body))}`);
    return { __dryrun: true };
  }
  if (write && !switches.on('RV_OUTBOUND_ENABLED')) {
    throw gateError('RV_OUTBOUND_DISABLED', `refusing ${label || method + ' ' + path} — writes are gated off`);
  }

  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString()
    : '';
  const url = `${baseUrl()}${path.startsWith('/') ? path : '/' + path}${qs}`;

  let refreshed = false;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res, buf;
    try {
      const token = await getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let payload;
      if (form) {
        // Node's own FormData/Blob (18+) — no new dependency, matching the
        // repo's no-native-deps rule. The boundary header is set by fetch.
        payload = toFormData(form);
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      ({ res, buf } = await fetchWithTimeout(url, { method, headers, body: payload }, RV().timeoutMs));
    } catch (netErr) {
      netErr.retryable = true; lastErr = netErr;
      if (attempt < MAX_TRIES) { await sleep(backoff(attempt)); continue; }
      throw netErr;
    }

    // A 401 means the cached token has been rotated or revoked — refresh once,
    // then treat a second 401 as a real rejection. A CONFIGURED raw token cannot
    // be refreshed, so retrying it would only burn attempts.
    if (res.status === 401 && !refreshed && !RV().apiToken) { refreshed = true; invalidateToken(); continue; }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
      const ra = parseInt(res.headers.get('retry-after') || '0', 10);
      await sleep(backoff(attempt, ra));
      continue;
    }

    const data = readBody(buf);
    if (!res.ok) throw httpError(label || `${method} ${path}`, res.status, data,
      parseInt(res.headers.get('retry-after') || '0', 10) || undefined);

    // Their envelope carries `success:false` WITH an HTTP 200 on a validation
    // failure, so a 2xx is not on its own proof the thing worked.
    if (data && data.success === false) {
      const e = new Error(`Richer Values ${label || path} refused: ${data.message || 'no message'}`);
      e.status = res.status; e.body = data; e.fieldErrors = fieldErrorsOf(data); e.retryable = false;
      throw e;
    }
    return data;
  }
  throw lastErr || new Error(`Richer Values ${label || path} failed after ${MAX_TRIES} attempts`);
}

/**
 * Build a multipart body from a FLAT object. Their intake takes bracketed array
 * keys verbatim (`property_access_contacts[0][name]`), so the builder is the thing
 * that flattens — this only serializes. A `{filename, contentType, bytes}` value is
 * sent as a file part; everything else is stringified. `null`/`undefined`/`''` are
 * DROPPED rather than sent as empty strings, because their validator refuses a
 * field that is forbidden for the chosen branch and an empty string still counts
 * as sending it.
 */
function toFormData(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      // A repeated field (their `appraisal_documents` shape). Each item is either
      // a file part or a scalar.
      for (const item of v) appendOne(fd, k, item);
      continue;
    }
    appendOne(fd, k, v);
  }
  return fd;
}

function appendOne(fd, key, v) {
  if (v == null || v === '') return;
  if (v && typeof v === 'object' && v.bytes) {
    const blob = new Blob([v.bytes], { type: v.contentType || 'application/octet-stream' });
    fd.append(key, blob, v.filename || 'file');
    return;
  }
  if (typeof v === 'boolean') { fd.append(key, v ? '1' : '0'); return; }
  fd.append(key, String(v));
}

function backoff(attempt, retryAfterSec) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 60000);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
}

// Mask anything that looks like a secret before it reaches a log line or the write
// journal. Deliberately about CREDENTIALS, not PII — a dry-run log is a staff-only
// diagnostic and the loan file's own data is exactly what the operator is checking.
const SECRET_KEYS = /^(password|api_?token|access_?token|authorization|token|company_token|loan_officer_token|payment_source_id|card_number|cvv|routing_number|bank_account_number)$/i;
function maskSafe(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(maskSafe);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (SECRET_KEYS.test(k)) { out[k] = '***'; continue; }
    if (val && typeof val === 'object' && val.bytes) { out[k] = { filename: val.filename || null, bytes: val.bytes.length }; continue; }
    out[k] = maskSafe(val);
  }
  return out;
}

// ---- the documented surface, each a thin named call -----------------------
const get = (path, query, label) => request('GET', path, { query, label });

module.exports = {
  configured, hosts, invalidateToken, getAccessToken, mintedIdentity,
  companyToken, loanOfficerToken, request, get, maskSafe, fieldErrorsOf,

  // ---- READS (master switch only) ----
  health:          () => get('/', undefined, 'health'),
  listCompanies:   () => get('/api/v1/company/list', undefined, 'listCompanies'),
  getCompany:      (ct) => get(`/api/v1/company/${encodeURIComponent(ct)}/get`, undefined, 'getCompany'),
  billingEmails:   (ct) => get(`/api/v1/company/${encodeURIComponent(ct)}/billing-receipt-emails`, undefined, 'billingEmails'),
  paymentSources:  (ct) => get('/api/v1/company/payment-sources', { company_token: ct }, 'paymentSources'),
  loanOfficers:    (ct) => get('/api/v1/user/loan-officers', { company_token: ct }, 'loanOfficers'),
  allUsers:        (ct) => get('/api/v1/user/all', { company_token: ct }, 'allUsers'),
  reportTypes:     (ct) => get('/api/v1/report-types', { company_token: ct }, 'reportTypes'),
  inspectionTypes: (ct, reportType) =>
    get('/api/v1/inspection/inspection-types', { company_token: ct, report_type: reportType }, 'inspectionTypes'),
  standaloneInspectionTypes: (ct) =>
    get('/api/v1/inspection/inspection-types/standalone', { company_token: ct }, 'standaloneInspectionTypes'),
  turnaroundTimes: (ct, reportType) => get('/api/v1/tat', { company_token: ct, report_type: reportType }, 'turnaroundTimes'),
  intakeDetails:   (intakeToken) => get('/api/v1/order/intake-details', { intake_token: intakeToken }, 'intakeDetails'),
  orderTokens:     (intakeToken) => get(`/api/v1/order/${encodeURIComponent(intakeToken)}/order-tokens`, undefined, 'orderTokens'),
  orderStatus:     (intakeToken, orderToken) => get('/api/v1/order/status', { intake_token: intakeToken, order_token: orderToken }, 'orderStatus'),
  orderHistory:    (intakeToken, orderToken) => get('/api/v1/order/history', { intake_token: intakeToken, order_token: orderToken }, 'orderHistory'),
  retrieveResponse:(intakeToken, orderToken) => get('/api/v1/order/retrieve-response', { intake_token: intakeToken, order_token: orderToken }, 'retrieveResponse'),
  pdfFile:         (intakeToken, orderToken) => get('/api/v1/order/pdf-file', { intake_token: intakeToken, order_token: orderToken }, 'pdfFile'),

  // PRICING is a POST that changes nothing — a price quote, not an order. It is
  // deliberately NOT behind the write gate, so a desk can price a Hybrid order
  // with ordering still switched off (the same reading the AMC preflight uses).
  pricing: (payload) => request('POST', '/api/v1/order/pricing', { body: payload, label: 'pricing' }),

  // ---- WRITES (outbound gate) ----
  submitOrder:   (form) => request('POST', '/api/v1/order/submit', { form, write: true, label: 'submitOrder' }),
  updateOrder:   (intakeToken, form) =>
    request('PUT', `/api/v1/order/${encodeURIComponent(intakeToken)}/update`, { form, write: true, label: 'updateOrder' }),
  // A CARD, HANDED OVER AND THEN TAKEN BACK. Their add-card is COMPANY-level, so
  // a borrower's card added here becomes a payment source on the YS Capital
  // account until it is deleted again — which is why `payment.js` always runs
  // add → pay → delete, and why the delete lives here beside the add rather than
  // somewhere a future caller could forget about it.
  addCard:       (body) => request('POST', '/api/v1/company/add-card', { body, write: true, label: 'addCard' }),
  deletePaymentSource: (paymentSourceId) =>
    request('DELETE', `/api/v1/company/payment-source/${encodeURIComponent(paymentSourceId)}`,
      { write: true, label: 'deletePaymentSource' }),

  payForOrder:   (intakeToken, body) =>
    request('POST', `/api/v1/public/${encodeURIComponent(intakeToken)}/payment`, { body, write: true, label: 'payForOrder' }),
  sendPaymentLink: (intakeToken, body) =>
    request('POST', `/api/v1/order/${encodeURIComponent(intakeToken)}/send-payment-link-to-borrower`, { body, write: true, label: 'sendPaymentLink' }),
  dismissOrder:  (intakeToken) =>
    request('PUT', `/api/v1/order/${encodeURIComponent(intakeToken)}/dismiss`, { write: true, label: 'dismissOrder' }),
  reactivateOrder: (intakeToken) =>
    request('PUT', `/api/v1/order/${encodeURIComponent(intakeToken)}/reactivate`, { write: true, label: 'reactivateOrder' }),
  cancelOrder:   (body) => request('PUT', '/api/v1/order/cancel', { body, write: true, label: 'cancelOrder' }),
  updateInspectionType: (body) => request('PUT', '/api/v1/order/inspection-type-update', { body, write: true, label: 'updateInspectionType' }),
  updateReportType:     (body) => request('PUT', '/api/v1/order/report-type-update', { body, write: true, label: 'updateReportType' }),
  placeHold:     (body) => request('PUT', '/api/v1/order/place-hold', { body, write: true, label: 'placeHold' }),
  releaseHold:   (body) => request('PUT', '/api/v1/order/release-hold', { body, write: true, label: 'releaseHold' }),
  reopenOrder:   (body) => request('PUT', '/api/v1/order/reopen', { body, write: true, label: 'reopenOrder' }),
  uploadDocuments: (form) => request('POST', '/api/v1/order/upload-documents', { form, write: true, label: 'uploadDocuments' }),

  _internals: { maskSafe, readBody, backoff, toFormData, HOSTS, baseUrl, fieldErrorsOf },
};
