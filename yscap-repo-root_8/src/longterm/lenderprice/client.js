'use strict';
/**
 * LENDER PRICE (Digital Lending PPE) BACKEND CLIENT — Long-Term DSCR pricing.
 *
 * WHAT THIS IS
 *   The "pricing agent" from docs/architecture-blueprint.html: our own backend logs into
 *   Lender Price once, keeps ONE warm token, and drives the same internal calls the
 *   yscapgroup.digitallending.com web app makes — login → enrich a zip → price → parse.
 *   It is a pricing VIEWER: it reads pricing and never books, locks, registers, or touches
 *   favorites (the three hard "never"s in the blueprint).
 *
 * WHY THE LOGIN WAS BEING REJECTED (root cause, confirmed 2026-08-16 from two live logins)
 *   The browser authenticates TWO parties at /oauth/token: the borrower in the form body,
 *   and the OAuth client with HTTP Basic auth (LP_CLIENT_ID:LP_CLIENT_SECRET). The original
 *   backend omitted the Basic header, so correct borrower credentials still returned 401.
 *   Origin/Referer and the form body also mirror the company page exactly.
 *
 * SAFETY, by construction:
 *   - LONG-TERM ONLY. Self-contained: reads process.env directly, imports NO RTL code,
 *     touches no database. (Product-separation gate: nothing crosses.)
 *   - Credentials come from Render env ONLY (LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET). Never hardcoded,
 *     never logged, never returned to a caller. scrub() strips tokens/passwords from errors.
 *   - Every outbound URL is https + host-allowlisted (auth./api.digitallending.com). No SSRF.
 *   - Read-only: only GET enrichment + POST pricing/searchRaw. No write/lock/register path
 *     exists in this module, so "we corrupted something in Lender Price" is off the table.
 *   - Fails CLOSED: on any uncertainty it returns { ok:false, error, message } and never
 *     throws to the caller; a bad login simply yields no token.
 *
 * TOKEN MODEL (blueprint §02 — nobody gets bumped)
 *   One shared service login, one warm bearer token refreshed a little early behind a
 *   single-flight lock, so N concurrent price requests trigger at most one login. The
 *   pricing call is stateless (each search independent), so concurrent searches don't
 *   collide. If Lender Price ever enforces one-token-per-account under load, swap the
 *   single token holder for a small pool behind the same manager — no caller changes.
 */

const crypto = require('crypto');
const { buildSearch, validateScenario, smoRegistryFromList, _internals: searchModelInternals } = require('./search-model');
// Durable L2 for the disqualify (ineligible) workflow (db/559) — best-effort; the in-memory Map
// below stays the L1 cache, this survives a reboot / deploy / instance-move. Every call degrades to
// in-memory-only on any DB error, so the pricing path never hard-depends on it.
const disqStore = require('./disqualify-store');
const sharedMapPurpose = searchModelInternals.mapPurpose;

// The RAW-PAYLOAD SINK. Inert unless LP_CAPTURE_DIR names a directory, and structurally unable to
// capture the token exchange (see capture.js). Every call below is best-effort by contract — a
// capture failure may never change what a caller gets back.
const rawCapture = require('./capture');

const AUTH_BASE = (process.env.LP_AUTH_BASE || 'https://auth.digitallending.com').replace(/\/+$/, '');
const API_BASE = (process.env.LP_API_BASE || 'https://api.digitallending.com').replace(/\/+$/, '');
const ORIGIN = (process.env.LP_ORIGIN || 'https://yscapgroup.digitallending.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.LP_CLIENT_ID || 'acme2';
// A MISCONFIGURED ENV MUST NEVER SILENTLY DISABLE A BOUND. `Number('15m')` is NaN, and every
// comparison against NaN is false — so a knob typed with a unit suffix does not fall back to its
// default, it turns the bound OFF, with nothing anywhere saying so. The pre-merge audit found this
// on the refresh backoff (a NaN window read as "not blocked", so the grant was retried before every
// renewal forever while the diagnostics reported no window open); it is the same class on every
// numeric knob in this file, so it is fixed once, here. Same shape as search-model's `envRatio`.
function envMs(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  // `>= 0`, NOT `> 0`: the NaN bug needed only `Number.isFinite`, and demanding a positive value
  // silently turns a knob's natural OFF value back ON. LP_RECOVERY_MAX=0 is an operator disabling the
  // 500-recovery during an incident; LP_DISQUALIFY_MAX_WAIT_MS=0 and LP_FOUNDATION_TTL_MS=0 are both
  // documented 'do not wait / do not cache' settings. Re-enabling what somebody just turned off is
  // the silent-substitution class this connector exists to refuse.
  return (Number.isFinite(n) && n >= 0) ? n : dflt;
}
const TIMEOUT_MS = envMs('LP_TIMEOUT_MS', 60000);
// The disqualify poll's READY response is very large (~111 MB — the full failing-lender/rule tree),
// so downloading + parsing it needs far longer than an ordinary price call. A still-computing poll
// returns an empty body and comes back fast, so this longer timeout only ever applies to the ready one.
const DISQUALIFY_TIMEOUT_MS = envMs('LP_DISQUALIFY_TIMEOUT_MS', 240000);
const REFRESH_EARLY_MS = envMs('LP_REFRESH_EARLY_MS', 5 * 60 * 1000); // refresh 5 min early
const UA = process.env.LP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

// ---- host allowlist (no SSRF) ---------------------------------------------
const ALLOWED_HOSTS = new Set([
  hostOf(AUTH_BASE), hostOf(API_BASE),
]);
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }
function assertAllowed(url) {
  let u; try { u = new URL(url); } catch { throw new Error('lp_bad_url'); }
  if (u.protocol !== 'https:') throw new Error('lp_insecure_url');
  if (!ALLOWED_HOSTS.has(u.host.toLowerCase())) throw new Error(`lp_host_not_allowed:${u.host}`);
  return u;
}

// ---- credentials (env only; never printed) --------------------------------
function credentials() {
  const username = process.env.LP_USERNAME || '';
  const password = process.env.LP_PASSWORD || '';
  const clientSecret = process.env.LP_CLIENT_SECRET || '';
  return { username, password, clientSecret, ok: !!(username && password && clientSecret) };
}
function configured() { return credentials().ok; }

// Strip any secret that might slip into an error string.
function scrub(s) {
  let out = String(s == null ? '' : s);
  const { password, clientSecret } = credentials();
  if (password) out = out.split(password).join('<redacted>');
  if (clientSecret) out = out.split(clientSecret).join('<redacted>');
  out = out.replace(/(access_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
  out = out.replace(/(refresh_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
  out = out.replace(/(Bearer )[A-Za-z0-9._\-]+/g, '$1<redacted>');
  out = out.replace(/(password=)[^&\s"]+/gi, '$1<redacted>');
  return out;
}

// Read a message off ANYTHING that was thrown. `e.message` alone throws its own TypeError on a
// non-object (`throw undefined` / `throw 'boom'`), which turns a handled upstream failure into an
// exception escaping the one function whose contract is that it never throws.
function errText(e) {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  return String((e && e.message) || e);
}
function basicClientAuthorization(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

// ---- fetch with timeout, browser-shaped headers ---------------------------
async function req(url, { method = 'GET', headers = {}, body = null, bearer = null, timeoutMs = TIMEOUT_MS } = {}) {
  const u = assertAllowed(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const h = {
    Accept: 'application/json, text/plain, */*',
    Origin: ORIGIN,
    Referer: ORIGIN + '/',
    'User-Agent': UA,
    ...headers,
  };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  try {
    const res = await fetch(u.toString(), { method, headers: h, body, redirect: 'manual', signal: ac.signal });
    const text = await res.text().catch(() => '');
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}

// ---- OAuth2 password-grant login ------------------------------------------
// POST auth/oauth/token  (application/x-www-form-urlencoded)
//   username, password, grant_type=password, client_id + Basic client auth + company Origin/Referer.
// Returns { ok, token, refreshToken, expiresAt, companyId, userId, profile } or { ok:false, error, message }.
async function login() {
  const c = credentials();
  if (!c.ok) return { ok: false, error: 'lp_creds_missing', message: 'Set LP_USERNAME, LP_PASSWORD, and LP_CLIENT_SECRET in Render to enable Lender Price pricing.' };
  const form = new URLSearchParams({
    username: c.username, password: c.password, grant_type: 'password', client_id: CLIENT_ID,
  }).toString();
  let r;
  try {
    r = await req(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Authorization: basicClientAuthorization(CLIENT_ID, c.clientSecret),
      },
      body: form,
    });
  } catch (e) { return { ok: false, error: 'lp_login_error', message: scrub(errText(e)) }; }

  if (r.status === 401) {
    return { ok: false, error: 'lp_login_unauthorized', http: 401,
      message: 'Lender Price rejected the login. Check LP_USERNAME, LP_PASSWORD, LP_CLIENT_SECRET, LP_CLIENT_ID, and LP_ORIGIN.' };
  }
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    return { ok: false, error: 'lp_login_failed', http: r.status,
      message: `Lender Price login returned ${r.status}.`, bodyPreview: scrub((r.text || '').slice(0, 200)) };
  }
  return sessionFromTokenBody(r.json);
}

// PURE — ONE definition of how an OAuth token body becomes a session, shared by the password login
// and the refresh-grant renewal below. Two bodies for the same account must never become two
// differently-shaped sessions: everything downstream reads `token` / `expiresAt` / `companyId`, and
// a renewal that quietly dropped one of them would break pricing only on the SECOND hour of uptime.
//
// `lifetimeMs` fails SAFE rather than trusting the wire: a non-numeric `expires_in` would make
// `expiresAt` NaN, `_fresh()` false forever, and every single request perform its own login — a
// login storm caused by one malformed field. An unreadable lifetime falls back to the vendor's
// ordinary hour.
function lifetimeMs(v, fallbackSec) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? n : fallbackSec) * 1000;
}
function sessionFromTokenBody(b, { now = Date.now() } = {}) {
  const refreshSec = Number(b.refresh_expires_in);
  return {
    ok: true,
    token: b.access_token,
    refreshToken: b.refresh_token || null,
    expiresAt: now + lifetimeMs(b.expires_in, 3599),
    // Optional in the spec and not confirmed for this vendor — null means "unknown", which
    // renewalPlan treats as "worth trying", never as "expired".
    refreshExpiresAt: Number.isFinite(refreshSec) && refreshSec > 0 ? now + refreshSec * 1000 : null,
    companyId: b.companyId || process.env.LP_COMPANY_ID || null,
    userId: b.userId || process.env.LP_USER_ID || null,
    profile: {
      email: b.email || null,
      companyNmlsId: b.companyNmlsId || null,
      loanOfficerNmlsId: b.loanOfficerNmlsId || null,
      person: b.person || null,
    },
  };
}

// ---- OAuth2 refresh-token renewal -----------------------------------------
// §37.3 — the login response has always CARRIED a refresh token and we have never once used it:
// every renewal replayed the account password. That is the standing developer instruction:
//   "access token approaching expiration → try grant_type=refresh_token → store replacement access
//    token AND replacement refresh token → if refresh is rejected, perform one password login."
//
// THIS IS BUILT FAIL-SAFE BY CONSTRUCTION, which is what makes it shippable before the vendor has
// confirmed the grant: EVERY failure path — a 400, a 401, an unparseable body, a network throw —
// falls through to the password login that has always run here. So the worst case is one wasted
// round trip, never a lost session. And because a vendor that does not support the grant would
// otherwise cost that wasted round trip before every renewal FOREVER, a rejection also opens a
// backoff window (below) so the client stops asking for a while.
//
// The returned access token is OUTPUT, never configuration: it is held in memory for its hour and
// replaced. Nothing here reads a token from a browser, a request header, or an env var — the only
// inputs are the Render-held service credentials and the refresh token the vendor itself issued.
const REFRESH_GRANT_BACKOFF_MS = envMs('LP_REFRESH_BACKOFF_MS', 15 * 60 * 1000);
const REFRESH_GRANT_BACKOFF_MAX_MS = envMs('LP_REFRESH_BACKOFF_MAX_MS', 24 * 60 * 60 * 1000);

// PURE — how long to stop asking for the refresh grant after N CONSECUTIVE rejections.
//
// THE FIRST CUT OF THIS WAS DEAD CODE and the suite caught it: a rejection opened the window and the
// password login that immediately followed — the fall-through, which always succeeds — cleared it,
// so the backoff never once applied. The window has to survive its own fallback to mean anything.
//
// It ESCALATES because one rejection cannot tell the two causes apart, and they want opposite
// treatment. A refresh token that is merely SPENT or revoked (a password change) is a one-off: the
// fallback login issues a new one, the next renewal falls outside the short first window, the grant
// succeeds and the counter resets to zero — total cost, one wasted round trip. A vendor that does not
// SUPPORT the grant at all rejects every time, so the window doubles each renewal (15m, 30m, 1h … to
// a day) and the client settles at asking about once a day instead of once an hour, forever. Neither
// case ever loses a session: the password login runs either way.
function refreshBackoffMs(consecutiveRejections) {
  const n = Math.max(1, Math.floor(Number(consecutiveRejections) || 1));
  const ms = REFRESH_GRANT_BACKOFF_MS * Math.pow(2, Math.min(n - 1, 20));
  return Math.min(ms, REFRESH_GRANT_BACKOFF_MAX_MS);
}
async function refreshSession(refreshToken) {
  const c = credentials();
  if (!c.ok) return { ok: false, error: 'lp_creds_missing', message: 'Set LP_USERNAME, LP_PASSWORD, and LP_CLIENT_SECRET in Render to enable Lender Price pricing.' };
  if (!refreshToken) return { ok: false, error: 'lp_refresh_missing', message: 'No refresh token to renew with.' };
  const form = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID,
  }).toString();
  let r;
  try {
    r = await req(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Authorization: basicClientAuthorization(CLIENT_ID, c.clientSecret),
      },
      body: form,
    });
  } catch (e) { return { ok: false, error: 'lp_refresh_error', message: scrub(errText(e)) }; }

  // 400 invalid_grant is the ORDINARY way an OAuth server says "that refresh token is spent or
  // revoked" — it is not an outage, and it is exactly the case the password fallback exists for.
  if (r.status === 400 || r.status === 401) {
    return { ok: false, error: 'lp_refresh_rejected', http: r.status, rejected: true,
      message: `Lender Price refused the refresh token (${r.status}); falling back to a password login.` };
  }
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    return { ok: false, error: 'lp_refresh_failed', http: r.status,
      message: `Lender Price refresh returned ${r.status}.`, bodyPreview: scrub((r.text || '').slice(0, 200)) };
  }
  return sessionFromTokenBody(r.json);
}

