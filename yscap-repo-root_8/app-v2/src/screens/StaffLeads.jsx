import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const TOOL_LABEL = {
  loan_application: 'Loan application', rehab_budget: 'Rehab budget', term_sheet: 'Term sheet',
  deal_analyzer: 'Deal analyzer', qualifier: 'Qualifier', contact: 'Contact',
};
const STATUSES = ['new', 'contacted', 'working', 'converted', 'archived'];
const STATUS_TONE = { new: 'gold', contacted: '', working: '', converted: 'done', archived: 'muted' };

export default function StaffLeads() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('open');   // open | all
  const [open, setOpen] = useState(null);

  const load = () => api.staffLeads().then(setRows).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function setStatus(id, status) {
    try { await api.staffUpdateLead(id, { status }); await load(); }
    catch (e) { setErr(e.message); }
  }

  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (rows == null) return <div className="panel muted">Loading leads…</div>;

  const shown = rows.filter(r => filter === 'all' ? true : (r.status !== 'archived' && r.status !== 'converted'));

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Leads</h1>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn ${filter === 'open' ? 'primary' : 'ghost'}`} onClick={() => setFilter('open')}>Open</button>
          <button className={`btn ${filter === 'all' ? 'primary' : 'ghost'}`} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        Submissions from the website tools (application, rehab budget, term-sheet requests). Each was
        saved here and emailed to the routed officer automatically — no borrower login required.
      </p>

      {shown.length === 0
        ? <div className="panel muted">No {filter === 'open' ? 'open ' : ''}leads yet.</div>
        : shown.map(l => (
          <div className="panel" key={l.id} style={{ marginBottom: 12 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 600 }}>
                  {l.name || l.email || 'Anonymous'} <span className="pill" style={{ marginLeft: 6 }}>{TOOL_LABEL[l.tool] || l.tool}</span>
                </div>
                <div className="muted small" style={{ marginTop: 3 }}>
                  {[l.email, l.phone].filter(Boolean).join(' · ') || '—'}
                  {l.officer_name ? ` · routed to ${l.officer_name}` : ' · loan desk'}
                  {` · ${new Date(l.created_at).toLocaleString()}`}
                </div>
                {l.message && <div className="small" style={{ marginTop: 6 }}>{l.message}</div>}
                {l.payload && (
                  <button className="btn link small" onClick={() => setOpen(open === l.id ? null : l.id)}>
                    {open === l.id ? 'Hide' : 'View'} submission
                  </button>
                )}
                {open === l.id && l.payload && (
                  <pre className="panel small" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 260, overflow: 'auto' }}>
                    {JSON.stringify(l.payload, null, 2)}
                  </pre>
                )}
              </div>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span className={`pill ${STATUS_TONE[l.status] || ''}`}>{l.status}</span>
                <select className="input" style={{ maxWidth: 150 }} value={l.status}
                  onChange={e => setStatus(l.id, e.target.value)}>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {l.email && <a className="btn ghost" href={`mailto:${l.email}`}>Email</a>}
              </div>
            </div>
          </div>
        ))}
    </>
  );
}
