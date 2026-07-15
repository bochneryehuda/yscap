import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';

/* Sync review queue — the human gate for PILOT ⇄ ClickUp disagreements
 * (2026-07-15). The auto-resolution engine settles the provable conflicts by
 * itself; only genuine ambiguity lands here, and the file's loan officer is
 * emailed when it does. Every card is TWO-SIDED: what ClickUp holds vs what
 * PILOT holds. Choosing "Adopt" applies that side's CURRENT value to BOTH
 * systems (re-read live at resolve time, fully audited + journaled). Dismiss
 * keeps both sides exactly as they are. */

const REASON_COPY = {
  dob_one_day_shift_blocked: 'An automated push wanted to move an existing ClickUp DOB by exactly one day — the corruption signature. Nothing was written.',
  dob_change_blocked_pending_review: 'An automated push wanted to change an existing ClickUp date of birth. A DOB change is always a human decision — nothing was written.',
  dob_restore_needs_review: 'The date-repair tooling found the two systems disagreeing on this DOB and could not prove which is right.',
  clickup_year_out_of_range: 'ClickUp holds a date with an impossible year (a mid-typing artifact or a 2-digit year). Nothing was synced.',
  clickup_dob_year_out_of_range: 'ClickUp holds a DOB with an impossible year. Nothing was synced.',
  clickup_dob_implausible: 'ClickUp holds a DOB that cannot belong to an adult borrower. Nothing was synced.',
  clickup_dob_differs_from_portal: 'ClickUp and PILOT carry different dates of birth and neither is provably wrong — a person must decide.',
  pii_overwrite_blocked: 'A bulk repush wanted to overwrite this borrower-identity value in ClickUp. Bulk pushes may only fill blanks — nothing was written.',
};
const FIELD_LABELS = {
  date_of_birth: 'Date of birth', expected_closing: 'Expected closing',
  actual_closing: 'Actual closing', acquisition_date: 'Acquisition date',
  ssn: 'Social Security number', first_name: 'Borrower name', email: 'Borrower email',
  cell_phone: 'Borrower cell', current_address: 'Borrower home address', status: 'File status',
};
// Field keys the two-sided resolver can apply to BOTH systems today.
const RESOLVABLE = new Set(['date_of_birth', 'expected_closing', 'actual_closing', 'acquisition_date', 'ssn', 'status']);
const showVal = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDay(v) : (v == null || v === '' ? '—' : String(v)));

// Two-sided values: rows written since the upgrade carry clickup_value /
// portal_value explicitly; older rows derive them from direction (inbound:
// the proposal came FROM ClickUp, current is PILOT's; outbound the reverse).
function sides(r) {
  const cu = r.clickup_value != null ? r.clickup_value : (r.direction === 'inbound' ? r.proposed_value : r.current_value);
  const p = r.portal_value != null ? r.portal_value : (r.direction === 'inbound' ? r.current_value : r.proposed_value);
  return { cu, p };
}

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

  async function act(id, verb, body) {
    setBusyId(id); setErr('');
    try { await api.post(`/api/staff/sync-reviews/${id}/${verb}`, body || {}); await load(); }
    catch (e) { setErr(e.message || `Could not ${verb}`); }
    finally { setBusyId(null); }
  }

  return (
    <div className="page">
      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <h2>Sync review</h2>
        <div className="spacer" />
        <select className="input" style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status">
          <option value="open">Needs review</option>
          <option value="resolved">Resolved</option>
          <option value="approved">Approved (legacy)</option>
          <option value="rejected">Dismissed</option>
        </select>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        PILOT and ClickUp disagreed and the system could not prove which side is right, so nothing was written anywhere.
        Compare both sides and <strong>adopt the correct one — it is applied to BOTH systems</strong> (re-read live, fully audited).
        Dismiss keeps both sides as they are.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {rows == null ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>
          {status === 'open' ? 'Nothing needs review — provable conflicts are auto-resolved, and no ambiguous ones are waiting.' : `No ${status} items.`}
        </p></div>
      ) : rows.map((r) => {
        const { cu, p } = sides(r);
        const canResolve = RESOLVABLE.has(r.field_key);
        return (
          <div className="panel" key={r.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <strong>{FIELD_LABELS[r.field_key] || r.field_key}</strong>
              <span className={`pill ${r.direction === 'outbound' ? '' : 'done'}`}>{r.direction === 'outbound' ? 'PILOT → ClickUp' : 'ClickUp → PILOT'}</span>
              <span className="muted small">{new Date(r.created_at).toLocaleString()}</span>
              <div className="spacer" />
              {r.application_id && <Link className="btn ghost btn-sm" to={`/internal/app/${r.application_id}`}>Open file</Link>}
            </div>
            <div className="metrow"><span className="k">Who</span><span className="v">{r.borrower_name || '—'}{r.property ? ` — ${r.property}` : ''}</span></div>
            <div className="metrow"><span className="k">In ClickUp</span><span className="v"><strong>{showVal(cu)}</strong></span></div>
            <div className="metrow"><span className="k">In PILOT</span><span className="v"><strong>{showVal(p)}</strong></span></div>
            <p className="muted small" style={{ margin: '8px 0' }}>{REASON_COPY[r.reason] || r.reason}</p>
            {status === 'open' && canResolve && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Apply ClickUp's current value to BOTH systems (re-read live, audited)"
                  onClick={() => act(r.id, 'resolve', { winner: 'clickup' })}>{busyId === r.id ? '…' : 'Adopt ClickUp value → both'}</button>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Apply PILOT's current value to BOTH systems (re-read live, audited)"
                  onClick={() => act(r.id, 'resolve', { winner: 'portal' })}>{busyId === r.id ? '…' : 'Adopt PILOT value → both'}</button>
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Close this without writing anything anywhere"
                  onClick={() => act(r.id, 'reject')}>Dismiss</button>
              </div>
            )}
            {status === 'open' && !canResolve && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id || !r.proposed_value}
                  title={r.proposed_value ? 'Apply the proposed value (audited)' : 'No valid proposal to apply — dismiss or fix manually'}
                  onClick={() => act(r.id, 'approve')}>{busyId === r.id ? '…' : 'Approve'}</button>
                <button className="btn ghost btn-sm" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>Dismiss</button>
              </div>
            )}
            {status !== 'open' && (
              <p className="muted small" style={{ margin: 0 }}>
                {r.winner ? `Adopted the ${r.winner === 'clickup' ? 'ClickUp' : 'PILOT'} value on both systems. ` : ''}
                {r.resolution_note ? `Note: ${r.resolution_note}` : ''}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
