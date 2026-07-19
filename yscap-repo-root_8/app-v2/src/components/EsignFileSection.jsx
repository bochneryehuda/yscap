import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import {
  PHASE, PURPOSE, ROLE, timeAgo, absTime, recipientSteps, recipientState,
  agingHours, agingLevel, agingLabel,
} from '../lib/esign.js';

/* Per-file DocuSign section on the internal file screen (owner-directed: "a full
 * DocuSign section... before send show what's outstanding, then live tracking —
 * timestamps, viewed/signed, who we're waiting on, plus resend"). This is the
 * per-file twin of the cross-file cockpit (/internal/esign): the readiness gate
 * + the two Send buttons + every envelope's live per-signer timeline + the
 * management actions (resend / void / re-issue / admin counter-sign / download).
 *
 * Everything is gated server-side (DOCUSIGN_SEND_ENABLED); a disabled send comes
 * back as a clear 409 we surface rather than pretending it sent. */

const PACKAGES = [
  { purpose: 'term_sheet_package', label: 'Term-sheet package', hint: 'Term sheet + application + business-purpose disclosure. Borrower (+ co-borrower) sign, then you counter-sign last.' },
  { purpose: 'heter_iska', label: 'Heter Iska', hint: 'Standalone. Borrower/guarantor sign only — no counter-signature. Never in the TPR export or SharePoint.' },
];

function Recipient({ r }) {
  const steps = recipientSteps(r);
  const state = recipientState(r);
  const declined = state === 'bad';
  const signed = state === 'done';
  return (
    <div className={`esr esr-${state}`}>
      <div className="esr-head">
        <span className="esr-order" aria-hidden="true">{r.routingOrder}</span>
        <span className="esr-who">
          <strong>{r.name || '(no name)'}</strong>
          <span className="muted small">{ROLE[r.role] || r.role}{r.isCountersigner ? ' · signs last' : ''}</span>
        </span>
        <span className="spacer" />
        <span className={`pill ${declined ? 'declined' : signed ? 'ok' : 'muted'}`}>
          {declined ? 'Declined' : signed ? 'Signed' : (r.deliveredAt ? 'Viewing' : 'Waiting')}
        </span>
      </div>
      <div className="esr-mail muted small">{r.email}</div>
      <ol className="esr-steps">
        {steps.map((s) => (
          <li key={s.key} className={`${s.done ? 'on' : ''} ${s.bad ? 'bad' : ''}`}>
            <span className="esr-step-label">{s.label}</span>
            {s.at ? <span className="esr-step-time" title={absTime(s.at)}>{timeAgo(s.at)}</span> : <span className="esr-step-time muted">—</span>}
          </li>
        ))}
      </ol>
      {declined && r.declineReason ? <div className="notice err" style={{ margin: '8px 0 0' }}>Reason: {r.declineReason}</div> : null}
    </div>
  );
}

