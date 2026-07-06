import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import MessageThread from '../components/MessageThread.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import StatusTimeline from '../components/StatusTimeline.jsx';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import ToolModal from '../components/ToolModal.jsx';

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
// file: it autosaves onto the condition and Submit attaches PDF+Excel exports.
function sowUrl(appId, item, app) {
  const p = new URLSearchParams({ app: appId, item: item.id });
  const addr = oneLineAddr(app.property_address);
  if (addr) p.set('address', addr);
  if (app.units > 0) p.set('units', String(app.units));
  if (app.loan_type && /refi/i.test(app.loan_type)) p.set('txn', 'refi');
  else if (app.loan_type && /purchase/i.test(app.loan_type)) p.set('txn', 'purchase');
  return `/tools/rehab-budget.html?${p.toString()}`;
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
    load();
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
  const contactItems = items.filter(it => it.tool_key && CONTACT[it.tool_key]);
  const idItem = items.find(it => it.template_code === 'rtl_p1_id');
  const usedIds = new Set([sowItem, trItem, idItem, ...contactItems].filter(Boolean).map(x => x.id));
  const docItems = items.filter(it => !usedIds.has(it.id) && !it.tool_key);

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

      <ProductStudioPanel appId={id} app={app} onRegistered={load} mode="borrower" />

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

              {/* 3 — Company contacts (title / insurance) */}
              {contactItems.filter(show).map(it => <ContactCondition key={it.id} it={it} appId={id} onSaved={load} />)}

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