// PURE — MERGE a refreshed token onto the session it renewed.
//
// A refresh response is a TOKEN response, not a LOGIN response: RFC 6749 makes `refresh_token`
// itself OPTIONAL in it, and this vendor's refresh body has not been observed at all, so it may
// carry none of the identity fields the password login returns. `companyId` is the one that bites —
// every foundation fetch (defaultSearch + SMO) is keyed on it, so a renewal that took the fresh body
// wholesale would leave a perfectly valid token with no company, and pricing would fall back to the
// static capture an hour into every deployment. So: the fresh ACCESS TOKEN always wins; anything the
// refresh did not restate is carried over from the session being renewed.
function mergeRefreshed(prev, fresh) {
  const p = prev || {};
  return {
    ...fresh,
    refreshToken: fresh.refreshToken || p.refreshToken || null,
    refreshExpiresAt: fresh.refreshExpiresAt != null ? fresh.refreshExpiresAt : (p.refreshExpiresAt != null ? p.refreshExpiresAt : null),
    companyId: fresh.companyId || p.companyId || null,
    userId: fresh.userId || p.userId || null,
    profile: (fresh.profile && (fresh.profile.email || fresh.profile.person)) ? fresh.profile : (p.profile || fresh.profile || null),
    renewedBy: 'refresh',
  };
}

// PURE — WHICH grant to renew with. Split out from the IO for the standing reason: `getSession`
// calls its collaborators as LOCAL functions, so a require-cache stub silently does nothing and a
// test written against the wrapper would exercise a different branch while appearing to pass.
// Returns { action: 'refresh' | 'login', reason }. Fails toward `login`, which is the path that has
// always worked, so an unreadable session state can never leave the client unable to authenticate.
function renewalPlan(session, { now = Date.now(), refreshBlockedUntil = 0 } = {}) {
  if (!session || !session.ok) return { action: 'login', reason: 'no_session' };
  if (!session.refreshToken) return { action: 'login', reason: 'no_refresh_token' };
  if (refreshBlockedUntil > now) return { action: 'login', reason: 'refresh_backoff' };
  // Only a refresh lifetime the vendor STATED can rule the grant out; an unknown one is tried.
  if (session.refreshExpiresAt != null && session.refreshExpiresAt <= now) {
    return { action: 'login', reason: 'refresh_expired' };
  }
  return { action: 'refresh', reason: 'refresh_available' };
}

// ---- token manager: one warm token, single-flight refresh -----------------
let _session = null;            // last successful login/renewal result
let _inflight = null;           // a renewal Promise currently resolving (single-flight)
let _refreshBlockedUntil = 0;   // set when the vendor rejects the refresh grant (see above)
let _refreshRejections = 0;     // CONSECUTIVE rejections; zeroed by a successful refresh
let _lastRenewal = null;        // { at, action, reason, ok, fellBack } — diagnostics ONLY, never a token

function _fresh(s) { return s && s.ok && s.token && s.expiresAt - REFRESH_EARLY_MS > Date.now(); }

