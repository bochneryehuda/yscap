import React, { useEffect, useState, useCallback } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { fileToBase64 } from '../lib/files.js';

/**
 * Credit report (Xactus import) — the internal "Credit report" condition
 * (rtl_cond_credit). Renders inside the staff file's `Item` when
 * it.template_code === 'rtl_cond_credit'.
 *
 *   • "Import credit" opens a review screen that SHOWS the exact borrower info
 *     that will be transmitted, defaults to Soft pull + tri-merge + v3.4, with
 *     manual toggles to Hard / brand-new, and requires a permissible-purpose
 *     attestation (the server enforces it too).
 *   • pulls/reissues via ONE shared company login (no per-user credential),
 *     files the PDF + the source data file, and imports every detail into a
 *     full credit-details section (hero score + KPIs + tradelines) for
 *     underwriting.
 *
 * Every identifier here is an import, a local, a prop, or a browser global — no
 * eslint no-undef traps in the esbuild JSX bundle.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// tz-safe: never `new Date('YYYY-MM-DD')` on a date-only value (repo date rule).
function fmtDay(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(s);
}
function fmtWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts || ''); }
}
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
function initials(first, last) {
  const a = (first || '').trim(), b = (last || '').trim();
  const s = ((a[0] || '') + (b[0] || '')).toUpperCase();
  return s || '—';
}
// FICO/score bands → a label + a tone key that drives the semantic color.
function scoreBand(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { label: 'No score', tone: 'none' };
  if (n >= 800) return { label: 'Exceptional', tone: 'good' };
  if (n >= 740) return { label: 'Very good', tone: 'good' };
  if (n >= 670) return { label: 'Good', tone: 'ok' };
  if (n >= 580) return { label: 'Fair', tone: 'fair' };
  return { label: 'Poor', tone: 'poor' };
}
// Marker position on a 300–850 gauge, clamped to the track.
function gaugePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, ((n - 300) / 550) * 100));
}

// Small line icons for the KPI badges (inline SVG, stroke = currentColor).
function KIcon({ name }) {
  const p = {
    accounts: <><rect x="2.5" y="4" width="11" height="8" rx="1.5" /><path d="M2.5 6.8h11" /></>,
    balance: <><rect x="2.5" y="4.5" width="11" height="7" rx="1.2" /><circle cx="8" cy="8" r="1.6" /></>,
    payment: <><rect x="2.5" y="3.5" width="11" height="9.5" rx="1.5" /><path d="M2.5 6.4h11M5.5 2.4v2M10.5 2.4v2" /></>,
    alert: <><path d="M8 2.6 14 12.5H2z" /><path d="M8 6.8v2.6M8 11h.01" /></>,
    flag: <><path d="M4 2.6v11" /><path d="M4 3.4h7l-1.3 2.2L11 7.8H4z" /></>,
    record: <><path d="M2.6 13h10.8M3.6 6.4h8.8M8 2.4 13 5.4H3z" /><path d="M4.8 6.6v5.4M11.2 6.6v5.4" /></>,
    search: <><circle cx="7" cy="7" r="3.6" /><path d="m10 10 3 3" /></>,
  }[name] || null;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>
  );
}

// A modern segmented control (namespaced .crx-seg so it never collides with the
// global .seg used elsewhere). Each option can carry a helper line.
function Seg({ value, onChange, options }) {
  return (
    <div className="crx-seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value}
          className={'crx-seg-btn' + (value === o.value ? ' on' : '')}
          onClick={() => onChange(o.value)}>
          <span className="crx-seg-lbl">{o.label}</span>
          {o.sub && <span className="crx-seg-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

// One bureau's score tile with a band-colored mini-bar.
function BureauTile({ s }) {
  const band = scoreBand(s && s.value);
  return (
    <div className={'crx-bureau tone-' + band.tone}>
      <div className="crx-bureau-top">
        <span className="crx-bureau-name">{(s && s.bureau) || 'Score'}</span>
        <span className="crx-bureau-val">{s && s.value != null ? s.value : '—'}</span>
      </div>
      <div className="crx-bureau-bar"><i style={{ width: gaugePct(s && s.value) + '%' }} /></div>
      {s && s.model ? <div className="crx-bureau-model" title={s.model}>{s.model}</div> : null}
    </div>
  );
}

// A KPI tile: icon badge + number + label. `tone` tints the badge for attention.
function KpiTile({ icon, tone, value, label }) {
  return (
    <div className="crx-kpi">
      <span className={'crx-kpi-ic' + (tone ? ' ' + tone : '')}><KIcon name={icon} /></span>
      <div className="crx-kpi-body">
        <div className="crx-kpi-num">{value}</div>
        <div className="crx-kpi-lbl">{label}</div>
      </div>
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
  const [reissueRef, setReissueRef] = useState('');
  const [consent, setConsent] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [xmlFile, setXmlFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);

  useEffect(() => {
    let alive = true;
    api.staffCreditPreview(appId)
      .then((d) => {
        if (!alive) return;
        setPre(d);
        if (d) {
          if (d.defaults) { setPullType(d.defaults.pullType); setRequestType(d.defaults.requestType); setVersion(d.defaults.version || '3.4'); }
          setReissueRef(d.reissueReportId || '');
        }
      })
      .catch((e) => alive && setErr(e.message || 'Could not load the borrower info.'));
    return () => { alive = false; };
  }, [appId]);

  // Lock the background page scroll while the modal is open (house pattern —
  // matches ToolModal/ProductStudioPanel/TrackRecordScreen) so the page behind
  // doesn't scroll under the box. Also close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const providerReady = pre && pre.provider && pre.provider.configured;
  const missing = (pre && pre.missing) || [];

  async function runImport(kind) {
    setErr(''); setBusy(true);
    try {
      const body = { pullType, requestType, version };
      if (requestType === 'reissue') body.reissueReportId = reissueRef;
      if (kind === 'live') body.consent = consent;    // permissible-purpose attestation (server enforces too)
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
  const name = b ? [b.firstName, b.lastName].filter(Boolean).join(' ') : '';

  // The primary action lives in a STICKY FOOTER so it's always reachable — the
  // body scrolls independently. The button adapts to the active mode (live pull
  // vs an uploaded file); a hint explains any disabled state so it's never a
  // dead, unexplained button.
  const canLive = providerReady && consent && missing.length === 0;
  const liveLabel = requestType === 'new' ? 'Order & import' : 'Reissue & import';
  const primaryLabel = busy ? 'Working…' : (showUpload ? 'Import the file' : liveLabel);
  const primaryDisabled = busy || (showUpload ? (!xmlFile && !pdfFile) : !canLive);
  let footerHint = '';
  if (!busy) {
    if (showUpload) { if (!xmlFile && !pdfFile) footerHint = 'Choose the downloaded data file (XML) and/or the PDF.'; }
    else if (!providerReady) footerHint = 'Live pull isn’t set up yet — use “Import a downloaded report”.';
    else if (missing.length) footerHint = `Add the borrower’s ${missing.join(', ')} to pull.`;
    else if (!consent) footerHint = 'Check the authorization box above to enable the pull.';
  }

  return (
    <div className="cv-modal-back crx-back" onClick={onClose}>
      <div className="cv-modal crx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crx-modal-head">
          <div>
            <h3 className="crx-modal-title">Import credit</h3>
            <p className="crx-modal-sub">Pull a tri-merge report through the shared Xactus login.</p>
          </div>
          <button className="crx-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="crx-modal-body">
          {!pre && !err && <div className="crx-loading">Loading the borrower’s information…</div>}
          {/* Load-time failure shows here (the whole modal failed to load). An
              IMPORT failure shows in the sticky footer so it's always visible. */}
          {!pre && err && <div className="crx-alert danger">{err}</div>}

          {pre && (<>
            {/* Recipient / what we transmit */}
            <section className="crx-recipient">
              <div className="crx-recip-head">
                <span className="crx-mono" aria-hidden="true">{initials(b && b.firstName, b && b.lastName)}</span>
                <div>
                  <div className="crx-recip-name">{name || 'Borrower'}</div>
                  <div className="crx-recip-eyebrow">Identity we’ll send to Xactus</div>
                </div>
              </div>
              <div className="crx-recip-grid">
                <div className="crx-field"><span>Date of birth</span><b>{b && b.dob ? fmtDay(b.dob) : '—'}</b></div>
                <div className="crx-field"><span>Social Security #</span><b>{(b && b.ssnMasked) || (b && b.hasSsn ? 'on file' : '— not on file')}</b></div>
                <div className="crx-field crx-field-wide"><span>Current address</span><b>{addrLine || '—'}</b></div>
              </div>
              {missing.length > 0
                ? <div className="crx-note warn">Add the borrower’s {missing.join(', ')} on the file before a live pull. You can still import a downloaded report below.</div>
                : <div className="crx-note secure"><span className="crx-lock" aria-hidden="true">🔒</span> Sent securely over an encrypted connection — a tri-merge of all three bureaus.</div>}
            </section>

            {/* Options */}
            <section className="crx-options">
              <div className="crx-opt">
                <label className="crx-opt-label">Type of pull</label>
                <Seg value={pullType} onChange={setPullType} options={[
                  { value: 'soft', label: 'Soft', sub: 'Pre-application' },
                  { value: 'hard', label: 'Hard', sub: 'Full report' },
                ]} />
                <div className="crx-opt-hint">{pullType === 'hard'
                  ? 'A hard inquiry — a full credit report that can affect the borrower’s score.'
                  : 'A soft inquiry — a pre-application check that does not affect the score.'}</div>
              </div>

              <div className="crx-opt">
                <label className="crx-opt-label">Order</label>
                <Seg value={requestType} onChange={setRequestType} options={[
                  { value: 'reissue', label: 'Reissue', sub: 'Existing report' },
                  { value: 'new', label: 'Brand-new', sub: 'Fresh pull' },
                ]} />
                {requestType === 'reissue' && (
                  <div className="crx-reissue">
                    <label className="crx-opt-label">Reissue reference #</label>
                    <input className="crx-input" value={reissueRef} onChange={(e) => setReissueRef(e.target.value)} placeholder="Xactus report reference" />
                    <div className="crx-opt-hint">{pre.reissueReportId
                      ? 'Pre-filled from the last report on this file — change it to re-pull a different one.'
                      : 'A reissue re-pulls an existing Xactus report by its reference. For a first pull, choose “Brand-new”.'}</div>
                  </div>
                )}
              </div>

              <div className="crx-meta-row">
                <div className="crx-meta">
                  <label className="crx-opt-label">Bureaus</label>
                  <div className="crx-tri">
                    {['Equifax', 'Experian', 'TransUnion'].map((x) => (
                      <span key={x} className="crx-tri-chip"><span className="crx-tri-dot" aria-hidden="true" />{x}</span>
                    ))}
                  </div>
                </div>
                <div className="crx-meta crx-meta-ver">
                  <label className="crx-opt-label">Version</label>
                  {/* Frozen — the report interface version is fixed (owner-directed);
                      staff cannot change it. Set only via XACTUS_INTERFACE_VERSION. */}
                  <span className="crx-tri-chip crx-frozen" title="Fixed report version — cannot be changed">
                    MISMO {version} <span className="crx-lock" aria-hidden="true">🔒</span>
                  </span>
                </div>
              </div>
            </section>

            {/* Consent — arms the primary action */}
            <label className={'crx-consent' + (consent ? ' on' : '')}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span><b>The borrower has authorized this credit pull.</b> Permissible purpose is on file (required to pull).</span>
            </label>

            {!providerReady && (
              <div className="crx-alert warn">
                The shared Xactus login isn’t set up yet, so a live pull isn’t available. Once the company login is added in the system settings this turns on — you can import a downloaded report below in the meantime.
              </div>
            )}

            {showUpload && (
              <section className="crx-upload">
                <div className="crx-upload-title">Import a report you already downloaded from Xactus</div>
                <div className="crx-upload-row"><span>Data file (XML)</span>
                  <input type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setXmlFile(e.target.files[0] || null)} /></div>
                <div className="crx-upload-row"><span>Report (PDF)</span>
                  <input type="file" accept="application/pdf,.pdf" onChange={(e) => setPdfFile(e.target.files[0] || null)} /></div>
                <p className="crx-upload-hint">The data file (XML) builds the credit-details section; the PDF is filed on the loan.</p>
              </section>
            )}
          </>)}
        </div>

        {/* Sticky footer — the primary action is ALWAYS visible + reachable,
            regardless of how far the body has scrolled. */}
        {pre && (
          <div className="crx-modal-foot">
            {err && <div className="crx-alert danger" style={{ margin: 0 }}>{err}</div>}
            {footerHint && <div className="crx-foot-hint">{footerHint}</div>}
            <div className="crx-foot-actions">
              <button className="crx-btn primary" disabled={primaryDisabled}
                onClick={() => runImport(showUpload ? 'upload' : 'live')}>{primaryLabel}</button>
              <button className="crx-btn ghost" onClick={() => setShowUpload((v) => !v)}>
                {showUpload ? 'Cancel downloaded import' : 'Import a downloaded report'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── details section ──
function CreditDetails({ report }) {
  const p = report;
  const s = p.summary || {};
  const kpis = [
    { icon: 'accounts', value: s.tradelineCount != null ? s.tradelineCount : '—', label: 'Accounts' },
    { icon: 'balance', value: money(s.totalBalance), label: 'Total balances' },
    { icon: 'payment', value: money(s.totalMonthlyPayments), label: 'Monthly' },
    { icon: 'alert', value: s.delinquentCount != null ? s.delinquentCount : '—', label: 'Delinquent', tone: (s.delinquentCount || 0) > 0 ? 'danger' : '' },
    { icon: 'flag', value: s.collectionCount != null ? s.collectionCount : '—', label: 'Collections', tone: (s.collectionCount || 0) > 0 ? 'danger' : '' },
    { icon: 'record', value: s.publicRecordCount != null ? s.publicRecordCount : '—', label: 'Public records', tone: (s.publicRecordCount || 0) > 0 ? 'danger' : '' },
    { icon: 'search', value: s.inquiryCount != null ? s.inquiryCount : '—', label: 'Inquiries' },
  ];
  return (
    <div className="crx-details">
      {p.parseError && <div className="crx-alert warn">The data file was saved, but some details couldn’t be read automatically ({p.parseError}).{p.pdfDocumentId ? ' The PDF is on the file.' : ''}</div>}

      <div className="crx-kpis">
        {kpis.map((k, i) => <KpiTile key={i} icon={k.icon} tone={k.tone} value={k.value} label={k.label} />)}
      </div>

      {Array.isArray(p.liabilities) && p.liabilities.length > 0 && (
        <details className="crx-sec" open>
          <summary>Accounts / tradelines <span className="crx-count">{p.liabilities.length}</span></summary>
          <div className="crx-table-wrap">
            <table className="crx-table">
              <thead><tr><th>Creditor</th><th>Type</th><th>Status</th><th className="r">Balance</th><th className="r">Limit / high</th><th className="r">Payment</th><th className="r">Past due</th><th>Opened</th><th>Late 30/60/90</th></tr></thead>
              <tbody>
                {p.liabilities.filter(Boolean).map((l, i) => (
                  <tr key={i} className={l.isCollection ? 'crx-bad' : ((l.pastDue || 0) > 0 ? 'crx-warn' : '')}>
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
        <details className="crx-sec">
          <summary>Public records <span className="crx-count">{p.publicRecords.length}</span></summary>
          <div className="crx-table-wrap"><table className="crx-table">
            <thead><tr><th>Type</th><th>Filed</th><th className="r">Amount</th><th>Status</th><th>Court</th></tr></thead>
            <tbody>{p.publicRecords.filter(Boolean).map((r, i) => (
              <tr key={i} className="crx-bad"><td>{r.type || '—'}</td><td>{fmtDay(r.date)}</td><td className="r">{money(r.amount)}</td><td>{r.status || '—'}</td><td>{r.court || '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {Array.isArray(p.inquiries) && p.inquiries.length > 0 && (
        <details className="crx-sec">
          <summary>Inquiries <span className="crx-count">{p.inquiries.length}</span></summary>
          <div className="crx-table-wrap"><table className="crx-table">
            <thead><tr><th>Who</th><th>Date</th><th>Bureau</th></tr></thead>
            <tbody>{p.inquiries.filter(Boolean).map((q, i) => (
              <tr key={i}><td>{q.name || '—'}</td><td>{fmtDay(q.date)}</td><td>{q.bureau || '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {p.borrower && (
        <details className="crx-sec">
          <summary>Identity on the report</summary>
          <div className="crx-id">
            <div className="crx-field"><span>Name</span><b>{[p.borrower.firstName, p.borrower.middleName, p.borrower.lastName].filter(Boolean).join(' ') || '—'}</b></div>
            {p.borrower.dob && <div className="crx-field"><span>Date of birth</span><b>{fmtDay(p.borrower.dob)}</b></div>}
            {p.borrower.ssnLast4 && <div className="crx-field"><span>SSN</span><b>•••-••-{p.borrower.ssnLast4}</b></div>}
            {(p.borrower.addresses || []).filter(Boolean).map((a, i) => (
              <div className="crx-field crx-field-wide" key={i}><span>Address {i + 1}</span><b>{[a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')}</b></div>
            ))}
            {(p.borrower.employers || []).length > 0 && <div className="crx-field crx-field-wide"><span>Employers</span><b>{p.borrower.employers.join(' · ')}</b></div>}
          </div>
        </details>
      )}
    </div>
  );
}

// The hero block (big middle score + gauge + bureau tiles) — shown at the top of
// the full-screen report overlay.
function CreditHero({ report }) {
  const band = scoreBand(report.middleScore);
  return (
    <div className={'crx-hero tone-' + band.tone}>
      <div className="crx-hero-main">
        <div className="crx-hero-score">{report.middleScore != null ? report.middleScore : '—'}</div>
        <div className="crx-hero-meta">
          <span className={'crx-band tone-' + band.tone}>{band.label}</span>
          <div className="crx-hero-lbl">Middle score</div>
          <div className="crx-gauge">
            <div className="crx-gauge-track">
              {report.middleScore != null && <span className="crx-gauge-mark" style={{ left: gaugePct(report.middleScore) + '%' }} />}
            </div>
            <div className="crx-gauge-scale"><span>300</span><span>850</span></div>
          </div>
        </div>
      </div>
      <div className="crx-hero-bureaus">
        {(report.scores || []).length
          ? report.scores.filter(Boolean).map((sc, i) => <BureauTile key={i} s={sc} />)
          : <span className="crx-muted">No numeric scores were read from the data file.</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────── the full-screen report overlay ────────
// The entire report, laid out with the whole screen (owner-directed 2026-07-23):
// opens on import and from the condition's "Open full report" button, closeable.
function CreditReportOverlay({ report, history, onClose, onDownload }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div className="crx-overlay-back" onClick={onClose}>
      <div className="crx-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="crx-overlay-head">
          <div className="crx-overlay-title">
            <h3 className="crx-modal-title">Credit report</h3>
            <p className="crx-modal-sub">
              {report.pullType === 'hard' ? 'Hard pull' : 'Soft pull'} · {report.requestType === 'new' ? 'new order' : 'reissue'}
              {report.reportDate ? ` · dated ${fmtDay(report.reportDate)}` : ''} · imported {fmtWhen(report.pulledAt)}
              {report.source === 'upload' ? ' · from an uploaded file' : ''}
            </p>
          </div>
          <div className="crx-overlay-tools">
            {report.pdfDocumentId && <button className="crx-btn ghost sm" onClick={() => onDownload(report.pdfDocumentId, 'credit-report.pdf')}>Download PDF</button>}
            {report.xmlDocumentId && <button className="crx-btn ghost sm" onClick={() => onDownload(report.xmlDocumentId, 'credit-report.xml')}>Download data (XML)</button>}
            <button className="crx-x" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className="crx-overlay-body">
          <CreditHero report={report} />
          <CreditDetails report={report} />
          {Array.isArray(history) && history.length > 1 && (
            <details className="crx-sec" style={{ marginTop: 12 }}>
              <summary>Import history <span className="crx-count">{history.length}</span></summary>
              <div className="crx-table-wrap"><table className="crx-table">
                <thead><tr><th>When</th><th>Type</th><th>Order</th><th className="r">Middle</th><th>Source</th></tr></thead>
                <tbody>{history.filter(Boolean).map((h) => (
                  <tr key={h.id}><td>{fmtWhen(h.pulledAt)}</td><td>{h.pullType === 'hard' ? 'Hard' : 'Soft'}</td><td>{h.requestType === 'new' ? 'New' : 'Reissue'}</td><td className="r">{h.middleScore != null ? h.middleScore : '—'}</td><td>{h.source === 'upload' ? 'uploaded' : 'pulled'}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// One compact score tile for the condition summary (primary / co-borrower / higher).
function ScoreCell({ value, label, tone, emphasis }) {
  const band = scoreBand(value);
  return (
    <div className={'crx-scorecell' + (emphasis ? ' emphasis' : '') + ' tone-' + (tone || band.tone)}>
      <div className="crx-scorecell-num">{value != null ? value : '—'}</div>
      <div className="crx-scorecell-lbl">{label}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────── the condition surface ───
export function CreditCondition({ appId, canPull, onChanged }) {
  const [data, setData] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [flash, setFlash] = useState('');
  const [flashTone, setFlashTone] = useState('ok');

  const loadCredit = useCallback(() => {
    return api.staffCredit(appId).then(setData).catch(() => setData({ hasReport: false, provider: {}, report: null, history: [], borrowers: null }));
  }, [appId]);

  useEffect(() => { loadCredit(); }, [loadCredit]);

  const report = data && data.report;
  const provider = (data && data.provider) || {};
  // Prefer the server's real permission (sign_off_conditions) once loaded; fall
  // back to the role-based prop for the brief moment before the fetch returns.
  const canImport = data && typeof data.canImport === 'boolean' ? data.canImport : canPull;

  const showFlash = (msg, tone) => {
    setFlashTone(tone || 'ok'); setFlash(msg);
    window.setTimeout(() => setFlash(''), 8000);
  };

  const onImported = (out) => {
    setShowModal(false);
    const bits = [];
    if (out && out.middleScore != null) bits.push(`middle score ${out.middleScore}`);
    if (out && out.ficoWritten != null) bits.push(`FICO set to ${out.ficoWritten}`);
    if (out && out.ficoMismatch) bits.push('FICO not auto-set — the report named a different person');
    if (out && out.ficoUnverified) bits.push('FICO not auto-set — no SSN on file to confirm identity');
    if (out && out.pdfMissing) bits.push('no PDF in the response — data file saved');
    if (out && out.parseError) bits.push('some details couldn’t be read');
    const tone = out && (out.ficoMismatch || out.ficoUnverified || out.parseError || out.pdfMissing) ? 'warn' : 'ok';
    showFlash('Credit report imported successfully ✓' + (bits.length ? ' — ' + bits.join(' · ') : ''), tone);
    // Reload, then pop the full report open on the whole screen.
    loadCredit().then(() => setShowOverlay(true));
    if (onChanged) onChanged();
  };

  const download = async (docId, fallback) => {
    try { const { blob, filename } = await api.staffDownloadDoc(docId); saveBlob(blob, filename || fallback); }
    catch (e) { showFlash('Download failed: ' + (e.message || 'please try again'), 'warn'); }
  };

  const borrowers = (data && data.borrowers) || null;
  const hasCo = !!(borrowers && borrowers.hasCoBorrower);
  const primaryScore = borrowers && borrowers.primary ? borrowers.primary.middleScore : (report ? report.middleScore : null);

  return (
    <div className="crx-wrap">
      <div className="crx-bar">
        {canImport
          ? <button className="crx-btn primary sm" onClick={() => setShowModal(true)}>{report ? '↻ Import again' : '⬇ Import credit'}</button>
          : !report && <span className="crx-muted">A processor can import the credit report here.</span>}
        {canImport && !provider.configured && <span className="crx-pill" title="The shared Xactus login is not set yet">Live pull: not set up</span>}
        <span className="crx-bar-spacer" />
        {report && report.pdfDocumentId && (
          <button className="crx-btn ghost sm" onClick={() => download(report.pdfDocumentId, 'credit-report.pdf')}>Open / download PDF</button>
        )}
      </div>

      {flash && <div className={'crx-alert ' + (flashTone === 'warn' ? 'warn' : 'ok')}>{flash}</div>}

      {/* Compact summary that ALWAYS sits at the bottom of the condition: the
          middle score (and, with a co-borrower, the higher-of-two that prices the
          deal) + a button to open the whole report on the full screen. */}
      {report ? (
        <div className="crx-cond-summary">
          <div className="crx-scoreline">
            <ScoreCell value={primaryScore}
              label={hasCo && borrowers.primary ? `${borrowers.primary.name} · middle` : 'Middle score'}
              emphasis={!hasCo} />
            {hasCo && borrowers.coBorrower && (
              <ScoreCell value={borrowers.coBorrower.middleScore}
                label={borrowers.coBorrower.name + (borrowers.coBorrower.hasReport ? ' · middle' : ' · not pulled yet')} />
            )}
            {hasCo && (
              <ScoreCell value={borrowers.higher} label="Higher — prices the deal" emphasis />
            )}
          </div>

          <div className="crx-sub">
            {report.pullType === 'hard' ? 'Hard pull' : 'Soft pull'} · {report.requestType === 'new' ? 'new order' : 'reissue'}
            {report.reportDate ? ` · dated ${fmtDay(report.reportDate)}` : ''} · imported {fmtWhen(report.pulledAt)}
            {report.source === 'upload' ? ' · from an uploaded file' : ''}
            {report.vendorReportId ? ` · ref ${report.vendorReportId}` : ''}
          </div>

          <div className="crx-summary-actions">
            <button className="crx-btn primary sm" onClick={() => setShowOverlay(true)}>⛶ Open full credit report</button>
          </div>
        </div>
      ) : (
        <div className="crx-empty">No credit report imported yet. Click <b>Import credit</b> to pull a tri-merge report or import one you downloaded.</div>
      )}

      {showModal && <CreditImportModal appId={appId} onClose={() => setShowModal(false)} onDone={onImported} />}
      {showOverlay && report && (
        <CreditReportOverlay report={report} history={data && data.history} onClose={() => setShowOverlay(false)} onDownload={download} />
      )}
    </div>
  );
}

export default CreditCondition;
