'use strict';
/**
 * src/elementix/client.js — the ONLY module that talks to Elementix.
 *
 * READ-ONLY BY DESIGN. Elementix is a public-records database; PILOT reads it and
 * never writes to it, so unlike the Sitewire/ClickUp clients there is no outbound
 * write switch, no write journal and no PII overwrite shield — there is nothing
 * to overwrite. The guard rails that DO apply:
 *
 *   - master switch ELEMENTIX_ENABLED (default off) + ELEMENTIX_DRYRUN, both
 *     flippable live from the API Health page;
 *   - a local token bucket, because the platform ceiling of 1,000 requests/hour
 *     is shared by the WHOLE organization across every connected client — every
 *     officer's browser session and every background job draw from one bucket, so
 *     a batch job that ignores it starves the person on the phone. Self-capped
 *     far below, the same discipline as src/trustpoint/client.js;
 *   - the PAID contact enrichment is refused unless the caller explicitly says
 *     it means to spend money. See PAID_TOOLS below.
 *
 * TRANSPORT. MCP over Streamable HTTP: JSON-RPC 2.0 posted to one endpoint, with
 * an `initialize` handshake first and a session id carried in the Mcp-Session-Id
 * header. A server may answer either `application/json` or an SSE stream, so both
 * are parsed — assuming JSON is the mistake that makes this look flaky.
 *
 * Auth is src/elementix/oauth.js. Nothing here mints or refreshes a token.
 */

const cfg = require('../config');
const flags = require('../lib/flags');
const oauth = require('./oauth');

const URL_OF = () => String(cfg.elementix.url || '').replace(/\/+$/, '');

/**
 * Tools that COST MONEY. `submit_contact_enrichment`'s own description says
 * "Credits will be charged unless the person is already unlocked. This is a
 * premium feature." So it is refused unless the caller passes
 * `{ allowPaid: true }`, which only ever comes from a route handling a
 * deliberate per-person human click — never from a sweep, a batch or a retry.
 */
const PAID_TOOLS = new Set(['submit_contact_enrichment']);

function enabled() { return flags.enabled('ELEMENTIX_ENABLED', cfg.elementix.enabled); }
function dryrun() { return flags.enabled('ELEMENTIX_DRYRUN', cfg.elementix.dryrun); }
function available() { return !!URL_OF(); }

// ---------------------------------------------------------------------------
// Token bucket — per-second smoothing plus an hourly ceiling.
// ---------------------------------------------------------------------------

let secStamps = [];
let hourStamps = [];

function bucketState() {
  const now = Date.now();
  secStamps = secStamps.filter((t) => now - t < 1000);
  hourStamps = hourStamps.filter((t) => now - t < 3600000);
  return { now, perSec: secStamps.length, perHour: hourStamps.length };
}

/**
 * Returns null when there is room, else a plain reason we are holding back.
 *
 * IN-MEMORY, and therefore PER-INSTANCE: with N instances the self-cap is really
 * N × maxPerHour, and it resets to zero on every deploy. `overBudgetShared()` is
 * the cross-instance version and is what `callTool` uses; this stays as the
 * cheap local smoothing and as the fallback when the ledger cannot be read.
 */
function overBudget() {
  const { perHour } = bucketState();
  const maxHour = Math.max(1, Number(cfg.elementix.maxPerHour) || 400);
  if (perHour >= maxHour) {
    return `PILOT has used its hourly Elementix allowance (${maxHour}). The platform limit of 1,000/hour `
         + 'is shared by everyone, so this pauses rather than starving the team. Try again shortly.';
  }
  return null;
}

/**
 * The SHARED hourly count, read from the ledger so every instance and every
 * restart draw from one number — the platform's 1,000/hour belongs to the whole
 * organization, and a per-process cap that forgets itself is not a cap.
 *
 * FAILS OPEN, deliberately, and the asymmetry with the money cap is the point:
 * an unreadable ledger here costs at most a throughput overshoot against a limit
 * the vendor enforces anyway, while refusing every lookup would take the feature
 * down over a bookkeeping hiccup. The MONEY cap fails CLOSED, because there the
 * expensive direction is spending what we cannot count.
 */
async function overBudgetShared() {
  const local = overBudget();
  if (local) return local;
  try {
    const db = require('../db');
    const maxHour = Math.max(1, Number(cfg.elementix.maxPerHour) || 400);
    const r = await db.query(
      `SELECT count(*)::int AS n FROM elementix_calls WHERE created_at >= now() - interval '1 hour'`);
    const n = (r.rows[0] && r.rows[0].n) || 0;
    if (n >= maxHour) {
      return `PILOT has used its hourly Elementix allowance (${maxHour}) across every instance. The platform `
           + 'limit of 1,000/hour is shared by everyone, so this pauses rather than starving the team. Try again shortly.';
    }
  } catch (_) { /* fails open — see above */ }
  return null;
}

