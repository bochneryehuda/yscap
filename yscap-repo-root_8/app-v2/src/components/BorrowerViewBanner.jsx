import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

/* BORROWER VIEW banner (owner-directed 2026-07-26).
   While a staffer is standing inside a borrower's portal, this bar is pinned to
   the top of EVERY borrower screen. Two jobs, both non-negotiable:
     1. You can never forget whose screen you are on. Everything below the bar
        is the borrower's real portal, so the bar is the only thing telling you
        that the "Upload" button you are about to press files a document under
        someone else's name.
     2. The way back is always one click away, on every screen — not buried in a
        menu you have to hunt for.
   It also counts the session down: a borrower view is capped (4h server-side),
   and a bar that silently expires would look like a bug. */

/* "Back to my loan officer view" / "…my processor view" / "…my admin view" —
   the owner asked for the way back to be named in the staffer's own terms. */
const ROLE_VIEW = {
  super_admin: 'admin view', admin: 'admin view', underwriter: 'underwriter view',
  loan_officer: 'loan officer view', loan_coordinator: 'coordinator view',
  draw_coordinator: 'draw desk', processor: 'processor view', closer: 'closer view',
  software_setup: 'setup console',
};

function remaining(expiresAt) {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'ending';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m left`;
}

export default function BorrowerViewBanner() {
  const { isBorrowerView, viewingAs, impersonation, exitBorrowerView } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  // Re-render once a minute so the countdown stays honest.
  useEffect(() => {
    if (!isBorrowerView) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, [isBorrowerView]);

  if (!isBorrowerView) return null;

  const who = viewingAs?.borrowerName || 'this borrower';
  const left = remaining(viewingAs?.expiresAt);
  const backTo = ROLE_VIEW[viewingAs?.staffRole || impersonation?.staffRole] || 'console';

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await exitBorrowerView();
    setBusy(false);
    nav(ok ? '/internal/borrower-view' : '/internal/login', { replace: true });
  };

  return (
    <div className="bview-bar" role="status" aria-live="polite">
      <span className="bview-dot" aria-hidden="true" />
      <span className="bview-text">
        <strong>Borrower view</strong>
        <span className="bview-sep" aria-hidden="true">·</span>
        You’re seeing PILOT exactly as <strong>{who}</strong> sees it. Anything you do here is
        recorded as done by you.
      </span>
      {left && <span className="bview-clock" title="A borrower view ends automatically after 4 hours.">{left}</span>}
      <button type="button" className="bview-exit" onClick={leave} disabled={busy}>
        {busy ? 'Leaving…' : `← Back to my ${backTo}`}
      </button>
    </div>
  );
}
