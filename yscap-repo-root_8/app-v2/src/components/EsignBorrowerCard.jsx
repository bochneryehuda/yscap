import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { PURPOSE } from '../lib/esign.js';

/* Borrower "Sign now" card (owner-directed: the borrower gets an email AND can
 * sign in the portal). Self-contained: fetches its own sanitized package status
 * and renders NOTHING unless there's something to show. Never exposes the admin
 * counter-signer's identity, and only says "binding" once every party has signed
 * (docs/DOCUSIGN-WORKFORCE-BUILD-SPEC §5). */

// A sanitized 3-step tracker. The Heter Iska omits the lender counter-sign step.
function Tracker({ pkg }) {
  const steps = [{ key: 'you', label: 'You' }];
  if (pkg.hasCoBorrower) steps.push({ key: 'co', label: 'Co-borrower' });   // only when there is one
  if (pkg.countersignRequired) steps.push({ key: 'lender', label: 'Lender counter-signs' });
  steps.push({ key: 'done', label: 'Done' });
  // Which step is active?
  let active = 0;
  if (pkg.yourStatus === 'completed') active = steps.length - 1;
  else if (pkg.waitingOnLender) active = steps.findIndex((s) => s.key === 'lender');
  else if (pkg.waitingOnCoBorrower) active = steps.findIndex((s) => s.key === 'co');
  else if (pkg.yourStatus === 'you_signed_waiting') active = 1;
  return (
    <div className="stepper esign-b-track" aria-hidden="true">
      {steps.map((s, i) => (
        <div key={s.key} className={`step ${i < active ? 'done' : ''} ${i === active ? 'active' : ''}`}>{s.label}</div>
      ))}
    </div>
  );
}

export default function EsignBorrowerCard({ appId }) {
  const [packages, setPackages] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get(`/api/borrower/applications/${appId}/esign`); setPackages(r.packages || []); setLoadFailed(false); }
    catch { setPackages([]); setLoadFailed(true); }   // distinguish a fetch error from genuinely empty
  }, [appId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  async function signNow(pkg) {
    setBusy(pkg.envelopeRowId); setErr('');
    try {
      const { url } = await api.post(`/api/borrower/applications/${appId}/esign/sign-view`, { envelopeRowId: pkg.envelopeRowId });
      if (url) window.location.assign(url);   // full navigation into the embedded signing session
    } catch (e) { setErr(e.message || 'Could not open the signing session'); }
    finally { setBusy(''); }
  }

  if (!packages) return null;
  // Only surface packages that have something for the borrower to see/do.
  const shown = packages.filter((p) => ['sign_now', 'you_signed_waiting', 'completed'].includes(p.yourStatus));
  if (!shown.length) {
    // Genuinely nothing to show → render nothing. But if the fetch FAILED, don't
    // silently vanish — a borrower told to sign would see an empty screen.
    if (!loadFailed) return null;
    return (
      <div className="panel esign-b" style={{ marginBottom: 16 }}>
        <p className="muted small" style={{ margin: 0 }}>We couldn’t load your documents just now. Please refresh — or use the signing link in your email.</p>
      </div>
    );
  }

  return (
    <div className="panel esign-b" style={{ marginBottom: 16 }}>
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Sign your documents</h3>
      </div>
      {err && <div role="alert" className="notice err" style={{ margin: '8px 0' }}>{err}</div>}
      {shown.map((p) => {
        const label = PURPOSE[p.purpose] || p.purpose;
        return (
          <div key={p.envelopeRowId} className="esign-b-item">
            <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong>{label}</strong>
              {p.yourStatus === 'sign_now' && <span className="pill new">Ready for your signature</span>}
              {p.yourStatus === 'you_signed_waiting' && <span className="pill ok">You’ve signed ✓</span>}
              {p.yourStatus === 'completed' && <span className="pill ok">Fully signed</span>}
            </div>
            <Tracker pkg={p} />
            {p.yourStatus === 'sign_now' && (
              <>
                <p className="muted small" style={{ margin: '4px 0 10px' }}>
                  Review and sign right here — or use the DocuSign email we sent you. You can sign from your phone.
                </p>
                <button className="btn primary" disabled={busy === p.envelopeRowId} onClick={() => signNow(p)}>
                  {busy === p.envelopeRowId ? 'Opening…' : 'Sign now'}
                </button>
              </>
            )}
            {p.yourStatus === 'you_signed_waiting' && (
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                Your part is done — {p.waitingOnCoBorrower ? `waiting on your co-borrower${p.coBorrowerName ? ` (${p.coBorrowerName})` : ''} to sign` : p.waitingOnLender ? 'now with your lender for the final counter-signature' : 'waiting on the other signer'}.
              </p>
            )}
            {p.yourStatus === 'completed' && (
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                All parties have signed — this is now fully executed. Your signed copy is on your file.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
