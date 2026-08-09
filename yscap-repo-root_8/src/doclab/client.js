'use strict';
/**
 * DOCLAB v3.1 — THE GUARDED TRANSPORT. One way in and out.
 *
 * Every safety property lives here so there is exactly one place to check them: the
 * three switches, the dry-run, the write gate, the token lifecycle, the timeout, the
 * retry rule, the masking — and the RTL scope gate, which is re-asserted here rather
 * than trusted from the caller. No route may call `fetch` against DocLab directly.
 *
 * WHAT THE WRITE GATE MEANS HERE, AND WHY IT IS DRAWN WHERE IT IS. A DocLab write
 * does not move money and does not touch a borrower — but it puts a loan request in
 * front of a law firm, and past `auto_approve` it causes real loan documents to be
 * drafted for a real closing. So creating, updating, approving, commenting and
 * generating a PDF are all behind `DOCLAB_OUTBOUND_ENABLED`. Reads — the token, the
 * lender/category catalogue, a state's prepayment options, a request's status, its
 * issues, its comments, a finished document — are behind the master switch only, so
 * a preflight or a catalogue refresh can run with submitting still switched off.
 *
 * ────────────────────────── WHAT IS NOT CONFIRMED YET ──────────────────────────
 * This is built from PLL's Confluence export (committed under docs/doclab/reference/).
 * That export renders several endpoint blocks as IMAGES, so their exact paths did not
 * come through as text. Two paths ARE stated in prose and are marked `confirmed`; the
 * rest are the documented SHAPE — method, parameters, response — with a path inferred
 * from the family. Every one of them is overridable by env, and `endpointStatus()`
 * reports which are which so a preflight can say so out loud instead of failing with
 * a 404 nobody can interpret.
 *
 * The export also contradicts itself about the `/api` prefix — the create endpoint is
 * printed as `POST /api/v3.1/loanprocess/loan-document` while the prepayment endpoint
 * is printed as `GET /v3.1/loanprocess/getPrepaymentOptions/{state}` on a full sandbox
 * URL with no `/api`. Both spellings are reproduced exactly as documented rather than
 * being "tidied" into agreement, because guessing which one is the typo is how you
 * spend a day debugging a 404 against a live vendor.
 *
 * THE SANDBOX AND PRODUCTION SHARE A BASE URL. Their API Setup page: "The base URL
 * for the sandbox and the production environment is currently identical. The
 * authentication parameters for the API determine which environment is accessed."
 * That is unusual and it is dangerous — the credential is the ONLY thing standing
 * between a test and a real law firm receiving a real loan request. So the
 * credential set carries an explicit `environment` label, `preflight()` reports it,
 * and it is written onto every stored request so a file can always answer which
 * environment its documents were drafted in.
 * ────────────────────────────────────────────────────────────────────────────────
 */

const cfg = require('../config');
const switches = require('../lib/integrations/switches');
const scope = require('./scope');

const MAX_TRIES = 3;
const BASE_BACKOFF_MS = 500;
const TOKEN_SKEW_SEC = 120;        // renew two minutes early rather than race the expiry
const DEFAULT_TIMEOUT_MS = 45000;

/**
 * The endpoint table. `confirmed` means the path appears as TEXT in PLL's
 * documentation; anything else is the documented shape with an inferred path.
 * `write` marks the calls behind the outbound gate.
 */
