'use strict';
/**
 * LONG-TERM — the A&D MORTGAGE (AIM Quick Pricer) backend client.
 *
 * The third pricing source, beside Lender Price and LoanNEX. It logs in once,
 * keeps one warm cookie session, caches AIM's published schema, and prices. It
 * is a pricing VIEWER: it reads pricing and never books, locks, registers or
 * writes anything at A&D.
 *
 * ── AUTH IS THE WHOLE DIFFERENCE FROM THE OTHER TWO ────────────────────────
 * Lender Price needs an OAuth2 password grant plus an HTTP Basic client
 * credential, a refresh token, a backoff and a breaker. AIM needs a JSON POST
 * and a cookie. Measured live: `POST /api/user/login {email,password}` -> 200,
 * `Set-Cookie: api-session, .AspNetCore.Cookies`, and every later call carries
 * them. One login served twelve sequential pricing calls with no re-auth.
 *
 * TWO THINGS THE BROWSER DOES THAT WE DO NOT NEED, both measured:
 *   · Selecting the org (`POST /api/user/account/{orgId}/{accountId}`) is NOT
 *     required to price — `calculate` answers 200 before it. We still do it when
 *     an account is discoverable, because it costs one call and keeps our
 *     session identical to a human's.
 *   · `/restrictions` is called by the web app on nearly every keystroke (46
 *     times in one recorded session). It only greys out impossible options. A
 *     backend never needs it, so this client never calls it.
 *
 * ⚠️ `passwordExpired: true` DOES NOT GATE THE API. The account this was
 * measured on is flagged for a password change and prices anyway — so that flag
 * must never be read as a health signal. It IS surfaced by `health()` because a
 * human should still act on it.
 *
 * ── CREDENTIALS ────────────────────────────────────────────────────────────
 * `process.env` only, never argv (visible in the process list), never a file.
 * A personal broker login is the wrong thing to run this on: a password change
 * silently kills the board and every call is attributed to one person. The
 * README says so; this module simply refuses to start without credentials.
 *
 * LT-only. Reads `process.env` directly, imports no RTL code, touches no database.
 */

const S = require('./schema');
const scenario = require('./scenario');
const { parse, parseRefusal } = require('./parse');

const API_BASE = process.env.AIM_BASE || 'https://aim.admortgage.com';
const TIMEOUT_MS = Number(process.env.AIM_TIMEOUT_MS || 30000);
const SCHEMA_TTL_MS = Number(process.env.AIM_SCHEMA_TTL_MS || 1800000);   // 30 min

/** Only ever talk to A&D. A redirect or a mis-set base must not exfiltrate a login. */
const ALLOWED_HOSTS = new Set(['aim.admortgage.com']);
function assertAllowed(url) {
  let host;
  try { host = new URL(url).host.toLowerCase(); } catch { throw new Error('admortgage_bad_url'); }
  if (!ALLOWED_HOSTS.has(host) && host !== new URL(API_BASE).host.toLowerCase()) {
    throw new Error(`admortgage_host_not_allowed:${host}`);
  }
}

function credentials() {
  const email = process.env.AIM_EMAIL;
  const password = process.env.AIM_PASSWORD;
  return { email, password, ok: !!(email && password) };
}
const configured = () => credentials().ok;

