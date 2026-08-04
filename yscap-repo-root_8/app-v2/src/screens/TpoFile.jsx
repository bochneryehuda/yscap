import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* A single TPO file — the loan's basics and the borrower-login toggle. Feature
   surfaces (pricing, conditions, documents, orders, draws) arrive in later
   phases. */

const STATUS_LABEL = {
  file_intake: 'Intake', new: 'New', in_review: 'In review', processing: 'Processing',
  underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close',
  funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn',
};
const money = (v) => v == null || v === '' ? '—' : '$' + Number(v).toLocaleString('en-US');
const addr = (a) => !a ? '' : (typeof a === 'string' ? a : (a.oneLine || [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ')));

export default function TpoFile() {
  const { id } = useParams();
  const [a, setA] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => api.tpoApplication(id)
    .then((r) => setA(r?.application || null))
    .catch((e) => setErr(e.message || 'Could not load this file'));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function togglePortal(enabled) {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api.tpoSetBorrowerPortal(id, enabled);
      setMsg(enabled ? 'The borrower can sign in to their portal for this file.' : 'The borrower can no longer sign in for this file.');
      await load();
    } catch (e) { setErr(e.message || 'Could not change the setting'); }
    finally { setBusy(false); }
  }

  if (err && !a) return <div className="notice err">{err}</div>;
  if (!a) return <div className="muted">Loading…</div>;

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="muted small">{label}</span><span>{value}</span>
    </div>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 12 }}><Link to="/tpo" className="btn link small">← Back to pipeline</Link></div>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>{a.ys_loan_number || 'New loan'}</h1>
        <p className="muted small" style={{ marginTop: 6 }}>
          <span className="pill">{STATUS_LABEL[a.status] || a.status}</span>
          {a.property_address ? ' · ' + addr(a.property_address) : ''}
        </p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="notice info" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Loan</div>
        {row('Borrower', a.borrower_id ? <Link to={`/tpo/borrower/${a.borrower_id}`}>{a.borrower_name || a.borrower_email || 'View'}</Link> : '—')}
        {row('Property', addr(a.property_address) || '—')}
        {row('Property type', a.property_type || '—')}
        {row('Loan type', a.loan_type || '—')}
        {row('Program', a.program || '—')}
        {a.purchase_price != null && row('Purchase price', money(a.purchase_price))}
        {a.as_is_value != null && row('As-is value', money(a.as_is_value))}
        {a.arv != null && row('After-repair value', money(a.arv))}
        {a.rehab_budget != null && row('Rehab budget', money(a.rehab_budget))}
        {a.loan_amount != null && row('Loan amount', money(a.loan_amount))}
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Borrower login</div>
        <p className="muted small" style={{ marginTop: 0 }}>
          By default your borrower can sign in to their own PILOT portal to see this file. You can turn that off for this file.
        </p>
        <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>{a.borrower_portal_enabled
            ? <span className="pill">Borrower login is ON</span>
            : <span className="pill">Borrower login is OFF</span>}</span>
          {a.borrower_portal_enabled
            ? <button className="btn ghost small" disabled={busy} onClick={() => togglePortal(false)}>Turn off</button>
            : <button className="btn ghost small" disabled={busy} onClick={() => togglePortal(true)}>Turn on</button>}
        </div>
      </div>
    </div>
  );
}
