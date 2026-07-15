import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';
import ChatThread from '../components/ChatThread.jsx';
import { useAuth } from '../lib/auth.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import StatusTimeline from '../components/StatusTimeline.jsx';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import ToolModal from '../components/ToolModal.jsx';
import LlcPicker from '../components/LlcPicker.jsx';
import LlcManager from '../components/LlcManager.jsx';
import FileSections, { Section, InfoTip } from '../components/FileSections.jsx';
import { MoneyInput } from '../components/FormattedInputs.jsx';
import DocPreview from '../components/DocPreview.jsx';
import FileContacts from '../components/FileContacts.jsx';
import ChangeRequestPanel from '../components/ChangeRequestPanel.jsx';
import { fileToBase64 } from '../lib/files.js';

const kb = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street || a.line1, a.city, a.state].filter(Boolean).join(', ') || '—');
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded' };

const isDone = (s) => s === 'received' || s === 'satisfied' || s === 'done';
const statusText = (it) => it.status === 'issue' ? 'Needs attention' : it.status === 'received' ? 'Submitted' : it.status === 'satisfied' ? 'Completed' : 'To do';

// Contact conditions are FORMS, not uploads: the borrower enters their title /
// insurance contact once; it saves to a reusable contact book.
const CONTACT = {
  title_contact:     { type: 'title_company',  name: 'Title company' },
  insurance_contact: { type: 'insurance_agent', name: 'Insurance agent' },
};

const oneLineAddr = (a) => !a ? '' : (a.oneLine || [a.street, a.line1, a.city, a.state, a.zip].filter(Boolean).join(', '));

// The Scope of Work condition opens the full static builder, connected to THIS
// file: it autosaves onto the condition and Save attaches HTML+PDF+Excel.
// Prefilled from the application: address, transaction, property type, unit
// count, project type and the target construction budget.
function sowUrl(appId, item, app) {
  const p = new URLSearchParams({ app: appId, item: item.id, embed: '1' });
  const addr = oneLineAddr(app.property_address);
  if (addr) p.set('address', addr);
  const units = Number(app.units) || 0;
  if (units > 0) p.set('units', String(units));
  p.set('propType', units >= 5 ? 'large' : units >= 2 ? 'multi' : 'single');
  if (app.loan_type && /refi/i.test(app.loan_type)) p.set('txn', 'refi');
  else if (app.loan_type && /purchase/i.test(app.loan_type)) p.set('txn', 'purchase');
  const rt = String(app.rehab_type || app.program || '');
  if (/ground/i.test(rt)) p.set('projType', 'ground');
  else if (/heavy|gut/i.test(rt)) p.set('projType', 'heavy');
  else if (/moderate/i.test(rt)) p.set('projType', 'moderate');
  else if (/cosmetic/i.test(rt)) p.set('projType', 'cosmetic');
  if (Number(app.rehab_budget) > 0) p.set('target', String(Math.round(Number(app.rehab_budget))));
  // Gold Standard files auto-fill a 5% construction contingency in the builder.
  if (/gold/i.test(String(app.registered_program || ''))) p.set('program', 'gold');
  return `/tools/rehab-budget.html?${p.toString()}`;
}

// Client-side Luhn check — same rule the server enforces.
function luhnOk(num) {
  const s = String(num || '').replace(/\D/g, '');
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

/* Credit card for the appraisal — a condition that expands into a card form.
   Validated (Luhn + expiry) before it saves; stored encrypted; the back
   office sees it when ordering the appraisal. */
function CardCondition({ it, appId, onSaved }) {
  const done = isDone(it.status);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(null);   // masked card on file
  const [f, setF] = useState({ number: '', expMonth: '', expYear: '', cvc: '', zip: '', saveForReuse: true });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [scanning, setScanning] = useState('');
  const scanRef = useRef(null);
  useEffect(() => { api.get(`/api/borrower/applications/${appId}/appraisal-card`).then(setSaved).catch(() => {}); }, [appId]);
  const digits = f.number.replace(/\D/g, '');
  const numberOk = luhnOk(digits);
  async function submit() {
    setFormErr('');
    if (!numberOk) { setFormErr('That card number doesn\'t check out — please re-enter it.'); return; }
    setBusy(true);
    try {
      const r = await api.post(`/api/borrower/applications/${appId}/appraisal-card`, f);
      setSaved({ last4: r.last4, brand: r.brand, exp_month: f.expMonth, exp_year: f.expYear, billing_zip: f.zip });
      setF({ number: '', expMonth: '', expYear: '', cvc: '', zip: '', saveForReuse: f.saveForReuse });
      setOpen(false); await onSaved();
    } catch (e) { setFormErr(e.message || 'Could not save the card'); }
    finally { setBusy(false); }
  }
  // Card scan via a HOSTED OCR API (owner choice, 2026-07-07). The photo is sent
  // to our backend, which proxies to the OCR provider and returns the parsed
  // number + expiry — the image is never persisted and card data is never
  // logged. The borrower confirms/edits before saving; manual entry always works.
  async function scanCard(file) {
    if (!file) return;
    setFormErr(''); setScanning('Reading your card…');
    try {
      const dataBase64 = await fileToBase64(file);
      const r = await api.post(`/api/borrower/applications/${appId}/scan-card`, { dataBase64, contentType: file.type });
      if (!r || (!r.number && !r.expMonth)) {
        setScanning(''); setFormErr("Couldn't read the card from that photo — please enter the details below."); return;
      }
      setF(prev => ({
        ...prev,
        number: r.number ? String(r.number).replace(/(\d{4})(?=\d)/g, '$1 ').trim() : prev.number,
        expMonth: r.expMonth || prev.expMonth,
        expYear: r.expYear ? (String(r.expYear).length === 2 ? '20' + r.expYear : String(r.expYear)) : prev.expYear,
      }));
      setScanning('Scanned ✓ — double-check the number and expiry, then add the CVC (back of the card) and billing ZIP.');
    } catch (e) {
      setScanning('');
      setFormErr("Card scanning isn't available right now — please enter the details below.");
    }
  }
  return (
    <ConditionRow
      done={done}
      title="Credit card for the appraisal"
      subtitle={saved
        ? `${saved.brand || 'Card'} ending ${saved.last4} on file — we'll use it to order your appraisal.`
        : 'Enter the card we should use to order your appraisal. Stored encrypted, used only for the appraisal.'}
      status={done ? 'Submitted' : 'To do'}
      open={open}
      action={<button className="btn ghost small" onClick={() => setOpen(o => !o)}>{open ? 'Close' : saved ? 'Replace card' : 'Enter card details'}</button>}
    >
      {formErr && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{formErr}</div>}
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input ref={scanRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => { const file = e.target.files && e.target.files[0]; e.target.value = ''; scanCard(file); }} />
        <button type="button" className="btn ghost small" onClick={() => scanRef.current && scanRef.current.click()}>📷 Scan card from a photo</button>
        <span className="muted small">Read on your device — the photo is never uploaded.</span>
      </div>
      {scanning && <div className="notice info" style={{ marginBottom: 8 }}>{scanning}</div>}
      <div className="grid cols-2">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Card number</label>
          <input className="input" inputMode="numeric" autoComplete="off" value={f.number}
            placeholder="•••• •••• •••• ••••"
            style={digits.length >= 13 && !numberOk ? { borderColor: 'var(--danger)' } : digits.length >= 13 && numberOk ? { borderColor: 'var(--ok)' } : undefined}
            onChange={e => setF({ ...f, number: e.target.value.replace(/[^\d ]/g, '').slice(0, 23) })} />
          {digits.length >= 13 && !numberOk && <span className="small" style={{ color: 'var(--danger)' }}>This isn't a valid card number.</span>}
          {digits.length >= 13 && numberOk && <span className="small" style={{ color: 'var(--ok)' }}>Card number checks out ✓</span>}
        </div>
        <div className="field"><label>Expiration month</label>
          <input className="input" inputMode="numeric" placeholder="MM" maxLength={2} value={f.expMonth}
            onChange={e => setF({ ...f, expMonth: e.target.value.replace(/\D/g, '') })} /></div>
        <div className="field"><label>Expiration year</label>
          <input className="input" inputMode="numeric" placeholder="YYYY" maxLength={4} value={f.expYear}
            onChange={e => setF({ ...f, expYear: e.target.value.replace(/\D/g, '') })} /></div>
        <div className="field"><label>Security code (CVC)</label>
          <input className="input" inputMode="numeric" placeholder="CVC" maxLength={4} value={f.cvc}
            onChange={e => setF({ ...f, cvc: e.target.value.replace(/\D/g, '') })} /></div>
        <div className="field"><label>Billing ZIP</label>
          <input className="input" inputMode="numeric" placeholder="ZIP" maxLength={10} value={f.zip}
            onChange={e => setF({ ...f, zip: e.target.value })} /></div>
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'flex-start', margin: '4px 0 12px', cursor: 'pointer' }}>
        <input type="checkbox" checked={!!f.saveForReuse} onChange={e => setF({ ...f, saveForReuse: e.target.checked })} style={{ marginTop: 3 }} />
        <span className="small">Save this card for my next file — we'll apply it automatically so you don't have to re-enter it. Stored encrypted; you can replace it any time.</span>
      </label>
      <button className="btn primary" onClick={submit} disabled={busy || !digits || !f.expMonth || !f.expYear || !f.cvc || !f.zip}>
        {busy ? 'Saving…' : 'Save & submit'}
      </button>
    </ConditionRow>
  );
}

