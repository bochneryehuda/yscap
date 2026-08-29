import React, { useCallback, useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { PhoneInput, EmailInput } from './FormattedInputs.jsx';
import EmailCenter from './EmailCenter.jsx';
import ClosingPrepCard from './ClosingPrepCard.jsx';
import DocPreview from './DocPreview.jsx';
import EmailPreview from './EmailPreview.jsx';
// A due date is a calendar 'YYYY-MM-DD' STRING end-to-end, so it is rendered
// through the shared formatter — `new Date('2026-08-07')` parses as UTC midnight
// and prints the day BEFORE for anybody west of Greenwich, which is the exact
// class of bug the repo's date rule exists to stop.
import { fmtDay } from '../lib/dates.js';
// Why an order's clock is stopped, worded in ONE place and shared with the
// cross-file Orders desk — the decision itself is the server's.
import { dormantMarker } from '../lib/orderDormant.js';
import { askConfirm, askPrompt } from '../lib/dialog.js';
// The file's own section jump — opens a collapsed section and scrolls to it, which
// a bare hash cannot do. Used by the appraisal card to hand off to the one screen
// that is allowed to talk to the appraisal companies.
import { goToSection } from './FileSections.jsx';
import { ScheduleButton, ScheduledSends, useScheduledSends } from './ScheduleSend.jsx';

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
  not_ordered: { borderColor: 'var(--gold)', color: 'var(--gold-ink)' },
  ordered: { borderColor: 'var(--teal, #2F7F86)', color: 'var(--teal, #2F7F86)' },
  documents_in: { borderColor: 'var(--teal, #2F7F86)', color: 'var(--teal, #2F7F86)' },
  completed: { borderColor: 'var(--ok)', color: 'var(--ok)' },
  cancelled: { opacity: 0.6 },
};
const KIND_LABEL = { title: 'Title', insurance: 'Insurance' };

/* "Is this order out?" deliberately has NO local definition any more. The server
   answers it once (order-sla.orderState → `open`) and hands the answer down with
   the rest of the order's state, because the same question is also asked by the
   cross-file desk and by the aging sweep — and a second, hand-typed status list
   in the browser is how a badge ends up disagreeing with the card beside it. */

/* THE THREE ORDERS ARE THREE REAL SECTIONS OF THE FILE NOW (owner-directed
   2026-08-03: "once we click on orders by the left side we should also have the
   three options over there right away"), so this panel no longer draws its own
   collapsible boxes — StaffApplication renders it once per order type inside the
   file's own <Section>, which is what puts all three in the left rail.

   The inner <details> that used to live here is deliberately GONE rather than
   ported. It took `open={!isPlaced(order)}` — a DERIVED prop — so the instant an
   order sent, `isPlaced` flipped, React re-rendered with open=false, and the
   section slammed shut on the "sent to <vendor>" confirmation the person had just
   asked for. A derived open-state prop can only ever behave that way; removing the
   derivation is what removes the class, not a longer-lived useState around it. */
const CONTACT_TYPE = { title: 'title_company', insurance: 'insurance_agent' };
const CONTACT_ASK = { title: 'title company', insurance: 'insurance agent' };
/* Every blocker code this card can NAME. The server's `orders.blockers()` is the
   authority on which codes can arrive, and scripts/test-order-blocker-labels-pure.js
   fails the build the moment that list gains a code with no wording here — a blocker
   the card cannot name used to leave the Order button clickable with nothing on the
   screen saying why it would refuse (the 'usps' address gate shipped exactly that
   way). Codes outside this list still render, through the fallback line. */
const KNOWN_ORDER_BLOCKERS = ['loan_number', 'contact', 'usps'];

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
  /* HOW THIS COMPANY HAS ACTUALLY PERFORMED, shown WHERE THE CHOICE IS MADE.
     A scorecard on an admin screen nobody opens changes nothing; the moment it
     matters is the moment somebody is about to send this vendor another order, or
     is deciding whether to use a different one. Best-effort and unobtrusive: it
     never blocks and it says "not enough to go on" rather than printing a
     confident percentage off two orders. */
  const [score, setScore] = useState(null);
  useEffect(() => {
    let live = true;
    if (!vendor || !vendor.id) { setScore(null); return undefined; }
    api.staffOrderVendorScore(appId, kind)
      .then((r) => { if (live) setScore(r && r.card ? r : null); })
      .catch(() => { if (live) setScore(null); });
    return () => { live = false; };
  }, [appId, kind, vendor && vendor.id]);

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
      {score && score.card && score.card.orders > 0 && (
        <div className="small" style={{ color: '#4B585C', marginTop: 2, paddingLeft: 128 }}>
          {score.summary}
          {score.card.overdueNow > 0 && (
            <span style={{ color: '#B3261E', fontWeight: 600 }}>
              {' '}They are late on {score.card.overdueNow} other order{score.card.overdueNow === 1 ? '' : 's'} right now.
            </span>
          )}
        </div>
      )}
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
    if (action === 'accept' && !doc.slot_label && !(await askConfirm('Accept this document without assigning a type (binder / invoice / …)? You can assign it first.'))) return;
    let reason;
    if (action === 'reject') { reason = await askPrompt('Why is this document being rejected? (the reason is recorded)'); if (!reason) return; }
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
      <span className="pill" style={unassigned ? { borderColor: 'var(--gold)', color: 'var(--gold-ink)' } : { borderColor: 'var(--teal,#2F7F86)', color: 'var(--teal,#2F7F86)' }}>
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
/* ════════════════════════════════════════════════════════════════════════════
   THE CLOCK AND THE OWNER — what makes an order a tracked thing rather than an
   email somebody has to remember (owner-directed 2026-08-03).

   Every figure here is computed on the SERVER (order-sla.orderState) and handed
   down whole. Nothing is re-derived in the browser on purpose: the same order
   also appears on the cross-file desk and drives the aging nudge, and a card that
   worked out "late" for itself is how one screen ends up disagreeing with
   another about the same order.
   ════════════════════════════════════════════════════════════════════════════ */
