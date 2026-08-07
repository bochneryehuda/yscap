'use strict';
/**
 * Class Valuation Orders API — the guarded transport.
 *
 * ONE way in and out, so every safety property is enforced in a single place:
 * the three switches, the dry-run, the write gate, the token lifecycle, the
 * timeout, the retry rule, and the masking. No route may call `fetch` directly.
 *
 * AUTH IS ONE CALL, NOT TWO (their guide, p.9). OAuth2 **password grant** —
 * `client_id` + `client_secret` + `username` + `password`, every one marked
 * [Required] and "supplied by Class Valuation". This is the whole reason the
 * portal login is not enough: there is no documented flow that omits the client
 * id/secret (the only other grant, `cv_user_identity`, still needs both). The
 * token is a Bearer with `expires_in` (3600s observed) and is cached until it is
 * close to expiring.
 *
 * WHAT THE WRITE GATE MEANS HERE. `CLASS_OUTBOUND_ENABLED` guards a real order
 * being PLACED — money, and an appraiser dispatched to someone's property. Reads
 * (the token, products, an order's status, its attachments) are gated only by the
 * master switch, exactly as on the AMC side, so a preflight or a catalog refresh
 * can run with ordering still switched off.
 *
 * A NON-JSON BODY IS KEPT — this is the lesson the AMC integration paid for.
 * A corporate proxy or an egress allowlist refuses with an HTTP status that looks
 * exactly like a credential rejection, and its explanation is plain text. Throw
 * that body away and "your network blocked this" is indistinguishable from "your
 * secret is wrong" — and the expensive mistake is sending someone to re-issue a
 * perfectly good credential. Every response body is preserved, JSON or not.
 *
 * HOSTS ARE UNCONFIRMED. Their guide and their onboarding email disagree about
 * the base URL, and the guide only ever prints the TEST identity host. Everything
 * is derived from one table and overridable by env; `hosts()` reports whether the
 * values in use were confirmed or inferred, so a preflight can say so out loud
 * rather than failing with a DNS error nobody can interpret.
 */

const cfg = require('../config');
const switches = require('../lib/integrations/switches');

const MAX_TRIES = 3;
const BASE_BACKOFF_MS = 500;
const TOKEN_SKEW_SEC = 60;          // renew a minute early rather than race the expiry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLASS = () => cfg.class || {};

// ---------------------------------------------------------------------------
// Hosts. ONE table, every value overridable, and each one says whether it was
// CONFIRMED by the vendor's own documentation or INFERRED by us.
// ---------------------------------------------------------------------------
const HOSTS = {
  // The guide (p.3) prints these three order hosts explicitly.
  production: { orders: 'https://orders-external.classvaluation.com',     ordersConfirmed: true,
                token:  'https://ids.classvaluation.com/connect/token',    tokenConfirmed: false },
  uat:        { orders: 'https://orders-external.uat.classvaluation.com', ordersConfirmed: true,
                token:  'https://ids.uat.classvaluation.com/connect/token', tokenConfirmed: false },
  // The ONLY identity host the guide ever shows is the test one — so this is the
  // one row where the token URL is confirmed and the others are inferred from it.
  test:       { orders: 'https://orders-external.test.classvaluation.com', ordersConfirmed: true,
                token:  'https://ids.test.classvaluation.com/connect/token', tokenConfirmed: true },
};

function hosts() {
  const c = CLASS();
  const env = HOSTS[c.environment] ? c.environment : 'uat';
  const row = HOSTS[env];
  const ordersUrl = c.ordersUrl || row.orders;
  const tokenUrl = c.tokenUrl || row.token;
  return {
    environment: env,
    ordersUrl,
    tokenUrl,
    // "Confirmed" means the vendor's own document prints this exact value for this
    // environment. An env override counts as confirmed by the operator.
    ordersConfirmed: !!c.ordersUrl || row.ordersConfirmed,
    tokenConfirmed: !!c.tokenUrl || row.tokenConfirmed,
  };
}

