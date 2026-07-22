'use strict';

/**
 * Automatic request-level audit log (owner-directed 2026-07-22).
 *
 * ONE row per HTTP request, written asynchronously in the background so the
 * request itself is never delayed by the logging. Captures every click that
 * reaches the server — through the borrower portal, the staff portal, direct
 * API calls, webhooks, automations, health checks — with timestamp, actor,
 * method, path, status, and how long it took.
 *
 * This is deliberately separate from the semantic `audit_log` (business
 * actions the code explicitly logs, e.g. "viewed SSN"). Together they answer
 * WHAT the user did, and WHICH HTTP calls the platform made in the process.
 *
 * Wired ONCE in src/server.js as `app.use(require('./lib/request-audit').middleware)`.
 * No per-handler changes are required.
 *
 * Design notes:
 *   • Writes are BUFFERED — we push each row into an in-memory queue and
 *     flush every FLUSH_MS (or when the buffer hits FLUSH_MAX). Under load
 *     this becomes one multi-row INSERT instead of one per request.
 *   • Everything is BEST-EFFORT — a DB blip during a flush must NEVER break
 *     a live request or turn into an uncaught rejection. We log + drop.
 *   • Bodies are NOT stored in full — that would leak PII (SSN, DOB, tokens).
 *     Only the top-level KEY NAMES are recorded, plus a size, so an audit
 *     shows "the request carried password + email fields" without the values.
 *   • Sensitive query params (?token=/?code=/?password=) are REDACTED.
 *   • The actor is decoded from the Bearer JWT without a DB roundtrip
 *     (verifyJwt is stateless); if the token is invalid or missing the row
 *     is written as actor_kind='anon' — a failed/anonymous request is
 *     exactly the kind of event this log exists to capture.
 */

const db = require('../db');
const C = require('./crypto');

// --------- Buffer + flusher ------------------------------------------------
const BUFFER = [];
const FLUSH_MS = 1500;
const FLUSH_MAX = 500;         // hard cap per flush so a huge burst can't stall the app
const BUFFER_MAX = 20000;      // if the DB is down for a long time we drop OLDEST rows rather than eat memory
let flushTimer = null;
let flushing = false;

function scheduleFlush() {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, FLUSH_MS);
}

async function flush() {
  if (flushing) return;
  if (!BUFFER.length) return;
  flushing = true;
  const batch = BUFFER.splice(0, FLUSH_MAX);
  try {
    // One multi-row INSERT is dramatically faster than N single inserts under load.
    const cols = [
      'at', 'request_id', 'actor_kind', 'actor_id', 'actor_email', 'actor_role',
      'method', 'path', 'route', 'query', 'status', 'duration_ms',
      'ip', 'user_agent', 'referer', 'entity_type', 'entity_id',
      'body_summary', 'error', 'bytes_out',
    ];
    const params = [];
    const rows = batch.map((r, i) => {
      const base = i * cols.length;
      params.push(
        r.at, r.request_id, r.actor_kind, r.actor_id, r.actor_email, r.actor_role,
        r.method, r.path, r.route, r.query, r.status, r.duration_ms,
        r.ip, r.user_agent, r.referer, r.entity_type, r.entity_id,
        r.body_summary, r.error, r.bytes_out,
      );
      return '(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')';
    }).join(',');
    await db.query(
      `INSERT INTO request_audit_log (${cols.join(',')}) VALUES ${rows}`,
      params);
  } catch (e) {
    // A logging failure must never propagate. Warn and drop the batch.
    // (If the DB is down every real request is already 503-ing; this is not
    // where you want a stack trace.)
    console.warn('[request-audit] flush failed (dropped ' + batch.length + ' rows):',
      db.describeError ? db.describeError(e) : (e && e.message) || String(e));
  } finally {
    flushing = false;
    if (BUFFER.length) scheduleFlush();
  }
}

function enqueue(row) {
  if (BUFFER.length >= BUFFER_MAX) BUFFER.shift();   // shed OLDEST first — the newest events are the useful ones
  BUFFER.push(row);
  if (BUFFER.length >= FLUSH_MAX) flush().catch(() => {});
  else scheduleFlush();
}

