'use strict';
/**
 * LONG-TERM (LT) — Encompass (ICE Mortgage Technology / Ellie Mae) READ-ONLY client.
 *
 * This is Long-Term's OWN copy of the Encompass integration, brought in with the
 * owner's written authorization (2026-08-14, recorded in
 * docs/LONG-TERM-AUTHORIZED-COPIES.md): "Pull in and copy the logic, the
 * credentials, the requests, and the authorization … we need to start long-term
 * loans with a full Encompass understanding."
 *
 * It is a by-VALUE copy of src/lib/integrations/encompass.js, made fully
 * self-contained: it imports ZERO RTL code (its own config, its own pacing), so
 * the two products stay completely separate and neither can break the other. It
 * connects to the SAME Encompass tenant as RTL by default (shared credentials via
 * env), but through its own module and its own token cache.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HARD RULE — READ-ONLY (mirrors RTL's owner-directed Encompass freeze).
 * Long-Term ↔ Encompass is a ONE-WAY, READ-ONLY connection. It NEVER mutates
 * anything in Encompass — never PATCHes a loan, never advances a milestone, never
 * updates a field, never uploads, never creates, never deletes. Three — and only
 * three — POSTs are allowed, and all are READ-SHAPED (they RETURN data and change
 * nothing on the Encompass side; think of them as SELECTs that need a body):
 *   (1) POST /oauth2/v1/token                          — OAuth token exchange (auth)
 *   (2) POST /encompass/v3/loanPipeline                — pipeline SEARCH (loan list)
 *   (3) POST /encompass/v3/loans/{guid}/fieldReader    — read fields by field number
 * Every other non-GET verb against ${baseUrl}/encompass/* is refused STRUCTURALLY
 * by _fetchGuarded. Do NOT add apiPost/apiPut/apiPatch/apiDelete. Do NOT add
 * another read-shaped POST to the allowlist without the owner's sign-off in their
 * own words. Long-Term deliberately has NO flood-order (write) module — that one
 * owner-authorized Encompass write is RTL-only.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * To activate (env): LT_ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID (falling back
 * to the shared ENCOMPASS_* vars), plus LT_ENCOMPASS_USERNAME + _PASSWORD for the
 * resource-owner password grant most Encompass tenants use. Optional
 * LT_ENCOMPASS_API_BASE (default https://api.elliemae.com). No secret VALUES live
 * in code — only env-var names.
 */
const cfg = require('../config').encompass;
const killSwitch = require('./enabled');

// The three endpoints on the base URL allowed to see a non-GET request. All are
// READ-SHAPED (return data, mutate nothing). Adding to this list needs the owner's
// sign-off in their own words.
const TOKEN_PATH = '/oauth2/v1/token';
const PIPELINE_SEARCH_PATH = '/encompass/v3/loanPipeline';
const POST_ALLOWLIST = new Set([TOKEN_PATH, PIPELINE_SEARCH_PATH]);

// The fieldReader POST carries the loan GUID, so it is matched by PREFIX + SUFFIX
// rather than exact equality — deliberately narrow: it must start with
// /encompass/v3/loans/ and end with /fieldReader, so no other loan sub-resource
// can slip through. Reading a field BY NUMBER is the only reliable way to get a
// value: the same field number lives at a different JSON path from loan to loan.
const FIELD_READER_PREFIX = '/encompass/v3/loans/';
const FIELD_READER_SUFFIX = '/fieldReader';
function _isFieldReaderPath(url) {
  if (!url.startsWith(cfg.baseUrl + FIELD_READER_PREFIX)) return false;
  const tail = url.slice((cfg.baseUrl + FIELD_READER_PREFIX).length);
  return /^[A-Za-z0-9-]{8,64}\/fieldReader$/.test(tail);
}

// Configured = the app credentials + instance are present. The user login is only
// required for the password grant.
// THE MASTER SWITCH COMES FIRST. One env var (`ENCOMPASS_ENABLED=0`) reports this
// connection as not connected however complete the credentials are, so the sync
// worker, the manual pull button and every file screen all answer the same way from
// one place. The credentials are untouched — they are simply not used while it is
// off. Long-Term reads that switch through its OWN mirror (`./enabled`), because it
// may not import RTL code; the two are pinned together by a test.
function configured() {
  if (!killSwitch.encompassEnabled()) return false;
  return !!(cfg.clientId && cfg.clientSecret && cfg.instanceId);
}

