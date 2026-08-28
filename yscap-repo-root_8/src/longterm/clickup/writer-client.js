'use strict';
/**
 * LONG-TERM — the ClickUp WRITER's wire chokepoint.
 *
 * BY-VALUE COPY of the proven RTL guard chokepoint (src/clickup/client.js),
 * under the CLICKUP WRITER'S INHERITANCE sanction (owner, 2026-08-23 — recorded
 * in docs/LONG-TERM-AUTHORIZED-COPIES.md). A copy, not an import: this file
 * requires ZERO RTL modules. The existing src/longterm/clickup/client.js stays
 * GET-only exactly as its header promises — writing is a different decision, so
 * it lives behind its own module with the guards baked in.
 *
 * TWO DELIBERATE DEPARTURES from the RTL original, both in the SAFER direction:
 *   · NO assignment-clear carve-out. RTL carries one owner-worded exception that
 *     lets a DELETE clear two enumerated RTL money fields. That sanction is
 *     RTL-only; the Long-Term writer clears NOTHING, ever, so guardNoTaskDeletion
 *     here has no escape hatch and clearAssignmentMoneyField does not exist.
 *   · NO v3 surface at all. RTL allows exactly one v3 call (the home-list move).
 *     Long-Term makes none, so guardV3TaskPath refuses EVERY v3-shaped path —
 *     an empty allowlist, kept as a guard rather than an absence so the refusal
 *     is a refusal.
 *
 * PACING: LT self-paces (min-gap between wire calls) and NEVER touches RTL's
 * shared lib/api-rate-limit bucket — that import is a crossing the ledger does
 * not authorize. The gap takes a deliberate minority of ClickUp's 100/min token
 * budget because the RTL sync spends from the same token; the writer's volume
 * circuit breaker (push.js) bounds the total on top of this.
 */

const BASE = 'https://api.clickup.com/api/v2';

/** Long-Term's token, falling back to the shared one. Never a value in code. */
function token() {
  const t = (process.env.LT_CLICKUP_API_TOKEN || process.env.CLICKUP_API_TOKEN || '').trim();
  if (!t) throw new Error('Long-Term ClickUp is not connected — set LT_CLICKUP_API_TOKEN (or the shared CLICKUP_API_TOKEN).');
  return t;
}
function configured() {
  return !!(process.env.LT_CLICKUP_API_TOKEN || process.env.CLICKUP_API_TOKEN || '').trim();
}
function teamId() {
  return (process.env.LT_CLICKUP_TEAM_ID || process.env.CLICKUP_TEAM_ID || '9011888435').trim();
}

// ── HARD STOP 1: this writer may NEVER delete a ClickUp task (a loan file). ──
// Owner-directed and non-negotiable on the RTL side, inherited verbatim here:
// ClickUp is a system of record — Long-Term only ever READS, CREATES and
// UPDATES cards, never removes one. The guard lives at the single choke point
// every request funnels through, so no code path (present, future, a refactor
// slip, or a copy-paste) can ever issue a task deletion.
//
// It blocks any DELETE addressed to a specific task — `DELETE /task/{id}` AND
// `DELETE /list/{id}/task/{id}` (removing a card from a list). Unlike RTL,
// there is NO field-clear carve-out: the Long-Term writer clears nothing, ever.
const TASK_PATH_RE = /(^|\/)task\/[^/?]+/; // any endpoint addressing a specific task

function guardNoTaskDeletion(method, path) {
  if (String(method).toUpperCase() !== 'DELETE') return;
  if (TASK_PATH_RE.test(String(path))) {
    const e = new Error(
      `BLOCKED: ClickUp task deletion is permanently disabled (DELETE ${path}). `
      + 'Long-Term never deletes or clears anything in ClickUp.');
    e.code = 'CLICKUP_DELETE_FORBIDDEN';
    throw e;
  }
}

