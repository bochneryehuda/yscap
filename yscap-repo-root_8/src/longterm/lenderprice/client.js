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

const { buildSearch, smoRegistryFromList } = require('./search-model');

const AUTH_BASE = (process.env.LP_AUTH_BASE || 'https://auth.digitallending.com').replace(/\/+$/, '');
const API_BASE = (process.env.LP_API_BASE || 'https://api.digitallending.com').replace(/\/+$/, '');
const ORIGIN = (process.env.LP_ORIGIN || 'https://yscapgroup.digitallending.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.LP_CLIENT_ID || 'acme2';
const TIMEOUT_MS = Number(process.env.LP_TIMEOUT_MS || 60000);
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
async function req(url, { method = 'GET', headers = {}, body = null, bearer = null } = {}) {
  const u = assertAllowed(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
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
async function price(scenario) {
  const s = await getSession();
  if (!s.ok) return { ok: false, ...s };
  const companyId = s.companyId || process.env.LP_COMPANY_ID;
  const userId = s.userId || process.env.LP_USER_ID;
  if (!companyId || !userId) return { ok: false, error: 'lp_no_ids', message: 'Missing companyId/userId from the Lender Price session.' };
  // Build the FULL canonical search model. Prefer the company's LIVE default search (so every
  // current default/config is preserved) and its LIVE special-mortgage-option ids; both fall
  // back to the captured static base / built-in ids when the endpoints are unavailable, so a
  // hand-built minimal payload (which Lender Price rejects with 500) is never sent.
  const [liveBase, smoReg] = await Promise.all([
    fetchDefaultSearch(companyId, userId),
    fetchSmoRegistry(companyId),
  ]);
  const payload = buildSearch({ ...scenario, companyId }, { base: liveBase || undefined, smo: smoReg || undefined });
  const url = `${API_BASE}/rest/v1/lp-ppe-integration/pricing/searchRaw/${encodeURIComponent(companyId)}/${encodeURIComponent(userId)}`;
  let r;
  try {
    r = await req(url, { method: 'POST', bearer: s.token, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { return { ok: false, error: 'lp_price_error', message: scrub(e.message) }; }
  if (r.status === 401) {
    const s2 = await getSession({ force: true });
    if (!s2.ok) return { ok: false, ...s2 };
    try { r = await req(url, { method: 'POST', bearer: s2.token, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch (e) { return { ok: false, error: 'lp_price_error', message: scrub(e.message) }; }
  }
  if (r.status !== 200) return { ok: false, error: 'lp_price_status', http: r.status, message: `searchRaw → ${r.status}`, upstream: scrub((r.text || '').slice(0, 600)), request: payload };
  return { ok: true, raw: r.json != null ? r.json : r.text, request: payload };
}

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
const RATE_KEYS = ['rate', 'noteRate', 'interestRate', 'adjustedRate', 'finalRate'];
const PRICE_KEYS = ['price', 'finalPrice', 'basePrice', 'adjustedPrice', 'netPrice'];
const LENDER_KEYS = ['lenderName', 'investor', 'investorName', 'lender', 'lenderKey'];
const PROGRAM_KEYS = ['programName', 'productName', 'program', 'productCode'];

function parse(raw) {
  const programs = [];
  const seen = new Map();
  walk(raw, {});
  function pushRung(ctx, node) {
    const rate = firstNum(node, RATE_KEYS);
    const price = firstNum(node, PRICE_KEYS);
    if (rate == null || price == null) return;
    const lender = ctx.lender || firstStr(node, LENDER_KEYS) || 'Unknown';
    const program = ctx.program || firstStr(node, PROGRAM_KEYS) || 'Program';
    const key = lender + '||' + program;
    let p = seen.get(key);
    if (!p) { p = { lender, program, rungs: [] }; seen.set(key, p); programs.push(p); }
    p.rungs.push({
      rate, price,
      points: firstNum(node, ['points', 'discountPoints', 'adjustmentPoints']),
      apr: firstNum(node, ['apr', 'annualPercentageRate']),
      monthly: firstNum(node, ['monthlyPayment', 'payment', 'principalAndInterest']),
      lockDays: firstNum(node, ['ratePeriod', 'lockPeriod', 'dayLocks']),
    });
  }
  function hasRate(node) { return RATE_KEYS.some((k) => k in node); }
  function hasPrice(node) { return PRICE_KEYS.some((k) => k in node); }
  function walk(node, ctx) {
    if (node == null || typeof node !== 'object') return;
    const nextCtx = {
      lender: firstStr(node, LENDER_KEYS) || ctx.lender,
      program: firstStr(node, PROGRAM_KEYS) || ctx.program,
    };
    if (hasRate(node) && hasPrice(node)) pushRung(nextCtx, node);
    for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') walk(v, nextCtx); }
  }
  for (const p of programs) {
    p.rungs.sort((a, b) => a.rate - b.rate);
    p.rungCount = p.rungs.length;
    p.minRate = p.rungs.length ? p.rungs[0].rate : null;
    p.maxPrice = p.rungs.reduce((m, r) => (r.price != null && r.price > m ? r.price : m), -Infinity);
    if (!isFinite(p.maxPrice)) p.maxPrice = null;
  }
  return {
    programCount: programs.length,
    lenderCount: new Set(programs.map((p) => p.lender)).size,
    rungCount: programs.reduce((n, p) => n + p.rungCount, 0),
    disqualifiedCount: countArrays(raw, ['disqualifiedData', 'disqualified']),
    programs,
  };
}
function firstNum(o, keys) { for (const k of keys) { if (o[k] != null && isFinite(Number(o[k]))) return Number(o[k]); } return null; }
function firstStr(o, keys) { for (const k of keys) { const v = o[k]; if (typeof v === 'string' && v.trim()) return v.trim(); } return null; }

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
  const seen = new Set();
  const shallow = (o) => { const out = {}; for (const k of Object.keys(o).slice(0, 50)) { const v = o[k]; out[k] = (v && typeof v === 'object') ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : v; } return out; };
  (function walk(node, path, depth, inKey, inLeafs) {
    if (node == null || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (!sampleLeaf && inLeafs) sampleLeaf = { path, node: shallow(node) };
    if (!sampleKeyNode && inKey) sampleKeyNode = { path, node: shallow(node) };
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
  return {
    topKeys: Object.keys(raw).slice(0, 60),
    nonEmptyArrays: Object.fromEntries(Object.entries(arrays).filter(([, n]) => n > 0).slice(0, 60)),
    sampleRateRow,
    sampleLeaf,
    sampleKeyNode,
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
  configured, login, getSession, apiGet, enrichZip, price, parse, summarizeRaw,
  buildSearchPayload, buildSearch, fetchDefaultSearch, fetchSmoRegistry,
  _internals: { assertAllowed, scrub, basicClientAuthorization, mapPurpose, mapPropertyType, mapPrepay, AUTH_BASE, API_BASE, ORIGIN, CLIENT_ID },
};
