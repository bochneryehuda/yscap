import React, { useEffect, useState } from 'react';
import { PhoneInput } from './FormattedInputs.jsx';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';

/* General file contacts (#144). Any party can add any kind of vendor to a file;
   every contact flows into the company-wide vendor directory and is shared with
   everyone on the file. Works on the borrower side and the staff side (isStaff).
   Contact TYPES cover the real-estate transaction; "Other" takes a free-text
   label. Minimal requirement to add: any one detail. */

const TYPES = [
  ['realtor', 'Realtor / agent'],
  ['attorney', 'Attorney'],
  ['title_company', 'Title company'],
  ['insurance_agent', 'Insurance company'],
  ['flood_insurance', 'Flood insurance'],
  ['contractor', 'Contractor'],
  ['appraiser', 'Appraiser'],
  ['lender', 'Lender'],
  ['escrow', 'Escrow'],
  ['other', 'Other'],
];
const LABEL = Object.fromEntries(TYPES);
export function contactTypeLabel(c) {
  if (c.contact_type === 'other') return (c.custom_type || 'Other');
  return LABEL[c.contact_type] || c.contact_type;
}

const BLANK = { contactType: 'realtor', customType: '', companyName: '', contactName: '', email: '', phone: '', notes: '' };

export default function FileContacts({ appId, isStaff, heading = 'File contacts' }) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => (isStaff ? api.staffFileContacts(appId) : api.fileContacts(appId)).then(setList).catch(() => setList([]));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId, isStaff]);

  const gate = useSubmitGate();
  async function add() {
    setErr('');
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail (company, name, email or phone).'); return; }
    if (!gate.enter()) return;             // a contact is already being added
    setBusy(true);
    try {
      await (isStaff ? api.staffAddFileContact(appId, f) : api.addFileContact(appId, f));
      setF(BLANK); setAdding(false); await load();
    } catch (e) { setErr((e && e.message) || 'Could not add the contact.'); }
    finally { setBusy(false); gate.leave(); }
  }
  async function remove(linkId) {
    if (!window.confirm('Remove this contact from the file? (It stays in the company vendor directory.)')) return;
    try { await (isStaff ? api.staffDelFileContact(linkId) : api.delFileContact(linkId)); await load(); } catch (_) { /* ignore */ }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{heading}</h3>
        <div className="spacer" />
        {!adding && <button className="btn ghost small" onClick={() => { setF(BLANK); setErr(''); setAdding(true); }}>+ Add contact</button>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Realtors, attorneys, title, insurance, flood, contractors and anyone else on this deal. Everyone on the file sees them, and they're saved to the company vendor directory.
      </p>

      {adding && (
        <div className="panel" style={{ background: 'var(--surface-soft, var(--ink-2))', marginBottom: 12 }}>
          <div className="grid cols-2" style={{ gap: 8 }}>
            <div>
              <label className="muted small">Type</label>
              <select className="input" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {f.contactType === 'other' && (
              <div>
                <label className="muted small">What kind?</label>
                <input className="input" placeholder="e.g. Surveyor" value={f.customType} onChange={e => setF({ ...f, customType: e.target.value })} />
              </div>
            )}
            <div><label className="muted small">Company</label><input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
            <div><label className="muted small">Contact name</label><input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
            <div><label className="muted small">Email</label><input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
            <div><label className="muted small">Phone</label><PhoneInput value={f.phone} onChange={v => setF({ ...f, phone: v })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label className="muted small">Notes</label><input className="input" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
          </div>
          {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary small" disabled={busy} onClick={add}>{busy ? 'Saving…' : 'Save contact'}</button>
            <button className="btn ghost small" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {list == null ? <p className="muted small">Loading…</p>
        : list.length === 0 ? <p className="muted small">No contacts on this file yet.</p>
        : (
          <div style={{ display: 'grid', gap: 6 }}>
            {list.map(c => (
              <div key={c.link_id} className="checkitem" style={{ alignItems: 'center' }}>
                <span className="pill" style={{ marginRight: 8 }}>{contactTypeLabel(c)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.company_name || c.contact_name || c.email || '—'}</div>
                  <div className="muted small" style={{ wordBreak: 'break-word' }}>
                    {[c.contact_name && c.company_name ? c.contact_name : '', c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                    {c.notes ? ` — ${c.notes}` : ''}
                  </div>
                </div>
                <button className="btn ghost small" title="Remove from this file" onClick={() => remove(c.link_id)}>Remove</button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

/* A read-only vendor list for a borrower profile — every vendor the borrower is
   dealing with, across all their files. */
export function BorrowerContacts({ borrowerId, isStaff }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    (isStaff ? api.staffBorrowerContacts(borrowerId) : api.myContacts()).then(setList).catch(() => setList([]));
  }, [borrowerId, isStaff]);
  if (list == null) return <p className="muted small">Loading contacts…</p>;
  if (!list.length) return <p className="muted small">No vendors on record yet.</p>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {list.map(c => (
        <div key={c.id} className="checkitem" style={{ alignItems: 'center' }}>
          <span className="pill" style={{ marginRight: 8 }}>{contactTypeLabel(c)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{c.company_name || c.contact_name || c.email || '—'}</div>
            <div className="muted small">{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</div>
          </div>
          {c.files_used > 0 && <span className="muted small">{c.files_used} file{c.files_used === 1 ? '' : 's'}</span>}
        </div>
      ))}
    </div>
  );
}
