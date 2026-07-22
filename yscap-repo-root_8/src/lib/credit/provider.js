'use strict';
/**
 * Xactus credit client — SHARED PRODUCTION login (owner-directed 2026-07-22).
 *
 * ONE company login (config.xactusProd, from Render env) is used for every
 * pull — no per-user credential, nobody stores their own login. This module
 * centralizes auth + the pull/reissue call behind a stable interface so the
 * rest of PILOT never touches the vendor wire format.
 *
 * Every pull is a TRI-MERGE (all three bureaus, always). The caller chooses:
 *   pullType    'soft' (pre-application / prequalification, a soft inquiry)   [default]
 *               'hard' (a full credit report, a hard inquiry)
 *   requestType 'reissue' (re-pull an existing report — cheaper/faster)       [default]
 *               'new'     (order a brand-new report)
 *   version     the interface/report version, default '3.4' (config.xactusProd.version)
 *
 * ── PACKET SEAM ──────────────────────────────────────────────────────────────
 * The exact request the endpoint expects and the exact envelope it returns are
 * finalized against Xactus's onboarding packet (their assigned URL + the request/
 * response spec). Those two account-specific pieces are ISOLATED in
 * `buildRequestBody()` and `extractReport()` below — the ONLY functions that need
 * a change when the packet is in hand. Everything else (shared-login auth, the
 * soft/hard + reissue/new + tri-merge + version options, error handling, the
 * returned {xml, pdfBase64} contract) is final. `extractReport()` is written
 * tolerantly so a JSON envelope, a raw MISMO document, or a MISMO doc with an
 * embedded base64 PDF all resolve without a code change.
 */
const cfg = require('../../config').xactusProd || {};

// Always tri-merge — all three national bureaus.
const ALL_BUREAUS = Object.freeze(['Equifax', 'Experian', 'TransUnion']);

function version() { return (cfg.version || '3.4'); }
function configured() { return !!(cfg.endpoint && cfg.username && cfg.password); }
function status() {
  return {
    configured: configured(),
    hasEndpoint: !!cfg.endpoint,
    hasLogin: !!(cfg.username && cfg.password),
    version: version(),
    // never leak the actual credentials — only whether each piece is present
    account: cfg.account ? true : false,
  };
}
function notConfiguredError() {
  const e = new Error('Xactus shared login not configured');
  e.code = 'not_configured';
  e.status = 409;
  e.userMessage = 'The shared Xactus login isn’t set up yet. Add the company Xactus web address, username and password in the system settings, then try again.';
  return e;
}

// Many Xactus/Xactus360 deployments issue a bearer token from a login call;
// others accept HTTP Basic per request. Try a token login, fall back to Basic.
// (Auth mechanics are standard; the exact login path is confirmed via the packet.)
async function authHeader() {
  const base = cfg.endpoint.replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password, clientId: cfg.clientId || undefined, account: cfg.account || undefined }),
    });
    if (r.ok) { const j = await r.json().catch(() => ({})); const t = j.access_token || j.token; if (t) return `Bearer ${t}`; }
  } catch (_) { /* fall through to Basic */ }
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
}

// ── PACKET SEAM #1: the request body Xactus expects ──────────────────────────
// Returns { path, contentType, body } for the order call. Shaped as a MISMO-style
// credit request today; confirm field names/paths against the Xactus packet.
function buildRequestBody({ borrower, pullType, requestType, bureaus, version: v }) {
  const body = {
    interfaceVersion: v,
    // 'Submit' = a brand-new order; 'Reissue' = re-pull an existing report.
    requestType: requestType === 'new' ? 'Submit' : 'Reissue',
    // soft = pre-application/prequalification (soft inquiry); hard = full report.
    inquiryType: pullType === 'hard' ? 'Individual' : 'PreQualification',
    creditRequestType: pullType === 'hard' ? 'CreditReport' : 'PreQualification',
    repositories: {
      equifax: bureaus.includes('Equifax'),
      experian: bureaus.includes('Experian'),
      transUnion: bureaus.includes('TransUnion'),
    },
    account: cfg.account || undefined,
    borrower: {
      firstName: borrower.firstName,
      lastName: borrower.lastName,
      middleName: borrower.middleName || undefined,
      ssn: borrower.ssn,                 // 9 bare digits
      dateOfBirth: borrower.dob || undefined,   // YYYY-MM-DD
      address: {
        line1: (borrower.address && borrower.address.line1) || undefined,
        line2: (borrower.address && borrower.address.line2) || undefined,
        city: (borrower.address && borrower.address.city) || undefined,
        state: (borrower.address && borrower.address.state) || undefined,
        postalCode: (borrower.address && borrower.address.zip) || undefined,
      },
    },
  };
  return { path: '/credit/order', contentType: 'application/json', body: JSON.stringify(body) };
}

