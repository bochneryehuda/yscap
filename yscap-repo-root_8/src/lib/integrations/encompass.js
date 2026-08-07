'use strict';
/**
 * Encompass (ICE Mortgage Technology / Ellie Mae) — the loan-origination system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HARD RULE — READ-ONLY, FROZEN (owner-directed 2026-07-22).
 * PILOT ↔ Encompass is a ONE-WAY, READ-ONLY connection. PILOT NEVER MUTATES
 * anything in Encompass — NEVER PATCHes a loan, NEVER advances a milestone,
 * NEVER updates a field, NEVER uploads to eFolder, NEVER creates a loan, NEVER
 * deletes anything. Two — and ONLY two — POSTs are allowed, and both are
 * READ-SHAPED (they RETURN data without changing anything on the Encompass
 * side; think of them as SQL SELECTs that happen to need a body):
 *   (1) `POST /oauth2/v1/token`         — OAuth token exchange (authentication)
 *   (2) `POST /encompass/v3/loanPipeline` — pipeline SEARCH (returns loan list)
 * Every other non-GET verb against `${baseUrl}/encompass/*` is refused
 * STRUCTURALLY by `_fetchGuarded`. Do NOT add `apiPost`/`apiPut`/`apiPatch`/
 * `apiDelete` to this module. Do NOT add another entry to the read-shaped POST
 * allowlist without owner sign-off in their own words — the two above are the
 * spec, not a template. The rule is layered:
 * (1) only READ helpers are exported (`configured`, `ping`, `apiGet`,
 *     `pipelineSearch`, `READ_ONLY`); no `apiWrite*` / `updateLoan` / etc.;
 * (2) `assertReadOnlyPath` blocks any path in the OAuth namespace from being
 *     called via `apiGet` (safety belt);
 * (3) `_fetchGuarded` enforces the POST allowlist at fetch build time —
 *     any other method is thrown before it hits the wire.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Framework client: Encompass access is per-INSTANCE via Developer Connect (OAuth2), so the
 * loan-level FIELD MAPPING is finalized against YOUR Encompass instance once credentials exist.
 * This module centralizes auth behind a stable interface + a `ping()` for the API Health page.
 *
 * To activate (env): ENCOMPASS_CLIENT_ID, ENCOMPASS_CLIENT_SECRET, ENCOMPASS_INSTANCE_ID
 * (your instance / smart-client id), and — for the resource-owner grant most Encompass tenants
 * use — ENCOMPASS_USERNAME + ENCOMPASS_PASSWORD. Optional ENCOMPASS_API_BASE (default
 * https://api.elliemae.com).
 */
const cfg = require('../../config').encompass;

// The two endpoints on the base URL that are allowed to see a non-GET request.
// Both are READ-SHAPED (return data, mutate nothing on Encompass). Adding to
// this list requires owner sign-off in their own words — see the header rule.
const TOKEN_PATH = '/oauth2/v1/token';
const PIPELINE_SEARCH_PATH = '/encompass/v3/loanPipeline';
const POST_ALLOWLIST = new Set([TOKEN_PATH, PIPELINE_SEARCH_PATH]);
// THIRD read-shaped POST, added with the owner's explicit sign-off (2026-07-26):
// "Go ahead with all the fixes", answering a direct request to allow reading
// Encompass fields BY FIELD NUMBER. Encompass exposes that as a POST only because
// the list of field ids travels in the JSON body — it RETURNS values and mutates
// nothing. It is required for correctness, not convenience: the same field number
// lives at a DIFFERENT place in the loan JSON from loan to loan (field 1859 sat in
// closingDocument.finalVestingDescription on one loan and was absent on 117 Brook,
// where the LLC name lived in borrowerUnparsedName1), and field 388's real value
// (1.000) appears at NO stable path — the path we had been reading held a different
// fee entirely (2), which is exactly the 1%-vs-2% the owner reported. Reading by
// field number is the only way to be right on every loan.
// The path carries the loan GUID, so it is matched by PREFIX + SUFFIX rather than
// exact equality — deliberately narrow: it must start with /encompass/v3/loans/ and
// end with /fieldReader, so no other loan sub-resource can slip through.
const FIELD_READER_PREFIX = '/encompass/v3/loans/';
const FIELD_READER_SUFFIX = '/fieldReader';
function _isFieldReaderPath(url) {
  if (!url.startsWith(cfg.baseUrl + FIELD_READER_PREFIX)) return false;
  const tail = url.slice((cfg.baseUrl + FIELD_READER_PREFIX).length);
  // exactly "<guid>/fieldReader" — one segment then the suffix, no query, no extras
  return /^[A-Za-z0-9-]{8,64}\/fieldReader$/.test(tail);
}

