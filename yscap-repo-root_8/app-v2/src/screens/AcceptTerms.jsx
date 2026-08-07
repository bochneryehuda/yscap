import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { BrandLockup } from '../components/Layout.jsx';

/* WHERE A BORROWER LANDS FROM THEIR OFFICER'S TERM-SHEET EMAIL (owner-directed
   2026-08-07). The owner's three steps, in his order:

     "1. Go right away and create a password for his account.
      2. Go ahead and collect the initial information.
      3. Start it like a regular file that is registered already, like it's borrower
         registered already with all the terms."

   So the screen is three steps and nothing else. The TERMS are shown first and stay
   visible above every step — somebody agreeing to a loan should be able to see what
   they are agreeing to at the moment they press the button, not one screen earlier.

   THE PASSWORD STEP IS THE EXISTING `/auth/accept`. This screen posts to it exactly
   as the invite screen does; it does not have its own credential path. When the person
   already has a login it asks them to sign in instead — being told to "create" a
   password you already have is the confusing half of every invite flow.

   NOTHING IS LOST BY REFRESHING. Each step re-reads the offer from the server, so a
   closed tab, a forwarded link or a mid-flow refresh resumes rather than restarts, and
   an offer that has already produced a file just opens it. */

export default function AcceptTerms() {
  const { token } = useParams();
  const nav = useNavigate();
  /* `signIn` — NOT the raw `setToken` — because it stores the token AND tells the app
     it is signed in. Writing the token alone leaves the auth context believing nobody
     is, so the very next route (the borrower's own file) bounces to /login: the file
     was created and registered, and the borrower was shown a sign-in page. Same helper
     the invite screen uses. */
  const { signIn } = useAuth();
  const [offer, setOffer] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState('terms');       // terms → account → initial → done
  const [busy, setBusy] = useState(false);

  // Step 1 fields
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  // Step 2 — the "initial information". Deliberately SHORT: the file is born with the
  // officer's figures, so this asks only what the term sheet could not know.
  const [phone, setPhone] = useState('');
  const [vesting, setVesting] = useState('entity');   // defaults to an entity, like every other door
  const [entityName, setEntityName] = useState('');
  const [addressText, setAddressText] = useState('');

  const load = () => {
    setLoading(true);
    api.termSheetOffer(token)
      .then((o) => {
        setOffer(o); setErr('');
        const nm = String(o.borrowerName || '').trim();
        if (nm && !firstName && !lastName) {
          const parts = nm.split(/\s+/);
          setFirstName(parts[0] || '');
          setLastName(parts.slice(1).join(' '));
        }
        if (!addressText && o.property) setAddressText(o.property);
      })
      .catch((e) => setErr(e.message || 'Could not load these terms.'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [token]);   // eslint-disable-line react-hooks/exhaustive-deps

  const terms = useMemo(() => (offer && Array.isArray(offer.terms) ? offer.terms : []), [offer]);

  async function createAccount(e) {
    if (e) e.preventDefault();
    if (password !== password2) { setErr('The two passwords do not match.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.acceptInvite({ token, password, firstName, lastName });
      if (r && r.token) signIn(r.token);
      setStep('initial');
    } catch (e2) {
      setErr(e2.message || 'Could not set your password.');
    } finally { setBusy(false); }
  }

  /* STEP 3 — the file. `initial` carries only what this screen asked; everything else
     comes off the officer's own term sheet on the server, which is what "born with the
     terms" means. */
  async function startApplication(e) {
    if (e) e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.startFromTermSheetOffer(token, {
        phone: phone || undefined,
        personalNamePurchase: vesting === 'individual',
        entityName: vesting === 'entity' ? (entityName || undefined) : undefined,
        propertyAddress: addressText ? { oneLine: addressText } : undefined,
      });
      setStep('done');
      // Straight into the file. It already carries the terms, so there is nothing to
      // review on the way in.
      if (r && r.applicationId) nav('/app/' + r.applicationId);
      else nav('/dashboard');
    } catch (e2) {
      setErr(e2.message || 'Could not start your application.');
      setBusy(false);
    }
  }

  if (loading) {
    return <Shell><p className="muted">Loading your terms…</p></Shell>;
  }
  if (!offer) {
    return (
      <Shell>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>This link isn’t valid</h1>
        <p style={{ color: '#4B585C' }}>{err || 'Ask your loan officer to send your terms again.'}</p>
      </Shell>
    );
  }
  if (offer.state === 'expired') {
    return (
      <Shell>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>These terms have expired</h1>
        <p style={{ color: '#4B585C' }}>
          Ask {offer.officer && offer.officer.name ? offer.officer.name : 'your loan officer'} to send you a fresh term sheet — rates and figures move, so we would rather re-price it than start on stale numbers.
        </p>
        <OfficerCard officer={offer.officer} />
      </Shell>
    );
  }
  if (offer.state === 'accepted') {
    return (
      <Shell>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>You’ve already accepted these terms</h1>
        <p style={{ color: '#4B585C' }}>Your loan application is open and already carries them.</p>
        <button className="btn primary" onClick={() => nav(offer.applicationId ? '/app/' + offer.applicationId : '/dashboard')}>
          Open my loan
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="sos-h" style={{ margin: '0 0 4px' }}>Your loan terms</p>
      <h1 style={{ margin: '0 0 2px', fontSize: 23 }}>{offer.property || 'Your loan'}</h1>
      {offer.officer && offer.officer.name && (
        <p className="muted small" style={{ margin: '0 0 14px' }}>Prepared by {offer.officer.name}</p>
      )}

      {/* THE TERMS STAY ON SCREEN THROUGH EVERY STEP — see the file header. Grouped on
          the section the server put on each row, so the fees read as fees and the cash
          as cash rather than as one twenty-line list. A row with no group still
          renders, so an older stored offer is never blank. */}
      <div style={{ marginBottom: 16 }}>
        {groupTerms(terms).map((sec, gi) => (
          <section className="sos" key={gi}>
            {sec.title && <p className="sos-h">{sec.title}</p>}
            {sec.rows.map((r, i) => {
              // A "Total …" line is the figure its section exists to produce.
              const isTotal = /^Total\b/.test(String(r.k));
              return (
                <div className={'metrow' + (isTotal ? ' sos-total' : '')} key={i}>
                  <span className="k">{r.k}</span><span className="v">{r.v}</span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {offer.hasTermSheet && (
        <p className="small" style={{ margin: '0 0 16px', color: '#4B585C' }}>
          The full term sheet is attached to the email that brought you here.
        </p>
      )}

      {err && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{err}</div>}

      {step === 'terms' && (
        <>
          <button className="btn primary" style={{ width: '100%' }} disabled={busy}
            onClick={() => setStep(offer.hasAccount ? 'signin' : 'account')}>
            Accept Terms and Start Loan Application
          </button>
          <p className="small" style={{ margin: '10px 0 0', color: '#4B585C' }}>
            This is an initial term sheet, not a commitment to lend. It’s subject to underwriting, an appraisal and final approval.
          </p>
        </>
      )}

      {step === 'signin' && (
        <div>
          <p style={{ marginTop: 0, color: '#141B22' }}>
            You already have a PILOT account for <strong>{offer.borrowerEmail}</strong>. Sign in and we’ll start your application with these terms.
          </p>
          <button className="btn primary" onClick={() => nav('/login?next=' + encodeURIComponent('#/accept-terms/' + token))}>
            Sign in to continue
          </button>
          <button className="btn ghost" style={{ marginLeft: 8 }} onClick={() => setStep('initial')}>
            I’m already signed in
          </button>
        </div>
      )}

      {step === 'account' && (
        <form onSubmit={createAccount}>
          <p className="sos-h" style={{ margin: '0 0 6px' }}>Step 1 of 2 — create your password</p>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <label>First name
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
            </label>
            <label>Last name
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            </label>
          </div>
          <label>Email
            <input value={offer.borrowerEmail} readOnly disabled />
          </label>
          <label>Create a password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" required />
          </label>
          <label>Confirm your password
            <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password" required />
          </label>
          <button className="btn primary" type="submit" disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Setting up…' : 'Create my account →'}
          </button>
        </form>
      )}

      {step === 'initial' && (
        <form onSubmit={startApplication}>
          <p className="sos-h" style={{ margin: '0 0 6px' }}>Step 2 of 2 — a few quick details</p>
          <p className="small" style={{ margin: '0 0 10px', color: '#4B585C' }}>
            Everything from your term sheet is already on your file. We just need these.
          </p>
          <label>Property address
            <input value={addressText} onChange={(e) => setAddressText(e.target.value)}
              placeholder="123 Main St, Town, NJ 07000" autoComplete="off" />
          </label>
          <label>Your mobile number
            <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
          </label>
          <label>How will you take title?
            <select value={vesting} onChange={(e) => setVesting(e.target.value)}>
              <option value="entity">In a company (LLC or corporation)</option>
              <option value="individual">In my own name</option>
            </select>
          </label>
          {vesting === 'entity' && (
            <label>Company name (if you have one yet)
              <input value={entityName} onChange={(e) => setEntityName(e.target.value)}
                placeholder="Leave blank if it isn’t formed yet" />
            </label>
          )}
          <button className="btn primary" type="submit" disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Starting your application…' : 'Start my loan application →'}
          </button>
        </form>
      )}

      <OfficerCard officer={offer.officer} />
    </Shell>
  );
}

/* Turn the server's ordered, group-stamped rows into sections, preserving order and
   never dropping a row whose group is blank. */
function groupTerms(rows) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const title = r && r.group ? String(r.group) : '';
    const last = out[out.length - 1];
    if (last && last.title === title) last.rows.push(r);
    else out.push({ title, rows: [r] });
  }
  return out;
}

function Shell({ children }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <div style={{ marginBottom: 16 }}><BrandLockup /></div>
        {children}
      </div>
    </div>
  );
}

function OfficerCard({ officer }) {
  if (!officer || !officer.name) return null;
  return (
    <div className="sos" style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
      <p className="sos-h" style={{ margin: '0 0 4px' }}>Your loan officer</p>
      <div className="metrow"><span className="k">{officer.title || 'Loan officer'}</span><span className="v">{officer.name}</span></div>
      {officer.email && <div className="metrow"><span className="k">Email</span><span className="v">{officer.email}</span></div>}
      {officer.phone && <div className="metrow"><span className="k">Phone</span><span className="v">{officer.phone}</span></div>}
      {officer.nmls && <div className="metrow"><span className="k">NMLS</span><span className="v">{officer.nmls}</span></div>}
    </div>
  );
}