async function getSession({ force = false } = {}) {
  if (!force && _fresh(_session)) return _session;
  // A FORCED renewal must NOT adopt one already in flight. While every renewal was a password login
  // that was harmless; now an in-flight renewal can be a REFRESH of the very session the caller just
  // invalidated — and that refresh re-installs it, undoing invalidateSession(). The 500-recovery is
  // built on exactly that sequence ("log in fresh"), so under load — which is when upstream 500s
  // cluster — it would burn a breaker slot and retry with the stale session it meant to discard.
  // Reproduced by the re-audit. An unforced caller still joins the in-flight renewal.
  if (_inflight && !force) return _inflight;
  _inflight = (async () => {
    const prev = _session;
    const plan = renewalPlan(prev, { now: Date.now(), refreshBlockedUntil: _refreshBlockedUntil });
    let fellBack = null;
    if (plan.action === 'refresh') {
      const rr = await refreshSession(prev.refreshToken);
      if (rr.ok) {
        _session = mergeRefreshed(prev, rr);
        _refreshRejections = 0;      // the grant works; forget any history
        _refreshBlockedUntil = 0;
        _lastRenewal = { at: Date.now(), action: 'refresh', reason: plan.reason, ok: true, fellBack: null };
        return _session;
      }
      // FAIL-SAFE: any refresh failure falls through to the password login. A REJECTION additionally
      // opens an escalating backoff window so a vendor that does not honour the grant is not asked
      // before every renewal forever; a transient error (network, 5xx) does NOT, because the grant
      // may be perfectly fine. The window deliberately SURVIVES the fallback login below — clearing
      // it there is what made the first cut of this dead code.
      if (rr.rejected) {
        _refreshRejections += 1;
        _refreshBlockedUntil = Date.now() + refreshBackoffMs(_refreshRejections);
      }
      fellBack = rr.error;
    }
    const s = await login();
    if (s.ok) {
      s.renewedBy = 'password';
      _session = s;
    }
    _lastRenewal = { at: Date.now(), action: 'login', reason: plan.reason, ok: !!s.ok, fellBack };
    return s;
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

// PURE — WHOSE FAULT IS AN UPSTREAM 500? Reading the vendor's error body, so the next person does
// not spend an hour establishing what live probing established on 2026-08-16.
//
// Lender Price's pricing service answers a 500 in two distinguishable shapes, and they mean
// opposite things about what to do next:
//
//   * a bare STATUS CODE where a sentence belongs (message: "500 "). That is what a service
//     produces when a call IT made downstream returned 500 and it stringified the status. Measured:
//     this is returned for a well-formed body AND for Lender Price's OWN defaultSearch model posted
//     back to them completely unchanged — so it cannot be our payload. No retry helps; it is theirs.
//   * anything else — e.g. "null cannot be cast to non-null type ...ObjectNode", returned for an
//     empty object — is their parser reading OUR request and objecting to it. That one IS ours, and
//     it names the problem.
//
// The distinction matters because the two look identical in a log ("searchRaw -> 500") while one is
// an outage to escalate and the other is a bug to fix. REPORTED, NEVER ACTED ON: this only changes
// what we SAY, never whether we retry, so a vendor who starts writing better messages tomorrow
// cannot break pricing.
function classifyUpstreamError(status, body) {
  const text = typeof body === 'string' ? body : (body == null ? '' : JSON.stringify(body));
  let msg = null;
  try { const j = JSON.parse(text); if (j && typeof j.message === 'string') msg = j.message; } catch { /* not JSON */ }
  if (status === 500 && msg != null && /^\s*\d{3}\s*$/.test(msg)) {
    return {
      kind: 'vendor_downstream',
      message: 'Lender Price\'s pricing service returned an internal error with no reason given (their body carries a bare status code where a message belongs, which is what a service returns when a call IT made failed). This is NOT our request: their own defaultSearch model, posted back unchanged, fails the same way. Nothing on our side fixes it — it needs raising with Lender Price.',
    };
  }
  // A NAMED configuration problem is neither an outage nor a malformed request: it is a setup step
  // a human performs at Lender Price. Measured verbatim on 2026-08-16 once the correct PPE user id
  // was sent. Telling the two apart is the difference between chasing a vendor about an outage and
  // asking them to finish an account.
  if (status === 500 && msg && /not setup|not set up|not configured|configuration/i.test(msg)) {
    return { kind: 'vendor_not_configured',
      message: 'Lender Price answered: "' + String(msg).slice(0, 160) + '". This is a setup step on their side for this loan officer / company — the request itself was understood. It needs completing in Lender Price before pricing can return anything.' };
  }
  if (status === 500 && msg) {
    return { kind: 'request_rejected', message: 'Lender Price rejected the request while reading it: ' + String(msg).slice(0, 200) };
  }
  return { kind: 'unknown', message: null };
}

// A 401 MEANS THE TOKEN WAS REJECTED — CLEAR IT AND LOG IN WITH THE PASSWORD.
//
// The developer's verified instruction is explicit and is a DIFFERENT path from the proactive
// renewal: "On 401, clear it, log in again, and retry once." Both of their rules now hold, each on
// its own path:
//   • approaching EXPIRY (getSession's ordinary renewal) → try grant_type=refresh_token first,
//     falling back to a password login if it is refused. That is §37.3.
//   • a 401 from the API → this. The session is DISCARDED first, so renewalPlan sees no session and
//     resolves to a password login.
//
// Why not simply force a renewal: with a session still in hand the ladder would try the REFRESH
// grant, and a 401 is precisely the state in which the whole session may have been invalidated
// upstream — in which case the refresh token is dead too and the attempt is a wasted round trip in
// front of the recovery, on the request a user is waiting for. Clearing first is also what the
// upstream-500 recovery already does, so "start over" has one meaning in this file.
function reauthenticate() {
  invalidateSession();
  return getSession({ force: true });
}

// A single authenticated GET against the API host, re-logging in once on a 401.
async function apiGet(path, { retryOn401 = true } = {}) {
  const s = await getSession();
  if (!s.ok) return { ok: false, ...s };
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  let r;
  try { r = await req(url, { method: 'GET', bearer: s.token }); }
  catch (e) { return { ok: false, error: 'lp_get_error', message: scrub(errText(e)) }; }
  if (r.status === 401 && retryOn401) {
    const s2 = await reauthenticate();
    if (!s2.ok) return { ok: false, ...s2 };
    try { r = await req(url, { method: 'GET', bearer: s2.token }); }
    catch (e) { return { ok: false, error: 'lp_get_error', message: scrub(errText(e)) }; }
  }
  if (r.status !== 200) return { ok: false, error: 'lp_get_status', http: r.status, message: `GET ${path} → ${r.status}`, body: scrub((r.text || '').slice(0, 300)) };
  return { ok: true, data: r.json != null ? r.json : r.text };
}

// ---- enrichment (blueprint step 3): zip → county / limits / AMI ------------
// These are the confirmed lookup endpoints seen in the login HAR. companyId/userId come
// from the session. All read-only.
async function enrichZip(zip, { loanAmount = 0, units = 1 } = {}) {
  const s = await getSession();
  if (!s.ok) return { ok: false, ...s };
  const out = { ok: true, zip: String(zip) };
  // Conforming/limit lookup by zip (public pricing path; units + loanAmount as the app sends).
  const lim = await apiGet(`/rest/v1/lp-ppe-integration/pricing/mortgageLimitByZip/1/${encodeURIComponent(zip)}/${encodeURIComponent(units)}/${encodeURIComponent(Math.round(loanAmount) || 0)}`);
  if (lim.ok) out.mortgageLimit = lim.data;
  return out;
}

// ---- canonical pricing foundation (blueprint step 4): defaultSearch + smo --
// The Lender Price web app never hand-builds a search: it GETs the company's full default
// search model and its special-mortgage-option registry, then overlays only the scenario.
// We do the same — but every fetch FALLS BACK to the captured static model / built-in ids,
// so an unavailable (or differently-pathed) endpoint degrades to the proven defaults instead
// of breaking pricing. Paths are env-overridable because they are not confirmed from a capture.
// §26.2: the frontend GETs these WITHOUT path params — the earlier `/{companyId}/{userId}`
// suffixes 404'd every live fetch and pinned the foundation to the static fallback forever.
// fillPath is a no-op when a path carries no placeholders, so an env override MAY still add them.
const DEFAULTSEARCH_PATH = process.env.LP_DEFAULTSEARCH_PATH || '/rest/v1/lp-ppe-integration/pricing/defaultSearch';
const SMO_PATH = process.env.LP_SMO_PATH || '/rest/v1/lp-ppe-integration/pricing/smo';
let _defaultSearch = null;   // { at, model, source, error } — source 'live'|'fallback', error is the live-fetch reason when it fell back
let _smoRegistry = null;     // { at, map, source, error }
const FOUNDATION_TTL_MS = envMs('LP_FOUNDATION_TTL_MS', 30 * 60 * 1000);

// ---- upstream-500 recovery: re-login + refetch + retry ONCE, with a breaker --
// Lender Price sometimes represents a stale/unusable backend session (or a lost live-config fetch)
// as an HTTP 500 on searchRaw rather than a 401. postSearchRaw only re-logs in on a 401, so a 500
// used to be returned straight to the caller (the audit's "all four fixtures returned upstream 500"
// regression). On a 500 we invalidate the cached session + live-config cache, log in fresh, refetch
// the live base/SMO, rebuild the body ONCE, and retry exactly ONCE. A 4xx is a deterministic
// request-validation error and is NEVER retried (it would loop and hide the real reason). A breaker
// caps 500-triggered relogins per window so repeated 500s can't cause a login storm.
const RECOVERY_WINDOW_MS = envMs('LP_RECOVERY_WINDOW_MS', 60000);
const RECOVERY_MAX = envMs('LP_RECOVERY_MAX', 3);
let _recoveryTimes = [];
function breakerOpen() {
  const now = Date.now();
  _recoveryTimes = _recoveryTimes.filter((t) => now - t < RECOVERY_WINDOW_MS);
  return _recoveryTimes.length >= RECOVERY_MAX;
}
function recordRecovery() { _recoveryTimes.push(Date.now()); }
function invalidateSession() { _session = null; }
// Deliberately NOT resetting `_refreshBlockedUntil`: invalidateSession is the 500-recovery path, and
// clearing the backoff there would re-arm the wasted rejected-refresh round trip on every upstream
// 500. A successful password login clears it instead — that is when a fresh refresh token exists.

// Auth diagnostics for the health card (§37.4). NEVER carries a token, a refresh token, or any
// credential — only which grant last renewed the session and whether the refresh grant is in backoff.
function authDiagnostics() {
  return {
    renewedBy: (_session && _session.renewedBy) || null,
    hasRefreshToken: !!(_session && _session.refreshToken),
    refreshBackoff: _refreshBlockedUntil > Date.now() ? new Date(_refreshBlockedUntil).toISOString() : null,
    refreshRejections: _refreshRejections,
    lastRenewal: _lastRenewal ? { ...(_lastRenewal), at: new Date(_lastRenewal.at).toISOString() } : null,
  };
}
// TEST SEAM ONLY — clears every piece of token state so a suite can drive the renewal ladder from a
// known start. Never call this from production code: it discards a live single-flight promise.
function resetTokenState() { _session = null; _inflight = null; _refreshBlockedUntil = 0; _refreshRejections = 0; _lastRenewal = null; }
// TEST SEAM ONLY — stand in for the clock reaching the end of the backoff window WITHOUT resetting
// the rejection history, so a suite can prove the grant is retried afterwards. Production never
// shortens a window it opened.
function expireRefreshBackoff() { _refreshBlockedUntil = 0; }
function invalidateFoundation() { _defaultSearch = null; _smoRegistry = null; _ppeUser = null; }
// §28.2 — in production the owner can REQUIRE a live pricing foundation: when LP_REQUIRE_LIVE_FOUNDATION
// is set, a searchRaw whose base/SMO resolved to the STATIC FALLBACK (e.g. the live endpoints 404) is
// REFUSED with a named 502 instead of silently pricing on stale configuration. Default off, so a dev
// run / the static base still works; the owner turns it on only after confirming base/smo report live.
function requireLiveFoundation() { const v = process.env.LP_REQUIRE_LIVE_FOUNDATION; return v === '1' || v === 'true'; }
function foundationLiveGate(f) {
  if (!requireLiveFoundation()) return null;
  const prov = foundationProvenance(f);
  if (prov.base === 'live' && prov.smo === 'live') return null;
  return { ok: false, error: 'lp_foundation_not_live', http: 502,
    message: 'Live Lender Price pricing configuration is unavailable (the search is running on the static fallback). Refusing to price on stale configuration; check the defaultSearch/smo endpoints.',
    provenance: prov, foundation: f };
}
// Live-vs-fallback provenance for a resolved foundation (diagnostics; never logs credentials).
function foundationProvenance(f) {
  return {
    base: (f && f.baseSource) || 'fallback', smo: (f && f.smoSource) || 'fallback',
    baseError: (f && f.baseError) || null, smoError: (f && f.smoError) || null,
  };
}

function fillPath(tpl, companyId, userId) {
  return tpl.replace('{companyId}', encodeURIComponent(companyId || '')).replace('{userId}', encodeURIComponent(userId || ''));
}

// Fetch (and cache) the company's live default search model. Returns the model or null.
async function fetchDefaultSearch(companyId, userId) {
  if (_defaultSearch && Date.now() - _defaultSearch.at < FOUNDATION_TTL_MS) return _defaultSearch.model;
  let model = null, source = 'fallback', error = null;
  try {
    const r = await apiGet(fillPath(DEFAULTSEARCH_PATH, companyId, userId));
    // A usable default search is an object carrying a criteria block (the shape searchRaw expects).
    if (r.ok && r.data && typeof r.data === 'object' && (r.data.criteria || (r.data.search && r.data.search.raw))) {
      model = r.data.criteria ? r.data : (r.data.search && r.data.search.raw) || null;
      if (model) source = 'live';
    }
    // Preserve WHY the live fetch didn't yield a usable model (do not silently turn it into undefined).
    if (!model) error = r.ok ? 'live default search returned an unusable shape' : `${r.error || 'lp_get_status'}${r.http ? ' ' + r.http : ''}`;
  } catch (e) { error = scrub(errText(e)); }
  _defaultSearch = { at: Date.now(), model, source, error };
  return model;
}

// Fetch (and cache) the company's live special-mortgage-option registry as a name→{id,name} Map.
async function fetchSmoRegistry(companyId) {
  if (_smoRegistry && Date.now() - _smoRegistry.at < FOUNDATION_TTL_MS) return _smoRegistry.map;
  let map = null, source = 'fallback', error = null;
  try {
    const r = await apiGet(fillPath(SMO_PATH, companyId));
    const list = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.data) ? r.data.data : (r.data && Array.isArray(r.data.smo) ? r.data.smo : null));
    if (r.ok && list && list.length) { map = smoRegistryFromList(list); if (map) source = 'live'; }
    if (!map) error = r.ok ? 'live SMO registry returned an unusable shape' : `${r.error || 'lp_get_status'}${r.http ? ' ' + r.http : ''}`;
  } catch (e) { error = scrub(errText(e)); }
  _smoRegistry = { at: Date.now(), map, source, error };
  return map;
}

// ---- pricing (blueprint step 5): POST searchRaw ---------------------------
// Endpoint (from README + architecture doc):
//   POST /rest/v1/lp-ppe-integration/pricing/searchRaw/{companyId}/{userId}
// Body is built by buildSearchPayload() from the decoded field mapping. Returns the full
// investor rate stack (a large nested tree). VERIFY the exact body against a live searchRaw
// on the first Render run — this module builds from the recordings' decoded mapping.
function sleep(ms) { return new Promise((rs) => setTimeout(rs, ms)); }

// THE PRICING PATH NEEDS THE *PPE* USER ID, WHICH IS NOT THE ONE THE LOGIN RETURNS.
//
// Discovered by live probing 2026-08-16, and it is the whole reason every price returned a bare,
// reasonless 500. There are TWO user identities behind this vendor: the login (the Digital Lending
// Platform) issues one, and the pricing engine (PPE) — a separate product the platform SSOs into —
// has its OWN, exposed by the platform's documented endpoint
// GET /rest/v1/loanofficer/{dlpUserId}/ppe-user-link. We had always put the LOGIN's id into the
// searchRaw path, so the pricing service looked up a loan officer that does not exist in it and a
// call behind it failed, which it relayed as `"message": "500 "` — a status code where a sentence
// belongs, and no way to tell it apart from an outage.
//
// With the RIGHT id the same request returns a REAL, actionable message: "Loan Officer Pricing
// Configuration not setup". That is a configuration item a human sets up at Lender Price, and being
// told it plainly is the difference between an hour of probing and a two-line email.
//
// FAILS SAFE: if the link cannot be resolved for any reason, pricing falls back to the login's own
// id — exactly what it did before — so a vendor outage on this lookup can never make things worse
// than they already were. Cached for the foundation's TTL because it changes only when an admin
// re-links a user.
const PPE_USER_LINK_PATH = process.env.LP_PPE_USER_LINK_PATH || '/rest/v1/loanofficer/{userId}/ppe-user-link';
let _ppeUser = null;   // { at, dlpUserId, ppeUserId, error }
async function fetchPpeUserId(dlpUserId) {
  if (_ppeUser && _ppeUser.dlpUserId === dlpUserId && Date.now() - _ppeUser.at < FOUNDATION_TTL_MS) return _ppeUser.ppeUserId;
  let ppeUserId = null, error = null;
  try {
    const r = await apiGet(PPE_USER_LINK_PATH.replace('{userId}', encodeURIComponent(dlpUserId)));
    const v = r.ok && r.data && typeof r.data === 'object' ? r.data.userId : null;
    if (typeof v === 'string' && v.trim()) ppeUserId = v.trim();
    else error = r.ok ? 'ppe-user-link returned no userId' : `${r.error || 'lp_get_status'}${r.http ? ' ' + r.http : ''}`;
  } catch (e) { error = scrub(errText(e)); }
  _ppeUser = { at: Date.now(), dlpUserId, ppeUserId, error };
  return ppeUserId;
}
function invalidatePpeUser() { _ppeUser = null; }

// Resolve the session + company/user ids + the live base/SMO foundation once. Shared by the
// qualified price() and the disqualify workflow so both build from the identical model.
async function priceFoundation({ force = false } = {}) {
  const s = await getSession({ force });
  if (!s.ok) return { ok: false, ...s };
  const companyId = s.companyId || process.env.LP_COMPANY_ID;
  const userId = s.userId || process.env.LP_USER_ID;
  if (!companyId || !userId) return { ok: false, error: 'lp_no_ids', message: 'Missing companyId/userId from the Lender Price session.' };
  const [liveBase, smoReg, ppeUserId] = await Promise.all([
    fetchDefaultSearch(companyId, userId), fetchSmoRegistry(companyId), fetchPpeUserId(userId),
  ]);
  // THE PRICING PATH USES THE LOGIN'S USER ID. PROVEN, AND DO NOT CHANGE IT AGAIN.
  //
  // A controlled live A/B test (2026-08-16, same token, same company, same payload, same minute):
  //   searchRaw/{companyId}/68e9a60f… (the LOGIN's id)     -> HTTP 200, 19 eligible programs
  //   searchRaw/{companyId}/68e9a4e5… (ppe-user-link's id) -> HTTP 500 'Loan Officer Pricing
  //                                                            Configuration not setup'
  // and the vendor's own frontend bundle calls searchRaw(userInfo.companyId, userInfo.userId, …)
  // and never calls ppe-user-link before pricing.
  //
  // I briefly substituted the ppe-user-link id here on the inference that a separate PPE identity
  // must own the pricing path. That inference MANUFACTURED the 'not setup' error: it is not a
  // statement about the account, it means 'no pricing configuration exists under the id you sent'.
  // The account is fully configured. `fetchPpeUserId` is kept because the mapping is real and
  // documented (findPpeLoanOfficerIdAndLinkId), but it must never choose the id for THIS endpoint.
  const pricingUserId = userId;
  const url = `${API_BASE}/rest/v1/lp-ppe-integration/pricing/searchRaw/${encodeURIComponent(companyId)}/${encodeURIComponent(pricingUserId)}`;
  return {
    ok: true, session: s, companyId, userId, url,
    pricingUserId, ppeUserId: ppeUserId || null,
    ppeUserError: (_ppeUser && _ppeUser.error) || null,
    liveBase: liveBase || undefined, smo: smoReg || undefined,
    // Live-vs-fallback provenance (+ the preserved live-fetch error) for diagnostics.
    baseSource: (_defaultSearch && _defaultSearch.source) || 'fallback',
    smoSource: (_smoRegistry && _smoRegistry.source) || 'fallback',
    baseError: (_defaultSearch && _defaultSearch.error) || null,
    smoError: (_smoRegistry && _smoRegistry.error) || null,
  };
}

// searchRaw with the upstream-500 recovery: build the body from the resolved foundation and POST it;
// on a 500, invalidate the session + live-config cache, re-login once, refetch, rebuild ONCE, retry
// ONCE. buildBody:(foundation)=>payload is called with whichever foundation is in force so the retry
// is built from the FRESH live base/SMO. Returns { ...postResult, foundation, request, recovered } on
// success, or a stable error carrying both upstream statuses + the live-vs-fallback provenance.
async function searchRawWithRecovery(buildBody, opts = {}) {
  const f1 = await priceFoundation();
  if (!f1.ok) return f1;
  const gate1 = foundationLiveGate(f1); // §28.2 — refuse to price on the static fallback in production
  if (gate1) return gate1;
  const body1 = buildBody(f1);
  const r1 = await postSearchRaw(f1.url, f1.session, body1, opts);
  if (r1.ok) return { ...r1, foundation: f1, request: body1, recovered: false };
  // Only a 500 is recoverable — a 4xx is deterministic request validation and must never be retried.
  if (r1.http !== 500) return { ...r1, foundation: f1, request: body1 };
  if (breakerOpen()) {
    return { ok: false, error: 'lp_price_500_circuit_open', http: 500,
      message: 'Repeated upstream 500s from Lender Price — the one-time re-login was skipped to avoid a login storm. Try again shortly.',
      upstream: r1.upstream || null, provenance: foundationProvenance(f1) };
  }
  recordRecovery();
  invalidateSession();
  invalidateFoundation();
  const f2 = await priceFoundation({ force: true });
  if (!f2.ok) return f2;
  const gate2 = foundationLiveGate(f2); // §28.2 — still on the fallback after re-login → refuse in prod
  if (gate2) return gate2;
  const body2 = buildBody(f2);
  const r2 = await postSearchRaw(f2.url, f2.session, body2, opts);
  if (r2.ok) return { ...r2, foundation: f2, request: body2, recovered: true };
  // Final failure — stable error with BOTH upstream statuses and the (refetched) provenance.
  //
  // THE VENDOR'S OWN DIAGNOSIS IS CARRIED THROUGH, not replaced by ours. The retry wrapper used to
  // overwrite the message with 'returned 500 before and after a fresh login', which is TRUE and
  // useless: it describes what we did rather than what they said. When their answer names the
  // problem — 'Loan Officer Pricing Configuration not setup' — that sentence is the entire fix, and
  // burying it under our retry narrative is how a two-line email becomes an hour of probing.
  const why = r2.fault && r2.fault !== 'unknown' ? r2 : (r1.fault && r1.fault !== 'unknown' ? r1 : null);
  return {
    ok: false, error: 'lp_price_500_after_retry', http: r2.http || 500,
    message: why
      ? why.message + ' (unchanged after a fresh login and a live-config refetch, so it is not a stale session.)'
      : 'Lender Price searchRaw returned 500 both before and after a fresh login + live-config refetch.',
    fault: (why && why.fault) || 'unknown',
    firstHttp: r1.http || null, retryHttp: r2.http || null,
    upstream: r2.upstream || r1.upstream || null,
    provenance: foundationProvenance(f2),
  };
}

// POST one searchRaw body (with a single 401 re-login retry). Returns { ok, http, raw, empty }.
// `empty` marks an ACCEPTED-but-empty body — how Lender Price answers "the async result isn't
// cached yet" during the disqualify poll.
async function postSearchRaw(url, session, payload, opts = {}) {
  let s = session;
  let r;
  const reqOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  if (opts.timeoutMs) reqOpts.timeoutMs = opts.timeoutMs; // the disqualify poll returns a ~111 MB body — allow more time to download + parse it
  try { r = await req(url, { ...reqOpts, bearer: s.token }); }
  catch (e) { return { ok: false, error: 'lp_price_error', message: scrub(errText(e)) }; }
  if (r.status === 401) {
    const s2 = await reauthenticate();
    if (!s2.ok) return { ok: false, ...s2 };
    s = s2;
    try { r = await req(url, { ...reqOpts, bearer: s.token }); }
    catch (e) { return { ok: false, error: 'lp_price_error', message: scrub(errText(e)) }; }
  }
  if (r.status !== 200) {
    const why = classifyUpstreamError(r.status, r.text);
    return { ok: false, error: 'lp_price_status', http: r.status,
      message: why.message || ('searchRaw → ' + r.status),
      fault: why.kind, upstream: scrub((r.text || '').slice(0, 600)) };
  }
  const raw = r.json != null ? r.json : r.text;
  const empty = raw == null || (typeof raw === 'string' && raw.trim() === '') || (typeof raw === 'object' && Object.keys(raw).length === 0);
  return { ok: true, session: s, raw, empty };
}

// ---- disqualify search store (kickoff once, poll by stable searchKey) ------
// The disqualify computation is async: a normal /price is ALREADY the kickoff (its body carries
// showDisqualify + disqualifyAsync + cachedDisqualified=false). To READ the result, the poll must
// re-post a BYTE-IDENTICAL body with only cachedDisqualified flipped to true — that is how the
// frontend hits the SAME server-side computation (~16s later, a ~111 MB tree). Rebuilding the body
// on each poll (re-fetching the live base/SMO) risks a different body → a NEW upstream search that
// is never ready. So we STORE the exact kickoff body under a stable searchKey and poll THAT.
const DISQ_STORE = new Map(); // searchKey -> { body, url, createdAt, expiresAt }
const DISQ_STORE_TTL_MS = envMs('LP_DISQUALIFY_STORE_TTL_MS', 15 * 60 * 1000);
const DISQ_STORE_MAX = 200;
// Stable key for a search: sha256 of the canonical body with cachedDisqualified removed (the only
// field that differs between kickoff and poll). Deterministic → the same scenario reuses one slot.
function searchKeyFor(body) {
  const clone = { ...body }; delete clone.cachedDisqualified;
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex').slice(0, 32);
}
function pruneDisqStore() {
  const now = Date.now();
  for (const [k, v] of DISQ_STORE) if (v.expiresAt <= now) DISQ_STORE.delete(k);
  while (DISQ_STORE.size > DISQ_STORE_MAX) { const first = DISQ_STORE.keys().next().value; DISQ_STORE.delete(first); }
}
// The kickoff RESPONSE assigns this search a requestId (at results.baseSearch.requestId). The poll
// MUST echo it at the top level of the poll body, or Lender Price treats the poll as a brand-new
// search (a fresh root id every time — the "different search id on every call" the audit measured)
// and the async result is never found. This is the single missing link that made the poll fail.
function requestIdOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // The kickoff assigns the requestId at baseSearch.requestId OR results.baseSearch.requestId
  // (both shapes occur). Check both.
  const a = raw.baseSearch && raw.baseSearch.requestId;
  const b = raw.results && raw.results.baseSearch && raw.results.baseSearch.requestId;
  const rid = (typeof a === 'string' && a) || (typeof b === 'string' && b) || null;
  return rid || null;
}
// Build the poll body from the stored kickoff body: cachedDisqualified=true, the upstream requestId,
// and four nullable defaults the frontend fills in (compensation bounds + rate range).
//
// §2.1/TASK-31 CORRECTION — THIS DOES **NOT** MATCH THE CAPTURED POLL BYTE-FOR-BYTE, and the comment
// that said so was measurably wrong. Measured against the captured poll bodies (anchors req-02…06,
// five identical polls of the req-01 kickoff), our poll still differs in 15 leaves. The frontend's
// OWN poll differs from its OWN kickoff in 14 leaves: it DROPS nine keys it had sent as `null`
// (brokerCriteria.divisionSourceType, rangeComplan.from/to, closingCost…titleInsurance,
// criteria.mortgageLimitForLatestYear.mortgageLimit, four dynamicPropertiesMap `.value`s,
// groupConfig.leafLimit, miDataWrapper.miPriceDetail.paymentType) and ADDS
// `disqualifiedResultsByProduct: false`. So "the poll differs from the kickoff only in
// cachedDisqualified" describes OUR behaviour, never theirs.
//
// IT IS DELIBERATELY LEFT THAT WAY. The vendor plainly does not cache-key on the whole body — if it
// did, the frontend's own 14-leaf-different poll could not read back the computation its kickoff
// started, and it demonstrably does. Correlation is by `requestId`, which is why this function echoes
// it and why `pollDisqualifiedByKey` refuses outright without one. Reshaping the poll to match would
// therefore be a change to a working async handshake justified by inference rather than measurement,
// and getting it wrong costs the ineligible-reasons read on every deal. It needs a live re-measure
// (kickoff, then poll in the frontend's shape, confirm the tree still comes back) before it moves.
// Pinned as-is by scripts/test-lt-lp-blank-parity.js so it cannot drift unnoticed.
function applyPollDelta(kickBody, requestId) {
  const body = { ...kickBody, cachedDisqualified: true };
  if (requestId) body.requestId = requestId;
  const bc = body.brokerCriteria = { ...(body.brokerCriteria || {}) };
  if (bc.minimunCompensation === undefined) bc.minimunCompensation = null;
  if (bc.maxCompensation === undefined) bc.maxCompensation = null;
  const rr = body.rateRange = { ...(body.rateRange || {}) };
  if (rr.from === undefined) rr.from = null;
  if (rr.to === undefined) rr.to = null;
  return body;
}
let _lastDurablePruneAt = 0;
function storeKickoff(url, body, requestId) {
  pruneDisqStore();
  const key = searchKeyFor(body);
  const now = Date.now();
  const expiresAt = now + DISQ_STORE_TTL_MS;
  const existing = DISQ_STORE.get(key);
  // §27.4 — two IDENTICAL concurrent /price calls hash to the SAME key. Overwriting an active
  // kickoff would swap in the second call's requestId, so a client polling the first search would
  // suddenly poll the second (fresh, not-yet-ready) upstream computation — and a result that was
  // already READY would be reset. So DON'T overwrite an active record: keep the first kickoff, only
  // FILL a requestId it was missing, and refresh the TTL. (Deliberate, reference-free de-dup: the
  // two searches are byte-identical, so the first search's result is the correct answer for both.)
  let entry;
  if (existing && existing.expiresAt > now) {
    if (!existing.requestId && requestId) existing.requestId = requestId;
    existing.expiresAt = expiresAt;
    entry = existing;
  } else {
    // Store the kickoff body verbatim (cachedDisqualified is already false on it) + the upstream requestId.
    entry = { body, url, requestId: requestId || null, createdAt: now, expiresAt };
    DISQ_STORE.set(key, entry);
  }
  // Durable L2 (best-effort, fire-and-forget): persist so the kickoff survives a reboot; the PG
  // upsert applies the SAME "keep the first requestId" rule via COALESCE.
  disqStore.persist(key, { url: entry.url, body: entry.body, requestId: entry.requestId, expiresAt }).catch(() => {});
  if (now - _lastDurablePruneAt > 5 * 60 * 1000) { _lastDurablePruneAt = now; disqStore.prune().catch(() => {}); }
  return key;
}

