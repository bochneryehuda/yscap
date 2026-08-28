/* Thin fetch wrapper. Token lives in localStorage; every call is same-origin
   against the Express backend (/auth, /api/borrower).

   Resilience built in:
   - GETs retry automatically on 502/503/504 and network drops (deploys,
     server restarts) instead of surfacing "HTTP 502" to the user.
   - Sessions slide: the backend returns a fresh token in X-Refresh-Token past
     the old one's half-life; we store it, so active users are never logged out.
   - A real 401 (expired/revoked session) clears the token once and notifies
     the app (ys:auth-changed), so route guards bounce to the right login with
     a clear message instead of leaving a half-broken page. */
const KEY = 'ys_portal_token';
export const NOTICE_KEY = 'ys_auth_notice';
export const getToken = () => localStorage.getItem(KEY) || '';
export const setToken = (t) => t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY);
export const clearToken = () => localStorage.removeItem(KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = [502, 503, 504];
// The shared record of what is uploading right now (see lib/upload-progress.js).
// The TRANSPORT writes to it, so every upload surface gets a live row without
// any call site remembering to report progress.
import * as up from './upload-progress.js';

const RETRY_DELAYS = [700, 1800, 3500];   // ~6s total — covers a restart blip

function friendlyError(status, data) {
  const base = (data && data.error) ? data.error
    : RETRYABLE.includes(status) ? 'The server is briefly unavailable (it may be restarting) — please try again in a moment.'
    : status === 401 ? 'Your session has expired — please sign in again.'
    : status === 403 ? 'You don’t have access to that.'
    : status === 404 ? 'That item could not be found.'
    : status === 413 ? 'That file is too large to upload.'
    : `Something went wrong (HTTP ${status}) — please try again.`;
  // A "server error" ON ITS OWN TELLS NOBODY ANYTHING (owner-directed 2026-08-16).
  // The server now attaches the real reason to every 5xx it can explain — for a
  // STAFF session only — plus a reference that names the exact row in the
  // request log. Both are put in front of the person looking at the screen, on
  // every screen at once, because this is the one place an error becomes words.
  const detail = data && typeof data.detail === 'string' ? data.detail.trim() : '';
  const ref = data && typeof data.reference === 'string' ? data.reference.trim() : '';
  return [detail && !base.includes(detail) ? `${base} — ${detail}` : base,
    ref ? `(ref ${ref})` : ''].filter(Boolean).join(' ');
}

// Session ended mid-use: clear the token ONCE, remember WHY, and let the router
// (which watches ys:auth-changed) bounce to the correct login screen.
//
// `reason` is the server's own words when it gave us one (the 401 body carries a
// `code` + message — see sessionDenied() in src/auth/index.js), so the login
// screen can say "this account has been turned off" instead of the catch-all
// "your session expired", which sent people re-typing a password that was never
// the problem (owner-reported 2026-07-26).
const DEFAULT_NOTICE = 'You were signed out because your session expired. Please sign in again.';
function sessionExpired(reason) {
  if (!getToken()) return;
  clearToken();
  try { sessionStorage.setItem(NOTICE_KEY, reason || DEFAULT_NOTICE); } catch { /* private mode */ }
  window.dispatchEvent(new Event('ys:auth-changed'));
}

/* Is the session REALLY dead, or was that one 401 about something else?
   Signing someone out is destructive (it drops every open tab on the device —
   the token lives in localStorage), so we never do it on the strength of a
   single response. We ask /auth/me, which answers for the SESSION and nothing
   else. Plain fetch, so this can never recurse back into the 401 handling.
   Anything other than a clean 401 (a network blip, a 502 from an upstream
   vendor, a 500) means KEEP the session. */
async function confirmSessionDead() {
  // Probe with the token stored RIGHT NOW, and report which token that was — so the
  // caller only ever signs out the exact token it proved dead (see handle401). This
  // single-flight probe is shared across every 401 in a burst, so it may test a
  // DIFFERENT token than a given caller captured; tying the verdict to the token it
  // used stops a delayed 401 from an old token signing out a freshly-refreshed one.
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch('/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 401) return null;
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { dead: true, reason: (data && data.error) || '', token };
  } catch { return null; }   // couldn't reach the server — not proof of anything
}

// Only one confirmation probe in flight at a time: a screen that fires six
// parallel calls must not fire six probes (and must not race six sign-outs).
let deadCheck = null;
async function handle401(data) {
  const token = getToken();
  if (!token) return;
  // The server marks a genuine session rejection with `session:'invalid'`.
  // A 401 WITHOUT that marker is not ours to act on — it came from something
  // else on the way (a proxy, a CDN, an older build) and must never sign
  // anyone out on its own; we confirm it against /auth/me first either way.
  if (!deadCheck) deadCheck = confirmSessionDead().finally(() => { deadCheck = null; });
  const verdict = await deadCheck;
  if (!verdict || !verdict.dead) return;               // session is fine — leave it alone
  // Sign out ONLY the token we actually proved dead, and only if it is STILL the
  // active one — so a refresh (or a fresh sign-in) that swapped the token while the
  // shared probe was in flight leaves the good session alone.
  if (verdict.token !== getToken()) return;
  sessionExpired(verdict.reason || (data && data.error) || DEFAULT_NOTICE);
}

/* Read a token's own claims WITHOUT verifying (routing/ordering only — the
   server verifies every call). Tolerates missing base64url padding. */
function tokenClaims(t) {
  try {
    const p = String(t).split('.')[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return { sub: c.sub || null, iat: Number(c.iat) || 0 };
  } catch { return null; }
}

/* Take a server-refreshed token ONLY if it is genuinely NEWER, for the SAME
   account. A response's headers do not always come from the network: when the
   browser revalidates a cached GET and the server answers 304, the fetch layer
   hands JavaScript the STORED response's headers. So an `X-Refresh-Token`
   minted during an earlier session could be replayed on every later request and
   overwrite the LIVE token with an old one — and once that replayed token aged
   past its 30-day life the very next call answered 401 `bad_token` and the SPA
   signed the user out a second after they signed in on a correct password.
   (The server now sends Cache-Control: no-store, which stops NEW poisoning;
   this guard is what saves a browser whose cache is already poisoned, and what
   keeps the whole class of replay from ever mattering again.)
   Comparing `iat` makes a replay a no-op: same-or-older is ignored. */
function acceptRefreshedToken(fresh) {
  const current = getToken();
  if (!current) return;                    // signed out — a header must never resurrect a session
  const now = tokenClaims(current);
  const next = tokenClaims(fresh);
  if (!now || !next) return;               // unreadable — keep the token we know works
  if (next.sub !== now.sub) return;        // a different account's token — never swap it in
  if (next.iat <= now.iat) return;         // same or older: a cached replay, not a refresh
  setToken(fresh);
}

// One fetch with retry-on-transient-failure (only for GETs — retrying a write
// could double-submit) + refresh-token capture + global 401 handling.
async function resilientFetch(path, opts, { isAuthCall = false } = {}) {
  const canRetry = !opts.method || opts.method === 'GET';
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {   // network drop / server not accepting connections yet
      lastErr = e;
      if (canRetry && attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt]); continue; }
      const err = new Error('Can’t reach the server — check your connection and try again.');
      err.cause = lastErr; err.status = 0;
      throw err;
    }
    if (canRetry && RETRYABLE.includes(res.status) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    const fresh = res.headers.get('X-Refresh-Token');
    if (fresh) acceptRefreshedToken(fresh);
    if (res.status === 401 && !isAuthCall && getToken()) {
      // Read the reason without consuming the body the caller still needs.
      let data = null; try { data = await res.clone().json(); } catch { /* empty */ }
      handle401(data);   // deliberately not awaited — the caller's error path shouldn't wait on the probe
    }
    return res;
  }
}

// Fetch a binary document with the auth header and hand back a blob + filename.
// (A plain <a href> can't send the Bearer token, so downloads go through fetch.)
async function download(path) {
  const t = getToken();
  const res = await resilientFetch(path, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!res.ok) {
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    const err = new Error(friendlyError(res.status, data));
    err.status = res.status; err.data = data;
    throw err;
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  return { blob: await res.blob(), filename: m ? m[1] : 'document' };
}
/* THE SAME DOWNLOAD, BUT IT SAYS WHERE IT HAS GOT TO.
 *
 * Owner-reported 2026-08-23 about the draw report: *"it's going to a blank page. It
 * takes a very long time … If it needs time, in the pilot, you should see that it
 * takes time loading."* `download()` above awaits `res.blob()`, which resolves only
 * when the LAST byte has arrived — so between the click and the file there is no
 * information at all, and a slow build is indistinguishable from a broken link.
 *
 * This reads the body as a stream and reports progress as it goes. Two honest
 * phases, and it never invents a third:
 *   · WAITING — the request is out, no byte has come back. For a report that means
 *     the server is still RENDERING; there is genuinely no percentage to show yet,
 *     so the caller shows elapsed time, not a fake bar creeping to 90%.
 *   · RECEIVING — bytes are arriving. With a Content-Length that is a real
 *     percentage; without one it is a byte count, which is still the truth.
 *
 * Falls back to a plain `blob()` where the browser has no streaming body reader, so
 * the download itself can never depend on the progress feature working.
 */
async function downloadProgress(path, onProgress) {
  const t = getToken();
  const report = (p) => { try { if (onProgress) onProgress(p); } catch (_) { /* a progress callback may never break a download */ } };
  report({ phase: 'waiting', received: 0, total: null, pct: null });

  const res = await resilientFetch(path, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!res.ok) {
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    const err = new Error((data && data.message) || friendlyError(res.status, data));
    err.status = res.status; err.data = data;
    throw err;
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m ? m[1] : 'document';
  const type = res.headers.get('Content-Type') || 'application/octet-stream';
  const lenHeader = res.headers.get('Content-Length');
  const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;

  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob();
    report({ phase: 'done', received: blob.size, total: blob.size, pct: 100 });
    return { blob, filename };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report({ phase: 'receiving', received, total, pct: total ? Math.min(99, Math.round((received / total) * 100)) : null });
  }
  const blob = new Blob(chunks, { type });
  report({ phase: 'done', received, total: total || received, pct: 100 });
  return { blob, filename };
}
export const downloadAuthedProgress = downloadProgress;

// Like download(), but POSTs a JSON body first (for exports that take a selection,
// e.g. a bulk tape). On error the server's JSON `{error,message,...}` rides along
// on err.data so the caller can show the exact reason (e.g. a buyer mismatch).
async function downloadPost(path, body) {
  const t = getToken();
  const res = await resilientFetch(path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: `Bearer ${t}` } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    const err = new Error((data && data.message) || friendlyError(res.status, data));
    err.status = res.status; err.data = data;
    throw err;
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  return { blob: await res.blob(), filename: m ? m[1] : 'document' };
}
/* AN UPLOAD THAT DOES NOT GO THROUGH ONE OF THE DOCUMENT DOORS STILL GETS A ROW.
 *
 * A handful of endpoints take their own shape — a draw's supporting documents post a
 * batch of files with a category, the manual wire form posts one. They are still
 * uploads, so the owner's rule still applies to them (2026-08-23: "everywhere in our
 * system … it's just blank, and it sounds like it's not uploading"), and a helper is
 * the honest way to say so: one line at the call site, no bespoke progress state, and
 * impossible to half-do. Sizeless rows render indeterminate (see `trackJsonUpload`) —
 * these payloads are already in memory, so what is being waited on is the server, and
 * a percentage would be invented.
 */
export function trackUploads(target, names, run) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const ids = list.map((n) => {
    const id = up.startUpload({ target, filename: String(n), size: 0 });
    up.finishSending(id);
    return id;
  });
  return Promise.resolve()
    .then(run)
    .then((r) => { ids.forEach((i) => up.completeUpload(i)); return r; })
    .catch((e) => {
      const msg = (e && e.data && (e.data.error || e.data.message)) || (e && e.message);
      ids.forEach((id) => up.failUpload(id, msg));
      throw e;
    });
}

// The authenticated-GET download, exported so feature clients (e.g. the Arena)
// can fetch a file behind the login instead of pointing an <a href> at it.
export const downloadAuthed = download;
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'document';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
// Open a fetched blob in a browser tab (for a PDF the user wants to VIEW, not download). Because the fetch
// happens AFTER the click, a `window.open` here is outside the user gesture and popup-blockers reject it —
// so the caller SHOULD pass a `win` it opened synchronously in the click handler (`window.open('','_blank')`)
// and we just navigate it. Falls back to opening/downloading if no live window was handed in, so the report
// is never lost. SECURITY: only ever hand this a blob whose type is server-controlled + trusted (our
// application/pdf reports/images) — a blob: URL opened this way runs with the portal's origin, so untrusted
// HTML/SVG bytes here would be a stored-XSS vector.
export function openBlob(blob, filename, win) {
  const url = URL.createObjectURL(blob);
  if (win && !win.closed) { try { win.location.href = url; } catch { window.open(url, '_blank'); } }
  else {
    const w = window.open(url, '_blank');
    if (!w) { const a = document.createElement('a'); a.href = url; a.download = filename || 'document'; document.body.appendChild(a); a.click(); a.remove(); }
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Normalize any upload payload: the backend stores raw base64 (dataBase64), so
// if a caller passes a full `data:` URL we strip the prefix here. This keeps a
// single upload contract and prevents "filename + dataBase64 required" errors.
function normalizeUpload(b) {
  if (b && b.dataUrl && !b.dataBase64) {
    const s = String(b.dataUrl);
    const i = s.indexOf(',');
    const { dataUrl, ...rest } = b;
    return { ...rest, dataBase64: i >= 0 ? s.slice(i + 1) : s };
  }
  return b;
}

/* THE STREAMING UPLOAD — the file itself is the request body.
 *
 * Owner-directed 2026-08-21: *"we need to increase the limit of megabytes that we can
 * upload to unlimit it … The sky is the limit."* Base64-in-JSON could not answer that: it
 * inflates the file by a third on the wire and costs the SERVER about five times the file
 * to parse, so on a 512 MB instance a large upload is an out-of-memory kill of the whole
 * site rather than one failed upload. Handing `fetch` the File streams it instead — the
 * browser sends it in chunks and the server writes it straight to storage.
 *
 * The metadata rides in a header as base64 JSON: a raw header value is latin-1 on the
 * wire, so a filename with an accent, a quotation mark or a comma would corrupt silently.
 */
function b64json(o) {
  const bytes = new TextEncoder().encode(JSON.stringify(o || {}));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function uploadBinary(path, b) {
  const { file, dataBase64, dataUrl, ...meta } = b || {};
  const filename = meta.filename || (file && file.name) || 'upload';
  const headers = { 'Content-Type': 'application/octet-stream' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  headers['x-upload-meta'] = b64json({
    ...meta,
    filename,
    contentType: meta.contentType || (file && file.type) || 'application/octet-stream',
  });

  /* XMLHttpRequest, NOT fetch — and this is the whole reason uploads showed nothing.
     Owner-reported 2026-08-23: *"when you upload a document, right now it's not doing
     anything while it's uploading. It's just blank, and it sounds like it's not
     uploading."*  `fetch()` has no way to report how much of the REQUEST BODY has been
     sent: its promise settles when the response arrives, and there is no event in
     between. So no surface could have shown a percentage even if it had wanted to —
     there was no number to show. `xhr.upload.onprogress` is the only browser API that
     reports bytes sent, which is why the transport moves here.

     Everything else is deliberately identical: same path, same headers, same streamed
     File body (XHR streams a File exactly as fetch does — the browser sends it in
     chunks, so the "sky is the limit" upload size from 2026-08-21 is untouched), same
     JSON result, same error shape. Every existing caller is unchanged.

     Progress is published to lib/upload-progress.js under a target derived from the
     upload's own metadata, so a surface gets a live row by rendering <UploadRows/>
     where the document will land — no call site has to remember to report anything. */
  const rowId = up.startUpload({ target: up.uploadTarget(meta), filename, size: file ? file.size : 0 });

  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path, true);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.responseType = 'text';

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) up.updateUpload(rowId, { loaded: e.loaded, total: e.total });
      };
      // The body is out; from here the server is storing it and we are waiting.
      xhr.upload.onload = () => up.finishSending(rowId);

      xhr.onload = () => {
        let parsed = null;
        try { parsed = JSON.parse(xhr.responseText); } catch { /* a non-JSON body is handled below */ }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(parsed); return; }
        const err = new Error(friendlyError(xhr.status, parsed));
        err.status = xhr.status; err.data = parsed;
        reject(err);
      };
      // A network failure, a CORS refusal and an abort are three different things to
      // the person watching, and "Upload failed" for all three is what makes a system
      // feel broken. Say which one it was.
      xhr.onerror = () => reject(new Error('The connection dropped while uploading. Check your connection and try again.'));
      xhr.ontimeout = () => reject(new Error('The upload timed out. Try again, or try a smaller file.'));
      xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true }));

      xhr.send(file);
    });

    // A 401 on an upload must trigger the same session-expiry probe every other call
    // gets; `resilientFetch` used to do that for this path and XHR does not, so it is
    // done explicitly rather than quietly lost.
    up.completeUpload(rowId);
    return data;
  } catch (e) {
    if (e && e.status === 401 && getToken()) handle401(e.data);
    up.failUpload(rowId, (e && e.data && (e.data.error || e.data.message)) || (e && e.message));
    throw e;
  }
}

/* THE OLDER, BASE64 UPLOAD PATH GETS A ROW TOO — because "everywhere in our system"
   means everywhere, and a surface that still hands over bytes rather than a File would
   otherwise be the one place that still looks broken.

   It cannot show a real PERCENTAGE and does not pretend to: the bytes were already in
   memory before the request started, so what the person is waiting on is the server
   storing them, not a transfer. The row says the file's name and that it is working,
   with an indeterminate bar — which is the honest version of the same message. A
   surface that wants a true percentage hands `api` a File and gets the streaming door
   (see `uploadBinary`). */
function trackJsonUpload(meta, run) {
  const m = meta || {};
  const id = up.startUpload({
    target: up.uploadTarget(m),
    filename: m.filename || (m.file && m.file.name) || 'file',
    size: 0,                       // 0 → no percentage; the row renders indeterminate
  });
  up.finishSending(id);            // straight to "working on it"
  return Promise.resolve()
    .then(run)
    .then((r) => { up.completeUpload(id); return r; })
    .catch((e) => {
      up.failUpload(id, (e && e.data && (e.data.error || e.data.message)) || (e && e.message));
      throw e;
    });
}

// Upload idempotency, client side (#87): a document upload that fires twice in
// the same tick — a drop handler running twice, a double-clicked button, a React
// double-invoke — must not send two POSTs (each of which becomes a duplicate
// document + a duplicate "New document uploaded" email). Coalesce byte-identical
// uploads to the same context that are already in flight onto ONE request/promise
// (the server carries a matching guard for the sequential-retry case). Keyed on
// the stable identity, never the whole base64 payload.
const _uploadsInFlight = new Map();
function uploadSig(tag, b) {
  b = b || {};
  /* A STREAMED upload carries no base64, so keying on its length would make every
     streamed upload to one condition look identical and coalesce two different files
     into one request. Its own byte size is the equivalent identity. */
  const size = b.file ? b.file.size : (b.dataBase64 || '').length;
  return [tag, b.applicationId, b.checklistItemId, b.llcId, b.trackRecordId, b.slot,
    b.docKind, b.filename, size].map((x) => (x == null ? '' : String(x))).join('|');
}
function coalesceUpload(tag, b, fn) {
  const key = uploadSig(tag, b);
  const existing = _uploadsInFlight.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => _uploadsInFlight.delete(key));
  _uploadsInFlight.set(key, p);
  return p;
}

