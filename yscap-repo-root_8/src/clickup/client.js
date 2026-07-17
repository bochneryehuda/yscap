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

// ── WO-2 (F-H1): rate-limit manners + retry contract ─────────────────────────
// Before this, call() was a single bare fetch: no timeout, no retry, and a 429
// ("slow down") was thrown as a generic error that burned a dead-letter attempt
// — so ClickUp's 100-req/min/token limit routinely turned into lost edits. This
// ports the proven SharePoint client discipline (src/lib/sharepoint.js graph()):
// honor Retry-After on 429/5xx, capped exponential backoff + jitter otherwise,
// a per-request timeout, and a per-minute token bucket that paces us UNDER the
// limit so we rarely get throttled in the first place.
//
// Division of labor: a SHORT in-call retry budget (a few quick tries) smooths
// over blips, because ClickUp writes sit behind a DURABLE Postgres queue that
// owns the long game. Errors are tagged e.retryable / e.status / e.retryAfter so
// pushOutboxOnce can retry transient failures PATIENTLY instead of dead-lettering
// a good edit during a brief outage.
const RPM = Math.max(1, parseInt(process.env.CLICKUP_MAX_RPM || '70', 10) || 70);        // pace under ClickUp's 100/min
const MAX_TRIES = Math.max(1, parseInt(process.env.CLICKUP_MAX_TRIES || '3', 10) || 3);  // short in-call budget
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.CLICKUP_TIMEOUT_MS || '20000', 10) || 20000);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;   // in-call cap; the queue owns anything longer

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient statuses worth retrying: 429 (rate limit) + 5xx. A 4xx client
 *  error (400/401/403/404) can't be fixed by retrying, so it fails fast. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** In-call wait before the next retry. Honors Retry-After (seconds) when the
 *  server sent one; otherwise capped exponential backoff. Jitter is added by the
 *  caller so this stays deterministic and testable. */
function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** Build the thrown error for a non-OK response, tagged for the queue. The
 *  message is value-free ("ClickUp POST /task/x/field/y -> 429") — never PII. */
function httpError(method, path, status, retryAfterSec) {
  const err = new Error(`ClickUp ${method} ${path} -> ${status}`);
  err.status = status;
  err.retryable = isRetryableStatus(status);
  if (retryAfterSec) err.retryAfter = retryAfterSec;
  return err;
}

// Per-process token bucket. Refills continuously at RPM/minute. Per-process (like
// the volume breaker) — multiple instances each get their own budget; a shared
// DB-backed limiter is a later refinement. Still turns "fire as fast as we can"
// into "never exceed ~RPM/min", which is the whole point.
let _tokens = RPM;
let _lastRefill = Date.now();
async function takeToken() {
  for (;;) {
    const now = Date.now();
    _tokens = Math.min(RPM, _tokens + ((now - _lastRefill) / 60000) * RPM);
    _lastRefill = now;
    if (_tokens >= 1) { _tokens -= 1; return; }
    await sleep(Math.ceil((1 - _tokens) * (60000 / RPM)));
  }
}

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function call(path, { method = 'GET', body } = {}) {
  guardNoTaskDeletion(method, path); // never delete a ClickUp file — see guard above
  const payload = body ? JSON.stringify(body) : undefined;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await takeToken(); // pre-throttle: never exceed ~RPM/min, so we rarely get 429'd
    let res;
    try {
      res = await fetchWithTimeout(`${BASE}${path}`, {
        method,
        headers: { Authorization: token(), 'Content-Type': 'application/json' },
        body: payload,
      }, TIMEOUT_MS);
    } catch (netErr) {
      // network failure / timeout / abort — transient, retryable.
      netErr.retryable = true;
      lastErr = netErr;
      if (attempt < MAX_TRIES) { await sleep(backoffMs(attempt) + Math.floor(Math.random() * 250)); continue; }
      throw netErr;
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining != null && Number(remaining) <= 5) {
      console.warn(`[clickup] rate-limit headroom low: ${remaining} left on ${method} ${path}`);
    }
    if (isRetryableStatus(res.status) && attempt < MAX_TRIES) {
      const ra = parseInt(res.headers.get('retry-after') || '0', 10);
      const wait = backoffMs(attempt, ra) + Math.floor(Math.random() * 250);
      console.warn(`[clickup] ${res.status} on ${method} ${path} — retry ${attempt}/${MAX_TRIES} in ${Math.round(wait / 1000)}s${ra ? ` (Retry-After ${ra}s)` : ''}`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = httpError(method, path, res.status, parseInt(res.headers.get('retry-after') || '0', 10) || undefined);
      err.body = data;
      throw err;
    }
    return data;
  }
  throw lastErr || new Error(`ClickUp ${method} ${path} failed after ${MAX_TRIES} attempts`);
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

// Workspaces (teams) the token can see, each with its `members[].user` (id +
// email). Read-only. Used to resolve a staffer's ClickUp numeric user id by email
// when staff_users.clickup_user_id isn't populated — so the officer/processor
// people-fields sync outbound for EVERY staffer, not only the db/045 backfilled 18.
const getTeams = () => call(`/team`);

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
  call, createTask, updateTask, setField, getFolderLists, addComment, getTeams,
  getTask, getListFields, getFilteredTeamTasks,
  addTaskToList, removeTaskFromList,
  createWebhook, listWebhooks, updateWebhook, deleteWebhook, verifyWebhookSignature,
  guardNoTaskDeletion, // exported for the safety test; the guard is enforced inside call()
  guardNoFieldClearing, guardTaskUpdatePayload, // exported for the safety tests; enforced inside setField()/updateTask()
  isRetryableStatus, backoffMs, httpError, // WO-2: exported for the retry-contract test
};
