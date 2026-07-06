import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import MessageThread from '../components/MessageThread.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import DealSnapshot from '../components/DealSnapshot.jsx';
import EditFileDetails from '../components/EditFileDetails.jsx';
import ToolModal from '../components/ToolModal.jsx';

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
function Completeness({ app, borrower }) {
  const checks = [
    ['Property address', !!(app.property_address && (app.property_address.oneLine || app.property_address.street))],
    ['Property type', !!app.property_type],
    ['Program', !!app.program],
    ['Loan type', !!app.loan_type],
    ['Purchase price', app.purchase_price != null],
    ['ARV', app.arv != null],
    ['Rehab budget', app.rehab_budget != null],
    ['Borrower phone', !!(borrower && borrower.cell_phone)],
    ['Date of birth', !!(borrower && borrower.date_of_birth)],
    ['SSN on file', !!(borrower && borrower.ssn_last4)],
    ['FICO', !!(borrower && borrower.fico)],
    ['Citizenship', !!(borrower && borrower.citizenship)],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  const missing = checks.filter(([, ok]) => !ok);
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3>Application completeness</h3>
        <div className="spacer" />
        <span className={`pill ${missing.length ? '' : 'done'}`}>{done}/{checks.length} complete</span>
      </div>
      {missing.length === 0
        ? <p className="muted small">Everything the application asks for has been provided.</p>
        : (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {missing.map(([label]) => (
              <span key={label} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}>Missing: {label}</span>
            ))}
          </div>
        )}
    </div>
  );
}

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const kb = (n) => n == null ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
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

function Item({ it, team, onPatch }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(it.notes || '');
  const signed = !!it.signed_off_at;
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

      <div className="row" style={{ width: '100%', gap: 8, flexWrap: 'wrap' }}>
        <select className="input" style={{ maxWidth: 150 }} value={it.status}
          onChange={e => onPatch(it.id, { status: e.target.value })}>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 180 }} value={it.assignee_staff_id || ''}
          onChange={e => onPatch(it.id, { assigneeStaffId: e.target.value || null })}>
          <option value="">Unassigned</option>
          {team.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
        </select>
        {signed
          ? <button className="btn ghost" onClick={() => onPatch(it.id, { signedOff: false })}>Undo sign-off</button>
          : <button className="btn primary" onClick={() => onPatch(it.id, { signedOff: true })}>Sign off</button>}
      </div>
      <div className="row" style={{ width: '100%', gap: 8 }}>
        <input className="input" placeholder="Add a note…" value={notes} onChange={e => setNotes(e.target.value)} />
        <button className="btn ghost" onClick={() => onPatch(it.id, { notes })}>Save note</button>
      </div>
    </div>
  );
}

/* The borrower's conditions, as staff see them: the same single list the
   borrower works through (Scope of Work, track record, contacts, ID, document
   slots), with every uploaded PDF inline and full sign-off capability — a
   separate section from the internal phase-by-phase checklist. */
