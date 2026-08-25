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
  const { signIn, isAuthed, isStaff } = useAuth();
  const app = params.get('app') || '';
  const state = (params.get('state') || params.get('esign') || '').toLowerCase();
  const li = params.get('li') || '';
  /* ONE OF OUR OWN SIGNERS LANDS ON THE INTERNAL FILE, NEVER A BORROWER ROUTE (owner-reported
     2026-08-24: the officer's "Review & sign" button "is taking him to the pipeline").

     THAT WAS THIS SCREEN. It was written for borrowers and sent everyone to `/app/:id`, which is
     borrower-only: App.jsx's `<Private>` wrapper answers a staff session with
     `<Navigate to="/internal">` — the pipeline. So any staff signer whose link did not reach
     DocuSign was silently deposited there, with nothing on screen explaining why.

     `who=staff` comes from /api/esign/sign so this is right even BEFORE a session resolves (a
     staff signer reading mail on a device where they are not signed in); `isStaff` covers a
     signed-in staffer arriving without it. Display routing only — never a trust boundary. */
  const staffSigner = params.get('who') === 'staff' || !!isStaff;

  const [phase, setPhase] = useState(li ? 'exchanging' : 'settle'); // exchanging|settle|signin|error
  const ran = useRef(false);

  const fileHref = staffSigner
    ? (app ? `/internal/app/${app}` : '/internal')
    : (app ? `/app/${app}${state ? `?esign=${encodeURIComponent(state)}` : ''}` : '/dashboard');
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
  /* SUPERSEDED IS ITS OWN OUTCOME, not "already signed". The package this link was for was
     voided, cleared or re-issued, and /sign already looked for a live one and found none — so
     "you have already signed" would be false, and it sends the reader to the wrong place. */
  const superseded = state === 'superseded';
  const place = staffSigner ? 'the file' : 'your loan file';

  let title = 'Thank you';
  let subtitle = 'Your signing session is complete.';
  let body = 'Your documents have been submitted for signing.';
  if (declined) { title = 'No problem'; subtitle = 'Nothing was signed.'; body = `You chose not to sign right now. You can come back to it any time from ${place}.`; }
  else if (superseded) {
    title = 'This package was replaced';
    subtitle = 'Nothing here is waiting on you.';
    body = staffSigner
      ? 'The package this link was for has been voided or re-issued, and there is no newer one waiting for your signature. Open the file to see where it stands — if a new package has since gone out, use the link in that email.'
      : `This set of documents was replaced by a newer one. Open ${place} to see what is waiting for you.`;
  }
  else if (invalid) { title = 'This link has expired'; subtitle = 'Please sign in to continue.'; body = `For your security, signing links expire. Sign in to pick up right where you left off in ${place}.`; }
  else if (state === 'already') { title = 'Already signed'; subtitle = 'These documents are no longer open for signing.'; body = `It looks like this has already been taken care of. Sign in to view ${place} and its documents.`; }
  else if (signed) { title = 'Thank you — you\'re all set'; subtitle = 'Your signature has been received.'; body = `Your signed documents have been received. Sign in to view ${place} and follow every step.`; }

  return (
    <AuthShell title={title} subtitle={subtitle}>
      <div className={`notice ${declined || invalid || superseded ? '' : 'ok'}`} style={{ marginBottom: 16 }}>{body}</div>
      <div className="row" style={{ marginTop: 8, gap: 10 }}>
        {isAuthed
          ? <button className="btn primary" onClick={goToFile}>
              {staffSigner ? (app ? 'Open the file' : 'Open the pipeline') : (app ? 'Go to my loan file' : 'Go to my portal')}
            </button>
          : <button className="btn primary" onClick={goToSignIn}>
              {staffSigner ? 'Sign in to open the file' : 'Sign in to view my file'}
            </button>}
      </div>
    </AuthShell>
  );
}
