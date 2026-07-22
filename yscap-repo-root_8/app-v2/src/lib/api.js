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
const RETRY_DELAYS = [700, 1800, 3500];   // ~6s total — covers a restart blip

function friendlyError(status, data) {
  if (data && data.error) return data.error;
  if (RETRYABLE.includes(status)) return 'The server is briefly unavailable (it may be restarting) — please try again in a moment.';
  if (status === 401) return 'Your session has expired — please sign in again.';
  if (status === 403) return 'You don’t have access to that.';
  if (status === 404) return 'That item could not be found.';
  if (status === 413) return 'That file is too large to upload.';
  return `Something went wrong (HTTP ${status}) — please try again.`;
}

// Session expired mid-use: clear the token ONCE, remember why, and let the
// router (which watches ys:auth-changed) bounce to the correct login screen.
function sessionExpired() {
  if (!getToken()) return;
  clearToken();
  try { sessionStorage.setItem(NOTICE_KEY, 'You were signed out because your session expired. Please sign in again.'); } catch { /* private mode */ }
  window.dispatchEvent(new Event('ys:auth-changed'));
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
    if (fresh && getToken()) setToken(fresh);
    if (res.status === 401 && !isAuthCall && getToken()) sessionExpired();
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
  return [tag, b.applicationId, b.checklistItemId, b.llcId, b.trackRecordId, b.slot,
    b.docKind, b.filename, (b.dataBase64 || '').length].map((x) => (x == null ? '' : String(x))).join('|');
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
  borrowerRegisterProduct: (appId, program, overrides, adminKey, econVersion, submitException) => req('POST', `/api/borrower/applications/${appId}/pricing/register`, { program, overrides, adminKey, econVersion, submitException }),
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
  uploadDoc:    (b) => coalesceUpload('uploadDoc', b, () => req('POST', '/api/borrower/documents', normalizeUpload(b))),
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
  staffBorrowerSearch: (q) => req('GET', '/api/staff/borrowers/search?q=' + encodeURIComponent(q)),
  // #83 — loan-officer borrower management
  staffBorrowers:   () => req('GET', '/api/staff/borrowers'),
  staffBorrowerInvite: (id) => req('POST', `/api/staff/borrowers/${id}/portal-invite`),
  // Change WHICH email the Sitewire borrower invite goes to (borrower / GC / partner). Replaces the
  // pending invite (Sitewire keeps one email per property) + stores it so the push/resend honor it.
  setDrawInviteEmail: (appId, email) => req('POST', `/api/sitewire/files/${appId}/invite-email`, { email }),
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
  staffBorrowerTrackRecords: (id) => req('GET', `/api/staff/borrowers/${id}/track-records`),
  staffTrackRecordSnapshot:  (id) => req('GET', `/api/staff/borrowers/${id}/track-record/snapshot`),
  staffBorrowerLlcs: (id) => req('GET', `/api/staff/borrowers/${id}/llcs`),
  // In-file verify set: the file's vesting entity + this borrower's track-record
  // entities only (not the borrower's whole LLC library). Returns { vestingLlcId, llcs:[{...,vesting}] }.
  staffAppVerifyLlcs: (appId) => req('GET', `/api/staff/applications/${appId}/verify-llcs`),
  staffSetVestingLlc: (appId, llcId) => req('POST', `/api/staff/applications/${appId}/vesting-llc`, { llcId }),
  staffCreateLlc:    (borrowerId, b) => req('POST', `/api/staff/borrowers/${borrowerId}/llcs`, b),
  staffLlc:          (id) => req('GET', `/api/staff/llcs/${id}`),
  staffUpdateLlc:    (id, b) => req('PATCH', `/api/staff/llcs/${id}`, b),
  staffSaveLlcMembers: (id, members) => req('PUT', `/api/staff/llcs/${id}/members`, { members }),
  staffUploadLlcDoc: (llcId, b) => coalesceUpload('llcDoc:' + llcId, b, () => req('POST', `/api/staff/llcs/${llcId}/documents`, normalizeUpload(b))),
  staffVerifyLlc:    (id, b) => req('POST', `/api/staff/llcs/${id}/verify`, b || {}),
  staffVerifyTrackRecord:    (id, body) => req('POST', `/api/staff/track-records/${id}/verify`, body),
  // Raise an issue/request against a track-record line item or a vesting LLC — it
  // becomes a named internal+external condition on the file (applicationId).
  staffRaiseTrackRecordIssue: (id, applicationId, reason) => req('POST', `/api/staff/track-records/${id}/raise-issue`, { applicationId, reason }),
  // Request a DOCUMENT for one track-record line item — becomes a condition
  // tagged with the line item; uploads land on the line + its REO folder.
  staffRequestTrackRecordDoc: (id, applicationId, label) => req('POST', `/api/staff/track-records/${id}/request-doc`, { applicationId, label }),
  staffTrackRecordDocs: (id) => req('GET', `/api/staff/track-records/${id}/documents`),
  staffRaiseLlcIssue:         (id, applicationId, reason) => req('POST', `/api/staff/llcs/${id}/raise-issue`, { applicationId, reason }),
  staffPatchItem:   (itemId, b) => req('PATCH', `/api/staff/checklist/${itemId}`, b),
  staffRequestDoc:  (appId, b) => req('POST', `/api/staff/applications/${appId}/checklist`, b),
  staffAddCondition:(appId, b) => req('POST', `/api/staff/applications/${appId}/conditions`, b),
  staffConditions:  (appId) => req('GET', `/api/staff/applications/${appId}/conditions`),
  staffActivity:    (appId) => req('GET', `/api/staff/applications/${appId}/activity`),
  // ---- Email Center (per-file history + global mailbox + reply) ----
  staffAppEmails:   (appId, scope) => req('GET', `/api/staff/applications/${appId}/emails` + (scope ? `?scope=${encodeURIComponent(scope)}` : '')),   // per-file email history (scope='draw' → draw inbox)
  staffAppEmailMsg: (appId, msgId) => req('GET', `/api/staff/applications/${appId}/emails/${msgId}`),   // full body of one message
  staffAppEmailReply: (appId, body) => req('POST', `/api/staff/applications/${appId}/emails/reply`, body),
  staffAppReplyRecipients: (appId) => req('GET', `/api/staff/applications/${appId}/emails/reply-recipients`),
  staffEmails:      (params) => req('GET', '/api/staff/emails' + qs(params)),            // global mailbox (all visible files)
  staffEmailMsg:    (msgId) => req('GET', `/api/staff/emails/${msgId}`),                 // full body from the global mailbox
  staffEmailStats:  () => req('GET', '/api/staff/emails/stats'),
  staffAppEmailResend: (appId, msgId) => req('POST', `/api/staff/applications/${appId}/emails/${msgId}/resend`),
  staffAppEmailAttachment: (appId, msgId, idx) => download(`/api/staff/applications/${appId}/emails/${msgId}/attachments/${idx}`),
  // Orders desk (#orders) — title + insurance orders on a file.
  staffOrders:        (appId) => req('GET', `/api/staff/applications/${appId}/orders`),
  staffPlaceOrder:    (appId, kind, body) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/place`, body || {}),
  staffOrderFollowup: (appId, kind, body) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/followup`, body || {}),
  staffClassifyOrderDoc: (appId, kind, docId, slot) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/documents/${docId}/classify`, { slot }),
  staffCancelOrder:   (appId, kind, reopen) => req('POST', `/api/staff/applications/${appId}/orders/${kind}/cancel`, reopen ? { reopen: true } : {}),
  staffAllOrders:     () => req('GET', '/api/staff/orders'),   // global orders queue (all visible files)
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
  // Borrower's OWN branded inspection report (always borrower-safe; server enforces own-file). drawId
  // optional → that draw; omitted → whole-project. Opens in a tab (win pre-opened in the click handler).
  borrowerDrawReport: async (appId, drawId, win) => {
    try { const { blob, filename } = await download(`/api/borrower/draws/${appId}/report${drawId ? `?drawId=${drawId}` : ''}`); openBlob(blob, filename, win); }
    catch (e) { try { if (win && !win.closed) win.close(); } catch { /* ignore */ } throw e; }
  },
  staffTprPreview:  (appId) => req('GET', `/api/staff/applications/${appId}/export/tpr/preview`),
  staffTprExport:   (appId) => download(`/api/staff/applications/${appId}/export/tpr`),
  // MISMO 3.4 — the mortgage industry's shared file format. Export downloads the
  // file as MISMO XML; import parses (preview, no writes) then creates a new file.
  staffExportMismo:  (appId) => download(`/api/staff/applications/${appId}/export/mismo`),
  staffMismoPreview: (xml) => req('POST', '/api/staff/mismo/preview', { xml }),
  staffMismoCreate:  (xml) => req('POST', '/api/staff/mismo/create', { xml }),
  staffSaveRehabBudget: (appId, payload) => req('POST', `/api/staff/applications/${appId}/rehab-budget`, { payload }),
  // #152 — export the current pipeline VIEW (same filter params as staffApplications).
  staffExportPipeline: (params) => download(`/api/staff/applications/export${qs(params)}`),
  staffPricing:      (appId) => req('GET', `/api/staff/applications/${appId}/pricing`),
  staffPricingQuote: (appId, overrides) => req('POST', `/api/staff/applications/${appId}/pricing/quote`, { overrides }),
  staffRegisterProduct: (appId, program, overrides, econVersion, assetMonths, submitException) => req('POST', `/api/staff/applications/${appId}/pricing/register`, { program, overrides, econVersion, assetMonths, submitException }),
  staffRequestException: (appId, note) => req('POST', `/api/staff/applications/${appId}/pricing/request-exception`, { note }),
  // Manual Program admin config + the super-admin escalation box.
  manualProgramSettings:     () => req('GET', '/api/admin/manual-programs/settings'),
  saveManualProgramSettings: (b) => req('PUT', '/api/admin/manual-programs/settings', b),
  manualEscalations:         (status) => req('GET', `/api/admin/manual-programs/escalations${status ? `?status=${status}` : ''}`),
  manualEscalationsCount:    () => req('GET', '/api/admin/manual-programs/escalations/count'),
  decideManualEscalation:    (id, decision, note) => req('POST', `/api/admin/manual-programs/escalations/${id}/decide`, { decision, note }),
  counterManualEscalation:   (id, counterTerms, counterNote) => req('POST', `/api/admin/manual-programs/escalations/${id}/counter`, { counterTerms, counterNote }),
  acceptCounterOffer:        (appId) => req('POST', `/api/staff/applications/${appId}/pricing/accept-counter`, {}),
  runCommitteeReview:        (appId, findingId, all = false) => req('POST', `/api/underwriting/${appId}/findings/${findingId}/committee-review`, { all: !!all }),
  trainingProposals:         (status = 'pending') => req('GET', `/api/admin/training/proposals${status ? `?status=${status}` : ''}`),
  trainingProposalsRun:      () => req('POST', '/api/admin/training/run', {}),
  trainingProposalsDecide:   (id, decision, note) => req('POST', `/api/admin/training/proposals/${id}/decide`, { decision, note }),
  fileCertificates:          (appId) => req('GET', `/api/underwriting/${appId}/certificate`),
  fileCertificateIssue:      (appId, milestone, reason) => req('POST', `/api/underwriting/${appId}/certificate/issue`, { milestone, reason: reason || undefined }),
  fileCertificateSurvey:     (appId) => req('POST', `/api/underwriting/${appId}/certificate/survey`, {}),
  fileStructuring:           (appId) => req('GET', `/api/underwriting/${appId}/structuring`),
  factHistory:               (appId, factKey) => req('GET', `/api/underwriting/${appId}/twin/fact/${encodeURIComponent(factKey)}`),
  confirmFact:               (appId, factKey, value, reason) => req('POST', `/api/underwriting/${appId}/twin/fact/${encodeURIComponent(factKey)}/confirm`, { value, reason: reason || undefined }),
  similarOpenFindings:       (appId, findingId) => req('GET', `/api/underwriting/${appId}/findings/${findingId}/similar-open`),
  bulkResolveFindings:       (appId, findingIds, action, note) => req('POST', `/api/underwriting/${appId}/findings/similar/bulk-resolve`, { findingIds, action, note: note || undefined }),
  fileAvmConsensus:          (appId) => req('GET', `/api/underwriting/${appId}/avm-consensus`),
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
  staffUploadAppDoc: (appId, b) => coalesceUpload('appDoc:' + appId, b, () => req('POST', `/api/staff/applications/${appId}/documents`, normalizeUpload(b))),
  staffAddLoanCondition: (appId, b) => req('POST', `/api/staff/applications/${appId}/loan-conditions`, b),
  staffClearCondition:   (cid) => req('POST', `/api/staff/loan-conditions/${cid}/clear`),
  staffWaiveCondition:   (cid, reason) => req('POST', `/api/staff/loan-conditions/${cid}/waive`, { reason }),
  staffReviewCondition:  (cid, reviewed) => req('POST', `/api/staff/loan-conditions/${cid}/review`, { reviewed }),
  // Borrower change-request sandbox (S5-03) — staff review side.
  staffChangeRequests:       (appId) => req('GET', `/api/staff/applications/${appId}/change-requests`),
  staffApproveChangeRequest: (cid, note) => req('POST', `/api/staff/change-requests/${cid}/approve`, { note }),
  staffRejectChangeRequest:  (cid, note) => req('POST', `/api/staff/change-requests/${cid}/reject`, { note }),
  staffAssign:      (appId, b) => req('POST', `/api/staff/applications/${appId}/assign`, b),
  // Multi-assignee team (#64): the full team + add/remove full-access assistants.
  staffAssignees:      (appId) => req('GET', `/api/staff/applications/${appId}/assignees`),
  staffAddAssignee:    (appId, staffId, role) => req('POST', `/api/staff/applications/${appId}/assignees`, { staffId, role }),
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
  workflowCount:     () => req('GET', '/api/staff/workflow/count'),
  workflowPickup:    (itemId) => req('POST', `/api/staff/workflow/${itemId}/pickup`),
  workflowReturn:    (itemId, outcomeLabel, note) => req('POST', `/api/staff/workflow/${itemId}/return`, { outcomeLabel, note }),
  closingWorkflow:   (appId) => req('GET', `/api/staff/applications/${appId}/closing-workflow`),
  advanceClosing:    (appId, stage) => req('POST', `/api/staff/applications/${appId}/closing-workflow`, { stage }),
  staffStatusHistory: (appId) => req('GET', `/api/staff/applications/${appId}/status-history`),
  staffSetClosingDate: (appId, b) => req('POST', `/api/staff/applications/${appId}/closing-date`, b),
  staffEditApplication: (appId, b) => req('PATCH', `/api/staff/applications/${appId}/details`, b),
  staffSetStructuralLock: (appId, unlocked, reason) => req('POST', `/api/staff/applications/${appId}/structural-lock`, { unlocked, reason }),
  staffNudge:          (appId) => req('POST', `/api/staff/applications/${appId}/nudge`),
  // Reminders + task management (#93). staffReminders returns { reminders,
  // contacts, outstanding } so the composer is populated in one round-trip.
  staffReminders:      (appId) => req('GET', `/api/staff/applications/${appId}/reminders`),
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
  staffLeads:       () => req('GET', '/api/staff/leads'),
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
  staffAddLeadDocument:(id, b) => req('POST', `/api/staff/leads/${id}/documents`, b),
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
  integrationTest:    (key) => req('POST', `/api/admin/integrations/${encodeURIComponent(key)}/test`),
  // Read-only Sitewire TEST-environment capability explorer (super_admin). Lists every field/button
  // Sitewire exposes so new integrations use confirmed names. Uses SITEWIRE_TEST_* creds; never writes.
  sitewireExplore:    (opts) => req('POST', '/api/admin/integrations/sitewire/explore', opts || {}),
  integrationSwitches: () => req('GET', '/api/admin/integrations/switches'),
  integrationToggleSwitch: (key, enabled, confirm) => req('POST', `/api/admin/integrations/switches/${encodeURIComponent(key)}`, { enabled, confirm }),
  integrationResetSwitch:  (key) => req('POST', `/api/admin/integrations/switches/${encodeURIComponent(key)}/reset`),
  clickupHealth:    () => req('GET', '/api/admin/clickup/health'),
  clickupActivity:  () => req('GET', '/api/admin/clickup/activity'),
  clickupBackfill:  (mode, sample) => req('POST', '/api/admin/clickup/backfill', { mode, sample }),
  clickupRepush:    (appId) => req('POST', `/api/admin/clickup/file/${appId}/repush`),
  clickupRepull:    (appId) => req('POST', `/api/admin/clickup/file/${appId}/repull`),
  clickupSyncFolder:(folderId, createFiles) => req('POST', '/api/admin/clickup/sync-folder', { folderId, createFiles }),
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
  staffAddFileContact: (appId, b) => req('POST', `/api/staff/applications/${appId}/file-contacts`, b),
  staffEditFileContact:(linkId, b) => req('PATCH', `/api/staff/file-contacts/${linkId}`, b),
  staffDelFileContact: (linkId) => req('DELETE', `/api/staff/file-contacts/${linkId}`),
  staffBorrowerContacts: (borrowerId) => req('GET', `/api/staff/borrowers/${borrowerId}/contacts`),
  staffAppraisalCard:(appId) => req('GET', `/api/staff/applications/${appId}/appraisal-card`),
  staffSaveAppraisalCard:(appId, b) => req('POST', `/api/staff/applications/${appId}/appraisal-card`, b),

  // ---- Appraisal desk: import the appraisal XML, read the property profile, resolve findings ----
  appraisalGet:            (appId) => req('GET', `/api/appraisal/${appId}`),
  appraisalImport:         (appId, b) => req('POST', `/api/appraisal/${appId}/import`, b),
  appraisalUndoImport:     (appId) => req('POST', `/api/appraisal/${appId}/undo-import`),
  appraisalResolveFinding: (appId, fid, b) => req('POST', `/api/appraisal/${appId}/findings/${fid}/resolve`, b),
  appraisalRefreshPhotos:  (appId) => req('POST', `/api/appraisal/${appId}/photos/refresh`, {}),
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
  staffReevaluateConditions: (appId) => req('POST', `/api/staff/applications/${appId}/conditions/reevaluate`),

  // ---- Condition Center: borrower answers an information condition ----
  submitInfoCondition: (appId, itemId, value) => req('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/info`, { value }),

  // ---- Pricing Admin Center (manage_pricing): company-wide markup/fee defaults ----
  adminPricingGet: () => req('GET', '/api/admin/pricing'),
  adminPricingPut: (b) => req('PUT', '/api/admin/pricing', b),

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
};
