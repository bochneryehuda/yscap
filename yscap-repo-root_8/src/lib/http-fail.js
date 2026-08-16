'use strict';
/**
 * WHY A "server error" NOW SAYS WHAT ACTUALLY WENT WRONG
 * (owner-directed 2026-08-16: "Need to make sure the server error always is
 * displaying more details, exactly what the error is, so we can better
 * troubleshoot it.")
 *
 * There are 379 places in this codebase that end a request with
 * `res.status(500).json({ error: 'server error' })`. That string is all a
 * staffer ever sees, on any screen, for every cause there is — a number too big
 * for its column, a NOT NULL that was never relaxed, a vendor timeout, a typo in
 * a column name. It reads as "PILOT is broken" and tells nobody, including us,
 * which of those it was. The owner's co-borrower report is the exact shape:
 * a red "server error" under the Save button, and no way to get from there to
 * "the email column does not accept an empty value".
 *
 * ── THE SHAPE OF THE FIX, AND WHY IT IS NOT 379 EDITS ──────────────────────
 *
 * Editing every call site is the cheap shape: it is a hand-kept list, it goes
 * stale the first time somebody writes route number 380, and it would have to
 * be done again in every route file added afterwards. So the cause is captured
 * at the ONE place every one of those failures actually passes through — the
 * database driver — and it is attached at the ONE place every one of those
 * responses passes through: `res.json`. A route written next year is covered
 * with no knowledge of this file.
 *
 *   1. `middleware` binds a per-request slot (AsyncLocalStorage, the same
 *      mechanism `api-rate-limit.runAsHealthProbe` uses) and wraps `res.json`.
 *   2. `src/db.js` calls `record(e, sql)` on every failed query — pooled and
 *      transactional alike. Nothing else has to know.
 *   3. Any response of 500 or worse gets a `reference` (the request id already
 *      echoed as `X-Request-Id` and already stored on the `request_audit_log`
 *      row), and — for a STAFF actor — the real reason.
 *   4. The same reason is stamped on `res.locals.auditError`, so it lands in
 *      `request_audit_log.error` and shows up in the file's own audit log under
 *      "Include every request". The failure becomes part of the record instead
 *      of a line in a log nobody can reach.
 *
 * ── WHAT MAY BE SHOWN, AND TO WHOM ────────────────────────────────────────
 *
 * A Postgres error's `detail` field quotes the FAILING ROW — the borrower's
 * name, their DOB, their encrypted SSN. It is never sent and never logged. What
 * is sent is the `message` (plus code/column/constraint/table), which describes
 * the SHAPE of the problem, and even that is run through the shared PII scrubber
 * first, because a message like `invalid input syntax for type integer: "..."`
 * echoes whatever was typed — and people type Social Security numbers into
 * boxes that are not for them.
 *
 * Even scrubbed, it is INTERNAL wording. So it is shown to `kind === 'staff'`
 * only. A borrower, a broker (`kind === 'tpo'` — an outside company) and an
 * anonymous caller get the plain apology and the `reference`, which is all a
 * support conversation needs: it names the exact row in the request log.
 *
 * NOTHING HERE MAY EVER BREAK A RESPONSE. Every step is wrapped: a failure
 * inside the failure reporter returns the body untouched.
 *
 * COVERAGE, stated plainly: this hooks `res.json`, which is how every JSON
 * failure in this codebase is written. The one 5xx that does not go through it
 * is `serve-document`'s `res.status(500).end()` on a broken byte stream, where a
 * JSON body would be wrong anyway. `db.pool.query(...)` called directly (rather
 * than `db.query`) is likewise not captured — those responses still gain a
 * reference, just not the reason.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Postgres fields worth quoting. `detail` and `where` are deliberately ABSENT:
// `detail` carries the failing row's values, and `where` carries PL/pgSQL context
// that can quote them too.
const PG_FIELDS = ['code', 'column', 'constraint', 'table', 'schema', 'routine'];
const MAX_DETAIL = 500;

/** The per-request slot, or null outside a request (a worker, a boot sweep). */
function store() { try { return als.getStore() || null; } catch (_) { return null; } }

/**
 * Remember the cause of a failure for the request currently in flight.
 *
 * Called by `src/db.js` for every rejected query, and callable by hand from any
 * catch block that wants to be precise. Outside a request it is a no-op, so a
 * worker never pays for it and never leaks into somebody else's response.
 */
function record(e, context) {
  const s = store();
  if (!s || !e) return e;
  try {
    s.count = (s.count || 0) + 1;
    s.cause = e;
    s.context = context ? String(context).replace(/\s+/g, ' ').trim().slice(0, 300) : (s.context || null);
  } catch (_) { /* reporting must never throw */ }
  return e;
}

