import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import ExceptionCard from '../components/ExceptionCard.jsx';

/* Loan policy EXCEPTIONS — the review box (owner-directed 2026-07-22; redesigned
 * 2026-07-24, docs/EXCEPTION-WORKFLOW-REDESIGN.md).
 *
 * ONE register for every exception type: guaranty waiver, send-before-CTC,
 * pricing/guideline exception, and recorded issuance overrides. Any staff member
 * requests on the file; a super-admin approves or denies here (required note,
 * optional approval validity on time-boxable types), and either party CLEARS
 * (archives) a handled one — an OPEN request can't be cleared, only withdrawn
 * or decided. The summary strip shows the register report (open/overdue/oldest,
 * approval rate); the register exports to a spreadsheet for loan-sale /
 * diligence conversations. The approver can't decide their own request
 * (server-enforced; buttons disabled here too). */

export default function StaffExceptions() {
  const { role } = useAuth();
  const location = useLocation();
  const focusAppId = new URLSearchParams(location.search).get('app') || '';

  const [rows, setRows] = useState([]);
  const [reasonCodes, setReasonCodes] = useState({});
  const [reasonCodesByType, setReasonCodesByType] = useState({});
  const [typeLabels, setTypeLabels] = useState({});
  const [expirableTypes, setExpirableTypes] = useState([]);
  const [compFactors, setCompFactors] = useState({});
  const [actorId, setActorId] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [typeFilter, setTypeFilter] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [canDecide, setCanDecide] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [notes, setNotes] = useState({});
  // Optional approval validity (per row, yyyy-mm-dd) for expirable types.
  const [validUntil, setValidUntil] = useState({});
  // Per-row waive selection for send-before-clear-to-close requests (2026-07-24):
  // rowId -> array of blocker codes the super-admin is waiving. Initialized by
  // EsignGatePanel with the safe default (readiness items only).
  const [waiveSel, setWaiveSel] = useState({});
  const [highlightId, setHighlightId] = useState('');
  const rowRefs = useRef({});

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const load = () => api.loanExceptions(statusFilter, typeFilter || undefined)
    .then((d) => {
      setRows(d.exceptions || []);
      setPendingCount(d.pendingCount || 0);
      setCanDecide(!!d.canDecide);
      setReasonCodes(d.reasonCodes || {});
      setReasonCodesByType(d.reasonCodesByType || {});
      setTypeLabels(d.typeLabels || {});
      setExpirableTypes(d.expirableTypes || []);
      setCompFactors(d.compensatingFactors || {});
      setActorId(d.actorId || '');
    })
    .catch((e) => flash(false, (e && e.message) || 'could not load exceptions'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter, typeFilter]);
  // The register report loads once (aggregate counts — cheap and stable).
  useEffect(() => { api.loanExceptionMetrics().then((d) => setMetrics(d.metrics || null)).catch(() => {}); }, []);

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
    const type = row.type || row.exception_type;
    const isEsign = type === 'esign_before_ctc';
    // An esign APPROVAL must name exactly what it waives — everything unchecked
    // still applies. The server re-validates against the live gate.
    const waived = isEsign && decision === 'approved' ? (waiveSel[row.id] || []) : undefined;
    if (isEsign && decision === 'approved' && !waived.length) {
      flash(false, 'Tick at least one requirement to waive in the picture above — or deny the request.');
      return;
    }
    // Optional validity on expirable types (yyyy-mm-dd → end of that day, local).
    let expiresAt;
    if (decision === 'approved' && expirableTypes.includes(type) && (validUntil[row.id] || '').trim()) {
      const d = new Date(`${validUntil[row.id]}T23:59:59`);
      if (!isFinite(d.getTime()) || d.getTime() <= Date.now()) {
        flash(false, 'The “valid until” date must be in the future (or leave it blank for no expiry).');
        return;
      }
      expiresAt = d.toISOString();
    }
    setBusy(row.id);
    try {
      await api.decideLoanException(row.id, decision, note, waived, expiresAt);
      flash(true, isEsign
        ? (decision === 'approved'
            ? `Approved with ${waived.length} requirement${waived.length === 1 ? '' : 's'} waived. Everything not waived still applies before the package can send.`
            : 'Denied. The package can be sent once the outstanding items are done.')
        : type === 'pricing_exception'
          ? (decision === 'approved'
              ? 'Pricing exception approved (recorded). To put it into effect, apply the approved terms in the Term Sheet Studio and re-register the file.'
              : 'Pricing exception denied. The registered product stands as the program prices it.')
          : (decision === 'approved'
              ? 'Waiver approved. The co-borrower now shows as a member (non-guarantor); re-issue the term sheet to reflect it.'
              : 'Waiver denied. Both borrowers remain personal guarantors.'));
      await load();
    } catch (e) { flash(false, (e && e.message) || 'could not record the decision'); }
    finally { setBusy(''); }
  }

  async function clear(row) {
    // The clear note is asked for HERE — never silently reused from the decision
    // textarea (typing a decision rationale then clearing used to store it as the
    // clear note).
    const note = window.prompt('Optional note for the archive (why this is being cleared):', '');
    if (note === null) return; // cancelled
    setBusy(row.id);
    try {
      await api.clearLoanException(row.id, note || '');
      flash(true, 'Exception cleared.');
      await load();
    } catch (e) { flash(false, (e && e.message) || 'could not clear the exception'); }
    finally { setBusy(''); }
  }

  async function exportRegister() {
    try { await api.exportExceptionRegister(statusFilter === 'open' ? 'all' : statusFilter, typeFilter || undefined); }
    catch (e) { flash(false, (e && e.message) || 'could not export the register'); }
  }

  const filters = ['open', 'approved', 'denied', 'withdrawn', 'expired', 'cleared', 'all'];
  const filterLabel = { open: 'Awaiting review', approved: 'Approved', denied: 'Denied', withdrawn: 'Withdrawn', expired: 'Expired', cleared: 'Cleared', all: 'All' };
  const typeChips = [['', 'All types'], ...Object.entries(typeLabels)];

  // The register report strip (aggregates only — no borrower data). Approval
  // rate over legible decisions (approved/expired vs denied — the server
  // excludes archived rows whose decision is no longer readable); "typical
  // decision time" is the per-type medians weighted by how many each type
  // decided (an honest blend, not a raw mean of medians).
  const agg = metrics && metrics.openAging;
  const rates = (metrics && metrics.timing) || [];
  const rateN = rates.reduce((s, t) => s + ((t.approved || 0) + (t.denied || 0)), 0);
  const overallApproved = rates.reduce((s, t) => s + (t.approved || 0), 0);
  const wSum = rates.reduce((s, t) => s + ((t.medianHours != null && t.decided) ? t.medianHours * t.decided : 0), 0);
  const wN = rates.reduce((s, t) => s + ((t.medianHours != null && t.decided) ? t.decided : 0), 0);

  return (
    <div className="wrap" style={{ maxWidth: 940 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Exceptions</h1>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} awaiting review</span>}
          <button className="btn ghost small" onClick={exportRegister} title="Download the exception register as a spreadsheet — the log you hand a note buyer / diligence reviewer.">Export register</button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Every request to deviate from a loan policy, in one place — waiving a co-borrower’s personal guarantee,
        sending a term-sheet package early, a pricing/guideline exception, and recorded admin overrides. {canDecide
          ? 'Approve or deny with a short note; on time-boxable types you can set how long the approval stays valid. Clear an exception when it’s handled. You can’t approve your own request — another admin does that.'
          : 'You can review the queue and comment; an admin approves or denies.'}
      </p>
      <div className="notice" style={{ marginTop: 4, marginBottom: 4 }}>
        <b>Not the same as “Manual / Escalations.”</b> That box is only for pricing a deal <b>outside the guidelines</b>
        {' '}(custom leverage / below-minimum) with the counter-offer haggle. Everything else — guaranty waivers, early
        sends, one-off pricing/guideline exceptions, overrides — is <b>here</b>. → <Link to="/internal/escalations">Open Manual / Escalations</Link>
      </div>

      {/* The register report — how many, how fast, how often granted. */}
      {metrics && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', margin: '10px 0', padding: '10px 12px', border: '1px solid var(--hair,#e7e2d6)', borderRadius: 10 }}>
          <div><div className="muted small">Open now</div><div style={{ fontWeight: 700 }}>{agg ? agg.open : 0}</div></div>
          <div><div className="muted small">Past review target</div><div style={{ fontWeight: 700, color: agg && agg.overdue ? '#a33' : undefined }}>{agg ? agg.overdue : 0}</div></div>
          <div><div className="muted small">Oldest waiting</div><div style={{ fontWeight: 700 }}>{agg && agg.oldestHours != null ? (agg.oldestHours >= 48 ? `${Math.floor(agg.oldestHours / 24)}d` : `${Math.round(agg.oldestHours)}h`) : '—'}</div></div>
          <div><div className="muted small">Approval rate (all time)</div><div style={{ fontWeight: 700 }}>{rateN ? `${Math.round((overallApproved / rateN) * 100)}%` : '—'}</div></div>
          <div><div className="muted small">Typical decision time</div><div style={{ fontWeight: 700 }}>{wN ? `${Math.round(wSum / wN)}h` : '—'}</div></div>
        </div>
      )}

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '12px 0 4px' }}>
        {filters.map((f) => (
          <button key={f} className={`btn small ${statusFilter === f ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(f)}>
            {filterLabel[f]}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '0 0 12px' }}>
        {typeChips.map(([k, label]) => (
          <button key={k || 'all'} className={`btn small ${typeFilter === k ? 'primary' : 'ghost'}`} onClick={() => setTypeFilter(k)}>
            {label}
          </button>
        ))}
      </div>

      {rows.length === 0 && <div className="notice">No exceptions {statusFilter === 'all' ? '' : `(${filterLabel[statusFilter].toLowerCase()})`}{typeFilter ? ` of that type` : ''} right now.</div>}

      {rows.map((r) => {
        const type = r.type || r.exception_type;
        const open = r.status === 'requested';
        const ownRequest = r.requested_by && actorId && r.requested_by === actorId;
        // An OPEN request can't be cleared (withdraw/decide first — server-enforced).
        const canClear = r.status !== 'cleared' && !open && (canDecide || ownRequest);
        const isEsign = type === 'esign_before_ctc';
        const perTypeReasons = reasonCodesByType[type] || reasonCodes;
        // The deciding super-admin picks which requirements to waive right in the
        // card's requirements picture; the selection lives here so Approve can
        // submit it. (EsignGatePanel only enables pickers when the server says
        // this actor can decide.)
        const gateSelect = isEsign && open && canDecide && !ownRequest
          ? { selected: waiveSel[r.id], onChange: (codes) => setWaiveSel((m) => ({ ...m, [r.id]: codes })) }
          : undefined;
        return (
          <ExceptionCard key={r.id} r={r} reasonCodes={perTypeReasons} compFactors={compFactors} gateSelect={gateSelect}
            highlight={highlightId === r.id} forwardRef={(el) => { rowRefs.current[r.id] = el; }}>
            {(open || canClear) ? (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--hair,#e7e2d6)', paddingTop: 10 }}>
                {open && canDecide && ownRequest && (
                  <div className="muted small" style={{ marginBottom: 6 }}>You requested this exception — another admin must approve or deny it (you can’t approve your own request).</div>
                )}
                {open && canDecide && !ownRequest && (
                  <>
                    <textarea className="input" rows={2} style={{ width: '100%' }}
                      placeholder="Decision note (required) — e.g. approved: strong primary guarantor; low LTV."
                      value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                    {expirableTypes.includes(type) && (
                      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <label className="muted small" htmlFor={`vu-${r.id}`}>Approval valid until (optional)</label>
                        <input id={`vu-${r.id}`} type="date" className="input" style={{ width: 170 }}
                          value={validUntil[r.id] || ''} onChange={(e) => setValidUntil((m) => ({ ...m, [r.id]: e.target.value }))} />
                        <span className="muted small">Past this date the approval expires on its own and grants nothing. Blank = no expiry.</span>
                      </div>
                    )}
                    {/* Buttons stay CLICKABLE even with an empty note — decide() flashes
                        "Add a short note" so a click always gives feedback instead of a
                        silently-greyed button that reads as "nothing happens". */}
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn primary small" disabled={busy === r.id} onClick={() => decide(r, 'approved')}>
                        {busy === r.id ? 'Saving…' : (isEsign || type === 'pricing_exception' ? 'Approve' : 'Approve waiver')}
                      </button>
                      <button className="btn ghost small" disabled={busy === r.id} onClick={() => decide(r, 'denied')}>Deny</button>
                    </div>
                  </>
                )}
                {/* A viewer who CAN'T decide (admin / non-super, or a non-requester
                    on someone else's open request) still gets a clear reason on the
                    row — previously this line lived inside a block that never rendered
                    for an admin on an open item, so the card showed no buttons AND no
                    explanation ("nothing happens"). */}
                {open && !canDecide && (
                  <div className="notice" style={{ marginBottom: 0 }}>
                    Approving or denying an exception needs the <b>Manage pricing</b> permission (Admins &amp; Super
                    Admins have it). You’re signed in as <b>{(role || 'staff').replace(/_/g, ' ')}</b>, so you can
                    review it here and add a comment — an admin makes the decision.
                    {ownRequest ? ' You can withdraw it from “My exceptions”.' : ''}
                  </div>
                )}
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
