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
 * WHY THE LOGIN WAS BEING REJECTED (root cause, confirmed 2026-08-16 from a real HAR)
 *   The token endpoint accepts a login ONLY when it arrives "from" the company page — i.e.
 *   with Origin/Referer = https://yscapgroup.digitallending.com. A byte-identical body with
 *   no Origin header returns 401 Unauthorized. Every request here therefore carries the
 *   company Origin/Referer, exactly as the browser does. This mirrors the Sitewire
 *   web-client "browser robot" pattern (src/sitewire/web-client.js).
 *
 * SAFETY, by construction:
 *   - LONG-TERM ONLY. Self-contained: reads process.env directly, imports NO RTL code,
 *     touches no database. (Product-separation gate: nothing crosses.)
 *   - Credentials come from Render env ONLY (LP_USERNAME / LP_PASSWORD). Never hardcoded,
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
  return { username, password, ok: !!(username && password) };
}
function configured() { return credentials().ok; }

// Strip any secret that might slip into an error string.
function scrub(s) {
  let out = String(s == null ? '' : s);
  const { password } = credentials();
  if (password) out = out.split(password).join('<redacted>');
  out = out.replace(/(access_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
  out = out.replace(/(refresh_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
  out = out.replace(/(Bearer )[A-Za-z0-9._\-]+/g, '$1<redacted>');
  out = out.replace(/(password=)[^&\s"]+/gi, '$1<redacted>');
  return out;
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
//   username, password, grant_type=password, client_id  + Origin/Referer of the company page.
// Returns { ok, token, refreshToken, expiresAt, companyId, userId, profile } or { ok:false, error, message }.
async function login() {
  const c = credentials();
  if (!c.ok) return { ok: false, error: 'lp_creds_missing', message: 'Set LP_USERNAME and LP_PASSWORD in Render to enable Lender Price pricing.' };
  const form = new URLSearchParams({
    username: c.username, password: c.password, grant_type: 'password', client_id: CLIENT_ID,
  }).toString();
  let r;
  try {
    r = await req(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form,
    });
  } catch (e) { return { ok: false, error: 'lp_login_error', message: scrub(e.message) }; }

  if (r.status === 401) {
    return { ok: false, error: 'lp_login_unauthorized', http: 401,
      message: 'Lender Price rejected the login. Check LP_USERNAME/LP_PASSWORD, and that LP_ORIGIN is the company page (the login is accepted only when it comes from there).' };
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
  const payload = buildSearchPayload(scenario);
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
  if (r.status !== 200) return { ok: false, error: 'lp_price_status', http: r.status, message: `searchRaw → ${r.status}`, body: scrub((r.text || '').slice(0, 300)), request: payload };
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
function parse(raw) {
  const programs = [];
  const seen = new Map();
  walk(raw, {});
  function pushRung(ctx, node) {
    const rate = firstNum(node, ['rate', 'noteRate', 'interestRate']);
    const price = firstNum(node, ['price', 'finalPrice', 'basePrice']);
    if (rate == null || price == null) return;
    const lender = ctx.lender || node.lenderName || node.investor || 'Unknown';
    const program = ctx.program || node.programName || node.productName || node.program || 'Program';
    const key = lender + '||' + program;
    let p = seen.get(key);
    if (!p) { p = { lender, program, rungs: [] }; seen.set(key, p); programs.push(p); }
    p.rungs.push({
      rate, price,
      points: firstNum(node, ['points', 'discountPoints']),
      apr: firstNum(node, ['apr', 'annualPercentageRate']),
      monthly: firstNum(node, ['monthlyPayment', 'payment', 'principalAndInterest']),
    });
  }
  function walk(node, ctx) {
    if (node == null || typeof node !== 'object') return;
    const nextCtx = {
      lender: node.lenderName || node.investor || node.lender || ctx.lender,
      program: node.programName || node.productName || ctx.program,
    };
    if (('rate' in node || 'noteRate' in node) && ('price' in node || 'finalPrice' in node)) pushRung(nextCtx, node);
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
    programs,
  };
}
function firstNum(o, keys) { for (const k of keys) { if (o[k] != null && isFinite(Number(o[k]))) return Number(o[k]); } return null; }

module.exports = {
  configured, login, getSession, apiGet, enrichZip, price, parse,
  buildSearchPayload,
  _internals: { assertAllowed, scrub, mapPurpose, mapPropertyType, mapPrepay, AUTH_BASE, API_BASE, ORIGIN, CLIENT_ID },
};