// ── HARD STOP 1b: NOTHING on ClickUp's v3 surface, at all. ──────────────────
// TASK_PATH_RE matches the v2 shape (`/task/{id}`); v3 addresses a task as
// `/workspaces/{n}/tasks/{id}/…`, which that regex does NOT match. RTL permits
// exactly one v3 call (the home-list move); Long-Term makes NONE, so the
// allowlist here is EMPTY — every v3-shaped path is refused whatever the verb.
const V3_TASK_PATH_RE = /(^|\/)tasks\/[^/?]+/;
function guardV3TaskPath(method, path) {
  const p = String(path);
  if (!V3_TASK_PATH_RE.test(p) && !/^\/workspaces\//.test(p)) return;
  const e = new Error(
    `BLOCKED: ${method} ${p} — the Long-Term ClickUp writer makes no v3 calls. `
    + 'Everything on v3 is refused.');
  e.code = 'CLICKUP_V3_FORBIDDEN';
  throw e;
}

// ── HARD STOP 2 (RTL owner-directed 2026-07-15, post data-loss report): this ─
// writer may NEVER blank, clear, or wipe a ClickUp field value. A write whose
// value is empty (null / undefined / '' / empty array) IS a clear — and a
// subtler class does the same thing silently: JSON.stringify turns NaN/Infinity
// into null and DROPS undefined object keys, and a nested null (e.g. a null
// latitude) reaches ClickUp as a value it treats as a clear/garbage write. All
// of it is refused here, at the single choke point every field write funnels
// through. Clearing a field remains a conscious human action in the ClickUp UI
// — never something this sync does.
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
    const e = new Error(`BLOCKED: refusing to write field ${fieldId} — ${why}. `
      + 'The sync never clears ClickUp values; clearing is a human-only action in the ClickUp UI.');
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

// ── HARD STOP 3: task updates may carry NOTHING but a status. The sync never ─
// renames a task and never touches its description — names/descriptions are
// human-owned deal identity (the writer sets a name only at task CREATION). An
// ALLOWLIST (not a blocklist) so any future payload key is refused by default.
// NOTE the writer does not call updateTask until the Long-Term status engine is
// built — the guard ships anyway, so that write is born constrained.
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

// ── Retry contract (the RTL WO-2 discipline, copied) ─────────────────────────
// A SHORT in-call retry budget smooths over blips; the Long-Term push pass owns
// the long game (a failed push is re-tried on a later pass, never dead-lettered
// silently). Errors are tagged e.retryable / e.status / e.retryAfter so the
// pass can tell transient from permanent.
const MAX_TRIES = Math.max(1, parseInt(process.env.LT_CLICKUP_MAX_TRIES || '3', 10) || 3);
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.LT_CLICKUP_TIMEOUT_MS || '20000', 10) || 20000);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient statuses worth retrying: 429 (rate limit) + 5xx. A 4xx client
 *  error (400/401/403/404) can't be fixed by retrying, so it fails fast. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** In-call wait before the next retry. Honors Retry-After (seconds) when the
 *  server sent one; otherwise capped exponential backoff. */
function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** Is it SAFE to re-send this request in-call after a transient failure? A
 *  non-idempotent POST (createTask) may have ALREADY landed before the
 *  reply/timeout, so re-issuing it makes a DUPLICATE (a second ClickUp card
 *  carrying full SSN/DOB). So:
 *   - network/timeout (status null): re-send ONLY if idempotent.
 *   - 429: ALWAYS safe — rejected before processing, nothing changed.
 *   - 5xx: ambiguous outcome → re-send ONLY if idempotent.
 *  GET/PUT and the value-idempotent setField POST pass idempotent=true and
 *  retry freely; createTask does not. Pure — unit tested. */
function inCallRetryAllowed(idempotent, status) {
  if (status == null) return !!idempotent;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return !!idempotent;
  return false;
}

/** Build the thrown error for a non-OK response, tagged for the pass. The
 *  message is value-free ("ClickUp POST /task/x/field/y -> 429") — never PII,
 *  and (stricter than RTL) NEVER the response body, which can echo the token. */
function httpError(method, path, status, retryAfterSec) {
  const err = new Error(`ClickUp ${method} ${path} -> ${status}`);
  err.status = status;
  err.retryable = isRetryableStatus(status);
  if (retryAfterSec) err.retryAfter = retryAfterSec;
  return err;
}

// ── Self-pacing (FRESH — never RTL's shared api-rate-limit bucket) ───────────
// One gap for every wire call this module makes, module-level so concurrent
// callers in one process queue behind each other. Default 900ms ≈ 66/min — the
// same minority-share doctrine as the LT read client. The push pass adds a
// bounded per-pass write budget on top; the circuit breaker bounds the total.
const MIN_GAP_MS = Math.max(200, parseInt(process.env.LT_CLICKUP_WRITER_MIN_GAP_MS
  || process.env.LT_CLICKUP_MIN_GAP_MS || '900', 10) || 900);
let nextAt = 0;
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextAt - now);
  nextAt = Math.max(now, nextAt) + MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
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

