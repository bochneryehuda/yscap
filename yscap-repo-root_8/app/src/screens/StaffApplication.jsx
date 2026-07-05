import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const kb = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const STATUSES = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
const APP_STATUSES = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'declined', 'withdrawn'];
const APP_STATUS_LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
const PHASE_LABEL = {
  p1_intake: 'Phase 1 · Borrower Intake', p2_setup: 'Phase 2 · File Setup',
  p3_verify: 'Phase 3 · Verifications', p4_appraisal: 'Phase 4 · Appraisal & Numbers',
  p5_closing: 'Phase 5 · Closing Prep',
};
const phaseName = (p) => PHASE_LABEL[p] || (p ? p.replace(/_/g, ' ') : 'General');

function Badge({ children, tone }) {
  return <span className="pill" style={tone === 'gold' ? { borderColor: 'var(--gold)', color: 'var(--gold)' } : undefined}>{children}</span>;
}

function Item({ it, team, onPatch }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(it.notes || '');
  const signed = !!it.signed_off_at;
  return (
    <div className="checkitem" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
        <span className={`dot ${signed || it.status === 'satisfied' ? 'done' : 'outstanding'}`} style={{ marginTop: 4 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{it.label}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <Badge>{it.audience}</Badge>
            {it.role_scope && <Badge>{it.role_scope}</Badge>}
            <Badge>{it.item_kind}</Badge>
            {it.is_gate && <Badge tone="gold">gate</Badge>}
            {it.is_milestone && <Badge tone="gold">milestone</Badge>}
            {it.tool_key && <Badge tone="gold">{it.tool_submitted ? 'borrower submitted' : 'borrower task'}</Badge>}
          </div>
          {it.hint && <div className="muted small" style={{ marginTop: 4 }}>{it.hint}</div>}
          {it.assignee_name && <div className="muted small">Assigned to {it.assignee_name}</div>}
          {signed && <div className="muted small">Signed off by {it.signed_off_name || 'staff'} · {new Date(it.signed_off_at).toLocaleDateString()}</div>}
          {it.tool_key && it.tool_submitted && (
            <button className="btn link small" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'View'} submission</button>
          )}
          {open && it.tool_payload && (
            <pre className="panel small" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
              {JSON.stringify(it.tool_payload, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="row" style={{ width: '100%', gap: 8, flexWrap: 'wrap' }}>
        <select className="input" style={{ maxWidth: 150 }} value={it.status}
          onChange={e => onPatch(it.id, { status: e.target.value })}>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 180 }} value={it.assignee_staff_id || ''}
          onChange={e => onPatch(it.id, { assigneeStaffId: e.target.value || null })}>
          <option value="">Unassigned</option>
          {team.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
        </select>
        {signed
          ? <button className="btn ghost" onClick={() => onPatch(it.id, { signedOff: false })}>Undo sign-off</button>
          : <button className="btn primary" onClick={() => onPatch(it.id, { signedOff: true })}>Sign off</button>}
      </div>
      <div className="row" style={{ width: '100%', gap: 8 }}>
        <input className="input" placeholder="Add a note…" value={notes} onChange={e => setNotes(e.target.value)} />
        <button className="btn ghost" onClick={() => onPatch(it.id, { notes })}>Save note</button>
      </div>
    </div>
  );
}

export default function StaffApplication() {
  const { id } = useParams();
  const [app, setApp] = useState(null);
  const [items, setItems] = useState([]);
  const [docs, setDocs] = useState([]);
  const [dlBusy, setDlBusy] = useState(null);
  const [borrower, setBorrower] = useState(null);
  const [team, setTeam] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [lo, setLo] = useState('');
  const [proc, setProc] = useState('');
  const [newDoc, setNewDoc] = useState('');
  const [newCond, setNewCond] = useState('');
  const [ssnFull, setSsnFull] = useState('');
  const [ssnBusy, setSsnBusy] = useState(false);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2600); };

  async function load() {
    setSsnFull('');
    try {
      const a = await api.staffApplication(id);
      setApp(a);
      const [c, t, d] = await Promise.all([api.staffChecklist(id), api.staffTeam(), api.staffAppDocuments(id).catch(() => [])]);
      setItems(c || []); setTeam(t || []); setDocs(d || []);
      if (a.borrower_id) api.staffBorrower(a.borrower_id).then(setBorrower).catch(() => {});
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function revealSsn() {
    if (ssnFull) { setSsnFull(''); return; }        // toggle back to masked
    if (!app?.borrower_id) return;
    setSsnBusy(true);
    try { const r = await api.staffBorrowerSsn(app.borrower_id); setSsnFull(r.ssn || ''); }
    catch (e) { setErr(e.message || 'Could not reveal SSN'); }
    finally { setSsnBusy(false); }
  }

  async function patch(itemId, body) {
    try { await api.staffPatchItem(itemId, body); flash('Saved ✓'); await load(); }
    catch (e) { setErr(e.message || 'Update failed'); }
  }
  async function downloadDoc(doc) {
    setDlBusy(doc.id);
    try { const { blob, filename } = await api.staffDownloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }
  async function changeStatus(status) {
    try { await api.staffSetStatus(id, status); flash(`Status → ${APP_STATUS_LABEL[status] || status}. Borrower & team notified.`); await load(); }
    catch (e) { setErr(e.message || 'Could not update status'); }
  }
  async function assign() {
    if (!lo && !proc) return;
    try {
      await api.staffAssign(id, { loanOfficerId: lo || undefined, processorId: proc || undefined });
      setLo(''); setProc(''); flash('Assigned ✓'); await load();
    } catch (e) { setErr(e.message || 'Assign failed'); }
  }
  async function requestDoc() {
    if (!newDoc.trim()) return;
    try { await api.staffRequestDoc(id, { label: newDoc.trim(), audience: 'borrower' }); setNewDoc(''); flash('Requested ✓'); await load(); }
    catch (e) { setErr(e.message || 'Failed'); }
  }
  async function addCondition() {
    if (!newCond.trim()) return;
    try { await api.staffAddCondition(id, { label: newCond.trim(), audience: 'staff' }); setNewCond(''); flash('Added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Failed'); }
  }

  const phases = useMemo(() => {
    const groups = {};
    for (const it of items) { const k = it.phase || 'general'; (groups[k] = groups[k] || []).push(it); }
    return Object.entries(groups)
      .map(([k, arr]) => [k, arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))])
      .sort((a, b) => (a[1][0].sort_order || 0) - (b[1][0].sort_order || 0));
  }, [items]);

  if (err && !app) return <div className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;
  const processors = team.filter(m => m.role === 'processor');
  const officers = team.filter(m => ['loan_officer', 'admin', 'super_admin'].includes(m.role));
  const procName = (team.find(m => m.id === app.processor_id) || {}).full_name;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/staff" className="btn link">← Pipeline</Link>
        <div className="spacer" />
        <span className={`pill ${app.status}`}>{app.status}</span>
      </div>
      <h1 style={{ marginBottom: 4 }}>{app.first_name} {app.last_name} · {addrLine(app.property_address)}</h1>
      <p className="muted small" style={{ marginBottom: 12 }}>{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}</p>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <span className="muted small">Advance status</span>
        <select className="input" style={{ maxWidth: 190 }} value={app.status} onChange={e => changeStatus(e.target.value)}>
          {APP_STATUSES.map(s => <option key={s} value={s}>{APP_STATUS_LABEL[s]}</option>)}
        </select>
        <span className="muted small">Notifies the borrower &amp; assigned team.</span>
      </div>

      {msg && <div className="notice ok">{msg}</div>}
      {err && app && <div className="notice err">{err}</div>}

      <div className="grid cols-2">
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Borrower</h3>
          {borrower ? <>
            <div className="metrow"><span className="k">Name</span><span className="v">{borrower.first_name} {borrower.last_name}</span></div>
            <div className="metrow"><span className="k">Email</span><span className="v">{borrower.email || '—'}</span></div>
            <div className="metrow"><span className="k">Phone</span><span className="v">{borrower.cell_phone || '—'}</span></div>
            <div className="metrow"><span className="k">FICO</span><span className="v">{borrower.fico || '—'}</span></div>
            <div className="metrow"><span className="k">Citizenship</span><span className="v">{borrower.citizenship || '—'}</span></div>
            <div className="metrow"><span className="k">Tier</span><span className="v">{borrower.tier || '—'}</span></div>
            <div className="metrow"><span className="k">SSN</span>
              <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }}>
                  {ssnFull || (borrower.ssn_last4 ? `•••-••-${borrower.ssn_last4}` : '—')}
                </span>
                {borrower.ssn_last4 && (
                  <button className="btn link small" onClick={revealSsn} disabled={ssnBusy}
                    title={ssnFull ? 'Hide the full number' : 'Show the full number'}>
                    {ssnFull ? 'Hide' : (ssnBusy ? '…' : 'Show')}
                  </button>
                )}
              </span>
            </div>
          </> : <p className="muted small">Loading borrower…</p>}
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Loan & assignment</h3>
          <div className="metrow"><span className="k">Purchase</span><span className="v">{money(app.purchase_price)}</span></div>
          <div className="metrow"><span className="k">As-is</span><span className="v">{money(app.as_is_value)}</span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(app.loan_amount)}</span></div>
          <div className="metrow"><span className="k">Loan officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}</span></div>
          <div className="metrow"><span className="k">Processor</span><span className="v">{procName || '—'}</span></div>
          <div className="gold-rule" style={{ margin: '10px 0' }} />
          <div className="field"><label>Assign loan officer</label>
            <select className="input" value={lo} onChange={e => setLo(e.target.value)}>
              <option value="">— select —</option>
              {officers.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
            </select></div>
          <div className="field"><label>Assign processor</label>
            <select className="input" value={proc} onChange={e => setProc(e.target.value)}>
              <option value="">— select —</option>
              {processors.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select></div>
          <button className="btn primary" onClick={assign} disabled={!lo && !proc}>Assign</button>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Checklist</h3>
          <div className="spacer" />
          <span className="muted small">{items.filter(i => i.signed_off_at).length}/{items.length} signed off</span>
        </div>
        {phases.length === 0
          ? <p className="muted small">No checklist items yet.</p>
          : phases.map(([k, arr]) => (
            <div key={k} style={{ marginTop: 10 }}>
              <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{phaseName(k)}</div>
              {arr.map(it => <Item key={it.id} it={it} team={team} onPatch={patch} />)}
            </div>
          ))}
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Documents</h3>
          <div className="spacer" />
          <span className="muted small">{docs.length} uploaded</span>
        </div>
        {docs.length === 0
          ? <p className="muted small">No documents uploaded yet. Request one below and the borrower will see it on their checklist.</p>
          : docs.map(d => (
            <div className="checkitem" key={d.id}>
              <span className="dot done" />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{d.filename}</div>
                <div className="muted small">
                  {kb(d.size_bytes)} · uploaded by {d.uploaded_by_kind} · {new Date(d.created_at).toLocaleDateString()}
                </div>
              </div>
              <button className="btn ghost" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                {dlBusy === d.id ? 'Downloading…' : 'Download'}
              </button>
            </div>
          ))}
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="panel">
          <h3 style={{ marginBottom: 8 }}>Request a document (borrower)</h3>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" placeholder="e.g. Updated bank statement" value={newDoc}
              onChange={e => setNewDoc(e.target.value)} onKeyDown={e => e.key === 'Enter' && requestDoc()} />
            <button className="btn primary" onClick={requestDoc}>Request</button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>Appears on the borrower's checklist and notifies them.</p>
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 8 }}>Add an internal condition (staff)</h3>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" placeholder="e.g. Verify owner of record on REO #3" value={newCond}
              onChange={e => setNewCond(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCondition()} />
            <button className="btn primary" onClick={addCondition}>Add</button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>Staff-only — not shown to the borrower.</p>
        </div>
      </div>
    </>
  );
}