/** Run `fn` with its own failure slot — for a non-HTTP caller that wants one. */
function withSlot(fn) { return als.run({ cause: null, count: 0, context: null }, fn); }

/**
 * The one-line, PII-scrubbed reason. Never throws, always returns a string or
 * null — a reason nobody can read is worse than none.
 */
function describe(e) {
  if (!e) return null;
  try {
    const parts = [];
    if (e.message) parts.push(String(e.message));
    for (const f of PG_FIELDS) if (e[f]) parts.push(`${f}=${e[f]}`);
    // AggregateError (every address for a host failed) keeps its cause in .errors.
    if (!e.message && Array.isArray(e.errors) && e.errors.length) parts.push(describe(e.errors[0]) || '');
    const raw = parts.filter(Boolean).join(' ').trim();
    if (!raw) return e.name ? String(e.name) : null;
    let safe = raw, scrubbed = false;
    try { safe = require('./pii-guard').scan(raw).redacted; scrubbed = true; } catch (_) { /* see below */ }
    // If the scrubber could not be LOADED we must not ship an unscrubbed string.
    // The test is the DASHED form only — deliberately the same judgement
    // `pii-guard` itself makes, which scrubs a bare nine-digit run only when the
    // surrounding words suggest a Social. A loan number is nine digits too, and
    // withholding every reason that contains one would trade a real diagnosis
    // for a hypothetical leak on the one path where the scrubber is missing.
    if (!scrubbed && /\d{3}-\d{2}-\d{4}/.test(raw)) {
      return 'the reason contained sensitive data and was withheld — see the server log';
    }
    return safe.slice(0, MAX_DETAIL);
  } catch (_) { return null; }
}

/** A last-resort reference when the request-audit middleware is switched off. */
function mintReference() {
  try { return require('crypto').randomBytes(6).toString('hex'); } catch (_) { return null; }
}

function isStaff(req) {
  const a = req && req.actor;
  return !!(a && a.kind === 'staff');
}

/**
 * Attach the reference (+ the reason, for staff) to a 5xx body, log one line
 * carrying everything, and stamp the request-audit row.
 */
function enrich(req, res, slot, body) {
  try {
    if (!res || (res.statusCode || 200) < 500) return body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    if (body.reference) return body;                       // already reported

    const reference = (req && req.requestId) || mintReference();
    const cause = slot && slot.cause;
    const detail = describe(cause);

    // The record, first: this must happen whether or not the caller is allowed
    // to SEE the reason.
    try {
      if (res.locals && !res.locals.auditError) {
        res.locals.auditError = [detail, reference ? `ref=${reference}` : null].filter(Boolean).join(' ').slice(0, 500);
      }
    } catch (_) { /* ignore */ }
    try {
      const where = req ? `${req.method} ${req.path}` : 'request';
      console.error(`[api-fail] ${where} → ${res.statusCode} ref=${reference || '-'}`,
        detail || '(no captured cause)',
        slot && slot.context ? `while=${slot.context}` : '',
        cause && cause.stack ? `\n${cause.stack}` : '');
    } catch (_) { /* ignore */ }

    const out = { ...body };
    if (reference) out.reference = reference;
    // NEVER OVERWRITE A REASON THE ROUTE ALREADY GAVE. Several handlers put the
    // VENDOR's own words on `detail` (the Class order path answers 502 with the
    // exact reason Class gave — the whole point of that work), and replacing it
    // with whatever the request last tripped over would be strictly worse than
    // the bare message this exists to improve. We only fill a gap.
    if (detail && isStaff(req) && out.detail == null) {
      out.detail = detail;
      if (cause && cause.code && out.code == null) out.code = String(cause.code);
      if (slot && slot.count > 1) out.earlierFailures = slot.count - 1;
    }
    return out;
  } catch (_) { return body; }
}

/**
 * Mount ONCE in server.js, after the request-audit middleware (so `req.requestId`
 * exists) and above every route.
 */
function middleware(req, res, next) {
  const slot = { cause: null, count: 0, context: null };
  try {
    const json = res.json.bind(res);
    res.json = (body) => json(enrich(req, res, slot, body));
  } catch (_) { /* a res without json — leave it alone */ }
  als.run(slot, next);
}

/**
 * The explicit form, for a catch block that has the error in hand: it is more
 * accurate than the captured last-cause, because it names THIS error.
 *
 *   catch (e) { return fail(res, e, { message: 'server error' }); }
 */
function fail(res, e, opts = {}) {
  record(e, opts.context);
  const status = opts.status || 500;
  return res.status(status).json({ error: opts.message || 'server error' });
}

module.exports = { middleware, record, describe, fail, withSlot, _internals: { enrich, isStaff } };
