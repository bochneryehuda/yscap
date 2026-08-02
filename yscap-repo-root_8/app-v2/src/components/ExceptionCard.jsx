import React from 'react';
import { Link } from 'react-router-dom';
import ExceptionComments from './ExceptionComments.jsx';
import ExceptionConditions from './ExceptionConditions.jsx';
import EsignGatePanel from './EsignGatePanel.jsx';
import { fullNameOf } from '../lib/personName.js';

/* One exception row, shared by the super-admin Exceptions box (StaffExceptions),
   the loan-officer "My exceptions" queue (StaffMyExceptions), and the file's
   exception register. Renders the file identity + rich detail + one-click
   deep-links into the file (and the exact section), the default-vs-requested
   policy, the reason/note, compensating factors, the EX-n reference, review
   aging, approval validity/expiry, deal-drift advisories, and the lifecycle
   trail. The mode-specific actions (approve/deny/clear/withdraw) are passed as
   `children` so each screen supplies its own. Owner-directed 2026-07-22;
   redesigned 2026-07-24 (docs/EXCEPTION-WORKFLOW-REDESIGN.md). */

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
export function fmtDay(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (_) { return ''; }
}
export const STATUS_TONE = { requested: 'warn', approved: 'ok', denied: 'err', withdrawn: '', cleared: '', expired: 'err' };
export const STATUS_LABEL = { requested: 'Awaiting review', approved: 'Approved', denied: 'Denied', withdrawn: 'Withdrawn', cleared: 'Cleared', expired: 'Expired' };

// How long an open request has been waiting, and whether it's past its review
// target. Returns null for anything not open.
export function agingOf(r) {
  if (!r || r.status !== 'requested') return null;
  const start = new Date(r.requested_at || r.created_at).getTime();
  if (!isFinite(start)) return null;
  const hours = Math.max(0, (Date.now() - start) / 3600000);
  const overdue = r.due_at ? Date.now() > new Date(r.due_at).getTime() : false;
  const label = hours >= 48 ? `waiting ${Math.floor(hours / 24)}d` : hours >= 1 ? `waiting ${Math.round(hours)}h` : 'just now';
  return { hours, overdue, label };
}

const DRIFT_LABEL = { loan_amount: 'Loan amount', purchase_price: 'Purchase price', rehab_budget: 'Rehab budget', arv: 'ARV' };

// Per-type presentation: the default policy vs. the requested change, and where in
// the file the controls live. Keeps the card generic across exception types (the
// table was built with an exception_type discriminator).
const TYPE_META = {
  guaranty_waiver: {
    chip: 'Guaranty waiver',
    jumpHash: '#sec-pricing', jumpLabel: 'Jump to the guaranty',
    defaultPolicy: () => 'Full recourse — both borrowers personally guarantee.',
    requestedChange: (subject) => <>Waive <b>{subject}</b>’s personal guarantee — {subject} becomes a non-guarantor member; the primary borrower remains sole guarantor.</>,
  },
  esign_before_ctc: {
    chip: 'Send before CTC',
    jumpHash: '#sec-esign', jumpLabel: 'Jump to e-sign',
    defaultPolicy: () => 'A term-sheet package sends only once every send requirement is met (appraisal back · reviewed · re-priced · closing date · registration current).',
    requestedChange: () => <>Send the <b>term-sheet package</b> for signature <b>before every send requirement is met</b>. The requirements picture below shows what’s done and what’s outstanding — a super-admin chooses exactly which outstanding requirements to waive, and <b>everything not waived still applies</b>.</>,
  },
  pricing_exception: {
    chip: 'Pricing exception',
    jumpHash: '#sec-pricing', jumpLabel: 'Jump to pricing',
    defaultPolicy: () => 'The registered product prices exactly as the program guidelines size it — caps, minimums, leverage and tiers all apply.',
    requestedChange: () => <>Make a <b>pricing / guideline exception</b> for this deal (finance more of an assignment fee, leverage, loan size, experience tier…). Approving records the DECISION — a super-admin then applies the approved terms in the <b>Term Sheet Studio</b> (admin override) and re-registers the file; the approval itself changes no numbers.</>,
  },
  oop_rehab: {
    chip: 'Out-of-pocket rehab',
    jumpHash: '#sec-pricing', jumpLabel: 'Jump to pricing',
    defaultPolicy: () => 'Every program finances 100% of the rehab — when a cap cuts the loan, the initial advance is reduced and no rehab is paid out of pocket.',
    requestedChange: () => <>Raise the <b>initial advance</b> toward its cap and bring the displaced rehab <b>out of pocket</b> (the borrower funds part of the rehab over construction). The <b>total loan, rate and every cap stay the same</b>. Approving records the DECISION — a super-admin then enters the approved out-of-pocket amount in the <b>Term Sheet Studio</b> and re-registers; the approval itself changes no numbers.</>,
  },
  issuance_override: {
    chip: 'Recorded override',
    jumpHash: '#sec-underwriting', jumpLabel: 'Jump to findings',
    defaultPolicy: () => 'A confirmed-fatal finding raises a hard warning before a status move / issuance, pausing it for a super-admin.',
    requestedChange: () => <>A <b>super-admin proceeded past a fatal hard-warning</b> (status change or document issuance). This is the record of that override — it was decided in the moment, so there was nothing to approve here.</>,
  },
  appraisal_xml_waiver: {
    chip: 'Appraisal — no XML',
    jumpHash: '#sec-appraisal', jumpLabel: 'Jump to the appraisal',
    defaultPolicy: () => 'The appraisal condition needs the XML data file, the PDF report, and a successful MISMO import.',
    requestedChange: () => <>Accept this appraisal with <b>no XML data file</b> — the PDF report is still required and the ARV + As-Is were entered by hand. Approving lets the appraisal condition be signed off without the XML.</>,
  },
  encompass_mismatch: {
    chip: 'Encompass exception',
    jumpHash: '#sec-encompass', jumpLabel: 'Jump to Encompass sync',
    defaultPolicy: () => 'Every field must match the Encompass loan copy before the term sheet can be issued.',
    requestedChange: () => <>A <b>super-admin excepted an Encompass field</b> that does not match (or has no data on one side) so it no longer holds the term sheet. This is the record of that grant — it was decided on the Encompass sync panel. The note names the field and both values.</>,
  },
};

