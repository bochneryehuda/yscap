import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { askPrompt } from '../lib/dialog.js';
import {
  PHASE, PURPOSE, ROLE, TERMINAL, timeAgo, absTime as abs, recipientSteps,
  agingHours, agingLevel, agingLabel,
} from '../lib/esign.js';
import { useUrlState } from '../lib/useUrlState.js';

/* E-Signatures — PILOT's own DocuSign cockpit (owner-directed 2026-07-19:
 * "our own page that would sound like we have our own DocuSign system within
 * our system — track everything, monitor everything, manage everything").
 *
 * This is the CROSS-FILE live view: every envelope we've sent, its derived
 * human-facing phase (DocuSign has no native "awaiting counter-signature"
 * status — we derive it from routing order + recipients; see
 * docs/DOCUSIGN-WORKFORCE-BUILD-SPEC.md §11), a per-signer timeline
 * (sent → viewed → signed, with timestamps), and an SLA aging clock so a stalled
 * package is obvious. It polls live so the floor can watch a package move without
 * leaving the screen. Management actions live per-file (EsignFileSection). */

// Filter tabs: which phases each shows. "attention" is the human-action bucket.
const TABS = [
  { key: 'all',       label: 'All' },
  { key: 'outstanding', label: 'Outstanding' },   // everything still in flight (not completed/declined/voided/error)
  { key: 'borrower',  label: 'Awaiting borrower', phases: ['awaiting_borrower'] },
  { key: 'admin',     label: 'Awaiting my signature', phases: ['awaiting_countersign'] },
  { key: 'completed', label: 'Completed', phases: ['completed'] },
  { key: 'attention', label: 'Needs attention' },   // declined / error / dead-lettered
  { key: 'closed',    label: 'Declined / voided', phases: ['declined', 'voided'] },
];

function Recipient({ r }) {
  const steps = recipientSteps(r);
  const declined = r.declinedAt || r.status === 'declined';
  const signed = r.signedAt || r.status === 'completed' || r.status === 'signed';
  const state = declined ? 'bad' : signed ? 'done' : 'pending';
  return (
    <div className={`esr esr-${state}`}>
      <div className="esr-head">
        <span className="esr-order" aria-hidden="true">{r.routingOrder}</span>
        <span className="esr-who">
          <strong>{r.name || '(no name)'}</strong>
          <span className="muted small">{ROLE[r.role] || r.role}{r.isCountersigner ? ' · signs last' : ''}{r.embedded ? ' · in-portal + email' : ''}</span>
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
            {s.at ? <span className="esr-step-time" title={abs(s.at)}>{timeAgo(s.at)}</span> : <span className="esr-step-time muted">—</span>}
          </li>
        ))}
      </ol>
      {declined && r.declineReason ? (
        <div className="notice err" style={{ margin: '8px 0 0' }}>Reason: {r.declineReason}</div>
      ) : null}
    </div>
  );
}

