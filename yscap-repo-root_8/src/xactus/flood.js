'use strict';
/**
 * src/xactus/flood.js — XACTUS "Flood ReportX" client (MISMO 2.4).
 *
 * The SECOND, cheaper flood-ordering provider (owner-directed 2026-07-30 —
 * "build up xactus flood temporarily … the interface and the main button should
 * use the exact xactus flood … this is much cheaper for us to use"). The Encompass
 * flood provider (src/encompass/flood-*) stays intact but PARKED; which provider
 * the "Order flood certificate" button uses is chosen by FLOOD_ORDER_PROVIDER
 * (default 'xactus'), dispatched in src/flood/dispatch.js.
 *
 * Wired to the Xactus Flood ReportX API from the owner's Postman collection +
 * digest (Flood ReportX 2.4):
 *   • POST a MISMO 2.4 REQUEST_GROUP as the body, Content-Type text/xml.
 *   • An ORIGINAL order (`_ActionType="Original"`) carries the product
 *     (`_Identifier="basic"` or `"life"`, life = Life-of-Loan monitoring), the
 *     borrower name(s), the loan number (LenderCaseIdentifier) and the PROPERTY
 *     address — a flood determination is about the PROPERTY, so the address is the
 *     required input, not the loan number.
 *   • The determination usually returns INSTANTLY in the same response — the
 *     certificate PDF rides back as a base64 EMBEDDED_FILE and the flood zone /
 *     SFHA flag sit on FLOOD_DETERMINATION. A property not on the FEMA maps needs
 *     manual processing: the initial response is an ACK (STATUS code 1000, a
 *     FloodCertificationIdentifier, no PDF) and we poll with a StatusQuery.
 *   • Auth is the shared Xactus login supplied as URL query params
 *     (LoginAccountIdentifier / LoginAccountPassword — the Postman-collection
 *     style) or a Basic header.
 *
 * This module is the wire only; the DB / conditions / PDF-filing orchestration is
 * src/xactus/flood-desk.js. Credentials live in Render env ONLY (config.xactusFlood).
 */
const cfg = require('../config').xactusFlood || {};
const X = require('../lib/mismo/xml');   // dependency-free MISMO XML writer/reader

// The runtime-flags module (API-Health switches) is LAZY-required so the request /
// response helpers stay pure-loadable in unit tests — it pulls in the DB pool.
function _switches() { return require('../lib/integrations/switches'); }

function clean(v) { return v == null ? '' : String(v).trim(); }

function version() { return cfg.version || '2.4'; }
// 'life' = Life-of-Loan (monitored for the life of the loan) — the default for a
// mortgage; 'basic' = a one-time determination (cheaper, no monitoring).
function productIdentifier(override) {
  const p = clean(override) || clean(cfg.product) || 'life';
  return /^basic$/i.test(p) ? 'basic' : 'life';
}
function configured() { return !!(cfg.endpoint && cfg.username && cfg.password); }
function enabled() { return _switches().on('XACTUS_FLOOD_ENABLED'); }
// Test mode: build + log the order but send NOTHING. Settable by env OR live on the
// API-Health page. Checked BEFORE the send so leaving it on can never bill an order.
function dryrun() { return !!(cfg.dryrun || process.env.XACTUS_FLOOD_DRYRUN === '1' || _switches().on('XACTUS_FLOOD_DRYRUN')); }

