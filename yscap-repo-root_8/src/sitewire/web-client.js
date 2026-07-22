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
// Audit finding C-5 (2026-07-21): the previous `h.endsWith('.amazonaws.com')` blanket suffix let a
// mis-served / compromised Sitewire response point PILOT's uploader at ANY AWS service host (ec2,
// elasticbeanstalk, lambda function URLs, etc.) or a dangling-subdomain takeover. Restrict to the two
// real S3 host shapes (regional `s3.us-east-1.amazonaws.com` / `bucket.s3-us-west-2.amazonaws.com`
// AND global `s3.amazonaws.com` / `bucket.s3.amazonaws.com`) and drop the suffix catch-all.
function assertUploadUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error('sitewire_web_bad_upload_url'); }
  if (url.protocol !== 'https:') throw new Error('sitewire_web_insecure_upload_url');
  const h = url.host.toLowerCase();
  const ok = h === webHost() || /(^|\.)s3[.-][a-z0-9-]*\.amazonaws\.com$/.test(h) || /(^|\.)s3\.amazonaws\.com$/.test(h);
  if (!ok) throw new Error(`sitewire_web_upload_host_not_allowed:${h}`);
  return url;
}

// ---- cookie jar (fetch does not persist cookies) ----
// Audit finding C-8 (2026-07-21): a server-issued `Set-Cookie: foo=; Max-Age=0` (or an already-
// expired Expires) MUST delete the cookie from our jar, not store a blank value that then gets
// sent back. Same for a "delete" via Max-Age=-1 or an Expires date in the past. Single-host jar
// today so this was largely cosmetic, but the fix is defensive against Sitewire ever adding a
// deliberate cookie-revocation on logout / session-rotate.
function mergeSetCookie(jar, res) {
  let list = [];
  try { list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; } catch { list = []; }
  if (!list.length) { const one = res.headers.get('set-cookie'); if (one) list = [one]; }
  for (const c of list) {
    const parts = String(c).split(';');
    const pair = parts[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // Parse the cookie attributes for Max-Age / Expires and honor deletion signals.
    let deleteCookie = false;
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].trim();
      const aeq = attr.indexOf('=');
      const k = (aeq >= 0 ? attr.slice(0, aeq) : attr).toLowerCase();
      const v = aeq >= 0 ? attr.slice(aeq + 1).trim() : '';
      if (k === 'max-age') {
        const n = Number(v);
        if (Number.isFinite(n) && n <= 0) { deleteCookie = true; break; }
      } else if (k === 'expires' && v) {
        const t = Date.parse(v);
        if (Number.isFinite(t) && t <= Date.now()) { deleteCookie = true; break; }
      }
    }
    if (deleteCookie) { delete jar[name]; continue; }
    jar[name] = value;
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
  const s = String(html || '');
  // name-first meta (Rails default), content-first meta (attribute order can vary), or the hidden form field.
  const m = s.match(/<meta[^>]*\bname=["']csrf-token["'][^>]*\bcontent=["']([^"']+)["']/i)
    || s.match(/<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']csrf-token["']/i)
    || s.match(/name=["']authenticity_token["'][^>]*\bvalue=["']([^"']+)["']/i)
    || s.match(/value=["']([^"']+)["'][^>]*\bname=["']authenticity_token["']/i);
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
  // Path A (PREFERRED, self-renewing): log in with email + password. Because PILOT logs itself in fresh each
  // time, the session can NEVER be "expired" — there is no cookie to go stale. This is the durable option.
  if (cfg.sitewireWebEmail && cfg.sitewireWebPassword) return loginWithPassword();
  // Path B (fallback, e.g. if login is ever blocked): a provided session cookie. Seed the jar and return —
  // do NOT warm up on the site root (that response rotates the session cookie and would clobber the good
  // one, making a valid cookie look "expired"). The CSRF token + auth check happen on the property page.
  if (cfg.sitewireWebCookie) {
    const jar = {};
    for (const pair of String(cfg.sitewireWebCookie).split(/;\s*/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    if (!Object.keys(jar).length) {
      return { error: 'web_cookie_malformed', message: 'The Sitewire cookie must be in name=value form (for example _sitewire_session=abc123…). Copy the cookie’s NAME and its value together, not just the value.' };
    }
    return { jar, csrf: null, viaCookie: true };
  }
  return { error: 'web_creds_missing', message: 'Set SITEWIRE_WEB_EMAIL + SITEWIRE_WEB_PASSWORD in Render to enable pushing documents to Sitewire.' };
}

// Log into Sitewire the way the website itself does (confirmed from a live capture 2026-07-21):
//   GET /login  → the form's authenticity_token
//   POST /login (application/x-www-form-urlencoded): authenticity_token + password_step=true +
//                user[email] + user[password]  → 302 to / (signed in)
// A fresh login each push = the session never "expires". Returns {jar, csrf, viaLogin} or {error, message}.
async function loginWithPassword() {
  const jar = {};
  try {
    const signInUrl = webBase() + (cfg.sitewireWebSignInPath || '/login');
    // 1) GET the login page → session cookie + the form's authenticity_token.
    const page = await fetchWithTimeout(signInUrl, { method: 'GET', headers: { Accept: 'text/html' } });
    mergeSetCookie(jar, page);
    const token = scrapeCsrf(await page.text());
    if (!token) return { error: 'web_login_no_token', message: 'Could not read the Sitewire login form (the login page may have changed). Re-capture the login if this persists.' };
    // 2) POST the exact fields Sitewire's login form submits (incl. password_step=true + Origin/Referer,
    // which Rails' forgery protection checks). Extra Devise fields are intentionally NOT sent.
    const form = new URLSearchParams();
    form.set('authenticity_token', token);
    form.set('password_step', 'true');
    form.set('user[email]', cfg.sitewireWebEmail);
    form.set('user[password]', cfg.sitewireWebPassword);
    const resp = await fetchWithTimeout(signInUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html',
        Cookie: cookieHeader(jar), 'X-CSRF-Token': token, Origin: webBase(), Referer: signInUrl,
      },
      body: form.toString(),
    });
    mergeSetCookie(jar, resp);
    // Success = a 302 redirect (to / then /draws). A 200 back on /login = bad credentials / rejected.
    // Audit finding C-7 (2026-07-21): only 200 was screened, so a 401/403/500/5xx from the login
    // POST silently returned `viaLogin:true` and errored downstream in primeCsrf with a generic
    // `web_session_invalid` — confusing "our session broke" instead of the actionable "the login
    // itself was rejected/broken". Explicitly accept ONLY 302 (Devise's success signal) or a 200
    // that doesn't look signed-out; anything else is an authentication failure with a clear message.
    if (resp.status === 302) {
      return { jar, csrf: null, viaLogin: true };
    }
    if (resp.status === 200) {
      const body = await resp.text();
      if (looksSignedOut(body)) return { error: 'web_login_failed', message: 'Sitewire rejected the login — double-check SITEWIRE_WEB_EMAIL and SITEWIRE_WEB_PASSWORD in Render.' };
      // A 200 without sign-in markers is a rare but valid "signed in but no redirect" — accept it.
      return { jar, csrf: null, viaLogin: true };
    }
    // Any other status (401/403/500/502/…): the login itself failed. Surface a message that says
    // WHY rather than deferring to a downstream "session invalid" catch-all.
    return { error: 'web_login_failed', message: `Sitewire login endpoint returned ${resp.status} — the login itself failed. Check SITEWIRE_WEB_EMAIL / SITEWIRE_WEB_PASSWORD, or Sitewire is having an outage.` };
  } catch (e) {
    return { error: 'web_login_error', message: `Sitewire login failed: ${e.message}` };
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
 * Get a fresh CSRF token from the PROPERTY page (which Rails always server-renders with
 * <meta name="csrf-token">), confirm the session is authenticated (not bounced to sign-in), and set it on
 * the session. This is what makes the cookie method reliable regardless of how the sign-in screen is built.
 * Returns { ok } or { error, message }. Never throws.
 */
async function primeCsrf(session, propertyId) {
  try {
    const url = `${webBase()}/properties/${encodeURIComponent(propertyId)}`;
    let res = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'text/html', Cookie: cookieHeader(session.jar) } });
    mergeSetCookie(session.jar, res);
    // Follow one same-host redirect (a signed-out session bounces to /users/sign_in).
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      const next = loc ? new URL(loc, webBase()) : null;
      if (next && /sign_in|login|session/i.test(next.pathname)) {
        return { error: 'web_session_invalid', message: 'The Sitewire login is no longer valid (the saved cookie has expired). Copy a fresh SITEWIRE_WEB_COOKIE from a logged-in Sitewire tab.' };
      }
      if (next && next.host === webHost()) { res = await fetchWithTimeout(next.toString(), { method: 'GET', headers: { Accept: 'text/html', Cookie: cookieHeader(session.jar) } }); mergeSetCookie(session.jar, res); }
    }
    const html = await res.text();
    if (looksSignedOut(html)) return { error: 'web_session_invalid', message: 'The Sitewire login is no longer valid (the saved cookie has expired). Copy a fresh SITEWIRE_WEB_COOKIE from a logged-in Sitewire tab.' };
    const token = scrapeCsrf(html) || session.csrf;
    if (!token) return { error: 'web_no_csrf', message: 'Signed in, but could not read Sitewire’s security token from the property page.' };
    session.csrf = token;
    return { ok: true };
  } catch (e) { return { error: 'web_prime_error', message: `Could not open the Sitewire property page: ${e.message}` }; }
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

// Sitewire's property_documents form is a Turbo (Hotwire) form — it responds with a turbo-stream, NOT JSON.
// Sending `Accept: application/json` gets a 406 Not Acceptable (the controller can't render JSON). These are
// the exact headers the website sends (confirmed from a live capture): turbo-stream Accept + the turbo-frame
// target + Origin/Referer for Rails' forgery check. Never send X-Requested-With here.
function turboHeaders(session, propertyId) {
  return {
    Accept: 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
    Cookie: cookieHeader(session.jar),
    'X-CSRF-Token': session.csrf,
    'Turbo-Frame': 'property-documents',
    Origin: webBase(),
    Referer: `${webBase()}/properties/${encodeURIComponent(propertyId)}`,
  };
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
  // ?paginate=true + turbo headers = the exact CREATE request the website makes (returns a 200 turbo-stream).
  const res = await fetchWithTimeout(`${webBase()}/properties/${encodeURIComponent(propertyId)}/property_documents?paginate=true`, {
    method: 'POST',
    headers: turboHeaders(session, propertyId),
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
  const res = await fetchWithTimeout(`${webBase()}/properties/${encodeURIComponent(propertyId)}/property_documents/${encodeURIComponent(docId)}?paginate=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...turboHeaders(session, propertyId) },
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
  webConfigured, getSession, primeCsrf, uploadBlob, attachDocument, deleteDocument,
  _internal: { scrapeCsrf, looksSignedOut, assertUploadUrl, mergeSetCookie, cookieHeader },
};
