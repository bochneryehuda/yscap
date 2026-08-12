import React, { useState } from 'react';
import { vendorSummary, parseOrderFailure } from '../lib/orderError.js';

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
 * The parsing (parseOrderFailure/vendorSummary) is pure and lives React-free in
 * ../lib/orderError.js so it can be executable-tested; this file is the display.
 * parseOrderFailure is re-exported so the panels keep importing it from here.
 *
 * All colours are EXPLICIT dark hex on the white canvas (never a var(--ink*) token,
 * which resolves LIGHT in this portal) — per the white-first HARD RULE.
 */

export { parseOrderFailure };

const BAD_BORDER = '#E4B4AE', BAD_BG = '#FBEEEC', BAD_HEAD = '#8A2F27';
const INK = '#141B22', MUTED = '#5B4A47';

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
