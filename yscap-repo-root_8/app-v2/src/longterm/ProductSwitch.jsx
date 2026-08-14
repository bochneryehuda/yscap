import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ltApi } from './api.js';

/**
 * THE PRODUCT SWITCH — owner-directed 2026-08-14: "everybody should have a switch
 * on his login to switch to the long-term side". Asked to choose the shape, the
 * owner picked a TOP-BAR switch that swaps the whole side and is remembered per
 * user.
 *
 * WHAT IT IS NOT: a filter. The two products are two systems, and this moves you
 * between them — RTL's screens under /internal, Long-Term's under /internal/lt.
 * Nothing on either side is merged into the other.
 *
 * IT FAILS QUIET. Long-Term is a side build that is not live, so if /api/lt/me
 * cannot be reached the switch simply does not render: an officer who has never
 * heard of the long-term side must never be shown a broken control on the screen
 * they work in all day. The preference is saved server-side (a per-user settings
 * scope), and the local state moves first so the control never feels laggy.
 *
 * Colours are explicit darks per the HARD RULE — every `--ink*` token in this
 * palette is a LIGHT paper colour and renders white-on-white.
 */
export default function ProductSwitch() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    let alive = true;
    ltApi.me().then((m) => { if (alive) setMe(m); }).catch(() => { /* stays hidden */ });
    return () => { alive = false; };
  }, []);

  if (!me) return null;

  const onLt = loc.pathname.startsWith('/internal/lt');
  const go = async (product) => {
    if (busy) return;
    setBusy(true);
    // Move first, save second: the switch must feel instant, and a preference that
    // fails to save is a smaller problem than a control that appears stuck.
    nav(product === 'long_term' ? '/internal/lt' : '/internal');
    try { await ltApi.setProduct(product); } catch { /* the side still changed */ }
    setBusy(false);
  };

  const base = {
    border: 'none', background: 'transparent', cursor: 'pointer',
    padding: '5px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
    color: '#4B585C', lineHeight: 1.2, whiteSpace: 'nowrap',
  };
  const on = { ...base, background: '#fff', color: '#141B22', boxShadow: '0 1px 2px rgba(20,27,34,.14)' };

  return (
    <div
      role="group"
      aria-label="Which side of the business"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 2, padding: 3,
        background: '#EAE4D7', borderRadius: 999, border: '1px solid rgba(174,135,70,.35)',
      }}
    >
      <button type="button" style={onLt ? base : on} aria-pressed={!onLt}
        title="Short-term — bridge, ground-up and fix & flip"
        onClick={() => go('rtl')}>Short-term</button>
      <button type="button" style={onLt ? on : base} aria-pressed={onLt}
        title="Long-term — DSCR and investor loans"
        onClick={() => go('long_term')}>Long-term</button>
    </div>
  );
}
