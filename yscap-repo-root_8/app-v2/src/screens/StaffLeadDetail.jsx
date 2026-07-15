import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { PhoneInput } from '../components/FormattedInputs.jsx';
import { useAuth } from '../lib/auth.jsx';
import {
  STAGES, STAGE_LABEL, STAGE_PILL, SOURCES, PROGRAMS, TOOL_LABEL, ACTIVITY_TYPES,
  leadName, initials, money, addrLine,
} from '../lib/leadCrm.js';

/* Lead workspace (owner-directed full CRM, 2026-07-14): everything a loan
   officer needs on one lead — contact + deal fields, the stage, ownership, a
   typed activity timeline (calls/emails/texts/meetings/notes), tasks with due
   dates, file attachments, and one-click conversion to a live loan file. */

// Tiny line-icons for the activity composer + timeline entries.
const ActIcon = ({ kind }) => {
  const p = {
    note: <path d="M5 4h14v12l-4 4H5z M15 20v-4h4" />,
    call: <path d="M6 3l3 1 1 4-2 2a12 12 0 0 0 5 5l2-2 4 1 1 3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2Z" />,
    email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
    sms: <path d="M5 4h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 15h-7l-4 4v-4H5A1.5 1.5 0 0 1 3.5 13.5v-8A1.5 1.5 0 0 1 5 4Z" />,
    meeting: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M17 8h4M19 6v4" /></>,
    status_change: <path d="M4 12h11m0 0-4-4m4 4-4 4M20 6v12" />,
    file: <path d="M6 3h8l4 4v14H6z M14 3v4h4" />,
    assignment: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
    system: <circle cx="12" cy="12" r="8" />,
  };
  return (
    <span className="lda-ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round">{p[kind] || p.system}</svg>
    </span>
  );
};

const fmtWhen = (d) => { try { return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return d; } };
const fmtDay = (d) => { try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return d; } };