// §37.7 — EVERY PRICED SCENARIO IS VALIDATED AND ENRICHED HERE, AT THE ONE CHOKEPOINT.
//
// `validateScenario` is what fills a location in from its ZIP — state, county NAME and county FIPS —
// and its own §26.3 note is explicit that a caller "MUST go on to price the returned scenario:
// pricing the original would validate one request and send a different, county-less one upstream."
// Only `routes/dscr-pricer.js` did that. `routes/ppe.js` — the SHADOW/CANARY path, whose entire job
// is to compare our engine against Lender Price — called `price()` with the raw scenario, so it
// priced a county-less location while the real pricer priced a county-carrying one. The comparison
// that decides whether we may cut over was measuring two different requests, and nothing anywhere
// said so.
//
// Enriching at the CALL SITE can only ever be as complete as the list of call sites somebody
// remembered, which is exactly how this gap opened, so it is done HERE instead: every caller,
// present and future, is covered by construction. It is safe to run twice — the enrichment fills
// only what is absent, so a scenario the route already enriched passes through unchanged — and it
// is offline (a table lookup), so it costs no upstream call.
//
// A scenario that cannot be priced is REFUSED here rather than sent: `searchRaw` answers a bad body
// with a bare "Internal Server Error" carrying no field name, so letting it through converts a
// precise, local, fixable complaint into the least diagnosable failure the vendor can produce.
// The refusal keeps the shape every caller already handles ({ok:false, reason}).
function validatedScenario(scenario) {
  let v;
  try { v = validateScenario(scenario); } catch (e) { return { ok: false, reason: 'lp_scenario_invalid', message: errText(e) }; }
  if (!v || v.ok !== true) {
    return { ok: false, reason: 'lp_scenario_invalid', error: v && v.error, field: v && v.field, message: v && v.message };
  }
  return { ok: true, scenario: v.scenario || scenario, countyEnrichment: v.countyEnrichment || null };
}

// `opts.profile` selects the PRODUCT PROFILE the request is built under (§2.88): `'dscr'` — the
// default, and byte-identical to every search this connector has ever sent — or `'mirror'`, which
// forces none of the five profile-identity fields and lets the scenario decide. An unknown name falls
// back to `'dscr'`, so a typo narrows rather than widens what we search.
// The scenario facts worth keeping BESIDE a captured payload, so a capture can be found later by what
// it was about rather than only by its hash. Deliberately a NAMED SUBSET and not the whole scenario:
// a scenario object is a request body's raw material and can pick up whatever a caller put on it, and
// an allowlist is the only shape that cannot start capturing something new by accident. Nothing here
// identifies a borrower — these are deal shape facts.
const CAPTURE_SCENARIO_KEYS = Object.freeze([
  '_label', '_group', 'purpose', 'state', 'zip', 'county', 'fico', 'loan', 'value', 'dscr',
  'term', 'prepayTerm', 'units', 'propertyType', 'occupancy', 'citizenship', 'loanType',
]);
function captureScenarioMeta(scenario) {
  const out = {};
  if (!scenario || typeof scenario !== 'object') return out;
  for (const k of CAPTURE_SCENARIO_KEYS) if (scenario[k] !== undefined) out[k] = scenario[k];
  return out;
}

async function price(scenario, opts = {}) {
  const v = validatedScenario(scenario);
  if (!v.ok) return v;
  scenario = v.scenario;
  // Build the FULL canonical search model. Prefer the company's LIVE default search (so every
  // current default/config is preserved) and its LIVE special-mortgage-option ids; both fall
  // back to the captured static base / built-in ids when the endpoints are unavailable, so a
  // hand-built minimal payload (which Lender Price rejects with 500) is never sent. The recovery
  // wrapper re-logs in + refetches the live config + retries ONCE on a 500 (a stale-session 500).
  const build = (f) => buildSearch({ ...scenario, companyId: f.companyId }, { base: f.liveBase, smo: f.smo, profile: opts.profile });
  const r = await searchRawWithRecovery(build);
  if (!r.ok) return r;
  const f = r.foundation;
  // A normal price IS the disqualify kickoff — store the exact body AND the upstream requestId the
  // response assigned, so a later status poll re-posts it with only cachedDisqualified flipped +
  // that requestId, hitting the SAME computation.
  const searchKey = storeKickoff(f.url, r.request, requestIdOf(r.raw));
  rawCapture.capture('price', r.raw, { searchKey, scenario: captureScenarioMeta(scenario), requestId: requestIdOf(r.raw), via: 'price' });
  return { ok: true, raw: r.raw, request: r.request, searchKey, provenance: foundationProvenance(f), recovered: !!r.recovered };
}

// Whether a searchRaw response carries a POPULATED disqualify tree (the async result is ready).
function hasDisqualifyData(raw) {
  const d = raw && typeof raw === 'object' && raw.results && raw.results.disqualifiedData;
  if (!d || typeof d !== 'object') return false;
  return (Array.isArray(d.childs) && d.childs.length > 0) || (Array.isArray(d.leafs) && d.leafs.length > 0);
}