const ENDPOINTS = Object.freeze({
  token:              { method: 'POST', path: '/api/v3.1/token',                                 confirmed: false, write: false, env: 'DOCLAB_PATH_TOKEN' },
  createLoanDocument: { method: 'POST', path: '/api/v3.1/loanprocess/loan-document',             confirmed: true,  write: true,  env: 'DOCLAB_PATH_CREATE' },
  getRequest:         { method: 'GET',  path: '/api/v3.1/loanprocess/request/{requestId}',       confirmed: true,  write: false, env: 'DOCLAB_PATH_GET' },
  getIssues:          { method: 'GET',  path: '/api/v3.1/loanprocess/issues/{requestId}',        confirmed: false, write: false, env: 'DOCLAB_PATH_ISSUES' },
  listRequests:       { method: 'GET',  path: '/api/v3.1/loanprocess/requests',                  confirmed: false, write: false, env: 'DOCLAB_PATH_LIST' },
  approve:            { method: 'POST', path: '/api/v3.1/loanprocess/approve/{requestId}',       confirmed: false, write: true,  env: 'DOCLAB_PATH_APPROVE' },
  generatePdf:        { method: 'POST', path: '/api/v3.1/loanprocess/generatePdf/{requestId}',   confirmed: false, write: true,  env: 'DOCLAB_PATH_GENERATE_PDF' },
  downloadPdf:        { method: 'GET',  path: '/api/v3.1/loanprocess/downloadPdf/{requestId}',   confirmed: false, write: false, env: 'DOCLAB_PATH_DOWNLOAD_PDF' },
  downloadWord:       { method: 'GET',  path: '/api/v3.1/loanprocess/downloadWord/{requestId}',  confirmed: false, write: false, env: 'DOCLAB_PATH_DOWNLOAD_WORD' },
  getComments:        { method: 'GET',  path: '/api/v3.1/loanprocess/comments/{requestId}',      confirmed: false, write: false, env: 'DOCLAB_PATH_COMMENTS' },
  putComment:         { method: 'POST', path: '/api/v3.1/loanprocess/comment/{requestId}',       confirmed: false, write: true,  env: 'DOCLAB_PATH_PUT_COMMENT' },
  // Printed WITHOUT the /api prefix on a full sandbox URL. Reproduced verbatim.
  prepaymentOptions:  { method: 'GET',  path: '/v3.1/loanprocess/getPrepaymentOptions/{stateName}', confirmed: true, write: false, env: 'DOCLAB_PATH_PREPAYMENT' },
  lenderCategory:     { method: 'GET',  path: '/api/v3.1/loanprocess/getLenderCategory',         confirmed: false, write: false, env: 'DOCLAB_PATH_LENDER_CATEGORY' },
});

function conf() { return cfg.doclab || {}; }

/** The path in use — an env override wins over the documented default. */
function pathFor(name) {
  const e = ENDPOINTS[name];
  if (!e) throw new Error(`doclab: unknown endpoint "${name}"`);
  const override = process.env[e.env];
  return (override && String(override).trim()) || e.path;
}

/** Which paths are confirmed, which are inferred, which have been overridden. */
function endpointStatus() {
  return Object.keys(ENDPOINTS).map((name) => {
    const e = ENDPOINTS[name];
    const used = pathFor(name);
    return { name, method: e.method, path: used, confirmed: e.confirmed, write: e.write,
      overridden: used !== e.path, envVar: e.env };
  });
}

/* ─────────────────────────────── the switches ─────────────────────────────── */

// `switches.on(key)` reads the stored override and falls back to the switch's own
// `envDefault()` — which for all three of these is the cfg value — so the fallback
// is NOT passed here. Same shape every other integration uses.
function masterOn() { return switches.on('DOCLAB_ENABLED'); }
function outboundOn() { return switches.on('DOCLAB_OUTBOUND_ENABLED'); }
function dryrunOn() { return switches.on('DOCLAB_DRYRUN'); }

function configured() {
  const c = conf();
  return !!(c.baseUrl && c.clientId && c.clientSecret);
}

