import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

/* "Borrower view" launcher (owner-directed 2026-07-26).

   Dropped anywhere a specific borrower is on screen — the loan file header, a
   borrower's profile — so stepping into their portal is one click from where
   you already are, not a trip to a separate screen. Passing `applicationId`
   lands the view straight on THAT loan, which is the whole point when a
   borrower calls about one file.

   Self-hides when there is no borrower to view. If the server says no (the
   borrower is outside this staffer's pipeline, or has never set up a login) the
   reason is shown inline — never a dead button. */
export default function BorrowerViewButton({
  borrowerId,
  applicationId = null,
  borrowerName = '',
  className = 'btn ghost small',
  label = 'Borrower view',
}) {
  const { startBorrowerView } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!borrowerId) return null;

  const go = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await startBorrowerView(borrowerId, applicationId);
      // A plain push, not a replace: the browser's Back button then also returns to the
      // file (the exit buttons use the parked location; this is the second way home).
      nav(r.landing || '/dashboard');
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <span className="row" style={{ gap: 8, flex: 'none', alignItems: 'center' }}>
      <button
        type="button"
        className={className}
        data-cobrowse-nodrive="view-as"
        style={{ flex: 'none' }}
        disabled={busy}
        onClick={go}
        title={borrowerName
          ? `See PILOT exactly as ${borrowerName} sees it — to walk them through a screen. You can come back with one click.`
          : 'See PILOT exactly as this borrower sees it. You can come back with one click.'}
      >
        {busy ? 'Opening…' : label}
      </button>
      {err && <span className="small" role="alert" style={{ color: '#B3261E' }}>{err}</span>}
    </span>
  );
}
