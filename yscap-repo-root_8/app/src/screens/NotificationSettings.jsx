import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const LABEL = {
  messages: 'Messages from your loan team',
  status_updates: 'Loan status changes',
  documents: 'Document updates (accepted / needs attention)',
  conditions: 'New conditions to clear',
  draws: 'Draw requests',
  other: 'Everything else',
};
const HINT = {
  documents: 'Kept on in-app so you never miss a document that needs fixing.',
  conditions: 'Kept on in-app so you never miss something we need to clear.',
};

export default function NotificationSettings() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => { api.notificationPrefs().then(setRows).catch(e => setErr(e.message)); }, []);

  async function toggle(cat, field, value) {
    setRows(rs => rs.map(r => r.category === cat ? { ...r, [field]: value } : r));
    const row = rows.find(r => r.category === cat);
    try {
      setErr('');
      await api.saveNotificationPref({ category: cat, in_app: field === 'in_app' ? value : row.in_app, email: field === 'email' ? value : row.email });
      setMsg('Saved'); setTimeout(() => setMsg(''), 1500);
    } catch (e) {
      // Roll the checkbox back — leaving the optimistic value on screen made
      // the user believe a preference stuck when it never saved.
      setRows(rs => rs.map(r => r.category === cat ? { ...r, [field]: row[field] } : r));
      setErr(e.message || 'Could not save');
    }
  }

  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;
  if (!rows) return <div className="panel muted">Loading…</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div><h1>Notification settings</h1>
          <p className="muted small">Choose what reaches you and how. A few important alerts stay on so nothing critical slips by.</p></div>
        <div className="spacer" />
        {msg && <span className="muted small">{msg} ✓</span>}
      </div>
      <div className="panel">
        <div className="row" style={{ fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}>Notification</span>
          <span className="notif-col" style={{ textAlign: 'center' }}>In-app</span>
          <span className="notif-col" style={{ textAlign: 'center' }}>Email</span>
        </div>
        {rows.map(r => (
          <div key={r.category} className="row" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)', alignItems: 'center', flexWrap: 'nowrap' }}>
            <div style={{ flex: 1, minWidth: 0, padding: '8px 0' }}>
              <div>{LABEL[r.category] || r.category}</div>
              {HINT[r.category] && <div className="muted small">{HINT[r.category]}</div>}
            </div>
            {/* the whole cell is the tap target, not just the 16px checkbox */}
            <label className="notif-col" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', cursor: r.inAppLocked ? 'default' : 'pointer' }}
              title={r.inAppLocked ? 'Always on' : ''}>
              <input type="checkbox" checked={!!r.in_app} disabled={r.inAppLocked}
                onChange={e => toggle(r.category, 'in_app', e.target.checked)} />
            </label>
            <label className="notif-col" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!r.email} onChange={e => toggle(r.category, 'email', e.target.checked)} />
            </label>
          </div>
        ))}
        <p className="muted small" style={{ marginTop: 12 }}>Changes save automatically.</p>
      </div>
    </>
  );
}
