import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Loan policy EXCEPTIONS — the super-admin review box (owner-directed 2026-07-22).
 *
 * Today the only exception type is a co-borrower GUARANTY WAIVER: a request to
 * waive the co-borrower's personal guarantee so they are a member of the
 * borrowing entity but not a personal guarantor. Any staff member requests it on
 * the file; a super-admin approves or denies it here (with a required note).
 *
 * Deliberately clean: one row per exception, a side-by-side of the DEFAULT policy
 * vs. the REQUESTED change, the reason + note, who asked, and a single Approve /
 * Deny control. The approver can't decide their own request (server-enforced;
 * the buttons are disabled here too). */

const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US');

function fmtAddr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1 || a.address || a.oneLine, a.city, a.state].filter(Boolean).join(', ');
}
function fmtWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return ''; }
}
const STATUS_TONE = { requested: 'warn', approved: 'ok', denied: 'err', withdrawn: '' };
const STATUS_LABEL = { requested: 'Awaiting review', approved: 'Approved', denied: 'Denied', withdrawn: 'Withdrawn' };

export default function StaffExceptions() {
  const { can, role } = useAuth();
  const location = useLocation();
  const canManage = can('manage_pricing');
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

  // Deep-link pulse to the focused file's row.
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
    setBusy(row.id);
    try {
      await api.decideLoanException(row.id, decision, note);
      flash(true, decision === 'approved'
        ? 'Waiver approved. The co-borrower now shows as a member (non-guarantor); re-issue the term sheet to reflect it.'
        : 'Waiver denied. Both borrowers remain personal guarantors.');
      await load();
    } catch (e) { flash(false, (e && e.message) || 'could not record the decision'); }
    finally { setBusy(''); }
  }

  if (!canManage) {
    return <div className="wrap"><div className="notice">You don’t have access to the Exceptions box.</div></div>;
  }

  const filters = ['open', 'approved', 'denied', 'withdrawn', 'all'];
  const filterLabel = { open: 'Awaiting review', approved: 'Approved', denied: 'Denied', withdrawn: 'Withdrawn', all: 'All' };

  return (
    <div className="wrap" style={{ maxWidth: 940 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Exceptions</h1>
        {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} awaiting review</span>}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Requests to make an exception to a loan policy. Today: waiving a co-borrower’s personal guarantee (they
        stay a member of the borrowing entity but are not a personal guarantor). {isSuper
          ? 'You can approve or deny each one — a short note is required.'
          : 'Only a super-admin can approve or deny; you can review the queue.'}
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
        const subject = [r.subject_first, r.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
        const borrower = [r.first_name, r.last_name].filter(Boolean).join(' ');
        const open = r.status === 'requested';
        const ownRequest = r.requested_by && actorId && r.requested_by === actorId;
        const reasonLabel = reasonCodes[r.reason_code] || r.reason_code || '—';
        return (
          <div key={r.id} ref={(el) => { rowRefs.current[r.id] = el; }}
            className="panel" style={{ marginBottom: 12, outline: highlightId === r.id ? '2px solid #AE8746' : 'none', transition: 'outline .3s' }}>
            <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <Link to={`/internal/app/${r.application_id}`} style={{ fontWeight: 600 }}>
                  {borrower || 'File'}{r.ys_loan_number ? ` · ${r.ys_loan_number}` : ''}
                </Link>
                <div className="muted small">{fmtAddr(r.property_address)}{r.loan_amount != null ? ` · ${money(r.loan_amount)}` : ''}</div>
              </div>
              <span className={`ts-badge ${STATUS_TONE[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>
            </div>

            {/* Default policy vs. requested change — the whole decision on one line. */}
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
              <div style={{ flex: '1 1 220px' }}>
                <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Default policy</div>
                <div>Full recourse — both borrowers personally guarantee.</div>
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Requested change</div>
                <div>Waive <b>{subject}</b>’s personal guarantee — {subject} becomes a non-guarantor member; the primary borrower remains sole guarantor.</div>
              </div>
            </div>

            <div className="metrow" style={{ marginTop: 8 }}><span className="k">Reason</span><span className="v">{reasonLabel}</span></div>
            {r.reason_note && <div className="notice" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.reason_note}</div>}
            <div className="muted small" style={{ marginTop: 6 }}>
              Requested by {r.requested_by_name || 'a team member'} · {fmtWhen(r.requested_at || r.created_at)}
              {r.decided_at && <> · {r.status === 'approved' ? 'Approved' : r.status === 'denied' ? 'Denied' : 'Decided'} by {r.decided_by_name || 'a super-admin'} · {fmtWhen(r.decided_at)}</>}
            </div>
            {!open && r.decision_note && <div className="muted small" style={{ marginTop: 4 }}>Decision note: {r.decision_note}</div>}

            {open && canDecide && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--hair,#e7e2d6)', paddingTop: 10 }}>
                {ownRequest ? (
                  <div className="muted small">You requested this exception — another super-admin must approve or deny it.</div>
                ) : (
                  <>
                    <textarea className="input" rows={2} style={{ width: '100%' }}
                      placeholder="Decision note (required) — e.g. approved: strong primary guarantor; low LTV."
                      value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn primary small" disabled={busy === r.id || !(notes[r.id] || '').trim()} onClick={() => decide(r, 'approved')}>
                        {busy === r.id ? 'Saving…' : 'Approve waiver'}
                      </button>
                      <button className="btn ghost small" disabled={busy === r.id || !(notes[r.id] || '').trim()} onClick={() => decide(r, 'denied')}>
                        Deny
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {open && !canDecide && <div className="muted small" style={{ marginTop: 8 }}>Only a super-admin can approve or deny this request.</div>}
          </div>
        );
      })}
    </div>
  );
}
