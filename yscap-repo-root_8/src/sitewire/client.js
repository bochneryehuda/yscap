'use strict';
/**
 * Sitewire REST client. The 3-header token pair (access-token + client + uid) comes
 * from the environment (SITEWIRE_*) — NEVER hardcoded, never from the browser. Every
 * portal->Sitewire call funnels through call(), which ports the proven ClickUp client
 * discipline: a per-minute token bucket, capped exponential backoff + jitter, a
 * per-request timeout, retry-only-on-transient (429/5xx/network), and errors tagged
 * e.status / e.retryable / e.retryAfter so the durable queue owns the long game.
 *
 * Write safety: a DRY-RUN gate (SITEWIRE_DRYRUN) logs the exact body and sends nothing;
 * guardNoUnsafeWrite refuses any body JSON would turn into a field-clearing null; the
 * draw transition endpoints are an ALLOWLIST. Business-rule 422s are surfaced (never
 * retried) so the orchestrator can park them for review.
 */
const cfg = require('../config');
const switches = require('../lib/integrations/switches'); // runtime on/off (env default unless flipped)
const T = require('./transforms');

function base() { return cfg.sitewireBaseUrl || 'https://app.sitewire.co'; }
function authHeaders() {
  const at = cfg.sitewireAccessToken, cl = cfg.sitewireClient, uid = cfg.sitewireUid;
  if (!at || !cl || !uid) throw new Error('SITEWIRE_ACCESS_TOKEN / SITEWIRE_CLIENT / SITEWIRE_UID are not all set');
  return { 'access-token': at, client: cl, uid, 'Content-Type': 'application/json', Accept: 'application/json' };
}

const RPM = Math.max(1, parseInt(process.env.SITEWIRE_MAX_RPM || '90', 10) || 90);
const MAX_TRIES = Math.max(1, parseInt(process.env.SITEWIRE_MAX_TRIES || '3', 10) || 3);
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.SITEWIRE_TIMEOUT_MS || '25000', 10) || 25000);
const BASE_BACKOFF_MS = 500, MAX_BACKOFF_MS = 8000, RETRY_AFTER_MAX_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryableStatus(s) { return s === 429 || (s >= 500 && s <= 599); } // IN-CALL retry (idempotent GET/PATCH only)
// Worker-facing OUTAGE classification (sets err.retryable, read by the durable queue in sitewire-sync.js):
// a systemic/transient condition the queue should retry PATIENTLY (600s, dead ≈7h) rather than dead-letter
// fast (8 attempts). Broader than in-call: a 401/403 is usually an expired/rotated token — fixed by an env
// update + restart — so every in-flight money job should WAIT for it, not dead-letter; 408/409/425 are
// transient timeout/conflict/too-early. A true bad-value (400/422) is handled by the orchestrator (parked),
// so it never reaches here as a thrown httpError.
function isOutageStatus(s) { return isRetryableStatus(s) || s === 401 || s === 403 || s === 408 || s === 409 || s === 425; }
function backoffMs(attempt, retryAfterSec) {
  // Honor a server-requested Retry-After up to a higher ceiling than our own backoff cap — if
  // Sitewire asks for 30s and we only wait 8s we'd just re-hit the 429 (audit note E-API-429).
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, RETRY_AFTER_MAX_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}
function httpError(method, path, status, retryAfterSec, body) {
  const err = new Error(`Sitewire ${method} ${path} -> ${status}`);
  err.status = status; err.retryable = isOutageStatus(status);
  if (retryAfterSec) err.retryAfter = retryAfterSec;
  if (body !== undefined) err.body = body;
  return err;
}

let _tokens = RPM, _lastRefill = Date.now();
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
  // Read the body UNDER the same timeout/abort. If we cleared the timer the instant headers arrived,
  // a stalled/half-open response body (200 headers then a hung read) would block `res.text()` forever
  // and freeze the worker's drain loop. Reading here keeps the abort armed across the whole exchange;
  // a body stall becomes a retryable AbortError, never a hang.
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    return { res, text };
  } finally { clearTimeout(timer); }
}

