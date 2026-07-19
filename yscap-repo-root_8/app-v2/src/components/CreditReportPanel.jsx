import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

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

/* FATAL underwriting finding: the verified FICO landed in a different pricing
   bracket than the FICO the file was built on. HARD-blocks completing the credit
   condition (server-enforced) until the file is corrected + re-pulled OR an
   underwriter reconciles the finding (a documented exception). */
function FindingBanner({ finding, report, mayReconcile, onReconciled }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!finding) return null;
  const reconciled = report && report.underwriting_finding_reconciled_at;
  // Prefer the per-borrower breakdown; when it's absent, fall back to the
  // representative-level claimed→verified so the banner ALWAYS names concrete
  // numbers instead of only the prose message.
  const rows = Array.isArray(finding.perBorrower) && finding.perBorrower.length > 0
    ? finding.perBorrower
    : ((finding.claimed != null || finding.verified != null)
        ? [{ name: 'Representative', claimed: finding.claimed, claimedBracket: finding.claimedBracket, verified: finding.verified, verifiedBracket: finding.verifiedBracket }]
        : []);

  async function reconcile(undo) {
    setErr(''); setBusy(true);
    try {
      await api.creditReconcileFinding({ creditReportId: report.id, note: undo ? undefined : note.trim(), undo });
      setOpen(false); setNote('');
      if (onReconciled) await onReconciled();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="notice err" style={{ marginTop: 8, borderLeft: '4px solid var(--danger)' }} role="alert">
      <strong>⚠ Fatal underwriting finding — the FICO does not match the file.</strong>
      {finding.message && <div style={{ marginTop: 4 }}>{finding.message}</div>}
      {rows.length > 0 && (
        <ul style={{ margin: '6px 0 0 18px' }}>
          {rows.map((b, i) => (
            <li key={i}>
              {b.name}: file <strong>{b.claimed != null ? b.claimed : '—'}</strong> ({b.claimedBracket || 'bracket —'}) → verified <strong>{b.verified != null ? b.verified : '—'}</strong> ({b.verifiedBracket || 'bracket —'})
            </li>
          ))}
        </ul>
      )}
      {reconciled ? (
        <div className="notice ok" style={{ marginTop: 6 }}>
          Reconciled{report.underwriting_finding_reconcile_note ? ` — ${report.underwriting_finding_reconcile_note}` : ''}. The credit condition can now be signed off.
          {mayReconcile && (
            <button className="btn ghost small" style={{ marginLeft: 8 }} disabled={busy} onClick={() => reconcile(true)}>Undo</button>
          )}
        </div>
      ) : (
        <>
          <div className="muted small" style={{ marginTop: 4 }}>
            Re-register the product on the verified score and re-pull, or reconcile this finding (a documented exception) — either one clears the credit condition for sign-off.
          </div>
          {mayReconcile && !open && (
            <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>Reconcile finding…</button>
          )}
          {mayReconcile && open && (
            <div style={{ marginTop: 6 }}>
              <input className="input" value={note} onChange={e => setNote(e.target.value)}
                placeholder="Reason (required) — e.g. score confirmed with underwriting" />
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <button className="btn primary small" disabled={busy || !note.trim()} onClick={() => reconcile(false)}>{busy ? 'Saving…' : 'Confirm reconcile'}</button>
                <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
              </div>
            </div>
          )}
          {err && <div className="notice err small" style={{ marginTop: 6 }}>{err}</div>}
        </>
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
  const badge = STATUS_BADGE[r.status] || { text: r.status, cls: '' };
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

      {r.pdf_document_id && (
        <div style={{ marginTop: 8 }}>
          <a className="btn ghost" href={api.creditReportPdfUrl(r.id)} target="_blank" rel="noopener noreferrer">Open full report PDF</a>
        </div>
      )}
    </div>
  );
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

  const load = () => api.creditReports(appId).then(r => {
    const list = r.reports || [];
    setReports(list);
    // prefill the reissue identifier from the most recent report
    const latest = list.find(x => x.credit_report_identifier);
    if (latest && !reissueId) setReissueId(latest.credit_report_identifier);
  }).catch(e => setErr(e.message));
  useEffect(() => { if (mayPull) load(); }, [appId, mayPull]);

  async function order() {
    setErr(''); setMsg('');
    if (action === 'Reissue' && !reissueId.trim()) { setErr('A reissue needs the prior credit report identifier.'); return; }
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
            <select className="input" value={action} onChange={e => setAction(e.target.value)}>
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
