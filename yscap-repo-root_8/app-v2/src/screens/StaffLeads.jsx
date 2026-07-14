import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const TOOL_LABEL = {
  loan_application: 'Loan application', rehab_budget: 'Rehab budget', term_sheet: 'Term sheet',
  deal_analyzer: 'Deal analyzer', qualifier: 'Qualifier', contact: 'Contact',
};
const STATUSES = ['new', 'contacted', 'working', 'converted', 'archived'];
// blueprint source-chip dot colour by tool, and status → .app pill tone
const SRC_CLASS = { term_sheet: 'ts', loan_application: 'app', contact: 'contact' };
const STATUS_PILL = { new: 'info', contacted: 'warn', working: 'warn', converted: 'ok', archived: 'mut' };
const initials = (s) => (String(s || '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase()) || '—';

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
  if (rows == null) return <div className="panel pad muted">Loading leads…</div>;

  const shown = rows.filter(r => filter === 'all' ? true : (r.status !== 'archived' && r.status !== 'converted'));
  const openCount = rows.filter(r => r.status !== 'archived' && r.status !== 'converted').length;
  const newCount = rows.filter(r => r.status === 'new').length;
  const workingCount = rows.filter(r => r.status === 'contacted' || r.status === 'working').length;
  const convertedCount = rows.filter(r => r.status === 'converted').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="sub">
            Submissions from the website tools — application, rehab budget, term-sheet requests.
            Each was saved here and emailed to the routed officer automatically; no borrower login required.
          </div>
        </div>
        <div className="filters page-head-actions">
          <button className={`tab ${filter === 'open' ? 'on' : ''}`} onClick={() => setFilter('open')}>Open <span className="ct">{openCount}</span></button>
          <button className={`tab ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All leads <span className="ct">{rows.length}</span></button>
        </div>
      </div>

      <div className="stack">
        <div className="kpi-grid">
          <div className="kpi"><div className="v">{newCount}</div><div className="k">New leads</div><div className="d">Awaiting triage</div></div>
          <div className="kpi"><div className="v">{workingCount}</div><div className="k">Working</div><div className="d">Contacted or in progress</div></div>
          <div className="kpi"><div className="v">{convertedCount}</div><div className="k">Converted</div><div className="d">Promoted to a live file</div></div>
          <div className="kpi"><div className="v">{rows.length}</div><div className="k">Total leads</div><div className="d">All time</div></div>
        </div>

        <div className="panel">
          <div className="panel-h">
            <h3>Captured leads</h3>
            <span className="pill mut">{shown.length} shown</span>
          </div>
          {shown.length === 0
            ? <div className="panel-b"><div className="empty-state"><h3>No {filter === 'open' ? 'open ' : ''}leads yet</h3><p>New submissions from the site tools will land here.</p></div></div>
            : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Source</th>
                      <th>Contact</th>
                      <th>Status</th>
                      <th>Assigned officer</th>
                      <th>Received</th>
                      <th className="act">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(l => {
                      const isOpen = open === l.id;
                      return (
                        <React.Fragment key={l.id}>
                          <tr>
                            <td className="cell-deal">
                              <span className="who"><span className="mono">{initials(l.name || l.email)}</span><span className="lead">{l.name || l.email || 'Anonymous'}</span></span>
                              {l.message && <div className="mut lead-msg">{l.message}</div>}
                            </td>
                            <td><span className={`src ${SRC_CLASS[l.tool] || ''}`}>{TOOL_LABEL[l.tool] || l.tool}</span></td>
                            <td className="mut">{[l.email, l.phone].filter(Boolean).join(' · ') || '—'}</td>
                            <td><span className={`pill ${STATUS_PILL[l.status] || 'mut'}`}>{l.status}</span></td>
                            <td>{l.officer_name
                              ? <span className="off"><span className="mono">{initials(l.officer_name)}</span>{l.officer_name}</span>
                              : <span className="off un"><span className="dot" />Loan desk</span>}</td>
                            <td className="rec">{new Date(l.created_at).toLocaleString()}</td>
                            <td className="act">
                              <div className="row-act">
                                <select className="input" style={{ maxWidth: 140 }} value={l.status} onChange={e => setStatus(l.id, e.target.value)}>
                                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                                {l.payload && (
                                  <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === l.id ? null : l.id)}>
                                    {isOpen ? 'Hide' : 'View'}
                                  </button>
                                )}
                                {l.email && <a className="btn btn-ghost btn-sm" href={`mailto:${l.email}`}>Email</a>}
                              </div>
                            </td>
                          </tr>
                          {isOpen && l.payload && (
                            <tr className="lead-payload-row">
                              <td colSpan={7}>
                                <pre className="lead-payload">{JSON.stringify(l.payload, null, 2)}</pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>
    </>
  );
}
