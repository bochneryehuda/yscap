import React, { useCallback, useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { PhoneInput, EmailInput } from './FormattedInputs.jsx';
import EmailCenter from './EmailCenter.jsx';

/* ════════════════════════════════════════════════════════════════════════════
   ORDERS DESK (#orders) — order TITLE and INSURANCE for a file, and track each
   one separately. An order can only be sent once the file has its LOAN NUMBER
   (it prints in the mortgage clause) and the right vendor CONTACT (title company
   / insurance agent). Entering the contact here is the SAME entry that fills the
   file's title / insurance contact condition — so the two are always in lock-step.
   The order emails the vendor with the borrower, loan officer and processor CC'd
   and a unique reply-to, so replies + returned documents come back to the right
   order. Follow-up is a separate button (never part of the first email). Each
   order has its own Gmail-style thread (the embedded Email Center, scoped).
   ════════════════════════════════════════════════════════════════════════════ */

const KB = (n) => (n == null ? '' : n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
const STATUS_LABEL = {
  not_ordered: 'Not ordered', ordered: 'Ordered', documents_in: 'Documents in',
  completed: 'Completed', cancelled: 'Cancelled',
};
const STATUS_TONE = {
  not_ordered: { borderColor: 'var(--gold)', color: 'var(--gold)' },
  ordered: { borderColor: 'var(--teal, #2F7F86)', color: 'var(--teal, #2F7F86)' },
  documents_in: { borderColor: 'var(--teal, #2F7F86)', color: 'var(--teal, #2F7F86)' },
  completed: { borderColor: 'var(--ok)', color: 'var(--ok)' },
  cancelled: { opacity: 0.6 },
};
const KIND_LABEL = { title: 'Title', insurance: 'Insurance' };
const CONTACT_TYPE = { title: 'title_company', insurance: 'insurance_agent' };
const CONTACT_ASK = { title: 'title company', insurance: 'insurance agent' };

function when(ts) { return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }

/* Inline contact entry — the same POST that fills the title / insurance condition. */
function ContactForm({ appId, kind, onSaved, onCancel }) {
  const [f, setF] = useState({ companyName: '', contactName: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail.'); return; }
    if (!f.email) { setErr('An email is required to send the order.'); return; }
    setBusy(true);
    try {
      await api.staffAddFileContact(appId, { contactType: CONTACT_TYPE[kind], ...f });
      onSaved && onSaved();
    } catch (e) { setErr((e && e.message) || 'Could not save the contact.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel" style={{ background: 'var(--surface-soft, var(--ink-2))', marginTop: 8 }}>
      <div className="muted small" style={{ marginBottom: 6 }}>
        Add the {CONTACT_ASK[kind]} — this also fills the file's {CONTACT_ASK[kind]} condition.
      </div>
      <div className="grid cols-2" style={{ gap: 8 }}>
        <div><label className="muted small">Company</label><input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
        <div><label className="muted small">Contact name</label><input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
        <div><label className="muted small">Email</label><EmailInput value={f.email} onChange={v => setF({ ...f, email: v })} /></div>
        <div><label className="muted small">Phone</label><PhoneInput value={f.phone} onChange={v => setF({ ...f, phone: v })} /></div>
      </div>
      {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save contact'}</button>
        <button className="btn ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* The loan-number gate — shown when the file has no YS loan number yet. */
function LoanNumberEntry({ appId, onSaved }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    if (!v.trim()) { setErr('Enter the loan number.'); return; }
    setBusy(true);
    try { await api.staffSetLoanNumber(appId, v.trim()); onSaved && onSaved(); }
    catch (e) { setErr((e && e.message) || 'Could not save the loan number.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel" style={{ background: 'var(--paper,#f6f3ec)', marginBottom: 14 }}>
      <b>Add the loan number to place orders.</b>
      <div className="muted small" style={{ margin: '3px 0 8px' }}>
        The loan number prints in the mortgage clause on every order, so it's required before Title or Insurance can be ordered.
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div><label className="muted small">Loan number</label><input className="input" placeholder="YSCAP…" value={v} onChange={e => setV(e.target.value.toUpperCase())} /></div>
        <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save loan number'}</button>
      </div>
      {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

/* One returned document row — classify (assign a slot), accept/reject + download. */
function ReturnedDoc({ appId, kind, doc, slots, canAccept, onChanged }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const classify = async (slot) => {
    setBusy('slot'); setErr('');
    try { await api.staffClassifyOrderDoc(appId, kind, doc.id, slot); onChanged && onChanged(); }
    catch (e) { setErr((e && e.message) || 'Could not classify.'); }
    finally { setBusy(''); }
  };
  const download = async () => {
    setBusy('dl');
    try { const { blob, filename } = await api.staffDownloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (_) { /* ignore */ }
    finally { setBusy(''); }
  };
  const review = async (action) => {
    if (action === 'accept' && !doc.slot_label && !window.confirm('Accept this document without assigning a type (binder / invoice / …)? You can assign it first.')) return;
    let reason;
    if (action === 'reject') { reason = window.prompt('Why is this document being rejected? (the reason is recorded)'); if (!reason) return; }
    setBusy('review'); setErr('');
    try { await api.staffReviewDoc(doc.id, action, reason); onChanged && onChanged(); }
    catch (e) { setErr((e && e.message) || 'Could not update.'); }
    finally { setBusy(''); }
  };
  const unassigned = !doc.slot_label;
  const rs = doc.review_status || 'pending';
  const rsTone = rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' }
    : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : { opacity: 0.7 };
  return (
    <div className="checkitem" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <span className="dot" style={{ marginTop: 0 }} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 600 }}>{doc.filename}</div>
        <div className="muted small">{KB(doc.size_bytes)} · {new Date(doc.created_at).toLocaleDateString()}</div>
        {err && <div className="small" style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>
      <span className="pill" style={unassigned ? { borderColor: 'var(--gold)', color: 'var(--gold)' } : { borderColor: 'var(--teal,#2F7F86)', color: 'var(--teal,#2F7F86)' }}>
        {unassigned ? 'Unassigned' : doc.slot_label}
      </span>
      <span className="pill" style={rsTone}>{rs}</span>
      <select className="input" style={{ width: 'auto' }} disabled={!!busy} value={doc.slot_label || ''} onChange={e => classify(e.target.value)} title="Assign a document type">
        <option value="">Unassigned…</option>
        {slots.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <button className="btn ghost small" disabled={!!busy} onClick={download}>Download</button>
      {rs !== 'accepted' && canAccept && <button className="btn primary small" disabled={!!busy} onClick={() => review('accept')}>Accept</button>}
      {rs !== 'rejected' && <button className="btn ghost small" disabled={!!busy} onClick={() => review('reject')}>Reject</button>}
    </div>
  );
}

/* One order card (Title or Insurance). */
function OrderCard({ appId, kind, order, file, canAccept, onChanged }) {
  const [addingContact, setAddingContact] = useState(false);
  const [showThread, setShowThread] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [followMsg, setFollowMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const blockers = order.blockers || [];
  const needsLoan = blockers.includes('loan_number');
  const needsContact = blockers.includes('contact');
  const placed = order.status !== 'not_ordered' && order.status !== 'cancelled';
  const recips = order.recipients || { to: [], cc: [] };

  const cancel = async (reopen) => {
    if (!reopen && !window.confirm(`Cancel the ${kind} order? It won't email anyone; you can re-order afterward.`)) return;
    setBusy('cancel'); setMsg(null);
    try { await api.staffCancelOrder(appId, kind, reopen); onChanged && onChanged(); }
    catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not update the order.' }); }
    finally { setBusy(''); }
  };

  const place = async (force) => {
    setBusy('place'); setMsg(null);
    try {
      const r = await api.staffPlaceOrder(appId, kind, force ? { force: true } : {});
      setMsg({ tone: 'ok', text: `${KIND_LABEL[kind]} order sent to ${(r.sent_to || []).join(', ')}${r.cc && r.cc.length ? ` (cc ${r.cc.length})` : ''}.` });
      onChanged && onChanged();
    } catch (e) {
      if (e && e.status === 409) setMsg({ tone: 'warn', text: `${KIND_LABEL[kind]} was already ordered. Use Follow-up, or force a re-send below.`, canForce: true });
      else setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the order.' });
    } finally { setBusy(''); }
  };
  const followup = async () => {
    setBusy('follow'); setMsg(null);
    try {
      const r = await api.staffOrderFollowup(appId, kind, { message: followMsg });
      setMsg({ tone: 'ok', text: `Follow-up sent to ${(r.sent_to || []).join(', ')}.` });
      setFollowMsg(''); setFollowOpen(false); onChanged && onChanged();
    } catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the follow-up.' }); }
    finally { setBusy(''); }
  };

  const unassignedCount = (order.returnedDocs || []).filter(d => !d.slot_label).length;

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>{KIND_LABEL[kind]} order</h3>
        <span className="pill" style={STATUS_TONE[order.status] || {}}>{STATUS_LABEL[order.status] || order.status}</span>
        {order.followupCount > 0 && <span className="muted small">· {order.followupCount} follow-up{order.followupCount === 1 ? '' : 's'}</span>}
        <div className="spacer" />
        {(order.returnedDocs || []).length > 0 && (
          <span className="muted small">{(order.returnedDocs || []).length} doc{(order.returnedDocs || []).length === 1 ? '' : 's'} back{unassignedCount ? ` · ${unassignedCount} to assign` : ''}</span>
        )}
      </div>

      {/* Vendor / contact */}
      {order.vendor
        ? <div className="muted small" style={{ marginBottom: 6 }}>
            To: <b style={{ color: 'var(--ink,#141B22)' }}>{order.vendor.name || order.vendor.email}</b>{order.vendor.email ? ` · ${order.vendor.email}` : ''}{order.vendor.phone ? ` · ${order.vendor.phone}` : ''}
          </div>
        : <div className="muted small" style={{ marginBottom: 6 }}>
            No {CONTACT_ASK[kind]} on the file yet — add one below to order.
          </div>}
      {addingContact && <ContactForm appId={appId} kind={kind} onSaved={() => { setAddingContact(false); onChanged && onChanged(); }} onCancel={() => setAddingContact(false)} />}

      {/* Who this order reaches — shown before you send so there are no surprises. */}
      {(recips.to.length > 0 || recips.cc.length > 0) && (
        <div className="muted small" style={{ marginBottom: 6 }}>
          <button className="btn link small" style={{ padding: 0 }} onClick={() => setShowRecipients(s => !s)}>
            {showRecipients ? 'Hide' : 'Show'} who gets this email
          </button>
          {showRecipients && (
            <div style={{ marginTop: 4 }}>
              <div><b>To:</b> {recips.to.join(', ') || '—'}</div>
              <div><b>Cc:</b> {recips.cc.join(', ') || '—'} <span className="muted">(visible to everyone)</span></div>
              <div className="muted">Replies + returned documents come back to this order automatically.</div>
            </div>
          )}
        </div>
      )}

      {order.condition && <div className="muted small" style={{ marginBottom: 6 }}>Documents file into the <b style={{ color: 'var(--ink,#141B22)' }}>{order.condition.label}</b> condition{order.condition.status ? ` (${order.condition.status})` : ''}.</div>}

      {order.orderedAt && <div className="muted small" style={{ marginBottom: 6 }}>Ordered {when(order.orderedAt)}{order.lastFollowupAt ? ` · last follow-up ${when(order.lastFollowupAt)}` : ''}</div>}

      {/* Before you can order: show EXACTLY what's still needed, each with a
          visible action — never a silently greyed-out button (a loan officer read
          the disabled "Order" as "I'm not allowed to order it"). */}
      {!placed && (needsLoan || needsContact) && (
        <div className="notice" style={{ marginTop: 6, marginBottom: 2, background: 'var(--surface-soft, #fbf7ee)', borderColor: 'var(--gold,#AE8746)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>To send this {kind} order, first:</div>
          <ul style={{ margin: '0 0 2px 18px', padding: 0 }}>
            {needsContact && (
              <li style={{ marginBottom: 4 }}>
                Add the {CONTACT_ASK[kind]} (who to email).{' '}
                {!addingContact && <button className="btn primary small" onClick={() => setAddingContact(true)}>Add {CONTACT_ASK[kind]}</button>}
              </li>
            )}
            {needsLoan && (
              <li>Add the file’s loan number — the box at the top of this section (it prints in the mortgage clause).</li>
            )}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {!placed && (
          <button className="btn primary small" disabled={!!busy || needsLoan || needsContact} onClick={() => place(false)}
            title={needsLoan ? 'Add the loan number first' : needsContact ? `Add the ${CONTACT_ASK[kind]} first` : `Send the ${kind} order to the vendor`}>
            {busy === 'place' ? 'Sending…' : `Order ${kind}`}
          </button>
        )}
        {!placed && !needsLoan && !needsContact && (
          <span className="muted small" style={{ alignSelf: 'center' }}>Emails the {CONTACT_ASK[kind]}, cc’ing the borrower, loan officer and processor.</span>
        )}
        {placed && (
          <>
            <button className="btn primary small" disabled={!!busy} onClick={() => setFollowOpen(o => !o)}>Follow up</button>
            <button className="btn ghost small" disabled={!!busy || needsContact} onClick={() => place(true)} title="Re-send the full order to the vendor + CC chain">
              {busy === 'place' ? 'Sending…' : 'Re-send order'}
            </button>
            <button className="btn ghost small" disabled={!!busy} style={{ color: 'var(--danger)' }} onClick={() => cancel(false)} title="Cancel this order (no email is sent)">Cancel order</button>
          </>
        )}
        {order.status === 'cancelled' && (
          <button className="btn ghost small" disabled={!!busy} onClick={() => cancel(true)} title="Reopen without re-sending">Reopen order</button>
        )}
        {((order.returnedDocs || []).length > 0 || placed) && (
          <button className="btn ghost small" onClick={() => setShowThread(s => !s)}>{showThread ? 'Hide' : 'Open'} {kind} email thread</button>
        )}
      </div>

      {followOpen && (
        <div className="panel" style={{ background: 'var(--surface-soft, var(--ink-2))', marginTop: 10 }}>
          <label className="muted small">Follow-up message (optional — a default is sent if blank)</label>
          <textarea className="input" rows={3} value={followMsg} onChange={e => setFollowMsg(e.target.value)}
            placeholder={kind === 'title' ? 'Following up on the title order…' : 'Following up on the insurance quote…'} />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary small" disabled={busy === 'follow'} onClick={followup}>{busy === 'follow' ? 'Sending…' : 'Send follow-up'}</button>
            <button className="btn ghost small" onClick={() => { setFollowOpen(false); setFollowMsg(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {msg && (
        <div className={`notice ${msg.tone === 'ok' ? 'ok' : msg.tone === 'warn' ? '' : 'err'}`} style={{ marginTop: 10 }} role="status">
          {msg.text}
          {msg.canForce && <> <button className="btn link small" onClick={() => place(true)}>Force re-send</button></>}
        </div>
      )}

      {/* Returned documents */}
      {(order.returnedDocs || []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted small" style={{ marginBottom: 4, fontWeight: 600 }}>Documents returned by the {CONTACT_ASK[kind]}</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {order.returnedDocs.map(d => (
              <ReturnedDoc key={d.id} appId={appId} kind={kind} doc={d} slots={order.slots || []} canAccept={canAccept} onChanged={onChanged} />
            ))}
          </div>
        </div>
      )}

      {/* Per-order email thread (Gmail-style, scoped to this order) */}
      {showThread && (
        <div style={{ marginTop: 12 }}>
          <EmailCenter mode="file" appId={appId} scope={kind} />
        </div>
      )}
    </div>
  );
}

export default function OrdersPanel({ appId, canAccept = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    api.staffOrders(appId).then(setData).catch(e => setErr((e && e.message) || 'Could not load orders.'));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="notice err">{err}</div>;
  if (!data) return <p className="muted small">Loading orders…</p>;

  return (
    <div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Order title and insurance from here. Each order emails the vendor with the borrower, loan officer and processor copied,
        and comes back to its own thread — the documents they send back land below for you to classify.
      </p>
      {!data.file.hasLoanNumber && <LoanNumberEntry appId={appId} onSaved={load} />}
      <div style={{ display: 'grid', gap: 14 }}>
        <OrderCard appId={appId} kind="title" order={data.orders.title} file={data.file} canAccept={canAccept} onChanged={load} />
        <OrderCard appId={appId} kind="insurance" order={data.orders.insurance} file={data.file} canAccept={canAccept} onChanged={load} />
      </div>
    </div>
  );
}
