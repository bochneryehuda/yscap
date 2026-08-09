'use strict';
/**
 * Class Valuation Orders API — the guarded transport.
 *
 * ONE way in and out, so every safety property is enforced in a single place:
 * the three switches, the dry-run, the write gate, the token lifecycle, the
 * timeout, the retry rule, and the masking. No route may call `fetch` directly.
 *
 * WHICH GUIDE THIS IS BUILT ON. "Class Orders API Guide", rev 0.17, 08-03-2026 —
 * which documents BOTH versions on the SAME hosts and the SAME credentials:
 * `POST /orders` is UAD 2.6 and `POST /v2/orders` is UAD 3.6. Both are built
 * (owner-directed 2026-08-07, ahead of the industry's shift to 3.6); 2.6 is the
 * default and the order screen can choose per order. Only the PATH and the body
 * shape differ, which is why the version lives in the builder and arrives here as
 * `opts.path` — see `createOrder`.
 *
 * There is a SEPARATE `ClassOrdersAPIGuide_V2.pdf` describing a different API on
 * `orders-external.*` hosts, which never mentions UAD at all. It is NOT "version 2"
 * in the sense used here and nothing in this integration is built against it.
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
 * THE IDENTITY HOST IS STILL UNCONFIRMED. The V1 guide prints all three ORDER
 * hosts, but only ever shows the TEST identity host — the UAT and production ones
 * are inferred from its shape. Everything is derived from one table and overridable
 * by env; `hosts()` reports whether the values in use were confirmed or inferred,
 * so a preflight can say so out loud rather than failing with a DNS error nobody
 * can interpret.
 */

const cfg = require('../config');
const switches = require('../lib/integrations/switches');
// PURE — no database, no network, no cycle back into this module.
const orderBuild = require('./order-build');

// Their product catalogue, cached for a few minutes. Only ever used to put a NAME
// beside a number on a screen — never to decide what is ordered.
const PRODUCT_CACHE_MS = 5 * 60 * 1000;
let _productCache = null;
const text = (v) => { const t = v == null ? '' : String(v).trim(); return t || null; };

