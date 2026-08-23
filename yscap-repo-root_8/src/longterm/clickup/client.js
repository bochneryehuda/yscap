'use strict';
/**
 * LONG-TERM'S OWN CLICKUP CLIENT — same workspace, same credentials, separate code.
 *
 * WHY A SECOND CLIENT AT ALL. Product separation: Long-Term may not import RTL code,
 * and the RTL client carries RTL's whole write surface — task updates, field writes,
 * list moves, webhooks — none of which Long-Term is authorized to do. Long-Term gets
 * the same arrangement it has for Encompass: its own thin client, reading the same
 * credentials from the environment. The crossing that IS authorized (2026-08-23,
 * recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md) is the two pure-data modules —
 * the tenant's field ids and the officer/folder map — because those are facts about
 * the workspace rather than RTL behaviour, and a second hand-kept copy of a hundred
 * ids is a copy that drifts.
 *
 * THE CREDENTIALS ARE THE SAME ONES, NAMED NOT COPIED. `LT_CLICKUP_API_TOKEN` falls
 * back to the shared `CLICKUP_API_TOKEN`, exactly as `LT_ENCOMPASS_*` falls back to
 * `ENCOMPASS_*`. No secret VALUE appears here or anywhere else in the repository —
 * only the names. A tenant that later wants Long-Term on its own ClickUp login sets
 * the LT_ vars and nothing else changes.
 *
 * READ-ONLY, AND STRUCTURALLY SO. Every method here is a GET, and `call()` refuses
 * any other verb before a request is built. That is not caution for its own sake:
 * the reconciliation this client was written for only ever READS, and the one write
 * that is coming — stamping the portal file id onto a task once a human has
 * confirmed the match — is a different decision that deserves its own guard, its own
 * authorization and its own test rather than arriving quietly inside a client that
 * was already allowed to write. When that lands, it goes through ONE named function
 * with the write allowlisted by path, mirroring `flood-order.js` on the Encompass
 * side.
 *
 * IT PACES ITSELF, AND DELIBERATELY TAKES THE SMALLER SHARE. ClickUp's limit is per
 * TOKEN, and this is the same token the RTL sync uses — so the budget is shared even
 * though the code is not. Long-Term could have reached for RTL's shared bucket, and
 * that is a crossing the ledger does not authorize; the honest alternative is not to
 * need it. A reconciliation read is a handful of pages that nobody is waiting on, so
 * it runs at a rate that stays out of RTL's way even when RTL is at full tilt, and
 * backs off on ClickUp's own `Retry-After` when it is wrong about that. Being slow
 * here costs seconds; 429-ing the live sync costs a file not reaching a card.
 */

const BASE = 'https://api.clickup.com/api/v2';

/** Long-Term's token, falling back to the shared one. Never a value in code. */
function token() {
  return (process.env.LT_CLICKUP_API_TOKEN || process.env.CLICKUP_API_TOKEN || '').trim();
}

/** The workspace. Defaulted to the tenant's own, overridable without a deploy. */
function teamId() {
  return (process.env.LT_CLICKUP_TEAM_ID || process.env.CLICKUP_TEAM_ID || '9011888435').trim();
}

/**
 * The space the loan files live in.
 *
 * VERIFIED AGAINST THE LIVE WORKSPACE 2026-08-23: there are exactly two spaces —
 * CRM & SALES and Loan Pipeline — and NO separate long-term space. Both products'
 * files sit in this one space, in the same per-officer folders, told apart by the
 * *Program dropdown. So this is the same space id RTL uses, and that is correct
 * rather than a copy-paste: it is where the loans are.
 */
function pipelineSpace() {
  return (process.env.LT_CLICKUP_PIPELINE_SPACE || process.env.CLICKUP_PIPELINE_SPACE || '90113223301').trim();
}

function configured() { return !!token(); }

/**
 * WHY A METHOD ARGUMENT EXISTS AT ALL when every caller is a GET: so the refusal is
 * a REFUSAL rather than an absence. A client that simply has no write function
 * quietly becomes writable the day somebody adds one; a client that throws on the
 * attempt has to be argued with first.
 */