/* One row in the conditions list: dot + title + status pill + right action,
   with optional expandable body. Every condition on the file renders through
   this so the whole section reads as one uniform list. */
function ConditionRow({ done, issue, title, subtitle, status, action, children, open, onDropFiles }) {
  const [over, setOver] = useState(false);
  // When onDropFiles is provided the whole row accepts a dragged-in document —
  // same upload as the button, you just drop the file onto the condition.
  const dropProps = onDropFiles ? {
    onDragOver: (e) => { e.preventDefault(); if (!over) setOver(true); },
    onDragLeave: (e) => { if (e.currentTarget === e.target) setOver(false); },
    onDrop: (e) => {
      e.preventDefault(); setOver(false);
      const f = Array.from(e.dataTransfer.files || []);
      if (f.length) onDropFiles(f);
    },
  } : {};
  return (
    <div className={`checkitem${onDropFiles ? ' cond-drop' : ''}${over ? ' drop-over' : ''}`}
      style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }} {...dropProps}>
      <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
        <span className={`dot ${done ? 'done' : 'outstanding'}`} style={{ marginTop: 4, ...(issue ? { background: 'var(--danger)' } : {}) }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
        <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{status}</span>
        {action}
      </div>
      {open && <div style={{ width: '100%', paddingLeft: 20 }}>{children}</div>}
      {over && onDropFiles && <div className="drop-hint">Drop file to upload</div>}
    </div>
  );
}

/* Information condition (Condition Center): asks for one piece of information
   and writes the answer straight into the real field on the file. The typed
   input (money / number / dropdown / date / text) comes from field_def. */
