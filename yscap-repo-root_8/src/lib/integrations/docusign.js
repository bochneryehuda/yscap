/**
 * DocuSign eSignature — hardened server-to-server client (JWT Grant, OAuth 2.0).
 *
 * This is the low-level transport + protocol layer only. It knows how to:
 *   - mint & cache an impersonation access token (JWT RS256 grant),
 *   - discover the account's real REST base URI (userinfo),
 *   - create an envelope (with idempotency + PILOT branding + Connect webhook),
 *   - read envelope/recipient status, download signed PDFs + the Certificate of
 *     Completion, list the audit trail,
 *   - mint an embedded (in-portal) recipient-view URL,
 *   - void / resend an envelope,
 *   - verify an inbound Connect webhook's HMAC (fail-closed, multi-key, base64).
 *
 * It does NOT decide WHEN to send, own the send-once claim, or clear conditions
 * — that orchestration lives above (the send queue + webhook receiver). Every
 * method throws a clear, classified error (`.code`, `.status`, `.retryable`,
 * `.dsErrorCode`) so the queue can pick the right retry class.
 *
 * Hardening (see docs/DOCUSIGN-BUG-REGISTER.md):
 *   H-3  read the body BEFORE branching on r.ok (a non-JSON 5xx never masks status)
 *   M-6  access-token cache (~55min), one JWT per window, not per call
 *   M-7  X-DocuSign-Idempotency-Key on create (deterministic, replay-safe)
 *   M-8  AbortController timeout on every fetch
 *   M-9  PEM \n normalization (done in config.js)
 *   L-2  userinfo base_uri discovery, arg validation, iat backdated for clock skew
 *
 * Config: DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID,
 * DOCUSIGN_PRIVATE_KEY, DOCUSIGN_BASE_URI, DOCUSIGN_OAUTH_BASE,
 * DOCUSIGN_CONNECT_HMAC_SECRET, DOCUSIGN_BRAND_ID. One-time JWT impersonation
 * consent must be granted to the integration key. Status arrives via Connect
 * webhooks — see src/routes/webhooks.js.
 */
const crypto = require('crypto');
const cfg = require('../../config').docusign;
// Our own app origin (for the L-C returnUrl allow-list). Read once at load.
const _appOrigin = (() => { try { return new URL(require('../../config').appUrl).origin; } catch (_) { return null; } })();

// ---- error helper: classify for the send queue's retry taxonomy -------------
function dsError(message, { code, status, retryable, dsErrorCode } = {}) {
  const e = new Error(message);
  if (code) e.code = code;
  if (status != null) e.status = status;
  if (retryable != null) e.retryable = retryable;
  if (dsErrorCode) e.dsErrorCode = dsErrorCode;
  return e;
}

function configured() {
  return !!(cfg.integrationKey && cfg.userId && cfg.accountId && cfg.privateKey);
}
function ensure() {
  if (!configured()) throw dsError('DocuSign not configured — add DOCUSIGN_* env vars', { code: 'DOCUSIGN_NOT_CONFIGURED' });
}
/** Are we pointed at the DEMO (sandbox) world? Used by the M-13 test gate above us.
 * Determined by the OAuth host (authoritative: account-d = demo, account = prod).
 * NOT by baseUri — a production account whose DOCUSIGN_BASE_URI was left at the
 * demo default would otherwise be mislabeled "demo" (the real data-center base,
 * e.g. na4.docusign.net, is discovered via userinfo at call time anyway). */
function isDemoHost() {
  return /account-d\.docusign\.com/i.test(cfg.oauthBase || '');
}

