import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Leads CRM (owner-directed 2026-07-14): the marketing-lead capture, built up
   into a working desk for loan officers — status pipeline, claim/assign, a
   next-follow-up date, and a per-lead notes / contact log. Admins/underwriters
   see every lead; a loan officer sees the ones routed to them plus the shared
   (unassigned) desk. */

const TOOL_LABEL = {
  loan_application: 'Loan application', rehab_budget: 'Rehab budget', term_sheet: 'Term sheet',
  deal_analyzer: 'Deal analyzer', qualifier: 'Qualifier', contact: 'Contact',
  subscribe: 'Newsletter', dscr_waitlist: 'DSCR waitlist',
};
const STATUSES = ['new', 'contacted', 'working', 'converted', 'archived'];
const SRC_CLASS = { term_sheet: 'ts', loan_application: 'app', contact: 'contact' };
const STATUS_PILL = { new: 'info', contacted: 'warn', working: 'warn', converted: 'ok', archived: 'mut' };
const initials = (s) => (String(s || '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase()) || '—';
const todayStr = () => new Date().toISOString().slice(0, 10);
const dueSoon = (l) => l.next_follow_up && String(l.next_follow_up).slice(0, 10) <= todayStr() && l.status !== 'converted' && l.status !== 'archived';

export default function StaffLeads() {
  const { actor } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState('open');   // open | due | all
  const [open, setOpen] = useState(null);
  const [notes, setNotes] = useState([]);         // notes for the open lead
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.staffLeads().then(setRows).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  async function patch(id, body, note) {
    try { await api.staffUpdateLead(id, body); await load(); if (note) flash(note); }
    catch (e) { setErr(e.message); }
  }
  async function openLead(l) {
    if (open === l.id) { setOpen(null); return; }
    setOpen(l.id); setNotes([]); setNoteText('');
    try { setNotes(await api.staffLeadNotes(l.id)); } catch { /* keep empty */ }
  }
  async function addNote(id) {
    const body = noteText.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.staffAddLeadNote(id, body);
      setNoteText('');
      setNotes(await api.staffLeadNotes(id));
      await load();   // a note nudges 'new' → 'contacted' + re-sorts
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (rows == null) return <div className="panel pad muted">Loading leads…</div>;

  const isOpenStatus = (r) => r.status !== 'archived' && r.status !== 'converted';
  const shown = rows.filter(r => filter === 'all' ? true : filter === 'due' ? dueSoon(r) : isOpenStatus(r));
  const openCount = rows.filter(isOpenStatus).length;
  const newCount = rows.filter(r => r.status === 'new').length;
  const workingCount = rows.filter(r => r.status === 'contacted' || r.status === 'working').length;
  const convertedCount = rows.filter(r => r.status === 'converted').length;
  const dueCount = rows.filter(dueSoon).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="sub">
            Submissions from the website tools — application, rehab budget, term-sheet requests, DSCR &amp; newsletter
            sign-ups. Claim a lead, log every touch, set a follow-up, and move it down the pipeline to a live file.
          </div>
        </div>
        <div className="filters page-head-actions">
          <button className={`tab ${filter === 'open' ? 'on' : ''}`} onClick={() => setFilter('open')}>Open <span className="ct">{openCount}</span></button>
          {dueCount > 0 && <button className={`tab ${filter === 'due' ? 'on' : ''}`} onClick={() => setFilter('due')}>Follow up <span className="ct">{dueCount}</span></button>}
          <button className={`tab ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All <span className="ct">{rows.length}</span></button>
        </div>
      </div>

      {msg && <div className="notice ok" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="stack">
        <div className="kpi-grid">
          <div className="kpi"><div className="v">{newCount}</div><div className="k">New leads</div><div className="d">Awaiting triage</div></div>
          <div className="kpi"><div className="v">{workingCount}</div><div className="k">Working</div><div className="d">Contacted or in progress</div></div>
          <div className="kpi"><div className="v">{dueCount}</div><div className="k">Follow up due</div><div className="d">On/past their date</div></div>
          <div className="kpi"><div className="v">{convertedCount}</div><div className="k">Converted</div><div className="d">Promoted to a live file</div></div>
        </div>

        <div className="panel">
          <div className="panel-h">
            <h3>Captured leads</h3>
            <span className="pill mut">{shown.length} shown</span>
          </div>
          {shown.length === 0
            ? <div className="panel-b"><div className="empty-state"><h3>No {filter === 'all' ? '' : filter + ' '}leads yet</h3><p>New submissions from the site tools will land here.</p></div></div>
            : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Name</th><th>Source</th><th>Contact</th><th>Status</th>
                      <th>Assigned</th><th>Follow up</th><th>Received</th><th className="act">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(l => {
                      const isOpen = open === l.id;
                      const mine = l.officer_id && actor && l.officer_id === actor.id;
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
                              ? <span className="off"><span className="mono">{initials(l.officer_name)}</span>{mine ? 'You' : l.officer_name}</span>
                              : <span className="off un"><span className="dot" />Loan desk</span>}</td>
                            <td className="mut" style={dueSoon(l) ? { color: 'var(--warning, #b8860b)', fontWeight: 600 } : undefined}>
                              {l.next_follow_up ? String(l.next_follow_up).slice(0, 10) : '—'}
                            </td>
                            <td className="rec">{new Date(l.created_at).toLocaleDateString()}</td>
                            <td className="act">
                              <div className="row-act">
                                <select className="input" style={{ maxWidth: 130 }} value={l.status} onChange={e => patch(l.id, { status: e.target.value })}>
                                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                                <button className="btn btn-ghost btn-sm" onClick={() => openLead(l)}>{isOpen ? 'Close' : 'Open'}{l.note_count > 0 ? ` · ${l.note_count}` : ''}</button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="lead-payload-row">
                              <td colSpan={8}>
                                <div className="grid cols-2" style={{ gap: 18, alignItems: 'start' }}>
                                  {/* left: manage */}
                                  <div>
                                    <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                                      {l.email && <a className="btn btn-ghost btn-sm" href={`mailto:${l.email}`}>✉ Email</a>}
                                      {l.phone && <a className="btn btn-ghost btn-sm" href={`tel:${l.phone}`}>☎ Call</a>}
                                      {mine
                                        ? <button className="btn btn-ghost btn-sm" onClick={() => patch(l.id, { officerId: null }, 'Released to the desk')}>Release</button>
                                        : <button className="btn primary btn-sm" onClick={() => patch(l.id, { officerId: actor && actor.id }, 'Claimed — it’s yours')}>Claim to me</button>}
                                    </div>
                                    <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>Next follow-up</label>
                                    <input className="input" type="date" style={{ maxWidth: 200 }} value={l.next_follow_up ? String(l.next_follow_up).slice(0, 10) : ''}
                                      onChange={e => patch(l.id, { nextFollowUp: e.target.value || null }, e.target.value ? 'Follow-up set' : 'Follow-up cleared')} />
                                    {l.payload && (
                                      <details style={{ marginTop: 12 }}>
                                        <summary className="muted small" style={{ cursor: 'pointer' }}>Submission detail</summary>
                                        <pre className="lead-payload" style={{ marginTop: 8 }}>{JSON.stringify(l.payload, null, 2)}</pre>
                                      </details>
                                    )}
                                  </div>
                                  {/* right: notes / contact log */}
                                  <div>
                                    <div className="muted small" style={{ marginBottom: 6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>Contact log</div>
                                    <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                                      <input className="input" style={{ flex: 1 }} placeholder="Log a call, email, or note…" value={noteText}
                                        onChange={e => setNoteText(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote(l.id)} />
                                      <button className="btn primary btn-sm" disabled={busy || !noteText.trim()} onClick={() => addNote(l.id)}>{busy ? '…' : 'Log'}</button>
                                    </div>
                                    {notes.length === 0
                                      ? <div className="muted small">No notes yet — every call or email you log shows here.</div>
                                      : notes.map(n => (
                                          <div key={n.id} style={{ padding: '7px 0', borderTop: '1px solid rgba(127,127,127,.14)' }}>
                                            <div style={{ fontSize: 14 }}>{n.body}</div>
                                            <div className="muted small">{n.staff_name || 'Staff'} · {new Date(n.created_at).toLocaleString()}</div>
                                          </div>
                                        ))}
                                  </div>
                                </div>
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
