import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

const addrLine = (a) => !a ? '' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const STATUS_LABEL = { outstanding: 'Outstanding', requested: 'Requested', received: 'In review', issue: 'Needs attention' };

/* Everything on the signed-in staffer's plate across all their files — tasks
   assigned to them or role-routed to a file they own. Grouped by file. */
export default function StaffTasks() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all'); // all | mine | overdue

  useEffect(() => { api.staffMyTasks().then(setRows).catch(e => setErr(e.message)); }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    const today = new Date().toISOString().slice(0, 10);
    return rows.filter(r =>
      (filter !== 'mine' || r.assigned_to_me) &&
      (filter !== 'overdue' || (r.due_date && r.due_date < today)));
  }, [rows, filter]);

  const byFile = useMemo(() => {
    const g = {};
    for (const r of shown) { (g[r.application_id] = g[r.application_id] || { file: r, items: [] }).items.push(r); }
    return Object.values(g);
  }, [shown]);

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <div className="panel muted">Loading your tasks…</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16, alignItems: 'center' }}>
        <h1>My tasks</h1>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          {['all', 'mine', 'overdue'].map(f => (
            <button key={f} className={`btn ${filter === f ? 'primary' : 'ghost'}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'mine' ? 'Assigned to me' : 'Overdue'}
            </button>
          ))}
        </div>
      </div>
      {byFile.length === 0
        ? <div className="panel muted">Nothing on your plate right now. 🎉</div>
        : byFile.map(({ file, items }) => (
          <div className="panel" key={file.application_id} style={{ marginBottom: 14 }}>
            <div className="row" style={{ marginBottom: 8, alignItems: 'baseline' }}>
              <Link to={`/staff/app/${file.application_id}`} style={{ fontWeight: 600 }}>
                {file.first_name} {file.last_name} · {addrLine(file.property_address) || file.ys_loan_number || 'File'}
              </Link>
              <div className="spacer" />
              {file.unread > 0 && <span className="chat-badge" title="Unread borrower messages">{file.unread}</span>}
              <span className={`pill ${file.app_status}`}>{file.app_status}</span>
            </div>
            {items.map(it => {
              const overdue = it.due_date && it.due_date < new Date().toISOString().slice(0, 10);
              return (
                <Link to={`/staff/app/${it.application_id}`} className="checkitem" key={it.id} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <span className={`dot ${it.status === 'received' ? 'outstanding' : it.status === 'issue' ? '' : 'outstanding'}`} style={it.status === 'issue' ? { background: 'var(--danger)' } : undefined} />
                  <div style={{ flex: 1 }}>
                    <div>{it.label}</div>
                    <div className="muted small">
                      {STATUS_LABEL[it.status] || it.status}
                      {it.role_scope && it.role_scope !== 'any' ? ` · ${it.role_scope}` : ''}
                      {it.assigned_to_me ? ' · assigned to you' : ''}
                      {it.due_date ? ` · due ${it.due_date}` : ''}
                    </div>
                  </div>
                  {overdue && <span className="pill" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>Overdue</span>}
                </Link>
              );
            })}
          </div>
        ))}
    </>
  );
}
