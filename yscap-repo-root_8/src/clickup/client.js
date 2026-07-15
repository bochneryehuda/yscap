/**
 * Minimal ClickUp REST client. Token comes from the environment
 * (CLICKUP_API_TOKEN) — NEVER hardcoded, never sent from the browser.
 * All portal->ClickUp writes funnel through here.
 */
const crypto = require('crypto');
const BASE = 'https://api.clickup.com/api/v2';

function token() {
  const t = process.env.CLICKUP_API_TOKEN;
  if (!t) throw new Error('CLICKUP_API_TOKEN is not set');
  return t;
}

// ── HARD STOP: this integration may NEVER delete a ClickUp task (a loan file). ──
// Owner-directed and non-negotiable: deleting or archiving a file in the portal
// must leave the ClickUp task FULLY intact and active. ClickUp is the system of
// record — we only ever READ and UPDATE tasks there, never remove them. This
// guard lives at the single choke point every ClickUp request funnels through,
// so no code path (present, future, a refactor slip, or a copy-paste) can ever
// issue a task deletion, no matter what happens in the portal.
//
// It blocks any DELETE addressed to a specific task — the destructive
// `DELETE /task/{id}` file-delete AND `DELETE /list/{id}/task/{id}` (removing a
// file from a list). Webhook plumbing (`DELETE /webhook/{id}`) is unrelated to
// files and stays allowed. If the business ever deliberately wants a task
// removed, that must be a conscious human action outside this sync — never an
// automatic consequence of a portal change.
const TASK_PATH_RE = /(^|\/)task\/[^/?]+/; // any endpoint addressing a specific task
function guardNoTaskDeletion(method, path) {
  if (String(method).toUpperCase() !== 'DELETE') return;
  if (TASK_PATH_RE.test(String(path))) {
    const e = new Error(
      `BLOCKED: ClickUp task deletion is permanently disabled (DELETE ${path}). ` +
      `Portal file deletions never touch ClickUp — ClickUp is the system of record.`);
    e.code = 'CLICKUP_DELETE_FORBIDDEN';
    throw e;
  }
}

// ── HARD STOP 2 (owner-directed 2026-07-15, post data-loss report): this ──────
// integration may NEVER blank, clear, or wipe a ClickUp field value. A write
// whose value is empty (null / undefined / '' / empty array) IS a clear — and a
// subtler class does the same thing silently: JSON.stringify turns NaN/Infinity
// into null and DROPS undefined object keys, and a nested null (e.g. a null
// latitude) reaches ClickUp as a value it treats as a clear/garbage write. All
// of it is refused here, at the single choke point every field write funnels
// through, so no code path (present, future, a refactor slip, or a copy-paste)
// can ever erase ClickUp data. Clearing a field remains a conscious human
// action in the ClickUp UI — never something this sync does.
function findJsonUnsafe(v, path) {
  if (v === undefined) return `${path} is undefined (JSON drops it → ClickUp reads a clear)`;
  if (v === null) return `${path} is null (ClickUp reads a clear)`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `${path} is ${v} (JSON → null → ClickUp clears the field)`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const r = findJsonUnsafe(v[i], `${path}[${i}]`); if (r) return r; }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) { const r = findJsonUnsafe(v[k], `${path}.${k}`); if (r) return r; }
    return null;
  }
  return null;
}
function guardNoFieldClearing(fieldId, value) {
  const forbid = (why) => {
    const e = new Error(`BLOCKED: refusing to write field ${fieldId} — ${why}. ` +
      `The sync never clears ClickUp values; clearing is a human-only action in the ClickUp UI.`);
    e.code = 'CLICKUP_EMPTY_WRITE_FORBIDDEN';
    throw e;
  };
  if (value === null || value === undefined) forbid('value is empty (null/undefined)');
  if (typeof value === 'string' && value.trim() === '') forbid('value is an empty string');
  if (Array.isArray(value) && value.length === 0) forbid('value is an empty array (clears a users/labels field)');
  if (value && typeof value === 'object' && Array.isArray(value.add) && value.add.length === 0) forbid('users add-list is empty');
  const unsafe = findJsonUnsafe(value, 'value');
  if (unsafe) forbid(unsafe);
}

// ── HARD STOP 3: task updates may carry NOTHING but a status. The sync never ──
// renames a task and never touches its description — names/descriptions are
// human-owned deal identity (the portal sets a name only at task CREATION). An
// ALLOWLIST (not a blocklist) so any future payload key is refused by default.
const TASK_UPDATE_ALLOWED_KEYS = new Set(['status']);
function guardTaskUpdatePayload(payload) {
  const p = payload || {};
  for (const k of Object.keys(p)) {
    if (!TASK_UPDATE_ALLOWED_KEYS.has(k)) {
      const e = new Error(`BLOCKED: task update may not carry '${k}' — the sync only ever updates a task's status.`);
      e.code = 'CLICKUP_RENAME_FORBIDDEN';
      throw e;
    }
  }
  if ('status' in p && (p.status == null || String(p.status).trim() === '')) {
    const e = new Error('BLOCKED: task update with an empty status.');
    e.code = 'CLICKUP_EMPTY_WRITE_FORBIDDEN';
    throw e;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  guardNoTaskDeletion(method, path); // never delete a ClickUp file — see guard above
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: token(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`ClickUp ${method} ${path} -> ${res.status}`);
    err.status = res.status; err.body = data;
    throw err;
  }
  return data;
}

