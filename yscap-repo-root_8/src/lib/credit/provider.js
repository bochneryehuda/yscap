'use strict';
/**
 * Xactus credit client — SHARED PRODUCTION login (owner-directed 2026-07-22).
 *
 * ONE company login (config.xactusProd, from Render env) is used for every
 * pull — no per-user credential, nobody stores their own login. This module
 * centralizes auth + the pull/reissue call behind a stable interface so the
 * rest of PILOT never touches the vendor wire format.
 *
 * Wired to the Xactus "Credit ReportX" API (MISMO 3.4), from the owner's
 * onboarding packet (the CRx / PQx Postman collection):
 *   • POST the borrower as a MISMO 3.4 `MESSAGE` document, Content-Type text/xml.
 *   • Every pull is a TRI-MERGE (all three CreditRepositoryIncluded*Indicator).
 *   • pullType  'soft' → PQx (CreditReportType=Other + …OtherDescription=SoftCheck)
 *               'hard' → CRx (CreditReportType=Merge)              [full report]
 *   • requestType 'reissue' → CreditReportRequestActionType=Reissue (needs the
 *                             prior report's CreditReportIdentifier)
 *                 'new'     → …ActionType=Submit (empty CreditReportIdentifier)
 *   • MISMOReferenceModelIdentifier = the interface version (default '3.4').
 * The response is a MISMO 3.4 MESSAGE carrying the CREDIT_RESPONSE (scores /
 * liabilities / inquiries / public records — parsed by ./parse.js) and the PDF
 * embedded in a VIEW_FILE. Auth is the login (Basic header by default; a 'query'
 * mode sends LoginAccountIdentifier/LoginAccountPassword query params instead).
 */
const cfg = require('../../config').xactusProd || {};
const X = require('../mismo/xml');   // dependency-free MISMO XML writer/reader

// Always tri-merge — all three national bureaus.
const ALL_BUREAUS = Object.freeze(['Equifax', 'Experian', 'TransUnion']);

function version() { return (cfg.version || '3.4'); }
function configured() { return !!(cfg.endpoint && cfg.username && cfg.password); }

