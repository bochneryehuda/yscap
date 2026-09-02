import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, takeReturnTo } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

/* TPO VIEW banner (owner-directed 2026-08-04; TPO blueprint decision 6).
   The exact mirror of the borrower-view banner, for the broker portal: while an
   internal staffer (AE/AM/admin) is standing inside a broker's login, this bar
   is pinned to the top of EVERY broker screen. Same two non-negotiable jobs:
     1. You can never forget whose portal you are on — everything below the bar
        is the broker's real portal.
     2. The way back is always one click away, on every screen.
   It counts the session down (a broker view is capped 4h server-side). Unlike
   the borrower banner (which reads the name from /auth/me), this one self-fetches
   from /api/tpo-view/session so it never depends on the borrower /auth/me shape. */

const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

function remaining(expiresAt) {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'ending';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m left`;
}

export default function TpoViewBanner() {
  const { isTpoView, impersonation, exitTpoView } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);   // { brokerName, firmName, expiresAt }
  const [, tick] = useState(0);

  // Name the broker + firm for the bar (self-fetched, not from /auth/me).
  useEffect(() => {
    let live = true;
    if (!isTpoView) { setInfo(null); return undefined; }
    api.tpoViewSession().then((r) => {
      if (!live || !r || !r.active) return;
      setInfo({
        brokerName: r.broker?.name || 'this broker',
        firmName: r.broker?.firmName || null,
        expiresAt: r.expiresAt || null,
      });
    }).catch(() => {});
    return () => { live = false; };
  }, [isTpoView, impersonation?.sessionId]);

  // Re-render once a minute so the countdown stays honest.
  useEffect(() => {
    if (!isTpoView) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, [isTpoView]);

  if (!isTpoView) return null;

  const who = info?.brokerName || 'this broker';
  const firm = info?.firmName;
  // Prefer the server's authoritative expiry; fall back to the token's own anchor.
  const expiresAt = info?.expiresAt || (impersonation?.startedAt ? impersonation.startedAt + MAX_SESSION_MS : null);
  const left = remaining(expiresAt);

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await exitTpoView();
    setBusy(false);
    nav(ok ? (takeReturnTo() || '/internal/tpo-view') : '/internal/login', { replace: true });
  };

  return (
    <div className="bview-bar" role="status" aria-live="polite">
      <span className="bview-dot" aria-hidden="true" />
      <span className="bview-text">
        <strong>Broker view</strong>
        <span className="bview-sep" aria-hidden="true">·</span>
        You’re seeing PILOT exactly as <strong>{who}</strong>{firm ? <> at <strong>{firm}</strong></> : null} sees it.
        Anything you do here is recorded as done by you.
      </span>
      {left && <span className="bview-clock" title="A broker view ends automatically after 4 hours.">{left}</span>}
      <button type="button" className="bview-exit" onClick={leave} disabled={busy}>
        {busy ? 'Leaving…' : '← Back to my console'}
      </button>
    </div>
  );
}