// ---- fetch with timeout + H-3 read-before-ok --------------------------------
// Returns parsed JSON on 2xx. On failure throws a classified dsError. NEVER lets
// a non-JSON error body throw a bare SyntaxError that hides the HTTP status.
async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.httpTimeoutMs);
  try {
    // L-B: the timeout stays armed through the BODY read too (a stalled body
    // response would otherwise hang past httpTimeoutMs).
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();                     // H-3: body first, always
    if (!r.ok) {
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }
      const dsCode = parsed && (parsed.errorCode || parsed.error);
      const msg = (parsed && (parsed.message || parsed.error_description || parsed.error)) || text.slice(0, 300) || `HTTP ${r.status}`;
      // 429 + 5xx → outage (patient) retry; 4xx validation → permanent. A 401 is
      // handled by authedJson (re-mint once) BEFORE this classification is trusted.
      const retryable = r.status === 429 || r.status >= 500;
      throw dsError(`DocuSign ${r.status}: ${msg}`, { code: 'DOCUSIGN_HTTP', status: r.status, retryable, dsErrorCode: dsCode });
    }
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (_) { throw dsError('DocuSign returned a non-JSON success body', { code: 'DOCUSIGN_BAD_RESPONSE', retryable: false }); }
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.startsWith('DOCUSIGN_')) throw e;   // already classified
    const aborted = e && e.name === 'AbortError';
    throw dsError(aborted ? `DocuSign request timed out after ${cfg.httpTimeoutMs}ms` : `DocuSign network error: ${e.message}`,
      { code: aborted ? 'DOCUSIGN_TIMEOUT' : 'DOCUSIGN_NETWORK', retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// ---- fetch binary (signed PDF / certificate) --------------------------------
async function httpBinary(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.httpTimeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });   // L-B: timeout covers the download body too
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const retryable = r.status === 429 || r.status >= 500;
      throw dsError(`DocuSign download ${r.status}: ${text.slice(0, 200)}`, { code: 'DOCUSIGN_HTTP', status: r.status, retryable });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw dsError('DocuSign returned an empty document', { code: 'DOCUSIGN_EMPTY_DOC', retryable: true });
    return buf;
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.startsWith('DOCUSIGN_')) throw e;
    const aborted = e && e.name === 'AbortError';
    throw dsError(aborted ? 'DocuSign download timed out' : `DocuSign network error: ${e.message}`,
      { code: aborted ? 'DOCUSIGN_TIMEOUT' : 'DOCUSIGN_NETWORK', retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// M-A: run a token-bearing request; on a transient 401 (stale/raced token),
// re-mint ONCE and retry. A persistent 401 (real consent/key problem) then
// surfaces normally (non-retryable → dead-letter → a human fixes consent).
async function authedJson(build) {
  const t = await accessToken();
  try { return await build(t); }
  catch (e) {
    if (e && e.status === 401) { invalidateToken(); return build(await accessToken()); }
    throw e;
  }
}
async function authedBinary(build) {
  const t = await accessToken();
  try { return await build(t); }
  catch (e) {
    if (e && e.status === 401) { invalidateToken(); return build(await accessToken()); }
    throw e;
  }
}

// ---- access-token cache (M-6) -----------------------------------------------
let _token = { value: null, expiresAt: 0 };
let _apiBase = null;   // discovered REST base (L-2)

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }

async function mintToken() {
  ensure();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: cfg.integrationKey,
    sub: cfg.userId,
    aud: cfg.oauthBase,
    iat: now - 60,                 // L-2: backdate for clock skew (avoids invalid_grant on a fast clock)
    exp: now + 3600,
    scope: 'signature impersonation',
  };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  let sig;
  try {
    sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(cfg.privateKey).toString('base64url');
  } catch (e) {
    // Almost always a malformed PEM (M-9) — fail closed with a clear message.
    throw dsError(`DocuSign private key failed to sign the JWT (check the PEM): ${e.message}`, { code: 'DOCUSIGN_BAD_KEY', retryable: false });
  }
  const assertion = `${signingInput}.${sig}`;
  const j = await httpJson(`https://${cfg.oauthBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }).catch((e) => {
    // The one-time human consent hasn't been granted → surface a distinct, actionable code.
    if (/consent_required/i.test(e.message)) throw dsError('DocuSign consent_required — grant JWT impersonation consent once (see DEMO-SETUP-STEPS Part A step 7)', { code: 'DOCUSIGN_CONSENT_REQUIRED', retryable: false });
    throw e;
  });
  return { value: j.access_token, ttl: j.expires_in || 3600 };
}

/** Cached impersonation access token. Refreshes ~55min (tokenCacheSec). */
async function accessToken() {
  const now = Date.now();
  if (_token.value && now < _token.expiresAt) return _token.value;
  const { value, ttl } = await mintToken();
  const cacheFor = Math.min(cfg.tokenCacheSec, Math.max(60, ttl - 300)) * 1000;   // never past token life; small safety margin
  _token = { value, expiresAt: now + cacheFor };
  return value;
}

/** Force the next call to re-mint (used after a 401). */
function invalidateToken() { _token = { value: null, expiresAt: 0 }; }

// ---- account REST base discovery (L-2) --------------------------------------
// The hardcoded baseUri breaks if DocuSign routes this account to another data
// center. Ask userinfo once for the account's real base_uri; cache it. Falls
// back to the configured baseUri if discovery fails (never blocks a send).
async function apiBase() {
  if (_apiBase) return _apiBase;
  try {
    const token = await accessToken();
    const j = await httpJson(`https://${cfg.oauthBase}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
    const acct = (j.accounts || []).find((a) => String(a.account_id) === String(cfg.accountId))
              || (j.accounts || []).find((a) => a.is_default);
    if (acct && acct.base_uri) { _apiBase = `${acct.base_uri.replace(/\/+$/, '')}/restapi`; return _apiBase; }
  } catch (e) {
    console.warn(`[docusign] base_uri discovery failed, using configured baseUri: ${e.message}`);
  }
  _apiBase = cfg.baseUri.replace(/\/+$/, '');
  return _apiBase;
}