// Remove the shared Xactus login from any string before it can reach an error
// message or a log. In query-auth mode the login rides in the request URL, so a
// network error that echoes the URL would otherwise expose the shared password —
// the login must never appear in an error or a log line.
function scrubCredentials(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/(LoginAccountIdentifier|LoginAccountPassword)=[^&\s"']*/gi, '$1=***');   // login in URL query
  out = out.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');                                  // scheme://user:pass@host
  for (const secret of [cfg && cfg.password, cfg && cfg.username]) {                            // belt-and-suspenders: the literal values
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
    authMode: cfg.authMode || 'basic',
    account: cfg.account ? true : false,   // never leak the value, only presence
  };
}
function notConfiguredError() {
  const e = new Error('Xactus shared login not configured');
  e.code = 'not_configured';
  e.status = 409;
  e.userMessage = 'The shared Xactus login isn’t set up yet. Add the company Xactus web address, username and password in the system settings, then try again.';
  return e;
}

// The "yyyy-mm-ddThh:mm:ssZ" stamp MISMO wants (no milliseconds).
function mismoNow() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

// ── PACKET SEAM #1: the MISMO 3.4 credit request MESSAGE ──────────────────────
// Built with the mismo/xml writer (leaf() omits blank values). Mirrors the
// Xactus CRx/PQx examples 1:1; the product/action mapping is the only variance.
function buildRequestBody({ borrower, pullType, requestType, bureaus, version: v, reissueReportId, loanNumber, company }) {
  const { el, leaf } = X;
  const b = borrower || {};
  const addr = b.address || {};
  const fullName = [b.firstName, b.middleName, b.lastName].filter(Boolean).join(' ');

  // product → CreditReportType
  const reportTypeEls = pullType === 'hard'
    ? [leaf('CreditReportType', 'Merge')]
    : [leaf('CreditReportType', 'Other'), leaf('CreditReportTypeOtherDescription', 'SoftCheck')];

  // action → CreditReportRequestActionType; Reissue carries the prior report id,
  // Submit leaves CreditReportIdentifier empty.
  const action = requestType === 'new' ? 'Submit' : 'Reissue';
  const reportIdEl = (action === 'Reissue' && reissueReportId)
    ? leaf('CreditReportIdentifier', reissueReportId)
    : el('CreditReportIdentifier', {}, ['']);   // renders <CreditReportIdentifier></CreditReportIdentifier>

  const messageParty = (seq, name, roleType, label) => el('PARTY', { SequenceNumber: String(seq) }, [
    el('LEGAL_ENTITY', {}, [el('LEGAL_ENTITY_DETAIL', {}, [leaf('FullName', name)])]),
    el('ROLES', {}, [el('ROLE', { 'xlink:label': label }, [el('ROLE_DETAIL', {}, [leaf('PartyRoleType', roleType)])])]),
  ]);

  const msg = el('MESSAGE', {
    MISMOReferenceModelIdentifier: v || '3.4',
    xmlns: 'http://www.mismo.org/residential/2009/schemas',
    'xmlns:xlink': 'http://www.w3.org/1999/xlink',
  }, [
    el('ABOUT_VERSIONS', {}, [el('ABOUT_VERSION', {}, [
      el('AboutVersionIdentifier', { IdentifierOwnerURI: 'http://www.yscapgroup.com' }, ['PILOT by YS Capital']),
      el('DataVersionIdentifier', { IdentifierOwnerURI: 'http://www.mismo.org' }, [v || '3.4']),
      leaf('DataVersionName', 'PILOT Credit'),
    ])]),
    el('DEAL_SETS', {}, [
      el('DEAL_SET', {}, [el('DEALS', {}, [el('DEAL', {}, [
        el('LOANS', {}, [el('LOAN', { LoanRoleType: 'SubjectLoan' }, [
          el('LOAN_IDENTIFIERS', {}, [el('LOAN_IDENTIFIER', {}, [
            leaf('LoanIdentifier', loanNumber || 'PILOT'),
            leaf('LoanIdentifierType', 'LenderCase'),
          ])]),
          el('TERMS_OF_LOAN', {}, [leaf('MortgageType', 'Conventional')]),
        ])]),
        el('PARTIES', {}, [el('PARTY', { SequenceNumber: '1' }, [
          el('INDIVIDUAL', {}, [el('NAME', {}, [
            leaf('FirstName', b.firstName),
            leaf('FullName', fullName),
            leaf('LastName', b.lastName),
            leaf('MiddleName', b.middleName),
          ])]),
          el('ROLES', {}, [el('ROLE', { 'xlink:label': 'Borrower01' }, [
            el('BORROWER', {}, [
              // Date of birth (standard MISMO 3.4 location) — the bureaus resolve
              // identity on name + SSN + DOB + address; the review screen also
              // shows the DOB as "what we'll send", so it must actually be sent.
              ...(b.dob ? [el('BORROWER_DETAIL', {}, [leaf('BorrowerBirthDate', b.dob)])] : []),
              el('RESIDENCES', {}, [el('RESIDENCE', { SequenceNumber: '1' }, [
                el('ADDRESS', {}, [
                  leaf('AddressLineText', addr.line1),
                  leaf('CityName', addr.city),
                  leaf('PostalCode', addr.zip),
                  leaf('StateCode', addr.state),
                ]),
                el('RESIDENCE_DETAIL', {}, [leaf('BorrowerResidencyType', 'Current')]),
              ])]),
            ]),
            el('ROLE_DETAIL', {}, [leaf('PartyRoleType', 'Borrower')]),
          ])]),
          el('TAXPAYER_IDENTIFIERS', {}, [el('TAXPAYER_IDENTIFIER', {}, [
            leaf('TaxpayerIdentifierType', 'SocialSecurityNumber'),
            leaf('TaxpayerIdentifierValue', b.ssn),
          ])]),
        ])]),
        el('RELATIONSHIPS', {}, [el('RELATIONSHIP', {
          'xlink:from': 'CreditRequestData001', 'xlink:to': 'Borrower01',
          'xlink:arcrole': 'urn:fdc:mismo.org:2009:residential/CREDIT_REQUEST_DATA_IsAssociatedWith_ROLE',
        })]),
        el('SERVICES', {}, [el('SERVICE', {}, [el('CREDIT', {}, [el('CREDIT_REQUEST', {}, [
          el('CREDIT_REQUEST_DATAS', {}, [el('CREDIT_REQUEST_DATA', { 'xlink:label': 'CreditRequestData001' }, [
            el('CREDIT_REPOSITORY_INCLUDED', {}, [
              leaf('CreditRepositoryIncludedEquifaxIndicator', bureaus.includes('Equifax') ? 'true' : 'false'),
              leaf('CreditRepositoryIncludedExperianIndicator', bureaus.includes('Experian') ? 'true' : 'false'),
              leaf('CreditRepositoryIncludedTransUnionIndicator', bureaus.includes('TransUnion') ? 'true' : 'false'),
            ]),
            el('CREDIT_REQUEST_DATA_DETAIL', {}, [
              reportIdEl,
              leaf('CreditReportRequestActionType', action),
              ...reportTypeEls,
              leaf('CreditRequestDatetime', mismoNow()),
              leaf('CreditRequestType', 'Individual'),
            ]),
          ])]),
        ])])])]),
      ])])]),
      el('PARTIES', {}, [
        messageParty(1, company || cfg.requestingParty || 'YS Capital Group', 'RequestingParty', 'RequestingParty001'),
        messageParty(2, 'PILOT by YS Capital', 'SubmittingParty', 'SubmittingParty001'),
        messageParty(3, 'Xactus, LLC', 'ReceivingParty', 'ReceivingParty001'),
      ]),
    ]),
  ]);
  return { path: '', contentType: 'text/xml', body: X.render(msg) };
}

// ── PACKET SEAM #2: pull {xml, pdfBase64, vendorReportId} out of the response ──
function extractReport(text, contentType) {
  const ct = String(contentType || '').toLowerCase();
  // JSON envelope (some deployments wrap it) — tolerate it.
  if (ct.includes('json') || /^\s*\{/.test(text)) {
    let j; try { j = JSON.parse(text); } catch (_) { j = null; }
    if (j) {
      const xml = j.xml || j.creditReportXml || j.mismo || j.mismoXml || j.reportXml || null;
      const pdfBase64 = j.pdf || j.pdfBase64 || j.pdfDocument || j.document || j.reportPdf || null;
      if (xml || pdfBase64) return { xml: xml || null, pdfBase64: pdfBase64 || null, vendorReportId: j.reportId || j.creditReportId || null };
    }
  }
  // MISMO 3.4 XML response (the normal case): keep the whole document as the
  // data file, pull the embedded PDF out of the VIEW_FILE, read the report id.
  if (/<\s*\w/.test(text)) {
    return { xml: text, pdfBase64: embeddedPdfBase64(text), vendorReportId: xmlReportId(text) };
  }
  const e = new Error('unrecognized Xactus response');
  e.userMessage = 'Xactus responded, but the report format wasn’t recognized. Send one real response to confirm the exact layout.';
  return { xml: null, pdfBase64: null, vendorReportId: null, _unrecognized: true, _raw: text.slice(0, 400), _error: e };
}

// A MISMO 3.4 report PDF is base64 inside a VIEW_FILE (FOREIGN_OBJECT /
// EmbeddedContentXML / MIMEEncodedObject / EncodedData), or an EMBEDDED_FILE.
function embeddedPdfBase64(xml) {
  const re = /<[^>]*(?:EMBEDDED_FILE|EmbeddedContent\w*|MIMEEncodedObject|EncodedData|DocumentContent|BinaryContent|PDF\w*)[^>]*>\s*([A-Za-z0-9+/=\r\n\s]{200,}?)\s*<\//g;
  let m;
  while ((m = re.exec(xml))) {
    const b64 = m[1].replace(/\s+/g, '');
    if (/^JVBER/.test(b64)) return b64;      // base64 of "%PDF-"
  }
  // Fallback: the longest base64 blob that decodes to a PDF header.
  const any = xml.match(/([A-Za-z0-9+/=]{400,})/g) || [];
  for (const b of any) if (/^JVBER/.test(b)) return b;
  return null;
}
function xmlReportId(xml) {
  const m = xml.match(/<CreditReportIdentifier>([^<]+)<\/CreditReportIdentifier>/)
    || xml.match(/CreditReportIdentifier="([^"]+)"/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/**
 * Order (or reissue) a tri-merge credit report through the shared login.
 * @returns {Promise<{xml:string|null, pdfBase64:string|null, vendorReportId:string|null}>}
 */
async function pull({ borrower, pullType = 'soft', requestType = 'reissue', bureaus = ALL_BUREAUS, version: v, reissueReportId, loanNumber, company } = {}) {
  if (!configured()) throw notConfiguredError();
  if (!borrower) throw new Error('pull: borrower required');
  if (requestType === 'reissue' && !reissueReportId) {
    const e = new Error('reissue requires a prior report id');
    e.status = 422;
    e.userMessage = 'A reissue needs the reference number of the credit report already on file. Enter it, or switch to “Order brand-new”.';
    throw e;
  }
  v = v || version();
  const req = buildRequestBody({ borrower, pullType, requestType, bureaus, version: v, reissueReportId, loanNumber, company });

  let url = cfg.endpoint.replace(/\/+$/, '') + req.path;
  const headers = { 'Content-Type': req.contentType, Accept: 'application/xml, text/xml' };
  if ((cfg.authMode || 'basic') === 'query') {
    const u = new URL(url);
    u.searchParams.set('LoginAccountIdentifier', cfg.username);
    u.searchParams.set('LoginAccountPassword', cfg.password);
    url = u.toString();
  } else {
    headers.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }

  // Reach Xactus with a hard timeout, and turn a network-level failure (bad web
  // address, DNS/TLS error, unreachable host) into a CLEAR, actionable message —
  // otherwise a thrown fetch surfaces to staff as the useless generic
  // "Could not import the credit report."
  let r, respText;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    r = await fetch(url, { method: 'POST', headers, body: req.body, signal: controller.signal });
    respText = await r.text();
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err.message || '').includes('aborted'));
    const e = new Error(`Xactus request failed: ${scrubCredentials((err && err.message) || err)}`);
    e.status = aborted ? 504 : 502;
    e.userMessage = aborted
      ? 'Xactus didn’t respond in time. Please try again in a moment — if it keeps timing out, the shared login may not be activated yet.'
      : 'PILOT couldn’t reach Xactus at the web address in the settings. Double-check the Xactus web address (XACTUS_API_URL) is the exact address Xactus gave you to send reports to, and that the shared login is activated.';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // Never echo the borrower's identifiers into logs: the outbound request
    // carried the full SSN, and a vendor validation error can reflect it back.
    const safe = String(respText)
      .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, '***-**-****')   // dashed, bare, or space-separated SSN
      .replace(/\b\d{9,}\b/g, '*********');
    const e = new Error(`Xactus ${r.status}: ${safe.slice(0, 300)}`);
    e.status = 502;
    e.userMessage = `Xactus couldn’t complete the pull (error ${r.status}). ${r.status === 401 || r.status === 403 ? 'The shared login may be wrong or not yet activated.' : 'Please try again in a moment.'}`;
    throw e;
  }
  const out = extractReport(respText, r.headers.get && r.headers.get('content-type'));
  if (out._error) throw out._error;
  return { xml: out.xml, pdfBase64: out.pdfBase64, vendorReportId: out.vendorReportId };
}

