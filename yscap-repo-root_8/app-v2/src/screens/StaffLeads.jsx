import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { PhoneInput , EmailInput} from '../components/FormattedInputs.jsx';
import { fmtDay } from '../lib/dates.js';
import { useAuth } from '../lib/auth.jsx';
import {
  STAGES, STAGE_LABEL, STAGE_PILL, BOARD_STAGES, OPEN_STAGES, SOURCES, PROGRAMS,
  TOOL_LABEL, leadName, initials, money, dueSoon, todayStr,
} from '../lib/leadCrm.js';

/* Leads CRM (owner-directed full CRM, 2026-07-14): a real lead desk for loan
   officers — a kanban pipeline OR list, manual + marketing-captured leads,
   search & filters, per-lead ownership, deal value, and a click-through to the
   full lead workspace (timeline, tasks, files, convert). Admins/underwriters see
   every lead; a loan officer sees theirs plus the shared (unassigned) desk. */

// The EFFECTIVE source for filtering/labels: the generic 'marketing_site'
// bucket (every public form lands there; the db/101 boot backfill stamps
// lead_source with it) is useless as a filter — fall through to the TOOL so
// "Newsletter / updates subscription" vs "Loan application" stay distinct.
// This also keeps the bulk-archive (#153) keyed to ONE tool, never a sweep of
// every public lead at once (audit-caught 2026-07-17).
const effSource = (l) => {
  const src = l.lead_source || l.source;
  return (src && src !== 'marketing_site') ? src : (l.tool || src);
};

