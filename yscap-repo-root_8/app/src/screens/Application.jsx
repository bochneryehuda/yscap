import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import MessageThread from '../components/MessageThread.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';

const kb = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const FLOW = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded'];
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded' };

// Borrower-facing tools that satisfy a checklist task. The vanilla tools live in
// the static bundle at /tools/… — we launch them, not rebuild them.
const TOOLS = {
  rehab_budget: { name: 'Rehab Budget', url: '/tools/rehab-budget.html', blurb: 'Build your construction budget and Scope of Work, then export it.' },
  track_record: { name: 'Track Record', url: '/tools/track-record.html', blurb: 'Enter your prior deals (REO / experience): LLC, address, price, dates.' },
};
// Contact tasks are FORMS, not uploads: the borrower enters their title / insurance
// contact and it saves to a reusable contact book (autocompletes on future files).
const CONTACT = {
  title_contact:     { type: 'title_company',  name: 'Title company', blurb: 'Enter your title company contact — no upload needed.' },
  insurance_contact: { type: 'insurance_agent', name: 'Insurance agent', blurb: 'Enter your insurance agent contact — no upload needed.' },
};
const isDone = (s) => s === 'received' || s === 'satisfied' || s === 'done';

// Inline contact form that satisfies a title/insurance checklist task. Suggests
// the borrower's previously-used contacts of the same type as they type.
function ContactTask({ it, appId, onSaved }) {
  const meta = CONTACT[it.tool_key];
  const done = isDone(it.status);
  const [saved, setSaved] = useState([]);
  const [f, setF] = useState({ companyName: '', contactName: '', email: '', phone: '' });
  const [contactId, setContactId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!done);
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
    <div className="checkitem" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ width: '100%', gap: 8 }}>
        <span className={`dot ${done ? 'done' : 'outstanding'}`} style={{ marginTop: 4 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{it.label}</div>
          <div className="muted small">{meta.blurb}</div>
        </div>
        <span className="muted small" style={{ textTransform: 'capitalize' }}>{done ? 'Submitted' : (it.status || 'to do')}</span>
        {done && <button className="btn link small" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Edit'}</button>}
      </div>
      {open && (
        <div style={{ width: '100%' }}>
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
          <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Submit to YS'}</button>
        </div>
      )}
    </div>
  );
}

// Compose a one-line address from the application's property_address jsonb.
const oneLineAddr = (a) => !a ? '' : (a.oneLine || [a.street, a.line1, a.city, a.state, a.zip].filter(Boolean).join(', '));

// Build the launch URL for a borrower tool, carrying over what the file already
// knows so the borrower doesn't retype it. The Rehab Budget / Scope of Work is
// for THIS property, so we pass the application's address. Track Record is a log
// of OTHER, prior deals, so we deliberately pass no address there.
function toolLaunchUrl(toolKey, app) {
  const base = TOOLS[toolKey].url;
  if (toolKey !== 'rehab_budget') return base;
  const p = new URLSearchParams();
  const addr = oneLineAddr(app.property_address);
  if (addr) p.set('address', addr);
  if (app.units > 0) p.set('units', String(app.units));
  if (app.loan_type && /refi/i.test(app.loan_type)) p.set('txn', 'refi');
  else if (app.loan_type && /purchase/i.test(app.loan_type)) p.set('txn', 'purchase');
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

export default function Application() {
  const { id } = useParams();
  const [app, setApp] = useState(null);
  const [items, setItems] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [dlBusy, setDlBusy] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);
  const [target, setTarget] = useState(null);

  const load = () => Promise.all([api.application(id), api.checklist(id), api.documents(id).catch(() => [])])
    .then(([a, c, d]) => { setApp(a); setItems(c || []); setUploads(d || []); }).catch(e => setErr(e.message));

  async function downloadDoc(doc) {
    setDlBusy(doc.id);
    try { const { blob, filename } = await api.downloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setMsg('Uploading…');
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
      });
      // The server stores raw base64 (dataBase64), not the full data: URL.
      await api.uploadDoc({
        applicationId: id, checklistItemId: target || undefined,
        filename: file.name, contentType: file.type, size: file.size,
        dataBase64: String(dataUrl).split(',')[1],
      });
      setMsg('Uploaded ✓'); setTarget(null); await load();
      setTimeout(() => setMsg(''), 2500);
    } catch (e2) { setMsg(''); setErr(e2.message || 'Upload failed'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
  const pick = (itemId) => { setTarget(itemId || null); fileRef.current && fileRef.current.click(); };

  async function markToolDone(it) {
    setMsg('Saving…');
    try {
      await api.completeTool(id, it.id, { tool: it.tool_key, completedAt: new Date().toISOString() });
      setMsg('Marked complete ✓ — your coordinator will review it.');
      await load(); setTimeout(() => setMsg(''), 3000);
    } catch (e) { setMsg(''); setErr(e.message || 'Could not save'); }
  }

  if (err) return <div className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;
  const idx = Math.max(0, FLOW.indexOf(app.status));

  const toolTasks = items.filter(it => it.tool_key && TOOLS[it.tool_key]);
  const contactTasks = items.filter(it => it.tool_key && CONTACT[it.tool_key]);
  const docs = items.filter(it => !(it.tool_key && (TOOLS[it.tool_key] || CONTACT[it.tool_key])));

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

      <PropertyPhoto address={addrLine(app.property_address) !== '—' ? addrLine(app.property_address) : ''} />

      <div className="grid cols-2">
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Status</h3>
          <ul className="timeline">
            {FLOW.map((s, i) => (
              <li key={s} className={i <= idx ? 'on' : ''}>{LABEL[s]}</li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Loan snapshot</h3>
          <div className="metrow"><span className="k">Officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}</span></div>
          <div className="metrow"><span className="k">Purchase price</span><span className="v">{money(app.purchase_price)}</span></div>
          <div className="metrow"><span className="k">As-is value</span><span className="v">{money(app.as_is_value)}</span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab budget</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(app.loan_amount)}</span></div>
        </div>
      </div>

      {toolTasks.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 4 }}>Your tasks to complete</h3>
          <p className="muted small" style={{ marginBottom: 12 }}>
            These are part of your file. Open each tool, complete and export it, then mark it done —
            your coordinator verifies and signs off.
          </p>
          {toolTasks.map(it => {
            const t = TOOLS[it.tool_key]; const done = isDone(it.status) || it.tool_submitted;
            return (
              <div className="checkitem" key={it.id} style={{ alignItems: 'flex-start' }}>
                <span className={`dot ${done ? 'done' : 'outstanding'}`} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{it.label}</div>
                  <div className="muted small">{t.blurb}{it.hint ? ` · ${it.hint}` : ''}</div>
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <a className="btn" href={toolLaunchUrl(it.tool_key, app)} target="_blank" rel="noopener noreferrer">Open {t.name} ↗</a>
                    {!done && <button className="btn ghost" onClick={() => markToolDone(it)}>Mark complete</button>}
                    {!done && <button className="btn link" onClick={() => pick(it.id)}>Attach export</button>}
                  </div>
                </div>
                <span className="muted small" style={{ textTransform: 'capitalize' }}>
                  {done ? 'Submitted' : (it.status || 'to do')}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {contactTasks.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 4 }}>Your contacts</h3>
          <p className="muted small" style={{ marginBottom: 12 }}>
            Enter your title company and insurance agent — we save them so you never re-type them on your next file.
          </p>
          {contactTasks.map(it => <ContactTask key={it.id} it={it} appId={id} onSaved={load} />)}
        </div>
      )}

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Documents &amp; conditions</h3>
          <div className="spacer" />
          <button className="btn ghost" onClick={() => pick(null)}>Upload a document</button>
        </div>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
        {docs.length === 0
          ? <p className="muted small">No items requested yet. Your coordinator will post your checklist here.</p>
          : docs.map(it => {
            const needsFix = it.status === 'issue';
            return (
            <div className="checkitem" key={it.id} style={{ alignItems: 'flex-start' }}>
              <span className={`dot ${isDone(it.status) ? 'done' : 'outstanding'}`} style={{ marginTop: 4 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{it.label}</div>
                <div className="muted small">{it.item_kind}{it.hint ? ` · ${it.hint}` : ''}{it.notes ? ` · ${it.notes}` : ''}</div>
                {needsFix && it.rejection_reason && (
                  <div className="small" style={{ color: 'var(--danger)', marginTop: 3 }}>
                    Needs a new version: {it.rejection_reason}
                  </div>
                )}
              </div>
              <span className="muted small" style={{ textTransform: 'capitalize' }}>
                {needsFix ? 'Needs attention' : it.status === 'received' ? 'In review' : it.status || 'outstanding'}
              </span>
              <button className="btn link" onClick={() => pick(it.id)}>{needsFix ? 'Re-upload' : 'Upload'}</button>
            </div>
            );
          })}
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
                <div className="muted small">{kb(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString()}</div>
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

      <MessageThread mine="borrower" title="Messages with your loan team"
        fetchMessages={() => api.messages(id)}
        send={(body, opts) => api.postMessage(id, body, { attachment: opts?.attachment, entityRefs: opts?.entityRefs })}
        downloadAttachment={(docId) => api.downloadDoc(docId)}
        react={(mid, emoji) => api.react(mid, emoji)}
        fetchMentionables={() => api.mentionables(id)}
        onOpenApplication={(aid) => { window.location.hash = '#/app/' + aid; }} />
    </>
  );
}
