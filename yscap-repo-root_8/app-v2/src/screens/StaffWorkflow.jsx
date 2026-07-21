import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* THE WORKFLOW (owner-directed 2026-07-21) — my personal work queue.
   Everything submitted to me, in the order it arrived, with a live "up next"
   list and a history of what I finished / sent back. Simple on purpose: pick a
   file up, do your part, then send it back with what you did. */

const TYPE_LABEL = {
  loan_setup: 'Loan Setup', processing: 'Processing', condition_clearing: 'Condition Clearing',
  clear_to_close: 'Clear to Close', closing: 'Closing', draw_setup: 'Draw Setup',
  post_closing: 'Post-Closing / Investor Delivery', exception: 'Exception', escalation: 'Escalation',
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
const fmtWhen = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return ts; } };

export default function StaffWorkflow() {
  const [tab, setTab] = useState('next');            // next | history
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);            // item id being acted on
  const [flash, setFlash] = useState('');
  const [returning, setReturning] = useState(null);  // item id whose send-back form is open
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');

  const OUTCOMES = ['Finished processing', 'Finished loan setup', 'Finished CTC', 'Cleared conditions',
    'Added conditions', 'Cleared exception', 'Finished closing', 'Finished draw setup', 'Reviewed', 'Sent back — needs more'];

  const reload = useCallback(() => {
    setRows(null);
    api.workflowQueue({ tab }).then(setRows).catch(e => setErr(e.message));
  }, [tab]);
  useEffect(() => { reload(); }, [reload]);

  const say = (m) => { setFlash(m); setTimeout(() => setFlash(''), 5000); };

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

  // KPI tiles for the live queue.
  const kpis = useMemo(() => {
    if (!rows || tab !== 'next') return null;
    const open = rows.filter(r => r.status === 'open').length;
    const inProg = rows.filter(r => r.status === 'in_progress').length;
    const aging = rows.filter(r => (Number(r.age_seconds) || 0) >= 86400).length;
    return { total: rows.length, open, inProg, aging };
  }, [rows, tab]);

  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Workflow</h1>
          <div className="sub">Every file submitted to you, in the order it arrived. Pick it up, do your part, then send it back.</div>
        </div>
        <div className="page-head-actions">
          <div className="tabs">
            <button className={`tab ${tab === 'next' ? 'on' : ''}`} onClick={() => setTab('next')}>Up next</button>
            <button className={`tab ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>Completed / Sent back</button>
          </div>
        </div>
      </div>

      {flash && <div className="notice ok" style={{ marginBottom: 12 }}>{flash}</div>}
      {err && rows && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}
        <button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

      {!rows ? <div className="panel pad muted">Loading your workflow…</div> : (
        <div className="stack">
          {kpis && (
            <div className="kpi-grid">
              <div className="kpi"><div className="v">{kpis.total}</div><div className="k">On your list</div><div className="d">Files waiting for you</div></div>
              <div className="kpi"><div className="v">{kpis.open}</div><div className="k">Not started</div><div className="d">Waiting to be picked up</div></div>
              <div className="kpi"><div className="v">{kpis.inProg}</div><div className="k">In progress</div><div className="d">You’re working on these</div></div>
              <div className="kpi"><div className="v">{kpis.aging}</div><div className="k">Waiting 1+ day</div><div className="d">Oldest first — start here</div></div>
            </div>
          )}

          {tab === 'next' && (rows.length === 0
            ? <div className="panel"><div className="panel-b"><div className="empty-state"><h3>Nothing in your workflow right now 🎉</h3><p>When a teammate submits a file to you, it shows up here in the order it arrived.</p></div></div></div>
            : <div className="panel">
                <div className="q-table wf-table">
                  <div className="q-head">
                    <span>File</span><span>What for</span><span>From</span><span>Waiting</span><span>Do</span>
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
                          {it.status === 'in_progress' && <span className="muted small" style={{ marginLeft: 6 }}>· started</span>}
                          {it.est_closing_date && <span className="muted small" style={{ display: 'block' }}>Est. close {it.est_closing_date}</span>}
                          {it.note && <span className="muted small" style={{ display: 'block' }}>“{it.note}”</span>}
                        </span>
                        <span className="muted small">{it.from_name || '—'}</span>
                        <span className={`due ${ageClass(it.age_seconds)}`}>{ageText(it.age_seconds)}</span>
                        <span className="wf-acts">
                          {it.status === 'open' && <button className="btn ghost small" disabled={busy === it.id} onClick={() => pickup(it.id)}>Pick up</button>}
                          <button className="btn primary small" disabled={busy === it.id} onClick={() => { setReturning(returning === it.id ? null : it.id); setOutcome(''); setNote(''); }}>Send back</button>
                          <Link className="btn ghost small" to={`/internal/app/${it.application_id}`}>Open</Link>
                        </span>
                      </div>
                      {returning === it.id && (
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

          {tab === 'history' && (rows.length === 0
            ? <div className="panel"><div className="panel-b"><div className="empty-state"><h3>No history yet</h3><p>Files you finish and send back will be listed here.</p></div></div></div>
            : <div className="panel">
                <div className="q-table wf-table wf-hist">
                  <div className="q-head"><span>File</span><span>What for</span><span>What you did</span><span>When</span></div>
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
