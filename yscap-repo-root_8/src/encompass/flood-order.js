'use strict';
/**
 * src/encompass/flood-order.js — GUARDED FLOOD-ORDER CLIENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE (AND ONLY) WRITE PATH INTO ENCOMPASS — owner-authorized, flood only.
 *
 * The owner authorized, in their own words (2026-07-30), ordering a Life-of-Loan
 * flood determination from ICE Mortgage Technology's OWN flood service through
 * the Encompass API — and NOTHING else ("only be able to order flood right now
 * and not anything extra"). src/lib/integrations/encompass.js stays structurally
 * READ-ONLY and is NOT touched by this module; its read-only test stays green.
 * This module is a SEPARATE, isolated, gated write client whose own fetch guard
 * refuses every request that is not (a) the OAuth token exchange or (b) one of
 * the flood service-ordering calls. It can physically make no other write.
 *
 * Staged rollout (all default OFF), mirroring the Sitewire write model:
 *   ENCOMPASS_FLOOD_ENABLED          master switch (reads + the poll worker)
 *   ENCOMPASS_FLOOD_OUTBOUND_ENABLED separate gate — actually PLACE an order
 *   ENCOMPASS_FLOOD_DRYRUN           build + log the exact order body, send nothing
 * Both switches are re-read at call time via lib/integrations/switches, so an
 * admin can flip them on the API-Health page without a restart.
 *
 * CREDENTIALS: by default this reuses the tenant's existing Encompass creds
 * (cfg.encompass). If the read-only service user is not authorized to ORDER a
 * service, drop a dedicated flood-authorized API user into ENCOMPASS_FLOOD_*
 * (client id/secret/username/password) — it overrides without touching the read
 * path. Secrets live in Render env ONLY, never in source.
 *
 * THE FLOOD SERVICE CONTRACT is confined to ONE descriptor (FLOOD_SERVICE below).
 * ICE's own flood (Enhanced Flood Report / Life-of-Loan) ships on Encompass
 * Partner Connect, ordered with a loan-scoped Service Order call — but the exact
 * endpoint, the flood service/product identifier for the tenant, and where the
 * SFHA flag / zone / certificate PDF sit in the response can only be confirmed
 * against the LIVE tenant. So every one of those is env-overridable and the whole
 * flow ships OFF + dry-run: turn it on in dry-run, confirm the body, place ONE
 * real test order, then enable outbound. No guessed request ever hits production
 * unverified.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const cfg = require('../config');
const switches = require('../lib/integrations/switches');

// ── Config / credentials ────────────────────────────────────────────────────
const enc = cfg.encompass || {};
const flood = cfg.encompassFlood || {};
const BASE = enc.baseUrl || 'https://api.elliemae.com';
const clientId = flood.clientId || enc.clientId;
const clientSecret = flood.clientSecret || enc.clientSecret;
const instanceId = flood.instanceId || enc.instanceId;
const username = flood.username || enc.username;
const password = flood.password || enc.password;

const TOKEN_PATH = '/oauth2/v1/token';

// ── The flood service descriptor (the ONE place the ICE contract lives) ──────
// Defaults are the Encompass Partner Connect "Service Order" shape. Confirm each
// against the live tenant before enabling outbound; every value is env-overridable.
const FLOOD_SERVICE = {
  // 'serviceOrders' = EPC loan-scoped Service Orders (default; ICE's own flood
  // ships here). 'partnerTransactions' = the classic /services partner ordering.
  framework: flood.framework || process.env.ENCOMPASS_FLOOD_FRAMEWORK || 'serviceOrders',
  // The flood partner/service id in the tenant (needed by both frameworks).
  // Discover it from the tenant's configured services once a token exists.
  partnerId: flood.partnerId || process.env.ENCOMPASS_FLOOD_PARTNER_ID || null,
  serviceId: flood.serviceId || process.env.ENCOMPASS_FLOOD_SERVICE_ID || null,
  // The Life-of-Loan flood product name/code the tenant exposes.
  productName: flood.product || process.env.ENCOMPASS_FLOOD_PRODUCT || 'Life of Loan Flood Determination',
  productType: 'Flood',
};

function configured() {
  return !!(clientId && clientSecret && instanceId && (FLOOD_SERVICE.partnerId || FLOOD_SERVICE.serviceId || FLOOD_SERVICE.framework === 'serviceOrders'));
}
function enabled() { return switches.on('ENCOMPASS_FLOOD_ENABLED'); }
function outboundEnabled() { return switches.on('ENCOMPASS_FLOOD_OUTBOUND_ENABLED'); }
function dryrun() { return !!(flood.dryrun || process.env.ENCOMPASS_FLOOD_DRYRUN === '1'); }

// ── Path builders (the guard's allowlist is derived from THESE) ──────────────
const GUID = '[A-Za-z0-9-]{8,64}';
// An order id must contain at least one alphanumeric — the lookahead rejects a
// dots-only id like ".." or "." (which WHATWG-URL would normalize to a parent
// path segment, turning an allowlisted flood GET into a plain loan read).
const ORDID = '(?=[A-Za-z0-9._-]*[A-Za-z0-9])[A-Za-z0-9._-]{1,80}';

function placePath(guid) {
  return FLOOD_SERVICE.framework === 'partnerTransactions'
    ? `/services/v1/partners/${encodeURIComponent(FLOOD_SERVICE.partnerId)}/transactions?view=id`
    : `/encompass/v3/loans/${encodeURIComponent(guid)}/serviceOrders`;
}
function statusPath(guid, orderId) {
  return FLOOD_SERVICE.framework === 'partnerTransactions'
    ? `/services/v1/partners/${encodeURIComponent(FLOOD_SERVICE.partnerId)}/transactions/${encodeURIComponent(orderId)}?generateFileUrls=true`
    : `/encompass/v3/loans/${encodeURIComponent(guid)}/serviceOrders/${encodeURIComponent(orderId)}`;
}
function resourcesPath(guid, orderId) {
  // EPC: downloadable response attachments live here. Partner transactions carry
  // file URLs directly on the status response (generateFileUrls=true above).
  return `/encompass/v3/loans/${encodeURIComponent(guid)}/serviceOrders/${encodeURIComponent(orderId)}/response/resources`;
}

// Every allowed (method, path) — a request that does not match one of these is
// refused BEFORE it hits the wire. This is what makes "flood only" structural.
const ALLOW = [
  { method: 'POST', re: new RegExp(`^${TOKEN_PATH}$`) },
  { method: 'POST', re: new RegExp(`^/encompass/v3/loans/${GUID}/serviceOrders$`) },
  { method: 'POST', re: new RegExp(`^/services/v1/partners/[^/]+/transactions(\\?.*)?$`) },
  { method: 'GET', re: new RegExp(`^/encompass/v3/loans/${GUID}/serviceOrders/${ORDID}(/response/resources)?$`) },
  { method: 'GET', re: new RegExp(`^/services/v1/partners/[^/]+/transactions/${ORDID}(\\?.*)?$`) },
];
function pathAllowed(method, path) {
  return ALLOW.some((a) => a.method === method && a.re.test(path));
}

// HARD GUARD. Every fetch this module builds funnels through here. A method/path
// outside the flood allowlist throws before the request is built — the same
// belt-and-suspenders philosophy as the read-only module's _fetchGuarded, but the
// allowlist is flood-only. A DOWNLOAD of a result file (an opaque signed URL) is
// the one thing that legitimately leaves the base host, so it is fetched by a
// separate, GET-only helper with its own host/https validation (never here).
async function _fetchGuarded(path, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (!pathAllowed(method, path)) {
    // eslint-disable-next-line no-console
    console.error('[encompass-flood] refused non-flood request:', method, path);
    throw new Error(`Encompass flood client refuses ${method} ${path.slice(0, 120)} — flood ordering only.`);
  }
  return fetch(`${BASE}${path}`, init);
}

const withTimeout = (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

// ── Auth ────────────────────────────────────────────────────────────────────
let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 30000) return tokenCache.token;
  if (!clientId || !clientSecret || !instanceId) throw new Error('Encompass flood ordering not configured (client id / secret / instance).');
  const params = { client_id: clientId, client_secret: clientSecret };
  if (username && password) {
    params.grant_type = 'password';
    params.username = `${username}@encompass:${instanceId}`;
    params.password = password;
    params.scope = 'lp';
  } else {
    params.grant_type = 'client_credentials';
    params.scope = `lp instance:${instanceId}`;
  }
  const g = withTimeout(12000);
  try {
    const r = await _fetchGuarded(TOKEN_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Encompass flood token ${r.status}: ${text.slice(0, 160)}`);
    const j = JSON.parse(text);
    tokenCache = { token: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 1800) - 60) * 1000 };
    return j.access_token;
  } finally { g.done(); }
}

// ── Order body (the request the tenant fulfills) ─────────────────────────────
// EPC Service Order shape by default. The KEY bits (which flood product, which
// partner/service) are env-overridable — confirm the exact field names against
// the tenant's flood service definition on the first dry-run.
function buildOrderBody(guid) {
  if (FLOOD_SERVICE.framework === 'partnerTransactions') {
    return {
      requestType: 'newOrder',
      loanId: guid,
      partnerId: FLOOD_SERVICE.partnerId,
      options: { productName: FLOOD_SERVICE.productName, floodProduct: 'LifeOfLoan' },
    };
  }
  // serviceOrders (EPC)
  const body = {
    type: FLOOD_SERVICE.productType,           // 'Flood'
    productName: FLOOD_SERVICE.productName,     // Life-of-Loan flood determination
    options: { floodProduct: 'LifeOfLoan' },
  };
  if (FLOOD_SERVICE.serviceId) body.serviceId = FLOOD_SERVICE.serviceId;
  if (FLOOD_SERVICE.partnerId) body.partnerId = FLOOD_SERVICE.partnerId;
  return body;
}

// ── Tolerant response reading (the exact shape is confirmed on live) ─────────
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}
const DONE = /^(complete|completed|fulfilled|ready|success|succeeded|done|finished)$/i;
const FAILED = /^(error|failed|rejected|cancell?ed|declined)$/i;

// An order id is embedded in URLs we build (statusPath / resourcesPath), so it
// must be a plain token — at least one alphanumeric, no slash, no "..". A vendor
// value that fails this is treated as "no order id" (placeOrder then throws) so a
// garbage id can never be composed into a non-flood path.
function sanitizeOrderId(v) {
  const s = v == null ? '' : String(v).trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(s)) return null;
  if (!/[A-Za-z0-9]/.test(s) || s.includes('..')) return null;
  return s;
}
// Reads an order id out of a place-order response, whatever the wire shape.
function extractOrderId(resp, locationHeader) {
  if (locationHeader) {
    const m = String(locationHeader).match(/([A-Za-z0-9._-]{4,80})\/?$/);
    if (m) { const id = sanitizeOrderId(m[1]); if (id) return id; }
  }
  return sanitizeOrderId(pick(resp || {}, ['id', 'orderId', 'transactionId', 'serviceOrderId', 'orderID']));
}
// Reads {status, sfha, floodZone, fileUrl, determination} out of a status response.
function extractStatus(resp) {
  const r = resp || {};
  const rawStatus = pick(r, ['status', 'orderStatus', 'transactionStatus', 'state']) || '';
  const status = DONE.test(rawStatus) ? 'completed' : FAILED.test(rawStatus) ? 'error' : 'ordered';
  // The determination detail can live in several places depending on the vendor.
  const det = r.determination || r.result || r.floodDetermination || r.response || r;
  const zone = pick(det, ['floodZone', 'zone', 'femaFloodZone', 'nfipFloodZone']);
  let sfha = pick(det, ['sfha', 'inSpecialFloodHazardArea', 'specialFloodHazardArea', 'inSFHA']);
  if (typeof sfha === 'string') sfha = /^(y|yes|true|1|in)/i.test(sfha) ? true : /^(n|no|false|0|out)/i.test(sfha) ? false : null;
  // If no explicit SFHA flag but a zone is known, an A*/V* zone is an SFHA.
  if ((sfha === null || sfha === undefined) && zone) sfha = /^(a|v)/i.test(String(zone).trim());
  // A directly-attached certificate file URL (partner transactions put it here).
  const files = r.files || r.reportFiles || r.attachments || r.resources || [];
  let fileUrl = pick(r, ['reportUrl', 'documentUrl', 'certificateUrl', 'pdfUrl']);
  if (!fileUrl && Array.isArray(files) && files.length) {
    const pdf = files.find((f) => /pdf/i.test(String((f && (f.mimeType || f.contentType || f.name || f.url)) || ''))) || files[0];
    fileUrl = (pdf && (pdf.url || pdf.href || pdf.downloadUrl || pdf.uri)) || null;
  }
  return { status, sfha: sfha === undefined ? null : sfha, floodZone: zone || null, fileUrl, determination: det && typeof det === 'object' ? det : null };
}