function InfoFieldCondition({ it, appId, onSaved }) {
  const done = isDone(it.status);
  const fd = it.field_def || { type: 'text', label: it.label };
  const submitted = it.tool_payload && it.tool_payload.value !== undefined ? it.tool_payload.value : undefined;
  const current = submitted !== undefined ? submitted : (it.field_value ?? '');
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(current === null || current === undefined ? '' : String(current));
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (fd.type === 'money') return money(v);
    if (fd.type === 'percent') return `${v}%`;
    if (fd.type === 'enum') { const o = (fd.options || []).find((x) => x.v === v); return o ? o.label : String(v); }
    return String(v);
  };
  async function submit() {
    if (val === '' || busy) return;
    setBusy(true); setFormErr('');
    try {
      await api.submitInfoCondition(appId, it.id, fd.type === 'boolean' ? val === 'true' : val);
      setOpen(false);
      await onSaved();
    } catch (e) { setFormErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  const input = fd.type === 'money'
    ? <MoneyInput value={val} onChange={setVal} />
    : fd.type === 'enum'
      ? <select className="input" value={val} onChange={(e) => setVal(e.target.value)}>
          <option value="" disabled>Choose…</option>
          {(fd.options || []).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
    : fd.type === 'boolean'
      ? <select className="input" value={val} onChange={(e) => setVal(e.target.value)}>
          <option value="" disabled>Choose…</option><option value="true">Yes</option><option value="false">No</option>
        </select>
    : <input className="input" type={fd.type === 'date' ? 'date' : (fd.type === 'number' || fd.type === 'percent') ? 'number' : 'text'}
        value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />;
  return (
    <ConditionRow
      done={done}
      issue={it.status === 'issue'}
      title={it.label}
      subtitle={(it.hint || fd.hint || 'A quick piece of information your loan team needs — it saves straight onto your file.')
        + (fmt(current) != null ? ` · Current answer: ${fmt(current)}` : '')}
      status={done ? 'Submitted' : 'To do'}
      open={open}
      action={<button className="btn primary small" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : done ? 'Update answer' : 'Enter information'}</button>}
    >
      {formErr && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{formErr}</div>}
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
          <label>{fd.label || it.label}</label>
          {input}
        </div>
        <button className="btn primary" onClick={submit} disabled={busy || val === ''}>{busy ? 'Saving…' : 'Save & submit'}</button>
      </div>
    </ConditionRow>
  );
}

/* E-signature condition (Condition Center). The signing ceremony activates
   when the e-sign integration goes live; until then the condition is visible
   with a clear "coming soon" state so nothing is a surprise later. */
function EsignCondition({ it }) {
  const done = isDone(it.status);
  return (
    <ConditionRow
      done={done}
      issue={it.status === 'issue'}
      title={it.label}
      subtitle={(it.esign_doc ? `Document: ${it.esign_doc}. ` : '') + (done
        ? 'Signed — the executed copy is on your file.'
        : (it.hint || 'You\'ll review and e-sign this document right here — electronic signing is being finalized. Your loan team will let you know the moment it\'s ready.'))}
      status={done ? 'Signed' : 'Awaiting signature'}
      action={<button className="btn ghost small" disabled title="Electronic signing is being finalized — this button will open the signing ceremony">Review & sign — coming soon</button>}
    />
  );
}

/* Company-contact condition (title company / insurance agent). Collapsed like
   every other condition; "Enter information" opens the form; saving submits. */
function ContactCondition({ it, appId, onSaved }) {
  const meta = CONTACT[it.tool_key];
  const done = isDone(it.status);
  const [saved, setSaved] = useState([]);
  const [f, setF] = useState({ companyName: '', contactName: '', email: '', phone: '' });
  const [contactId, setContactId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.contacts(meta.type).then(setSaved).catch(() => {}); }, [meta.type]);
  const useSaved = (c) => { setContactId(c.id); setF({ companyName: c.company_name || '', contactName: c.contact_name || '', email: c.email || '', phone: c.phone || '' }); };
  async function submit() {
    setBusy(true); setErr('');
    try {
      await api.saveContact({ contactType: meta.type, contactId, ...f, applicationId: appId, checklistItemId: it.id });
      setOpen(false); await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  return (
    <ConditionRow
      done={done}
      title={`Company contact — ${meta.name}`}
      subtitle={`Enter your ${meta.name.toLowerCase()} contact — no upload needed. We save it for your next file.`}
      status={done ? 'Submitted' : 'To do'}
      open={open}
      action={<button className="btn ghost small" onClick={() => setOpen(o => !o)}>{open ? 'Close' : done ? 'Edit' : 'Enter information'}</button>}
    >
      {saved.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="muted small">Use a saved contact:</span>
          {saved.map(c => <button key={c.id} className="btn ghost small" onClick={() => useSaved(c)}>{c.company_name || c.contact_name || c.email}</button>)}
        </div>
      )}
      <div className="grid cols-2">
        <div className="field"><label>Company / agency</label>
          <input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
        <div className="field"><label>Contact name</label>
          <input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
      </div>
      <div className="grid cols-2">
        <div className="field"><label>Email</label>
          <input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label>Phone</label>
          <input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
      </div>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save & submit'}</button>
    </ConditionRow>
  );
}

function experienceRequirement(app) {
  return {
    flips: Number(app.requested_exp_flips) || 0,
    holds: Number(app.requested_exp_holds) || 0,
    ground: Number(app.requested_exp_ground) || 0,
  };
}

/* The LLC condition — fulfilled by the LINKED entity's state, never by ad-hoc
   uploads. No entity linked: pick or create one. Linked but not verified:
   set it up right here (details, ownership, three documents) — everything
   saves to the borrower profile and is reused on every future loan. Linked
   and verified: automatically satisfied, documents already on file. */
function LlcCondition({ it, app, onChanged }) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pick, setPick] = useState({ id: null, name: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const linked = !!app.llc_id;
  const verified = !!app.llc_verified;

  async function link(llcId) {
    if (!llcId || busy) return;
    setBusy(true); setErr('');
    try { await api.linkLlc(app.id, llcId); setSwitching(false); setOpen(true); await onChanged(); }
    catch (e) { setErr(e.message || 'Could not link the LLC'); }
    finally { setBusy(false); }
  }

  if (!linked || switching) {
    return (
      <ConditionRow
        done={false}
        issue={it.status === 'issue'}
        title={it.label || 'Your LLC (vesting entity)'}
        subtitle="Which LLC is taking title? Pick one of your entities or create a new one — its details and documents live on your profile and are reused on every loan."
        status="To do"
        open
        action={switching ? <button className="btn link small" onClick={() => setSwitching(false)}>Cancel</button> : null}
      >
        {err && <div role="alert" className="notice err" style={{ marginBottom: 6 }}>{err}</div>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <LlcPicker value={pick.name} onPick={setPick} placeholder="Start typing your LLC name…" />
          </div>
          <button className="btn primary small" disabled={!pick.id || busy} onClick={() => link(pick.id)}>
            {busy ? 'Linking…' : 'Link this LLC'}
          </button>
        </div>
      </ConditionRow>
    );
  }

  if (verified) {
    return (
      <ConditionRow
        done
        title={it.label || 'Your LLC (vesting entity)'}
        subtitle={`${app.llc_name} is verified — its formation documents, EIN letter and operating agreement are on file and linked to this loan automatically.`}
        status="Verified ✓"
        open={open}
        action={<button className="btn ghost small" onClick={() => setOpen(o => !o)}>{open ? 'Close' : 'View LLC'}</button>}
      >
        <LlcManager llcId={app.llc_id} onChanged={onChanged} />
      </ConditionRow>
    );
  }

  return (
    <ConditionRow
      done={isDone(it.status)}
      issue={it.status === 'issue'}
      title={it.label || 'Your LLC (vesting entity)'}
      subtitle={`Set up ${app.llc_name}: entity details, full ownership, and its three documents. It saves to your profile — you'll never be asked again once it's verified.`}
      status={statusText(it)}
      open={open}
      action={
        <span className="row" style={{ gap: 6 }}>
          <button className="btn link small" onClick={() => setSwitching(true)}>Use a different LLC</button>
          <button className="btn primary small" onClick={() => setOpen(o => !o)}>{open ? 'Close' : 'Set up LLC'}</button>
        </span>
      }
    >
      {(() => {
        const propState = app.property_address && app.property_address.state;
        const formState = app.llc_formation_state;
        return propState && formState && String(propState).toUpperCase() !== String(formState).toUpperCase() ? (
          <p className="muted small" style={{ marginBottom: 8 }}>
            Heads up: this LLC is formed in {formState} but the property is in {propState} — you'll likely
            need to register the LLC as a foreign entity in {propState} before closing. Your loan team can help.
          </p>
        ) : null;
      })()}
      <LlcManager llcId={app.llc_id} onChanged={onChanged} />
    </ConditionRow>
  );
}

/* Borrower application completeness — the missing pieces of YOUR application,
   filled in RIGHT HERE (no separate form). Each missing field is a button that
   opens an inline input and saves straight onto your file. */
function BorrowerCompleteness({ app, profile, appId, onSaved }) {
  const [editing, setEditing] = useState(null);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = profile || {};
  const fields = [
    { key: 'property_address', label: 'Property address', ok: !!(app.property_address && (app.property_address.oneLine || app.property_address.street)), edit: false },
    { key: 'property_type', label: 'Property type', ok: !!app.property_type, type: 'select', options: ['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed Use'] },
    { key: 'purchase_price', label: 'Purchase price', ok: app.purchase_price != null, type: 'money' },
    { key: 'arv', label: 'ARV (estimate)', ok: app.arv != null, type: 'money' },
    { key: 'rehab_budget', label: 'Rehab budget', ok: app.rehab_budget != null, type: 'money' },
    { key: 'cell_phone', label: 'Your phone', ok: !!b.cell_phone, type: 'tel' },
    { key: 'date_of_birth', label: 'Date of birth', ok: !!b.date_of_birth, type: 'date' },
    { key: 'fico', label: 'Estimated FICO', ok: b.fico != null, type: 'number' },
    { key: 'citizenship', label: 'Citizenship', ok: !!b.citizenship, type: 'select', options: ['US Citizen', 'Permanent Resident', 'Foreign National'] },
  ];
  const done = fields.filter((x) => x.ok).length;
  const missing = fields.filter((x) => !x.ok);
  async function save(f) {
    if (val === '' || val == null) return;
    setBusy(true); setErr('');
    try { await api.post(`/api/borrower/applications/${appId}/complete-fields`, { [f.key]: val }); setEditing(null); setVal(''); await onSaved(); }
    catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Complete your application</h3>
        <div className="spacer" />
        <span className={`pill ${missing.length ? '' : 'done'}`}>{done}/{fields.length} complete</span>
      </div>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
      {missing.length === 0
        ? <p className="muted small">Thanks — your application has everything we asked for.</p>
        : (
          <>
            <p className="muted small" style={{ marginBottom: 8 }}>A few details are still missing — tap any to fill it in right here.</p>
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
                <span key={f.key} className="pill" style={{ borderColor: 'var(--muted)', color: 'var(--muted)' }}>Missing: {f.label}</span>
              ) : (
                <button key={f.key} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)', cursor: 'pointer', background: 'none' }}
                  onClick={() => { setEditing(f.key); setVal(''); setErr(''); }}>+ {f.label}</button>
              ))}
            </div>
          </>
        )}
    </div>
  );
}