// The disqualify workflow (mirrors the web app's "show disqualified" button):
//  1. POST the search with the disqualify flags (cachedDisqualified=false) → returns the QUALIFIED
//     programs fast AND kicks off the async disqualify computation server-side.
//  2. Re-POST the SAME body with cachedDisqualified=true, polling until the cached disqualify tree
//     is ready (Lender Price answers with an empty body while it is still computing — a few minutes).
// The poll body differs from the kickoff only in cachedDisqualified, so Lender Price's cache key
// matches — which means a later call rebuilds the identical body and picks up the ready result
// instantly (so an external caller can also poll by calling this again). Bounded by maxWaitMs so it
// never blocks an HTTP request indefinitely; returns ready:false with the qualified data when the
// window elapses.
async function priceDisqualified(scenario, opts = {}) {
  // Same chokepoint as price() — the ineligible-products path must price the SAME enriched location
  // as the eligible one, or the two halves of one search disagree about where the property is.
  const v = validatedScenario(scenario);
  if (!v.ok) return v;
  scenario = v.scenario;
  const build = (f) => buildSearch({ ...scenario, companyId: f.companyId }, { base: f.liveBase, smo: f.smo, disqualify: { cached: false } });
  const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : envMs('LP_DISQUALIFY_MAX_WAIT_MS', 80000);
  const pollMs = opts.pollMs != null ? opts.pollMs : envMs('LP_DISQUALIFY_POLL_MS', 5000);

  // Phase 1 — kick off + qualified (through the 500 recovery: re-login + refetch + rebuild + retry once).
  const first = await searchRawWithRecovery(build);
  if (!first.ok) return first;
  const f = first.foundation;
  let session = first.session || f.session;
  const kickBody = first.request;
  // Echo the kickoff's requestId on the poll so it reads the SAME async computation (not a new one),
  // applying the exact frontend normalization delta (cachedDisqualified + requestId + nullable defaults).
  const rid = requestIdOf(first.raw);
  const pollBody = applyPollDelta(kickBody, rid);
  storeKickoff(f.url, kickBody, rid); // also make it pollable by searchKey afterwards
  if (hasDisqualifyData(first.raw)) {
    // ⛔ CAPTURE HERE, AND AT EVERY OTHER RETURN BELOW THAT CARRIES A PAYLOAD (§2.112). This is the
    // ONLY disqualify function the paid agreement run calls — `pollDisqualified` and
    // `pollDisqualifiedByKey` are the poll-only doors for a caller that already has a search key — so
    // wiring the sink to those two alone captured the price ladder and silently threw away the decline
    // tree, which is the bigger payload and the one this whole workstream is about.
    rawCapture.capture('disqualify', first.raw, { scenario: captureScenarioMeta(scenario), via: 'priceDisqualified', ready: true, polls: 0 });
    return { ok: true, ready: true, polls: 0, qualified: first.raw, disqualified: first.raw, request: kickBody, provenance: foundationProvenance(f) };
  }

  // Phase 2 — poll the cached async result.
  const t0 = Date.now();
  let polls = 0;
  let last = null;
  while (Date.now() - t0 < maxWaitMs) {
    await sleep(pollMs);
    polls += 1;
    const p = await postSearchRaw(f.url, session, pollBody, { timeoutMs: DISQUALIFY_TIMEOUT_MS });
    if (p.session) session = p.session;
    if (!p.ok) continue;      // transient upstream error — keep polling within the window
    if (p.empty) continue;    // still computing (empty body) — keep polling
    last = p.raw;
    if (hasDisqualifyData(p.raw)) {
      rawCapture.capture('disqualify', p.raw, { scenario: captureScenarioMeta(scenario), via: 'priceDisqualified', ready: true, polls });
      return { ok: true, ready: true, polls, qualified: first.raw, disqualified: p.raw, request: pollBody };
    }
  }
  // The window closed with no tree. Whatever DID come back was still paid for, and a run that keeps
  // timing out is exactly the case somebody will want the bytes for later — captured with `ready:false`
  // in the meta so a reader can never mistake a partial for a finished tree.
  if (last) rawCapture.capture('disqualify', last, { scenario: captureScenarioMeta(scenario), via: 'priceDisqualified', ready: false, polls });
  return {
    ok: true, ready: false, polls,
    qualified: first.raw,
    disqualified: last || first.raw,
    request: pollBody,
    message: 'Disqualify reasons are still being computed by Lender Price — call again shortly (the result is cached server-side, so the next call returns it quickly).',
  };
}

// POLL-ONLY disqualify (the audit's design): a normal price() already KICKED OFF the async
// computation (its body carries showDisqualify + disqualifyAsync). This rebuilds the byte-identical
// body with ONLY cachedDisqualified=true and posts it ONCE — it does NOT kick off again, so it can
// never reset the computation the price() started. Returns { ready:true, disqualified } when the
// cached tree is populated, or { ready:false } while still computing (empty body). Because
// buildSearch is deterministic (base/SMO cached), a caller can poll repeatedly over a few minutes,
// exactly like the web app polls after its search.
async function pollDisqualified(scenario) {
  const f = await priceFoundation();
  if (!f.ok) return f;
  // If a prior /price for this scenario stored the kickoff's requestId, echo it (+ the nullable
  // defaults) so we poll the SAME computation. (searchKeyFor ignores cachedDisqualified, so the key
  // matches the kickoff's.) Build the kickoff-shaped body first to compute the key.
  const kickBody = buildSearch({ ...scenario, companyId: f.companyId }, { base: f.liveBase, smo: f.smo, disqualify: { cached: false } });
  pruneDisqStore();
  const entry = DISQ_STORE.get(searchKeyFor(kickBody));
  const body = applyPollDelta(kickBody, entry && entry.requestId);
  const r = await postSearchRaw(f.url, f.session, body, { timeoutMs: DISQUALIFY_TIMEOUT_MS });
  if (!r.ok) return { ...r, request: body };
  if (r.empty || !hasDisqualifyData(r.raw)) return { ok: true, ready: false, request: body };
  rawCapture.capture('disqualify', r.raw, { scenario: captureScenarioMeta(scenario), via: 'pollDisqualified' });
  return { ok: true, ready: true, raw: r.raw, request: body };
}

// POLL-ONLY by searchKey — the correct, idempotent status check (the audit's required design).
// Loads the STORED kickoff body (never rebuilds via buildSearch, never re-fetches base/SMO), flips
// ONLY cachedDisqualified to true, and posts it ONCE. So every poll hits the SAME upstream
// computation the price() kickoff started — it can never restart/replace it, and the cache key is
// byte-stable across polls. Returns { unknown:true } when the searchKey is absent/expired so the
// route can tell the caller to re-run the price. Never holds a long loop: one post, then answer.
async function pollDisqualifiedByKey(searchKey) {
  pruneDisqStore();
  let entry = DISQ_STORE.get(searchKey);
  if (!entry) {
    // DURABLE REHYDRATE (audit): after a reboot / deploy / instance-move the L1 Map is empty, but the
    // kickoff (and any materialized result) persist in Postgres. Load and repopulate L1 so the poll
    // hits the SAME upstream computation the original price() kicked off — instead of "unknown key".
    const loaded = await disqStore.load(searchKey);
    if (loaded) {
      entry = { body: loaded.body, url: loaded.url, requestId: loaded.requestId,
        result: loaded.result || null, rawSummary: loaded.rawSummary || null,
        createdAt: Date.now(), expiresAt: loaded.expiresAt, rehydrated: true };
      DISQ_STORE.set(searchKey, entry);
    }
  }
  if (!entry) return { ok: true, unknown: true, ready: false };
  // Without the upstream requestId the poll can never correlate to the kickoff's computation — it
  // would 202 forever. Surface a named, controlled error instead (the caller re-runs /price).
  if (!entry.requestId) return { ok: false, error: 'lp_missing_request_id', searchKey,
    message: 'The kickoff response did not include an upstream requestId, so the ineligible result cannot be polled. Re-run the price search.' };
  // §27.3 — once a search is READY we MATERIALIZE its parsed result (a compact structure, not the
  // ~111 MB raw tree) on the store entry. Every later poll for the same searchKey serves that
  // materialized result with ZERO upstream calls, instead of re-downloading + re-parsing the tree
  // (the audit measured a 30s re-download on every repeat poll).
  if (entry.result) return { ok: true, ready: true, searchKey, parsed: entry.result, rawSummary: entry.rawSummary || null, cached: true };
  const f = await priceFoundation(); // session/auth only — the scenario body comes from the store
  if (!f.ok) return f;
  const body = applyPollDelta(entry.body, entry.requestId); // cachedDisqualified + requestId + nullable defaults
  const r = await postSearchRaw(entry.url || f.url, f.session, body, { timeoutMs: DISQUALIFY_TIMEOUT_MS });
  if (!r.ok) return { ...r, searchKey };
  if (r.empty || !hasDisqualifyData(r.raw)) return { ok: true, ready: false, searchKey };
  const parsed = parseDisqualified(r.raw);
  entry.result = parsed;                         // materialize — subsequent polls skip upstream
  entry.rawSummary = summarizeRaw(r.raw);        // small structural summary kept for debug on cached hits
  entry.readyAt = Date.now();
  // Durable L2 (best-effort): persist the materialized result so ANOTHER instance (or this one after
  // a restart) serves it from cache instead of re-downloading the large tree.
  disqStore.saveResult(searchKey, parsed, entry.rawSummary).catch(() => {});
  rawCapture.capture('disqualify', r.raw, { searchKey, via: 'pollDisqualifiedByKey' });
  return { ok: true, ready: true, searchKey, parsed, rawSummary: entry.rawSummary, raw: r.raw };
}
// Test/introspection helper — is a searchKey currently stored (kicked off, not expired)?
function hasStoredSearch(searchKey) { pruneDisqStore(); return DISQ_STORE.has(searchKey); }

// ---- request builder (decoded field mapping; README "Field mapping") -------
// Turns a plain scenario into the Lender Price searchRaw body. Confirmed tokens per the
// README and quick-pricer buildPayload(). Pure — safe to unit-test with no network.
function buildSearchPayload(sc = {}) {
  const value = num(sc.value);
  const loan = num(sc.loan);
  const ltv = value && loan ? Math.round((loan / value) * 10000) / 10000 : num(sc.ltv);
  const propMap = mapPropertyType(sc.propertyType);
  const pp = mapPrepay(sc.prepayMonths);
  const smo = [pp.ppp, 'Debt Service Coverage Ratio', 'DSCR'];
  if (propMap.nonWarrantableProject) smo.push('Non-Warrantable Condo');
  return {
    criteria: {
      loanPurpose: mapPurpose(sc.purpose),
      purchasePrice: value, appraisedValue: value, loanAmount: loan, ltv,
      fico: num(sc.fico), dscr: num(sc.dscr),
      propertyUse: 'Investment', loanType: 'Fixed', loanYear: 30,
      mortgageTypes: ['Conventional'], ownProperties: '1',
      interestOnly: !!sc.io, escrowWaiver: !!sc.escrowWaive,
      nonWarrantableProject: propMap.nonWarrantableProject, firstTimeHomeBuyer: !!sc.fthb,
      specialMortgageOptions: smo, compensationType: 'BorrowerCompPlan',
    },
    property: {
      propertyType: propMap.propertyType, numberOfUnit: propMap.units,
      attachmentType: 'Detached',
      address: { zip: sc.zip || '', state: sc.state || '', county: sc.countyFps || '', countyName: sc.county || '' },
    },
    dynamicPropertiesMap: {
      IncomeDocType: 'DSCR', DSCRRATIO: String(num(sc.dscr) ?? ''),
      GLOBAL_BorrowerType: sc.borrowerType || 'LLC', GLOBAL_RESERVES: 'Reserves_24',
      Citizenship: 'US Citizen', AddlOccupancyType: 'Long_Term_Rental_Property',
      PrepayTerm: pp.PrepayTerm, PrePayment_Plan_Type: pp.PrePayment_Plan_Type,
    },
    dayLocks: 30, sortView: 'all',
    ...(sc.date ? { date: sc.date } : {}),   // historical as-of pricing (blueprint / audit)
  };
}
// Delegate to the ONE shared alias table (search-model.mapPurpose) so this legacy builder can never
// silently default an unknown purpose to Refinance either (§26.4). Throws LpValidationError on unknown.
function mapPurpose(p) { return sharedMapPurpose(p); }
function mapPropertyType(t) {
  switch (t) {
    case 'Unit2_4': case 'UnitDwelling_2_4': return { propertyType: 'UnitDwelling_2_4', nonWarrantableProject: false, units: 2 };
    case 'CondoWarr': case 'Condos': case 'Condominium': return { propertyType: 'Condos', nonWarrantableProject: false, units: 1 };
    case 'CondoNonWarr': return { propertyType: 'Condos', nonWarrantableProject: true, units: 1 };
    default: return { propertyType: 'SingleFamily', nonWarrantableProject: false, units: 1 };
  }
}
function mapPrepay(months) {
  const m = num(months);
  if (!m) return { PrepayTerm: null, PrePayment_Plan_Type: null, ppp: 'No PPP' };
  return { PrepayTerm: m + ' Months', PrePayment_Plan_Type: 'Standard', ppp: (m / 12) + ' Yr PPP' };
}
// ⛔ TWO JOBS, TWO FUNCTIONS — and until §2.117 they were ONE (§2.104 explains why that ever worked).
//
// `magnitude()` is a FRAME CONVERSION, not a sanitizer. Lender Price states an adjustment
// CHARGE-POSITIVE (a charge is +, a credit is −) while our rate sheet states the SAME adjustment
// PREMIUM-POSITIVE (+ improves the price — deephaven-dscr-sheet.js SHEET_FICO_CLTV says so in its own
// words). MEASURED live 2026-08-18 across four scoped Deephaven searches, EIGHT of eight observable
// families are EXACT negations, so taking the MAGNITUDE *is* the conversion and the itemized-LLPA
// agreement holds for a real reason. Restore the sign on its own and every parsed adjustment flips.
// The relationship is enforced, not assumed: `scripts/test-lt-ppe-llpa-sign-frames.js` holds it family
// by family against `scripts/fixtures/lp-raw-adjustment-signs.json` (the raw vendor values) and fails
// if any family stops being an exact negation. Changing it means changing that suite, the sheet's
// frame, and the comparison in lp-normalize-full together.
//
// `num()` reads an INPUT FACT — fico, dscr, loan, value, months, a monthly payment. **None of those is
// ever negative**, so where the frame conversion silently returned `0.25` for `-0.25`, this REFUSES a
// negative outright: a loan amount of −500,000 is garbage, and quoting it as +500,000 is fail-open on
// money. It stays deliberately lenient about text AROUND the number — Lender Price answers a prepay
// term as `"60 Months"` and the whole prepay mapping depends on reading the 60 out of it — so the
// difference from `magnitude` is the SIGN, and only the sign.
//
// THE POINT OF THE SPLIT is that they no longer coincide by accident. One function doing both meant a
// future field that is legitimately negative and is NOT an adjustment would inherit the conversion and
// be corrupted silently, with no suite able to notice: the sign-frame suite only covers adjustment
// families. Now the conversion is named, is reachable from exactly four call sites, and everything else
// fails closed on a sign it should never see. Parity doc §2.104 + §2.117.
// The lenient extraction both of them are built on: pull the digits out of whatever the vendor sent
// ("$1,250.50", "60 Months") and drop everything else — INCLUDING the sign. It is deliberately private
// and deliberately unnamed for either job: the two callers below are what give it a meaning.
function digitsOnly(v) { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; }
// THE FRAME CONVERSION. A one-line alias on purpose — its whole job is to NAME what dropping the sign
// means here, and to be the only thing an adjustment value is read through.
function magnitude(v) { return digitsOnly(v); }
function num(v) {
  if (v == null || v === '') return null;
  // The sign is read off the RAW value before any stripping — `String(-0.25)` is "-0.25", and a
  // vendor's accounting parenthesis "(0.25)" means the same thing.
  const s = String(v).trim();
  if (/^-/.test(s) || /^\(.*\)$/.test(s)) return null;
  return digitsOnly(s);
}

