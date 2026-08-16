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
const { buildSearch, smoRegistryFromList } = require('./search-model');

const AUTH_BASE = (process.env.LP_AUTH_BASE || 'https://auth.digitallending.com').replace(/\/+$/, '');
const API_BASE = (process.env.LP_API_BASE || 'https://api.digitallending.com').replace(/\/+$/, '');
const ORIGIN = (process.env.LP_ORIGIN || 'https://yscapgroup.digitallending.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.LP_CLIENT_ID || 'acme2';
const TIMEOUT_MS = Number(process.env.LP_TIMEOUT_MS || 60000);
// The disqualify poll's READY response is very large (~111 MB — the full failing-lender/rule tree),
// so downloading + parsing it needs far longer than an ordinary price call. A still-computing poll
// returns an empty body and comes back fast, so this longer timeout only ever applies to the ready one.
const DISQUALIFY_TIMEOUT_MS = Number(process.env.LP_DISQUALIFY_TIMEOUT_MS || 240000);
const REFRESH_EARLY_MS = Number(process.env.LP_REFRESH_EARLY_MS || 5 * 60 * 1000); // refresh 5 min early
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
  } catch (e) { return { ok: false, error: 'lp_login_error', message: scrub(e.message) }; }

  if (r.status === 401) {
    return { ok: false, error: 'lp_login_unauthorized', http: 401,
      message: 'Lender Price rejected the login. Check LP_USERNAME, LP_PASSWORD, LP_CLIENT_SECRET, LP_CLIENT_ID, and LP_ORIGIN.' };
  }
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    return { ok: false, error: 'lp_login_failed', http: r.status,
      message: `Lender Price login returned ${r.status}.`, bodyPreview: scrub((r.text || '').slice(0, 200)) };
  }
  const b = r.json;
  return {
    ok: true,
    token: b.access_token,
    refreshToken: b.refresh_token || null,
    expiresAt: Date.now() + (Number(b.expires_in || 3599) * 1000),
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

// ---- token manager: one warm token, single-flight refresh -----------------
let _session = null;      // last successful login result
let _inflight = null;     // a login Promise currently resolving (single-flight)

function _fresh(s) { return s && s.ok && s.token && s.expiresAt - REFRESH_EARLY_MS > Date.now(); }

async function getSession({ force = false } = {}) {
  if (!force && _fresh(_session)) return _session;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const s = await login();
    if (s.ok) _session = s;
    return s;
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

// A single authenticated GET against the API host, re-logging in once on a 401.
async function apiGet(path, { retryOn401 = true } = {}) {
  const s = await getSession();
  if (!s.ok) return { ok: false, ...s };
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  let r;
  try { r = await req(url, { method: 'GET', bearer: s.token }); }
  catch (e) { return { ok: false, error: 'lp_get_error', message: scrub(e.message) }; }
  if (r.status === 401 && retryOn401) {
    const s2 = await getSession({ force: true });
    if (!s2.ok) return { ok: false, ...s2 };
    try { r = await req(url, { method: 'GET', bearer: s2.token }); }
    catch (e) { return { ok: false, error: 'lp_get_error', message: scrub(e.message) }; }
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
const DEFAULTSEARCH_PATH = process.env.LP_DEFAULTSEARCH_PATH || '/rest/v1/lp-ppe-integration/pricing/defaultSearch/{companyId}/{userId}';
const SMO_PATH = process.env.LP_SMO_PATH || '/rest/v1/lp-ppe-integration/pricing/smo/{companyId}';
let _defaultSearch = null;   // { at, model } | { at, model:null } (unavailable, cached to avoid re-hammering)
let _smoRegistry = null;     // { at, map } | { at, map:null }
const FOUNDATION_TTL_MS = Number(process.env.LP_FOUNDATION_TTL_MS || 30 * 60 * 1000);

function fillPath(tpl, companyId, userId) {
  return tpl.replace('{companyId}', encodeURIComponent(companyId || '')).replace('{userId}', encodeURIComponent(userId || ''));
}

// Fetch (and cache) the company's live default search model. Returns the model or null.
async function fetchDefaultSearch(companyId, userId) {
  if (_defaultSearch && Date.now() - _defaultSearch.at < FOUNDATION_TTL_MS) return _defaultSearch.model;
  let model = null;
  try {
    const r = await apiGet(fillPath(DEFAULTSEARCH_PATH, companyId, userId));
    // A usable default search is an object carrying a criteria block (the shape searchRaw expects).
    if (r.ok && r.data && typeof r.data === 'object' && (r.data.criteria || (r.data.search && r.data.search.raw))) {
      model = r.data.criteria ? r.data : (r.data.search && r.data.search.raw) || null;
    }
  } catch { /* fall back to the static base */ }
  _defaultSearch = { at: Date.now(), model };
  return model;
}

// Fetch (and cache) the company's live special-mortgage-option registry as a name→{id,name} Map.
async function fetchSmoRegistry(companyId) {
  if (_smoRegistry && Date.now() - _smoRegistry.at < FOUNDATION_TTL_MS) return _smoRegistry.map;
  let map = null;
  try {
    const r = await apiGet(fillPath(SMO_PATH, companyId));
    const list = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.data) ? r.data.data : (r.data && Array.isArray(r.data.smo) ? r.data.smo : null));
    if (r.ok && list && list.length) map = smoRegistryFromList(list);
  } catch { /* fall back to built-in ids */ }
  _smoRegistry = { at: Date.now(), map };
  return map;
}

// ---- pricing (blueprint step 5): POST searchRaw ---------------------------
// Endpoint (from README + architecture doc):
//   POST /rest/v1/lp-ppe-integration/pricing/searchRaw/{companyId}/{userId}
// Body is built by buildSearchPayload() from the decoded field mapping. Returns the full
// investor rate stack (a large nested tree). VERIFY the exact body against a live searchRaw
// on the first Render run — this module builds from the recordings' decoded mapping.
function sleep(ms) { return new Promise((rs) => setTimeout(rs, ms)); }

// Resolve the session + company/user ids + the live base/SMO foundation once. Shared by the
// qualified price() and the disqualify workflow so both build from the identical model.
async function priceFoundation() {
  const s = await getSession();
  if (!s.ok) return { ok: false, ...s };
  const companyId = s.companyId || process.env.LP_COMPANY_ID;
  const userId = s.userId || process.env.LP_USER_ID;
  if (!companyId || !userId) return { ok: false, error: 'lp_no_ids', message: 'Missing companyId/userId from the Lender Price session.' };
  const [liveBase, smoReg] = await Promise.all([fetchDefaultSearch(companyId, userId), fetchSmoRegistry(companyId)]);
  const url = `${API_BASE}/rest/v1/lp-ppe-integration/pricing/searchRaw/${encodeURIComponent(companyId)}/${encodeURIComponent(userId)}`;
  return { ok: true, session: s, companyId, userId, url, liveBase: liveBase || undefined, smo: smoReg || undefined };
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
  catch (e) { return { ok: false, error: 'lp_price_error', message: scrub(e.message) }; }
  if (r.status === 401) {
    const s2 = await getSession({ force: true });
    if (!s2.ok) return { ok: false, ...s2 };
    s = s2;
    try { r = await req(url, { ...reqOpts, bearer: s.token }); }
    catch (e) { return { ok: false, error: 'lp_price_error', message: scrub(e.message) }; }
  }
  if (r.status !== 200) return { ok: false, error: 'lp_price_status', http: r.status, message: `searchRaw → ${r.status}`, upstream: scrub((r.text || '').slice(0, 600)) };
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
const DISQ_STORE_TTL_MS = Number(process.env.LP_DISQUALIFY_STORE_TTL_MS || 15 * 60 * 1000);
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
// Build the poll body from the stored kickoff body applying the EXACT frontend normalization the
// captured HAR uses: cachedDisqualified=true, the upstream requestId, and four nullable defaults the
// frontend fills in (compensation bounds + rate range) so the poll body matches byte-for-byte.
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
function storeKickoff(url, body, requestId) {
  pruneDisqStore();
  const key = searchKeyFor(body);
  const now = Date.now();
  // Store the kickoff body verbatim (cachedDisqualified is already false on it) + the upstream
  // requestId. Refresh the TTL on a repeat so an active scenario stays pollable.
  DISQ_STORE.set(key, { body, url, requestId: requestId || null, createdAt: now, expiresAt: now + DISQ_STORE_TTL_MS });
  return key;
}

async function price(scenario) {
  const f = await priceFoundation();
  if (!f.ok) return f;
  // Build the FULL canonical search model. Prefer the company's LIVE default search (so every
  // current default/config is preserved) and its LIVE special-mortgage-option ids; both fall
  // back to the captured static base / built-in ids when the endpoints are unavailable, so a
  // hand-built minimal payload (which Lender Price rejects with 500) is never sent.
  const payload = buildSearch({ ...scenario, companyId: f.companyId }, { base: f.liveBase, smo: f.smo });
  const r = await postSearchRaw(f.url, f.session, payload);
  if (!r.ok) return { ...r, request: payload };
  // A normal price IS the disqualify kickoff — store the exact body AND the upstream requestId the
  // response assigned, so a later status poll re-posts it with only cachedDisqualified flipped +
  // that requestId, hitting the SAME computation.
  const searchKey = storeKickoff(f.url, payload, requestIdOf(r.raw));
  return { ok: true, raw: r.raw, request: payload, searchKey };
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
  const f = await priceFoundation();
  if (!f.ok) return f;
  const kickBody = buildSearch({ ...scenario, companyId: f.companyId }, { base: f.liveBase, smo: f.smo, disqualify: { cached: false } });
  const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : Number(process.env.LP_DISQUALIFY_MAX_WAIT_MS || 80000);
  const pollMs = opts.pollMs != null ? opts.pollMs : Number(process.env.LP_DISQUALIFY_POLL_MS || 5000);

  // Phase 1 — kick off + qualified.
  let session = f.session;
  const first = await postSearchRaw(f.url, session, kickBody);
  if (!first.ok) return { ...first, request: kickBody };
  if (first.session) session = first.session;
  // Echo the kickoff's requestId on the poll so it reads the SAME async computation (not a new one),
  // applying the exact frontend normalization delta (cachedDisqualified + requestId + nullable defaults).
  const rid = requestIdOf(first.raw);
  const pollBody = applyPollDelta(kickBody, rid);
  storeKickoff(f.url, kickBody, rid); // also make it pollable by searchKey afterwards
  if (hasDisqualifyData(first.raw)) {
    return { ok: true, ready: true, polls: 0, qualified: first.raw, disqualified: first.raw, request: kickBody };
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
      return { ok: true, ready: true, polls, qualified: first.raw, disqualified: p.raw, request: pollBody };
    }
  }
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
  const entry = DISQ_STORE.get(searchKey);
  if (!entry) return { ok: true, unknown: true, ready: false };
  // Without the upstream requestId the poll can never correlate to the kickoff's computation — it
  // would 202 forever. Surface a named, controlled error instead (the caller re-runs /price).
  if (!entry.requestId) return { ok: false, error: 'lp_missing_request_id', searchKey,
    message: 'The kickoff response did not include an upstream requestId, so the ineligible result cannot be polled. Re-run the price search.' };
  const f = await priceFoundation(); // session/auth only — the scenario body comes from the store
  if (!f.ok) return f;
  const body = applyPollDelta(entry.body, entry.requestId); // cachedDisqualified + requestId + nullable defaults
  const r = await postSearchRaw(entry.url || f.url, f.session, body, { timeoutMs: DISQUALIFY_TIMEOUT_MS });
  if (!r.ok) return { ...r, searchKey };
  if (r.empty || !hasDisqualifyData(r.raw)) return { ok: true, ready: false, searchKey };
  return { ok: true, ready: true, raw: r.raw, searchKey };
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
function mapPurpose(p) { return p === 'Purchase' ? 'Purchase' : (p === 'CashOut' || p === 'CashoutRefinance') ? 'CashoutRefinance' : 'Refinance'; }
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
function num(v) { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; }

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
      out.push({ group, reason: group, type: g.type || null, valueType: null, value: num(g.finalAdjustment != null ? g.finalAdjustment : g.totalAdjustment) });
    }
    for (const a of adjs) {
      if (!a || typeof a !== 'object') continue;
      out.push({ group, reason: a.key || a.name || group, adjType: a.adjType || null, type: a.type || null, valueType: a.valueType || null, value: num(a.llpa != null ? a.llpa : a.adj) });
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
      out[party] = p.adjustments.map((a) => ({ reason: a.key || a.name || null, type: a.type || null, valueType: a.valueType || null, value: num(a.adj != null ? a.adj : a.llpa) }));
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
    });
  }
  finishPrograms(programs);
  return {
    programCount: programs.length,
    lenderCount: new Set(programs.map((p) => p.lender)).size,
    rungCount: programs.reduce((n, p) => n + p.rungCount, 0),
    disqualifiedCount: countArrays(raw, ['disqualifiedData', 'disqualified']),
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
  return {
    programCount: programs.length,
    lenderCount: new Set(programs.map((p) => p.lender)).size,
    optionCount: options.length,
    disqualifiedCount: countArrays(raw, ['disqualifiedData', 'disqualified']),
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
  return { programCount: programs.length, lenderCount: new Set(programs.map((p) => p.lender)).size, rungCount: programs.reduce((n, p) => n + p.rungCount, 0), disqualifiedCount: countArrays(raw, ['disqualifiedData', 'disqualified']), programs };
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
      if (Array.isArray(arr)) for (const a of arr) add(a && (a.key || a.name), { group: g.name || null, value: num(a && (a.llpa != null ? a.llpa : a.adj)) });
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
function countArrays(root, keys) {
  let n = 0; const stack = [root]; const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (node == null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (keys.includes(k) && Array.isArray(v)) n += v.length;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return n;
}

module.exports = {
  configured, login, getSession, apiGet, enrichZip, price, priceDisqualified, pollDisqualified, pollDisqualifiedByKey,
  hasStoredSearch, searchKeyFor, parse, parseFull, parseDisqualified, summarizeRaw,
  hasDisqualifyData, buildSearchPayload, buildSearch, fetchDefaultSearch, fetchSmoRegistry,
  _internals: { assertAllowed, scrub, basicClientAuthorization, mapPurpose, mapPropertyType, mapPrepay, AUTH_BASE, API_BASE, ORIGIN, CLIENT_ID, storeKickoff, DISQ_STORE, requestIdOf, applyPollDelta },
};
