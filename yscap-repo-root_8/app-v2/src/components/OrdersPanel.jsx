import React, { useCallback, useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { PhoneInput, EmailInput } from './FormattedInputs.jsx';
import EmailCenter from './EmailCenter.jsx';
import ClosingPrepCard from './ClosingPrepCard.jsx';
import DocPreview from './DocPreview.jsx';

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

/* Has this order actually been placed? Mirrors the server's own live-order test
   (routes/orders + closing-prep.orderIsLive): anything other than "not ordered"
   or "cancelled" means it is out. Used only to decide which sub-section starts
   open, so an unreadable value simply reads as not placed — the safe direction,
   since an un-placed order is the one with work to do. */
function isPlaced(order) {
  const s = order && order.status;
  return !!s && s !== 'not_ordered' && s !== 'cancelled';
}

/* One of the three order types, as its own collapsible section (owner-directed
   2026-08-02). Native <details> for the same reason AppraisalPanel uses it: the
   browser owns the open/closed state, so nothing here can bounce the reader. */
function OrderSection({ label, open, children }) {
  return (
    <details className="panel" open={open} style={{ padding: 0 }}>
      <summary style={{
        cursor: 'pointer', padding: '12px 16px', fontWeight: 700,
        color: '#141B22', listStyle: 'revert',
      }}>{label}</summary>
      <div style={{ padding: '0 16px 16px' }}>{children}</div>
    </details>
  );
}
const CONTACT_TYPE = { title: 'title_company', insurance: 'insurance_agent' };
const CONTACT_ASK = { title: 'title company', insurance: 'insurance agent' };

function when(ts) { return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }

/* Inline contact entry — the same POST that fills the title / insurance condition,
   so entering the vendor HERE clears the file's contact condition at the same time
   and nobody has to go to the condition and come back (owner-directed 2026-08-03).
   `existing` (a file-contact link row) turns this into an EDIT of that contact
   rather than a second directory entry for the same company. */
function ContactForm({ appId, kind, existing, onSaved, onCancel }) {
  const [f, setF] = useState({
    companyName: (existing && existing.company_name) || '',
    contactName: (existing && existing.contact_name) || '',
    email: (existing && existing.email) || '',
    phone: (existing && existing.phone) || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail.'); return; }
    if (!f.email) { setErr('An email is required to send the order.'); return; }
    setBusy(true);
    try {
      if (existing && existing.link_id) await api.staffEditFileContact(existing.link_id, { contactType: CONTACT_TYPE[kind], ...f });
      else await api.staffAddFileContact(appId, { contactType: CONTACT_TYPE[kind], ...f });
      onSaved && onSaved();
    } catch (e) { setErr((e && e.message) || 'Could not save the contact.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel" style={{ background: 'var(--surface-soft, var(--ink-2))', marginTop: 8 }}>
      <div className="muted small" style={{ marginBottom: 6 }}>
        {existing ? 'Edit' : 'Add'} the {CONTACT_ASK[kind]} — this also fills the file's {CONTACT_ASK[kind]} condition,
        so you don't have to open the condition to enter it.
      </div>
      <div className="grid cols-2" style={{ gap: 8 }}>
        <div><label className="muted small">Company</label><input className="input" value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></div>
        <div><label className="muted small">Contact name</label><input className="input" value={f.contactName} onChange={e => setF({ ...f, contactName: e.target.value })} /></div>
        <div><label className="muted small">Email</label><EmailInput value={f.email} onChange={v => setF({ ...f, email: v })} /></div>
        <div><label className="muted small">Phone</label><PhoneInput value={f.phone} onChange={v => setF({ ...f, phone: v })} /></div>
      </div>
      {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : existing ? 'Save changes' : 'Save contact'}</button>
        <button className="btn ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* THE CONTACT SLOT — always on the order, never only when the order is blocked
   (owner-directed 2026-08-03: "within the insurance Order section you should have
   over there the slot and the button to put in the insurance contact information").
   It shows who the order will go to, and carries the Add / Edit button beside it,
   so the whole order can be completed without leaving this section. Editing needs
   the file-contact LINK id, which the orders payload does not carry — so the link
   list is fetched only when somebody actually opens the editor. */
function ContactSlot({ appId, kind, vendor, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const openEditor = async () => {
    setErr(''); setBusy(true);
    try {
      const rows = await api.staffFileContacts(appId);
      // The order uses the most-recently-used contact of this type, which is the
      // FIRST row the file-contacts list returns for it — match on the contact id
      // the orders payload already gave us so the editor can never open a
      // different company's row.
      const found = (rows || []).find((r) => String(r.contact_id) === String(vendor && vendor.id))
        || (rows || []).find((r) => r.contact_type === CONTACT_TYPE[kind]);
      if (!found) { setErr('Could not find that contact to edit — add it again instead.'); return; }
      setLink(found); setEditing(true);
    } catch (e) { setErr((e && e.message) || 'Could not load the contact.'); }
    finally { setBusy(false); }
  };

  const done = () => { setEditing(false); setAdding(false); setLink(null); onChanged && onChanged(); };

  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="muted small" style={{ minWidth: 120 }}>{kind === 'title' ? 'Title company' : 'Insurance agent'}</span>
        {vendor
          ? <span className="small" style={{ flex: 1, minWidth: 160, color: 'var(--ivory,#141B22)' }}>
              <b>{vendor.name || vendor.email}</b>
              {vendor.contactName && vendor.contactName !== vendor.name ? ` · ${vendor.contactName}` : ''}
              {vendor.email ? ` · ${vendor.email}` : ''}{vendor.phone ? ` · ${vendor.phone}` : ''}
            </span>
          : <span className="small muted" style={{ flex: 1, minWidth: 160 }}>
              Not on the file yet — the order needs somebody to send it to.
            </span>}
        {vendor
          ? <button className="btn ghost small" disabled={busy} onClick={openEditor}>{busy ? '…' : 'Edit contact'}</button>
          : <button className="btn primary small" onClick={() => setAdding(true)}>Add {CONTACT_ASK[kind]}</button>}
        {vendor && !editing && <button className="btn ghost small" onClick={() => setAdding(true)} title="Use a different company for this order">Use a different one</button>}
      </div>
      {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {(editing || adding) && (
        <ContactForm appId={appId} kind={kind} existing={editing ? link : null}
          onSaved={done} onCancel={() => { setEditing(false); setAdding(false); setLink(null); }} />
      )}
    </div>
  );
}

/* The loan-number gate — shown when the file has no YS loan number yet. `compact`
   is the copy of it that sits INSIDE an order card (owner-directed 2026-08-03:
   "you should also be able to enter the loan number right here"), so the blocker
   list carries the box that clears it instead of pointing at another box. */
function LoanNumberEntry({ appId, onSaved, compact = false }) {
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
  const box = (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div><label className="muted small">Loan number</label><input className="input" placeholder="YSCAP…" value={v} onChange={e => setV(e.target.value.toUpperCase())} /></div>
        <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save loan number'}</button>
      </div>
      {err && <div role="alert" className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
    </>
  );
  if (compact) return <div style={{ marginTop: 6 }}>{box}</div>;
  return (
    <div className="panel" style={{ background: 'var(--paper,#f6f3ec)', marginBottom: 14 }}>
      <b>Add the loan number to place orders.</b>
      <div className="muted small" style={{ margin: '3px 0 8px' }}>
        The loan number prints in the mortgage clause on every order, so it's required before Title or Insurance can be ordered.
      </div>
      {box}
    </div>
  );
}

/* One returned document row — PREVIEW, classify (assign a slot), accept/reject +
   download. Preview is first-class rather than behind a menu (owner-directed
   2026-08-03: "we need to have a preview button over there to preview the
   documents"): you cannot say whether a PDF is the binder or the invoice without
   opening it, and that decision is the whole job on this row. */
function ReturnedDoc({ appId, kind, doc, slots, conditionSlots, canAccept, onChanged, onPreview }) {
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
      {/* The condition's OWN slots are listed first and marked, so it is obvious
          which choices file the document into a named slot on the condition
          (binder / invoice) and which simply describe it and leave it in the
          condition's "also in this condition" list. */}
      <select className="input" style={{ width: 'auto' }} disabled={!!busy}
        value={slots.includes(doc.slot_label) ? doc.slot_label : ''}
        onChange={e => classify(e.target.value)} title="Assign a document type">
        <option value="">Leave unassigned…</option>
        {slots.map(s => (
          <option key={s} value={s}>
            {s}{(conditionSlots || []).includes(s) ? ' — condition slot' : ''}
          </option>
        ))}
      </select>
      {onPreview && <button className="btn ghost small" disabled={!!busy} onClick={() => onPreview(doc)} title="Open it here without downloading">Preview</button>}
      <button className="btn ghost small" disabled={!!busy} onClick={download}>Download</button>
      {rs !== 'accepted' && canAccept && <button className="btn primary small" disabled={!!busy} onClick={() => review('accept')}>Accept</button>}
      {rs !== 'rejected' && <button className="btn ghost small" disabled={!!busy} onClick={() => review('reject')}>Reject</button>}
    </div>
  );
}

/* One order card (Title or Insurance). Exported so the SAME card can be opened
   from the file's title / insurance conditions (see OrderModal) — one definition,
   so ordering from a condition and ordering from the Orders desk can never
   behave differently. */
export function OrderCard({ appId, kind, order, file, canAccept, onChanged }) {
  const [previewDoc, setPreviewDoc] = useState(null);
  const [showThread, setShowThread] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [followMsg, setFollowMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  // Borrower CC (owner-directed 2026-07-31): title defaults OFF (or the file
  // LO's own setting); the officer can flip it per order before sending. The
  // server returns the effective default; null = not yet loaded.
  const [ccBorrower, setCcBorrower] = useState(order.ccBorrower != null ? !!order.ccBorrower : null);
  useEffect(() => { if (order.ccBorrower != null) setCcBorrower((prev) => (prev == null ? !!order.ccBorrower : prev)); }, [order.ccBorrower]);

  const blockers = order.blockers || [];
  const needsLoan = blockers.includes('loan_number');
  const needsContact = blockers.includes('contact');
  const placed = order.status !== 'not_ordered' && order.status !== 'cancelled';
  const recipsRaw = order.recipients || { to: [], cc: [] };
  // The preview follows the checkbox live: the server built the cc list with the
  // effective default, so flipping the box adds/removes the borrower emails here.
  const borrowerEmails = [file && file.borrowerEmail, file && file.coBorrowerEmail]
    .filter(Boolean).map((e) => String(e).toLowerCase());
  const recips = (() => {
    const cc = (recipsRaw.cc || []).filter((e) => !borrowerEmails.includes(String(e).toLowerCase()));
    if (ccBorrower) for (const e of borrowerEmails) if (!cc.includes(e)) cc.unshift(e);
    return { to: recipsRaw.to || [], cc };
  })();

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
      const body = force ? { force: true } : {};
      if (ccBorrower != null) body.ccBorrower = !!ccBorrower;
      const r = await api.staffPlaceOrder(appId, kind, body);
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

      {/* THE CONTACT SLOT — who this order goes to, with its own Add / Edit button,
          always present rather than only when the order is blocked. Saving here
          also fills the file's title / insurance CONTACT condition. */}
      <ContactSlot appId={appId} kind={kind} vendor={order.vendor} onChanged={onChanged} />

      {/* THE LOAN NUMBER, entered here too — it prints in the mortgage clause on
          every order, so it is part of placing one. */}
      {!file.hasLoanNumber ? (
        <div className="panel" style={{ background: 'var(--paper,#f6f3ec)', marginBottom: 8, padding: '8px 10px' }}>
          <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="muted small" style={{ minWidth: 120 }}>Loan number</span>
            <span className="small muted" style={{ flex: 1, minWidth: 160 }}>
              Not on the file yet — it prints in the mortgage clause, so the order needs it.
            </span>
          </div>
          <LoanNumberEntry appId={appId} onSaved={onChanged} compact />
        </div>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: 'baseline', marginBottom: 8 }}>
          <span className="muted small" style={{ minWidth: 120 }}>Loan number</span>
          <span className="small" style={{ color: 'var(--ivory,#141B22)', fontWeight: 600 }}>{file.loanNumber}</span>
        </div>
      )}

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

      {/* Loop the borrower in? (owner-directed 2026-07-31: title default OFF; the
          officer flips it per order; their My-settings default can turn it on.) */}
      {!placed && (
        <label className="row small" style={{ gap: 6, marginBottom: 6, alignItems: 'center', color: '#4B585C' }}>
          <input type="checkbox" checked={!!ccBorrower} disabled={!!busy}
            onChange={(e) => setCcBorrower(e.target.checked)} />
          <span>CC the borrower on this {kind} order email{kind === 'title' ? ' (off by default — change your default in My settings)' : ''}</span>
        </label>
      )}

      {order.condition && <div className="muted small" style={{ marginBottom: 6 }}>Documents file into the <b style={{ color: 'var(--ivory,#141B22)' }}>{order.condition.label}</b> condition{order.condition.status ? ` (${order.condition.status})` : ''}.</div>}

      {order.orderedAt && <div className="muted small" style={{ marginBottom: 6 }}>Ordered {when(order.orderedAt)}{order.lastFollowupAt ? ` · last follow-up ${when(order.lastFollowupAt)}` : ''}</div>}

      {/* Before you can order: show EXACTLY what's still needed, each with a
          visible action — never a silently greyed-out button (a loan officer read
          the disabled "Order" as "I'm not allowed to order it"). */}
      {!placed && (needsLoan || needsContact) && (
        <div className="notice" style={{ marginTop: 6, marginBottom: 2, background: 'var(--surface-soft, #fbf7ee)', borderColor: 'var(--gold,#AE8746)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>To send this {kind} order, first:</div>
          <ul style={{ margin: '0 0 2px 18px', padding: 0 }}>
            {needsContact && <li style={{ marginBottom: 4 }}>Add the {CONTACT_ASK[kind]} (who to email) — the box above.</li>}
            {needsLoan && <li>Add the file’s loan number — the box above (it prints in the mortgage clause).</li>}
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
          <span className="muted small" style={{ alignSelf: 'center' }}>
            Emails the {CONTACT_ASK[kind]}, cc’ing the loan officer and processor{ccBorrower ? ' — and the borrower' : ''}.
          </span>
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
          {order.condition && (
            <div className="muted small" style={{ marginBottom: 4 }}>
              Every one of these is attached to the <b style={{ color: 'var(--ivory,#141B22)' }}>{order.condition.label}</b> condition
              and shows there too. Choosing a “condition slot” below files it into that slot; anything else stays in the
              condition without a slot.
            </div>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            {order.returnedDocs.map(d => (
              <ReturnedDoc key={d.id} appId={appId} kind={kind} doc={d} slots={order.slots || []}
                conditionSlots={order.conditionSlots || []} canAccept={canAccept}
                onChanged={onChanged} onPreview={setPreviewDoc} />
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

      {/* In-place preview — the same authenticated loader the download uses, so a
          returned PDF opens here instead of landing in the downloads folder. */}
      {previewDoc && (
        <DocPreview
          title={previewDoc.slot_label || `${KIND_LABEL[kind]} order document`}
          filename={previewDoc.filename}
          contentType={previewDoc.content_type}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          onDownload={async () => {
            try { const { blob, filename } = await api.staffDownloadDoc(previewDoc.id); saveBlob(blob, filename || previewDoc.filename); }
            catch (_) { /* ignore */ }
          }}
          onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}

/* THE ORDER SCREEN, OPENED FROM A CONDITION (owner-directed 2026-08-03: "in the
   insurance contact condition and the insurance general condition and the title
   contact condition and the title general condition we should have a small button
   … which should pop up a screen which should be the order screen to continue and
   complete the order").
   It loads the SAME payload the Orders desk loads and renders the SAME card, so
   the gates, the recipients preview, the borrower-CC choice, the returned
   documents and the follow-up all behave identically — there is no second
   ordering implementation to keep in step. */
export function OrderModal({ appId, kind, canAccept = false, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    api.staffOrders(appId).then(setData).catch((e) => setErr((e && e.message) || 'Could not load the order.'));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A change made in here (a contact, the loan number, a classified document) is
  // a change to the FILE, so the screen underneath is refreshed too.
  const changed = async () => { load(); if (onChanged) await onChanged(); };

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal panel" style={{ maxWidth: 860, width: '96%', maxHeight: '92vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, color: '#141B22' }}>Order {kind}</h3>
          <button className="btn ghost small" onClick={onClose}>Close ✕</button>
        </div>
        {err && <div className="notice err">{err}</div>}
        {!data && !err && <p className="muted small">Loading the order…</p>}
        {data && (
          <OrderCard appId={appId} kind={kind} order={data.orders[kind]} file={data.file}
            canAccept={canAccept} onChanged={changed} />
        )}
      </div>
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
        Order title and insurance from here, and send the closing attorney the file for closing prep.
        Each order emails its recipient with the right people copied and comes back to its own thread —
        the documents they send back land below.
      </p>
      {!data.file.hasLoanNumber && <LoanNumberEntry appId={appId} onSaved={load} />}
      {/* THREE SEPARATE SECTIONS, one per order type (owner-directed 2026-08-02:
          "under the orders three separate sections for all 3 different order
          types that we currently have"). Each opens and closes on its own so you
          can sit on the one you are working; an order that has NOT been placed
          yet starts open, because that is the one with something to do. */}
      <div style={{ display: 'grid', gap: 14 }}>
        <OrderSection label="Title" open={!isPlaced(data.orders.title)}>
          <OrderCard appId={appId} kind="title" order={data.orders.title} file={data.file} canAccept={canAccept} onChanged={load} />
        </OrderSection>
        <OrderSection label="Insurance" open={!isPlaced(data.orders.insurance)}>
          <OrderCard appId={appId} kind="insurance" order={data.orders.insurance} file={data.file} canAccept={canAccept} onChanged={load} />
        </OrderSection>
        {/* The attorney closing-prep order. Its own card + its own routes — the
            recipients, the document package and the closing email chain share
            nothing with a title/insurance vendor order. */}
        <OrderSection label="Attorney closing prep" open>
          <ClosingPrepCard appId={appId} />
        </OrderSection>
      </div>
    </div>
  );
}
