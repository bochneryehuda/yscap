import React, { useState } from 'react';

/**
 * ONE place that turns a failed appraisal order into a plain-language reason the
 * owner can read (owner-directed 2026-08-12: "every time I try to place an order,
 * it should come up with the reason why it failed, with the error code and basic
 * stuff about why the order didn't go through, so I'm not trying in the dark").
 *
 * Both vendor desks (Class Valuation and AppraisalScope / NAN) use this, so the two
 * can never drift on how a failure reads. It LEADS with the vendor's name, which is
 * also how a person tells at a glance which desk they clicked — the two panels sit
 * side by side, and an order that lands on the wrong one now says so out loud
 * ("AppraisalScope / NAN could not place this order") instead of failing silently.
 *
 * WHERE THE PIECES COME FROM. The server already hands the browser the whole failure
 * body — api.js's req() throws an Error with the parsed JSON on `err.data` and the
 * HTTP status on `err.status`. The two desks shape that body slightly differently:
 *   Class (routes/class.js):  502 { error, detail: <string reason>, vendor: <raw body> }
 *   AMC   (routes/amc.js):    400 { error, message: <string reason>, httpStatus, detail: <object> }
 * parseOrderFailure() normalises both into one shape so the display never has to know
 * which desk it came from.
 *
 * All colours are EXPLICIT dark hex on the white canvas (never a var(--ink*) token,
 * which resolves LIGHT in this portal) — per the white-first HARD RULE.
 */

const BAD_BORDER = '#E4B4AE', BAD_BG = '#FBEEEC', BAD_HEAD = '#8A2F27';
const INK = '#141B22', MUTED = '#5B4A47';

// Pull a short human sentence out of whatever the vendor's own system returned.
// It arrives as their envelope ({ code, error, message }), as ASP.NET's default
// validation shape ({ errors: { "$.field": [msg] } }), or as a plain string.
function vendorSummary(v) {
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

  const missing = Array.isArray(data.missing) && data.missing.length ? data.missing : null;

  return { code, httpStatus, reason, vendor, missing };
}

function Box({ children }) {
  return (
    <div style={{ border: `1px solid ${BAD_BORDER}`, background: BAD_BG, borderRadius: 8,
      padding: '10px 12px', marginBottom: 10, fontSize: 13 }}>
      {children}
    </div>
  );
}

// `info` is either a plain string (a load/other error) or the object from
// parseOrderFailure(). `vendor` is the desk's own name, shown so a person always
// knows which desk this failure is about.
export default function OrderFailure({ info, vendor }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!info) return null;

  if (typeof info === 'string') {
    return <Box><div style={{ color: INK }}>{info}</div></Box>;
  }

  const { code, httpStatus, reason, vendor: body, missing } = info;
  const vs = vendorSummary(body);
  let raw = '';
  if (body != null) {
    try { raw = typeof body === 'string' ? body : JSON.stringify(body, null, 2); }
    catch { raw = ''; }
  }

  return (
    <Box>
      <div style={{ fontWeight: 700, color: BAD_HEAD, marginBottom: reason || missing ? 4 : 0 }}>
        {vendor ? `${vendor} could not place this order.` : 'Could not place this order.'}
      </div>

      {reason ? <div style={{ color: INK, marginBottom: 4 }}>{reason}</div> : null}

      {missing ? (
        <div style={{ color: INK, marginBottom: 4 }}>
          <strong>Still needed:</strong> {missing.join(', ')}
        </div>
      ) : null}

      {(code || httpStatus) ? (
        <div style={{ color: MUTED, fontSize: 12, marginBottom: (vs && vs !== reason) || raw ? 6 : 0 }}>
          {code ? <span>Error code: <strong style={{ color: INK }}>{code}</strong></span> : null}
          {code && httpStatus ? <span>{'  ·  '}</span> : null}
          {httpStatus ? <span>Status: <strong style={{ color: INK }}>{httpStatus}</strong></span> : null}
        </div>
      ) : null}

      {vs && vs !== reason ? (
        <div style={{ color: INK, fontSize: 13, marginBottom: raw ? 6 : 0 }}>
          <span style={{ color: MUTED }}>What their system reported: </span>{vs}
        </div>
      ) : null}

      {raw ? (
        <div>
          <button type="button" onClick={() => setShowRaw((v) => !v)}
            style={{ background: 'none', border: 'none', padding: 0, color: '#256168',
              textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
            {showRaw ? 'Hide' : 'Show'} the full technical details
          </button>
          {showRaw ? (
            <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', maxHeight: 200, marginTop: 6,
              background: '#FFF', border: `1px solid ${BAD_BORDER}`, borderRadius: 6, padding: 8,
              color: INK, fontSize: 12 }}>{raw}</pre>
          ) : null}
        </div>
      ) : null}
    </Box>
  );
}
