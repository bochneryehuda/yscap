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
  dob_same_but_impossible: 'Both systems carry the SAME date of birth — but it cannot be right (see the note next to the value). Correct the DOB on the borrower’s file, then dismiss this row.',
  pii_overwrite_blocked: 'A bulk repush wanted to overwrite this borrower-identity value in ClickUp. Bulk pushes may only fill blanks — nothing was written.',
  file_not_materialized_ambiguous: 'This ClickUp task could not be matched to a PILOT file — its identity signals (loan number / address / stamp) point at more than one existing file or at another borrower’s loan. Fix the conflicting value in ClickUp (usually a loan number copied by the duplicate-a-task workflow) and this row closes itself on a later sync — or resolve it right here: create it as its own new file, or link it to one of the candidate files below.',
  file_not_materialized_duplicate_pending: 'This task looks like a fresh ClickUp duplicate that still shows another ACTIVE deal’s address, so PILOT is deliberately waiting rather than creating a twin file. Update the task’s address in ClickUp and the file appears on the next sync — or, if this genuinely is a second deal at the same address, create it now. (When the earlier deal at this address is already funded or cancelled, the file is created automatically — no action needed.)',
  copied_loan_number_needs_assignment: 'Two of this borrower’s tasks carried the SAME YS loan number (the duplicate-a-task workflow copies it), and this file is the one holding a copy — a loan number belongs to exactly one loan, so it was not kept here. Fix it in ClickUp: enter this deal’s correct number on this task (it syncs in and this row closes itself), or clear the number on whichever task is the duplicate — the system automatically gives a contested number to the task that rightfully owns it (the older task, or the only one still carrying it).',
  task_deleted_needs_decision: 'This file’s ClickUp task was DELETED and no live task for the same deal exists. Decide what the file should do: archive it (reversible, ClickUp untouched), or keep it in PILOT without a task.',
  push_dead_lettered: 'An update from PILOT could not reach ClickUp after every retry (the fields and the last error are shown above). Nothing was lost in PILOT. Retry the push once the cause is fixed — this row also closes itself when any later push for the file succeeds.',
  file_unlinked_no_task: 'This PILOT file has NO ClickUp task, so it does not sync at all (it is older than the automatic recovery window). Create its ClickUp task now, or dismiss if this file intentionally lives outside ClickUp.',
  identity_mismatch_audit: 'The portfolio audit found the two systems carrying DIFFERENT values for this borrower-identity field. Nothing was changed anywhere (identity fields never overwrite silently) — compare the sides and adopt the correct one; it is applied to both systems. If both are fine (e.g. an old phone number), dismiss and this stays closed.',
  sharepoint_match_uncertain: 'The SharePoint mirror was NOT SURE which folder this file’s documents belong in (an ambiguous folder match, or no officer yet), so it filed into a safe, clearly-marked new folder — shown under “In PILOT”. If that is the wrong tree: merge or rename the folders IN SharePoint (the mirror never moves or renames anything itself), then click Re-match. Dismiss keeps the new folder.',
  sharepoint_mirror_failed: 'This document could NOT be mirrored to SharePoint after every automatic retry — the last error is recorded on the row. Usually a permissions problem, a folder issue, or an unreadable file. Fix the cause, then Retry the document; if the folder match itself is wrong, use Re-match. Nothing is lost — the document is safe in PILOT.',
  borrower_identity_conflict: 'TWO DIFFERENT PEOPLE appear to share ONE borrower profile: this file’s ClickUp task and the PILOT profile disagree on identity (name, phone, or SSN), and the profile also belongs to another officer’s relationship (a lead or owned profile). This usually comes from a family-shared email + the family last name. Do NOT adopt either value — that would change the other person too. Click Split: the file’s person gets their OWN fresh profile (rebuilt from ClickUp), and the other person keeps the original profile untouched. Dismiss only if you are sure it is genuinely the same human.',
  shared_email_needs_reassignment: 'TWO SEPARATE BORROWERS are using ONE email address (shown under “In ClickUp”; the two people under “In PILOT”). An email must belong to exactly ONE borrower — until it does, the system deliberately refuses to link any file by this email (it cannot know whose file it would be), and each borrower stays with their own loan officer. Fix: give one of the two their OWN email — edit it on their borrower screen in PILOT, or correct it on the ClickUp task and resync. This card closes itself the moment each borrower carries their own email.',
};
// FILE-LEVEL resolution options per reason (mirrors REASON_ACTIONS in
// src/lib/sync-file-review.js — the server validates; this only renders).
const REASON_FILE_ACTIONS = {
  file_not_materialized_ambiguous: [
    { action: 'create_file', label: 'Create as its own new file', title: 'Materialize this task as a brand-new PILOT file (all guards still apply)' },
    { action: 'link_existing', label: 'Link to selected file', title: 'Bind this task to the selected existing file, then fill it from the task', needsTarget: true },
  ],
  file_not_materialized_duplicate_pending: [
    { action: 'create_file', label: 'Create the file now', title: 'Deliberate override of the duplicate-wait: create the file from the task as it is' },
  ],
  task_deleted_needs_decision: [
    { action: 'archive_file', label: 'Archive the file', title: 'Soft-archive (reversible; ClickUp untouched)' },
    { action: 'keep_file', label: 'Keep the file', title: 'Keep it in PILOT without a ClickUp task' },
  ],
  push_dead_lettered: [
    { action: 'retry_push', label: 'Retry the push', title: 'Re-queue the failed update through the normal guarded push' },
  ],
  file_unlinked_no_task: [
    { action: 'create_task', label: 'Create its ClickUp task', title: 'Create the ClickUp task for this file via the normal create path' },
  ],
  sharepoint_match_uncertain: [
    { action: 'sp_rematch', label: 'Re-match folders now', title: 'Clear the folder match so the next document sync re-runs it — fix the folders in SharePoint first (the mirror never moves anything itself)' },
  ],
  sharepoint_mirror_failed: [
    { action: 'sp_retry_doc', label: 'Retry the document', title: 'Re-arm the document’s mirror retries and kick a sync pass — fix the underlying cause first' },
    { action: 'sp_rematch', label: 'Re-match folders', title: 'Clear the folder match so the next sync re-runs it (when the folder resolution itself is the problem)' },
  ],
  borrower_identity_conflict: [
    { action: 'split_borrower', label: 'Split — give this file’s person their own profile', title: 'Un-merge: rebuild this file’s person from the ClickUp task on a fresh profile and re-point the file; the other person keeps the original profile untouched' },
  ],
};
// Candidate files the matcher surfaced (enriched into raw_value at queue time).
function linkCandidates(r) {
  try {
    const raw = r.raw_value ? JSON.parse(r.raw_value) : null;
    const cs = (raw && raw.candidates) || [];
    return cs.filter((c) => c && c.id).map((c) => ({ id: String(c.id), address: c.address || '(no address)', loanNumber: c.loanNumber || null }));
  } catch { return []; }
}