// Create a task in a given LIST (folders contain lists; resolve list at runtime/config).
const createTask = (listId, payload) =>
  call(`/list/${listId}/task`, { method: 'POST', body: payload });

const updateTask = (taskId, payload) => {
  guardTaskUpdatePayload(payload);          // status-only allowlist — never rename / never touch descriptions
  return call(`/task/${taskId}`, { method: 'PUT', body: payload });
};

// Set a single custom field value on a task. Field-clearing writes are refused
// structurally (see HARD STOP 2) — this sync can update values, never erase them.
const setField = (taskId, fieldId, value) => {
  guardNoFieldClearing(fieldId, value);
  return call(`/task/${taskId}/field/${fieldId}`, { method: 'POST', body: { value } });
};

const getFolderLists = (folderId) => call(`/folder/${folderId}/list`);
const addComment = (taskId, comment_text) =>
  call(`/task/${taskId}/comment`, { method: 'POST', body: { comment_text } });

// GET a single task (custom_fields are included by default on v2).
// includeSubtasks=true asks ClickUp to attach a shallow `subtasks[]` array
// ({id,name,status,...}) — used to locate a co-borrower profile subtask.
function getTask(taskId, { customTaskIds = false, teamId, includeSubtasks = false } = {}) {
  const q = new URLSearchParams();
  if (customTaskIds) { q.set('custom_task_ids', 'true'); if (teamId) q.set('team_id', teamId); }
  if (includeSubtasks) q.set('include_subtasks', 'true');
  const qs = q.toString();
  return call(`/task/${taskId}${qs ? `?${qs}` : ''}`);
}

// Accessible custom fields for a list — field ids, types, dropdown options.
// Feeds the live option registry (index<->uuid translation).
const getListFields = (listId) => call(`/list/${listId}/field`);

// Filtered team (workspace) tasks — the reconciliation-poll workhorse.
// params: { spaceIds[], folderIds[], listIds[], statuses[], page, includeClosed,
//           dateUpdatedGt, orderBy, customFields:[{field_id,operator,value}] }
// NOTE: on this endpoint folders are the `project_ids[]` param.
function getFilteredTeamTasks(teamId, params = {}) {
  const q = new URLSearchParams();
  (params.spaceIds  || []).forEach((id) => q.append('space_ids[]', id));
  (params.folderIds || []).forEach((id) => q.append('project_ids[]', id));
  (params.listIds   || []).forEach((id) => q.append('list_ids[]', id));
  (params.statuses  || []).forEach((s)  => q.append('statuses[]', s));
  if (params.page != null)      q.set('page', String(params.page));
  if (params.includeClosed)     q.set('include_closed', 'true');
  if (params.subtasks === false) q.set('subtasks', 'false');
  if (params.dateUpdatedGt)     q.set('date_updated_gt', String(params.dateUpdatedGt));
  if (params.orderBy)           q.set('order_by', params.orderBy);
  if (params.reverse)           q.set('reverse', 'true');
  if (params.customFields)      q.set('custom_fields', JSON.stringify(params.customFields));
  return call(`/team/${teamId}/task?${q.toString()}`);
}

// Multi-home (processor assignment ADDS without moving). Requires the
// "Tasks in Multiple Lists" ClickApp.
const addTaskToList      = (listId, taskId) => call(`/list/${listId}/task/${taskId}`, { method: 'POST' });
// NOTE: this is intentionally blocked by guardNoTaskDeletion (it is a DELETE on a
// task path). Kept only for interface symmetry with addTaskToList; the sync never
// removes a file from a list. See the HARD STOP note above.
const removeTaskFromList = (listId, taskId) => call(`/list/${listId}/task/${taskId}`, { method: 'DELETE' });

// Webhooks
const createWebhook = (teamId, body)   => call(`/team/${teamId}/webhook`, { method: 'POST', body });
const listWebhooks  = (teamId)         => call(`/team/${teamId}/webhook`);
const updateWebhook = (webhookId, body) => call(`/webhook/${webhookId}`, { method: 'PUT', body });
const deleteWebhook = (webhookId)      => call(`/webhook/${webhookId}`, { method: 'DELETE' });

/**
 * Verify a ClickUp webhook delivery. ClickUp signs the raw request body with
 * HMAC-SHA256 using the webhook secret and sends it in the `X-Signature`
 * header (hex). Constant-time compare. Uses Node's built-in crypto (no deps).
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const body = typeof rawBody === 'string' ? rawBody : (rawBody ? rawBody.toString('utf8') : '');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  call, createTask, updateTask, setField, getFolderLists, addComment,
  getTask, getListFields, getFilteredTeamTasks,
  addTaskToList, removeTaskFromList,
  createWebhook, listWebhooks, updateWebhook, deleteWebhook, verifyWebhookSignature,
  guardNoTaskDeletion, // exported for the safety test; the guard is enforced inside call()
  guardNoFieldClearing, guardTaskUpdatePayload, // exported for the safety tests; enforced inside setField()/updateTask()
};
