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

function ScoreChips({ scores }) {
  if (!scores || !scores.length) return <span className="muted small">no scores</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {scores.map((s, i) => (
        <span key={i} className="tchip" title={s.reason || ''}>
          {s.bureau}: {s.usable && s.value != null ? s.value : '—'}
        </span>
      ))}
    </span>
  );
}

function ReportRow({ r }) {
  const badge = STATUS_BADGE[r.status] || { text: r.status, cls: '' };
  // group scores by report borrower id
  const byBorrower = new Map();
  for (const s of (r.scores || [])) {
    const k = s.report_borrower_id || '—';
    if (!byBorrower.has(k)) byBorrower.set(k, []);
    byBorrower.get(k).push({ bureau: s.bureau, value: s.value, usable: s.usable, reason: s.reason });
  }
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{r.action_type || 'Order'}</strong>{' '}
          <span className="muted small">
            {r.other_description || r.report_type}{r.first_issued_date ? ` · ${r.first_issued_date}` : ''}
          </span>
        </div>
        <span className={`notice ${badge.cls}`} style={{ padding: '2px 8px', fontSize: 12 }}>{badge.text}</span>
      </div>
      {r.representative_score != null && (
        <div style={{ marginTop: 6 }}>
          Representative FICO: <strong>{r.representative_score}</strong>{' '}
          <span className="muted small">({r.representative_bracket})</span>
        </div>
      )}
      {r.status === 'review' && r.review_reason && (
        <div className="notice err" style={{ marginTop: 6 }}>Manual review: {r.review_reason}</div>
      )}
      {[...byBorrower.entries()].map(([bid, scores]) => (
        <div key={bid} style={{ marginTop: 6 }}>
          <span className="muted small">{bid}:</span> <ScoreChips scores={scores} />
        </div>
      ))}
      {r.pdf_document_id && (
        <div style={{ marginTop: 8 }}>
          <a className="btn ghost" href={api.creditReportPdfUrl(r.id)} target="_blank" rel="noopener noreferrer">Open PDF</a>
        </div>
      )}
    </div>
  );
}

export default function CreditReportPanel({ appId }) {
  const { can } = useAuth();
  const mayPull = can('pull_credit');
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
      {reports && reports.map(r => <ReportRow key={r.id} r={r} />)}
    </div>
  );
}