/**
 * Record a call. THE CLIENT IS THE ONLY MODULE THAT TALKS TO ELEMENTIX, so it is
 * the only one that records — a second writer would double-count the very number
 * the hourly guard reads. Best-effort for a FREE call: losing a bookkeeping row
 * must never fail a lookup. (A PAID call is recorded by `recordPaid` BEFORE it
 * happens, and that one is not best-effort.)
 */
async function recordCall(tool, opts, out) {
  try {
    const db = require('../db');
    await db.query(
      `INSERT INTO elementix_calls (tool, paid, staff_id, ok, detail) VALUES ($1,false,$2::uuid,$3,$4)`,
      [tool, (opts && opts.staffId) || null, !!(out && out.ok),
        out && out.ok ? null : String((out && out.detail) || '').slice(0, 300)]);
  } catch (_) { /* the lookup is the point */ }
}

async function throttle() {
  const maxSec = Math.max(1, Number(cfg.elementix.maxPerSec) || 3);
  for (;;) {
    const { now, perSec } = bucketState();
    if (perSec < maxSec) { secStamps.push(now); hourStamps.push(now); return; }
    await new Promise((r) => setTimeout(r, 120));
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

let session = { id: null, initialized: false, url: null };

let rpcId = 0;
function nextId() { rpcId += 1; return rpcId; }

/**
 * A server may reply with a JSON body or an SSE stream carrying the same
 * envelope. Pull the JSON-RPC response out of either.
 */
function parseRpcBody(text, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const raw = String(text || '');
  if (ct.includes('text/event-stream') || /^\s*(event|data):/m.test(raw)) {
    let found = null;
    for (const line of raw.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1].trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        // Keep the last envelope that looks like a result/error for our call.
        if (j && (Object.prototype.hasOwnProperty.call(j, 'result') || j.error)) found = j;
      } catch (_) { /* a partial or non-JSON frame — skip it */ }
    }
    return found;
  }
  try { return JSON.parse(raw); } catch (_) { return null; }
}

const HTTP_TIMEOUT_MS = 30000;

async function post(body, token, tokenType) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `${tokenType || 'Bearer'} ${token}`,
    };
    if (session.id) headers['mcp-session-id'] = session.id;
    const r = await fetch(URL_OF(), { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const sid = r.headers.get('mcp-session-id');
    if (sid) session.id = sid;
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type'), envelope: parseRpcBody(text, r.headers.get('content-type')), text };
  } finally {
    clearTimeout(t);
  }
}

/** Handshake. Cached per process; re-run when the server forgets our session. */
async function ensureSession(token, tokenType) {
  if (session.initialized && session.url === URL_OF()) return { ok: true };
  session = { id: null, initialized: false, url: URL_OF() };

  const res = await post({
    jsonrpc: '2.0', id: nextId(), method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'PILOT by YS Capital', version: '1' },
    },
  }, token, tokenType);

  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' };
  if (!res.envelope || res.envelope.error) {
    return { ok: false, reason: 'initialize_failed',
      detail: (res.envelope && res.envelope.error && res.envelope.error.message) || `HTTP ${res.status}` };
  }

  // Per the spec the client confirms initialization. Best effort — a server that
  // does not need it simply ignores it, and failing here must not block the call.
  try {
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, tokenType);
  } catch (_) { /* ignore */ }

  session.initialized = true;
  return { ok: true };
}

/**
 * Call a tool. NEVER THROWS — always returns a shaped result, so a lookup that
 * fails degrades to a message on the screen instead of a 500.
 *
 *   { ok:true,  data }                     — the tool's parsed payload
 *   { ok:false, reason, detail }           — anything else, in plain words
 *
 * Pass `{ allowPaid:true }` ONLY from a route acting on a deliberate human click
 * for one named person; see PAID_TOOLS.
 */
async function callTool(name, args = {}, opts = {}) {
  // The never-throws contract is STRUCTURAL, not a promise each return statement
  // has to keep. Below this line are a database read, a token refresh and two
  // HTTP calls; any of them can throw, and a research lookup that throws becomes
  // a 500 on the officer's screen instead of a sentence they can act on.
  let out;
  try {
    out = await callToolInner(name, args, opts);
  } catch (e) {
    out = { ok: false, reason: 'error', detail: (e && e.message) || 'The Elementix lookup failed.' };
  }
  /* Only a call that actually WENT OUT counts against the hourly allowance. A
     refusal made before the wire — switched off, not configured, rate-limited,
     a paid tool with no actor — spent nothing, and counting it would make the
     guard throttle on its own refusals. A PAID call is already recorded by
     recordPaid, so it is not recorded twice here. */
  const wentOut = !['disabled', 'not_configured', 'rate_limited', 'paid_tool_refused',
    'paid_cap_reached', 'paid_cap_unknown', 'no_tool'].includes(out && out.reason);
  if (wentOut && !PAID_TOOLS.has(String(name || ''))) recordCall(String(name || ''), opts, out).catch(() => {});
  return out;
}

