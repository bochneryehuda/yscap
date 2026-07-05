import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
const seesAll = (role) => ['admin', 'super_admin', 'underwriter'].includes(role);

function Row({ a }) {
  return (
    <Link to={`/staff/app/${a.id}`} className="checkitem" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{a.first_name} {a.last_name} · {addrLine(a.property_address)}</div>
        <div className="muted small">
          {a.ys_loan_number || 'Loan # pending'} · {a.program || '—'} · {a.loan_type || '—'} · {money(a.loan_amount)}
          {a.loan_officer_name ? ` · LO: ${a.loan_officer_name}` : ' · Unassigned'}
        </div>
      </div>
      <span className={`pill ${a.status}`}>{LABEL[a.status] || a.status}</span>
    </Link>
  );
}

export default function StaffQueue() {
  const { role } = useAuth();
  const [tab, setTab] = useState('mine');       // mine | leads
  const [mine, setMine] = useState(null);
  const [leads, setLeads] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.staffApplications().then(setMine).catch(e => setErr(e.message));
    api.staffLeadCapture().then(setLeads).catch(() => setLeads([]));
  }, []);

  const list = tab === 'mine' ? mine : leads;
  const mineLabel = seesAll(role) ? 'All applications' : 'My pipeline';

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1>Pipeline</h1>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn ${tab === 'mine' ? 'primary' : 'ghost'}`} onClick={() => setTab('mine')}>
            {mineLabel}{mine ? ` (${mine.length})` : ''}
          </button>
          <button className={`btn ${tab === 'leads' ? 'primary' : 'ghost'}`} onClick={() => setTab('leads')}>
            Lead Capture{leads ? ` (${leads.length})` : ''}
          </button>
        </div>
      </div>

      {err && <div className="notice err">{err}</div>}
      {tab === 'leads' && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          New applications with no loan officer assigned yet. Open one to assign an officer and processor.
        </p>
      )}

      <div className="panel">
        {list == null
          ? <p className="muted">Loading…</p>
          : list.length === 0
            ? <p className="muted small">Nothing here yet.</p>
            : list.map(a => <Row key={a.id} a={a} />)}
      </div>
    </>
  );
}