async function call(path, { method = 'GET', body, idempotent } = {}) {
  guardNoTaskDeletion(method, path); // never delete a ClickUp file — see guard above
  guardV3TaskPath(method, path);     // …and nothing on v3, at all
  const payload = body ? JSON.stringify(body) : undefined;
  // GET/PUT default to idempotent; a POST is NOT idempotent unless the caller
  // says so (setField is value-idempotent and opts in). A non-idempotent POST
  // that fails transiently is NOT re-sent in-call.
  const idem = idempotent != null ? !!idempotent : method !== 'POST';
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await pace();
    let res;
    try {
      res = await fetchWithTimeout(`${BASE}${path}`, {
        method,
        headers: { Authorization: token(), 'Content-Type': 'application/json' },
        body: payload,
      }, TIMEOUT_MS);
    } catch (netErr) {
      netErr.retryable = true;
      lastErr = netErr;
      if (inCallRetryAllowed(idem, null) && attempt < MAX_TRIES) { await sleep(backoffMs(attempt) + Math.floor(Math.random() * 250)); continue; }
      throw netErr;
    }
    if (inCallRetryAllowed(idem, res.status) && !res.ok && attempt < MAX_TRIES) {
      const ra = parseInt(res.headers.get('retry-after') || '0', 10);
      const wait = backoffMs(attempt, ra) + Math.floor(Math.random() * 250);
      console.warn(`[lt-clickup-writer] ${res.status} on ${method} ${path} — retry ${attempt}/${MAX_TRIES} in ${Math.round(wait / 1000)}s${ra ? ` (Retry-After ${ra}s)` : ''}`);
      await sleep(wait);
      continue;
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // The body is read (so the socket drains) and DROPPED — an error echo can
      // carry the token or the value back, and neither belongs in a log line.
      throw httpError(method, path, res.status, parseInt(res.headers.get('retry-after') || '0', 10) || undefined);
    }
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    return data;
  }
  throw lastErr || new Error(`ClickUp ${method} ${path} failed after ${MAX_TRIES} attempts`);
}

// ── The write surface (each goes through call() and therefore every guard) ───

// Create a task in a given LIST (folders contain lists; the create flow
// resolves the officer's folder, then its first list).
const createTask = (listId, payload) =>
  call(`/list/${listId}/task`, { method: 'POST', body: payload });

// Status-only, and unused until the Long-Term status engine lands — see G3.
const updateTask = (taskId, payload) => {
  guardTaskUpdatePayload(payload);
  return call(`/task/${taskId}`, { method: 'PUT', body: payload });
};

// Set a single custom field value on a task. Field-clearing writes are refused
// structurally (HARD STOP 2) — this sync can update values, never erase them.
const setField = (taskId, fieldId, value) => {
  guardNoFieldClearing(fieldId, value);
  // Value-idempotent: writing the same value twice is a no-op, so this POST is
  // safe to re-send on a transient failure (unlike createTask).
  return call(`/task/${taskId}/field/${fieldId}`, { method: 'POST', body: { value }, idempotent: true });
};

// GET a single task (custom_fields are included by default on v2) — the
// pre-write read every push starts from. includeSubtasks asks ClickUp to
// attach the shallow subtasks[] array ({id, name, …}) — how the co-borrower
// profile subtask is found.
function getTask(taskId, { includeSubtasks = false } = {}) {
  const qs = includeSubtasks ? '?include_subtasks=true' : '';
  return call(`/task/${encodeURIComponent(String(taskId))}${qs}`);
}

// Accessible custom fields for a list — field ids, types, dropdown options.
// Feeds the live option registry (index<->uuid translation).
const getListFields = (listId) => call(`/list/${listId}/field`);

// A folder's lists — the create flow lands the task in the first one.
const getFolderLists = (folderId) => call(`/folder/${folderId}/list`);

// One list, WITH its configured statuses (statuses are LIST-level on this
// workspace) — consulted before a create ever passes an explicit status.
const getList = (listId) => call(`/list/${listId}`);

// Workspaces (teams) the token can see, each with its members[].user (id +
// email). Read-only; used to resolve a staffer's ClickUp numeric user id by
// email when no stored id exists.
const getTeams = () => call(`/team`);

module.exports = {
  configured, teamId,
  call, createTask, updateTask, setField, getTask, getListFields, getFolderLists, getList, getTeams,
  guardNoTaskDeletion, guardV3TaskPath,           // exported for the safety tests; both enforced inside call()
  guardNoFieldClearing, guardTaskUpdatePayload,   // exported for the safety tests; enforced inside setField()/updateTask()
  isRetryableStatus, backoffMs, httpError, inCallRetryAllowed,
  MIN_GAP_MS,
};