/** Never let a credential or a cookie reach a log or an error surface. */
function scrub(s) {
  return String(s == null ? '' : s)
    .replace(/("password"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/("email"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/(api-session|\.AspNetCore\.Cookies)=[^;,\s]+/gi, '$1=***');
}

let _session = null;      // { cookies: Map, at, account }
let _schema = new Map();  // groupId -> { fields, at, provenance }
let _inflight = null;

function cookieHeader(cookies) { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
function keepCookies(res, cookies) {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

async function req(path, { method = 'GET', body, cookies } = {}) {
  const url = API_BASE + path;
  assertAllowed(url);
  const headers = {
    Accept: '*/*',
    Origin: API_BASE,
    Referer: `${API_BASE}/quick-pricer/`,
  };
  if (cookies && cookies.size) headers.Cookie = cookieHeader(cookies);
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method, headers, redirect: 'manual', signal: ctl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'admortgage_timeout' : `admortgage_network:${e.message}`);
  } finally { clearTimeout(timer); }

  if (cookies) keepCookies(res, cookies);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* AIM answers JSON; a non-JSON body is surfaced as text */ }
  return { status: res.status, text, json };
}

async function login() {
  const { email, password, ok } = credentials();
  if (!ok) throw new Error('admortgage_not_configured');
  const cookies = new Map();
  const r = await req('/api/user/login', { method: 'POST', body: { email, password }, cookies });
  if (r.status !== 200 || !r.json || r.json.success !== true || r.json.data !== true) {
    throw new Error(`admortgage_login_failed:${r.status}`);
  }
  if (!cookies.size) throw new Error('admortgage_login_no_session_cookie');

  // Mirror a human session: discover the account and select it. Not required to
  // price (measured), so a failure here is recorded, never fatal.
  let account = null;
  try {
    const a = await req('/api/user/accounts', { cookies });
    const first = a.json && Array.isArray(a.json.data) ? a.json.data[0] : null;
    if (first) {
      await req(`/api/user/account/${first.orgId}/${first.accountId}`, { method: 'POST', body: {}, cookies });
      account = { orgId: first.orgId, accountId: first.accountId, organizationName: first.organizationName || null };
    }
  } catch { /* org selection is optional — see the header */ }

  return { cookies, at: Date.now(), account };
}

const fresh = (s) => !!(s && s.cookies && s.cookies.size);

async function getSession({ force = false } = {}) {
  if (!force && fresh(_session)) return _session;
  if (_inflight) return _inflight;
  _inflight = (async () => { try { _session = await login(); return _session; } finally { _inflight = null; } })();
  return _inflight;
}

/**
 * AIM's published schema for a group, cached.
 *
 * ON A FETCH FAILURE THE CAPTURED SCHEMA IS USED AND SAID SO. Every answer
 * carries `schemaProvenance`, so a board priced against a four-day-old field map
 * can always be told from one priced against AIM's live one. Silently falling
 * back is how a renamed option becomes a wrong price.
 */
async function schemaFor(groupId, { force = false } = {}) {
  const gid = String(groupId);
  const hit = _schema.get(gid);
  if (!force && hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit;

  try {
    const session = await getSession();
    const r = await req(`/api/qp/api/v1/extended/program-groups/${gid}`, { cookies: session.cookies });
    if (r.status === 401) {
      const retry = await getSession({ force: true });
      const r2 = await req(`/api/qp/api/v1/extended/program-groups/${gid}`, { cookies: retry.cookies });
      if (r2.status === 200 && r2.json && Array.isArray(r2.json.data)) {
        const v = { fields: r2.json.data, at: Date.now(), provenance: 'live' };
        _schema.set(gid, v); return v;
      }
    } else if (r.status === 200 && r.json && Array.isArray(r.json.data)) {
      const v = { fields: r.json.data, at: Date.now(), provenance: 'live' };
      _schema.set(gid, v); return v;
    }
  } catch { /* fall through to the captured schema, which SAYS it is captured */ }

  const cap = S.schemaFor(gid, null);
  return { fields: cap.fields, at: Date.now(), provenance: cap.provenance };
}

/**
 * Price one scenario.
 *
 * THE THREE REFUSALS ARE KEPT APART, because they are different problems:
 *   422 — a value outside AIM's published interval. Ours to prevent; the
 *         scenario builder catches most before the call.
 *   400 — legal values, but a rule blocks them, AND AIM NAMES THE FIELDS. This
 *         is a real disqualify reason and is returned as one.
 *   200 with an EMPTY array — nothing fits and AIM says nothing about why. The
 *         board carries a note; a 200 is never assumed to mean a price.
 */
async function price(sc = {}, opts = {}) {
  const groupId = opts.groupId || S.DSCR_GROUP;
  const schema = await schemaFor(groupId, { force: opts.forceSchema === true });
  if (!schema.fields.length) throw new Error('admortgage_no_schema');

  const built = scenario.buildParams(sc, schema.fields, opts);
  if (built.problems.length) {
    const err = new Error('admortgage_scenario_rejected');
    err.problems = built.problems;
    err.effective = built.effective;
    throw err;
  }

  const query = scenario.toQuery(built.params);
  const path = `/api/qp/api/v1/extended/program-groups/${groupId}/calculate?${query}`;
  const session = await getSession();
  let r = await req(path, { cookies: session.cookies });
  if (r.status === 401) {
    const retry = await getSession({ force: true });
    r = await req(path, { cookies: retry.cookies });
  }

  const ctx = {
    lockDays: built.effective.lockDays === '15 Days' ? 15
      : built.effective.lockDays === '45 Days' ? 45
        : built.effective.lockDays === '60 Days' ? 60 : 30,
    dscr: built.effective.dscrRatio == null ? null : built.effective.dscrRatio,
    termMonths: built.effective.term === '40 Year Fixed' ? 480 : 360,
    io: built.effective.io === true,
  };

  if (r.status === 400) {
    return {
      board: { source: 'admortgage', programCount: 0, lenderCount: 0, rungCount: 0, programs: [], notes: ['refused_with_reason'] },
      refusal: parseRefusal(r.json), status: 400,
      schemaProvenance: schema.provenance, effective: built.effective, groupId,
    };
  }
  if (r.status === 422) {
    const err = new Error('admortgage_validation_rejected');
    err.problems = (r.json && r.json.errors) || null;
    err.effective = built.effective;
    throw err;
  }
  if (r.status !== 200) throw new Error(`admortgage_http_${r.status}:${scrub(r.text).slice(0, 200)}`);

  return {
    board: parse(r.json, ctx),
    refusal: null, status: 200,
    schemaProvenance: schema.provenance, effective: built.effective, groupId,
  };
}

/** Up? Configured? Never attempts a login. */
function health() {
  return {
    configured: configured(),
    base: API_BASE,
    hasSession: fresh(_session),
    account: _session ? _session.account : null,
    schemaGroupsCached: [..._schema.keys()],
  };
}

/** Actually log in and report what came back — for diagnostics, not for pricing. */
async function loginCheck() {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  try {
    const s = await getSession({ force: true });
    const st = await req('/api/user/auth-state', { cookies: s.cookies });
    const d = (st.json && st.json.data) || {};
    return {
      ok: true,
      account: s.account,
      status: d.status || null,
      userType: d.userType || null,
      // Surfaced deliberately: it does NOT block the API, but a human should act on it.
      passwordExpired: d.passwordExpired === true,
      businessChannels: d.businessChannels || null,
    };
  } catch (e) { return { ok: false, reason: scrub(e.message) }; }
}

function resetForTests() { _session = null; _schema = new Map(); _inflight = null; }

module.exports = { price, health, loginCheck, schemaFor, configured, resetForTests, _internals: { scrub, login, assertAllowed } };