function acctUrl(base, path) { return `${base}/v2.1/accounts/${encodeURIComponent(cfg.accountId)}${path}`; }

// ---- deterministic idempotency key (M-7) ------------------------------------
// Same (application, purpose, economics version) => same key => DocuSign returns
// the ORIGINAL envelope on a replay/reclaim instead of creating a second one.
function idempotencyKey(applicationId, purpose, productVersion) {
  return crypto.createHash('sha256')
    .update(`${applicationId}:${purpose}:${productVersion == null ? 0 : productVersion}`)
    .digest('hex');
}

// ---- tab / recipient builders -----------------------------------------------
// An invisible anchor string (e.g. "/app_b1_sig/") is drawn white-on-white in
// the generated PDF; DocuSign places the tab where the anchor appears, scoped to
// THIS recipient. anchorIgnoreIfNotPresent => a missing anchor is skipped, never
// an error (e.g. the co-borrower signature block only exists when there IS one).
function signHereAnchor(anchor) {
  return {
    anchorString: anchor,
    anchorUnits: 'pixels',
    anchorXOffset: '0',
    anchorYOffset: '0',
    anchorIgnoreIfNotPresent: 'true',
    anchorCaseSensitive: 'false',
  };
}
function dateSignedAnchor(anchor) {
  return { anchorString: anchor, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', anchorIgnoreIfNotPresent: 'true' };
}

/**
 * Build a validated EnvelopeDefinition.
 *  documents: [{ base64, name, documentId }]  (documentId is a string number)
 *  signers:   [{ recipientId, name, email, routingOrder, clientUserId?,
 *               tabsByDoc:{ [documentId]: { sign:['/anchor/'], date:['/anchor/'] } } }]
 *  eventNotification: the per-envelope Connect config (webhook + HMAC) — optional
 */
function buildEnvelopeDefinition({ documents, signers, subject, status = 'sent', emailBlurb, brandId, customFields, eventNotification: evtNotif, notification }) {
  if (!Array.isArray(documents) || !documents.length) throw dsError('buildEnvelope: at least one document required', { code: 'DOCUSIGN_ARG', retryable: false });
  if (!Array.isArray(signers) || !signers.length) throw dsError('buildEnvelope: at least one signer required', { code: 'DOCUSIGN_ARG', retryable: false });
  for (const s of signers) {
    if (!s.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) throw dsError(`buildEnvelope: invalid signer email "${s.email}"`, { code: 'DOCUSIGN_ARG', retryable: false });
    if (!s.name) throw dsError('buildEnvelope: signer name required', { code: 'DOCUSIGN_ARG', retryable: false });
  }
  const def = {
    emailSubject: subject || 'Please sign your documents',
    status,
    documents: documents.map((d, i) => ({
      documentBase64: d.base64,
      name: d.name || `Document ${i + 1}`,
      fileExtension: d.fileExtension || 'pdf',
      documentId: String(d.documentId || i + 1),
    })),
    recipients: {
      signers: signers.map((s) => {
        const signHereTabs = [];
        const dateSignedTabs = [];
        const byDoc = s.tabsByDoc || {};
        for (const [documentId, tabs] of Object.entries(byDoc)) {
          for (const a of (tabs.sign || [])) signHereTabs.push({ ...signHereAnchor(a), documentId: String(documentId) });
          for (const a of (tabs.date || [])) dateSignedTabs.push({ ...dateSignedAnchor(a), documentId: String(documentId) });
        }
        const signer = {
          email: s.email,
          name: s.name,
          recipientId: String(s.recipientId),
          // L-A: default PARALLEL routing (all order 1) so a co-borrower can sign
          // in any order and an embedded view never hits RECIPIENT_NOT_IN_SEQUENCE.
          // Pass an explicit routingOrder to force sequential signing.
          routingOrder: String(s.routingOrder || 1),
          tabs: { signHereTabs, dateSignedTabs },
        };
        if (s.clientUserId) signer.clientUserId = String(s.clientUserId);   // embedded (in-portal) signer
        // Hybrid email+embedded: SIGN_AT_DOCUSIGN makes DocuSign ALSO send the
        // email invite while still allowing an embedded recipient view. (Trade-off:
        // hybrid recipients don't get DocuSign auto-reminders — we drive our own.)
        if (s.embeddedRecipientStartURL) signer.embeddedRecipientStartURL = s.embeddedRecipientStartURL;
        return signer;
      }),
    },
  };
  if (emailBlurb) def.emailBlurb = emailBlurb;
  if (notification) def.notification = notification;   // reminders + expiration (per-envelope)
  if (brandId) def.brandId = brandId;
  if (customFields) def.customFields = customFields;                 // { textCustomFields:[{name,value,show:'false'}] } — correlation only, NO PII
  if (evtNotif) def.eventNotification = evtNotif;                    // per-envelope Connect (webhook + HMAC)
  return def;
}

/**
 * Per-envelope Connect (webhook) config so status flows back even if the
 * account-level Connect config is absent. requireAcknowledgment=true so DocuSign
 * retries until our endpoint 200s (no silent event loss).
 */
function eventNotification(webhookUrl, { includeCertificate = true } = {}) {
  return {
    url: webhookUrl,
    loggingEnabled: 'true',
    requireAcknowledgment: 'true',
    includeDocuments: 'false',
    includeCertificateOfCompletion: String(includeCertificate),
    // L-E: DocuSign documents these capitalized; Connect treats them
    // case-insensitively, but we normalize to the documented casing.
    envelopeEvents: [
      { envelopeEventStatusCode: 'Sent' },
      { envelopeEventStatusCode: 'Delivered' },
      { envelopeEventStatusCode: 'Completed' },
      { envelopeEventStatusCode: 'Declined' },
      { envelopeEventStatusCode: 'Voided' },
    ],
    // Recipient events must be enabled explicitly, else only envelope-* fire.
    // These drive the per-recipient dashboard + the "borrowers done → admin's turn"
    // transition (recipient-completed at order 1 → recipient-sent at order 2).
    recipientEvents: [
      { recipientEventStatusCode: 'Sent' },
      { recipientEventStatusCode: 'Delivered' },
      { recipientEventStatusCode: 'Completed' },
      { recipientEventStatusCode: 'Declined' },
      { recipientEventStatusCode: 'AuthenticationFailed' },
      { recipientEventStatusCode: 'AutoResponded' },
    ],
    eventData: { version: 'restv2.1', format: 'json', includeData: ['recipients', 'custom_fields'] },
  };
}

// ---- envelope operations ----------------------------------------------------
/** Create an envelope. Pass idempotencyKey to make retries/reclaims replay-safe (M-7). */
async function createEnvelope(envelopeDefinition, { idempotencyKey: idem } = {}) {
  ensure();
  const base = await apiBase();
  const j = await authedJson((token) => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (idem) headers['X-DocuSign-Idempotency-Key'] = idem;
    return httpJson(acctUrl(base, '/envelopes'), { method: 'POST', headers, body: JSON.stringify(envelopeDefinition) });
  });
  if (!j.envelopeId) throw dsError('createEnvelope: DocuSign returned no envelopeId', { code: 'DOCUSIGN_BAD_RESPONSE', retryable: true });
  // L-D: a create that requested status 'sent' must NOT come back 'created' (a
  // silent draft — no email, no error). Surface it as retryable so we don't
  // record a "sent" that never mailed the borrower.
  if ((envelopeDefinition.status === 'sent') && j.status && String(j.status).toLowerCase() === 'created') {
    throw dsError('createEnvelope: envelope stuck in "created" (draft) — not sent', { code: 'DOCUSIGN_NOT_SENT', status: 502, retryable: true });
  }
  return { envelopeId: j.envelopeId, status: j.status, statusDateTime: j.statusDateTime, uri: j.uri };
}