// COMMON-SENSE annotation for a DOB value (owner-directed 2026-07-15): a review
// row must SAY what is wrong — "born in the future", "would be 3 years old" —
// not just that something needs review.
function dobNote(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return '';
  const today = new Date().toISOString().slice(0, 10);
  const y = Number(String(v).slice(0, 4));
  const nowY = new Date().getUTCFullYear();
  if (String(v) > today) return ' — not born yet (a birth date in the future)';
  if (y > nowY - 18) return ` — would make the borrower about ${Math.max(0, nowY - y)} years old (a minor)`;
  if (y < nowY - 120) return ` — would make the borrower over 120 years old`;
  return '';
}
const FIELD_LABELS = {
  date_of_birth: 'Date of birth', expected_closing: 'Expected closing',
  actual_closing: 'Actual closing', acquisition_date: 'Acquisition date',
  ssn: 'Social Security number', first_name: 'Borrower name', email: 'Borrower email',
  cell_phone: 'Borrower cell', current_address: 'Borrower home address', status: 'File status',
  file_link: 'File not syncing', ys_loan_number: 'YS loan number', push_job: 'ClickUp push failed',
  co_first_name: 'Co-borrower name', co_cell_phone: 'Co-borrower cell',
  sharepoint_folder: 'SharePoint filing', sharepoint_doc: 'SharePoint document sync',
  borrower_identity: 'Borrower identity — one profile, two people',
  co_borrower_identity: 'Co-borrower identity — one profile, two people',
  shared_email: 'Shared email — two borrowers',
};
// Field keys the two-sided resolver can apply to BOTH systems today.
// 'file_link' / 'ys_loan_number' rows are deliberately NOT here: they are
// visibility rows — the fix happens in ClickUp (or the Control Center
// force-create) and the row closes itself on the next sync.
const RESOLVABLE = new Set(['date_of_birth', 'expected_closing', 'actual_closing', 'acquisition_date', 'ssn', 'status',
  'email', 'cell_phone', 'first_name', 'current_address']);
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
  const [linkTarget, setLinkTarget] = useState({});   // rowId -> chosen candidate application id
  const [customVal, setCustomVal] = useState({});     // rowId -> reviewer-typed correct value
  const [selected, setSelected] = useState({});       // rowId -> checked (bulk actions)
  const [bulkMsg, setBulkMsg] = useState('');

  async function bulk(action, winner) {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    if (!ids.length) return;
    setBusyId('bulk'); setErr(''); setBulkMsg('');
    try {
      const r = await api.post('/api/staff/sync-reviews/bulk', { ids, action, winner });
      const ok = (r.results || []).filter((x) => x.ok).length;
      const bad = (r.results || []).filter((x) => !x.ok);
      setBulkMsg(`${ok} done${bad.length ? `, ${bad.length} failed (${bad.slice(0, 3).map((b) => b.error).join('; ')}${bad.length > 3 ? '…' : ''})` : ''}`);
      setSelected({});
      await load();
    } catch (e) { setErr(e.message || 'Bulk action failed'); }
    finally { setBusyId(null); }
  }
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
      {bulkMsg && <div className="notice ok" style={{ marginBottom: 10 }}>{bulkMsg}</div>}
      {status === 'open' && Object.values(selected).some(Boolean) && (
        <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{Object.values(selected).filter(Boolean).length} selected</strong>
          <button className="btn primary btn-sm" disabled={busyId === 'bulk'}
            title="Apply ClickUp's current value to BOTH systems for every selected row that supports it"
            onClick={() => bulk('resolve', 'clickup')}>Adopt ClickUp for selected</button>
          <button className="btn primary btn-sm" disabled={busyId === 'bulk'}
            title="Apply PILOT's current value to BOTH systems for every selected row that supports it"
            onClick={() => bulk('resolve', 'portal')}>Adopt PILOT for selected</button>
          <button className="btn ghost btn-sm" disabled={busyId === 'bulk'}
            onClick={() => bulk('reject')}>Dismiss selected</button>
          <button className="btn ghost btn-sm" onClick={() => setSelected({})}>Clear</button>
        </div>
      )}
      {rows == null ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>
          {status === 'open' ? 'Nothing needs review — provable conflicts are auto-resolved, and no ambiguous ones are waiting.' : `No ${status} items.`}
        </p></div>
      ) : rows.map((r) => {
        const { cu, p } = sides(r);
        // Adopting a side only makes sense when the sides actually DIFFER —
        // for an equal-but-impossible pair the fix is correcting the value on
        // the file (the resolver would refuse to re-apply nonsense anyway).
        const sidesEqual = cu != null && p != null && String(cu) === String(p);
        const canResolve = RESOLVABLE.has(r.field_key) && !sidesEqual;
        const isDob = r.field_key === 'date_of_birth';
        const fileActions = REASON_FILE_ACTIONS[r.reason] || null;
        const candidates = fileActions && fileActions.some((a) => a.needsTarget) ? linkCandidates(r) : [];
        return (
          <div className="panel" key={r.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              {status === 'open' && (
                <input type="checkbox" checked={!!selected[r.id]} aria-label="Select for bulk action"
                  onChange={(e) => setSelected((m) => ({ ...m, [r.id]: e.target.checked }))} />
              )}
              <strong>{FIELD_LABELS[r.field_key] || r.field_key}</strong>
              <span className={`pill ${r.direction === 'outbound' ? '' : 'done'}`}>{r.direction === 'outbound' ? 'PILOT → ClickUp' : 'ClickUp → PILOT'}</span>
              <span className="muted small">{new Date(r.created_at).toLocaleString()}</span>
              <div className="spacer" />
              {r.application_id && <Link className="btn ghost btn-sm" to={`/internal/app/${r.application_id}`}>Open file</Link>}
            </div>
            <div className="metrow"><span className="k">Who</span><span className="v">{r.borrower_name || '—'}{r.property ? ` — ${r.property}` : ''}</span></div>
            <div className="metrow"><span className="k">In ClickUp</span><span className="v"><strong>{showVal(cu)}</strong>{isDob ? <em className="muted small">{dobNote(cu)}</em> : null}</span></div>
            <div className="metrow"><span className="k">In PILOT</span><span className="v"><strong>{showVal(p)}</strong>{isDob ? <em className="muted small">{dobNote(p)}</em> : null}</span></div>
            <p className="muted small" style={{ margin: '8px 0' }}>
              {sidesEqual && r.reason === 'clickup_dob_differs_from_portal'
                ? REASON_COPY.dob_same_but_impossible   /* legacy rows queued before the common-sense reasons */
                : (REASON_COPY[r.reason] || r.reason)}
            </p>
            {status === 'open' && canResolve && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Apply ClickUp's current value to BOTH systems (re-read live, audited)"
                  onClick={() => act(r.id, 'resolve', { winner: 'clickup' })}>{busyId === r.id ? '…' : 'Adopt ClickUp value → both'}</button>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Apply PILOT's current value to BOTH systems (re-read live, audited)"
                  onClick={() => act(r.id, 'resolve', { winner: 'portal' })}>{busyId === r.id ? '…' : 'Adopt PILOT value → both'}</button>
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Close this without writing anything anywhere"
                  onClick={() => act(r.id, 'reject')}>Dismiss</button>
                {/* THIRD OPTION: neither side is right — type the correct value;
                    it runs the same sanitizers and applies to BOTH systems. */}
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input className="input" style={{ maxWidth: 180 }}
                    type={isDob || /closing|acquisition/.test(r.field_key) ? 'date' : 'text'}
                    placeholder="Or type the correct value…" aria-label="Type the correct value"
                    value={customVal[r.id] || ''} disabled={busyId === r.id}
                    onChange={(e) => setCustomVal((m) => ({ ...m, [r.id]: e.target.value }))} />
                  <button className="btn ghost btn-sm" disabled={busyId === r.id || !(customVal[r.id] || '').trim()}
                    title="Apply the typed value to BOTH systems (validated, audited)"
                    onClick={() => act(r.id, 'resolve', { winner: 'custom', value: customVal[r.id] })}>Apply typed → both</button>
                </span>
              </div>
            )}
            {status === 'open' && !canResolve && fileActions && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {fileActions.map((a) => {
                  const needsPick = a.needsTarget;
                  const picked = linkTarget[r.id] || '';
                  if (needsPick && !candidates.length) return null;   // no linkable candidates surfaced
                  return (
                    <React.Fragment key={a.action}>
                      {needsPick && (
                        <select className="input" style={{ maxWidth: 320 }} value={picked} aria-label="File to link this task to"
                          onChange={(e) => setLinkTarget((m) => ({ ...m, [r.id]: e.target.value }))}>
                          <option value="">Choose an existing file…</option>
                          {candidates.map((c) => (
                            <option key={c.id} value={c.id}>{c.address}{c.loanNumber ? ` — ${c.loanNumber}` : ''}</option>
                          ))}
                        </select>
                      )}
                      <button className="btn primary btn-sm" title={a.title}
                        disabled={busyId === r.id || (needsPick && !picked)}
                        onClick={() => act(r.id, 'resolve-file', { action: a.action, targetApplicationId: needsPick ? picked : undefined })}>
                        {busyId === r.id ? '…' : a.label}
                      </button>
                    </React.Fragment>
                  );
                })}
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Close this row without doing anything (it will not come back for this task)"
                  onClick={() => act(r.id, 'reject')}>Dismiss</button>
              </div>
            )}
            {status === 'open' && !canResolve && !fileActions && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id || !r.proposed_value}
                  title={r.proposed_value ? 'Apply the proposed value (audited)' : 'No valid proposal to apply — dismiss or fix manually'}
                  onClick={() => act(r.id, 'approve')}>{busyId === r.id ? '…' : 'Approve'}</button>
                <button className="btn ghost btn-sm" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>Dismiss</button>
              </div>
            )}
            {status !== 'open' && (
              <p className="muted small" style={{ margin: 0 }}>
                {/* The record of WHAT settled it (owner-directed): auto-closed
                    rows say so explicitly with the value that resolved them —
                    "fixed outside PILOT" still leaves a visible explanation. */}
                {r.auto_resolved ? '✓ Resolved automatically — no clicks needed. ' :
                  r.winner === 'custom' ? 'A reviewer typed the correct value; it was applied to both systems. ' :
                  r.winner ? `Adopted the ${r.winner === 'clickup' ? 'ClickUp' : 'PILOT'} value on both systems. ` : ''}
                {r.resolution_note ? `${r.resolution_note}` : ''}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