// Read a File into raw base64 (no data: prefix), matching the upload contract.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function StaffLeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { actor, can } = useAuth();
  const seesAll = can ? can('see_all_files') : false;

  const [lead, setLead] = useState(null);
  const [team, setTeam] = useState([]);
  const [acts, setActs] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [docs, setDocs] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);       // editable contact/deal form
  const [dirty, setDirty] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2600); };

  const reloadLead = () => api.staffLead(id).then(l => { setLead(l); setForm(shapeForm(l)); setDirty(false); }).catch(e => setErr(e.message));
  const reloadFeeds = () => {
    api.staffLeadActivities(id).then(setActs).catch(() => {});
    api.staffLeadTasks(id).then(setTasks).catch(() => {});
    api.staffLeadDocuments(id).then(setDocs).catch(() => {});
  };
  useEffect(() => { reloadLead(); reloadFeeds(); api.staffTeam().then(setTeam).catch(() => {}); /* eslint-disable-next-line */ }, [id]);

  const officers = useMemo(() => team.filter(m => ['loan_officer', 'admin', 'super_admin', 'processor'].includes(m.role)), [team]);

  if (err) return <div role="alert" className="notice err">{err} <Link className="btn link small" to="/internal/leads">Back to leads</Link></div>;
  if (!lead || !form) return <div className="panel pad muted">Loading lead…</div>;

  const mine = lead.officer_id && actor && lead.officer_id === actor.id;
  const converted = !!lead.application_id;

  function shapeForm(l) {
    return {
      firstName: l.first_name || '', lastName: l.last_name || '', company: l.company || '',
      email: l.email || '', phone: l.phone || '', phoneAlt: l.phone_alt || '',
      program: l.program || '', loanAmount: l.loan_amount != null ? String(l.loan_amount) : '',
      leadSource: l.lead_source || l.source || '', referralPartner: l.referral_partner || '',
      propertyOneLine: (l.property_address && l.property_address.oneLine) || addrLine(l.property_address) || '',
      estimatedClose: l.estimated_close ? String(l.estimated_close).slice(0, 10) : '',
      lostReason: l.lost_reason || '',
    };
  }
  const setField = (k, v) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };

  async function saveContact() {
    try {
      await api.staffUpdateLead(id, {
        firstName: form.firstName, lastName: form.lastName, company: form.company,
        email: form.email, phone: form.phone, phoneAlt: form.phoneAlt,
        program: form.program, loanAmount: form.loanAmount === '' ? '' : Number(form.loanAmount),
        leadSource: form.leadSource, referralPartner: form.referralPartner,
        estimatedClose: form.estimatedClose || null,
        propertyAddress: form.propertyOneLine ? { oneLine: form.propertyOneLine } : null,
      });
      flash('Saved'); await reloadLead(); reloadFeeds();
    } catch (e) { setErr(e.message); }
  }
  async function patchLead(body, note) {
    try { await api.staffUpdateLead(id, body); if (note) flash(note); await reloadLead(); reloadFeeds(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <>
      {msg && <div className="notice ok" style={{ marginBottom: 12 }}>{msg}</div>}

      {/* Header */}
      <div className="lead-head">
        <div className="lead-head-main">
          <Link className="btn link small" to="/internal/leads">← All leads</Link>
          <div className="lead-title">
            <span className="lda-avatar">{initials(leadName(lead))}</span>
            <div>
              <h1>{leadName(lead)}</h1>
              <div className="sub">
                {lead.company ? <>{lead.company} · </> : null}
                {TOOL_LABEL[lead.tool] || lead.lead_source || 'Lead'}
                {lead.created_at ? ` · added ${fmtDay(lead.created_at)}` : ''}
                {lead.created_by_name ? ` by ${lead.created_by_name}` : ''}
              </div>
            </div>
          </div>
        </div>
        <div className="lead-head-actions">
          <select className="input stage-select" value={lead.status} onChange={e => patchLead({ status: e.target.value }, `Moved to ${STAGE_LABEL[e.target.value]}`)}
            title="Pipeline stage">
            {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {converted
            ? <Link className="btn btn-ink btn-sm" to={`/internal/app/${lead.application_id}`}>Open loan file →</Link>
            : <button className="btn btn-gold btn-sm" onClick={() => setConvertOpen(true)}>Convert to loan file</button>}
        </div>
      </div>

      <div className="lead-grid">
        {/* ---- Left: contact + deal + ownership ---- */}
        <div className="stack">
          <div className="panel">
            <div className="panel-h"><h3>Contact &amp; deal</h3>
              {dirty && <button className="btn primary btn-sm" onClick={saveContact}>Save</button>}
            </div>
            <div className="panel-b lead-form">
              <div className="grid cols-2">
                <label className="field"><span>First name</span><input className="input" value={form.firstName} onChange={e => setField('firstName', e.target.value)} /></label>
                <label className="field"><span>Last name</span><input className="input" value={form.lastName} onChange={e => setField('lastName', e.target.value)} /></label>
              </div>
              <label className="field"><span>Company / entity</span><input className="input" value={form.company} onChange={e => setField('company', e.target.value)} placeholder="Acme Holdings LLC" /></label>
              <div className="grid cols-2">
                <label className="field"><span>Email</span><input className="input" type="email" value={form.email} onChange={e => setField('email', e.target.value)} /></label>
                <label className="field"><span>Phone</span><PhoneInput value={form.phone} onChange={v => setField('phone', v)} /></label>
              </div>
              <div className="grid cols-2">
                <label className="field"><span>Alt phone</span><PhoneInput value={form.phoneAlt} onChange={v => setField('phoneAlt', v)} /></label>
                <label className="field"><span>Source</span>
                  <select className="input" value={form.leadSource} onChange={e => setField('leadSource', e.target.value)}>
                    <option value="">—</option>
                    {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                    {form.leadSource && !SOURCES.includes(form.leadSource) && <option value={form.leadSource}>{form.leadSource}</option>}
                  </select>
                </label>
              </div>
              <label className="field"><span>Referral partner</span><input className="input" value={form.referralPartner} onChange={e => setField('referralPartner', e.target.value)} placeholder="Who referred them?" /></label>
              <div className="grid cols-2">
                <label className="field"><span>Program of interest</span>
                  <select className="input" value={form.program} onChange={e => setField('program', e.target.value)}>
                    <option value="">—</option>
                    {PROGRAMS.map(p => <option key={p} value={p}>{p}</option>)}
                    {form.program && !PROGRAMS.includes(form.program) && <option value={form.program}>{form.program}</option>}
                  </select>
                </label>
                <label className="field"><span>Est. loan amount</span><input className="input" type="number" min="0" inputMode="numeric" value={form.loanAmount} onChange={e => setField('loanAmount', e.target.value)} placeholder="325000" /></label>
              </div>
              <label className="field"><span>Subject property (if any)</span><input className="input" value={form.propertyOneLine} onChange={e => setField('propertyOneLine', e.target.value)} placeholder="123 Main St, City, ST" /></label>
              <label className="field"><span>Target close</span><input className="input" type="date" value={form.estimatedClose} onChange={e => setField('estimatedClose', e.target.value)} /></label>
              {lead.status === 'lost' && (
                <label className="field"><span>Lost reason</span><input className="input" value={form.lostReason} onChange={e => setField('lostReason', e.target.value)} onBlur={() => patchLead({ lostReason: form.lostReason })} placeholder="Why did this lead not move forward?" /></label>
              )}
              {dirty && <div className="row" style={{ gap: 8, marginTop: 4 }}><button className="btn primary btn-sm" onClick={saveContact}>Save changes</button><button className="btn btn-ghost btn-sm" onClick={() => { setForm(shapeForm(lead)); setDirty(false); }}>Cancel</button></div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-h"><h3>Ownership &amp; follow-up</h3></div>
            <div className="panel-b lead-form">
              <label className="field"><span>Owner</span>
                {seesAll
                  ? <select className="input" value={lead.officer_id || ''} onChange={e => patchLead({ officerId: e.target.value || null }, 'Owner updated')}>
                      <option value="">Loan desk (unassigned)</option>
                      {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
                    </select>
                  : (mine
                      ? <div className="row" style={{ gap: 8, alignItems: 'center' }}><span className="off"><span className="mono">{initials(lead.officer_name)}</span>You</span><button className="btn btn-ghost btn-sm" onClick={() => patchLead({ officerId: null }, 'Released to the desk')}>Release</button></div>
                      : <div className="row" style={{ gap: 8, alignItems: 'center' }}><span className="off un"><span className="dot" />{lead.officer_name || 'Loan desk'}</span><button className="btn primary btn-sm" onClick={() => patchLead({ officerId: actor && actor.id }, 'Claimed — it’s yours')}>Claim to me</button></div>)}
              </label>
              <label className="field"><span>Next follow-up</span>
                <input className="input" type="date" value={lead.next_follow_up ? String(lead.next_follow_up).slice(0, 10) : ''}
                  onChange={e => patchLead({ nextFollowUp: e.target.value || null }, e.target.value ? 'Follow-up set' : 'Follow-up cleared')} />
              </label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {lead.email && <a className="btn btn-ghost btn-sm" href={`mailto:${lead.email}`}>Email</a>}
                {lead.phone && <a className="btn btn-ghost btn-sm" href={`tel:${lead.phone}`}>Call</a>}
              </div>
            </div>
          </div>
        </div>

        {/* ---- Center: activity timeline ---- */}
        <div className="panel lead-timeline-panel">
          <div className="panel-h"><h3>Activity</h3><span className="pill mut">{acts.length}</span></div>
          <div className="panel-b">
            <ActivityComposer leadId={id} onLogged={() => { reloadFeeds(); reloadLead(); }} onErr={setErr} />
            {acts.length === 0
              ? <div className="muted small" style={{ marginTop: 14 }}>No activity yet. Log your first call, email, or note above.</div>
              : (
                <ol className="lead-timeline">
                  {acts.map(a => (
                    <li key={a.id} className={`lda-item t-${a.activity_type}`}>
                      <ActIcon kind={a.activity_type} />
                      <div className="lda-body">
                        <div className="lda-top">
                          <span className="lda-subj">{a.subject || labelForType(a.activity_type)}</span>
                          {a.direction && <span className="lda-dir">{a.direction === 'inbound' ? 'inbound' : 'outbound'}</span>}
                          <span className="lda-when">{fmtWhen(a.occurred_at)}</span>
                        </div>
                        {a.body && <div className="lda-text">{a.body}</div>}
                        <div className="muted small">{a.staff_name || 'System'}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
          </div>
        </div>

        {/* ---- Right: tasks + attachments ---- */}
        <div className="stack">
          <TasksPanel leadId={id} tasks={tasks} officers={officers} actor={actor}
            onChange={() => { reloadFeeds(); }} onErr={setErr} />
          <AttachmentsPanel leadId={id} docs={docs} onChange={() => { reloadFeeds(); reloadLead(); }} onErr={setErr} />
        </div>
      </div>

      {convertOpen && (
        <ConvertModal lead={lead} officers={officers} onClose={() => setConvertOpen(false)}
          onConverted={(appId) => { setConvertOpen(false); nav(`/internal/app/${appId}`); }} onErr={setErr} />
      )}
    </>
  );
}

function labelForType(t) {
  const m = { call: 'Call', email: 'Email', sms: 'Text', meeting: 'Meeting', note: 'Note', status_change: 'Stage change', file: 'File', assignment: 'Assignment', system: 'Update' };
  return m[t] || 'Activity';
}

// ---- Activity composer -----------------------------------------------------
function ActivityComposer({ leadId, onLogged, onErr }) {
  const [type, setType] = useState('note');
  const [body, setBody] = useState('');
  const [direction, setDirection] = useState('outbound');
  const [busy, setBusy] = useState(false);
  const showDir = type === 'call' || type === 'email' || type === 'sms';
  async function log() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.staffAddLeadActivity(leadId, { type, body: text, direction: showDir ? direction : undefined });
      setBody(''); onLogged();
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }
  return (
    <div className="lead-composer">
      <div className="lda-typerow">
        {ACTIVITY_TYPES.map(t => (
          <button key={t.key} type="button" className={`lda-type ${type === t.key ? 'on' : ''}`} onClick={() => setType(t.key)}>
            <ActIcon kind={t.icon} />{t.label}
          </button>
        ))}
        {showDir && (
          <select className="input lda-dirsel" value={direction} onChange={e => setDirection(e.target.value)}>
            <option value="outbound">Outbound</option>
            <option value="inbound">Inbound</option>
          </select>
        )}
      </div>
      <textarea className="input" rows={2} placeholder={type === 'note' ? 'Add a note…' : `Log this ${labelForType(type).toLowerCase()}…`}
        value={body} onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) log(); }} />
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-gold btn-sm" disabled={busy || !body.trim()} onClick={log}>{busy ? 'Logging…' : `Log ${labelForType(type).toLowerCase()}`}</button>
      </div>
    </div>
  );
}

// ---- Tasks -----------------------------------------------------------------
function TasksPanel({ leadId, tasks, officers, actor, onChange, onErr }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState(actor ? actor.id : '');
  const [busy, setBusy] = useState(false);
  const open = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  async function add() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.staffAddLeadTask(leadId, { title: t, dueAt: due ? new Date(due).toISOString() : undefined, assigneeStaffId: assignee || undefined });
      setTitle(''); setDue(''); onChange();
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }
  async function toggle(task) {
    try { await api.staffUpdateLeadTask(leadId, task.id, { done: !task.done }); onChange(); } catch (e) { onErr(e.message); }
  }
  const overdue = (t) => t.due_at && new Date(t.due_at) < new Date() && !t.done;
  return (
    <div className="panel">
      <div className="panel-h"><h3>Tasks</h3>{open.length > 0 && <span className="pill warn">{open.length} open</span>}</div>
      <div className="panel-b">
        <div className="lead-taskadd">
          <input className="input" placeholder="Add a task (e.g. Send term sheet)…" value={title}
            onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
          <div className="row" style={{ gap: 6 }}>
            <input className="input" type="date" style={{ maxWidth: 150 }} value={due} onChange={e => setDue(e.target.value)} title="Due date" />
            {officers.length > 0 && (
              <select className="input" style={{ maxWidth: 150 }} value={assignee} onChange={e => setAssignee(e.target.value)} title="Assignee">
                <option value="">Assign to me</option>
                {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
              </select>
            )}
            <button className="btn primary btn-sm" disabled={busy || !title.trim()} onClick={add}>Add</button>
          </div>
        </div>
        {tasks.length === 0
          ? <div className="muted small" style={{ marginTop: 10 }}>No tasks yet.</div>
          : (
            <ul className="lead-tasks">
              {open.map(t => (
                <li key={t.id} className={overdue(t) ? 'overdue' : ''}>
                  <label className="lead-task-check"><input type="checkbox" checked={false} onChange={() => toggle(t)} /></label>
                  <div className="lead-task-body">
                    <div className="lead-task-title">{t.title}</div>
                    <div className="muted small">
                      {t.due_at ? `Due ${fmtDay(t.due_at)}` : 'No due date'}
                      {t.assignee_name ? ` · ${t.assignee_name}` : ''}
                    </div>
                  </div>
                </li>
              ))}
              {done.map(t => (
                <li key={t.id} className="done">
                  <label className="lead-task-check"><input type="checkbox" checked readOnly onChange={() => toggle(t)} /></label>
                  <div className="lead-task-body"><div className="lead-task-title">{t.title}</div><div className="muted small">Done{t.done_at ? ` · ${fmtDay(t.done_at)}` : ''}</div></div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

// ---- Attachments -----------------------------------------------------------
function AttachmentsPanel({ leadId, docs, onChange, onErr }) {
  const [busy, setBusy] = useState(false);
  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.staffAddLeadDocument(leadId, { filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64 });
      onChange();
    } catch (e2) { onErr(e2.message || 'Upload failed'); }
    setBusy(false);
  }
  const kb = (n) => n == null ? '' : (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  return (
    <div className="panel">
      <div className="panel-h"><h3>Files</h3>{docs.length > 0 && <span className="pill mut">{docs.length}</span>}</div>
      <div className="panel-b">
        <label className={`btn btn-ghost btn-sm ${busy ? 'disabled' : ''}`} style={{ cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Uploading…' : '+ Attach a file'}
          <input type="file" style={{ display: 'none' }} onChange={onFile} disabled={busy} />
        </label>
        {docs.length === 0
          ? <div className="muted small" style={{ marginTop: 10 }}>No files yet. Attach pre-approvals, IDs, or anything the borrower sends.</div>
          : (
            <ul className="lead-files">
              {docs.map(d => (
                <li key={d.id}>
                  <button type="button" className="lead-file-name" title="Download"
                    onClick={async () => { try { const { blob, filename } = await api.staffDownloadLeadDoc(leadId, d.id); saveBlob(blob, filename || d.filename); } catch (e) { onErr(e.message || 'Could not open file'); } }}>
                    {d.filename}
                  </button>
                  <span className="muted small">{kb(d.size_bytes)}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

// ---- Convert modal ---------------------------------------------------------
function ConvertModal({ lead, officers, onClose, onConverted, onErr }) {
  const [firstName, setFirstName] = useState(lead.first_name || '');
  const [lastName, setLastName] = useState(lead.last_name || '');
  const [email, setEmail] = useState(lead.email || '');
  const [propertyOneLine, setProp] = useState((lead.property_address && lead.property_address.oneLine) || addrLine(lead.property_address) || '');
  const [program, setProgram] = useState(lead.program || '');
  const [officerId, setOfficerId] = useState(lead.officer_id || '');
  const [busy, setBusy] = useState(false);
  async function convert() {
    if (busy) return;
    if (!email.trim()) return onErr('A borrower email is required to convert.');
    if (!firstName.trim()) return onErr('A borrower first name is required to convert.');
    if (!propertyOneLine.trim()) return onErr('A subject property address is required to convert.');
    setBusy(true);
    try {
      const r = await api.staffConvertLead(lead.id, {
        firstName, lastName, email, program: program || undefined,
        loanOfficerId: officerId || undefined,
        propertyAddress: { oneLine: propertyOneLine.trim() },
      });
      onConverted(r.applicationId);
    } catch (e) { onErr(e.message || 'Convert failed'); setBusy(false); }
  }
  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal lead-convert" onClick={e => e.stopPropagation()} role="dialog" aria-label="Convert lead to a loan file">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Convert to a loan file</h3>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">Close ✕</button>
        </div>
        <div className="lead-form">
          <p className="muted small">This creates (or matches) the borrower and opens a new loan file, then links this lead to it.</p>
          <div className="grid cols-2">
            <label className="field"><span>First name</span><input className="input" value={firstName} onChange={e => setFirstName(e.target.value)} /></label>
            <label className="field"><span>Last name</span><input className="input" value={lastName} onChange={e => setLastName(e.target.value)} /></label>
          </div>
          <label className="field"><span>Borrower email</span><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className="field"><span>Subject property address</span><input className="input" value={propertyOneLine} onChange={e => setProp(e.target.value)} placeholder="123 Main St, City, ST 00000" /></label>
          <div className="grid cols-2">
            <label className="field"><span>Program</span>
              <select className="input" value={program} onChange={e => setProgram(e.target.value)}>
                <option value="">—</option>
                {PROGRAMS.map(p => <option key={p} value={p}>{p}</option>)}
                {program && !PROGRAMS.includes(program) && <option value={program}>{program}</option>}
              </select>
            </label>
            <label className="field"><span>Loan officer</span>
              <select className="input" value={officerId} onChange={e => setOfficerId(e.target.value)}>
                <option value="">Unassigned</option>
                {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" disabled={busy} onClick={convert}>{busy ? 'Converting…' : 'Create loan file'}</button>
        </div>
      </div>
    </div>
  );
}
