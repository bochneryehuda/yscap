import React from 'react';
import { Link } from 'react-router-dom';
import ExceptionComments from './ExceptionComments.jsx';
import ExceptionConditions from './ExceptionConditions.jsx';

/* One exception row, shared by the super-admin Exceptions box (StaffExceptions)
   and the loan-officer "My exceptions" queue (StaffMyExceptions). Renders the
   file identity + rich detail + one-click deep-links into the file (and the exact
   section), the default-vs-requested policy, the reason/note, and the lifecycle
   trail. The mode-specific actions (approve/deny/clear/withdraw) are passed as
   `children` so each screen supplies its own. Owner-directed 2026-07-22. */

export const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US');
export function fmtAddr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1 || a.address || a.oneLine, a.city, a.state].filter(Boolean).join(', ');
}
export function fmtWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return ''; }
}
export const STATUS_TONE = { requested: 'warn', approved: 'ok', denied: 'err', withdrawn: '', cleared: '' };
export const STATUS_LABEL = { requested: 'Awaiting review', approved: 'Approved', denied: 'Denied', withdrawn: 'Withdrawn', cleared: 'Cleared' };

// Per-type presentation: the default policy vs. the requested change, and where in
// the file the controls live. Keeps the card generic across exception types (the
// table was built with an exception_type discriminator).
const TYPE_META = {
  guaranty_waiver: {
    jumpHash: '#sec-pricing', jumpLabel: 'Jump to the guaranty',
    defaultPolicy: () => 'Full recourse — both borrowers personally guarantee.',
    requestedChange: (subject) => <>Waive <b>{subject}</b>’s personal guarantee — {subject} becomes a non-guarantor member; the primary borrower remains sole guarantor.</>,
  },
  esign_before_ctc: {
    jumpHash: '#sec-esign', jumpLabel: 'Jump to e-sign',
    defaultPolicy: () => 'A term-sheet package sends only once the file is ready for clear-to-close (appraisal back · reviewed · re-priced · closing date · registration current).',
    requestedChange: () => <>Send the <b>term-sheet package</b> for signature <b>before clear-to-close</b>. The appraisal / pricing / closing-date / registration prerequisites still apply — this waives only the remaining readiness (the internal appraisal review).</>,
  },
};

export default function ExceptionCard({ r, reasonCodes = {}, highlight = false, forwardRef, children }) {
  const type = r.type || r.exception_type || 'guaranty_waiver';
  const meta = TYPE_META[type] || TYPE_META.guaranty_waiver;
  const subject = [r.subject_first, r.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
  const borrower = [r.first_name, r.last_name].filter(Boolean).join(' ');
  // Prefer the server-computed per-type reason label; fall back to the passed map.
  const reasonLabel = r.reason_label || reasonCodes[r.reason_code] || r.reason_code || '—';
  const appId = r.application_id;
  // Deep-links: each exception type points at the section holding its controls.
  // The trailing "#sec-*" is matched by StaffApplication's section-open handler.
  const link = (hash) => `/internal/app/${appId}${hash || ''}`;

  return (
    <div ref={forwardRef}
      className="panel" style={{ marginBottom: 12, outline: highlight ? '2px solid #AE8746' : 'none', transition: 'outline .3s' }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Link to={link()} style={{ fontWeight: 600 }}>
            {borrower || 'File'}{r.ys_loan_number ? ` · ${r.ys_loan_number}` : ''}
          </Link>
          <div className="muted small">{fmtAddr(r.property_address)}{r.loan_amount != null ? ` · ${money(r.loan_amount)}` : ''}{r.file_status ? ` · ${String(r.file_status).replace(/_/g, ' ')}` : ''}</div>
        </div>
        <span className={`ts-badge ${STATUS_TONE[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>
      </div>

      {/* One-click entry points into the file (and the exact section). */}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <Link className="btn ghost small" to={link()}>Open file</Link>
        <Link className="btn ghost small" to={link(meta.jumpHash)}>{meta.jumpLabel}</Link>
        <Link className="btn ghost small" to={link('#sec-conditions')}>Conditions</Link>
        <Link className="btn ghost small" to={link('#sec-documents')}>Documents</Link>
      </div>

      {/* Exactly what the exception is — default policy vs. requested change. */}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        <div style={{ flex: '1 1 220px' }}>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Default policy</div>
          <div>{meta.defaultPolicy()}</div>
        </div>
        <div style={{ flex: '1 1 220px' }}>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Requested change</div>
          <div>{meta.requestedChange(subject)}</div>
        </div>
      </div>

      <div className="metrow" style={{ marginTop: 8 }}><span className="k">Reason</span><span className="v">{reasonLabel}</span></div>
      {r.reason_note && <div className="notice" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.reason_note}</div>}

      <div className="muted small" style={{ marginTop: 6 }}>
        {r.requested_by_name && <>Requested by {r.requested_by_name} · </>}{fmtWhen(r.requested_at || r.created_at)}
        {r.decided_at && <> · {r.status === 'approved' ? 'Approved' : r.status === 'denied' ? 'Denied' : 'Decided'} by {r.decided_by_name || 'a super-admin'} · {fmtWhen(r.decided_at)}</>}
        {r.cleared_at && <> · Cleared · {fmtWhen(r.cleared_at)}</>}
      </div>
      {r.status !== 'requested' && r.decision_note && <div className="muted small" style={{ marginTop: 4 }}>Decision note: {r.decision_note}</div>}

      {children}

      {/* Documents + conditions attached to the exception (request + track paperwork). */}
      <ExceptionConditions exceptionId={r.id} appId={appId} />

      {/* Staff-only back-and-forth on the exception (requester ↔ reviewer). */}
      <ExceptionComments exceptionId={r.id} />
    </div>
  );
}