// Build a `?a=b&c=d` query string from a params object, skipping null/undefined/
// empty values (so callers can pass a sparse filter object and unset filters just
// disappear). Returns '' for no/empty params, keeping bare-path callers unchanged.
function qs(params) {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    u.append(k, v);
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

// Login/MFA/registration endpoints answer 401 for bad credentials — that must
// show as an error on the form, never trigger the global "session expired" path.
const AUTH_CALL = /^\/auth\/((borrower|staff)\/(login|mfa\/verify|register)|mfa\/(enable|disable|backup-codes))/;

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await resilientFetch(path, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined,
  }, { isAuthCall: AUTH_CALL.test(path) });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data));
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get:  (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  patch:(p, b) => req('PATCH', p, b),
  put:  (p, b) => req('PUT', p, b),
  del:  (p) => req('DELETE', p),

  login: (email, password) => req('POST', '/auth/borrower/login', { email, password }),
  mfaVerify: (challenge, code) => req('POST', '/auth/borrower/mfa/verify', { challenge, code }),
  register: (b) => req('POST', '/auth/borrower/register', b),

  // Self-service 2FA (shared borrower/staff endpoints — the token identifies who).
  mfaStatus:      () => req('GET', '/auth/mfa/status'),
  mfaSetup:       () => req('POST', '/auth/mfa/setup'),
  mfaEnable:      (code) => req('POST', '/auth/mfa/enable', { code }),
  mfaDisable:     (code) => req('POST', '/auth/mfa/disable', { code }),
  mfaRegenBackup: (code) => req('POST', '/auth/mfa/backup-codes', { code }),

  verifyEmail:        (b) => req('POST', '/auth/borrower/verify', b),          // {token} or {email,code}
  resendVerification: (email) => req('POST', '/auth/borrower/resend-verification', { email }),
  // scope ('borrower' | 'staff') tells the shared endpoint which login the user
  // clicked "Forgot password?" on, so a dual account (staff who also borrowed)
  // gets ONE reset email routed to the right login instead of two.
  forgotPassword:     (email, scope) => req('POST', '/auth/borrower/forgot', scope ? { email, scope } : { email }),
  resetPassword:      (token, password) => req('POST', '/auth/borrower/reset', { token, password }),
  acceptInvite:       (b) => req('POST', '/auth/accept', b),                   // {token,password,fullName?}
  /* An officer's emailed term sheet (owner-directed 2026-08-07). The READ is public —
     the borrower has no account yet when they click the link, and the token is the
     authorization — so it must not be filed under the borrower routes. `start` needs
     the session /auth/accept just handed out. */
  termSheetOffer:     (token) => req('GET', `/api/term-sheet-offers/${encodeURIComponent(token)}`),
  startFromTermSheetOffer: (token, initial) =>
    req('POST', `/api/term-sheet-offers/${encodeURIComponent(token)}/start`, { initial }),
  // Staff side: send a term sheet built in the Investor Suite to a borrower.
  sendTermSheetOffer: (b) => req('POST', '/api/staff/term-sheet-offers', b),
  termSheetOffersSent: () => req('GET', '/api/staff/term-sheet-offers'),
  // Borrower HELPER (assistant) — a standing second login a borrower authorized
  // (can do everything but see personal info / sign). Its own credentials, but
  // NOT its own sign-in screen: a helper signs in through `login` above, on the
  // one client login page, and the server hands back a helper session
  // (owner-directed 2026-08-09). `assistantAccept` is the one-time
  // set-your-password step from the invite email.
  assistantAccept:    (token, password) => req('POST', '/auth/assistant/accept', { token, password }),
  assistantLogout:    () => req('POST', '/auth/assistant/logout'),
  // Borrower self-service: manage the helpers on my own account.
  assistantsList:     () => req('GET', '/api/borrower/assistants'),
  assistantInvite:    (email, name) => req('POST', '/api/borrower/assistants', { email, name }),
  assistantResend:    (id) => req('POST', `/api/borrower/assistants/${id}/resend`),
  assistantDisable:   (id) => req('POST', `/api/borrower/assistants/${id}/disable`),
  // E-sign magic-link session handoff: exchange the one-time login code (from the
  // /api/esign/return redirect) for a real borrower session, so a borrower who
  // signed from PILOT's branded email lands back inside their file already logged in.
  claimEsignSession:  (li) => req('POST', '/api/esign/claim-session', { li }),

  profile:      () => req('GET', '/api/borrower/profile'),
  saveProfile:  (b) => req('PUT', '/api/borrower/profile', b),
  uploadPhotoId:(b) => coalesceUpload('photoId', b, () => req('POST', '/api/borrower/profile/photo-id', normalizeUpload(b))),
  applications: () => req('GET', '/api/borrower/applications'),
  application:  (id) => req('GET', `/api/borrower/applications/${id}`),
  fileOfficer:  (id) => req('GET', `/api/borrower/applications/${id}/officer`),
  // Cross-file "Action needed" — everything the borrower must do right now (documents
  // to provide, fixes, signatures) in ONE call, so the home shows it instantly.
  actionItems: () => req('GET', '/api/borrower/action-items'),
  inviteCoBorrowerToFile: (id, b) => req('POST', `/api/borrower/applications/${id}/co-borrower`, b),
  requestDraw:  (id) => req('POST', `/api/borrower/applications/${id}/request-draw`),
  borrowerPricing:      (appId) => req('GET', `/api/borrower/applications/${appId}/pricing`),
  borrowerPricingQuote: (appId, overrides) => req('POST', `/api/borrower/applications/${appId}/pricing/quote`, { overrides }),
  borrowerRegisterProduct: (appId, program, overrides, adminKey, econVersion, submitException, termOptions) => req('POST', `/api/borrower/applications/${appId}/pricing/register`, { program, overrides, adminKey, econVersion, submitException, termOptions }),
  borrowerRequestException: (appId, note) => req('POST', `/api/borrower/applications/${appId}/pricing/request-exception`, { note }),
  checklist:    (id) => req('GET', `/api/borrower/applications/${id}/checklist`),
  conditions:   (id) => req('GET', `/api/borrower/applications/${id}/conditions`),
  // Borrower change-request sandbox (S5-03) — borrower side. List their requests,
  // and open one (a single economics field + reason) via the complete-fields path.
  changeRequests: (id) => req('GET', `/api/borrower/applications/${id}/change-requests`),
  requestChange:  (id, field, value, reason) => req('POST', `/api/borrower/applications/${id}/complete-fields`, { [field]: value, reason }),
  activity:     (id) => req('GET', `/api/borrower/applications/${id}/activity`),
  statusHistory:(id) => req('GET', `/api/borrower/applications/${id}/status-history`),
  // #103 borrower self-service pricing
  pricingPrefill:      () => req('GET', '/api/borrower/pricing/prefill'),
  pricingScenarios:    () => req('GET', '/api/borrower/pricing/scenarios'),
  savePricingScenario: (label, inputs) => req('POST', '/api/borrower/pricing/scenarios', { label, inputs }),
  updatePricingScenario: (id, body) => req('PUT', `/api/borrower/pricing/scenarios/${id}`, body),
  deletePricingScenario: (id) => req('DELETE', `/api/borrower/pricing/scenarios/${id}`),
  notifications:() => req('GET', '/api/borrower/notifications'),
  messages:     (appId) => req('GET', `/api/borrower/messages?applicationId=${appId}`),
  react:        (msgId, emoji) => req('POST', `/api/borrower/messages/${msgId}/react`, { emoji }),
  editMessage:  (msgId, body) => req('PATCH', `/api/borrower/messages/${msgId}`, { body }),
  deleteMessage:(msgId) => req('DELETE', `/api/borrower/messages/${msgId}`),
  mentionables: (appId) => req('GET', `/api/borrower/applications/${appId}/mentionables`),
  postMessage:  (appId, body, opts = {}) => req('POST', '/api/borrower/messages', { applicationId: appId, body, ...opts }),
  readNotif:    (id) => req('POST', `/api/borrower/notifications/${id}/read`),
  uploadDoc:    (b) => coalesceUpload('uploadDoc', b, () => (b && b.file
    ? uploadBinary('/api/borrower/documents/binary', b)
    : trackJsonUpload(b, () => req('POST', '/api/borrower/documents', normalizeUpload(b))))),
  documents:    (appId) => req('GET', `/api/borrower/documents${appId ? `?applicationId=${appId}` : ''}`),
  downloadDoc:  (id) => download(`/api/borrower/documents/${id}/download`),
  // borrower completes an in-portal tool task (Rehab Budget / Track Record)
  completeTool: (appId, itemId, payload, notes) =>
    req('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/tool`, { payload, notes }),

  // reusable service contacts (title company / insurance agent)
  contacts:     (type) => req('GET', `/api/borrower/contacts${type ? `?type=${type}` : ''}`),
  saveContact:  (b) => req('POST', '/api/borrower/contacts', b),
  // general file contacts (#144) — any vendor, many per file, shared on the file
  fileContacts:    (appId) => req('GET', `/api/borrower/applications/${appId}/file-contacts`),
  /* The borrower's OWN previously-used contacts as a type-ahead — never the
     company vendor directory (see lib/vendor-directory for why the two
     audiences differ). Blank `q` = "what have I used before". */
  vendorSuggest:   (type, q) => req('GET', `/api/borrower/vendor-suggest?type=${encodeURIComponent(type || '')}&q=${encodeURIComponent(q || '')}`),
  addFileContact:  (appId, b) => req('POST', `/api/borrower/applications/${appId}/file-contacts`, b),
  editFileContact: (linkId, b) => req('PATCH', `/api/borrower/file-contacts/${linkId}`, b),
  delFileContact:  (linkId) => req('DELETE', `/api/borrower/file-contacts/${linkId}`),
  myContacts:      () => req('GET', '/api/borrower/my-contacts'),

  // reusable LLC / vesting-entity database (info + ownership + 3 doc slots)
  llcs:         () => req('GET', '/api/borrower/llcs'),
  llc:          (id) => req('GET', `/api/borrower/llcs/${id}`),
  createLlc:    (b) => req('POST', '/api/borrower/llcs', b),
  updateLlc:    (id, b) => req('PATCH', `/api/borrower/llcs/${id}`, b),
  saveLlcMembers: (id, members) => req('PUT', `/api/borrower/llcs/${id}/members`, { members }),
  linkLlc:      (appId, llcId) => req('POST', `/api/borrower/applications/${appId}/link-llc`, { llcId }),

  // investment track record (experience) — drives the pricing tier
  trackRecords:    () => req('GET', '/api/borrower/track-records'),
  addTrackRecord:  (b) => req('POST', '/api/borrower/track-records', b),
  deleteTrackRecord: (id) => req('DELETE', `/api/borrower/track-records/${id}`),
  trackRecordSnapshot: () => req('GET', '/api/borrower/track-record/snapshot'),
  // Properties our team found in the public records, for the borrower to confirm
  // (blueprint §9.4). A "yes" is a CLAIM — it lands pending and staff verify it.
  trackRecordCandidates: () => req('GET', '/api/borrower/track-record-candidates'),
  answerTrackRecordCandidate: (id, b) => req('POST', `/api/borrower/track-record-candidates/${id}/answer`, b),
  undoTrackRecordCandidate: (id) => req('POST', `/api/borrower/track-record-candidates/${id}/undo`),
  // The borrower's OWN records search (2026-08-19) — one button, no options;
  // the server owns the cooldown, the monthly ceiling and the wording.
  borrowerTrackRecordSearch: () => req('POST', '/api/borrower/track-record-search', {}),

  // reusable partners (co-borrowers)
  partners:     () => req('GET', '/api/borrower/partners'),
  savePartner:  (b) => req('POST', '/api/borrower/partners', b),

  // notification preferences
  notificationPrefs:     () => req('GET', '/api/borrower/notification-prefs'),
  saveNotificationPref:  (b) => req('PUT', '/api/borrower/notification-prefs', b),

  drafts:         () => req('GET', '/api/borrower/drafts'),
  archivedDrafts: () => req('GET', '/api/borrower/drafts?archived=1'),
  createDraft:    (b) => req('POST', '/api/borrower/drafts', b),
  draft:          (id) => req('GET', `/api/borrower/drafts/${id}`),
  saveDraft:      (id, b) => req('PUT', `/api/borrower/drafts/${id}`, b),
  deleteDraft:    (id) => req('DELETE', `/api/borrower/drafts/${id}`),
  archiveDraft:   (id) => req('POST', `/api/borrower/drafts/${id}/archive`),
  unarchiveDraft: (id) => req('POST', `/api/borrower/drafts/${id}/unarchive`),
  submitDraft:    (id, b) => req('POST', `/api/borrower/drafts/${id}/submit`, b),

  // ---- TPO portal (external brokerage users — the third front door) ----
  // A broker signs in ONLY here; the token carries kind='tpo' and every /api/tpo
  // call is firm-scoped server-side. Mirrors the staff login shape (mfaRequired /
  // challenge). The invite-accept reuses the shared /auth/accept (the invite's
  // stored kind routes it), so `acceptInvite` above is used for a tpo invite too.
  tpoLogin:       (email, password) => req('POST', '/auth/tpo/login', { email, password }),
  tpoMfaVerify:   (challenge, code) => req('POST', '/auth/tpo/mfa/verify', { challenge, code }),
  tpoMe:          () => req('GET', '/api/tpo/me'),
  tpoApplications:() => req('GET', '/api/tpo/applications'),
  tpoApplication: (id) => req('GET', `/api/tpo/applications/${id}`),
  tpoEnterLoan:   (b) => req('POST', '/api/tpo/applications', b),
  tpoSetBorrowerPortal: (id, enabled) => req('POST', `/api/tpo/applications/${id}/borrower-portal`, { enabled }),
  tpoTeam:        () => req('GET', '/api/tpo/team'),
  tpoTeamInvite:  (b) => req('POST', '/api/tpo/team/invite', b),   // {email, fullName?, role?}
  // The firm's OWN broker origination fee — the ONLY pricing control a broker has
  // (never the rate). GET returns { isFirmAdmin, brokerFeePct, maxBrokerFeePct }.
  tpoBrokerFee:    () => req('GET', '/api/tpo/pricing/broker-fee'),
  tpoBrokerFeeSet: (brokerFeePct) => req('PUT', '/api/tpo/pricing/broker-fee', { brokerFeePct }),
  // Phase 3 — the firm's borrowers + full PII.
  tpoBorrowers:      () => req('GET', '/api/tpo/borrowers'),
  tpoBorrower:       (id) => req('GET', `/api/tpo/borrowers/${id}`),
  tpoBorrowerSsn:    (id) => req('GET', `/api/tpo/borrowers/${id}/ssn`),      // reveal (audited)
  tpoSetBorrowerSsn: (id, ssn) => req('POST', `/api/tpo/borrowers/${id}/ssn`, { ssn }),
  tpoUpdateBorrower: (id, b) => req('PATCH', `/api/tpo/borrowers/${id}`, b),
  // Phase 4 — the file's conditions + documents.
  tpoChecklist:      (id) => req('GET', `/api/tpo/applications/${id}/checklist`),
  tpoDocuments:      (id) => req('GET', `/api/tpo/applications/${id}/documents`),
  tpoUploadDocument: (b) => (b && b.file
    ? uploadBinary('/api/tpo/documents/binary', b)
    : trackJsonUpload(b, () => req('POST', '/api/tpo/documents', normalizeUpload(b)))),
  // Answer an information condition (a deal field). A person field (fico) is
  // redirected to the borrower's profile by the server.
  tpoAnswerInfoCondition: (appId, itemId, value) => req('POST', `/api/tpo/applications/${appId}/checklist/${itemId}/info`, { value }),
  // Phase 5a — order a credit pull (borrower-safe: readiness in, "pulled" out; no scores).
  tpoCreditStatus: (appId) => req('GET', `/api/tpo/applications/${appId}/credit`),
  tpoOrderCredit: (appId, body) => req('POST', `/api/tpo/applications/${appId}/credit/order`, body),   // { consent:true, borrowerIds? }
  // Title & insurance ordering (broker; never flood, never RCN). Borrower-safe state.
  tpoOrders:        (appId) => req('GET', `/api/tpo/applications/${appId}/orders`),
  tpoSetOrderVendor:(appId, kind, b) => req('POST', `/api/tpo/applications/${appId}/orders/${kind}/vendor`, b),
  tpoPlaceOrder:    (appId, kind, body) => req('POST', `/api/tpo/applications/${appId}/orders/${kind}/place`, body || {}),
  // Phase 6a — the read-only appraisal ("property profile report"); same borrower-safe scrub.
  tpoAppraisal: (appId) => req('GET', `/api/tpo/applications/${appId}/appraisal`),
  // The file-overview slide-over — one borrower-safe builder, three doors.
  tpoFileOverview:      (appId) => req('GET', `/api/tpo/applications/${appId}/overview-card`),
  borrowerFileOverview: (appId) => req('GET', `/api/borrower/applications/${appId}/overview-card`),
  staffFileOverview:    (appId) => req('GET', `/api/staff/applications/${appId}/overview-card`),
  tpoAppraisalPhotoBlob: async (docId) => (await download(`/api/tpo/appraisal-photo/${docId}?inline=1`)).blob,
  // Phase 6b — the read-only DRAW view (construction-draw progress); same borrower-safe scrub.
  tpoDraws: (appId) => req('GET', `/api/tpo/applications/${appId}/draws`),
  // A photo url from the draws payload is a firm-scoped /api/tpo/draw-media path — blob-fetched WITH
  // auth (an <img src> can't send the token), exactly like the appraisal photos.
  tpoDrawMediaBlob: async (url) => (await download(url)).blob,
  tpoDrawReport: async (appId, drawId, win) => {
    try { const { blob, filename } = await download(`/api/tpo/applications/${appId}/draws/report${drawId ? `?drawId=${drawId}` : ''}`); openBlob(blob, filename, win); }
    catch (e) { try { if (win && !win.closed) win.close(); } catch { /* ignore */ } throw e; }
  },
  // The same report, opened IN the portal with a visible progress state (2026-08-23).
  tpoDrawReportStatus: (appId, drawId) =>
    req('GET', `/api/tpo/applications/${appId}/draws/report/status${drawId ? `?drawId=${drawId}` : ''}`),
  tpoDrawReportBytes: (appId, drawId, onProgress) =>
    downloadProgress(`/api/tpo/applications/${appId}/draws/report${drawId ? `?drawId=${drawId}` : ''}`, onProgress),

  // Phase 6d — the broker ACCEPTS / DISPUTES an inspection result (owner-locked: "like a borrower").
  // Authenticated + firm-scoped; mirrors the borrower's authenticated accept/dispute server-side —
  // never the borrower's public reply_token. Accept MOVES MONEY (starts the wire SLA).
  tpoDrawAccept:  (appId, findingId) => req('POST', `/api/tpo/applications/${appId}/findings/${findingId}/accept`, {}),
  tpoDrawDispute: (appId, findingId, lines) => req('POST', `/api/tpo/applications/${appId}/findings/${findingId}/dispute`, { lines }),
  // Phase 6e — broker ↔ team messaging (reuses ChatThread with surface='tpo'; firm-scoped, borrower-safe).
  tpoConversations:  (appId) => req('GET', `/api/tpo/chat/conversations${appId ? `?applicationId=${appId}` : ''}`),
  tpoConversation:   (cid) => req('GET', `/api/tpo/chat/conversations/${cid}`),
  tpoConvMessages:   (cid, before) => req('GET', `/api/tpo/chat/conversations/${cid}/messages${before ? `?before=${before}` : ''}`),
  tpoConvSend:       (cid, b) => req('POST', `/api/tpo/chat/conversations/${cid}/messages`, b),
  tpoConvRead:       (cid, seq) => req('POST', `/api/tpo/chat/conversations/${cid}/read`, { seq }),
  tpoConvMarkUnread: (cid, seq) => req('POST', `/api/tpo/chat/conversations/${cid}/unread`, { seq }),
  tpoConvDelivered:  (cid, seq) => req('POST', `/api/tpo/chat/conversations/${cid}/delivered`, { seq }),
  tpoConvTyping:     (cid, connId) => req('POST', `/api/tpo/chat/conversations/${cid}/typing`, { connId }),
  tpoConvOpen:       (cid, connId) => req('POST', `/api/tpo/chat/conversations/${cid}/open`, { connId }),
  tpoConvDraft:      (cid, body) => req('PUT', `/api/tpo/chat/conversations/${cid}/draft`, { body }),
  tpoConvShared:     (cid) => req('GET', `/api/tpo/chat/conversations/${cid}/shared`),
  tpoDownloadChatAttachment: (id) => download(`/api/tpo/chat/attachment/${id}`),
  // Phase 4b — the TPO Term Sheet Studio: price, register, generate the term
  // sheet (borrower-safe; sending the DocuSign package stays lender-only).
  tpoPricing:      (appId) => req('GET', `/api/tpo/applications/${appId}/pricing`),
  tpoPricingQuote: (appId, overrides) => req('POST', `/api/tpo/applications/${appId}/pricing/quote`, { overrides }),
  tpoRegisterProduct: (appId, program, overrides, econVersion, submitException, termOptions) =>
    req('POST', `/api/tpo/applications/${appId}/pricing/register`, { program, overrides, econVersion, submitException, termOptions }),

  // ---- staff portal (loan officer / processor / underwriter / admin) ----
  staffLogin:     (email, password) => req('POST', '/auth/staff/login', { email, password }),
  staffMfaVerify: (challenge, code) => req('POST', '/auth/staff/mfa/verify', { challenge, code }),
  me:             () => req('GET', '/auth/me'),
  staffTeam:        () => req('GET', '/api/staff/team'),
  // Optional server-side filters (see /api/staff/applications): group, status,
  // officerId, processorId, program, minAmount, maxAmount, fundedFrom/To,
  // createdFrom/To, flag ('stalled'|'nodate'), limit, offset. Called bare it
  // returns the full scoped pipeline (used to build filter facets + counts).
  staffApplications:(params) => req('GET', '/api/staff/applications' + qs(params)),
  // Top-bar omnibox — one call returns { loans, borrowers, llcs }.
  staffGlobalSearch:(q) => req('GET', '/api/staff/search' + qs({ q })),
  staffMyTasks:     () => req('GET', '/api/staff/my-tasks'),
  staffExceptions:  () => req('GET', '/api/staff/exceptions'),
  staffCreateFile:  (b) => req('POST', '/api/staff/applications', b),
  staffInviteBorrower: (appId) => req('POST', `/api/staff/applications/${appId}/invite-borrower`),
  staffInviteToPortal: (b) => req('POST', '/api/staff/invite-to-portal', b),
  staffLeadCapture: () => req('GET', '/api/staff/lead-capture'),
  staffApplication: (id) => req('GET', `/api/staff/applications/${id}`),
  staffSetCoBorrower: (id, body) => req('POST', `/api/staff/applications/${id}/co-borrower`, body),
  // #81 — subject vesting LLC ownership across the file's borrowers
  staffVestingLlcOwners: (id) => req('GET', `/api/staff/applications/${id}/vesting-llc-owners`),
  staffSetVestingLlcOwners: (id, owners) => req('POST', `/api/staff/applications/${id}/vesting-llc-owners`, { owners }),
  staffChecklist:   (id) => req('GET', `/api/staff/applications/${id}/checklist`),
  // The login-free outstanding-conditions outreach (owner-directed 2026-08-28):
  // preview + recipients (helpers included), the send (one personal link per
  // recipient), and the kill switch on a link that shouldn't be out there.
  conditionsOutreachPreview: (id, note) => req('GET', `/api/staff/applications/${id}/conditions/outreach${note ? `?note=${encodeURIComponent(note)}` : ''}`),
  conditionsOutreachSend:    (id, body) => req('POST', `/api/staff/applications/${id}/conditions/outreach`, body),
  conditionsOutreachRevoke:  (id, linkId) => req('POST', `/api/staff/applications/${id}/conditions/outreach/${linkId}/revoke`),
  // WHO HANDLES THE CLOSING (owner-directed 2026-08-28): the per-file resolution
  // + override, and the company/note-buyer defaults on the API Health page.
  closingHandling:        (id) => req('GET', `/api/staff/applications/${id}/closing-handling`),
  setClosingHandling:     (id, handling) => req('POST', `/api/staff/applications/${id}/closing-handling`, { handling }),
  adminClosingHandling:   () => req('GET', '/api/admin/integrations/closing-handling'),
  saveAdminClosingHandling: (body) => req('PUT', '/api/admin/integrations/closing-handling', body),
  staffPlaceSettlementOrder: (id, body) => req('POST', `/api/staff/applications/${id}/orders/settlement/place`, body || {}),
  staffFloodZoneFlip:        (id, inFloodZone) => req('POST', `/api/staff/applications/${id}/flood-zone`, { inFloodZone }),
  staffPlaceFloodInsurance:  (id, body) => req('POST', `/api/staff/applications/${id}/orders/flood-insurance/place`, body || {}),

  // Encompass sync (READ-ONLY per-file reconcile). status = summary; findings =
  // the full field-by-field comparison (live data); refresh = re-pull read-only;
  // replace = pull one Encompass value into our column (any assigned staff).
  encompassStatus:   (id) => req('GET', `/api/staff/applications/${id}/encompass/status`),
  encompassFindings: (id) => req('GET', `/api/staff/applications/${id}/encompass/findings`),
  encompassRefresh:  (id) => req('POST', `/api/staff/applications/${id}/encompass/refresh`),
  // Super-admin only: the raw Encompass troubleshooting view.
  encompassRaw:      (id) => req('GET', `/api/staff/applications/${id}/encompass/raw`),
  encompassReplace:  (id, fieldKey) => req('POST', `/api/staff/applications/${id}/encompass/replace`, { fieldKey }),
  // Field exceptions: any assigned staffer requests; a super admin grants/denies/revokes.
  encompassRequestException: (id, fieldKey, reason) => req('POST', `/api/staff/applications/${id}/encompass/request-exception`, { fieldKey, reason }),
  encompassDecideException:  (id, fieldKey, decision, reason) => req('POST', `/api/staff/applications/${id}/encompass/decide-exception`, { fieldKey, decision, reason }),
  // Flood-certificate ordering (the one owner-authorized Encompass write).
  floodOrderState:   (id) => req('GET', `/api/staff/applications/${id}/flood-order`),
  orderFlood:        (id, itemId, force) => req('POST', `/api/staff/applications/${id}/order-flood`, { ...(itemId ? { checklistItemId: itemId } : {}), ...(force ? { force: true } : {}) }),
  // Retrieval of a certificate we already paid for — never places a new order.
  fetchFloodCertificate: (id) => req('POST', `/api/staff/applications/${id}/flood-certificate`),
  // Credit report (Xactus import) — the internal Credit report condition.
  // `scope` = 'co' | 'primary' narrows the credit section to ONE borrower, so a
  // co-borrower's own credit condition shows their report instead of the file's.
  staffCredit:        (id, scope) => req('GET', `/api/staff/applications/${id}/credit${scope && scope !== 'file' ? `?scope=${encodeURIComponent(scope)}` : ''}`),
  staffCreditPreview: (id) => req('GET', `/api/staff/applications/${id}/credit/preview`),
  staffCreditImport:  (id, b) => req('POST', `/api/staff/applications/${id}/credit/import`, b),
  // #16 — reuse a borrower's existing (<120-day) report from another of their files,
  // no new inquiry; and the borrower profile's credit history across all their files.
  staffCreditReuse:   (id, b) => req('POST', `/api/staff/applications/${id}/credit/reuse`, b),
  staffBorrowerCredit:(borrowerId) => req('GET', `/api/staff/borrowers/${borrowerId}/credit`),
  // Sign the credit condition off on a report obtained ELSEWHERE (owner-directed
  // 2026-08-03): upload the PDF onto the condition, then request an exception an
  // admin approves. `itemId` names WHICH credit condition (a file can carry the
  // file-level one and a co-borrower's own).
  creditWaiverGet:    (id, q) => req('GET', `/api/staff/applications/${id}/credit-waiver${q && q.itemId ? `?itemId=${encodeURIComponent(q.itemId)}` : (q && q.scope ? `?scope=${encodeURIComponent(q.scope)}` : '')}`),
  creditWaiverRequest:(id, b) => req('POST', `/api/staff/applications/${id}/credit-waiver`, b),
  creditWaiverRemove: (id, q) => req('DELETE', `/api/staff/applications/${id}/credit-waiver${q && q.itemId ? `?itemId=${encodeURIComponent(q.itemId)}` : (q && q.scope ? `?scope=${encodeURIComponent(q.scope)}` : '')}`),
  // #147 — the cross-system observability timeline for a file (portal + ClickUp +
  // SharePoint + sync-review events, time-ordered). Scoped by the file's access.
  staffObservability: (id, opts = {}) => req('GET', `/api/staff/applications/${id}/observability`
    + (opts.sources ? `?sources=${encodeURIComponent(opts.sources)}` : '')),
  staffAppDocuments:(id) => req('GET', `/api/staff/applications/${id}/documents`),
  staffReviewDoc:   (id, action, reason, opts) => req('POST', `/api/staff/documents/${id}/review`, { action, reason, ...(opts || {}) }),
  // Permanently delete a document (mistake-upload) — removes bytes + row, never
  // syncs to SharePoint. Reopens the condition if nothing accepted remains.
  staffDeleteDoc:   (id) => req('DELETE', `/api/staff/documents/${id}`),
  staffDownloadDoc: (id) => download(`/api/staff/documents/${id}/download`),
  // Read the text off a scanned document so the in-viewer search can find it.
  // Returns { ok, pages:[{page,text}], engine, reason }. Never throws for the
  // caller's UX — a not-configured / failed read is a shaped { ok:false }.
  staffOcrDoc:      (id) => req('POST', `/api/staff/documents/${id}/ocr`, {}),
  // Everything the system knows about ONE document: where it landed, why it was
  // asked for, its versions, its review verdicts, its sync state, and its full
  // event history. Read-only.
  staffDocDossier:  (id) => req('GET', `/api/staff/documents/${id}/dossier`),
  staffBorrowerSearch: (q) => req('GET', '/api/staff/borrowers/search?q=' + encodeURIComponent(q)),
  // #83 — loan-officer borrower management
  staffBorrowers:   () => req('GET', '/api/staff/borrowers'),
  staffBorrowerInvite: (id) => req('POST', `/api/staff/borrowers/${id}/portal-invite`),
  // Change WHICH email the Sitewire borrower invite goes to (borrower / GC / partner). Replaces the
  // pending invite (Sitewire keeps one email per property) + stores it so the push/resend honor it.
  setDrawInviteEmail: (appId, email) => req('POST', `/api/sitewire/files/${appId}/invite-email`, { email }),

  // ---- AMC appraisal ordering (AppraisalScope / CoreLogic Digital Gateway) ----
  amcConfig:        () => req('GET', '/api/amc/config'),
  amcPreview:       (appId, params) => req('GET', `/api/amc/files/${appId}/preview${params && Object.keys(params).length ? ('?' + new URLSearchParams(params).toString()) : ''}`),
  amcOrders:        (appId) => req('GET', `/api/amc/files/${appId}/orders`),
  amcPlaceOrder:    (appId, body) => req('POST', `/api/amc/files/${appId}/order`, body),
  amcSaveCard:      (appId, body) => req('POST', `/api/amc/files/${appId}/card`, body),
  amcOrder:         (orderId) => req('GET', `/api/amc/orders/${orderId}`),
  // PAYING an AppraisalScope order. `amcPayment` is the read a screen does BEFORE
  // offering a button — is it already paid, is one going through, can this file's
  // card actually be charged — and reveals no card number. `amcPay` is the press.
  amcPayment:       (orderId) => req('GET', `/api/amc/orders/${orderId}/payment`),
  amcPay:           (orderId, body) => req('POST', `/api/amc/orders/${orderId}/pay`, body || {}),
  amcCancelOrder:   (orderId, reason) => req('POST', `/api/amc/orders/${orderId}/cancel`, { reason }),
  // Delete a draft/failed/dryrun attempt that never reached the vendor (2026-08-18).
  amcDeleteOrder:   (orderId) => req('DELETE', `/api/amc/orders/${orderId}`),
  classDeleteOrder: (appId, orderRowId) => req('DELETE', `/api/class/files/${appId}/orders/${orderRowId}`),
  rvDeleteOrder:    (orderId) => req('DELETE', `/api/richer-value/orders/${orderId}`),
  amcComments:      (orderId) => req('GET', `/api/amc/orders/${orderId}/comments`),
  amcPostComment:   (orderId, body) => req('POST', `/api/amc/orders/${orderId}/comments`, { body }),
  amcReadComment:   (orderId, commentId) => req('POST', `/api/amc/orders/${orderId}/comments/${commentId}/read`),
  amcRevisions:     (orderId) => req('GET', `/api/amc/orders/${orderId}/revisions`),
  amcPostRevision:  (orderId, b) => req('POST', `/api/amc/orders/${orderId}/revisions`, b),
  amcRovComps:      (appId) => req('GET', `/api/amc/files/${appId}/rov-comps`),
  amcRovCompSearch: (appId, query) => {
    const qs = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v != null && v !== '')).toString();
    return req('GET', `/api/amc/files/${appId}/rov-comp-search${qs ? '?' + qs : ''}`);
  },
  amcPostRov:       (orderId, b) => req('POST', `/api/amc/orders/${orderId}/rov`, b),
  amcDocuments:     (appId, orderId) => req('GET', `/api/amc/files/${appId}/documents${orderId ? '?orderId=' + orderId : ''}`),
  // `action` names the AppraisalScope upload to use. Omitted, it follows the count
  // (UploadDocument / UploadDocumentMulti) exactly as it always has; 'UploadContract'
  // is how the purchase contract goes up AS the contract, where the appraiser looks
  // for it, instead of as a generic supporting document.
  amcUploadDocs:    (orderId, documentIds, action) => req('POST', `/api/amc/orders/${orderId}/documents`, action ? { documentIds, action } : { documentIds }),
  // ACCOUNT-WIDE reads (platform_setup), not per file: what the appraisal company
  // holds that PILOT has no row for, and which payment routes the account allows.
  // Both are pure reads — neither places, changes or charges anything.
  amcReconcile:     (q) => req('GET', `/api/amc/reconcile${q && Object.keys(q).length ? '?' + new URLSearchParams(q).toString() : ''}`),
  amcPaymentOptions: () => req('GET', '/api/amc/payment-options'),

  // ---- Class Valuation appraisal ordering (the SECOND vendor) ----
  // Deliberately its own set of calls, never shared with the AMC ones: the owner has
  // not picked a default vendor, so nothing here may quietly become "the" appraisal
  // desk. `classPreview` takes the staff overrides so the screen re-previews as they
  // type — the server is the one that decides what a change does.
  classConfig:   () => req('GET', '/api/class/config'),
  classPreview:  (appId, overrides) => {
    const qs = new URLSearchParams(Object.entries(overrides || {}).filter(([, v]) => v != null && v !== '')).toString();
    return req('GET', `/api/class/files/${appId}/preview${qs ? '?' + qs : ''}`);
  },
  classProducts: (query) => {
    const qs = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v != null && v !== '')).toString();
    return req('GET', `/api/class/products${qs ? '?' + qs : ''}`);
  },
  classPlaceOrder: (appId, body) => req('POST', `/api/class/files/${appId}/order`, body),
  // After the order: the orders on a file, the conversation with Class, and the
  // three things a desk asks for once a report is back.
  classOrders:      (appId) => req('GET', `/api/class/files/${appId}/orders`),
  classThread:      (appId, o) => req('GET', `/api/class/files/${appId}/orders/${o}/thread`),
  classThreadSync:  (appId, o) => req('POST', `/api/class/files/${appId}/orders/${o}/thread/sync`),
  classNote:        (appId, o, content) => req('POST', `/api/class/files/${appId}/orders/${o}/notes`, { content }),
  classMarkRead:    (appId, o) => req('POST', `/api/class/files/${appId}/orders/${o}/read`),
  classRevision:    (appId, o, body) => req('POST', `/api/class/files/${appId}/orders/${o}/revision`, body),
  classCancelOrder: (appId, o, body) => req('POST', `/api/class/files/${appId}/orders/${o}/cancel`, body),
  classReasons:     (kind) => req('GET', `/api/class/revision-reasons?kind=${encodeURIComponent(kind || 'revision')}`),

  // ---- Richer Values — the THIRD vendor, and the "Hybrid Appraisal" ----
  // Deliberately its own set of calls, never shared with the other two: this is a
  // different PRODUCT (an evaluation giving an As-Is value and an ARV, with no
  // appraisal data file), and the vendor selector's default deliberately stays
  // AppraisalScope / NAN — nothing here may quietly become "the" appraisal desk.
  rvConfig:     () => req('GET', '/api/richer-value/config'),
  rvCatalogue:  (q = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '')).toString();
    return req('GET', `/api/richer-value/catalogue${qs ? '?' + qs : ''}`);
  },
  // The preview re-runs as the staffer types, so the SERVER stays the one that
  // decides what a change does — the overrides go up, the whole answer comes back.
  rvPreview: (appId, overrides) => {
    const flat = { ...(overrides || {}) };
    if (flat.propertyAccessContacts) flat.propertyAccessContacts = JSON.stringify(flat.propertyAccessContacts);
    const qs = new URLSearchParams(Object.entries(flat).filter(([, v]) => v != null && v !== '')).toString();
    return req('GET', `/api/richer-value/files/${appId}/preview${qs ? '?' + qs : ''}`);
  },
  rvPrice:       (appId, overrides) => req('POST', `/api/richer-value/files/${appId}/price`, overrides || {}),
  rvPlaceOrder:  (appId, body) => req('POST', `/api/richer-value/files/${appId}/order`, body),
  rvOrders:      (appId) => req('GET', `/api/richer-value/files/${appId}/orders`),
  // Talking to their team. Their API has no messaging, so this is email — the
  // thread is read and written here, and their replies join it on their own.
  rvMessages:    (appId) => req('GET', `/api/richer-value/files/${appId}/messages`),
  rvSendMessage: (appId, body) => req('POST', `/api/richer-value/files/${appId}/messages`, { body }),
  rvOrder:       (orderId) => req('GET', `/api/richer-value/orders/${orderId}`),
  rvRefresh:     (orderId) => req('POST', `/api/richer-value/orders/${orderId}/refresh`, {}),
  rvApplyValues: (orderId) => req('POST', `/api/richer-value/orders/${orderId}/apply-values`, {}),
  rvFetchReport: (orderId) => req('POST', `/api/richer-value/orders/${orderId}/fetch-report`, {}),
  rvCancel:      (orderId, reason) => req('POST', `/api/richer-value/orders/${orderId}/cancel`, { reason, confirm: true }),
  rvHold:        (orderId, reason) => req('POST', `/api/richer-value/orders/${orderId}/hold`, { reason }),
  rvReleaseHold: (orderId, notes) => req('POST', `/api/richer-value/orders/${orderId}/release-hold`, { notes }),
  rvReopen:      (orderId, body) => req('POST', `/api/richer-value/orders/${orderId}/reopen`, body),
  // Paying takes a METHOD — the card on the file, a card typed now, or a payment
  // link to the borrower. Add to Invoice and ACH are not offered anywhere.
  rvPay:         (orderId, body) => req('POST', `/api/richer-value/orders/${orderId}/pay`, body || {}),
  rvPaymentState: (appId) => req('GET', `/api/richer-value/files/${appId}/payment`),
  rvScopeOfWork: (appId) => req('GET', `/api/richer-value/files/${appId}/scope-of-work`),
  rvSendScopeOfWork: (orderId, note) => req('POST', `/api/richer-value/orders/${orderId}/scope-of-work`, { note: note || null }),
  rvSendPaymentLink: (orderId, body) => req('POST', `/api/richer-value/orders/${orderId}/send-payment-link`, body),
  rvSetInspection: (orderId, inspectionType) => req('POST', `/api/richer-value/orders/${orderId}/inspection-type`, { inspectionType }),
  rvSetReportType: (orderId, reportType) => req('POST', `/api/richer-value/orders/${orderId}/report-type`, { reportType }),
  rvDismiss:     (orderId) => req('POST', `/api/richer-value/orders/${orderId}/dismiss`, {}),
  rvReactivate:  (orderId) => req('POST', `/api/richer-value/orders/${orderId}/reactivate`, {}),
  rvSendDocuments: (orderId, documentIds, field) => req('POST', `/api/richer-value/orders/${orderId}/documents`, { documentIds, field }),
  staffBorrowerResetPassword: (id) => req('POST', `/api/staff/borrowers/${id}/reset-password`),
  staffBorrowerSetPassword: (id, password) => req('POST', `/api/staff/borrowers/${id}/set-password`, { password }),
  staffBorrower:    (id) => req('GET', `/api/staff/borrowers/${id}`),
  staffUpdateBorrower: (id, b) => req('PATCH', `/api/staff/borrowers/${id}`, b),
  // Borrower CRM hub roll-ups
  staffBorrowerApplications: (id) => req('GET', `/api/staff/borrowers/${id}/applications`),
  staffBorrowerConditions:   (id) => req('GET', `/api/staff/borrowers/${id}/conditions`),
  staffBorrowerReminders:    (id) => req('GET', `/api/staff/borrowers/${id}/reminders`),
  staffCreateBorrowerReminder: (id, b) => req('POST', `/api/staff/borrowers/${id}/reminders`, b),
  staffBorrowerDocuments:    (id) => req('GET', `/api/staff/borrowers/${id}/documents`),
  staffBorrowerActivity:     (id) => req('GET', `/api/staff/borrowers/${id}/activity`),
  staffBorrowerNotes:        (id) => req('GET', `/api/staff/borrowers/${id}/notes`),
  staffAddBorrowerNote:      (id, body) => req('POST', `/api/staff/borrowers/${id}/notes`, { body }),
  staffDeleteBorrowerNote:   (id, nid) => req('DELETE', `/api/staff/borrowers/${id}/notes/${nid}`),
  staffBorrowerSsn: (id) => req('GET', `/api/staff/borrowers/${id}/ssn`),
  // Set / correct the SSN on the PROFILE (owner-directed 2026-07-26 — it was
  // only settable from inside a loan file). `resolveConflict:'same_person'`
  // moves the number off a duplicate profile that is already holding it; the
  // 409 that comes back without it names that profile so the staffer can look.
  staffSetBorrowerSsn: (id, ssn, opts = {}) => req('POST', `/api/staff/borrowers/${id}/ssn`, { ssn, ...opts }),
  staffAddBorrowerContact:     (id, b) => req('POST', `/api/staff/borrowers/${id}/contacts`, b),
  staffSetPrimaryContact:      (id, b) => req('POST', `/api/staff/borrowers/${id}/contacts/primary`, b),
  // Track-record findings (owner-directed 2026-08-02). Reading also re-runs the
  // detector server-side, so opening the section keeps the list current.
  staffTrackRecordFindings: (appId) => req('GET', `/api/staff/applications/${appId}/track-record-findings`),
  staffResolveTrackRecordFinding: (appId, findingId, action, note) =>
    req('POST', `/api/staff/applications/${appId}/track-record-findings/${findingId}`, { action, note }),
  // What is still LEFT on this file's track record (owner-directed 2026-08-03).
  // Worked out server-side: the 36-month exit window is a frozen rule and the
  // refusals are the sign-off gate's own — never re-derived in the browser.
  staffTrackRecordTodo: (appId, borrowerId) =>
    req('GET', `/api/staff/applications/${appId}/track-record-todo${borrowerId ? `?borrower=${borrowerId}` : ''}`),
  staffBorrowerTrackRecords: (id) => req('GET', `/api/staff/borrowers/${id}/track-records`),
  /* The profile lens of the Track Record Center: per-line to-do codes + the
     borrower's verified in-window counts — the person, no file. */
  staffBorrowerTrackRecordTodo: (id) => req('GET', `/api/staff/borrowers/${id}/track-record-todo`),
  /* The search sheet's budget meter — calls this hour / paid credits this
     month, read-only (the refusing caps live server-side). */
  staffElementixUsage: () => req('GET', '/api/staff/elementix/usage'),
  staffTrackRecordSnapshot:  (id) => req('GET', `/api/staff/borrowers/${id}/track-record/snapshot`),
  staffBorrowerLlcs: (id) => req('GET', `/api/staff/borrowers/${id}/llcs`),
  // Super-admin: preview + remove an entity added to a profile by mistake.
  staffEntityRemovalPreview: (borrowerId, llcId) => req('GET', `/api/staff/borrowers/${borrowerId}/llcs/${llcId}/removal-preview`),
  staffRemoveEntity: (borrowerId, llcId, reason) => req('POST', `/api/staff/borrowers/${borrowerId}/llcs/${llcId}/remove`, { reason }),
  // Deals a BORROWER typed that nobody has reviewed yet — the track-record
  // review queue (db/458). Scoped server-side to the borrowers this staffer sees.
  staffTrackRecordReviews: () => req('GET', '/api/staff/track-record-reviews'),
  /* THE WORKSPACE (phase 5). Every next step, refusal and readiness sentence in
     these payloads is computed by src/lib/track-record/pillar-actions.js — the
     screen renders them verbatim and never re-decides one. */
  staffTrackRecordWorkspace: (q = {}) =>
    req('GET', `/api/staff/track-record-workspace?filter=${encodeURIComponent(q.filter || 'open')}`
      // Narrowing to one person happens SERVER-side: the queue is capped, so a
      // client-side filter over one page shows nothing at all for a borrower
      // who did not make the cut.
      + (q.borrowerId ? `&borrower=${encodeURIComponent(q.borrowerId)}` : '')),
  staffTrackRecordLine: (id) => req('GET', `/api/staff/track-records/${id}/workspace`),
  staffDecidePillar: (pillarId, body) => req('POST', `/api/staff/track-record-pillars/${pillarId}/decide`, body),
  staffBulkConfirmPillars: (id, body) => req('POST', `/api/staff/track-records/${id}/pillars/bulk-confirm`, body || {}),
  /* THE IMPORTER (phases 7 + 9). Four routes that have existed since phase 7
     with no client and no screen. Searching SPENDS the office's shared hourly
     allowance, so it is only ever a deliberate click — never a page load. */
  staffTrackRecordSearch: (borrowerId, body) =>
    req('POST', `/api/staff/borrowers/${borrowerId}/track-record-search`, body || {}),
  staffTrackRecordCandidates: (borrowerId) =>
    req('GET', `/api/staff/borrowers/${borrowerId}/track-record-candidates`),
  staffCompareCandidate: (id) => req('GET', `/api/staff/track-record-candidates/${id}/compare`),
  /* WHO IS ON IT — advisory. Starting a review run says "I am on these" so two
     reviewers do not read the same deeds; it never gates a decision. */
  staffClaimCandidates: (borrowerId, body) =>
    req('POST', `/api/staff/borrowers/${borrowerId}/track-record-candidates/claim`, body || {}),
  staffDecideCandidate: (id, body) => req('POST', `/api/staff/track-record-candidates/${id}/decide`, body),
  staffTrackRecordDocTypes: () => req('GET', '/api/staff/track-record-doc-types'),
  staffRequestTrackRecordDocTyped: (id, body) => req('POST', `/api/staff/track-records/${id}/request-doc`, body),
  staffTrackRecordRequestPreview: (id, body) => req('POST', `/api/staff/track-records/${id}/request-doc/preview`, body),
  staffAddTrackRecordNote: (body) => req('POST', '/api/staff/track-record-notes', body),
  staffTrackRecordNotes: (kind, id) =>
    req('GET', `/api/staff/track-record-notes?subjectKind=${encodeURIComponent(kind)}&subjectId=${encodeURIComponent(id)}`),
  staffTrackRecordReviewsCount: () => req('GET', '/api/staff/track-record-reviews/count'),
  // In-file verify set: the file's vesting entity + this borrower's track-record
  // entities only (not the borrower's whole LLC library). Returns { vestingLlcId, llcs:[{...,vesting}] }.
  staffAppVerifyLlcs: (appId) => req('GET', `/api/staff/applications/${appId}/verify-llcs`),
  staffSetVestingLlc: (appId, llcId) => req('POST', `/api/staff/applications/${appId}/vesting-llc`, { llcId }),
  // Personal-name purchase: waive the LLC condition with a non-owner-occupied
  // affidavit → vesting flips to Individual (db/383). Pass the affidavit upload to
  // waive, or { undo:true } to go back to an LLC purchase (the default).
  staffVestingPersonalName: (appId, b) => req('POST', `/api/staff/applications/${appId}/vesting/personal-name`, normalizeUpload(b || {})),
  staffCreateLlc:    (borrowerId, b) => req('POST', `/api/staff/borrowers/${borrowerId}/llcs`, b),
  staffLlc:          (id) => req('GET', `/api/staff/llcs/${id}`),
  staffUpdateLlc:    (id, b) => req('PATCH', `/api/staff/llcs/${id}`, b),
  staffSaveLlcMembers: (id, members) => req('PUT', `/api/staff/llcs/${id}/members`, { members }),
  /* THE ENTITY DOCUMENT — streamed when the caller hands over a File (owner-directed
     2026-08-21: the upload fix is "across the entire system"). An operating agreement is a
     multi-page scan, routinely the largest thing on a loan; the base64 branch stays for any
     caller that still holds bytes. */
  staffUploadLlcDoc: (llcId, b) => coalesceUpload('llcDoc:' + llcId, b, () => (b && b.file
    ? uploadBinary(`/api/staff/llcs/${llcId}/documents/binary`, b)
    : trackJsonUpload({ llcId, ...b }, () => req('POST', `/api/staff/llcs/${llcId}/documents`, normalizeUpload(b))))),
  /* THE SAME, for the doors whose callers post by path rather than through a named method:
     hand it a File and it streams, hand it base64 and it does not. One helper, so a new upload
     surface cannot quietly land on the small transport again. */
  uploadStream: (path, b) => (b && b.file
    ? uploadBinary(path.endsWith('/binary') ? path : `${path}/binary`, b)
    : trackJsonUpload(b, () => req('POST', path, normalizeUpload(b)))),
  staffVerifyLlc:    (id, b) => req('POST', `/api/staff/llcs/${id}/verify`, b || {}),
  staffVerifyTrackRecord:    (id, body) => req('POST', `/api/staff/track-records/${id}/verify`, body),
  /* Remove a file from ONE workflow view (pipeline | closing | purchasing) —
     hides it from that desk without deleting it (owner-directed 2026-08-11). The
     double warning is enforced at the call site. Reversible via …/restore. */
  staffRemoveFromWorkflow:  (id, workflow, reason) => req('POST', `/api/staff/applications/${id}/workflow/${workflow}/remove`, { reason: reason || null }),
  staffRestoreToWorkflow:   (id, workflow) => req('POST', `/api/staff/applications/${id}/workflow/${workflow}/restore`, {}),
  /* Edit a line's own fields (address/entity/prices/dates/deal type) — the PUT
     door writes ONLY the columns the body sent (trackRecordSentOnly guard), so
     a partial edit never nulls what it did not touch, and never stamps a
     verification (db/485 stays the one judge). Inline editing on the Track
     Record Center (2026-08-09) instead of opening the embedded tool. */
  staffUpdateTrackRecord:    (id, body) => req('PUT', `/api/staff/track-records/${id}`, body || {}),
  /* Delete a whole track-record line (a duplicate, or a deal that isn't theirs).
     The server re-checks access and recomputes the borrower's tier. Deleting a
     line cascade-removes any documents on it, so the caller warns twice (#32). */
  staffDeleteTrackRecord:    (id) => req('DELETE', `/api/staff/track-records/${id}`),
  /* CHECK THE RECORDS — the per-line public-records research (verify-run.js).
     This is the button the owner expected "Verify" to be (2026-08-09): it reads
     the county's own records for THIS property and fills the three pillars; it
     never marks the line verified — a person still does that, and the final
     verify stays gated on a completed in-window exit. */
  staffResearchTrackRecord:  (id, force) => req('POST', `/api/staff/track-records/${id}/research`, force ? { force: true } : {}),
  // "See more information" — the property's whole recorded story (cached read
  // unless refresh), and the fill that imports what the records state.
  staffTrackRecordMoreInfo:  (id, refresh) => req('POST', `/api/staff/track-records/${id}/more-info`, refresh ? { refresh: true } : {}),
  staffTrackRecordMoreInfoApply: (id, b) => req('POST', `/api/staff/track-records/${id}/more-info/apply`, b || {}),
  // Raise an issue/request against a track-record line item or a vesting LLC — it
  // becomes a named internal+external condition on the file (applicationId).
  staffRaiseTrackRecordIssue: (id, applicationId, reason, postCondition) => req('POST', `/api/staff/track-records/${id}/raise-issue`, { applicationId, reason, postCondition: !!postCondition }),
  // Request a DOCUMENT for one track-record line item — becomes a condition
  // tagged with the line item; uploads land on the line + its REO folder.
  staffRequestTrackRecordDoc: (id, applicationId, label) => req('POST', `/api/staff/track-records/${id}/request-doc`, { applicationId, label }),
  staffTrackRecordDocs: (id) => req('GET', `/api/staff/track-records/${id}/documents`),
  staffRaiseLlcIssue:         (id, applicationId, reason, postCondition) => req('POST', `/api/staff/llcs/${id}/raise-issue`, { applicationId, reason, postCondition: !!postCondition }),
  staffPatchItem:   (itemId, b) => req('PATCH', `/api/staff/checklist/${itemId}`, b),
  staffRequestDoc:  (appId, b) => req('POST', `/api/staff/applications/${appId}/checklist`, b),
  staffAddCondition:(appId, b) => req('POST', `/api/staff/applications/${appId}/conditions`, b),
  staffConditions:  (appId) => req('GET', `/api/staff/applications/${appId}/conditions`),
  // The file's audit log. `requests:true` adds the HTTP request-level layer
  // (opt-in — it is enormous and mostly page loads).
  staffActivity:    (appId, opts) => req('GET', `/api/staff/applications/${appId}/activity`
    + ((opts && (opts.requests || opts.limit))
      ? '?' + [opts.requests ? 'requests=1' : null, opts.limit ? `limit=${opts.limit}` : null].filter(Boolean).join('&')
      : '')),
  // ---- Email Center (per-file history + global mailbox + reply) ----
  staffAppEmails:   (appId, scope) => req('GET', `/api/staff/applications/${appId}/emails` + (scope ? `?scope=${encodeURIComponent(scope)}` : '')),   // per-file email history (scope='draw' → draw inbox)
  staffAppEmailMsg: (appId, msgId) => req('GET', `/api/staff/applications/${appId}/emails/${msgId}`),   // full body of one message
  staffAppEmailReply: (appId, body) => req('POST', `/api/staff/applications/${appId}/emails/reply`, body),
  /* THE TRACK-RECORD EXPORT (owner item 7, 2026-08-21). `scope` is verified | all |
     unverified — the plain button sends none and gets the verified-only report, which is what
     the owner called "regular"; the other two are the extra options. */
  staffTrackRecordExport: async (borrowerId, { scope, format } = {}) => {
    const q = new URLSearchParams();
    if (scope) q.set('scope', scope);
    if (format) q.set('format', format);
    const { blob, filename } = await download(`/api/staff/borrowers/${borrowerId}/track-record/export?${q.toString()}`);
    saveBlob(blob, filename);
  },
  staffAppReplyRecipients: (appId) => req('GET', `/api/staff/applications/${appId}/emails/reply-recipients`),
  staffEmails:      (params) => req('GET', '/api/staff/emails' + qs(params)),            // global mailbox (all visible files)
  staffEmailMsg:    (msgId) => req('GET', `/api/staff/emails/${msgId}`),                 // full body from the global mailbox
  staffEmailStats:  () => req('GET', '/api/staff/emails/stats'),
  staffAppEmailResend: (appId, msgId) => req('POST', `/api/staff/applications/${appId}/emails/${msgId}/resend`),
  staffAppEmailAttachment: (appId, msgId, idx) => download(`/api/staff/applications/${appId}/emails/${msgId}/attachments/${idx}`),
  // Orders desk (#orders) — title + insurance orders on a file.
  staffOrders:        (appId) => req('GET', `/api/staff/applications/${appId}/orders`),
  staffPlaceOrder:    (appId, kind, body) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/place`, body || {}),
  // THE EDITABLE PREVIEW (owner-directed 2026-08-26): the send's own pure builder, read-only.
  staffOrderEmailPreview: (appId, kind, q) => req('GET', `/api/staff/applications/${appId}/orders/${kind}/email-preview${q ? `?${new URLSearchParams(q)}` : ''}`),
  staffClosingPrepEmailPreview: (appId, q) => req('GET', `/api/staff/applications/${appId}/closing-prep/email-preview${q ? `?${new URLSearchParams(q)}` : ''}`),
  // SEND IT LATER (owner-directed 2026-08-20). The scheduling doors mirror the
  // send doors one for one — same file, same kind, same body — because the
  // dispatcher re-enters the very route `staffPlaceOrder` posts to.
  staffScheduleOrder: (appId, kind, body) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/schedule`, body || {}),
  staffScheduleClosingPrep: (appId, body) => req('POST', `/api/staff/applications/${appId}/closing-prep/schedule`, body || {}),
  staffScheduledSends: (appId) => req('GET', `/api/staff/applications/${appId}/scheduled-sends`),
  staffCancelScheduledSend: (appId, id) => req('POST', `/api/staff/applications/${appId}/scheduled-sends/${id}/cancel`, {}),
  drawScheduleInvestorDelivery: (appId, drawId, body) => req('POST', `/api/sitewire/files/${appId}/draws/${drawId}/investor-delivery/schedule`, body || {}),
  drawScheduledSends: (appId) => req('GET', `/api/sitewire/files/${appId}/scheduled-sends`),
  drawCancelScheduledSend: (appId, id) => req('POST', `/api/sitewire/files/${appId}/scheduled-sends/${id}/cancel`, {}),
  staffOrderFollowup: (appId, kind, body) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/followup`, body || {}),
  staffClassifyOrderDoc: (appId, kind, docId, slot) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/documents/${docId}/classify`, { slot }),
  // Put a document into one of ITS OWN condition's named slots (binder / invoice),
  // or back to unassigned — the same act as the Orders desk's classify, done from
  // the condition. Works for a document that reached the condition without an
  // order too (a staffer's manual upload, an agent emailing the file address).
  staffSetDocSlot: (appId, docId, slot) => req('POST', `/api/staff/applications/${appId}/documents/${docId}/slot`, { slot }),
  // Extra requested-document slots ON a condition (db/578): open a named slot
  // ("Request another document within this condition") / remove an unfilled one.
  conditionSlotAdd:    (appId, itemId, body) => req('POST', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots`, body),
  conditionSlotRemove: (appId, itemId, key) => req('DELETE', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots/${encodeURIComponent(key)}`),
  staffCancelOrder:   (appId, kind, reopen) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/cancel`, reopen ? { reopen: true } : {}),
  // AN ORDER IS A TRACKED THING (2026-08-03): who is chasing it, when the answer
  // is expected, what is known about it, and what has happened to it. `staffId`
  // null unassigns; `dueOn` null drops back to the derived date.
  staffAssignOrder:   (appId, kind, staffId) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/assign`, { staffId: staffId || null }),
  staffOrderDue:      (appId, kind, body) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/due`, body || {}),
  staffOrderNote:     (appId, kind, note) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/note`, { note }),
  // The only way an order whose condition is never signed off can ever end.
  staffOrderComplete: (appId, kind, reason) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/complete`, { reason }),
  staffOrderEvents:   (appId, kind) => req('GET', `/api/staff/applications/${appId}/orders/${kind}/events`),
  // How this vendor has actually performed — shown where the choice is made.
  staffOrderVendorScore: (appId, kind) => req('GET', `/api/staff/applications/${appId}/orders/${kind}/vendor-scorecard`),
  staffVendorScorecards: (type) => req('GET', `/api/staff/vendor-scorecards${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  staffAllOrders:     () => req('GET', '/api/staff/orders'),   // global orders queue (all visible files)
  // Attorney closing prep — the third order. Its own routes: the recipients, the
  // document package and the closing email chain have nothing in common with a
  // title/insurance vendor order.
  staffClosingPrep:         (appId) => req('GET', `/api/staff/applications/${appId}/closing-prep`),
  staffPlaceClosingPrep:    (appId, body) => req('POST', `/api/staff/applications/${appId}/closing-prep/place`, body || {}),
  staffClosingPrepFollowup: (appId, body) => req('POST', `/api/staff/applications/${appId}/closing-prep/followup`, body || {}),
  // `reason` rides only on a CANCEL — it goes into the email outside counsel receives. A reopen
  // emails nobody, so it carries none.
  staffCancelClosingPrep:   (appId, reopen, reason) => req('POST', `/api/staff/applications/${appId}/closing-prep/cancel`, reopen ? { reopen: true } : (reason ? { reason } : {})),
  staffSetLoanNumber: (appId, loanNumber) => req('POST', `/api/staff/applications/${appId}/loan-number`, { loanNumber }),
  staffPostClosing: (appId) => req('GET', `/api/staff/applications/${appId}/post-closing`),
  staffSeedPostClosing: (appId) => req('POST', `/api/staff/applications/${appId}/post-closing/seed`),
  staffPatchPostClosing: (pid, b) => req('PATCH', `/api/staff/post-closing/${pid}`, b),
  // Sitewire draw desk: authenticated Excel export of a SOW reallocation (Version 1 vs 2).
  sitewireExportReallocation: async (crId) => { const { blob, filename } = await download(`/api/sitewire/change-requests/${crId}/export`); saveBlob(blob, filename); },
  // Sitewire draw desk: authenticated Excel export of a file's draw audit trail.
  sitewireExportActivity: async (appId) => { const { blob, filename } = await download(`/api/sitewire/files/${appId}/activity/export`); saveBlob(blob, filename); },
  // Sitewire draw desk: authenticated GL/accounting Excel export of the release ledger.
  sitewireExportGl: async (appId) => { const { blob, filename } = await download(`/api/sitewire/files/${appId}/gl-export`); saveBlob(blob, filename); },
  sitewireMessageAttachment: async (appId, nid, idx) => { const { blob, filename } = await download(`/api/sitewire/files/${appId}/messages/${nid}/attachments/${idx}`); saveBlob(blob, filename); },
  // Authed blob fetch for an <img>/tab (an <img src> can't carry the Bearer token). Used to show
  // borrower dispute-evidence photos on the staff draw desk. Returns the Blob.
  authedBlob: async (path) => (await download(path)).blob,
  sitewireOpenDisputeMedia: async (lineId, idx, win) => { const { blob, filename } = await download(`/api/sitewire/findings/lines/${lineId}/dispute-media/${idx}`); openBlob(blob, filename, win); },
  // Sitewire draw desk: authenticated per-draw packet (schedule of values + findings + waivers).
  sitewireExportPacket: async (appId, drawId) => { const { blob, filename } = await download(`/api/sitewire/files/${appId}/draws/${drawId}/packet`); saveBlob(blob, filename); },
  // A supporting document filed on a draw. Streamed through the authed download helper for the same
  // reason every other draw artifact is: an <img>/<a> cannot carry the Bearer token.
  sitewireOpenDrawAttachment: async (appId, drawId, attId, win) => {
    try { const { blob, filename } = await download(`/api/sitewire/files/${appId}/draws/${drawId}/attachments/${attId}/file`); openBlob(blob, filename, win); }
    catch (e) { try { if (win) win.close(); } catch (_) {} throw e; }
  },
  // Accept / reject a supporting document right on the draw card — only an accepted document
  // travels with the investor delivery.
  sitewireReviewDrawAttachment: (appId, drawId, attId, action, reason) =>
    req('POST', `/api/sitewire/files/${appId}/draws/${drawId}/attachments/${attId}/review`, reason ? { action, reason } : { action }),
  // PILOT-branded inspection report (phase 2b) — opens the PDF in a tab (`win` is opened synchronously in the
  // click handler so the popup blocker doesn't eat it; closed here on error). mode 'staff' (full) | 'borrower'
  // (borrower-safe: no partner name / fee / net / GPS). Per-draw and whole-project variants.
  sitewireDrawReport: async (appId, drawId, mode, win) => {
    try { const { blob, filename } = await download(`/api/sitewire/files/${appId}/draws/${drawId}/report${mode === 'borrower' ? '?mode=borrower' : ''}`); openBlob(blob, filename, win); }
    catch (e) { try { if (win && !win.closed) win.close(); } catch { /* ignore */ } throw e; }
  },
  sitewireProjectReport: async (appId, mode, win) => {
    try { const { blob, filename } = await download(`/api/sitewire/files/${appId}/report${mode === 'borrower' ? '?mode=borrower' : ''}`); openBlob(blob, filename, win); }
    catch (e) { try { if (win && !win.closed) win.close(); } catch { /* ignore */ } throw e; }
  },
  /* THE REPORT, OPENED IN PILOT WITH A VISIBLE PROGRESS STATE (owner-reported
     2026-08-23). `…Status` is the cheap "is it already built?" probe the screen asks
     on the click, so it can say "opening" or "building — 43 photos" instead of
     showing a blank tab; `…Bytes` streams the PDF and reports how far it has got.
     The `win`-based openers above are kept for the callers that genuinely want a new
     browser tab (the borrower-share action), unchanged. */
  sitewireDrawReportStatus: (appId, drawId, mode) =>
    req('GET', `/api/sitewire/files/${appId}/draws/${drawId}/report/status${mode === 'borrower' ? '?mode=borrower' : ''}`),
  sitewireProjectReportStatus: (appId, mode) =>
    req('GET', `/api/sitewire/files/${appId}/report/status${mode === 'borrower' ? '?mode=borrower' : ''}`),
  sitewireDrawReportBytes: (appId, drawId, mode, onProgress) =>
    downloadProgress(`/api/sitewire/files/${appId}/draws/${drawId}/report${mode === 'borrower' ? '?mode=borrower' : ''}`, onProgress),
  sitewireProjectReportBytes: (appId, mode, onProgress) =>
    downloadProgress(`/api/sitewire/files/${appId}/report${mode === 'borrower' ? '?mode=borrower' : ''}`, onProgress),
  trustpointDrawReportBytes: (appId, tpDrawId, mode, onProgress) =>
    downloadProgress(`/api/trustpoint/files/${appId}/draws/${tpDrawId}/report${mode === 'borrower' ? '?mode=borrower' : ''}`, onProgress),
  // PILOT-branded report for a TrustPoint-administered draw (staff; mode borrower = the
  // borrower-safe copy). Opens in a tab (win pre-opened in the click handler).
  trustpointDrawReport: async (appId, tpDrawId, mode, win) => {
    try { const { blob, filename } = await download(`/api/trustpoint/files/${appId}/draws/${tpDrawId}/report${mode === 'borrower' ? '?mode=borrower' : ''}`); openBlob(blob, filename, win); }
    catch (e) { try { if (win && !win.closed) win.close(); } catch { /* ignore */ } throw e; }
  },
  // Borrower's OWN branded inspection report (always borrower-safe; server enforces own-file). drawId
  // optional → that draw; omitted → whole-project. Opens in a tab (win pre-opened in the click handler).
  borrowerDrawReport: async (appId, drawId, win) => {
    try { const { blob, filename } = await download(`/api/borrower/draws/${appId}/report${drawId ? `?drawId=${drawId}` : ''}`); openBlob(blob, filename, win); }
    catch (e) { try { if (win && !win.closed) win.close(); } catch { /* ignore */ } throw e; }
  },
  // The same report, opened IN the portal with a visible progress state — the
  // borrower sees a blank tab for exactly as long as a staffer does, so they get
  // the same fix (owner-reported 2026-08-23).
  borrowerDrawReportStatus: (appId, drawId) =>
    req('GET', `/api/borrower/draws/${appId}/report/status${drawId ? `?drawId=${drawId}` : ''}`),
  borrowerDrawReportBytes: (appId, drawId, onProgress) =>
    downloadProgress(`/api/borrower/draws/${appId}/report${drawId ? `?drawId=${drawId}` : ''}`, onProgress),
  staffTprPreview:  (appId) => req('GET', `/api/staff/applications/${appId}/export/tpr/preview`),
  staffTprExport:   (appId) => download(`/api/staff/applications/${appId}/export/tpr`),
  // MISMO 3.4 — the mortgage industry's shared file format. Export downloads the
  // file as MISMO XML; import parses (preview, no writes) then creates a new file.
  staffExportMismo:  (appId) => download(`/api/staff/applications/${appId}/export/mismo`),
  staffMismoPreview: (xml) => req('POST', '/api/staff/mismo/preview', { xml }),
  staffMismoCreate:  (xml) => req('POST', '/api/staff/mismo/create', { xml }),
  // Corrfirst Export — the borrower's VERIFIED track record on CorrFirst's own
  // CSV, ready to import on their side with no editing.
  staffCorrfirstTrackRecordPreview: (appId) => req('GET', `/api/staff/applications/${appId}/export/corrfirst-track-record/preview`),
  staffCorrfirstTrackRecordExport:  (appId) => download(`/api/staff/applications/${appId}/export/corrfirst-track-record`),
  // EMCAP's own pricing & eligibility workbook, filled with this loan's inputs so
  // THEIR formulas price it. Not a data tape — its own section of Send to investor.
  staffEmcapPricingToolPreview: (appId) => req('GET', `/api/staff/applications/${appId}/export/emcap-pricing-tool/preview`),
  staffEmcapPricingToolExport:  (appId) => download(`/api/staff/applications/${appId}/export/emcap-pricing-tool`),
  // Capital-provider data tapes. A loan can only export the tape of the provider
  // it is currently assigned to (staffTapesForApp says which, and why not).
  staffTapesList:    () => req('GET', '/api/staff/tapes'),
  staffTapesForApp:  (appId) => req('GET', `/api/staff/applications/${appId}/tapes`),
  // Extra questions a loan needs before its tape can fill (e.g. New-Construction
  // fields). Empty for most loans.
  staffTapeQuestions:(appId, tapeKey) => req('GET', `/api/staff/applications/${appId}/export/tape/${tapeKey}/questions`),
  staffTapeExport:   (appId, tapeKey, answers) => download(`/api/staff/applications/${appId}/export/tape/${tapeKey}${qs(answers)}`),
  // "Send to investor" — MANUAL email of the Excel tape (owner-directed 2026-08-18):
  // the compose preview (saved investor contacts, subject, figures, team Cc), then
  // the send itself (body carries recipients + note + any questionnaire answers).
  staffTapeSendPreview: (appId) => req('GET', `/api/staff/applications/${appId}/tape-send`),
  staffTapeSend:        (appId, tapeKey, body) => req('POST', `/api/staff/applications/${appId}/tape-send/${tapeKey}`, body || {}),
  staffTapeSendSchedule: (appId, tapeKey, body) => req('POST', `/api/staff/applications/${appId}/tape-send/${tapeKey}/schedule`, body || {}),
  staffTapeLoans:    (tapeKey) => req('GET', `/api/staff/tapes/${tapeKey}/loans`),
  /* SEARCH EVERY LOAN FOR A TAPE, not just the ones already assigned to its
     provider (owner-directed 2026-08-23). `q` takes a loan number, an address, a
     borrower name — or a pasted LIST of loan numbers, which is how a tape request
     actually arrives from an investor. `staffTapeSelected` re-checks a selection
     built across several searches, so the basket survives changing the query. */
  staffTapeSearch:   (tapeKey, q) => req('GET', `/api/staff/tapes/${tapeKey}/search${qs({ q })}`),
  staffTapeSelected: (tapeKey, applicationIds) => req('POST', `/api/staff/tapes/${tapeKey}/selected`, { applicationIds }),
  staffTapeBulkExport: (tapeKey, applicationIds, encompassOverrideReason) => downloadPost(`/api/staff/tapes/${tapeKey}/export/bulk${encompassOverrideReason ? qs({ encompassOverrideReason }) : ''}`, { applicationIds }),
  staffSaveRehabBudget: (appId, payload) => req('POST', `/api/staff/applications/${appId}/rehab-budget`, { payload }),
  // #152 — export the current pipeline VIEW (same filter params as staffApplications).
  staffExportPipeline: (params) => download(`/api/staff/applications/export${qs(params)}`),
  staffPricing:      (appId) => req('GET', `/api/staff/applications/${appId}/pricing`),
  // 1% closing-cost liquidity buffer waiver (owner-authorized 2026-07-31; admin).
  staffSetLiquidityBuffer: (appId, waived) => req('POST', `/api/staff/applications/${appId}/liquidity-buffer`, { waived: !!waived }),
  // Per-file program exception (owner-directed 2026-08-18): a SUPER ADMIN turns a
  // company-discontinued program back on for this one file (recorded + audited).
  staffProgramException: (appId, program, enabled, reason) => req('POST', `/api/staff/applications/${appId}/program-exception`, { program, enabled: !!enabled, reason }),
  // Per-officer business settings (owner-directed 2026-07-31) — self-scoped.
  mySettings:        () => req('GET', '/api/staff/my-settings'),
  saveMySettings:    (settings) => req('PUT', '/api/staff/my-settings', { settings }),
  staffPricingQuote: (appId, overrides) => req('POST', `/api/staff/applications/${appId}/pricing/quote`, { overrides }),
  staffRegisterProduct: (appId, program, overrides, econVersion, assetMonths, submitException, termOptions, encompassOverrideReason) => req('POST', `/api/staff/applications/${appId}/pricing/register`, { program, overrides, econVersion, assetMonths, submitException, termOptions, encompassOverrideReason }),
  // Redesign 2026-07-24: the pricing exception is a first-class register record —
  // the request now carries an optional structured reason + compensating factors.
  staffRequestException: (appId, note, reasonCode, compensatingFactors) => req('POST', `/api/staff/applications/${appId}/pricing/request-exception`, { note, reasonCode, compensatingFactors }),
  // Manual Program admin config + the super-admin escalation box.
  manualProgramSettings:     () => req('GET', '/api/admin/manual-programs/settings'),
  saveManualProgramSettings: (b) => req('PUT', '/api/admin/manual-programs/settings', b),
  // `q` searches the FILE — loan number, address, borrower — the same search the
  // exception register takes, so one typed string finds a file in either queue.
  manualEscalations:         (status, q) => req('GET', `/api/admin/manual-programs/escalations${qs({ status, q })}`),
  manualEscalationsCount:    () => req('GET', '/api/admin/manual-programs/escalations/count'),
  decideManualEscalation:    (id, decision, note) => req('POST', `/api/admin/manual-programs/escalations/${id}/decide`, { decision, note }),
  counterManualEscalation:   (id, counterTerms, counterNote) => req('POST', `/api/admin/manual-programs/escalations/${id}/counter`, { counterTerms, counterNote }),
  acceptCounterOffer:        (appId) => req('POST', `/api/staff/applications/${appId}/pricing/accept-counter`, {}),
  // Co-borrower guaranty-waiver exceptions (owner-directed 2026-07-22). File-scoped
  // request/withdraw/state (any staff) + the super-admin review box (decide = super-admin).
  fileExceptions:            (appId) => req('GET', `/api/staff/applications/${appId}/exceptions`),
  requestGuarantyWaiver:     (appId, body) => req('POST', `/api/staff/applications/${appId}/exceptions/guaranty-waiver`, body || {}),
  requestEsignBeforeCtc:     (appId, body) => req('POST', `/api/staff/applications/${appId}/exceptions/esign-before-ctc`, body || {}),
  // Ask a super admin to allow the data tape out before Encompass matches (owner-directed 2026-08-02).
  requestTapeException:      (appId, body) => req('POST', `/api/staff/applications/${appId}/exceptions/tape-encompass`, body || {}),
  // Ask an admin/super-admin to waive a specific condition (owner-directed 2026-08-04).
  requestConditionWaiver:    (appId, itemId, body) => req('POST', `/api/staff/applications/${appId}/conditions/${itemId}/request-waiver`, body || {}),
  withdrawException:         (appId, eid) => req('POST', `/api/staff/applications/${appId}/exceptions/${eid}/withdraw`, {}),
  // Every request to deviate, from every queue, as ONE list (owner-directed
  // 2026-08-26). Read-only: each queue still decides where its rules live.
  exceptionFeed:             (p) => req('GET', `/api/admin/exceptions/feed${qs(p || {})}`),
  loanExceptions:            (status, type, q) => req('GET', `/api/admin/exceptions${qs({ status, type, q })}`),
  loanExceptionsCount:       () => req('GET', '/api/admin/exceptions/count'),
  /* Investor Suite saved scenarios (owner-directed 2026-07-30) — a staffer's own
     named working states for the suite tools, so they can price a deal that is not
     a file yet and pick it up later. Private to the staffer; every route is keyed
     server-side on the actor, so there is no id to pass. `toolScenarios()` with no
     tool returns the whole list plus per-tool counts for the suite grid badges;
     the full state is fetched only when a scenario is actually opened. */
  toolScenarios:             (tool) => req('GET', `/api/staff/tool-scenarios${qs({ tool })}`),
  toolScenario:              (id) => req('GET', `/api/staff/tool-scenarios/${id}`),
  saveToolScenario:          (body) => req('POST', '/api/staff/tool-scenarios', body),
  renameToolScenario:        (id, body) => req('PUT', `/api/staff/tool-scenarios/${id}`, body),
  deleteToolScenario:        (id) => req('DELETE', `/api/staff/tool-scenarios/${id}`),
  // The register report (counts, approval rate, time-to-decision, aging) and the
  // diligence-ready xlsx export of the register (redesign 2026-07-24).
  loanExceptionMetrics:      () => req('GET', '/api/admin/exceptions/metrics'),
  // The export carries the SEARCH too — a spreadsheet that does not match the
  // screen you asked it from is worse than no spreadsheet.
  exportExceptionRegister:   async (status, type, q) => { const { blob, filename } = await download(`/api/admin/exceptions/export.xlsx${qs({ status, type, q })}`); saveBlob(blob, filename); },
  // decide: `waivedCodes` (esign_before_ctc approvals, 2026-07-24) names EXACTLY
  // which outstanding requirements the super-admin waives; omitted → legacy meaning.
  // `expiresAt` (redesign) sets an approval validity on expirable types.
  decideLoanException:       (id, decision, note, waivedCodes, expiresAt) => req('POST', `/api/admin/exceptions/${id}/decide`, { decision, note, ...(waivedCodes ? { waivedCodes } : {}), ...(expiresAt ? { expiresAt } : {}) }),
  clearLoanException:        (id, note) => req('POST', `/api/admin/exceptions/${id}/clear`, { note }),
  // The esign exception's clear view: live ✓/✗ requirements + request snapshot + waived codes.
  exceptionGate:             (id) => req('GET', `/api/admin/exceptions/${id}/gate`),
  exceptionComments:         (id) => req('GET', `/api/admin/exceptions/${id}/comments`),
  addExceptionComment:       (id, body) => req('POST', `/api/admin/exceptions/${id}/comments`, { body }),
  exceptionConditions:       (id) => req('GET', `/api/admin/exceptions/${id}/conditions`),
  // The loan officer's own cross-file exception queue.
  myExceptions:              (status) => req('GET', `/api/staff/my-exceptions${status ? `?status=${status}` : ''}`),
  myExceptionsCount:         () => req('GET', '/api/staff/my-exceptions/count'),
  runCommitteeReview:        (appId, findingId, all = false) => req('POST', `/api/underwriting/${appId}/findings/${findingId}/committee-review`, { all: !!all }),
  trainingProposals:         (status = 'pending') => req('GET', `/api/admin/training/proposals${status ? `?status=${status}` : ''}`),
  trainingProposalsRun:      () => req('POST', '/api/admin/training/run', {}),
  trainingProposalsDecide:   (id, decision, note) => req('POST', `/api/admin/training/proposals/${id}/decide`, { decision, note }),
  // Azure Custom labeling console (R3.3 — owner-directed 2026-07-22).
  labelingExamples:          () => req('GET', '/api/admin/labeling/examples'),
  labelingAddExample:        (b) => req('POST', '/api/admin/labeling/examples', normalizeUpload(b)),
  labelingDeleteExample:     (id) => req('DELETE', `/api/admin/labeling/examples/${id}`),
  labelingTrainingRuns:      () => req('GET', '/api/admin/labeling/training-runs'),
  labelingRequestTraining:   (b) => req('POST', '/api/admin/labeling/training-runs', b),
  fileCertificates:          (appId) => req('GET', `/api/underwriting/${appId}/certificate`),
  fileCertificateIssue:      (appId, milestone, reason) => req('POST', `/api/underwriting/${appId}/certificate/issue`, { milestone, reason: reason || undefined }),
  fileCertificateSurvey:     (appId) => req('POST', `/api/underwriting/${appId}/certificate/survey`, {}),
  fileStructuring:           (appId) => req('GET', `/api/underwriting/${appId}/structuring`),
  factHistory:               (appId, factKey) => req('GET', `/api/underwriting/${appId}/twin/fact/${encodeURIComponent(factKey)}`),
  confirmFact:               (appId, factKey, value, reason) => req('POST', `/api/underwriting/${appId}/twin/fact/${encodeURIComponent(factKey)}/confirm`, { value, reason: reason || undefined }),
  similarOpenFindings:       (appId, findingId) => req('GET', `/api/underwriting/${appId}/findings/${findingId}/similar-open`),
  // R5.17 — the grounded evidence behind one finding (exact OCR quote + page), fetched on demand.
  findingEvidence:           (appId, findingId) => req('GET', `/api/underwriting/${appId}/findings/${findingId}/evidence`),
  // Grounded back-and-forth reasoning chat: ask PILOT "why?" about a file; history is client-held.
  aiReason:                  (appId, question, history) => req('POST', `/api/underwriting/${appId}/reason`, { question, history: history || [] }),
  // "What to look for" — the note-buyer checklist for a document type (fetched on demand).
  documentReviewGuide:       (appId, docType) => req('GET', `/api/underwriting/${appId}/document-review-guide?docType=${encodeURIComponent(docType || '')}`),
  bulkResolveFindings:       (appId, findingIds, action, note) => req('POST', `/api/underwriting/${appId}/findings/similar/bulk-resolve`, { findingIds, action, note: note || undefined }),
  // Owner-directed 2026-08-02 — a bank statement under a different LLC: put that entity on the
  // borrower's profile (with its document slots), carry any operating agreement / articles / EIN
  // already on this file onto those slots, and post the entity-documents condition. The finding is
  // only settled when the operating agreement actually landed.
  adoptEntityToProfile:      (appId, entityName, findingId) => req('POST', `/api/underwriting/${appId}/entity-adopt`, { entityName, findingId: findingId || undefined }),
  fileAvmConsensus:          (appId) => req('GET', `/api/underwriting/${appId}/avm-consensus`),
  // #197 — whole-loan run cockpit (decision + run-diff + next-actions + findings digest).
  fileUnderwritingRun:       (appId) => req('GET', `/api/underwriting/${appId}/underwriting-run`),
  // #179 (R6.16) — plain-language "Why this decision?" explanation of the latest whole-loan run.
  fileUnderwritingWhy:       (appId) => req('GET', `/api/underwriting/${appId}/underwriting-run/why`),
  // #179 (R6.16) — download the latest whole-loan run findings as a CSV (auth'd fetch → browser save).
  fileUnderwritingFindingsCsv: async (appId) => { const { blob, filename } = await download(`/api/underwriting/${appId}/underwriting-run/findings.csv`); saveBlob(blob, filename); },
  // #136 (R5.39) — advisory guideline evaluation (per-rule verdicts + plain citations + investor-fit "A vs B").
  fileGuidelineEvaluation:   (appId) => req('GET', `/api/underwriting/${appId}/guideline-evaluation`),
  // ISG — Investor-Specific Soft Guidelines desk (per note-buyer condition verdicts + conflicts).
  fileInvestorGuidelines:    (appId) => req('GET', `/api/underwriting/${appId}/investor-guidelines`),
  // ISG AI satisfaction-quality check — asks the grounded GPT brain whether each SATISFIED
  // note-buyer condition's cleared evidence actually meets the investor's exact rule. On-demand
  // (staff clicks), env-gated + cost-capped, advisory only. Returns immediately; advisories land
  // in the AI suggestions panel on its next refresh.
  aiVerifyInvestorGuidelines: (appId) => req('POST', `/api/underwriting/${appId}/investor-guidelines/ai-verify`, {}),
  fileAvmConsensusVerify:    (appId) => req('POST', `/api/underwriting/${appId}/avm-consensus/verify`, {}),
  // AI Suggestions panel (R3.5/R3.6 — owner-directed 2026-07-22).
  aiSuggestionsList:      (appId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req('GET', `/api/underwriting/${appId}/ai-suggestions${qs ? '?' + qs : ''}`);
  },
  aiSuggestionsDecide:    (appId, id, decision) => req('POST', `/api/underwriting/${appId}/ai-suggestions/${id}/decide`, decision),
  aiSuggestionAddNote:    (appId, id, text) => req('POST', `/api/underwriting/${appId}/ai-suggestions/${id}/note`, { text }),
  aiAdminQuestions:       (appId) => req('GET', `/api/underwriting/ai-admin/questions${appId ? `?appId=${appId}` : ''}`),
  aiAdminAnswer:          (questionId, answer) => req('POST', `/api/underwriting/ai-admin/questions/${questionId}/answer`, { answer }),
  aiCostForFile:          (appId) => req('GET', `/api/underwriting/${appId}/ai-cost`),
  aiRiskScore:            (appId) => req('GET', `/api/underwriting/${appId}/ai-risk-score`),
  similarLoans:           (appId) => req('GET', `/api/underwriting/${appId}/similar-loans`),
  aiDismissAllOnFile:     (appId, reason) => req('POST', `/api/underwriting/${appId}/ai-suggestions/dismiss-all`, { reason }),
  aiRerunChecks:          (appId) => req('POST', `/api/underwriting/${appId}/ai-suggestions/rerun-checks`, {}),
  askAdminAboutFile:      (appId, question) => req('POST', `/api/underwriting/${appId}/ask-admin`, { question }),
  aiCrossDocCheck:        (appId) => req('POST', `/api/underwriting/${appId}/ai-crossdoc`, {}),
  fraudBannerSnooze:      (appId, hours = 24, note) => req('POST', `/api/underwriting/${appId}/fraud-banner/snooze`, { hours, note }),
  fileKnowledgeGraph:     (appId) => req('GET', `/api/underwriting/${appId}/knowledge-graph`),
  insightsDashboard:      () => req('GET', '/api/admin/insights'),
  insightsAiCostTrend:    () => req('GET', '/api/admin/insights/ai-cost-trend'),
  insightsAiStack:        () => req('GET', '/api/admin/insights/ai-stack'),
  aiSilencedCodesList:    () => req('GET', '/api/admin/insights/silenced-codes'),
  aiSilencedCodesAdd:     (code, reason) => req('POST', '/api/admin/insights/silenced-codes', { code, reason }),
  aiSilencedCodesRemove:  (code) => req('DELETE', `/api/admin/insights/silenced-codes/${encodeURIComponent(code)}`),
  aiSilencedCodesHistory: () => req('GET', '/api/admin/insights/silenced-codes/history'),

  // Pipeline V2 (shadow) — vendor health + the staff-only shadow comparison (V2 vs V1).
  pipelineHealth:      () => req('GET', '/api/admin/pipeline/health'),
  pipelineShadow:      (loanId) => req('GET', '/api/admin/pipeline/shadow' + (loanId ? `?loanId=${encodeURIComponent(loanId)}` : '')),
  pipelineShadowJob:   (jobId) => req('GET', `/api/admin/pipeline/shadow/${encodeURIComponent(jobId)}`),
  insightsFilesWithSuggestion: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req('GET', `/api/admin/insights/files-with-suggestion${qs ? '?' + qs : ''}`);
  },
  staffUploadAppDoc: (appId, b) => coalesceUpload('appDoc:' + appId, b, () => (b && b.file
    ? uploadBinary(`/api/staff/applications/${appId}/documents/binary`, b)
    : trackJsonUpload(b, () => req('POST', `/api/staff/applications/${appId}/documents`, normalizeUpload(b))))),
  staffAddLoanCondition: (appId, b) => req('POST', `/api/staff/applications/${appId}/loan-conditions`, b),
  // `override` (optional) = { adminOverride:true, overrideReason } from
  // lib/condition-override.askOverride — a super-admin clearing/waiving a
  // condition without meeting its requirement. The server refuses it for anyone
  // else and requires the reason; omitting it is an ordinary clear/waive.
  staffClearCondition:   (cid, override) => req('POST', `/api/staff/loan-conditions/${cid}/clear`, override || undefined),
  staffWaiveCondition:   (cid, reason, override) => req('POST', `/api/staff/loan-conditions/${cid}/waive`, { reason, ...(override || {}) }),
  staffReviewCondition:  (cid, reviewed) => req('POST', `/api/staff/loan-conditions/${cid}/review`, { reviewed }),
  // Borrower change-request sandbox (S5-03) — staff review side.
  staffChangeRequests:       (appId) => req('GET', `/api/staff/applications/${appId}/change-requests`),
  staffApproveChangeRequest: (cid, note) => req('POST', `/api/staff/change-requests/${cid}/approve`, { note }),
  staffRejectChangeRequest:  (cid, note) => req('POST', `/api/staff/change-requests/${cid}/reject`, { note }),
  staffAssign:      (appId, b) => req('POST', `/api/staff/applications/${appId}/assign`, b),
  // Multi-assignee team (#64): the full team + add/remove full-access assistants.
  staffAssignees:      (appId) => req('GET', `/api/staff/applications/${appId}/assignees`),
  staffAddAssignee:    (appId, staffId, role, primary) => req('POST', `/api/staff/applications/${appId}/assignees`, { staffId, role, primary: !!primary }),
  staffRemoveAssignee: (appId, staffId, role) => req('DELETE', `/api/staff/applications/${appId}/assignees/${staffId}${role ? `?role=${role}` : ''}`),
  staffSetStatus:   (appId, status, force) => req('PATCH', `/api/staff/applications/${appId}`, force ? { status, force: true } : { status }),
  // Internal (ClickUp) status — the exact 38-status task workflow. The list feeds
  // the picker; setting it re-derives the borrower-facing status and pushes to ClickUp.
  staffInternalStatuses: () => req('GET', '/api/staff/clickup/internal-statuses'),
  staffSetInternalStatus: (id, internalStatus) => req('POST', '/api/staff/applications/' + id + '/internal-status', { internalStatus }),
  staffGating:      (appId) => req('GET', `/api/staff/applications/${appId}/gating`),
  // The Workflow (owner-directed 2026-07-21) — submission hand-offs + personal queues.
  workflowOptions:   (appId) => req('GET', `/api/staff/applications/${appId}/workflow/options`),
  workflowTimeline:  (appId) => req('GET', `/api/staff/applications/${appId}/workflow/timeline`),
  workflowSubmit:    (appId, b) => req('POST', `/api/staff/applications/${appId}/workflow/submit`, b),
  workflowQueue:     (params) => req('GET', `/api/staff/workflow${params ? '?' + new URLSearchParams(params).toString() : ''}`),
  workflowRoster:    () => req('GET', '/api/staff/workflow/roster'),
  workflowCount:     () => req('GET', '/api/staff/workflow/count'),
  workflowPickup:    (itemId) => req('POST', `/api/staff/workflow/${itemId}/pickup`),
  workflowReturn:    (itemId, outcomeLabel, note) => req('POST', `/api/staff/workflow/${itemId}/return`, { outcomeLabel, note }),
  // Remove a hand-off from the workflow queue (restorable — owner-directed
  // 2026-08-18: remove/restore lives on the WORKFLOWS, not the pipeline).
  workflowRemoveItem:  (itemId, reason) => req('POST', `/api/staff/workflow/${itemId}/remove`, { reason: reason || null }),
  workflowRestoreItem: (itemId) => req('POST', `/api/staff/workflow/${itemId}/restore`, {}),
  closingWorkflow:   (appId) => req('GET', `/api/staff/applications/${appId}/closing-workflow`),
  advanceClosing:    (appId, stage) => req('POST', `/api/staff/applications/${appId}/closing-workflow`, { stage }),
  // The closing workspace (the closer's desk).
  closingWorkspace:  (appId) => req('GET', `/api/staff/applications/${appId}/closing`),
  // Property is free and clear — waives/reopens both payoff conditions (db/575).
  payoffFreeAndClear: (appId, on) => req('POST', `/api/staff/applications/${appId}/payoff/free-and-clear`, { on, confirm: true }),
  // The rate-&-term $2,000 cash limit + the itemized closing costs (db/577).
  rateTermGate:        (appId) => req('GET', `/api/staff/applications/${appId}/rate-term-gate`),
  closingCostAdd:      (appId, item) => req('POST', `/api/staff/applications/${appId}/closing-costs`, item),
  closingCostDelete:   (appId, costId) => req('DELETE', `/api/staff/applications/${appId}/closing-costs/${costId}`),
  rateTermException:   (appId, body) => req('POST', `/api/staff/applications/${appId}/rate-term-gate/request-exception`, body),
  // The verified-assets ledger + max cash to close (db/574).
  assetLedger:       (appId) => req('GET', `/api/staff/applications/${appId}/asset-ledger`),
  assetLedgerSave:   (appId, entry) => req('POST', `/api/staff/applications/${appId}/asset-ledger/entries`, entry),
  assetLedgerDelete: (appId, entryId) => req('DELETE', `/api/staff/applications/${appId}/asset-ledger/entries/${entryId}`),
  // Read-only Encompass re-pull, then hand back the fresh workspace — so a funded
  // date the closer just entered in Encompass shows up on the reconciliation.
  closingReconcileRefresh: (appId) => req('POST', `/api/staff/applications/${appId}/closing/reconcile-refresh`),
  // Read-only ClickUp re-pull (re-ingests the file's card), then hand back the fresh workspace — so
  // a funded date the team just set in ClickUp shows up on the reconciliation.
  closingReclickupRefresh: (appId) => req('POST', `/api/staff/applications/${appId}/closing/reclickup-refresh`),
  closingUpdate:     (appId, b) => req('PATCH', `/api/staff/applications/${appId}/closing`, b),
  closingAddNote:    (appId, body) => req('POST', `/api/staff/applications/${appId}/closing/notes`, { body }),
  closingCashToClose:(appId, actualCashToClose, docId) => req('POST', `/api/staff/applications/${appId}/closing/cash-to-close`, { actualCashToClose, docId }),
  closingSignOff:    (appId, kind, on) => req('POST', `/api/staff/applications/${appId}/closing/sign-off`, { kind, on }),
  closingChecklistTemplates: (appId) => req('GET', `/api/staff/applications/${appId}/closing/checklist-templates`),
  closingCreateChecklist: (appId, b) => req('POST', `/api/staff/applications/${appId}/closing/checklists`, b),
  closingAddChecklistItem: (appId, cid, label) => req('POST', `/api/staff/applications/${appId}/closing/checklists/${cid}/items`, { label }),
  closingToggleChecklistItem: (appId, iid, checked) => req('PATCH', `/api/staff/applications/${appId}/closing/checklist-items/${iid}`, { checked }),
  closingQueue:      (params) => req('GET', `/api/staff/closing${params ? '?' + new URLSearchParams(params).toString() : ''}`),
  closingCount:      () => req('GET', '/api/staff/closing/count'),
  // The purchasing desk — where a file lands after investor delivery (unless it
  // was table funded, i.e. sold right at closing).
  purchasingQueue:   (params) => req('GET', `/api/staff/purchasing${params ? '?' + new URLSearchParams(params).toString() : ''}`),
  purchasingCount:   () => req('GET', '/api/staff/purchasing/count'),
  purchasingGet:     (appId) => req('GET', `/api/staff/applications/${appId}/purchasing`),
  purchasingStatus:  (appId, status) => req('POST', `/api/staff/applications/${appId}/purchasing/status`, { status }),
  purchasingAddNote: (appId, body) => req('POST', `/api/staff/applications/${appId}/purchasing/notes`, { body }),
  purchasingAddTask: (appId, label) => req('POST', `/api/staff/applications/${appId}/purchasing/tasks`, { label }),
  purchasingTaskDone: (appId, taskId, done) => req('PATCH', `/api/staff/applications/${appId}/purchasing/tasks/${taskId}`, { done }),
  purchasingTaskDelete: (appId, taskId) => req('DELETE', `/api/staff/applications/${appId}/purchasing/tasks/${taskId}`),
  purchasingAddCondition:  (appId, label, detail) => req('POST', `/api/staff/applications/${appId}/purchasing/conditions`, { label, detail }),
  purchasingConditionStatus: (appId, cid, status, note) => req('PATCH', `/api/staff/applications/${appId}/purchasing/conditions/${cid}`, { status, note }),
  purchasingConditionDelete: (appId, cid) => req('DELETE', `/api/staff/applications/${appId}/purchasing/conditions/${cid}`),
  purchasingAdvice:        (appId, patch) => req('POST', `/api/staff/applications/${appId}/purchasing/advice`, patch),
  // Uploads the advice STAFF-ONLY from the outset — there is no borrower-visible
  // window to designate away, which is the root cause the designation-time
  // forcing could only mitigate.
  purchasingAdviceUpload:  (appId, file) => req('POST', `/api/staff/applications/${appId}/documents`,
    normalizeUpload({ ...file, staffOnly: true, slot: 'Purchase advice' })),
  staffStatusHistory: (appId) => req('GET', `/api/staff/applications/${appId}/status-history`),
  staffSetClosingDate: (appId, b) => req('POST', `/api/staff/applications/${appId}/closing-date`, b),
  staffEditApplication: (appId, b) => req('PATCH', `/api/staff/applications/${appId}/details`, b),
  staffSetStructuralLock: (appId, unlocked, reason) => req('POST', `/api/staff/applications/${appId}/structural-lock`, { unlocked, reason }),
  staffNudge:          (appId) => req('POST', `/api/staff/applications/${appId}/nudge`),
  // Reminders + task management (#93). staffReminders returns { reminders,
  // contacts, outstanding } so the composer is populated in one round-trip.
  staffReminders:      (appId) => req('GET', `/api/staff/applications/${appId}/reminders`),
  // The cross-file scheduled-tasks queue (task management, 2026-08-18).
  // A-piece / B-piece split (internal-only, manual program).
  staffAbPiece:        (appId) => req('GET', `/api/staff/applications/${appId}/ab-piece`),
  staffAbPieceSave:    (appId, b) => req('POST', `/api/staff/applications/${appId}/ab-piece`, b),
  staffReminderTasks:  (q) => req('GET', `/api/staff/reminder-tasks${q ? `?${new URLSearchParams(q)}` : ''}`),
  staffReminderTaskCounts: () => req('GET', `/api/staff/reminder-tasks?count=1`),
  staffReminderTasksBulk: (b) => req('POST', `/api/staff/reminder-tasks/bulk`, b),
  // The queue's own Done/Dismiss door — reaches a task ASSIGNED to you even on a
  // file outside your scope (the per-file PATCH below sits behind the file-scope
  // middleware and 403s there).
  staffReminderTaskUpdate: (rid, b) => req('PATCH', `/api/staff/reminder-tasks/${rid}`, b),
  // The Drafting desk (2026-08-18): AI drafts an email from the file, copy-paste only.
  staffDraftEmail:     (appId, b) => req('POST', `/api/staff/applications/${appId}/drafting`, b || {}),
  // PILOT AI writing assistant (2026-08-18): advisory text-in/text-out. The
  // surface picks the door — an external user's requests ride the borrower-safe
  // scrub server-side.
  pilotWriter: (surface, body) => req('POST',
    surface === 'borrower' ? '/api/borrower/pilot-writer'
      : surface === 'tpo' ? '/api/tpo/pilot-writer' : '/api/staff/pilot-writer', body || {}),
  staffCreateReminder: (appId, b) => req('POST', `/api/staff/applications/${appId}/reminders`, b),
  staffUpdateReminder: (appId, rid, b) => req('PATCH', `/api/staff/applications/${appId}/reminders/${rid}`, b),
  staffDeleteReminder: (appId, rid) => req('DELETE', `/api/staff/applications/${appId}/reminders/${rid}`),
  // Archive = reversible soft-remove (leaves the Archived folder); Purge =
  // permanent hard delete (row + children + stored bytes, gone from all figures).
  staffArchiveApp:  (appId, reason) => req('POST', `/api/staff/applications/${appId}/archive`, { reason }),
  staffRestoreApp:  (appId) => req('POST', `/api/staff/applications/${appId}/restore`),
  staffPurgeApp:    (appId, reason) => req('DELETE', `/api/staff/applications/${appId}`, { reason }),
  staffArchivedApps:() => req('GET', '/api/staff/archived-applications'),
  staffNotifs:      () => req('GET', '/api/staff/notifications'),
  // The leads desk. `params` are the SERVER-SIDE filters on where a lead came
  // from — {source} (which system opened it: elementix / marketing_site /
  // manual / portal_invite), {tool} (which public form) and {leadSource} (the
  // channel typed on a hand-entered lead) — plus {counts:1}, which asks for the
  // per-origin totals beside the rows. WITHOUT counts the answer is the bare
  // array it has always been; WITH it the answer is {rows, facets}. Filtering
  // has to happen there and not here: the list is capped at 500 rows, so a
  // browser-side filter would count a page, not a desk.
  //
  // {officerId} narrows it to ONE officer's book — what the admin CRM desk
  // (/internal/crm) mounts the leads screen with. It is ANDed onto the same
  // visibility scope every other caller gets, so it can only ever SHRINK what
  // the person asking could already see: a loan officer who sends somebody
  // else's id gets an empty list, never their desk.
  staffLeads:       (params) => req('GET', '/api/staff/leads' + qs(params)),
  // The follow-up review desk (owner-directed 2026-08-28): the officer's whole book
  // split into piles by next follow-up date, counted on the SERVER over the whole
  // scope — never over the 500-row page `staffLeads` returns.
  staffLeadFollowUps: (params) => req('GET', '/api/staff/leads/follow-ups' + qs(params)),
  // The Excel export of the lead desk (owner-directed 2026-08-28) — the caller's
  // current filters ride along, so what downloads is what the screen shows.
  staffLeadsExport:   async (params) => { const { blob, filename } = await download(`/api/staff/leads/export${qs(params)}`); saveBlob(blob, filename); },
  staffLeadsBulkArchive: (filters) => req('POST', '/api/staff/leads/bulk-archive', filters),
  staffCreateLead:  (b) => req('POST', '/api/staff/leads', b),
  staffLead:        (id) => req('GET', `/api/staff/leads/${id}`),
  staffUpdateLead:  (id, b) => req('PATCH', `/api/staff/leads/${id}`, b),
  staffLeadNotes:   (id) => req('GET', `/api/staff/leads/${id}/notes`),
  staffAddLeadNote: (id, body) => req('POST', `/api/staff/leads/${id}/notes`, { body }),
  // Full CRM: activity timeline, tasks, attachments, convert.
  staffLeadActivities: (id) => req('GET', `/api/staff/leads/${id}/activities`),
  staffAddLeadActivity:(id, b) => req('POST', `/api/staff/leads/${id}/activities`, b),
  staffLeadTasks:   (id) => req('GET', `/api/staff/leads/${id}/tasks`),
  staffAddLeadTask: (id, b) => req('POST', `/api/staff/leads/${id}/tasks`, b),
  staffUpdateLeadTask: (id, taskId, b) => req('PATCH', `/api/staff/leads/${id}/tasks/${taskId}`, b),
  staffLeadDocuments:(id) => req('GET', `/api/staff/leads/${id}/documents`),
  staffAddLeadDocument:(id, b) => (b && b.file
    ? uploadBinary(`/api/staff/leads/${id}/documents/binary`, b)
    : trackJsonUpload(b, () => req('POST', `/api/staff/leads/${id}/documents`, b))),
  // Authed download — a plain <a href> can't send the Bearer token, so fetch
  // the bytes and hand them to saveBlob (matches every other doc download).
  staffDownloadLeadDoc:(id, docId) => download(`/api/staff/leads/${id}/documents/${docId}`),
  staffConvertLead: (id, b) => req('POST', `/api/staff/leads/${id}/convert`, b),
  staffDashboard:   (params) => req('GET', '/api/staff/dashboard' + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '')),
  staffChatInbox:   () => req('GET', '/api/staff/chat/inbox'),
  staffReact:       (msgId, emoji) => req('POST', `/api/staff/messages/${msgId}/react`, { emoji }),
  staffPinMessage:  (msgId) => req('POST', `/api/staff/messages/${msgId}/pin`),
  staffEditMessage: (msgId, body) => req('PATCH', `/api/staff/messages/${msgId}`, { body }),
  staffDeleteMessage:(msgId) => req('DELETE', `/api/staff/messages/${msgId}`),
  staffMentionables:(appId) => req('GET', `/api/staff/applications/${appId}/mentionables`),
  // System-wide audit log (#145) — the company-wide compliance trail.
  auditLog:         (params) => req('GET', '/api/staff/audit-log' + qs(params)),
  auditLogFacets:   () => req('GET', '/api/staff/audit-log/facets'),
  adminWelcome:     (id) => req('POST', `/api/admin/staff/${id}/welcome`),
  adminResetStaffEmail: (id) => req('POST', `/api/admin/staff/${id}/reset-email`),
  adminWelcomeAll:  (all) => req('POST', '/api/admin/staff/welcome-all', { onlyWithoutLogin: !all }),
  chatInbox:        () => req('GET', '/api/borrower/chat/inbox'),
  staffMessages:    (appId, channel = 'borrower') => req('GET', `/api/staff/applications/${appId}/messages?channel=${channel}`),
  staffPostMessage: (appId, body, opts = {}) => req('POST', `/api/staff/applications/${appId}/messages`, { body, ...opts }),
  adminIntegrations:() => req('GET', '/api/admin/integrations'),

  // ---- ClickUp Control Center (admin / platform_setup) ----
  // API Health — status of every external API / integration.
  integrationsHealth: () => req('GET', '/api/admin/integrations/health'),
  // The Google-coordinate licensing rule, in full. /api/health carries only the
  // verdict (it is public); the explanation lives behind this one.
  researchLicensing: () => req('GET', '/api/admin/research-licensing'),
  integrationTest:    (key) => req('POST', `/api/admin/integrations/${encodeURIComponent(key)}/test`),
  // Read-only Sitewire TEST-environment capability explorer (super_admin). Lists every field/button
  // Sitewire exposes so new integrations use confirmed names. Uses SITEWIRE_TEST_* creds; never writes.
  sitewireExplore:    (opts) => req('POST', '/api/admin/integrations/sitewire/explore', opts || {}),
  // SharePoint document-mirror scoreboard + controls (admin / platform_setup).
  // Reconciliation = total docs vs mirrored vs waiting vs stuck; the two POSTs
  // force a full backfill sweep and re-drive every "given up" (parked) document.
  sharepointReconciliation: () => req('GET', '/api/admin/sharepoint/reconciliation'),
  sharepointRunSweep:  () => req('POST', '/api/admin/sharepoint/mirror', {}),
  sharepointRetryStuck: () => req('POST', '/api/admin/sharepoint/retry-exhausted', {}),
  // Elementix (recorded deeds / mortgages). The connection is approved ONCE in a
  // browser and then renews itself. `elementixConnect` returns the sign-in URL as
  // JSON rather than a redirect ON PURPOSE — a 302 inside fetch() is followed
  // invisibly, and this hand-off has to happen in the address bar so the person
  // actually sees Elementix's own sign-in page.
  elementixStatus:     () => req('GET', '/api/admin/elementix/status'),
  elementixDiscover:   () => req('GET', '/api/admin/elementix/discover'),
  elementixConnect:    () => req('GET', '/api/admin/elementix/connect'),
  elementixDisconnect: () => req('POST', '/api/admin/elementix/disconnect', {}),
  integrationSwitches: () => req('GET', '/api/admin/integrations/switches'),
  integrationToggleSwitch: (key, enabled, confirm) => req('POST', `/api/admin/integrations/switches/${encodeURIComponent(key)}`, { enabled, confirm }),
  integrationResetSwitch:  (key) => req('POST', `/api/admin/integrations/switches/${encodeURIComponent(key)}/reset`),
  clickupHealth:    () => req('GET', '/api/admin/clickup/health'),
  clickupActivity:  () => req('GET', '/api/admin/clickup/activity'),
  clickupBackfill:  (mode, sample) => req('POST', '/api/admin/clickup/backfill', { mode, sample }),
  // Field-by-field: what PILOT holds vs what the card holds. Read-only, file-scoped.
  clickupCompare:   (appId) => req('GET', `/api/staff/applications/${appId}/clickup/compare`),
  clickupRepush:    (appId) => req('POST', `/api/admin/clickup/file/${appId}/repush`),
  clickupRepull:    (appId) => req('POST', `/api/admin/clickup/file/${appId}/repull`),
  clickupSyncFolder:(folderId, createFiles) => req('POST', '/api/admin/clickup/sync-folder', { folderId, createFiles }),
  // The borrower-profile sweep — reads every ClickUp card in every status to
  // build PEOPLE (profile, entities, track record, officer link), never files.
  clickupProfileSweep:      () => req('GET', '/api/admin/clickup/profile-sweep'),
  clickupStartProfileSweep: (opts) => req('POST', '/api/admin/clickup/profile-sweep', opts || {}),
  clickupAudit:     () => req('GET', '/api/admin/clickup/audit'),
  clickupManualReview:        () => req('GET', '/api/admin/clickup/manual-review'),
  clickupResolveManualReview: (appId, action) => req('POST', `/api/admin/clickup/manual-review/${appId}/resolve`, { action }),
  // self-serve: pull my own ClickUp pipeline folder into the portal
  staffSyncMyClickup: () => req('POST', '/api/staff/clickup/sync-mine'),

  // ---- ADMIN manual ClickUp link / unlink (admin/super_admin only; server
  // enforces requireRole('admin')) ----
  clickupRelinkPreview: (appId, taskId) => req('GET', `/api/staff/applications/${appId}/clickup/relink-preview?taskId=${encodeURIComponent(taskId)}`),
  clickupUnlink:        (appId) => req('POST', `/api/staff/applications/${appId}/clickup/unlink`),
  clickupRelink:        (appId, taskId, confirmMove) => req('POST', `/api/staff/applications/${appId}/clickup/relink`, { taskId, confirmMove: !!confirmMove }),

  // ---- chat v3: conversations (staff) ----
  staffConversations:      () => req('GET', '/api/staff/chat/conversations'),
  staffConversation:       (cid) => req('GET', `/api/staff/conversations/${cid}`),
  staffConvMessages:       (cid, before) => req('GET', `/api/staff/conversations/${cid}/messages${before ? `?before=${before}` : ''}`),
  staffConvSend:           (cid, b) => req('POST', `/api/staff/conversations/${cid}/messages`, b),
  staffConvRead:           (cid, seq) => req('POST', `/api/staff/conversations/${cid}/read`, { seq }),
  staffConvMarkUnread:     (cid, seq) => req('POST', `/api/staff/conversations/${cid}/unread`, { seq }),
  staffConvDelivered:      (cid, seq) => req('POST', `/api/staff/conversations/${cid}/delivered`, { seq }),
  staffConvTyping:         (cid, connId) => req('POST', `/api/staff/conversations/${cid}/typing`, { connId }),
  staffConvOpen:           (cid, connId) => req('POST', `/api/staff/conversations/${cid}/open`, { connId }),
  staffConvMute:           (cid, b) => req('POST', `/api/staff/conversations/${cid}/mute`, b),
  staffConvDraft:          (cid, body) => req('PUT', `/api/staff/conversations/${cid}/draft`, { body }),
  staffConvShared:         (cid) => req('GET', `/api/staff/conversations/${cid}/shared`),
  staffCreateConversation: (appId, b) => req('POST', `/api/staff/applications/${appId}/conversations`, b),
  staffUpdateConversation: (cid, b) => req('PATCH', `/api/staff/conversations/${cid}`, b),
  staffConvAddMember:      (cid, staffId) => req('POST', `/api/staff/conversations/${cid}/members`, { staffId }),
  staffConvRemoveMember:   (cid, staffId) => req('DELETE', `/api/staff/conversations/${cid}/members/${staffId}`),
  // #75 external EMAIL guests (partner/secretary): add by email, remove by id.
  staffConvAddExternal:    (cid, b) => req('POST', `/api/staff/conversations/${cid}/external`, b),
  staffConvRemoveExternal: (cid, id) => req('DELETE', `/api/staff/conversations/${cid}/external/${id}`),
  staffChatSearch:         (q, cid) => req('GET', `/api/staff/chat/search?q=${encodeURIComponent(q)}${cid ? `&conversationId=${cid}` : ''}`),
  staffSetChatStatus:      (b) => req('PUT', '/api/staff/chat/status', b),
  staffClearChatStatus:    () => req('DELETE', '/api/staff/chat/status'),
  staffChatExport:         (appId) => download(`/api/staff/applications/${appId}/chat-export`),

  // ---- chat v3: conversations (borrower) ----
  conversations:      (appId) => req('GET', `/api/borrower/conversations${appId ? `?applicationId=${appId}` : ''}`),
  conversation:       (cid) => req('GET', `/api/borrower/conversations/${cid}`),
  convMessages:       (cid, before) => req('GET', `/api/borrower/conversations/${cid}/messages${before ? `?before=${before}` : ''}`),
  convSend:           (cid, b) => req('POST', `/api/borrower/conversations/${cid}/messages`, b),
  convRead:           (cid, seq) => req('POST', `/api/borrower/conversations/${cid}/read`, { seq }),
  convMarkUnread:     (cid, seq) => req('POST', `/api/borrower/conversations/${cid}/unread`, { seq }),
  convDelivered:      (cid, seq) => req('POST', `/api/borrower/conversations/${cid}/delivered`, { seq }),
  convTyping:         (cid, connId) => req('POST', `/api/borrower/conversations/${cid}/typing`, { connId }),
  convOpen:           (cid, connId) => req('POST', `/api/borrower/conversations/${cid}/open`, { connId }),
  convDraft:          (cid, body) => req('PUT', `/api/borrower/conversations/${cid}/draft`, { body }),
  convShared:         (cid) => req('GET', `/api/borrower/conversations/${cid}/shared`),

  // vendor directory (admin) + appraisal payment card
  staffVendors:      (type) => req('GET', `/api/staff/vendors${type ? `?type=${type}` : ''}`),
  staffAddVendor:    (b) => req('POST', '/api/staff/vendors', b),
  staffUpdateVendor: (id, b) => req('PATCH', `/api/staff/vendors/${id}`, b),
  staffDeleteVendor: (id) => req('DELETE', `/api/staff/vendors/${id}`),
  // Manual vendor merge (owner-directed 2026-07-21). Body: { survivorId, mergedId,
  // picks:{...}, emails:[...], phones:[...] }.
  staffMergeVendors: (body) => req('POST', '/api/staff/vendors/merge', body),
  // general file contacts (#144) — staff side + a borrower's whole vendor list
  staffFileContacts:   (appId) => req('GET', `/api/staff/applications/${appId}/file-contacts`),
  // The general contractor's record (db/605) — the file contact PLUS the license and
  // insurance that only mean something for a contractor.
  staffGcRecord:       (appId) => req('GET', `/api/staff/applications/${appId}/gc-record`),
  staffGcRecordSave:   (appId, body) => req('PUT', `/api/staff/applications/${appId}/gc-record`, body),
  /* THE VENDOR TYPE-AHEAD (owner-directed 2026-08-20). Scoped to a FILE, because
     that is also the permission — anybody who may edit this file's contacts may
     look one up. A blank `q` is a real ask: it means "show me the ones already
     used", which is the prefill half of the request. */
  staffVendorSuggest:  (appId, type, q) => req('GET', `/api/staff/applications/${appId}/vendor-suggest?type=${encodeURIComponent(type || '')}&q=${encodeURIComponent(q || '')}`),
  staffAddFileContact: (appId, b) => req('POST', `/api/staff/applications/${appId}/file-contacts`, b),
  staffEditFileContact:(linkId, b) => req('PATCH', `/api/staff/file-contacts/${linkId}`, b),
  staffDelFileContact: (linkId) => req('DELETE', `/api/staff/file-contacts/${linkId}`),
  staffBorrowerContacts: (borrowerId) => req('GET', `/api/staff/borrowers/${borrowerId}/contacts`),
  // Duplicate borrower profiles: find, compare side by side, merge into one
  // (owner-directed 2026-07-26). `choices` names the winning side for every field
  // the two disagree on — the server REFUSES (409) a merge with any left undecided.
  staffBorrowerDuplicates: (id) => req('GET', `/api/staff/borrowers/${id}/duplicates`),
  staffBorrowerCompare:    (id, otherId) => req('GET', `/api/staff/borrowers/${id}/compare/${otherId}`),
  staffBorrowerMerge:      (id, body) => req('POST', `/api/staff/borrowers/${id}/merge`, body),
  staffBorrowerMerges:     (id) => req('GET', `/api/staff/borrowers/${id}/merges`),
  staffAppraisalCard:(appId) => req('GET', `/api/staff/applications/${appId}/appraisal-card`),
  // Appraisal "no XML available" waiver.
  appraisalXmlWaiverGet:    (appId) => req('GET', `/api/staff/applications/${appId}/appraisal-xml-waiver`),
  appraisalXmlWaiverSet:    (appId, body) => req('POST', `/api/staff/applications/${appId}/appraisal-xml-waiver`, body),
  appraisalXmlWaiverRemove: (appId) => req('DELETE', `/api/staff/applications/${appId}/appraisal-xml-waiver`),
  staffSaveAppraisalCard:(appId, b) => req('POST', `/api/staff/applications/${appId}/appraisal-card`, b),
  // Permanently deletes the card off the file — there is no undo (the UI double-confirms).
  staffClearAppraisalCard:(appId) => req('DELETE', `/api/staff/applications/${appId}/appraisal-card`),

  // ---- How an appraisal is being paid for (owner-directed 2026-08-16) ----------
  // Payment is MANUAL. These record which of the three ways a person chose, on the
  // two companies PILOT cannot charge (AppraisalScope, Class Valuation). Richer
  // Values genuinely takes the payment and keeps its own `rvPay` above — the
  // choose route refuses it on purpose, so an instruction can never say "somebody
  // will do this by hand" about an order the vendor already charged.
  staffAppraisalPayment:       (appId) => req('GET', `/api/staff/applications/${appId}/appraisal-payment`),
  staffChooseAppraisalPayment: (appId, b) => req('POST', `/api/staff/applications/${appId}/appraisal-payment`, b),
  staffSettleAppraisalPayment: (appId, b) => req('POST', `/api/staff/applications/${appId}/appraisal-payment/settle`, b),

  // ---- Appraisal desk: import the appraisal XML, read the property profile, resolve findings ----
  appraisalGet:            (appId) => req('GET', `/api/appraisal/${appId}`),
  appraisalImport:         (appId, b) => req('POST', `/api/appraisal/${appId}/import`, b),
  appraisalUndoImport:     (appId) => req('POST', `/api/appraisal/${appId}/undo-import`),
  appraisalResolveFinding: (appId, fid, b) => req('POST', `/api/appraisal/${appId}/findings/${fid}/resolve`, b),
  appraisalRefreshPhotos:  (appId) => req('POST', `/api/appraisal/${appId}/photos/refresh`, {}),
  // The As-Is value PILOT read off the appraisal, and the officer's own entry (2026-07-28).
  appraisalAsIs:           (appId) => req('GET', `/api/appraisal/${appId}/as-is`),
  appraisalSetAsIs:        (appId, b) => req('POST', `/api/appraisal/${appId}/as-is`, b),
  appraisalSetArv:         (appId, b) => req('POST', `/api/appraisal/${appId}/arv`, b),
  appraisalRereadAsIs:     (appId) => req('POST', `/api/appraisal/${appId}/as-is/read`, {}),
  // Borrower READ-ONLY view of the same appraisal report + findings (no actions).
  appraisalGetBorrower:    (appId) => req('GET', `/api/borrower/applications/${appId}/appraisal`),
  // Fetch an appraisal photo's bytes (blob) for inline display — staff vs borrower channel.
  appraisalPhotoBlob:      async (docId) => (await download(`/api/staff/documents/${docId}/download?inline=1`)).blob,
  appraisalPhotoBlobBorrower: async (docId) => (await download(`/api/borrower/documents/${docId}/download?inline=1`)).blob,

  // ---- Document-underwriting desk: read + understand each document, resolve findings ----
  underwritingGet:            (appId) => req('GET', `/api/underwriting/${appId}`),
  underwritingAnalyze:        (appId, docId, b) => req('POST', `/api/underwriting/${appId}/documents/${docId}/analyze`, b),
  underwritingAutoRead:       (appId) => req('POST', `/api/underwriting/${appId}/auto-read`),
  underwritingClassify:       (appId, docId) => req('POST', `/api/underwriting/${appId}/documents/${docId}/classify`),
  underwritingResolveFinding: (appId, fid, b) => req('POST', `/api/underwriting/${appId}/findings/${fid}/resolve`, b),
  underwritingExperienceException: (appId, b) => req('POST', `/api/underwriting/${appId}/experience-exception`, b),
  // Per-finding escalation to the super-admin / processor / underwriter workload (Items 7+12).
  underwritingEscalateFinding: (appId, b) => req('POST', `/api/underwriting/${appId}/findings/escalate`, b),
  findingEscalations:         (status) => req('GET', `/api/underwriting/escalations${status ? `?status=${status}` : ''}`),
  findingEscalationsCount:    () => req('GET', '/api/underwriting/escalations/count'),
  decideFindingEscalation:    (id, decision, note) => req('POST', `/api/underwriting/escalations/${id}/decide`, { decision, note }),
  // Take a REAL underwriting action (post a condition / request a document / fix the file /
  // grant an exception / clear / dismiss / decline …) straight from the review queue: it
  // resolves the finding ON THE FILE and closes the queue item in one call.
  applyFindingEscalation:     (id, b) => req('POST', `/api/underwriting/escalations/${id}/apply`, b),
  // Portfolio-wide "training" report: which finding types turned out real vs false alarms.
  underwritingFeedback:       () => req('GET', '/api/underwriting/insights/feedback'),

  // ---- admin: team / staff management ----
  adminStaff:        () => req('GET', '/api/admin/staff'),
  adminCreateStaff:  (b) => req('POST', '/api/admin/staff', b),
  adminUpdateStaff:  (id, b) => req('PATCH', `/api/admin/staff/${id}`, b),
  adminSetStaffPassword: (id, password) => req('POST', `/api/admin/staff/${id}/password`, { password }),
  adminPermissionsMeta:  () => req('GET', '/api/admin/permissions-meta'),
  // #111 per-loan manual file-access grants (backed by the #64 assignee chokepoint)
  adminStaffFileGrants: (id) => req('GET', `/api/admin/staff/${id}/file-grants`),
  adminGrantStaffFile:  (id, applicationId) => req('POST', `/api/admin/staff/${id}/file-grants`, { applicationId }),
  adminRevokeStaffFile: (id, applicationId) => req('DELETE', `/api/admin/staff/${id}/file-grants/${applicationId}`),
  adminTestEmail:    (to) => req('POST', '/api/admin/test-email', { to }),
  roster:            () => req('GET', '/api/roster'),

  // ---- TPO firms: internal admin onboarding + per-firm own-Xactus credit account ----
  adminTpoFirms:        () => req('GET', '/api/admin/tpo/firms'),
  adminTpoFirm:         (id) => req('GET', `/api/admin/tpo/firms/${id}`),
  adminCreateTpoFirm:   (b) => req('POST', '/api/admin/tpo/firms', b),
  adminTpoFirmStatus:   (id, status) => req('PATCH', `/api/admin/tpo/firms/${id}`, { status }),
  adminInviteTpoUser:   (id, b) => req('POST', `/api/admin/tpo/firms/${id}/invite`, b),
  adminTpoFirmCredit:       (id) => req('GET', `/api/admin/tpo/firms/${id}/credit-credentials`),
  adminTpoFirmCreditSet:    (id, b) => req('PUT', `/api/admin/tpo/firms/${id}/credit-credentials`, b),
  adminTpoFirmCreditActive: (id, active) => req('POST', `/api/admin/tpo/firms/${id}/credit-credentials/active`, { active }),
  adminTpoFirmCreditClear:  (id) => req('DELETE', `/api/admin/tpo/firms/${id}/credit-credentials`),
  adminTpoFirmCreditTest:   (id) => req('POST', `/api/admin/tpo/firms/${id}/credit-credentials/test`, {}),
  // Per-firm PRICING overrides (special pricing for one broker firm) — markup/orig
  // that override the TPO channel defaults for that firm. broker fee is read-only here.
  adminTpoFirmPricing:      (id) => req('GET', `/api/admin/tpo/firms/${id}/pricing`),
  adminTpoFirmPricingSet:   (id, b) => req('PUT', `/api/admin/tpo/firms/${id}/pricing`, b),
  adminTpoFirmPricingClear: (id) => req('DELETE', `/api/admin/tpo/firms/${id}/pricing`),

  // ---- Condition Center: admin studio (global condition library + rules) ----
  adminConditionFields:    () => req('GET', '/api/admin/conditions/fields'),
  adminConditionDefs:      () => req('GET', '/api/admin/conditions/definitions'),
  adminCreateConditionDef: (b) => req('POST', '/api/admin/conditions/definitions', b),
  adminUpdateConditionDef: (id, b) => req('PATCH', `/api/admin/conditions/definitions/${id}`, b),
  adminDeleteConditionDef: (id, removeFromFiles) => req('DELETE', `/api/admin/conditions/definitions/${id}${removeFromFiles ? '?removeFromFiles=1' : ''}`),
  adminPreviewRule:        (ruleLogic) => req('POST', '/api/admin/conditions/preview-rule', { ruleLogic }),
  adminRunAllConditions:   () => req('POST', '/api/admin/conditions/run-all'),
  // admin-defined custom fields (used by information conditions + rules)
  adminCustomFields:       () => req('GET', '/api/admin/conditions/custom-fields'),
  adminCreateCustomField:  (b) => req('POST', '/api/admin/conditions/custom-fields', b),
  adminUpdateCustomField:  (id, b) => req('PATCH', `/api/admin/conditions/custom-fields/${id}`, b),
  adminDeleteCustomField:  (id) => req('DELETE', `/api/admin/conditions/custom-fields/${id}`),

  // ---- Condition Center: per-file (any staff) ----
  staffConditionMeta:        () => req('GET', '/api/staff/conditions/meta'),
  staffAddCustomCondition:   (appId, b) => req('POST', `/api/staff/applications/${appId}/conditions/custom`, b),
  staffAttachCondition:      (appId, templateId) => req('POST', `/api/staff/applications/${appId}/conditions/attach`, { templateId }),
  // Manual-condition deletion (owner-directed 2026-08-04). Delete works for the
  // adder / an admin; otherwise the server returns 403 code needs_delete_request
  // and the caller offers to ask the adder instead.
  staffDeleteCondition:      (appId, itemId) => req('DELETE', `/api/staff/applications/${appId}/conditions/${itemId}`),
  staffRequestDeleteCondition:(appId, itemId, reason) => req('POST', `/api/staff/applications/${appId}/conditions/${itemId}/request-delete`, { reason }),
  staffDismissDeleteRequest: (appId, itemId) => req('POST', `/api/staff/applications/${appId}/conditions/${itemId}/dismiss-delete-request`),
  staffReevaluateConditions: (appId) => req('POST', `/api/staff/applications/${appId}/conditions/reevaluate`),

  // ---- Condition Center: borrower answers an information condition ----
  submitInfoCondition: (appId, itemId, value) => req('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/info`, { value }),

  // ---- Pricing Admin Center (manage_pricing): company-wide markup/fee defaults ----
  adminPricingGet: () => req('GET', '/api/admin/pricing'),
  adminPricingPut: (b) => req('PUT', '/api/admin/pricing', b),
  // TPO (broker/wholesale) channel pricing controls — separate markup + origination
  // defaults for the TPO channel (blank = same as retail). manage_pricing-gated.
  adminTpoPricingGet: () => req('GET', '/api/admin/pricing/tpo'),
  adminTpoPricingPut: (b) => req('PUT', '/api/admin/pricing/tpo', b),

  // ---- Loan-Officer Notification Center: per-notification prefs + draft queue ----
  loNotifCatalog:      () => req('GET',  '/api/staff/notification-center/catalog'),
  loNotifPrefs:        () => req('GET',  '/api/staff/notification-center/prefs'),
  loNotifSavePref:     (key, body) => req('PUT', `/api/staff/notification-center/prefs/${encodeURIComponent(key)}`, body),
  loNotifBulkSave:     (changes) => req('POST', '/api/staff/notification-center/prefs/bulk', { changes }),
  loNotifDrafts:       (params) => req('GET',  '/api/staff/notification-center/drafts' + qs(typeof params === 'string' ? { status: params } : (params || {}))),
  loNotifDraftCount:   () => req('GET',  '/api/staff/notification-center/drafts/count'),
  loNotifDraftPreview: (id) => req('GET',  `/api/staff/notification-center/drafts/${id}/preview`),
  loNotifDraftSend:    (id, edits) => req('POST', `/api/staff/notification-center/drafts/${id}/send`, edits || {}),
  loNotifDraftDiscard: (id) => req('POST', `/api/staff/notification-center/drafts/${id}/discard`),
  loNotifDraftSchedule:(id, at) => req('POST', `/api/staff/notification-center/drafts/${id}/schedule`, { at }),
  loNotifDraftSnooze:  (id, minutes) => req('POST', `/api/staff/notification-center/drafts/${id}/snooze`, { minutes }),
  loNotifDraftsBulk:   (ids, action, extra) => req('POST', '/api/staff/notification-center/drafts/bulk', { ids, action, ...(extra || {}) }),
  loNotifRulesGet:     () => req('GET',  '/api/staff/notification-center/rules'),
  loNotifRulesPut:     (b) => req('PUT',  '/api/staff/notification-center/rules', b),
  loNotifOverrides:    (appId) => req('GET',  `/api/staff/notification-center/overrides?applicationId=${encodeURIComponent(appId)}`),
  loNotifSaveOverride: (b) => req('PUT',  '/api/staff/notification-center/overrides', b),
  loNotifClearOverride:(appId, key) => req('DELETE', `/api/staff/notification-center/overrides?applicationId=${encodeURIComponent(appId)}&key=${encodeURIComponent(key)}`),
  loNotifCompose:      (b) => req('POST', '/api/staff/notification-center/compose', b),
  loNotifAnalytics:    (days) => req('GET',  `/api/staff/notification-center/analytics${days ? `?days=${days}` : ''}`),
  // ---- "For me" — the LO's OWN inbox controls ----
  loNotifSelfPrefs:        () => req('GET',  '/api/staff/notification-center/self-prefs'),
  loNotifSelfSavePref:     (key, body) => req('PUT', `/api/staff/notification-center/self-prefs/${encodeURIComponent(key)}`, body),
  loNotifSelfBulkSave:     (items) => req('POST', '/api/staff/notification-center/self-prefs/bulk', { items }),
  loNotifDeliveryRules:    () => req('GET',  '/api/staff/notification-center/delivery-rules'),
  loNotifDeliveryRulesPut: (b) => req('PUT',  '/api/staff/notification-center/delivery-rules', b),
  loNotifMuteFile:         (b) => req('POST', '/api/staff/notification-center/mute-file', b),
  loNotifUnmuteFile:       (appId) => req('DELETE', `/api/staff/notification-center/mute-file?applicationId=${encodeURIComponent(appId)}`),
  loNotifMutedFiles:       () => req('GET',  '/api/staff/notification-center/muted-files'),
  loNotifStarFile:         (appId) => req('POST', '/api/staff/notification-center/star-file', { applicationId: appId }),
  loNotifUnstarFile:       (appId) => req('DELETE', `/api/staff/notification-center/star-file?applicationId=${encodeURIComponent(appId)}`),
  loNotifStarredFiles:     () => req('GET',  '/api/staff/notification-center/starred-files'),
  loNotifSelfVolume:       (days) => req('GET',  `/api/staff/notification-center/self-volume${days ? `?days=${days}` : ''}`),

  // ---- Borrower view: stand inside a borrower's portal (owner-directed 2026-07-26) ----
  // The flow itself lives in lib/auth.jsx (startBorrowerView / exitBorrowerView),
  // which swaps the stored token — screens should call THOSE, not these directly.
  borrowerViewEligible: (q) => req('GET', '/api/borrower-view/eligible' + qs({ q })),
  borrowerViewStart:    (borrowerId, applicationId) => req('POST', '/api/borrower-view/start', { borrowerId, applicationId: applicationId || null }),
  borrowerViewSession:  () => req('GET', '/api/borrower-view/session'),
  borrowerViewExit:     () => req('POST', '/api/borrower-view/exit'),
  borrowerViewHistory:  (limit) => req('GET', '/api/borrower-view/history' + qs({ limit })),
  // TPO VIEW — the mirror of borrower view for the external brokerage portal: an
  // AE/AM/admin steps into a broker's login. See src/lib/tpo-view.js.
  tpoViewEligible: (q) => req('GET', '/api/tpo-view/eligible' + qs({ q })),
  tpoViewStart:    (tpoUserId, applicationId) => req('POST', '/api/tpo-view/start', { tpoUserId, applicationId: applicationId || null }),
  tpoViewSession:  () => req('GET', '/api/tpo-view/session'),
  tpoViewExit:     () => req('POST', '/api/tpo-view/exit'),
  tpoViewHistory:  (limit) => req('GET', '/api/tpo-view/history' + qs({ limit })),

  // ---- Staff view: a super-admin stands inside a TEAM MEMBER's console --------
  // The third sibling of borrower/tpo view, read-only by design (acting as
  // another staffer would put the admin's actions on the wrong person's record).
  staffViewEligible: (q) => req('GET', '/api/staff-view/eligible' + qs({ q })),
  staffViewStart:    (staffId) => req('POST', '/api/staff-view/start', { staffId }),
  staffViewSession:  () => req('GET', '/api/staff-view/session'),
  staffViewExit:     () => req('POST', '/api/staff-view/exit'),
  staffViewHistory:  (limit) => req('GET', '/api/staff-view/history' + qs({ limit })),

  // ---- Research desk: the property / comparable / appraiser database ----------
  // Built out of every appraisal XML we have ever imported (db/409). Staff-wide —
  // it holds addresses, property facts and recorded sale prices, no borrower data.
  researchStats:       () => req('GET', '/api/research/stats'),
  // How many appraisals we had to turn away, and in what format (db/438). UAD 3.6
  // becomes MANDATORY for Fannie/Freddie appraisals on 2 November 2026 and PILOT
  // reads UAD 2.6, so this count going above zero is the deadline arriving early
  // — which is only useful if somebody can see it.
  appraisalFormats:    (f) => req('GET', '/api/research/appraisal-formats' + qs(f)),
  // TWO ROWS, ONE HOUSE (db/419). The detection is ADVISORY by design — "nothing
  // here is ever merged without a person saying so" — which needs a door for the
  // person to say it through. There was none, so the pairs were found and then
  // nobody could answer them either way.
  // How much of the warehouse is placed on the map. A property with no
  // coordinates is INVISIBLE to a "within N miles" search, silently — so the
  // count is a disclosure, not plumbing.
  researchGeocodeStatus: () => req('GET', '/api/research/geocode/status'),
  researchDuplicates:  (f) => req('GET', '/api/research/duplicates' + qs(f)),
  researchMergeProps:  (b) => req('POST', '/api/research/duplicates/merge', b),
  researchNotDup:      (b) => req('POST', '/api/research/duplicates/not-duplicate', b),
  researchSearch:      (f) => req('GET', '/api/research/properties' + qs(f)),
  researchProperty:    (id) => req('GET', `/api/research/properties/${id}`),
  // A photo is fetched with the Bearer token like every other binary on this
  // platform, NEVER pointed at from an <img src>. A browser image request sends
  // no Authorization header, so an API path in `src` is a guaranteed 401 — see
  // components/ResearchPhoto.jsx, which turns this into an object URL.
  researchPhotoBlob:   (documentId) => download(`/api/research/photos/${documentId}`),
  researchAppraisers:  (f) => req('GET', '/api/research/appraisers' + qs(f)),
  researchAppraiser:   (id) => req('GET', `/api/research/appraisers/${id}`),
  researchRates:       (f) => req('GET', '/api/research/rates' + qs(f)),
  researchComps:       (f) => req('GET', '/api/research/comps' + qs(f)),
  // The 1004MC market grid, rolled up by month across every report we hold for a
  // town. Small numbers of reports per month, so the screen shows the count too.
  researchMarket:        (f) => req('GET', '/api/research/market' + qs(f)),
  researchAdjustmentRates: (f) => req('GET', '/api/research/adjustment-rates' + qs(f)),
  researchQuick:         (f) => req('GET', '/api/research/quick' + qs(f)),
  researchVariance:      (f) => req('GET', '/api/research/variance' + qs(f)),
  marketAreas:           (f) => req('GET', '/api/research/market-areas' + qs(f)),
  marketAreaCreate:      (b) => req('POST', '/api/research/market-areas', b),
  marketAreaArchive:     (id) => req('POST', `/api/research/market-areas/${id}/archive`, {}),
  marketAreaProperties:  (id) => req('GET', `/api/research/market-areas/${id}/properties`),
  researchMarketReports: (f) => req('GET', '/api/research/market/reports' + qs(f)),
  researchFlips:         (f) => req('GET', '/api/research/flips' + qs(f)),
  researchBackfill:    (b) => req('POST', '/api/research/backfill', b || {}),
  // Upload appraisal data files straight into the research database. `files` is
  // [{filename, xml}] — the screen sends a big drop in size-bounded batches,
  // because one MISMO file carries the whole report PDF inside it and a hundred
  // of them would blow past the server's request-size limit in a single POST.
  researchImportXml:   (b) => req('POST', '/api/research/imports', b),
  researchImports:     (f) => req('GET', '/api/research/imports' + qs(f)),
  // Build-your-own valuations (db/410)
  valuations:          (f) => req('GET', '/api/research/valuations' + qs(f)),
  valuation:           (id) => req('GET', `/api/research/valuations/${id}`),
  valuationCreate:     (b) => req('POST', '/api/research/valuations', b),
  valuationUpdate:     (id, b) => req('PATCH', `/api/research/valuations/${id}`, b),
  valuationAddComps:   (id, b) => req('POST', `/api/research/valuations/${id}/comps`, b),
  valuationEditComp:   (id, compId, b) => req('PATCH', `/api/research/valuations/${id}/comps/${compId}`, b),
  valuationDropComp:   (id, compId) => req('DELETE', `/api/research/valuations/${id}/comps/${compId}`),
  valuationSuggest:    (id, b) => req('POST', `/api/research/valuations/${id}/suggest`, b || {}),
  valuationFinalize:   (id, b) => req('POST', `/api/research/valuations/${id}/finalize`, b || {}),
  // The confirm-the-facts step: corrections in, a re-valued grid straight back.
  valuationConfirmSubject: (id, corrections) => req('POST', `/api/research/valuations/${id}/confirm-subject`, { corrections }),
  valuationDuplicate:  (id) => req('POST', `/api/research/valuations/${id}/duplicate`, {}),
  valuationDelete:     (id) => req('DELETE', `/api/research/valuations/${id}`),

  // ---- Elementix CRM (the second Elementix plane — see src/routes/elementix-crm.js) ----
  // Underwriting's Elementix calls live behind /api/underwriting; NOTHING here
  // may be reused there. Contact detail bought on this plane must never reach a
  // lending decision.
  elxMe:               () => req('GET', '/api/elementix/me'),
  elxConnect:          () => req('GET', '/api/elementix/connect'),
  elxDisconnect:       () => req('POST', '/api/elementix/disconnect', {}),
  elxConnections:      () => req('GET', '/api/elementix/connections'),
  elxRefreshIdentity:  (staffId) => req('POST', `/api/elementix/connections/${staffId}/refresh-identity`, {}),
  elxUsage:            () => req('GET', '/api/elementix/usage'),
  elxSearch:           (q, state) => req('GET', `/api/elementix/search?q=${encodeURIComponent(q || '')}${state ? `&state=${encodeURIComponent(state)}` : ''}`),
  elxContact:          (personId) => req('GET', `/api/elementix/people/${personId}/contact`),
  elxSkipTrace:        (personId, b) => req('POST', `/api/elementix/people/${personId}/skip-trace`, b || {}),
  elxAddLead:          (personId, b) => req('POST', `/api/elementix/people/${personId}/lead`, b || {}),
  elxProfile:          (personId) => req('GET', `/api/elementix/people/${personId}/profile`),
  elxProfileBuild:     (personId, b) => req('POST', `/api/elementix/people/${personId}/profile/build`, b || {}),
  elxAliases:          (personId) => req('GET', `/api/elementix/people/${personId}/aliases`),
  elxDecideAlias:      (personId, aliasId, confirm) => req('POST', `/api/elementix/people/${personId}/aliases/${aliasId}`, { confirm }),
  elxLink:             (b) => req('POST', '/api/elementix/link', b || {}),
  elxFor:              (kind, recordId) => req('GET', `/api/elementix/for/${kind}/${recordId}`),
  // The lead's phone book (own numbers + every Elementix number, each with its
  // working/not-working mark) and the mark writer. A mark never removes a number.
  elxLeadPhones:       (leadId) => req('GET', `/api/elementix/leads/${leadId}/phones`),
  elxMarkLeadPhone:    (leadId, b) => req('POST', `/api/elementix/leads/${leadId}/phones/mark`, b || {}),
  // THE PROPERTY BEHIND A ROW. The GET is the cache and is safe anywhere; the
  // POST spends three to five of the organisation's shared hourly requests, so
  // it is only ever wired to a button somebody presses.
  elxAddress:          (addressId, personId) => req('GET', `/api/elementix/addresses/${addressId}?personId=${encodeURIComponent(personId || '')}`),
  elxAddressRead:      (addressId, personId, force) => req('POST', `/api/elementix/addresses/${addressId}/read`, { personId, force: !!force }),
  elxBackfill:         () => req('GET', '/api/elementix/backfill'),
  elxBackfillList:     () => req('POST', '/api/elementix/backfill/list', {}),
  elxBackfillWork:     (limit) => req('POST', '/api/elementix/backfill/work', { limit }),
  elxLinkUser:         (b) => req('POST', '/api/elementix/backfill/users/link', b || {}),
  /* THE ADMIN CRM DESK — the whole company's lead book, one row per officer
     (manage_team). Read-only: it spends nothing and calls no vendor. Every
     ACTIVE INTERNAL officer comes back, including the ones at zero, plus a
     company total and the unassigned desk. A figure that could not be read is
     null (rendered "—"), never 0. */
  elxCrmDesk:          () => req('GET', '/api/elementix/crm-desk'),

  // ---- Dashboards (the KPI screen + the build-your-own section) ----
  dashboards:          () => req('GET', '/api/dashboards'),
  dashboardMeta:       () => req('GET', '/api/dashboards/meta'),
  dashboardHome:       () => req('GET', '/api/dashboards/home'),
  dashboard:           (id) => req('GET', `/api/dashboards/${id}`),
  dashboardAnswers:    (id) => req('GET', `/api/dashboards/${id}/answers`),
  dashboardCardAnswer: (cardId) => req('GET', `/api/dashboards/cards/${cardId}/answer`),
  dashboardCardFiles:  (cardId, q) => req('GET', `/api/dashboards/cards/${cardId}/files` + qs(q || {})),
  dashboardPreview:    (card) => req('POST', '/api/dashboards/preview', { card }),
  dashboardCreate:     (b) => req('POST', '/api/dashboards', b || {}),
  dashboardFork:       (id, b) => req('POST', `/api/dashboards/${id}/fork`, b || {}),
  dashboardRename:     (id, b) => req('PATCH', `/api/dashboards/${id}`, b || {}),
  dashboardArchive:    (id) => req('DELETE', `/api/dashboards/${id}`),
  dashboardAddCard:    (id, b) => req('POST', `/api/dashboards/${id}/cards`, b || {}),
  dashboardSaveCard:   (id, cardId, b) => req('PATCH', `/api/dashboards/${id}/cards/${cardId}`, b || {}),
  dashboardDropCard:   (id, cardId) => req('DELETE', `/api/dashboards/${id}/cards/${cardId}`),
  dashboardReorder:    (id, order) => req('POST', `/api/dashboards/${id}/reorder`, { order }),
  dashboardShares:     (id) => req('GET', `/api/dashboards/${id}/shares`),
  dashboardShare:      (id, b) => req('POST', `/api/dashboards/${id}/shares`, b || {}),
  dashboardUnshare:    (id, shareId) => req('DELETE', `/api/dashboards/${id}/shares/${shareId}`),
};
