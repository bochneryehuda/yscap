import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
const seesAll = (role) => ['admin', 'super_admin', 'underwriter'].includes(role);
const bigMoney = (n) => n == null ? '$0' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n;

const EXC = [
  { k: 'needs_correction', label: 'Docs need correction', to: '/staff/tasks' },
  { k: 'awaiting_review', label: 'Awaiting your review', to: '/staff/tasks' },
  { k: 'awaiting_borrower', label: 'Awaiting borrower', to: '/staff/tasks' },
  { k: 'unread_messages', label: 'Unread messages', to: '/staff/chat' },
  { k: 'open_conditions', label: 'Open conditions', to: '/staff/tasks' },
  { k: 'unassigned', label: 'Unassigned', to: '/staff' },
  { k: 'post_closing_exceptions', label: 'Post-closing exceptions', to: '/staff/tasks' },
];
function ExceptionStrip({ e }) {
  if (!e) return null;
  const live = EXC.filter(x => (e[x.k] || 0) > 0);
  if (live.length === 0) return null;
  return (
    <div className="kpi-row" style={{ marginBottom: 14 }}>
      {live.map(x => (
        <Link key={x.k} to={x.to} className="kpi alert" style={{ textDecoration: 'none' }}>
          <div className="kpi-v">{e[x.k]}</div>
          <div className="kpi-k">{x.label}</div>
        </Link>
      ))}
    </div>
  );
}

function Kpis({ d }) {
  if (!d) return null;
  const tiles = [
    { k: 'Active files', v: d.active },
    { k: 'Pipeline value', v: bigMoney(d.pipelineValue) },
    { k: 'New this week', v: d.newThisWeek },
    { k: 'Open leads', v: d.openLeads },
    { k: 'Funded', v: d.funded },
    { k: 'Needs attention', v: d.stale, alert: d.stale > 0 },
  ];
  return (
    <div className="kpi-row">
      {tiles.map(t => (
        <div key={t.k} className={`kpi${t.alert ? ' alert' : ''}`}>
          <div className="kpi-v">{t.v}</div>
          <div className="kpi-k">{t.k}</div>
        </div>
      ))}
    </div>
  );
}

function Row({ a }) {
  const pct = a.total_items > 0 ? Math.round((a.done_items / a.total_items) * 100) : 0;
  return (
    <Link to={`/staff/app/${a.id}`} className="checkitem" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{a.first_name} {a.last_name} · {addrLine(a.property_address)}</div>
        <div className="muted small">
          {a.ys_loan_number || 'Loan # pending'} · {a.program || '—'} · {a.loan_type || '—'} · {money(a.loan_amount)}
          {a.loan_officer_name ? ` · LO: ${a.loan_officer_name}` : ' · Unassigned'}
        </div>
        {a.total_items > 0 && (
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <div className="progress" style={{ maxWidth: 180 }}><div className="progress-fill" style={{ width: pct + '%' }} /></div>
            <span className="muted small">{pct}%</span>
          </div>
        )}
      </div>
      <span className={`pill ${a.status}`}>{LABEL[a.status] || a.status}</span>
    </Link>
  );
}

export default function StaffQueue() {
  const { role } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('mine');       // mine | leads
  const [mine, setMine] = useState(null);
  const [leads, setLeads] = useState(null);
  const [dash, setDash] = useState(null);
  const [exc, setExc] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.staffApplications().then(setMine).catch(e => setErr(e.message));
    api.staffLeadCapture().then(setLeads).catch(() => setLeads([]));
    api.staffDashboard().then(setDash).catch(() => {});
    api.staffExceptions().then(setExc).catch(() => {});
  }, []);

  const [officer, setOfficer] = useState('');
  const [statusF, setStatusF] = useState('');
  const officers = [...new Set((mine || []).map(a => a.loan_officer_name).filter(Boolean))].sort();
  const baseList = tab === 'mine' ? mine : leads;
  let list = baseList;
  if (tab === 'mine' && baseList) {
    list = baseList.filter(a => (!officer || a.loan_officer_name === officer) && (!statusF || a.status === statusF));
  }
  const mineLabel = seesAll(role) ? 'All applications' : 'My pipeline';
  const STATUS_ORDER = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'declined', 'withdrawn'];

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
          <button className="btn primary" onClick={() => nav('/staff/new')} title="Open a new loan file — the borrower doesn't need an account">
            + New file
          </button>
        </div>
      </div>

      {err && <div className="notice err">{err}</div>}
      <Kpis d={dash} />
      <ExceptionStrip e={exc} />
      {tab === 'mine' && (
        <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="input" style={{ maxWidth: 200 }} value={statusF} onChange={e => setStatusF(e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_ORDER.map(s => <option key={s} value={s}>{LABEL[s]}</option>)}
          </select>
          {seesAll(role) && officers.length > 1 && (
            <select className="input" style={{ maxWidth: 220 }} value={officer} onChange={e => setOfficer(e.target.value)}>
              <option value="">All officers</option>
              {officers.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {(officer || statusF) && <span className="muted small">{list ? list.length : 0} file(s)</span>}
        </div>
      )}
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