function fail(code, message, extra) {
  const e = new Error(`doclab: ${message}`);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/* ─────────────────────────────── the token ─────────────────────────────── */

let TOKEN = null;      // { value, expiresAt }

/** Forget the cached token — used after a 401 so the next call re-authenticates. */
function resetToken() { TOKEN = null; }

/**
 * Fetch (or reuse) the access token.
 *
 * Their Authentication page: the token is valid for ONE HOUR and a 401 means "get a
 * new one and retry". We renew two minutes early rather than wait to be told, and
 * `request()` still handles the 401 — a clock that drifts, or a token revoked early,
 * must not turn into a failed submission.
 *
 * The credential shape is the OAuth2 client-credentials form their docs describe
 * ("a unique clientId and clientSecret ... used to create a token"). The exact body
 * encoding is one of the things to confirm on the first live handshake, so it is
 * overridable: `DOCLAB_TOKEN_BODY=json` sends JSON instead of form-encoding.
 */
async function token({ force = false } = {}) {
  if (!configured()) throw fail('doclab_not_configured', 'the base URL, client id or client secret is not set.');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!force && TOKEN && TOKEN.expiresAt - TOKEN_SKEW_SEC > nowSec) return TOKEN.value;

  const c = conf();
  const url = joinUrl(c.baseUrl, pathFor('token'));
  const asJson = String(process.env.DOCLAB_TOKEN_BODY || '').toLowerCase() === 'json';
  const body = asJson
    ? JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials', scope: c.scope || undefined })
    : new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials',
      ...(c.scope ? { scope: c.scope } : {}) }).toString();

  const res = await rawFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': asJson ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  }, c.timeoutMs || DEFAULT_TIMEOUT_MS);

  const parsed = await readBody(res);
  if (!res.ok) {
    throw fail('doclab_auth_failed',
      `could not get an access token (HTTP ${res.status}). ${describeBody(parsed)}`,
      { status: res.status });
  }
  const j = parsed.json || {};
  const value = j.access_token || j.accessToken || j.token;
  if (!value) {
    throw fail('doclab_auth_no_token',
      `the token endpoint answered ${res.status} but no access_token was in the reply. ${describeBody(parsed)}`);
  }
  const ttl = Number(j.expires_in || j.expiresIn) || 3600;   // their docs: one hour
  TOKEN = { value, expiresAt: Math.floor(Date.now() / 1000) + ttl };
  return value;
}

/* ─────────────────────────────── the transport ─────────────────────────────── */

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
}

function fillPath(path, params) {
  return String(path).replace(/\{(\w+)\}/g, (m, k) => {
    const v = params && params[k];
    if (v === undefined || v === null || v === '') {
      throw fail('doclab_path_param_missing', `the "${k}" value is missing from a ${path} call.`);
    }
    return encodeURIComponent(String(v));
  });
}

/** A timeout that always clears, so a slow vendor cannot leak a handle per call. */
async function rawFetch(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Read a response body ONCE, keeping it whether or not it is JSON.
 *
 * A NON-JSON BODY IS KEPT ON PURPOSE — the lesson the AMC and Class integrations
 * already paid for. A corporate proxy or an egress allowlist refuses with a status
 * that looks exactly like a credential rejection and explains itself in plain text.
 * Throw that text away and "your network blocked this" becomes indistinguishable
 * from "your secret is wrong", and the expensive mistake is re-issuing a perfectly
 * good credential.
 */
async function readBody(res) {
  const ctype = String(res.headers.get('content-type') || '');
  if (/pdf|officedocument|octet-stream|msword/i.test(ctype)) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { binary: buf, contentType: ctype, text: null, json: null };
  }
  let text = '';
  try { text = await res.text(); } catch (_) { text = ''; }
  let json = null;
  if (text && /json/i.test(ctype)) { try { json = JSON.parse(text); } catch (_) { json = null; } }
  if (json === null && text) { try { json = JSON.parse(text); } catch (_) { /* genuinely not JSON */ } }
  return { binary: null, contentType: ctype, text, json };
}

function describeBody(parsed) {
  if (!parsed) return '';
  if (parsed.json) {
    const j = parsed.json;
    const bits = [j.detail, j.title, j.message, j.error_description, j.error].filter(Boolean);
    if (bits.length) return String(bits[0]).slice(0, 400);
    try { return JSON.stringify(j).slice(0, 400); } catch (_) { return ''; }
  }
  if (parsed.text) return parsed.text.replace(/\s+/g, ' ').trim().slice(0, 400);
  return '';
}

