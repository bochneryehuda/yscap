/**
 * Minimal ClickUp REST client. Token comes from the environment
 * (CLICKUP_API_TOKEN) — NEVER hardcoded, never sent from the browser.
 * All portal->ClickUp writes funnel through here.
 */
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

module.exports = { call, createTask, updateTask, setField, getFolderLists, addComment };
