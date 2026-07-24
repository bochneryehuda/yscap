import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import ExceptionCard from '../components/ExceptionCard.jsx';

/* Loan policy EXCEPTIONS — the super-admin review box (owner-directed 2026-07-22).
 *
 * Today the only exception type is a co-borrower GUARANTY WAIVER. Any staff member
 * requests it on the file; a super-admin approves or denies it here (with a
 * required note), and either party can CLEAR (archive) a handled one. Each row is
 * the shared ExceptionCard — rich file detail + one-click deep-links into the file
 * and its sections. The approver can't decide their own request (server-enforced;
 * buttons disabled here too). */

export default function StaffExceptions() {
  const { role } = useAuth();
  const location = useLocation();
  const isSuper = role === 'super_admin';
  const focusAppId = new URLSearchParams(location.search).get('app') || '';

  const [rows, setRows] = useState([]);
  const [reasonCodes, setReasonCodes] = useState({});
  const [actorId, setActorId] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [pendingCount, setPendingCount] = useState(0);
  const [canDecide, setCanDecide] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [notes, setNotes] = useState({});
  // Per-row waive selection for send-before-clear-to-close requests (2026-07-24):
  // rowId -> array of blocker codes the super-admin is waiving. Initialized by
  // EsignGatePanel with the safe default (readiness items only).
  const [waiveSel, setWaiveSel] = useState({});
  const [highlightId, setHighlightId] = useState('');
  const rowRefs = useRef({});

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const load = () => api.loanExceptions(statusFilter)
    .then((d) => {
      setRows(d.exceptions || []);
      setPendingCount(d.pendingCount || 0);
      setCanDecide(!!d.canDecide);
      setReasonCodes(d.reasonCodes || {});
      setActorId(d.actorId || '');
    })
    .catch((e) => flash(false, (e && e.message) || 'could not load exceptions'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  useEffect(() => {
    if (!focusAppId || !rows.length) return;
    const hit = rows.find((r) => r.application_id === focusAppId);
    if (hit && rowRefs.current[hit.id]) {
      rowRefs.current[hit.id].scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(hit.id); setTimeout(() => setHighlightId(''), 2600);
    }
  }, [focusAppId, rows]);

  async function decide(row, decision) {
    const note = (notes[row.id] || '').trim();
    if (!note) { flash(false, 'Add a short note explaining your decision.'); return; }
    const isEsign = (row.type || row.exception_type) === 'esign_before_ctc';
    // An esign APPROVAL must name exactly what it waives — everything unchecked
    // still applies. The server re-validates against the live gate.
    const waived = isEsign && decision === 'approved' ? (waiveSel[row.id] || []) : undefined;
    if (isEsign && decision === 'approved' && !waived.length) {
      flash(false, 'Tick at least one requirement to waive in the picture above — or deny the request.');
      return;
    }
    setBusy(row.id);
    try {
      await api.decideLoanException(row.id, decision, note, waived);
      flash(true, isEsign
        ? (decision === 'approved'
            ? `Approved with ${waived.length} requirement${waived.length === 1 ? '' : 's'} waived. Everything not waived still applies before the package can send.`
            : 'Denied. The package can be sent once the outstanding items are done.')
        : (decision === 'approved'
            ? 'Waiver approved. The co-borrower now shows as a member (non-guarantor); re-issue the term sheet to reflect it.'
            : 'Waiver denied. Both borrowers remain personal guarantors.'));
      await load();
    } catch (e) { flash(false, (e && e.message) || 'could not record the decision'); }
    finally { setBusy(''); }
  }

  async function clear(row) {
    setBusy(row.id);
    try {
      await api.clearLoanException(row.id, notes[row.id] || '');
      flash(true, 'Exception cleared.');
      await load();
    } catch (e) { flash(false, (e && e.message) || 'could not clear the exception'); }
    finally { setBusy(''); }
  }

  const filters = ['open', 'approved', 'denied', 'withdrawn', 'cleared', 'all'];
  const filterLabel = { open: 'Awaiting review', approved: 'Approved', denied: 'Denied', withdrawn: 'Withdrawn', cleared: 'Cleared', all: 'All' };

  return (
    <div className="wrap" style={{ maxWidth: 940 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Exceptions</h1>
        {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} awaiting review</span>}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Requests to make an exception to a loan policy — waiving a co-borrower’s personal guarantee (they stay a
        member of the borrowing entity but are not a personal guarantor), or sending a term-sheet package before
        every send requirement is met. {isSuper
          ? 'For a send exception you see the whole picture — what’s done and what’s outstanding — and tick exactly which requirements you’re waiving; everything unchecked still applies. A short note is required; clear the exception when it’s handled.'
          : 'Only a super-admin can approve or deny; you can review the queue and clear a handled one.'}
      </p>

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
        {filters.map((f) => (
          <button key={f} className={`btn small ${statusFilter === f ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(f)}>
            {filterLabel[f]}
          </button>
        ))}
      </div>

      {rows.length === 0 && <div className="notice">No exceptions {statusFilter === 'all' ? '' : `(${filterLabel[statusFilter].toLowerCase()})`} right now.</div>}

      {rows.map((r) => {
        const open = r.status === 'requested';
        const ownRequest = r.requested_by && actorId && r.requested_by === actorId;
        const canClear = r.status !== 'cleared' && (isSuper || ownRequest);
        const isEsign = (r.type || r.exception_type) === 'esign_before_ctc';
        // The deciding super-admin picks which requirements to waive right in the
        // card's requirements picture; the selection lives here so Approve can
        // submit it. (EsignGatePanel only enables pickers when the server says
        // this actor can decide.)
        const gateSelect = isEsign && open && canDecide && !ownRequest
          ? { selected: waiveSel[r.id], onChange: (codes) => setWaiveSel((m) => ({ ...m, [r.id]: codes })) }
          : undefined;
        return (
          <ExceptionCard key={r.id} r={r} reasonCodes={reasonCodes} gateSelect={gateSelect}
            highlight={highlightId === r.id} forwardRef={(el) => { rowRefs.current[r.id] = el; }}>
            {(open && canDecide) || canClear ? (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--hair,#e7e2d6)', paddingTop: 10 }}>
                {open && canDecide && ownRequest && (
                  <div className="muted small" style={{ marginBottom: 6 }}>You requested this exception — another super-admin must approve or deny it.</div>
                )}
                {open && canDecide && !ownRequest && (
                  <>
                    <textarea className="input" rows={2} style={{ width: '100%' }}
                      placeholder="Decision note (required) — e.g. approved: strong primary guarantor; low LTV."
                      value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn primary small" disabled={busy === r.id || !(notes[r.id] || '').trim()} onClick={() => decide(r, 'approved')}>
                        {busy === r.id ? 'Saving…' : ((r.type || r.exception_type) === 'esign_before_ctc' ? 'Approve' : 'Approve waiver')}
                      </button>
                      <button className="btn ghost small" disabled={busy === r.id || !(notes[r.id] || '').trim()} onClick={() => decide(r, 'denied')}>Deny</button>
                    </div>
                  </>
                )}
                {open && !canDecide && <div className="muted small">Only a super-admin can approve or deny this request.</div>}
                {canClear && (
                  <div className="row" style={{ gap: 8, marginTop: open && canDecide && !ownRequest ? 8 : 0, alignItems: 'center' }}>
                    <button className="btn ghost small" disabled={busy === r.id} onClick={() => clear(r)}>Clear (archive)</button>
                    <span className="muted small">Closes this out of the active queue. Doesn’t change the waiver.</span>
                  </div>
                )}
              </div>
            ) : null}
          </ExceptionCard>
        );
      })}
    </div>
  );
}