function retryable(status) { return status === 408 || status === 429 || (status >= 500 && status <= 599); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The one call. Everything else in this file is a thin wrapper.
 *
 * `opts.write` marks a call as a write; the outbound gate and the dry-run both key
 * on it. The dry-run is checked BEFORE the write gate deliberately, so leaving it on
 * is always safe while somebody is verifying a payload against the documentation.
 */
async function request(endpoint, { params, query, body, accept, write } = {}) {
  const e = ENDPOINTS[endpoint];
  if (!e) throw fail('doclab_unknown_endpoint', `unknown endpoint "${endpoint}".`);
  const isWrite = write === undefined ? e.write : !!write;

  if (!masterOn()) throw fail('doclab_disabled', 'the DocLab integration is switched off.');
  if (!configured()) throw fail('doclab_not_configured', 'the base URL, client id or client secret is not set.');

  const c = conf();
  let path = fillPath(pathFor(endpoint), params);
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) path += (path.includes('?') ? '&' : '?') + s;
  }
  const url = joinUrl(c.baseUrl, path);

  if (isWrite && dryrunOn()) {
    // Log the exact request and send nothing. The payload is the whole point of a
    // dry-run, so it is logged in full — it carries no secret (the token is the
    // secret, and it is not in the body).
    console.log('[doclab] DRY RUN — would send', e.method, url,
      body ? JSON.stringify(body).slice(0, 4000) : '(no body)');
    return { dryRun: true, status: 0, json: null, text: null, binary: null, url, method: e.method };
  }
  if (isWrite && !outboundOn()) {
    throw fail('doclab_outbound_disabled',
      'sending to DocLab is switched off. Turn on "Send loan document requests to DocLab" on the API Health page.');
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let bearer;
    try { bearer = await token(); } catch (err) { throw err; }

    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: accept || 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await rawFetch(url, {
        method: e.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }, c.timeoutMs || DEFAULT_TIMEOUT_MS);
    } catch (err) {
      // Network or timeout. Retryable — and a write is safe to retry ONLY because
      // DocLab keys an update on `requestId`: a create that actually landed but whose
      // reply we never saw would be re-created, which is why `submit()` in the desk
      // layer must always send the stored requestId when it has one.
      lastErr = fail('doclab_unreachable', `could not reach DocLab (${err && err.message}).`);
      if (attempt < MAX_TRIES) { await sleep(BASE_BACKOFF_MS * attempt); continue; }
      throw lastErr;
    }

    // Their Authentication page's own instruction: on a 401, mint a new token and
    // resubmit. Once — a second 401 is a credential problem, not an expiry.
    if (res.status === 401 && attempt < MAX_TRIES) {
      resetToken();
      await token({ force: true }).catch(() => {});
      continue;
    }

    const parsed = await readBody(res);

    if (retryable(res.status) && attempt < MAX_TRIES) {
      lastErr = fail('doclab_http_error', `DocLab answered HTTP ${res.status}. ${describeBody(parsed)}`, { status: res.status });
      await sleep(BASE_BACKOFF_MS * attempt);
      continue;
    }

    if (!res.ok && res.status !== 202) {
      throw fail('doclab_http_error',
        `DocLab answered HTTP ${res.status}. ${describeBody(parsed)}`,
        { status: res.status, body: parsed.json || parsed.text || null });
    }

    return {
      dryRun: false, status: res.status, url, method: e.method,
      json: parsed.json, text: parsed.text, binary: parsed.binary, contentType: parsed.contentType,
    };
  }
  throw lastErr || fail('doclab_failed', 'the request did not complete.');
}

/* ─────────────────────────────── the operations ─────────────────────────────── */

/**
 * Create or update a loan request.
 *
 * ONE FUNCTION FOR BOTH, because DocLab makes it one endpoint: their Update page is
 * explicit that `requestId` present updates and absent creates. Splitting it into
 * two functions here would invent a distinction their API does not have, and the
 * real hazard is the opposite one — losing the requestId and silently creating a
 * SECOND request for a loan that already has one. `payload.buildPayload` is what
 * puts the stored id in, and this asserts scope one more time on the way out.
 */