/**
 * STRIP ANY SECRET THAT MIGHT SLIP INTO A STRING LEAVING THIS MODULE.
 *
 * The token endpoint's own response body is put into a thrown message on every
 * failed mint, and `ping()` turns that message into `reason` — which
 * `routes/encompass-knowledge.js` returns in an HTTP response and which every
 * caller logs. So whatever the identity server chose to say about our request
 * travels, verbatim, onto a screen and into the logs.
 *
 * Most OAuth servers answer a bad grant with `{"error":"invalid_client"}` and
 * nothing more. "Most" is not a property you can rely on for a credential, the
 * request we sent it contains the client secret and the user password, and the
 * Lender Price client in this repo has scrubbed for exactly this reason since it
 * shipped. This is the same guard, on the side that had none.
 *
 * The literal secrets are removed first — that is the part that matters and it
 * cannot false-negative — and the token-shaped patterns after, for the values we
 * would not recognise by comparison.
 */
function scrub(s) {
  let out = String(s == null ? '' : s);
  if (cfg.clientSecret) out = out.split(cfg.clientSecret).join('<redacted>');
  if (cfg.password) out = out.split(cfg.password).join('<redacted>');
  out = out.replace(/(access_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
  out = out.replace(/(refresh_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
  out = out.replace(/(Bearer )[A-Za-z0-9._\-]+/g, '$1<redacted>');
  out = out.replace(/((?:client_secret|password)=)[^&\s"]+/gi, '$1<redacted>');
  return out;
}

// The reason has to tell the two states apart: "not configured" on a tenant whose
// credentials are sitting right there sends somebody hunting for a missing value.
function ensure() {
  if (!killSwitch.encompassEnabled()) throw new Error(killSwitch.OFF_REASON);
  if (!configured()) throw new Error('LT Encompass not configured — add LT_ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID (or the shared ENCOMPASS_* vars)');
}

const withTimeout = (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

// Self-contained pacing. RTL funnels Encompass calls through a shared, cross-process
// rate limiter (src/lib/api-rate-limit.js); Long-Term does not import RTL code, so
// it keeps its OWN minimal in-process spacing (serialize calls, keep a small gap).
// It only ever WAITS — it adds no request, method or path of its own. If Long-Term
// ever drives heavy live Encompass traffic against the SAME tenant as RTL, revisit
// this (a shared limiter would need an owner-authorized crossing).
const MIN_GAP_MS = parseInt(process.env.LT_ENCOMPASS_MIN_GAP_MS || '350', 10);

/**
 * ONE REQUEST AT A TIME, with a gap between them.
 *
 * This used to chain only the WAIT — each caller queued behind the previous
 * caller's gap and then fetched — which spaces request STARTS but does not
 * serialise the requests themselves. With a 350ms gap and a fast tenant nothing
 * overlaps, so it read as serial and was described as serial; but the timeouts
 * in this module are 12 to 30 SECONDS, and any request slower than the gap runs
 * alongside the next one. A burst against a slow tenant is exactly when that
 * matters, and exactly when the ceiling does: 30 CONCURRENT, shared with every
 * other integration on this instance, so Long-Term overlapping is not merely
 * Long-Term's problem — it is what starves RTL.
 *
 * So the chain now holds until the request itself SETTLES. It costs nothing
 * today (every Long-Term caller is already a sequential sweep) and it makes the
 * guarantee true rather than incidental. `run` is handed the work instead of the
 * caller awaiting a gap and then fetching on its own, because a promise the
 * caller resolves separately is a chain anybody can step out of by accident.
 */
let _pace = Promise.resolve();
function paced(run) {
  const turn = _pace.then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS))).then(run);
  // The QUEUE must survive a failed request: swallow here only so the next caller
  // still gets its turn — the rejection itself is handed to the caller untouched.
  _pace = turn.then(() => undefined, () => undefined);
  return turn;
}

// HARD READ-ONLY GATE. Every fetch built in this module funnels through here,
// which refuses any method other than GET unless the URL is in the POST allowlist
// (OAuth token + pipeline search + fieldReader).
async function _fetchGuarded(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  // THE MASTER SWITCH, STRUCTURALLY — nothing reaches the wire while Encompass is
  // switched off, even if some path skipped `configured()`. Same belt-and-suspenders
  // shape as the read-only rule below it.
  if (!killSwitch.encompassEnabled()) {
    throw new Error(killSwitch.OFF_REASON);
  }
  const allowedPost = [...POST_ALLOWLIST].some((p) => url === cfg.baseUrl + p || url.startsWith(cfg.baseUrl + p + '?'))
    || _isFieldReaderPath(url);
  if (method !== 'GET' && !allowedPost) {
    console.error('[lt-encompass] refused non-GET request:', method, url);
    throw new Error(`LT Encompass integration is READ-ONLY. Refused ${method} ${url.slice(0, 200)}`);
  }
  if (allowedPost && method !== 'POST') {
    throw new Error(`LT Encompass read-shaped endpoint requires POST (got ${method}).`);
  }
  return paced(() => fetch(url, init));
}

// A GET path against /encompass/* must not reach into the OAuth namespace.
function assertReadOnlyPath(path) {
  const p = String(path || '');
  if (!p) throw new Error('LT Encompass GET path is required.');
  const norm = p.startsWith('/') ? p : `/${p}`;
  if (norm.startsWith('/oauth2/') || norm.startsWith(TOKEN_PATH)) {
    throw new Error('LT Encompass GET may not call the OAuth namespace.');
  }
  return norm;
}

let tokenCache = { token: null, exp: 0 };

/**
 * SINGLE-FLIGHT. The cache is only consulted at the TOP of this function, so a
 * burst of callers that all arrive before the first token comes back each see an
 * empty cache and each mint their own: measured at five concurrent reads issuing
 * FIVE token requests plus the five reads — ten calls where two would do. The
 * pacer below then serialises them, so it costs no concurrency; what it costs is
 * the tenant's call budget, which is 500,000 a day shared with every other
 * integration touching this instance (§12 of the master plan).
 *
 * Nothing in Long-Term issues Encompass reads in parallel TODAY — every caller is
 * a sequential sweep, measured — so this is a hole rather than a leak. It is
 * closed now because the first parallel sweep somebody writes would not notice it:
 * the calls succeed, the sync works, and the only symptom is twice the budget
 * spent, arriving as a rate limit on a busy morning.
 *
 * The in-flight promise is CLEARED on both settle paths — a failed token request
 * must never be handed to the next caller for ever.
 */
let tokenInFlight = null;
async function getToken() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 30000) return tokenCache.token;
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = mintToken().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

async function mintToken() {
  ensure();
  // Developer Connect: resource-owner password grant when a user login is provided
  // (the common tenant setup), otherwise client-credentials. The username rides as
  // `<username>@encompass:<instance-id>` and the scope is `lp`.
  const params = { client_id: cfg.clientId, client_secret: cfg.clientSecret };
  if (cfg.username && cfg.password) {
    params.grant_type = 'password';
    params.username = `${cfg.username}@encompass:${cfg.instanceId}`;
    params.password = cfg.password;
    params.scope = 'lp';
  } else {
    params.grant_type = 'client_credentials';
    params.scope = `lp instance:${cfg.instanceId}`;
  }
  const g = withTimeout(12000);
  try {
    const r = await _fetchGuarded(`${cfg.baseUrl}${TOKEN_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`LT Encompass token ${r.status}: ${scrub(text).slice(0, 160)}`);
    const j = JSON.parse(text);
    tokenCache = { token: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 1800) - 60) * 1000 };
    return j.access_token;
  } finally { g.done(); }
}

/**
 * DIAGNOSTIC ONLY — ask for a token with a given scope and report what came back.
 *
 * Why this exists. `getToken` above asks for `scope=lp` on the password grant. Two
 * independent, widely-used Encompass clients — EncompassRest (.NET) and
 * EncompassConnect (TypeScript) — send **no `scope` parameter at all** on that grant;
 * only the client-credentials grant carries `lp`. That difference matters, because
 * OAuth (RFC 6749 §3.3) says a server receiving no scope applies its own default,
 * which is normally everything the caller is entitled to. So it is possible we have
 * been NARROWING our own token by naming `lp` — and the token introspection that
 * reported `"scope": "lp"` cannot tell us otherwise, because that is precisely what we
 * asked for. Asking for nothing and seeing what we are given is the only way to know,
 * and it costs one read-only call.
 *
 * Pass `null` to omit the scope entirely, or a string to name one.
 *
 * READ-ONLY and side-effect free: it uses the SAME already-allowed token path through
 * the SAME guard, adds no endpoint to the allowlist, and deliberately does NOT touch
 * `tokenCache` — a probe must never leave the app running on a token it minted.
 */
async function tokenProbe(scope) {
  ensure();
  const params = { client_id: cfg.clientId, client_secret: cfg.clientSecret };
  if (cfg.username && cfg.password) {
    params.grant_type = 'password';
    params.username = `${cfg.username}@encompass:${cfg.instanceId}`;
    params.password = cfg.password;
  } else {
    params.grant_type = 'client_credentials';
    params.instance_id = cfg.instanceId;
  }
  if (scope != null) params.scope = String(scope);

  const g = withTimeout(12000);
  try {
    const r = await _fetchGuarded(`${cfg.baseUrl}${TOKEN_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: g.signal,
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* the refusal is sometimes plain text */ }
    return {
      requested: scope == null ? '(omitted)' : scope,
      ok: r.ok,
      status: r.status,
      // What we were actually GRANTED, which is the whole question.
      granted: body && body.scope ? String(body.scope) : (r.ok ? '(not stated)' : null),
      // THE TOKEN ITSELF IS NOT HANDED BACK. It used to be, and no caller has ever
      // read it — the one diagnostic that calls this prints the granted SCOPE and
      // the status. A live credential sitting in a returned object that nothing
      // uses is the worst version of the field-nobody-reads shape this side keeps
      // finding: harmless until somebody logs the whole result.
      error: r.ok ? null : scrub(text).slice(0, 200),
    };
  } finally { g.done(); }
}

// Cheap reachability check: authenticate only.
async function ping() {
  if (!killSwitch.encompassEnabled()) return { ok: false, reason: killSwitch.OFF_REASON };
  if (!configured()) return { ok: false, reason: 'LT_ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID not set' };
  try { await getToken(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

// A minimal authenticated READ against the instance (e.g. '/encompass/v3/loans/{id}').
// Deliberately GET-only.
async function apiGet(path) {
  ensure();
  const norm = assertReadOnlyPath(path);
  const token = await getToken();
  const g = withTimeout(15000);
  try {
    const r = await _fetchGuarded(`${cfg.baseUrl}${norm}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`LT Encompass ${r.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally { g.done(); }
}

// Pipeline SEARCH — the one other read-shaped POST. Returns a loan list. This is
// the only way to find loans by a field like Loan.LoanNumber without knowing the
// opaque Encompass GUID up front. READ-SHAPED — returns rows, mutates nothing.
// `sortOrder` MUST be top-level; `order` is PascalCase Ascending/Descending. A
// single-term filter list must NOT carry an `operator` (Encompass 400s otherwise).
async function pipelineSearch(request, { limit, start } = {}) {
  ensure();
  if (request == null || typeof request !== 'object') throw new Error('pipelineSearch: request object is required.');
  const token = await getToken();
  const g = withTimeout(30000);
  try {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (start != null) qs.set('start', String(start));
    const url = `${cfg.baseUrl}${PIPELINE_SEARCH_PATH}${qs.toString() ? '?' + qs.toString() : ''}`;
    const body = {};
    if (Array.isArray(request.loanIds) && request.loanIds.length) body.loanIds = request.loanIds;
    if (Array.isArray(request.loanFolders) && request.loanFolders.length) body.loanFolders = request.loanFolders;
    if (request.filter && typeof request.filter === 'object') {
      const f = request.filter;
      if (Array.isArray(f.terms) && f.terms.length > 0) {
        const filt = { ...f };
        if (f.terms.length < 2) delete filt.operator;   // Encompass refuses `operator` with one term
        body.filter = filt;
      } else if (f.canonicalName) {
        body.filter = f;   // simple single-term form
      }
    }
    if (Array.isArray(request.sortOrder) && request.sortOrder.length) body.sortOrder = request.sortOrder;
    if (Array.isArray(request.fields) && request.fields.length) body.fields = request.fields;
    if (request.orgType) body.orgType = request.orgType;
    if (request.loanOwnership) body.loanOwnership = request.loanOwnership;
    if (request.includeArchivedLoans != null) body.includeArchivedLoans = String(request.includeArchivedLoans);
    const r = await _fetchGuarded(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`LT Encompass pipeline ${r.status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally { g.done(); }
}

// READ FIELDS BY FIELD NUMBER — the authoritative reader. `ids` is a list of
// Encompass field ids ('1859', '388', 'CX.CAPITALPROVIDER'…); returns a map
// { '1859': 'MW TRADING LLC', '388': '1.000', … }. READ-ONLY: returns values,
// mutates nothing. The response may be an OBJECT map (this tenant's v3) OR an ARRAY
// of { fieldId, value } (v1 / ICE's SDK type) — returned raw; normalize with
// fieldReaderToMap in the field catalog.
async function fieldReader(loanGuid, ids) {
  ensure();
  const guid = String(loanGuid || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(guid)) throw new Error('fieldReader: a loan GUID is required.');
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean);
  if (!list.length) return {};
  const token = await getToken();
  const g = withTimeout(30000);
  try {
    const url = `${cfg.baseUrl}${FIELD_READER_PREFIX}${guid}${FIELD_READER_SUFFIX}`;
    const r = await _fetchGuarded(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(list),
      signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`LT Encompass fieldReader ${r.status}: ${text.slice(0, 300)}`);
    const out = text ? JSON.parse(text) : {};
    return (out && typeof out === 'object') ? out : {};
  } finally { g.done(); }
}

// ── Settings / catalog reads (GET) ────────────────────────────────────────────
// The audit (2026-08-14) verified these two CURRENT paths against the live tenant
// and found the old RTL paths outdated — Long-Term uses the CORRECTED ones:
//   • milestones:      /encompass/v3/settings/milestones          (RTL had .../settings/loan/milestones — 403)
//   • standard fields: /encompass/v3/schemas/loan/standardFields  (RTL had .../settings/loan/standardFields — 403)
//   • custom fields:   /encompass/v3/settings/loan/customFields    (verified live, unchanged)
async function getMilestoneSettings({ includeArchived = false, view = 'Detail' } = {}) {
  const qs = new URLSearchParams({ includeArchived: String(includeArchived), view, start: '0', limit: '100' });
  return apiGet(`/encompass/v3/settings/milestones?${qs.toString()}`);
}
/**
 * ONE milestone's full settings.
 *
 * The LIST answer carries only `{id, name, tpoStatus, consumerStatus,
 * milestoneColor, isArchived}` — the ROLE, the assignment rule and the expected
 * days live only here (verified live, 2026-08-14; see ENCOMPASS-LIVE-API-PROBE §8.3).
 * So a full catalog read is one list call plus one of these per milestone.
 */
async function getMilestoneSetting(id) {
  return apiGet(`/encompass/v3/settings/milestones/${encodeURIComponent(String(id))}`);
}
async function getStandardFieldSchema(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x)).filter(Boolean);
  const qs = new URLSearchParams({ ids: list.join(','), start: '0', limit: '100' });
  return apiGet(`/encompass/v3/schemas/loan/standardFields?${qs.toString()}`);
}
async function getCustomFieldSettings() { return apiGet('/encompass/v3/settings/loan/customFields'); }

// A loan and its live milestone state / log — READ-ONLY.
async function getLoan(loanId) { return apiGet(`/encompass/v3/loans/${encodeURIComponent(loanId)}`); }
async function getLoanMilestones(loanId) { return apiGet(`/encompass/v3/loans/${encodeURIComponent(loanId)}/milestones`); }
async function getLoanMilestoneLogs(loanId) { return apiGet(`/encompass/v3/loans/${encodeURIComponent(loanId)}/milestoneLogs`); }

// READ-ONLY sentinel — importers can check `client.READ_ONLY === true`.
const READ_ONLY = true;

module.exports = {
  name: 'lt-encompass',
  READ_ONLY,
  configured, ensure, ping,
  // diagnostic-only, read-only: see scripts/test-lt-encompass-access-probe.js
  tokenProbe,
  apiGet, pipelineSearch, fieldReader,
  getMilestoneSettings, getMilestoneSetting, getStandardFieldSchema, getCustomFieldSettings,
  getLoan, getLoanMilestones, getLoanMilestoneLogs,
  // exported for the read-only self-test
  _internals: { _fetchGuarded, _isFieldReaderPath, assertReadOnlyPath, POST_ALLOWLIST, TOKEN_PATH, PIPELINE_SEARCH_PATH, scrub },
};