// ---- write guards ----
// Refuse any write body JSON would turn into a field-clearing null / NaN (mirror ClickUp).
function guardNoUnsafeWrite(path, body) {
  const unsafe = T.findJsonUnsafe(body, 'body');
  if (unsafe) {
    const e = new Error(`BLOCKED: refusing Sitewire write ${path} — ${unsafe}. The sync never sends a clearing/garbage value.`);
    e.code = 'SITEWIRE_UNSAFE_WRITE'; throw e;
  }
}
const DRAW_TRANSITIONS = new Set(['approve', 'amend', 'reopen']); // reject is capital-partner-only; never ours

async function call(path, { method = 'GET', body, noRetry = false, allowNulls = false } = {}) {
  const isWrite = method !== 'GET';
  // Default: refuse a body containing null / undefined / NaN — a Sitewire field wiped with null
  // is almost always a bug. Opt-in `allowNulls:true` skips the guard for a specific KNOWN-CLEARING
  // call (e.g. quick_notify_status_id=null per the swagger PATCH /draws example). Never a blanket
  // "trust me" — every caller that opts in owns the safety of that specific write.
  if (isWrite && body !== undefined && !allowNulls) guardNoUnsafeWrite(path, body);
  // DRY-RUN: log the exact write and send nothing (reads still go through).
  if (isWrite && cfg.sitewireDryrun) {
    console.warn(`[sitewire][DRYRUN] would ${method} ${path} body=${body ? JSON.stringify(body) : '(none)'}`);
    return { __dryrun: true };
  }
  // Defense-in-depth: the outbound write gate is enforced at every caller, but also fail-closed HERE
  // so a future write path that forgets the check can never send a live write while OUTBOUND is off.
  if (isWrite && !switches.on('SITEWIRE_OUTBOUND_ENABLED')) {
    const e = new Error(`SITEWIRE_OUTBOUND_DISABLED: refusing ${method} ${path} — writes are gated off`);
    e.code = 'SITEWIRE_OUTBOUND_DISABLED'; throw e;
  }
  // A non-idempotent POST must NOT be retried in-call: the first attempt may have COMMITTED
  // server-side before the response/connection was lost, so a retry would create a DUPLICATE
  // (Sitewire doesn't dedupe on loan_number). Fail fast + retryable; the durable queue re-drives
  // through the G-DUPEPROP-guarded birth path. PATCH/GET stay retryable (idempotent) — EXCEPT a
  // budget PATCH that carries id-LESS job-item creates (noRetry): the verb is idempotent but the
  // payload is NOT — a create sub-item has no id, so a lost-response in-call retry re-sends it and
  // Sitewire makes a DUPLICATE line (the "Exterior of House Photos appears twice" class). Those
  // re-drive through the durable queue, which then hits the read-before-write adopt path instead of
  // blindly re-creating in-call.
  const retryInCall = method !== 'POST' && !noRetry;
  const payload = body ? JSON.stringify(body) : undefined;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await takeToken();
    let res, text;
    try {
      ({ res, text } = await fetchWithTimeout(`${base()}${path}`, { method, headers: authHeaders(), body: payload }, TIMEOUT_MS));
    } catch (netErr) {
      // AbortError (connect/header/body timeout) or a network error — both retryable (idempotent calls).
      netErr.retryable = true; lastErr = netErr;
      if (attempt < MAX_TRIES && retryInCall) { await sleep(backoffMs(attempt) + Math.floor(Math.random() * 250)); continue; }
      throw netErr;
    }
    if (isRetryableStatus(res.status) && attempt < MAX_TRIES && retryInCall) {
      const ra = parseInt(res.headers.get('retry-after') || '0', 10);
      await sleep(backoffMs(attempt, ra) + Math.floor(Math.random() * 250));
      continue;
    }
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    // 304 NOT MODIFIED is a SUCCESS, not a failure. We never send conditional-request headers
    // (If-None-Match / If-Modified-Since), so Sitewire returns 304 only to say "already in this
    // state — nothing to change": re-assigning the SAME borrower email on a re-push, or re-sending
    // an unchanged field. Treating any non-2xx as an error made that no-op look like a real failure
    // and PARK it (owner-reported: "could not assign borrower … (Sitewire 304)"). `res.ok` is false
    // for 304, so this MUST come before the throw below. Chokepoint fix — every write path benefits.
    if (res.status === 304) return (data && typeof data === 'object' && !Array.isArray(data)) ? { ...data, __unchanged: true } : { __unchanged: true };
    if (!res.ok) throw httpError(method, path, res.status, parseInt(res.headers.get('retry-after') || '0', 10) || undefined, data);
    return data;
  }
  throw lastErr || new Error(`Sitewire ${method} ${path} failed after ${MAX_TRIES} attempts`);
}