// ---- parser (blueprint step 6): flatten the raw tree to clean ladders ------
// The raw searchRaw response is a deep nested tree. This flattens it to a per-lender/
// per-program list of rate rungs. It is deliberately DEFENSIVE about the exact shape
// (the tree varies) — it walks for objects that carry a rate + a price and groups them.
// Refine field names against the first real Render capture.
// Rate: Lender Price puts the note rate on the priced LEAF as `rate`, and also mirrors it as
// adjustedRates/baseRates/rawRates. Cost is expressed as POINTS (adjustedPoints), NOT a "price"
// field — so we derive a 100-basis price from points when no explicit price is present.
const RATE_KEYS = ['rate', 'noteRate', 'interestRate', 'adjustedRate', 'adjustedRates', 'finalRate', 'baseRates', 'rawRates'];
const POINT_KEYS = ['adjustedPointsBorrowerPaid', 'adjustedPoints', 'points', 'discountPoints', 'basePoints', 'adjustmentPoints'];
const PRICE_KEYS = ['price', 'finalPrice', 'basePrice', 'adjustedPrice', 'netPrice'];
const LENDER_KEYS = ['lenderName', 'investorName', 'investor', 'lender', 'lenderKey'];
const PROGRAM_KEYS = ['programName', 'productName', 'program', 'productCode'];

// Pull grouping context (lender / program) off a group node: its own string fields AND anything
// inside its `key[]` grouping array (Lender Price nests the grouping value there — e.g. a
// LenderKey group's key carries the lender, a program group's key carries the program name).
function ctxFrom(node, ctx) {
  let lender = firstStr(node, LENDER_KEYS) || ctx.lender;
  let program = firstStr(node, PROGRAM_KEYS) || ctx.program;
  if (Array.isArray(node.key)) {
    for (const el of node.key) {
      if (!el || typeof el !== 'object') continue;
      lender = firstStr(el, LENDER_KEYS) || lender;
      program = firstStr(el, PROGRAM_KEYS) || program;
      const gt = String(el.groupType || el.type || el.keyType || '');
      const val = (el.value != null ? el.value : (el.name != null ? el.name : el.displayName));
      if (typeof val === 'string' && val.trim()) {
        if (/lender|investor/i.test(gt)) lender = val.trim();
        else if (/(program|product|criteria)/i.test(gt) && !/rate/i.test(gt)) program = val.trim();
      }
    }
  }
  return { lender, program };
}
function monthlyOf(node) {
  const mp = node.monthlyPayment;
  if (typeof mp === 'number') return mp;
  if (mp && typeof mp === 'object') return firstNum(mp, ['total', 'totalPayment', 'principalAndInterest', 'amount', 'payment']);
  return firstNum(node, ['payment', 'principalAndInterest']);
}

// ---- FULL-DETAIL capture ---------------------------------------------------
// Lender Price returns a deeply detailed tree: results.{qualifiedNonQMData,qualifiedQMData,
// disqualifiedData} are grouped Program→Rate→Lender, and each priced LEAF carries 140+ fields —
// the whole pricing build (base rate/points → itemized LLPA stack → margin/holdback → final
// rate/points/price), lender + program identity, comp, fees, ratios, monthly payment, compliance.
// We CAPTURE EVERYTHING: every option keeps its full raw leaf plus a clean structured breakdown.
function unquote(s) { return typeof s === 'string' ? s.replace(/^"+|"+$/g, '') : s; }
// id → {id,name,shortName} from results.lenderDtos.{lenderDtoQm,NonQm,Disq,sponsored}.
function lenderDtoMap(R) {
  const map = {};
  const d = (R && R.lenderDtos) || {};
  for (const k of ['lenderDtoQm', 'lenderDtoNonQm', 'lenderDtoDisq', 'sponsoredLenderDto']) {
    const arr = d[k];
    if (Array.isArray(arr)) for (const x of arr) if (x && x.id) map[x.id] = { id: x.id, name: x.name || null, shortName: x.shortName || null, ratePeriodId: x.ratePeriodId || null };
  }
  return map;
}
// Flatten the itemized adjustment groups (groupAdjustmentProperties / groupRateAdjustmentProperties)
// into a clean line list: each line's human reason (`key`), its value in points/rate, its group.
function flattenAdjustments(groups) {
  const out = [];
  if (!Array.isArray(groups)) return out;
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const group = g.name || null;
    const adjs = Array.isArray(g.adjustments) ? g.adjustments : [];
    if (!adjs.length && (g.finalAdjustment != null || g.totalAdjustment != null)) {
      out.push({ group, reason: group, type: g.type || null, valueType: null, value: magnitude(g.finalAdjustment != null ? g.finalAdjustment : g.totalAdjustment) });
    }
    for (const a of adjs) {
      if (!a || typeof a !== 'object') continue;
      out.push({ group, reason: a.key || a.name || group, adjType: a.adjType || null, type: a.type || null, valueType: a.valueType || null, value: magnitude(a.llpa != null ? a.llpa : a.adj) });
    }
  }
  return out;
}
// The margin/holdback the lender/broker keeps (holdBackResult.{broker,lender,investor}.adjustments).
function holdbackOf(leaf) {
  const hb = leaf.holdBackResult;
  if (!hb || typeof hb !== 'object') return null;
  const out = {};
  for (const party of ['broker', 'lender', 'investor']) {
    const p = hb[party];
    if (p && Array.isArray(p.adjustments) && p.adjustments.length) {
      out[party] = p.adjustments.map((a) => ({ reason: a.key || a.name || null, type: a.type || null, valueType: a.valueType || null, value: magnitude(a.adj != null ? a.adj : a.llpa) }));
    }
  }
  return Object.keys(out).length ? out : null;
}
// The bottom-up price build: par/base rate → rate adjustment → note rate; base points → LLPA
// points → adjusted points → price (100 − points); plus APR / APOR.
function priceBuildOf(leaf) {
  const adjPts = firstNum(leaf, ['adjustedPoints']);
  const price = adjPts != null ? Math.round((100 - adjPts) * 1000) / 1000 : firstNum(leaf, PRICE_KEYS);
  return {
    parRate: firstNum(leaf, ['undiscountedRate', 'startedAdjustedRate']), // the un-bought-down rate
    baseRate: firstNum(leaf, ['baseRates', 'rawRates']),
    rateAdjustment: firstNum(leaf, ['adjustmentRates']),
    noteRate: firstNum(leaf, ['rate', 'adjustedRates']),
    basePoints: firstNum(leaf, ['basePoints', 'rawBasePoints']),
    adjustmentPoints: firstNum(leaf, ['adjustmentPoints']),          // the LLPA stack total, in points
    adjustedPoints: adjPts,                                          // final points
    borrowerPaidPoints: firstNum(leaf, ['adjustedPointsBorrowerPaid', 'borrowerPaidPoints']),
    price,                                                           // 100 − adjustedPoints
    priceDerivedFromPoints: firstNum(leaf, PRICE_KEYS) == null && adjPts != null,
    apr: firstNum(leaf, ['apr', 'notRoundedAPR']),
    apor: firstNum(leaf, ['apor']),
  };
}
// One priced option = the full structured breakdown + (optionally) the entire raw leaf.
function optionOf(leaf, ctx, dtoMap, keepRaw) {
  const plenderId = unquote(ctx.plenderId) || leaf.companyId || null;
  const dto = (plenderId && dtoMap[plenderId]) || null;
  const lender = leaf.companyName || ctx.lender || (dto && dto.name) || 'Lender';
  const program = leaf.programName || leaf.productName || ctx.program || firstStr(leaf, ['mortgageType']) || 'Program';
  const mp = leaf.monthlyPayment;
  const o = {
    lender, lenderId: plenderId, investor: dto ? dto.name : null, lenderShort: dto ? dto.shortName : null,
    program, product: leaf.productName || null, rateGridId: leaf.rateGridId || null, rateGridName: leaf.rateGridName || null,
    priceBuild: priceBuildOf(leaf),
    adjustments: flattenAdjustments(leaf.groupAdjustmentProperties),         // itemized LLPAs (point)
    rateAdjustments: flattenAdjustments(leaf.groupRateAdjustmentProperties), // itemized LLPAs (rate)
    holdback: holdbackOf(leaf),                                              // margin
    comp: {
      borrowerPaid: firstNum(leaf, ['borrowerPaid']), lenderPaid: firstNum(leaf, ['lenderPaid']),
      compPlanBorrowerPaid: firstNum(leaf, ['compPlanBorrowerPaid']),
      borrowerPaidDetails: leaf.borrowerPaidDetails || [], lenderPaidDetails: leaf.lenderPaidDetails || [],
    },
    fees: {
      totalOriginationFee: firstNum(leaf, ['totalOriginationFee']), totalLenderFees: firstNum(leaf, ['totalLenderFees']),
      finalClosingCost: firstNum(leaf, ['finalClosingCost']), cashToClose: firstNum(leaf, ['cashToCloseAmount']),
      pointsFinanced: firstNum(leaf, ['pointsFinancedDollarAmount']),
    },
    terms: {
      loanAmount: firstNum(leaf, ['loanAmount']), term: firstNum(leaf, ['term']), termInMonths: !!leaf.termInMonths,
      dayLock: firstNum(leaf, ['dayLock']), mortgageType: leaf.mortgageType || null, loanPurpose: leaf.loanPurpose || null,
      interestOnly: !!leaf.isInterestOnly, dscr: firstNum(leaf, ['dscr']), fico: firstNum(leaf, ['fico']),
      ltv: firstNum(leaf, ['ltv']), cltv: firstNum(leaf, ['cltv']), dti: firstNum(leaf, ['dti']), hti: firstNum(leaf, ['hti']),
    },
    monthlyPayment: (mp && typeof mp === 'object') ? mp : null,
    flags: { disqualified: !!leaf.disqualified, interpolated: !!leaf.interpolated, expired: !!leaf.expired, highBalance: !!leaf.highBalanceIndicator },
    // §37.12 — WHICH RATE SHEET THIS PRICE CAME FROM, AND WHETHER IT IS STILL GOOD.
    // A rate with no provenance cannot be checked. `validAsOf` is the sheet's effective stamp and
    // `expired` is the vendor's own verdict on it; both were being dropped. See rateSheetSummary().
    rateSheet: rateSheetOf(leaf),
  };
  if (keepRaw) o.raw = leaf; // EVERY field, untouched — nothing left behind
  return o;
}
// Walk the grouped tree(s) and collect every priced option (each leaf → one option).
function collectOptions(raw, opts = {}) {
  const R = (raw && typeof raw === 'object' && raw.results) ? raw.results : raw;
  const dtoMap = lenderDtoMap(R);
  const options = [];
  const containers = opts.containers || ['qualifiedNonQMData', 'qualifiedQMData'];
  for (const c of containers) { const root = R && R[c]; if (root) walkTree(root, { program: null, lender: null, plenderId: null }); }
  function walkTree(node, ctx) {
    if (!node || typeof node !== 'object') return;
    const next = { ...ctx };
    if (node.plenderId) next.plenderId = node.plenderId;
    if (node.type === 'CriteriaFromLineResultKey' && node.keyLabel) next.program = node.keyLabel;
    else if (node.type === 'LenderKey' && node.keyLabel) next.lender = node.keyLabel;
    if (Array.isArray(node.leafs)) for (const lf of node.leafs) if (lf && typeof lf === 'object') options.push(optionOf(lf, next, dtoMap, opts.keepRaw));
    if (Array.isArray(node.childs)) for (const c of node.childs) walkTree(c, next);
  }
  return { options, dtoMap, R };
}

