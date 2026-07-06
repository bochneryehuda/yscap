import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
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
const blank = () => ({ contactType: 'title_company', companyName: '', contactName: '', email: '', phone: '', address: '', notes: '' });

function VendorForm({ initial, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial);
  return (
    <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
      <div className="grid cols-3">
        <div className="field"><label>Type</label>
          <select value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
            {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select></div>
        <div className="field"><label>Company / agency</label>
          <input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
        <div className="field"><label>Contact name</label>
          <input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
        <div className="field"><label>Email</label>
          <input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label>Phone</label>
          <input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
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
  const { role } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [rows, setRows] = useState(null);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);   // vendor id being edited
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api.staffVendors(type).then(setRows).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type]);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  async function add(f) {
    setBusy(true); setErr('');
    try { await api.staffAddVendor(f); setAdding(false); flash('Vendor added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); }
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

  if (!isAdmin) return <div className="notice err">The vendor directory is admin-only.</div>;
  const needle = q.trim().toLowerCase();
  const shown = (rows || []).filter(v => !needle
    || [v.company_name, v.contact_name, v.email, v.phone].some(x => String(x || '').toLowerCase().includes(needle)));

  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1>Vendor contacts</h1>
          <p className="muted small">Every title company and insurance agent entered across the platform — curate them here.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => { setAdding(a => !a); setEditing(null); }}>{adding ? 'Close' : '+ Add vendor'}</button>
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div className="notice err">{err}</div>}
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
        {rows == null ? <p className="muted small">Loading…</p>
          : shown.length === 0 ? <p className="muted small">No vendors match.</p>
          : shown.map(v => (
            <div key={v.id}>
              <div className="checkitem" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span className="pill" style={{ minWidth: 120, textAlign: 'center' }}>{TYPE_LABEL[v.contact_type] || v.contact_type}</span>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>{v.company_name || v.contact_name || v.email || '—'}</div>
                  <div className="muted small">
                    {[v.contact_name && v.company_name ? v.contact_name : null, v.email, v.phone, v.address].filter(Boolean).join(' · ') || 'No contact details yet'}
                  </div>
                  <div className="muted small">
                    Added by {v.added_by_staff ? `${v.added_by_staff} (staff)` : v.added_by_borrower ? `${v.added_by_borrower} (borrower)` : '—'}
                    {v.files_used ? ` · used on ${v.files_used} file${v.files_used === 1 ? '' : 's'}` : ''}
                    {v.notes ? ` · ${v.notes}` : ''}
                  </div>
                </div>
                <button className="btn ghost small" onClick={() => { setEditing(editing === v.id ? null : v.id); setAdding(false); }}>
                  {editing === v.id ? 'Close' : 'Edit'}
                </button>
                <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} onClick={() => del(v)}>Delete</button>
              </div>
              {editing === v.id && (
                <VendorForm busy={busy}
                  initial={{ contactType: v.contact_type, companyName: v.company_name || '', contactName: v.contact_name || '', email: v.email || '', phone: v.phone || '', address: v.address || '', notes: v.notes || '' }}
                  onSave={(f) => saveEdit(v.id, f)} onCancel={() => setEditing(null)} />
              )}
            </div>
          ))}
      </div>
    </>
  );
}
