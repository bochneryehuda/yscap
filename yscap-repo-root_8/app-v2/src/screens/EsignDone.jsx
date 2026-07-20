import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';

/* Where a borrower lands after signing from PILOT's branded "ready to sign" email
   (owner-directed 2026-07-20). The /api/esign/return bounce redirects here with a
   ONE-TIME login code (`li`) so we can establish their session and drop them right
   back INSIDE their loan file, already logged in — no manual sign-in. The code is
   single-use + short-lived + server-verified; we exchange it exactly once.

   States (from /api/esign/sign or /return):
     li present            → exchange it, sign in, go to the file
     signed | viewed       → done; go to the file (or offer sign-in if not logged in)
     already               → already signed / no longer open → view the file
     declined | cancelled  → they chose not to sign
     expired|error|notready→ the link is no longer valid → sign in to continue */
export default function EsignDone() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { signIn, isAuthed } = useAuth();
  const app = params.get('app') || '';
  const state = (params.get('state') || params.get('esign') || '').toLowerCase();
  const li = params.get('li') || '';

  const [phase, setPhase] = useState(li ? 'exchanging' : 'settle'); // exchanging|settle|signin|error
  const ran = useRef(false);

  const fileHref = app ? `/app/${app}${state ? `?esign=${encodeURIComponent(state)}` : ''}` : '/dashboard';
  const goToFile = () => nav(fileHref, { replace: true });
  const goToSignIn = () => nav('/login', { replace: true, state: { from: fileHref } });

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      if (li) {
        try {
          const r = await api.claimEsignSession(li);
          if (r && r.token) { signIn(r.token); nav(fileHref, { replace: true }); return; }
          setPhase('signin');
        } catch (_) { setPhase('signin'); }
        return;
      }
      // No handoff code. If they're already logged in and we know the file, just go.
      if (isAuthed && app && (state === 'signed' || state === 'viewed' || state === 'already' || !state)) {
        goToFile(); return;
      }
      setPhase('settle');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'exchanging')
    return (
      <AuthShell title="Bringing you back to your file" subtitle="One moment…">
        <div className="muted small">Finishing up your signing session…</div>
      </AuthShell>
    );

  // Copy per outcome.
  const declined = state === 'declined' || state === 'cancelled';
  const invalid = state === 'expired' || state === 'error' || state === 'ttl_expired' || state === 'timeout' || state === 'notready';
  const signed = state === 'signed' || state === 'viewed' || state === 'done';

  let title = 'Thank you';
  let subtitle = 'Your signing session is complete.';
  let body = 'Your documents have been submitted for signing.';
  if (declined) { title = 'No problem'; subtitle = 'Nothing was signed.'; body = 'You chose not to sign right now. You can come back to it any time from your loan file.'; }
  else if (invalid) { title = 'This link has expired'; subtitle = 'Please sign in to continue.'; body = 'For your security, signing links expire. Sign in to your portal to pick up right where you left off.'; }
  else if (state === 'already') { title = 'Already signed'; subtitle = 'These documents are no longer open for signing.'; body = 'It looks like this has already been taken care of. Sign in to view your loan file and its documents.'; }
  else if (signed) { title = 'Thank you — you\'re all set'; subtitle = 'Your signature has been received.'; body = 'Your signed documents have been received. Sign in to view your loan file and follow every step.'; }

  return (
    <AuthShell title={title} subtitle={subtitle}>
      <div className={`notice ${declined || invalid ? '' : 'ok'}`} style={{ marginBottom: 16 }}>{body}</div>
      <div className="row" style={{ marginTop: 8, gap: 10 }}>
        {isAuthed
          ? <button className="btn primary" onClick={goToFile}>{app ? 'Go to my loan file' : 'Go to my portal'}</button>
          : <button className="btn primary" onClick={goToSignIn}>Sign in to view my file</button>}
      </div>
    </AuthShell>
  );
}