// Remove the shared Xactus login from any string before it can reach a log or an
// error message. In query-auth mode the login rides in the request URL, so a
// network error echoing the URL would otherwise expose the shared password.
function scrubCredentials(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/(LoginAccountIdentifier|LoginAccountPassword)=[^&\s"']*/gi, '$1=***');
  out = out.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
  for (const secret of [cfg && cfg.password, cfg && cfg.username]) {
    if (secret && String(secret).length >= 3) out = out.split(String(secret)).join('***');
  }
  return out;
}

function status() {
  return {
    configured: configured(),
    hasEndpoint: !!cfg.endpoint,
    hasLogin: !!(cfg.username && cfg.password),
    version: version(),
    product: productIdentifier(),
    authMode: cfg.authMode || 'query',
    enabled: enabled(),
    dryrun: dryrun(),
  };
}

function notConfiguredError() {
  const e = new Error('Xactus flood login not configured');
  e.code = 'not_configured';
  e.status = 409;
  e.userMessage = 'The Xactus flood login isn’t set up yet. Add the Xactus flood web address, username and password in the system settings, then try again.';
  return e;
}

// ── The MISMO 2.4 request document ───────────────────────────────────────────
// One BORROWER element per person. A flood order needs a name only for the record
// — the determination is about the PROPERTY — so an individual borrower is
// Residential (_FirstName + _LastName) and an entity-only borrower is Commercial
// (the company name in _LastName).
function borrowerElements(people, residential) {
  const { el } = X;
  const list = (Array.isArray(people) ? people : []).filter(Boolean);
  if (residential) {
    return list.map((p) => el('BORROWER', { _FirstName: clean(p.firstName), _LastName: clean(p.lastName) }, []));
  }
  // Commercial: the last (business) name carries the company; first name omitted.
  return list.map((p) => el('BORROWER', { _LastName: clean(p.lastName) || clean(p.name) }, []));
}

function isResidential(people) {
  const primary = (Array.isArray(people) ? people : []).filter(Boolean)[0] || {};
  return !!clean(primary.firstName);
}

// Build the Original flood-order request body. `property` = {street, city, state, zip}.
function buildOrderBody({ loanNumber, borrowers, property, product } = {}) {
  const { el } = X;
  const prop = property || {};
  const residential = isResidential(borrowers);
  const req = el('REQUEST_GROUP', { MISMOVersionID: version() }, [
    el('REQUESTING_PARTY', { _Name: clean(cfg.requestingParty) || 'YS Capital Group' }, []),
    el('SUBMITTING_PARTY', { _Name: 'PILOT by YS Capital' }, []),
    el('REQUEST', {}, [el('REQUEST_DATA', {}, [
      el('FLOOD_REQUEST', { _ActionType: 'Original' }, [
        el('_PRODUCT', {}, [el('_NAME', { _Description: residential ? 'Residential' : 'Commercial', _Identifier: productIdentifier(product) }, [])]),
        ...borrowerElements(borrowers, residential),
        el('MORTGAGE_TERMS', { LenderCaseIdentifier: clean(loanNumber) || 'PILOT' }, []),
        el('PROPERTY', {
          _StreetAddress: clean(prop.street),
          _City: clean(prop.city),
          _State: clean(prop.state),
          _PostalCode: clean(prop.zip),
        }, []),
      ]),
    ])]),
  ]);
  return X.render(req);
}

// Build a StatusQuery request for a pending (manual) order.
function buildStatusBody(certId) {
  const { el } = X;
  const req = el('REQUEST_GROUP', { MISMOVersionID: version() }, [
    el('REQUESTING_PARTY', { _Name: clean(cfg.requestingParty) || 'YS Capital Group' }, []),
    el('SUBMITTING_PARTY', { _Name: 'PILOT by YS Capital' }, []),
    el('REQUEST', {}, [el('REQUEST_DATA', {}, [
      el('FLOOD_REQUEST', { FloodCertificationIdentifier: clean(certId), _ActionType: 'StatusQuery' }, []),
    ])]),
  ]);
  return X.render(req);
}

// ── Response reading ─────────────────────────────────────────────────────────
// A completed determination is decided by the PAYLOAD (a certificate PDF or a
// concrete flood-zone / SFHA reading), NEVER by STATUS wording: a `basic` product
// may return the zone with no embedded PDF, and a manual ACK can carry a
// "completed"-ish word with no determination yet. Errors are read off the STATUS
// condition / name / description.
const FAILED = /(error|reject|declin|fail|cancel|unable)/i;

// The certificate PDF is base64 inside FLOOD_RESPONSE/EMBEDDED_FILE/DOCUMENT.
function embeddedPdfBase64(root) {
  const ef = X.firstDeep(root, 'EMBEDDED_FILE');
  if (ef) {
    const doc = X.kid(ef, 'DOCUMENT') || ef;
    const b64 = clean(doc && doc.text).replace(/\s+/g, '');
    if (/^JVBER/.test(b64)) return b64;    // base64 of "%PDF-"
  }
  // Fallback: any DOCUMENT element whose text decodes to a PDF header.
  for (const d of X.allDeep(root, 'DOCUMENT')) {
    const b64 = clean(d.text).replace(/\s+/g, '');
    if (/^JVBER/.test(b64)) return b64;
  }
  return null;
}

// Turn a MISMO 2.4 response into a normalized shape. Never throws for a well-formed
// document; a parse failure is surfaced as an `unrecognized` error by the caller.
function parseResponse(text) {
  const root = X.parse(text);   // RESPONSE_GROUP (throws on malformed input)
  const statusNode = X.firstDeep(root, 'STATUS');
  const stName = X.attr(statusNode, '_Name');
  const stCond = X.attr(statusNode, '_Condition');
  const stDesc = X.attr(statusNode, '_Description');
  const stCode = X.attr(statusNode, '_Code');

  const det = X.firstDeep(root, 'FLOOD_DETERMINATION');
  const certId = det ? clean(X.attr(det, 'FloodCertificationIdentifier')) : '';
  const sfhaRaw = det ? clean(X.attr(det, 'SpecialFloodHazardAreaIndicator')) : '';
  const building = det ? X.firstDeep(det, '_BUILDING_INFORMATION') : null;
  const zone = building ? clean(X.attr(building, 'NFIPFloodZoneIdentifier')) : '';
  const pdfBase64 = embeddedPdfBase64(root);

  // A concrete determination came back = the order is DONE, whatever the wording:
  // a certificate PDF, a FEMA flood zone, or an SFHA indicator. Errors win over a
  // stray result; an ack (cert id, nothing else yet) polls later.
  const hasResult = !!pdfBase64 || !!zone || sfhaRaw !== '';
  const failWords = `${stCond} ${stName} ${stDesc}`.toLowerCase();
  let outStatus;
  if (FAILED.test(failWords)) outStatus = 'error';
  else if (hasResult) outStatus = 'completed';
  else if (certId) outStatus = 'ordered';   // an ACK for a manual order — poll later
  else outStatus = 'error';

  let sfha = null;
  if (/^(y|t|1|in\b)/i.test(sfhaRaw)) sfha = true;
  else if (/^(n|f|0|out\b)/i.test(sfhaRaw)) sfha = false;
  else if (zone) sfha = /^(a|v)/i.test(zone);   // A*/V* zones are Special Flood Hazard Areas

  return {
    status: outStatus,
    certId: certId || null,
    sfha,
    floodZone: zone || null,
    pdfBase64: pdfBase64 || null,
    statusText: stDesc || '',
    code: stCode || '',
    determination: det ? summarizeDetermination(det) : null,
    error: outStatus === 'error' ? (stDesc || 'Xactus reported the flood order failed.') : null,
  };
}

// A small, borrower-safe snapshot of the determination for the record (audit).
function summarizeDetermination(det) {
  const community = X.firstDeep(det, '_COMMUNITY_INFORMATION');
  const building = X.firstDeep(det, '_BUILDING_INFORMATION');
  const out = {
    certifyDate: clean(X.attr(det, 'FloodProductCertifyDate')) || null,
    lifeOfLoan: /^y/i.test(clean(X.attr(det, '_LifeOfLoanIndicator'))) || null,
    floodZone: building ? (clean(X.attr(building, 'NFIPFloodZoneIdentifier')) || null) : null,
    mapNumber: building ? (clean(X.attr(building, 'NFIPMapIdentifier')) || null) : null,
    mapPanelDate: building ? (clean(X.attr(building, 'NFIPMapPanelDate')) || null) : null,
    communityName: community ? (clean(X.attr(community, 'NFIPCommunityName')) || null) : null,
    communityNumber: community ? (clean(X.attr(community, 'NFIPCommunityIdentifier')) || null) : null,
  };
  // Drop null keys so the stored JSON is compact.
  Object.keys(out).forEach((k) => { if (out[k] == null) delete out[k]; });
  return Object.keys(out).length ? out : null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function buildUrlAndHeaders() {
  let url = cfg.endpoint.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'text/xml', Accept: 'application/xml, text/xml' };
  if ((cfg.authMode || 'query') === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  } else {
    const u = new URL(url);
    u.searchParams.set('LoginAccountIdentifier', cfg.username);
    u.searchParams.set('LoginAccountPassword', cfg.password);
    url = u.toString();
  }
  return { url, headers };
}

async function postXml(body) {
  if (!configured()) throw notConfiguredError();
  const { url, headers } = buildUrlAndHeaders();
  let r, respText;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    r = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    respText = await r.text();
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err.message || '').includes('aborted'));
    const e = new Error(`Xactus flood request failed: ${scrubCredentials((err && err.message) || err)}`);
    e.status = aborted ? 504 : 502;
    e.userMessage = aborted
      ? 'Xactus didn’t respond in time. Please try again in a moment — if it keeps timing out, the flood login may not be activated yet.'
      : 'PILOT couldn’t reach Xactus at the flood web address in the settings. Double-check the Xactus flood web address and that the login is activated.';
    throw e;
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    const safe = scrubCredentials(String(respText)).slice(0, 300);
    const e = new Error(`Xactus flood ${r.status}: ${safe}`);
    e.status = 502;
    e.userMessage = `Xactus couldn’t complete the flood order (error ${r.status}). ${r.status === 401 || r.status === 403 ? 'The login may be wrong or not yet activated.' : 'Please try again in a moment.'}`;
    throw e;
  }
  try {
    return parseResponse(respText);
  } catch (_) {
    const e = new Error('unrecognized Xactus flood response');
    e.status = 502;
    e.userMessage = 'Xactus responded, but the flood report format wasn’t recognized. Confirm the exact endpoint with Xactus.';
    throw e;
  }
}

