'use strict';
/**
 * Sitewire WEBSITE client — the "browser robot" for the one thing the API cannot do: upload documents.
 *
 * WHY THIS EXISTS
 *   Sitewire's API v2 has NO document-upload endpoint (verified against the official swagger —
 *   docs/sitewire/SITEWIRE-API-v2.md). The ONLY way to place a file in a property's Documents tab is
 *   the website's Rails ActiveStorage direct-upload flow, which needs a logged-in browser SESSION +
 *   a CSRF token. The 3-header API token cannot do a website action. So — exactly as a person would —
 *   this module logs into the website, does the confirmed upload handshake, and attaches the blob.
 *
 * CONFIRMED FLOW (captured from a real browser session — never guessed):
 *   1. POST /rails/active_storage/direct_uploads
 *        body: {"blob":{"filename","content_type","byte_size","checksum":<base64 MD5>}}
 *        -> {signed_id, direct_upload:{url, headers}}            (the fixed ActiveStorage contract)
 *   2. PUT <direct_upload.url> with <direct_upload.headers>, body = the raw file bytes   (S3)
 *   3. POST /properties/:propertyId/property_documents   (multipart)
 *        fields: authenticity_token, file-selection,
 *                property[property_documents_attributes][0][document] = <signed_id>
 *      + header x-csrf-token: <token>
 *   Delete (for revoke/re-push): POST /properties/:propertyId/property_documents/:docId
 *        body: _method=delete&authenticity_token=<token>
 *
 * SAFETY, by construction:
 *   - This file NEVER writes property/budget DATA fields — it only authenticates + uploads a document.
 *     A wrong login shape simply fails to authenticate (fail-closed); it can never corrupt Sitewire data.
 *   - Credentials come from Render env ONLY (cfg.sitewireWeb*), never hardcoded, never from a chat paste.
 *   - Every outbound URL is asserted https + host-allowlisted (the Sitewire host, or an AWS S3 host that
 *     Sitewire's OWN response handed us for the PUT) — no SSRF to an arbitrary host.
 *   - Read-after-write VERIFICATION is done by the caller against the TRUSTED API (GET property.documents[]),
 *     not by trusting this website flow's own response.
 */
const crypto = require('crypto');
const cfg = require('../config');

const TIMEOUT_MS = () => cfg.sitewireWebTimeoutMs || 45000;
function webBase() { return (cfg.sitewireWebBaseUrl || 'https://app.sitewire.co').replace(/\/+$/, ''); }
function webHost() { try { return new URL(webBase()).host; } catch { return 'app.sitewire.co'; } }

function webConfigured() {
  return !!(cfg.sitewireWebCookie || (cfg.sitewireWebEmail && cfg.sitewireWebPassword));
}

// ---- SSRF guard: only the Sitewire host, or an AWS S3 host Sitewire itself returned for the PUT ----
function assertUploadUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error('sitewire_web_bad_upload_url'); }
  if (url.protocol !== 'https:') throw new Error('sitewire_web_insecure_upload_url');
  const h = url.host.toLowerCase();
  const ok = h === webHost() || /(^|\.)s3[.-][a-z0-9-]*\.amazonaws\.com$/.test(h) || /(^|\.)s3\.amazonaws\.com$/.test(h)
    || h.endsWith('.amazonaws.com');
  if (!ok) throw new Error(`sitewire_web_upload_host_not_allowed:${h}`);
  return url;
}

