/* Turning a failed appraisal order into a plain-language reason — the pure half,
 * with NO React, so it is executable-testable (scripts/test-order-failure-pure.mjs).
 * The component that renders it is ../components/OrderFailure.jsx.
 *
 * The server already hands the browser the whole failure body — api.js's req()
 * throws an Error with the parsed JSON on `err.data` and the HTTP status on
 * `err.status`. The two appraisal desks shape that body slightly differently:
 *   Class (routes/class.js):
 *     502 { error, detail:<string reason>, vendor:<raw body> }
 *     422 { error:'incomplete', missing:[{field,why}...], message:<string> }
 *   AMC (routes/amc.js):
 *     400 { error, message:<string reason>, httpStatus, missing:[<string>...], detail:<object> }
 * parseOrderFailure() normalises both into one shape so the display never has to
 * know which desk it came from — including `missing`, which is OBJECTS on Class and
 * STRINGS on AMC and must never reach the screen as "[object Object]".
 */

// Pull a short human sentence out of whatever the vendor's own system returned.
// It arrives as their envelope ({ code, error, message }), as ASP.NET's default
// validation shape ({ errors: { "$.field": [msg] } }), or as a plain string.
// The server twin is vendorErrorText() in src/class/order-build.js — keep the two
// in step (the server additionally JSON-stringifies an unrecognised object, which
// this stops short of because the component shows the raw body in an expander).
export function vendorSummary(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    if (typeof v.error === 'string' && v.error.trim()) return v.error.trim();
    if (typeof v.message === 'string' && v.message.trim()) return v.message.trim();
    // ASP.NET ValidationProblemDetails: the field is a KEY, the messages an array —
    // and these carry the specifics, so they win over the generic `title` boilerplate.
    if (v.errors && typeof v.errors === 'object') {
      const parts = [];
      for (const k of Object.keys(v.errors)) {
        const msgs = v.errors[k];
        const text = Array.isArray(msgs) ? msgs.join('; ') : String(msgs);
        parts.push(k ? `${k}: ${text}` : text);
      }
      if (parts.length) return parts.join(' · ');
    }
    if (typeof v.detail === 'string' && v.detail.trim()) return v.detail.trim();
    if (typeof v.title === 'string' && v.title.trim()) return v.title.trim();
    // A non-JSON body kept verbatim under `raw` (client.js readBody).
    if (typeof v.raw === 'string' && v.raw.trim()) return v.raw.trim();
  }
  return '';
}

// Normalise a placement failure into one shape, from EITHER a thrown error `e`
// (the usual case — a non-2xx makes req() throw) OR a 2xx body that carries
// { ok:false } (defensive; the routes answer non-2xx today).
export function parseOrderFailure(e, out) {
  const data = e ? (e.data || {}) : (out || {});

  const code = data.error || (e && e.code) || null;

  let httpStatus = null;
  if (typeof data.httpStatus === 'number') httpStatus = data.httpStatus;
  else if (e && typeof e.status === 'number' && e.status > 0) httpStatus = e.status;

  // The plain reason. Class puts it on `detail` (a string); AMC on `message`.
  // e.message is the last resort, but only when it isn't just a repeat of the code
  // (friendlyError() in api.js returns the bare code when that's all it has).
  let reason = null;
  if (typeof data.message === 'string' && data.message.trim()) reason = data.message.trim();
  else if (typeof data.detail === 'string' && data.detail.trim()) reason = data.detail.trim();
  else if (e && typeof e.message === 'string' && e.message && e.message !== code) reason = e.message;

  // The vendor's own structured body: Class → `vendor`; AMC → `detail` (an object).
  let vendor = null;
  if (data.vendor != null) vendor = data.vendor;
  else if (data.detail != null && typeof data.detail === 'object') vendor = data.detail;

  // Each desk shapes `missing` differently: Class returns {field, why} OBJECTS
  // (and its route hands those back verbatim on the incomplete-at-send path), AMC
  // returns plain strings. Normalise both to readable strings — the same
  // `why || field` the Class panel already uses — so this never prints "[object Object]".
  const rawMissing = Array.isArray(data.missing) ? data.missing : [];
  const missing = rawMissing
    .map((m) => (typeof m === 'string' ? m : (m && (m.why || m.field)) || ''))
    .filter(Boolean);

  return { code, httpStatus, reason, vendor, missing: missing.length ? missing : null };
}