async function authedJson(path, init) {
  const token = await getToken();
  const g = withTimeout(30000);
  try {
    const r = await _fetchGuarded(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init && init.headers) },
      signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) { const e = new Error(`Encompass flood ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
    let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { body, location: r.headers.get('location') };
  } finally { g.done(); }
}

// ── Public: place / status / download ────────────────────────────────────────

// Place a flood order against the given Encompass loan GUID. Honors dry-run and
// the outbound write gate (fail-closed). Returns { orderId, dryrun } or throws.
async function placeOrder(guid) {
  if (!guid) throw new Error('placeOrder: loan GUID is required.');
  const body = buildOrderBody(guid);
  if (dryrun()) {
    // eslint-disable-next-line no-console
    console.warn('[encompass-flood][DRYRUN] would POST', placePath(guid), JSON.stringify(body).slice(0, 500));
    return { orderId: null, dryrun: true, body };
  }
  if (!outboundEnabled()) { const e = new Error('Encompass flood ordering is turned off (ENCOMPASS_FLOOD_OUTBOUND_ENABLED).'); e.code = 'FLOOD_OUTBOUND_DISABLED'; throw e; }
  const { body: resp, location } = await authedJson(placePath(guid), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const orderId = extractOrderId(resp, location);
  if (!orderId) { const e = new Error('Flood order placed but no order id came back — cannot track it.'); e.raw = resp; throw e; }
  return { orderId, dryrun: false, raw: resp };
}

// Poll one order's status. Returns { status, sfha, floodZone, fileUrl, determination, raw }.
async function getOrderStatus(guid, orderId) {
  if (!guid || !orderId) throw new Error('getOrderStatus: guid + orderId are required.');
  const { body } = await authedJson(statusPath(guid, orderId), { method: 'GET' });
  const out = extractStatus(body);
  // EPC completed orders expose their files on a separate resources call.
  if (out.status === 'completed' && !out.fileUrl && FLOOD_SERVICE.framework !== 'partnerTransactions') {
    try {
      const res = await authedJson(resourcesPath(guid, orderId), { method: 'GET' });
      const files = res.body.resources || res.body.files || res.body || [];
      const arr = Array.isArray(files) ? files : (files.resources || []);
      const pdf = arr.find((f) => /pdf/i.test(String((f && (f.mimeType || f.contentType || f.name || f.url)) || ''))) || arr[0];
      if (pdf) out.fileUrl = pdf.url || pdf.href || pdf.downloadUrl || pdf.uri || null;
    } catch (_) { /* resources optional — the determination is still recorded */ }
  }
  out.raw = body;
  return out;
}

// An ICE / Encompass host — the only place our OAuth bearer may ever be sent.
// A pre-signed vendor URL (S3, a partner's CDN) is self-authenticating and must
// NOT receive our token; and a non-ICE / internal host must never see it at all.
const ICE_HOST_RE = /(?:^|\.)(elliemae\.com|ice\.com|icemortgagetechnology\.com)$/i;
function isIceHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (ICE_HOST_RE.test(h)) return true;
  try { return h === new URL(BASE).hostname.toLowerCase(); } catch { return false; }
}

// Download the certificate PDF from the (opaque, expiring) result URL Encompass
// hands back. GET-only. SSRF-guarded: https + non-private-IP on EVERY redirect
// hop (via the shared assertPublicHttps), and the Encompass bearer is attached
// ONLY when the current hop is an ICE/Encompass host — so a vendor URL (or a
// malicious one) can never receive our token, and an internal address is refused.
// Returns a Buffer or null.
async function downloadResultFile(url) {
  if (!url) return null;
  const { assertPublicHttps } = require('../sitewire/media-archive');
  const g = withTimeout(45000);
  let current = String(url);
  let token = null;
  try {
    for (let hop = 0; hop < 5; hop++) {
      let u; try { u = new URL(current); } catch { return null; }
      try { await assertPublicHttps(current); }        // https + non-private IP, this hop
      catch (e) { console.warn('[encompass-flood] refusing result url:', e.message); return null; }
      const headers = {};
      if (isIceHost(u.hostname)) { token = token || await getToken(); headers.Authorization = `Bearer ${token}`; }
      const r = await fetch(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: g.signal });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = new URL(r.headers.get('location'), u).toString();  // re-validate + re-decide the bearer next hop
        continue;
      }
      if (!r.ok) throw new Error(`flood result download ${r.status}`);
      const ab = await r.arrayBuffer();
      return Buffer.from(ab);
    }
    throw new Error('flood result download: too many redirects');
  } finally { g.done(); }
}

module.exports = {
  configured, enabled, outboundEnabled, dryrun,
  placeOrder, getOrderStatus, downloadResultFile,
  // exported for tests + the API-Health surface
  FLOOD_SERVICE, buildOrderBody, extractStatus, extractOrderId, sanitizeOrderId, isIceHost, pathAllowed, placePath, statusPath,
};