async function callToolInner(name, args, opts) {
  const toolName = String(name || '');
  if (!toolName) return { ok: false, reason: 'no_tool' };

  // The paid refusal comes FIRST, before anything about the environment is read.
  // It is a rule about what the CALLER asked for, so it must not depend on a
  // switch, a URL or a stored token: no configuration state can ever be arranged
  // such that a sweep spends credits, and a caller that forgot `allowPaid` is
  // told exactly that rather than "not configured".
  if (PAID_TOOLS.has(toolName)) {
    /* `allowPaid: true` was a BOOLEAN, and a boolean cannot answer the two
       questions a spend has to answer later: who asked, and for whom. It was
       also the easiest thing in the world to add to a call site "to make it
       work". `paidActor` demands a staff id, the person being unlocked and a
       reason IN THE SAME OBJECT — you cannot satisfy it by accident, and every
       spend is attributable afterwards. `allowPaid` is deliberately no longer
       honoured at all: silently accepting it would leave the weaker door open. */
    const actor = opts.paidActor;
    if (!actor || !actor.staffId || !actor.personId || !String(actor.reason || '').trim()) {
      return { ok: false, reason: 'paid_tool_refused',
        detail: `${toolName} spends Elementix credits, so it only runs from a deliberate per-person action `
              + 'that records who asked, about whom, and why.' };
    }
    /* THE OWNER'S CAP: "I have only 1,000 per month." A counter in process
       memory forgets itself on every deploy and is per-instance, so the month is
       counted in the database. FAILS CLOSED — an unreadable count refuses the
       spend, because the expensive direction is spending money we cannot count. */
    const spent = await paidThisMonth();
    if (spent.ok !== true) {
      return { ok: false, reason: 'paid_cap_unknown',
        detail: 'PILOT cannot read how many contact look-ups have been used this month, so it will not spend one.' };
    }
    const cap = Math.max(0, Number(cfg.elementix.paidPerMonth) || 1000);
    if (spent.n >= cap) {
      return { ok: false, reason: 'paid_cap_reached',
        detail: `The ${cap} contact look-ups for this month are used up (${spent.n}). It resets next month.` };
    }
    await recordPaid(toolName, actor);
  }

  if (!available()) return { ok: false, reason: 'not_configured', detail: 'ELEMENTIX_URL is not set.' };
  if (!enabled()) {
    return { ok: false, reason: 'disabled',
      detail: 'Elementix lookups are switched off. Turn them on from the API Health page.' };
  }

  const over = await overBudgetShared();
  if (over) return { ok: false, reason: 'rate_limited', detail: over };

  if (dryrun()) {
    console.log('[elementix] DRY-RUN tools/call', toolName, JSON.stringify(args).slice(0, 400));
    return { ok: true, dryRun: true, data: null };
  }

  const auth = await oauth.accessToken(opts.staffId || null);
  if (!auth.ok) return { ok: false, reason: auth.reason, detail: auth.detail };

  const attempt = async (token, tokenType) => {
    const s = await ensureSession(token, tokenType);
    if (!s.ok) return { transport: s };
    await throttle();
    const res = await post({
      jsonrpc: '2.0', id: nextId(), method: 'tools/call',
      params: { name: toolName, arguments: args || {} },
    }, token, tokenType);
    return { res };
  };

  let out = await attempt(auth.token, auth.tokenType);

  // A 401 mid-session, or a forgotten session, is worth exactly one retry with a
  // freshly refreshed token. More than one and a genuinely revoked credential
  // would become a retry storm.
  const unauthorized = (out.transport && out.transport.reason === 'unauthorized')
    || (out.res && (out.res.status === 401 || out.res.status === 403));
  const sessionGone = out.res && out.res.status === 404 && session.initialized;

  if (unauthorized || sessionGone) {
    session = { id: null, initialized: false, url: null };
    const again = await oauth.accessToken(opts.staffId || null);
    if (!again.ok) return { ok: false, reason: again.reason, detail: again.detail };
    out = await attempt(again.token, again.tokenType);
  }

  if (out.transport && !out.transport.ok) {
    return { ok: false, reason: out.transport.reason || 'transport',
      detail: out.transport.detail || 'Could not start an Elementix session.' };
  }

  const res = out.res;
  if (!res) return { ok: false, reason: 'no_response' };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'unauthorized',
      detail: 'Elementix rejected our access. Reconnect from the API Health page.' };
  }
  if (!res.envelope) {
    return { ok: false, reason: 'unreadable_response',
      detail: `Elementix answered HTTP ${res.status} in a form we could not read.` };
  }
  if (res.envelope.error) {
    const e = res.envelope.error;
    return { ok: false, reason: 'tool_error', detail: e.message || 'Elementix returned an error', code: e.code };
  }

  const result = res.envelope.result || {};
  // An MCP tool reports its own failure with isError plus the reason in content.
  if (result.isError) {
    return { ok: false, reason: 'tool_error', detail: textOf(result) || 'The lookup failed.' };
  }
  return { ok: true, data: payloadOf(result), raw: result };
}

