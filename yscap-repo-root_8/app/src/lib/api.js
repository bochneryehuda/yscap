/* Thin fetch wrapper. Token lives in localStorage; every call is same-origin
   against the Express backend (/auth, /api/borrower). */
const KEY = 'ys_portal_token';
export const getToken = () => localStorage.getItem(KEY) || '';
export const setToken = (t) => t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY);
export const clearToken = () => localStorage.removeItem(KEY);

// Fetch a binary document with the auth header and hand back a blob + filename.
// (A plain <a href> can't send the Bearer token, so downloads go through fetch.)
async function download(path) {
  const t = getToken();
  const res = await fetch(path, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!res.ok) {
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    throw new Error((data && data.error) || `HTTP ${res.status}`);
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

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
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
  applications: () => req('GET', '/api/borrower/applications'),
  application:  (id) => req('GET', `/api/borrower/applications/${id}`),
  checklist:    (id) => req('GET', `/api/borrower/applications/${id}/checklist`),
  notifications:() => req('GET', '/api/borrower/notifications'),
  messages:     (appId) => req('GET', `/api/borrower/messages?applicationId=${appId}`),
  postMessage:  (appId, body) => req('POST', '/api/borrower/messages', { applicationId: appId, body }),
  readNotif:    (id) => req('POST', `/api/borrower/notifications/${id}/read`),
  uploadDoc:    (b) => req('POST', '/api/borrower/documents', b),
  documents:    (appId) => req('GET', `/api/borrower/documents${appId ? `?applicationId=${appId}` : ''}`),
  downloadDoc:  (id) => download(`/api/borrower/documents/${id}/download`),
  // borrower completes an in-portal tool task (Rehab Budget / Track Record)
  completeTool: (appId, itemId, payload, notes) =>
    req('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/tool`, { payload, notes }),

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
  staffLeadCapture: () => req('GET', '/api/staff/lead-capture'),
  staffApplication: (id) => req('GET', `/api/staff/applications/${id}`),
  staffChecklist:   (id) => req('GET', `/api/staff/applications/${id}/checklist`),
  staffAppDocuments:(id) => req('GET', `/api/staff/applications/${id}/documents`),
  staffDownloadDoc: (id) => download(`/api/staff/documents/${id}/download`),
  staffBorrower:    (id) => req('GET', `/api/staff/borrowers/${id}`),
  staffBorrowerSsn: (id) => req('GET', `/api/staff/borrowers/${id}/ssn`),
  staffPatchItem:   (itemId, b) => req('PATCH', `/api/staff/checklist/${itemId}`, b),
  staffRequestDoc:  (appId, b) => req('POST', `/api/staff/applications/${appId}/checklist`, b),
  staffAddCondition:(appId, b) => req('POST', `/api/staff/applications/${appId}/conditions`, b),
  staffAssign:      (appId, b) => req('POST', `/api/staff/applications/${appId}/assign`, b),
  staffSetStatus:   (appId, status) => req('PATCH', `/api/staff/applications/${appId}`, { status }),
  staffNotifs:      () => req('GET', '/api/staff/notifications'),
  staffLeads:       () => req('GET', '/api/staff/leads'),
  staffUpdateLead:  (id, b) => req('PATCH', `/api/staff/leads/${id}`, b),
  staffDashboard:   () => req('GET', '/api/staff/dashboard'),
  staffMessages:    (appId) => req('GET', `/api/staff/applications/${appId}/messages`),
  staffPostMessage: (appId, body) => req('POST', `/api/staff/applications/${appId}/messages`, { body }),
  adminIntegrations:() => req('GET', '/api/admin/integrations'),

  // ---- admin: team / staff management ----
  adminStaff:        () => req('GET', '/api/admin/staff'),
  adminCreateStaff:  (b) => req('POST', '/api/admin/staff', b),
  adminUpdateStaff:  (id, b) => req('PATCH', `/api/admin/staff/${id}`, b),
  adminSetStaffPassword: (id, password) => req('POST', `/api/admin/staff/${id}/password`, { password }),
  adminTestEmail:    (to) => req('POST', '/api/admin/test-email', { to }),
  roster:            () => req('GET', '/api/roster'),
};
