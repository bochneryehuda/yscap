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

// Login/MFA/registration endpoints answer 401 for bad credentials — that must
// show as an error on the form, never trigger the global "session expired" path.
const AUTH_CALL = /^\/auth\/((borrower|staff)\/(login|mfa\/verify|register)|mfa\/enable)/;

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
  put:  (p, b) => req('PUT', p, b),
  del:  (p) => req('DELETE', p),

  login: (email, password) => req('POST', '/auth/borrower/login', { email, password }),
  mfaVerify: (challenge, code) => req('POST', '/auth/borrower/mfa/verify', { challenge, code }),
  register: (b) => req('POST', '/auth/borrower/register', b),

  verifyEmail:        (b) => req('POST', '/auth/borrower/verify', b),          // {token} or {email,code}
  resendVerification: (email) => req('POST', '/auth/borrower/resend-verification', { email }),
  forgotPassword:     (email) => req('POST', '/auth/borrower/forgot', { email }),
  resetPassword:      (token, password) => req('POST', '/auth/borrower/reset', { token, password }),
  acceptInvite:       (b) => req('POST', '/auth/accept', b),                   // {token,password,fullName?}

  profile:      () => req('GET', '/api/borrower/profile'),
  saveProfile:  (b) => req('PUT', '/api/borrower/profile', b),
  uploadPhotoId:(b) => req('POST', '/api/borrower/profile/photo-id', normalizeUpload(b)),
  applications: () => req('GET', '/api/borrower/applications'),
  application:  (id) => req('GET', `/api/borrower/applications/${id}`),
  requestDraw:  (id) => req('POST', `/api/borrower/applications/${id}/request-draw`),
  borrowerPricing:      (appId) => req('GET', `/api/borrower/applications/${appId}/pricing`),
  borrowerPricingQuote: (appId, overrides) => req('POST', `/api/borrower/applications/${appId}/pricing/quote`, { overrides }),
  borrowerRegisterProduct: (appId, program, overrides, adminKey) => req('POST', `/api/borrower/applications/${appId}/pricing/register`, { program, overrides, adminKey }),
  checklist:    (id) => req('GET', `/api/borrower/applications/${id}/checklist`),
  conditions:   (id) => req('GET', `/api/borrower/applications/${id}/conditions`),
  activity:     (id) => req('GET', `/api/borrower/applications/${id}/activity`),
  statusHistory:(id) => req('GET', `/api/borrower/applications/${id}/status-history`),
  notifications:() => req('GET', '/api/borrower/notifications'),
  messages:     (appId) => req('GET', `/api/borrower/messages?applicationId=${appId}`),
  react:        (msgId, emoji) => req('POST', `/api/borrower/messages/${msgId}/react`, { emoji }),
  editMessage:  (msgId, body) => req('PATCH', `/api/borrower/messages/${msgId}`, { body }),
  deleteMessage:(msgId) => req('DELETE', `/api/borrower/messages/${msgId}`),
  mentionables: (appId) => req('GET', `/api/borrower/applications/${appId}/mentionables`),
  postMessage:  (appId, body, opts = {}) => req('POST', '/api/borrower/messages', { applicationId: appId, body, ...opts }),
  readNotif:    (id) => req('POST', `/api/borrower/notifications/${id}/read`),
  uploadDoc:    (b) => req('POST', '/api/borrower/documents', normalizeUpload(b)),
  documents:    (appId) => req('GET', `/api/borrower/documents${appId ? `?applicationId=${appId}` : ''}`),
  downloadDoc:  (id) => download(`/api/borrower/documents/${id}/download`),
  // borrower completes an in-portal tool task (Rehab Budget / Track Record)
  completeTool: (appId, itemId, payload, notes) =>
    req('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/tool`, { payload, notes }),

  // reusable service contacts (title company / insurance agent)
  contacts:     (type) => req('GET', `/api/borrower/contacts${type ? `?type=${type}` : ''}`),
  saveContact:  (b) => req('POST', '/api/borrower/contacts', b),

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

  drafts:       () => req('GET', '/api/borrower/drafts'),
  createDraft:  (b) => req('POST', '/api/borrower/drafts', b),
  draft:        (id) => req('GET', `/api/borrower/drafts/${id}`),
  saveDraft:    (id, b) => req('PUT', `/api/borrower/drafts/${id}`, b),
  deleteDraft:  (id) => req('DELETE', `/api/borrower/drafts/${id}`),
  submitDraft:  (id, b) => req('POST', `/api/borrower/drafts/${id}/submit`, b),

  // ---- staff portal (loan officer / processor / underwriter / admin) ----
  staffLogin:     (email, password) => req('POST', '/auth/staff/login', { email, password }),
  staffMfaVerify: (challenge, code) => req('POST', '/auth/staff/mfa/verify', { challenge, code }),
  me:             () => req('GET', '/auth/me'),
  staffTeam:        () => req('GET', '/api/staff/team'),
  staffApplications:() => req('GET', '/api/staff/applications'),
  staffMyTasks:     () => req('GET', '/api/staff/my-tasks'),
  staffExceptions:  () => req('GET', '/api/staff/exceptions'),
  staffCreateFile:  (b) => req('POST', '/api/staff/applications', b),
  staffInviteBorrower: (appId) => req('POST', `/api/staff/applications/${appId}/invite-borrower`),
  staffLeadCapture: () => req('GET', '/api/staff/lead-capture'),
  staffApplication: (id) => req('GET', `/api/staff/applications/${id}`),
  staffChecklist:   (id) => req('GET', `/api/staff/applications/${id}/checklist`),
  staffAppDocuments:(id) => req('GET', `/api/staff/applications/${id}/documents`),
  staffReviewDoc:   (id, action, reason, opts) => req('POST', `/api/staff/documents/${id}/review`, { action, reason, ...(opts || {}) }),
  staffDownloadDoc: (id) => download(`/api/staff/documents/${id}/download`),
  staffBorrower:    (id) => req('GET', `/api/staff/borrowers/${id}`),
  staffBorrowerSsn: (id) => req('GET', `/api/staff/borrowers/${id}/ssn`),
  staffBorrowerTrackRecords: (id) => req('GET', `/api/staff/borrowers/${id}/track-records`),
  staffTrackRecordSnapshot:  (id) => req('GET', `/api/staff/borrowers/${id}/track-record/snapshot`),
  staffBorrowerLlcs: (id) => req('GET', `/api/staff/borrowers/${id}/llcs`),
  staffCreateLlc:    (borrowerId, b) => req('POST', `/api/staff/borrowers/${borrowerId}/llcs`, b),
  staffUpdateLlc:    (id, b) => req('PATCH', `/api/staff/llcs/${id}`, b),
  staffSaveLlcMembers: (id, members) => req('PUT', `/api/staff/llcs/${id}/members`, { members }),
  staffVerifyLlc:    (id, b) => req('POST', `/api/staff/llcs/${id}/verify`, b || {}),
  staffVerifyTrackRecord:    (id) => req('POST', `/api/staff/track-records/${id}/verify`),
  staffPatchItem:   (itemId, b) => req('PATCH', `/api/staff/checklist/${itemId}`, b),
  staffRequestDoc:  (appId, b) => req('POST', `/api/staff/applications/${appId}/checklist`, b),
  staffAddCondition:(appId, b) => req('POST', `/api/staff/applications/${appId}/conditions`, b),
  staffConditions:  (appId) => req('GET', `/api/staff/applications/${appId}/conditions`),
  staffActivity:    (appId) => req('GET', `/api/staff/applications/${appId}/activity`),
  staffPostClosing: (appId) => req('GET', `/api/staff/applications/${appId}/post-closing`),
  staffSeedPostClosing: (appId) => req('POST', `/api/staff/applications/${appId}/post-closing/seed`),
  staffPatchPostClosing: (pid, b) => req('PATCH', `/api/staff/post-closing/${pid}`, b),
  staffTprPreview:  (appId) => req('GET', `/api/staff/applications/${appId}/export/tpr/preview`),
  staffTprExport:   (appId) => download(`/api/staff/applications/${appId}/export/tpr`),
  staffSaveRehabBudget: (appId, payload) => req('POST', `/api/staff/applications/${appId}/rehab-budget`, { payload }),
  staffPricing:      (appId) => req('GET', `/api/staff/applications/${appId}/pricing`),
  staffPricingQuote: (appId, overrides) => req('POST', `/api/staff/applications/${appId}/pricing/quote`, { overrides }),
  staffRegisterProduct: (appId, program, overrides) => req('POST', `/api/staff/applications/${appId}/pricing/register`, { program, overrides }),
  staffUploadAppDoc: (appId, b) => req('POST', `/api/staff/applications/${appId}/documents`, normalizeUpload(b)),
  staffAddLoanCondition: (appId, b) => req('POST', `/api/staff/applications/${appId}/loan-conditions`, b),
  staffClearCondition:   (cid) => req('POST', `/api/staff/loan-conditions/${cid}/clear`),
  staffWaiveCondition:   (cid, reason) => req('POST', `/api/staff/loan-conditions/${cid}/waive`, { reason }),
  staffAssign:      (appId, b) => req('POST', `/api/staff/applications/${appId}/assign`, b),
  staffSetStatus:   (appId, status, force) => req('PATCH', `/api/staff/applications/${appId}`, force ? { status, force: true } : { status }),
  staffGating:      (appId) => req('GET', `/api/staff/applications/${appId}/gating`),
  staffStatusHistory: (appId) => req('GET', `/api/staff/applications/${appId}/status-history`),
  staffSetClosingDate: (appId, b) => req('POST', `/api/staff/applications/${appId}/closing-date`, b),
  staffEditApplication: (appId, b) => req('PATCH', `/api/staff/applications/${appId}/details`, b),
  staffNudge:          (appId) => req('POST', `/api/staff/applications/${appId}/nudge`),
  // Archive = reversible soft-remove (leaves the Archived folder); Purge =
  // permanent hard delete (row + children + stored bytes, gone from all figures).
  staffArchiveApp:  (appId, reason) => req('POST', `/api/staff/applications/${appId}/archive`, { reason }),
  staffRestoreApp:  (appId) => req('POST', `/api/staff/applications/${appId}/restore`),
  staffPurgeApp:    (appId, reason) => req('DELETE', `/api/staff/applications/${appId}`, { reason }),
  staffArchivedApps:() => req('GET', '/api/staff/archived-applications'),
  staffNotifs:      () => req('GET', '/api/staff/notifications'),
  staffLeads:       () => req('GET', '/api/staff/leads'),
  staffUpdateLead:  (id, b) => req('PATCH', `/api/staff/leads/${id}`, b),
  staffDashboard:   () => req('GET', '/api/staff/dashboard'),
  staffChatInbox:   () => req('GET', '/api/staff/chat/inbox'),
  staffReact:       (msgId, emoji) => req('POST', `/api/staff/messages/${msgId}/react`, { emoji }),
  staffPinMessage:  (msgId) => req('POST', `/api/staff/messages/${msgId}/pin`),
  staffEditMessage: (msgId, body) => req('PATCH', `/api/staff/messages/${msgId}`, { body }),
  staffDeleteMessage:(msgId) => req('DELETE', `/api/staff/messages/${msgId}`),
  staffMentionables:(appId) => req('GET', `/api/staff/applications/${appId}/mentionables`),
  adminWelcome:     (id) => req('POST', `/api/admin/staff/${id}/welcome`),
  adminResetStaffEmail: (id) => req('POST', `/api/admin/staff/${id}/reset-email`),
  adminWelcomeAll:  (all) => req('POST', '/api/admin/staff/welcome-all', { onlyWithoutLogin: !all }),
  chatInbox:        () => req('GET', '/api/borrower/chat/inbox'),
  staffMessages:    (appId, channel = 'borrower') => req('GET', `/api/staff/applications/${appId}/messages?channel=${channel}`),
  staffPostMessage: (appId, body, opts = {}) => req('POST', `/api/staff/applications/${appId}/messages`, { body, ...opts }),
  adminIntegrations:() => req('GET', '/api/admin/integrations'),

  // ---- ClickUp Control Center (admin / platform_setup) ----
  clickupHealth:    () => req('GET', '/api/admin/clickup/health'),
  clickupActivity:  () => req('GET', '/api/admin/clickup/activity'),
  clickupBackfill:  (mode, sample) => req('POST', '/api/admin/clickup/backfill', { mode, sample }),
  clickupRepush:    (appId) => req('POST', `/api/admin/clickup/file/${appId}/repush`),
  clickupRepull:    (appId) => req('POST', `/api/admin/clickup/file/${appId}/repull`),
  clickupSyncFolder:(folderId, createFiles) => req('POST', '/api/admin/clickup/sync-folder', { folderId, createFiles }),
  // self-serve: pull my own ClickUp pipeline folder into the portal
  staffSyncMyClickup: () => req('POST', '/api/staff/clickup/sync-mine'),

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
  staffAppraisalCard:(appId) => req('GET', `/api/staff/applications/${appId}/appraisal-card`),

  // ---- admin: team / staff management ----
  adminStaff:        () => req('GET', '/api/admin/staff'),
  adminCreateStaff:  (b) => req('POST', '/api/admin/staff', b),
  adminUpdateStaff:  (id, b) => req('PATCH', `/api/admin/staff/${id}`, b),
  adminSetStaffPassword: (id, password) => req('POST', `/api/admin/staff/${id}/password`, { password }),
  adminPermissionsMeta:  () => req('GET', '/api/admin/permissions-meta'),
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
};
