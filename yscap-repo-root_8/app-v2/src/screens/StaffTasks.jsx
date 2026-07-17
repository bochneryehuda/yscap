import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const addrLine = (a) => !a ? '' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const STATUS_LABEL = { outstanding: 'Outstanding', requested: 'Requested', received: 'In review', issue: 'Needs attention' };
// File-status label for the group header pill (#151: file_intake must read
// "Intake", never the raw enum). Mirrors StaffQueue's LABEL map.
const APP_STATUS_LABEL = { file_intake: 'Intake', new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn' };
const initials = (...parts) => parts.filter(Boolean).map(s => String(s).trim()[0] || '').join('').slice(0, 2).toUpperCase() || '—';
// ONE completion rule, mirroring StaffApplication.roleDone — a task is off your
// plate once it's signed off / waived / satisfied, or (for an LO) marked done.
function roleDone(it, role) {
  return it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at
    || (role === 'loan_officer' && !!it.reviewed_at);
}
// Who may SIGN OFF / waive (mirrors StaffApplication.canComplete) — the loan
// officer's step is "Done"; the back office signs off (#134). We hide Sign off /
// Waive for non-completers so the task list doesn't show them a dead button the
// backend would 403 (the file view hides them too).
const COMPLETER_ROLES = ['processor', 'admin', 'super_admin', 'underwriter', 'loan_coordinator'];

/* Everything on the signed-in staffer's plate across all their files — tasks
   assigned to them or role-routed to a file they own. Grouped by file. #142: each
   task carries the SAME inline Done / Sign off / Waive actions the file's
   condition list does, so a staffer can finish it here without diving into the
   file (the backend enforces the identical sign-off gate). */
export default function StaffTasks() {
  const { actor } = useAuth();
  const role = actor && actor.role;
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);      // item id being acted on
  const [filter, setFilter] = useState('all'); // all | mine | overdue
  const [statusFilter, setStatusFilter] = useState('all'); // all | outstanding | requested | received | issue

  const reload = useCallback(() => api.staffMyTasks().then(setRows).catch(e => setErr(e.message)), []);
  useEffect(() => { reload(); }, [reload]);

  // Inline completion — the same PATCH the file's condition list issues. On
  // success the list refetches (a signed-off task drops off; a Done task stays,
  // marked done). A blocked sign-off surfaces the server's exact reason.
  const patchItem = useCallback(async (itemId, body) => {
    if (busy) return;
    setBusy(itemId); setErr('');
    try { await api.staffPatchItem(itemId, body); await reload(); }
    catch (e) {
      const msg = e.message || 'Update failed';
      setErr(msg);
      if (body && (body.signedOff === true || body.status === 'satisfied')) {
        try { window.alert('Can’t sign off yet:\n\n' + msg); } catch (_) { /* no window */ }
      }
    } finally { setBusy(null); }
  }, [busy, reload]);

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

  // Load failure with nothing to show → full-page error. An INLINE-action error
  // (rows already loaded) must NOT blank the list — it renders as a banner below.
  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;
  if (!rows) return <div className="panel pad muted">Loading your tasks…</div>;

  const today = new Date().toISOString().slice(0, 10);
  // "Soon" window: due within the next 3 days. Derived only from due_date.
  const soonBy = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
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
      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}
        <button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

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
                  <span className={`pill ${file.app_status}`}>{APP_STATUS_LABEL[file.app_status] || file.app_status}</span>
                </div>
              </div>
              <div className="grp-b">
                {items.map(it => {
                  const overdue = it.due_date && it.due_date < today;
                  const isToday = it.due_date === today;
                  // Priority derived purely from the task's existing due_date.
                  const pri = !it.due_date ? null : (it.due_date < today ? 'high' : it.due_date <= soonBy ? 'soon' : 'normal');
                  const done = roleDone(it, role);
                  const b = busy === it.id;
                  return (
                    <div className={`task${done ? ' task-done' : ''}`} key={it.id}>
                      <div className="who-wrap">
                        <span className={`dot ${done ? 'done' : ''}`} style={it.status === 'issue' && !done ? { background: 'var(--danger)' } : undefined} />
                        <div>
                          {/* The label still opens the file for anything that needs more than a click. */}
                          <Link to={`/internal/app/${it.application_id}`} className="who" style={{ textDecoration: 'none', color: 'inherit' }}>{it.label}</Link>
                          <div className="what">
                            {STATUS_LABEL[it.status] || it.status}
                            {it.reviewed_at ? ` · done by ${it.reviewed_by_name || 'staff'}` : ''}
                            {it.role_scope && it.role_scope !== 'any' ? ` · ${it.role_scope}` : ''}
                            {it.is_required === false ? ' · optional' : ''}
                            {it.assigned_to_me ? ' · assigned to you' : ''}
                          </div>
                        </div>
                      </div>
                      <div className="task-meta">
                        {pri && <span className={`pri pri-${pri}`}>{pri === 'high' ? 'High' : pri === 'soon' ? 'Soon' : 'Normal'}</span>}
                        {it.due_date && (
                          <span className={`due ${overdue ? 'over' : isToday ? 'today' : ''}`}>
                            {overdue ? 'Overdue' : isToday ? 'Today' : `Due ${it.due_date}`}
                          </span>
                        )}
                        {/* #142 — finish it right here. Same actions + backend gate as
                            the file's condition list: Done (LO step) → Sign off
                            (completes for everyone) → Waive (optional only). */}
                        <div className="task-acts" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {it.reviewed_at
                            ? <button className="btn ghost small" disabled={b} title={`Marked done by ${it.reviewed_by_name || 'staff'} — undo to put it back on your list`} onClick={() => patchItem(it.id, { reviewed: false })}>Done ✓</button>
                            : <button className="btn ghost small" disabled={b} title="Mark this task done (loan-officer step). The processor still signs it off." onClick={() => patchItem(it.id, { reviewed: true })}>Done</button>}
                          {/* Sign off / Waive are the back-office step (#134) — only shown to
                              completers, matching the file view, so an LO never sees a dead button. */}
                          {COMPLETER_ROLES.includes(role) && (it.waived_at
                            ? <button className="btn ghost small" disabled={b} onClick={() => patchItem(it.id, { waived: false })}>Undo waive</button>
                            : <>
                                <button className="btn primary small" disabled={b} title="Sign off = the whole task is complete. This removes it from the list for everyone." onClick={() => patchItem(it.id, { signedOff: true })}>Sign off</button>
                                {it.is_required === false && <button className="btn ghost small" disabled={b} title="Waive this optional task (clear without a document)" onClick={() => patchItem(it.id, { waived: true })}>Waive</button>}
                              </>)}
                          <Link className="btn ghost small" to={`/internal/app/${it.application_id}`} title="Open the file">Open</Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </>
  );
}