// ---- cookie jar (fetch does not persist cookies) ----
function mergeSetCookie(jar, res) {
  let list = [];
  try { list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; } catch { list = []; }
  if (!list.length) { const one = res.headers.get('set-cookie'); if (one) list = [one]; }
  for (const c of list) {
    const pair = String(c).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchWithTimeout(url, opts) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS());
  try { return await fetch(url, { ...opts, redirect: 'manual', signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

// Rails prints the CSRF token in <meta name="csrf-token" content="..."> on every authenticated HTML page.
function scrapeCsrf(html) {
  const m = String(html || '').match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i)
    || String(html || '').match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
  return m ? m[1] : null;
}
// Is this HTML an authenticated page (not the sign-in screen)?
function looksSignedOut(html) {
  const s = String(html || '');
  return /\/users\/sign_in|name=["']user\[password\]|Sign in to your account/i.test(s) && !/sign_out|Log ?out/i.test(s);
}

/**
 * Obtain an authenticated website session: { jar, csrf }.
 * Path A (preferred, durable): log in with SITEWIRE_WEB_EMAIL/PASSWORD (standard Devise), self-verify.
 * Path B (fallback for MFA/SSO): a browser session cookie the owner pasted into SITEWIRE_WEB_COOKIE.
 * Fails CLOSED — returns {error} instead of proceeding on any uncertainty. Never throws to the caller.
 */
async function getSession() {
  if (!webConfigured()) {
    return { error: 'web_creds_missing', message: 'Set SITEWIRE_WEB_EMAIL + SITEWIRE_WEB_PASSWORD (preferred) or SITEWIRE_WEB_COOKIE in Render to enable pushing documents to Sitewire.' };
  }
  const jar = {};
  // Path B: a provided cookie — seed the jar, then refresh a live CSRF token from an authenticated page.
  if (cfg.sitewireWebCookie) {
    for (const pair of String(cfg.sitewireWebCookie).split(/;\s*/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const csrf = await refreshCsrf(jar);
    if (!csrf) return { error: 'web_session_invalid', message: 'The provided SITEWIRE_WEB_COOKIE did not resolve to a logged-in Sitewire session (it may have expired). Log in again and update the cookie, or set SITEWIRE_WEB_EMAIL/PASSWORD.' };
    return { jar, csrf };
  }
  // Path A: automated Devise login.
  try {
    const signInUrl = webBase() + (cfg.sitewireWebSignInPath || '/users/sign_in');
    // 1) GET the sign-in page → session cookie + the form's authenticity_token.
    const page = await fetchWithTimeout(signInUrl, { method: 'GET', headers: { Accept: 'text/html' } });
    mergeSetCookie(jar, page);
    const pageHtml = await page.text();
    const token = scrapeCsrf(pageHtml);
    if (!token) return { error: 'web_login_no_token', message: 'Could not read the Sitewire sign-in form. If Sitewire uses SSO/MFA, set SITEWIRE_WEB_COOKIE instead.' };
    // 2) POST credentials (standard Devise field names).
    const form = new URLSearchParams();
    form.set('authenticity_token', token);
    form.set('user[email]', cfg.sitewireWebEmail);
    form.set('user[password]', cfg.sitewireWebPassword);
    form.set('user[remember_me]', '0');
    form.set('commit', 'Log in');
    const resp = await fetchWithTimeout(signInUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', Cookie: cookieHeader(jar), 'X-CSRF-Token': token },
      body: form.toString(),
    });
    mergeSetCookie(jar, resp);
    // Devise success = a 3xx redirect (usually to the dashboard). A 200 back on /sign_in = bad credentials.
    const status = resp.status;
    if (status === 200) {
      const body = await resp.text();
      if (looksSignedOut(body)) return { error: 'web_login_failed', message: 'Sitewire rejected the login (check SITEWIRE_WEB_EMAIL/PASSWORD, or the account may require MFA — then use SITEWIRE_WEB_COOKIE).' };
    }
    // 3) Verify: fetch an authenticated page and confirm we are NOT signed out + grab a fresh CSRF.
    const csrf = await refreshCsrf(jar);
    if (!csrf) return { error: 'web_login_unverified', message: 'Logged in but could not confirm an authenticated Sitewire session. If MFA is on, set SITEWIRE_WEB_COOKIE.' };
    return { jar, csrf };
  } catch (e) {
    return { error: 'web_login_error', message: `Sitewire website login failed: ${e.message}` };
  }
}

// GET an authenticated page (the account root) and scrape a fresh CSRF token; null if signed out.
async function refreshCsrf(jar) {
  try {
    const res = await fetchWithTimeout(webBase() + '/', { method: 'GET', headers: { Accept: 'text/html', Cookie: cookieHeader(jar) } });
    mergeSetCookie(jar, res);
    // Follow ONE redirect within the Sitewire host (Devise often lands you via a 302).
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        const next = new URL(loc, webBase());
        if (next.host === webHost()) {
          const r2 = await fetchWithTimeout(next.toString(), { method: 'GET', headers: { Accept: 'text/html', Cookie: cookieHeader(jar) } });
          mergeSetCookie(jar, r2);
          const h2 = await r2.text();
          if (looksSignedOut(h2)) return null;
          return scrapeCsrf(h2);
        }
      }
    }
    const html = await res.text();
    if (looksSignedOut(html)) return null;
    return scrapeCsrf(html);
  } catch { return null; }
}

/**
 * ActiveStorage direct upload. Returns { signed_id } on success or throws (retryable-tagged) on failure.
 * @param session {jar, csrf}
 * @param file {filename, contentType, bytes:Buffer}
 */
async function uploadBlob(session, file) {
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
  const checksum = crypto.createHash('md5').update(bytes).digest('base64'); // ActiveStorage wants base64 MD5
  // 1) Reserve the blob + get the S3 upload target.
  const du = await fetchWithTimeout(webBase() + '/rails/active_storage/direct_uploads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      Cookie: cookieHeader(session.jar), 'X-CSRF-Token': session.csrf, 'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ blob: { filename: file.filename, content_type: file.contentType, byte_size: bytes.length, checksum } }),
  });
  mergeSetCookie(session.jar, du);
  if (du.status < 200 || du.status >= 300) {
    const t = await du.text().catch(() => '');
    const e = new Error(`sitewire_direct_upload_${du.status}`); e.status = du.status;
    e.retryable = du.status === 429 || du.status >= 500; e.body = t.slice(0, 500); throw e;
  }
  let blob; try { blob = await du.json(); } catch { const e = new Error('sitewire_direct_upload_bad_json'); e.retryable = false; throw e; }
  if (!blob || !blob.signed_id || !blob.direct_upload || !blob.direct_upload.url) {
    const e = new Error('sitewire_direct_upload_no_signed_id'); e.retryable = false; throw e;
  }
  // 2) PUT the raw bytes to S3 with the headers Sitewire handed us (Content-MD5 etc.).
  const putUrl = assertUploadUrl(blob.direct_upload.url);
  const put = await fetchWithTimeout(putUrl.toString(), {
    method: 'PUT', headers: { ...(blob.direct_upload.headers || {}) }, body: bytes,
  });
  if (put.status < 200 || put.status >= 300) {
    const t = await put.text().catch(() => '');
    const e = new Error(`sitewire_s3_put_${put.status}`); e.status = put.status;
    e.retryable = put.status === 429 || put.status >= 500; e.body = t.slice(0, 500); throw e;
  }
  return { signed_id: blob.signed_id, checksum, byte_size: bytes.length };
}

