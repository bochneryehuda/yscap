import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showMessage } from '../lib/dialog.js';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
// (No overrideLine here: this queue only lists OPEN work — a cleared condition,
// overridden or not, has already dropped off it. The file's list shows the stamp.)
import { canOverride, isCompletion, askOverride } from '../lib/condition-override.js';

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

/* SCHEDULED TASKS & REMINDERS across every file (task management, owner-directed
   2026-08-18) — the reminders-engine rows (a due moment, an owner, recipients),
   distinct from the condition queue below: these are the things somebody
   SCHEDULED, and they fire on their own at the due time. Done / Dismiss inline;
   the file link opens the file's own Tasks & reminders section. */
function ScheduledTasksBlock() {
  const [scope, setScope] = useState('mine');   // mine | all
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.staffReminderTasks({ scope }).then(setData).catch((e) => setErr(e.message || 'Could not load')), [scope]);
  useEffect(() => { load(); }, [load]);
  const done = async (t, status) => {
    setBusy(t.id); setErr('');
    // The queue's OWN door (not the per-file PATCH): a task handed to you can sit
    // on a file outside your scope, and the per-file route 403s there (audit
    // 2026-08-18 finding 1) — this endpoint admits the assignee/creator too.
    try { await api.staffReminderTaskUpdate(t.id, { status }); await load(); }
    catch (e) { await showMessage((e.data && e.data.error) || e.message || 'Could not update the task.'); }
    finally { setBusy(''); }
  };
  const tasks = (data && data.tasks) || [];
  if (data && !tasks.length && scope === 'mine') {
    return (
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ color: '#141B22' }}>Scheduled tasks &amp; reminders</b>
          <span className="muted small" style={{ flex: 1 }}>Nothing scheduled for you. Add one from any file’s “Tasks &amp; reminders” section.</span>
          <button className="btn ghost small" onClick={() => setScope('all')}>Show every file’s</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <b style={{ color: '#141B22' }}>Scheduled tasks &amp; reminders</b>
        <span className="muted small" style={{ flex: 1 }}>Each fires at its due moment — these are the ones still open.</span>
        <div className="tabs">
          {['mine', 'all'].map((sc) => (
            <button key={sc} className={`tab ${scope === sc ? 'on' : ''}`} onClick={() => setScope(sc)}>
              {sc === 'mine' ? 'Mine' : 'All my files'}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
      {!data ? <div className="muted small">Loading…</div> : tasks.map((t) => (
        <div key={t.id} className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px dotted #EFEAE0' }}>
          <span className="pill" style={t.overdue ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>
            {t.overdue ? 'overdue' : (t.kind === 'task' ? 'task' : 'reminder')}
          </span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <span style={{ fontWeight: 600, color: '#141B22' }}>{t.title}</span>
            <div className="small" style={{ color: '#4B585C' }}>
              Due {new Date(t.due_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              {t.assignee_name ? ` · owned by ${t.assignee_name}` : ''}
              {/* The file link renders only when this staffer can actually OPEN
                  the file — a task handed to you on someone else's file keeps
                  its name but not a link into a 403 (audit 2026-08-18 #1). */}
              {t.file_visible !== false ? (<>{' · '}
                <Link to={`/internal/app/${t.application_id}#sec-tasks`} style={{ color: '#0B6B63' }}>
                  {t.ys_loan_number || addrLine(t.property_address) || (t.borrower_name ? `${t.borrower_name}’s file` : 'open the file')}
                </Link></>) : (
                <span> · {t.ys_loan_number || addrLine(t.property_address) || 'a file outside your list'}</span>
              )}
            </div>
          </div>
          <button className="btn ghost small" disabled={busy === t.id} onClick={() => done(t, 'done')}>Done</button>
          <button className="btn ghost small" disabled={busy === t.id} onClick={() => done(t, 'dismissed')}>Dismiss</button>
        </div>
      ))}
      {data && !tasks.length && <div className="muted small">Nothing scheduled on your files.</div>}
    </div>
  );
}

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
  const patchItem = useCallback(async (itemId, body, label) => {
    if (busy && !(body && body.adminOverride)) return;   // the override retry is a continuation of the same click
    setBusy(itemId); setErr('');
    try { await api.staffPatchItem(itemId, body); await reload(); }
    catch (e) {
      const msg = e.message || 'Update failed';
      // Same super-admin override as the file's conditions list, offered at the
      // same moment — the refusal (owner-directed 2026-07-27). A staffer who
      // works from this queue must not have to open the file to get through.
      if (isCompletion(body) && !body.adminOverride && canOverride(role)) {
        const extra = await askOverride(label, { blocked: msg });
        if (extra) { setBusy(null); return patchItem(itemId, { ...body, ...extra }, label); }
      }
      setErr(msg);
      if (isCompletion(body)) {
        try { showMessage('Can’t clear this yet:\n\n' + msg); } catch (_) { /* no window */ }
      }
    } finally { setBusy(null); }
  }, [busy, reload, role]);

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
        <ScheduledTasksBlock />
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
                            ? <button className="btn ghost small" disabled={b} title={`Marked done by ${it.reviewed_by_name || 'staff'} — undo to put it back on your list`} onClick={() => patchItem(it.id, { reviewed: false }, it.label)}>Done ✓</button>
                            : <button className="btn ghost small" disabled={b} title="Mark this task done (loan-officer step). The processor still signs it off." onClick={() => patchItem(it.id, { reviewed: true }, it.label)}>Done</button>}
                          {/* Sign off / Waive are the back-office step (#134) — only shown to
                              completers, matching the file view, so an LO never sees a dead button. */}
                          {COMPLETER_ROLES.includes(role) && (it.waived_at
                            ? <button className="btn ghost small" disabled={b} onClick={() => patchItem(it.id, { waived: false }, it.label)}>Undo waive</button>
                            : <>
                                <button className="btn primary small" disabled={b} title="Sign off = the whole task is complete. This removes it from the list for everyone." onClick={() => patchItem(it.id, { signedOff: true }, it.label)}>Sign off</button>
                                {it.is_required === false && <button className="btn ghost small" disabled={b} title="Waive this optional task (clear without a document)" onClick={() => patchItem(it.id, { waived: true }, it.label)}>Waive</button>}
                                {/* Super admin only — clear it without what it asks for (reason required). */}
                                {canOverride(role) && (
                                  <button className="btn ghost small" disabled={b} style={{ color: 'var(--gold, #AE8746)' }}
                                    title="Super admin: clear this WITHOUT a document / without meeting its requirement. Your reason is saved on the file."
                                    onClick={async () => { const x = await askOverride(it.label); if (x) patchItem(it.id, { signedOff: true, ...x }, it.label); }}>Override</button>
                                )}
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