// Configured = the app credentials + instance are present. The user login is only required for the
// password grant; a client-credentials tenant needs just the three.
function configured() { return !!(cfg.clientId && cfg.clientSecret && cfg.instanceId); }
function ensure() { if (!configured()) throw new Error('Encompass not configured — add ENCOMPASS_CLIENT_ID / ENCOMPASS_CLIENT_SECRET / ENCOMPASS_INSTANCE_ID'); }

const withTimeout = (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

// HARD READ-ONLY GATE. Every fetch built INSIDE this module is funneled through
// _fetchGuarded, which refuses any method other than GET unless the URL is in
// the POST_ALLOWLIST (OAuth token + pipeline search). This is the belt-AND-
// suspenders backstop behind the "only READ helpers are exported" contract.
async function _fetchGuarded(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  const allowedPost = [...POST_ALLOWLIST].some((p) => url === cfg.baseUrl + p || url.startsWith(cfg.baseUrl + p + '?'))
    || _isFieldReaderPath(url);
  if (method !== 'GET' && !allowedPost) {
    // eslint-disable-next-line no-console
    console.error('[encompass] refused non-GET request:', method, url);
    throw new Error(`Encompass integration is READ-ONLY (owner-directed freeze). Refused ${method} ${url.slice(0, 200)}`);
  }
  if (allowedPost && method !== 'POST') {
    throw new Error(`Encompass read-shaped POST endpoint requires POST (got ${method}).`);
  }
  // Shared-across-processes pacing (lib/api-rate-limit.js, db/482). READ-ONLY still: this
  // only ever WAITS, and adds no request, method or path of its own.
  await require('../api-rate-limit').acquire('encompass');
  return fetch(url, init);
}

// A GET path against /encompass/* must not reach into the OAuth namespace.
function assertReadOnlyPath(path) {
  const p = String(path || '');
  if (!p) throw new Error('Encompass GET path is required.');
  const norm = p.startsWith('/') ? p : `/${p}`;
  if (norm.startsWith('/oauth2/') || norm.startsWith(TOKEN_PATH)) {
    throw new Error('Encompass GET may not call the OAuth namespace.');
  }
  return norm;
}

let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 30000) return tokenCache.token;
  ensure();
  // Developer Connect: resource-owner password grant when a user login is provided (the common
  // tenant setup), otherwise client-credentials. The instance id rides as `client_id@instance`.
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
    if (!r.ok) throw new Error(`Encompass token ${r.status}: ${text.slice(0, 160)}`);
    const j = JSON.parse(text);
    tokenCache = { token: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 1800) - 60) * 1000 };
    return j.access_token;
  } finally { g.done(); }
}