// A version-specific READ must be told which version; it may never fall back. The
// caller that knows is the stored order row (`class_orders.api_version`), and when
// THAT is unknown the documented behaviour is to decline the call, not to guess.
function requireVersion(opts) {
  const v = opts && opts.version;
  if (v !== 'v1' && v !== 'v2') {
    const e = new Error('class: the UAD version of this order is unknown, so it cannot be read — reading it on the wrong version answers in the other vocabulary and finds nothing');
    e.code = 'class_version_unknown';
    throw e;
  }
  return orderBuild.profileFor(v);
}

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
  // The V1 guide (p.3) prints these three order hosts explicitly, and p.13 shows a
  // real create call at `POST https://api.uat.classvaluation.com/orders` — so the
  // order paths hang off the ROOT of these hosts.
  production: { orders: 'https://api.classvaluation.com',      ordersConfirmed: true,
                token:  'https://ids.classvaluation.com/connect/token',     tokenConfirmed: false },
  uat:        { orders: 'https://api.uat.classvaluation.com',  ordersConfirmed: true,
                token:  'https://ids.uat.classvaluation.com/connect/token', tokenConfirmed: false },
  // The ONLY identity host either guide ever shows is the test one — so this is the
  // one row where the token URL is confirmed and the others are inferred from it.
  test:       { orders: 'https://api.test.classvaluation.com', ordersConfirmed: true,
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
    // Which UAD version orders go out on by default. Both are built; this is only
    // the starting point, and the screen can choose per order.
    apiVersion: orderBuild.profileFor(c.apiVersion).version,
    uad: orderBuild.profileFor(c.apiVersion).uad,
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
async function request(method, path, { body, query, write, label, dryrun } = {}) {
  if (!switches.on('CLASS_ENABLED')) throw gateError('CLASS_DISABLED', 'the Class Valuation integration master switch is off');

  // Dry-run is checked BEFORE the write gate, so it is always safe to leave on
  // while verifying — exactly the AMC ordering.
  //
  // `opts.dryrun` is a caller's already-made decision and can only ever force the dry
  // run ON, never cancel one. The order route STAMPS `class_orders.dryrun` from its
  // own read of this switch, so without passing it down a switch flipped between the
  // two reads left a real order permanently labelled a test — the same read-it-twice
  // shape the AMC side was fixed for, in the other vendor's route.
  if (write && (dryrun === true || switches.on('CLASS_DRYRUN'))) {
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
// `userName` is in here for a specific reason: the callback REGISTRATION body is
// {callbackUrl, userName, password, authMode}, and those two are the Basic-auth pair
// for our PUBLIC receiver. Masking only the password writes half the credential to
// the application log in clear on any dry-run registration.
const SECRET_KEYS = /^(client_?secret|password|access_?token|authorization|token|user_?name|login_?account)$/i;
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
  // The chosen form's NAME, not just its number. Their catalogue is small and
  // changes rarely, so it is cached briefly: the order screen asks for this on
  // every preview, and re-fetching a price list per keystroke would be absurd.
  // NEVER throws and never blocks an order — a number with no name is still a
  // placeable order, it just reads worse.
  productTitle: async (id) => {
    const key = String(id == null ? '' : id).trim();
    if (!key) return null;
    try {
      const now = Date.now();
      if (!_productCache || now - _productCache.at > PRODUCT_CACHE_MS) {
        const r = await get('/products', { limit: 500 }, 'products');
        const list = (r && (r.products || r.data)) || [];
        const byId = new Map();
        for (const p of Array.isArray(list) ? list : []) {
          if (p && p.id != null) byId.set(String(p.id), text(p.title || p.name || p.productName));
        }
        _productCache = { at: now, byId };
      }
      return _productCache.byId.get(key) || null;
    } catch (_) { return null; }
  },
  // READING AN ORDER IS VERSION-SPECIFIC. `GET /orders/{id}` and `GET /v2/orders/{id}`
  // describe the SAME order with different field names (propertyTypeEnum vs
  // propertyType, a typed occupancy, the renamed GSE references). Reading a 3.6 order
  // through the 2.6 path does not error — it answers in the other vocabulary, and
  // anything keyed on a field name would quietly find nothing. So the version is
  // REQUIRED to be passed by whoever knows it (the stored order row), and the default
  // here is only for a caller that genuinely has no order in hand.
  // ...and "REQUIRED" is enforced rather than described. `profileFor` falls back to v1
  // for anything it does not recognise — which is right for the BUILDER (a new order
  // has to go somewhere, and the default version is the honest choice) and exactly
  // wrong for a READ of an order that already exists on one specific version. An
  // omitted version here would silently read a 3.6 order through the 2.6 vocabulary
  // and find nothing, which is the failure this whole file is arranged around.
  order: (orderId, opts = {}) =>
    get(`${requireVersion(opts).path}/${encodeURIComponent(orderId)}`, undefined, 'order'),
  orders: (query, opts = {}) => get(requireVersion(opts).path, query, 'orders'),
  // THE V1 GUIDE CONTRADICTS ITSELF ON THIS ONE PATH: its order-completion walkthrough
  // (p.7, added in the newest revision) says `GET /orders/{orderId}/attachments`, while
  // the older Attachments reference section (p.14) writes `GET /{orderId}/attachments`
  // with no `/orders`. We follow the newer walkthrough. If the first live pull 404s,
  // this — not the credential — is the thing to try.
  attachments: (orderId, query) => get(`/orders/${encodeURIComponent(orderId)}/attachments`, query, 'attachments'),
  attachment: (orderId, attachmentId, query) =>
    get(`/orders/${encodeURIComponent(orderId)}/attachments/${encodeURIComponent(attachmentId)}`, query, 'attachment'),
  // CALLBACKS ARE REGISTERED PER ORGANIZATION, NOT PER ORDER OR PER VERSION. Their
  // registration body carries an event name and a URL and nothing else — so ONE
  // registration covers orders on both UAD versions, and the event that arrives does
  // not say which version its order was placed on. That is exactly why the version is
  // stored on our own order row (db/490) instead of being read off the callback.
  // Notes, revisions and cancellations are NOT version-specific — the guide
  // documents exactly one path for each, shared by both UAD versions. Only order
  // CREATE, order READ and the product catalogue have a /v2 variant.
  notes: (orderId, query) => get(`/orders/${encodeURIComponent(orderId)}/notes`, query, 'notes'),
  listCallbacks: () => get('/callbacks', undefined, 'callbacks'),
  // WRITES (outbound gate)
  // THE PATH IS THE VERSION. `/orders` is UAD 2.6, `/v2/orders` is UAD 3.6 — same
  // host, same credentials, a different contract. The BUILDER decides which (it is
  // the thing that shaped the body to match), and hands its own `path` down here, so
  // the body and the endpoint can never disagree. Defaulting to `/orders` keeps
  // every existing caller on 2.6 exactly as before.
  createOrder: (body, query, opts = {}) =>
    request('POST', opts.path || '/orders', { body, query, write: true, label: 'createOrder', dryrun: opts.dryrun }),
  addNote: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/notes`, body, { label: 'addNote' }),
  requestRevision: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/request-revision`, body, { label: 'requestRevision' }),
  requestCancel: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/request-cancel`, body, { label: 'requestCancel' }),
  requestGseRevision: (orderId, body) => post(`/orders/${encodeURIComponent(orderId)}/request-gse-revision`, body, { label: 'requestGseRevision' }),
  registerCallback: (body) => post('/callbacks', body, { label: 'registerCallback' }),
  registerAllCallbacks: (body) => post('/callbacks/addAll', body, { label: 'registerAllCallbacks' }),
  deleteCallback: (id) => request('DELETE', '/callbacks', { query: { id }, write: true, label: 'deleteCallback' }),
  _internals: { maskSafe, readBody, backoff, HOSTS },
};