function BorrowerConditions({ appId, app, items, docs, onPatch, onReviewDoc, onDownloadDoc, dlBusy }) {
  const [sowOpen, setSowOpen] = useState(null);   // itemId of the SOW being edited
  const [card, setCard] = useState(null);         // decrypted appraisal card (revealed on demand)
  const [cardBusy, setCardBusy] = useState(false);
  const borrowerItems = items.filter(it => it.audience === 'borrower' || it.audience === 'both');
  const ppItem = borrowerItems.find(it => it.tool_key === 'product_pricing');
  const sowItem = borrowerItems.find(it => it.tool_key === 'rehab_budget');
  const trItem = borrowerItems.find(it => it.tool_key === 'track_record');
  const contactItems = borrowerItems.filter(it => ['title_contact', 'insurance_contact'].includes(it.tool_key));
  const cardItem = borrowerItems.find(it => it.tool_key === 'appraisal_card');
  const idItem = borrowerItems.find(it => it.template_code === 'rtl_p1_id');
  const lead = [ppItem, sowItem, trItem, ...contactItems, cardItem, idItem].filter(Boolean);
  const rest = borrowerItems.filter(it => !lead.includes(it) && !it.tool_key);
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

  if (ordered.length === 0) return null;
  return (
    <div className="panel" style={{ marginTop: 18, borderColor: 'var(--gold)' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3>Borrower conditions</h3>
        <div className="spacer" />
        <span className="muted small">{signedCount}/{ordered.length} signed off</span>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        The conditions list exactly as the borrower sees it — with each condition's uploaded documents and sign-off.
      </p>
      {ordered.map(it => {
        const itemDocs = docsFor(it.id);
        const signed = !!it.signed_off_at;
        const done = signed || it.status === 'satisfied' || it.status === 'received';
        return (
          <div className="checkitem" key={it.id} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
            <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
              <span className={`dot ${signed || it.status === 'satisfied' ? 'done' : 'outstanding'}`} style={{ marginTop: 4, ...(it.status === 'issue' ? { background: 'var(--danger)' } : {}) }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{it.label}</div>
                <div className="muted small">
                  {it.tool_key === 'rehab_budget' ? `Scope of Work builder${app.rehab_budget != null ? ` · total ${money(app.rehab_budget)}` : ''}`
                    : it.tool_key === 'track_record' ? 'Verified from the borrower\'s general track record (panel below)'
                    : it.tool_key === 'product_pricing' ? (app.registered_program ? `Registered · ${app.registered_program === 'gold' ? 'Gold Standard' : 'Standard'} · ${money(app.registered_total_loan)}` : 'No product registered yet')
                    : it.tool_key === 'appraisal_card' ? 'Card for ordering the appraisal (reveal is audited)'
                    : ['title_contact', 'insurance_contact'].includes(it.tool_key) ? 'Contact information form'
                    : it.item_kind}
                  {` · ${it.status}`}
                  {signed && ` · signed off by ${it.signed_off_name || 'the internal team'}`}
                </div>
                {it.tool_key === 'appraisal_card' && card && (
                  <div className="small" style={{ marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                    {card.brand} <strong>{card.number.replace(/(\d{4})(?=\d)/g, '$1 ')}</strong> · exp {String(card.expMonth).padStart(2, '0')}/{card.expYear} · CVC {card.cvc} · ZIP {card.zip}
                  </div>
                )}
              </div>
              {it.tool_key === 'rehab_budget' && (
                <button className="btn ghost small" onClick={() => setSowOpen(it.id)}>Open Scope of Work</button>
              )}
              {it.tool_key === 'appraisal_card' && (
                <button className="btn ghost small" disabled={cardBusy} onClick={revealCard}>
                  {cardBusy ? '…' : card ? 'Hide card' : 'Reveal card'}
                </button>
              )}
              {signed
                ? <button className="btn ghost small" onClick={() => onPatch(it.id, { signedOff: false })}>Undo sign-off</button>
                : <button className="btn primary small" onClick={() => onPatch(it.id, { signedOff: true })}>Sign off</button>}
            </div>
            {itemDocs.length > 0 && (
              <div style={{ width: '100%', paddingLeft: 20 }}>
                {itemDocs.map((d, i) => {
                  const rs = d.review_status || 'pending';
                  return (
                    <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                      <span className="muted small" style={{ minWidth: 90 }}>{d.slot_label || (d.source_type === 'system' ? 'Tool export' : `Document ${i + 1}`)}</span>
                      <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                      <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                      <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => onDownloadDoc(d)}>{dlBusy === d.id ? '…' : 'Download'}</button>
                      {rs !== 'accepted' && <button className="btn primary small" onClick={() => onReviewDoc(d, 'accept')}>Accept</button>}
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
          url={`/tools/rehab-budget.html?app=${appId}&item=${sowOpen}&internal=1`}
          onClose={() => setSowOpen(null)} />
      )}
    </div>
  );
}

export default function StaffApplication() {
  const { id } = useParams();
  const nav = useNavigate();
  const { role } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
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
  const [newDoc, setNewDoc] = useState('');
  const [newCond, setNewCond] = useState('');
  const [conds, setConds] = useState([]);
  const [gating, setGating] = useState(null);
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
    // This component is reused across /staff/app/:id changes — clear the old
    // file's data or it renders under the new file's URL until the fetch lands.
    setApp(null); setItems([]); setDocs([]); setConds([]); setBorrower(null); setGating(null); setErr(''); setMsg('');
    load();
    /* eslint-disable-next-line */
  }, [id]);

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
    catch (e) { setErr(e.message || 'Update failed'); }
  }
  async function downloadDoc(doc) {
    setDlBusy(doc.id);
    try { const { blob, filename } = await api.staffDownloadDoc(doc.id); saveBlob(blob, filename || doc.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }
  async function reviewDoc(doc, action) {
    if (busyAct) return;
    let reason;
    if (action === 'reject') {
      reason = window.prompt('Why is this document being rejected? The borrower will see this and can upload a new version.');
      if (reason == null || !reason.trim()) return;
    }
    setBusyAct('review');
    try {
      await api.staffReviewDoc(doc.id, action, reason);
      flash(action === 'accept' ? 'Document accepted ✓' : 'Document rejected — the borrower was notified.');
      await load();
    } catch (e) { setErr(e.message || 'Could not review the document'); }
    finally { setBusyAct(''); }
  }
  async function deleteApp() {
    const reason = window.prompt('Delete this file? It will be removed from all borrower and internal views (recoverable by an admin). Optional reason:');
    if (reason === null) return;
    try { await api.staffDeleteApp(id, reason || undefined); nav('/internal'); }
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
  async function requestDoc() {
    if (!newDoc.trim() || busyAct) return;   // double-Enter created duplicate items
    setBusyAct('request');
    try { await api.staffRequestDoc(id, { label: newDoc.trim(), audience: 'borrower' }); setNewDoc(''); flash('Requested ✓'); await load(); }
    catch (e) { setErr(e.message || 'Failed'); }
    finally { setBusyAct(''); }
  }
  async function addLoanCondition() {
    if (!cForm.title.trim()) return;
    try {
      await api.staffAddLoanCondition(id, {
        title: cForm.title.trim(),
        borrowerTitle: cForm.audience !== 'staff' ? cForm.title.trim() : undefined,
        audience: cForm.audience, severity: cForm.severity,
      });
      setCForm({ title: '', audience: 'staff', severity: 'standard' }); flash('Condition added ✓'); await load();
    } catch (e) { setErr(e.message || 'Could not add condition'); }
  }
  async function clearCond(cid) { try { await api.staffClearCondition(cid); flash('Cleared ✓'); await load(); } catch (e) { setErr(e.message); } }
  async function waiveCond(cid) { const r = window.prompt('Waive this condition — reason (required):'); if (!r) return; try { await api.staffWaiveCondition(cid, r); flash('Waived ✓'); await load(); } catch (e) { setErr(e.message); } }
  async function addCondition() {
    if (!newCond.trim()) return;
    try { await api.staffAddCondition(id, { label: newCond.trim(), audience: 'staff' }); setNewCond(''); flash('Added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Failed'); }
  }

  const [itemFilter, setItemFilter] = useState('all');
  const bucketOf = (s) => s === 'issue' ? 'rejected' : s === 'received' ? 'submitted' : s === 'satisfied' ? 'satisfied' : 'outstanding';
  const phases = useMemo(() => {
    const groups = {};
    const src = itemFilter === 'all' ? items : items.filter(it => bucketOf(it.status) === itemFilter);
    for (const it of src) { const k = it.phase || 'general'; (groups[k] = groups[k] || []).push(it); }
    return Object.entries(groups)
      .map(([k, arr]) => [k, arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))])
      .sort((a, b) => (a[1][0].sort_order || 0) - (b[1][0].sort_order || 0));
  }, [items, itemFilter]);

  if (err && !app) return <div className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;
  const processors = team.filter(m => m.role === 'processor');
  const officers = team.filter(m => ['loan_officer', 'admin', 'super_admin'].includes(m.role));
  const procName = (team.find(m => m.id === app.processor_id) || {}).full_name;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/internal" className="btn link">← Pipeline</Link>
        <div className="spacer" />
        {isAdmin && <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} onClick={deleteApp} title="Admin: delete this file">Delete file</button>}
        <span className={`pill ${app.status}`}>{app.status}</span>
      </div>
      <h1 style={{ marginBottom: 4 }}>{app.first_name} {app.last_name} · {addrLine(app.property_address)}</h1>
      <p className="muted small" style={{ marginBottom: 12 }}>{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}</p>
      <DealSnapshot app={app} gating={gating} />
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
        <button className="btn ghost" onClick={jumpToChat}>💬 Message</button>
        <button className="btn ghost" onClick={nudge} disabled={busyAct === 'nudge'} title="Email the borrower a reminder of their outstanding items">🔔 Remind</button>
        <button className="btn primary" onClick={inviteBorrower} disabled={inviteBusy}
          title="Email the borrower an invite to join this file in the portal">
          {inviteBusy ? 'Sending…' : 'Invite borrower'}
        </button>
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

      {msg && <div className="notice ok">{msg}</div>}
      {err && app && <div className="notice err">{err}</div>}

      <PropertyPhoto address={addrLine(app.property_address) !== '—' ? addrLine(app.property_address) : ''} />

      <div className="grid cols-2">
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Borrower</h3>
          {borrower ? <>
            <div className="metrow"><span className="k">Name</span><span className="v">{borrower.first_name} {borrower.last_name}</span></div>
            <div className="metrow"><span className="k">Email</span><span className="v">{borrower.email || '—'}</span></div>
            <div className="metrow"><span className="k">Phone</span><span className="v">{borrower.cell_phone || '—'}</span></div>
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
          </> : <p className="muted small">Loading borrower…</p>}
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Loan & assignment</h3>
          <div className="metrow"><span className="k">Property</span><span className="v">{app.property_type || '—'}{app.units ? ` · ${app.units} unit${app.units > 1 ? 's' : ''}` : ''}</span></div>
          <div className="metrow"><span className="k">Entity</span><span className="v">{app.entity_name || (app.llc_id ? 'LLC on file' : '—')}</span></div>
          <div className="metrow"><span className="k">Purchase</span><span className="v">{money(app.purchase_price)}</span></div>
          {app.is_assignment && <>
            <div className="metrow"><span className="k">Assignment</span><span className="v" style={{ color: 'var(--teal)' }}>Yes</span></div>
            <div className="metrow"><span className="k">Underlying price</span><span className="v">{money(app.underlying_contract_price)}</span></div>
            <div className="metrow"><span className="k">Assignment fee</span><span className="v">{money(app.assignment_fee)}</span></div>
          </>}
          <div className="metrow"><span className="k">As-is</span><span className="v">{money(app.as_is_value)}</span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(app.loan_amount)}</span></div>
          <div className="metrow"><span className="k">Loan officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}</span></div>
          <div className="metrow"><span className="k">Processor</span><span className="v">{procName || '—'}</span></div>
          <div className="gold-rule" style={{ margin: '10px 0' }} />
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
        </div>
      </div>

      <Completeness app={app} borrower={borrower} />

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
          <h3>Checklist</h3>
          <div className="spacer" />
          <select className="input" style={{ maxWidth: 160 }} value={itemFilter} onChange={e => setItemFilter(e.target.value)}>
            <option value="all">All ({items.length})</option>
            <option value="outstanding">Outstanding</option>
            <option value="submitted">Submitted (in review)</option>
            <option value="rejected">Needs attention</option>
            <option value="satisfied">Satisfied</option>
          </select>
          <span className="muted small">{items.filter(i => i.signed_off_at).length}/{items.length} signed off</span>
        </div>
        {phases.length === 0
          ? <p className="muted small">No checklist items yet.</p>
          : phases.map(([k, arr]) => (
            <div key={k} style={{ marginTop: 10 }}>
              <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{phaseName(k)}</div>
              {arr.map(it => <Item key={it.id} it={it} team={team} onPatch={patch} />)}
            </div>
          ))}
      </div>

      <BorrowerConditions appId={id} app={app} items={items} docs={docs}
        onPatch={patch} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc} dlBusy={dlBusy} />

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Documents</h3>
          <div className="spacer" />
          <span className="muted small">{docs.length} uploaded</span>
        </div>
        {docs.length === 0
          ? <p className="muted small">No documents uploaded yet. Request one below and the borrower will see it on their checklist.</p>
          : docs.map(d => {
            const rs = d.review_status || 'pending';
            const tone = rs === 'accepted' ? 'done' : rs === 'rejected' ? '' : 'outstanding';
            const pillStyle = rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' }
              : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
              : rs === 'superseded' ? { opacity: .6 } : { borderColor: 'var(--gold)', color: 'var(--gold)' };
            return (
            <div className="checkitem" key={d.id} style={{ alignItems: 'flex-start', flexWrap: 'wrap', opacity: d.is_current ? 1 : .6 }}>
              <span className={`dot ${tone}`} style={{ marginTop: 4 }} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{d.filename} {!d.is_current && <span className="muted small">· old version</span>}</div>
                <div className="muted small">
                  {kb(d.size_bytes)} · {d.item_label ? `${d.item_label} · ` : ''}uploaded by {d.uploaded_by_kind} · {new Date(d.created_at).toLocaleDateString()}
                </div>
                {rs === 'rejected' && d.rejection_reason && <div className="small" style={{ color: 'var(--danger)', marginTop: 2 }}>Rejected: {d.rejection_reason}</div>}
                {d.reviewed_by_name && <div className="muted small">Reviewed by {d.reviewed_by_name}</div>}
              </div>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span className="pill" style={pillStyle}>{rs}</span>
                <button className="btn ghost" disabled={dlBusy === d.id} onClick={() => downloadDoc(d)}>
                  {dlBusy === d.id ? '…' : 'Download'}
                </button>
                {d.is_current && rs !== 'accepted' && <button className="btn primary" onClick={() => reviewDoc(d, 'accept')}>Accept</button>}
                {d.is_current && rs !== 'rejected' && <button className="btn ghost" onClick={() => reviewDoc(d, 'reject')}>Reject</button>}
              </div>
            </div>
            );
          })}
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="panel">
          <h3 style={{ marginBottom: 8 }}>Request a document (borrower)</h3>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" placeholder="e.g. Updated bank statement" value={newDoc}
              onChange={e => setNewDoc(e.target.value)} onKeyDown={e => e.key === 'Enter' && requestDoc()} />
            <button className="btn primary" onClick={requestDoc} disabled={busyAct === 'request'}>Request</button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>Appears on the borrower's checklist and notifies them.</p>
        </div>
        <div className="panel">
          <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
            <h3>Conditions</h3>
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
                      {c.waive_reason ? ` · ${c.waive_reason}` : ''}
                    </div>
                  </div>
                  {open && <button className="btn ghost small" onClick={() => clearCond(c.id)}>Clear</button>}
                  {open && isAdmin && <button className="btn link small" onClick={() => waiveCond(c.id)}>Waive</button>}
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
      </div>

      <EditFileDetails app={app} onSaved={load} />
      {app.borrower_id && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
            <h3>Track record &amp; experience</h3>
            <div className="spacer" />
            <span className="muted small">The borrower's live record — add, edit, verify, and attach docs. Changes save automatically.</span>
          </div>
          <iframe
            title="Borrower track record"
            src={`/tools/track-record.html?internal=1&borrower=${app.borrower_id}&embed=1`}
            style={{ width: '100%', height: 640, border: '1px solid var(--line, rgba(127,169,176,.25))', borderRadius: 10, background: 'transparent' }}
          />
        </div>
      )}
      <ProductStudioPanel appId={id} app={app} onRegistered={load} mode="staff" />
      {app.status === 'funded' && <PostClosing appId={id} />}
      <TprExport appId={id} />
      <ChatPanel appId={id} onTaskCreated={load} />
      <ActivityFeed fetcher={activityFetcher} title="File activity" />
    </>
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
    try { const { blob, filename } = await api.staffTprExport(appId); saveBlob(blob, filename || 'TPR_export.zip'); }
    catch (e) { alert(e.message || 'Export failed'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3>TPR / clean-file export</h3>
        <div className="spacer" />
        <button className="btn primary" onClick={download} disabled={busy || !prev || prev.includedCount === 0}>
          {busy ? 'Building…' : 'Export clean file (ZIP)'}
        </button>
      </div>
      {!prev ? <p className="muted small">Checking readiness…</p> : (
        <>
          <p className="muted small">{prev.includedCount} accepted document{prev.includedCount === 1 ? '' : 's'} will be included (rejected & superseded files are excluded).</p>
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

function ChatPanel({ appId, onTaskCreated }) {
  const [channel, setChannel] = useState('borrower');
  const internal = channel === 'internal';
  return (
    <div className="panel" id="conversations" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 10, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Conversations</h3>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn ${!internal ? 'primary' : 'ghost'}`} onClick={() => setChannel('borrower')}>Borrower</button>
          <button className={`btn ${internal ? 'primary' : 'ghost'}`} onClick={() => setChannel('internal')}>Team (internal)</button>
        </div>
      </div>
      {/* Key by app id AND channel: this panel survives /staff/app/:id changes,
          and without the id in the key the previous file's thread kept showing. */}
      <MessageThread key={`${appId}:${channel}`} mine="staff" bare
        header={<span />}
        hint={internal
          ? 'Internal channel — loan officer, processor, underwriting and admin only. The borrower can never see these messages. Tick the box to also save a message as a task on the file.'
          : 'This thread is shared with the borrower.'}
        taskOption={internal}
        fetchMessages={() => api.staffMessages(appId, channel)}
        downloadAttachment={(docId) => api.staffDownloadDoc(docId)}
        react={(mid, emoji) => api.staffReact(mid, emoji)}
        pin={(mid) => api.staffPinMessage(mid)}
        edit={(mid, body) => api.staffEditMessage(mid, body)}
        del={(mid) => api.staffDeleteMessage(mid)}
        fetchMentionables={() => api.staffMentionables(appId)}
        onOpenApplication={(id) => { window.location.hash = '#/internal/app/' + id; }}
        send={async (body, opts) => {
          const r = await api.staffPostMessage(appId, body, {
            channel, makeTask: internal && opts?.makeTask, attachment: opts?.attachment,
            entityRefs: opts?.entityRefs });   // was dropped — staff # mentions saved as plain text
          if (r && r.taskId && onTaskCreated) onTaskCreated();
          return r;
        }} />
    </div>
  );
}