function OrderTracking({ appId, kind, tracking, onChanged }) {
  const [team, setTeam] = useState(null);
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [dueDraft, setDueDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  // The roster is only fetched when somebody actually opens the picker — an order
  // card is on screen for every file, and the whole team list is not.
  const openAssign = () => {
    setEditing('assign'); setErr('');
    if (!team) api.staffTeam().then(setTeam).catch(() => setTeam([]));
  };

  if (!tracking || !tracking.open) return null;
  const t = tracking;

  const save = async (what, fn) => {
    setBusy(what); setErr('');
    try { await fn(); setEditing(''); onChanged && onChanged(); }
    catch (e) { setErr((e && e.message) || 'Could not save that.'); }
    finally { setBusy(''); }
  };

  const tone = t.overdue
    ? { background: '#FBEAEA', border: '1px solid #E3B7B7' }
    : { background: 'var(--paper,#f6f3ec)', border: '1px solid var(--line,#e6e0d4)' };

  return (
    <div className="panel" style={{ ...tone, marginBottom: 8, padding: '8px 10px' }}>
      <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {/* "PAUSED", NOT "ON TIME", when the clock is stopped. The server stops it
            on a file nobody is working (on hold, declined, withdrawn), and saying
            "On time" beside an order placed three months ago claims we MET the
            date rather than that we stopped measuring — the reason is spelled out
            beside it either way. */}
        <span className="small" style={{ color: '#141B22', fontWeight: 700 }}>
          {t.dormant ? 'Paused'
            : t.overdue ? `${t.daysLate} business day${t.daysLate === 1 ? '' : 's'} late`
              : t.dueOn ? 'On time' : 'Waiting'}
        </span>
        {/* WHY IT IS PAUSED — the SERVER's reason, worded in the one shared place,
            so this card and the cross-file desk can never describe the same order
            differently. A reason neither knows reads as "not being worked" rather
            than being mislabelled as one they do. */}
        {dormantMarker(t) && (
          <span className="small" style={{ color: '#8A5A00', fontWeight: 600 }}>· {dormantMarker(t)}</span>
        )}
        {t.daysOut != null && (
          <span className="small" style={{ color: '#4B585C' }}>
            · out {t.daysOut} day{t.daysOut === 1 ? '' : 's'}
          </span>
        )}
        {t.dueOn && (
          <span className="small" style={{ color: '#4B585C' }}>
            · expected back {fmtDay(t.dueOn)}{t.dueOnIsOverride ? ' (set by hand)' : ''}
          </span>
        )}
        {/* WHOSE MOVE IS IT. A vendor who has already replied must never be
            described as owing us something — that is how a desk teaches people
            to stop reading it. */}
        {t.pendingOn === 'us' && (
          <span className="small" style={{ color: '#8A5A00', fontWeight: 600 }}>· their documents are here, waiting on us</span>
        )}
      </div>

      <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 4 }}>
        <span className="small" style={{ color: '#4B585C' }}>
          Chased by: <b style={{ color: '#141B22' }}>{t.assignedName || 'nobody yet'}</b>
        </span>
        <button className="btn link small" style={{ padding: 0 }} onClick={openAssign}>Change</button>
        <span className="small" style={{ color: '#4B585C' }}>·</span>
        <button className="btn link small" style={{ padding: 0 }}
          onClick={() => { setEditing('due'); setDueDraft(t.dueOnIsOverride ? t.dueOn : ''); setErr(''); }}>
          Set the date it is expected
        </button>
        <span className="small" style={{ color: '#4B585C' }}>·</span>
        <button className="btn link small" style={{ padding: 0 }}
          onClick={() => { setEditing('note'); setNoteDraft(t.notes || ''); setErr(''); }}>
          {t.notes ? 'Edit the note' : 'Add a note'}
        </button>
        <span className="small" style={{ color: '#4B585C' }}>·</span>
        {/* THE ONLY WAY SOME ORDERS CAN EVER END. An order retires by itself when
            its condition is signed off, and that is the only automatic rule — so
            one whose condition is never signed off (a funded file worked another
            way, a file with no such condition at all) stayed on the desk forever
            with a live Chase button pointed at a vendor on a closed loan, and the
            overdue nudge re-fired at the administrators every two days, permanently.
            Deliberately NOT "Cancel": that is a stand-down and it shuts the
            follow-up and reply doors, which must stay open after funding. */}
        <button className="btn link small" style={{ padding: 0 }} disabled={busy === 'done'}
          onClick={async () => {
            if (!(await askConfirm('Mark this order finished?\n\nIt leaves the Orders desk and stops being chased. You can still write to the vendor and file anything else they send.'))) return;
            save('done', () => api.staffOrderComplete(appId, kind, 'marked finished on the file'));
          }}>
          {busy === 'done' ? 'Finishing…' : 'Mark finished'}
        </button>
      </div>

      {t.notes && editing !== 'note' && (
        <div className="small" style={{ color: '#141B22', marginTop: 4, whiteSpace: 'pre-wrap' }}>{t.notes}</div>
      )}
      {err && <div className="notice err" style={{ marginTop: 6 }}>{err}</div>}

      {editing === 'assign' && (
        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <select className="small" defaultValue={t.assignedTo || ''} disabled={busy === 'assign'}
            onChange={(e) => save('assign', () => api.staffAssignOrder(appId, kind, e.target.value || null))}>
            <option value="">Nobody — back to the team</option>
            {(team || []).map((p) => (
              <option key={p.id} value={p.id}>{p.full_name || p.email}{p.title ? ` — ${p.title}` : ''}</option>
            ))}
          </select>
          {!team && <span className="muted small">Loading the team…</span>}
          <button className="btn ghost small" onClick={() => setEditing('')}>Cancel</button>
        </div>
      )}

      {editing === 'due' && (
        <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" className="small" value={dueDraft} onChange={(e) => setDueDraft(e.target.value)} />
          <button className="btn small" disabled={busy === 'due'}
            onClick={() => save('due', () => api.staffOrderDue(appId, kind, { dueOn: dueDraft || null }))}>
            {busy === 'due' ? 'Saving…' : 'Save'}
          </button>
          {t.dueOnIsOverride && (
            <button className="btn ghost small" disabled={busy === 'due'}
              onClick={() => save('due', () => api.staffOrderDue(appId, kind, { dueOn: null }))}>
              Back to the usual {t.slaDays} business days
            </button>
          )}
          <button className="btn ghost small" onClick={() => setEditing('')}>Cancel</button>
        </div>
      )}

      {editing === 'note' && (
        <div style={{ marginTop: 6 }}>
          <textarea className="small" rows={2} style={{ width: '100%' }} value={noteDraft}
            placeholder="e.g. they said Thursday; wrong parcel, re-sent"
            onChange={(e) => setNoteDraft(e.target.value)} />
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <button className="btn small" disabled={busy === 'note'}
              onClick={() => save('note', () => api.staffOrderNote(appId, kind, noteDraft))}>
              {busy === 'note' ? 'Saving…' : 'Save the note'}
            </button>
            <button className="btn ghost small" onClick={() => setEditing('')}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  /* THE BORROWER'S HELPER (owner-directed 2026-08-28) — its OWN choice, never a
     rider on the borrower's, so an officer can copy the helper without copying the
     borrower. The server sends the effective default; null = not yet loaded. */
  const [ccHelper, setCcHelper] = useState(order.ccHelper != null ? !!order.ccHelper : null);
  useEffect(() => { if (order.ccHelper != null) setCcHelper((prev) => (prev == null ? !!order.ccHelper : prev)); }, [order.ccHelper]);
  /* THE COMPANY BEHIND THE VENDOR (owner-directed 2026-08-28): the pool's other
     people at the vendor's email domain, the same-domain addresses this order's
     own email chain has shown, and one-off loop-ins for THIS send. Loaded when
     the block is opened; ticked addresses ride the place body as extraCc. */
  const [companyOpen, setCompanyOpen] = useState(false);
  const [company, setCompany] = useState(null);
  const [loopIn, setLoopIn] = useState([]);   // emails ticked for this send
  const loadCompany = async () => {
    try { setCompany(await api.orderCompanyContacts(appId, kind)); }
    catch (_) { setCompany({ domain: null, company: [], harvested: [], onFile: [] }); }
  };
  const toggleCompany = () => { setCompanyOpen((v) => !v); if (!company) loadCompany(); };
  const toggleLoopIn = (e) => setLoopIn((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e]));

  // WHO the helper is — the file's own list. No helper on file ⇒ no checkbox at all,
  // rather than one that could never do anything.
  const helpers = (file && Array.isArray(file.helpers) ? file.helpers : []);
  const helperEmails = helpers.map((h) => String(h.email || '').toLowerCase()).filter(Boolean);
  const helperNames = helpers.map((h) => h.name || h.email).filter(Boolean).join(', ');

  const blockers = order.blockers || [];
  const needsLoan = blockers.includes('loan_number');
  const needsContact = blockers.includes('contact');
  // The USPS address gate: the server refuses to place (or re-send) an order until
  // the USPS-verified address is imported, so the card must say so up front.
  const needsUsps = blockers.includes('usps');
  // A blocker code this screen has no wording for still shows and still holds the
  // button — the server will refuse it anyway, and a clickable button that fails
  // after the click (or a silently disabled one) is the dead end this fixes.
  const otherBlockers = blockers.filter((b) => !KNOWN_ORDER_BLOCKERS.includes(b));
  const blocked = needsLoan || needsContact || needsUsps || otherBlockers.length > 0;
  const placed = order.status !== 'not_ordered' && order.status !== 'cancelled';
  const recipsRaw = order.recipients || { to: [], cc: [] };
  // The preview follows the checkbox live: the server built the cc list with the
  // effective default, so flipping the box adds/removes the borrower emails here.
  const borrowerEmails = [file && file.borrowerEmail, file && file.coBorrowerEmail]
    .filter(Boolean).map((e) => String(e).toLowerCase());
  const recips = (() => {
    const cc = (recipsRaw.cc || [])
      .filter((e) => !borrowerEmails.includes(String(e).toLowerCase()))
      .filter((e) => !helperEmails.includes(String(e).toLowerCase()));
    if (ccHelper) for (const e of helperEmails) if (!cc.includes(e)) cc.unshift(e);
    if (ccBorrower) for (const e of borrowerEmails) if (!cc.includes(e)) cc.unshift(e);
    return { to: recipsRaw.to || [], cc };
  })();

  const cancel = async (reopen) => {
    if (!reopen && !(await askConfirm(`Cancel the ${kind} order? It won't email anyone; you can re-order afterward.`))) return;
    setBusy('cancel'); setMsg(null);
    try { await api.staffCancelOrder(appId, kind, reopen); onChanged && onChanged(); }
    catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not update the order.' }); }
    finally { setBusy(''); }
  };

  /* SEND IT LATER. The scheduling door takes the SAME body the send takes, so
     what is queued tonight is exactly what pressing the button now would do —
     and it is the send ROUTE, not a rendered email, that runs in the morning. */
  const sched = useScheduledSends(appId, [order.status]);
  const scheduleIt = async ({ day, time, override }) => {
    const body = { day, time };
    if (placed) body.force = true;
    if (ccBorrower != null) body.ccBorrower = !!ccBorrower;
    if (helpers.length && ccHelper != null) body.ccHelper = !!ccHelper;
    // An edit approved in the preview rides the stored intent (post-merge audit):
    // scheduling must never quietly drop wording the person already approved.
    if (override) body.override = override;
    const r = await api.staffScheduleOrder(appId, kind, body);
    await sched.reload();
    setMsg({ tone: (r.warnings && r.warnings.length) ? 'warn' : 'ok',
      text: (r.warnings && r.warnings.length)
        ? `Scheduled for ${r.scheduled.sendAtText}. It will NOT go out unless you also: ${r.warnings.join(' ')}`
        : `${KIND_LABEL[kind]} order scheduled for ${r.scheduled.sendAtText}.` });
    onChanged && onChanged();
  };

  /* THE EDITABLE PREVIEW (owner-directed 2026-08-26): the Order / Re-send / Follow-up
     buttons open the send's OWN built email — subject + body, fully editable — and the
     send carries only what was actually changed. The preview endpoint runs the same
     pure builder the send runs, so this can never show a different email. If the
     preview cannot be fetched, the modal still opens with an honest note rather than
     silently sending unseen. */
  const [preview, setPreview] = useState(null);   // {mode:'place'|'followup', force, subject, text, to, cc}
  const openSendPreview = async (mode, force) => {
    setBusy('preview'); setMsg(null);
    try {
      // The panel's ccBorrower choice rides the preview request, so the To/Cc shown is
      // the send's own derivation (post-merge audit W6) — a follow-up keeps the footing
      // the order was placed with, so it sends no explicit choice.
      const q = mode === 'followup'
        ? { followup: '1', ...(followMsg.trim() ? { note: followMsg.trim() } : {}) }
        : {
          ...(ccBorrower != null ? { ccBorrower: ccBorrower ? '1' : '0' } : {}),
          ...(helpers.length && ccHelper != null ? { ccHelper: ccHelper ? '1' : '0' } : {}),
        };
      const pv = await api.staffOrderEmailPreview(appId, kind, q);
      setPreview({ mode, force: !!force, subject: pv.subject || '', text: pv.text || '', to: pv.to || [], cc: pv.cc || [] });
    } catch (e) {
      setMsg({ tone: 'err', text: (e && e.message) || 'Could not build the email preview.' });
    } finally { setBusy(''); }
  };
  const place = async (force, override) => {
    setBusy('place'); setMsg(null);
    try {
      const body = force ? { force: true } : {};
      if (override) body.override = override;
      if (ccBorrower != null) body.ccBorrower = !!ccBorrower;
      if (helpers.length && ccHelper != null) body.ccHelper = !!ccHelper;
      if (loopIn.length) body.extraCc = loopIn;
      const r = await api.staffPlaceOrder(appId, kind, body);
      // AN UNCONFIRMED SEND IS NOT A GREEN TICK. The server distinguishes a send
      // the provider ACCEPTED from one it stopped responding to mid-flight
      // (orders.isAmbiguousSendFailure) precisely so a human is told to check
      // before re-sending — and that sentence has to reach a screen, or the
      // distinction may as well not exist and the vendor gets the order twice.
      setMsg(r.unconfirmed
        ? { tone: 'warn', text: r.warning || 'The order may or may not have gone out — check the Email Center before re-sending.' }
        : { tone: 'ok', text: `${KIND_LABEL[kind]} order sent to ${(r.sent_to || []).join(', ')}${r.cc && r.cc.length ? ` (cc ${r.cc.length})` : ''}.` });
      onChanged && onChanged();
    } catch (e) {
      // THE SERVER'S OWN WORDING WINS on a 409, because it distinguishes two cases
      // this screen cannot: "already ordered, use Follow-up" and "you just pressed
      // force, give it a moment". Hard-coding one string here told the operator who
      // had JUST pressed "force a re-send" to force a re-send — the advice-to-do-
      // the-thing-you-just-did trap the server-side fix was written to close, made
      // inert by the client throwing that message away.
      if (e && e.status === 409) {
        setMsg({
          tone: 'warn',
          text: (e && e.message) || `${KIND_LABEL[kind]} was already ordered. Use Follow-up, or force a re-send below.`,
          // A double-click inside the re-send window is not a reason to offer the
          // button again — waiting is the fix.
          canForce: !(e.data && e.data.code === 'too_soon'),
        });
      } else setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the order.' });
    } finally { setBusy(''); }
  };
  const followup = async (override) => {
    setBusy('follow'); setMsg(null);
    try {
      const r = await api.staffOrderFollowup(appId, kind, { message: followMsg, ...(override ? { override } : {}) });
      setMsg(r.unconfirmed
        ? { tone: 'warn', text: r.warning || 'The follow-up may or may not have gone out — check the Email Center before sending it again.' }
        : { tone: 'ok', text: `Follow-up sent to ${(r.sent_to || []).join(', ')}.` });
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

      {/* THE CLOCK AND THE OWNER — first, because "is this late and who has it?"
          is the question somebody opening a placed order came to answer. Renders
          nothing until the order is actually out. */}
      <OrderTracking appId={appId} kind={kind} tracking={order.tracking} onChanged={onChanged} />

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

      {/* THE COMPANY'S PEOPLE (owner-directed 2026-08-28): everyone else at this
          vendor's company — from the vendor pool and from this order's own email
          chain — offered to add to the file (auto-looped from then on) or to loop
          into just this send. */}
      <div className="muted small" style={{ marginBottom: 6 }}>
        <button className="btn link small" style={{ padding: 0 }} onClick={toggleCompany} aria-expanded={companyOpen}>
          {companyOpen ? 'Hide' : 'Show'} people at this company
        </button>
        {companyOpen && (
          <div style={{ marginTop: 4, border: '1px solid #E4DFD3', borderRadius: 8, padding: '6px 10px' }}>
            {!company ? 'Looking up the company…' : !company.domain ? (
              <span>This vendor’s email is a personal mailbox, so there is no company domain to look up.</span>
            ) : (
              <>
                <div style={{ color: '#141B22', fontWeight: 600 }}>@{company.domain}</div>
                {company.onFile.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    On this file already (looped into every {kind} email automatically):{' '}
                    {company.onFile.map((c) => c.name || c.emails[0]).join(', ')}
                  </div>
                )}
                {company.company.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <b style={{ color: '#141B22' }}>In the vendor pool at this company:</b>
                    {company.company.map((c) => (
                      <div key={c.id} className="row" style={{ gap: 6, alignItems: 'center', padding: '2px 0' }}>
                        <span style={{ flex: 1 }}>{c.name || c.emails[0]} — {c.emails.join(', ')}</span>
                        <button className="btn ghost small" onClick={async () => {
                          try { await api.adoptFileContact(appId, c.id); await loadCompany(); onChanged && onChanged(); }
                          catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not add them.' }); }
                        }}>Add to this file</button>
                      </div>
                    ))}
                  </div>
                )}
                {company.harvested.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <b style={{ color: '#141B22' }}>Seen on this order’s email chain (same company):</b>
                    {company.harvested.map((h) => (
                      <div key={h.email} className="row" style={{ gap: 6, alignItems: 'center', padding: '2px 0' }}>
                        <label className="row" style={{ gap: 6, alignItems: 'center', flex: 1, cursor: 'pointer' }}>
                          <input type="checkbox" checked={loopIn.includes(h.email)} onChange={() => toggleLoopIn(h.email)} />
                          <span>{h.name ? `${h.name} — ` : ''}{h.email} <span className="muted">(tick to CC on this send)</span></span>
                        </label>
                        <button className="btn ghost small" title="Save them as a contact at this company and add them to the file"
                          onClick={async () => {
                            try { await api.orderCompanyContactAdd(appId, kind, { email: h.email, name: h.name || undefined }); await loadCompany(); onChanged && onChanged(); }
                            catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not save that contact.' }); }
                          }}>Save as contact</button>
                      </div>
                    ))}
                  </div>
                )}
                {company.company.length === 0 && company.harvested.length === 0 && company.onFile.length === 0 && (
                  <div>Nobody else at this company yet — replies on this order’s chain will show up here.</div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Loop the borrower in? (owner-directed 2026-08-05: OFF by default for every
          order kind; the officer flips it per order; their My-settings default can
          turn it on for their own files.) */}
      {!placed && (
        <label className="row small" style={{ gap: 6, marginBottom: 6, alignItems: 'center', color: '#4B585C' }}>
          <input type="checkbox" checked={!!ccBorrower} disabled={!!busy}
            onChange={(e) => setCcBorrower(e.target.checked)} />
          <span>CC the borrower on this {kind} order email (off by default — change your default in My settings)</span>
        </label>
      )}

      {/* AND THE BORROWER'S HELPER (owner-directed 2026-08-28: "you should also be
          able to have an option to CC the helper as well if there is a borrower
          helper on file"). Only shown when this file actually HAS a helper — a
          checkbox that can never do anything is worse than no checkbox — and it is a
          separate choice from the borrower's, so the helper can be on the thread
          while the borrower is not. */}
      {!placed && helpers.length > 0 && (
        <label className="row small" style={{ gap: 6, marginBottom: 6, alignItems: 'center', color: '#4B585C' }}>
          <input type="checkbox" checked={!!ccHelper} disabled={!!busy}
            onChange={(e) => setCcHelper(e.target.checked)} />
          <span>CC the borrower’s helper{helpers.length > 1 ? 's' : ''} on this {kind} order email — <b style={{ color: '#141B22' }}>{helperNames}</b> (off by default; separate from CC’ing the borrower)</span>
        </label>
      )}

      {order.condition && <div className="muted small" style={{ marginBottom: 6 }}>Documents file into the <b style={{ color: 'var(--ivory,#141B22)' }}>{order.condition.label}</b> condition{order.condition.status ? ` (${order.condition.status})` : ''}.</div>}

      {order.orderedAt && <div className="muted small" style={{ marginBottom: 6 }}>Ordered {when(order.orderedAt)}{order.lastFollowupAt ? ` · last follow-up ${when(order.lastFollowupAt)}` : ''}</div>}

      {/* Before you can order: show EXACTLY what's still needed, each with a
          visible action — never a silently greyed-out button (a loan officer read
          the disabled "Order" as "I'm not allowed to order it"). */}
      {blocked && (
        <div className="notice" style={{ marginTop: 6, marginBottom: 2, background: 'var(--surface-soft, #fbf7ee)', borderColor: 'var(--gold,#AE8746)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {placed ? `Before you can send this ${kind} order again:` : `To send this ${kind} order, first:`}
          </div>
          <ul style={{ margin: '0 0 2px 18px', padding: 0 }}>
            {needsContact && <li style={{ marginBottom: 4 }}>Add the {CONTACT_ASK[kind]} (who to email) — the box above.</li>}
            {needsLoan && <li>Add the file’s loan number — the box above (it prints in the mortgage clause).</li>}
            {/* THE USPS ADDRESS GATE — same rule as the attorney closing prep: an
                order transmits the property address to an outside vendor, so it
                goes out USPS-verified or not at all. Same words the server
                answers with. */}
            {needsUsps && <li>Import the USPS-verified property address — open <b style={{ color: 'var(--ivory,#141B22)' }}>USPS Address Verification</b> on this file's conditions list, verify the subject address, and click "Import verified address". The {CONTACT_ASK[kind]} must never get an unverified address. If USPS cannot confirm the address, a super admin can accept it there as an exception.</li>}
            {/* A blocker this screen has no wording for still SHOWS — a held-back
                order with nothing on screen saying why is a dead end. */}
            {otherBlockers.map((b) => (
              <li key={b}>Something on the server is holding this order (its code is "{b}") and this screen does not know how to explain it yet. Refresh the page — if this line is still here, the portal needs an update.</li>
            ))}
          </ul>
        </div>
      )}

      <ScheduledSends rows={sched.rows} onCancel={sched.cancel}
        kinds={[kind === 'title' ? 'title_order' : 'insurance_order']} />

      {/* Actions */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {!placed && (
          <button className="btn primary small" disabled={!!busy || blocked} onClick={() => openSendPreview('place', false)}
            title={needsLoan ? 'Add the loan number first' : needsContact ? `Add the ${CONTACT_ASK[kind]} first` : needsUsps ? 'Import the USPS-verified address first — see the step above' : blocked ? 'Finish the steps listed above first' : `Send the ${kind} order to the vendor`}>
            {busy === 'place' ? 'Sending…' : `Order ${kind}`}
          </button>
        )}
        {!placed && (
          <ScheduleButton onSchedule={scheduleIt} busy={!!busy} what={`the ${kind} order`} />
        )}
        {!placed && !blocked && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            Emails the {CONTACT_ASK[kind]}, cc’ing the loan officer and processor{ccBorrower ? ' — and the borrower' : ''}{ccHelper && helpers.length ? `${ccBorrower ? ' and' : ' — and'} the borrower’s helper` : ''}.
          </span>
        )}
        {placed && (
          <>
            <button className="btn primary small" disabled={!!busy} onClick={() => setFollowOpen(o => !o)}>Follow up</button>
            <button className="btn ghost small" disabled={!!busy || needsContact || needsUsps} onClick={() => openSendPreview('place', true)}
              title={needsUsps ? 'Import the USPS-verified address first — see the step above' : 'Re-send the full order to the vendor + CC chain'}>
              {busy === 'place' ? 'Sending…' : 'Re-send order'}
            </button>
            <ScheduleButton onSchedule={scheduleIt} busy={!!busy} disabled={needsContact || needsUsps}
              what={`the ${kind} order`} />
            {/* NOT on a FINISHED order. Cancelling is not a tidier way of saying
                "done" — it is an explicit stand-down that shuts the vendor reply
                door, so on an order that already finished it can only lose the
                team the ability to write to a company that may still owe the
                final policy. Reopen is the action there. */}
            {order.status !== 'completed' && (
              <button className="btn ghost small" disabled={!!busy} style={{ color: 'var(--danger)' }} onClick={() => cancel(false)} title="Cancel this order (no email is sent)">Cancel order</button>
            )}
          </>
        )}
        {/* Reopen covers BOTH ways an order ends. Offering it only for 'cancelled'
            made "Mark finished" a one-way door: an order finished by hand, or
            retired by the sweep on a condition somebody later pushed back, had no
            way back onto the desk. The server decides which state it returns to —
            'documents_in' when the vendor has actually answered — so reopening
            never tells the nudge that a commitment sitting on the file is missing. */}
        {(order.status === 'cancelled' || order.status === 'completed') && (
          <button className="btn ghost small" disabled={!!busy} onClick={() => cancel(true)}
            title="Put this order back on the Orders desk without re-sending it">
            Reopen order
          </button>
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
            <button className="btn primary small" disabled={busy === 'follow'} onClick={() => openSendPreview('followup')}>{busy === 'follow' ? 'Sending…' : 'Preview & send follow-up'}</button>
            <button className="btn ghost small" onClick={() => { setFollowOpen(false); setFollowMsg(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {preview && (
        <EmailPreview
          title={preview.mode === 'followup' ? `Follow-up on the ${kind} order` : `${KIND_LABEL[kind]} order email`}
          subject={preview.subject} text={preview.text} to={preview.to} cc={preview.cc}
          subjectLocked={preview.mode === 'followup'}
          lockNote="A follow-up stays on the vendor's original order conversation, so its subject is kept."
          busy={busy === 'place' || busy === 'follow'}
          sendLabel={preview.mode === 'followup' ? 'Send follow-up' : (preview.force ? 'Re-send order' : 'Send order')}
          onClose={() => setPreview(null)}
          onSend={async (override) => {
            if (preview.mode === 'followup') await followup(override); else await place(preview.force, override);
            setPreview(null);
          }}
          /* Scheduling from INSIDE the preview keeps the edit (post-merge audit) — the
             outside ScheduleButton has no edit to carry. A follow-up cannot be
             scheduled (no such kind). */
          scheduleWhat={`the ${kind} order`}
          onSchedule={preview.mode === 'followup' ? null : async (override, { day, time }) => {
            await scheduleIt({ day, time, override });
            setPreview(null);
          }} />
      )}

      {msg && (
        <div className={`notice ${msg.tone === 'ok' ? 'ok' : msg.tone === 'warn' ? '' : 'err'}`} style={{ marginTop: 10 }} role="status">
          {msg.text}
          {msg.canForce && <> <button className="btn link small" onClick={() => openSendPreview('place', true)}>Force re-send</button></>}
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

  // A change made in here (a contact, the loan number, a classified document, the
  // order itself) is a change to the FILE, so the screen underneath is refreshed
  // too — INCLUDING the three order sections, which hold their own copy of this
  // exact payload. Without `refreshOrders`, placing an order from a condition's
  // pop-up left every order section on the page still reading "not ordered".
  const changed = async () => { load(); refreshOrders(appId); if (onChanged) await onChanged(); };

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

/* ── ONE FETCH FOR THE THREE ORDER SECTIONS ─────────────────────────────────
   Orders is three sibling sections now, so this panel is mounted up to three
   times on one screen — and they are three views of ONE payload. Left alone,
   that is three identical round trips every time the room is opened, three
   copies of the state, and — the part that actually bit — no way for one card's
   action to refresh the others: placing the title order left the insurance card
   and the closing card showing a file that had already moved on.

   So the request lives here, keyed by file, with the mounted cards as
   subscribers: one request however many cards are showing, and ANY card's
   onChanged refreshes all of them. The cache is dropped when the last subscriber
   for a file unmounts, so switching files never serves a stale payload. */
const orderSubs = new Map();     // appId -> Set<forceRender>
const orderCache = new Map();    // appId -> { data, err, loading }
const orderGen = new Map();      // appId -> the generation the newest request belongs to

function emitOrders(appId) {
  const subs = orderSubs.get(appId);
  if (subs) subs.forEach((fn) => { try { fn(); } catch (_) { /* a dead subscriber must not stop the rest */ } });
}

/**
 * A GENERATION TOKEN, not an in-flight flag — and the difference is two real bugs.
 *
 * With a plain `inflight` Set, a forced reload racing the mount request had the
 * OLDER response clear the flag (so a third card started a redundant request) and,
 * if it landed second, overwrite the fresh payload with the pre-action state — the
 * exact "showing a file that had already moved on" this store exists to remove.
 *
 * Worse: the cache is deleted when the last card unmounts, and an in-flight
 * response then RE-CREATED it with nobody subscribed. The mount guard is
 * `cache.has(appId)`, so coming back to that file minutes later found a populated
 * entry, made no request, and rendered a stale payload for the rest of the tab
 * session. Bumping the generation on unmount is what makes a late response
 * recognise that it belongs to a panel nobody is looking at, and drop itself.
 */
function loadOrders(appId, { force = false } = {}) {
  if (!appId) return;
  const cur = orderCache.get(appId);
  // A second card mounting in the same tick joins the request already in flight
  // rather than starting its own. An explicit refresh (force) always re-asks.
  if (cur && cur.loading && !force) return;
  const gen = (orderGen.get(appId) || 0) + 1;
  orderGen.set(appId, gen);
  const prev = cur || {};
  orderCache.set(appId, { ...prev, loading: true });
  emitOrders(appId);
  // A response is only allowed to write if it is still the NEWEST request for
  // this file. THE GENERATION IS THE WHOLE TEST — deliberately NOT "and somebody
  // is still subscribed".
  //
  // Requiring a subscriber wedged the room: `refreshOrders` is called from the
  // order pop-up on a CONDITION, which lives in a different room, so no order
  // section is mounted at that moment. The request set `loading:true`, the
  // response was then discarded for having no subscriber, and `loading` was never
  // cleared — after which the mount guard saw a populated cache entry, made no
  // request, and all three sections read "Loading orders…" until the page was
  // reloaded. Unmounting already bumps the generation, so a genuinely orphaned
  // response is refused by this test alone.
  const stillOurs = () => orderGen.get(appId) === gen;
  api.staffOrders(appId)
    .then((data) => { if (stillOurs()) orderCache.set(appId, { data, err: '', loading: false }); })
    // Keep the last good payload on a failed refresh: blanking three cards
    // because one refresh hiccupped loses work in progress for no gain. The
    // error is still surfaced — quietly, beside the data (see the panel).
    .catch((e) => { if (stillOurs()) orderCache.set(appId, { data: prev.data || null, err: (e && e.message) || 'Could not load orders.', loading: false }); })
    .then(() => { if (stillOurs()) emitOrders(appId); });
}

function useOrders(appId) {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    if (!appId) return undefined;
    let subs = orderSubs.get(appId);
    if (!subs) { subs = new Set(); orderSubs.set(appId, subs); }
    subs.add(rerender);
    // Fetch unless there is already something to show or something on the way.
    // "Has an entry" is NOT the same question: an entry can hold a failed refresh
    // that nobody ever saw, and treating that as "already loaded" leaves the card
    // showing an error for a request the reader never made.
    const cur = orderCache.get(appId);
    if (!cur || (!cur.data && !cur.loading)) loadOrders(appId);
    return () => {
      subs.delete(rerender);
      if (!subs.size) {
        orderSubs.delete(appId);
        orderCache.delete(appId);
        // Retire the generation too, so a request still in flight cannot
        // re-create the entry it just cleared — which would make the next mount
        // skip its fetch and render a payload that is minutes old.
        orderGen.set(appId, (orderGen.get(appId) || 0) + 1);
      }
    };
  }, [appId, rerender]);
  const st = orderCache.get(appId) || { data: null, err: '', loading: true };
  const reload = useCallback(() => loadOrders(appId, { force: true }), [appId]);
  return { data: st.data, err: st.err, loading: st.loading, reload };
}

/** Refresh every mounted order card for a file — exported so a sibling card
    (the closing-prep card, a condition's order button) can say "this changed"
    without knowing who else is on screen. */
export function refreshOrders(appId) { loadOrders(appId, { force: true }); }

/**
 * `only` names ONE order type ('title' | 'insurance' | 'closing') so the file can
 * render each in its own <Section> — which is what gives each one a rail entry, a
 * deep link and its own badge. Omitting it renders all three stacked, which is
 * what the order modal and any non-file host still want.
 */
export default function OrdersPanel({ appId, canAccept = false, only = null }) {
  const { data, err, reload } = useOrders(appId);

  // THE CLOSING CARD DOES NOT READ THIS PAYLOAD. Making it wait for one meant the
  // attorney section showed "Loading orders…" behind a request it never uses —
  // and showed the ORDERS error in place of the closing card when that request
  // failed. It fetches its own data and is rendered straight away; the tracking
  // strip appears above it as soon as the orders payload arrives, and its absence
  // never holds the card up.
  if (only === 'closing') {
    return (
      <>
        {data && data.orders.attorney && (
          <OrderTracking appId={appId} kind="attorney" tracking={data.orders.attorney.tracking} onChanged={reload} />
        )}
        <ClosingPrepCard appId={appId} onChanged={reload} />
      </>
    );
  }

  if (err && !data) return <div className="notice err">{err}</div>;
  if (!data) return <p className="muted small">Loading orders…</p>;

  // A refresh that failed AFTER we already had a payload keeps the payload (losing
  // work in progress helps nobody) but must still SAY so — silence here reads as
  // "your change saved", which is exactly what it may not have done.
  const staleWarning = err ? (
    <div className="notice warn" style={{ marginBottom: 8 }}>
      Showing the last version we loaded — the refresh did not go through ({err}). Reload the page to be sure.
    </div>
  ) : null;

  const vendorOrder = (kind) => (
    <>
      {staleWarning}
      {/* The loan number prints in the mortgage clause, so it is THIS order's
          blocker — shown in the section that is blocked by it, not once at the
          top of a page the reader may never scroll to. */}
      {!data.file.hasLoanNumber && <LoanNumberEntry appId={appId} onSaved={reload} />}
      <OrderCard appId={appId} kind={kind} order={data.orders[kind]} file={data.file}
        canAccept={canAccept} onChanged={reload} />
    </>
  );

  if (only === 'title') return vendorOrder('title');
  if (only === 'insurance') return vendorOrder('insurance');
  // Inside the Appraisal section itself, this is the DESK STRIP only — the clock,
  // the owner, the due date and the note — sitting above the order builder exactly
  // as the attorney strip sits above the closing card. The full card (with the
  // vendor summary and the jump) is for the stacked view below, where the reader
  // is not already looking at the order.
  if (only === 'appraisal') {
    return (
      <>
        {staleWarning}
        <AppraisalOrderCard appId={appId} order={data.orders.appraisal} onChanged={reload} compact />
      </>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {staleWarning}
      {!data.file.hasLoanNumber && <LoanNumberEntry appId={appId} onSaved={reload} />}
      <div><h3 style={{ margin: '0 0 8px', color: '#141B22' }}>Title</h3>
        <OrderCard appId={appId} kind="title" order={data.orders.title} file={data.file} canAccept={canAccept} onChanged={reload} /></div>
      <div><h3 style={{ margin: '0 0 8px', color: '#141B22' }}>Insurance</h3>
        <OrderCard appId={appId} kind="insurance" order={data.orders.insurance} file={data.file} canAccept={canAccept} onChanged={reload} /></div>
      <div><h3 style={{ margin: '0 0 8px', color: '#141B22' }}>Appraisal</h3>
        <AppraisalOrderCard appId={appId} order={data.orders.appraisal} onChanged={reload} /></div>
      <div><h3 style={{ margin: '0 0 8px', color: '#141B22' }}>Attorney closing prep</h3>
        <ClosingPrepCard appId={appId} onChanged={reload} /></div>
      {/* FLOOD INSURANCE (owner-directed 2026-08-28): grayed until the flood
          zone is established — with the "this property is in a flood zone"
          switch right on the card. */}
      {data.orders.floodInsurance && (
        <div><h3 style={{ margin: '0 0 8px', color: '#141B22' }}>Flood insurance</h3>
          <FloodInsuranceCard appId={appId} card={data.orders.floodInsurance} onChanged={reload} /></div>
      )}
      {/* THE SETTLEMENT-AGENT ORDER (owner-directed 2026-08-28) — the New-York
          workflow. Present on NY files only; grayed with the full reason until
          the file's closing handling makes it live. */}
      {data.orders.settlement && (
        <div><h3 style={{ margin: '0 0 8px', color: '#141B22' }}>Settlement agent (New York)</h3>
          <SettlementOrderCard appId={appId} card={data.orders.settlement} onChanged={reload} /></div>
      )}
    </div>
  );
}

/* The flood card, SELF-LOADING — the second door (owner-directed 2026-08-28:
   "Two places: one in the flood condition and in the order center"). Mounted on
   the rtl_cond_flood_insurance condition row, it fetches the same panel payload
   and renders the SAME card — never a second copy of the rules. */
export function FloodInsuranceEntry({ appId }) {
  const [card, setCard] = useState(null);
  const load = () => api.staffOrders(appId)
    .then((d) => setCard((d.orders && d.orders.floodInsurance) || null))
    .catch(() => setCard(null));
  useEffect(() => { load(); }, [appId]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!card) return null;
  return <FloodInsuranceCard appId={appId} card={card} onChanged={load} />;
}

/* ════════════════════════════════════════════════════════════════════════════
   FLOOD INSURANCE (owner-directed 2026-08-28).

   The order is grayed until the flood zone is ESTABLISHED — by the appraisal's
   FEMA fields, a completed flood determination, or the manual switch on this
   card ("this property is in a flood zone"), which also attaches the
   flood-insurance condition through the engine's existing rule. Ordering asks
   who handles the flood policy: the DEFAULT is the file's own insurance agent,
   but only after an explicit confirm — a different agent is added under File
   contacts → Flood insurance. The email is the insurance order's flood twin:
   same mortgagee clause + loan number, asking for the binder or paid invoice.
   ════════════════════════════════════════════════════════════════════════════ */
function FloodInsuranceCard({ appId, card, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const placed = card.status !== 'not_ordered' && card.status !== 'cancelled';

  const flip = async (on) => {
    if (on && !(await askConfirm('Mark this property as sitting in a flood zone? That adds the flood-insurance condition to the file and opens this order.'))) return;
    setBusy(true); setMsg(null);
    try { await api.staffFloodZoneFlip(appId, on ? true : null); onChanged && onChanged(); }
    catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not update the flood zone.' }); }
    finally { setBusy(false); }
  };

  const place = async (force) => {
    setBusy(true); setMsg(null);
    const doPlace = async (body) => {
      try {
        const r = await api.staffPlaceFloodInsurance(appId, { ...(force ? { force: true } : {}), ...body });
        setMsg(r.unconfirmed
          ? { tone: 'warn', text: r.warning || 'The order may or may not have gone out — check the Email Center before re-sending.' }
          : { tone: 'ok', text: `Flood insurance ordered — sent to ${(r.sent_to || []).join(', ')}.` });
        onChanged && onChanged();
        return true;
      } catch (e) {
        if (e.data && e.data.code === 'contact' && e.data.insuranceAgent) {
          /* THE VERIFY-BEFORE-DEFAULT (the owner: "The default should be the same
             insurance agent, but it should verify before"). */
          const useSame = await askConfirm(
            `Use the file’s own insurance agent for the flood policy too? (${e.data.insuranceAgent.name || e.data.insuranceAgent.email}) — choose Cancel to add a different flood insurance contact under File contacts instead.`);
          if (useSame) return doPlace({ useInsuranceAgent: true });
          setMsg({ tone: 'warn', text: 'Add the flood insurance contact under File contacts → Flood insurance, then order.' });
          return false;
        }
        setMsg({ tone: 'err', text: (e.data && e.data.error) || e.message || 'Could not send the flood insurance order.' });
        return false;
      }
    };
    try { await doPlace({}); } finally { setBusy(false); }
  };

  const ZONE_WORDS = { manual: 'marked by your team', appraisal: 'per the appraisal’s FEMA fields', determination: 'per the flood determination' };
  return (
    <div className="panel" style={{ opacity: card.enabled ? 1 : 0.75 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ color: '#141B22' }}>Flood insurance order</b>
        {placed
          ? <span className="pill ok">Ordered{card.vendorName ? ` — ${card.vendorName}` : ''}</span>
          : card.enabled
            ? <span className="pill warn">Flood zone on file — ready to order</span>
            : <span className="pill mut">No flood zone established</span>}
        {card.inFloodZone && <span className="muted small">In a flood zone ({ZONE_WORDS[card.zoneSource] || card.zoneSource})</span>}
      </div>
      {!card.enabled && card.reason && (
        <div className="small" style={{ color: '#4B585C', marginTop: 6, padding: '6px 8px', border: '1px dashed #C9C2B2', borderRadius: 8 }}>{card.reason}</div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* The manual flip. Only the MANUAL flip can be un-flipped from here —
            a zone the appraisal or a determination proved is not silenced by hand. */}
        {!card.inFloodZone && (
          <button className="btn btn-line btn-sm" disabled={busy} onClick={() => flip(true)}>
            ⚑ This property IS in a flood zone
          </button>
        )}
        {card.inFloodZone && card.manualFlip && card.zoneSource === 'manual' && !placed && (
          <button className="btn ghost small" disabled={busy} onClick={() => flip(false)}
            title="Remove the manual mark — the file falls back to what the appraisal / determination says">
            Un-mark the manual flood-zone flag
          </button>
        )}
        {card.vendor
          ? <span className="muted small">Flood insurance contact: <b style={{ color: '#141B22' }}>{card.vendor.name || card.vendor.emails[0]}</b></span>
          : card.insuranceAgent
            ? <span className="muted small">No flood contact yet — ordering will offer the file’s insurance agent ({card.insuranceAgent.name || card.insuranceAgent.email}) first.</span>
            : <span className="muted small">No flood insurance contact yet — File contacts → Flood insurance.</span>}
      </div>
      {card.condition && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Returned documents belong on the <b style={{ color: '#141B22' }}>Flood insurance</b> condition ({card.condition.status}).
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {!placed && (
          <button className="btn primary small" disabled={!card.enabled || busy}
            title={card.enabled ? 'Order flood insurance — binder or paid invoice, same mortgagee clause as the regular insurance order' : (card.reason || 'Establish the flood zone first')}
            onClick={() => place(false)}>
            {busy ? 'Working…' : 'Order flood insurance'}
          </button>
        )}
        {placed && (
          <button className="btn ghost small" disabled={busy} onClick={() => place(true)}>Re-send the order</button>
        )}
        {msg && <span className="small" role={msg.tone === 'err' ? 'alert' : 'status'}
          style={msg.tone === 'err' ? { color: 'var(--danger)' } : msg.tone === 'warn' ? { color: '#8a6d3b' } : { color: '#4B585C' }}>{msg.text}</span>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   SETTLEMENT AGENT — NEW YORK (owner-directed 2026-08-28).

   In New York, title does not do the settlement, so the title order never asks
   title for the CPL, the wiring instructions or the preliminary settlement
   statement — a separate SETTLEMENT AGENT produces those. This card is that
   order. It exists on every NY file so the desk can SEE the workflow, but it is
   live only when the file's closing handling is "we close it in house": until
   then it renders grayed, with the exact reason printed on it (the owner: "if
   an option is disabled, it should always say why"), and its asks list shows as
   a DRAFT CONDITION — visible, gray, not a real condition yet.
   ════════════════════════════════════════════════════════════════════════════ */
function SettlementOrderCard({ appId, card, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const disabled = !card.enabled;
  const placed = card.status !== 'not_ordered' && card.status !== 'cancelled';

  const place = async (force) => {
    if (!(await askConfirm(`Engage ${card.vendor ? (card.vendor.name || 'the settlement agent') : 'the settlement agent'} for this New York closing? The order asks for their E&O certificate, the preliminary settlement statement and their wiring instructions.`))) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.staffPlaceSettlementOrder(appId, force ? { force: true } : {});
      setMsg(r.unconfirmed
        ? { tone: 'warn', text: r.warning || 'The order may or may not have gone out — check the Email Center before re-sending.' }
        : { tone: 'ok', text: `Settlement agent engaged — sent to ${(r.sent_to || []).join(', ')}.` });
      onChanged && onChanged();
    } catch (e) {
      setMsg({ tone: 'err', text: (e.data && e.data.error) || e.message || 'Could not send the settlement-agent order.' });
    } finally { setBusy(false); }
  };

  return (
    <div className="panel" style={{ opacity: disabled ? 0.75 : 1 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ color: '#141B22' }}>Settlement agent order</b>
        {placed
          ? <span className="pill ok">Engaged{card.vendorName ? ` — ${card.vendorName}` : ''}</span>
          : disabled
            ? <span className="pill mut">{card.dormant ? 'Prepped — not in use yet' : 'Not available'}</span>
            : <span className="pill warn">Ready to order</span>}
      </div>
      {disabled && card.reason && (
        <div className="small" style={{ color: '#4B585C', marginTop: 6, padding: '6px 8px', border: '1px dashed #C9C2B2', borderRadius: 8 }}>
          {card.reason}
        </div>
      )}
      {/* The DRAFT CONDITION container: what the agent will owe the file. Gray by
          design while dormant — "that condition should not even be a condition
          yet. It should be grayed out." */}
      <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8,
        border: `1px ${disabled ? 'dashed' : 'solid'} #C9C2B2`,
        color: disabled ? '#8B8574' : '#141B22', background: disabled ? 'transparent' : '#FBF9F4' }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {disabled ? 'Draft condition — not a condition yet' : 'What the settlement agent owes this file'}
        </div>
        <ul style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 13 }}>
          {(card.asks || []).map((a) => <li key={a}>{a}</li>)}
        </ul>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {card.vendor
          ? <span className="muted small">Settlement agent on file: <b style={{ color: '#141B22' }}>{card.vendor.name || card.vendor.emails[0]}</b>{card.vendor.emails.length ? ` (${card.vendor.emails.join(', ')})` : ''}</span>
          : <span className="muted small">No settlement agent contact on this file yet — add one under File contacts (type “settlement_agent”).</span>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {!placed && (
          <button className="btn primary small" disabled={disabled || busy || !card.vendor}
            title={disabled ? (card.reason || 'Not available on this file') : !card.vendor ? 'Add the settlement agent contact first' : 'Engage the settlement agent'}
            onClick={() => place(false)}>
            {busy ? 'Sending…' : 'Engage the settlement agent'}
          </button>
        )}
        {placed && (
          <button className="btn ghost small" disabled={disabled || busy} onClick={() => place(true)}>Re-send the engagement</button>
        )}
        {msg && <span className={`small ${msg.tone === 'err' ? '' : 'muted'}`} role={msg.tone === 'err' ? 'alert' : 'status'}
          style={msg.tone === 'err' ? { color: 'var(--danger)' } : msg.tone === 'warn' ? { color: '#8a6d3b' } : undefined}>{msg.text}</span>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   THE APPRAISAL ON THE ORDERS DESK (owner-directed 2026-08-05, re-confirmed
   2026-08-16).

   IT SHOWS AND TRACKS; IT DOES NOT ORDER. An appraisal is placed through one of
   three vendor APIs, each with its own credentials and its own hard-won placement
   path, and exactly ONE screen may talk to them — the Appraisal section. So this
   card carries the desk's half (the clock, the owner, the note, the history) and
   its main action OPENS that section rather than growing a second order builder
   that could drift out of step with the first.

   Everything under `order.vendor` is projected by the server
   (lib/appraisal-order-mirror.js), so this card needs no per-vendor branches: it
   renders the same way whether the appraisal was ordered from AppraisalScope /
   NAN, Class Valuation or Richer Values.
   ════════════════════════════════════════════════════════════════════════════ */
function AppraisalOrderCard({ appId, order, onChanged, compact = false }) {
  // The appraisal section is a <Section> on the same screen, so this is the file's
  // OWN jump — the one the conditions list and the closing card already use, which
  // opens a collapsed section and scrolls to it. Never a raw hash: a hash does not
  // open a section that is closed, so the button would appear to do nothing.
  const goToAppraisal = () => {
    try { goToSection((order && order.vendor && order.vendor.section) || 'sec-order-appraisal'); }
    catch (_) { /* a host without the section resolver simply stays put */ }
  };

  // Nothing ordered yet. In the appraisal section the builder is right below, so
  // saying "go to the appraisal section" there would point at itself.
  if (!order) {
    if (compact) return null;
    return (
      <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ color: '#4B585C', fontSize: 14 }}>
          No appraisal has been ordered on this file yet. Appraisals are ordered in the
          Appraisal section, where the form, the fee and the appraisal company are chosen —
          once one is placed it is tracked here with the other orders.
        </div>
        <div>
          <button className="btn ghost small" onClick={goToAppraisal}>Order an appraisal</button>
        </div>
      </div>
    );
  }

  const v = order.vendor || {};
  const money = (c) => (c == null ? null : `$${(Number(c) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  const docs = order.returnedDocs || [];
  const hasXml = docs.some((d) => d.doc_kind === 'appraisal_xml');
  const hasPdf = docs.some((d) => d.doc_kind === 'appraisal_pdf');
  // HOW IT IS BEING PAID FOR. Payment on an appraisal is manual by standing rule,
  // so the desk's job is to say which of the three ways somebody chose — and, when
  // it is one a person still has to carry out, that it is still waiting on them.
  // Absent until somebody has chosen: an order with no instruction must read as
  // "nobody has said yet", never as unpaid or as paid.
  const pay = (order.payment && order.payment.describe) || null;

  if (compact) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        <OrderTracking appId={appId} kind="appraisal" tracking={order.tracking} onChanged={onChanged} />
        <div className="muted small" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
          <span>Tracked on the Orders desk as an appraisal order</span>
          {v.name ? <span>· {v.name}</span> : null}
          {v.orderNumber ? <span>· their #{v.orderNumber}</span> : null}
          {v.feeCents != null ? <span>· {money(v.feeCents)}</span> : null}
          {pay ? <span>· {pay.head}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <OrderTracking appId={appId} kind="appraisal" tracking={order.tracking} onChanged={onChanged} />
      <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ color: '#141B22' }}>{v.name || 'Appraisal company'}</strong>
          <span className="pill" style={{ ...(STATUS_TONE[order.status] || {}) }}>
            {STATUS_LABEL[order.status] || order.status}
          </span>
          {v.vendorStatus ? <span className="muted small">their status: {v.vendorStatus}</span> : null}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 22px', fontSize: 14, color: '#4B585C' }}>
          {v.orderNumber ? <span>Their order&nbsp;#<span style={{ color: '#141B22' }}>{v.orderNumber}</span></span> : null}
          {v.product ? <span>Form&nbsp;<span style={{ color: '#141B22' }}>{v.product}</span></span> : null}
          {v.feeCents != null ? <span>Fee&nbsp;<span style={{ color: '#141B22' }}>{money(v.feeCents)}</span></span> : null}
          {order.orderedAt ? <span>Ordered&nbsp;<span style={{ color: '#141B22' }}>{fmtDay(order.orderedAt)}</span></span> : null}
        </div>

        {/* PAYMENT. Three readings, and they must not look alike: paid, chosen but
            still on somebody's list, and nobody has said yet. */}
        <div style={{ fontSize: 13.5, color: '#4B585C' }}>
          {pay ? (
            <>
              <span style={{ color: pay.settled ? '#1E7B4F' : '#9A3412', fontWeight: 600 }}>
                {pay.head}
              </span>
              {pay.awaitingBackOffice ? <span> — waiting on the back office</span> : null}
              {order.payment.chosen_by_name ? (
                <span className="muted small"> · chosen by {order.payment.chosen_by_name}</span>
              ) : null}
            </>
          ) : (
            <span className="muted">Nobody has said how this one is being paid yet.</span>
          )}
        </div>

        {/* WHAT IS BACK. The two documents file themselves into the appraisal
            condition's own slots, so this says whether each has arrived rather than
            offering a classification step there is no need for. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 13.5 }}>
          <span style={{ color: hasPdf ? 'var(--ok, #1E5E3C)' : '#6E7A7E' }}>
            {hasPdf ? '✓' : '○'} Report (PDF)
          </span>
          <span style={{ color: hasXml ? 'var(--ok, #1E5E3C)' : '#6E7A7E' }}>
            {hasXml ? '✓' : '○'} Data file (XML)
          </span>
          {docs.length ? <span className="muted small">— filed on the appraisal condition</span> : null}
        </div>

        {v.lastError ? (
          <div className="notice warn" style={{ margin: 0 }}>
            The appraisal company last reported: {v.lastError}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn ghost small" onClick={goToAppraisal}>Open the appraisal order</button>
        </div>
        <div className="muted small">
          Messages, revisions, documents and cancelling this order all live in the Appraisal
          section — there is one place that talks to the appraisal company, so nothing here
          can disagree with it.
        </div>
      </div>
    </div>
  );
}