export default function EsignFileSection({ appId, role }) {
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [data, setData] = useState(null);   // { gate, packages, envelopes }
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');      // action key currently running
  const seq = useRef(0);

  const load = useCallback(async (quiet) => {
    const mine = ++seq.current;
    if (!quiet) setErr('');
    try {
      const r = await api.get(`/api/staff/applications/${appId}/esign`);
      if (mine === seq.current) setData(r);
    } catch (e) { if (mine === seq.current && !quiet) setErr(e.message || 'Could not load e-signatures'); }
  }, [appId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(true); }, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function act(key, fn, okMsg) {
    setBusy(key); setErr(''); setMsg('');
    try { await fn(); if (okMsg) setMsg(okMsg); await load(true); }
    catch (e) { setErr(e.message || 'Action failed'); }
    finally { setBusy(''); }
  }

  const send = (purpose) => act(`send:${purpose}`, async () => {
    const r = await api.post(`/api/staff/applications/${appId}/esign/send`, { purpose });
    // A dead-lettered send returns 200 with ok:false — don't show a false success.
    if (r && (r.dead || r.ok === false)) throw new Error(r.error || 'The document could not be sent — check the file and try again.');
  }, 'Sent for signature.');
  const resend = (rowId) => act(`resend:${rowId}`, () => api.post(`/api/staff/esign/${rowId}/resend`), 'Reminder resent.');
  const voidEnv = (rowId) => {
    const reason = window.prompt('Void this envelope — reason (required):');
    if (!reason || !reason.trim()) return;
    return act(`void:${rowId}`, () => api.post(`/api/staff/esign/${rowId}/void`, { reason }), 'Envelope voided.');
  };
  const countersign = (rowId) => act(`cs:${rowId}`, async () => {
    const { url } = await api.post(`/api/staff/esign/${rowId}/countersign-view`);
    // Navigate in the SAME tab — window.open() after an await is outside the user
    // gesture and gets popup-blocked (Safari especially). DocuSign bounces staff
    // back to the file when done.
    if (!url) throw new Error('Could not open the signing view — please try again.');
    window.location.assign(url);
  });
  const download = (doc) => act(`dl:${doc.documentId}`, async () => {
    const { blob, filename } = await api.staffDownloadDoc(doc.documentId);
    saveBlob(blob, filename || doc.filename);
  });

  if (data == null) return <p className="muted small">Loading…</p>;
  const gate = data.gate || { ready: false, outstanding: [] };
  const envelopes = data.envelopes || [];

  return (
    <div className="esign-file">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}

      {/* Readiness gate + Send buttons */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h4 style={{ margin: 0 }}>Ready to send?</h4>
          <div className="spacer" />
          <span className={`pill ${gate.ready ? 'ok' : 'muted'}`}>{gate.ready ? 'All prerequisites met' : 'Not yet'}</span>
        </div>
        <ul className="esign-gate">
          {gate.ready ? (
            <li className="ok"><span className="esign-gate-ic">✓</span> Appraisal back · reviewed · product re-priced after the appraisal.</li>
          ) : gate.outstanding.map((o) => (
            <li key={o.code} className="bad"><span className="esign-gate-ic">✗</span> <strong>{o.label}</strong> — <span className="muted small">{o.reason}</span></li>
          ))}
        </ul>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {PACKAGES.map((p) => (
            <button key={p.purpose} className="btn primary btn-sm" disabled={!gate.ready || busy === `send:${p.purpose}`}
              title={gate.ready ? p.hint : 'Complete the prerequisites above first'}
              onClick={() => send(p.purpose)}>
              {busy === `send:${p.purpose}` ? 'Sending…' : `Send ${p.label}`}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Sending is gated while the integration is in test mode — a real borrower is never emailed until go-live.
        </p>
      </div>

      {/* Live envelopes */}
      {envelopes.length === 0 ? (
        <p className="muted small">No packages sent yet.</p>
      ) : envelopes.map((e) => {
        const ph = PHASE[e.phase] || { label: e.phase, cls: 'muted', dot: '#4B585C' };
        const h = agingHours(e);
        const lvl = agingLevel(h);
        const terminal = ['completed', 'declined', 'voided', 'error'].includes(e.phase);
        const recips = (e.recipients || []).slice().sort((a, b) => Number(a.routingOrder) - Number(b.routingOrder) || String(a.role).localeCompare(String(b.role)));
        return (
          <div className="panel esign-card" key={e.id} style={{ marginBottom: 12 }}>
            <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="pill muted">{PURPOSE[e.purpose] || e.purpose}</span>
              <span className={`pill ${ph.cls}`}><span className="esign-dot" style={{ background: ph.dot }} aria-hidden="true" />{ph.label}</span>
              {e.waitingOn && lvl ? (
                <span className={`pill esign-aging ${lvl}`} title={`No progress for ${agingLabel(h)}`}>⏱ {agingLabel(h)}</span>
              ) : null}
              <div className="spacer" />
              {e.envelopeId ? <span className="muted small esign-env" title="DocuSign envelope ID">{e.envelopeId}</span> : null}
            </div>

            {e.waitingOn ? (
              <div className={`esign-waiting ${e.phase === 'awaiting_countersign' ? 'is-admin' : ''}`}>
                {e.phase === 'awaiting_countersign'
                  ? <>Ready for your counter-signature — <strong>{e.waitingOn.name}</strong></>
                  : <>Waiting on <strong>{e.waitingOn.name}</strong> ({ROLE[e.waitingOn.role] || e.waitingOn.role})</>}
              </div>
            ) : null}
            {(e.phase === 'error' || e.deadLetteredAt) && e.lastError ? <div className="notice err" style={{ margin: '10px 0 0' }}><strong>Send failed.</strong> {e.lastError}</div> : null}
            {e.phase === 'voided' && e.voidReason ? <div className="notice info" style={{ margin: '10px 0 0' }}>Voided: {e.voidReason}</div> : null}

            <div className="esign-recips">
              {recips.map((r) => <Recipient key={r.id || `${r.role}-${r.routingOrder}`} r={r} />)}
            </div>

            {/* Actions */}
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {e.phase === 'awaiting_countersign' && isAdmin && (
                <button className="btn primary btn-sm" disabled={busy === `cs:${e.id}`} onClick={() => countersign(e.id)}>
                  {busy === `cs:${e.id}` ? '…' : 'Counter-sign now'}
                </button>
              )}
              {!terminal && e.envelopeId && (
                <>
                  <button className="btn ghost btn-sm" disabled={busy === `resend:${e.id}`} onClick={() => resend(e.id)}>{busy === `resend:${e.id}` ? '…' : 'Resend reminder'}</button>
                  <button className="btn ghost btn-sm" disabled={busy === `void:${e.id}`} onClick={() => voidEnv(e.id)}>Void</button>
                </>
              )}
              {(e.phase === 'declined' || e.phase === 'voided' || e.phase === 'error') && gate.ready && (
                <button className="btn primary btn-sm" disabled={busy === `send:${e.purpose}`} title="Send a fresh envelope for this package"
                  onClick={() => send(e.purpose)}>{busy === `send:${e.purpose}` ? '…' : (e.phase === 'error' ? 'Retry send' : 'Re-issue')}</button>
              )}
              {(e.documents || []).map((d) => (
                <button key={d.documentId} className="btn ghost btn-sm" disabled={busy === `dl:${d.documentId}`} onClick={() => download(d)}
                  title={`Download ${d.filename}`}>{busy === `dl:${d.documentId}` ? '…' : `↓ ${(d.docKind || '').replace(/_/g, ' ')}`}</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
