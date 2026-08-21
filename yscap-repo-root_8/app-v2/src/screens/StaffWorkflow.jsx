import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate } from '../lib/dates.js';
import { useFlash } from '../components/FlashToast.jsx';
import { confirmRemoveWorkflowItem } from '../lib/workflowRemove.js';
import { useUrlState } from '../lib/useUrlState.js';

/* THE WORKFLOW (owner-directed 2026-07-21) — my personal work queue.
   Everything submitted to me, in the order it arrived, with a live "up next"
   list and a history of what I finished / sent back. Simple on purpose: pick a
   file up, do your part, then send it back with what you did.

   Admin / super_admin OVERSIGHT (owner-directed 2026-07-26): switch into EACH
   workflow SEPARATELY — the closer workflow, the processing workflow, the draw
   workflow, underwriting, or one person's queue — each experienced on its own,
   never merged. The closer/draw views link straight to their fully-detailed desk. */

const TYPE_LABEL = {
  loan_setup: 'Loan Setup', processing: 'Processing', condition_clearing: 'Condition Clearing',
  clear_to_close: 'Clear to Close', closing: 'Closing', draw_setup: 'Draw Setup',
  post_closing: 'Post-Closing / Investor Delivery', exception: 'Exception', escalation: 'Escalation',
  trustpoint_import: 'TrustPoint Draw Entry', trinity_inspection_order: 'Trinity Inspection Order',
};
// Each role's workflow, viewed separately by an admin. `desk` = the fully-detailed
// screen for that process, one click away.
const ROLE_WF = [
  { role: 'closer', label: 'Closer workflow', desk: '/internal/closing', deskLabel: 'the Closing desk' },
  { role: 'processor', label: 'Processing workflow', desk: null },
  { role: 'draw_coordinator', label: 'Draw workflow', desk: '/internal/draws', deskLabel: 'the Draw desk' },
  { role: 'underwriter', label: 'Underwriting workflow', desk: null },
  { role: 'super_admin', label: 'Escalations workflow', desk: null },
];
const ROLE_LABEL = {
  super_admin: 'Super Admin', admin: 'Admin', underwriter: 'Underwriter', loan_officer: 'Loan Officer',
  loan_coordinator: 'Loan Coordinator', draw_coordinator: 'Draw Coordinator', processor: 'Processor',
  closer: 'Closer', software_setup: 'Software Setup',
};
const addrLine = (a) => !a ? '' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const initials = (...p) => p.filter(Boolean).map(s => String(s).trim()[0] || '').join('').slice(0, 2).toUpperCase() || '—';
// Aging, in plain words. Anything sitting a while reads as more urgent.
function ageText(seconds) {
  const s = Number(seconds) || 0;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
function ageClass(seconds) {
  const days = (Number(seconds) || 0) / 86400;
  return days >= 2 ? 'over' : days >= 1 ? 'today' : '';
}
// Prefer the server's SLA read (against each hand-off's due date) over raw age.
function slaClass(it) {
  if (it.sla_state === 'overdue') return 'over';
  if (it.sla_state === 'at_risk') return 'today';
  if (it.sla_state === 'ok') return '';
  return ageClass(it.age_seconds);   // no SLA on this type → fall back to age
}
const fmtWhen = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return ts; } };