// ---- reads ----
const listProperties = () => call('/api/v2/properties');
const getProperty = (id) => call(`/api/v2/properties/${id}`);
const getBudget = (id) => call(`/api/v2/budgets/${id}`);
const listDraws = () => call('/api/v2/draws');
const getDraw = (id) => call(`/api/v2/draws/${id}`);
const getRequest = (id) => call(`/api/v2/requests/${id}`);
const listCapitalPartners = () => call('/api/v2/capital_partners');
const getLender = (id) => call(`/api/v2/lenders/${id}`);
const listQuickNotifyStatuses = () => call('/api/v2/quick_notify_statuses');

// ---- writes (lender_owner) ----
const createProperty = (property) => call('/api/v2/properties', { method: 'POST', body: { property } });
const updateProperty = (id, property) => call(`/api/v2/properties/${id}`, { method: 'PATCH', body: { property } });
const assignBorrower = (id, contactEmail) => call(`/api/v2/properties/${id}/borrower`, { method: 'PATCH', body: { borrower: { contact_email: contactEmail } } });
const updateBudget = (id, budget) => {
  // A budget PATCH that carries any id-LESS create sub-item is NOT safe to retry in-call (a lost
  // response would re-send the create and duplicate the line). Disable the in-call retry for those;
  // the durable queue re-drives them through the read-before-write adopt path. A pure update/delete
  // batch (every job_item has an id) stays idempotent and retryable.
  const hasIdlessCreate = Array.isArray(budget && budget.job_items) && budget.job_items.some((j) => j && j.id == null && !j._destroy);
  return call(`/api/v2/budgets/${id}`, { method: 'PATCH', body: { budget }, noRetry: hasIdlessCreate });
};
const updateRequest = (id, request) => call(`/api/v2/requests/${id}`, { method: 'PATCH', body: { request } });
const updateDraw = (id, draw, opts = {}) => call(`/api/v2/draws/${id}`, { method: 'PATCH', body: { draw }, allowNulls: !!opts.allowNulls });
function drawTransition(id, action) {
  if (!DRAW_TRANSITIONS.has(action)) {
    const e = new Error(`BLOCKED: unsupported draw transition '${action}' (allowed: approve/amend/reopen).`);
    e.code = 'SITEWIRE_BAD_TRANSITION'; throw e;
  }
  return call(`/api/v2/draws/${id}/${action}`, { method: 'PATCH' });
}
const createQuickNotifyStatus = (lenderId, name) => call(`/api/v2/quick_notify_statuses?lender_id=${lenderId}`, { method: 'POST', body: { quick_notify_status: { name } } });

module.exports = {
  call, isRetryableStatus, backoffMs, httpError, guardNoUnsafeWrite,
  listProperties, getProperty, getBudget, listDraws, getDraw, getRequest,
  listCapitalPartners, getLender, listQuickNotifyStatuses,
  createProperty, updateProperty, assignBorrower, updateBudget, updateRequest,
  updateDraw, drawTransition, createQuickNotifyStatus, DRAW_TRANSITIONS,
};