/** Concatenate the text blocks of a tool result. */
function textOf(result) {
  const c = Array.isArray(result && result.content) ? result.content : [];
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
}

/**
 * The useful payload. Prefer the spec's `structuredContent`; otherwise the text
 * block, which these tools fill with JSON. Falls back to the plain string when
 * it is not JSON, so a human-readable answer is never thrown away.
 */
function payloadOf(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const t = textOf(result);
  if (!t) return null;
  try { return JSON.parse(t); } catch (_) { return t; }
}

/** Tool catalogue, for an admin "what can this do?" view. */
async function listTools(opts = {}) {
  if (!available()) return { ok: false, reason: 'not_configured' };
  if (!enabled()) return { ok: false, reason: 'disabled' };
  // A listing is a real request against the organization-wide 1,000/hour, so it
  // waits its turn like everything else rather than jumping the queue.
  const overList = overBudget();
  if (overList) return { ok: false, reason: 'rate_limited', detail: overList };
  const auth = await oauth.accessToken(opts.staffId || null);
  if (!auth.ok) return { ok: false, reason: auth.reason, detail: auth.detail };
  const s = await ensureSession(auth.token, auth.tokenType);
  if (!s.ok) return { ok: false, reason: s.reason || 'transport', detail: s.detail };
  await throttle();
  const res = await post({ jsonrpc: '2.0', id: nextId(), method: 'tools/list', params: {} }, auth.token, auth.tokenType);
  if (!res.envelope || res.envelope.error) {
    return { ok: false, reason: 'tool_error',
      detail: (res.envelope && res.envelope.error && res.envelope.error.message) || `HTTP ${res.status}` };
  }
  const tools = (res.envelope.result && res.envelope.result.tools) || [];
  /* KEEP `inputSchema`. Discarding it made this listing useless for the one
     thing a listing is for — knowing what a tool takes — so every caller had to
     go back to the vendor's docs, or guess. */
  return { ok: true,
    tools: tools.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema || null,
      paid: PAID_TOOLS.has(t.name),
    })) };
}

/**
 * How many CREDIT-SPENDING calls this calendar month, across every instance and
 * surviving every deploy. `{ok:false}` when the count cannot be read, and the
 * caller must treat that as a refusal — see the paid branch.
 */
async function paidThisMonth() {
  try {
    const db = require('../db');
    const r = await db.query(
      `SELECT count(*)::int AS n FROM elementix_calls
        WHERE paid AND created_at >= date_trunc('month', now())`);
    return { ok: true, n: (r.rows[0] && r.rows[0].n) || 0 };
  } catch (_) { return { ok: false, n: null }; }
}

/**
 * Record the spend BEFORE it happens. Deliberately not best-effort and
 * deliberately not after: a credit spent with no row is a credit nobody can
 * account for, and if the write fails we would rather refuse the lookup than
 * lose the count that the cap is built on.
 */
async function recordPaid(tool, actor) {
  const db = require('../db');
  await db.query(
    `INSERT INTO elementix_calls (tool, paid, staff_id, subject_id, reason) VALUES ($1,true,$2::uuid,$3,$4)`,
    [tool, actor.staffId, String(actor.personId).slice(0, 120), String(actor.reason).slice(0, 300)]);
}

/** How much of our self-imposed allowance is left — for the API Health page. */
function budget() {
  const { perSec, perHour } = bucketState();
  return {
    perSec, perHour,
    maxPerSec: Math.max(1, Number(cfg.elementix.maxPerSec) || 3),
    maxPerHour: Math.max(1, Number(cfg.elementix.maxPerHour) || 400),
    platformCeilingPerHour: 1000,
    note: 'The 1,000/hour platform limit is shared by the whole organization across every connected client.',
  };
}

/** Drop the cached handshake — used by tests and after a reconnect. */
function resetSession() { session = { id: null, initialized: false, url: null }; }

module.exports = {
  callTool, listTools, budget, paidThisMonth,
  available, enabled, dryrun,
  PAID_TOOLS,
  _internals: { parseRpcBody, payloadOf, textOf, overBudget, overBudgetShared, recordCall, resetSession, bucketState },
};