// ---------------------------------------------------------------------------
// Configuration report — booleans only, never a credential value.
// ---------------------------------------------------------------------------
function configured() {
  const c = CLASS();
  const h = hosts();
  const hasClient = !!(c.clientId && c.clientSecret);
  const hasUser = !!(c.username && c.password);
  return {
    enabled: switches.on('CLASS_ENABLED'),
    outbound: switches.on('CLASS_OUTBOUND_ENABLED'),
    dryrun: switches.on('CLASS_DRYRUN'),
    hasClient, hasUser,
    // All four are required by the password grant — there is no partial mode.
    ready: hasClient && hasUser,
    environment: h.environment,
    hostsConfirmed: h.ordersConfirmed && h.tokenConfirmed,
    // The callback half is independent: ordering works without it, but nothing
    // will tell us the order progressed.
    callbackReady: !!(c.callbackUrl && c.callbackUser && c.callbackPassword),
  };
}

// ---------------------------------------------------------------------------
// Errors. `retryable` decides the retry; `body` is ALWAYS carried so a caller can
// tell a firewall's plain-text refusal from the vendor's own JSON rejection.
// ---------------------------------------------------------------------------
function httpError(label, status, body, retryAfterSec) {
  const e = new Error(`Class ${label} failed: HTTP ${status}`);
  e.status = status;
  e.body = body;
  e.retryable = status === 429 || (status >= 500 && status <= 599);
  if (retryAfterSec) e.retryAfterSec = retryAfterSec;
  return e;
}
function gateError(code, message) { const e = new Error(`${code}: ${message}`); e.code = code; return e; }

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  } finally { clearTimeout(t); }
}

// Parse a body WITHOUT ever discarding it. A non-JSON reply is kept verbatim
// under `raw` — see the header note; this is the whole point.
function readBody(buf) {
  const text = buf.toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 800) }; }
}

// ---------------------------------------------------------------------------
// Token. Cached in-process until close to expiry; a 401 invalidates it once.
// ---------------------------------------------------------------------------
let _token = null;          // { value, expiresAtMs }
let _inFlight = null;       // single-flight, so a burst mints one token

function invalidateToken() { _token = null; }

async function getAccessToken() {
  if (!switches.on('CLASS_ENABLED')) throw gateError('CLASS_DISABLED', 'the Class Valuation integration master switch is off');
  const c = CLASS();
  if (!c.clientId || !c.clientSecret || !c.username || !c.password) {
    throw gateError('CLASS_NOT_CONFIGURED',
      'CLASS_CLIENT_ID / CLASS_CLIENT_SECRET / CLASS_USERNAME / CLASS_PASSWORD are not all set — the password grant requires all four');
  }
  if (_token && _token.expiresAtMs - TOKEN_SKEW_SEC * 1000 > Date.now()) return _token.value;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    const url = hosts().tokenUrl;
    // Their documented form: everything in the body, x-www-form-urlencoded.
    const form = new URLSearchParams({
      grant_type: 'password',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      username: c.username,
      password: c.password,
    });
    const { res, buf } = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, c.timeoutMs);
    const data = readBody(buf);
    if (!res.ok) throw httpError('token', res.status, data);
    const tok = data && data.access_token;
    if (!tok) throw httpError('token', res.status, data);   // 200 with no token is still a failure
    const ttl = Math.max(60, parseInt(data.expires_in, 10) || 3600);
    _token = { value: tok, expiresAtMs: Date.now() + ttl * 1000 };
    return tok;
  })().finally(() => { _inFlight = null; });

  return _inFlight;
}