export default function StaffLeads() {
  const { actor, can } = useAuth();
  const nav = useNavigate();
  const seesAll = can ? can('see_all_files') : false;
  const [rows, setRows] = useState(null);
  const [team, setTeam] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [view, setView] = useState('board');      // board | list
  const [q, setQ] = useState('');
  const [stageF, setStageF] = useState('');
  const [ownerF, setOwnerF] = useState('');
  const [sourceF, setSourceF] = useState('');
  const [scope, setScope] = useState('open');     // open | all
  const [addOpen, setAddOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = () => api.staffLeads().then(setRows).catch(e => setErr(e.message));
  useEffect(() => { load(); api.staffTeam().then(setTeam).catch(() => {}); }, []);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2600); };

  const officers = useMemo(() => team.filter(m => ['loan_officer', 'admin', 'super_admin', 'processor'].includes(m.role)), [team]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const term = q.trim().toLowerCase();
    return rows.filter(l => {
      if (scope === 'open' && !OPEN_STAGES.includes(l.status)) return false;
      if (stageF && l.status !== stageF) return false;
      if (ownerF === 'me' && !(actor && l.officer_id === actor.id)) return false;
      if (ownerF === 'unassigned' && l.officer_id) return false;
      if (ownerF && ownerF !== 'me' && ownerF !== 'unassigned' && l.officer_id !== ownerF) return false;
      if (sourceF && effSource(l) !== sourceF) return false;
      if (term) {
        const hay = [leadName(l), l.company, l.email, l.phone, l.referral_partner].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [rows, q, stageF, ownerF, sourceF, scope, actor]);

  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (rows == null) return <div className="panel pad muted">Loading leads…</div>;

  const cnt = (fn) => rows.filter(fn).length;
  const newCount = cnt(l => l.status === 'new');
  const workingCount = cnt(l => ['contacted', 'qualified', 'quoted', 'working'].includes(l.status));
  const dueCount = cnt(dueSoon);
  const wonCount = cnt(l => l.status === 'converted');
  const pipelineValue = rows.filter(l => OPEN_STAGES.includes(l.status)).reduce((s, l) => s + (Number(l.loan_amount) || 0), 0);

  const sources = [...new Set(rows.map(effSource).filter(Boolean))];

  async function quickStage(l, status) {
    try { await api.staffUpdateLead(l.id, { status }); await load(); flash(`Moved to ${STAGE_LABEL[status]}`); }
    catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="sub">Your lead desk — capture, qualify, and work every opportunity to a live file.</div>
        </div>
        <div className="page-head-actions">
          <div className="seg" role="tablist">
            <button className={`tab ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')}>Board</button>
            <button className={`tab ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}>List</button>
          </div>
          <button className="btn btn-line btn-sm" onClick={() => setInviteOpen(true)}
            title="Invite anyone by email to the borrower portal — they're auto-assigned to you and opened as a lead">Invite to portal ✉</button>
          <button className="btn btn-gold btn-sm" onClick={() => setAddOpen(true)}>+ Add lead</button>
        </div>
      </div>

      {msg && <div className="notice ok" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="stack">
        <div className="kpi-grid">
          <div className="kpi"><div className="v">{newCount}</div><div className="k">New</div><div className="d">Awaiting first touch</div></div>
          <div className="kpi"><div className="v">{workingCount}</div><div className="k">Working</div><div className="d">Contacted → in progress</div></div>
          <div className="kpi"><div className="v">{dueCount}</div><div className="k">Follow-up due</div><div className="d">On/past their date</div></div>
          <div className="kpi"><div className="v">{money(pipelineValue) || '$0'}</div><div className="k">Open pipeline</div><div className="d">Est. loan value</div></div>
        </div>

        {/* Filters */}
        <div className="row lead-filters" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ flex: '1 1 260px', minWidth: 200, maxWidth: 380 }} type="search"
            placeholder="Search name, company, email, phone…" value={q} onChange={e => setQ(e.target.value)} />
          <select className="input flt-sm" style={{ width: 150 }} value={stageF} onChange={e => setStageF(e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select className="input flt-sm" style={{ width: 160 }} value={ownerF} onChange={e => setOwnerF(e.target.value)}>
            <option value="">All owners</option>
            <option value="me">My leads</option>
            <option value="unassigned">Unassigned</option>
            {seesAll && officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
          </select>
          {sources.length > 1 && (
            <select className="input flt-sm" style={{ width: 150 }} value={sourceF} onChange={e => setSourceF(e.target.value)}>
              <option value="">All sources</option>
              {sources.map(s => <option key={s} value={s}>{TOOL_LABEL[s] || s}</option>)}
            </select>
          )}
          <label className="row small" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={scope === 'all'} onChange={e => setScope(e.target.checked ? 'all' : 'open')} />
            Include closed
          </label>
          <span className="muted small">{shown.length} shown</span>
          {/* #153: one-click cleanup of a spam wave — archive every open lead
              from the selected source (admin only; the source filter must be
              chosen so it can never sweep the whole desk). */}
          {sourceF && ['admin', 'super_admin'].includes(actor?.role) && (
            <button className="btn ghost small" onClick={async () => {
              const label = TOOL_LABEL[sourceF] || sourceF;
              if (!window.confirm(`Archive ALL open "${label}" leads? Converted leads are never touched.`)) return;
              try {
                const key = TOOL_LABEL[sourceF] ? { tool: sourceF } : { source: sourceF };
                const r = await api.staffLeadsBulkArchive(key);
                await load(); flash(`Archived ${r.archived} ${label} lead${r.archived === 1 ? '' : 's'}.`);
              } catch (e2) { setErr(e2.message || 'Bulk archive failed'); }
            }}>Archive all “{TOOL_LABEL[sourceF] || sourceF}”</button>
          )}
        </div>

        {view === 'board'
          ? <LeadBoard leads={shown} onOpen={(l) => nav(`/internal/leads/${l.id}`)} onStage={quickStage} actor={actor} />
          : <LeadList leads={shown} onOpen={(l) => nav(`/internal/leads/${l.id}`)} actor={actor} />}
      </div>

      {addOpen && <AddLeadModal officers={officers} seesAll={seesAll}
        onClose={() => setAddOpen(false)}
        onCreated={(leadId) => { setAddOpen(false); nav(`/internal/leads/${leadId}`); }} onErr={setErr} />}

      {inviteOpen && <InviteToPortalModal officers={officers} seesAll={seesAll}
        onClose={() => setInviteOpen(false)}
        onDone={(r) => { setInviteOpen(false); load(); flash(r && r.leadId ? 'Invite sent — lead opened.' : 'Invite sent.'); }} onErr={setErr} />}
    </>
  );
}

// ---- Kanban board ----------------------------------------------------------
function LeadBoard({ leads, onOpen, onStage, actor }) {
  const byStage = (key) => leads.filter(l => l.status === key);
  return (
    <div className="lead-board">
      {BOARD_STAGES.map(s => {
        const col = byStage(s.key);
        const val = col.reduce((a, l) => a + (Number(l.loan_amount) || 0), 0);
        return (
          <div key={s.key} className="lead-col">
            <div className="lead-col-h">
              <span className={`pill ${STAGE_PILL[s.key]}`}>{s.label}</span>
              <span className="lead-col-ct">{col.length}{val > 0 ? ` · ${money(val)}` : ''}</span>
            </div>
            <div className="lead-col-body">
              {col.length === 0
                ? <div className="lead-col-empty">—</div>
                : col.map(l => <LeadCard key={l.id} l={l} onOpen={onOpen} onStage={onStage} actor={actor} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LeadCard({ l, onOpen, onStage, actor }) {
  const mine = l.officer_id && actor && l.officer_id === actor.id;
  return (
    <div className="lead-card" role="button" tabIndex={0}
      onClick={() => onOpen(l)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(l))}>
      <div className="lead-card-top">
        <span className="lead-card-name">{leadName(l)}</span>
        {Number(l.loan_amount) > 0 && <span className="lead-card-amt">{money(l.loan_amount)}</span>}
      </div>
      {l.company && <div className="lead-card-sub">{l.company}</div>}
      <div className="lead-card-meta">
        {l.program && <span className="tagm">{l.program}</span>}
        {effSource(l) && <span className="tagm mut">{TOOL_LABEL[effSource(l)] || effSource(l)}</span>}
      </div>
      <div className="lead-card-foot">
        <span className="lead-card-owner">
          {l.officer_name ? <><span className="mono">{initials(l.officer_name)}</span>{mine ? 'You' : l.officer_name}</> : <span className="muted">Loan desk</span>}
        </span>
        <span className="lead-card-flags">
          {l.open_tasks > 0 && <span className="flagm" title="Open tasks">◷ {l.open_tasks}</span>}
          {dueSoon(l) && <span className="flagm due" title="Follow-up due">● due</span>}
        </span>
      </div>
    </div>
  );
}

// ---- List view -------------------------------------------------------------
function LeadList({ leads, onOpen, actor }) {
  if (leads.length === 0) return (
    <div className="panel"><div className="panel-b"><div className="empty-state"><h3>No leads here</h3><p>Add a lead or adjust your filters.</p></div></div></div>
  );
  return (
    <div className="panel">
      <div className="tbl-scroll">
        <table className="tbl lead-tbl">
          <thead>
            <tr><th>Name</th><th>Source</th><th>Stage</th><th>Owner</th><th className="num">Est. amount</th><th>Follow-up</th><th>Tasks</th></tr>
          </thead>
          <tbody>
            {leads.map(l => {
              const mine = l.officer_id && actor && l.officer_id === actor.id;
              return (
                <tr key={l.id} className="lead-row" onClick={() => onOpen(l)}>
                  <td className="cell-deal">
                    <span className="who"><span className="mono">{initials(leadName(l))}</span><span className="lead">{leadName(l)}</span></span>
                    {l.company && <div className="mut">{l.company}</div>}
                  </td>
                  <td className="mut">{TOOL_LABEL[effSource(l)] || effSource(l) || '—'}</td>
                  <td><span className={`pill ${STAGE_PILL[l.status] || 'mut'}`}>{STAGE_LABEL[l.status] || l.status}</span></td>
                  <td>{l.officer_name
                    ? <span className="off"><span className="mono">{initials(l.officer_name)}</span>{mine ? 'You' : l.officer_name}</span>
                    : <span className="off un"><span className="dot" />Loan desk</span>}</td>
                  <td className="num">{money(l.loan_amount) || '—'}</td>
                  <td className="mut" style={dueSoon(l) ? { color: 'var(--warning,#b8860b)', fontWeight: 600 } : undefined}>
                    {l.next_follow_up ? fmtDay(l.next_follow_up) : '—'}</td>
                  <td className="mut">{l.open_tasks > 0 ? `${l.open_tasks} open` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Add-lead modal --------------------------------------------------------
function AddLeadModal({ officers, seesAll, onClose, onCreated, onErr }) {
  const [f, setF] = useState({ firstName: '', lastName: '', company: '', email: '', phone: '', leadSource: 'referral', referralPartner: '', program: '', loanAmount: '', officerId: '' });
  const [busy, setBusy] = useState(false);
  const [autoState, setAutoState] = useState('');   // '', 'saving', 'saved'
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  // Build the field payload once, shared by the auto-save and the final submit.
  const payload = (s) => ({
    firstName: s.firstName, lastName: s.lastName, company: s.company, email: s.email, phone: s.phone,
    leadSource: s.leadSource, referralPartner: s.referralPartner, program: s.program,
    loanAmount: s.loanAmount === '' ? undefined : Number(s.loanAmount),
    officerId: seesAll ? (s.officerId || undefined) : undefined,
  });
  const meaningful = (s) => !!(s.firstName.trim() || s.email.trim() || s.phone.trim());

  // Draft AUTO-SAVE (owner-directed 2026-07-14). Anything typed is saved as you
  // go so a partial lead is never lost — but WITHOUT the "new record per
  // keystroke" bug: the draft is CREATED exactly ONCE and every later change
  // (and the final "Add lead" click) PATCHes that SAME row.
  //
  // The create-once guarantee is a single shared PROMISE: `ensureDraft()` starts
  // the POST at most once and hands the SAME promise to every caller — the
  // debounced auto-save AND the "Add lead" button. So even if the user clicks
  // "Add lead" while the auto-save's create is still in flight, both await the
  // one POST and then PATCH the one row — a second lead can never be created.
  const draftId = useRef(null);
  const draftPromise = useRef(null);
  const lastSaved = useRef('');
  const ensureDraft = () => {
    if (draftId.current) return Promise.resolve(draftId.current);
    if (!draftPromise.current) {
      draftPromise.current = api.staffCreateLead(payload(f))
        .then((r) => { draftId.current = r.leadId; return r.leadId; })
        .catch((e) => { draftPromise.current = null; throw e; });   // allow a retry on failure
    }
    return draftPromise.current;
  };
  useEffect(() => {
    if (busy) return undefined;                       // final submit in progress
    if (!meaningful(f)) return undefined;             // nothing worth saving yet
    const snapshot = JSON.stringify(f);
    if (snapshot === lastSaved.current) return undefined;   // no real change
    const t = setTimeout(async () => {
      try {
        setAutoState('saving');
        const id = await ensureDraft();               // create-once (shared promise)
        await api.staffUpdateLead(id, payload(f));     // sync the latest values to the one row
        lastSaved.current = snapshot;
        setAutoState('saved');
      } catch (_) { setAutoState(''); /* a later change retries */ }
    }, 800);   // debounce — never per-keystroke
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, busy]);

  async function create() {
    if (busy) return;
    if (!meaningful(f)) return onErr('Enter at least a name, email, or phone.');
    setBusy(true);
    try {
      // Finalize the ONE draft (creating it if the auto-save hasn't yet, or
      // joining its in-flight create) — never a second lead.
      const id = await ensureDraft();
      await api.staffUpdateLead(id, payload(f));
      onCreated(id);
    } catch (e) { onErr(e.message || 'Could not add lead'); setBusy(false); }
  }
  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal lead-convert" onClick={e => e.stopPropagation()} role="dialog" aria-label="Add a lead">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Add a lead</h3>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">Close ✕</button>
        </div>
        <div className="lead-form">
          <div className="grid cols-2">
            <label className="field"><span>First name</span><input className="input" autoFocus value={f.firstName} onChange={e => set('firstName', e.target.value)} /></label>
            <label className="field"><span>Last name</span><input className="input" value={f.lastName} onChange={e => set('lastName', e.target.value)} /></label>
          </div>
          <label className="field"><span>Company / entity</span><input className="input" value={f.company} onChange={e => set('company', e.target.value)} placeholder="Acme Holdings LLC" /></label>
          <div className="grid cols-2">
            <label className="field"><span>Email</span><EmailInput value={f.email} onChange={v => set('email', v)} /></label>
            <label className="field"><span>Phone</span><PhoneInput value={f.phone} onChange={v => set('phone', v)} /></label>
          </div>
          <div className="grid cols-2">
            <label className="field"><span>Source</span>
              <select className="input" value={f.leadSource} onChange={e => set('leadSource', e.target.value)}>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>Referral partner</span><input className="input" value={f.referralPartner} onChange={e => set('referralPartner', e.target.value)} /></label>
          </div>
          <div className="grid cols-2">
            <label className="field"><span>Program of interest</span>
              <select className="input" value={f.program} onChange={e => set('program', e.target.value)}>
                <option value="">—</option>
                {PROGRAMS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="field"><span>Est. loan amount</span><input className="input" type="number" min="0" inputMode="numeric" value={f.loanAmount} onChange={e => set('loanAmount', e.target.value)} placeholder="325000" /></label>
          </div>
          {seesAll && officers.length > 0 && (
            <label className="field"><span>Assign to</span>
              <select className="input" value={f.officerId} onChange={e => set('officerId', e.target.value)}>
                <option value="">Loan desk (unassigned)</option>
                {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <span className="muted small" aria-live="polite" style={{ marginRight: 'auto' }}>
            {autoState === 'saving' ? 'Saving draft…' : autoState === 'saved' ? 'Draft saved ✓' : 'Autosaves as you type'}
          </span>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-gold" disabled={busy} onClick={create}>{busy ? 'Adding…' : 'Add lead'}</button>
        </div>
      </div>
    </div>
  );
}

// #102: invite ANY email to the borrower portal. The person becomes a borrower
// profile auto-assigned to the inviting loan officer (owning officer of record),
// an invite email goes out, and a CRM lead is opened for the officer.
function InviteToPortalModal({ officers, seesAll, onClose, onDone, onErr }) {
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', phone: '', officerId: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  async function send() {
    if (!emailOk) return;
    setBusy(true);
    try {
      const body = { email: f.email.trim(), firstName: f.firstName.trim(), lastName: f.lastName.trim(), phone: f.phone.trim() };
      if (seesAll && f.officerId) body.officerId = f.officerId;
      const r = await api.staffInviteToPortal(body);
      onDone(r);
    } catch (e) { if (onErr) onErr(e.message || 'Could not send the invite.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invite to portal">
        <h3 style={{ marginTop: 0 }}>Invite to portal</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          They get a portal invite and are auto-assigned to {seesAll && f.officerId ? 'the chosen officer' : 'you'} as their loan officer, with a lead opened in the CRM.
        </p>
        <div className="field"><label>Email</label>
          <EmailInput autoComplete="off" value={f.email} onChange={v => set('email')({ target: { value: v } })} placeholder="them@example.com" /></div>
        <div className="grid cols-2">
          <div className="field"><label>First name <span className="muted small">(optional)</span></label>
            <input className="input" value={f.firstName} onChange={set('firstName')} /></div>
          <div className="field"><label>Last name <span className="muted small">(optional)</span></label>
            <input className="input" value={f.lastName} onChange={set('lastName')} /></div>
        </div>
        <div className="field"><label>Phone <span className="muted small">(optional)</span></label>
          <PhoneInput value={f.phone} onChange={v => setF(p => ({ ...p, phone: v }))} /></div>
        {seesAll && (
          <div className="field"><label>Assign to officer</label>
            <select className="input" value={f.officerId} onChange={set('officerId')}>
              <option value="">Me</option>
              {officers.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select></div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" disabled={busy || !emailOk} onClick={send}>{busy ? 'Sending…' : 'Send invite'}</button>
        </div>
      </div>
    </div>
  );
}