// ── Connection test (the "Test now" button on the API Health page) ────────────
// A SAFE reachability check: a HEAD request to the configured endpoint with the
// shared login — NO credit request, NO borrower data, not a billable pull. It
// distinguishes "couldn't reach the address at all" (wrong/unreachable URL) from
// "reached it" (address OK; login/path is the remaining question), so staff can
// pinpoint a live-pull failure in one click instead of guessing.

// Pure: turn a reached HTTP status into a plain-language verdict (unit-tested).
function _classifyConnection(status) {
  if (status === 401 || status === 403) {
    return { live: false, detail: `Reached Xactus (so the web address is correct), but the login was rejected (error ${status}). The shared username/password may be wrong, or the account isn’t turned on for sending yet — ask Xactus to confirm it’s activated.` };
  }
  if (status === 400 || status === 404 || status === 405 || status === 501) {
    // Reached the server, but this quick check can't confirm it's the right endpoint
    // + a working login — neutral, not a green "connected".
    return { live: null, detail: `Reached the Xactus server at that address (it answered with ${status}). The address is reachable; this quick check can’t fully confirm the login — run a real import to confirm, or double-check the exact endpoint with Xactus.` };
  }
  if (status >= 200 && status < 400) {
    return { live: true, detail: `Connected to Xactus successfully (the address answered, status ${status}). You’re ready to try an import.` };
  }
  return { live: null, detail: `Reached Xactus, but it answered with an unexpected status (${status}). Try a real import, or check with Xactus.` };
}

