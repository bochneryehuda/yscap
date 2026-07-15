import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';

/* Sync review queue (2026-07-15 date incident): suspicious cross-system changes
 * are HELD here instead of silently applied or silently dropped — a blocked
 * outbound DOB one-day shift, a ClickUp date with an impossible year ("26"
 * typed as the year), or a ClickUp DOB that disagrees with the portal's.
 * Approving applies the proposed value through the normal audited write path;
 * rejecting closes the item. The sync stays fully bidirectional — only the
 * suspicious cases stop here. */

const REASON_COPY = {
  dob_one_day_shift_blocked: 'Automated push wanted to move an existing ClickUp DOB by exactly one day — the corruption signature. Approve only if the portal value is the correct one.',
  clickup_year_out_of_range: 'ClickUp holds a date with an impossible year (a mid-typing artifact or a 2-digit year). The proposal is the auto-corrected year.',
  clickup_dob_year_out_of_range: 'ClickUp holds a DOB with an impossible year. The proposal is the auto-corrected year (a DOB can never be in the future).',
  clickup_dob_differs_from_portal: 'ClickUp carries a different DOB than the portal. Approve to take ClickUp’s value into the portal; reject to keep the portal’s.',
};
const FIELD_LABELS = {
  date_of_birth: 'Date of birth', expected_closing: 'Expected closing',
  actual_closing: 'Actual closing', acquisition_date: 'Acquisition date',
};
const showDay = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDay(v) : (v || '—'));

export default function SyncReviews() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const load = useCallback(async () => {
    setErr('');
    try { setRows((await api.get(`/api/staff/sync-reviews?status=${status}`)).reviews || []); }
    catch (e) { setErr(e.message || 'Could not load the review queue'); setRows([]); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  async function act(id, verb) {
    setBusyId(id); setErr('');
    try { await api.post(`/api/staff/sync-reviews/${id}/${verb}`, {}); await load(); }
    catch (e) { setErr(e.message || `Could not ${verb}`); }
    finally { setBusyId(null); }
  }

  return (
    <div className="page">
      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <h2>Sync review</h2>
        <div className="spacer" />
        <select className="input" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status">
          <option value="open">Needs review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        Changes between PILOT and ClickUp that look suspicious are held here instead of being applied silently.
        Nothing below has been written anywhere yet — approving applies the proposed value (fully audited); rejecting keeps things as they are.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {rows == null ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>
          {status === 'open' ? 'Nothing needs review — the sync guards have not flagged any suspicious changes.' : `No ${status} items.`}
        </p></div>
      ) : rows.map((r) => (
        <div className="panel" key={r.id} style={{ marginBottom: 10 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong>{FIELD_LABELS[r.field_key] || r.field_key}</strong>
            <span className={`pill ${r.direction === 'outbound' ? '' : 'done'}`}>{r.direction === 'outbound' ? 'PILOT → ClickUp' : 'ClickUp → PILOT'}</span>
            <span className="muted small">{new Date(r.created_at).toLocaleString()}</span>
            <div className="spacer" />
            {r.application_id && <Link className="btn ghost btn-sm" to={`/internal/app/${r.application_id}`}>Open file</Link>}
          </div>
          <div className="metrow"><span className="k">Who</span><span className="v">{r.borrower_name || '—'}{r.property ? ` — ${r.property}` : ''}</span></div>
          <div className="metrow"><span className="k">Current</span><span className="v">{showDay(r.current_value)}</span></div>
          <div className="metrow"><span className="k">Proposed</span><span className="v">{showDay(r.proposed_value)}</span></div>
          <p className="muted small" style={{ margin: '8px 0' }}>{REASON_COPY[r.reason] || r.reason}</p>
          {status === 'open' && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary btn-sm" disabled={busyId === r.id || !r.proposed_value}
                title={r.proposed_value ? 'Apply the proposed value (audited)' : 'No valid proposal to apply — reject or fix manually'}
                onClick={() => act(r.id, 'approve')}>{busyId === r.id ? '…' : 'Approve'}</button>
              <button className="btn ghost btn-sm" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>Reject</button>
            </div>
          )}
          {status !== 'open' && r.resolution_note && <p className="muted small" style={{ margin: 0 }}>Note: {r.resolution_note}</p>}
        </div>
      ))}
    </div>
  );
}
