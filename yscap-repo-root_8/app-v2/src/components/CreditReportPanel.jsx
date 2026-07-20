import React, { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import CreditReportDetail from './CreditReportDetail.jsx';

/* Per-file staff credit section: pull / reissue a credit report and view the
   imported reports (representative FICO + bracket, per-bureau scores, the PDF,
   and any manual-review reason). Ordering is a BILLABLE action gated on the
   pull_credit capability; the default is the soft-pull Pre-Qualification reissue
   the shop runs day to day, switchable to a brand-new order or a hard pull. */

const STATUS_BADGE = {
  imported: { text: 'Imported', cls: 'ok' },
  review: { text: 'Needs review', cls: 'err' },
  error: { text: 'Error', cls: 'err' },
  ordering: { text: 'In progress…', cls: '' },
};

// Friendly title per finding type.
const FINDING_TITLE = {
  fico_mismatch: 'FICO does not match the file',
  fraud_alert: 'Fraud alert',
  active_duty: 'Active-duty military alert',
  deceased: 'Deceased / SSA Death Master flag',
  ofac: 'OFAC / SDN match',
  ssn_alert: 'SSN alert',
  address_discrepancy: 'Address discrepancy',
  high_risk_score: 'High-risk fraud score',
  security_freeze: 'Security freeze',
  consumer_statement: 'Consumer statement',
  id_ssn_mismatch: 'SSN does not match the file',
  id_dob_mismatch: 'Date of birth does not match the file',
  id_name_mismatch: 'Name does not match the file',
  other: 'Credit-file alert',
};

/* Normalize whatever is stored on the report into a findings[] list — accepts the
   new wrapper {severity,types,message,findings[]} AND the pre-E2 single-finding
   shape, so old reports still render. */
function normalizeFindings(finding) {
  if (!finding || typeof finding !== 'object') return [];
  if (Array.isArray(finding.findings)) return finding.findings;
  if (finding.severity || finding.type) return [finding];
  return [];
}

/* One finding row: title + severity chip + message, the FICO per-borrower
   breakdown when present, and (for an active fatal finding) a per-finding
   reconcile control. OFAC / deceased are compliance-only — only an admin may
   clear them (the server enforces this too). */
function FindingRow({ f, report, wholeReconciled, mayReconcile, isAdmin, onReconciled }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fatal = f.severity === 'fatal';
  const cleared = wholeReconciled || f.reconciled;
  const complianceOnly = f.reconcilableBy === 'compliance';
  const canClear = mayReconcile && (!complianceOnly || isAdmin);

  const rows = Array.isArray(f.perBorrower) && f.perBorrower.length > 0
    ? f.perBorrower
    : (f.type === 'fico_mismatch' && (f.claimed != null || f.verified != null)
        ? [{ name: 'Representative', claimed: f.claimed, claimedBracket: f.claimedBracket, verified: f.verified, verifiedBracket: f.verifiedBracket }]
        : []);

  async function reconcile(undo) {
    setErr(''); setBusy(true);
    try {
      await api.creditReconcileFinding({ creditReportId: report.id, findingType: f.type, note: undo ? undefined : note.trim(), undo });
      setOpen(false); setNote('');
      if (onReconciled) await onReconciled();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ borderLeft: `3px solid var(--${fatal && !cleared ? 'danger' : cleared ? 'teal' : 'gold'})`, paddingLeft: 8 }}>
      <div>
        <span className="tchip" style={{ borderColor: fatal ? 'var(--danger)' : 'var(--gold)', marginRight: 6 }}>
          {fatal ? 'FATAL' : 'Alert'}
        </span>
        <strong>{FINDING_TITLE[f.type] || f.type}</strong>
        {cleared && <span className="muted small" style={{ marginLeft: 6 }}>· reconciled</span>}
      </div>
      {f.message && <div className="small" style={{ marginTop: 2 }}>{f.message}</div>}
      {rows.length > 0 && (
        <ul style={{ margin: '4px 0 0 18px' }} className="small">
          {rows.map((b, i) => (
            <li key={i}>
              {b.name}: file <strong>{b.claimed != null ? b.claimed : '—'}</strong> ({b.claimedBracket || 'bracket —'}) → verified <strong>{b.verified != null ? b.verified : '—'}</strong> ({b.verifiedBracket || 'bracket —'})
            </li>
          ))}
        </ul>
      )}
      {fatal && !cleared && (
        <div style={{ marginTop: 4 }}>
          {complianceOnly && !isAdmin && (
            <div className="muted small">This is a compliance finding — only an admin can clear it, after a documented review.</div>
          )}
          {canClear && !open && (
            <button className="btn ghost small" onClick={() => setOpen(true)}>Reconcile…</button>
          )}
          {canClear && open && (
            <div style={{ marginTop: 4 }}>
              <input className="input" value={note} onChange={e => setNote(e.target.value)}
                placeholder="Reason (required) — how this finding was resolved" />
              <div className="row" style={{ marginTop: 4, gap: 6 }}>
                <button className="btn primary small" disabled={busy || !note.trim()} onClick={() => reconcile(false)}>{busy ? 'Saving…' : 'Confirm reconcile'}</button>
                <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
              </div>
            </div>
          )}
          {err && <div className="notice err small" style={{ marginTop: 4 }}>{err}</div>}
        </div>
      )}
      {f.reconciled && !wholeReconciled && canClear && (
        <button className="btn ghost small" style={{ marginTop: 4 }} disabled={busy} onClick={() => reconcile(true)}>Undo</button>
      )}
    </div>
  );
}