async function submitLoanDocument(payload) {
  const p = payload || {};
  scope.assertInScope({
    loanCategory: p.template && p.template.loan_category,
    prepaymentOptionCode: p.prepayment_option_code,
  });
  return request('createLoanDocument', { body: p, write: true });
}

async function getRequest(requestId)  { return request('getRequest', { params: { requestId } }); }
async function getIssues(requestId)   { return request('getIssues', { params: { requestId } }); }
async function getComments(requestId) { return request('getComments', { params: { requestId } }); }

async function listRequests({ offset = 1, limit = 50, status } = {}) {
  return request('listRequests', { query: { offset, limit, status } });
}

async function approve(requestId)     { return request('approve', { params: { requestId }, write: true }); }
async function generatePdf(requestId) { return request('generatePdf', { params: { requestId }, write: true }); }
async function putComment(requestId, comment) {
  return request('putComment', { params: { requestId }, body: { comment: String(comment || '') }, write: true });
}

/**
 * Download the finished package.
 *
 * A 202 IS NOT AN ERROR AND MUST NOT BE TREATED AS ONE — their Download page:
 * "If PDF is not ready, API will return 202 Accepted." So the caller polls; it does
 * not retry-as-failure and it does not mistake the empty body for a broken document.
 */
async function downloadPdf(requestId) {
  const r = await request('downloadPdf', { params: { requestId }, accept: 'application/pdf' });
  return { ready: r.status === 200 && !!r.binary, pending: r.status === 202, bytes: r.binary || null, status: r.status };
}

async function downloadWord(requestId) {
  const r = await request('downloadWord', { params: { requestId },
    accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  return { ready: r.status === 200 && !!r.binary, pending: r.status === 202, bytes: r.binary || null, status: r.status };
}

/** The per-state prepayment options. The ONLY authority on which codes a state allows. */
async function prepaymentOptions(stateName) {
  return request('prepaymentOptions', { params: { stateName } });
}

/** The lender → category → state → options hierarchy. Cache it; it is configuration. */
async function lenderCategory() { return request('lenderCategory'); }

/**
 * Can we actually talk to DocLab, and in which environment?
 *
 * Never throws — a preflight that throws tells an admin nothing. It reports the
 * switch positions, whether the credentials are present, whether a token can be
 * minted, and which endpoint paths are still inferred rather than confirmed.
 */
async function preflight() {
  const out = {
    configured: configured(),
    enabled: masterOn(),
    outbound: outboundOn(),
    dryrun: dryrunOn(),
    baseUrl: conf().baseUrl || null,
    environment: conf().environment || 'unknown',
    tokenOk: null,
    detail: null,
    endpoints: endpointStatus(),
  };
  out.unconfirmedPaths = out.endpoints.filter((e) => !e.confirmed && !e.overridden).map((e) => e.name);
  if (!out.configured) { out.detail = 'The base URL, client id or client secret is not set.'; return out; }
  if (!out.enabled) { out.detail = 'The DocLab integration is switched off.'; return out; }
  try {
    await token({ force: true });
    out.tokenOk = true;
    out.detail = `Signed in to the ${out.environment} environment.`;
  } catch (e) {
    out.tokenOk = false;
    out.detail = e && e.message ? e.message : 'Could not get an access token.';
  }
  return out;
}

module.exports = {
  ENDPOINTS, endpointStatus, pathFor,
  configured, masterOn, outboundOn, dryrunOn,
  token, resetToken, request,
  submitLoanDocument, getRequest, getIssues, listRequests, approve, generatePdf,
  putComment, getComments, downloadPdf, downloadWord, prepaymentOptions, lenderCategory,
  preflight,
  _internals: { joinUrl, fillPath, readBody, describeBody, retryable },
};
