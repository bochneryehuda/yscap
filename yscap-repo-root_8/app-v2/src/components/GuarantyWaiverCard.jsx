import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* Personal-guaranty status + the co-borrower guaranty-waiver request flow on a
   loan file (owner-directed 2026-07-22). STAFF file view only.

   By default both borrowers personally guarantee the loan (full recourse) and
   both show as guarantors on the term sheet. Any staff member may REQUEST that
   the co-borrower's personal guarantee be waived (they stay a member of the
   borrowing entity but are not a guarantor); a super-admin approves it in the
   Exceptions box, which flips the file flag so the term sheet reflects it.

   Self-hides when the file has no co-borrower (nothing to waive). */
export default function GuarantyWaiverCard({ appId }) {
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState('passive_member');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.fileExceptions(appId).then(setState).catch(() => {});
  useEffect(() => { if (appId) load(); /* eslint-disable-next-line */ }, [appId]);

  if (!state || !state.hasCoBorrower) return null;   // only meaningful with a co-borrower
  const gw = state.guarantyWaiver;
  const waived = !!state.coBorrowerPgWaived;
  const openReq = gw && gw.status === 'requested';
  const coName = state.coBorrowerName || 'the co-borrower';
  const reasons = state.reasonCodes || {};

  const submit = async () => {
    setBusy(true); setErr('');
    try { await api.requestGuarantyWaiver(appId, { reasonCode, reasonNote: note }); setOpen(false); setNote(''); await load(); }
    catch (e) { setErr((e && e.message) || 'Could not send the request.'); }
    finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true); setErr('');
    try { await api.withdrawException(appId, gw.id); await load(); }
    catch (e) { setErr((e && e.message) || 'Could not withdraw the request.'); }
    finally { setBusy(false); }
  };

  return (
    <div className={`notice ${waived ? 'ok' : ''}`} style={{ marginTop: 10 }}>
      <strong>Personal guaranty.</strong>{' '}
      {waived
        ? <>The co-borrower’s personal guarantee is <b>waived</b> (approved exception). {coName} shows on the term sheet as a member of the borrowing entity, not a personal guarantor — the primary borrower is the sole guarantor (full recourse).</>
        : <>Both borrowers personally guarantee this loan — <b>full recourse</b>, and both are listed as guarantors on the term sheet.</>}

      {!waived && openReq && (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
          <span className="ts-badge warn">Waiver requested — awaiting super-admin approval</span>
          <button className="btn ghost small" disabled={busy} onClick={withdraw}>Withdraw request</button>
        </div>
      )}

      {!waived && !openReq && (
        <div style={{ marginTop: 8 }}>
          {!open ? (
            <button className="btn ghost small" onClick={() => { setOpen(true); setErr(''); }}>
              Request guarantee waiver for {coName}
            </button>
          ) : (
            <div style={{ padding: 10, background: 'rgba(174,135,70,0.08)', border: '1px solid #AE8746', borderRadius: 8 }}>
              <div className="muted small" style={{ marginBottom: 6 }}>
                Ask a super-admin to waive {coName}’s personal guarantee (rare). They stay a member/owner of the
                LLC but won’t be a personal guarantor. This goes to the Exceptions box for approval — the term
                sheet updates only if it’s approved.
              </div>
              <label className="muted small">Reason</label>
              <select className="input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}
                style={{ width: '100%', marginBottom: 6 }}>
                {Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <textarea className="input" rows={2} style={{ width: '100%' }}
                placeholder="Explain why this waiver is warranted…"
                value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn primary small" disabled={busy || !note.trim()} onClick={submit}>
                  {busy ? 'Sending…' : 'Send request'}
                </button>
                <button className="btn ghost small" onClick={() => { setOpen(false); setNote(''); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {!waived && gw && gw.status === 'denied' && (
        <div className="muted small" style={{ marginTop: 6 }}>
          A previous waiver request was denied{gw.decision_note ? ` — ${gw.decision_note}` : ''}. Both borrowers remain guarantors.
        </div>
      )}
      {err && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}
