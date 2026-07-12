import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Borrower change-request "sandbox" (S5-03). Once a product is registered, the
// borrower can't edit the deal numbers directly — they PROPOSE a change here and
// the loan team approves or rejects it. This panel renders nothing until the file
// is locked, so nothing changes for borrowers still in early intake.

const FIELDS = [
  { key: 'purchase_price', label: 'Purchase price', type: 'money' },
  { key: 'as_is_value', label: 'As-is value', type: 'money' },
  { key: 'arv', label: 'After-repair value (ARV)', type: 'money' },
  { key: 'rehab_budget', label: 'Rehab budget', type: 'money' },
  { key: 'property_type', label: 'Property type', type: 'select',
    options: ['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed Use'] },
];

const STATUS_PILL = {
  pending: { text: 'Waiting for your loan team', cls: '' },
  approved: { text: 'Approved', cls: 'done' },
  rejected: { text: 'Not approved', cls: '' },
  superseded: { text: 'Replaced by a newer request', cls: '' },
};

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? '$' + n.toLocaleString() : v;
}

export default function ChangeRequestPanel({ appId }) {
  const [state, setState] = useState({ locked: false, requests: [] });
  const [field, setField] = useState('arv');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    try { setState(await api.changeRequests(appId)); } catch (_) { /* leave hidden on error */ }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId]);

  async function submit() {
    if (value === '' || value == null) { setErr('Enter the new value you want.'); return; }
    setBusy(true); setErr(''); setOk('');
    try {
      const r = await api.requestChange(appId, field, value, reason.trim() || undefined);
      const made = Array.isArray(r.changeRequests) && r.changeRequests.length;
      setOk(made ? 'Sent to your loan team for approval.' : 'That already matches what we have on file.');
      setValue(''); setReason('');
      await load();
    } catch (e) { setErr(e.message || 'Could not send your request.'); }
    finally { setBusy(false); }
  }

  if (!state.locked) return null;
  const def = FIELDS.find((f) => f.key === field) || FIELDS[0];
  const requests = state.requests || [];

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Request a change to your loan</h3>
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        Your loan is priced, so the numbers are locked in. If something needs to change,
        ask here — your loan officer and processor review every request before it takes effect.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
      {ok && <div className="notice ok" style={{ marginBottom: 8 }}>{ok}</div>}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        <select className="input" style={{ maxWidth: 220 }} value={field} onChange={(e) => { setField(e.target.value); setValue(''); }}>
          {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        {def.type === 'select'
          ? <select className="input" style={{ maxWidth: 180 }} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="" disabled>Choose…</option>
              {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          : <input className="input" style={{ maxWidth: 180 }} type="number" inputMode="decimal"
              placeholder="New value" value={value} onChange={(e) => setValue(e.target.value)} />}
      </div>
      <textarea className="input" rows={2} style={{ width: '100%', marginBottom: 8 }}
        placeholder="Why are you asking for this change? (optional but helps us review it faster)"
        value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Sending…' : 'Send request'}</button>

      {requests.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>Your requests</div>
          {requests.map((r) => {
            const isMoney = ['purchase_price', 'as_is_value', 'arv', 'rehab_budget'].includes(r.field);
            const pill = STATUS_PILL[r.status] || { text: r.status, cls: '' };
            return (
              <div key={r.id} className="row" style={{ gap: 8, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid rgba(127,127,127,.12)', flexWrap: 'wrap' }}>
                <strong style={{ minWidth: 130 }}>{r.field_label}</strong>
                <span className="muted small">
                  {r.old_value != null ? (isMoney ? money(r.old_value) : r.old_value) : '—'} → {isMoney ? money(r.new_value) : r.new_value}
                </span>
                <div className="spacer" />
                <span className={`pill ${pill.cls}`}>{pill.text}</span>
                {r.status === 'rejected' && r.decision_note &&
                  <div className="muted small" style={{ width: '100%' }}>Note: {r.decision_note}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
