import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage, askConfirm } from '../lib/dialog.js';
import ReminderModal from './ReminderModal.jsx';

/* THE FILE'S TASK BOARD (owner-directed 2026-08-18 — per-file task management).
   Every scheduled task and reminder on THIS file, as a standing section rather
   than only a popup: title, what it says, when it is due (overdue in red), who
   owns it, who is included — with Done / Dismiss / Reopen / Delete and an
   assignee hand-off inline. "New task or reminder" opens the existing composer
   (ReminderModal — ONE composer definition, with the due-date quick picks, the
   recipient presets and the "prefill outstanding conditions" helper), so this
   panel adds a home for the work without a second way to create it. */

const STATUS = {
  scheduled: { label: 'Scheduled', color: '#2F7F86' },
  sent: { label: 'Sent', color: '#AE8746' },
  done: { label: 'Done', color: 'var(--ok, #2E7D4F)' },
  dismissed: { label: 'Dismissed', color: '#4B585C' },
  cancelled: { label: 'Cancelled', color: '#4B585C' },
};
const CLOSED = new Set(['done', 'dismissed', 'cancelled']);

function when(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return iso; }
}

export default function FileTasksPanel({ appId, team }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(() => api.staffReminders(appId).then(setData).catch((e) => setErr(e.message || 'Could not load the tasks.')), [appId]);
  useEffect(() => { load(); }, [load]);

  const patch = async (rid, body) => {
    setBusy(rid); setErr('');
    try { await api.staffUpdateReminder(appId, rid, body); await load(); }
    catch (e) { await showMessage((e.data && e.data.error) || e.message || 'Could not update the task.'); }
    finally { setBusy(''); }
  };
  const remove = async (rid, title) => {
    if (!(await askConfirm(`Delete "${title}"? It disappears from the file — Done or Dismiss keep the record.`))) return;
    setBusy(rid); setErr('');
    try { await api.staffDeleteReminder(appId, rid); await load(); }
    catch (e) { await showMessage((e.data && e.data.error) || e.message || 'Could not delete the task.'); }
    finally { setBusy(''); }
  };

  const rows = (data && data.reminders) || [];
  const open = rows.filter((r) => !CLOSED.has(r.status));
  const closed = rows.filter((r) => CLOSED.has(r.status));
  const staffOptions = (team || []).filter((t) => t && t.id);

  const row = (r) => {
    const st = STATUS[r.status] || { label: r.status, color: '#4B585C' };
    const overdue = r.status === 'scheduled' && r.due_at && new Date(r.due_at) < new Date();
    return (
      <div key={r.id} className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px dotted #EFEAE0' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" style={{ borderColor: st.color, color: st.color }}>{st.label}</span>
            <span className="pill">{r.kind === 'task' ? 'task' : 'reminder'}</span>
            <span style={{ fontWeight: 600, color: '#141B22' }}>{r.title}</span>
          </div>
          {r.body && <div className="small" style={{ color: '#4B585C', marginTop: 2, whiteSpace: 'pre-wrap' }}>{r.body}</div>}
          <div className="small" style={{ marginTop: 2, color: overdue ? 'var(--danger)' : '#4B585C' }}>
            {overdue ? 'OVERDUE — was due ' : 'Due '}{when(r.due_at)}
            {r.assignee_name ? ` · owned by ${r.assignee_name}` : ''}
            {r.created_by_name ? ` · added by ${r.created_by_name}` : ''}
            {r.completed_by_name ? ` · closed by ${r.completed_by_name}` : ''}
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {r.kind === 'task' && !CLOSED.has(r.status) && (
            <select className="input" style={{ width: 'auto' }} disabled={busy === r.id}
              value={r.assignee_staff_id || ''}
              title="Hand this task to a teammate"
              onChange={(e) => patch(r.id, { assigneeStaffId: e.target.value || null })}>
              <option value="">Nobody owns it…</option>
              {staffOptions.map((t) => <option key={t.id} value={t.id}>{t.full_name || t.name || t.email}</option>)}
            </select>
          )}
          {!CLOSED.has(r.status) ? (
            <>
              <button className="btn ghost small" disabled={busy === r.id} onClick={() => patch(r.id, { status: 'done' })}>Done</button>
              <button className="btn ghost small" disabled={busy === r.id} onClick={() => patch(r.id, { status: 'dismissed' })}>Dismiss</button>
            </>
          ) : (
            <button className="btn ghost small" disabled={busy === r.id} onClick={() => patch(r.id, { status: 'scheduled' })}>Reopen</button>
          )}
          <button className="btn ghost small" disabled={busy === r.id} onClick={() => remove(r.id, r.title)}>Delete</button>
        </div>
      </div>
    );
  };

  return (
    <div className="panel" style={{ marginTop: 4 }}>
      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <p className="muted small" style={{ flex: 1, margin: 0 }}>
          Scheduled tasks and reminders on this file — each fires at its due moment to the people on it.
          Tasks carry an owner; anything here also shows on that person’s My-tasks queue.
        </p>
        <button className="btn primary small" onClick={() => setComposerOpen(true)}>New task or reminder</button>
      </div>
      {err && <p className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      {!data ? <p className="muted small">Loading…</p> : (
        <>
          {open.length === 0 && <p className="muted small">Nothing scheduled — add a task or a reminder above.</p>}
          {open.map(row)}
          {closed.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button className="btn link small" onClick={() => setShowClosed((v) => !v)}>
                {showClosed ? 'Hide' : 'Show'} finished ({closed.length})
              </button>
              {showClosed && closed.map(row)}
            </div>
          )}
        </>
      )}
      {composerOpen && (
        <ReminderModal appId={appId} team={team} onClose={() => { setComposerOpen(false); load(); }} onChanged={load} />
      )}
    </div>
  );
}