async function getEnvelope(envelopeId, { include } = {}) {
  ensure();
  const base = await apiBase();
  const q = include ? `?include=${encodeURIComponent(Array.isArray(include) ? include.join(',') : include)}` : '';
  return authedJson((token) => httpJson(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}${q}`), { headers: { Authorization: `Bearer ${token}` } }));
}

/** Download the combined signed PDF of all documents, with the Certificate of Completion appended. */
async function getCombinedDocument(envelopeId, { certificate = true } = {}) {
  ensure();
  const base = await apiBase();
  return authedBinary((token) => httpBinary(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}/documents/combined?certificate=${certificate ? 'true' : 'false'}`),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' } }));
}

async function listRecipients(envelopeId) {
  ensure();
  const base = await apiBase();
  return authedJson((token) => httpJson(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}/recipients`), { headers: { Authorization: `Bearer ${token}` } }));
}

/** Download one document's signed PDF. documentId: a numeric id, 'combined', or 'certificate'. Returns a Buffer. */
async function getDocument(envelopeId, documentId) {
  ensure();
  const base = await apiBase();
  return authedBinary((token) => httpBinary(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}/documents/${encodeURIComponent(documentId)}`),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' } }));
}

/** The Certificate of Completion (the AATL-sealed audit trail) as a PDF Buffer. */
async function getCertificate(envelopeId) { return getDocument(envelopeId, 'certificate'); }