// parse() — the DISPLAY summary: programs grouped by lender+program, each with a rate/point ladder
// and the lender/investor identity. Captures the pricing build at a glance (base/adjustment/final
// points + adjustment count) without the full raw dump.
// §37.12 — RATE-SHEET PROVENANCE AND STALENESS.
//
// THE FINDING, measured on the owner's own captured searches: **115 of 309 priced options (37%) in
// one, and 285 of 470 (61%) in the other, come from EXPIRED rate sheets.** Whole lenders at a time —
// in the Brooklyn capture, Oaktree (61 options), AD Mortgage (30) and Bluepoint (24) were entirely
// expired, and AD Mortgage was showing the BEST RATE on the board. In the Linden capture the
// second-cheapest rate was expired.
//
// The vendor tells us plainly: every leaf carries `expired`, and `ratePeriod.validAsOf` stamps the
// sheet it was priced from. We were dropping both. `parseFull` surfaced `flags.expired` and nothing
// else; `parse()` — the DISPLAY summary, the one an officer actually reads — surfaced neither, and
// no parsed result carried a quote time at all. So a stale rate was presented exactly like a live
// one, with nothing on the object a caller could have checked even if they had thought to.
//
// This is worse than a 500, and the reason is worth stating: a 500 fails loudly and nobody quotes
// anybody. A quietly stale rate is handed to a borrower as a real number.
//
// Nothing here FILTERS. An expired sheet is not automatically a wrong price — a lender may not have
// re-published because nothing changed — and silently dropping a third of the board would be its own
// silent-substitution bug. The rule is the repo's own: fail closed and SAY SO. Every rung now carries
// its provenance, and the summary states how much of the board is stale, so a human decides.
function rateSheetOf(leaf) {
  const rp = leaf && leaf.ratePeriod;
  if (!rp || typeof rp !== 'object') return { expired: !!(leaf && leaf.expired), validAsOf: null, name: null, id: null };
  return {
    expired: !!(leaf.expired || rp.expired),
    validAsOf: rp.validAsOf || null,          // when the lender published this sheet
    rateValidDate: rp.rateValidDate || null,
    name: rp.name || null,                    // e.g. "The Loan Store - NDC Orange 2"
    id: rp.id || null,
    parentInvalid: !!rp.parentRateOrCompanyInvalid,
  };
}
// The board-level staleness picture, plus WHEN this quote was priced. A parsed result used to carry
// no timestamp of any kind, so "is this quote fresh?" was unanswerable from the object itself.
function rateSheetSummary(raw, options) {
  const total = options.length;
  const expired = options.filter((o) => o && o.rateSheet && o.rateSheet.expired).length;
  const stamps = options.map((o) => o && o.rateSheet && o.rateSheet.validAsOf).filter(Boolean).sort();
  const lenders = new Set(options.filter((o) => o && o.rateSheet && o.rateSheet.expired).map((o) => o.lender));
  const search = raw && typeof raw === 'object' ? raw.search : null;
  return {
    pricedAt: (search && search.date) || null,     // the vendor's own stamp for this search
    optionCount: total,
    expiredCount: expired,
    liveCount: total - expired,
    expiredPct: total ? Math.round((expired / total) * 1000) / 10 : 0,
    expiredLenders: Array.from(lenders).sort(),
    oldestSheet: stamps.length ? stamps[0] : null,
    newestSheet: stamps.length ? stamps[stamps.length - 1] : null,
  };
}

function parse(raw) {
  const { options } = collectOptions(raw);
  if (!options.length) return parseFallback(raw); // synthetic / non-grouped shapes
  const seen = new Map();
  const programs = [];
  for (const o of options) {
    const key = o.lender + '||' + o.program;
    let p = seen.get(key);
    if (!p) { p = { lender: o.lender, investor: o.investor, lenderId: o.lenderId, program: o.program, product: o.product, rungs: [] }; seen.set(key, p); programs.push(p); }
    const pb = o.priceBuild;
    p.rungs.push({
      rate: pb.noteRate, price: pb.price, points: pb.adjustedPoints, priceDerivedFromPoints: pb.priceDerivedFromPoints,
      basePoints: pb.basePoints, adjustmentPoints: pb.adjustmentPoints, apr: pb.apr,
      monthly: o.monthlyPayment ? num(o.monthlyPayment.monthlyPI != null ? o.monthlyPayment.monthlyPI : o.monthlyPayment.total) : null,
      lockDays: o.terms.dayLock, term: o.terms.term, adjustmentCount: o.adjustments.length,
      // §37.12 — a rung an officer reads must say whether its rate sheet is still good. Measured:
      // 37-61% of a real board is priced off an expired sheet, sometimes the best rate on it.
      expired: !!(o.rateSheet && o.rateSheet.expired),
      rateSheetValidAsOf: (o.rateSheet && o.rateSheet.validAsOf) || null,
    });
  }
  finishPrograms(programs);
  const rateSheets = rateSheetSummary(raw, options);
  return {
    programCount: programs.length,
    lenderCount: new Set(programs.map((p) => p.lender)).size,
    rungCount: programs.reduce((n, p) => n + p.rungCount, 0),
    disqualifiedCount: disqualifiedCountOf(raw),
    // §37.12 — the board's staleness, stated rather than left to be discovered.
    pricedAt: rateSheets.pricedAt,
    rateSheets,
    programs,
  };
}
function finishPrograms(programs) {
  for (const p of programs) {
    p.rungs.sort((a, b) => a.rate - b.rate);
    p.rungCount = p.rungs.length;
    p.minRate = p.rungs.length ? p.rungs[0].rate : null;
    p.minPoints = p.rungs.reduce((m, r) => (r.points != null && (m == null || r.points < m) ? r.points : m), null);
    p.maxPrice = p.rungs.reduce((m, r) => (r.price != null && r.price > m ? r.price : m), -Infinity);
    if (!isFinite(p.maxPrice)) p.maxPrice = null;
  }
}

// parseFull() — CAPTURE EVERYTHING: every option's full structured breakdown (price build, itemized
// LLPAs, margin/holdback, comp, fees, ratios, monthly payment). Pass {raw:true} to also attach the
// entire untouched leaf per option. Returns programs → options, plus the lender registry.
function parseFull(raw, opts = {}) {
  const { options, dtoMap } = collectOptions(raw, { keepRaw: !!opts.raw });
  const seen = new Map();
  const programs = [];
  for (const o of options) {
    const key = o.lender + '||' + o.program;
    let p = seen.get(key);
    if (!p) { p = { lender: o.lender, investor: o.investor, lenderId: o.lenderId, lenderShort: o.lenderShort, program: o.program, product: o.product, rateGridId: o.rateGridId, options: [] }; seen.set(key, p); programs.push(p); }
    p.options.push(o);
  }
  for (const p of programs) {
    p.options.sort((a, b) => ((a.priceBuild.noteRate == null ? 99 : a.priceBuild.noteRate) - (b.priceBuild.noteRate == null ? 99 : b.priceBuild.noteRate)));
    p.optionCount = p.options.length;
    p.minRate = p.options.length ? p.options[0].priceBuild.noteRate : null;
  }
  const rateSheets = rateSheetSummary(raw, options);
  return {
    programCount: programs.length,
    lenderCount: new Set(programs.map((p) => p.lender)).size,
    optionCount: options.length,
    disqualifiedCount: disqualifiedCountOf(raw),
    // §37.12 — provenance rides on every option (o.rateSheet); this is the board-level picture.
    pricedAt: rateSheets.pricedAt,
    rateSheets,
    lenders: Object.values(dtoMap),
    programs,
  };
}

// Fallback parser for non-grouped / synthetic shapes (older fixtures, odd responses): a generic
// deep-walk that groups any object carrying a rate + a cost value.
function parseFallback(raw) {
  const programs = [];
  const seen = new Map();
  const root = (raw && typeof raw === 'object' && raw.results) ? raw.results : raw;
  walk(root, {});
  function pushRung(ctx, node) {
    const rate = firstNum(node, RATE_KEYS);
    if (rate == null) return;
    const points = firstNum(node, POINT_KEYS);
    const quoted = firstNum(node, PRICE_KEYS);
    let price = quoted;
    if (price == null && points != null) price = Math.round((100 - points) * 1000) / 1000;
    if (price == null && points == null) return;
    const lender = ctx.lender || firstStr(node, LENDER_KEYS) || 'Lender';
    const program = ctx.program || firstStr(node, PROGRAM_KEYS) || firstStr(node, ['mortgageType']) || 'DSCR';
    const key = lender + '||' + program;
    let p = seen.get(key);
    if (!p) { p = { lender, program, rungs: [] }; seen.set(key, p); programs.push(p); }
    p.rungs.push({ rate, price, points, priceDerivedFromPoints: quoted == null, apr: firstNum(node, ['apr', 'annualPercentageRate', 'notRoundedAPR']), monthly: monthlyOf(node), loanAmount: firstNum(node, ['loanAmount']), term: firstNum(node, ['term']), lockDays: firstNum(node, ['dayLock', 'lockDays', 'lockPeriod']) });
  }
  function isLeafRow(node) { return RATE_KEYS.some((k) => k in node) && !Array.isArray(node.childs) && !Array.isArray(node.leafs); }
  function walk(node, ctx) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const el of node) walk(el, ctx); return; }
    if (isLeafRow(node)) { pushRung(ctx, node); return; }
    const nextCtx = ctxFrom(node, ctx);
    for (const k of Object.keys(node)) { if (k === 'key') continue; const v = node[k]; if (v && typeof v === 'object') walk(v, nextCtx); }
  }
  finishPrograms(programs);
  return { programCount: programs.length, lenderCount: new Set(programs.map((p) => p.lender)).size, rungCount: programs.reduce((n, p) => n + p.rungCount, 0), disqualifiedCount: disqualifiedCountOf(raw), programs };
}
function firstNum(o, keys) { for (const k of keys) { if (o[k] != null && isFinite(Number(o[k]))) return Number(o[k]); } return null; }
function firstStr(o, keys) { if (!o || typeof o !== 'object') return null; for (const k of keys) { const v = o[k]; if (typeof v === 'string' && v.trim()) return v.trim(); } return null; }