async function testConnection() {
  if (!configured()) {
    return { configured: false, live: false, detail: 'Not connected yet — add the full Xactus Credit ReportX web address, username and password (in the system settings) first.' };
  }
  let u;
  try { u = new URL(cfg.endpoint); }
  catch (_) { return { configured: true, live: false, detail: 'The Xactus web address isn’t a valid link. It must be the full address Xactus gave you, starting with https:// — fix XACTUS_API_URL in the settings.' }; }
  if (u.protocol !== 'https:') {
    return { configured: true, live: false, detail: `The Xactus web address must start with https:// (it starts with “${u.protocol.replace(':', '')}”). Fix XACTUS_API_URL in the settings.` };
  }
  let url = cfg.endpoint;
  const headers = { Accept: 'application/xml, text/xml' };
  if ((cfg.authMode || 'basic') === 'query') {
    const q = new URL(url);
    q.searchParams.set('LoginAccountIdentifier', cfg.username);
    q.searchParams.set('LoginAccountPassword', cfg.password);
    url = q.toString();
  } else {
    headers.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'HEAD', headers, signal: controller.signal });
    return Object.assign({ configured: true }, _classifyConnection(r.status));
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String((err && err.message) || '').includes('aborted'));
    return { configured: true, live: false, detail: aborted
      ? 'Timed out reaching Xactus (no answer within 15 seconds). The address may be wrong, or Xactus can’t be reached from the server.'
      : 'Couldn’t reach Xactus at that web address. Double-check XACTUS_API_URL is the exact address Xactus gave you to send reports to — spelled correctly and starting with https://.' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  name: 'xactus',
  ALL_BUREAUS,
  configured, status, version, pull, testConnection,
  // exposed for unit tests + the packet wiring
  _seam: { buildRequestBody, extractReport, embeddedPdfBase64, classifyConnection: _classifyConnection, scrubCredentials },
};