// Place an ORIGINAL flood order. Honors dry-run (build + return the body, send
// nothing). Returns { dryrun, body } on a dry run, else the parsed determination.
async function placeOrder({ loanNumber, borrowers, property, product } = {}) {
  const body = buildOrderBody({ loanNumber, borrowers, property, product });
  if (dryrun()) {
    // eslint-disable-next-line no-console
    console.warn('[xactus-flood][DRYRUN] would POST flood order:', scrubCredentials(body).slice(0, 600));
    return { dryrun: true, body };
  }
  const parsed = await postXml(body);
  return { dryrun: false, ...parsed };
}

// Poll a pending (manual) order's status.
async function getOrderStatus(certId) {
  if (!certId) throw new Error('getOrderStatus: FloodCertificationIdentifier is required.');
  return postXml(buildStatusBody(certId));
}

// ── Connection test (the API-Health "Test now" button) ───────────────────────
function _classifyConnection(status) {
  if (status === 401 || status === 403) {
    return { live: false, detail: `Reached Xactus (so the flood web address is correct), but the login was rejected (error ${status}). The username/password may be wrong, or the flood account isn’t turned on yet — ask Xactus to confirm it’s activated.` };
  }
  if (status === 400 || status === 404 || status === 405 || status === 501) {
    return { live: null, detail: `Reached the Xactus server at that address (it answered with ${status}). The address is reachable; this quick check can’t fully confirm the login — run a real order, or double-check the exact flood endpoint with Xactus.` };
  }
  if (status >= 200 && status < 400) {
    return { live: true, detail: `Connected to Xactus flood successfully (status ${status}). You’re ready to try an order.` };
  }
  return { live: null, detail: `Reached Xactus, but it answered with an unexpected status (${status}). Try a real order, or check with Xactus.` };
}