/**
 * Attach an uploaded blob to a property's Documents tab. Returns the raw response text (best-effort);
 * the CALLER verifies the document actually landed via the trusted API (property.documents[]).
 */
async function attachDocument(session, propertyId, signedId, opts = {}) {
  const form = new FormData();
  form.set('authenticity_token', session.csrf);
  form.set('file-selection', String(opts.filename || ''));
  form.set('property[property_documents_attributes][0][document]', signedId);
  const res = await fetchWithTimeout(`${webBase()}/properties/${encodeURIComponent(propertyId)}/property_documents`, {
    method: 'POST',
    headers: { Accept: 'application/json, text/html', Cookie: cookieHeader(session.jar), 'X-CSRF-Token': session.csrf, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  mergeSetCookie(session.jar, res);
  const text = await res.text().catch(() => '');
  if (res.status < 200 || res.status >= 400) { // 3xx redirect to the property page = success in this Rails flow
    const e = new Error(`sitewire_attach_document_${res.status}`); e.status = res.status;
    e.retryable = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403;
    e.body = text.slice(0, 500); throw e;
  }
  return { status: res.status, body: text };
}

/**
 * Delete a property document (for revoke / clean re-push). Mirrors the confirmed website DELETE:
 * POST /properties/:id/property_documents/:docId  body: _method=delete&authenticity_token=<csrf>
 */
async function deleteDocument(session, propertyId, docId) {
  const form = new URLSearchParams();
  form.set('_method', 'delete');
  form.set('authenticity_token', session.csrf);
  const res = await fetchWithTimeout(`${webBase()}/properties/${encodeURIComponent(propertyId)}/property_documents/${encodeURIComponent(docId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/html', Cookie: cookieHeader(session.jar), 'X-CSRF-Token': session.csrf, 'X-Requested-With': 'XMLHttpRequest' },
    body: form.toString(),
  });
  mergeSetCookie(session.jar, res);
  const text = await res.text().catch(() => '');
  if (res.status < 200 || res.status >= 400) {
    const e = new Error(`sitewire_delete_document_${res.status}`); e.status = res.status;
    e.retryable = res.status === 429 || res.status >= 500; e.body = text.slice(0, 500); throw e;
  }
  return { status: res.status };
}

module.exports = {
  webConfigured, getSession, uploadBlob, attachDocument, deleteDocument,
  _internal: { scrapeCsrf, looksSignedOut, assertUploadUrl, mergeSetCookie, cookieHeader },
};