// --------- Redaction helpers ----------------------------------------------
// Query params / body keys whose VALUES must never be written into the audit
// log — they carry credentials or PII that this log is not authorized to hold.
const REDACT_KEYS = new Set([
  'password', 'pass', 'pwd', 'new_password', 'newpassword', 'current_password',
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'authorization',
  'api_key', 'apikey', 'secret', 'client_secret', 'session', 'sessionid', 'sid',
  'code', 'otp', 'totp', 'mfa', 'backup_code', 'backupcode',
  'ssn', 'social', 'tax_id', 'ein',
  'card', 'card_number', 'cardnumber', 'cvv', 'cvc',
  'dob', 'date_of_birth',
  'signature', 'sig',
]);
// A key is treated as sensitive if it matches REDACT_KEYS exactly (case-
// insensitive), OR contains one of these token substrings. Prefix/suffix
// matching catches things like "resetToken" / "borrowerSsn" / "cardBase64".
const REDACT_SUBSTR = ['password', 'token', 'secret', 'ssn', 'apikey', 'api_key', 'authorization'];
function isSensitive(k) {
  if (!k) return false;
  const s = String(k).toLowerCase();
  if (REDACT_KEYS.has(s)) return true;
  return REDACT_SUBSTR.some((sub) => s.includes(sub));
}

function redactQuery(q) {
  if (!q || typeof q !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of Object.keys(q)) {
    any = true;
    const v = q[k];
    if (isSensitive(k)) { out[k] = '[REDACTED]'; continue; }
    // Values are short-typed on purpose — we only need a hint, not the payload.
    if (v == null) out[k] = null;
    else if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = '[' + v.length + ' items]';
    else out[k] = '[object]';
  }
  return any ? out : null;
}

// Body summary: just the KEY NAMES (with sensitive ones flagged), never the
// values. A big enough hint to see "the request was setting a password"
// without ever storing the password itself.
function summarizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body)) return { _kind: 'array', _len: body.length };
  const keys = Object.keys(body);
  if (!keys.length) return null;
  const summary = { _keys: keys.length };
  const fields = [];
  for (const k of keys.slice(0, 40)) {                     // bound the summary
    const v = body[k];
    if (isSensitive(k)) fields.push(k + '=[REDACTED]');
    else if (v == null) fields.push(k + '=null');
    else if (typeof v === 'string') fields.push(k + '=str(' + v.length + ')');
    else if (typeof v === 'number' || typeof v === 'boolean') fields.push(k + '=' + typeof v);
    else if (Array.isArray(v)) fields.push(k + '=array(' + v.length + ')');
    else fields.push(k + '=object');
  }
  summary.fields = fields;
  return summary;
}

// Best-effort actor resolution from the Bearer token. We do NOT hit the DB
// here (that would double every request's authentication cost) — verifyJwt
// is stateless. A revoked but not-yet-expired token still resolves; that's
// FINE for the audit trail (it records what token was presented; the auth
// middleware is the one that decides whether to honor it).
function resolveActor(req) {
  try {
    const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!raw) return { kind: 'anon' };
    const claims = C.verifyJwt(raw);
    if (!claims) return { kind: 'anon' };
    if (claims.kind === 'staff' || claims.kind === 'borrower') {
      return {
        kind: claims.kind,
        id: claims.sub || null,
        role: claims.role || null,
      };
    }
    return { kind: 'anon' };
  } catch (_) {
    return { kind: 'anon' };
  }
}

// The first UUID-shaped path segment is almost always the entity id (files,
// borrowers, documents…). We only record it when the route matches an
// obvious entity keyword so we don't over-attribute a random UUID somewhere
// in a URL to the wrong entity type.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_HINTS = [
  ['applications', 'application'],
  ['files', 'application'],
  ['borrowers', 'borrower'],
  ['staff-users', 'staff'],
  ['staff', 'staff'],
  ['documents', 'document'],
  ['checklist-items', 'checklist_item'],
  ['llcs', 'llc'],
  ['track-records', 'track_record'],
  ['reminders', 'reminder'],
  ['leads', 'lead'],
  ['esign', 'esign'],
  ['sitewire', 'sitewire'],
  ['draws', 'draw'],
];
function inferEntity(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (UUID_RE.test(parts[i + 1])) {
      const seg = parts[i];
      const hit = ENTITY_HINTS.find(([k]) => k === seg);
      return hit ? { type: hit[1], id: parts[i + 1] } : { type: seg, id: parts[i + 1] };
    }
  }
  return { type: null, id: null };
}