async function testConnection() {
  if (!configured()) {
    return { configured: false, live: false, detail: 'Not connected yet — add the Xactus flood web address, username and password (in the system settings) first.' };
  }
  let u;
  try { u = new URL(cfg.endpoint); }
  catch (_) { return { configured: true, live: false, detail: 'The Xactus flood web address isn’t a valid link. It must be the full address Xactus gave you, starting with https:// — fix XACTUS_FLOOD_API_URL.' }; }
  if (u.protocol !== 'https:') {
    return { configured: true, live: false, detail: `The Xactus flood web address must start with https:// (it starts with “${u.protocol.replace(':', '')}”). Fix XACTUS_FLOOD_API_URL.` };
  }
  const { url, headers } = buildUrlAndHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { Accept: headers.Accept, ...(headers.Authorization ? { Authorization: headers.Authorization } : {}) }, signal: controller.signal });
    return Object.assign({ configured: true }, _classifyConnection(r.status));
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String((err && err.message) || '').includes('aborted'));
    return { configured: true, live: false, detail: aborted
      ? 'Timed out reaching Xactus (no answer within 15 seconds). The flood address may be wrong, or Xactus can’t be reached from the server.'
      : 'Couldn’t reach Xactus at that flood web address. Double-check XACTUS_FLOOD_API_URL is the exact address Xactus gave you.' };
  } finally { clearTimeout(timer); }
}

module.exports = {
  name: 'xactus-flood',
  configured, enabled, dryrun, status, version, productIdentifier,
  placeOrder, getOrderStatus, testConnection,
  // exposed for unit tests
  _seam: { buildOrderBody, buildStatusBody, parseResponse, embeddedPdfBase64, scrubCredentials, classifyConnection: _classifyConnection },
};
