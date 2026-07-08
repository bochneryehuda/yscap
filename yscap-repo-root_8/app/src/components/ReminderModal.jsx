import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Reminders + task management (#93) — the popup behind a file's "Remind" button.
 *
 * Left side: compose a reminder or a task. Pick a due date+time, who's included
 * (any mix of the loan team, the borrower / co-borrower, or an ad-hoc email),
 * and the message — with one-click presets for the common recipient combos and a
 * "prefill outstanding conditions" helper. A TASK additionally takes an assignee
 * (who's responsible) and an optional "remind before it's due" lead time.
 *
 * Right side: everything already scheduled on this file, with mark-done /
 * dismiss / reschedule / delete. The backend dispatcher fires each reminder at
 * its due moment through the normal notify fan-out (in-app + branded email),
 * respecting borrower notification preferences and note-buyer redaction.
 */

// datetime-local → the value the backend parses (local wall-clock). Empty stays
// empty. We hand the raw "YYYY-MM-DDTHH:mm" straight through; new Date() on the
// server reads it as local time, which is what the composer showed.
function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function quickWhen(which) {
  const d = new Date();
  if (which === 'tomorrow9') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else if (which === 'in3') { d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0); }
  else if (which === 'nextweek') { d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); }
  else if (which === 'in1h') { d.setHours(d.getHours() + 1, d.getMinutes(), 0, 0); }
  return fmtLocal(d);
}
function whenLabel(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch (_) { return iso; }
}
const STATUS_TONE = {
  scheduled: { label: 'Scheduled', tone: '' },
  sent: { label: 'Sent', tone: 'ok' },
  done: { label: 'Done', tone: 'ok' },
  dismissed: { label: 'Dismissed', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export default function ReminderModal({ appId, team = [], onClose, onChanged }) {
  const [data, setData] = useState({ reminders: [], contacts: [], outstanding: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // Compose state
  const [kind, setKind] = useState('reminder');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueAt, setDueAt] = useState(quickWhen('tomorrow9'));
  const [remindAt, setRemindAt] = useState('');
  const [assignee, setAssignee] = useState('');
  const [selected, setSelected] = useState(() => new Set(['self']));
  const [extraEmails, setExtraEmails] = useState([]);   // [{email,name}]
  const [emailDraft, setEmailDraft] = useState('');

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3500); };

  async function load() {
    setLoading(true);
    try {
      const d = await api.staffReminders(appId);
      setData({ reminders: d.reminders || [], contacts: d.contacts || [], outstanding: d.outstanding || [] });
    } catch (e) { setErr(e.message || 'Could not load reminders'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasToken = (tok) => data.contacts.some(c => c.token === tok);
  const toggle = (tok) => setSelected(s => { const n = new Set(s); n.has(tok) ? n.delete(tok) : n.add(tok); return n; });
  // The recipient presets the owner asked for by name.
  const preset = (tokens) => setSelected(new Set(tokens.filter(hasToken)));

  const staffOptions = useMemo(
    () => (team || []).filter(m => ['loan_officer', 'processor', 'underwriter', 'admin', 'super_admin'].includes(m.role)),
    [team]);

  function prefillOutstanding() {
    if (!data.outstanding.length) { flash('Nothing outstanding to prefill.'); return; }
    setTitle(t => t || 'Outstanding items on your file');
    setBody(data.outstanding.map(x => `• ${x}`).join('\n'));
  }
  function addEmail() {
    const e = emailDraft.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { flash('Enter a valid email.'); return; }
    if (extraEmails.some(x => x.email.toLowerCase() === e.toLowerCase())) { setEmailDraft(''); return; }
    setExtraEmails(list => [...list, { email: e, name: e }]);
    setSelected(s => new Set(s).add('email:' + e.toLowerCase()));
    setEmailDraft('');
  }

  function recipientsPayload() {
    const out = [];
    for (const c of data.contacts) if (selected.has(c.token)) out.push({ kind: 'token', token: c.token });
    // Map the role tokens to the shape the backend resolves.
    const mapped = out.map(o => ({ kind: o.token }));
    for (const x of extraEmails) if (selected.has('email:' + x.email.toLowerCase())) mapped.push({ kind: 'email', email: x.email, name: x.name });
    return mapped;
  }

  async function submit() {
    setErr('');
    if (!title.trim()) { setErr('Give the reminder a title.'); return; }
    if (!dueAt) { setErr('Pick a due date and time.'); return; }
    const recipients = recipientsPayload();
    if (!recipients.length) { setErr('Choose at least one recipient.'); return; }
    setBusy(true);
    try {
      await api.staffCreateReminder(appId, {
        kind, title: title.trim(), body: body.trim(), dueAt,
        remindAt: kind === 'task' ? (remindAt || null) : null,
        recipients,
        assigneeStaffId: kind === 'task' ? (assignee || null) : null,
      });
      flash(kind === 'task' ? 'Task created ✓' : 'Reminder scheduled ✓');
      setTitle(''); setBody(''); setRemindAt('');
      await load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not save.'); }
    finally { setBusy(false); }
  }

  async function setStatus(rid, status) {
    try { await api.staffUpdateReminder(appId, rid, { status }); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Update failed'); }
  }
  async function del(rid) {
    if (!window.confirm('Delete this reminder?')) return;
    try { await api.staffDeleteReminder(appId, rid); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Delete failed'); }
  }

  const upcoming = data.reminders.filter(r => !['done', 'dismissed', 'cancelled'].includes(r.status));
  const past = data.reminders.filter(r => ['done', 'dismissed', 'cancelled'].includes(r.status));

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 940, width: '96%', height: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '2px 2px 10px' }}>
          <h3 style={{ margin: 0 }}>🔔 Reminders &amp; tasks</h3>
          <button className="btn ghost small" onClick={onClose}>Close ✕</button>
        </div>
        {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
        {msg && <div className="notice ok" style={{ marginBottom: 8 }}>{msg}</div>}

        <div className="rem-grid" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, overflow: 'auto' }}>
          {/* ── Compose ─────────────────────────────────────────────── */}
          <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
            <div className="seg" role="tablist" style={{ display: 'inline-flex', gap: 6 }}>
              <button className={`btn small ${kind === 'reminder' ? 'primary' : 'ghost'}`} onClick={() => setKind('reminder')}>Reminder</button>
              <button className={`btn small ${kind === 'task' ? 'primary' : 'ghost'}`} onClick={() => setKind('task')}>Task</button>
            </div>

            <label className="fld">
              <span className="k">Title</span>
              <input className="input" value={title} onChange={e => setTitle(e.target.value)}
                placeholder={kind === 'task' ? 'e.g. Order the appraisal' : 'e.g. Follow up on insurance binder'} />
            </label>

            <label className="fld">
              <span className="k">Message</span>
              <textarea className="input" rows={4} value={body} onChange={e => setBody(e.target.value)}
                placeholder="What should this reminder say?" style={{ resize: 'vertical' }} />
            </label>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn ghost small" onClick={prefillOutstanding}
                title="Fill the message with the file's outstanding borrower items">
                ⤵ Prefill outstanding conditions{data.outstanding.length ? ` (${data.outstanding.length})` : ''}
              </button>
              <button type="button" className="btn ghost small" onClick={() => setBody('')}>Clear</button>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <label className="fld" style={{ flex: '1 1 200px' }}>
                <span className="k">Due date &amp; time</span>
                <input className="input" type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} />
              </label>
              {kind === 'task' && (
                <label className="fld" style={{ flex: '1 1 200px' }}>
                  <span className="k">Remind before due <span className="muted">(optional)</span></span>
                  <input className="input" type="datetime-local" value={remindAt} onChange={e => setRemindAt(e.target.value)} />
                </label>
              )}
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn ghost small" onClick={() => setDueAt(quickWhen('in1h'))}>In 1 hour</button>
              <button type="button" className="btn ghost small" onClick={() => setDueAt(quickWhen('tomorrow9'))}>Tomorrow 9am</button>
              <button type="button" className="btn ghost small" onClick={() => setDueAt(quickWhen('in3'))}>In 3 days</button>
              <button type="button" className="btn ghost small" onClick={() => setDueAt(quickWhen('nextweek'))}>Next week</button>
            </div>

            {kind === 'task' && (
              <label className="fld">
                <span className="k">Assign to <span className="muted">(who can do it)</span></span>
                <select className="input" value={assignee} onChange={e => setAssignee(e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {staffOptions.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
                </select>
              </label>
            )}

            <div className="fld">
              <span className="k">Who's included</span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                <button type="button" className="btn ghost small" onClick={() => preset(['self'])}>You only</button>
                <button type="button" className="btn ghost small" onClick={() => preset(['self', 'processor'])}>You + processor</button>
                <button type="button" className="btn ghost small" onClick={() => preset(['processor'])}>Processor only</button>
                <button type="button" className="btn ghost small" onClick={() => preset(['borrower'])}>Borrower only</button>
                <button type="button" className="btn ghost small" onClick={() => preset(['self', 'processor', 'borrower'])}>All three</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.contacts.map(c => (
                  <label key={c.token} className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected.has(c.token)} onChange={() => toggle(c.token)} />
                    <span>{c.label}</span>
                  </label>
                ))}
                {extraEmails.map(x => (
                  <label key={x.email} className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected.has('email:' + x.email.toLowerCase())}
                      onChange={() => toggle('email:' + x.email.toLowerCase())} />
                    <span>{x.email} <span className="muted small">(contact)</span></span>
                  </label>
                ))}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <input className="input" style={{ flex: 1 }} value={emailDraft} placeholder="add a contact email…"
                  onChange={e => setEmailDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } }} />
                <button type="button" className="btn ghost small" onClick={addEmail}>Add</button>
              </div>
            </div>

            <button className="btn primary" disabled={busy} onClick={submit}>
              {busy ? 'Saving…' : (kind === 'task' ? 'Create task' : 'Schedule reminder')}
            </button>
          </div>

          {/* ── Scheduled list ──────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
            <h4 style={{ margin: '2px 0' }}>On this file</h4>
            {loading && <p className="muted small">Loading…</p>}
            {!loading && !data.reminders.length && <p className="muted small">No reminders or tasks yet.</p>}
            {upcoming.map(r => <ReminderRow key={r.id} r={r} onStatus={setStatus} onDelete={del} />)}
            {past.length > 0 && <div className="muted small" style={{ marginTop: 8 }}>Completed / dismissed</div>}
            {past.map(r => <ReminderRow key={r.id} r={r} onStatus={setStatus} onDelete={del} past />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReminderRow({ r, onStatus, onDelete, past }) {
  const st = STATUS_TONE[r.status] || { label: r.status, tone: '' };
  const overdue = r.status === 'scheduled' && r.due_at && new Date(r.due_at) < new Date();
  const names = (Array.isArray(r.recipients) ? r.recipients : []).map(x => x.name || x.email).filter(Boolean);
  return (
    <div className="panel" style={{ padding: 10, opacity: past ? 0.7 : 1, borderLeft: `3px solid ${overdue ? 'var(--danger,#e06666)' : 'var(--gold,#c8a24a)'}` }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {r.kind === 'task' ? '☑ ' : '🔔 '}{r.title}
          </div>
          {r.body && <div className="muted small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{r.body}</div>}
        </div>
        <span className={`pill ${st.tone}`} style={{ flex: 'none' }}>{overdue ? 'Overdue' : st.label}</span>
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        {whenLabel(r.due_at)}
        {r.assignee_name ? ` · ${r.assignee_name}` : ''}
        {names.length ? ` · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : ''}
      </div>
      {!past && (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost small" onClick={() => onStatus(r.id, 'done')}>✓ Done</button>
          <button className="btn ghost small" onClick={() => onStatus(r.id, 'dismissed')}>Dismiss</button>
          <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} onClick={() => onDelete(r.id)}>Delete</button>
        </div>
      )}
      {past && (
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button className="btn ghost small" onClick={() => onStatus(r.id, 'scheduled')}>Reopen</button>
          <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} onClick={() => onDelete(r.id)}>Delete</button>
        </div>
      )}
    </div>
  );
}
