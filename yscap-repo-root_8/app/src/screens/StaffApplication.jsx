import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { fileToBase64 } from '../lib/files.js';
import { useAuth } from '../lib/auth.jsx';
import ChatThread from '../components/ChatThread.jsx';
import { NewChatModal } from './StaffChat.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import DealSnapshot from '../components/DealSnapshot.jsx';
import EditFileDetails from '../components/EditFileDetails.jsx';
import ToolModal from '../components/ToolModal.jsx';
import FileSections, { Section, InfoTip } from '../components/FileSections.jsx';
import StaticToolFrame from '../components/StaticToolFrame.jsx';
import AddConditionPanel from '../components/AddConditionPanel.jsx';
import StaffChangeRequests from '../components/StaffChangeRequests.jsx';
import FileContacts from '../components/FileContacts.jsx';
import DocPreview from '../components/DocPreview.jsx';
import ReminderModal from '../components/ReminderModal.jsx';
import LlcManager, { US_STATES } from '../components/LlcManager.jsx';

// Small inline eye toggle for the SSN reveal (revealing is server-audited).
const Eye = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
);
const EyeOff = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" /></svg>
);

/* What the borrower has and hasn't completed — so the officer sees at a glance
   what still needs chasing without opening every panel. */
// Field metadata shared by the staff + borrower completeness panels. `edit`
// false = filled elsewhere (address picker / secure SSN flow) so we only hint.
const COMPLETENESS_FIELDS = (app, borrower) => [
  { key: 'property_address', label: 'Property address', ok: !!(app.property_address && (app.property_address.oneLine || app.property_address.street)), edit: false, hint: 'Set from the property address field on the file.' },
  { key: 'property_type', label: 'Property type', ok: !!app.property_type, type: 'select', options: ['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed Use'] },
  { key: 'program', label: 'Program', ok: !!app.program, type: 'select', options: ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction'] },
  { key: 'loan_type', label: 'Loan type', ok: !!app.loan_type, type: 'select', options: ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out'] },
  { key: 'purchase_price', label: 'Purchase price', ok: app.purchase_price != null, type: 'money' },
  { key: 'arv', label: 'ARV', ok: app.arv != null, type: 'money' },
  { key: 'rehab_budget', label: 'Rehab budget', ok: app.rehab_budget != null, type: 'money' },
  { key: 'cell_phone', label: 'Borrower phone', ok: !!(borrower && borrower.cell_phone), type: 'tel' },
  { key: 'date_of_birth', label: 'Date of birth', ok: !!(borrower && borrower.date_of_birth), type: 'date' },
  { key: 'ssn', label: 'SSN on file', ok: !!(borrower && borrower.ssn_last4), edit: false, hint: 'Enter via the secure SSN field on the borrower profile.' },
  { key: 'fico', label: 'FICO', ok: !!(borrower && borrower.fico), type: 'number' },
  { key: 'citizenship', label: 'Citizenship', ok: !!(borrower && borrower.citizenship), type: 'select', options: ['US Citizen', 'Permanent Resident', 'Foreign National'] },
  // #73 — when a co-borrower is linked, THEIR personal info is required too (not
  // a condition — required fields). Filled in the Co-borrower panel (so edit:
  // false here). Gated to payloads that actually carry the co-borrower join
  // (the staff file), so they never show as spuriously-missing on the borrower's
  // own completeness view.
  ...((app.co_borrower_id && ('co_first_name' in app)) ? [
    { key: 'co_name', label: 'Co-borrower name', ok: !!(app.co_first_name && app.co_last_name), edit: false, hint: 'Enter in the Co-borrower panel.' },
    { key: 'co_email', label: 'Co-borrower email', ok: !!app.co_email, edit: false, hint: 'Enter in the Co-borrower panel.' },
    { key: 'co_phone', label: 'Co-borrower phone', ok: !!app.co_cell_phone, edit: false, hint: 'Enter in the Co-borrower panel.' },
    { key: 'co_dob', label: 'Co-borrower date of birth', ok: !!app.co_date_of_birth, edit: false, hint: 'Enter in the Co-borrower panel.' },
    { key: 'co_ssn', label: 'Co-borrower SSN on file', ok: !!app.co_ssn_last4, edit: false, hint: 'Enter in the Co-borrower panel (stored encrypted).' },
  ] : []),
];

/* Application completeness with INLINE editing — click a missing field to enter
   it right there; it saves to the file (and syncs to ClickUp) without a form.
   `endpoint` differs for staff vs borrower; `onSaved` reloads the file. */
function CompletenessPanel({ app, borrower, endpoint, onSaved, heading = 'Application completeness' }) {
  const [editing, setEditing] = useState(null);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fields = COMPLETENESS_FIELDS(app, borrower);
  const done = fields.filter((x) => x.ok).length;
  const missing = fields.filter((x) => !x.ok);
  const start = (f) => { setEditing(f.key); setVal(''); setErr(''); };
  async function save(f) {
    if (val === '' || val == null) return;
    setBusy(true); setErr('');
    try { await api.post(endpoint, { [f.key]: val }); setEditing(null); setVal(''); await onSaved(); }
    catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3>{heading}</h3>
        <div className="spacer" />
        <span className={`pill ${missing.length ? '' : 'done'}`}>{done}/{fields.length} complete</span>
      </div>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
      {missing.length === 0
        ? <p className="muted small">Everything the application asks for has been provided.</p>
        : (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {missing.map((f) => editing === f.key ? (
              <span key={f.key} className="row" style={{ gap: 4, alignItems: 'center' }}>
                {f.type === 'select'
                  ? <select className="input" style={{ maxWidth: 200 }} value={val} onChange={(e) => setVal(e.target.value)} autoFocus>
                      <option value="" disabled>{f.label}…</option>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  : <input className="input" style={{ maxWidth: 170 }} autoFocus
                      type={f.type === 'date' ? 'date' : f.type === 'number' || f.type === 'money' ? 'number' : f.type === 'tel' ? 'tel' : 'text'}
                      inputMode={f.type === 'money' || f.type === 'number' ? 'numeric' : undefined}
                      placeholder={f.label} value={val} onChange={(e) => setVal(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && save(f)} />}
                <button className="btn primary small" disabled={busy || val === ''} onClick={() => save(f)}>{busy ? '…' : 'Save'}</button>
                <button className="btn ghost small" onClick={() => setEditing(null)}>✕</button>
              </span>
            ) : f.edit === false ? (
              <span key={f.key} className="pill" style={{ borderColor: 'var(--muted)', color: 'var(--muted)' }} title={f.hint}>Missing: {f.label}</span>
            ) : (
              <button key={f.key} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)', cursor: 'pointer', background: 'none' }}
                onClick={() => start(f)} title="Click to enter it now">+ {f.label}</button>
            ))}
          </div>
        )}
    </div>
  );
}

function Completeness({ app, borrower, appId, onSaved }) {
  return <CompletenessPanel app={app} borrower={borrower}
    endpoint={`/api/staff/applications/${appId}/complete-fields`} onSaved={onSaved} />;
}

/* Staff-only file detail the team keeps in ClickUp — pulled onto the file for a
   complete picture (rates, carrying costs, valuation, title/insurance, liens,
   pipeline status). Read-only here; ClickUp remains the source of truth for these
   (pull-only, never pushed back). Only populated rows show, grouped for a fast scan. */
function ClickupFileData({ app }) {
  const cash = (n) => (n == null || n === '' ? null : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  const str = (v) => (v == null || v === '' ? null : String(v));
  const groups = [
    ['Rates', [
      ['Actual interest rate', str(app.actual_rate)],
      ['Desired interest rate', str(app.desired_rate)],
      ['Prepayment penalty', str(app.prepayment_penalty)],
    ]],
    ['Carrying costs', [
      ['Property taxes', cash(app.property_taxes)],
      ['Property insurance', cash(app.property_insurance)],
      ['HOA', cash(app.property_hoa)],
      ['Rental income', cash(app.rental_income)],
    ]],
    ['Valuation', [
      ['Appraised rental value', cash(app.appraised_rental_value)],
      ['Approx. appraised rental', cash(app.approx_appraised_rental_value)],
      ['CDA value', cash(app.cda_value)],
      ["Appraiser's name", str(app.appraiser_name)],
    ]],
    ['Liens', [
      ['1st lien', cash(app.first_lien)],
      ['2nd lien', cash(app.second_lien)],
    ]],
    ['Title & insurance', [
      ['Title company', str(app.title_company)],
      ['Title contact', str(app.title_company_contact)],
      ['Insurance company', str(app.insurance_company)],
      ['Insurance contact', str(app.insurance_company_contact)],
    ]],
    ['Pipeline', [
      ['Application submitted', str(app.application_submitted)],
      // Encompass origin ("File originally started in Encompass") is intentionally
      // NOT displayed on any front-end surface (owner-directed) — it stays in the
      // backend (encompass_status column) but is never shown to staff or borrower.
    ]],
  ];
  const shown = groups
    .map(([g, rows]) => [g, rows.filter(([, v]) => v != null)])
    .filter(([, rows]) => rows.length);
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3>File detail from ClickUp</h3>
        <div className="spacer" />
        <span className="muted small">Pulled from the pipeline · read-only</span>
      </div>
      {shown.length === 0
        ? <p className="muted small">No additional pipeline detail synced for this file yet.</p>
        : (
          <div className="grid cols-2" style={{ gap: '2px 24px' }}>
            {shown.map(([g, rows]) => (
              <div key={g} style={{ breakInside: 'avoid' }}>
                <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', margin: '10px 0 4px' }}>{g}</div>
                {rows.map(([k, v]) => (
                  <div className="metrow" key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
                ))}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const kb = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street || a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ') || '—');
// Build the Rehab Budget / Scope of Work builder URL SEEDED from the file —
// same prefill the borrower gets (address, transaction, property/project type,
// target construction budget) plus internal=1 so it talks to the staff
// tool-state endpoints. Previously the staff link was bare, so the builder
// opened empty instead of pre-filled.
function sowUrl(appId, itemId, app) {
  const p = new URLSearchParams({ app: appId, item: itemId, internal: '1', embed: '1' });
  const a = app || {};
  const pa = a.property_address;
  const addr = pa ? (pa.oneLine || [pa.street || pa.line1, pa.city, pa.state, pa.zip].filter(Boolean).join(', ')) : '';
  if (addr) p.set('address', addr);
  const units = Number(a.units) || 0;
  if (units > 0) p.set('units', String(units));
  p.set('propType', units >= 5 ? 'large' : units >= 2 ? 'multi' : 'single');
  if (a.loan_type && /refi/i.test(a.loan_type)) p.set('txn', 'refi');
  else if (a.loan_type && /purchase/i.test(a.loan_type)) p.set('txn', 'purchase');
  const rt = String(a.rehab_type || a.program || '');
  if (/ground/i.test(rt)) p.set('projType', 'ground');
  else if (/heavy|gut/i.test(rt)) p.set('projType', 'heavy');
  else if (/moderate/i.test(rt)) p.set('projType', 'moderate');
  else if (/cosmetic/i.test(rt)) p.set('projType', 'cosmetic');
  if (Number(a.rehab_budget) > 0) p.set('target', String(Math.round(Number(a.rehab_budget))));
  // Gold Standard files auto-fill a 5% construction contingency in the builder.
  if (/gold/i.test(String(a.registered_program || ''))) p.set('program', 'gold');
  return `/tools/rehab-budget.html?${p.toString()}`;
}
const STATUSES = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
const APP_STATUSES = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'declined', 'withdrawn'];
const APP_STATUS_LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
const PHASE_LABEL = {
  p1_intake: 'Phase 1 · Borrower Intake', p2_setup: 'Phase 2 · File Setup',
  p3_verify: 'Phase 3 · Verifications', p4_appraisal: 'Phase 4 · Appraisal & Numbers',
  p5_closing: 'Phase 5 · Closing Prep',
};
const phaseName = (p) => PHASE_LABEL[p] || (p ? p.replace(/_/g, ' ') : 'General');

function Badge({ children, tone }) {
  return <span className="pill" style={tone === 'gold' ? { borderColor: 'var(--gold)', color: 'var(--gold)' } : undefined}>{children}</span>;
}

// Completing / signing off is the PROCESSOR's call (admins too); a loan
// officer marks conditions REVIEWED instead — mirrored server-side. This is a
// UI hint by role default; the server enforces the sign_off_conditions
// capability (incl. the loan-coordinator persona and per-user overrides).
const canComplete = (role) => ['processor', 'admin', 'super_admin', 'underwriter', 'loan_coordinator'].includes(role);

function Item({ it, team, onPatch, role, docs, onUploadTo, onDropTo, onReviewDoc, onDownloadDoc, dlBusy, onPreview }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(it.notes || '');
  const signed = !!it.signed_off_at;
  const completer = canComplete(role);
  // Staff-only DOCUMENT conditions (e.g. Insurance, Title) get an upload area in
  // the internal checklist, mirroring the borrower-conditions document block.
  // `it.slots` is a FIXED named-slot array (Insurance → binder + invoice) or
  // null/absent for a FREE-FORM multi-document condition (Title).
  const isDoc = it.item_kind === 'document';
  const slots = Array.isArray(it.slots) && it.slots.length ? it.slots : null;
  const itemDocs = (isDoc && docs)
    ? docs.filter(d => d.checklist_item_id === it.id && d.is_current && d.source_type !== 'chat_attachment')
    : [];
  return (
    <div className="checkitem" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
        <span className={`dot ${signed || it.status === 'satisfied' ? 'done' : 'outstanding'}`} style={{ marginTop: 4 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{it.label}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <Badge>{it.audience}</Badge>
            {it.role_scope && <Badge>{it.role_scope}</Badge>}
            <Badge>{it.item_kind}</Badge>
            {it.is_gate && <Badge tone="gold">gate</Badge>}
            {it.is_milestone && <Badge tone="gold">milestone</Badge>}
            {it.tool_key && <Badge tone="gold">{it.tool_submitted ? 'borrower submitted' : 'borrower task'}</Badge>}
          </div>
          {it.hint && <div className="muted small" style={{ marginTop: 4 }}>{it.hint}</div>}
          {it.assignee_name && <div className="muted small">Assigned to {it.assignee_name}</div>}
          {signed && <div className="muted small">Signed off by {it.signed_off_name || 'the internal team'} · {new Date(it.signed_off_at).toLocaleDateString()}</div>}
          {it.reviewed_at && <div className="muted small">Reviewed by {it.reviewed_by_name || 'the loan officer'} · {new Date(it.reviewed_at).toLocaleDateString()}</div>}
          {(it.issue_reason || it.rejection_reason) && (
            <div className="small" style={{ marginTop: 4, color: 'var(--danger)' }}>Sent back to the borrower: {it.issue_reason || it.rejection_reason}</div>
          )}
          {it.tool_key && it.tool_submitted && (
            <button className="btn link small" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'View'} submission</button>
          )}
          {open && it.tool_payload && (
            <pre className="panel small" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
              {JSON.stringify(it.tool_payload, null, 2)}
            </pre>
          )}
        </div>
      </div>

      {isDoc && (onUploadTo || itemDocs.length > 0) && (
        <div style={{ width: '100%', paddingLeft: 20 }}
          className={(!slots && onDropTo) ? 'cond-drop' : undefined}
          onDragOver={(!slots && onDropTo) ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); } : undefined}
          onDragLeave={(!slots && onDropTo) ? (e) => { e.currentTarget.classList.remove('drop-over'); } : undefined}
          onDrop={(!slots && onDropTo) ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); const f = Array.from(e.dataTransfer.files || []); if (f.length) onDropTo(f, { itemId: it.id, slotBase: itemDocs.length }); } : undefined}>
          {slots ? (
            /* Fixed named slots (e.g. Insurance → binder + invoice) — each slot is
               its own drop target so a dropped file lands in the right slot. */
            slots.map(slot => {
              const doc = itemDocs.find(d => (d.slot_label || '') === slot.label);
              const rs = doc ? (doc.review_status || 'pending') : null;
              const slotTarget = doc ? { itemId: it.id, slot: slot.label, replaceDocumentId: doc.id } : { itemId: it.id, slot: slot.label };
              return (
                <div className={`row${onDropTo ? ' cond-drop' : ''}`} key={slot.key || slot.label} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}
                  onDragOver={onDropTo ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); } : undefined}
                  onDragLeave={onDropTo ? (e) => { e.currentTarget.classList.remove('drop-over'); } : undefined}
                  onDrop={onDropTo ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); const f = Array.from(e.dataTransfer.files || []); if (f.length) onDropTo(f, slotTarget); } : undefined}>
                  <span className="muted small" style={{ minWidth: 140 }}>{slot.label}</span>
                  {doc ? (
                    <>
                      <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.filename}</span>
                      <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                      {onPreview && <button className="btn ghost small" title="Preview without downloading" onClick={() => onPreview(doc)}>Preview</button>}
                      <button className="btn ghost small" disabled={dlBusy === doc.id} onClick={() => onDownloadDoc(doc)}>{dlBusy === doc.id ? '…' : 'Download'}</button>
                      {onUploadTo && <button className="btn link small" title="Replace this document with a new version" onClick={() => onUploadTo({ itemId: it.id, slot: slot.label, replaceDocumentId: doc.id })}>Replace</button>}
                      {completer && rs !== 'accepted' && <button className="btn primary small" onClick={() => onReviewDoc(doc, 'accept')}>Accept</button>}
                      {completer && <button className="btn ghost small" title="Accept this document but keep the condition open — ask the borrower for one more" onClick={() => onReviewDoc(doc, 'accept_more')}>Accept +1 more</button>}
                      {rs !== 'rejected' && <button className="btn link small" onClick={() => onReviewDoc(doc, 'reject')}>Reject</button>}
                    </>
                  ) : (
                    <>
                      <span className="small muted" style={{ flex: 1 }}>not uploaded</span>
                      {onUploadTo && <button className="btn ghost small" onClick={() => onUploadTo({ itemId: it.id, slot: slot.label })}>Upload</button>}
                    </>
                  )}
                </div>
              );
            })
          ) : (
            /* Free-form: any number of documents, additive (e.g. Title). */
            <>
              {itemDocs.map((d, i) => {
                const rs = d.review_status || 'pending';
                return (
                  <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                    <span className="muted small" style={{ minWidth: 90 }}>{d.slot_label || `Document ${i + 1}`}</span>
                    <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                    <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                    {onPreview && <button className="btn ghost small" title="Preview without downloading" onClick={() => onPreview(d)}>Preview</button>}
                    <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => onDownloadDoc(d)}>{dlBusy === d.id ? '…' : 'Download'}</button>
                    {onUploadTo && d.source_type !== 'system' && <button className="btn link small" title="Replace this document with a new version" onClick={() => onUploadTo({ itemId: it.id, slot: d.slot_label || undefined, replaceDocumentId: d.id })}>Replace</button>}
                    {completer && rs !== 'accepted' && <button className="btn primary small" onClick={() => onReviewDoc(d, 'accept')}>Accept</button>}
                    {completer && <button className="btn ghost small" title="Accept this document but keep the condition open — ask the borrower for one more" onClick={() => onReviewDoc(d, 'accept_more')}>Accept +1 more</button>}
                    {rs !== 'rejected' && <button className="btn link small" onClick={() => onReviewDoc(d, 'reject')}>Reject</button>}
                  </div>
                );
              })}
              {onUploadTo && (
                <div style={{ padding: '3px 0' }}>
                  <button className="btn ghost small"
                    title="Upload documents into this condition (multiple at once supported)"
                    onClick={() => onUploadTo({ itemId: it.id, slotBase: itemDocs.length })}>
                    {itemDocs.length ? '+ Add another document' : 'Upload'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="row" style={{ width: '100%', gap: 8, flexWrap: 'wrap' }}>
        <select className="input" style={{ maxWidth: 150 }} value={it.status}
          onChange={e => onPatch(it.id, { status: e.target.value })}>
          {STATUSES.filter(s => completer || s !== 'satisfied' || it.status === 'satisfied').map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 180 }} value={it.assignee_staff_id || ''}
          onChange={e => onPatch(it.id, { assigneeStaffId: e.target.value || null })}>
          <option value="">Unassigned</option>
          {team.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
        </select>
        {/* LO "Done": marks the condition completed/submitted from the loan
            officer's side (owner-directed #133). It clears off the LO's default
            filter but the processor's list keeps it until SHE signs off. */}
        {it.reviewed_at
          ? <button className="btn ghost" title="You marked this done — undo to put it back on your list" onClick={() => onPatch(it.id, { reviewed: false })}>Undo done</button>
          : <button className="btn ghost" title="Mark this condition done (loan-officer step). The processor still signs it off." onClick={() => onPatch(it.id, { reviewed: true })}>Done</button>}
        {completer && (signed
          ? <button className="btn ghost" onClick={() => onPatch(it.id, { signedOff: false })}>Undo sign-off</button>
          : <button className="btn primary" title="Sign off = the whole condition is complete (processor step). This is what removes it from the list for everyone." onClick={() => onPatch(it.id, { signedOff: true })}>Sign off</button>)}
        {it.audience !== 'staff' && (
          <button className="btn ghost" title="Send this condition back to the borrower with a reason (reopens it, clears any sign-off)"
            onClick={() => {
              const reason = window.prompt(signed || it.status === 'satisfied'
                ? 'Reopen and send this back to the borrower — what needs to change? (they will see this)'
                : 'Send this back to the borrower — what needs to change? (they will see this)');
              if (reason == null || !reason.trim()) return;
              onPatch(it.id, { pushBack: true, issueReason: reason.trim() });
            }}>{signed || it.status === 'satisfied' ? 'Reopen / send back' : 'Send back'}</button>
        )}
        {!completer && <span className="muted small" style={{ alignSelf: 'center' }}>Completion is the processor's sign-off.</span>}
      </div>
      <div className="row" style={{ width: '100%', gap: 8 }}>
        <input className="input" placeholder="Add a note…" value={notes} onChange={e => setNotes(e.target.value)} />
        <button className="btn ghost" onClick={() => onPatch(it.id, { notes })}>Save note</button>
      </div>
    </div>
  );
}

/* Every LLC of this borrower — the staff review surface for the LLC section.
   The file's vesting entity is expanded first; each LLC shows its details,
   full ownership structure, and the three document slots with per-document
   Accept / Reject, plus the whole-LLC "Mark verified" sign-off. Verifying an
   entity auto-satisfies the LLC condition on every open file it vests;
   revoking (or rejecting one of its documents) reopens those conditions. */
function LlcReview({ appId, app, onReviewDoc, onDownloadDoc, dlBusy, onChanged, reviewBusy, onPreview, role }) {
  // Verifying an LLC signs off the entity condition — processor/underwriter only,
  // never a loan officer (#126). The LO can still reject documents and raise issues.
  const completer = canComplete(role);
  const [llcs, setLlcs] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  // Staff can upload directly into an entity's document slots (e.g. the borrower
  // emailed a formation doc) — same shared slots the borrower uploads into.
  const fileRef = useRef(null);
  const [upTarget, setUpTarget] = useState(null);   // {llcId, itemId, slotLabel, replaceDocumentId}
  const pickSlot = (t) => { setUpTarget(t); if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } };
  // Full parity with the borrower: staff can enter/correct entity details and
  // the ownership structure directly (not just review). A verified entity is
  // locked — revoke verification first.
  const [editId, setEditId] = useState(null);   // llc whose details are being edited
  const [ef, setEf] = useState(null);           // {llcName, ein, formationState, formationDate, ownershipPct}
  const [em, setEm] = useState(null);           // members [{fullName, ownershipPct, email}]
  const [showCreate, setShowCreate] = useState(false);
  // #57 — the file's vesting entity is the focus; other borrower entities stay
  // collapsed behind this toggle so staff verify just the LLC on this property.
  const [showOthers, setShowOthers] = useState(false);
  const blankCreate = { llcName: '', ein: '', formationState: '', formationDate: '', ownershipPct: '' };
  const [cf, setCf] = useState(blankCreate);
  function beginEdit(l) {
    setEditId(l.id); setErr('');
    setEf({ llcName: l.llc_name || '', ein: l.ein || '', formationState: l.formation_state || '',
      formationDate: l.formation_date ? String(l.formation_date).slice(0, 10) : '',
      ownershipPct: l.ownership_pct == null ? '' : String(l.ownership_pct) });
    setEm((l.members || []).map(m => ({ fullName: m.full_name, ownershipPct: String(m.ownership_pct), email: m.email || '' })));
  }
  async function saveEdit(l) {
    setBusy('edit-' + l.id); setErr('');
    try {
      await api.staffUpdateLlc(l.id, ef);
      await api.staffSaveLlcMembers(l.id, (em || []).filter(m => m.fullName.trim()).map(m => ({
        fullName: m.fullName.trim(), ownershipPct: Number(m.ownershipPct), email: m.email.trim() || undefined })));
      flash('Entity saved ✓ — the borrower sees the same details.');
      setEditId(null); await load(); onChanged && await onChanged();
    } catch (e) { setErr(e.message || 'Could not save the entity'); }
    finally { setBusy(''); }
  }
  const entityGate = useSubmitGate();
  async function createEntity() {
    if (!cf.llcName.trim()) { setErr('Entity name is required'); return; }
    if (!entityGate.enter()) return;       // a create is already in flight (double-click)
    setBusy('create'); setErr('');
    try {
      const created = await api.staffCreateLlc(app.borrower_id, {
        llcName: cf.llcName.trim(), ein: cf.ein || undefined, formationState: cf.formationState || undefined,
        formationDate: cf.formationDate || undefined, ownershipPct: cf.ownershipPct === '' ? undefined : Number(cf.ownershipPct) });
      // The verify list is now scoped to the vesting + track-record entities, so a
      // brand-new entity would not appear unless it's linked. When the file has no
      // vesting entity yet, the one just created here IS the file's vesting entity —
      // link it so it shows (and drives the LLC condition). If one already exists,
      // leave it: this was a plain library add and will surface once tied to a deal.
      if (!app.llc_id && created && created.llcId) {
        try { await api.staffSetVestingLlc(appId, created.llcId); } catch (_) { /* best-effort */ }
      }
      flash('Entity created ✓ — its document slots are ready for upload.');
      setShowCreate(false); setCf(blankCreate); await load(); onChanged && await onChanged();
    } catch (e) { setErr(e.message || 'Could not create the entity'); }
    finally { setBusy(''); entityGate.leave(); }
  }
  // Shared by the file picker AND per-slot drag-and-drop — target passed in.
  async function uploadLlcFiles(fileList, tgt) {
    const files = Array.from(fileList || []);
    if (!files.length || !tgt) return;
    setBusy(tgt.itemId); setErr('');
    try {
      // Upload every selected file to this entity slot. On a "replace" action only
      // the first file replaces the existing document; any extras are added as new
      // documents on the same slot.
      let first = true;
      for (const file of files) {
        await api.staffUploadAppDoc(appId, {
          llcId: tgt.llcId, checklistItemId: tgt.itemId, slot: tgt.slotLabel || undefined,
          replaceDocumentId: (first ? tgt.replaceDocumentId : null) || undefined,
          filename: file.name, contentType: file.type, dataBase64: await fileToBase64(file),
        });
        first = false;
      }
      flash(files.length > 1 ? `Uploaded ${files.length} files to the entity ✓ — the borrower sees them too.` : 'Uploaded to the entity ✓ — the borrower sees it too.');
      setUpTarget(null); await load(); onChanged && await onChanged();
    } catch (e2) { setErr(e2.message || 'Upload failed'); }
    finally { setBusy(''); }
  }
  const onFile = (e) => uploadLlcFiles(e.target && e.target.files, upTarget);

  // Scope to the entities that matter for THIS file: the vesting entity + the
  // borrower's (and co-borrower's) track-record entities — NOT the borrower's
  // whole LLC library. The endpoint marks the vesting one with `vesting:true`.
  const load = () => appId
    ? api.staffAppVerifyLlcs(appId).then(r => setLlcs(r.llcs || [])).catch(e => { setErr(e.message || 'Could not load entities'); setLlcs([]); })
    : Promise.resolve();
  useEffect(() => { setOpenId(app.llc_id || null); load(); /* eslint-disable-next-line */ }, [appId, app.llc_id]);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };

  async function setVerified(llc, verified) {
    if (busy) return;
    let reason;
    if (!verified) {
      reason = window.prompt('Revoke verification of this LLC? The LLC condition reopens on every open file vesting in it, and the borrower is notified. Reason (the borrower is told why — required):');
      if (reason === null || !reason.trim()) return;   // reason is required (#125)
    } else if (!window.confirm(`Mark "${llc.llc_name}" as a verified LLC? The LLC condition on every open file vesting in it is satisfied and signed off automatically.`)) return;
    setBusy(llc.id); setErr('');
    try {
      await api.staffVerifyLlc(llc.id, verified ? { verified: true } : { verified: false, reason: reason || undefined });
      flash(verified ? 'LLC verified ✓ — linked files updated.' : 'Verification revoked — linked files reopened.');
      await load(); onChanged && await onChanged();
    } catch (e) {
      if (e.status === 409 && e.data && e.data.missing) setErr(`Not ready to verify: ${e.data.missing.join(' · ')}`);
      else setErr(e.message || 'Could not update the LLC');
    } finally { setBusy(''); }
  }

  async function review(slot, action) {
    await onReviewDoc({ id: slot.document_id, filename: slot.filename }, action);
    await load();
  }

  if (!app.borrower_id) return null;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onFile} />
      <div className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
        <h3>Vesting entity (LLC)</h3>
        <div className="spacer" />
        <span className="muted small">{llcs ? `${llcs.length} entit${llcs.length === 1 ? 'y' : 'ies'}` : ''}</span>
        <button className="btn ghost small" onClick={() => { setShowCreate(v => !v); setErr(''); }}>{showCreate ? 'Cancel' : '+ Add entity'}</button>
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        The LLC taking title on this property. Confirm its details, ownership (to 100%) and the three
        documents, then mark it verified — that satisfies the internal LLC condition on this and every
        future file it vests. This is the borrower's reusable entity, so anything you enter mirrors their
        profile. Only this file's entities are shown — the vesting entity plus any entities from the
        borrower's track record; unrelated entities on the borrower are not listed here.
      </p>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}
      {showCreate && (
        <div className="panel" style={{ marginBottom: 12, background: 'var(--ink-2)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>New entity for this borrower</div>
          <div className="ts-inputs">
            <label style={{ gridColumn: '1 / -1' }}><span>Entity name *</span>
              <input className="input" value={cf.llcName} onChange={e => setCf({ ...cf, llcName: e.target.value })} placeholder="Acme Holdings LLC" /></label>
            <label><span>EIN</span>
              <input className="input" value={cf.ein} placeholder="XX-XXXXXXX" onChange={e => setCf({ ...cf, ein: e.target.value })} /></label>
            <label><span>Formation state</span>
              <select className="input" value={cf.formationState} onChange={e => setCf({ ...cf, formationState: e.target.value })}>
                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
            <label><span>Formation date</span>
              <input className="input" type="date" value={cf.formationDate} onChange={e => setCf({ ...cf, formationDate: e.target.value })} /></label>
            <label><span>Borrower ownership %</span>
              <input className="input" type="number" min="0" max="100" value={cf.ownershipPct} onChange={e => setCf({ ...cf, ownershipPct: e.target.value })} /></label>
          </div>
          <button className="btn primary small" style={{ marginTop: 8 }} disabled={busy === 'create'} onClick={createEntity}>{busy === 'create' ? 'Creating…' : 'Create entity'}</button>
        </div>
      )}
      {llcs == null ? <p className="muted small">Loading…</p>
        : llcs.length === 0 ? <p className="muted small">{app.llc_id
            ? "The vesting entity linked to this file isn't loading — refresh the page."
            : 'No vesting entity or track-record entities to verify yet. Use “+ Add entity” to create and link this file’s vesting entity.'}</p>
        : (() => {
          // #57 — render JUST the vesting entity for THIS file up top; the file's
          // track-record entities collapse behind a toggle so staff verify the one
          // that matters without wading through unrelated entities.
          const renderLlc = (l) => {
          const linked = l.vesting || l.id === app.llc_id;
          const open = openId === l.id;
          const c = l.completeness || {};
          const total = (Number(l.ownership_pct) || 0) + (Number(c.member_total_pct) || 0);
          return (
            <div className="checkitem" key={l.id} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
              <div className="row" style={{ width: '100%', gap: 8, alignItems: 'center' }}>
                <span className={`dot ${l.is_verified ? 'done' : 'outstanding'}`} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {l.llc_name}
                    {linked && <span className="pill" style={{ marginLeft: 8, borderColor: 'var(--teal)', color: 'var(--teal)' }}>Vesting entity for this file</span>}
                  </div>
                  <div className="muted small">
                    {l.formation_state || 'state —'} · EIN {l.ein || '—'} · {c.docs_accepted || 0}/{c.docs_required || 3} docs accepted
                    {l.is_verified && l.verified_at ? ` · verified ${new Date(l.verified_at).toLocaleDateString()}` : ''}
                  </div>
                </div>
                <span className={`ts-badge ${l.is_verified ? 'ok' : (l.missing || []).length ? 'warn' : 'ok'}`}>
                  {l.is_verified ? 'Verified LLC ✓' : (l.missing || []).length ? 'Unverified' : 'Ready to verify'}
                </span>
                {(l.completeness || {}).gs_expired &&
                  <span className="ts-badge warn" style={{ marginLeft: 6 }} title="The Certificate of Good Standing on file is more than 30 days old — upload a current one. The entity stays verified.">Good standing expired</span>}
                <button className="btn ghost small" onClick={() => setOpenId(open ? null : l.id)}>{open ? 'Close' : 'Review'}</button>
              </div>
              {open && (
                <div style={{ width: '100%', paddingLeft: 20 }}>
                  {editId === l.id ? (
                    /* ---- editable entity details + ownership (staff parity) ---- */
                    (() => {
                      const eOwn = Number(ef.ownershipPct) || 0;
                      const eMemTotal = (em || []).reduce((s, m) => s + (Number(m.ownershipPct) || 0), 0);
                      const eTotal = eOwn + eMemTotal;
                      return (
                        <div style={{ marginBottom: 10 }}>
                          <div className="ts-inputs">
                            <label style={{ gridColumn: '1 / -1' }}><span>Entity name</span>
                              <input className="input" value={ef.llcName} onChange={e => setEf({ ...ef, llcName: e.target.value })} /></label>
                            <label><span>EIN</span>
                              <input className="input" value={ef.ein} placeholder="XX-XXXXXXX" onChange={e => setEf({ ...ef, ein: e.target.value })} /></label>
                            <label><span>Formation state</span>
                              <select className="input" value={ef.formationState} onChange={e => setEf({ ...ef, formationState: e.target.value })}>
                                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                              </select></label>
                            <label><span>Formation date</span>
                              <input className="input" type="date" value={ef.formationDate} onChange={e => setEf({ ...ef, formationDate: e.target.value })} /></label>
                            <label><span>Borrower ownership %</span>
                              <input className="input" type="number" min="0" max="100" value={ef.ownershipPct} onChange={e => setEf({ ...ef, ownershipPct: e.target.value })} /></label>
                          </div>
                          <div style={{ fontWeight: 600, marginTop: 12 }}>Other members</div>
                          <p className="muted small" style={{ marginBottom: 6 }}>Everyone besides the borrower, until ownership totals 100%.</p>
                          {(em || []).map((m, i) => (
                            <div className="row" key={i} style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                              <input className="input" style={{ flex: 2, minWidth: 150 }} placeholder="Member full name" value={m.fullName}
                                onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, fullName: e.target.value } : x))} />
                              <input className="input" style={{ width: 90 }} type="number" min="0.01" max="99.99" placeholder="%" value={m.ownershipPct}
                                onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, ownershipPct: e.target.value } : x))} />
                              <input className="input" style={{ flex: 2, minWidth: 150 }} type="email" placeholder="Email (optional)" value={m.email}
                                onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
                              <button className="btn link small" onClick={() => setEm(ms => ms.filter((_, j) => j !== i))}>Remove</button>
                            </div>
                          ))}
                          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                            <button className="btn ghost small" onClick={() => setEm(ms => [...(ms || []), { fullName: '', ownershipPct: '', email: '' }])}>+ Add a member</button>
                            {/* #102 — one click adds the file's co-borrower to the ownership
                                structure with their details pre-filled; just enter their %. */}
                            {app.co_borrower_id && (() => {
                              const coName = `${app.co_first_name || ''} ${app.co_last_name || ''}`.trim();
                              const already = coName && (em || []).some(m => (m.fullName || '').trim().toLowerCase() === coName.toLowerCase());
                              return coName && !already ? (
                                <button className="btn ghost small"
                                  title="Add the file's co-borrower as an additional owner — their info is filled automatically; enter their ownership %"
                                  onClick={() => setEm(ms => [...(ms || []), { fullName: coName, ownershipPct: '', email: app.co_email || '' }])}>
                                  + Add co-borrower ({coName}) as owner
                                </button>
                              ) : null;
                            })()}
                            <span className={`ts-badge ${Math.abs(eTotal - 100) <= 0.01 ? 'ok' : 'warn'}`}>
                              {Math.abs(eTotal - 100) <= 0.01 ? 'Ownership 100% ✓' : `Ownership ${Math.round(eTotal * 100) / 100 || 0}%`}
                            </span>
                          </div>
                          <div className="row" style={{ gap: 8, marginTop: 10 }}>
                            <button className="btn primary small" disabled={busy === 'edit-' + l.id} onClick={() => saveEdit(l)}>{busy === 'edit-' + l.id ? 'Saving…' : 'Save entity'}</button>
                            <button className="btn ghost small" disabled={busy === 'edit-' + l.id} onClick={() => { setEditId(null); setErr(''); }}>Cancel</button>
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                  <div className="row" style={{ gap: 14, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
                    <span className="muted small">Formed {l.formation_date ? new Date(l.formation_date).toLocaleDateString() : '—'}</span>
                    <span className="muted small">Borrower owns {l.ownership_pct != null ? `${l.ownership_pct}%` : '—'}</span>
                    {(l.members || []).map(m => (
                      <span key={m.id} className="muted small">
                        {m.full_name}: {m.ownership_pct}%
                        {Number(m.ownership_pct) >= 20 && <span className="pill" style={{ marginLeft: 4, borderColor: 'var(--gold)', color: 'var(--gold)' }}>≥20% — guarantor likely required</span>}
                      </span>
                    ))}
                    <span className={`ts-badge ${Math.abs(total - 100) <= 0.01 ? 'ok' : 'warn'}`}>
                      {Math.abs(total - 100) <= 0.01 ? 'Ownership 100% ✓' : `Ownership ${total || 0}%`}
                    </span>
                    {!l.is_verified && <button className="btn ghost small" onClick={() => beginEdit(l)}>Edit details</button>}
                  </div>
                  )}
                  {(() => {
                    // Underwriting advisories: never gate verification, always visible.
                    const notes = [...(c.advisories || [])];
                    const propState = app.property_address && app.property_address.state;
                    if (linked && propState && l.formation_state && String(propState).toUpperCase() !== String(l.formation_state).toUpperCase())
                      notes.push(`Formed in ${l.formation_state}, property in ${propState} — foreign entity registration in ${propState} is likely required`);
                    if (l.is_verified && l.verified_at && (Date.now() - new Date(l.verified_at).getTime()) > 365 * 86400000)
                      notes.push('Verified over a year ago — re-verification recommended (fresh Good Standing certificate)');
                    return notes.length ? (
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {notes.map((n, i) => <span key={i} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}>{n}</span>)}
                      </div>
                    ) : null;
                  })()}
                  {(l.slots || []).map(s => {
                    const rs = s.document_id ? s.review_status : null;
                    // The Certificate of Good Standing ships OPTIONAL by default —
                    // the officer/processor flips it to required per file/entity,
                    // and it then gates the LLC's verification.
                    const toggleable = /good standing/i.test(s.label || '');
                    // Per-slot drag-and-drop: drop a file onto this slot to upload
                    // it there (replaces the current doc if one exists). Locked
                    // once the LLC is verified.
                    const canDropSlot = !l.is_verified;
                    const slotTarget = { llcId: l.id, itemId: s.item_id, slotLabel: s.slot_label || s.label, replaceDocumentId: s.document_id || undefined };
                    return (
                      <div className={`row${canDropSlot ? ' cond-drop' : ''}`} key={s.item_id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0', alignItems: 'center' }}
                        onDragOver={canDropSlot ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); } : undefined}
                        onDragLeave={canDropSlot ? (e) => { e.currentTarget.classList.remove('drop-over'); } : undefined}
                        onDrop={canDropSlot ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); const f = Array.from(e.dataTransfer.files || []); if (f.length) uploadLlcFiles(f, slotTarget); } : undefined}>
                        <span className="muted small" style={{ minWidth: 170 }}>{s.label}{s.is_required === false ? ' (optional)' : ''}</span>
                        {toggleable && (
                          <button className="btn link small" disabled={!!busy}
                            title={s.is_required === false
                              ? 'Optional (default) — click to make it REQUIRED: it will gate this LLC\'s verification'
                              : 'Required — click to make it optional again'}
                            onClick={async () => {
                              setBusy(s.item_id); setErr('');
                              try { await api.staffPatchItem(s.item_id, { isRequired: s.is_required === false }); await load(); onChanged && await onChanged(); }
                              catch (e) { setErr(e.message || 'Could not update the requirement'); }
                              finally { setBusy(''); }
                            }}>
                            {s.is_required === false ? 'Make required' : 'Make optional'}
                          </button>
                        )}
                        <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.document_id ? s.filename : <span className="muted">not uploaded</span>}
                        </span>
                        {s.document_id ? (
                          <>
                            <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : { borderColor: 'var(--gold)', color: 'var(--gold)' }}>
                              {rs === 'accepted' ? 'accepted' : rs === 'rejected' ? 'rejected' : 'pending'}
                            </span>
                            {s.reviewed_by_name && <span className="muted small">by {s.reviewed_by_name}</span>}
                            {onPreview && <button className="btn ghost small" title="Preview without downloading" onClick={() => onPreview({ id: s.document_id, filename: s.filename })}>Preview</button>}
                            <button className="btn ghost small" disabled={dlBusy === s.document_id} onClick={() => onDownloadDoc({ id: s.document_id, filename: s.filename })}>{dlBusy === s.document_id ? '…' : 'Download'}</button>
                            {!l.is_verified && (
                              <button className="btn link small" disabled={!!busy}
                                title="Upload a replacement (e.g. the borrower emailed a new copy)"
                                onClick={() => pickSlot({ llcId: l.id, itemId: s.item_id, slotLabel: s.slot_label || s.label, replaceDocumentId: s.document_id })}>Replace</button>
                            )}
                            {completer && rs !== 'accepted' && <button className="btn primary small" disabled={reviewBusy} onClick={() => review(s, 'accept')}>Accept</button>}
                            {rs !== 'rejected' && <button className="btn link small" disabled={reviewBusy} onClick={() => review(s, 'reject')}>Reject</button>}
                          </>
                        ) : (
                          !l.is_verified && (
                            <button className="btn ghost small" disabled={busy === s.item_id}
                              title="Upload this document on the borrower's behalf (e.g. they emailed it to you)"
                              onClick={() => pickSlot({ llcId: l.id, itemId: s.item_id, slotLabel: s.slot_label || s.label })}>
                              {busy === s.item_id ? '…' : 'Upload'}
                            </button>
                          )
                        )}
                        {rs === 'rejected' && s.rejection_reason && <span className="small" style={{ color: 'var(--danger)', width: '100%', paddingLeft: 170 }}>{s.rejection_reason}</span>}
                      </div>
                    );
                  })}
                  <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {l.is_verified
                      ? (completer
                          ? <button className="btn ghost small" disabled={busy === l.id} onClick={() => setVerified(l, false)}>{busy === l.id ? '…' : 'Revoke verification'}</button>
                          : <span className="pill small" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>Verified ✓</span>)
                      : (completer
                          ? <button className="btn primary small" disabled={busy === l.id || (l.missing || []).length > 0}
                              title={(l.missing || []).length ? l.missing.join(' · ') : 'All requirements met'}
                              onClick={() => setVerified(l, true)}>{busy === l.id ? '…' : 'Mark LLC verified'}</button>
                          : <span className="muted small">Verifying is the processor's sign-off — you can reject documents or raise an issue.</span>)}
                    {!l.is_verified && completer && (l.missing || []).length > 0 && (
                      <span className="muted small">Outstanding: {l.missing.slice(0, 4).join(' · ')}{l.missing.length > 4 ? ` · +${l.missing.length - 4} more` : ''}</span>
                    )}
                    {appId && (
                      <button className="btn ghost small" disabled={busy === l.id}
                        title="Post a request/issue about this entity — it becomes a named condition on this file that the borrower can respond to"
                        onClick={async () => {
                          const reason = window.prompt(`Raise an issue on "${l.llc_name}" — what do you need? (the borrower will see this)`);
                          if (reason == null || !reason.trim()) return;
                          setBusy(l.id); setErr(''); setMsg('');
                          try { await api.staffRaiseLlcIssue(l.id, appId, reason.trim()); setMsg(`Issue raised on ${l.llc_name} — added as a condition on this file.`); onChanged && onChanged(); }
                          catch (e) { setErr(e.message || 'Could not raise the issue'); }
                          finally { setBusy(''); }
                        }}>Raise an issue</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
          };
          // Vesting entity first; the rest are the file's track-record entities.
          const vesting = llcs.filter(l => l.vesting || l.id === app.llc_id);
          const others = llcs.filter(l => !(l.vesting || l.id === app.llc_id));
          return (
            <>
              {vesting.map(renderLlc)}
              {app.llc_id && vesting.length === 0 &&
                <p className="muted small">The entity linked to this file isn't loading — refresh the page.</p>}
              {!app.llc_id && others.length > 0 &&
                <p className="muted small" style={{ marginBottom: 8 }}>No vesting entity is linked to this file yet — the entities below are from the borrower's track record. Link one as the vesting entity with “+ Add entity”, or in the file details.</p>}
              {others.length > 0 && (vesting.length > 0
                ? (<>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn link small" onClick={() => setShowOthers(v => !v)}>
                        {showOthers ? 'Hide track-record entities' : `Show ${others.length} track-record entit${others.length === 1 ? 'y' : 'ies'}`}
                      </button>
                    </div>
                    {showOthers && others.map(renderLlc)}
                  </>)
                : others.map(renderLlc))}
            </>
          );
        })()}
    </div>
  );
}

/* The borrower's general track record, embedded seamlessly (no box, no inner
   scrollbar): the SAME static builder the marketing site serves, bridged to
   this borrower's live record. Every staff edit saves to the server and
   refreshes the saved static HTML copy, which downloads right here. */
function StaffTrackRecordPanel({ app, role }) {
  // On a co-borrower file each borrower has their OWN track record (#80): pick
  // whose you're editing. Every deal you add saves to THAT borrower's profile
  // (so a future solo file of theirs pre-populates it), and the file's pricing
  // experience is the SUM of both. Track_records are keyed per borrower_id, so
  // switching the selector just re-points the tool at that borrower.
  const people = [
    { id: app.borrower_id, label: `${app.first_name || 'Primary'} ${app.last_name || ''}`.trim(), role: 'Primary borrower' },
    ...(app.co_borrower_id ? [{ id: app.co_borrower_id, label: `${app.co_first_name || 'Co-borrower'} ${app.co_last_name || ''}`.trim(), role: 'Co-borrower' }] : []),
  ];
  const [selected, setSelected] = useState(app.borrower_id);
  const borrowerId = people.some(p => p.id === selected) ? selected : app.borrower_id;
  const [snap, setSnap] = useState(null);
  const [dl, setDl] = useState(false);
  const [preview, setPreview] = useState(false);
  const [full, setFull] = useState(false);   // full-screen tool sheet (same UX as the Scope of Work)
  // Per-line-item list so staff can raise an issue/request against a SPECIFIC
  // past project — it becomes a named condition on this file the borrower answers.
  const [trs, setTrs] = useState([]);
  const [trDocs, setTrDocs] = useState({});   // { [trackRecordId]: [docs] } — per-line-item uploaded docs
  const [trBusy, setTrBusy] = useState('');
  const [trMsg, setTrMsg] = useState('');
  const completerTR = canComplete(role);
  const refreshTrs = useCallback(() => {
    api.staffBorrowerTrackRecords(borrowerId).then(async rows => {
      const list = Array.isArray(rows) ? rows : [];
      setTrs(list);
      // Pull each line item's uploaded documents so staff can accept/reject them
      // per line item (#126). Best-effort; a failed fetch just shows no docs.
      const docMap = {};
      await Promise.all(list.map(async (t) => {
        try { const d = await api.staffTrackRecordDocs(t.id); docMap[t.id] = Array.isArray(d) ? d : []; } catch (_) { docMap[t.id] = []; }
      }));
      setTrDocs(docMap);
    }).catch(() => { setTrs([]); setTrDocs({}); });
  }, [borrowerId]);
  // Accept / reject a document uploaded against a track-record line item. Reject
  // requires a reason and un-verifies the line item (its evidence no longer stands).
  const reviewTrDoc = useCallback(async (doc, action) => {
    let reason;
    if (action === 'reject') {
      reason = window.prompt('Why is this document being rejected? The borrower is notified and the line item is un-verified until a new document is accepted.');
      if (reason == null || !reason.trim()) return;
    }
    setTrBusy(doc.id); setTrMsg('');
    try { await api.staffReviewDoc(doc.id, action, reason); setTrMsg(action === 'reject' ? 'Document rejected — the borrower was notified.' : 'Document accepted ✓'); refreshTrs(); }
    catch (e) { setTrMsg(e.message || 'Could not review the document'); }
    finally { setTrBusy(''); }
  }, [refreshTrs]);
  const refreshSnap = useCallback(() => {
    api.staffTrackRecordSnapshot(borrowerId).then(setSnap).catch(() => {});
  }, [borrowerId]);
  useEffect(() => { refreshSnap(); refreshTrs(); }, [refreshSnap, refreshTrs]);
  useEffect(() => {
    // the embedded tool announces every sync — the saved-copy link stays fresh
    const onMsg = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === 'ys-tr-sync') setTimeout(refreshSnap, 3500);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [refreshSnap]);
  async function download() {
    if (!snap) return;
    setDl(true);
    try { const { blob, filename } = await api.staffDownloadDoc(snap.documentId); saveBlob(blob, filename || snap.filename); }
    catch (_) { /* surfaced by the button state */ }
    finally { setDl(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3>Track record &amp; experience</h3>
        <div className="spacer" />
        <button className="btn primary small" onClick={() => setFull(true)}
          title="Open the track record in the full-screen workspace — same as the Scope of Work">
          Open full screen
        </button>
        {snap && (
          <button className="btn ghost small" onClick={() => setPreview(true)}
            title="Preview the borrower's saved static copy without downloading">Preview</button>
        )}
        {snap && (
          <button className="btn ghost small" disabled={dl} onClick={download}
            title="The borrower's saved static copy — refreshed automatically on every change">
            {dl ? '…' : '⤓ Saved copy (HTML)'}
          </button>
        )}
        <span className="muted small">The borrower's live record — add, edit, verify, and attach docs. Changes save automatically.</span>
      </div>
      {people.length > 1 && (
        <div className="row" style={{ gap: 6, margin: '2px 0 12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted small" style={{ marginRight: 2 }}>Whose track record:</span>
          {people.map(p => (
            <button key={p.id} type="button"
              className={`btn small ${p.id === borrowerId ? 'primary' : 'ghost'}`}
              onClick={() => { setFull(false); setSelected(p.id); }}
              title={`${p.role} — deals you add here save to ${p.label}'s profile`}>
              {p.label} <span className="muted" style={{ fontWeight: 400 }}>· {p.role}</span>
            </button>
          ))}
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            Pricing experience for this file = both borrowers, summed.
          </span>
        </div>
      )}
      {preview && snap && (
        <DocPreview title="Track record — saved copy" filename={snap.filename} contentType="text/html"
          load={() => api.staffDownloadDoc(snap.documentId)}
          onDownload={download} onClose={() => setPreview(false)} />
      )}
      {trs.length > 0 && (
        <div className="panel" style={{ marginBottom: 12, padding: 10 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            Raise a request against a specific past project — it becomes a named condition on this file the borrower can respond to.
          </div>
          {trMsg && <div className="small" style={{ color: 'var(--ok)', marginBottom: 6 }}>{trMsg}</div>}
          {trs.map((t) => {
            const pa = t.property_address || {};
            const addr = pa.oneLine || [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ') || 'Past project';
            const itemDocs = trDocs[t.id] || [];
            return (
              <div key={t.id} style={{ padding: '4px 0', borderTop: '1px solid rgba(127,169,176,.15)' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="small" style={{ flex: 1, minWidth: 160 }}>{addr}</span>
                  {t.verification_status && <span className="pill small">{t.verification_status}</span>}
                  <button className="btn ghost small" disabled={trBusy === t.id}
                    title="Post a request/issue about this past project — it becomes a condition on this file"
                    onClick={async () => {
                      const reason = window.prompt(`Raise an issue on "${addr}" — what do you need? (the borrower will see this)`);
                      if (reason == null || !reason.trim()) return;
                      setTrBusy(t.id); setTrMsg('');
                      try { await api.staffRaiseTrackRecordIssue(t.id, app.id, reason.trim()); setTrMsg(`Issue raised on ${addr} — added as a condition on this file.`); }
                      catch (e) { setTrMsg(e.message || 'Could not raise the issue'); }
                      finally { setTrBusy(''); }
                    }}>Raise an issue</button>
                </div>
                {/* Per-line-item documents: accept / reject each with a reason (#126). */}
                {itemDocs.map((d) => {
                  const rs = d.review_status || 'pending';
                  return (
                    <div className="row" key={d.id} style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '2px 0 2px 18px' }}>
                      <span className="small muted" style={{ flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                      <span className="pill small" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                      {completerTR && rs !== 'accepted' && <button className="btn primary small" disabled={trBusy === d.id} onClick={() => reviewTrDoc(d, 'accept')}>Accept</button>}
                      {rs !== 'rejected' && <button className="btn link small" disabled={trBusy === d.id} onClick={() => reviewTrDoc(d, 'reject')}>Reject</button>}
                      {rs === 'rejected' && d.rejection_reason && <span className="small" style={{ color: 'var(--danger)', width: '100%', paddingLeft: 18 }}>{d.rejection_reason}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <StaticToolFrame
        key={borrowerId}
        title="Borrower track record"
        src={`/tools/track-record.html?internal=1&borrower=${borrowerId}&embed=1`}
        minHeight={520}
      />
      {full && (
        <ToolModal
          title="Borrower track record"
          url={`/tools/track-record.html?internal=1&borrower=${borrowerId}&embed=1`}
          onClose={() => { setFull(false); refreshSnap(); }} />
      )}
    </div>
  );
}

/* An internal note on any condition (borrower-facing conditions and raised
   issues included) — the internal checklist Item already had one; this brings
   notes to every condition on the borrower-conditions view too (#126). Notes are
   staff-only (ci.notes is never sent to the borrower). */
function CondNote({ item, onPatch }) {
  const [v, setV] = useState(item.notes || '');
  const [saved, setSaved] = useState(false);
  return (
    <div className="row" style={{ width: '100%', gap: 8, paddingLeft: 20, marginTop: 4 }}>
      <input className="input small" placeholder="Internal note (staff-only)…" value={v} style={{ flex: 1 }}
        onChange={(e) => { setV(e.target.value); setSaved(false); }} />
      <button className="btn ghost small" onClick={async () => { await onPatch(item.id, { notes: v }); setSaved(true); }}>
        {saved ? 'Saved ✓' : 'Save note'}
      </button>
    </div>
  );
}

/* The borrower's conditions, as staff see them: the same single list the
   borrower works through (Scope of Work, track record, contacts, ID, document
   slots), with every uploaded PDF inline and full sign-off capability — a
   separate section from the internal phase-by-phase checklist. */
// #81 — the subject vesting LLC is owned by BOTH borrowers on a co-borrower file.
// Each borrower's ownership % is captured here and the entity stays linked to
// both (so a future solo file of either borrower already knows the LLC). Only
// shown on a co-borrower file — a single borrower owns their entity outright.
function VestingLlcOwners({ appId, app }) {
  const [data, setData] = useState(null);   // { llcId, llcName, owners:[{borrower_id, first_name, last_name, ownership_pct, is_primary}] }
  const [pcts, setPcts] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.staffVestingLlcOwners(appId).then(d => {
    setData(d);
    setPcts(Object.fromEntries((d.owners || []).map(o => [o.borrower_id, o.ownership_pct ?? ''])));
  }).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId, app.llc_id, app.co_borrower_id]);
  if (!app.co_borrower_id) return null;   // #81 is about multi-borrower entities

  const total = Object.values(pcts).reduce((s, v) => s + (Number(v) || 0), 0);
  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const owners = (data.owners || []).map(o => ({ borrowerId: o.borrower_id, ownershipPct: pcts[o.borrower_id] === '' ? null : Number(pcts[o.borrower_id]) }));
      await api.staffSetVestingLlcOwners(appId, owners);
      setMsg('Saved ✓'); setTimeout(() => setMsg(''), 2500);
      await load();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 14, borderColor: 'var(--gold)' }}>
      <h3 style={{ marginTop: 0 }}>Vesting entity ownership</h3>
      {!data ? <p className="muted small">Loading…</p>
        : !data.llcId ? <p className="muted small">Link a vesting LLC to this file first — then set each borrower's ownership %.</p>
        : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {data.llcName ? <><strong>{data.llcName}</strong> is </> : 'The vesting entity is '}
            owned by both borrowers. Enter each borrower's ownership stake — the entity stays linked to both.
          </p>
          {(data.owners || []).map(o => (
            <div className="row" key={o.borrower_id} style={{ gap: 8, alignItems: 'center', margin: '6px 0' }}>
              <span style={{ minWidth: 200 }}>{`${o.first_name || ''} ${o.last_name || ''}`.trim() || '(borrower)'}
                {o.is_primary ? <span className="muted small"> · primary</span> : <span className="muted small"> · co-borrower</span>}</span>
              <input className="input" type="number" min="0" max="100" step="0.01" style={{ maxWidth: 110 }}
                value={pcts[o.borrower_id] ?? ''} onChange={e => setPcts(p => ({ ...p, [o.borrower_id]: e.target.value }))} />
              <span className="muted small">% ownership</span>
            </div>
          ))}
          <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 8 }}>
            <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save ownership'}</button>
            <span className="muted small" style={{ color: Math.abs(total - 100) < 0.01 ? 'var(--ok)' : undefined }}>
              Borrowers total: {total.toFixed(2)}%{Math.abs(total - 100) >= 0.01 ? ' (plus any non-borrower members should reach 100%)' : ' ✓'}
            </span>
            {msg && <span className="small" style={{ color: 'var(--ok)' }}>{msg}</span>}
            {err && <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// #65 — the second borrower on a file. Shows the linked co-borrower (name,
// contact, DOB, SSN reveal) and lets staff add/link or remove one. The record is
// created encrypted + identity-matched server-side; removing only unlinks it.
function CoBorrowerBlock({ appId, app, onChanged }) {
  const has = !!app.co_borrower_id;
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', dob: '', ssn: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [coSsn, setCoSsn] = useState('');
  const [ssnBusy, setSsnBusy] = useState(false);
  // #98 — internal-only autocomplete: type a name to find someone already in the
  // database and link them without re-entering their details. staffBorrowerSearch
  // is a staff-scoped, guarded endpoint (never exposed on the borrower side).
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  async function runSearch(text) {
    setQ(text);
    if (text.trim().length < 2) { setMatches(null); return; }
    setSearchBusy(true);
    try { setMatches(await api.staffBorrowerSearch(text.trim())); }
    catch (_) { setMatches([]); }
    finally { setSearchBusy(false); }
  }
  async function linkExisting(m) {
    setBusy(true); setErr('');
    try { await api.staffSetCoBorrower(appId, { borrowerId: m.id }); setAdding(false); setQ(''); setMatches(null); await onChanged(); }
    catch (e) { setErr(e.message || 'Could not link the co-borrower'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.staffSetCoBorrower(appId, { firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone || undefined, dob: f.dob || undefined, ssn: f.ssn || undefined });
      setAdding(false); setF({ firstName: '', lastName: '', email: '', phone: '', dob: '', ssn: '' }); setQ(''); setMatches(null); await onChanged();
    } catch (e) { setErr(e.message || 'Could not save the co-borrower'); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm('Remove the co-borrower from this file? The borrower record is kept for other files.')) return;
    setBusy(true); setErr('');
    try { await api.staffSetCoBorrower(appId, { unlink: true }); await onChanged(); }
    catch (e) { setErr(e.message || 'Could not remove the co-borrower'); } finally { setBusy(false); }
  }
  async function revealCoSsn() {
    if (coSsn) { setCoSsn(''); return; }
    setSsnBusy(true);
    try { const r = await api.staffBorrowerSsn(app.co_borrower_id); setCoSsn(r.ssn); } catch (_) {} finally { setSsnBusy(false); }
  }
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
        <span className="k" style={{ fontWeight: 600 }}>Co-borrower</span>
        <div className="spacer" />
        {has && !adding && <button className="btn link small" onClick={remove} disabled={busy}>Remove</button>}
        {!has && !adding && <button className="btn ghost small" onClick={() => { setAdding(true); setErr(''); }}>+ Add co-borrower</button>}
      </div>
      {has && !adding && <>
        <div className="metrow"><span className="k">Name</span><span className="v">{app.co_first_name} {app.co_last_name}</span></div>
        <div className="metrow"><span className="k">Email</span><span className="v">{app.co_email || '—'}</span></div>
        <div className="metrow"><span className="k">Phone</span><span className="v">{app.co_cell_phone || '—'}</span></div>
        {app.co_date_of_birth && <div className="metrow"><span className="k">DOB</span><span className="v">{new Date(app.co_date_of_birth).toLocaleDateString()}</span></div>}
        <div className="metrow"><span className="k">FICO</span><span className="v">{app.co_fico || '—'}</span></div>
        <div className="metrow"><span className="k">Citizenship</span><span className="v">{app.co_citizenship || '—'}</span></div>
        <div className="metrow"><span className="k">Tier</span><span className="v">{app.co_tier || '—'}</span></div>
        <div className="metrow"><span className="k">SSN</span>
          <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }}>{coSsn || (app.co_ssn_last4 ? `•••-••-${app.co_ssn_last4}` : '—')}</span>
            {app.co_ssn_last4 && (
              <button className="eye-btn" onClick={revealCoSsn} disabled={ssnBusy} title={coSsn ? 'Hide the full number' : 'Reveal the full number (logged)'}>
                {ssnBusy ? '…' : (coSsn ? EyeOff : Eye)}
              </button>
            )}
          </span>
        </div>
      </>}
      {adding && <>
        <div style={{ marginTop: 6, marginBottom: 8 }}>
          <label><span>Find an existing borrower</span>
            <input className="input" value={q} onChange={e => runSearch(e.target.value)}
              placeholder="Type a name — link someone already in the system without re-entering their info" /></label>
          {searchBusy && <div className="muted small" style={{ marginTop: 4 }}>Searching…</div>}
          {matches && matches.length > 0 && (
            <div className="panel" style={{ padding: 4, marginTop: 4, maxHeight: 200, overflowY: 'auto' }}>
              {matches.filter(m => m.id !== app.borrower_id).map(m => (
                <button key={m.id} type="button" className="btn ghost small" disabled={busy}
                  style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => linkExisting(m)}>
                  {m.first_name} {m.last_name} <span className="muted small">· {m.email || 'no email'}{m.prior_files ? ` · ${m.prior_files} file(s)` : ''}</span>
                </button>
              ))}
            </div>
          )}
          {matches && matches.filter(m => m.id !== app.borrower_id).length === 0 && q.trim().length >= 2 && !searchBusy && (
            <div className="muted small" style={{ marginTop: 4 }}>No existing borrower matches — enter their details below to add a new one.</div>
          )}
          <div className="muted small" style={{ marginTop: 8 }}>…or enter a new person's details:</div>
        </div>
        <div className="ts-inputs" style={{ marginTop: 6 }}>
          <label><span>First name</span><input className="input" value={f.firstName} onChange={e => setF({ ...f, firstName: e.target.value })} /></label>
          <label><span>Last name</span><input className="input" value={f.lastName} onChange={e => setF({ ...f, lastName: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}><span>Email</span><input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></label>
          <label><span>Phone</span><input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></label>
          <label><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={e => setF({ ...f, dob: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}><span>SSN (stored encrypted)</span><input className="input" value={f.ssn} onChange={e => setF({ ...f, ssn: e.target.value })} placeholder="XXX-XX-XXXX" /></label>
        </div>
        {err && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn primary small" onClick={save} disabled={busy || !f.firstName.trim() || !f.lastName.trim() || !f.email.trim()}>{busy ? 'Saving…' : 'Save co-borrower'}</button>
          <button className="btn ghost small" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
        </div>
      </>}
      {err && !adding && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function BorrowerConditions({ appId, app, items, docs, onPatch, onReviewDoc, onDownloadDoc, dlBusy, role, onUploadTo, onDropTo, onChanged, onPreview, onOpenStudio }) {
  const completer = canComplete(role);
  const [sowOpen, setSowOpen] = useState(null);   // itemId of the SOW being edited
  const [trOpen, setTrOpen] = useState(null);    // track record open full-screen (staff): holds the borrower id, or null
  const [card, setCard] = useState(null);         // decrypted appraisal card (revealed on demand)
  const [cardBusy, setCardBusy] = useState(false);
  // #66 — role-aware visibility: default hides what's already off THIS viewer's
  // plate (LO clears on review/"complete"; processor·underwriter on sign-off;
  // anyone on satisfied). The picker re-shows cleared items or everything.
  const [condFilter, setCondFilter] = useState('mine');
  // The LLC condition stays its OWN dedicated section (LlcReview) AND is also
  // surfaced here as a condition to close, rendered with the full entity template
  // (owner-directed). It's excluded from the generic list below (so it isn't a bare
  // duplicate row) and rendered explicitly as `llcCondItem`.
  const borrowerItems = items.filter(it => (it.audience === 'borrower' || it.audience === 'both') && it.template_code !== 'rtl_p1_llc');
  const llcCondItem = items.find(it => it.template_code === 'rtl_p1_llc');
  const ppItem = borrowerItems.find(it => it.tool_key === 'product_pricing');
  const sowItem = borrowerItems.find(it => it.tool_key === 'rehab_budget');
  const trItem = borrowerItems.find(it => it.tool_key === 'track_record');
  const contactItems = borrowerItems.filter(it => ['title_contact', 'insurance_contact'].includes(it.tool_key));
  const cardItem = borrowerItems.find(it => it.tool_key === 'appraisal_card');
  const idItem = borrowerItems.find(it => it.template_code === 'rtl_p1_id');
  const lead = [ppItem, sowItem, trItem, ...contactItems, cardItem, idItem].filter(Boolean);
  // Condition Center items (info fields, e-sign) carry a tool_key too — keep
  // them in the staff list alongside the plain document conditions.
  const rest = borrowerItems.filter(it => !lead.includes(it) && (!it.tool_key || ['info_field', 'esign'].includes(it.tool_key)));
  const ordered = [...lead, ...rest];

  async function revealCard() {
    if (card) { setCard(null); return; }
    setCardBusy(true);
    try { setCard(await api.staffAppraisalCard(appId)); }
    catch (e) { alert(e.message || 'No card on file yet.'); }
    finally { setCardBusy(false); }
  }
  const docsFor = (itemId) => docs.filter(d => d.checklist_item_id === itemId && d.is_current && d.source_type !== 'chat_attachment');
  const signedCount = ordered.filter(it => it.signed_off_at).length;
  const isLO = role === 'loan_officer';
  // Role-aware "off my plate" (owner-directed #135): a loan officer clears a
  // condition by marking it Done (reviewed) OR when it's signed off/satisfied;
  // a processor/underwriter only clears it by SIGNING IT OFF — so an accepted
  // (received) document keeps the condition on the processor's list until she
  // signs off. This is why accept now sets 'received', not 'satisfied'.
  const offMyPlate = (it) => it.status === 'satisfied' || !!it.signed_off_at || (isLO && !!it.reviewed_at);
  const matchFilter = (it) => {
    switch (condFilter) {
      case 'awaiting':  return ['outstanding', 'requested'].includes(it.status) && !it.signed_off_at;      // nothing submitted yet
      case 'review':    return it.status === 'received' && !it.signed_off_at;                              // uploaded/accepted, not signed off
      case 'attention': return it.status === 'issue';                                                       // needs a fix
      case 'signed':    return !!it.signed_off_at || it.status === 'satisfied';                             // done
      case 'all':       return true;
      case 'mine':
      default:          return !offMyPlate(it);                                                             // role default
    }
  };
  const visible = ordered.filter(matchFilter);
  // The LLC condition renders as its own row; drive its visibility off a
  // synthesized status so it honors the same filters.
  const llcPseudo = { id: '__llc', tool_key: null, reviewed_at: null,
    status: app.entity_verified ? 'satisfied' : (app.llc_id ? 'received' : 'outstanding'),
    signed_off_at: app.entity_verified ? 'x' : null };
  const llcShown = !!llcCondItem && matchFilter(llcPseudo);

  if (ordered.length === 0 && !llcCondItem) return null;
  return (
    <div className="panel" style={{ marginTop: 18, borderColor: 'var(--gold)' }}>
      <div className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
        <h3>Borrower conditions</h3>
        <div className="spacer" />
        <select className="input" style={{ maxWidth: 210 }} value={condFilter} onChange={e => setCondFilter(e.target.value)}
          title={isLO ? 'Your default shows conditions still needing your review; marking one Done clears it here.' : 'Your default shows conditions still needing your sign-off; accepting a document keeps it here until you sign off.'}>
          <option value="mine">{isLO ? 'Needs my review' : 'Needs my sign-off'}</option>
          <option value="awaiting">Not submitted yet</option>
          <option value="review">In review — not signed off</option>
          <option value="attention">Needs attention</option>
          <option value="signed">Signed off</option>
          <option value="all">All conditions</option>
        </select>
        <span className="muted small">{signedCount}/{ordered.length} signed off</span>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        The conditions list exactly as the borrower sees it — with each condition's uploaded documents and sign-off.
      </p>
      {/* The LLC condition to close — the FULL entity template (details, ownership,
          the three documents, verification state), rendered here as a condition in
          addition to its dedicated Vesting entity section above. Gate. */}
      {llcShown && (
        <div className="checkitem" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, borderColor: 'var(--gold)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`dot ${app.entity_verified ? 'done' : 'outstanding'}`} />
            <strong>{llcCondItem.label || 'LLC (vesting entity)'}</strong>
            <Badge tone="gold">gate</Badge>
            <Badge>{llcCondItem.audience}</Badge>
            {app.entity_verified
              ? <span className="pill ok">Verified ✓</span>
              : <span className="pill">{app.llc_id ? 'In progress' : 'No entity linked'}</span>}
          </div>
          <div className="muted small">Condition to close — the borrower fills this too. Verifying the entity (below or here) satisfies and signs it off.</div>
          {app.llc_id
            ? <LlcManager llcId={app.llc_id} staff compactHeader />
            : <p className="muted small" style={{ margin: 0 }}>No vesting entity linked yet — link or create one in the “Vesting entity (LLC)” section above.</p>}
        </div>
      )}
      {visible.length === 0 && !llcShown && (
        <p className="muted small">Nothing matches this filter — switch to “All conditions” to see everything on the file.</p>
      )}
      {visible.map(it => {
        const itemDocs = docsFor(it.id);
        const signed = !!it.signed_off_at;
        const done = signed || it.status === 'satisfied' || it.status === 'received';
        // Drop a file onto a document condition to upload it (same as the button).
        const canDrop = !it.tool_key && !!onDropTo;
        const dropProps = canDrop ? {
          onDragOver: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); },
          onDragLeave: (e) => { e.currentTarget.classList.remove('drop-over'); },
          onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); const f = Array.from(e.dataTransfer.files || []); if (f.length) onDropTo(f, { itemId: it.id, slotBase: itemDocs.length }); },
        } : {};
        return (
          <div className={`checkitem${canDrop ? ' cond-drop' : ''}`} key={it.id} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }} {...dropProps}>
            <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
              <span className={`dot ${signed || it.status === 'satisfied' ? 'done' : 'outstanding'}`} style={{ marginTop: 4, ...(it.status === 'issue' ? { background: 'var(--danger)' } : {}) }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {it.label}
                  {it.origin_kind === 'auto' && (
                    <span className="pill" style={{ marginLeft: 8, borderColor: 'var(--gold)', color: 'var(--gold)' }}
                      title={(it.origin_detail && it.origin_detail.rule) ? `Added automatically — applies when: ${it.origin_detail.rule}` : 'Added automatically by a condition rule'}>Auto</span>
                  )}
                </div>
                <div className="muted small">
                  {it.tool_key === 'info_field' ? (() => {
                      const p = it.tool_payload || {};
                      return `Information request → ${it.field_key || 'field'}${p.value !== undefined ? ` · answered: ${p.value}` : ' · awaiting the borrower’s answer'}`;
                    })()
                    : it.tool_key === 'esign' ? `E-signature${it.esign_doc ? ` — ${it.esign_doc}` : ''} (activates with the e-sign integration)`
                    : it.tool_key === 'rehab_budget' ? `Scope of Work builder${app.rehab_budget != null ? ` · total ${money(app.rehab_budget)}` : ''}`
                    : it.tool_key === 'track_record' ? (() => {
                        // live counts stamped on the condition by the server on
                        // every track-record change — no need to open the panel
                        const p = it.tool_payload || {};
                        const c = p.counts, r = p.required;
                        // No experience priced/claimed on this file → nothing to
                        // verify. It reactivates the moment experience is entered
                        // on the application or in Products & Pricing.
                        if (p.notApplicable) return 'No experience required on this file — reactivates if experience is entered on the application or in Products & Pricing';
                        if (!c) return 'Verified from the borrower\'s general track record (panel below)';
                        const have = `On record: ${c.flips || 0} flip${c.flips === 1 ? '' : 's'} · ${c.holds || 0} hold${c.holds === 1 ? '' : 's'}${c.ground ? ` · ${c.ground} ground-up` : ''}`;
                        const needsAny = r && (r.flips + r.holds + r.ground > 0);
                        const short = needsAny ? [
                          r.flips > (c.flips || 0) ? `${r.flips - (c.flips || 0)} flip${r.flips - c.flips === 1 ? '' : 's'}` : null,
                          r.holds > (c.holds || 0) ? `${r.holds - (c.holds || 0)} hold${r.holds - c.holds === 1 ? '' : 's'}` : null,
                          r.ground > (c.ground || 0) ? `${r.ground - (c.ground || 0)} ground-up` : null,
                        ].filter(Boolean) : [];
                        return `${have}${needsAny ? (short.length ? ` — still needs ${short.join(', ')}` : ' — requirement met ✓') : ''}`;
                      })()
                    : it.tool_key === 'product_pricing' ? (app.registered_program ? `Registered · ${app.registered_program === 'gold' ? 'Gold Standard' : 'Standard'} · ${money(app.registered_total_loan)}` : 'No product registered yet')
                    : it.tool_key === 'appraisal_card' ? 'Card for ordering the appraisal (reveal is audited)'
                    : ['title_contact', 'insurance_contact'].includes(it.tool_key) ? 'Contact information form'
                    : it.template_code === 'rtl_p3_assets' ? (() => {
                        // Assets & liquidity: show the registered requirement summary
                        // on the internal login too (#85), not just a bare "document".
                        const liq = it.tool_payload && it.tool_payload.liquidity;
                        return liq && liq.required != null
                          ? `Required liquidity ${money(liq.required)}${liq.cashToClose ? ` · cash to close ${money(liq.cashToClose)}` : ''}${liq.reserveRequirement ? ` · reserves ${money(liq.reserveRequirement)}` : ''}`
                          : 'Assets & bank statements — the required liquidity is set the moment a product is registered';
                      })()
                    : it.item_kind}
                  {` · ${it.status}`}
                  {signed && ` · signed off by ${it.signed_off_name || 'the internal team'}`}
                </div>
                {it.template_code === 'rtl_p3_assets' && it.hint && (
                  <div className="muted small" style={{ whiteSpace: 'pre-line', marginTop: 6, padding: '8px 10px', border: '1px solid rgba(127,169,176,.3)', borderRadius: 8 }}>
                    {it.hint}
                  </div>
                )}
                {it.tool_key === 'track_record' && it.tool_payload && it.tool_payload.perBorrower && it.tool_payload.perBorrower.length > 1 && (
                  // #103 — per-borrower breakdown: each borrower's own 3-year-window
                  // deals, so it's clear who contributes what. The requirement is the
                  // combined total shown in the summary line above.
                  <div className="small" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {it.tool_payload.perBorrower.map(p => {
                      const c = p.counts || {};
                      return (
                        <div key={p.borrowerId} className="muted">
                          <b style={{ color: 'var(--ink-9,inherit)' }}>{p.name}</b>{p.isPrimary ? ' (borrower)' : ' (co-borrower)'} — {c.flips || 0} flip{c.flips === 1 ? '' : 's'} · {c.holds || 0} hold{c.holds === 1 ? '' : 's'}{c.ground ? ` · ${c.ground} ground-up` : ''}
                        </div>
                      );
                    })}
                  </div>
                )}
                {it.tool_key === 'appraisal_card' && card && (
                  <div className="small" style={{ marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                    {card.brand} <strong>{card.number.replace(/(\d{4})(?=\d)/g, '$1 ')}</strong> · exp {String(card.expMonth).padStart(2, '0')}/{card.expYear} · CVC {card.cvc} · ZIP {card.zip}
                  </div>
                )}
              </div>
              {it.tool_key === 'rehab_budget' && (
                <button className="btn ghost small" onClick={() => setSowOpen(it.id)}>Open Scope of Work</button>
              )}
              {it.tool_key === 'product_pricing' && onOpenStudio && (
                <button className="btn ghost small" onClick={onOpenStudio}
                  title="Open the Term Sheet Studio to price / register the product on this file — the same tool the borrower opens from this condition">
                  {app.registered_program ? 'Reprice / re-register' : 'Open Products & Pricing'}
                </button>
              )}
              {it.tool_key === 'track_record' && app.borrower_id && (() => {
                // #103 — on a co-borrower file the experience condition opens EACH
                // borrower's own track record: one button per borrower, named.
                const pb = (it.tool_payload && it.tool_payload.perBorrower) || null;
                if (pb && pb.length > 1) {
                  return (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {pb.map(p => (
                        <button key={p.borrowerId} className="btn ghost small" onClick={() => setTrOpen(p.borrowerId)}
                          title={`Open ${p.name}'s track record${p.isPrimary ? ' (primary borrower)' : ' (co-borrower)'}`}>
                          Open {p.name.split(' ')[0] || 'track record'}'s track record
                        </button>
                      ))}
                    </div>
                  );
                }
                return <button className="btn ghost small" onClick={() => setTrOpen(app.borrower_id)}>Open track record</button>;
              })()}
              {it.tool_key === 'appraisal_card' && (
                <button className="btn ghost small" disabled={cardBusy} onClick={revealCard}>
                  {cardBusy ? '…' : card ? 'Hide card' : 'Reveal card'}
                </button>
              )}
              {!it.tool_key && onUploadTo && (
                <button className="btn ghost small"
                  title="Upload documents into this condition on the borrower's behalf (multiple PDFs at once supported) — they land in the shared list exactly as if the borrower uploaded them"
                  onClick={() => onUploadTo({ itemId: it.id, slotBase: itemDocs.length })}>
                  {itemDocs.length ? '+ Add doc' : 'Upload'}
                </button>
              )}
              {it.reviewed_at
                ? <button className="btn ghost small" title={`Marked done by ${it.reviewed_by_name || 'staff'} — undo to put it back on your list`} onClick={() => onPatch(it.id, { reviewed: false })}>Done ✓</button>
                : <button className="btn ghost small" title="Mark this condition done (loan-officer step). The processor still signs it off." onClick={() => onPatch(it.id, { reviewed: true })}>Done</button>}
              {completer && (signed
                ? <button className="btn ghost small" onClick={() => onPatch(it.id, { signedOff: false })}>Undo sign-off</button>
                : <button className="btn primary small" onClick={() => onPatch(it.id, { signedOff: true })}>Sign off</button>)}
              <button className="btn ghost small" title="Send this condition back to the borrower with a reason (reopens it, clears any sign-off)"
                onClick={() => {
                  const reason = window.prompt(signed || it.status === 'satisfied'
                    ? 'Reopen and send this back to the borrower — what needs to change? (they will see this)'
                    : 'Send this back to the borrower — what needs to change? (they will see this)');
                  if (reason == null || !reason.trim()) return;
                  onPatch(it.id, { pushBack: true, issueReason: reason.trim() });
                }}>{signed || it.status === 'satisfied' ? 'Reopen' : 'Send back'}</button>
            </div>
            {(it.issue_reason || it.rejection_reason) && (
              <div className="small" style={{ color: 'var(--danger)', paddingLeft: 20 }}>Sent back: {it.issue_reason || it.rejection_reason}</div>
            )}
            {it.borrower_hint && /still needed/i.test(it.borrower_hint) && (
              <div className="small" style={{ color: 'var(--gold)', paddingLeft: 20 }}>Requested from borrower: {it.borrower_hint.replace(/^[\s\S]*?Still needed:\s*/i, '')}</div>
            )}
            <CondNote item={it} onPatch={onPatch} />
            {itemDocs.length > 0 && (
              <div style={{ width: '100%', paddingLeft: 20 }}>
                {itemDocs.map((d, i) => {
                  const rs = d.review_status || 'pending';
                  return (
                    <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                      <span className="muted small" style={{ minWidth: 90 }}>{d.slot_label || (d.source_type === 'system' ? 'Tool export' : `Document ${i + 1}`)}</span>
                      <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                      <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                      {onPreview && <button className="btn ghost small" title="Preview without downloading" onClick={() => onPreview(d)}>Preview</button>}
                      <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => onDownloadDoc(d)}>{dlBusy === d.id ? '…' : 'Download'}</button>
                      {onUploadTo && d.source_type !== 'system' && (
                        <button className="btn link small" title="Replace this document with a new version (the old one is kept in the trash)"
                          onClick={() => onUploadTo({ itemId: it.id, slot: d.slot_label || undefined, replaceDocumentId: d.id })}>Replace</button>
                      )}
                      {completer && rs !== 'accepted' && <button className="btn primary small" onClick={() => onReviewDoc(d, 'accept')}>Accept</button>}
                      {completer && rs !== 'accepted' && (
                        <button className="btn ghost small"
                          title="Accept this document but keep the condition open and ask the borrower for one more document"
                          onClick={() => onReviewDoc(d, 'accept_more')}>Accept +1 more</button>
                      )}
                      {rs !== 'rejected' && <button className="btn link small" onClick={() => onReviewDoc(d, 'reject')}>Reject</button>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {sowOpen && (
        <ToolModal
          title="Rehab Budget — Scope of Work (internal)"
          url={sowUrl(appId, sowOpen, app)}
          onClose={() => setSowOpen(null)} />
      )}
      {trOpen && (
        <ToolModal
          title="Borrower track record (internal)"
          url={`/tools/track-record.html?internal=1&borrower=${trOpen}&embed=1`}
          onClose={() => { setTrOpen(null); onChanged && onChanged(); }} />
      )}
    </div>
  );
}

/* ClickUp sync panel — staff-only surface on the file overview.
   Shows the two-layer status (exact ClickUp mirror vs. borrower-facing), the
   YS loan number, the note buyer (internal only — never borrower-facing), the
   link to the ClickUp task, and last-synced time. Admins (platform_setup) can
   force a re-push / re-pull. */
function ClickupSyncPanel({ app, canSetup, onResynced }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const taskId = app.clickup_pipeline_task_id;
  const state = app.sync_state || 'unlinked';
  const onHold = app.status === 'on_hold' || /hold/i.test(app.internal_status || '');
  async function resync(dir) {
    setBusy(dir); setNote('');
    try {
      const r = dir === 'push' ? await api.clickupRepush(app.id) : await api.clickupRepull(app.id);
      setNote(dir === 'push' ? `Pushed to ClickUp ✓${r && r.taskId ? ` (task ${r.taskId})` : ''}` : 'Pulled from ClickUp ✓');
      if (onResynced) onResynced();
    } catch (e) { setNote(e.message || 'Re-sync failed'); }
    finally { setBusy(''); }
  }
  return (
    <div className="panel" style={{ background: 'var(--ink-2)', marginBottom: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <b className="small">ClickUp sync</b>
        <span className="pill" title="Sync state">{state}</span>
        {onHold && <span className="pill" style={{ background: 'rgba(224,168,0,.15)', color: 'var(--warn,#e0a800)' }}>On hold</span>}
        {taskId
          ? <a className="btn link small" href={`https://app.clickup.com/t/${taskId}`} target="_blank" rel="noreferrer">Open task ↗</a>
          : <span className="muted small">not linked to a ClickUp task yet</span>}
        <div className="spacer" />
        {canSetup && taskId && (
          <>
            <button className="btn ghost small" disabled={!!busy} onClick={() => resync('pull')}>{busy === 'pull' ? 'Pulling…' : 'Pull ← ClickUp'}</button>
            <button className="btn ghost small" disabled={!!busy} onClick={() => resync('push')}>{busy === 'push' ? 'Pushing…' : 'Push → ClickUp'}</button>
          </>
        )}
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <span className="muted small">Internal status (ClickUp mirror): <b>{app.internal_status || '—'}</b></span>
        <span className="muted small">Borrower sees: <b>{app.status || '—'}</b></span>
        {app.ys_loan_number && <span className="muted small">YS loan #: <b>{app.ys_loan_number}</b></span>}
        {app.lender && <span className="muted small" title="Note buyer / capital partner — internal only, never shown to the borrower">Note buyer: <b>{app.lender}</b></span>}
        {app.clickup_last_synced_at && <span className="muted small">Last synced: {new Date(app.clickup_last_synced_at).toLocaleString()}</span>}
      </div>
      {note && <div className="muted small" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}

export default function StaffApplication() {
  const { id } = useParams();
  const nav = useNavigate();
  const { search } = useLocation();
  const { role, can } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const completer = canComplete(role);   // may CLEAR (sign off) a condition; others only mark it reviewed
  const canDelete = can('delete_files');
  const [app, setApp] = useState(null);
  const [items, setItems] = useState([]);
  const [docs, setDocs] = useState([]);
  const [dlBusy, setDlBusy] = useState(null);
  const [borrower, setBorrower] = useState(null);
  const [team, setTeam] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [lo, setLo] = useState('');
  const [proc, setProc] = useState('');
  const [newCond, setNewCond] = useState('');
  const [conds, setConds] = useState([]);
  const [gating, setGating] = useState(null);
  // Known internal (ClickUp) statuses for the picker — file-independent, loaded once.
  const [internalStatuses, setInternalStatuses] = useState([]);
  const [condFilter, setCondFilter] = useState('all');
  const [cForm, setCForm] = useState({ title: '', audience: 'staff', severity: 'standard' });
  const [ssnFull, setSsnFull] = useState('');
  const [ssnBusy, setSsnBusy] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  // One in-flight action at a time: double-clicking Assign/Remind/Accept/Request
  // used to double-assign, double-email the borrower, or create duplicate items.
  const [busyAct, setBusyAct] = useState('');

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };
  const activityFetcher = useCallback(() => api.staffActivity(id), [id]);

  async function inviteBorrower() {
    setInviteBusy(true); setErr('');
    try {
      const r = await api.staffInviteBorrower(id);
      flash(r.hasAccount
        ? 'That borrower already has portal access — a sign-in link was emailed to them.'
        : 'Invitation emailed. When the borrower sets up access they will see this file immediately.');
    } catch (e) { setErr(e.message || 'Could not send the invite.'); }
    finally { setInviteBusy(false); }
  }
  function jumpToChat() {
    const el = document.getElementById('conversations');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const idRef = useRef(id); idRef.current = id;
  async function load() {
    const forId = id;   // drop late responses after switching to another file
    setSsnFull('');
    try {
      const a = await api.staffApplication(id);
      if (idRef.current !== forId) return;
      setApp(a);
      // Prefill the assignment selectors from what's already on the file, so an
      // assigned file never reads as "nobody assigned" after a reload.
      setLo(a.loan_officer_id || '');
      setProc(a.processor_id || '');
      // Each sub-load fails independently: a 500 on the checklist must not also
      // empty the team dropdowns (and vice versa).
      const [c, t, d, cn] = await Promise.all([
        api.staffChecklist(id).catch(e => { setErr(e.message || 'Could not load the checklist'); return []; }),
        api.staffTeam().catch(() => []),
        api.staffAppDocuments(id).catch(() => []),
        api.staffConditions(id).catch(() => []),
      ]);
      if (idRef.current !== forId) return;
      setItems(c || []); setTeam(t || []); setDocs(d || []); setConds(cn || []);
      if (a.borrower_id) api.staffBorrower(a.borrower_id).then(b => { if (idRef.current === forId) setBorrower(b); }).catch(() => {});
      api.staffGating(id).then(g => { if (idRef.current === forId) setGating(g); }).catch(() => setGating(null));
    } catch (e) { if (idRef.current === forId) setErr(e.message); }
  }
  useEffect(() => {
    // This component is reused across /internal/app/:id changes — clear the old
    // file's data or it renders under the new file's URL until the fetch lands.
    setApp(null); setItems([]); setDocs([]); setConds([]); setBorrower(null); setGating(null); setErr(''); setMsg('');
    load();
    /* eslint-disable-next-line */
  }, [id]);

  // The internal (ClickUp) status list is the same for every file — load once.
  useEffect(() => { api.staffInternalStatuses().then(setInternalStatuses).catch(() => {}); }, []);

  // Arriving from the Chat hub (?focus=chat): land on the conversation panel
  // instead of the top of a very long page. Runs once per file, after render.
  const focusedChat = useRef(false);
  useEffect(() => { focusedChat.current = false; }, [id]);
  useEffect(() => {
    if (app && !focusedChat.current && new URLSearchParams(search).get('focus') === 'chat') {
      focusedChat.current = true;
      setTimeout(jumpToChat, 60);
    }
    /* eslint-disable-next-line */
  }, [app]);

  // In-place document preview (any PDF/image/text) — see it before signing off,
  // without downloading. Uses the same authenticated loader as the download.
  const [previewDoc, setPreviewDoc] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);   // #94 — Message opens a popup, not a scroll
  const [remindOpen, setRemindOpen] = useState(false);   // #93 — Remind opens the reminder/task manager
  const openPreview = useCallback((doc) => setPreviewDoc(doc), []);

  async function revealSsn() {
    if (ssnFull) { setSsnFull(''); return; }        // toggle back to masked
    if (!app?.borrower_id) return;
    setSsnBusy(true);
    try { const r = await api.staffBorrowerSsn(app.borrower_id); setSsnFull(r.ssn || ''); }
    catch (e) { setErr(e.message || 'Could not reveal SSN'); }
    finally { setSsnBusy(false); }
  }

  async function patch(itemId, body) {
    try { await api.staffPatchItem(itemId, body); flash('Saved ✓'); await load(); }
    catch (e) {
      const msg = e.message || 'Update failed';
      setErr(msg);
      // A BLOCKED sign-off / verification (#88) needs an unmissable explanation of
      // WHY it can't be signed off (e.g. experience still needs verifying, budgets
      // don't match, a required document is missing). The page-top banner is easy
      // to miss on a long file, so surface the exact reason right here too.
      if (body && (body.signedOff === true || body.status === 'satisfied')) {
        try { window.alert('Can’t sign off yet:\n\n' + msg); } catch (_) { /* no window */ }
      }
    }
  }
  async function downloadDoc(doc) {
    setDlBusy(doc.id);
    try { const { blob, filename } = await api.staffDownloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }
  async function reviewDoc(doc, action) {
    if (busyAct) return;
    let reason, opts;
    if (action === 'reject') {
      reason = window.prompt('Why is this document being rejected? The borrower will see this and can upload a new version.');
      if (reason == null || !reason.trim()) return;
    }
    if (action === 'accept_more') {
      // Accept the PDF, keep the condition open, ask for one more document.
      const note = window.prompt('This document is accepted ✓ — what ELSE is needed to satisfy the condition? The borrower sees this note.');
      if (note == null || !note.trim()) return;   // the note is required — the borrower must be told what else is needed
      action = 'accept';
      opts = { requestMore: true, note: note.trim() };
    }
    setBusyAct('review');
    try {
      await api.staffReviewDoc(doc.id, action, reason, opts);
      flash(opts ? 'Accepted ✓ — condition stays open, borrower asked for one more document.'
        : action === 'accept' ? 'Document accepted ✓' : 'Document rejected — the borrower was notified.');
      await load();
    } catch (e) { setErr(e.message || 'Could not review the document'); }
    finally { setBusyAct(''); }
  }
  // Staff upload INTO a condition on the borrower's behalf — same slots, same
  // shared list the borrower sees. Multi-select aware: several PDFs at once
  // land in successive slots (Document N, N+1, …); replacements stay single.
  const staffFileRef = useRef(null);
  // Lets the Products & Pricing CONDITION open the Term Sheet Studio directly —
  // the same one-click the borrower has (#79), from inside the conditions list.
  const studioRef = useRef(null);
  const [uploadTarget, setUploadTarget] = useState(null);   // {itemId, slotBase|slot, replaceDocumentId}
  const pickUpload = (t) => { setUploadTarget(t || {}); staffFileRef.current && staffFileRef.current.click(); };
  // Shared by the file picker AND drag-and-drop — target passed explicitly.
  async function uploadStaffFiles(fileList, tgt) {
    const all = Array.from(fileList || []);
    if (!all.length || !tgt) return;
    const files = tgt.replaceDocumentId ? all.slice(0, 1) : all;
    setBusyAct('upload'); setErr('');
    try {
      const slotBase = Number.isFinite(tgt.slotBase) ? tgt.slotBase : null;
      for (let i = 0; i < files.length; i++) {
        await api.staffUploadAppDoc(id, {
          checklistItemId: tgt.itemId || undefined,
          llcId: tgt.llcId || undefined,
          // LLC document slots are single-doc per slot (formation/EIN/…), so an
          // LLC upload keeps the slot's own label rather than "Document N".
          slot: (tgt.replaceDocumentId || tgt.llcId) ? (tgt.slot || undefined)
            : slotBase != null ? `Document ${slotBase + i + 1}` : (tgt.slot || undefined),
          replaceDocumentId: tgt.replaceDocumentId || undefined,
          filename: files[i].name, contentType: files[i].type, dataBase64: await fileToBase64(files[i]),
        });
      }
      flash(files.length > 1
        ? `${files.length} files uploaded ✓ — the borrower sees them too.`
        : 'Uploaded ✓ — the borrower sees it too.');
      setUploadTarget(null); await load();
    } catch (e2) { setErr(e2.message || 'Upload failed'); }
    finally { setBusyAct(''); if (staffFileRef.current) staffFileRef.current.value = ''; }
  }
  const onStaffFile = (e) => uploadStaffFiles(e.target.files, uploadTarget);
  async function archiveApp() {
    const reason = window.prompt('Archive this file? It leaves the pipeline and stops counting in the dashboard, but is kept in the Archived folder and can be restored anytime. Optional reason:');
    if (reason === null) return;
    try { await api.staffArchiveApp(id, reason || undefined); nav('/internal'); }
    catch (e) { setErr(e.message || 'Could not archive'); }
  }
  async function restoreApp() {
    try { await api.staffRestoreApp(id); await load(); flash('File restored ✓ — back in the pipeline.'); }
    catch (e) { setErr(e.message || 'Could not restore'); }
  }
  async function purgeApp() {
    const ok1 = window.confirm('Delete this file PERMANENTLY? This removes the loan file and every document, condition and message under it, and it will disappear from all figures. This cannot be undone.');
    if (!ok1) return;
    const typed = window.prompt('This is permanent. Type DELETE to confirm.');
    if (typed !== 'DELETE') { if (typed !== null) setErr('Not deleted — you must type DELETE to confirm.'); return; }
    try { await api.staffPurgeApp(id); nav('/internal'); }
    catch (e) { setErr(e.message || 'Could not delete'); }
  }
  async function changeStatus(status) {
    setErr('');
    try {
      await api.staffSetStatus(id, status);
      flash(`Status → ${APP_STATUS_LABEL[status] || status}. Borrower & team notified.`);
      await load();
    } catch (e) {
      // Conditions-to-close gating: the server refuses clear-to-close / funded
      // while blockers remain. Admins may override; others see what's outstanding.
      if (e.status === 409 && e.data && e.data.blockers) {
        const b = e.data.blockers;
        const lines = [
          ...b.conditions.map(c => `• Condition: ${c.title} (${String(c.severity).replace(/_/g, ' ')})`),
          ...b.gates.map(g => `• Gate: ${g.label}`),
        ].join('\n');
        if (isAdmin && window.confirm(`This file isn't ready for "${APP_STATUS_LABEL[status]}":\n\n${lines}\n\nOverride as admin and advance anyway?`)) {
          try { await api.staffSetStatus(id, status, true); flash(`Status → ${APP_STATUS_LABEL[status]} (admin override).`); await load(); }
          catch (e2) { setErr(e2.message || 'Could not update status'); }
        } else {
          setErr(`Not ready for "${APP_STATUS_LABEL[status]}" — ${b.conditions.length} condition(s) and ${b.gates.length} gate(s) outstanding.`);
          api.staffGating(id).then(setGating).catch(() => {});
        }
        return;
      }
      setErr(e.message || 'Could not update status');
    }
  }
  // Set the EXACT ClickUp task status. Re-derives the borrower-facing status and
  // pushes both to ClickUp via the scoped status push.
  async function changeInternalStatus(internalStatus) {
    setErr('');
    if (!internalStatus || internalStatus === (app.internal_status || '')) return;
    try {
      await api.staffSetInternalStatus(id, internalStatus);
      flash(`Internal status → ${internalStatus}. Pushed to ClickUp; borrower status re-derived.`);
      await load();
    } catch (e) { setErr(e.message || 'Could not update internal status'); }
  }
  async function nudge() {
    if (busyAct) return;   // a double-click emailed the borrower twice
    setBusyAct('nudge'); setErr('');
    try { const r = await api.staffNudge(id); flash(`Reminder sent — ${r.count} outstanding item${r.count === 1 ? '' : 's'}.`); }
    catch (e) { setErr(e.message || 'Could not send reminder'); }
    finally { setBusyAct(''); }
  }
  async function setClosing(field, value) {
    setErr('');
    try { await api.staffSetClosingDate(id, { [field]: value || null }); flash(field === 'expectedClosing' ? 'Expected closing saved — borrower notified.' : 'Actual closing saved.'); await load(); }
    catch (e) { setErr(e.message || 'Could not save closing date'); }
  }
  async function assign() {
    if (busyAct) return;   // double-click assigned (and emailed) twice
    // Only send what actually changed, so re-opening a file and clicking Assign
    // doesn't re-notify the same people. Keep the selectors populated afterward.
    const body = {};
    if (lo && lo !== (app.loan_officer_id || '')) body.loanOfficerId = lo;
    if (proc && proc !== (app.processor_id || '')) body.processorId = proc;
    if (!body.loanOfficerId && !body.processorId) { flash('No assignment change.'); return; }
    setBusyAct('assign');
    try {
      await api.staffAssign(id, body);
      flash('Assigned ✓'); await load();
    } catch (e) { setErr(e.message || 'Assign failed'); }
    finally { setBusyAct(''); }
  }
  async function addLoanCondition() {
    if (!cForm.title.trim() || busyAct) return;   // double-submit created the condition twice
    setBusyAct('addcond');
    try {
      await api.staffAddLoanCondition(id, {
        title: cForm.title.trim(),
        borrowerTitle: cForm.audience !== 'staff' ? cForm.title.trim() : undefined,
        audience: cForm.audience, severity: cForm.severity,
      });
      setCForm({ title: '', audience: 'staff', severity: 'standard' }); flash('Condition added ✓'); await load();
    } catch (e) { setErr(e.message || 'Could not add condition'); }
    finally { setBusyAct(''); }
  }
  async function clearCond(cid) { if (busyAct) return; setBusyAct('cond:' + cid); try { await api.staffClearCondition(cid); flash('Cleared ✓'); await load(); } catch (e) { setErr(e.message); } finally { setBusyAct(''); } }
  async function waiveCond(cid) { if (busyAct) return; const r = window.prompt('Waive this condition — reason (required):'); if (!r) return; setBusyAct('cond:' + cid); try { await api.staffWaiveCondition(cid, r); flash('Waived ✓'); await load(); } catch (e) { setErr(e.message); } finally { setBusyAct(''); } }
  async function reviewCond(cid, reviewed) { if (busyAct) return; setBusyAct('cond:' + cid); try { await api.staffReviewCondition(cid, reviewed); flash(reviewed ? 'Marked reviewed ✓' : 'Review cleared'); await load(); } catch (e) { setErr(e.message); } finally { setBusyAct(''); } }
  async function addCondition() {
    if (!newCond.trim()) return;
    try { await api.staffAddCondition(id, { label: newCond.trim(), audience: 'staff' }); setNewCond(''); flash('Added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Failed'); }
  }

  const [itemFilter, setItemFilter] = useState('all');
  const [internalCondFilter, setInternalCondFilter] = useState('todo');   // #66 internal-conditions role-aware filter
  const bucketOf = (s) => s === 'issue' ? 'rejected' : s === 'received' ? 'submitted' : s === 'satisfied' ? 'satisfied' : 'outstanding';
  // #66 — role-aware "off my plate": LO clears on review, processor/underwriter
  // on sign-off, anyone on satisfied. Default hides those; picker re-shows them.
  const condOffPlate = (it) => it.status === 'satisfied' || !!it.signed_off_at || (role === 'loan_officer' && !!it.reviewed_at);
  // The internal checklist shows ONLY staff-facing work items — the borrower's
  // conditions (audience borrower/both) already live in "Conditions to close",
  // so they must not be listed twice.
  // Internal DOCUMENT conditions (audience=staff, item_kind=document — e.g.
  // Insurance binder+invoice, Title) live in their OWN "Internal conditions"
  // section in the conditions area, NOT in the phase-by-phase internal checklist
  // (which is staff work-items/tasks only).
  const internalConds = useMemo(() => items.filter(it => it.audience === 'staff' && it.item_kind === 'document'), [items]);
  const internalItems = useMemo(() => items.filter(it => it.audience === 'staff' && it.item_kind !== 'document'), [items]);
  const phases = useMemo(() => {
    const groups = {};
    const src = itemFilter === 'all' ? internalItems : internalItems.filter(it => bucketOf(it.status) === itemFilter);
    for (const it of src) { const k = it.phase || 'general'; (groups[k] = groups[k] || []).push(it); }
    return Object.entries(groups)
      .map(([k, arr]) => [k, arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))])
      .sort((a, b) => (a[1][0].sort_order || 0) - (b[1][0].sort_order || 0));
  }, [internalItems, itemFilter]);

  if (err && !app) return <div role="alert" className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;
  const processors = team.filter(m => m.role === 'processor');
  const officers = team.filter(m => ['loan_officer', 'admin', 'super_admin'].includes(m.role));
  const procName = (team.find(m => m.id === app.processor_id) || {}).full_name;
  const uwName = (team.find(m => m.id === app.underwriter_id) || {}).full_name;
  // Headline the file with the property's one-line address (incl. zip) so it's
  // instantly obvious which property this file is — with a graceful fallback.
  const propAddress = addrLine(app.property_address);

  const borrowerItems = items.filter(it => it.audience === 'borrower' || it.audience === 'both');
  const nCondOpen = borrowerItems.filter(it => !it.signed_off_at && it.status !== 'satisfied').length;
  const SECTIONS = [
    { id: 'sec-overview', label: 'File overview' },
    { id: 'sec-application', label: 'Application details' },
    { id: 'sec-pricing', label: 'Structure & pricing', badge: app.registered_program ? '✓' : '' },
    { id: 'sec-conditions', label: 'Conditions to close', badge: nCondOpen || '' },
    { id: 'sec-internal-conds', label: 'Internal conditions', badge: internalConds.length ? `${internalConds.filter(i => i.signed_off_at || i.status === 'satisfied').length}/${internalConds.length}` : '' },
    { id: 'sec-entity', label: 'LLC condition', badge: app.llc_id && app.llc_verified ? '✓' : '' },
    { id: 'sec-track', label: 'Track record' },
    { id: 'sec-checklist', label: 'Internal checklist', badge: internalItems.length ? `${internalItems.filter(i => i.signed_off_at).length}/${internalItems.length}` : '' },
    { id: 'sec-documents', label: 'Documents & exports', badge: docs.length || '' },
    { id: 'sec-messages', label: 'Conversations' },
    { id: 'sec-activity', label: 'Activity' },
  ];

  return (
    <>
      {/* The file's identity bar STAYS while you scroll — borrower, address,
          loan number and status pin under the app header; only the sections
          below (and the rail beside them) move. */}
      <div className="file-top">
        <Link to="/internal" className="btn link" style={{ flex: 'none' }}>← Pipeline</Link>
        <div className="file-top-main">
          <h1 className="file-top-addr">{app.first_name} {app.last_name}{app.co_borrower_id ? ` & ${app.co_first_name || ''} ${app.co_last_name || ''}`.trimEnd() : ''} · {propAddress === '—' ? 'Address pending' : propAddress}</h1>
          <span className="muted small">{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}</span>
        </div>
        {canDelete && (app.deleted_at
          ? <span className="row" style={{ gap: 8, flex: 'none' }}>
              <span className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }} title="This file is archived">Archived</span>
              <button className="btn link small" onClick={restoreApp} title="Restore this file to the pipeline">Restore</button>
              <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} onClick={purgeApp} title="Delete permanently — cannot be undone">Delete permanently</button>
            </span>
          : <button className="btn link small" style={{ color: 'var(--danger,#e06666)', flex: 'none' }} onClick={archiveApp} title="Archive this file (reversible; leaves the dashboard figures)">Archive file</button>
        )}
        <span className={`pill ${app.status}`} style={{ flex: 'none' }}>{app.status}</span>
      </div>

      {msg && <div className="notice ok">{msg}</div>}
      {err && app && <div role="alert" className="notice err">{err}</div>}

      <FileSections sections={SECTIONS}>

      <Section id="sec-overview" title="File overview"
        info="Status, milestone gating, assignments and the deal at a glance — the control panel for this file.">
      <DealSnapshot app={app} gating={gating} />
      <ClickupSyncPanel app={app} canSetup={can('platform_setup')} onResynced={load} />
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <span className="muted small">Advance status</span>
        <select className="input" style={{ maxWidth: 190 }} value={app.status} onChange={e => changeStatus(e.target.value)}>
          {APP_STATUSES.map(s => <option key={s} value={s}>{APP_STATUS_LABEL[s]}</option>)}
        </select>
        <span className="muted small">Notifies the borrower &amp; assigned team.</span>
        {gating && (() => {
          const g = gating.clear_to_close || {};
          const n = (g.conditions ? g.conditions.length : 0) + (g.gates ? g.gates.length : 0);
          return g.ready
            ? <span className="ts-badge ok" title="All prior-to-docs conditions cleared and gates satisfied">Clear-to-close ready</span>
            : <span className="ts-badge warn" title={[...(g.conditions || []).map(c => c.title), ...(g.gates || []).map(x => x.label)].join(' · ')}>{n} to clear before CTC</span>;
        })()}
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setChatOpen(true)}>💬 Message</button>
        <button className="btn ghost" onClick={() => setRemindOpen(true)} title="Schedule a reminder or task — pick a date/time, who's included, and what it says">🔔 Remind</button>
        <button className="btn primary" onClick={inviteBorrower} disabled={inviteBusy}
          title="Email the borrower an invite to join this file in the portal">
          {inviteBusy ? 'Sending…' : 'Invite borrower'}
        </button>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <span className="muted small">Internal (ClickUp) status</span>
        <select className="input" style={{ maxWidth: 280 }} value={app.internal_status || ''}
          onChange={e => changeInternalStatus(e.target.value)}
          title="The exact ClickUp task status (38-status workflow). Setting it re-derives the borrower-facing status and pushes to ClickUp.">
          {/* Keep the current value selectable even if it isn't a normalized known key
              (live ClickUp statuses carry irregular casing / trailing spaces). */}
          {!app.internal_status && <option value="">— not set —</option>}
          {app.internal_status && !internalStatuses.some(s => s.value === app.internal_status) &&
            <option value={app.internal_status}>{app.internal_status} (current)</option>}
          {(() => {
            const groups = {};
            for (const s of internalStatuses) (groups[s.external] || (groups[s.external] = [])).push(s);
            return Object.keys(groups).map(ext => (
              <optgroup key={ext} label={ext}>
                {groups[ext].map(s => <option key={s.value} value={s.value}>{s.value}</option>)}
              </optgroup>
            ));
          })()}
        </select>
        <span className="muted small">Pushes the exact status to ClickUp; borrower status is re-derived.</span>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <span className="muted small">Expected closing</span>
        <input className="input" type="date" style={{ maxWidth: 170 }}
          value={app.expected_closing ? String(app.expected_closing).slice(0, 10) : ''}
          onChange={e => setClosing('expectedClosing', e.target.value)} />
        <span className="muted small" style={{ marginLeft: 8 }}>Actual closing</span>
        <input className="input" type="date" style={{ maxWidth: 170 }}
          value={app.actual_closing ? String(app.actual_closing).slice(0, 10) : ''}
          onChange={e => setClosing('actualClosing', e.target.value)} />
        <span className="muted small">Setting an expected date notifies the borrower.</span>
      </div>

      <PropertyPhoto address={propAddress !== '—' ? propAddress : ''} />

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Borrower</h3>
          {borrower ? <>
            <div className="metrow"><span className="k">Name</span><span className="v">{app.borrower_id ? <Link to={`/internal/borrowers/${app.borrower_id}`} title="Open borrower CRM profile">{borrower.first_name} {borrower.last_name}</Link> : <>{borrower.first_name} {borrower.last_name}</>}</span></div>
            <div className="metrow"><span className="k">Email</span><span className="v">{borrower.email || '—'}</span></div>
            <div className="metrow"><span className="k">Phone</span><span className="v">{borrower.cell_phone || '—'}</span></div>
            {/* DOB shown for the primary borrower too, to match the co-borrower panel (#99). */}
            {borrower.date_of_birth && <div className="metrow"><span className="k">DOB</span><span className="v">{new Date(borrower.date_of_birth).toLocaleDateString()}</span></div>}
            <div className="metrow"><span className="k">FICO</span><span className="v">{borrower.fico || '—'}</span></div>
            <div className="metrow"><span className="k">Citizenship</span><span className="v">{borrower.citizenship || '—'}</span></div>
            <div className="metrow"><span className="k">Tier</span><span className="v">{borrower.tier || '—'}</span></div>
            <div className="metrow"><span className="k">SSN</span>
              <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }}>
                  {ssnFull || (borrower.ssn_last4 ? `•••-••-${borrower.ssn_last4}` : '—')}
                </span>
                {borrower.ssn_last4 && (
                  <button className="eye-btn" onClick={revealSsn} disabled={ssnBusy}
                    aria-label={ssnFull ? 'Hide the full Social Security number' : 'Reveal the full Social Security number'}
                    title={ssnFull ? 'Hide the full number' : 'Reveal the full number (logged)'}>
                    {ssnBusy ? '…' : (ssnFull ? EyeOff : Eye)}
                  </button>
                )}
              </span>
            </div>
            <CoBorrowerBlock appId={id} app={app} onChanged={load} />
          </> : <p className="muted small">Loading borrower…</p>}
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Loan & assignment</h3>
          <div className="metrow"><span className="k">Property</span><span className="v">{app.property_type || '—'}{app.units ? ` · ${app.units} unit${app.units > 1 ? 's' : ''}` : ''}</span></div>
          <div className="metrow"><span className="k">Entity</span><span className="v">
            {app.entity_name || (app.llc_id ? 'LLC on file' : '—')}
            {app.llc_id && (app.entity_verified
              ? <span className="ts-badge ok" style={{ marginLeft: 6 }}>Verified ✓</span>
              : <span className="ts-badge warn" style={{ marginLeft: 6 }}>Unverified</span>)}
          </span></div>
          <div className="metrow"><span className="k">Purchase</span><span className="v">{money(app.purchase_price)}</span></div>
          {app.is_assignment && <>
            <div className="metrow"><span className="k">Assignment</span><span className="v" style={{ color: 'var(--teal)' }}>Yes</span></div>
            <div className="metrow"><span className="k">Underlying price</span><span className="v">{money(app.underlying_contract_price)}</span></div>
            <div className="metrow"><span className="k">Assignment fee</span><span className="v">{money(app.assignment_fee)}</span></div>
          </>}
          <div className="metrow"><span className="k">As-is</span><span className="v">
            {money(app.as_is_value ?? (app.is_assignment && app.underlying_contract_price != null
              ? Number(app.underlying_contract_price) + Number(app.assignment_fee || 0)
              : app.purchase_price))}
            {app.as_is_value == null && app.purchase_price != null &&
              <span className="muted small" style={{ fontWeight: 400 }} title="No as-is value entered — defaults to the final purchase price everywhere (incl. pricing)"> (= purchase)</span>}
          </span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(app.loan_amount)}</span></div>
          <div className="metrow"><span className="k">Loan officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}</span></div>
          <div className="metrow"><span className="k">Processor</span><span className="v">{procName || '—'}</span></div>
          {uwName && <div className="metrow"><span className="k">Underwriter</span><span className="v">{uwName}</span></div>}
          <div className="gold-rule" style={{ margin: '10px 0' }} />
          {/* Reassigning a file is an admin function (S3-02) — the server 403s a
              non-admin, so don't offer the control to them. */}
          {isAdmin ? (<>
          <div className="field"><label>Assign loan officer</label>
            <select className="input" value={lo} onChange={e => setLo(e.target.value)}>
              <option value="">— select —</option>
              {officers.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
            </select></div>
          <div className="field"><label>Assign processor</label>
            <select className="input" value={proc} onChange={e => setProc(e.target.value)}>
              <option value="">— select —</option>
              {processors.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select></div>
          <button className="btn primary" onClick={assign} disabled={(!lo && !proc) || busyAct === 'assign'}>Assign</button>
          </>) : <p className="muted small">Only an admin can change who this file is assigned to.</p>}
        </div>
      </div>
      </Section>

      <Section id="sec-application" title="Application details"
        info="What the borrower filled out — completeness at a glance, plus the editable deal numbers. Changing them here flows straight into pricing.">
      <Completeness app={app} borrower={borrower} appId={app.id} onSaved={load} />
      <EditFileDetails app={app} onSaved={load} />
      <ClickupFileData app={app} />
      </Section>

      <Section id="sec-pricing" title="Loan structure & pricing"
        info="The registered product with its full economics, and the live Term Sheet Studio to reprice or re-register — every registration attaches the exact term sheet PDF."
        badge={app.registered_program ? 'Registered ✓' : 'Not registered'}>
      <ProductStudioPanel ref={studioRef} appId={id} app={app} onRegistered={load} mode="staff"
        toolItemId={(items.find(it => it.tool_key === 'product_pricing') || {}).id} />
      </Section>

      <Section id="sec-conditions" title="Conditions to close"
        info="The SAME list the borrower sees — shared both ways. Upload on their behalf, accept (signs off), accept-but-request-one-more, or reject with a reason (the file moves to the trash and the condition reopens)."
        badge={`${borrowerItems.filter(it => it.signed_off_at).length}/${borrowerItems.length} signed off`}>
      <input ref={staffFileRef} type="file" multiple style={{ display: 'none' }} onChange={onStaffFile} />
      <BorrowerConditions appId={id} app={app} items={items} docs={docs} role={role}
        onPatch={patch} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc} dlBusy={dlBusy}
        onUploadTo={pickUpload} onDropTo={uploadStaffFiles} onChanged={load} onPreview={openPreview}
        onOpenStudio={() => { studioRef.current ? studioRef.current.openStudio() : document.getElementById('sec-pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
      <StaffChangeRequests appId={id} onChanged={load} />
      <FileContacts appId={id} isStaff heading="File contacts (realtor, attorney, title, insurance, contractor…)" />
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <AddConditionPanel appId={id} items={items} onChanged={load}
          onError={(t) => setErr(t)} onFlash={flash} />
        <LoanConditionsPanel conds={conds} condFilter={condFilter} setCondFilter={setCondFilter}
          cForm={cForm} setCForm={setCForm} addLoanCondition={addLoanCondition}
          clearCond={clearCond} waiveCond={waiveCond} isAdmin={isAdmin} completer={completer} reviewCond={reviewCond} />
      </div>
      </Section>

      <Section id="sec-internal-conds" title="Internal conditions"
        info="Staff-only document conditions (e.g. Insurance binder + invoice, Title). They sync with ClickUp and appear in the DPR export like any condition, but are NEVER shared with the borrower — separate from the phase-by-phase internal checklist below.">
      <div className="panel" style={{ marginTop: 0 }}>
        {(() => {
          const sorted = [...internalConds].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
          const vis = sorted.filter(it => internalCondFilter === 'all' ? true : internalCondFilter === 'cleared' ? condOffPlate(it) : !condOffPlate(it));
          const isLO = role === 'loan_officer';
          return (<>
            {internalConds.length > 0 && (
              <div className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
                <div className="spacer" />
                <select className="input" style={{ maxWidth: 170 }} value={internalCondFilter} onChange={e => setInternalCondFilter(e.target.value)}>
                  <option value="todo">{isLO ? 'To review' : 'To sign off'}</option>
                  <option value="cleared">Cleared</option>
                  <option value="all">Show all</option>
                </select>
                <span className="muted small">{internalConds.filter(i => i.signed_off_at || i.status === 'satisfied').length}/{internalConds.length} cleared</span>
              </div>
            )}
            {internalConds.length === 0
              ? <p className="muted small">No internal conditions on this file.</p>
              : vis.length === 0
                ? <p className="muted small">Nothing {isLO ? 'left to review' : 'left to sign off'} — switch to “Cleared” or “Show all”.</p>
                : vis.map(it => (
                  <Item key={it.id} it={it} team={team} onPatch={patch} role={role}
                    docs={docs} onUploadTo={pickUpload} onDropTo={uploadStaffFiles} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc}
                    dlBusy={dlBusy} onPreview={openPreview} />))}
          </>);
        })()}
      </div>
      </Section>

      <Section id="sec-checklist" title="Internal checklist"
        info="The phase-by-phase processing checklist — internal-only work items, assignments and gates. Borrower conditions live in “Conditions to close” and are never repeated here. The borrower never sees this section.">
      <div className="panel" style={{ marginTop: 0 }}>
        <div className="row" style={{ marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
          <h3>Internal checklist</h3>
          <div className="spacer" />
          <select className="input" style={{ maxWidth: 160 }} value={itemFilter} onChange={e => setItemFilter(e.target.value)}>
            <option value="all">All ({internalItems.length})</option>
            <option value="outstanding">Outstanding</option>
            <option value="submitted">Submitted (in review)</option>
            <option value="rejected">Needs attention</option>
            <option value="satisfied">Satisfied</option>
          </select>
          <span className="muted small">{internalItems.filter(i => i.signed_off_at).length}/{internalItems.length} signed off</span>
        </div>
        {phases.length === 0
          ? <p className="muted small">No internal-only checklist items. Borrower-facing conditions are in “Conditions to close” above.</p>
          : phases.map(([k, arr]) => (
            <div key={k} style={{ marginTop: 10 }}>
              <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{phaseName(k)}</div>
              {arr.map(it => <Item key={it.id} it={it} team={team} onPatch={patch} role={role}
                docs={docs} onUploadTo={pickUpload} onDropTo={uploadStaffFiles} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc}
                dlBusy={dlBusy} onPreview={openPreview} />)}
            </div>
          ))}
      </div>
      </Section>

      <Section id="sec-entity" title="LLC condition — vesting entity"
        info="This IS the LLC condition for the file — set up and verify the LLC taking title inline (entity details, ownership, the three documents). It's the same entity the borrower fills in on their side, so completing it here clears their condition and vice-versa; marking it verified satisfies the LLC condition on every open file it vests. No separate LLC condition row is shown — this is it.">
      <LlcReview appId={id} app={app} role={role} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc}
        dlBusy={dlBusy} onChanged={load} reviewBusy={busyAct === 'review'} onPreview={openPreview} />
      <VestingLlcOwners appId={id} app={app} />
      </Section>

      <Section id="sec-documents" title="Documents & exports"
        info="Every document on the file, titled by condition — with the working set on top, rejected/replaced versions in the trash, and the DPR clean-file export."
        badge={docs.length ? `${docs.length} files` : ''}>
      <div className="panel" style={{ marginTop: 0 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Documents</h3>
          <div className="spacer" />
          <span className="muted small">{docs.length} uploaded</span>
        </div>
        {docs.length === 0
          ? <p className="muted small">No documents uploaded yet. Request one below and the borrower will see it on their checklist.</p>
          : (() => {
            // Rejected / superseded documents live in the file's TRASH: kept
            // for the record (named by their condition) but out of the working
            // set and never part of the DPR / clean-file export.
            const inTrash = (d) => d.review_status === 'rejected' || d.review_status === 'superseded' || d.is_current === false;
            const working = docs.filter(d => !inTrash(d));
            const trash = docs.filter(inTrash);
            const row = (d) => {
              const rs = d.review_status || 'pending';
              const tone = rs === 'accepted' ? 'done' : rs === 'rejected' ? '' : 'outstanding';
              const pillStyle = rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' }
                : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
                : rs === 'superseded' ? { opacity: .6 } : { borderColor: 'var(--gold)', color: 'var(--gold)' };
              return (
              <div className="checkitem" key={d.id} style={{ alignItems: 'flex-start', flexWrap: 'wrap', opacity: d.is_current ? 1 : .6 }}>
                <span className={`dot ${tone}`} style={{ marginTop: 4 }} />
                <div style={{ flex: 1, minWidth: 200 }}>
                  {/* The condition is the document's identity — filename second. */}
                  <div style={{ fontWeight: 600 }}>
                    {d.item_label || (d.doc_kind === 'term_sheet' ? 'Term sheet' : d.doc_kind === 'photo_id' ? 'Government photo ID' : 'General upload')}
                    {d.slot_label && <span className="muted small" style={{ fontWeight: 400 }}> · {d.slot_label}</span>}
                    {!d.is_current && <span className="muted small" style={{ fontWeight: 400 }}> · old version</span>}
                  </div>
                  <div className="muted small">
                    {d.filename} · {kb(d.size_bytes)} · uploaded by {d.uploaded_by_kind} · {new Date(d.created_at).toLocaleDateString()}
                  </div>
                  {rs === 'rejected' && d.rejection_reason && <div className="small" style={{ color: 'var(--danger)', marginTop: 2 }}>Rejected: {d.rejection_reason}</div>}
                  {d.reviewed_by_name && <div className="muted small">Reviewed by {d.reviewed_by_name}</div>}
                </div>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="pill" style={pillStyle}>{rs}</span>
                  <button className="btn ghost small" title="Preview without downloading" onClick={() => openPreview(d)}>Preview</button>
                  <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                    {dlBusy === d.id ? '…' : 'Download'}
                  </button>
                  {d.is_current && rs !== 'accepted' && canComplete(role) && <button className="btn primary small" onClick={() => reviewDoc(d, 'accept')}>Accept</button>}
                  {d.is_current && rs !== 'rejected' && <button className="btn ghost small" onClick={() => reviewDoc(d, 'reject')}>Reject</button>}
                </div>
              </div>
              );
            };
            return (
              <>
                {working.length === 0 && <p className="muted small">Nothing in the working set.</p>}
                {working.map(row)}
                {trash.length > 0 && (
                  <details style={{ marginTop: 10 }}>
                    <summary className="muted small" style={{ cursor: 'pointer' }}>
                      🗑 Trash — {trash.length} rejected / replaced document{trash.length === 1 ? '' : 's'} (kept for the record, excluded from the DPR export)
                    </summary>
                    {trash.map(row)}
                  </details>
                )}
              </>
            );
          })()}
      </div>
      {app.status === 'funded' && <PostClosing appId={id} />}
      <TprExport appId={id} />
      </Section>

      <Section id="sec-track" title="Track record"
        info="The borrower's live track record — one record shared by every file. Add, edit, verify and attach closing docs; changes save automatically.">
      {app.borrower_id
        ? <StaffTrackRecordPanel app={app} role={role} />
        : <p className="muted small">No borrower linked yet.</p>}
      </Section>

      <Section id="sec-messages" title="Conversations"
        info="Every chat on this file: the borrower-facing chat, the internal Loan Team chat, the Officer ↔ Processor chat, and any group chats you create. Live typing, read receipts, and presence — internal chats are never visible to the borrower.">
      <ChatPanel appId={id} onTaskCreated={load} />
      </Section>

      <Section id="sec-activity" title="Activity"
        info="The audited history of everything on this file — status changes, uploads, sign-offs, reveals.">
      <ActivityFeed fetcher={activityFetcher} title="File activity" />
      </Section>

      </FileSections>
      {previewDoc && (
        <DocPreview
          title={previewDoc.item_label || previewDoc.slot_label || 'Document preview'}
          filename={previewDoc.filename} contentType={previewDoc.content_type}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          onDownload={() => downloadDoc(previewDoc)}
          onClose={() => setPreviewDoc(null)} />
      )}
      {chatOpen && (
        // #94 — Message opens a designed popup with the full conversation, instead
        // of scrolling the page to the bottom. Click the backdrop or ✕ to close.
        <div className="cv-modal-back" onClick={() => setChatOpen(false)}>
          <div className="cv-modal" style={{ maxWidth: 760, width: '96%', height: '88vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '2px 2px 10px' }}>
              <h3 style={{ margin: 0 }}>💬 Conversation{addrLine(app.property_address) !== '—' ? ` — ${addrLine(app.property_address)}` : ''}</h3>
              <button className="btn ghost small" onClick={() => setChatOpen(false)}>Close ✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <ChatPanel appId={id} onTaskCreated={load} />
            </div>
          </div>
        </div>
      )}
      {remindOpen && (
        // #93 — Remind opens the reminder/task manager: schedule a reminder or
        // task with a due date/time, recipients, and message; manage what's live.
        <ReminderModal appId={id} team={team} onClose={() => setRemindOpen(false)} onChanged={() => {}} />
      )}
    </>
  );
}

/* Underwriting loan conditions (clear / waive / add) — lives inside the
   Conditions-to-close section, beside the borrower request box. */
function LoanConditionsPanel({ conds, condFilter, setCondFilter, cForm, setCForm, addLoanCondition, clearCond, waiveCond, isAdmin, completer, reviewCond }) {
  return (
        <div className="panel">
          <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
            <h3>Underwriting conditions <InfoTip tip="Formal loan conditions by severity (prior-to-docs, prior-to-funding…). These gate clear-to-close; clear or waive them here." /></h3>
            <div className="spacer" />
            <span className="muted small" style={{ marginRight: 8 }}>{conds.filter(c => c.status === 'open').length} open</span>
            <select className="input" style={{ maxWidth: 130 }} value={condFilter} onChange={e => setCondFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="cleared">Cleared</option>
              <option value="waived">Waived</option>
            </select>
          </div>
          {(() => {
            const shownConds = condFilter === 'all' ? conds
              : condFilter === 'open' ? conds.filter(c => c.status === 'open' || c.status === 'borrower_responded')
              : conds.filter(c => c.status === condFilter);
          return shownConds.length === 0
            ? <p className="muted small">{conds.length === 0 ? 'No conditions yet.' : 'None match this filter.'}</p>
            : shownConds.map(c => {
              const sev = { standard: 'Standard', prior_to_docs: 'Prior to docs', prior_to_funding: 'Prior to funding', post_closing: 'Post-closing' }[c.severity] || c.severity;
              const open = c.status === 'open' || c.status === 'borrower_responded';
              return (
                <div className="checkitem" key={c.id} style={{ alignItems: 'flex-start', opacity: open ? 1 : .6 }}>
                  <span className={`dot ${open ? 'outstanding' : 'done'}`} style={{ marginTop: 4 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div className="muted small">
                      {sev} · {c.audience === 'staff' ? 'Internal' : 'Borrower-facing'}
                      {c.status !== 'open' ? ` · ${c.status}${c.cleared_by_name ? ` by ${c.cleared_by_name}` : ''}` : ''}
                      {open && c.reviewed_by_name ? ` · reviewed by ${c.reviewed_by_name}` : ''}
                      {c.waive_reason ? ` · ${c.waive_reason}` : ''}
                    </div>
                  </div>
                  {/* Clearing (sign-off) is a processor/underwriter call; a loan officer marks it reviewed instead. */}
                  {open && completer && <button className="btn ghost small" onClick={() => clearCond(c.id)}>Clear</button>}
                  {open && isAdmin && <button className="btn link small" onClick={() => waiveCond(c.id)}>Waive</button>}
                  {open && !completer && <button className="btn ghost small" onClick={() => reviewCond(c.id, !c.reviewed_by)}
                    title="Mark that you've reviewed this — a processor or underwriter still signs it off">
                    {c.reviewed_by ? 'Reviewed ✓ — undo' : 'Mark done'}</button>}
                </div>
              );
            });
          })()}
          <div className="gold-rule" style={{ margin: '10px 0' }} />
          <input className="input" placeholder="New condition — e.g. Verify owner of record on REO #3" value={cForm.title}
            onChange={e => setCForm({ ...cForm, title: e.target.value })} onKeyDown={e => e.key === 'Enter' && addLoanCondition()} style={{ marginBottom: 8 }} />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select className="input" style={{ maxWidth: 150 }} value={cForm.audience} onChange={e => setCForm({ ...cForm, audience: e.target.value })}>
              <option value="staff">Internal</option>
              <option value="both">Borrower-facing</option>
            </select>
            <select className="input" style={{ maxWidth: 170 }} value={cForm.severity} onChange={e => setCForm({ ...cForm, severity: e.target.value })}>
              <option value="standard">Standard</option>
              <option value="prior_to_docs">Prior to docs</option>
              <option value="prior_to_funding">Prior to funding</option>
              <option value="post_closing">Post-closing</option>
            </select>
            <button className="btn primary" onClick={addLoanCondition}>Add condition</button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>Borrower-facing conditions notify the borrower and appear on their file.</p>
        </div>
  );
}

/* Two collaboration channels per file: the borrower-facing thread, and an
   internal team channel (LO / processor / underwriter / admin) the borrower
   never sees — where a message can be saved straight onto the file as a task. */
/* Post-closing trailing-doc tracking — appears once a file is funded. */
const PC_STATUS = ['pending', 'ordered', 'received', 'accepted', 'exception'];
const PC_LABEL = { pending: 'Pending', ordered: 'Ordered', received: 'Received', accepted: 'Accepted', exception: 'Exception' };
function PostClosing({ appId }) {
  const [rows, setRows] = useState(null);
  const reload = () => api.staffPostClosing(appId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [appId]);
  async function seed() { try { await api.staffSeedPostClosing(appId); await reload(); } catch (_) {} }
  async function setStatus(pid, status) {
    setRows(rs => rs.map(r => r.id === pid ? { ...r, status } : r));
    try { await api.staffPatchPostClosing(pid, { status }); } catch (_) { reload(); }
  }
  if (!rows) return null;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3>Post-closing</h3>
        <div className="spacer" />
        {rows.length === 0 && <button className="btn ghost small" onClick={seed}>Create trailing-doc list</button>}
        {rows.length > 0 && <span className="muted small">{rows.filter(r => r.status === 'accepted').length}/{rows.length} accepted</span>}
      </div>
      {rows.length === 0
        ? <p className="muted small">No post-closing items yet.</p>
        : rows.map(r => (
          <div className="checkitem" key={r.id} style={{ alignItems: 'center' }}>
            <span className={`dot ${r.status === 'accepted' ? 'done' : r.status === 'exception' ? '' : 'outstanding'}`} style={r.status === 'exception' ? { background: 'var(--danger)' } : undefined} />
            <div style={{ flex: 1 }}>{r.label}</div>
            <select className="input" style={{ maxWidth: 150 }} value={r.status} onChange={e => setStatus(r.id, e.target.value)}>
              {PC_STATUS.map(s => <option key={s} value={s}>{PC_LABEL[s]}</option>)}
            </select>
          </div>
        ))}
    </div>
  );
}

/* TPR / clean-file export — shows readiness (accepted docs + what's still
   missing) and downloads a stacked, manifested ZIP of the clean set. */
function TprExport({ appId }) {
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.staffTprPreview(appId).then(setPrev).catch(() => setPrev({ includedCount: 0, missing: [] })); }, [appId]);
  async function download() {
    setBusy(true);
    try { const { blob, filename } = await api.staffTprExport(appId); saveBlob(blob, filename || 'DPR_export.zip'); }
    catch (e) { alert(e.message || 'Export failed'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3>DPR / clean-file export</h3>
        <div className="spacer" />
        <button className="btn primary" onClick={download} disabled={busy || !prev || prev.includedCount === 0}>
          {busy ? 'Building…' : 'Export clean file (ZIP)'}
        </button>
      </div>
      {!prev ? <p className="muted small">Checking readiness…</p> : (
        <>
          <p className="muted small">
            Packaged by subject property: the accepted loan documents (by category), the signed term sheet on its own,
            and the borrower’s operating track record as HTML + Excel with each project’s verification documents in an
            address-named folder. {prev.includedCount} accepted loan document{prev.includedCount === 1 ? '' : 's'}
            {prev.trackDocs > 0 ? ` plus ${prev.trackDocs} track-record verification file${prev.trackDocs === 1 ? '' : 's'}` : ''} will be included (rejected & superseded files are excluded).
          </p>
          {prev.missing.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <span className="muted small">Not yet accepted:</span>
              {prev.missing.slice(0, 12).map((m, i) => <span key={i} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}>{m}</span>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* The file's chats: Borrower / Loan Team / Officer ↔ Processor / custom group
   chats — pick one tab and the full live thread (typing, receipts, presence)
   renders inline. "Open in Chat" jumps to the two-pane hub on the same chat. */
function ChatPanel({ appId, onTaskCreated }) {
  const { actor } = useAuth();
  const me = { kind: 'staff', id: actor?.id };
  const [convs, setConvs] = useState(null);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.staffConversations().then(r => {
    const mine = (r.conversations || []).filter(c => c.application_id === appId);
    const KIND_ORDER = { borrower: 0, internal: 1, lo_processor: 2, custom: 3 };
    mine.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
    setConvs(mine);
    setOpen(o => (o && mine.some(c => c.id === o)) ? o : (mine[0] ? mine[0].id : null));
  }).catch(() => {}), [appId]);
  useEffect(() => { load(); }, [load]);
  return (
    <div id="conversations">
      <div className="row" style={{ marginBottom: 10, alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        {(convs || []).map(c => (
          <button key={c.id} className={`btn small ${open === c.id ? 'primary' : 'ghost'}`} onClick={() => setOpen(c.id)}>
            {c.emoji || '💬'} {c.name}
            {c.unread > 0 && <span className="chat-badge" style={{ marginLeft: 6 }}>{c.unread}</span>}
          </button>
        ))}
        <button className="btn ghost small" title="New group chat on this file" onClick={() => setCreating(true)}>＋ Group chat</button>
        <div className="spacer" />
        {open && <Link className="btn link small" to={`/internal/chat?c=${open}`}>Open in Chat ↗</Link>}
      </div>
      {open
        ? <ChatThread key={open} conversationId={open} surface="staff" me={me} height="56vh"
            onChanged={load} onTaskCreated={onTaskCreated}
            onOpenApplication={(id) => { window.location.hash = '#/internal/app/' + id; }} />
        : <p className="muted small">Loading conversations…</p>}
      {creating && <NewChatModal appId={appId} onClose={() => setCreating(false)}
        onCreated={(cid) => { setCreating(false); load().then(() => setOpen(cid)); }} />}
    </div>
  );
}
