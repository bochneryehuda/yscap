import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm, showMessage } from '../lib/dialog.js';

// Broker title & insurance ordering. Borrower-safe: the note buyer is never shown, and
// when the note buyer is RCN the option reads "your loan team handles this" (never why).
// Flood is never here — it is not a broker order at all.

const KIND_LABEL = { title: 'Title', insurance: 'Insurance' };
const VENDOR_LABEL = { title: 'title company', insurance: 'insurance agent' };
const STATUS_LABEL = {
  not_ordered: 'Not ordered yet',
  ordered: 'Ordered — waiting on the vendor',
  documents_in: 'Documents received',
  completed: 'Complete',
  cancelled: 'Cancelled',
};

function StatusPill({ status }) {
  const done = status === 'completed';
  const active = status === 'ordered' || status === 'documents_in';
  const bg = done ? '#E8F1EC' : active ? '#FBF4E4' : '#EEF0F2';
  const fg = done ? '#1E5E3A' : active ? '#7A5A16' : '#4B585C';
  return (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function VendorForm({ appId, kind, onSaved }) {
  const [f, setF] = useState({ companyName: '', contactName: '', email: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function save() {
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail.'); return; }
    setErr(''); setSaving(true);
    try { await api.tpoSetOrderVendor(appId, kind, f); onSaved && onSaved(); }
    catch (e) { setErr(e?.message || 'Could not save the contact.'); }
    finally { setSaving(false); }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted small" style={{ marginBottom: 6, color: '#4B585C' }}>Add the {VENDOR_LABEL[kind]} for this file.</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <input className="input" placeholder="Company" value={f.companyName} onChange={set('companyName')} />
        <input className="input" placeholder="Contact name" value={f.contactName} onChange={set('contactName')} />
        <input className="input" placeholder="Email" value={f.email} onChange={set('email')} />
        <input className="input" placeholder="Phone" value={f.phone} onChange={set('phone')} />
      </div>
      {err && <div className="small" style={{ color: '#B23B3B', marginTop: 6 }}>{err}</div>}
      <button className="btn ghost small" style={{ marginTop: 8 }} disabled={saving} onClick={save}>
        {saving ? 'Saving…' : `Save ${VENDOR_LABEL[kind]}`}
      </button>
    </div>
  );
}

function OrderRow({ appId, o, reload }) {
  const [placing, setPlacing] = useState(false);
  const vendor = o.vendor;
  async function place() {
    const who = vendor && (vendor.company_name || vendor.contact_name || vendor.email);
    const ok = await askConfirm(`Send the ${VENDOR_LABEL[o.kind]} order${who ? ` to ${who}` : ''}? This emails the order request.`);
    if (!ok) return;
    setPlacing(true);
    try {
      const r = await api.tpoPlaceOrder(appId, o.kind);
      if (r && r.unconfirmed) await showMessage(r.warning || 'The order was sent, but the email provider did not confirm it — your loan team can check.');
      else await showMessage(`The ${VENDOR_LABEL[o.kind]} order was sent.`);
      reload && reload();
    } catch (e) {
      await showMessage(e?.message || 'Could not place the order.');
    } finally { setPlacing(false); }
  }
  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, color: '#141B22' }}>{KIND_LABEL[o.kind]}</div>
        <StatusPill status={o.status} />
      </div>

      {o.staffHandled ? (
        <div className="muted small" style={{ marginTop: 6, color: '#4B585C' }}>Your loan team places this order for this file.</div>
      ) : (
        <>
          {vendor && (
            <div className="small" style={{ marginTop: 6, color: '#3A4550' }}>
              {[vendor.company_name, vendor.contact_name, vendor.email, vendor.phone].filter(Boolean).join(' · ') || 'Contact on file'}
            </div>
          )}
          {(o.blockers || []).map((b) => (
            <div key={b.code} className="small" style={{ marginTop: 6, color: '#4B585C' }}>{b.text}</div>
          ))}
          {/* The broker can add the vendor when that's the blocker (or to replace it). */}
          {(!vendor || (o.blockers || []).some((b) => b.code === 'contact')) && (
            <VendorForm appId={appId} kind={o.kind} onSaved={reload} />
          )}
          {o.canOrder && (
            <button className="btn ghost small" style={{ marginTop: 10 }} disabled={placing} onClick={place}>
              {placing ? 'Sending…' : `Order ${VENDOR_LABEL[o.kind]}`}
            </button>
          )}
          {vendor && !o.canOrder && (o.status === 'not_ordered' || o.status === 'cancelled') && !(o.blockers || []).length && (
            <div className="muted small" style={{ marginTop: 8, color: '#4B585C' }}>Ready — your loan team is finishing the last step before this can be ordered.</div>
          )}
        </>
      )}
    </div>
  );
}

export default function TpoOrders({ appId }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.tpoOrders(appId).then((r) => setState(r)).catch((e) => setErr(e?.message || ''));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId]);
  if (err) return <div className="muted small" style={{ color: '#4B585C' }}>Orders aren’t available for this file yet.</div>;
  if (!state) return <div className="muted small" style={{ color: '#4B585C' }}>Loading…</div>;
  const list = state.orders || [];
  return (
    <div>
      {list.map((o) => <OrderRow key={o.kind} appId={appId} o={o} reload={load} />)}
    </div>
  );
}