// ---- URL paths we deliberately DON'T log ----------------------------------
// The audit log's purpose is "every action a user or system took." Static
// asset requests (CSS/JS/PNG/font/…) are noise — they arrive by the thousand
// on every page load and drown the useful rows. We skip them by suffix.
// Everything under /api and /auth is logged unconditionally.
const STATIC_SUFFIX_RE = /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|webm|txt|xml|json|html?)$/i;
function shouldLog(req) {
  const p = req.path || '';
  if (p.startsWith('/api/') || p.startsWith('/auth')) return true;
  if (p.startsWith('/link/') || p.startsWith('/e/o/')) return true;   // email bounces + open pixel
  if (STATIC_SUFFIX_RE.test(p)) return false;
  return true;   // an SPA HTML shell request, an unknown route, a webhook — all worth logging
}

// A short unique request id — appears in every log line + gets echoed back to
// the client as `X-Request-Id`, so a support ticket ("this failed at 3:14pm")
// can be pin-pointed to the exact row in this log in one step.
function makeRequestId() {
  return C.randomB64url ? C.randomB64url(9)
    : require('crypto').randomBytes(9).toString('base64').replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}

// --------- The middleware itself ------------------------------------------
function middleware(req, res, next) {
  if (!shouldLog(req)) return next();

  const started = Date.now();
  const requestId = req.get('x-request-id') || makeRequestId();
  req.requestId = requestId;
  res.set('X-Request-Id', requestId);

  // Resolve actor once at request-start; we do NOT read req.actor here (auth
  // middleware hasn't run yet at this position) — we decode the JWT ourselves.
  const actor = resolveActor(req);

  const query = redactQuery(req.query);
  const bodySummary = summarizeBody(req.body);
  const entity = inferEntity(req.path);

  res.on('finish', () => {
    try {
      // Prefer the freshest actor state — if the auth middleware ran later
      // and set req.actor (staff/borrower), use it (it's the authoritative
      // one). This is why we don't await here.
      let ak = actor.kind;
      let aid = actor.id || null;
      let arole = actor.role || null;
      if (req.actor && req.actor.id) {
        ak = req.actor.kind || ak;
        aid = req.actor.id;
        arole = req.actor.role || arole;
      }
      const status = res.statusCode || 0;
      const errText = (status >= 400 && (res.locals && res.locals.auditError))
        ? String(res.locals.auditError).slice(0, 500)
        : null;
      const cl = res.getHeader && res.getHeader('content-length');
      const bytesOut = cl ? parseInt(cl, 10) || null : null;

      enqueue({
        at: new Date(started).toISOString(),
        request_id: requestId,
        actor_kind: ak,
        actor_id: aid,
        actor_email: (req.actor && req.actor.email) || null,
        actor_role: arole,
        method: req.method,
        path: req.path.slice(0, 400),
        route: (req.route && req.route.path) ? String(req.route.path).slice(0, 200) : null,
        query,
        status,
        duration_ms: Date.now() - started,
        ip: (req.ip || '').slice(0, 60) || null,
        user_agent: String(req.get('user-agent') || '').slice(0, 500) || null,
        referer: String(req.get('referer') || '').slice(0, 400) || null,
        entity_type: entity.type,
        entity_id: entity.id,
        body_summary: bodySummary,
        error: errText,
        bytes_out: bytesOut,
      });
    } catch (_) { /* logging must never break */ }
  });

  next();
}

// A tiny error-recorder route handlers can call: `req.auditError('reason')`.
// Optional — the middleware already captures the response status; this just
// lets a handler surface a specific reason (e.g. "wrong password") into the
// log without echoing it to the client body.
function attachAuditError(req, res, next) {
  req.auditError = (msg) => { res.locals.auditError = String(msg || '').slice(0, 500); };
  next();
}

// Manual flush hook for tests + graceful shutdown.
async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flush();
}

// If the process is asked to exit cleanly, try to drain the buffer first so
// the last few requests before shutdown don't vanish.
function attachShutdownDrain() {
  const drain = () => { flushNow().catch(() => {}); };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
  process.on('beforeExit', drain);
}
attachShutdownDrain();

module.exports = {
  middleware,
  attachAuditError,
  flushNow,
  // exported for tests
  _internals: { redactQuery, summarizeBody, isSensitive, inferEntity, shouldLog },
};