/* Underwriting findings: a LIST of things a human must look at on this report — a
   FICO that doesn't match the file, and/or the bureau's own fraud / OFAC /
   deceased / SSN / address alerts. Any active FATAL finding HARD-blocks completing
   the credit condition (server-enforced) until the file is corrected + re-pulled
   OR the finding is reconciled (a documented exception). */
function FindingBanner({ finding, report, mayReconcile, onReconciled }) {
  const { role } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const list = normalizeFindings(finding);
  if (!list.length) return null;
  const wholeReconciled = report && report.underwriting_finding_reconciled_at;
  const activeFatal = list.filter((f) => f.severity === 'fatal' && !f.reconciled && !wholeReconciled);
  const anyFatal = list.some((f) => f.severity === 'fatal');
  const tone = activeFatal.length ? 'err' : (anyFatal ? 'ok' : '');   // '' = base notice (no .warn class exists)
  const header = activeFatal.length
    ? `⚠ ${activeFatal.length} underwriting finding${activeFatal.length > 1 ? 's' : ''} must be reviewed — the credit condition is blocked`
    : (anyFatal ? '✓ Underwriting findings reconciled — the credit condition can be signed off' : 'ⓘ Credit-file alerts');

  return (
    <div className={`notice ${tone}`} style={{ marginTop: 8, borderLeft: `4px solid var(--${activeFatal.length ? 'danger' : anyFatal ? 'teal' : 'gold'})` }} role="alert">
      <strong>{header}</strong>
      <div style={{ marginTop: 6, display: 'grid', gap: 8 }}>
        {list.map((f, i) => (
          <FindingRow key={i} f={f} report={report} wholeReconciled={wholeReconciled}
            mayReconcile={mayReconcile} isAdmin={isAdmin} onReconciled={onReconciled} />
        ))}
      </div>
      {wholeReconciled && (
        <div className="muted small" style={{ marginTop: 6 }}>
          All findings on this report were reconciled together{report.underwriting_finding_reconcile_note ? ` — ${report.underwriting_finding_reconcile_note}` : ''}.
        </div>
      )}
      {activeFatal.length > 0 && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Fix the file and re-pull the report, or reconcile each finding above — either clears the credit condition for sign-off.
        </div>
      )}
    </div>
  );
}

/* One bureau's score with its model, date, and (when excluded) the reason. */
function BureauLine({ s }) {
  const factors = Array.isArray(s.factors) ? s.factors.filter((f) => f && (f.text || f.code)) : [];
  return (
    <div style={{ marginTop: 3 }}>
      <span className="tchip" title={s.model || ''}
        style={{ borderColor: s.usable ? 'var(--teal)' : 'var(--muted)' }}>
        {s.bureau}: <strong>{s.usable && s.value != null ? s.value : '—'}</strong>
      </span>
      {s.model && <span className="muted small" style={{ marginLeft: 6 }}>{s.model}</span>}
      {s.score_date && <span className="muted small" style={{ marginLeft: 6 }}>· {s.score_date}</span>}
      {!s.usable && (s.exclusion_reason || s.reason) && (
        <span className="small" style={{ marginLeft: 6, color: 'var(--danger)' }}>({s.exclusion_reason || s.reason})</span>
      )}
      {factors.length > 0 && (
        <div className="muted small" style={{ marginLeft: 6, marginTop: 2 }}>
          Factors: {factors.map((f) => f.text || f.code).join('; ')}
        </div>
      )}
    </div>
  );
}

