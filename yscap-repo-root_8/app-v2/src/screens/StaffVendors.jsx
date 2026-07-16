import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { PhoneInput } from '../components/FormattedInputs.jsx';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { useAuth } from '../lib/auth.jsx';

/* Vendor directory (admin): every title company / insurance agent contact
   entered anywhere on the platform, tagged by type. Admins enrich, correct,
   or delete entries — borrowers then autocomplete against the clean records. */

const TYPES = [
  { v: 'title_company', label: 'Title company' },
  { v: 'insurance_agent', label: 'Insurance agent' },
  { v: 'attorney', label: 'Attorney' },
  { v: 'contractor', label: 'Contractor' },
  { v: 'other', label: 'Other' },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.v, t.label]));
// Presentational only: type→swatch colour class + monogram initials for the directory table.
const SWATCH = { title_company: 'sw-title', insurance_agent: 'sw-insurance', attorney: 'sw-attorney', contractor: 'sw-inspector', other: '' };
const initials = (s) => (String(s || '').trim().split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()) || '—';
const blank = () => ({ contactType: 'title_company', companyName: '', contactName: '', email: '', phone: '', address: '', notes: '' });

function VendorForm({ initial, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial);
  return (
    <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
      <div className="grid cols-3">
        <div className="field"><label>Type</label>
          <select className="input" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
            {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select></div>
        <div className="field"><label>Company / agency</label>
          <input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
        <div className="field"><label>Contact name</label>
          <input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
        <div className="field"><label>Email</label>
          <input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label>Phone</label>
          <PhoneInput value={f.phone} onChange={v => setF({ ...f, phone: v })} /></div>
        <div className="field"><label>Address</label>
          <input className="input" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes (internal)</label>
          <input className="input" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="e.g. preferred contact for Brooklyn closings" /></div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy} onClick={() => onSave(f)}>{busy ? 'Saving…' : 'Save vendor'}</button>
        <button className="btn link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function StaffVendors() {
  const { can } = useAuth();
  const isAdmin = can('manage_vendors');
  const [rows, setRows] = useState(null);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);   // vendor id being edited
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Last-request-wins: switching vendor types fast must never let a slow
  // earlier type's response overwrite the current one (vanishing-search class).
  const loadSeq = useRef(0);
  const load = () => {
    const mine = ++loadSeq.current;
    return api.staffVendors(type)
      .then(r => { if (mine === loadSeq.current) setRows(r); })
      .catch(e => { if (mine === loadSeq.current) setErr(e.message); });
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type]);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  const gate = useSubmitGate();
  async function add(f) {
    if (!gate.enter()) return;             // a vendor add is already in flight
    setBusy(true); setErr('');
    try { await api.staffAddVendor(f); setAdding(false); flash('Vendor added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); gate.leave(); }
  }
  async function saveEdit(id, f) {
    setBusy(true); setErr('');
    try { await api.staffUpdateVendor(id, f); setEditing(null); flash('Saved ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }
  async function del(v) {
    if (!window.confirm(`Delete this ${TYPE_LABEL[v.contact_type] || 'vendor'} (${v.company_name || v.contact_name || v.email})? Borrowers will no longer see it in autocomplete.`)) return;
    try { await api.staffDeleteVendor(v.id); flash('Deleted ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not delete'); }
  }

  // Directory KPIs — derived purely from the vendor rows the screen already holds
  // (each row carries contact_type + files_used). No new data is fetched.
  const stats = useMemo(() => {
    const list = rows || [];
    const by = (t) => list.filter(v => v.contact_type === t).length;
    return {
      total: list.length,
      title: by('title_company'),
      insurance: by('insurance_agent'),
      files: list.reduce((n, v) => n + (Number(v.files_used) || 0), 0),
    };
  }, [rows]);

  if (!isAdmin) return <div role="alert" className="notice err">The vendor directory is admin-only.</div>;
  const needle = q.trim().toLowerCase();
  const shown = (rows || []).filter(v => !needle
    || [v.company_name, v.contact_name, v.email, v.phone].some(x => String(x || '').toLowerCase().includes(needle)));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vendors</h1>
          <div className="sub">Every title company and insurance agent entered across the platform — curate them here.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-ink btn-sm" onClick={() => { setAdding(a => !a); setEditing(null); }}>{adding ? 'Close' : '+ Add vendor'}</button>
        </div>
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {rows != null && (
        <div className="kpi-grid" style={{ margin: '4px 0 14px' }}>
          <div className="kpi"><div className="v">{stats.total}</div><div className="k">Vendors</div><div className="d">In the directory</div></div>
          <div className="kpi"><div className="v">{stats.title}</div><div className="k">Title companies</div></div>
          <div className="kpi"><div className="v">{stats.insurance}</div><div className="k">Insurance agents</div></div>
          <div className="kpi"><div className="v">{stats.files}</div><div className="k">Files referenced</div><div className="d">Across all vendors</div></div>
        </div>
      )}

      {adding && <VendorForm initial={blank()} busy={busy} onSave={add} onCancel={() => setAdding(false)} />}

      <div className="row" style={{ gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
        <select className="input" style={{ maxWidth: 180 }} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search name / email / phone…" value={q} onChange={e => setQ(e.target.value)} />
        <span className="muted small" style={{ alignSelf: 'center' }}>{shown.length} vendor{shown.length === 1 ? '' : 's'}</span>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h3>Directory</h3>
          <span className="pill mut">{shown.length} of {rows ? rows.length : 0}</span>
        </div>
        {rows == null ? <div className="panel-b"><p className="muted small">Loading…</p></div>
          : shown.length === 0 ? <div className="empty-state"><h3>No vendors match</h3><p>Try a different type or search term, or add a new vendor.</p></div>
          : (
            <div className="tbl-wrap">
              <table className="tbl tbl-vendors">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Type</th>
                    <th>Contact</th>
                    <th>Phone</th>
                    <th className="num">Files</th>
                    <th>Added by</th>
                    <th className="actc"></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(v => (
                    <React.Fragment key={v.id}>
                      <tr>
                        <td data-label="Company">
                          <div className="co">
                            <span className="mono">{initials(v.company_name || v.contact_name || v.email)}</span>
                            <span>
                              <span className="nm">{v.company_name || v.contact_name || v.email || '—'}</span>
                              {v.notes && <span className="id">{v.notes}</span>}
                            </span>
                          </div>
                        </td>
                        <td data-label="Type"><span className="tchip"><span className={`sw ${SWATCH[v.contact_type] || ''}`} />{TYPE_LABEL[v.contact_type] || v.contact_type}</span></td>
                        <td data-label="Contact">
                          <span className="ct-nm">{v.contact_name || '—'}</span>
                          {v.email && <span className="ct-em">{v.email}</span>}
                        </td>
                        <td data-label="Phone"><span className="num">{v.phone || '—'}</span></td>
                        <td className="num files-c" data-label="Files">{v.files_used || 0}</td>
                        <td data-label="Added by"><span className="mut">{v.added_by_staff ? `${v.added_by_staff} (staff)` : v.added_by_borrower ? `${v.added_by_borrower} (borrower)` : '—'}</span></td>
                        <td className="actc" data-label="">
                          <button className="rowbtn" onClick={() => { setEditing(editing === v.id ? null : v.id); setAdding(false); }}>{editing === v.id ? 'Close' : 'Edit'}</button>
                          <button className="rowbtn danger" onClick={() => del(v)}>Delete</button>
                        </td>
                      </tr>
                      {editing === v.id && (
                        <tr className="editrow">
                          <td colSpan={7} data-label="">
                            <VendorForm busy={busy}
                              initial={{ contactType: v.contact_type, companyName: v.company_name || '', contactName: v.contact_name || '', email: v.email || '', phone: v.phone || '', address: v.address || '', notes: v.notes || '' }}
                              onSave={(f) => saveEdit(v.id, f)} onCancel={() => setEditing(null)} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </>
  );
}
