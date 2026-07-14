import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

const addrLine = (a) => !a ? '' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const STATUS_LABEL = { outstanding: 'Outstanding', requested: 'Requested', received: 'In review', issue: 'Needs attention' };
const initials = (...parts) => parts.filter(Boolean).map(s => String(s).trim()[0] || '').join('').slice(0, 2).toUpperCase() || '—';

/* Everything on the signed-in staffer's plate across all their files — tasks
   assigned to them or role-routed to a file they own. Grouped by file. */
export default function StaffTasks() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all'); // all | mine | overdue
  const [statusFilter, setStatusFilter] = useState('all'); // all | outstanding | requested | received | issue

  useEffect(() => { api.staffMyTasks().then(setRows).catch(e => setErr(e.message)); }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    const today = new Date().toISOString().slice(0, 10);
    return rows.filter(r =>
      (filter !== 'mine' || r.assigned_to_me) &&
      (filter !== 'overdue' || (r.due_date && r.due_date < today)) &&
      (statusFilter === 'all' || r.status === statusFilter));
  }, [rows, filter, statusFilter]);

  const byFile = useMemo(() => {
    const g = {};
    for (const r of shown) { (g[r.application_id] = g[r.application_id] || { file: r, items: [] }).items.push(r); }
    return Object.values(g);
  }, [shown]);

  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (!rows) return <div className="panel pad muted">Loading your tasks…</div>;

  const today = new Date().toISOString().slice(0, 10);
  const dueToday = rows.filter(r => r.due_date === today).length;
  const overdueCount = rows.filter(r => r.due_date && r.due_date < today).length;
  const inReview = rows.filter(r => r.status === 'received').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My tasks</h1>
          <div className="sub">Everything on your plate across every file you own — grouped by file.</div>
        </div>
        <div className="page-head-actions">
          <div className="tabs">
            {['all', 'mine', 'overdue'].map(f => (
              <button key={f} className={`tab ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'mine' ? 'Assigned to me' : 'Overdue'}
              </button>
            ))}
          </div>
          <select className="input" style={{ maxWidth: 160 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">Any status</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className="stack">
        <div className="kpi-grid">
          <div className="kpi"><div className="v">{dueToday}</div><div className="k">Due today</div><div className="d">Across your open files</div></div>
          <div className="kpi"><div className="v">{overdueCount}</div><div className="k">Overdue</div><div className="d">Past their due date</div></div>
          <div className="kpi"><div className="v">{inReview}</div><div className="k">Awaiting your review</div><div className="d">Conditions &amp; docs received</div></div>
          <div className="kpi"><div className="v">{rows.length}</div><div className="k">Open tasks</div><div className="d">On your plate right now</div></div>
        </div>

        {byFile.length === 0
          ? <div className="panel"><div className="panel-b"><div className="empty-state"><h3>Nothing on your plate right now 🎉</h3><p>New conditions and documents routed to your files will appear here.</p></div></div></div>
          : byFile.map(({ file, items }) => (
            <div className="panel" key={file.application_id}>
              <div className="panel-h">
                <div className="lead-l">
                  <span className="mono">{initials(file.first_name, file.last_name)}</span>
                  <Link to={`/internal/app/${file.application_id}`} className="lead-file">
                    <div className="who">{file.first_name} {file.last_name}</div>
                    <div className="what">{addrLine(file.property_address) || file.ys_loan_number || 'File'}</div>
                  </Link>
                </div>
                <div className="task-meta">
                  {file.unread > 0 && <span className="chat-badge" title="Unread borrower messages">{file.unread}</span>}
                  <span className={`pill ${file.app_status}`}>{file.app_status}</span>
                </div>
              </div>
              <div className="grp-b">
                {items.map(it => {
                  const overdue = it.due_date && it.due_date < today;
                  const isToday = it.due_date === today;
                  return (
                    <Link to={`/internal/app/${it.application_id}`} className="task" key={it.id}>
                      <div className="who-wrap">
                        <span className={`dot ${it.status === 'received' ? 'outstanding' : it.status === 'issue' ? '' : 'outstanding'}`} style={it.status === 'issue' ? { background: 'var(--danger)' } : undefined} />
                        <div>
                          <div className="who">{it.label}</div>
                          <div className="what">
                            {STATUS_LABEL[it.status] || it.status}
                            {it.role_scope && it.role_scope !== 'any' ? ` · ${it.role_scope}` : ''}
                            {it.assigned_to_me ? ' · assigned to you' : ''}
                          </div>
                        </div>
                      </div>
                      <div className="task-meta">
                        {it.due_date && (
                          <span className={`due ${overdue ? 'over' : isToday ? 'today' : ''}`}>
                            {overdue ? 'Overdue' : isToday ? 'Today' : `Due ${it.due_date}`}
                          </span>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </>
  );
}