function ReportRow({ r, mayReconcile, onChanged }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const badge = STATUS_BADGE[r.status] || { text: r.status, cls: '' };
  // The full-report detail (tradelines/alerts/identity) exists only once a report
  // has been imported or routed to review — not while it is still ordering.
  const hasDetail = r.status === 'imported' || r.status === 'review';
  // group scores by report borrower id (joint → one block each)
  const byBorrower = new Map();
  for (const s of (r.scores || [])) {
    const k = s.report_borrower_id || '—';
    if (!byBorrower.has(k)) byBorrower.set(k, []);
    byBorrower.get(k).push(s);
  }
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{r.action_type || 'Order'}</strong>{' '}
          <span className="muted small">
            {r.other_description || r.report_type}{r.first_issued_date ? ` · ${r.first_issued_date}` : ''}
            {r.mismo_version ? ` · MISMO ${r.mismo_version}` : ''}
          </span>
        </div>
        <span className={`notice ${badge.cls}`} style={{ padding: '2px 8px', fontSize: 12 }}>{badge.text}</span>
      </div>

      <FindingBanner finding={r.underwriting_finding} report={r} mayReconcile={mayReconcile} onReconciled={onChanged} />

      {r.representative_score != null && (
        <div style={{ marginTop: 6 }}>
          Representative FICO: <strong style={{ fontSize: 16 }}>{r.representative_score}</strong>{' '}
          <span className="muted small">({r.representative_bracket})</span>
          <span className="muted small"> — the highest of the borrowers’ middle scores</span>
        </div>
      )}
      {r.bureau_status && r.bureau_status.perBureau && (
        <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted small">{r.bureau_status.scoredCount}/{r.bureau_status.requested} bureaus:</span>
          {Object.entries(r.bureau_status.perBureau).map(([b, st]) => (
            <span key={b} className="tchip" title={st}
              style={{ borderColor: st === 'scored' ? 'var(--teal)' : st === 'excluded' || st === 'no_score' ? 'var(--danger)' : 'var(--muted)' }}>
              {b[0].toUpperCase() + b.slice(1)}: {st === 'scored' ? '✓' : st === 'returned' ? '·' : st.replace('_', ' ')}
            </span>
          ))}
        </div>
      )}
      {r.status === 'review' && r.review_reason && (
        <div className="notice err" style={{ marginTop: 6 }}>Manual review: {r.review_reason}</div>
      )}

      {[...byBorrower.entries()].map(([bid, scores]) => (
        <div key={bid} style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--hair)' }}>
          <div className="muted small" style={{ fontWeight: 600 }}>Borrower {bid}</div>
          {scores.map((s, i) => <BureauLine key={i} s={s} />)}
        </div>
      ))}

      {(hasDetail || r.pdf_document_id) && (
        <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
          {hasDetail && (
            <button className="btn ghost" onClick={() => setDetailOpen(true)}>View full report</button>
          )}
          {r.pdf_document_id && (
            <a className="btn ghost" href={api.creditReportPdfUrl(r.id)} target="_blank" rel="noopener noreferrer">Open full report PDF</a>
          )}
        </div>
      )}
      {detailOpen && <CreditReportDetail reportId={r.id} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}

// Plain-language meaning of the chosen pull — so a non-technical user sees, in
// business terms, exactly what will happen (score impact, new inquiry, cost)
// before ordering. Covers the full 2×2: {soft, hard} × {reissue, brand-new}.
// A HARD brand-new pull is the only score-affecting, most-costly corner → 'warn'.
function pullMeaning(product, action) {
  const hard = product === 'creditreport';
  const reissue = action === 'Reissue';
  if (!hard && reissue) return { tone: 'ok', label: 'Soft pull · Reissue (default)', detail: 'Re-pulls the borrower’s existing report. No new inquiry, no score impact, lowest cost.' };
  if (!hard && !reissue) return { tone: 'ok', label: 'Soft pull · Brand-new', detail: 'Orders a fresh pre-qualification. A soft inquiry — it does NOT affect the borrower’s score.' };
  if (hard && reissue) return { tone: 'ok', label: 'Hard pull · Reissue', detail: 'Re-pulls an existing full credit report using a prior report ID. No new inquiry on the borrower.' };
  return { tone: 'warn', label: 'Hard pull · Brand-new', detail: 'Orders a fresh full tri-merge report. This is a REAL (hard) inquiry — it affects the borrower’s score and costs the most.' };
}