// Cheap reachability check for the API Health page: authenticate only.
async function ping() {
  if (!configured()) return { ok: false, reason: 'ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID not set' };
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
    if (!r.ok) throw new Error(`Encompass ${r.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally { g.done(); }
}

// Pipeline SEARCH — the ONE other read-shaped POST. Returns a loan list.
// This endpoint is the only way to find loans by fields like `Loan.LoanNumber`
// without knowing the opaque Encompass GUID up front. It is READ-SHAPED — it
// returns loan rows, mutates nothing.
//
// Request shape (Encompass Developer Connect):
//   {
//     "loanIds":   [ "guid1", "guid2", ... ],           // OR
//     "loanFolders": [ "My Pipeline", "Prospects" ],     // OR
//     "filter":    { "canonicalName":"...", "value":"...", "matchType":"Exact" } // simple form (ONE term)
//               or  { "operator":"and", "terms":[...] }  // complex form — operator only with 2+ terms
//                   // (a single-term list must NOT carry an operator; Encompass 400s otherwise)
//     "sortOrder": [ { "canonicalName":"Loan.LastModified", "order":"Descending" } ],
//     "fields":    [ "Loan.LoanNumber", ... ],
//     "orgType": "Internal", "loanOwnership": "AllLoans"  // optional
//   }
// Encompass REQUIRES one of loanIds / loanFolders / filter / fieldFilters —
// a body with none of those is refused ("Either 'LoanIds' or filter properties
// like 'LoanFolders', 'Filter' or 'FieldFilters' must be supplied.", 2026-07-22
// live diag). To pull "all loans" the caller passes `loanFolders` = every
// folder name in the tenant (fetched from GET /settings/loan/folders).
// `sortOrder` MUST be at the TOP LEVEL and `order` values are PascalCase
// "Ascending"/"Descending". Pagination via `?limit=N&start=M`.
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
    // Every property below is placed at the TOP LEVEL of the body — that's
    // the shape Encompass Developer Connect requires. `filter` accepts both
    // the "simple" form ({canonicalName,value,matchType}) and the "complex"
    // form ({operator,terms:[...]}) — passed through as-is.
    const body = {};
    if (Array.isArray(request.loanIds) && request.loanIds.length) body.loanIds = request.loanIds;
    if (Array.isArray(request.loanFolders) && request.loanFolders.length) body.loanFolders = request.loanFolders;
    if (request.filter && typeof request.filter === 'object') {
      const f = request.filter;
      // Accept both shapes; only include if it actually carries a term.
      if (Array.isArray(f.terms) && f.terms.length > 0) {
        // Complex form ({operator,terms:[...]}). Encompass REFUSES an `operator`
        // when only ONE term is supplied ("If only one filter term is supplied in
        // the list 'Terms', 'Operator' does not apply." — live 400, 2026-07-26), so
        // send `operator` ONLY with 2+ terms; a single-term list goes bare. This
        // is a read-shaped body normalization only — no write path, same endpoint.
        const filt = { ...f };
        if (f.terms.length < 2) delete filt.operator;
        body.filter = filt;
      } else if (f.canonicalName) {
        // Simple form — a single {canonicalName,value,matchType} term; no operator.
        body.filter = f;
      }
    }
    if (Array.isArray(request.sortOrder) && request.sortOrder.length) body.sortOrder = request.sortOrder;
    if (Array.isArray(request.fields) && request.fields.length) body.fields = request.fields;
    if (request.orgType) body.orgType = request.orgType;
    if (request.loanOwnership) body.loanOwnership = request.loanOwnership;
    if (request.includeArchivedLoans != null) body.includeArchivedLoans = String(request.includeArchivedLoans);
    const r = await _fetchGuarded(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Encompass pipeline ${r.status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally { g.done(); }
}

// READ-ONLY sentinel — anything that imports this module can check
// `encompass.READ_ONLY === true` before wiring up code that assumes it can write.
const READ_ONLY = true;


// READ FIELDS BY FIELD NUMBER — the authoritative reader (owner sign-off 2026-07-26).
// `ids` is a list of Encompass field ids ('1859', '388', 'CX.CAPITALPROVIDER'…);
// returns { '1859': 'MW TRADING LLC', '388': '1.000', … }. Read-only: it returns
// values and mutates nothing. Prefer this over guessing a JSON path — the same
// field number lives in different places on different loans.
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
    if (!r.ok) throw new Error(`Encompass fieldReader ${r.status}: ${text.slice(0, 300)}`);
    const out = text ? JSON.parse(text) : {};
    // Return the RAW parsed body — it may be an OBJECT map { "388":"1.000" } (this
    // tenant's v3) OR an ARRAY of { fieldId, value } pairs (v1 / ICE's own SDK type).
    // The client wrapper (encompass-field-map.fieldReaderToMap) normalizes BOTH into a
    // flat { id: value } map. The old code discarded an array as `{}` — the exact bug
    // that silently blanked _fieldValues and made the panel read the wrong JSON paths.
    return (out && typeof out === 'object') ? out : {};
  } finally { g.done(); }
}

module.exports = { name: 'encompass', configured, ping, apiGet, pipelineSearch, fieldReader, READ_ONLY };
