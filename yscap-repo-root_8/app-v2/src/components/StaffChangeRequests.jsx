import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Staff review side of the borrower change-request sandbox (S5-03). Shows the
// borrower's proposed economics changes on a registered file; the assigned loan
// officer / processor approves (applies it to the live record, re-firing pricing)
// or rejects it. Renders nothing until there is at least one request on the file.

function money(field, v) {
  if (!['purchase_price', 'as_is_value', 'arv', 'rehab_budget'].includes(field)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? '$' + n.toLocaleString() : v;
}
const STATUS = {
  pending: { text: 'Pending', cls: '' },
  approved: { text: 'Approved', cls: 'done' },
  rejected: { text: 'Rejected', cls: '' },
  superseded: { text: 'Superseded', cls: '' },
};

export default function StaffChangeRequests({ appId, onChanged }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');

  async function load() {
    try { setRows(await api.staffChangeRequests(appId)); } catch (_) { setRows([]); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId]);

  async function decide(id, action) {
    setBusy(id + action); setErr('');
    try {
      if (action === 'approve') await api.staffApproveChangeRequest(id, note.trim() || undefined);
      else await api.staffRejectChangeRequest(id, note.trim() || undefined);
      setNoteFor(null); setNote('');
      await load();
      if (onChanged) await onChanged();   // approval reopens P&P — refresh the file
    } catch (e) { setErr(e.message || 'Could not update the request.'); }
    finally { setBusy(''); }
  }

  if (!rows || rows.length === 0) return null;
  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending').slice(0, 8);

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Change requests</h3>
        {pending.length > 0 && <span className="pill" style={{ marginLeft: 8 }}>{pending.length} pending</span>}
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        The borrower proposed these changes to the priced deal. Approving applies the value to the
        file and re-opens Products &amp; Pricing so it can be re-registered.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}

      {pending.length === 0 && <p className="muted small">No pending requests.</p>}
      {pending.map((r) => (
        <div key={r.id} style={{ padding: '8px 0', borderTop: '1px solid rgba(127,127,127,.14)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ minWidth: 150 }}>{r.field_label}</strong>
            <span className="muted small">
              {r.old_value != null ? money(r.field, r.old_value) : '—'} → <strong>{money(r.field, r.new_value)}</strong>
            </span>
            <div className="spacer" />
            <button className="btn primary small" disabled={busy === r.id + 'approve'}
              onClick={() => decide(r.id, 'approve')}>{busy === r.id + 'approve' ? 'Applying…' : 'Approve'}</button>
            <button className="btn ghost small" disabled={busy === r.id + 'reject'}
              onClick={() => { setNoteFor(noteFor === r.id ? null : r.id); setNote(''); }}>Reject…</button>
          </div>
          {r.reason && <div className="muted small" style={{ marginTop: 2 }}>Borrower’s reason: {r.reason}</div>}
          {noteFor === r.id && (
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <input className="input" style={{ maxWidth: 320 }} placeholder="Reason (shared with the borrower, optional)"
                value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn danger small" disabled={busy === r.id + 'reject'}
                onClick={() => decide(r.id, 'reject')}>{busy === r.id + 'reject' ? 'Rejecting…' : 'Confirm reject'}</button>
            </div>
          )}
        </div>
      ))}

      {decided.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted small" style={{ marginBottom: 4 }}>Recent decisions</div>
          {decided.map((r) => {
            const s = STATUS[r.status] || { text: r.status, cls: '' };
            return (
              <div key={r.id} className="row" style={{ gap: 8, alignItems: 'baseline', padding: '3px 0', flexWrap: 'wrap' }}>
                <span style={{ minWidth: 150 }}>{r.field_label}</span>
                <span className="muted small">→ {money(r.field, r.new_value)}</span>
                <div className="spacer" />
                <span className={`pill ${s.cls}`}>{s.text}</span>
                {r.decided_by_name && <span className="muted small">by {r.decided_by_name}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