export default function CreditReportPanel({ appId }) {
  const { can } = useAuth();
  const mayPull = can('pull_credit');
  const mayReconcile = can('sign_off_conditions');
  const [reports, setReports] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [product, setProduct] = useState('prequal');
  const [action, setAction] = useState('Reissue');
  const [reissueId, setReissueId] = useState('');
  // Don't let a re-load stomp on an action the user deliberately chose.
  const touchedAction = useRef(false);

  const load = () => api.creditReports(appId).then(r => {
    const list = r.reports || [];
    setReports(list);
    // prefill the reissue identifier from the most recent report
    const latest = list.find(x => x.credit_report_identifier);
    if (latest && !reissueId) setReissueId(latest.credit_report_identifier);
    // Smart default: reissue when there IS a prior report to reissue; otherwise
    // there's nothing to re-pull, so default to a brand-new (soft) pull. Product
    // stays soft (prequal) by default. Never override a manual pick.
    if (!touchedAction.current && !latest) setAction('Submit');
  }).catch(e => setErr(e.message));
  useEffect(() => { if (mayPull) load(); }, [appId, mayPull]);

  async function order() {
    setErr(''); setMsg('');
    if (action === 'Reissue' && !reissueId.trim()) { setErr('A reissue needs the prior credit report identifier.'); return; }
    // Guard the only score-affecting, most-costly corner: a brand-new HARD pull is
    // a real inquiry on the borrower. Reissues and soft pulls proceed without a prompt.
    if (product === 'creditreport' && action !== 'Reissue') {
      const okHard = window.confirm('This is a HARD credit pull (a brand-new full report). It is a real inquiry that affects the borrower’s score and costs the most. Continue?');
      if (!okHard) return;
    }
    setBusy(true);
    try {
      // A fresh key per click so a deliberate retry is a new order, while a
      // double-fire of THIS click reuses the key (server also has an in-flight
      // window). crypto.randomUUID is available in the portal's secure context.
      const idempotencyKey = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID() : `k-${appId}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const out = await api.creditOrder({
        applicationId: appId, product, action,
        creditReportIdentifier: action === 'Reissue' ? reissueId.trim() : undefined,
        idempotencyKey,
      });
      setMsg(out.deduped
        ? (out.inflight ? 'An order is already in progress — showing it.' : 'That order was already placed — showing the existing report.')
        : out.underwritingFinding
          ? `Imported (FICO ${out.representativeScore ?? 'n/a'}), but it does NOT match the file — a fatal underwriting finding was raised. Reconcile before sign-off.`
          : out.status === 'review'
            ? `Imported, but it needs manual review: ${out.reviewReason || ''}`
            : `Done — representative FICO ${out.representativeScore ?? 'n/a'} (${out.representativeBracket || '—'}).`);
      await load();
    } catch (e) {
      // An in-doubt (timeout) outcome must NOT invite a blind re-order.
      const extra = e.data && e.data.inDoubt
        ? ' — the vendor may have processed this; check Xactus before re-ordering (it may already be in the review queue).'
        : (e.data && e.data.retriable ? ' (safe to retry a reissue)' : '');
      setErr(e.message + extra);
    } finally { setBusy(false); }
  }

  if (!mayPull) return <p className="muted small">You don’t have permission to pull credit on this file.</p>;

  return (
    <div>
      <div className="panel" style={{ background: 'var(--ink-2)' }}>
        <div className="grid cols-3">
          <div className="field">
            <label>Product</label>
            <select className="input" value={product} onChange={e => setProduct(e.target.value)}>
              <option value="prequal">Soft pull — Pre-Qualification</option>
              <option value="creditreport">Hard pull — Credit Report</option>
            </select>
          </div>
          <div className="field">
            <label>Action</label>
            <select className="input" value={action} onChange={e => { touchedAction.current = true; setAction(e.target.value); }}>
              <option value="Reissue">Reissue (re-pull existing)</option>
              <option value="Submit">Brand-new order</option>
            </select>
          </div>
          <div className="field">
            <label>Prior report ID {action === 'Reissue' && <span className="muted small">(for reissue)</span>}</label>
            <input className="input" value={reissueId} disabled={action !== 'Reissue'}
              onChange={e => setReissueId(e.target.value)} placeholder="e.g. 1202696" />
          </div>
        </div>
        {/* Plain-language summary of exactly what this pull does (score / inquiry / cost). */}
        {(() => {
          const m = pullMeaning(product, action);
          return (
            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8,
              border: `1px solid var(--${m.tone === 'warn' ? 'danger' : 'line'})`,
              background: m.tone === 'warn' ? 'var(--danger-soft, #FBEAEA)' : 'var(--ink-1)' }}>
              <div style={{ fontSize: 13 }}><strong style={{ color: m.tone === 'warn' ? 'var(--danger)' : undefined }}>{m.label}</strong></div>
              <div className="muted small" style={{ marginTop: 2 }}>{m.detail}</div>
            </div>
          );
        })()}
        {err && <div className="notice err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
        {msg && <div className="notice ok" style={{ marginTop: 8 }}>{msg}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={order}>
            {busy ? 'Working…' : action === 'Reissue' ? 'Reissue credit' : 'Pull credit'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          Ordering bills the vendor. A double-click is safe — the same order won’t be placed twice.
        </p>
      </div>

      {reports === null && !err && <p className="muted" style={{ marginTop: 8 }}>Loading reports…</p>}
      {reports && reports.length === 0 && <p className="muted" style={{ marginTop: 8 }}>No credit reports pulled yet.</p>}
      {reports && reports.map(r => <ReportRow key={r.id} r={r} mayReconcile={mayReconcile} onChanged={load} />)}
    </div>
  );
}