/** The envelope's audit-event trail (who/what/when). */
async function listAuditEvents(envelopeId) {
  ensure();
  const base = await apiBase();
  return authedJson((token) => httpJson(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}/audit_events`), { headers: { Authorization: `Bearer ${token}` } }));
}

/** Void a still-open envelope (reason is required by DocuSign). */
async function voidEnvelope(envelopeId, reason) {
  ensure();
  const base = await apiBase();
  return authedJson((token) => httpJson(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'voided', voidedReason: reason || 'Voided by PILOT' }),
  }));
}

/**
 * Re-notify the SAME envelope's outstanding recipients (never creates a new one).
 * H-A: resend_envelope=true on the ENVELOPE-update endpoint (PUT /envelopes/{id})
 * re-sends to all outstanding recipients. (The /recipients endpoint with an empty
 * body resends to nobody — a silent no-op — so it is NOT used here.)
 */
async function resendEnvelope(envelopeId) {
  ensure();
  const base = await apiBase();
  return authedJson((token) => httpJson(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}?resend_envelope=true`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

/**
 * Mint a short-lived embedded (in-portal) signing URL for one recipient.
 * The recipient MUST have been created with a clientUserId. returnUrl is where
 * DocuSign bounces the browser after signing — always our own origin.
 * The URL is single-use and ~5 minutes; never store or log it.
 */
async function createRecipientView(envelopeId, { returnUrl, email, userName, clientUserId, recipientId }) {
  ensure();
  if (!returnUrl || !/^https?:\/\//i.test(returnUrl)) throw dsError('createRecipientView: absolute returnUrl required', { code: 'DOCUSIGN_ARG', retryable: false });
  // L-C: pin returnUrl to our own app origin (defense-in-depth against an
  // open redirect through DocuSign's post-sign bounce).
  if (_appOrigin) {
    let ok = false;
    try { ok = new URL(returnUrl).origin === _appOrigin; } catch (_) { ok = false; }
    if (!ok) throw dsError(`createRecipientView: returnUrl must be on ${_appOrigin}`, { code: 'DOCUSIGN_ARG', retryable: false });
  }
  if (!clientUserId) throw dsError('createRecipientView: clientUserId required (embedded signer)', { code: 'DOCUSIGN_ARG', retryable: false });
  const base = await apiBase();
  const j = await authedJson((token) => httpJson(acctUrl(base, `/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnUrl, authenticationMethod: 'none', email, userName, clientUserId: String(clientUserId), recipientId: String(recipientId) }),
  }));
  return j.url;
}

// ---- reminders/expiration + per-recipient status helpers --------------------
/** Per-envelope reminders + expiration (days). Overrides account defaults. */
function notificationSettings({ reminderDelayDays = 2, reminderFrequencyDays = 3, expireAfterDays = 30, expireWarnDays = 5 } = {}) {
  return {
    useAccountDefaults: 'false',
    reminders: { reminderEnabled: 'true', reminderDelay: String(reminderDelayDays), reminderFrequency: String(reminderFrequencyDays) },
    expirations: { expireEnabled: 'true', expireAfter: String(expireAfterDays), expireWarn: String(expireWarnDays) },
  };
}

/**
 * Normalize an envelope's signers into a flat per-recipient list for the staff
 * dashboard. Pass an envelope fetched with include:'recipients'. Completion keys
 * on signedDateTime (the terminal status string can be 'signed' or 'completed').
 */
function parseRecipients(envelope) {
  const signers = (envelope && envelope.recipients && envelope.recipients.signers) || [];
  return signers.map((s) => ({
    recipientId: s.recipientId,
    routingOrder: s.routingOrder != null ? Number(s.routingOrder) : null,
    name: s.name,
    email: s.email,
    status: s.status || (s.signedDateTime ? 'completed' : 'created'),
    signed: !!s.signedDateTime || s.status === 'completed' || s.status === 'signed',
    declined: s.status === 'declined' || !!s.declinedDateTime,
    sentAt: s.sentDateTime || null,
    deliveredAt: s.deliveredDateTime || null,   // "viewed"
    signedAt: s.signedDateTime || null,
    declinedAt: s.declinedDateTime || null,
    declineReason: s.declinedReason || s.declineReason || null,
  }));
}

/**
 * Derive the human-facing phase — DocuSign has no native "awaiting
 * counter-signature" status; we compute it from currentRoutingOrder + recipients.
 * adminRoutingOrder (default 2) is where the counter-signer sits.
 * Returns: awaiting_borrower | awaiting_countersign | completed | declined | voided.
 */
function derivePhase(envelope, { adminRoutingOrder = 2 } = {}) {
  const status = ((envelope && envelope.status) || '').toLowerCase();
  if (status === 'completed') return 'completed';
  if (status === 'declined') return 'declined';
  if (status === 'voided') return 'voided';
  const recips = parseRecipients(envelope);
  const hasCounterSigner = recips.some((r) => r.routingOrder >= adminRoutingOrder);
  if (!hasCounterSigner) return 'awaiting_borrower';   // e.g. the Iska package (no admin)
  const current = envelope && envelope.currentRoutingOrder != null ? Number(envelope.currentRoutingOrder) : null;
  const order1 = recips.filter((r) => r.routingOrder === 1);
  const order1Done = order1.length > 0 && order1.every((r) => r.signed);
  const adminPending = recips.some((r) => r.routingOrder >= adminRoutingOrder && !r.signed && !r.declined);
  if ((current != null && current >= adminRoutingOrder) || (order1Done && adminPending)) return 'awaiting_countersign';
  return 'awaiting_borrower';
}

// ---- inbound Connect HMAC verify (fail-closed, multi-key, base64) -----------
// DocuSign signs the raw request body with each configured HMAC key and sends
// X-DocuSign-Signature-1..N (base64). We accept iff one of OUR keys reproduces
// one of the provided signatures. Constant-time; length-guarded.
function verifyConnectHmac(rawBody, signatureHeaders) {
  const keys = cfg.connectHmacKeys || [];
  if (!keys.length) return false;                                   // fail closed: no key configured => reject
  const sigs = (Array.isArray(signatureHeaders) ? signatureHeaders : [signatureHeaders]).filter(Boolean).map(String);
  if (!sigs.length) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  for (const key of keys) {
    const expected = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(body).digest('base64');
    const expBuf = Buffer.from(expected);
    for (const sig of sigs) {
      const sigBuf = Buffer.from(sig);
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) return true;
    }
  }
  return false;
}

/** Collect every X-DocuSign-Signature-N header off an Express req. */
function connectSignatureHeaders(req) {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const h = req.headers[`x-docusign-signature-${i}`];
    if (h) out.push(h);
  }
  return out;
}

// ---- connectivity self-test (the "test connection" in DEMO-SETUP Part C) ----
async function ping() {
  ensure();
  const token = await accessToken();
  const j = await httpJson(`https://${cfg.oauthBase}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  const acct = (j.accounts || []).find((a) => String(a.account_id) === String(cfg.accountId)) || (j.accounts || [])[0] || {};
  return { ok: true, demo: isDemoHost(), accountName: acct.account_name, accountId: acct.account_id, baseUri: acct.base_uri, name: j.name, email: j.email };
}

module.exports = {
  name: 'docusign',
  configured,
  isDemoHost,
  // auth
  accessToken,
  invalidateToken,
  apiBase,
  ping,
  // create + read
  idempotencyKey,
  buildEnvelopeDefinition,
  eventNotification,
  notificationSettings,
  signHereAnchor,
  dateSignedAnchor,
  createEnvelope,
  getEnvelope,
  getCombinedDocument,
  listRecipients,
  getDocument,
  getCertificate,
  listAuditEvents,
  voidEnvelope,
  resendEnvelope,
  createRecipientView,
  parseRecipients,
  derivePhase,
  // inbound webhook
  verifyConnectHmac,
  connectSignatureHeaders,
};
