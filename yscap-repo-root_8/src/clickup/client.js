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

async function call(path, { method = 'GET', body } = {}) {
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

const updateTask = (taskId, payload) =>
  call(`/task/${taskId}`, { method: 'PUT', body: payload });

// Set a single custom field value on a task.
const setField = (taskId, fieldId, value) =>
  call(`/task/${taskId}/field/${fieldId}`, { method: 'POST', body: { value } });

const getFolderLists = (folderId) => call(`/folder/${folderId}/list`);
const addComment = (taskId, comment_text) =>
  call(`/task/${taskId}/comment`, { method: 'POST', body: { comment_text } });

// GET a single task (custom_fields are included by default on v2).
function getTask(taskId, { customTaskIds = false, teamId } = {}) {
  const q = new URLSearchParams();
  if (customTaskIds) { q.set('custom_task_ids', 'true'); if (teamId) q.set('team_id', teamId); }
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
};
