import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { fileToBase64 } from '../lib/files.js';

/**
 * Credit report (Xactus import) — the redesigned internal "Credit report"
 * condition (rtl_cond_credit). Renders inside the staff file's `Item` when
 * it.template_code === 'rtl_cond_credit'.
 *
 *   • an "Import credit" button → a review screen that SHOWS the borrower info
 *     that will be sent, defaults to Soft pull (pre-application) + Reissue +
 *     tri-merge + interface v3.4, with manual toggles to Hard pull / Order-new;
 *   • pulls/reissues via ONE shared company login (no per-user credential),
 *     files the PDF + the source data file, and imports every detail into a
 *     full credit-details section for underwriting.
 *
 * All identifiers here are imports, locals, props, or browser globals (no und
 * eslint no-undef traps in the JSX build).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// tz-safe: never `new Date('YYYY-MM-DD')` on a date-only value (repo date rule).
function fmtDay(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(s);
}
function fmtWhen(ts) { try { return new Date(ts).toLocaleString(); } catch { return String(ts || ''); } }
function money(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsText(file);
  });
}

function Seg({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" title={o.hint || ''}
          className={'seg-btn' + (value === o.value ? ' on' : '')}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// One bureau's score chip.
function ScoreChip({ s }) {
  return (
    <div className="cr-score">
      <div className="cr-score-bureau">{s.bureau || 'Score'}</div>
      <div className="cr-score-val">{s.value != null ? s.value : '—'}</div>
      {s.model && <div className="cr-score-model" title={s.model}>{s.model}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── import modal ───
function CreditImportModal({ appId, onClose, onDone }) {
  const [pre, setPre] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pullType, setPullType] = useState('soft');
  const [requestType, setRequestType] = useState('reissue');
  const [version, setVersion] = useState('3.4');
  const [consent, setConsent] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [xmlFile, setXmlFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);

  useEffect(() => {
    let alive = true;
    api.staffCreditPreview(appId)
      .then((d) => { if (alive) { setPre(d); if (d && d.defaults) { setPullType(d.defaults.pullType); setRequestType(d.defaults.requestType); setVersion(d.defaults.version || '3.4'); } } })
      .catch((e) => alive && setErr(e.message || 'Could not load the borrower info.'));
    return () => { alive = false; };
  }, [appId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const providerReady = pre && pre.provider && pre.provider.configured;
  const missing = (pre && pre.missing) || [];

  async function runImport(kind) {
    setErr(''); setBusy(true);
    try {
      const body = { pullType, requestType, version };
      if (kind === 'upload') {
        if (!xmlFile && !pdfFile) throw new Error('Choose the credit data file (XML) and/or the PDF to import.');
        if (xmlFile) body.xml = await readFileText(xmlFile);
        if (pdfFile) body.pdfBase64 = await fileToBase64(pdfFile);
      }
      const out = await api.staffCreditImport(appId, body);
      onDone(out);
    } catch (e) {
      setErr(e.message || 'The import did not go through.');
      setBusy(false);
    }
  }

  const b = pre && pre.borrower;
  const addr = (b && b.address) || {};
  const addrLine = [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip].filter(Boolean).join(' · ');

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Import credit</h3>
          <button className="btn ghost small" onClick={onClose}>Close ✕</button>
        </div>

        {!pre && !err && <p className="muted small">Loading the borrower’s information…</p>}
        {err && <div className="cr-alert danger" style={{ marginBottom: 10 }}>{err}</div>}

        {pre && (
          <>
            {/* What will be sent */}
            <div className="cr-card">
              <div className="cr-card-title">This is what we’ll send to Xactus</div>
              <div className="cr-kv"><span>Name</span><b>{[b.firstName, b.lastName].filter(Boolean).join(' ') || '—'}</b></div>
              <div className="cr-kv"><span>Date of birth</span><b>{b.dob ? fmtDay(b.dob) : '—'}</b></div>
              <div className="cr-kv"><span>Social Security #</span><b>{b.ssnMasked || (b.hasSsn ? 'on file' : '— not on file')}</b></div>
              <div className="cr-kv"><span>Current address</span><b>{addrLine || '—'}</b></div>
              {missing.length > 0 && (
                <div className="cr-alert warn" style={{ marginTop: 8 }}>
                  Add the borrower’s {missing.join(', ')} on the file before a live pull. You can still import a downloaded report below.
                </div>
              )}
            </div>

            {/* Options */}
            <div className="cr-opts">
              <label className="cr-opt-label">Type of pull</label>
              <Seg value={pullType} onChange={setPullType} options={[
                { value: 'soft', label: 'Soft — pre-application', hint: 'A soft inquiry that does not affect the score.' },
                { value: 'hard', label: 'Hard — full report', hint: 'A hard inquiry — a full credit report.' },
              ]} />
              <label className="cr-opt-label">Order</label>
              <Seg value={requestType} onChange={setRequestType} options={[
                { value: 'reissue', label: 'Reissue existing', hint: 'Re-pull a report already on file (faster).' },
                { value: 'new', label: 'Order brand-new', hint: 'Order a fresh report.' },
              ]} />
              <div className="row" style={{ gap: 16, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                <div><label className="cr-opt-label" style={{ display: 'block' }}>Bureaus</label><span className="pill">Tri-merge · all three</span></div>
                <div><label className="cr-opt-label" style={{ display: 'block' }}>Version</label>
                  <input className="input" style={{ width: 90 }} value={version} onChange={(e) => setVersion(e.target.value)} /></div>
              </div>
            </div>

            {/* Consent + live pull */}
            <label className="cr-consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>The borrower has authorized this credit pull (permissible purpose on file).</span>
            </label>

            {!providerReady && (
              <div className="cr-alert warn" style={{ marginBottom: 8 }}>
                The shared Xactus login isn’t set up yet, so a live pull isn’t available. Once the company login is added in the system settings this button turns on. You can import a downloaded report below in the meantime.
              </div>
            )}

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy || !providerReady || !consent || missing.length > 0}
                onClick={() => runImport('live')}>
                {busy ? 'Working…' : requestType === 'new' ? 'Order & import' : 'Reissue & import'}
              </button>
              <button className="btn ghost" onClick={() => setShowUpload((v) => !v)}>
                {showUpload ? 'Hide' : 'Import a downloaded report instead'}
              </button>
            </div>

            {showUpload && (
              <div className="cr-card" style={{ marginTop: 10 }}>
                <div className="cr-card-title">Import a report you already downloaded from Xactus</div>
                <div className="cr-kv"><span>Data file (XML)</span>
                  <input type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setXmlFile(e.target.files[0] || null)} /></div>
                <div className="cr-kv"><span>Report (PDF)</span>
                  <input type="file" accept="application/pdf,.pdf" onChange={(e) => setPdfFile(e.target.files[0] || null)} /></div>
                <p className="muted small" style={{ margin: '4px 0 8px' }}>The data file (XML) is what builds the credit-details section; the PDF is filed on the loan.</p>
                <button className="btn primary" disabled={busy || (!xmlFile && !pdfFile)} onClick={() => runImport('upload')}>
                  {busy ? 'Working…' : 'Import the file'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── details section ──
function CreditDetails({ report }) {
  const p = report;
  const s = p.summary || {};
  return (
    <div className="cr-details">
      {p.parseError && <div className="cr-alert warn">The data file was saved, but some details couldn’t be read automatically ({p.parseError}). The PDF is on the file.</div>}

      <div className="cr-summary-grid">
        <div className="cr-stat"><div className="cr-stat-num">{s.tradelineCount != null ? s.tradelineCount : '—'}</div><div className="cr-stat-lbl">Accounts</div></div>
        <div className="cr-stat"><div className="cr-stat-num">{money(s.totalBalance)}</div><div className="cr-stat-lbl">Total balances</div></div>
        <div className="cr-stat"><div className="cr-stat-num">{money(s.totalMonthlyPayments)}</div><div className="cr-stat-lbl">Monthly payments</div></div>
        <div className="cr-stat"><div className="cr-stat-num">{s.delinquentCount != null ? s.delinquentCount : '—'}</div><div className="cr-stat-lbl">Delinquent</div></div>
        <div className="cr-stat"><div className="cr-stat-num">{s.collectionCount != null ? s.collectionCount : '—'}</div><div className="cr-stat-lbl">Collections</div></div>
        <div className="cr-stat"><div className="cr-stat-num">{s.publicRecordCount != null ? s.publicRecordCount : '—'}</div><div className="cr-stat-lbl">Public records</div></div>
        <div className="cr-stat"><div className="cr-stat-num">{s.inquiryCount != null ? s.inquiryCount : '—'}</div><div className="cr-stat-lbl">Inquiries</div></div>
      </div>

      {Array.isArray(p.liabilities) && p.liabilities.length > 0 && (
        <details className="cr-sec" open>
          <summary>Accounts / tradelines ({p.liabilities.length})</summary>
          <div className="cr-table-wrap">
            <table className="cr-table">
              <thead><tr><th>Creditor</th><th>Type</th><th>Status</th><th className="r">Balance</th><th className="r">Limit / high</th><th className="r">Payment</th><th className="r">Past due</th><th>Opened</th><th>Late 30/60/90</th></tr></thead>
              <tbody>
                {p.liabilities.map((l, i) => (
                  <tr key={i} className={l.isCollection ? 'cr-bad' : ((l.pastDue || 0) > 0 ? 'cr-warn' : '')}>
                    <td>{l.creditor || '—'}</td>
                    <td>{l.accountType || '—'}</td>
                    <td>{l.status || (l.open === false ? 'Closed' : l.open ? 'Open' : '—')}</td>
                    <td className="r">{money(l.balance)}</td>
                    <td className="r">{money(l.creditLimit != null ? l.creditLimit : l.highCredit)}</td>
                    <td className="r">{money(l.monthlyPayment)}</td>
                    <td className="r">{(l.pastDue || 0) > 0 ? money(l.pastDue) : '—'}</td>
                    <td>{fmtDay(l.dateOpened)}</td>
                    <td>{`${l.late30 || 0}/${l.late60 || 0}/${l.late90 || 0}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {Array.isArray(p.publicRecords) && p.publicRecords.length > 0 && (
        <details className="cr-sec">
          <summary>Public records ({p.publicRecords.length})</summary>
          <div className="cr-table-wrap"><table className="cr-table">
            <thead><tr><th>Type</th><th>Filed</th><th className="r">Amount</th><th>Status</th><th>Court</th></tr></thead>
            <tbody>{p.publicRecords.map((r, i) => (
              <tr key={i} className="cr-bad"><td>{r.type || '—'}</td><td>{fmtDay(r.date)}</td><td className="r">{money(r.amount)}</td><td>{r.status || '—'}</td><td>{r.court || '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {Array.isArray(p.inquiries) && p.inquiries.length > 0 && (
        <details className="cr-sec">
          <summary>Inquiries ({p.inquiries.length})</summary>
          <div className="cr-table-wrap"><table className="cr-table">
            <thead><tr><th>Who</th><th>Date</th><th>Bureau</th></tr></thead>
            <tbody>{p.inquiries.map((q, i) => (
              <tr key={i}><td>{q.name || '—'}</td><td>{fmtDay(q.date)}</td><td>{q.bureau || '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {p.borrower && (
        <details className="cr-sec">
          <summary>Identity on the report</summary>
          <div style={{ padding: '6px 2px' }}>
            <div className="cr-kv"><span>Name</span><b>{[p.borrower.firstName, p.borrower.middleName, p.borrower.lastName].filter(Boolean).join(' ') || '—'}</b></div>
            {p.borrower.dob && <div className="cr-kv"><span>Date of birth</span><b>{fmtDay(p.borrower.dob)}</b></div>}
            {p.borrower.ssnLast4 && <div className="cr-kv"><span>SSN</span><b>•••-••-{p.borrower.ssnLast4}</b></div>}
            {(p.borrower.addresses || []).map((a, i) => (
              <div className="cr-kv" key={i}><span>Address {i + 1}</span><b>{[a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')}</b></div>
            ))}
            {(p.borrower.employers || []).length > 0 && <div className="cr-kv"><span>Employers</span><b>{p.borrower.employers.join(' · ')}</b></div>}
          </div>
        </details>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────── the condition surface ───
export function CreditCondition({ appId, canPull, onChanged }) {
  const [data, setData] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState('');

  const loadCredit = useCallback(() => {
    return api.staffCredit(appId).then(setData).catch(() => setData({ hasReport: false, provider: {}, report: null, history: [] }));
  }, [appId]);

  useEffect(() => { loadCredit(); }, [loadCredit]);

  const report = data && data.report;
  const provider = (data && data.provider) || {};
  // Prefer the server's real permission (sign_off_conditions) once loaded; fall
  // back to the role-based prop for the brief moment before the fetch returns.
  const canImport = data && typeof data.canImport === 'boolean' ? data.canImport : canPull;

  const onImported = (out) => {
    setShowModal(false);
    setExpanded(true);
    const bits = [];
    if (out && out.middleScore != null) bits.push(`middle score ${out.middleScore}`);
    if (out && out.ficoWritten != null) bits.push(`FICO set to ${out.ficoWritten}`);
    if (out && out.ficoMismatch) bits.push('FICO not auto-set — the report named a different person');
    if (out && out.parseError) bits.push('data file saved, some details couldn’t be read');
    setFlash('Imported ✓' + (bits.length ? ' — ' + bits.join(' · ') : ''));
    loadCredit();
    if (onChanged) onChanged();
    window.setTimeout(() => setFlash(''), 8000);
  };

  return (
    <div className="cr-wrap" style={{ width: '100%', paddingLeft: 20 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {canImport
          ? <button className="btn primary small" onClick={() => setShowModal(true)}>{report ? 'Import credit again' : '⬇ Import credit'}</button>
          : !report && <span className="muted small">A processor can import the credit report here.</span>}
        {canImport && !provider.configured && <span className="pill" title="The shared Xactus login is not set yet">Live pull: not set up</span>}
        {report && report.pdfDocumentId && (
          <button className="btn ghost small" onClick={() => api.staffDownloadDoc(report.pdfDocumentId)}>Download PDF</button>
        )}
        {report && report.xmlDocumentId && (
          <button className="btn ghost small" onClick={() => api.staffDownloadDoc(report.xmlDocumentId)}>Download data (XML)</button>
        )}
      </div>

      {flash && <div className="cr-alert ok" style={{ marginTop: 8 }}>{flash}</div>}

      {report ? (
        <div className="cr-report" style={{ marginTop: 10 }}>
          <div className="cr-head">
            <div className="cr-mid">
              <div className="cr-mid-num">{report.middleScore != null ? report.middleScore : '—'}</div>
              <div className="cr-mid-lbl">Middle score</div>
            </div>
            <div className="cr-scores">
              {(report.scores || []).length
                ? report.scores.map((s, i) => <ScoreChip key={i} s={s} />)
                : <span className="muted small">No numeric scores were read from the data file.</span>}
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            {report.pullType === 'hard' ? 'Hard pull' : 'Soft pull'} · {report.requestType === 'new' ? 'new order' : 'reissue'}
            {report.reportDate ? ` · dated ${fmtDay(report.reportDate)}` : ''} · imported {fmtWhen(report.pulledAt)}
            {report.source === 'upload' ? ' · from an uploaded file' : ''}
            {report.vendorReportId ? ` · ref ${report.vendorReportId}` : ''}
          </div>

          <button className="btn link small" style={{ marginTop: 6 }} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide full credit details' : 'View full credit details'}
          </button>
          {expanded && <CreditDetails report={report} />}

          {data && data.history && data.history.length > 1 && (
            <details className="cr-sec" style={{ marginTop: 8 }}>
              <summary>Import history ({data.history.length})</summary>
              <div className="cr-table-wrap"><table className="cr-table">
                <thead><tr><th>When</th><th>Type</th><th>Order</th><th className="r">Middle</th><th>Source</th></tr></thead>
                <tbody>{data.history.map((h) => (
                  <tr key={h.id}><td>{fmtWhen(h.pulledAt)}</td><td>{h.pullType === 'hard' ? 'Hard' : 'Soft'}</td><td>{h.requestType === 'new' ? 'New' : 'Reissue'}</td><td className="r">{h.middleScore != null ? h.middleScore : '—'}</td><td>{h.source === 'upload' ? 'uploaded' : 'pulled'}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          )}
        </div>
      ) : (
        <p className="muted small" style={{ marginTop: 6 }}>No credit report imported yet. Click <b>Import credit</b> to pull a tri-merge report or import one you downloaded.</p>
      )}

      {showModal && <CreditImportModal appId={appId} onClose={() => setShowModal(false)} onDone={onImported} />}
    </div>
  );
}

export default CreditCondition;