export default function Application() {
  const { id } = useParams();
  const loc = useLocation();
  // A chat email deep-link arrives as /app/:id?chat=<conversationId> — auto-open
  // the Messages section so the recipient lands ON the conversation instead of at
  // the top of the file (owner-reported 2026-07-14). Runs once the file paints.
  const wantsChat = /(?:^|[?&])chat=/.test(loc.search || '');
  const [app, setApp] = useState(null);
  const [items, setItems] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [conds, setConds] = useState([]);
  const [profile, setProfile] = useState(null);
  const [dlBusy, setDlBusy] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);
  const studioRef = useRef(null);               // the Products & Pricing sheet
  const [target, setTarget] = useState(null);   // {itemId, slotBase|slot, replaceDocumentId, photoId}
  const [docFilter, setDocFilter] = useState('open');   // default: only what still needs the borrower
  // Conditions the borrower just worked on THIS visit: they stay visible in the
  // default "Open" view instead of vanishing the second an upload submits them.
  const [justTouched, setJustTouched] = useState(() => new Set());
  const touch = (itemId) => { if (itemId) setJustTouched((s) => new Set(s).add(itemId)); };
  const [trBusy, setTrBusy] = useState(false);
  const [trRows, setTrRows] = useState([]);     // the borrower's live track record
  const [trSnap, setTrSnap] = useState(null);   // its saved static HTML copy
  const [sowOpen, setSowOpen] = useState(false);

  const activityFetcher = useCallback(() => api.activity(id), [id]);
  const idRef = useRef(id); idRef.current = id;
  const load = () => {
    const forId = id;   // drop late responses after navigating to another file
    return Promise.all([
      api.application(id), api.checklist(id), api.documents(id).catch(() => []),
      api.conditions(id).catch(() => []), api.profile().catch(() => null),
      api.trackRecords().catch(() => []), api.trackRecordSnapshot().catch(() => null),
    ]).then(([a, c, d, cn, p, tr, ts]) => {
      if (idRef.current !== forId) return;
      setApp(a); setItems(c || []); setUploads(d || []); setConds(cn || []); setProfile(p); setTrRows(tr || []); setTrSnap(ts || null);
    }).catch(e => { if (idRef.current === forId) setErr(e.message); });
  };

  async function downloadDoc(doc) {
    setDlBusy(doc.id);
    try { const { blob, filename } = await api.downloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }
  // Preview a document in place (no download) — same authenticated loader.
  const [previewDoc, setPreviewDoc] = useState(null);
  // #100: the borrower's OWN loan officer contact for this file (name, title,
  // NMLS, phone, email) — not generic company info. null while loading / at Lead
  // Capture, so the rail falls back to the general YS Capital contact.
  const [officer, setOfficer] = useState(null);
  useEffect(() => {
    // React Router reuses this mounted component across /app/:id changes
    // (mention chips, notification deep-links). Clear the previous file's data
    // first or the old loan renders under the new URL until the fetch lands.
    setApp(null); setItems([]); setUploads([]); setConds([]); setErr(''); setMsg('');
    setSowOpen(false); setTarget(null);   // else the Scope-of-Work modal carries over to the next file
    setJustTouched(new Set()); setOfficer(null);
    load();
    api.fileOfficer(id).then(r => setOfficer((r && r.officer) || null)).catch(() => setOfficer(null));
    /* eslint-disable-next-line */
  }, [id]);
  // Coming back from the Track Record section / Scope of Work tab: refresh so
  // condition statuses and counts stay in step without a manual reload.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    /* eslint-disable-next-line */
  }, [id]);
  // Chat deep-link (…?chat=<id>): once the file has painted, bring the Messages
  // section into view so the recipient lands on the conversation.
  useEffect(() => {
    if (!wantsChat || !app) return undefined;
    const t = setTimeout(() => {
      const el = document.getElementById('sec-messages');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 350);
    return () => clearTimeout(t);
  }, [wantsChat, app]);

  const readB64 = fileToBase64;   // shared reader (lib/files.js)

  // Multi-select aware: picking several PDFs at once uploads them all onto the
  // condition, each in its own slot (Document N, N+1, …). Replacements and the
  // photo ID stay single-file. Shared by the file picker AND drag-and-drop, so
  // the target is passed explicitly rather than read from state.
  async function uploadFiles(fileList, tgt) {
    const all = Array.from(fileList || []);
    if (!all.length || !tgt) return;
    const files = (tgt.photoId || tgt.replaceDocumentId) ? all.slice(0, 1) : all;
    setErr('');
    try {
      if (tgt.photoId) {
        // The government-ID condition saves to the PROFILE too, so the next
        // file's ID condition is fulfilled automatically.
        setMsg('Uploading…');
        await api.uploadPhotoId({ applicationId: id, filename: files[0].name, contentType: files[0].type, dataBase64: await readB64(files[0]) });
      } else {
        const slotBase = Number.isFinite(tgt.slotBase) ? tgt.slotBase : null;
        for (let i = 0; i < files.length; i++) {
          setMsg(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
          const slot = tgt.replaceDocumentId ? (tgt.slot || undefined)
            : slotBase != null ? `Document ${slotBase + i + 1}`
            : (tgt.slot || undefined);
          await api.uploadDoc({
            applicationId: id, checklistItemId: tgt.itemId || undefined,
            slot, replaceDocumentId: tgt.replaceDocumentId || undefined,
            filename: files[i].name, contentType: files[i].type, size: files[i].size, dataBase64: await readB64(files[i]),
          });
        }
        touch(tgt.itemId);   // the condition stays visible in the Open view
      }
      setMsg(files.length > 1 ? `${files.length} files uploaded ✓` : 'Uploaded ✓');
      setTarget(null); await load();
      setTimeout(() => setMsg(''), 2500);
    } catch (e2) { setMsg(''); setErr(e2.message || 'Upload failed'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
  const onFile = (e) => uploadFiles(e.target.files, target);
  const pick = (t) => { setTarget(t || {}); fileRef.current && fileRef.current.click(); };

  async function submitTrackRecord(it) {
    setTrBusy(true); setErr('');
    try {
      await api.completeTool(id, it.id, { tool: 'track_record', completedAt: new Date().toISOString() });
      setMsg('Track record submitted for this file ✓'); await load(); setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      if (e.status === 422) setErr('Your track record doesn\'t cover this file\'s requirement yet — add the missing deals in your Track Record section first.');
      else setErr(e.message || 'Could not submit');
    } finally { setTrBusy(false); }
  }

  if (err && !app) return <div role="alert" className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;

  // ---- carve the checklist into the ordered conditions list ----
  const sowItem = items.find(it => it.tool_key === 'rehab_budget');
  const trItem = items.find(it => it.tool_key === 'track_record');
  const ppItem = items.find(it => it.tool_key === 'product_pricing');
  const cardItem = items.find(it => it.tool_key === 'appraisal_card');
  const contactItems = items.filter(it => it.tool_key && CONTACT[it.tool_key]);
  const infoItems = items.filter(it => it.tool_key === 'info_field');
  const esignItems = items.filter(it => it.tool_key === 'esign');
  const idItem = items.find(it => it.template_code === 'rtl_p1_id');
  const llcItem = items.find(it => it.template_code === 'rtl_p1_llc');
  const assetsItem = items.find(it => it.template_code === 'rtl_p3_assets');
  const usedIds = new Set([sowItem, trItem, idItem, llcItem, assetsItem, ...contactItems].filter(Boolean).map(x => x.id));
  const docItems = items.filter(it => !usedIds.has(it.id) && !it.tool_key);
  const registeredQuote = (() => {
    if (!app.registered_quote) return null;
    try { return typeof app.registered_quote === 'string' ? JSON.parse(app.registered_quote) : app.registered_quote; }
    catch { return null; }
  })();

  const currentDocsFor = (itemId) => uploads.filter(d => d.checklist_item_id === itemId && d.is_current !== false && d.review_status !== 'superseded');
  const itemLabelById = Object.fromEntries(items.map(it => [it.id, it.label]));
  const sowExports = sowItem ? currentDocsFor(sowItem.id).filter(d => d.doc_kind === 'rehab_budget_export') : [];
  // The registered term sheet now saves onto the Products & Pricing condition
  // itself (#139) — surface it there as a document slot.
  const tsDocs = ppItem ? currentDocsFor(ppItem.id).filter(d => d.doc_kind === 'term_sheet' || /term.?sheet/i.test(d.slot_label || d.filename || '')) : [];
  const req = experienceRequirement(app);
  // Experience progress toward the requirement. Prefer the SERVER-authoritative
  // count from the experience condition's payload — it applies the frozen 3-year
  // exit window AND sums the co-borrower's deals, so the borrower's "still need X"
  // matches the staff view and the requirement math exactly (#121). The condition
  // sync runs on every checklist GET, so the payload is current. Fall back to a
  // local all-deals compute only if the payload hasn't landed yet.
  const liveCounts = (() => {
    const sc = trItem && trItem.tool_payload && trItem.tool_payload.counts;
    if (sc && typeof sc === 'object') {
      const flips = sc.flips || 0, holds = sc.holds || 0, ground = sc.ground || 0;
      return { flips, holds, ground, total: sc.total != null ? sc.total : (flips + holds + ground) };
    }
    const c = { flips: 0, holds: 0, ground: 0, total: 0 };
    for (const r of trRows) {
      const t = String(r.deal_type || '').toLowerCase();
      if (t.includes('ground')) c.ground++; else if (t.includes('flip')) c.flips++; else c.holds++;
      c.total++;
    }
    return c;
  })();
  const stillNeeded = [
    req.flips > liveCounts.flips ? `${req.flips - liveCounts.flips} more flip${req.flips - liveCounts.flips === 1 ? '' : 's'}` : null,
    req.holds > liveCounts.holds ? `${req.holds - liveCounts.holds} more hold${req.holds - liveCounts.holds === 1 ? '' : 's'}` : null,
    req.ground > liveCounts.ground ? `${req.ground - liveCounts.ground} more ground-up` : null,
  ].filter(Boolean);
  const hasReq = req.flips + req.holds + req.ground > 0;

  const nDone = items.filter(it => isDone(it.status)).length;
  const nOpen = items.length - nDone;
  const isRefi = /refi/i.test(app.loan_type || '');

  // The 1003-style section rail: one page, clearly named parts.
  const SECTIONS = [
    { id: 'sec-overview', label: 'Loan overview' },
    { id: 'sec-application', label: 'Application details' },
    { id: 'sec-pricing', label: 'Structure & pricing', badge: app.registered_program ? '✓' : '' },
    { id: 'sec-conditions', label: 'Conditions to close', badge: nOpen || '' },
    { id: 'sec-contacts', label: 'Contacts' },
    ...(uploads.length ? [{ id: 'sec-documents', label: 'Document history', badge: uploads.length }] : []),
    { id: 'sec-messages', label: 'Messages' },
    { id: 'sec-activity', label: 'Activity' },
  ];

  return (
    <>
      {/* The file's identity bar STAYS while you scroll — the address, loan
          number and status pin under the app header; only the sections below
          (and the rail beside them) move. */}
      <div className="file-top">
        <Link to="/dashboard" className="btn link" style={{ flex: 'none' }}>← All loans</Link>
        <div className="file-top-main">
          <h1 className="file-top-addr">{addrLine(app.property_address)}</h1>
          <span className="muted small">{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}</span>
        </div>
        {app.loan_amount != null && (
          <span className="file-top-amt">
            <span className="k">Loan amount</span>
            <span className="ln-amount">{money(app.loan_amount)}</span>
          </span>
        )}
        <span className={`pill ${app.status}`} style={{ flex: 'none' }}>{LABEL[app.status] || app.status}</span>
      </div>

      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {/* Blueprint 2-column shell (pilot-borrower-file): the existing section
          nav + FileSections content stay exactly as they were on the main side;
          a NEW presentation-only right rail sits beside them. Wrapping markup
          only — FileSections and its .file-* internals are untouched. */}
      <div className="file-rail-grid">
      <FileSections sections={SECTIONS}>

      <Section id="sec-overview" title="Loan overview"
        info="Where your loan stands right now — the milestone timeline and the key numbers on file.">
      <PropertyPhoto address={addrLine(app.property_address) !== '—' ? addrLine(app.property_address) : ''} />

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <StatusTimeline appId={id} status={app.status} createdAt={app.created_at}
          expectedClosing={app.expected_closing} actualClosing={app.actual_closing} />
        <div className="panel" style={{ marginTop: 0 }}>
          <h3 style={{ marginBottom: 12 }}>Loan snapshot <InfoTip tip="The headline numbers your loan team works from. Ask your officer to update deal numbers — they flow into pricing automatically." /></h3>
          <div className="metrow"><span className="k">Officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}{app.team_online && <span title="Your loan team is online now" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3fb950', marginLeft: 8, verticalAlign: 'middle' }} />}</span></div>
          <div className="metrow"><span className="k">Purchase price</span><span className="v">{money(app.purchase_price)}</span></div>
          <div className="metrow"><span className="k">As-is value</span><span className="v">
            {money(app.as_is_value ?? app.purchase_price)}
            {app.as_is_value == null && app.purchase_price != null &&
              <span className="muted small" style={{ fontWeight: 400 }} title="No as-is value was entered, so it defaults to the final purchase price"> (= purchase price)</span>}
          </span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab budget</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v ln-amount">{money(app.loan_amount)}</span></div>
        </div>
      </div>
      </Section>

      <Section id="sec-application" title="Application details"
        info="What you told us on your application — the borrower, the property and the transaction. Ask your loan team to correct anything here.">
      <BorrowerCompleteness app={app} profile={profile} appId={id} onSaved={load} />
      <ChangeRequestPanel appId={id} app={app} />
      <div className="grid cols-2">
        <div className="panel" style={{ marginTop: 0 }}>
          <h3 style={{ marginBottom: 12 }}>Borrower</h3>
          <div className="metrow"><span className="k">Name</span><span className="v">{profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || '—' : '—'}</span></div>
          <div className="metrow"><span className="k">Email</span><span className="v">{(profile && profile.email) || '—'}</span></div>
          <div className="metrow"><span className="k">Phone</span><span className="v">{(profile && profile.cell_phone) || '—'}</span></div>
          <div className="metrow"><span className="k">Vesting entity</span><span className="v">
            {app.entity_name || app.llc_name || (app.llc_id ? 'LLC on file' : 'Not linked yet')}
            {app.llc_id && app.llc_verified && <span className="ts-badge ok" style={{ marginLeft: 6 }}>Verified ✓</span>}
          </span></div>
          {(() => {
            // Entered = what was claimed on the application / product
            // registration (re-registering syncs these onto the file).
            // Verified = what the loan team has verified on the track record —
            // the basis pricing actually stands on. The two must meet: either
            // the track record catches up, or the file reprices at the lower
            // (more expensive) experience tier.
            const entered = {
              flips: Number(app.requested_exp_flips) || 0,
              holds: Number(app.requested_exp_holds) || 0,
              ground: Number(app.requested_exp_ground) || 0,
            };
            const v = { flips: 0, holds: 0, ground: 0, total: 0 };
            for (const r of trRows) {
              if (!r.is_verified) continue;
              const t = String(r.deal_type || '').toLowerCase();
              if (t.includes('ground')) v.ground++; else if (t.includes('flip')) v.flips++; else v.holds++;
              v.total++;
            }
            const short = [
              entered.flips > v.flips ? `${entered.flips - v.flips} flip${entered.flips - v.flips === 1 ? '' : 's'}` : null,
              entered.holds > v.holds ? `${entered.holds - v.holds} hold${entered.holds - v.holds === 1 ? '' : 's'}` : null,
              entered.ground > v.ground ? `${entered.ground - v.ground} ground-up` : null,
            ].filter(Boolean);
            return <>
              <div className="metrow"><span className="k">Experience entered <InfoTip tip="What you entered on your application / product registration. Re-registering a product updates this." /></span><span className="v">
                {[entered.flips ? `${entered.flips} flips` : '', entered.holds ? `${entered.holds} holds` : '', entered.ground ? `${entered.ground} ground-up` : '', app.requested_exp_reo ? `${app.requested_exp_reo} REO` : ''].filter(Boolean).join(' · ') || '—'}
              </span></div>
              <div className="metrow"><span className="k">Experience verified <InfoTip tip="Deals your loan team has verified on your Track Record — the experience your pricing actually stands on." /></span><span className="v">
                {v.total
                  ? <>
                      {[v.flips ? `${v.flips} flip${v.flips === 1 ? '' : 's'}` : '', v.holds ? `${v.holds} hold${v.holds === 1 ? '' : 's'}` : '', v.ground ? `${v.ground} ground-up` : ''].filter(Boolean).join(' · ')}
                      <span className="ts-badge ok" style={{ marginLeft: 6 }}>From your track record ✓</span>
                    </>
                  : <span className="muted">None verified yet — your track record is reviewed by your loan team</span>}
              </span></div>
              {short.length > 0 && (
                <div className="small" style={{ padding: '8px 10px', marginTop: 6, borderRadius: 8, border: '1px solid rgba(201,168,106,.45)', background: 'rgba(201,168,106,.1)', color: '#E6D2A6' }}>
                  ⚠ These two need to match before closing: your verified track record is short {short.join(', ')}.
                  Add (and document) the missing deals in your <Link to={`/track-record?app=${id}`} style={{ color: 'inherit', textDecoration: 'underline' }}>Track Record</Link>,
                  or reprice in Products &amp; Pricing with the lower experience — a lower tier prices higher.
                </div>
              )}
            </>;
          })()}
        </div>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3 style={{ marginBottom: 12 }}>Property & transaction</h3>
          <div className="metrow"><span className="k">Address</span><span className="v">{addrLine(app.property_address)}</span></div>
          <div className="metrow"><span className="k">Property type</span><span className="v">{app.property_type || '—'}{app.units ? ` · ${app.units} unit${app.units > 1 ? 's' : ''}` : ''}</span></div>
          <div className="metrow"><span className="k">Program</span><span className="v">{app.program || '—'}</span></div>
          <div className="metrow"><span className="k">Transaction</span><span className="v">{app.loan_type || '—'}</span></div>
          {isRefi ? <>
            <div className="metrow"><span className="k">Payoff amount</span><span className="v">{money(app.payoff_amount)}</span></div>
            <div className="metrow"><span className="k">Original purchase price</span><span className="v">{money(app.original_purchase_price)}</span></div>
            <div className="metrow"><span className="k">Date acquired</span><span className="v">{app.acquisition_date ? fmtDay(app.acquisition_date) : '—'}</span></div>
          </> : (
            <div className="metrow"><span className="k">Purchase price</span><span className="v">{money(app.purchase_price)}</span></div>
          )}
          <div className="metrow"><span className="k">Rehab type</span><span className="v">{app.rehab_type || '—'}</span></div>
        </div>
      </div>
      </Section>

      <Section id="sec-pricing" title="Loan structure & pricing"
        info="Your registered product and the live Term Sheet Studio. Reprice any time — your scenario autosaves and re-registering replaces the old terms."
        badge={app.registered_program ? 'Registered ✓' : 'Not registered yet'}>
      <div id="product-studio"><ProductStudioPanel ref={studioRef} appId={id} app={app} onRegistered={load} mode="borrower"
        toolItemId={(items.find(it => it.tool_key === 'product_pricing') || {}).id} /></div>
      </Section>

      {/* ================= CONDITIONS — one list, everything the file needs ================= */}
      <Section id="sec-conditions" title="Conditions to close"
        info="Every item your loan team needs before closing, in the order it's worked. Upload to a condition and it moves to review; your team accepts, or asks for a fix — you'll be notified either way."
        badge={`${nDone}/${items.length} complete`}>
      <div className="panel" style={{ marginTop: 0 }}>
        <div className="row" style={{ marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
          <h3>Your conditions</h3>
          <div className="spacer" />
          <span className="muted small">{nDone}/{items.length} complete</span>
          <select className="input" style={{ maxWidth: 200 }} value={docFilter} onChange={e => setDocFilter(e.target.value)}>
            <option value="open">Open — still needs you</option>
            <option value="review">Submitted — in review</option>
            <option value="attention">Needs attention</option>
            <option value="done">Completed</option>
            <option value="all">All conditions</option>
          </select>
        </div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Everything your loan team needs to move this file forward, in one place. Each condition can carry
          several documents — select multiple PDFs at once, or add more later with "+ Add another".
        </p>
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onFile} />
        {(() => {
          const bucket = (s) => s === 'issue' ? 'attention' : s === 'received' ? 'review' : (s === 'satisfied' || s === 'done') ? 'done' : 'todo';
          // Default view: submitted conditions disappear as you complete them —
          // only what still needs you (to do / needs attention) stays visible.
          // EXCEPT what you just worked on this visit (justTouched): it stays put
          // so "+ Add another" is still there right after an upload submits it.
          const show = (it) => docFilter === 'all'
            || (docFilter === 'open'
              ? (['todo', 'attention'].includes(bucket(it.status)) || justTouched.has(it.id))
              : bucket(it.status) === docFilter);
          return (
            <>
              {/* 0 — Products & pricing: open until a product is registered */}
              {ppItem && show(ppItem) && (
                <ConditionRow
                  done={isDone(ppItem.status) || !!app.registered_program}
                  title="Products & pricing — register your product"
                  subtitle={app.registered_program
                    ? `Registered: ${app.registered_product_label || (app.registered_program === 'gold' ? 'Gold Standard Program' : 'Standard Program')} · ${money(app.registered_total_loan)}`
                    : 'Price your deal in the Term Sheet Studio and register your product — your terms, cash to close and liquidity requirement all come from it.'}
                  status={(isDone(ppItem.status) || app.registered_program) ? 'Completed' : 'To do'}
                  open={tsDocs.length > 0}
                  action={<button className="btn primary small" onClick={() => {
                    // Same full-screen tool sheet as the Scope of Work — no
                    // scrolling hunt for the panel.
                    if (studioRef.current) studioRef.current.openStudio();
                    else { const el = document.getElementById('product-studio'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                  }}>
                    {app.registered_program ? 'Reprice / re-register' : 'Open Products & Pricing'}
                  </button>}
                >
                  {tsDocs.length > 0 && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {tsDocs.map(d => {
                        const canPreview = /pdf|html|image|png|jpe?g/i.test(d.content_type || d.filename);
                        return (
                          <span key={d.id} className="row" style={{ gap: 4 }}>
                            {canPreview && <button className="btn ghost small" title="Preview without downloading" onClick={() => setPreviewDoc(d)}>Preview term sheet</button>}
                            <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                              {dlBusy === d.id ? '…' : '⤓ Term sheet'}
                            </button>
                          </span>
                        );
                      })}
                      <span className="muted small" style={{ alignSelf: 'center' }}>Saved from your registration. Re-registering replaces it.</span>
                    </div>
                  )}
                </ConditionRow>
              )}

              {/* 1 — Rehab budget / Scope of Work */}
              {sowItem && show(sowItem) && (
                <ConditionRow
                  done={isDone(sowItem.status)}
                  issue={sowItem.status === 'issue'}
                  title="Rehab budget — Scope of Work"
                  subtitle={'Build your scope of work in the YS builder. It autosaves onto this condition; submitting attaches a fresh PDF + Excel for underwriting' + (app.rehab_budget != null ? ` · current total ${money(app.rehab_budget)}` : '')}
                  status={statusText(sowItem)}
                  open={sowExports.length > 0}
                  action={<button className="btn primary small" onClick={() => setSowOpen(true)}>{sowItem.tool_submitted ? 'Reopen & edit' : 'Open Scope of Work'}</button>}
                >
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {sowExports.map(d => {
                      const label = /xlsx|sheet/i.test(d.content_type || d.filename) ? 'Excel export' : /html/i.test(d.content_type || d.filename) ? 'Editable HTML copy' : 'PDF export';
                      const canPreview = /pdf|html|image|png|jpe?g/i.test(d.content_type || d.filename);
                      return (
                        <span key={d.id} className="row" style={{ gap: 4 }}>
                          {canPreview && <button className="btn ghost small" title="Preview without downloading" onClick={() => setPreviewDoc(d)}>Preview {label}</button>}
                          <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                            {dlBusy === d.id ? '…' : `⤓ ${label}`}
                          </button>
                        </span>
                      );
                    })}
                    {sowExports.length > 0 && <span className="muted small" style={{ alignSelf: 'center' }}>Re-submitting from the builder replaces these with fresh versions.</span>}
                  </div>
                </ConditionRow>
              )}

              {/* 2 — Track record (lives on your profile-wide Track Record section) */}
              {trItem && show(trItem) && (
                <ConditionRow
                  done={isDone(trItem.status)}
                  issue={trItem.status === 'issue'}
                  title="Borrower track record & experience"
                  subtitle={hasReq
                    ? `You've entered ${[req.flips ? `${liveCounts.flips}/${req.flips} flips` : '', req.holds ? `${liveCounts.holds}/${req.holds} holds` : '', req.ground ? `${liveCounts.ground}/${req.ground} ground-up` : ''].filter(Boolean).join(', ')}`
                      + (stillNeeded.length ? ` — still need ${stillNeeded.join(', ')} to match your product registration.` : ' — requirement met ✓ submit it for this file.')
                    : liveCounts.total
                      ? `${liveCounts.total} deal${liveCounts.total === 1 ? '' : 's'} on your record — linked automatically to this file.`
                      : 'Document your completed deals once — your track record is one record, shared by every file.'}
                  status={statusText(trItem)}
                  open={!!trSnap}
                  action={
                    <span className="row" style={{ gap: 6 }}>
                      <Link className="btn primary small" to={`/track-record?app=${id}`}>Open Track Record</Link>
                      {!isDone(trItem.status) && <button className="btn ghost small" disabled={trBusy} onClick={() => submitTrackRecord(trItem)}>{trBusy ? '…' : 'Submit for this file'}</button>}
                    </span>
                  }
                >
                  {trSnap && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn ghost small" title="Preview without downloading"
                        onClick={() => setPreviewDoc({ id: trSnap.documentId, filename: trSnap.filename, content_type: 'text/html' })}>
                        Preview
                      </button>
                      <button className="btn ghost small" disabled={dlBusy === trSnap.documentId}
                        onClick={() => downloadDoc({ id: trSnap.documentId, filename: trSnap.filename })}>
                        {dlBusy === trSnap.documentId ? '…' : '⤓ Saved copy (HTML)'}
                      </button>
                      <span className="muted small" style={{ alignSelf: 'center' }}>
                        The static copy of your track record — kept in sync automatically, shared by every file.
                      </span>
                    </div>
                  )}
                </ConditionRow>
              )}

              {/* 3 — The vesting LLC: linked entity's state drives this condition */}
              {llcItem && show(llcItem) && <LlcCondition it={llcItem} app={app} onChanged={load} />}

              {/* 4 — Company contacts (title / insurance) + appraisal card */}
              {contactItems.filter(show).map(it => <ContactCondition key={it.id} it={it} appId={id} onSaved={async () => { touch(it.id); await load(); }} />)}
              {cardItem && show(cardItem) && <CardCondition it={cardItem} appId={id} onSaved={async () => { touch(cardItem.id); await load(); }} />}

              {/* 4a — Information conditions: typed answers written straight
                  onto the file, and e-sign conditions (ceremony coming). */}
              {infoItems.filter(show).map(it => <InfoFieldCondition key={it.id} it={it} appId={id} onSaved={async () => { touch(it.id); await load(); }} />)}
              {esignItems.filter(show).map(it => <EsignCondition key={it.id} it={it} />)}

              {/* 4 — Government ID, fulfilled straight from the borrower profile */}
              {idItem && show(idItem) && (
                <ConditionRow
                  done={isDone(idItem.status) || !!(profile && profile.photo_id_document_id)}
                  issue={idItem.status === 'issue'}
                  title={idItem.label}
                  subtitle={profile && profile.photo_id_document_id
                    ? 'On file from your borrower profile — automatically linked to this file. You won\'t be asked again on your next loan.'
                    : 'Upload once — it saves to your borrower profile and fulfills this condition on every future file automatically.'}
                  status={(profile && profile.photo_id_document_id) ? 'On file ✓' : statusText(idItem)}
                  action={<button className="btn ghost small" onClick={() => pick({ photoId: true })}>{profile && profile.photo_id_document_id ? 'Replace ID' : 'Upload ID'}</button>}
                  onDropFiles={(f) => uploadFiles(f, { photoId: true })}
                />
              )}

              {/* 4b — Assets & liquidity: once a product is registered, the
                  registered requirement replaces the generic asset condition */}
              {assetsItem && show(assetsItem) && (() => {
                const docs = currentDocsFor(assetsItem.id);
                const q = registeredQuote;
                const liq = q && (q.liquidity ?? q.liquidityRequired);
                // The registration's liquidity condition is one and the same —
                // its full breakdown renders inside THIS condition.
                const regCond = conds.find(c => c.linked_entity_type === 'product_registration');
                return (
                  <ConditionRow
                    done={isDone(assetsItem.status)}
                    issue={assetsItem.status === 'issue'}
                    title={q ? 'Assets & liquidity — your registered requirement' : assetsItem.label}
                    subtitle={q
                      ? `Your ${app.registered_program === 'gold' ? 'Gold Standard' : 'Standard'} registration: verify ${money(liq)} in liquidity`
                        + (q.reserveRequirement ? ` (incl. ${money(q.reserveRequirement)} reserve${q.reserveBasis ? ` — ${q.reserveBasis}` : ''})` : '')
                        + (q.cashToClose ? ` · estimated cash to close ${money(q.cashToClose)}` : '')
                        + '. Upload the bank statements that show it.'
                      : [assetsItem.hint, assetsItem.notes].filter(Boolean).join(' · ') || 'Bank statements showing your required liquidity.'}
                    status={statusText(assetsItem)}
                    open={docs.length > 0 || assetsItem.status === 'issue' || !!q}
                    action={<button className="btn ghost small" title="You can select several PDFs at once" onClick={() => pick({ itemId: assetsItem.id, slotBase: docs.length })}>{docs.length ? '+ Add another' : 'Upload statements'}</button>}
                    onDropFiles={(f) => uploadFiles(f, { itemId: assetsItem.id, slotBase: docs.length })}
                  >
                    {regCond && regCond.detail && (
                      <div className="muted small" style={{ whiteSpace: 'pre-line', marginBottom: 8, padding: '8px 10px', border: '1px solid rgba(127,169,176,.3)', borderRadius: 8 }}>
                        {regCond.detail}
                      </div>
                    )}
                    {assetsItem.status === 'issue' && assetsItem.rejection_reason && (
                      <div className="small" style={{ color: 'var(--danger)', marginBottom: 6 }}>
                        Needs a new version: {assetsItem.rejection_reason}
                      </div>
                    )}
                    {/* A staffer accepted a statement but asked for one more — the
                        registered-requirement subtitle above hides the hint, so
                        surface the "Still needed" ask here too (#125). */}
                    {assetsItem.hint && /still needed/i.test(assetsItem.hint) && (
                      <div className="small" style={{ color: 'var(--gold)', marginBottom: 6 }}>
                        Still needed: {assetsItem.hint.replace(/^[\s\S]*?Still needed:\s*/i, '')}
                      </div>
                    )}
                    {docs.map((d, i) => (
                      <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                        <span className="muted small" style={{ minWidth: 90 }}>{d.slot_label || `Document ${i + 1}`}</span>
                        <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                        <span className="pill" style={d.review_status === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : d.review_status === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>
                          {d.review_status === 'accepted' ? 'Accepted' : d.review_status === 'rejected' ? 'Rejected' : 'In review'}
                        </span>
                        <button className="btn link small" onClick={() => pick({ itemId: assetsItem.id, slot: d.slot_label || undefined, replaceDocumentId: d.id })}>Replace</button>
                        <button className="btn ghost small" title="Preview" onClick={() => setPreviewDoc(d)}>Preview</button>
                        <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>{dlBusy === d.id ? '…' : '⤓'}</button>
                      </div>
                    ))}
                  </ConditionRow>
                );
              })()}

              {/* 5 — every remaining condition, each with multi-document slots */}
              {docItems.filter(show).map(it => {
                const docs = currentDocsFor(it.id);
                const needsFix = it.status === 'issue';
                return (
                  <ConditionRow
                    key={it.id}
                    done={isDone(it.status)}
                    issue={needsFix}
                    title={it.label}
                    subtitle={[it.hint, it.notes].filter(Boolean).join(' · ') || null}
                    status={statusText(it)}
                    open={docs.length > 0 || needsFix}
                    action={<button className="btn ghost small" title="You can select several PDFs at once" onClick={() => pick({ itemId: it.id, slotBase: docs.length })}>{docs.length ? '+ Add another' : 'Upload'}</button>}
                    onDropFiles={(f) => uploadFiles(f, { itemId: it.id, slotBase: docs.length })}
                  >
                    {needsFix && it.rejection_reason && (
                      <div className="small" style={{ color: 'var(--danger)', marginBottom: 6 }}>
                        Needs a new version: {it.rejection_reason}
                      </div>
                    )}
                    {docs.map((d, i) => (
                      <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                        <span className="muted small" style={{ minWidth: 90 }}>{d.slot_label || `Document ${i + 1}`}</span>
                        <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                        <span className="pill" style={d.review_status === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : d.review_status === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>
                          {d.review_status === 'accepted' ? 'Accepted' : d.review_status === 'rejected' ? 'Rejected' : 'In review'}
                        </span>
                        <button className="btn link small" onClick={() => pick({ itemId: it.id, slot: d.slot_label || undefined, replaceDocumentId: d.id })}>Replace</button>
                        <button className="btn ghost small" title="Preview" onClick={() => setPreviewDoc(d)}>Preview</button>
                        <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>{dlBusy === d.id ? '…' : '⤓'}</button>
                      </div>
                    ))}
                  </ConditionRow>
                );
              })}

              {/* 6 — anything else your loan team flagged (read-only). The
                  registered-liquidity condition is NOT repeated here — it is
                  merged into the Assets & liquidity condition above. */}
              {conds.filter(c => c.linked_entity_type !== 'product_registration').map(c => (
                <ConditionRow key={c.id} done={false} title={c.title} subtitle={c.detail || 'Your loan team will follow up on this item.'}
                  status="Needs your attention" action={null} />
              ))}
            </>
          );
        })()}
        {items.length === 0 && conds.length === 0 && (
          <p className="muted small">No conditions requested yet. Your coordinator will post them here.</p>
        )}
      </div>
      </Section>

      <Section id="sec-contacts" title="Contacts"
        info="Everyone working on this deal — realtor, attorney, title, insurance, contractor and more. Add anyone; they're shared on the file and saved to your contacts.">
        <FileContacts appId={id} heading="Contacts on this file" />
      </Section>

      {uploads.length > 0 && (
        <Section id="sec-documents" title="Document history" collapsible defaultOpen={false}
          info="Everything uploaded to this file, newest first, titled by the condition it belongs to. Replaced and rejected versions stay for the record."
          badge={`${uploads.length} file${uploads.length === 1 ? '' : 's'}`}>
        <div className="panel" style={{ marginTop: 0 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <h3>Your uploaded documents</h3>
            <div className="spacer" />
            <span className="muted small">{uploads.length} file{uploads.length === 1 ? '' : 's'}</span>
          </div>
          {uploads.map(d => {
            const rs = d.review_status || 'pending';
            const label = rs === 'accepted' ? 'Accepted' : rs === 'rejected' ? 'Rejected' : rs === 'superseded' ? 'Replaced' : 'In review';
            const style = rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' }
              : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined;
            return (
            <div className="checkitem" key={d.id} style={{ opacity: d.is_current === false ? .6 : 1, flexWrap: 'wrap' }}>
              <span className={`dot ${rs === 'accepted' ? 'done' : 'outstanding'}`} />
              <div style={{ flex: 1, minWidth: 200 }}>
                {/* The CONDITION is where the document lives — lead with it;
                    the raw filename is secondary (often meaningless). */}
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {itemLabelById[d.checklist_item_id] || (d.doc_kind === 'term_sheet' ? 'Term sheet' : d.doc_kind === 'photo_id' ? 'Government photo ID' : 'General upload')}
                  {d.slot_label ? <span className="muted small" style={{ fontWeight: 400 }}> · {d.slot_label}</span> : null}
                </div>
                <div className="muted small">{d.filename} · {kb(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString()}</div>
                {rs === 'rejected' && d.rejection_reason && <div className="small" style={{ color: 'var(--danger)' }}>{d.rejection_reason}</div>}
              </div>
              <span className="pill" style={style}>{label}</span>
              <button className="btn ghost" title="Preview" onClick={() => setPreviewDoc(d)}>Preview</button>
              <button className="btn ghost" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                {dlBusy === d.id ? '…' : 'Download'}
              </button>
            </div>
            );
          })}
        </div>
        </Section>
      )}

      <Section id="sec-messages" title="Messages"
        info="Chat live with your loan team — see when they're online, when they're typing, and when your messages are read. Attach files, record voice notes, and get answers on the record.">
      {/* Keyed by file id: this component survives /app/:id navigation, and
          without the key the previous file's thread kept showing. */}
      <BorrowerChat key={id} appId={id} />
      </Section>

      <Section id="sec-activity" title="Activity" collapsible defaultOpen={false}
        info="The full audit log of this file — every application edit, reprice, upload, status change and sign-off, with exactly what changed.">
      <ActivityFeed fetcher={activityFetcher} title="File audit log" compact />
      </Section>

      </FileSections>

      {/* RIGHT RAIL — the borrower's loan team + help. Shows THEIR assigned loan
          officer's contact (name, title, NMLS, direct phone + email; #100),
          fetched per file, falling back to the loan object's name and the general
          YS Capital line at Lead Capture. No note-buyer/capital-partner names. */}
      <aside className="file-rail" aria-label="Your loan team and help">
        <div className="panel">
          <h3 style={{ marginBottom: 10 }}>Your team</h3>
          <div className="rail-team">
            <span className="rail-ava" aria-hidden="true" />
            <div className="rail-who">
              <div className="rail-n">{(officer && officer.full_name) || app.loan_officer_name || 'Lead Capture'}</div>
              <div className="rail-r muted small">{(officer && officer.title) || 'Loan Officer'}{officer && officer.nmls ? ` · NMLS #${officer.nmls}` : ''}</div>
            </div>
          </div>
          {officer && (officer.phone || officer.cell || officer.email) && (
            <div className="rail-help" style={{ marginTop: 10, flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              {(officer.cell || officer.phone) && (
                <span><span className="rail-help-ic" aria-hidden="true">☎</span>{' '}
                  <a href={`tel:${(officer.cell || officer.phone).replace(/[^\d+]/g, '')}`}>{officer.cell || officer.phone}</a></span>
              )}
              {officer.email && (
                <span><span className="rail-help-ic" aria-hidden="true">✉</span>{' '}
                  <a href={`mailto:${officer.email}`}>{officer.email}</a></span>
              )}
            </div>
          )}
        </div>

        <CoBorrowerRail app={app} onChanged={load} />

        <div className="panel rail-callout">
          <div className="rail-callout-lbl">Next step</div>
          <p className="small" style={{ margin: 0 }}>
            Check <b>Conditions to close</b> for anything still needed — upload to a
            condition and your loan team reviews it right away.
          </p>
        </div>

        <div className="panel">
          <h3 style={{ marginBottom: 8 }}>Need help?</h3>
          <p className="muted small" style={{ marginBottom: 10 }}>
            We're here Monday–Friday, 9am–6pm ET. Reach your YS Capital team anytime.
          </p>
          <div className="rail-help">
            <span className="rail-help-ic" aria-hidden="true">☎</span>
            <a href="tel:+17188312168">718-831-2168</a>
          </div>
        </div>
      </aside>
      </div>

      {sowOpen && sowItem && (
        <ToolModal
          title="Rehab Budget — Scope of Work"
          url={sowUrl(id, sowItem, app)}
          onClose={() => { setSowOpen(false); load(); }} />
      )}
      {previewDoc && (
        <DocPreview
          title={itemLabelById[previewDoc.checklist_item_id] || previewDoc.slot_label || 'Document preview'}
          filename={previewDoc.filename} contentType={previewDoc.content_type}
          load={() => api.downloadDoc(previewDoc.id)}
          onDownload={() => downloadDoc(previewDoc)}
          onClose={() => setPreviewDoc(null)} />
      )}
    </>
  );
}

/* #110: invite a co-borrower to an EXISTING file from the overview — only the
   PRIMARY borrower, only when the file has no co-borrower yet. When one is
   already on the file, this just shows who. */
function CoBorrowerRail({ app, onChanged }) {
  const { actor } = useAuth();
  const isPrimary = actor?.id && app.borrower_id === actor.id;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const coName = [app.co_borrower_first_name, app.co_borrower_last_name].filter(Boolean).join(' ');
  async function submit() {
    if (busy) return; setErr('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((f.email || '').trim())) { setErr('Enter a valid email address.'); return; }
    setBusy(true);
    try { await api.inviteCoBorrowerToFile(app.id, f); setOpen(false); setF({ firstName: '', lastName: '', email: '', phone: '' }); await onChanged(); }
    catch (e) { setErr(e.message || 'Could not invite the co-borrower.'); }
    finally { setBusy(false); }
  }
  if (app.co_borrower_id) {
    return (
      <div className="panel">
        <h3 style={{ marginBottom: 8 }}>Co-borrower</h3>
        <div className="rail-team"><span className="rail-ava" aria-hidden="true" />
          <div className="rail-who"><div className="rail-n">{coName || 'Invited'}</div>
            <div className="rail-r muted small">On this loan with you</div></div></div>
      </div>
    );
  }
  if (!isPrimary) return null;
  return (
    <div className="panel">
      <h3 style={{ marginBottom: 8 }}>Co-borrower</h3>
      {!open ? (
        <>
          <p className="muted small" style={{ marginBottom: 10 }}>Applying with someone else? Invite them to PILOT — they add their own information and documents.</p>
          <button className="btn ghost small" onClick={() => setOpen(true)}>+ Invite a co-borrower</button>
        </>
      ) : (
        <>
          <div className="grid cols-2" style={{ gap: 8 }}>
            <input className="input" placeholder="First name" value={f.firstName} onChange={e => setF(s => ({ ...s, firstName: e.target.value }))} />
            <input className="input" placeholder="Last name" value={f.lastName} onChange={e => setF(s => ({ ...s, lastName: e.target.value }))} />
          </div>
          <input className="input" style={{ marginTop: 8 }} type="email" placeholder="Email" value={f.email} onChange={e => setF(s => ({ ...s, email: e.target.value }))} />
          {err && <div role="alert" className="notice err small" style={{ marginTop: 8 }}>{err}</div>}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary small" disabled={busy} onClick={submit}>{busy ? 'Inviting…' : 'Send invite'}</button>
            <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

/* The borrower's live chat with their loan team. A file has exactly one
   borrower-visible conversation — resolve it, then render the full thread
   (typing indicators, online presence, read receipts, replies, drafts). */
function BorrowerChat({ appId }) {
  const { actor } = useAuth();
  const [conv, setConv] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.conversations(appId)
      .then(r => setConv((r.conversations || [])[0] || false))
      .catch(e => setErr(e.message));
  }, [appId]);
  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (conv === false) return <p className="muted small">Your conversation will appear here once your loan team opens it.</p>;
  if (!conv) return <p className="muted small">Loading your conversation…</p>;
  return (
    <ChatThread conversationId={conv.id} surface="borrower"
      me={{ kind: 'borrower', id: actor?.id }} height="60vh"
      onOpenApplication={(aid) => { window.location.hash = '#/app/' + aid; }} />
  );
}