export default function ExceptionCard({ r, reasonCodes = {}, compFactors = {}, highlight = false, forwardRef, gateSelect, children }) {
  const type = r.type || r.exception_type || 'guaranty_waiver';
  const meta = TYPE_META[type] || TYPE_META.guaranty_waiver;
  const subject = [r.subject_first, r.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
  const borrower = fullNameOf(r);
  // Prefer the server-computed per-type reason label; fall back to the passed map.
  const reasonLabel = r.reason_label || reasonCodes[r.reason_code] || r.reason_code || '—';
  const appId = r.application_id;
  const aging = agingOf(r);
  const drift = Array.isArray(r.deal_drift) ? r.deal_drift : [];
  const factors = Array.isArray(r.compensating_factors) ? r.compensating_factors : [];
  // Requester line: a staff name, or the borrower themselves (pricing asks can
  // come from the borrower portal), or blank for legacy rows.
  const requesterName = r.requested_by_kind === 'borrower'
    ? 'the borrower' : (r.requested_by_name || null);
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
        <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {r.exception_seq != null && <span className="ts-badge" title="The exception's reference number — quote it in loan-sale / investor conversations.">EX-{r.exception_seq}</span>}
          <span className="ts-badge">{meta.chip}</span>
          {r.severity === 'material' && <span className="ts-badge warn" title="A material deviation — expect extra scrutiny in diligence.">Material</span>}
          {aging && <span className={`ts-badge ${aging.overdue ? 'err' : ''}`} title={aging.overdue ? 'Past the review target — a super-admin should decide it.' : 'How long this has been waiting for a decision.'}>{aging.overdue ? `overdue · ${aging.label}` : aging.label}</span>}
          <span className={`ts-badge ${STATUS_TONE[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>
        </div>
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

      {/* Compensating factors — what offsets the risk (the diligence answer to
          "what did we accept in exchange"). */}
      {factors.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Compensating factors</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {factors.map((f, i) => (
              <span key={i} className="ts-badge ok" title={f.note || ''}>
                {compFactors[f.code] || f.code}{f.note ? ` — ${f.note}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* The re-request chain: this ask follows a prior denied/withdrawn/expired one. */}
      {r.re_request_of && (
        <div className="muted small" style={{ marginTop: 6 }}>
          ↻ This is a renewed request — it follows an earlier one on this file that was denied, withdrawn, or expired.
        </div>
      )}

      {/* Deal drift — the economics moved since the request snapshot. Advisory:
          the reviewer/team re-checks before relying on the request/approval. */}
      {drift.length > 0 && r.status !== 'cleared' && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          <b>The deal changed since this was requested:</b>{' '}
          {drift.map((d, i) => (
            <span key={d.field}>{i > 0 ? ' · ' : ''}{DRIFT_LABEL[d.field] || d.field} {money(d.was)} → {money(d.now)}</span>
          ))}
          . Re-check the ask against today’s numbers before relying on it.
        </div>
      )}

      {/* Approval validity / expiry. */}
      {r.status === 'approved' && r.expires_at && (
        <div className="muted small" style={{ marginTop: 6 }}>
          ⏳ Approval valid until <b>{fmtDay(r.expires_at)}</b> — past that it expires on its own and grants nothing.
        </div>
      )}
      {r.status === 'expired' && (
        <div className="notice err" style={{ marginTop: 8 }}>
          This approval passed its validity date{r.expires_at ? ` (${fmtDay(r.expires_at)})` : ''} and has EXPIRED — it no longer grants anything. If it’s still needed, request it again for a fresh review.
        </div>
      )}

      {/* Send-before-clear-to-close: the CLEAR VIEW — every requirement ✓/✗, what
          the approval waived, and (for a deciding super-admin) the waive pickers. */}
      {type === 'esign_before_ctc' && <EsignGatePanel exceptionId={r.id} status={r.status} select={gateSelect} />}

      <div className="muted small" style={{ marginTop: 6 }}>
        {requesterName && <>Requested by {requesterName} · </>}{fmtWhen(r.requested_at || r.created_at)}
        {r.status === 'withdrawn' && (r.withdrawn_at || r.withdrawn_by_name) ? (
          <> · Withdrawn{r.withdrawn_by_name ? ` by ${r.withdrawn_by_name}` : ''} · {fmtWhen(r.withdrawn_at)}</>
        ) : r.decided_at && (
          <> · {r.status === 'approved' ? 'Approved' : r.status === 'denied' ? 'Denied' : r.status === 'expired' ? 'Approved' : r.status === 'withdrawn' ? 'Withdrawn' : 'Decided'} by {r.decided_by_name || 'a super-admin'} · {fmtWhen(r.decided_at)}</>
        )}
        {r.expired_at && <> · Expired · {fmtWhen(r.expired_at)}</>}
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