// ---------------------------------------------------------------------------
// The one request path.
//   opts.write  — this call CHANGES something at Class. Gated by
//                 CLASS_OUTBOUND_ENABLED and short-circuited by CLASS_DRYRUN.
//   opts.label  — what to call it in an error.
// ---------------------------------------------------------------------------
async function request(method, path, { body, query, write, label } = {}) {
  if (!switches.on('CLASS_ENABLED')) throw gateError('CLASS_DISABLED', 'the Class Valuation integration master switch is off');

  // Dry-run is checked BEFORE the write gate, so it is always safe to leave on
  // while verifying — exactly the AMC ordering.
  if (write && switches.on('CLASS_DRYRUN')) {
    console.warn(`[class][DRYRUN] would ${method} ${path} body=${JSON.stringify(maskSafe(body))}`);
    return { __dryrun: true };
  }
  if (write && !switches.on('CLASS_OUTBOUND_ENABLED')) {
    throw gateError('CLASS_OUTBOUND_DISABLED', `refusing ${label || method + ' ' + path} — writes are gated off`);
  }

  const base = hosts().ordersUrl;
  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString()
    : '';
  const url = `${base}${path.startsWith('/') ? path : '/' + path}${qs}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  let refreshed = false;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res, buf;
    try {
      const token = await getAccessToken();
      const headers = { Authorization: `Bearer ${token}` };
      if (payload !== undefined) headers['Content-Type'] = 'application/json';
      ({ res, buf } = await fetchWithTimeout(url, { method, headers, body: payload }, CLASS().timeoutMs));
    } catch (netErr) {
      netErr.retryable = true; lastErr = netErr;
      if (attempt < MAX_TRIES) { await sleep(backoff(attempt)); continue; }
      throw netErr;
    }

    // Their documented expired-token shape is `{success:false, code:"401.1"}` with
    // an HTTP 401 — refresh once, then treat a second 401 as a real rejection.
    if (res.status === 401 && !refreshed) { refreshed = true; invalidateToken(); continue; }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
      const ra = parseInt(res.headers.get('retry-after') || '0', 10);
      await sleep(backoff(attempt, ra));
      continue;
    }

    const data = readBody(buf);
    if (!res.ok) throw httpError(label || `${method} ${path}`, res.status, data,
      parseInt(res.headers.get('retry-after') || '0', 10) || undefined);

    // Their envelope carries `success:false` WITH an HTTP 200 on some errors, so a
    // 2xx is not on its own proof the thing worked.
    if (data && data.success === false) {
      const e = new Error(`Class ${label || path} refused: ${data.message || 'no message'}`);
      e.status = res.status; e.body = data; e.retryable = false;
      throw e;
    }
    return data;
  }
  throw lastErr || new Error(`Class ${label || path} failed after ${MAX_TRIES} attempts`);
}

function backoff(attempt, retryAfterSec) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 60000);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
}

// Mask anything that looks like a secret before it reaches a log line. The order
// body carries borrower names and contact details, so this is deliberately about
// CREDENTIALS, not PII — a dry-run log is a staff-only diagnostic, and the loan
// file's own data is what the operator is trying to check.
const SECRET_KEYS = /^(client_?secret|password|access_?token|authorization|token)$/i;
function maskSafe(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(maskSafe);
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '***' : maskSafe(val);
  return out;
}

// ---- the documented surface, each a thin named call -----------------------
const get  = (path, query, label) => request('GET', path, { query, label });
const post = (path, body, opts = {}) => request('POST', path, { body, write: true, ...opts });

module.exports = {
  configured, hosts, invalidateToken, getAccessToken, request, get, post,
  // READS (master switch only)
  products: (query) => get('/products', query, 'products'),
  order: (orderId) => get(`/orders/${encodeURIComponent(orderId)}`, undefined, 'order'),
  orders: (query) => get('/orders', query, 'orders'),
  attachments: (orderId, query) => get(`/orders/${encodeURIComponent(orderId)}/attachments`, query, 'attachments'),
  attachment: (orderId, attachmentId, query) =>
    get(`/orders/${encodeURIComponent(orderId)}/attachments/${encodeURIComponent(attachmentId)}`, query, 'attachment'),
  listCallbacks: () => get('/callbacks', undefined, 'callbacks'),
  // WRITES (outbound gate)
  createOrder: (body, query) => request('POST', '/orders', { body, query, write: true, label: 'createOrder' }),
  addNote: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/notes`, body, { label: 'addNote' }),
  requestRevision: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/request-revision`, body, { label: 'requestRevision' }),
  requestCancel: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/request-cancel`, body, { label: 'requestCancel' }),
  registerCallback: (body) => post('/callbacks', body, { label: 'registerCallback' }),
  _internals: { maskSafe, readBody, backoff, HOSTS },
};
