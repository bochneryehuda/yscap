import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* E-Signatures — PILOT's own DocuSign cockpit (owner-directed 2026-07-19:
 * "our own page that would sound like we have our own DocuSign system within
 * our system — track everything, monitor everything, manage everything").
 *
 * This is the CROSS-FILE live view: every envelope we've sent, its derived
 * human-facing phase (DocuSign has no native "awaiting counter-signature"
 * status — we derive it from routing order + recipients; see
 * docs/DOCUSIGN-WORKFORCE-BUILD-SPEC.md §11), and a per-signer timeline
 * (sent → viewed → signed, with timestamps). It polls live so the floor can
 * watch a package move without leaving the screen. Read-only for now;
 * management actions (send / resend / void) mount here with the send
 * orchestration and are gated by DOCUSIGN_SEND_ENABLED. */

const PHASE = {
  draft:                { label: 'Draft',                    cls: 'muted',   dot: '#4B585C' },
  awaiting_borrower:    { label: 'Awaiting borrower',        cls: 'new',     dot: '#2F7F86' },
  awaiting_countersign: { label: 'Awaiting counter-signature', cls: 'gold',  dot: '#AE8746' },
  completed:            { label: 'Completed',                cls: 'ok',      dot: '#2E7A5E' },
  declined:             { label: 'Declined',                 cls: 'declined', dot: '#A32A2A' },
  voided:               { label: 'Voided',                   cls: 'muted',   dot: '#4B585C' },
  error:                { label: 'Send failed',              cls: 'declined', dot: '#A32A2A' },
};
const PURPOSE = {
  term_sheet_package: 'Term-Sheet Package',
  heter_iska: 'Heter Iska',
};
const ROLE = {
  borrower: 'Borrower',
  co_borrower: 'Co-borrower',
  admin: 'Counter-signature',
};

// Filter tabs: which phases each shows. "attention" is the human-action bucket.
const TABS = [
  { key: 'all',       label: 'All' },
  { key: 'borrower',  label: 'Awaiting borrower', phases: ['awaiting_borrower'] },
  { key: 'admin',     label: 'Awaiting my signature', phases: ['awaiting_countersign'] },
  { key: 'completed', label: 'Completed', phases: ['completed'] },
  { key: 'attention', label: 'Needs attention' },   // declined / error / dead-lettered
  { key: 'closed',    label: 'Declined / voided', phases: ['declined', 'voided'] },
];

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
const abs = (iso) => (iso ? new Date(iso).toLocaleString() : '');

// A recipient's own progress: sent → viewed → signed, or terminal decline.
function recipientSteps(r) {
  const signed = r.signedAt || r.status === 'completed' || r.status === 'signed';
  const declined = r.declinedAt || r.status === 'declined';
  const viewed = r.deliveredAt || r.status === 'delivered' || signed;
  const sent = r.sentAt || r.status === 'sent' || viewed || signed;
  return [
    { key: 'sent', label: 'Sent', at: r.sentAt, done: !!sent },
    { key: 'viewed', label: 'Viewed', at: r.deliveredAt, done: !!viewed },
    declined
      ? { key: 'declined', label: 'Declined', at: r.declinedAt, done: true, bad: true }
      : { key: 'signed', label: 'Signed', at: r.signedAt, done: !!signed },
  ];
}

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

function EnvelopeCard({ e }) {
  const ph = PHASE[e.phase] || { label: e.phase, cls: 'muted' };
  const who = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const recips = (e.recipients || []).slice().sort(
    (a, b) => Number(a.routingOrder) - Number(b.routingOrder) || String(a.role).localeCompare(String(b.role)));
  const sentSummary = e.sentAt ? `Sent ${timeAgo(e.sentAt)}` : (e.status === 'not_sent' ? 'Not sent yet' : '');
  return (
    <div className="panel esign-card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="pill muted">{PURPOSE[e.purpose] || e.purpose}</span>
        <strong>{e.loanNumber || who || `File #${e.applicationId}`}</strong>
        {e.propertyAddress ? <span className="muted small">{e.propertyAddress}</span> : null}
        <div className="spacer" />
        <span className={`pill ${ph.cls}`} title={`DocuSign envelope ${e.envelopeId || '(not created yet)'}`}>
          <span className="esign-dot" style={{ background: ph.dot }} aria-hidden="true" />{ph.label}
        </span>
        <Link className="btn ghost btn-sm" to={`/internal/app/${e.applicationId}`}>Open file</Link>
      </div>

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
          : recips.map((r) => <Recipient key={r.id || `${r.role}-${r.routingOrder}`} r={r} />)}
      </div>

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
  const [data, setData] = useState(null);   // { envelopes, counts }
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('all');
  const [refreshedAt, setRefreshedAt] = useState(null);
  const seq = useRef(0);

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
  const attention = (e) => ['declined', 'error'].includes(e.phase) || e.deadLetteredAt;
  const shown = envelopes.filter((e) => {
    const t = TABS.find((x) => x.key === tab);
    if (!t || t.key === 'all') return true;
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
        <button className="btn ghost btn-sm" onClick={() => load()} title="Refresh now">Refresh</button>
      </div>
      {refreshedAt && (
        <p className="muted small" style={{ margin: '0 0 14px' }} aria-live="polite">
          <span className="esign-live" aria-hidden="true" /> Live — updated {timeAgo(refreshedAt.toISOString())}
        </p>
      )}

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="esign-stats">
        <StatCard label="All packages" value={counts.total || 0} active={tab === 'all'} onClick={() => setTab('all')} />
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
        shown.map((e) => <EnvelopeCard key={e.id} e={e} />)
      )}
    </div>
  );
}