// ── PACKET SEAM #2: pull {xml, pdfBase64, vendorReportId} out of the response ──
// Tolerant across the shapes a credit response arrives in.
function extractReport(text, contentType) {
  const ct = String(contentType || '').toLowerCase();
  // (a) JSON envelope: {xml|creditReportXml|mismo, pdf|pdfBase64|document, reportId}
  if (ct.includes('json') || /^\s*\{/.test(text)) {
    let j; try { j = JSON.parse(text); } catch (_) { j = null; }
    if (j) {
      const xml = j.xml || j.creditReportXml || j.mismo || j.mismoXml || j.reportXml || null;
      const pdfBase64 = j.pdf || j.pdfBase64 || j.pdfDocument || j.document || j.reportPdf || null;
      const vendorReportId = j.reportId || j.creditReportId || j.orderId || null;
      if (xml || pdfBase64) return { xml: xml || null, pdfBase64: pdfBase64 || null, vendorReportId };
    }
  }
  // (b) raw XML/MISMO document (optionally with an embedded base64 PDF).
  if (/<\s*\w/.test(text)) {
    return { xml: text, pdfBase64: embeddedPdfBase64(text), vendorReportId: xmlReportId(text) };
  }
  const e = new Error('unrecognized Xactus response');
  e.userMessage = 'Xactus responded, but the report format wasn’t recognized. This is the one piece we finalize against their setup guide.';
  return { xml: null, pdfBase64: null, vendorReportId: null, _unrecognized: true, _raw: text.slice(0, 400), _error: e };
}

// Best-effort: find a base64 PDF embedded in a MISMO document (EMBEDDED_FILE /
// DOCUMENT / PDF element carrying a base64 blob). Returns null if none.
function embeddedPdfBase64(xml) {
  const m = xml.match(/<[^>]*(?:EMBEDDED_FILE|EmbeddedContent|PDF[^>]*|DOCUMENT)[^>]*>\s*([A-Za-z0-9+/=\r\n]{200,})\s*<\//);
  if (m) {
    const b64 = m[1].replace(/\s+/g, '');
    if (/^JVBERi0/.test(b64)) return b64; // base64 of "%PDF-"
    if (b64.length > 200) return b64;      // some vendors don't prefix; keep it, decode validates later
  }
  return null;
}
function xmlReportId(xml) {
  const m = xml.match(/CreditReportIdentifier="([^"]+)"/) || xml.match(/<CreditReportIdentifier>([^<]+)</);
  return m ? m[1] : null;
}

/**
 * Order (or reissue) a tri-merge credit report through the shared login.
 * @returns {Promise<{xml:string|null, pdfBase64:string|null, vendorReportId:string|null}>}
 */
async function pull({ borrower, pullType = 'soft', requestType = 'reissue', bureaus = ALL_BUREAUS, version: v } = {}) {
  if (!configured()) throw notConfiguredError();
  if (!borrower) throw new Error('pull: borrower required');
  v = v || version();
  const auth = await authHeader();
  const req = buildRequestBody({ borrower, pullType, requestType, bureaus, version: v });
  const r = await fetch(cfg.endpoint.replace(/\/+$/, '') + req.path, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': req.contentType, Accept: 'application/json, application/xml' },
    body: req.body,
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`Xactus ${r.status}: ${text.slice(0, 300)}`);
    e.status = 502;
    e.userMessage = `Xactus couldn’t complete the pull (error ${r.status}). ${r.status === 401 || r.status === 403 ? 'The shared login may be wrong or not yet activated.' : 'Please try again in a moment.'}`;
    throw e;
  }
  const out = extractReport(text, r.headers.get && r.headers.get('content-type'));
  if (out._error) throw out._error;
  return { xml: out.xml, pdfBase64: out.pdfBase64, vendorReportId: out.vendorReportId };
}

module.exports = {
  name: 'xactus',
  ALL_BUREAUS,
  configured, status, version, pull,
  // exposed for unit tests + the packet wiring
  _seam: { buildRequestBody, extractReport, embeddedPdfBase64 },
};
