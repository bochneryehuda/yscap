import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import AppraisalPanel from '../components/AppraisalPanel.jsx';

/* A single TPO file — the loan's basics, PRICE & register the deal (the Term
   Sheet Studio), the conditions we need, the documents provided, and the
   borrower-login toggle. A broker prices and registers a product and the studio
   generates the term sheet, but SENDING the official DocuSign package is
   lender-only, and a broker uploads documents against a condition while the
   lender reviews and signs off (a broker never signs off or waives). */

const STATUS_LABEL = {
  file_intake: 'Intake', new: 'New', in_review: 'In review', processing: 'Processing',
  underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close',
  funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn',
};
const COND_STATUS = {
  outstanding: 'Needed', requested: 'Requested', received: 'In review', issue: 'Needs a fix',
  satisfied: 'Done', waived: 'Waived',
};
const money = (v) => v == null || v === '' ? '—' : '$' + Number(v).toLocaleString('en-US');
const addr = (a) => !a ? '' : (typeof a === 'string' ? a : (a.oneLine || [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ')));

// Read a File into the {filename, contentType, dataBase64} upload contract.
function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const comma = s.indexOf(',');
      resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64: comma >= 0 ? s.slice(comma + 1) : s });
    };
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

export default function TpoFile() {
  const { id } = useParams();
  const [a, setA] = useState(null);
  const [checklist, setChecklist] = useState([]);
  const [progress, setProgress] = useState([]);   // read-only lender-progress rows
  const [documents, setDocuments] = useState([]);
  const [credit, setCredit] = useState(null);               // borrower-safe credit readiness
  const [orderingCredit, setOrderingCredit] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [uploadingFor, setUploadingFor] = useState(null);   // checklist item id currently uploading
  const [infoVals, setInfoVals] = useState({});             // per-item info-answer input
  const [answeringFor, setAnsweringFor] = useState(null);   // checklist item id currently answering
  const fileInput = useRef(null);
  const pendingItem = useRef(null);

  const loadFile = () => api.tpoApplication(id).then((r) => setA(r?.application || null)).catch((e) => setErr(e.message || 'Could not load this file'));
  const loadChecklist = () => api.tpoChecklist(id).then((r) => {
    setChecklist(Array.isArray(r?.checklist) ? r.checklist : []);
    setProgress(Array.isArray(r?.progress) ? r.progress : []);
  }).catch(() => {});
  const loadDocuments = () => api.tpoDocuments(id).then((r) => setDocuments(Array.isArray(r?.documents) ? r.documents : [])).catch(() => {});
  const loadCredit = () => api.tpoCreditStatus(id).then(setCredit).catch(() => {});

  useEffect(() => { loadFile(); loadChecklist(); loadDocuments(); loadCredit(); /* eslint-disable-next-line */ }, [id]);

  async function orderCredit() {
    if (!window.confirm('Confirm the borrower authorized a credit pull. This orders their credit report.')) return;
    setErr(''); setMsg(''); setOrderingCredit(true);
    try {
      const r = await api.tpoOrderCredit(id, { consent: true });
      setMsg(r?.message || 'Credit was pulled — your loan team is reviewing it.');
      await Promise.all([loadCredit(), loadChecklist()]);
    } catch (ex) { setErr(ex.message || 'Could not order credit'); }
    finally { setOrderingCredit(false); }
  }

  async function togglePortal(enabled) {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api.tpoSetBorrowerPortal(id, enabled);
      setMsg(enabled ? 'The borrower can sign in to their portal for this file.' : 'The borrower can no longer sign in for this file.');
      await loadFile();
    } catch (e) { setErr(e.message || 'Could not change the setting'); }
    finally { setBusy(false); }
  }

  // A condition's "Upload" (or the general upload) picks the file, then this runs.
  async function onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';   // allow re-picking the same file
    if (!file) return;
    const itemId = pendingItem.current; pendingItem.current = null;
    setErr(''); setMsg(''); setUploadingFor(itemId || 'general');
    try {
      const payload = await readFile(file);
      await api.tpoUploadDocument({ ...payload, applicationId: id, checklistItemId: itemId || undefined });
      setMsg('Document uploaded.');
      await Promise.all([loadChecklist(), loadDocuments()]);
    } catch (ex) { setErr(ex.message || 'Could not upload the document'); }
    finally { setUploadingFor(null); }
  }
  const pickFor = (itemId) => { pendingItem.current = itemId || null; if (fileInput.current) fileInput.current.click(); };

  // Answer an information condition (a deal field). The server validates + fits
  // the value, applies the file freeze, and moves the condition to review.
  async function answerInfo(itemId) {
    const value = (infoVals[itemId] || '').trim();
    if (!value) return;
    setErr(''); setMsg(''); setAnsweringFor(itemId);
    try {
      await api.tpoAnswerInfoCondition(id, itemId, value);
      setMsg('Answer saved — your loan team will review it.');
      setInfoVals((v) => ({ ...v, [itemId]: '' }));
      await Promise.all([loadFile(), loadChecklist()]);
    } catch (ex) { setErr(ex.message || 'Could not save that answer'); }
    finally { setAnsweringFor(null); }
  }

  if (err && !a) return <div className="notice err">{err}</div>;
  if (!a) return <div className="muted">Loading…</div>;

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="muted small">{label}</span><span>{value}</span>
    </div>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <input ref={fileInput} type="file" style={{ display: 'none' }} onChange={onFilePicked} />
      <div style={{ marginBottom: 12 }}><Link to="/tpo" className="btn link small">← Back to pipeline</Link></div>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>{a.ys_loan_number || 'New loan'}</h1>
        <p className="muted small" style={{ marginTop: 6 }}>
          <span className="pill">{STATUS_LABEL[a.status] || a.status}</span>
          {a.property_address ? ' · ' + addr(a.property_address) : ''}
        </p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="notice info" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Loan</div>
        {row('Borrower', a.borrower_id ? <Link to={`/tpo/borrower/${a.borrower_id}`}>{a.borrower_name || a.borrower_email || 'View'}</Link> : '—')}
        {row('Property', addr(a.property_address) || '—')}
        {row('Property type', a.property_type || '—')}
        {row('Loan type', a.loan_type || '—')}
        {row('Program', a.program || '—')}
        {a.purchase_price != null && row('Purchase price', money(a.purchase_price))}
        {a.as_is_value != null && row('As-is value', money(a.as_is_value))}
        {a.arv != null && row('After-repair value', money(a.arv))}
        {a.rehab_budget != null && row('Rehab budget', money(a.rehab_budget))}
        {a.loan_amount != null && row('Loan amount', money(a.loan_amount))}
      </div>

      {/* Pricing — the Term Sheet Studio (price / register / generate the term
          sheet). The broker prices exactly what the borrower/staff studio does,
          minus the internal margin; WE still send the official signed term sheet. */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Loan structure &amp; pricing</div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
          Price the deal and register a product. Your loan team reviews it and sends the official term sheet.
        </p>
        <ProductStudioPanel mode="tpo" appId={id} app={a} onRegistered={() => { loadFile(); loadChecklist(); loadDocuments(); }} />
      </div>

      {/* Conditions */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>What we need</div>
        {checklist.length === 0 && <div className="muted small">Nothing outstanding right now.</div>}
        {checklist.map((c) => (
          <div key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{c.label}</div>
                {c.hint && <div className="muted small" style={{ marginTop: 2 }}>{c.hint}</div>}
                {c.rejection_reason && <div className="small" style={{ marginTop: 2, color: '#B4532A' }}>Needs a fix: {c.rejection_reason}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="pill">{COND_STATUS[c.status] || c.status}</span>
                {c.item_kind === 'document' && !c.readOnly && (
                  <button className="btn ghost small" disabled={uploadingFor === c.id} onClick={() => pickFor(c.id)}>
                    {uploadingFor === c.id ? 'Uploading…' : 'Upload'}
                  </button>
                )}
              </div>
            </div>
            {/* An information condition the broker can answer inline (a deal field). */}
            {c.answerable && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <input
                  className="input small" style={{ flex: 1, minWidth: 160 }}
                  placeholder="Enter your answer"
                  value={infoVals[c.id] || ''}
                  onChange={(e) => setInfoVals((v) => ({ ...v, [c.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') answerInfo(c.id); }}
                  disabled={answeringFor === c.id}
                />
                <button className="btn ghost small" disabled={answeringFor === c.id || !(infoVals[c.id] || '').trim()} onClick={() => answerInfo(c.id)}>
                  {answeringFor === c.id ? 'Saving…' : 'Submit'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Lender progress — a READ-ONLY view of a few steps YOUR loan team drives
          (credit, appraisal), so you can see where the file stands. Nothing to do
          here; your team handles these. */}
      {progress.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Lender progress</div>
          {progress.map((c) => (
            <div key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{c.label}</div>
                  {c.hint && <div className="muted small" style={{ marginTop: 2 }}>{c.hint}</div>}
                </div>
                <span className="pill">{COND_STATUS[c.status] || c.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Credit — order a pull on the firm's file. Borrower-safe: readiness in,
          "pulled" out; the score + report stay with the loan team. */}
      {credit && Array.isArray(credit.borrowers) && credit.borrowers.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600 }}>Credit</div>
            <button className="btn ghost small" disabled={orderingCredit || !credit.canOrder} onClick={orderCredit}>
              {orderingCredit ? 'Ordering…' : 'Order credit'}
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
            Order the borrower’s credit. Your loan team reviews the report — scores and the report itself stay with them.
          </p>
          {credit.borrowers.map((b) => (
            <div key={b.borrowerId} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 120 }}>{b.name || 'Borrower'}</span>
              <span className="muted small">
                {b.hasReport ? 'On file' : b.canPull ? 'Ready to order' : `Needs: ${(b.missing || []).join(', ') || 'more info'}`}
              </span>
            </div>
          ))}
          {!credit.configured && <div className="muted small" style={{ marginTop: 8 }}>Credit ordering isn’t set up here — your loan team can pull it.</div>}
          {credit.configured && credit.recentlyPulled && <div className="muted small" style={{ marginTop: 8 }}>Credit was pulled for this file recently — your loan team is reviewing it. You can order again later if needed.</div>}
        </div>
      )}

      {/* Appraisal — the read-only "property profile report": the same clean report the borrower
          sees. Our internal review notes and any capital-partner names are never included. The
          panel shows its own "will appear once received" state when there's no appraisal yet. */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Appraisal</div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
          The property report once the appraisal is in. Read-only — your loan team handles the review.
        </p>
        <AppraisalPanel appId={id} readOnly source="tpo" />
      </div>

      {/* Documents */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600 }}>Documents</div>
          <button className="btn ghost small" disabled={uploadingFor === 'general'} onClick={() => pickFor(null)}>
            {uploadingFor === 'general' ? 'Uploading…' : 'Upload a document'}
          </button>
        </div>
        {documents.length === 0 && <div className="muted small">No documents yet.</div>}
        {documents.map((d) => (
          <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
            <span className="muted small">{d.review_status === 'accepted' ? 'Accepted' : d.review_status === 'rejected' ? 'Rejected' : 'In review'}</span>
          </div>
        ))}
      </div>

      {/* Borrower login */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Borrower login</div>
        <p className="muted small" style={{ marginTop: 0 }}>
          By default your borrower can sign in to their own PILOT portal to see this file. You can turn that off for this file.
        </p>
        <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>{a.borrower_portal_enabled
            ? <span className="pill">Borrower login is ON</span>
            : <span className="pill">Borrower login is OFF</span>}</span>
          {a.borrower_portal_enabled
            ? <button className="btn ghost small" disabled={busy} onClick={() => togglePortal(false)}>Turn off</button>
            : <button className="btn ghost small" disabled={busy} onClick={() => togglePortal(true)}>Turn on</button>}
        </div>
      </div>
    </div>
  );
}
