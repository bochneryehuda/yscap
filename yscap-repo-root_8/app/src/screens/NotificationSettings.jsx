import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* Per-category notification preferences (in-app + email), grouped the way a
   borrower thinks about their loan, with bulk email controls. Every toggle
   saves immediately (optimistic, rolled back on failure); a few critical
   in-app alerts stay on so nothing that needs action can be silenced. */

const LABEL = {
  messages: 'Messages from your loan team',
  status_updates: 'Loan status & closing-date changes',
  documents: 'Document updates (accepted / needs attention)',
  conditions: 'New conditions to clear',
  pricing: 'Pricing & product registration (terms, term sheets)',
  reminders: 'Reminders about outstanding items',
  draws: 'Draw requests',
  other: 'Everything else',
};
const HINT = {
  documents: 'Kept on in-app so you never miss a document that needs fixing.',
  conditions: 'Kept on in-app so you never miss something we need to clear.',
  pricing: 'When a product is registered or repriced on one of your files.',
  reminders: 'Occasional nudges from your loan team about what’s still open.',
};
const GROUPS = [
  { name: 'Your loan file', cats: ['status_updates', 'conditions', 'documents', 'pricing'] },
  { name: 'Communication', cats: ['messages', 'reminders', 'draws', 'other'] },
];

export default function NotificationSettings() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => { api.notificationPrefs().then(setRows).catch(e => setErr(e.message)); }, []);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2000); };

  async function toggle(cat, field, value) {
    setRows(rs => rs.map(r => r.category === cat ? { ...r, [field]: value } : r));
    const row = rows.find(r => r.category === cat);
    try {
      setErr('');
      await api.saveNotificationPref({ category: cat, in_app: field === 'in_app' ? value : row.in_app, email: field === 'email' ? value : row.email });
      flash('Saved');
    } catch (e) {
      // Roll the checkbox back — leaving the optimistic value on screen made
      // the user believe a preference stuck when it never saved.
      setRows(rs => rs.map(r => r.category === cat ? { ...r, [field]: row[field] } : r));
      setErr(e.message || 'Could not save');
    }
  }

  // Bulk email switch: writes every category (sequentially, verified by the
  // server response) — "pause all email" for a vacation, one tap to restore.
  async function setAllEmail(on) {
    if (!rows || bulkBusy) return;
    setBulkBusy(true); setErr('');
    const before = rows;
    setRows(rs => rs.map(r => ({ ...r, email: on })));
    try {
      for (const r of before) {
        await api.saveNotificationPref({ category: r.category, in_app: r.in_app, email: on });
      }
      flash(on ? 'Email notifications on for everything' : 'All email notifications paused');
    } catch (e) {
      setRows(before);
      setErr(e.message || 'Could not update every category — nothing was changed.');
    } finally { setBulkBusy(false); }
  }

  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;
  if (!rows) return <div className="panel muted">Loading…</div>;

  const byCat = Object.fromEntries(rows.map(r => [r.category, r]));
  const grouped = GROUPS.map(g => ({ ...g, rows: g.cats.map(c => byCat[c]).filter(Boolean) }));
  const leftovers = rows.filter(r => !GROUPS.some(g => g.cats.includes(r.category)));
  if (leftovers.length) grouped.push({ name: 'More', rows: leftovers });
  const emailCount = rows.filter(r => r.email).length;

  const renderRow = (r) => (
    <div key={r.category} className="row" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)', alignItems: 'center', flexWrap: 'nowrap' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '8px 0' }}>
        <div>{LABEL[r.category] || r.category}</div>
        {HINT[r.category] && <div className="muted small">{HINT[r.category]}</div>}
      </div>
      {/* the whole cell is the tap target, not just the 16px checkbox */}
      <label className="notif-col" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', cursor: r.inAppLocked ? 'default' : 'pointer' }}
        title={r.inAppLocked ? 'Always on — this alert needs your action' : ''}>
        <input type="checkbox" checked={!!r.in_app} disabled={r.inAppLocked}
          onChange={e => toggle(r.category, 'in_app', e.target.checked)} />
      </label>
      <label className="notif-col" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', cursor: 'pointer' }}>
        <input type="checkbox" checked={!!r.email} onChange={e => toggle(r.category, 'email', e.target.checked)} />
      </label>
    </div>
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div><h1>Notification settings</h1>
          <p className="muted small">Choose what reaches you and how — per category, in-app and by email. A few critical alerts stay on so nothing that needs your action slips by.</p></div>
        <div className="spacer" />
        {msg && <span className="muted small">{msg} ✓</span>}
      </div>
      {err && <div role="alert" className="notice err">{err}</div>}

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>Email</h3>
            <p className="muted small" style={{ margin: 0 }}>
              {emailCount === rows.length ? 'You get an email for every category.'
                : emailCount === 0 ? 'All email is paused — everything still reaches you in-app.'
                : `Email on for ${emailCount} of ${rows.length} categories.`}
            </p>
          </div>
          <div className="spacer" />
          <button className="btn ghost small" disabled={bulkBusy || emailCount === rows.length} onClick={() => setAllEmail(true)}>
            {bulkBusy ? '…' : 'Email everything'}
          </button>
          <button className="btn ghost small" disabled={bulkBusy || emailCount === 0} onClick={() => setAllEmail(false)}
            title="In-app notifications keep working — only email pauses">
            {bulkBusy ? '…' : 'Pause all email'}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}>Notification</span>
          <span className="notif-col" style={{ textAlign: 'center' }}>In-app</span>
          <span className="notif-col" style={{ textAlign: 'center' }}>Email</span>
        </div>
        {grouped.map(g => (
          <React.Fragment key={g.name}>
            <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', padding: '12px 0 2px' }}>{g.name}</div>
            {g.rows.map(renderRow)}
          </React.Fragment>
        ))}
        <p className="muted small" style={{ marginTop: 12 }}>Changes save automatically. In-app alerts marked "always on" require your action and can't be silenced — their email can still be turned off.</p>
      </div>
    </>
  );
}