// ---- disqualify parser -----------------------------------------------------
// results.disqualifiedData is a grouped tree (ROOT → childs …, keyLabel naming each group's
// value: lender, program, rate) whose deepest nodes hold the DISQUALIFIED programs and, because
// the request set showDisqualifyRules=true, the RULE that failed + a human reason. It is defensive
// about the exact leaf field names (they mirror the qualified leaves + a reasons/rules array):
// it groups by the top group label (lender), names each item by its program group label, and
// collects every reason/rule string it can find on the item and its descendants.
const REASON_KEYS = ['disqualifyReason', 'disqualifyReasons', 'reason', 'reasons', 'message', 'messages', 'ruleMessage', 'ruleText', 'ruleName', 'rule', 'rules', 'guideline', 'description', 'failReason', 'ineligibleReason'];
function collectReasons(node, out, depth) {
  if (node == null || depth > 6) return;
  if (typeof node === 'string') { const t = node.trim(); if (t) out.add(t.slice(0, 400)); return; }
  if (Array.isArray(node)) { for (const el of node) collectReasons(el, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (REASON_KEYS.includes(k)) collectReasons(v, out, depth + 1);
    else if (v && typeof v === 'object' && !/^(childs|leafs|key)$/.test(k)) collectReasons(v, out, depth + 1);
  }
}
// The structured failing rules for a disqualified leaf: the itemized disqualify adjustments
// (groupAdjustmentProperties[].disqualifyAdjustments — each an eligibility rule with its key),
// condition actions/advisories, then a defensive reason-string sweep as a fallback.
function disqualifyRulesOf(leaf) {
  const out = [];
  const seenR = new Set();
  const add = (rule, extra) => { const r = String(rule || '').trim(); if (r && !seenR.has(r)) { seenR.add(r); out.push({ rule: r.slice(0, 300), ...(extra || {}) }); } };
  const groups = leaf.groupAdjustmentProperties;
  if (Array.isArray(groups)) for (const g of groups) {
    for (const key of ['disqualifyAdjustments', 'hideDisqualifyAdjustments', 'qualifyAdjustments']) {
      const arr = g && g[key];
      // ⛔ AN ELEMENT HERE IS A PLAIN STRING, and reading it as an object is why the entire decline
      // feed was unusable. MEASURED on a captured 173 MB Deephaven disqualify payload (2026-08-18):
      // `groupAdjustmentProperties[].disqualifyAdjustments` is an array of STRINGS —
      //   "DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%"
      //   "DSCR >=1.25%  only eligible on this program"
      // — so `a.key || a.name` was `undefined` on every one of them, `add(undefined)` stored nothing,
      // and ALL 56 Deephaven DSCR leaves reported "no structured rules". That dropped every leaf into
      // the defensive sweep below, which harvests any string it meets: the real refusals arrived with
      // no group and no adjType, buried under ~500x product-classification noise (see the parity doc
      // §2.101/§2.102). An OBJECT element is still read exactly as before — both shapes are handled,
      // because a vendor that ships one today can ship the other tomorrow.
      if (Array.isArray(arr)) for (const a of arr) {
        const isStr = typeof a === 'string';
        add(isStr ? a : (a && (a.key || a.name)), {
          group: g.name || null,
          adjType: (!isStr && a && a.adjType) || null,
          value: isStr ? null : magnitude(a && (a.llpa != null ? a.llpa : a.adj)),
        });
      }
    }
  }
  if (Array.isArray(leaf.conditionActions)) for (const ca of leaf.conditionActions) add(ca && (ca.message || ca.description || ca.key || ca.name), { group: 'condition' });
  if (leaf.holdBackResult && typeof leaf.holdBackResult === 'object') {
    for (const party of ['broker', 'lender', 'investor']) {
      const p = leaf.holdBackResult[party];
      if (p && Array.isArray(p.disqualifications)) for (const d of p.disqualifications) add(d && (d.key || d.name || d.message), { group: party });
    }
  }
  if (!out.length) { const set = new Set(); collectReasons(leaf, set, 0); for (const r of set) add(r); }
  return out;
}
// Parse the DISQUALIFIED tree: which lender/investor declined which program, and the exact rules
// that failed. Same Program→Rate→Lender grouping and lender identity as the qualified parser.
function parseDisqualified(raw) {
  const R = (raw && typeof raw === 'object' && raw.results) ? raw.results : null;
  const root = R && R.disqualifiedData;
  if (!root || typeof root !== 'object') return { ready: false, lenderCount: 0, itemCount: 0, reasonCount: 0, lenders: [] };
  const dtoMap = lenderDtoMap(R);
  const lenders = new Map();
  let itemCount = 0;
  let reasonCount = 0;
  (function walk(node, ctx) {
    if (!node || typeof node !== 'object') return;
    const next = { ...ctx };
    if (node.plenderId) next.plenderId = node.plenderId;
    if (node.type === 'CriteriaFromLineResultKey' && node.keyLabel) next.program = node.keyLabel;
    else if (node.type === 'LenderKey' && node.keyLabel) next.lender = node.keyLabel;
    if (Array.isArray(node.leafs)) for (const lf of node.leafs) {
      if (!lf || typeof lf !== 'object') continue;
      const plenderId = unquote(next.plenderId) || lf.companyId || null;
      const dto = (plenderId && dtoMap[plenderId]) || null;
      const lender = lf.companyName || next.lender || (dto && dto.name) || 'Lender';
      const program = lf.programName || lf.productName || next.program || firstStr(lf, PROGRAM_KEYS) || 'Program';
      const rules = disqualifyRulesOf(lf);
      let g = lenders.get(lender);
      if (!g) { g = { lender, investor: dto ? dto.name : null, lenderId: plenderId, items: [] }; lenders.set(lender, g); }
      g.items.push({ program, product: lf.productName || null, rate: firstNum(lf, RATE_KEYS), reasons: rules });
      itemCount += 1; reasonCount += rules.length;
    }
    if (Array.isArray(node.childs)) for (const c of node.childs) walk(c, next);
  })(root, { program: null, lender: null, plenderId: null });
  const list = Array.from(lenders.values());
  for (const g of list) g.itemCount = g.items.length;
  return { ready: hasDisqualifyData(raw), lenderCount: list.length, itemCount, reasonCount, lenders: list };
}

// Structural summary of the raw searchRaw response — for diagnostics ONLY (secret-gated).
// Tells us whether Lender Price actually returned programs (so the parser is the gap) or truly
// zero (so the request is the gap), plus the exact container/field names + any disqualify reasons.
function summarizeRaw(raw) {
  if (raw == null || typeof raw !== 'object') return { type: typeof raw, note: 'non-object response', preview: scrub(String(raw).slice(0, 400)) };
  const arrays = {};        // dotted path → length, for every array found (depth ≤ 8)
  const reasons = new Set();
  let sampleRateRow = null;
  let sampleLeaf = null;    // first object found inside a `leafs` array — the actual priced rung
  let sampleKeyNode = null; // first object found inside a `key` array — the grouping key
  let sampleGroupNode = null; // first object that BRANCHES (has a `childs` array) — a grouping node
  const seen = new Set();
  const shallow = (o) => { const out = {}; for (const k of Object.keys(o).slice(0, 50)) { const v = o[k]; out[k] = (v && typeof v === 'object') ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : v; } return out; };
  (function walk(node, path, depth, inKey, inLeafs) {
    if (node == null || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (!sampleLeaf && inLeafs) sampleLeaf = { path, node: shallow(node) };
    if (!sampleKeyNode && inKey) sampleKeyNode = { path, node: shallow(node) };
    if (!sampleGroupNode && Array.isArray(node.childs)) sampleGroupNode = { path, node: shallow(node) };
    if (!sampleRateRow && (RATE_KEYS.some((k) => k in node) || PROGRAM_KEYS.some((k) => k in node))) {
      sampleRateRow = { path, keys: Object.keys(node).slice(0, 40) };
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      const p = path ? `${path}.${k}` : k;
      if (/reason/i.test(k) && (typeof v === 'string' || typeof v === 'number')) reasons.add(String(v).slice(0, 120));
      if (Array.isArray(v)) { arrays[p] = v.length; v.slice(0, 1).forEach((el) => walk(el, `${p}[0]`, depth + 1, k === 'key', k === 'leafs')); }
      else if (v && typeof v === 'object') walk(v, p, depth + 1, false, false);
    }
  })(raw, '', 0, false, false);
  // Drill specifically into the disqualify tree so we learn its real leaf/reason field names live.
  let disqualify = null;
  const dd = raw.results && raw.results.disqualifiedData;
  if (dd && typeof dd === 'object') {
    let sampleDisqLeaf = null;
    let sampleDisqNode = null;
    const dseen = new Set();
    (function dwalk(node, path, depth, inLeafs) {
      if (node == null || typeof node !== 'object' || depth > 8 || dseen.has(node)) return;
      dseen.add(node);
      if (!sampleDisqLeaf && inLeafs) sampleDisqLeaf = { path, node: shallow(node) };
      if (!sampleDisqNode && (Array.isArray(node.childs) || Array.isArray(node.leafs))) sampleDisqNode = { path, keyLabel: node.keyLabel, node: shallow(node) };
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) v.slice(0, 1).forEach((el) => dwalk(el, `${path}.${k}[0]`, depth + 1, k === 'leafs'));
        else if (v && typeof v === 'object') dwalk(v, `${path}.${k}`, depth + 1, false);
      }
    })(dd, 'disqualifiedData', 0, false);
    disqualify = {
      populated: hasDisqualifyData(raw),
      topChilds: Array.isArray(dd.childs) ? dd.childs.length : 0,
      topLeafs: Array.isArray(dd.leafs) ? dd.leafs.length : 0,
      sampleDisqNode,
      sampleDisqLeaf,
    };
  }
  return {
    topKeys: Object.keys(raw).slice(0, 60),
    nonEmptyArrays: Object.fromEntries(Object.entries(arrays).filter(([, n]) => n > 0).slice(0, 60)),
    sampleRateRow,
    sampleLeaf,
    sampleKeyNode,
    sampleGroupNode,
    disqualify,
    disqualifyReasons: Array.from(reasons).slice(0, 12),
  };
}
// Sum the lengths of any arrays reachable under the named keys anywhere in the tree.
// §37.13 — THE INELIGIBLE COUNT COULD NEVER BE ANYTHING BUT ZERO.
//
// `countArrays(raw, ['disqualifiedData','disqualified'])` only adds `v.length` where the value AT
// that key IS AN ARRAY. In the real vendor response `results.disqualifiedData` is an OBJECT (the
// root of the same 4-level grouped tree the qualified side uses) and `leaf.disqualified` is a
// BOOLEAN. Neither is ever an array, so the sum was structurally incapable of being non-zero — and
// it reaches the API as `meta.disqualifiedCount`, telling a caller "0 products were ineligible" on
// top of a tree of ineligible products.
//
// It survived because the test that guards it feeds `disqualifiedData: [{}, {}, {}]` — an ARRAY, at
// the top level, with no `results` wrapper: a shape the vendor never returns. A fixture invented to
// satisfy an implementation proves only that the implementation matches the fixture.
//
// `parseDisqualified` already walks the real tree correctly. This just asks it, instead of counting
// arrays that do not exist. It stays cheap on the common path: the poll response is the only one
// that carries a populated tree, and on a kickoff the root is empty so the walk ends immediately.
function disqualifiedCountOf(raw) {
  try { const d = parseDisqualified(raw); return (d && typeof d.itemCount === 'number') ? d.itemCount : 0; }
  catch (_) { return 0; }
}
// (countArrays was removed with its last caller — it counted arrays at keys the vendor never
// returns as arrays, which is precisely how the ineligible count came to be permanently zero.)
// Authenticated pricing readiness for /health — proves more than "configured": that a login
// SUCCEEDS and the live pricing-config endpoints (defaultSearch + SMO) answer, with live-vs-fallback
// provenance. With { price:true } it also runs a real minimal searchRaw so callers can confirm
// pricing end-to-end on demand (kept opt-in so a frequently-polled health check never hammers Lender
// Price). Never throws.
async function pricingReadiness({ price: deep = false } = {}) {
  if (!configured()) return { pricingReady: false, reason: 'not_configured' };
  const s = await getSession();
  // The diagnostics ride the FAILURE branch too: `lastRenewal.fellBack` ("the refresh was rejected
  // before this login failed") is invisible on the one health read where it explains the outage.
  if (!s.ok) return { pricingReady: false, auth: { ok: false, error: s.error, http: s.http || null, message: s.message, ...authDiagnostics() } };
  const f = await priceFoundation();
  if (!f.ok) return { pricingReady: false, auth: { ok: true, expiresAt: new Date(s.expiresAt).toISOString() }, foundation: { ok: false, error: f.error, message: f.message } };
  const auth = { ok: true, expiresAt: new Date(s.expiresAt).toISOString(), companyId: f.companyId, ...authDiagnostics() };
  const fr = foundationReadiness(f);
  if (fr.blocked) return { pricingReady: false, reason: fr.reason, message: fr.message, auth, foundation: fr.foundation };
  const foundation = fr.foundation;
  if (!deep) return { pricingReady: true, auth, foundation };
  // Deep check — a real minimal searchRaw (the only thing that proves a stale-session 500 is gone).
  const prDeep = await price({ purpose: 'Purchase', value: 500000, loan: 350000, fico: 780, dscr: 1.1 });
  return {
    pricingReady: !!prDeep.ok, auth, foundation,
    price: prDeep.ok ? { ok: true, recovered: !!prDeep.recovered } : { ok: false, error: prDeep.error, http: prDeep.http || null, message: prDeep.message },
  };
}

// A LOGIN CHECK THAT CANNOT PRINT A SECRET.
//
// The sanctioned way to verify credentials from inside Render is to run this and print its whole
// result. `login()` returns the access token, so a check built on it depends on whoever runs it
// remembering to select fields — and the natural thing to type in a shell is the whole object, into
// a terminal that may be recorded or pasted into a ticket. This returns the ANSWER only: whether the
// password worked, the failure reason if not, and the two ids that prove which company answered.
// There is no token, no refresh token and no credential in the returned shape, by construction.
//
// It performs a REAL password login (not a renewal), touches no cached session, and never throws.
async function loginSelfTest() {
  const s = await login();
  if (!s.ok) return { ok: false, error: s.error, http: s.http || null, message: s.message };
  return {
    ok: true,
    grant: 'password',
    companyId: s.companyId || null,
    userId: s.userId || null,
    expiresInSec: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
    refreshTokenIssued: !!s.refreshToken,   // whether a renewal is even possible — never the token
  };
}

// PURE — the readiness VERDICT on a resolved foundation, split out so it is testable without a
// session, credentials or a network. `pricingReadiness` above is the thin IO wrapper; this is the
// rule, in one place, the same split cutover-store/cutover-ledger and gate/gate-disposition use.
//
// A GREEN HEALTH CHECK MUST NOT MEAN "the static fallback can still complete a minimal price"
// (audit §34.2 P0, §28.1). Provenance was always reported, but `pricingReady` ignored it — so a
// service pricing every loan off a months-old captured search model reported itself perfectly
// healthy, which is precisely the reading that stops anyone from noticing. The fallback does not
// error: it is accepted upstream and prices a materially DIFFERENT loan (the audit measured 475
// frontend rows against 752 from the fallback on one matched scenario, with zero exact rate/price
// overlap).
//
// The verdict reflects the POLICY ACTUALLY IN FORCE, and is honest in BOTH directions rather than
// simply stricter:
//   • enforcing (LP_REQUIRE_LIVE_FOUNDATION) + fallback → NOT ready. Not a judgement call:
//     foundationLiveGate makes every price 502 in that state, so "ready" would be a plain falsehood
//     about what the next request does.
//   • not enforcing + fallback → ready (prices really do succeed) but `degraded: true`, so a
//     stale-configuration outage cannot hide behind a green check. Failing readiness outright here
//     would paint every environment without live vendor credentials permanently red, which trains
//     people to ignore the signal — the more expensive failure, and the reason this is not simply
//     "not live → not ready".
// Returns { foundation, blocked, reason, message }.
function foundationReadiness(f) {
  const foundation = foundationProvenance(f);
  foundation.live = foundation.base === 'live' && foundation.smo === 'live';
  foundation.required = requireLiveFoundation();   // is a live foundation ENFORCED in this env
  foundation.degraded = !foundation.live;          // are we serving off the static capture
  if (foundation.required && !foundation.live) {
    return {
      foundation,
      blocked: true,
      reason: 'foundation_not_live',
      message: 'Live Lender Price pricing configuration is unavailable, and this environment requires it — pricing will refuse rather than quote from the static fallback.',
    };
  }
  return { foundation, blocked: false, reason: null, message: null };
}

module.exports = {
  configured, login, getSession, apiGet, enrichZip, price, priceDisqualified, pollDisqualified, pollDisqualifiedByKey,
  hasStoredSearch, searchKeyFor, parse, parseFull, parseDisqualified, summarizeRaw, pricingReadiness,
  hasDisqualifyData, buildSearchPayload, buildSearch, fetchDefaultSearch, fetchSmoRegistry,
  loginSelfTest,
  // The raw-payload sink, re-exported so a caller that ends a run — every CLI here — can await
  // `client.capture.flush()` without reaching past the client for it.
  capture: rawCapture,
  // `num` and `magnitude` are exported here for ONE reason: §2.117 split them apart, and the suite that
  // proves the split has to drive the REAL functions. Comparing against a copy of the new logic written
  // inside the test would prove only that the test agrees with itself.
  _internals: { assertAllowed, scrub, basicClientAuthorization, mapPurpose, mapPropertyType, mapPrepay, num, magnitude, AUTH_BASE, API_BASE, ORIGIN, CLIENT_ID, storeKickoff, DISQ_STORE, pollDisqualifiedByKey, hasStoredSearch, searchKeyFor, disqStore, requestIdOf, applyPollDelta, breakerOpen, recordRecovery, foundationProvenance, foundationLiveGate, foundationReadiness, requireLiveFoundation, invalidateSession, invalidateFoundation, RECOVERY_MAX, searchRawWithRecovery,
    renewalPlan, mergeRefreshed, sessionFromTokenBody, refreshSession, authDiagnostics, resetTokenState, reauthenticate, errText, classifyUpstreamError, fetchPpeUserId, invalidatePpeUser,
    refreshBackoffMs, expireRefreshBackoff, REFRESH_GRANT_BACKOFF_MS, REFRESH_GRANT_BACKOFF_MAX_MS },
};
