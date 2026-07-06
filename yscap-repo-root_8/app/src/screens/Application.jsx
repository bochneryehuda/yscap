import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import MessageThread from '../components/MessageThread.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import StatusTimeline from '../components/StatusTimeline.jsx';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import ToolModal from '../components/ToolModal.jsx';
import LlcPicker from '../components/LlcPicker.jsx';
import LlcManager from '../components/LlcManager.jsx';

const kb = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
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
  const [f, setF] = useState({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
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
      setF({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
      setOpen(false); await onSaved();
    } catch (e) { setFormErr(e.message || 'Could not save the card'); }
    finally { setBusy(false); }
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
      {formErr && <div className="notice err" style={{ marginBottom: 8 }}>{formErr}</div>}
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
      <button className="btn primary" onClick={submit} disabled={busy || !digits || !f.expMonth || !f.expYear || !f.cvc || !f.zip}>
        {busy ? 'Saving…' : 'Save & submit'}
      </button>
    </ConditionRow>
  );
}

/* One row in the conditions list: dot + title + status pill + right action,
   with optional expandable body. Every condition on the file renders through
   this so the whole section reads as one uniform list. */
function ConditionRow({ done, issue, title, subtitle, status, action, children, open }) {
  return (
    <div className="checkitem" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
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
    </div>
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
  useEffect(() => { api.contacts(meta.type).then(setSaved).catch(() => {}); }, [meta.type]);
  const useSaved = (c) => { setContactId(c.id); setF({ companyName: c.company_name || '', contactName: c.contact_name || '', email: c.email || '', phone: c.phone || '' }); };
  async function submit() {
    setBusy(true);
    try {
      await api.saveContact({ contactType: meta.type, contactId, ...f, applicationId: appId, checklistItemId: it.id });
      setOpen(false); await onSaved();
    } catch (e) { alert(e.message || 'Could not save'); }
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
        {err && <div className="notice err" style={{ marginBottom: 6 }}>{err}</div>}
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
      <LlcManager llcId={app.llc_id} onChanged={onChanged} />
    </ConditionRow>
  );
}

export default function Application() {
  const { id } = useParams();
  const [app, setApp] = useState(null);
  const [items, setItems] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [conds, setConds] = useState([]);
  const [profile, setProfile] = useState(null);
  const [dlBusy, setDlBusy] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);
  const [target, setTarget] = useState(null);   // {itemId, slot, replaceDocumentId, photoId}
  const [docFilter, setDocFilter] = useState('all');
  const [trBusy, setTrBusy] = useState(false);
  const [sowOpen, setSowOpen] = useState(false);

  const activityFetcher = useCallback(() => api.activity(id), [id]);
  const idRef = useRef(id); idRef.current = id;
  const load = () => {
    const forId = id;   // drop late responses after navigating to another file
    return Promise.all([
      api.application(id), api.checklist(id), api.documents(id).catch(() => []),
      api.conditions(id).catch(() => []), api.profile().catch(() => null),
    ]).then(([a, c, d, cn, p]) => {
      if (idRef.current !== forId) return;
      setApp(a); setItems(c || []); setUploads(d || []); setConds(cn || []); setProfile(p);
    }).catch(e => { if (idRef.current === forId) setErr(e.message); });
  };

  async function downloadDoc(doc) {
    setDlBusy(doc.id);
    try { const { blob, filename } = await api.downloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }
  useEffect(() => {
    // React Router reuses this mounted component across /app/:id changes
    // (mention chips, notification deep-links). Clear the previous file's data
    // first or the old loan renders under the new URL until the fetch lands.
    setApp(null); setItems([]); setUploads([]); setConds([]); setErr(''); setMsg('');
    setSowOpen(false); setTarget(null);   // else the Scope-of-Work modal carries over to the next file
    load();
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

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !target) return;
    setMsg('Uploading…');
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
      });
      const dataBase64 = String(dataUrl).split(',')[1];
      if (target.photoId) {
        // The government-ID condition saves to the PROFILE too, so the next
        // file's ID condition is fulfilled automatically.
        await api.uploadPhotoId({ applicationId: id, filename: file.name, contentType: file.type, dataBase64 });
      } else {
        await api.uploadDoc({
          applicationId: id, checklistItemId: target.itemId || undefined,
          slot: target.slot || undefined, replaceDocumentId: target.replaceDocumentId || undefined,
          filename: file.name, contentType: file.type, size: file.size, dataBase64,
        });
      }
      setMsg('Uploaded ✓'); setTarget(null); await load();
      setTimeout(() => setMsg(''), 2500);
    } catch (e2) { setMsg(''); setErr(e2.message || 'Upload failed'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
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

  if (err && !app) return <div className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;

  // ---- carve the checklist into the ordered conditions list ----
  const sowItem = items.find(it => it.tool_key === 'rehab_budget');
  const trItem = items.find(it => it.tool_key === 'track_record');
  const ppItem = items.find(it => it.tool_key === 'product_pricing');
  const cardItem = items.find(it => it.tool_key === 'appraisal_card');
  const contactItems = items.filter(it => it.tool_key && CONTACT[it.tool_key]);
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
  const sowExports = sowItem ? currentDocsFor(sowItem.id).filter(d => d.doc_kind === 'rehab_budget_export') : [];
  const req = experienceRequirement(app);
  const trPayload = (trItem && trItem.tool_payload) || {};
  const trCounts = trPayload.counts || {};
  const hasReq = req.flips + req.holds + req.ground > 0;

  const nDone = items.filter(it => isDone(it.status)).length;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <Link to="/dashboard" className="btn link">← All loans</Link>
        <div className="spacer" />
        <span className={`pill ${app.status}`}>{LABEL[app.status] || app.status}</span>
      </div>
      <h1 style={{ marginBottom: 4 }}>{addrLine(app.property_address)}</h1>
      <p className="muted small" style={{ marginBottom: 20 }}>{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}</p>

      {msg && <div className="notice ok">{msg}</div>}
      {err && <div className="notice err">{err}</div>}

      <PropertyPhoto address={addrLine(app.property_address) !== '—' ? addrLine(app.property_address) : ''} />

      <div className="grid cols-2">
        <StatusTimeline appId={id} status={app.status} createdAt={app.created_at}
          expectedClosing={app.expected_closing} actualClosing={app.actual_closing} />
        <div className="panel" style={{ marginTop: 0 }}>
          <h3 style={{ marginBottom: 12 }}>Loan snapshot</h3>
          <div className="metrow"><span className="k">Officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}{app.team_online && <span title="Your loan team is online now" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3fb950', marginLeft: 8, verticalAlign: 'middle' }} />}</span></div>
          <div className="metrow"><span className="k">Purchase price</span><span className="v">{money(app.purchase_price)}</span></div>
          <div className="metrow"><span className="k">As-is value</span><span className="v">{money(app.as_is_value)}</span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab budget</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(app.loan_amount)}</span></div>
        </div>
      </div>

      <div id="product-studio"><ProductStudioPanel appId={id} app={app} onRegistered={load} mode="borrower" /></div>

      {/* ================= YOUR CONDITIONS — one list, everything the file needs ================= */}
      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
          <h3>Your conditions</h3>
          <div className="spacer" />
          <span className="muted small">{nDone}/{items.length} complete</span>
          <select className="input" style={{ maxWidth: 170 }} value={docFilter} onChange={e => setDocFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="todo">To do</option>
            <option value="review">In review</option>
            <option value="attention">Needs attention</option>
            <option value="done">Completed</option>
          </select>
        </div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Everything your loan team needs to move this file forward, in one place. Each condition can carry
          several documents — add them one per slot.
        </p>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
        {(() => {
          const bucket = (s) => s === 'issue' ? 'attention' : s === 'received' ? 'review' : (s === 'satisfied' || s === 'done') ? 'done' : 'todo';
          const show = (it) => docFilter === 'all' || bucket(it.status) === docFilter;
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
                  action={<button className="btn primary small" onClick={() => { const el = document.getElementById('product-studio'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
                    {app.registered_program ? 'Reprice / re-register' : 'Open Products & Pricing'}
                  </button>}
                />
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
                    {sowExports.map(d => (
                      <button key={d.id} className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                        {dlBusy === d.id ? '…' : `⤓ ${/xlsx|sheet/i.test(d.content_type || d.filename) ? 'Excel export' : /html/i.test(d.content_type || d.filename) ? 'Editable HTML copy' : 'PDF export'}`}
                      </button>
                    ))}
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
                    ? `This file asks for ${[req.flips ? `${trCounts.flips ?? 0}/${req.flips} flips` : '', req.holds ? `${trCounts.holds ?? 0}/${req.holds} holds` : '', req.ground ? `${trCounts.ground ?? 0}/${req.ground} ground-up` : ''].filter(Boolean).join(', ')} — your track record is one record, shared by every file.`
                    : 'Document your completed deals once — your track record is one record, shared by every file.'}
                  status={statusText(trItem)}
                  action={
                    <span className="row" style={{ gap: 6 }}>
                      <Link className="btn primary small" to="/track-record">Open Track Record</Link>
                      {!isDone(trItem.status) && <button className="btn ghost small" disabled={trBusy} onClick={() => submitTrackRecord(trItem)}>{trBusy ? '…' : 'Submit for this file'}</button>}
                    </span>
                  }
                />
              )}

              {/* 3 — The vesting LLC: linked entity's state drives this condition */}
              {llcItem && show(llcItem) && <LlcCondition it={llcItem} app={app} onChanged={load} />}

              {/* 4 — Company contacts (title / insurance) + appraisal card */}
              {contactItems.filter(show).map(it => <ContactCondition key={it.id} it={it} appId={id} onSaved={load} />)}
              {cardItem && show(cardItem) && <CardCondition it={cardItem} appId={id} onSaved={load} />}

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
                />
              )}

              {/* 4b — Assets & liquidity: once a product is registered, the
                  registered requirement replaces the generic asset condition */}
              {assetsItem && show(assetsItem) && (() => {
                const docs = currentDocsFor(assetsItem.id);
                const q = registeredQuote;
                const liq = q && (q.liquidity ?? q.liquidityRequired);
                const nextSlot = `Document ${docs.length + 1}`;
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
                    open={docs.length > 0 || assetsItem.status === 'issue'}
                    action={<button className="btn link small" onClick={() => pick({ itemId: assetsItem.id, slot: docs.length ? nextSlot : 'Document 1' })}>{docs.length ? '+ Add another' : 'Upload statements'}</button>}
                  >
                    {assetsItem.status === 'issue' && assetsItem.rejection_reason && (
                      <div className="small" style={{ color: 'var(--danger)', marginBottom: 6 }}>
                        Needs a new version: {assetsItem.rejection_reason}
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
                const nextSlot = `Document ${docs.length + 1}`;
                return (
                  <ConditionRow
                    key={it.id}
                    done={isDone(it.status)}
                    issue={needsFix}
                    title={it.label}
                    subtitle={[it.hint, it.notes].filter(Boolean).join(' · ') || null}
                    status={statusText(it)}
                    open={docs.length > 0 || needsFix}
                    action={<button className="btn link small" onClick={() => pick({ itemId: it.id, slot: docs.length ? nextSlot : 'Document 1' })}>{docs.length ? '+ Add another' : 'Upload'}</button>}
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
                        <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>{dlBusy === d.id ? '…' : '⤓'}</button>
                      </div>
                    ))}
                  </ConditionRow>
                );
              })}

              {/* 6 — anything else your loan team flagged (read-only) */}
              {conds.length > 0 && conds.map(c => (
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

      {uploads.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
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
            <div className="checkitem" key={d.id} style={{ opacity: d.is_current === false ? .6 : 1 }}>
              <span className={`dot ${rs === 'accepted' ? 'done' : 'outstanding'}`} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{d.filename}</div>
                <div className="muted small">{kb(d.size_bytes)}{d.slot_label ? ` · ${d.slot_label}` : ''} · {new Date(d.created_at).toLocaleDateString()}</div>
                {rs === 'rejected' && d.rejection_reason && <div className="small" style={{ color: 'var(--danger)' }}>{d.rejection_reason}</div>}
              </div>
              <span className="pill" style={style}>{label}</span>
              <button className="btn ghost" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                {dlBusy === d.id ? '…' : 'Download'}
              </button>
            </div>
            );
          })}
        </div>
      )}

      {/* Keyed by file id: this component survives /app/:id navigation, and
          without the key the previous file's thread kept showing. */}
      <MessageThread key={id} mine="borrower" title="Messages with your loan team"
        fetchMessages={() => api.messages(id)}
        send={(body, opts) => api.postMessage(id, body, { attachment: opts?.attachment, entityRefs: opts?.entityRefs })}
        downloadAttachment={(docId) => api.downloadDoc(docId)}
        react={(mid, emoji) => api.react(mid, emoji)}
        edit={(mid, body) => api.editMessage(mid, body)}
        del={(mid) => api.deleteMessage(mid)}
        fetchMentionables={() => api.mentionables(id)}
        onOpenApplication={(aid) => { window.location.hash = '#/app/' + aid; }} />

      <ActivityFeed fetcher={activityFetcher} />

      {sowOpen && sowItem && (
        <ToolModal
          title="Rehab Budget — Scope of Work"
          url={sowUrl(id, sowItem, app)}
          onClose={() => { setSowOpen(false); load(); }} />
      )}
    </>
  );
}