export default function StaffWorkflow() {
  const { role } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [view, setView] = useUrlState('view', 'mine', { remember: 'workflow.view' });          // 'mine' | 'role:<role>' | 'staff:<id>'
  const [roster, setRoster] = useState(null);        // { staff:[{id,full_name,role}] }
  const [tab, setTab] = useUrlState('tab', 'next');             // next | history
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);            // item id being acted on
  const [returning, setReturning] = useState(null);  // item id whose send-back form is open
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');

  const OUTCOMES = ['Finished processing', 'Finished loan setup', 'Finished CTC', 'Cleared conditions',
    'Added conditions', 'Cleared exception', 'Finished closing', 'Finished draw setup', 'Entered in TrustPoint', 'Reviewed', 'Sent back — needs more'];

  const isMine = view === 'mine';
  const roleView = view.startsWith('role:') ? view.slice(5) : null;
  // A role view has no per-person history — force the live tab (the Removed
  // view works everywhere: remove/restore lives on the workflows, owner-directed
  // 2026-08-18).
  const effTab = roleView ? (tab === 'removed' ? 'removed' : 'next') : tab;

  useEffect(() => { if (isAdmin) api.workflowRoster().then(setRoster).catch(() => {}); }, [isAdmin]);

  const reload = useCallback(() => {
    setRows(null); setReturning(null);
    const p = { tab: effTab };
    if (view.startsWith('role:')) { p.role = view.slice(5); }
    else if (view.startsWith('staff:')) { p.staffId = view.slice(6); }
    api.workflowQueue(p).then(setRows).catch(e => setErr(e.message));
  }, [effTab, view]);
  useEffect(() => { reload(); }, [reload]);

  // Every hand-off action belongs to a row — confirm in the fixed toast so
  // the queue never jumps under the cursor (see FlashToast.jsx).
  const { flash: say, toast } = useFlash();

  const pickup = useCallback(async (id) => {
    if (busy) return; setBusy(id); setErr('');
    try { await api.workflowPickup(id); say('Picked up — it’s yours to work now.'); reload(); }
    catch (e) { setErr(e.message || 'Could not pick it up'); } finally { setBusy(null); }
  }, [busy, reload]);

  const sendBack = useCallback(async (id) => {
    if (busy) return;
    if (!outcome) { setErr('Choose what you finished before sending it back.'); return; }
    setBusy(id); setErr('');
    try {
      await api.workflowReturn(id, outcome, note || undefined);
      say('Sent back to the loan officer. It’s off your list.');
      setReturning(null); setOutcome(''); setNote(''); reload();
    } catch (e) { setErr(e.message || 'Could not send it back'); } finally { setBusy(null); }
  }, [busy, outcome, note, reload]);

  // Remove a hand-off from THIS workflow (restorable from the Removed view) /
  // restore it. Owner-directed 2026-08-18: the Remove button lives on the
  // workflows — never on the pipeline. Double warning inside the confirm helper.
  const removeIt = useCallback(async (it, queueLabel) => {
    if (busy) return; setBusy(it.id); setErr('');
    try {
      const ok = await confirmRemoveWorkflowItem(it.id, queueLabel,
        [it.first_name, it.last_name].filter(Boolean).join(' '));
      if (ok) { say('Removed from the workflow — restorable from the Removed view.'); reload(); }
    } finally { setBusy(null); }
  }, [busy, reload]);
  const restoreIt = useCallback(async (it) => {
    if (busy) return; setBusy(it.id); setErr('');
    try { await api.workflowRestoreItem(it.id); say('Restored — it’s back in the workflow.'); reload(); }
    catch (e) { setErr(e.message || 'Could not restore it'); } finally { setBusy(null); }
  }, [busy, reload]);

  // KPI tiles for the live queue.
  const kpis = useMemo(() => {
    if (!rows || effTab !== 'next') return null;
    const open = rows.filter(r => r.status === 'open').length;
    const inProg = rows.filter(r => r.status === 'in_progress').length;
    const overdue = rows.filter(r => r.sla_state === 'overdue'
      || (!r.sla_state && (Number(r.age_seconds) || 0) >= 86400)).length;
    return { total: rows.length, open, inProg, overdue };
  }, [rows, effTab]);

  const wfMeta = roleView ? ROLE_WF.find(w => w.role === roleView) : null;
  const title = isMine ? 'My Workflow'
    : wfMeta ? wfMeta.label
    : (roster && roster.staff || []).find(s => `staff:${s.id}` === view)
      ? `${(roster.staff.find(s => `staff:${s.id}` === view) || {}).full_name}’s workflow`
      : 'Workflow';
  const subtitle = isMine
    ? 'Every file submitted to you, in the order it arrived. Pick it up, do your part, then send it back.'
    : 'Oversight view — every file live in this workflow right now.';

  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <div className="sub">{subtitle}</div>
        </div>
        <div className="page-head-actions" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {isAdmin && (
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="small muted">Workflow</span>
              <select className="input" style={{ maxWidth: 240 }} value={view} onChange={e => { setView(e.target.value); setTab('next'); }}>
                <option value="mine">My workflow</option>
                <optgroup label="By workflow">
                  {ROLE_WF.map(w => <option key={w.role} value={`role:${w.role}`}>{w.label}</option>)}
                </optgroup>
                {roster && Array.isArray(roster.staff) && roster.staff.length > 0 && (
                  <optgroup label="By person">
                    {roster.staff.map(s => <option key={s.id} value={`staff:${s.id}`}>{s.full_name} — {ROLE_LABEL[s.role] || s.role}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          <div className="tabs">
            <button className={`tab ${effTab === 'next' ? 'on' : ''}`} onClick={() => setTab('next')}>Up next</button>
            {!roleView && <button className={`tab ${effTab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>Completed / Sent back</button>}
            <button className={`tab ${effTab === 'removed' ? 'on' : ''}`} onClick={() => setTab('removed')}>Removed</button>
          </div>
        </div>
      </div>

      {wfMeta && wfMeta.desk && (
        <div className="notice" style={{ marginBottom: 12 }}>
          This is the {wfMeta.label.toLowerCase()}. For the full process with all its details, open <Link className="btn link small" to={wfMeta.desk}>{wfMeta.deskLabel} →</Link>
        </div>
      )}

      {toast}
      {err && rows && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}
        <button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

      {!rows ? <div className="panel pad muted">Loading…</div> : (
        <div className="stack">
          {kpis && (
            <div className="kpi-grid">
              <div className="kpi"><div className="v">{kpis.total}</div><div className="k">{isMine ? 'On your list' : 'In this workflow'}</div><div className="d">{isMine ? 'Files waiting for you' : 'Live files right now'}</div></div>
              <div className="kpi"><div className="v">{kpis.open}</div><div className="k">Not started</div><div className="d">Waiting to be picked up</div></div>
              <div className="kpi"><div className="v">{kpis.inProg}</div><div className="k">In progress</div><div className="d">{isMine ? 'You’re working on these' : 'Being worked now'}</div></div>
              <div className="kpi"><div className="v">{kpis.overdue}</div><div className="k">Overdue</div><div className="d">Past their target time — start here</div></div>
            </div>
          )}

          {effTab === 'next' && (rows.length === 0
            ? <div className="panel"><div className="panel-b"><div className="empty-state"><h3>{isMine ? 'Nothing in your workflow right now 🎉' : 'Nothing live in this workflow right now'}</h3><p>{isMine ? 'When a teammate submits a file to you, it shows up here in the order it arrived.' : 'Files being worked in this process will appear here.'}</p></div></div></div>
            : <div className="panel">
                <div className="q-table wf-table">
                  <div className="q-head">
                    <span>File</span><span>What for</span><span>{isMine ? 'From' : 'Assigned to'}</span><span>Waiting</span><span>{isMine ? 'Do' : 'Open'}</span>
                  </div>
                  {rows.map(it => (
                    <React.Fragment key={it.id}>
                      <div className="q-row wf-row">
                        <Link to={`/internal/app/${it.application_id}`} className="wf-file">
                          <span className="mono">{initials(it.first_name, it.last_name)}</span>
                          <span>
                            <span className="who">{it.first_name} {it.last_name}</span>
                            <span className="what">{addrLine(it.property_address) || it.ys_loan_number || 'File'}</span>
                          </span>
                        </Link>
                        <span><span className="pill">{TYPE_LABEL[it.submission_type] || it.submission_type}</span>
                          {it.auto && <span className="pill" style={{ marginLeft: 6 }} title="Created automatically by PILOT">Auto</span>}
                          {it.status === 'in_progress' && <span className="muted small" style={{ marginLeft: 6 }}>· started</span>}
                          {it.est_closing_date && <span className="muted small" style={{ display: 'block' }}>Est. close {fmtDate(it.est_closing_date)}</span>}
                          {it.note && <span className="muted small" style={{ display: 'block' }}>“{it.note}”</span>}
                        </span>
                        <span className="muted small">{isMine
                          ? (it.from_name || '—')
                          : (it.to_name ? <>{it.to_name}{it.to_staff_role ? <span style={{ display: 'block' }}>{ROLE_LABEL[it.to_staff_role] || it.to_staff_role}</span> : null}</> : <span title="Unclaimed — in the role inbox">Unclaimed ({ROLE_LABEL[it.to_role] || it.to_role || '—'})</span>)}</span>
                        <span className={`due ${slaClass(it)}`} title={it.due_at ? `Target: ${fmtWhen(it.due_at)}` : ''}>
                          {it.sla_state === 'overdue' ? 'Overdue' : ageText(it.age_seconds)}</span>
                        <span className="wf-acts">
                          {isMine && it.status === 'open' && <button className="btn ghost small" disabled={busy === it.id} onClick={() => pickup(it.id)}>Pick up</button>}
                          {isMine && it.submission_type === 'escalation' && <Link className="btn primary small" to={`/internal/escalations?app=${it.application_id}`} title="Review the exception request and approve, decline, or counter-offer">Review exception</Link>}
                          {isMine && <button className="btn primary small" disabled={busy === it.id} onClick={() => { setReturning(returning === it.id ? null : it.id); setOutcome(''); setNote(''); }}>Send back</button>}
                          {(isMine || isAdmin) && <button className="btn ghost small" disabled={busy === it.id}
                            title="Take this hand-off off the workflow (does not delete the file — restorable from the Removed view)"
                            onClick={() => removeIt(it, wfMeta ? wfMeta.label.toLowerCase() : isMine ? 'your workflow' : 'this workflow')}>Remove</button>}
                          <Link className="btn ghost small" to={`/internal/app/${it.application_id}`}>Open</Link>
                        </span>
                      </div>
                      {isMine && returning === it.id && (
                        <div className="wf-returnbar">
                          <div className="muted small" style={{ marginBottom: 6 }}>Finish this and send the file back to <b>{it.from_name || 'the loan officer'}</b>. What did you do?</div>
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <select className="input" style={{ maxWidth: 220 }} value={outcome} onChange={e => setOutcome(e.target.value)}>
                              <option value="">— choose what you finished —</option>
                              {OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                            <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Add a note (optional)" value={note} onChange={e => setNote(e.target.value)} />
                            <button className="btn primary small" disabled={busy === it.id || !outcome} onClick={() => sendBack(it.id)}>Send back</button>
                            <button className="btn ghost small" onClick={() => setReturning(null)}>Cancel</button>
                          </div>
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>)}

          {/* Removed — hand-offs taken off this workflow (owner-directed
              2026-08-18). Nothing here is deleted; Restore puts it back. */}
          {effTab === 'removed' && (rows.length === 0
            ? <div className="panel"><div className="panel-b"><div className="empty-state"><h3>Nothing removed</h3><p>A hand-off removed from this workflow would be listed here, with a Restore button to put it back.</p></div></div></div>
            : <div className="panel">
                <div className="q-table wf-table">
                  <div className="q-head">
                    <span>File</span><span>What for</span><span>Removed</span><span>Why</span><span>Put back</span>
                  </div>
                  {rows.map(it => (
                    <div className="q-row wf-row" key={it.id}>
                      <Link to={`/internal/app/${it.application_id}`} className="wf-file">
                        <span className="mono">{initials(it.first_name, it.last_name)}</span>
                        <span>
                          <span className="who">{it.first_name} {it.last_name}</span>
                          <span className="what">{addrLine(it.property_address) || it.ys_loan_number || 'File'}</span>
                        </span>
                      </Link>
                      <span><span className="pill">{TYPE_LABEL[it.submission_type] || it.submission_type}</span></span>
                      <span className="muted small">{it.removed_at ? fmtWhen(it.removed_at) : '—'}{it.removed_by_name ? <span style={{ display: 'block' }}>by {it.removed_by_name}</span> : null}</span>
                      <span className="muted small">{it.removed_reason || '—'}</span>
                      <span className="wf-acts">
                        {(isMine || isAdmin) && <button className="btn ghost small" disabled={busy === it.id} onClick={() => restoreIt(it)}>Restore</button>}
                        <Link className="btn ghost small" to={`/internal/app/${it.application_id}`}>Open</Link>
                      </span>
                    </div>
                  ))}
                </div>
              </div>)}

          {effTab === 'history' && (rows.length === 0
            ? <div className="panel"><div className="panel-b"><div className="empty-state"><h3>No history yet</h3><p>Files {isMine ? 'you finish' : 'finished'} and sent back will be listed here.</p></div></div></div>
            : <div className="panel">
                <div className="q-table wf-table wf-hist">
                  <div className="q-head"><span>File</span><span>What for</span><span>What {isMine ? 'you' : 'they'} did</span><span>When</span></div>
                  {rows.map(ev => (
                    <div className="q-row wf-row" key={ev.id}>
                      <Link to={`/internal/app/${ev.application_id}`} className="wf-file">
                        <span className="mono">{initials(ev.first_name, ev.last_name)}</span>
                        <span>
                          <span className="who">{ev.first_name} {ev.last_name}</span>
                          <span className="what">{addrLine(ev.property_address) || ev.ys_loan_number || 'File'}</span>
                        </span>
                      </Link>
                      <span><span className="pill">{TYPE_LABEL[ev.submission_type] || ev.submission_type}</span></span>
                      <span>{ev.event_type === 'returned'
                        ? <><b>{ev.outcome_label || 'Sent back'}</b>{ev.note ? <span className="muted small" style={{ display: 'block' }}>“{ev.note}”</span> : null}</>
                        : ev.event_type === 'picked_up' ? <span className="muted">Picked up</span>
                        : <span className="muted">Submitted{ev.to_name ? ` to ${ev.to_name}` : ''}</span>}
                      </span>
                      <span className="muted small">{fmtWhen(ev.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>)}
        </div>
      )}
    </>
  );
}