function assertReadOnly(method) {
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') {
    throw new Error(
      `Long-Term's ClickUp client is read-only — refused ${m}. `
      + 'The portal-file-id stamp is the one write planned, and it needs its own '
      + 'guarded function and the owner\'s authorization, not a general write path.');
  }
}

const TIMEOUT_MS = parseInt(process.env.LT_CLICKUP_TIMEOUT_MS || '20000', 10);

// ClickUp allows 100 requests a minute per token. Long-Term takes a deliberate
// minority of that (default one request every 900ms, so ~66/min) because the RTL
// sync is spending from the same budget and is the one with a person waiting on it.
const MIN_GAP_MS = parseInt(process.env.LT_CLICKUP_MIN_GAP_MS || '900', 10);
const MAX_RETRIES = 4;
let nextAt = 0;

/** Space calls out, in this process, without a shared bucket to reach for. */
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextAt - now);
  nextAt = Math.max(now, nextAt) + MIN_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Sleep, kept separate so the retry path reads as what it is. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET' } = {}) {
  assertReadOnly(method);
  if (!configured()) {
    throw new Error('Long-Term ClickUp is not connected — set LT_CLICKUP_API_TOKEN (or the shared CLICKUP_API_TOKEN).');
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    await pace();
    try {
      return await once(path);
    } catch (e) {
      lastErr = e;
      // 429 is the shared budget telling us RTL got there first, and 5xx is
      // ClickUp having a moment. Both are worth waiting out; a 4xx is not — it
      // will say the same thing however many times it is asked.
      const status = e && e.status;
      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt === MAX_RETRIES) throw e;
      const after = Number(e.retryAfterSec) > 0 ? Number(e.retryAfterSec) * 1000 : 0;
      await sleep(after || Math.min(8000, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

async function once(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: token(), Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // The body can carry the token back in an error echo, so it is never included.
    const err = new Error(`ClickUp GET ${path} failed (HTTP ${res.status})`);
    err.status = res.status;
    const ra = res.headers && res.headers.get && res.headers.get('retry-after');
    if (ra) err.retryAfterSec = Number(ra) || 0;
    throw err;
  }
  try { return text ? JSON.parse(text) : {}; } catch (_) {
    throw new Error(`ClickUp GET ${path} returned something that is not JSON`);
  }
}

/**
 * ONE PAGE OF THE WORKSPACE'S TASKS, scoped to the loan-file space.
 *
 * This is the endpoint that makes the whole reconciliation possible: v2's team-task
 * read returns `custom_fields` INLINE, so one call brings back a hundred tasks with
 * their YS loan number, program, amount and address attached. Reading them one at a
 * time would be thousands of calls and, through some clients, would not return the
 * custom fields at all.
 *
 * `subtasks:false` because a loan file is a top-level task; `includeClosed` because
 * the closed files are exactly the ones the owner expects to match cleanly on the
 * loan number.
 */
function pipelineTasksPage(page = 0, { includeClosed = true, spaceIds = null } = {}) {
  const q = new URLSearchParams();
  (spaceIds || [pipelineSpace()]).forEach((id) => q.append('space_ids[]', id));
  q.set('page', String(page));
  q.set('subtasks', 'false');
  if (includeClosed) q.set('include_closed', 'true');
  return call(`/team/${teamId()}/task?${q.toString()}`);
}

/** A single task, for spot-checking one file rather than the whole book. */
function getTask(taskId) {
  return call(`/task/${encodeURIComponent(String(taskId))}`);
}

/** Is the connection alive? Answers, never throws — screens call this. */
async function ping() {
  if (!configured()) {
    return { ok: false, reason: 'Long-Term ClickUp is not connected — set LT_CLICKUP_API_TOKEN (or the shared CLICKUP_API_TOKEN).' };
  }
  try {
    const out = await call(`/team/${teamId()}/space?archived=false`);
    const spaces = (out && out.spaces) || [];
    return { ok: true, spaces: spaces.length, teamId: teamId(), pipelineSpace: pipelineSpace() };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

module.exports = {
  configured,
  teamId,
  pipelineSpace,
  pipelineTasksPage,
  getTask,
  ping,
  READ_ONLY: true,
  _internals: { assertReadOnly, call, pace, MIN_GAP_MS },
};