function EnvelopeCard({ e, onReload, isAdmin }) {
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState('');
  const [emailEdit, setEmailEdit] = useState(null);   // inline "change a signer's email" editor: { rid, email, name }
  const [emailWarn, setEmailWarn] = useState(null);    // after a change: { newEmail, fileEmail, borrowerId, name } — "also update the file" reminder
  // A test envelope's resend/void is admin-only server-side (403 otherwise) — don't
  // show the buttons to a see-all non-admin, or a click just errors. Real envelopes
  // stay open to all staff.
  const canResend = !!e.envelopeId && !TERMINAL.includes(e.phase) && (!e.isTest || isAdmin);   // one shared terminal vocabulary across all e-sign surfaces
  const canVoid = canResend;   // same window: sent but not yet finished
  async function resend() {
    setBusy(true); setActErr('');
    try { await api.post(`/api/staff/esign/${e.id}/resend`); if (onReload) onReload(); }
    catch (err) { setActErr(err.message || 'Could not resend the email.'); }
    finally { setBusy(false); }
  }
  async function voidEnv() {
    const reason = await askPrompt('Cancel (void) this package — the signer can no longer sign it. Reason (required):');
    if (!reason || !reason.trim()) return;
    setBusy(true); setActErr('');
    try { await api.post(`/api/staff/esign/${e.id}/void`, { reason: reason.trim() }); if (onReload) onReload(); }
    catch (err) { setActErr(err.message || 'Could not cancel the package.'); }
    finally { setBusy(false); }
  }
  async function dl(documentId, fallbackName) {
    setActErr('');
    try { const { blob, filename } = await api.staffDownloadDoc(documentId); saveBlob(blob, filename || fallbackName); }
    catch (err) { setActErr(err.message || 'Could not download the document.'); }
  }
  // A pending BORROWER / CO-BORROWER on an in-flight envelope can be re-addressed —
  // change their email and re-send the invitation, for any package (owner-directed).
  // The counter-signer + loan-officer emails are system-sourced and never re-addressed
  // here (the server enforces this too).
  const canEditEmail = (r) => !!e.envelopeId && !TERMINAL.includes(e.phase)
    && ['borrower', 'co_borrower'].includes(r.role)
    && !(r.signedAt || r.status === 'completed' || r.status === 'signed') && !(r.declinedAt || r.status === 'declined');
  async function changeEmail(r) {
    const email = String((emailEdit && emailEdit.email) || '').trim();
    const name = String((emailEdit && emailEdit.name) || '').trim();
    if (!email) { setActErr('Enter the new email address.'); return; }
    setBusy(true); setActErr('');
    try {
      const res = await api.post(`/api/staff/esign/${e.id}/recipient-email`, { recipientRowId: r.id, email, ...(name ? { name } : {}) });
      setEmailEdit(null);
      if (res && res.differsFromFile && res.borrowerId) setEmailWarn({ newEmail: res.email, fileEmail: res.fileEmail, borrowerId: res.borrowerId, name: res.name });
      if (onReload) onReload();
    } catch (err) { setActErr(err.message || 'Could not change the email.'); }
    finally { setBusy(false); }
  }
  // Optional convenience: also set the file's borrower email through the ONE shared
  // borrower writer (PATCH /borrowers/:id) — never a new write path.
  async function updateFileEmail() {
    if (!emailWarn) return;
    setBusy(true); setActErr('');
    try { await api.staffUpdateBorrower(emailWarn.borrowerId, { email: emailWarn.newEmail }); setEmailWarn(null); if (onReload) onReload(); }
    catch (err) { setActErr(err.message || 'Could not update the file email automatically — update it in the borrower section.'); }
    finally { setBusy(false); }
  }
  const docLabel = (kind) => String(kind || 'signed document').replace(/_signed$/, '').replace(/_/g, ' ');
  const ph = PHASE[e.phase] || { label: e.phase, cls: 'muted', dot: '#4B585C' };
  const who = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const recips = (e.recipients || []).slice().sort(
    (a, b) => Number(a.routingOrder) - Number(b.routingOrder) || String(a.role).localeCompare(String(b.role)));
  const sentSummary = e.sentAt ? `Sent ${timeAgo(e.sentAt)}` : (e.status === 'not_sent' ? 'Not sent yet' : '');
  const h = agingHours(e);
  const lvl = agingLevel(h);
  return (
    <div className="panel esign-card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="pill muted">{PURPOSE[e.purpose] || e.purpose}</span>
        {e.isTest ? <span className="pill" style={{ background: '#AE8746', color: '#fff' }} title="A self-test — not a real loan file">TEST</span> : null}
        <strong>{e.loanNumber || who || (e.applicationId ? `File #${e.applicationId}` : 'Test')}</strong>
        {e.propertyAddress ? <span className="muted small">{e.propertyAddress}</span> : null}
        <div className="spacer" />
        {e.waitingOn && lvl ? (
          <span className={`pill esign-aging ${lvl}`} title={`No progress for ${agingLabel(h)}`}>⏱ {agingLabel(h)}</span>
        ) : null}
        <span className={`pill ${ph.cls}`} title={`DocuSign envelope ${e.envelopeId || '(not created yet)'}`}>
          <span className="esign-dot" style={{ background: ph.dot }} aria-hidden="true" />{ph.label}
        </span>
        {e.applicationId ? <Link className="btn ghost btn-sm" to={`/internal/app/${e.applicationId}`}>Open file</Link> : null}
        {canResend ? <button className="btn ghost btn-sm" disabled={busy} onClick={resend} title="Resend the DocuSign email to the current signer">{busy ? 'Resending…' : 'Resend email'}</button> : null}
        {canVoid ? <button className="btn ghost btn-sm" disabled={busy} onClick={voidEnv} title="Cancel this package — the signer can no longer sign">Void</button> : null}
      </div>
      {actErr ? <div role="alert" className="notice err" style={{ margin: '8px 0 0' }}>{actErr}</div> : null}

      {e.waitingOn ? (
        <div className={`esign-waiting ${e.phase === 'awaiting_countersign' ? 'is-admin' : ''}`}>
          {e.phase === 'awaiting_countersign'
            ? <>Ready for your counter-signature — <strong>{e.waitingOn.name}</strong> ({ROLE[e.waitingOn.role] || e.waitingOn.role})</>
            : <>Waiting on <strong>{e.waitingOn.name}</strong> ({ROLE[e.waitingOn.role] || e.waitingOn.role})</>}
        </div>
      ) : null}

      {(e.phase === 'error' || e.deadLetteredAt) && e.lastError ? (
        <div className="notice err" style={{ margin: '10px 0 0' }}>
          <strong>Send failed.</strong> {e.lastError}
        </div>
      ) : null}
      {e.phase === 'voided' && e.voidReason ? (
        <div className="notice info" style={{ margin: '10px 0 0' }}>Voided: {e.voidReason}</div>
      ) : null}

      <div className="esign-recips">
        {recips.length === 0
          ? <p className="muted small" style={{ margin: '10px 0 0' }}>No recipients recorded yet.</p>
          : recips.map((r) => {
            const editing = emailEdit && emailEdit.rid === r.id;
            return (
              <div key={r.id || `${r.role}-${r.routingOrder}`}>
                <Recipient r={r} />
                {canEditEmail(r) && !editing ? (
                  <div style={{ margin: '-2px 0 10px', paddingLeft: 4 }}>
                    <button className="btn ghost btn-sm" onClick={() => { setEmailWarn(null); setActErr(''); setEmailEdit({ rid: r.id, email: r.email || '', name: r.name || '' }); }}
                      title="Wrong email? Change it and re-send the invitation to the new address — no need to void and re-issue.">✎ Change email &amp; re-send</button>
                  </div>
                ) : null}
                {editing ? (
                  <div className="notice info" style={{ margin: '2px 0 10px' }}>
                    <div className="muted small" style={{ marginBottom: 6 }}>Re-address this invitation. DocuSign re-sends it to the new email right away; the old link stops working.</div>
                    <input className="input" type="email" style={{ width: '100%', maxWidth: 340 }} placeholder="name@example.com"
                      value={emailEdit.email} onChange={(ev) => setEmailEdit((s) => ({ ...s, email: ev.target.value }))}
                      onKeyDown={(ev) => { if (ev.key === 'Enter' && !busy) changeEmail(r); }} />
                    <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn primary btn-sm" disabled={busy || !String(emailEdit.email || '').trim()} onClick={() => changeEmail(r)}>{busy ? 'Updating…' : 'Change email & re-send'}</button>
                      <button className="btn ghost btn-sm" onClick={() => setEmailEdit(null)}>Cancel</button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
      </div>
      {emailWarn ? (
        <div className="notice warn" style={{ margin: '10px 0 0' }}>
          <div>
            <strong>This changed the email for this signing package only.</strong>{' '}
            If <strong>{emailWarn.newEmail}</strong> is {emailWarn.name || 'the borrower'}’s correct email, also update it
            on the file so future packages and emails go there
            {emailWarn.fileEmail ? <> — the file still shows <strong>{emailWarn.fileEmail}</strong></> : null}.
            {' '}If it was a one-off fix, leave the file as it is.
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn primary btn-sm" disabled={busy} onClick={updateFileEmail}>Update it on the file too</button>
            <button className="btn ghost btn-sm" onClick={() => setEmailWarn(null)}>Keep the file as it is</button>
          </div>
        </div>
      ) : null}

      {(e.documents && e.documents.length) || e.certificate ? (
        <div className="row" style={{ gap: 6, margin: '10px 0 0', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span className="muted small">Signed:</span>
          {(e.documents || []).map((d) => (
            <button key={d.documentId} className="btn ghost btn-sm" onClick={() => dl(d.documentId, d.filename)}
              title={`Download the signed ${docLabel(d.docKind)}`}>↓ {docLabel(d.docKind)}</button>
          ))}
          {e.certificate ? (
            <button className="btn ghost btn-sm" onClick={() => dl(e.certificate.documentId, e.certificate.filename)}
              title="DocuSign Certificate of Completion — the legal audit trail (signers, times, IP)">↓ certificate</button>
          ) : null}
        </div>
      ) : null}

      <div className="esign-foot muted small">
        <span>{sentSummary}</span>
        {e.completedAt ? <span> · Completed {timeAgo(e.completedAt)}</span> : null}
        {e.countersignRequired ? <span> · Admin counter-sign required</span> : <span> · No counter-signature</span>}
        {e.envelopeId ? <span className="esign-env" title="DocuSign envelope ID"> · {e.envelopeId}</span> : null}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone, active, onClick }) {
  return (
    <button type="button" className={`esign-stat ${tone || ''} ${active ? 'on' : ''}`} onClick={onClick}>
      <span className="esign-stat-n">{value}</span>
      <span className="esign-stat-l">{label}</span>
    </button>
  );
}

export default function EsignDashboard() {
  const { role } = useAuth();
  const isAdmin = ['admin', 'super_admin'].includes(role);
  const [data, setData] = useState(null);   // { envelopes, counts }
  const [err, setErr] = useState('');
  const [tab, setTab] = useUrlState('tab', 'all', { remember: 'esign.tab' });
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [conn, setConn] = useState(null);   // DocuSign connection + mode (admin)
  const seq = useRef(0);

  // Admin-only "are we live?" readout — fetched on mount + manual refresh (NOT on the
  // 30s auto-tick, so it never hammers DocuSign). Best-effort: a failure just hides it.
  const loadConn = useCallback(async () => {
    if (!isAdmin) return;
    try { setConn(await api.get('/api/staff/esign/connection')); } catch (_) { /* best-effort */ }
  }, [isAdmin]);
  useEffect(() => { loadConn(); }, [loadConn]);

  // Admin self-test: send a sample envelope to my own email to confirm DocuSign
  // renders our documents + the signing flow works, without a real loan file.
  async function sendTest() {
    setTestBusy(true); setTestMsg(''); setErr('');
    try {
      const r = await api.post('/api/staff/esign/test-send', {});
      const n = (r.packages && r.packages.length) || 1;
      setTestMsg(`Sent ${n} test package${n > 1 ? 's' : ''} to ${r.to} — check your email to review and sign. They appear below marked TEST, and you can open and track them as they move.`);
      load(true);
    } catch (e) {
      setErr(e.message || 'Could not send the test envelope.');
    } finally { setTestBusy(false); }
  }

  const load = useCallback(async (quiet) => {
    const mine = ++seq.current;
    if (!quiet) setErr('');
    try {
      const r = await api.get('/api/staff/esign/dashboard');
      if (mine === seq.current) { setData(r); setRefreshedAt(new Date()); }
    } catch (e) {
      if (mine === seq.current && !quiet) { setErr(e.message || 'Could not load e-signatures'); }
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Live: refresh every 30s, but only while the tab is visible (a hidden tab
  // shouldn't hammer DocuSign-derived queries). Resume immediately on focus.
  useEffect(() => {
    let t = null;
    const tick = () => { if (!document.hidden) load(true); };
    t = setInterval(tick, 30000);
    const onVis = () => { if (!document.hidden) load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const counts = (data && data.counts) || {};
  const envelopes = (data && data.envelopes) || [];
  const sendHealth = (data && data.sendHealth) || null;
  const attention = (e) => ['declined', 'error'].includes(e.phase) || e.deadLetteredAt;   // a deliberate void is resolved, not "needs attention"
  const isOutstanding = (e) => !TERMINAL.includes(e.phase);   // still in flight: awaiting borrower / counter-sign
  const outstandingCount = envelopes.filter(isOutstanding).length;
  const shown = envelopes.filter((e) => {
    const t = TABS.find((x) => x.key === tab);
    if (!t || t.key === 'all') return true;
    if (t.key === 'outstanding') return isOutstanding(e);
    if (t.key === 'attention') return attention(e);
    return (t.phases || []).includes(e.phase);
  });

  return (
    <div className="page esign-page">
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <div>
          <h2 style={{ margin: 0 }}>E-Signatures</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            PILOT’s own DocuSign cockpit — every package, every signer, live.
          </p>
        </div>
        <div className="spacer" />
        {isAdmin && (
          <button className="btn ghost btn-sm" disabled={testBusy} onClick={sendTest}
            title="Send a sample envelope to your own email to confirm signing works">
            {testBusy ? 'Sending…' : 'Send myself a test'}
          </button>
        )}
        <button className="btn ghost btn-sm" onClick={() => { load(); loadConn(); }} title="Refresh now">Refresh</button>
      </div>
      {testMsg && <div className="notice ok" style={{ marginBottom: 12 }}>{testMsg}</div>}

      {/* Are we live? — the plain-English DocuSign mode readout (admins only). Tells the
          owner exactly what still keeps real borrowers from being emailed. */}
      {isAdmin && conn && (
        <div className="notice" style={{ marginBottom: 12, borderLeft: `4px solid ${conn.liveToBorrowers ? 'var(--success, #2F7F86)' : 'var(--gold, #AE8746)'}` }}>
          <strong>{conn.liveToBorrowers
            ? '🟢 Live — real borrowers receive documents'
            : '🟡 Test mode — real borrowers are NOT emailed yet'}</strong>
          <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>DocuSign account: <strong>{conn.reachable ? (conn.demo ? 'Practice (sandbox)' : 'Live') : (conn.configured ? 'not reachable — check the credentials' : 'not set up yet')}</strong>{conn.accountName ? ` — ${conn.accountName}` : ''}{conn.reachError ? ` (${conn.reachError})` : ''}</li>
            <li>Sending switch: <strong>{conn.sendEnabled ? 'On' : 'Off'}</strong></li>
            <li>Test mode: <strong>{conn.testMode ? 'On' : 'Off'}</strong>{conn.testMode && (conn.allowlist || []).length ? ` — only these emails receive documents: ${conn.allowlist.join(', ')}` : ''}</li>
          </ul>
          {!conn.liveToBorrowers && (
            <div className="small" style={{ marginTop: 6 }}>
              <strong>Still needed to go live:</strong> {[
                !conn.configured && 'add the DocuSign credentials',
                conn.configured && conn.reachable === false && 'fix the credentials so DocuSign connects',
                conn.reachable && conn.demo && 'switch to the live DocuSign account (the DocuSign “Go-Live” promotion)',
                !conn.sendEnabled && 'turn the sending switch on',
                conn.testMode && 'turn test mode off',
              ].filter(Boolean).join('; ') || 'checking…'}.
            </div>
          )}
        </div>
      )}
      {refreshedAt && (
        <p className="muted small" style={{ margin: '0 0 14px' }} aria-live="polite">
          <span className="esign-live" aria-hidden="true" /> Live — updated {timeAgo(refreshedAt.toISOString())}
        </p>
      )}

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      {/* Send-engine health — tells staff "it's DocuSign / it's paused" vs "PILOT is broken." */}
      {sendHealth && !sendHealth.sendEnabled && (
        <div className="notice info" style={{ marginBottom: 12 }}>
          <strong>Sending is paused.</strong> New packages and resends are held until sending is turned back on — already-sent packages still track and update normally.
        </div>
      )}
      {sendHealth && sendHealth.sendEnabled && sendHealth.breakerOpen && (
        <div className="notice info" style={{ marginBottom: 12 }}>
          <strong>DocuSign is busy right now.</strong> Sends are automatically pacing themselves and will catch up — nothing is lost.
        </div>
      )}
      {sendHealth && sendHealth.sendEnabled && !sendHealth.breakerOpen && sendHealth.backingOff > 0 && (
        <div className="notice info" style={{ marginBottom: 12 }}>
          {sendHealth.backingOff} package{sendHealth.backingOff > 1 ? 's are' : ' is'} waiting to send (DocuSign was briefly unavailable) — retrying automatically.
        </div>
      )}

      <div className="esign-stats">
        <StatCard label="All packages" value={counts.total || 0} active={tab === 'all'} onClick={() => setTab('all')} />
        <StatCard label="Outstanding" value={outstandingCount} tone="teal" active={tab === 'outstanding'} onClick={() => setTab('outstanding')} />
        <StatCard label="Awaiting borrower" value={counts.awaiting_borrower || 0} tone="teal" active={tab === 'borrower'} onClick={() => setTab('borrower')} />
        <StatCard label="Awaiting my signature" value={counts.awaitingCountersign || 0} tone="gold" active={tab === 'admin'} onClick={() => setTab('admin')} />
        <StatCard label="Completed" value={counts.completed || 0} tone="ok" active={tab === 'completed'} onClick={() => setTab('completed')} />
        <StatCard label="Needs attention" value={counts.needsAttention || 0} tone="bad" active={tab === 'attention'} onClick={() => setTab('attention')} />
      </div>

      <div className="esign-tabs" role="tablist" aria-label="Filter e-signatures">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
            className={`esign-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {data == null ? (
        <p className="muted small">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>
          {tab === 'all'
            ? 'No e-signature packages yet. They appear here the moment a term-sheet package or Heter Iska is sent.'
            : 'Nothing in this view right now.'}
        </p></div>
      ) : (
        shown.map((e) => <EnvelopeCard key={e.id} e={e} isAdmin={isAdmin} onReload={() => load(true)} />)
      )}
    </div>
  );
}
