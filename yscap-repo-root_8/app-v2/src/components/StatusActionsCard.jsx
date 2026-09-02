import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* THE STATUS ACTIONS (owner-directed 2026-09-01: "The processor doesn't have any way to
   make the file clear to close. She needs to have a button of actions that will actually
   change the statuses when she finishes her work on a file … a section for statuses,
   nicely designed, where she can switch to any status that she wants. Before clear to
   close status, all conditions need to be signed off.")

   The statuses were only reachable through a dropdown behind the pipeline-details
   toggle. This card puts the processor's stages on the overview as buttons, with the
   whole 38-status list one click away, and goes through the ONE status door the
   dropdown uses (POST …/internal-status → applyInternalStatus), which already refuses
   Clear to Close while a required condition is not signed off and answers with the
   blockers — shown here by name instead of a dead "blocked". Nothing is decided on this
   screen. Colours are explicit darks on white. */

const INK = '#141B22', MUTED = '#4B585C', TEAL = '#2F7F86', LINE = '#E7E1D3';

// The processor's stages, in order, as the ClickUp statuses they are.
const STAGES = [
  { v: 'assigned to processor', label: 'Loan setup' },
  { v: 'file being worked', label: 'Processing' },
  { v: 'waiting for docs', label: 'Waiting for docs' },
  { v: 'delegated ctc submission', label: 'Submitted for CTC' },
  { v: 'ctc (4-email)', label: 'Clear to close' },
];

export default function StatusActionsCard({ appId, app, onChanged }) {
  const { can } = useAuth();
  const [all, setAll] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);      // { tone, text, blockers? }
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { api.staffInternalStatuses().then((r) => setAll(Array.isArray(r) ? r : (r && r.statuses) || [])).catch(() => setAll([])); }, []);
  if (!app || !can('see_all_files')) return null;   // the same people the status door lets decide

  const current = String(app.internal_status || '').trim().toLowerCase();
  async function move(v, label) {
    if (!v || v === current) return;
    setBusy(v); setMsg(null);
    try {
      const r = await api.staffSetInternalStatus(appId, v);
      setMsg({ tone: 'ok', text: `Status moved to ${label || v}.${r && r.status ? ` The borrower now sees “${r.status}”.` : ''}` });
      if (onChanged) await onChanged();
    } catch (e) {
      const d = (e && e.data) || {};
      if (d.error === 'blocked') {
        const names = (d.blockers && (d.blockers.conditions || [])).map((c) => c.label || c.title || c.code).filter(Boolean);
        setMsg({ tone: 'err', text: `Not yet — ${label || v} needs every required condition signed off first. Still open: ${names.length}.`, blockers: names.slice(0, 12) });
      } else setMsg({ tone: 'err', text: (e && e.message) || 'Could not change the status.' });
    } finally { setBusy(''); }
  }

  return (
    <div className="panel">
      <div className="panel-h"><h3 style={{ margin: 0 }}>Status</h3>
        <span className="muted small">Move the file when you finish your part. Clear to close needs every required condition signed off.</span></div>
      <div className="panel-b">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {STAGES.map((st, i) => {
            const on = current === st.v;
            return (
              <React.Fragment key={st.v}>
                {i ? <span aria-hidden="true" style={{ color: LINE }}>›</span> : null}
                <button type="button" className={`btn small ${on ? 'primary' : 'ghost'}`} disabled={busy === st.v || on}
                  title={on ? 'This is the current status' : `Move this file to ${st.label}`}
                  onClick={() => move(st.v, st.label)}
                  style={on ? {} : { color: INK }}>
                  {busy === st.v ? '…' : st.label}
                </button>
              </React.Fragment>
            );
          })}
          <button type="button" className="btn link small" onClick={() => setShowAll((v) => !v)} style={{ color: TEAL, marginLeft: 'auto' }}>
            {showAll ? 'Hide every status' : 'Any other status…'}
          </button>
        </div>
        <div className="muted small" style={{ marginTop: 6, color: MUTED }}>
          Now: <b style={{ color: INK }}>{app.internal_status || '— not set —'}</b>{app.status ? <> · the borrower sees <b style={{ color: INK }}>{app.status}</b></> : null}
        </div>
        {showAll && (
          <select className="input" style={{ marginTop: 8, maxWidth: 420 }} value={app.internal_status || ''}
            onChange={(e) => move(e.target.value, e.target.value)} disabled={!!busy}>
            {!app.internal_status && <option value="">— not set —</option>}
            {(() => {
              const groups = {};
              for (const s of all) (groups[s.external] || (groups[s.external] = [])).push(s);
              return Object.entries(groups).map(([ext, list]) => (
                <optgroup key={ext} label={ext}>{list.map((s) => <option key={s.value} value={s.value}>{s.label || s.value}</option>)}</optgroup>
              ));
            })()}
          </select>
        )}
        {msg && (
          <div role={msg.tone === 'err' ? 'alert' : undefined} className={`notice ${msg.tone}`} style={{ marginTop: 10 }}>
            {msg.text}
            {msg.blockers && msg.blockers.length ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{msg.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
