import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { showMessage, askConfirm, askPrompt } from '../lib/dialog.js';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { ENTITY_TYPES, describeEntity, titlesFor, subtypesFor, hasSubtypes } from '../lib/entityType.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { fileToBase64 } from '../lib/files.js';
import { onFilesDropped } from '../lib/drop-files.js';
import { fmtDay, dayInputValue } from '../lib/dates.js';
import { formatSSN, cleanFICO, ficoValid } from '../lib/validators.js';
import { moneyNum } from '../lib/money.js';
import { useAuth } from '../lib/auth.jsx';
import { ESIGN_RETURN_MSG } from '../lib/esign.js';
import { canOverride, isCompletion, askOverride, overrideLine } from '../lib/condition-override.js';
import { subscribeChat } from '../lib/chatEvents.js';
import ChatThread from '../components/ChatThread.jsx';
import { NewChatModal } from './StaffChat.jsx';
import PropertyPhoto from '../components/PropertyPhoto.jsx';
import StaffPropertyWorkbench from './StaffPropertyWorkbench.jsx';
import ExperienceHeader from '../components/track-record/ExperienceHeader.jsx';
import RecordLedger from '../components/track-record/RecordLedger.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import DocumentsPanel from '../components/DocumentsPanel.jsx';
import EmailCenter from '../components/EmailCenter.jsx';
import ProductStudioPanel from '../components/ProductStudioPanel.jsx';
import InvestorGuidelinesPanel from '../components/InvestorGuidelinesPanel.jsx';
import DealSnapshot from '../components/DealSnapshot.jsx';
import NoteBuyerCard from '../components/NoteBuyerCard.jsx';
import PayoffCard from '../components/PayoffCard.jsx';
import { payoffApplies, payoffMissingKeys } from '../lib/payoff.js';
import { sizesOnAsIsValue } from '../lib/dealBasis.js';
import WhatsLeftPanel from '../components/WhatsLeftPanel.jsx';
import LoanProgress from '../components/LoanProgress.jsx';
import ClosingPanel from '../components/ClosingPanel.jsx';
import TapeQuestionsModal from '../components/TapeQuestionsModal.jsx';
import TapeSendModal from '../components/TapeSendModal.jsx';
import FileOverviewSlideOver from '../components/FileOverviewSlideOver.jsx';
import { CreditCondition } from '../components/CreditReport.jsx';
import SubmitFilePanel from '../components/SubmitFilePanel.jsx';
import FileNotificationOverrides from '../components/FileNotificationOverrides.jsx';
import BorrowerViewButton from '../components/BorrowerViewButton.jsx';
import { PhoneInput, ZipInput , EmailInput} from '../components/FormattedInputs.jsx';
import EditFileDetails from '../components/EditFileDetails.jsx';
import ToolModal from '../components/ToolModal.jsx';
import FileSections, { Section, InfoTip, subscribeConditionsTab, goToSection, requestOpenSection, requestConditionsTab, requestAppDetailTab, subscribeAppDetailTab, setSectionResolver, revealAnchor } from '../components/FileSections.jsx';
import { STATIONS, STATION_OF, ANCHOR_SECTION, stationOf, resolveSection, whereDidItGo } from '../lib/stations.js';
import { captureScrollAnchor, keepAnchored, keepTabPlace, parkScroll, restoreScrollAnchor, unparkScroll, nearestFileSectionId } from '../lib/keep-scroll.js';
import { readStation, readSection, writeStation, savePlace } from '../lib/file-place.js';
import BorrowerProfilePanel from '../components/BorrowerProfilePanel.jsx';
import { CONDITION_TIMINGS, conditionStatusLabel, conditionStatusClass, timingLabel, loanConditionStatusLabel, audienceStamp, audienceLabel } from '../lib/conditions-vocab.js';
import { severityCount } from '../lib/findings-vocab.js';
import { groupBySubject, subjectOf } from '../lib/condition-subjects.js';
import { isWorkflowStep } from '../lib/condition-workflow-steps.js';
import ConditionActions, { DocActions } from '../components/ConditionActions.jsx';
import ConditionLine, { ConditionNote, NoteBuyerMark, ConditionCollapse } from '../components/ConditionLine.jsx';
import UspsAddressVerification from '../components/UspsAddressVerification.jsx';
import { canComplete, canDeleteDoc } from '../lib/condition-actions.js';
import EsignFileSection from '../components/EsignFileSection.jsx';
import ExceptionRegisterCard from '../components/ExceptionRegisterCard.jsx';
import GuarantyWaiverCard from '../components/GuarantyWaiverCard.jsx';
import RateTermCashCard from '../components/RateTermCashCard.jsx';
import OrdersPanel, { OrderModal } from '../components/OrdersPanel.jsx';
import AppraisalPanel from '../components/AppraisalPanel.jsx';
import AppraisalOrderSection from '../components/AppraisalOrderSection.jsx';
import AppraisalCardEntry from '../components/AppraisalCardEntry.jsx';
import UnderwritingPanel from '../components/UnderwritingPanel.jsx';
import EncompassSyncPanel from '../components/EncompassSyncPanel.jsx';
import AddConditionPanel from '../components/AddConditionPanel.jsx';
import { strayConditionReason, strayConfirmText } from '../lib/conditionLabel.js';
import StaffChangeRequests from '../components/StaffChangeRequests.jsx';
import FileContacts from '../components/FileContacts.jsx';
import DocPreview from '../components/DocPreview.jsx';
import ReminderModal from '../components/ReminderModal.jsx';
import FileTasksPanel from '../components/FileTasksPanel.jsx';
import DraftingPanel from '../components/DraftingPanel.jsx';
import LlcManager, { US_STATES } from '../components/LlcManager.jsx';
import { fullNameOf } from '../lib/personName.js';
import LoudHint from '../components/LoudHint.jsx';

/* A closing-date <input type="date"> that DOESN'T fight the typist.
 * The old input saved on every onChange and reloaded the file — but a date
 * input fires change with each intermediate value while you type the year
 * (0002 → 0020 → 0202 → 2026), and the reload reset focus, so "you can't even
 * type in dates." This holds a local draft, saves only on blur/Enter, and only
 * when the value is a real complete date (or cleared) — never mid-type. */
function ClosingDateField({ value, onSave }) {
  const [draft, setDraft] = useState(dayInputValue(value));
  useEffect(() => { setDraft(dayInputValue(value)); }, [value]);
  const commit = () => {
    const cur = dayInputValue(value);
    if (draft === cur) return;                                   // unchanged
    if (draft && !/^\d{4}-\d{2}-\d{2}$/.test(draft)) return;      // incomplete → ignore
    if (draft && Number(draft.slice(0, 4)) < 1900) return;        // mid-type year → ignore
    onSave(draft || null);
  };
  return (
    <input className="input" type="date" value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

/* The inline DOB row that used to live here is gone — the shared
   shared BorrowerProfilePanel (components/BorrowerProfilePanel.jsx) now owns
   date of birth along with every other borrower field, for the primary AND the
   co-borrower. Keeping a second DOB editor here would be exactly the per-surface
   drift that left the co-borrower uneditable in the first place. */

/* The note buyer (applications.lender) as it appears on the staff ClickUp panel —
 * READ-ONLY, with a link to the file's Note buyer panel, which is where it is
 * changed (owner-directed 2026-07-27).
 *
 * This used to BE the editor: a pencil icon on a muted line, inside a panel about
 * ClickUp sync, hidden behind the "Pipeline details" toggle — the unclear path the
 * owner reported. Changing the note buyer attaches and retracts conditions, can turn
 * on the 5% Scope-of-Work contingency and raise the bank-statement count, so it now
 * happens in ONE place that explains itself, and this line just shows the value and
 * points there. Do not put a second editor back here.
 *
 * STAFF-ONLY — the note buyer name is never shown to a borrower. */
function NoteBuyerRef({ value }) {
  // revealAnchor: the slot lives on the Overview room — from another room the
  // resolver switches rooms first, then scrolls (Seven Rooms, Phase 1).
  const jump = () => { revealAnchor('note-buyer-slot', { block: 'center' }); };
  return (
    <span className="muted small" title="Note buyer / capital partner — internal only, never shown to the borrower">
      Note buyer: <b>{value || '—'}</b>
      <button type="button" className="btn link small" style={{ marginLeft: 4 }} onClick={jump}
        title="Open the Note buyer panel on this file, where you can change it and see what changing it does">
        {value ? 'change ↑' : 'set it ↑'}
      </button>
    </span>
  );
}

/* Inline entry rendered directly ON the "note buyer missing" internal condition
   so staff can set the note buyer right from the condition (owner-directed
   2026-07-20). Saving posts the note buyer, which re-runs the condition engine
   server-side and retracts the condition. STAFF-ONLY — the name never reaches a
   borrower. */
function CondNoteBuyerEntry({ appId, onSaved }) {
  const [draft, setDraft] = useState('');
  const [opts, setOpts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const listId = useMemo(() => 'nbc-' + Math.random().toString(36).slice(2), []);
  useEffect(() => {
    let live = true;
    api.get('/api/staff/note-buyers').then((r) => { if (live) setOpts((r && r.noteBuyers) || []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  async function save() {
    const v = draft.trim(); if (!v) return;
    setBusy(true); setErr('');
    try { await api.post(`/api/staff/applications/${appId}/complete-fields`, { lender: v }); if (onSaved) await onSaved(); }
    catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }
  return (
    <div className="row" style={{ gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input className="input small" style={{ maxWidth: 220 }} list={listId} placeholder="Pick or type a note buyer…"
        value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      <datalist id={listId}>{opts.map((o) => <option key={o.value || o.label} value={o.label} />)}</datalist>
      <button className="btn primary small" onClick={save} disabled={busy || !draft.trim()}>{busy ? '…' : 'Set note buyer'}</button>
      {/* The note buyer's home is the Note buyer panel on the overview — it shows what
          each one requires and what switching changes. This quick entry stays (it is
          owner-directed, 2026-07-20), but it now says where the full view lives. */}
      <button type="button" className="btn link small"
        onClick={() => revealAnchor('note-buyer-slot', { block: 'center' })}
        title="Open the Note buyer panel, which shows what each note buyer requires on this file">
        see what each one requires ↑
      </button>
      {err && <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>}
    </div>
  );
}

/* Inline entry ON the "loan number missing" internal condition. Posts to the
   dedicated /loan-number endpoint, which enforces the YSCAP format and
   cross-file/ClickUp uniqueness (a duplicate is rejected here and parked to
   manual review). Filling it retracts the condition. STAFF-ONLY. */
/* The loan-number box ON the "loan number missing" condition. It is the SAME
   control Application details carries (LoanNumberEntry) — this used to be a
   second, near-identical implementation with its own input, its own save and its
   own error line, which is exactly how two write paths drift apart. Here it opens
   straight into the box (the condition already says the number is missing) and
   carries no label column of its own. */
function CondLoanNumberEntry({ appId, onSaved }) {
  return <LoanNumberEntry appId={appId} value={null} onSaved={onSaved} autoOpen label={null} />;
}

/* INTERNAL As-Is panel ON the "Confirm the As-Is value" condition (owner-directed 2026-07-28).
   Shows exactly what came in — the value PILOT read, where it read it, the words it read it from,
   what the file said before and what it says now — and lets an officer type over it. Staff-only:
   this condition is audience='staff', so nothing here is ever borrower-facing.
   Every text colour is an explicit dark hex — `var(--ink*)` is a LIGHT token in this palette. */
function CondAsIsEntry({ appId, onSaved }) {
  const [st, setSt] = useState(null);
  const [draft, setDraft] = useState('');
  const [arvDraft, setArvDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(async () => {
    try { setSt(await api.appraisalAsIs(appId)); } catch (e) { setErr(e.message || 'Could not load the As-Is reading'); }
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  const m = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

  async function save() {
    const v = Number(String(draft).replace(/[,$\s]/g, ''));
    if (!Number.isFinite(v) || v <= 0) { setErr('Enter the As-Is value as a number.'); return; }
    setBusy(true); setErr(''); setOk('');
    try {
      const r = await api.appraisalSetAsIs(appId, { value: v });
      setOk(`Saved — the As-Is value on this file is now ${m(r.value)}.`);
      setDraft('');
      await load();
      if (onSaved) await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }

  async function saveArv() {
    const v = Number(String(arvDraft).replace(/[,$\s]/g, ''));
    if (!Number.isFinite(v) || v <= 0) { setErr('Enter the ARV as a number.'); return; }
    setBusy(true); setErr(''); setOk('');
    try {
      const r = await api.appraisalSetArv(appId, { value: v });
      setOk(`Saved — the ARV on this file is now ${m(r.value)}.`);
      setArvDraft('');
      await load();
      if (onSaved) await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }

  async function reread() {
    setReading(true); setErr(''); setOk('');
    try {
      const r = await api.appraisalRereadAsIs(appId);
      setSt(r.state || null);
      setOk(r.applied
        ? `PILOT read the appraisal again and set the As-Is value to ${m(r.appliedValue)}.`
        : 'PILOT read the appraisal again — nothing on the file was changed.');
      if (onSaved) await onSaved();
    } catch (e) { setErr(e.message || 'Could not read the appraisal again'); } finally { setReading(false); }
  }

  if (!st) return <div className="small" style={{ marginTop: 8, color: '#4B585C' }}>{err || 'Loading the As-Is reading…'}</div>;
  if (!st.hasAppraisal) {
    return <div className="small" style={{ marginTop: 8, color: '#4B585C' }}>This becomes active once the appraisal has been uploaded and read.</div>;
  }

  const r = st.read || {};
  const av = st.arv || {};
  const WHERE = {
    xml: 'the appraisal data file (XML)',
    pdf_text: 'the appraisal report PDF, read with OCR',
    pdf_ai: 'the appraisal report PDF, read with OCR and located by AI',
  };
  const WHY = {
    same_value: 'that is exactly what the file already shows, so nothing needed changing',
    not_above_as_is: 'it is not above the As-Is value, so the two figures would be the wrong way round',
    not_the_headline_value: 'it was read out of the report’s wording rather than being the appraisal’s own headline figure, so PILOT will not use it on its own',
    as_is_changed_underneath: 'the As-Is changed on the file while PILOT was reading, so the two could not be compared safely',
    write_failed: 'the update did not go through',
    appraisal_identity_mismatch: 'this appraisal does not match the property on the file (address, unit count or property type), so nothing was taken from it — sort that out first',
    human_decided: 'someone has already decided this file’s As-Is value by hand, so PILOT left it alone — a person’s decision about this number is final',
    file_locked: 'this file’s figures are locked (the term sheet has gone out, or it is clear-to-close / funded), so nothing was changed automatically',
    not_confident: 'PILOT is not confident enough in that reading to use it — please read it off the report and enter it',
    auto_off: 'the automatic As-Is update is switched off',
    no_value: 'PILOT could not read an As-Is value',
    implausible: 'the amount does not look like a property value',
    value_changed_underneath: 'the As-Is value on the file changed while PILOT was reading, so it did not overwrite it',
  };
  const cell = { padding: '2px 0', color: '#141B22' };
  const lbl = { color: '#4B585C', minWidth: 190, display: 'inline-block' };

  return (
    <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid rgba(174,135,70,.35)', borderRadius: 8, background: '#FFFFFF' }}>
      <div className="small" style={{ fontWeight: 600, color: '#141B22', marginBottom: 6 }}>
        Internal — what PILOT read off the appraisal
      </div>

      <div className="small">
        <div style={cell}><span style={lbl}>PILOT read</span>
          <b>{m(r.value)}</b>
          {r.value != null && <> — from {WHERE[r.source] || 'the appraisal'}{r.engine ? ` (${r.engine})` : ''}</>}
          {r.value != null && <> · {r.confidence === 'definite' || r.confidence === 'high' ? 'confident' : 'not confident'}</>}
        </div>
        {r.value == null && r.reason && <div style={cell}><span style={lbl} /> {r.reason}.</div>}
        <div style={cell}><span style={lbl}>As-Is on the file now</span><b>{m(st.file.asIs)}</b>
          {r.applied && r.fileValueBefore != null && (
            <> (PILOT {Number(r.appliedValue) < Number(r.fileValueBefore) ? 'lowered' : 'raised'} it from {m(r.fileValueBefore)})</>
          )}
          {r.applied && r.fileValueBefore == null && <> (PILOT filled it in)</>}
        </div>
        {(r.applied || av.applied) && (
          <div style={{ ...cell, color: '#8A6D3B' }}>
            The loan has to be re-priced on {r.applied && av.applied ? 'these values' : 'this value'} — Products &amp; Pricing
            has reopened. Nothing about the loan amount changes until someone re-registers the product.
          </div>
        )}
        <div style={cell}><span style={lbl}>Purchase price</span>{m(st.file.purchasePrice)}</div>
        {/* The ARV — no ladder, no OCR: the appraisal's own headline figure. */}
        <div style={cell}><span style={lbl}>ARV on the file now</span><b>{m(st.file.arv)}</b>
          {av.applied && av.fileValueBefore != null && (
            <> (PILOT {Number(av.appliedValue) > Number(av.fileValueBefore) ? 'raised' : 'lowered'} it from {m(av.fileValueBefore)}, straight from the data file)</>
          )}
          {av.applied && av.fileValueBefore == null && <> (PILOT filled it in from the data file)</>}
          {!av.applied && av.fromAppraisal != null && Number(av.fromAppraisal) !== Number(st.file.arv) && (
            <> — the appraisal says {m(av.fromAppraisal)}{av.skipReason ? `; ${WHY[av.skipReason] || av.skipReason}` : ''}</>
          )}
        </div>
        {!r.applied && r.skipReason && (
          <div style={{ ...cell, marginTop: 4 }}><span style={lbl}>Nothing was changed because</span>{WHY[r.skipReason] || r.skipReason}</div>
        )}
        {Array.isArray(r.candidates) && r.candidates.length > 1 && (
          <div style={cell}><span style={lbl}>Other amounts seen</span>{r.candidates.map((n) => m(n)).join(', ')}</div>
        )}
        {r.quote && (
          <div style={{ ...cell, marginTop: 6, color: '#3A4550', fontStyle: 'italic' }}>“{r.quote}”</div>
        )}
        {st.confirmed && (
          <div style={{ ...cell, marginTop: 4, color: '#256168' }}>An officer entered the As-Is of {m(st.confirmed.value)} by hand.</div>
        )}
        {av.confirmed && (
          <div style={{ ...cell, color: '#256168' }}>An officer entered the ARV of {m(av.confirmed.value)} by hand.</div>
        )}
      </div>

      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
        <input className="input small" style={{ maxWidth: 180 }} inputMode="decimal"
          placeholder={st.file.asIs != null ? `Overwrite ${m(st.file.asIs)}…` : 'Enter the As-Is value…'}
          value={draft} disabled={busy}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <button className="btn primary small" onClick={save} disabled={busy || !String(draft).trim()}>
          {busy ? '…' : 'Save As-Is value'}
        </button>
        <button className="btn small" onClick={reread} disabled={reading} title="Read the appraisal again — useful if the report PDF arrived after the data file">
          {reading ? 'Reading…' : 'Read the appraisal again'}
        </button>
      </div>
      {/* The ARV gets its own box: PILOT can rewrite it, so there has to be somewhere to correct it. */}
      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        <input className="input small" style={{ maxWidth: 180 }} inputMode="decimal"
          placeholder={st.file.arv != null ? `Overwrite ARV ${m(st.file.arv)}…` : 'Enter the ARV…'}
          value={arvDraft} disabled={busy}
          onChange={(e) => setArvDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveArv(); }} />
        <button className="btn small" onClick={saveArv} disabled={busy || !String(arvDraft).trim()}>
          {busy ? '…' : 'Save ARV'}
        </button>
      </div>
      {st.locked && <div className="small" style={{ marginTop: 4, color: '#8A6D3B' }}>{st.locked}</div>}
      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {ok && <div className="small" style={{ color: '#256168', marginTop: 4 }}>{ok}</div>}
    </div>
  );
}

/* THE INLINE SLOT — ONE definition, rendered by BOTH condition row shapes.
 *
 * Some conditions are answered by TYPING the answer, not by uploading anything:
 * the note buyer, the YS loan number, the As-Is value off the appraisal. The box
 * belongs ON the condition — that is the owner's rule ("it should have a slot in
 * the condition itself to enter the loan number").
 *
 * It lives here because the conditions list renders two row shapes — the
 * borrower-facing row and `Item` for an internal one — and all three of these
 * conditions are audience='staff'. Written into one branch only, the box
 * silently disappeared the moment a row changed shape. One definition, called
 * from both, is what makes that impossible rather than merely fixed.
 */
function CondInlineEntry({ it, appId, onChanged, indent }) {
  let box = null;
  switch (it.template_code) {
    case 'cond_note_buyer_missing':  box = <CondNoteBuyerEntry appId={appId} onSaved={onChanged} />; break;
    case 'cond_loan_number_missing': box = <CondLoanNumberEntry appId={appId} onSaved={onChanged} />; break;
    case 'appraisal_as_is_verify':   box = <CondAsIsEntry appId={appId} onSaved={onChanged} />; break;
    /* The verify-payoff condition carries the WHOLE payoff section as its
       fillable form (owner-directed 2026-08-18: "bring in the details to fill
       in the payoff details in the condition") — the SAME PayoffCard the
       sec-payoff section mounts, so the two can never disagree. The condition's
       own wording is untouched; this renders UNDER it. */
    case 'cond_payoff_internal':     box = <PayoffCard appId={appId} app={{}} onSaved={onChanged} />; break;
    default: return null;   // never an empty wrapper — Item is a gapped flex column
  }
  return indent ? <div style={{ width: '100%', paddingLeft: 20 }}>{box}</div> : box;
}

// The SSN reveal eye lives with the SSN row itself, in the shared
// BorrowerProfilePanel — this screen no longer renders one of its own.

/* What the borrower has and hasn't completed — so the officer sees at a glance
   what still needs chasing without opening every panel. */
// Whether this file needs an estimated monthly rent for completeness is decided
// by the SERVER and arrives as `app.requires_estimated_rent`
// (GET /api/staff/applications/:id). It used to be re-derived here, which put a
// capital partner's name in the bundle every visitor downloads and drifted from
// the server's own rule — see the note on that line in src/routes/staff.js.
// Never re-derive a note-buyer rule in the browser: ask the server.

/* COMPLETENESS IS THREE LISTS, NOT ONE (owner-directed 2026-08-02: split it
   three ways — the application, the borrower, the co-borrower).

   It used to be one flat run of pills that mixed the DEAL (address, program,
   price, loan number) with the PERSON (date of birth, Social, FICO), so a
   processor chasing deal terms and an officer chasing borrower identity read the
   same undifferentiated wall — and the co-borrower's identical six fields sat in
   their own section below, which only made the primary's look like part of the
   deal. Now: what is true of the FILE, what is true of the BORROWER, what is true
   of the CO-BORROWER.

   The split is by SUBJECT, and the test asserts it both ways so a new field
   cannot quietly land in the wrong list: a field that reads `borrower.*` belongs
   to the person, everything else to the file. `edit:false` still means "filled
   somewhere else" (the address picker, the secure SSN flow) so we only hint. */
const APP_COMPLETENESS_FIELDS = (app) => [
  { key: 'property_address', label: 'Property address', ok: !!(app.property_address && (app.property_address.oneLine || app.property_address.street)), edit: false, hint: 'Set from the property address field on the file.' },
  /* Subject-property LLC / vesting entity (owner-directed 2026-07-21): required
     for application completeness.

     SATISFIED BY AN ENTITY OR BY THE FILE BEING IN AN INDIVIDUAL'S NAME
     (owner-directed 2026-08-02). It used to check only for an LLC, so a
     personal-name purchase carried a "Subject-property LLC" pill that could
     NEVER be filled: there is no entity to link, by definition. The file could
     therefore never read complete. Answering it with the individual choice is
     correct — the question is "what does this vest in?", and "an individual" is
     a real answer, which the non-owner-occupied affidavit condition then
     documents (db/408).

     AND IT IS FILLED IN RIGHT HERE, like every other pill (owner-directed
     2026-08-03: "this missing stuff doesn't have the plus button like everywhere
     else … you can't fill in the vesting LLC over there"). It was the ONE pill
     with no `+` — a dead grey chip naming another section — even though the LLC
     name is the single most ordinary thing an officer types. Typing it
     resolves-or-creates that entity on the borrower's PROFILE (a name they
     already have is reused) and routes through the vesting chokepoint, so the
     LLC condition and its three document slots open on the file straight away.
     It saves through the file's one vesting door rather than complete-fields:
     `applications.llc_id` is a LINK to the borrower's entity, never a text
     column, and a name written into a column would be a name with no documents
     behind it.

     AND THE OTHER ANSWER IS RIGHT HERE TOO (owner-directed 2026-08-03: "you have
     a plus mark where you can put an LLC. We need over there to have a tool to
     select that this is on an individual"). The pill asks "what does this vest
     in?" and there are TWO answers, but only one of them could be given here —
     the other was a sentence telling the officer to go and find a different
     section, on the one pill they had already opened to answer the question.
     "An individual" is a SIGN-OFF (it stands the LLC condition down), so it
     still saves through the personal-name door — a second button on the same
     editor, never a value typed into the name box. */
  { key: 'entity_name',
    label: (app.personal_name_purchase && !app.llc_id) ? 'Vesting' : 'Vesting entity name',
    ok: !!(app.entity_name || app.llc_name || app.llc_id || (app.personal_name_purchase && !app.llc_id)),
    type: 'entity', placeholder: 'Acme Holdings LLC',
    postEndpoint: (base) => base.replace(/\/complete-fields$/, '/vesting-llc'),
    postBody: (v) => ({ entityName: v }),
    // The second answer, offered beside the name box by CompletenessPanel.
    altEndpoint: (base) => base.replace(/\/complete-fields$/, '/vesting/personal-name'),
    altBody: () => ({}),
    altLabel: 'No entity — an individual',
    altNote: 'Saved — this file closes in the borrower’s own name. The signed non-owner-occupied affidavit is now asked for on its own condition.',
    altBlocked: app.vesting_individual_blocked || '',
    hint: 'The entity taking title — type the name, or say it closes in the borrower’s own name.' },
  { key: 'property_type', label: 'Property type', ok: !!app.property_type, type: 'select', options: ['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed Use'] },
  { key: 'program', label: 'Program', ok: !!app.program, type: 'select', options: ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction'] },
  { key: 'loan_type', label: 'Loan type', ok: !!app.loan_type, type: 'select', options: ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out'] },
  /* THE FILE IS ASKED FOR THE FIGURE IT IS SIZED ON (owner-directed 2026-08-02).
     A refinance is sized on the AS-IS VALUE — the frozen engine's own denominator
     (`acqDenom = purchase ? min(pp, aiv) : aiv`) — so demanding a purchase price
     there was demanding a number nothing reads, while the number that actually
     sets the initial advance was never asked for at all. A purchase is unchanged.
     The extra refinance rows below are the seasoning basis the owner asked for;
     they are pills to FILL, not gates — nothing waits on them. */
  ...(sizesOnAsIsValue(app.loan_type) ? [
    { key: 'as_is_value', label: 'As-is value', ok: app.as_is_value != null, type: 'money',
      hint: 'What the property is worth today — a refinance is sized on this.' },
    { key: 'original_purchase_price', label: 'Original purchase price', ok: app.original_purchase_price != null,
      edit: false, goTo: 'sec-application',
      hint: 'What the borrower paid when they bought it — enter it under Refinance details.' },
    { key: 'acquisition_date', label: 'Date acquired', ok: !!app.acquisition_date,
      edit: false, goTo: 'sec-application',
      hint: 'When they bought it — this is what ownership seasoning is counted from.' },
  ] : [
    { key: 'purchase_price', label: 'Purchase price', ok: app.purchase_price != null, type: 'money' },
  ]),
  { key: 'arv', label: 'ARV', ok: app.arv != null, type: 'money' },
  { key: 'rehab_budget', label: 'Rehab budget', ok: app.rehab_budget != null, type: 'money' },
  // Note buyer / capital partner (applications.lender). Normally fed from ClickUp;
  // staff can fill it here when ClickUp doesn't feed it or is empty (owner-directed
  // 2026-07-20). Type 'notebuyer' renders a datalist of every note buyer available
  // in ClickUp. STAFF-ONLY — this whole panel is staff; it's never on the borrower
  // completeness panel and the note-buyer name never reaches a borrower.
  { key: 'lender', label: 'Note buyer', ok: !!app.lender, type: 'notebuyer' },
  // Estimated monthly rent — required for completeness only on an EMCAP
  // fix-and-hold loan (owner-directed 2026-07-26). Hidden on every other file.
  ...(app.requires_estimated_rent
    ? [{ key: 'estimated_rental_income', label: 'Estimated monthly rent', ok: app.estimated_rental_income != null, type: 'money' }]
    : []),
  // Loan number (applications.ys_loan_number) — part of application completeness
  // (owner-directed 2026-07-20). Saved through the dedicated /loan-number entry so
  // it enforces the YSCAP format + cross-file/ClickUp uniqueness (a duplicate is
  // rejected inline and parked to manual review). STAFF-ONLY.
  { key: 'ys_loan_number', label: 'Loan number', ok: !!app.ys_loan_number, type: 'text',
    placeholder: 'YSCAP…',
    postEndpoint: (base) => base.replace(/\/complete-fields$/, '/loan-number'),
    postBody: (v) => ({ loanNumber: v }) },
];

/* THE BORROWER — facts about the PERSON, not about the deal. Every row here
   reads `borrower.*`, and it is the mirror of CO_COMPLETENESS_FIELDS below, so
   the two people are asked for the same things in the same order. It saves
   through the SAME complete-fields endpoint as the deal list (the server keys on
   the field name, not on which panel it came from), so nothing about the write
   path changed. */
const BORROWER_COMPLETENESS_FIELDS = (app, borrower) => [
  { key: 'cell_phone', label: 'Borrower phone', ok: !!(borrower && borrower.cell_phone), type: 'tel' },
  // Borrower's PRIMARY (home) residence address — required for application
  // completeness (owner-directed 2026-07-21). Filled via the PrimaryAddressPanel
  // below; the panel writes borrowers.current_address through
  // staffUpdateBorrower({currentAddress}), so completeness only checks it here.
  { key: 'current_address', label: 'Borrower primary home address',
    ok: !!(borrower && borrower.current_address
      && ['line1', 'city', 'state', 'zip'].some((k) => String(borrower.current_address[k] || '').trim())),
    edit: false, hint: 'Set with the borrower primary address panel below.' },
  { key: 'date_of_birth', label: 'Date of birth', ok: !!(borrower && borrower.date_of_birth), type: 'date' },
  // SSN is entered on its own audited line in the Borrower section (it has a
  // duplicate-profile resolver and a reveal that this compact panel can't carry),
  // so the pill jumps you straight there rather than naming a screen to go hunt.
  { key: 'ssn', label: 'SSN on file', ok: !!(borrower && borrower.ssn_last4), edit: false, goTab: 'people',
    hint: 'Add it on the SSN line of the Borrower profile — click to go there.' },
  { key: 'fico', label: 'FICO', ok: !!(borrower && borrower.fico), type: 'fico' },
  { key: 'citizenship', label: 'Citizenship', ok: !!(borrower && borrower.citizenship), type: 'select', options: ['US Citizen', 'Permanent Resident', 'Foreign National'] },
];

// #30 / #60 — the co-borrower's own required identity fields, shown in a SEPARATE
// "Co-borrower completeness" section (not mixed into the primary borrower's).
// Name / phone / date of birth / FICO / citizenship are all inline-addable (+)
// via the co-borrower-fields endpoint — PARITY with the primary borrower section
// (owner-directed 2026-07-14: "add it right there like you can on the borrower").
// Email + SSN stay in the Co-borrower panel (set at link / secure flow). Gated to
// the staff payload that carries the co-borrower join.
const PLACEHOLDER_NAME = new Set(['', 'unknown', 'co-borrower', 'n/a', 'na', 'tbd']);
const realName = (v) => !!v && !PLACEHOLDER_NAME.has(String(v).trim().toLowerCase());
const CO_COMPLETENESS_FIELDS = (app) => ((app.co_borrower_id && ('co_first_name' in app)) ? [
  { key: 'co_name', label: 'Co-borrower name', ok: realName(app.co_first_name) && realName(app.co_last_name), type: 'text' },
  { key: 'co_email', label: 'Co-borrower email', ok: !!app.co_email, edit: false, goTab: 'people',
    hint: 'Add it on the Email line of the Co-borrower profile — click to go there.' },
  { key: 'co_phone', label: 'Co-borrower phone', ok: !!app.co_cell_phone, type: 'tel' },
  { key: 'co_dob', label: 'Co-borrower date of birth', ok: !!app.co_date_of_birth, type: 'date' },
  { key: 'co_fico', label: 'Co-borrower FICO', ok: !!app.co_fico, type: 'fico' },
  { key: 'co_citizenship', label: 'Co-borrower citizenship', ok: !!app.co_citizenship, type: 'select', options: ['US Citizen', 'Permanent Resident', 'Foreign National'] },
  { key: 'co_ssn', label: 'Co-borrower SSN on file', ok: !!app.co_ssn_last4, edit: false, goTab: 'people',
    hint: 'Add it on the SSN line of the Co-borrower profile (stored encrypted) — click to go there.' },
] : []);

/* "Show me the tab that edits this" — a one-line channel, the shape FileSections
   already uses for the Conditions hub (requestConditionsTab/subscribe).
   `CompletenessPanel` is a module-level component with no access to the section's
   own state, and its pills for fields it cannot edit itself (the Social, the
   co-borrower's email) point at a SIBLING TAB of the very section they are
   rendered in — so they need to flip a tab, not navigate anywhere.
   It MOVED into FileSections.jsx (2026-08-03) and is imported at the top of this
   file: components that are not defined here — the e-sign section, the tape
   export — need the same channel now that Encompass sync is a tab rather than a
   section, and they cannot import this screen without a cycle. */

/* Application completeness with INLINE editing — click a missing field to enter
   it right there; it saves to the file (and syncs to ClickUp) without a form.
   `endpoint` differs for staff vs borrower; `onSaved` reloads the file. */
function CompletenessPanel({ app, borrower, endpoint, onSaved, heading = 'Application completeness', fields: fieldsProp }) {
  const [editing, setEditing] = useState(null);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const fields = fieldsProp || [...APP_COMPLETENESS_FIELDS(app), ...BORROWER_COMPLETENESS_FIELDS(app, borrower)];
  // Note-buyer picker: load every note buyer available in ClickUp (+ known + on
  // file) so a 'notebuyer' field renders a datalist. Only fetched when the panel
  // actually carries such a field. Its own datalist id avoids id collisions.
  const [nbOpts, setNbOpts] = useState([]);
  const nbListId = useMemo(() => 'nb-dl-' + Math.random().toString(36).slice(2), []);
  const hasNoteBuyer = fields.some((f) => f.type === 'notebuyer');
  useEffect(() => {
    if (!hasNoteBuyer) return;
    let live = true;
    api.get('/api/staff/note-buyers').then((r) => { if (live) setNbOpts((r && r.noteBuyers) || []); }).catch(() => {});
    return () => { live = false; };
  }, [hasNoteBuyer]);
  /* Vesting-entity picker: the borrower's OWN entities, offered as a datalist so
     the LLC they already have is reused rather than re-typed slightly
     differently and created twice. The server matches by name either way — this
     is the convenience, not the guard. Fetched only when the pill is genuinely
     missing, so a complete file makes no extra call. */
  const [entOpts, setEntOpts] = useState([]);
  const entListId = useMemo(() => 'ent-dl-' + Math.random().toString(36).slice(2), []);
  const needsEntity = fields.some((f) => f.type === 'entity' && !f.ok);
  const entBorrowerId = (app && app.borrower_id) || null;
  useEffect(() => {
    if (!needsEntity || !entBorrowerId) return;
    let live = true;
    api.staffBorrowerLlcs(entBorrowerId)
      .then((r) => { if (live) setEntOpts((Array.isArray(r) ? r : []).map((l) => l && l.llc_name).filter(Boolean)); })
      .catch(() => {});
    return () => { live = false; };
  }, [needsEntity, entBorrowerId]);
  const done = fields.filter((x) => x.ok).length;
  const missing = fields.filter((x) => !x.ok);
  const start = (f) => { setEditing(f.key); setVal(''); setErr(''); setNote(''); };
  async function save(f) {
    if (val === '' || val == null) return;
    // #90: a FICO must be a real 3-digit score in range — never save junk.
    if (f.type === 'fico' && !ficoValid(val)) { setErr('FICO must be a 3-digit score between 300 and 850.'); return; }
    setBusy(true); setErr(''); setNote('');
    // A field may post to its OWN endpoint/body (e.g. the loan number goes to the
    // dedicated /loan-number entry that enforces format + cross-file uniqueness,
    // and the vesting LLC to the file's one vesting door).
    const ep = f.postEndpoint ? f.postEndpoint(endpoint) : endpoint;
    const body = f.postBody ? f.postBody(val) : { [f.key]: val };
    try {
      const r = await api.post(ep, body);
      setEditing(null); setVal('');
      // Say what actually happened to the borrower's profile — a name that
      // already existed there was LINKED, not created, and the two are different
      // things to anyone chasing that entity's documents.
      if (f.type === 'entity' && r && r.entityName) {
        setNote(r.existed
          ? `Linked ${r.entityName} — the entity the borrower already had, with its documents.`
          : `${r.entityName} saved to the borrower’s profile and linked — its document slots are ready.`);
      }
      await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  /* THE OTHER ANSWER — a field whose question has a second, non-typed answer
     (today: "this vests in an individual", which is a sign-off through the
     personal-name door, not a name to type). It posts NOTHING from the box, so
     it deliberately does not go through `save` and is never gated on the box
     having a value. `altBlocked` carries the server's own reason (Blue Lake /
     Gold), so the button is greyed WITH the reason rather than answering 409. */
  async function saveAlt(f) {
    if (!f.altEndpoint || f.altBlocked) return;
    setBusy(true); setErr(''); setNote('');
    try {
      await api.post(f.altEndpoint(endpoint), f.altBody ? f.altBody() : {});
      setEditing(null); setVal('');
      if (f.altNote) setNote(f.altNote);
      await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); }
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
      {note && <div className="notice ok" style={{ marginBottom: 8 }}>{note}</div>}
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
                  : f.type === 'notebuyer'
                  ? <input className="input" style={{ maxWidth: 200 }} autoFocus list={nbListId}
                      type="text" placeholder="Pick or type a note buyer…" value={val}
                      onChange={(e) => setVal(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && save(f)} />
                  : f.type === 'entity'
                  ? <input className="input" style={{ maxWidth: 260 }} autoFocus list={entListId}
                      type="text" maxLength={160} placeholder={f.placeholder || 'Entity name…'} value={val}
                      onChange={(e) => setVal(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && save(f)} />
                  : <input className="input" style={{ maxWidth: 170 }} autoFocus
                      type={f.type === 'date' ? 'date' : f.type === 'number' || f.type === 'money' ? 'number' : f.type === 'tel' ? 'tel' : 'text'}
                      inputMode={f.type === 'money' || f.type === 'number' || f.type === 'fico' ? 'numeric' : undefined}
                      maxLength={f.type === 'fico' ? 3 : undefined}
                      placeholder={f.placeholder || (f.type === 'fico' ? '300–850' : f.label)} value={val}
                      onChange={(e) => setVal(f.type === 'fico' ? cleanFICO(e.target.value) : e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && save(f)} />}
                <button className="btn primary small" disabled={busy || val === '' || (f.type === 'fico' && !ficoValid(val))} onClick={() => save(f)}>{busy ? '…' : 'Save'}</button>
                {f.altEndpoint && (
                  <button className="btn ghost small" disabled={busy || !!f.altBlocked}
                    title={f.altBlocked || 'No company takes title — the borrower buys in their own name.'}
                    onClick={() => saveAlt(f)}>{f.altLabel || 'Other'}</button>
                )}
                <button className="btn ghost small" onClick={() => setEditing(null)}>✕</button>
                {f.altEndpoint && f.altBlocked
                  && <span className="small" style={{ flexBasis: '100%', color: '#8A6D3B' }}>{f.altBlocked}</span>}
              </span>
            ) : f.edit === false ? (
              // A field this compact panel can't edit itself is still one CLICK
              // from where it IS edited — it used to be a dead grey pill naming a
              // panel that had no such control (owner-reported 2026-07-27).
              (f.goTo || f.goTab) ? (
                <button key={f.key} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold-ink)', cursor: 'pointer', background: 'none' }}
                  onClick={() => { if (f.goTab) requestAppDetailTab(f.goTab); if (f.goTo) goToSection(f.goTo); }}
                  title={f.hint}>+ {f.label} →</button>
              ) : (
                <span key={f.key} className="pill" style={{ borderColor: 'var(--muted)', color: 'var(--muted)' }} title={f.hint}>Missing: {f.label}</span>
              )
            ) : (
              <button key={f.key} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold-ink)', cursor: 'pointer', background: 'none' }}
                onClick={() => start(f)} title={f.hint || 'Click to enter it now'}>+ {f.label}</button>
            ))}
          </div>
        )}
      {hasNoteBuyer && (
        <datalist id={nbListId}>
          {nbOpts.map((o) => <option key={o.value || o.label} value={o.label} />)}
        </datalist>
      )}
      {needsEntity && (
        <datalist id={entListId}>
          {entOpts.map((n) => <option key={n} value={n} />)}
        </datalist>
      )}
    </div>
  );
}

/* THE DEAL's own missing pieces (owner-directed 2026-08-02 — the first of the
   three). Same endpoint as before; only the list it is handed is narrower. */
function Completeness({ app, borrower, appId, onSaved }) {
  return <CompletenessPanel app={app} borrower={borrower} fields={APP_COMPLETENESS_FIELDS(app)}
    heading="Application — what's missing"
    endpoint={`/api/staff/applications/${appId}/complete-fields`} onSaved={onSaved} />;
}

/* THE BORROWER's own missing pieces — the second of the three, and the mirror of
   the co-borrower panel below, so the two people read identically. */
function BorrowerCompleteness({ app, borrower, appId, onSaved }) {
  return <CompletenessPanel app={app} borrower={borrower}
    fields={BORROWER_COMPLETENESS_FIELDS(app, borrower)}
    heading="Borrower — what's missing"
    endpoint={`/api/staff/applications/${appId}/complete-fields`} onSaved={onSaved} />;
}

/* Borrower PRIMARY (home) residence address — the borrower enters this in their
   profile, but when STAFF fill out a file for a borrower who isn't in the portal
   there was no place to capture it. This editor saves it straight to the
   borrower profile (current_address), so it's on file for underwriting and the
   1003/URLA the same as if the borrower had typed it. Reused for the co-borrower. */
const oneLineAddr = (a) => [a.line1, a.unit ? `#${a.unit}` : '', a.city, [a.state, a.zip].filter(Boolean).join(' ')]
  .map(s => String(s || '').trim()).filter(Boolean).join(', ');
function PrimaryAddressPanel({ borrowerId, address, name, onSaved }) {
  const blank = { line1: '', unit: '', city: '', state: '', zip: '' };
  const [a, setA] = useState({ ...blank, ...(address || {}) });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  // Once an address is on file it collapses to a single line (owner-directed:
  // "once it's filled and saved, that should be collapsed automatically… it's
  // just wasting everybody's place and time"). It opens into the full editor
  // only when there's nothing on file yet, or the user clicks Edit.
  const onFile = !!(address && ['line1', 'city', 'state', 'zip'].some(k => String(address[k] || '').trim()));
  const [editing, setEditing] = useState(!onFile);
  const key = borrowerId + '|' + JSON.stringify(address || {});
  useEffect(() => { setA({ ...blank, ...(address || {}) }); setSaved(false); setEditing(!onFile); /* eslint-disable-next-line */ }, [key]);
  const set = (k, v) => { setA(s => ({ ...s, [k]: v })); setSaved(false); };
  const hasAny = ['line1', 'city', 'state', 'zip'].some(k => String(a[k] || '').trim());
  async function save() {
    setBusy(true); setErr('');
    try {
      const clean = hasAny ? { ...a, oneLine: oneLineAddr(a) } : null;
      await api.staffUpdateBorrower(borrowerId, { currentAddress: clean });
      setSaved(true); setEditing(false); if (onSaved) await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }

  // Collapsed one-liner — the common case for a file that's already set up.
  if (!editing) {
    const line = (address && address.oneLine) || oneLineAddr({ ...blank, ...(address || {}) }) || '—';
    return (
      <div className="metrow" style={{ marginTop: 12, alignItems: 'center' }}>
        <span className="k">{name} — primary address</span>
        <span className="v" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span>{line}</span>
          <button className="btn link small" onClick={() => setEditing(true)}>Edit</button>
        </span>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <h3>{name} — primary address</h3>
        <div className="spacer" />
        <span className={`pill ${hasAny ? 'done' : ''}`}>{hasAny ? 'On file' : 'Not set'}</span>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
        The borrower&apos;s home (physical) residence address. Enter it here when you&apos;re filling out the file for them.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 10 }}>
        <div className="field"><label>Street address</label>
          <input className="input" value={a.line1} onChange={e => set('line1', e.target.value)} placeholder="123 Main St" /></div>
        <div className="field"><label>Unit</label>
          <input className="input" value={a.unit} onChange={e => set('unit', e.target.value)} placeholder="Apt 2" /></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
        <div className="field"><label>City</label>
          <input className="input" value={a.city} onChange={e => set('city', e.target.value)} /></div>
        <div className="field"><label>State</label>
          <input className="input" value={a.state} onChange={e => set('state', e.target.value.toUpperCase())} maxLength={2} placeholder="NJ" /></div>
        <div className="field"><label>ZIP</label>
          <ZipInput value={a.zip} onChange={v => set('zip', v)} placeholder="07001" /></div>
      </div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save address'}</button>
        {onFile && <button className="btn ghost small" disabled={busy} onClick={() => { setA({ ...blank, ...(address || {}) }); setEditing(false); }}>Cancel</button>}
        {saved && <span className="muted small">Saved ✓</span>}
      </div>
    </div>
  );
}

// #30 — the co-borrower's own completeness card, separate from the primary
// borrower's. Only renders when a co-borrower is linked. Name / phone / DOB are
// inline-addable here; email + SSN point to the Co-borrower panel.
function CoBorrowerCompleteness({ app, appId, onSaved }) {
  const fields = CO_COMPLETENESS_FIELDS(app);
  if (!fields.length) return null;
  return <CompletenessPanel app={app} borrower={null} fields={fields}
    endpoint={`/api/staff/applications/${appId}/co-borrower-fields`} onSaved={onSaved}
    heading="Co-borrower — what's missing" />;
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

/* THE FACTS THE APPRAISAL PUT ON THE FILE (db/403, owner-directed 2026-08-02:
   "all these things that he's getting from the appraisal … please add this field
   in our file and that field should automatically be tabulated once you import
   the XML of the appraisal").

   Filled by the appraisal import, blank-only — there is nothing to type here and
   nothing to chase: these are NOT part of application completeness and never
   appear on a missing-info panel ("this field should not be a requirement for us
   to fill anywhere"). The seller is the useful one: it gives the purchase
   contract, the title report and the settlement statement a single value of
   record to be matched against on the data comparison.

   OCCUPANCY IS NOT HERE ON PURPOSE. The appraisal's occupancy is the SELLER's use
   of the property today — a seller living in the house they are selling is
   perfectly ordinary — while the file's occupancy is the borrower's use after
   closing, and we only lend non-owner-occupied. The import never writes it.

   Renders nothing until an appraisal has been imported. */
function AppraisalFileFacts({ app }) {
  const rows = [
    ['Seller', app.seller_name || null],
    ['Year built', app.year_built == null ? null : String(app.year_built)],
    ['Living area', app.living_area_sqft == null ? null : `${Number(app.living_area_sqft).toLocaleString('en-US')} sq ft`],
    ['Market rent (1007)', app.market_rent == null ? null : '$' + Number(app.market_rent).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' / mo'],
  ].filter(([, v]) => v != null);
  if (!rows.length) return null;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3>Property facts from the appraisal</h3>
        <div className="spacer" />
        <span className="muted small">Filled when the appraisal XML was imported · read-only</span>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
        Nothing to fill in here — these come off the appraisal and are never required on the file.
        They are on the file so the data comparison can match them against the other documents.
      </p>
      {rows.map(([k, v]) => (
        <div className="metrow" key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
      ))}
    </div>
  );
}

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
// Fees / cash-to-close / liquidity / reserves show EXACT cents (owner-directed
// 2026-07-16); loan amount / advance / holdback stay whole-dollar (frozen).
const money2 = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// The status list moved with the status dropdown into components/ConditionActions
// — it reads CONDITION_STATUSES from lib/conditions-vocab.js directly.
/* Kept in the SERVER'S order, and it must stay in step with `APP_STATUS` in
   routes/staff.js — a status the server accepts but this list omits simply
   cannot be set from PILOT. That is exactly what happened to `on_hold`: it has
   been a real status since db/319 (2026-07-26) and settable by the API ever
   since, but it was missing here, so a file could be parked from ClickUp and
   never from the portal. */
const APP_STATUSES = ['file_intake', 'new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'on_hold', 'declined', 'withdrawn'];
const APP_STATUS_LABEL = { file_intake: 'File intake', new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn' };
const PHASE_LABEL = {
  p1_intake: 'Phase 1 · Borrower Intake', p2_setup: 'Phase 2 · File Setup',
  p3_verify: 'Phase 3 · Verifications', p4_appraisal: 'Phase 4 · Appraisal & Numbers',
  p5_closing: 'Phase 5 · Closing Prep',
};
const phaseName = (p) => PHASE_LABEL[p] || (p ? p.replace(/_/g, ' ') : 'General');

function Badge({ children, tone, title }) {
  // `title` is optional — a collapsed row can carry the full story (e.g. why a
  // condition was cleared by override) in a hover without widening the line.
  return <span className="pill" title={title || undefined}
    style={tone === 'gold' ? { borderColor: 'var(--gold)', color: 'var(--gold-ink)' } : undefined}>{children}</span>;
}

/* PILOT ADVISORY stamp (owner-directed 2026-07-24). PILOT lays an advisory ON TOP
   of the human layer for EVERY condition it can judge, and NEVER clears a Condition
   Center condition itself — the human still signs off. Four verdicts:
     ready      — open, PILOT verified it's met → ready for a human to clear
     not_ready  — open, PILOT hasn't confirmed it yet
     agree      — signed off, PILOT confirms it was cleared correctly
     dispute    — signed off, but PILOT found evidence it should be revisited
   The note explains why. Purely presentational — reads it.pilot_advice/_note/_at. */
const PILOT_ADVICE = {
  ready:     { label: 'PILOT: ready to clear', fg: '#1f7a4d', bg: '#e7f5ec', bd: '#bfe3cd', dot: '#22a35d' },
  not_ready: { label: 'PILOT: not ready yet',  fg: '#8a5a00', bg: '#fbf1de', bd: '#eeddb6', dot: '#d99518' },
  agree:     { label: 'PILOT: agrees',         fg: '#1d6a70', bg: '#e4f2f3', bd: '#bfe0e3', dot: '#2f7f86' },
  dispute:   { label: 'PILOT: revisit',        fg: '#a5342b', bg: '#fbe9e7', bd: '#f1c7c2', dot: '#d1453b' },
};
function PilotAdvice({ it }) {
  const v = it && it.pilot_advice;
  const spec = v && PILOT_ADVICE[v];
  if (!spec) return null;
  const note = (it.pilot_advice_note || '').trim();
  const when = it.pilot_advice_at ? new Date(it.pilot_advice_at).toLocaleDateString() : '';
  const title = [note, when && `PILOT looked at this on ${when}`].filter(Boolean).join('\n');
  return (
    <span
      title={title || undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px',
        borderRadius: 999, fontSize: 11.5, fontWeight: 700, lineHeight: 1.6,
        color: spec.fg, background: spec.bg, border: `1px solid ${spec.bd}`,
        whiteSpace: 'nowrap', letterSpacing: .1,
      }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: spec.dot, flex: '0 0 auto' }} />
      {spec.label}
    </span>
  );
}
/* The plain-language note under the row, so the reason is visible without hovering. */
function PilotAdviceNote({ it }) {
  const v = it && it.pilot_advice;
  const note = (it.pilot_advice_note || '').trim();
  if (!v || !note) return null;
  const dispute = v === 'dispute';
  return (
    <div className="small" style={{ marginTop: 4, color: dispute ? 'var(--danger)' : 'var(--muted)' }}>
      <strong>PILOT’s note:</strong> {note}
    </div>
  );
}

// Completing / signing off is the PROCESSOR's call (admins too); a loan
// officer marks conditions REVIEWED instead — mirrored server-side. This is a
// UI hint by role default; the server enforces the sign_off_conditions
// capability (incl. the loan-coordinator persona and per-user overrides).
// canComplete moved to lib/condition-actions.js — the action ladder owns its own
// role rules, so "who may sign off" has one definition rather than one here and
// one implied by whichever buttons a row happened to render.

/* SUPER-ADMIN CONDITION OVERRIDE (owner-directed 2026-07-27): "if we're unable
   to clear it, the admin should be able to overwrite and clear the condition
   without a document attached to it or without fulfilling the requirement of
   that condition. Only super admin."

   ONLY a super admin, and only as a deliberate act — the ordinary Sign off /
   Waive buttons still refuse an unfulfilled condition for everyone (that gate is
   unchanged). The ask + the wording + the display live in ../lib/condition-override
   so this screen and the task queue can never word the same decision differently;
   the SERVER (src/lib/conditions/admin-override.js) is the authority on who may
   do it, so a hidden button is a convenience, never the control. */

/* ONE "off my plate" rule for every conditions/checklist surface (owner-directed
   2026-07-16): the loan officer's terminal action is DONE (reviewed_at); the
   back office's is SIGN-OFF. Once YOUR role's action is complete, the item
   leaves your default view and renders collapsed (reopenable). */
function roleDone(it, role) {
  return it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at
    || (role === 'loan_officer' && !!it.reviewed_at);
}
// Per-user sticky filters (client-side; keyed per filter surface).
function useStickyFilter(key, fallback) {
  const [v, setV] = useState(() => { try { return localStorage.getItem('pilot.filter.' + key) || fallback; } catch { return fallback; } });
  // Memoized: consumers put this setter in hook deps (e.g. the Seven Rooms
  // runReveal), and an unstable identity re-ran those effects on EVERY render —
  // which is what let a re-render cancel a queued cross-room reveal (audit
  // 2026-08-02 #1). Same behavior, stable identity.
  const set = useCallback((nv) => { setV(nv); try { localStorage.setItem('pilot.filter.' + key, nv); } catch { /* private mode */ } }, [key]);
  return [v, set];
}

// The appraisal "no XML available" control on the appraisal-documents condition.
// Waives ONLY the XML upload (the PDF stays required), collects the ARV + As-Is by
// hand (usually read off the XML), and routes the reason: a transferred appraisal
// auto-waives and asks for a transfer-letter PDF; any other reason needs a note
// and opens an admin exception.
const APPR_XML_REASONS = [
  { v: 'transferred_appraisal', label: 'Transferred appraisal (from another lender)' },
  { v: 'appraiser_no_xml', label: 'Appraiser did not provide the XML data file' },
  { v: 'desk_or_manual', label: 'Desk / manual / older appraisal (no MISMO XML)' },
  { v: 'other', label: 'Other (explain in the note)' },
];
// Order a flood determination from the active flood provider (Xactus by default;
// Encompass parked — see src/flood/dispatch.js). Renders on the flood condition
// (rtl_cond_flood). Any staff member may order. Self-hides until the feature is
// turned on. If the file isn't ready to order, the button says exactly what's
// missing (the property address / borrower name / loan number, per provider).
function OrderFloodButton({ appId, itemId, onChanged, onUploadTo }) {
  const [state, setState] = useState(null);   // { order, enabled, provider, hasLoanNumber(=ready), needs } | null
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.floodOrderState(appId).then(setState).catch(() => setState(null)), [appId]);
  useEffect(() => { load(); }, [load]);
  if (!state || !state.enabled) return null;   // feature off → nothing shows

  const order = state.order;
  const pending = order && order.status === 'ordered';
  const done = order && order.status === 'completed';
  const errored = order && order.status === 'error';
  const box = { marginTop: 8, padding: '8px 10px', border: '1px solid var(--gold)', borderRadius: 8, background: 'rgba(174,135,70,0.06)' };

  // `force` re-orders a file that already has a determination — ALWAYS passed
  // explicitly (a bare onClick={placeOrder} would hand the click event in as
  // `force`, which is truthy, and silently re-charge us).
  async function placeOrder(force) {
    setBusy(true); setErr(''); setMsg('');
    try {
      const out = await api.orderFlood(appId, itemId, force === true);
      setMsg(out.message || 'Flood certificate ordered.');
      await load();
      onChanged && onChanged();
    } catch (e) {
      setErr((e.data && e.data.message) || e.message || 'Could not order the flood certificate.');
    } finally { setBusy(false); }
  }

  // Retrieval of a certificate already paid for — never places a new order.
  async function fetchCert() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const out = await api.fetchFloodCertificate(appId);
      setMsg(out.message || 'Flood certificate retrieved.');
      await load();
      onChanged && onChanged();
    } catch (e) {
      setErr((e.data && e.data.message) || e.message || 'Could not get the certificate.');
    } finally { setBusy(false); }
  }

  async function reorder() {
    if (!(await askConfirm('This places a NEW flood order with Xactus and we will be charged again.\n\nOnly do this if the determination on file is wrong (for example the property address was corrected). Continue?'))) return;
    placeOrder(true);
  }

  if (done) {
    return (
      <div className="small" style={box}>
        <div style={{ fontWeight: 600, color: '#141B22' }}>Flood determination received</div>
        <div style={{ color: '#4B585C', marginTop: 2 }}>
          {order.sfha === true
            ? `In a flood zone${order.flood_zone ? ` (zone ${order.flood_zone})` : ''} — a flood-insurance condition was added to the file.`
            : order.sfha === false
              ? `Not in a flood zone${order.flood_zone ? ` (zone ${order.flood_zone})` : ''}.`
              : 'The determination came back.'}
          {/* Three states, never conflated: filed / definitely missing / can't tell.
              "Can't tell" must NEVER read as "filed" — claiming a certificate is on
              the file when it isn't is the exact bug this card had. */}
          {' '}{state.hasCertificate === true
            ? 'The certificate PDF is filed on this condition — it’s in the documents above.'
            : state.hasCertificate === false
              ? 'The certificate PDF is not on this condition yet.'
              : 'Check the documents above for the certificate PDF.'}
        </div>
        {/* Offered unless the PDF is confirmed filed. This RETRIEVES the report we
            already paid for — it never places (or is charged for) a second order. */}
        {state.hasCertificate !== true && (
          <button className="btn ghost small" style={{ marginTop: 6 }} disabled={busy} onClick={fetchCert}>
            {busy ? 'Getting the certificate…' : 'Get the certificate PDF'}
          </button>
        )}
        <div style={{ color: '#4B585C', marginTop: 6 }}>
          PILOT won’t order another one for this file — each order is billable.
        </div>
        {state.canReorder && (
          <button className="btn link small" style={{ marginTop: 4, color: '#256168', display: 'block' }}
            disabled={busy} onClick={reorder}>Order a new determination anyway (charges again)</button>
        )}
        {onUploadTo && (
          <button className="btn link small" style={{ marginTop: 4, color: '#256168', display: 'block' }}
            onClick={() => onUploadTo({ itemId, slotBase: 0 })}>Upload a certificate manually instead</button>
        )}
        {msg && <div className="notice" style={{ marginTop: 6 }}>{msg}</div>}
        {err && <div className="notice err" style={{ marginTop: 6 }}>{err}</div>}
      </div>
    );
  }
  if (pending) {
    return (
      <div className="small" style={box}>
        <div style={{ fontWeight: 600, color: '#141B22' }}>Flood certificate ordered</div>
        <div style={{ color: '#4B585C', marginTop: 2 }}>Waiting for it to come back — it will appear here automatically.</div>
      </div>
    );
  }
  const isDry = order && order.status === 'dryrun';
  return (
    <div style={{ marginTop: 6 }}>
      {isDry && (
        <div className="small" style={box}>
          <div style={{ fontWeight: 600, color: '#141B22' }}>Test run — nothing was sent</div>
          <div style={{ color: '#4B585C', marginTop: 2 }}>Test mode is on, so PILOT built the order but did not send it. Turn test mode off (in Settings → API health) to place a real order.</div>
          {order.raw && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ color: '#256168', cursor: 'pointer' }}>What PILOT would send (technical)</summary>
              <pre style={{ whiteSpace: 'pre-wrap', color: '#141B22', background: '#F4F1EA', padding: 8, borderRadius: 6, marginTop: 4, fontSize: 11 }}>{JSON.stringify(order.raw, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {!state.hasCompletedOrder && (
        <button className="btn ghost small" style={{ marginTop: isDry ? 6 : 0 }} disabled={busy || !state.hasLoanNumber} onClick={() => placeOrder(false)}>
          {busy ? 'Ordering…' : (errored || isDry) ? 'Order flood certificate again' : 'Order flood certificate'}
        </button>
      )}
      {!state.hasCompletedOrder && !state.hasLoanNumber && (
        <div className="small" style={{ color: '#4B585C', marginTop: 4 }}>
          {state.needs === 'address'
            ? 'Add the full property address (street, city, state, ZIP) to this file first — the flood certificate is ordered on the property address.'
            : state.needs === 'borrower'
              ? 'Add the borrower’s name to this file first — the flood certificate is issued in the borrower’s name.'
              : state.needs === 'loan_number'
                ? 'Add a loan number to this file first.'
                : 'This file isn’t ready to order a flood certificate yet.'}
        </div>
      )}
      {/* A determination already exists but the newest row is an error/dry run, so the
          "done" panel isn't showing. Say so, and keep the admin's deliberate re-order
          reachable here — otherwise a forced order that FAILS is a dead end: every
          later click is refused as already-completed with no way through. */}
      {state.hasCompletedOrder && (
        <div className="small" style={{ color: '#4B585C', marginTop: 6 }}>
          This file already has a flood determination, so an ordinary order is refused — each order is billable.
          {' '}Use “Get the certificate PDF” to pull down the one we already paid for.
        </div>
      )}
      {state.hasCompletedOrder && (
        <button className="btn ghost small" style={{ marginTop: 6 }} disabled={busy} onClick={fetchCert}>
          {busy ? 'Getting the certificate…' : 'Get the certificate PDF'}
        </button>
      )}
      {state.hasCompletedOrder && state.canReorder && (
        <button className="btn link small" style={{ marginTop: 4, color: '#256168', display: 'block' }}
          disabled={busy} onClick={reorder}>Order a new determination anyway (charges again)</button>
      )}
      {/* Quiet fallback: if a certificate can't be ordered (or you already have one),
          you can still attach it by hand — it's not the up-front action. */}
      {onUploadTo && (
        <button className="btn link small" style={{ marginTop: 6, color: '#256168', display: 'block' }}
          onClick={() => onUploadTo({ itemId, slotBase: 0 })}>Upload a certificate manually instead</button>
      )}
      {msg && <div className="notice" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="notice err" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// Shared between the appraisal-DOCUMENTS condition (context='docs') and the
// appraisal-REVIEW condition (context='review'). Both write the SAME
// appraisal_xml_waivers row + the SAME file As-Is/ARV, so entering the values on
// one side shows them "already entered — please confirm" on the other (both
// directions), with no separate storage to keep in step.
function AppraisalXmlWaiver({ appId, onChanged, context = 'docs' }) {
  const isReview = context === 'review';
  const [state, setState] = useState(null);     // { waiver, exception } | null
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('transferred_appraisal');
  const [note, setNote] = useState('');
  const [arv, setArv] = useState('');
  const [asIs, setAsIs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.appraisalXmlWaiverGet(appId).then(setState).catch(() => setState(null)), [appId]);
  useEffect(() => { load(); }, [load]);
  const isTransfer = reason === 'transferred_appraisal';

  // The owner's warning, shown BEFORE anyone types a value: there is no data file
  // to read from, so the numbers must be read off the appraisal PDF by hand, and a
  // wrong figure re-prices the whole loan.
  const warning = (
    <div className="small" style={{ padding: '8px 10px', border: '1px solid var(--danger, #b4442f)', borderRadius: 8, background: 'rgba(180,68,47,0.06)', color: '#141B22' }}>
      <strong>⚠️ Only use this if there is genuinely no XML for this appraisal.</strong> There is no
      data file to read the numbers from, so open the appraisal PDF yourself and read them by hand:
      find the <strong>ARV</strong>, and read the <strong>As-Is</strong> value specifically from the
      As-Is section of the report. A lot goes wrong if the figures are not exactly right — this value
      re-prices the whole loan.
    </div>
  );

  async function submit() {
    setErr('');
    if (!(Number(String(arv).replace(/[,$\s]/g, '')) > 0) || !(Number(String(asIs).replace(/[,$\s]/g, '')) > 0)) {
      setErr('Enter both the ARV and the As-Is value.'); return;
    }
    if (!isTransfer && !note.trim()) { setErr('Add a short note — it goes to an admin for an exception.'); return; }
    setBusy(true);
    try {
      await api.appraisalXmlWaiverSet(appId, { reason, note: note.trim() || undefined, arv, asIs });
      setOpen(false); setNote('');
      await load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not save the waiver.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setErr('');
    try { await api.appraisalXmlWaiverRemove(appId); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Could not remove the waiver.'); }
    finally { setBusy(false); }
  }

  const w = state && state.waiver;
  // The review-side entry does not apply on a file that already has an imported
  // appraisal (there IS XML) — self-hide unless a waiver was already recorded.
  if (isReview && state && state.hasAppraisal && !w) return null;
  if (w) {
    const ex = state.exception;
    // Same shared row on both sides. On the side you did NOT enter it from, this
    // reads "already entered — please confirm"; on the side you did, it reads as a
    // recorded waiver. Either way it shows the two values and how to clear.
    return (
      <div className="small" style={{ marginTop: 8, padding: '8px 10px', border: '1px solid var(--gold)', borderRadius: 8, background: 'rgba(174,135,70,0.06)' }}>
        <div style={{ fontWeight: 600, color: '#141B22' }}>
          {isReview ? 'No-XML appraisal — As-Is & ARV already entered' : 'No XML on this appraisal — XML waived'}
        </div>
        <div style={{ color: '#4B585C', marginTop: 2 }}>
          Reason: {(APPR_XML_REASONS.find(r => r.v === w.reason) || {}).label || w.reason}.
          {w.requires_transfer_letter
            ? ' Upload the transfer letter in the PDF slot on the appraisal documents condition; no exception is needed.'
            : ex
              ? ` This waiver ${ex.status === 'approved' ? 'was APPROVED' : ex.status === 'denied' ? 'was DENIED' : 'is waiting for an admin to approve it'} on the Exceptions screen${ex.exception_seq ? ` (EX-${ex.exception_seq})` : ''}.`
              : ''}
        </div>
        <div style={{ color: '#141B22', marginTop: 2, fontWeight: 600 }}>ARV ${moneyNum(w.arv).toLocaleString('en-US')} · As-Is ${moneyNum(w.as_is_value).toLocaleString('en-US')} — entered by hand.</div>
        {isReview && (
          <div style={{ color: '#4B585C', marginTop: 2 }}>
            These stand in for the appraisal review, so the term sheet can go out{w.requires_transfer_letter || (ex && ex.status === 'approved') ? '' : ' once the exception is approved'}. Please confirm
            they are correct against the appraisal report. Re-registering on these numbers is required
            (changing them re-opens Products &amp; Pricing).
          </div>
        )}
        <button className="btn ghost small" style={{ marginTop: 6 }} disabled={busy} onClick={remove}>Remove waiver (XML is available)</button>
        {err && <div className="notice err" style={{ marginTop: 6 }}>{err}</div>}
      </div>
    );
  }
  if (!open) {
    if (isReview) {
      return (
        <div style={{ marginBottom: 12, padding: '10px 12px', border: '1px solid var(--line,#d9d3c6)', borderRadius: 10, background: '#fff' }}>
          <div style={{ fontWeight: 600, color: '#141B22' }}>Appraisal review — no XML available?</div>
          <div className="small" style={{ color: '#4B585C', marginTop: 2 }}>
            Use this only when there is genuinely no appraisal XML for PILOT to review. It records the
            As-Is and ARV by hand, stands in for the appraisal review, and lets the term sheet go out.
          </div>
          <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
            No appraisal XML? Enter the As-Is &amp; ARV to clear the review
          </button>
        </div>
      );
    }
    return (
      <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        No XML available?
      </button>
    );
  }
  return (
    <div className="small" style={{ marginTop: 8, padding: '10px', border: '1px solid var(--line, #d9d3c6)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600, color: '#141B22' }}>No appraisal XML available</div>
      {warning}
      <div style={{ color: '#4B585C' }}>
        {isReview
          ? 'With no XML there are no PILOT appraisal findings to review, so entering the As-Is and ARV by hand stands in for the review (the same as signing off the appraisal documents slot). The appraisal PDF is still required there.'
          : 'The PDF report is still required. Enter the ARV and As-Is by hand (we normally read these off the XML).'}
      </div>
      <label style={{ color: '#141B22' }}>Why is there no XML?
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginTop: 4 }}>
          {APPR_XML_REASONS.map(r => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
      </label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label style={{ color: '#141B22', flex: 1, minWidth: 140 }}>ARV
          <input className="input" inputMode="decimal" placeholder="$" value={arv} onChange={(e) => setArv(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label style={{ color: '#141B22', flex: 1, minWidth: 140 }}>As-Is value
          <input className="input" inputMode="decimal" placeholder="$" value={asIs} onChange={(e) => setAsIs(e.target.value)} style={{ marginTop: 4 }} />
        </label>
      </div>
      {!isTransfer && (
        <label style={{ color: '#141B22' }}>Note (goes to an admin for an exception)
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 4 }} />
        </label>
      )}
      {isTransfer && <div style={{ color: '#4B585C' }}>A transferred appraisal waives automatically — just upload the transfer letter in the PDF slot on the appraisal documents condition. No exception needed.</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary small" disabled={busy} onClick={submit}>{busy ? 'Saving…' : (isTransfer ? 'Waive XML (transferred)' : 'Waive XML & request exception')}</button>
        <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
      </div>
      {err && <div className="notice err">{err}</div>}
      <div style={{ color: '#4B585C' }}>Changing the ARV / As-Is re-opens Products &amp; Pricing so the loan is re-priced on the new numbers.</div>
    </div>
  );
}

/* WHICH SLOT DOES THIS DOCUMENT BELONG TO?
   A slot KEEPS EVERY document dropped into it, and the upload path makes each
   label unique so two files don't display identically — lib/slot-label.js turns
   the second "Insurance binder" into "Insurance binder (2)". The slot renderer
   matched on an EXACT label, so that second document fell out of its own slot the
   moment it was uploaded. Strip the numeric suffix before comparing, which is the
   one place these two conventions meet. */
function slotBaseLabel(label) {
  return String(label || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}
function docInSlot(doc, slotLabel) {
  // Case-INSENSITIVE, matching the server's baseLabel (extra-slots.js) — the
  // sign-off gate lowercases both sides, so the screen must count the same
  // documents as filling a slot that the gate does (audit 078cb1a #7).
  return slotBaseLabel(doc && doc.slot_label).toLowerCase() === String(slotLabel || '').trim().toLowerCase();
}

/* DOCUMENTS ON A SLOTTED CONDITION THAT ARE NOT IN A SLOT (owner-directed
   2026-08-03).
   A condition that declares named slots — Insurance declares "Insurance binder"
   and "Insurance invoice" — used to render ONLY those slots, matching a document
   to a slot by an exact label compare. So a document sitting on the condition
   with no slot, or with any other label, was INVISIBLE there: the insurance
   condition went on saying "not uploaded" while the agent's PDFs were attached to
   it. That is precisely what a returned order document looks like — it arrives
   unassigned on purpose, so a human decides what it is.
   The owner's rule: they land as ordinary documents in the condition, each with a
   preview, and you choose the slot they belong to — binder, invoice, or leave
   them here unassigned. Same DocActions as every other document row, so accept /
   reject / download / replace all work exactly as they do in a slot. */
function UnslottedConditionDocs({ appId, it, docs, slotLabels, role, onReviewDoc, onDownloadDoc, onPreview, dlBusy, onUploadTo, onChanged }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  if (!docs.length) return null;
  const assign = async (docId, slot) => {
    setBusy(docId); setErr('');
    try { await api.staffSetDocSlot(appId, docId, slot); if (onChanged) await onChanged(); }
    catch (e) { setErr((e && e.message) || 'Could not file that document into the slot.'); }
    finally { setBusy(''); }
  };
  return (
    <div style={{ marginTop: 6, borderTop: '1px solid var(--line,#D9D4C8)', paddingTop: 6 }}>
      <div className="small" style={{ fontWeight: 700, color: '#141B22' }}>
        Also in this condition ({docs.length}) — not filed into a slot
      </div>
      <div className="small" style={{ color: '#4B585C', margin: '2px 0 4px' }}>
        Documents that came back on the order, or were uploaded without a type. Preview each one and
        choose the slot it belongs in — or leave it here.
      </div>
      {err && <div className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
      {docs.map((d) => {
        const rs = d.review_status || 'pending';
        return (
          <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0', alignItems: 'center' }}>
            <span className="muted small" style={{ minWidth: 140 }}>{d.slot_label || 'Not assigned'}</span>
            <span className="small" style={{ flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
            <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
            <select className="input" style={{ width: 'auto' }} disabled={busy === d.id}
              value={slotLabels.includes(slotBaseLabel(d.slot_label)) ? slotBaseLabel(d.slot_label) : ''}
              title="File this document into one of the condition's slots"
              onChange={(e) => assign(d.id, e.target.value)}>
              <option value="">Leave unassigned…</option>
              {slotLabels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <DocActions doc={d} role={role} onReviewDoc={onReviewDoc} fullscreen
              onDownloadDoc={onDownloadDoc} onPreview={onPreview} dlBusy={dlBusy}
              onReplace={onUploadTo ? () => onUploadTo({ itemId: it.id, slot: d.slot_label || undefined, replaceDocumentId: d.id }) : null} />
          </div>
        );
      })}
    </div>
  );
}

/* ORDER STRAIGHT FROM THE CONDITION (owner-directed 2026-08-03: "we should have a
   small button over there in the condition — order title and order insurance —
   which should pop up a screen … so you can order directly from the condition to
   make it easier").
   Four conditions carry it: the title CONTACT and title DOCUMENTS conditions open
   the title order, the insurance CONTACT and insurance DOCUMENTS conditions open
   the insurance order. The button opens the real Orders-desk card in a modal, so
   the contact, the loan number, the recipients, the send and the documents that
   came back are all right there — nothing about ordering is reimplemented here. */
const CONDITION_ORDER_KIND = {
  rtl_p1_titlec: 'title', rtl_cond_title: 'title',
  rtl_p1_insc: 'insurance', rtl_cond_insurance: 'insurance',
};
const TOOL_ORDER_KIND = { title_contact: 'title', insurance_contact: 'insurance' };
function orderKindForCondition(it) {
  return CONDITION_ORDER_KIND[it.template_code] || TOOL_ORDER_KIND[it.tool_key] || null;
}

function ConditionOrderButton({ appId, it, role, onChanged }) {
  const [open, setOpen] = useState(false);
  const kind = orderKindForCondition(it);
  if (!kind) return null;
  return (
    <>
      <button className="btn ghost small" onClick={() => setOpen(true)}
        title={`Open the ${kind} order for this file — add the contact, the loan number, and send it, without leaving this condition`}>
        Order {kind}
      </button>
      {open && (
        <OrderModal appId={appId} kind={kind} canAccept={canComplete(role)}
          onClose={() => setOpen(false)} onChanged={onChanged} />
      )}
    </>
  );
}

/* REQUEST ANOTHER DOCUMENT WITHIN A CONDITION (db/578, owner-directed 2026-08-18:
   "you got one document and you wanna request another document within that
   condition … there should be a button for the staff members to open up another
   slot in a condition and type the name of that slot. That should populate as an
   open item needing it"). Opens a NAMED slot on THIS condition: an external ask
   shows on the borrower's portal as still needed (and they are notified); an
   internal one is our own team's to-do. The uploaded document files INTO the
   condition — same folder in the TPR export, same SharePoint mirror. Opening a
   slot on a signed-off condition REOPENS it (the sign-off predates this ask). */
function RequestSlotButton({ appId, it, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (it.item_kind !== 'document') return null;
  const borrowerFacing = it.audience === 'borrower' || it.audience === 'both';
  const ask = async () => {
    const label = await askPrompt('Name the document you are requesting on this condition (e.g. "Updated operating agreement", "October bank statement"):',
      { placeholder: 'Document name', confirmLabel: 'Request it' });
    if (label == null || !String(label).trim()) return;
    const name = String(label).trim();
    let audience = 'internal';
    if (borrowerFacing) {
      // Two explicit steps, so Escape/backdrop is always an ABORT — never a
      // silent "internal" nobody chose.
      const ext = await askConfirm(`Should the BORROWER provide "${name}"?\n\nYes — it shows on their portal as still needed and they are notified.\nNo — it stays an internal ask for our own team.`,
        { confirmLabel: 'Yes — from the borrower', cancelLabel: 'No — internal' });
      if (ext) audience = 'external';
      else if (!(await askConfirm(`Add "${name}" as an INTERNAL ask? The borrower will not see it.`, { confirmLabel: 'Add internal ask' }))) return;
    }
    setBusy(true);
    try {
      let r;
      try {
        r = await api.conditionSlotAdd(appId, it.id, { label: name, audience });
      } catch (e) {
        // The stray-label guard offers "add anyway" — the same affordance every
        // other hand-typed-label surface has (never a dead end).
        const d = (e && e.data) || {};
        if (d.code === 'stray_condition_label' && d.needsConfirm) {
          if (!(await askConfirm(`${d.error}\n\nRequest "${name}" anyway?`, { confirmLabel: 'Yes — request it' }))) return;
          r = await api.conditionSlotAdd(appId, it.id, { label: name, audience, confirmStrayLabel: true });
        } else throw e;
      }
      if (r && r.reopened) await showMessage('This condition was signed off — it has been reopened, since the new request was made after that sign-off.');
      if (onChanged) await onChanged();
    } catch (e) {
      await showMessage(((e && e.data && e.data.error) || (e && e.message)) || 'Could not open the document slot.');
    } finally { setBusy(false); }
  };
  return (
    <button className="btn ghost small" disabled={busy} onClick={ask}
      title="Open another named document slot on this condition — the uploaded document stays part of this condition (same folder in the TPR export)">
      Request another document
    </button>
  );
}

function Item({ it, team, onPatch, role, docs, onUploadTo, onDropTo, onReviewDoc, onDownloadDoc, dlBusy, onPreview, appId, onChanged, canImportCredit, fullscreen = false, onRequestWaiver, expanded = false, onToggleExpand }) {
  const [open, setOpen] = useState(false);
  // EVERY condition is a compact line until you open it (owner-directed
  // 2026-07-28: "one compact line each, click to open the one you're working").
  //
  // OPEN/SHUT IS THE PARENT'S `expandedConds`, NOT LOCAL STATE (2026-08-07). This
  // row used to keep its own `expandOverride`, so the list ran on TWO collapse
  // stores — the internal rows on this one, every other row on the parent's Set.
  // That is the same root as the wandering Collapse button: two stores cannot help
  // but behave differently, and they did (full screen opened both but restored only
  // one on the way out, and no "open/close everything" could ever reach these
  // rows). One Set now owns every row on the file.
  const signed = !!it.signed_off_at;
  // No `completer` here any more — who may do what is decided inside the shared
  // action bar (components/ConditionActions), so this row cannot answer that
  // question differently from the borrower-facing one.
  const myDone = roleDone(it, role);
  const isDoc = it.item_kind === 'document';
  const slots = Array.isArray(it.slots) && it.slots.length ? it.slots : null;
  // The flood certificate is ORDERED from Encompass and the PDF auto-files onto
  // this condition (owner-directed 2026-07-30 — "same logic as the credit report;
  // it uploads automatically, so you don't need the upload button in front"). So
  // suppress the generic manual-upload button/drop here; the filed certificate
  // still lists + downloads below, and a manual fallback lives on the order button.
  const genericUpload = it.template_code === 'rtl_cond_flood' ? null : onUploadTo;
  const itemDocs = (isDoc && docs)
    ? docs.filter(d => d.checklist_item_id === it.id && d.is_current && d.source_type !== 'chat_attachment')
    : [];
  // Full screen opens everything — the parent seeds `expandedConds` with every
  // visible row on the way in and restores the normal state on the way out, so an
  // internal condition now behaves exactly like every other one.
  if (!expanded) {
    return (
      // data-keep-scroll: a stable handle so a refresh can put this row back
      // exactly where it was on screen (lib/keep-scroll.js).
      <div className="checkitem" data-keep-scroll={`item-${it.id}`} style={{ padding: '2px 10px' }}>
        <ConditionLine it={it} role={role} docs={itemDocs} open={false} done={myDone}
          onToggle={onToggleExpand} onPatch={onPatch} />
      </div>
    );
  }
  // isDoc / slots / itemDocs are computed above the collapse guard — the compact
  // line needs itemDocs too, to say how many documents are waiting.
  // `it.slots` is a FIXED named-slot array (Insurance → binder + invoice) or
  // null/absent for a FREE-FORM multi-document condition (Title).
  return (
    <div className="checkitem" data-keep-scroll={`item-${it.id}`} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
        <span className={`dot ${signed ? 'cond-satisfied' : conditionStatusClass(it.status)}`} style={{ marginTop: 4 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{it.label}</div>
          {/* ONE stamp for who sees it, replacing the four raw-database chips
              (audience, role_scope, item_kind) that were printed verbatim on
              every row — owner-directed 2026-07-28. The rest stays only where
              it changes what you do: a gate, an optional condition, a borrower
              task, work awaiting sign-off. */}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <span className={`aud ${audienceStamp(it.audience).cls}`}
              title={audienceStamp(it.audience).title}>{audienceStamp(it.audience).label}</span>
            {it.is_required === false && <Badge>optional</Badge>}
            {it.is_gate && <Badge tone="gold">gate</Badge>}
            {it.is_milestone && <Badge tone="gold">milestone</Badge>}
            {it.tool_key && <Badge tone="gold">{it.tool_submitted ? 'borrower submitted' : 'borrower task'}</Badge>}
            {!signed && it.reviewed_at && <Badge>done ✓ awaiting sign-off</Badge>}
            <PilotAdvice it={it} />
          </div>
          <PilotAdviceNote it={it} />
          {it.hint && <LoudHint hint={it.hint} className="muted small" style={{ marginTop: 4 }} />}
          {it.assignee_name && <div className="muted small">Assigned to {it.assignee_name}</div>}
          {signed && (it.waived_at
            ? <div className="muted small">Waived by {it.waived_by_name || 'the internal team'} · {new Date(it.waived_at).toLocaleDateString()}</div>
            : <div className="muted small">Signed off by {it.signed_off_name || 'the internal team'} · {new Date(it.signed_off_at).toLocaleDateString()}</div>)}
          {/* A condition cleared without what it asks for says so on its face —
              never only in the audit log (owner-directed 2026-07-27). */}
          {it.override_at && <div className="small" style={{ marginTop: 4, color: 'var(--gold, #AE8746)' }}>{overrideLine(it)}</div>}
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
        {/* Top-right, always — the ONE shared control (components/ConditionLine). */}
        <ConditionCollapse onToggle={onToggleExpand} />
      </div>

      {it.template_code === 'rtl_cond_credit' && (
        // The import button follows the SERVER's canImport (the pull_credit gate);
        // `canPull` is only the pre-load fallback, so pass the same capability a loan
        // officer now has — never `completer` (that would flash the button off for LOs).
        // `field_key` tells it WHICH credit condition this is: the file-level one, or
        // a co-borrower's own ('cob_credit') — which shows that borrower's report
        // only, instead of repeating the whole file's credit section twice.
        <CreditCondition appId={appId} canPull={canImportCredit} onChanged={onChanged} fieldKey={it.field_key} itemId={it.id} />
      )}

      {/* The typed answer, for the conditions that ARE a typed answer — the note
          buyer, the YS loan number, the As-Is value. All three are internal, so
          this row shape is where they actually land. Same component the
          borrower-facing rows use; see CondInlineEntry. */}
      <CondInlineEntry it={it} appId={appId} onChanged={onChanged} indent />

      {/* The credit condition's PDF/XML are managed by <CreditCondition> above
          (download there). Suppress the generic free-form doc block for it so the
          same files don't render twice with destructive Delete/Reject/+Add
          controls that would orphan credit_reports' document pointers. */}
      {isDoc && it.template_code !== 'rtl_cond_credit' && (genericUpload || itemDocs.length > 0) && (
        <div style={{ width: '100%', paddingLeft: 20 }}
          className={(!slots && onDropTo && it.template_code !== 'rtl_cond_flood') ? 'cond-drop' : undefined}
          onDragOver={(!slots && onDropTo && it.template_code !== 'rtl_cond_flood') ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); } : undefined}
          onDragLeave={(!slots && onDropTo && it.template_code !== 'rtl_cond_flood') ? (e) => { e.currentTarget.classList.remove('drop-over'); } : undefined}
          onDrop={(!slots && onDropTo && it.template_code !== 'rtl_cond_flood') ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); onFilesDropped(e, (files) => onDropTo(files, { itemId: it.id, slotBase: itemDocs.length })); } : undefined}>
          {slots ? (
            /* Fixed named slots (e.g. Insurance → binder + invoice) — each slot is
               its own drop target so a dropped file lands in the right slot. Every
               slot KEEPS EVERY document dropped in it (owner-directed): uploading a
               second file ADDS it, it never replaces the first. "Replace" is an
               explicit per-document action; the slot's Upload/drop always adds.
               Anything on the condition that is NOT in one of these slots is listed
               underneath by <UnslottedConditionDocs> — never dropped from the
               screen, which is what hid every returned insurance document. */
            <>
            {slots.map(slot => {
              const slotDocs = itemDocs.filter(d => docInSlot(d, slot.label));
              const addTarget = { itemId: it.id, slot: slot.label };   // no replaceDocumentId → additive
              return (
                <div className={`row${onDropTo ? ' cond-drop' : ''}`} key={slot.key || slot.label} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0', alignItems: 'flex-start' }}
                  onDragOver={onDropTo ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); } : undefined}
                  onDragLeave={onDropTo ? (e) => { e.currentTarget.classList.remove('drop-over'); } : undefined}
                  onDrop={onDropTo ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); onFilesDropped(e, (files) => onDropTo(files, addTarget)); } : undefined}>
                  <span className="muted small" style={{ minWidth: 140 }}>{slot.label}</span>
                  {/* An ad-hoc requested slot (db/578) says so on its face — who
                      asked, and whether the borrower owes it or our own team. */}
                  {slot.extra && (
                    <span className="pill" style={{ borderColor: 'var(--gold, #AE8746)', color: 'var(--gold, #AE8746)' }}
                      title={`Requested${slot.added_by_name ? ` by ${slot.added_by_name}` : ''} — ${slot.audience === 'external' ? 'needed from the borrower' : 'internal'}`}>
                      requested{slot.audience === 'external' ? ' · borrower' : ' · internal'}
                    </span>
                  )}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    {slotDocs.length === 0 ? (
                      <div className="row" style={{ gap: 8 }}>
                        <span className="small muted" style={{ flex: 1 }}>not uploaded</span>
                        {onUploadTo && <button className="btn ghost small" onClick={() => onUploadTo(addTarget)}>Upload</button>}
                        {slot.extra && (
                          <button className="btn ghost small" title="Remove this request (only an unfilled slot can be removed)"
                            onClick={async () => {
                              if (!(await askConfirm(`Remove the request for "${slot.label}"?`))) return;
                              try { await api.conditionSlotRemove(appId, it.id, String(slot.key).replace(/^extra:/, '')); if (onChanged) await onChanged(); }
                              catch (e) { await showMessage((e && e.message) || 'Could not remove the request.'); }
                            }}>Remove</button>
                        )}
                      </div>
                    ) : (
                      <>
                        {slotDocs.map((doc) => {
                          const rs = doc.review_status || 'pending';
                          return (
                            <div className="row" key={doc.id} style={{ gap: 8, flexWrap: 'wrap' }}>
                              <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.filename}</span>
                              <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                              <DocActions doc={doc} role={role} onReviewDoc={onReviewDoc} fullscreen={fullscreen}
                                onDownloadDoc={onDownloadDoc} onPreview={onPreview} dlBusy={dlBusy}
                                onReplace={onUploadTo ? () => onUploadTo({ itemId: it.id, slot: slot.label, replaceDocumentId: doc.id }) : null} />
                            </div>
                          );
                        })}
                        {onUploadTo && (
                          <div className="row" style={{ gap: 8 }}>
                            <button className="btn ghost small" onClick={() => onUploadTo(addTarget)}>+ Add another</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <UnslottedConditionDocs appId={appId} it={it} role={role}
              docs={itemDocs.filter((d) => !slots.some((s) => docInSlot(d, s.label)))}
              slotLabels={slots.map((s) => s.label)}
              onReviewDoc={onReviewDoc} onDownloadDoc={onDownloadDoc} onPreview={onPreview}
              dlBusy={dlBusy} onUploadTo={onUploadTo} onChanged={onChanged} />
            </>
          ) : (
            /* Free-form: any number of documents, additive (e.g. Title). */
            <>
              {itemDocs.map((d, i) => {
                const rs = d.review_status || 'pending';
                return (
                  <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                    {/* 140, matching the fixed-slot rows above — a free-form
                        condition (Title) sat on a narrower label column, so its
                        filename and buttons started at a different x than every
                        other condition on the file. Owner-reported 2026-07-27. */}
                    <span className="muted small" style={{ minWidth: 140 }}>{d.slot_label || `Document ${i + 1}`}</span>
                    <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                    <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                    <DocActions doc={d} role={role} onReviewDoc={onReviewDoc} fullscreen={fullscreen}
                      onDownloadDoc={onDownloadDoc} onPreview={onPreview} dlBusy={dlBusy}
                      onReplace={(onUploadTo && d.source_type !== 'system')
                        ? () => onUploadTo({ itemId: it.id, slot: d.slot_label || undefined, replaceDocumentId: d.id }) : null} />
                  </div>
                );
              })}
              {genericUpload && (
                /* Same labelled-row shape as a fixed slot, so the button starts
                   where every other condition's controls start. With nothing
                   uploaded it used to be a bare button floating in the indent,
                   which is what made Title look unlike the rest of the list. */
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                  <span className="muted small" style={{ minWidth: 140 }}>
                    {itemDocs.length ? 'Another document' : 'Documents'}
                  </span>
                  <button className="btn ghost small"
                    title="Upload documents into this condition (multiple at once supported)"
                    onClick={() => onUploadTo({ itemId: it.id, slotBase: itemDocs.length })}>
                    {itemDocs.length ? '+ Add another document' : 'Upload'}
                  </button>
                  {!itemDocs.length && <span className="muted small">or drop files anywhere in this box</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Appraisal condition: "No XML available" — waive the XML slot (PDF stays
          required), type the ARV + As-Is by hand, and route the reason to a
          transfer letter or an admin exception. (The REVIEW-side entry point for
          the same waiver lives in the "Appraisal & findings" section — the
          appraisal-review task itself is worked from My Tasks, not this list.) */}
      {it.template_code === 'rtl_cond_appraisaldocs' && (
        <AppraisalXmlWaiver appId={appId} onChanged={onChanged} />
      )}
      {/* Flood condition — order the flood certificate from Encompass (flood only). */}
      {it.template_code === 'rtl_cond_flood' && (
        <OrderFloodButton appId={appId} itemId={it.id} onChanged={onChanged} onUploadTo={onUploadTo} />
      )}

      {/* Title / insurance — order it from right here. */}
      {orderKindForCondition(it) && (
        <div className="row" style={{ gap: 8, paddingLeft: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <ConditionOrderButton appId={appId} it={it} role={role} onChanged={onChanged} />
          <span className="muted small">
            Opens the {orderKindForCondition(it)} order — add the contact and the loan number and send it without leaving this condition.
          </span>
        </div>
      )}

      {it.template_code === 'usps_address_verification' && (
        <UspsAddressVerification appId={appId} onChanged={onChanged} />
      )}

      {/* Ask for one more document WITHIN this condition (db/578) — never a
          brand-new condition for a follow-up document. */}
      {isDoc && it.template_code !== 'rtl_cond_credit' && (
        <div className="row" style={{ gap: 8, paddingLeft: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <RequestSlotButton appId={appId} it={it} onChanged={onChanged} />
        </div>
      )}

      {/* ONE next step, everything else behind More — the shared bar, so this
          row and the borrower-facing one can never drift again. Collapse is NOT in
          here: it is a view control, not an action on the loan, and mixing the two
          is what put it at the bottom of this one row and nowhere else. */}
      <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
        <ConditionActions it={it} role={role} team={team} onPatch={onPatch}
          docs={itemDocs} size="" onRequestWaiver={onRequestWaiver} />
      </div>
      <ConditionNote it={it} onPatch={onPatch} />
    </div>
  );
}

/* Every ENTITY of this borrower — the staff review surface for the entity section.
   The file's vesting entity is expanded first; each one shows its details,
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
  // collapsed behind this toggle so staff verify just the entity on this property.
  const [showOthers, setShowOthers] = useState(false);
  const blankCreate = { llcName: '', entityType: '', entitySubtype: '', ein: '', formationState: '', formationDate: '', ownershipPct: '' };
  const [cf, setCf] = useState(blankCreate);
  function beginEdit(l) {
    setEditId(l.id); setErr('');
    setEf({ llcName: l.llc_name || '', ein: l.ein || '', formationState: l.formation_state || '',
      formationDate: l.formation_date ? String(l.formation_date).slice(0, 10) : '',
      ownershipPct: l.ownership_pct == null ? '' : String(l.ownership_pct),
      // Blank until somebody CHOSE one — db/509 stamped the back book as an LLC
      // with nobody saying so, and pre-selecting that assumption would turn it
      // into a stated fact the first time anyone pressed Save.
      entityType: l.entity_type_confirmed ? (l.entity_type || '') : '',
      entitySubtype: l.entity_subtype || '' });
    setEm((l.members || []).map(m => ({
      fullName: m.full_name, ownershipPct: String(m.ownership_pct), email: m.email || '',
      memberKind: m.member_kind === 'entity' ? 'entity' : 'person',
      ownerLlcId: m.owner_llc_id || null,
      memberTitle: m.member_title || '', shares: m.shares == null ? '' : String(m.shares),
      certificateNumber: m.certificate_number || '',
    })));
  }
  async function saveEdit(l) {
    setBusy('edit-' + l.id); setErr('');
    try {
      await api.staffUpdateLlc(l.id, ef);
      // memberKind/ownerLlc round-trip so an entity member (layered entity)
      // survives a staff edit instead of silently becoming a person.
      await api.staffSaveLlcMembers(l.id, (em || []).filter(m => m.fullName.trim()).map(m => ({
        fullName: m.fullName.trim(), ownershipPct: Number(m.ownershipPct),
        email: m.memberKind === 'entity' ? undefined : (m.email.trim() || undefined),
        memberKind: m.memberKind === 'entity' ? 'entity' : 'person',
        ownerLlcId: m.memberKind === 'entity' ? (m.ownerLlcId || undefined) : undefined,
        ownerLlcName: m.memberKind === 'entity' ? m.fullName.trim() : undefined,
        /* Who signs and as what. A company owner holds no title and no
           certificate — it signs through its own people, recorded on its own
           row — so it is skipped. Sent as keys so a blank deliberately clears. */
        ...(m.memberKind !== 'entity' ? {
          memberTitle: m.memberTitle || '',
          shares: m.shares === '' ? null : m.shares,
          certificateNumber: m.certificateNumber || '',
        } : {}) })));
      flash('Entity saved ✓ — the borrower sees the same details.');
      setEditId(null); await load(); onChanged && await onChanged();
    } catch (e) { setErr(e.message || 'Could not save the entity'); }
    finally { setBusy(''); }
  }
  const entityGate = useSubmitGate();
  async function createEntity() {
    if (!cf.llcName.trim()) { setErr('Entity name is required'); return; }
    // WHICH KIND (owner-directed 2026-08-09) — it decides which governing
    // document the borrower is asked for, so it is not optional at creation.
    if (!cf.entityType) { setErr('Pick what kind of entity it is — it decides which documents we ask for.'); return; }
    if (!entityGate.enter()) return;       // a create is already in flight (double-click)
    setBusy('create'); setErr('');
    try {
      const created = await api.staffCreateLlc(app.borrower_id, {
        llcName: cf.llcName.trim(), entityType: cf.entityType, entitySubtype: cf.entitySubtype || undefined,
        ein: cf.ein || undefined, formationState: cf.formationState || undefined,
        formationDate: cf.formationDate || undefined, ownershipPct: cf.ownershipPct === '' ? undefined : Number(cf.ownershipPct) });
      // The verify list is now scoped to the vesting + track-record entities, so a
      // brand-new entity would not appear unless it's linked. When the file has no
      // vesting entity yet, the one just created here IS the file's vesting entity —
      // link it so it shows (and drives the entity condition). If one already exists,
      // leave it: this was a plain library add and will surface once tied to a deal.
      let linkedNow = false;
      if (!app.llc_id && created && created.llcId) {
        try { await api.staffSetVestingLlc(appId, created.llcId); linkedNow = true; } catch (_) { /* best-effort */ }
      }
      // A name the borrower already has is REUSED (merge), not created anew — say
      // so honestly rather than claiming a fresh entity with empty document slots.
      flash(created && created.existed
        ? (linkedNow
            ? 'This entity already existed — linked it to this file with its documents & verification.'
            : 'This entity already existed — it’s in the borrower’s entities list.')
        : 'Entity created ✓ — its document slots are ready for upload.');
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
      reason = await askPrompt('Revoke verification of this entity? The entity condition reopens on every open file vesting in it, and the borrower is notified. Reason (the borrower is told why — required):');
      if (reason === null || !reason.trim()) return;   // reason is required (#125)
    } else if (!(await askConfirm(`Mark "${llc.llc_name}" as verified? The entity condition on every open file vesting in it is satisfied and signed off automatically.`))) return;
    setBusy(llc.id); setErr('');
    try {
      await api.staffVerifyLlc(llc.id, verified ? { verified: true } : { verified: false, reason: reason || undefined });
      flash(verified ? 'Entity verified ✓ — linked files updated.' : 'Verification revoked — linked files reopened.');
      await load(); onChanged && await onChanged();
    } catch (e) {
      if (e.status === 409 && e.data && e.data.missing) setErr(`Not ready to verify: ${e.data.missing.join(' · ')}`);
      else setErr(e.message || 'Could not update the entity');
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
        <h3>Vesting entity</h3>
        <div className="spacer" />
        <span className="muted small">{llcs ? `${llcs.length} entit${llcs.length === 1 ? 'y' : 'ies'}` : ''}</span>
        <button className="btn ghost small" onClick={() => { setShowCreate(v => !v); setErr(''); }}>{showCreate ? 'Cancel' : '+ Add entity'}</button>
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        The entity taking title on this property. Confirm its details, ownership (to 100%) and the three
        documents, then mark it verified — that satisfies the internal entity condition on this and every
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
            {/* WHAT KIND OF COMPANY (owner-directed 2026-08-09). A corporation is
                asked for bylaws and a stock certificate where an LLC is asked for
                an operating agreement, and the loan documents need to know whether
                its owners hold a percentage or shares. */}
            <label><span>Entity type *</span>
              <select className="input" value={cf.entityType} onChange={e => setCf({ ...cf, entityType: e.target.value, entitySubtype: '' })}>
                <option value="">Select…</option>
                {ENTITY_TYPES.map(t => <option key={t.key} value={t.key}>{t.longLabel}</option>)}
              </select></label>
            {/* Only a partnership and a trust have a kind, and it decides what we
                may ask them for — a revocable trust has no EIN of its own, a
                general partnership no state filing. */}
            {hasSubtypes(cf.entityType) && (
              <label><span>What kind?</span>
                <select className="input" value={cf.entitySubtype} onChange={e => setCf({ ...cf, entitySubtype: e.target.value })}>
                  <option value="">Select…</option>
                  {subtypesFor(cf.entityType).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select></label>
            )}
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
            : app.personal_name_purchase
              /* An individual purchase has no entity BY DEFINITION, so telling
                 the officer to go and create one is the one instruction that
                 must never appear here (owner-reported 2026-08-03). */
              ? 'This file closes as an individual — title goes in the borrower’s own name, so there is no entity to verify. Switch it back to an entity on the entity condition below if that is wrong.'
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
                    {l.layered && <span className="pill" style={{ marginLeft: 8 }} title="A layered entity — it owns (part of) another entity on this file. It must be verified before the entity it owns can be.">Owning entity (layered)</span>}
                  </div>
                  <div className="muted small">
                    {l.formation_state || 'state —'} · EIN {l.ein || '—'} · {c.docs_accepted || 0}/{c.docs_required || 3} docs accepted
                    {l.is_verified && l.verified_at ? ` · verified ${new Date(l.verified_at).toLocaleDateString()}` : ''}
                  </div>
                </div>
                <span className={`ts-badge ${l.is_verified ? 'ok' : (l.missing || []).length ? 'warn' : 'ok'}`}>
                  {l.is_verified ? 'Verified ✓' : (l.missing || []).length ? 'Unverified' : 'Ready to verify'}
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
                            {/* WHAT KIND OF COMPANY (owner-directed 2026-08-09) — it
                                decides which governing document the borrower is asked
                                for and which titles the owners below may hold. */}
                            <label><span>Entity type</span>
                              <select className="input" value={ef.entityType || ''} onChange={e => setEf({ ...ef, entityType: e.target.value, entitySubtype: '' })}>
                                <option value="">Not confirmed — treated as an LLC</option>
                                {ENTITY_TYPES.map(t => <option key={t.key} value={t.key}>{t.longLabel}</option>)}
                              </select></label>
                            {hasSubtypes(ef.entityType) && (
                              <label><span>What kind?</span>
                                <select className="input" value={ef.entitySubtype || ''} onChange={e => setEf({ ...ef, entitySubtype: e.target.value })}>
                                  <option value="">Not stated</option>
                                  {subtypesFor(ef.entityType).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                                </select></label>
                            )}
                          </div>
                          <div style={{ fontWeight: 600, marginTop: 12 }}>Other owners</div>
                          <p className="muted small" style={{ marginBottom: 6 }}>
                            Everyone besides the borrower, until ownership totals 100%. Each one needs a TITLE — it prints
                            under their signature on the recorded documents, so the closing package cannot be drafted without it.
                          </p>
                          {(em || []).map((m, i) => (
                            <div className="row" key={i} style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
                              <input className="input" style={{ flex: 2, minWidth: 150 }}
                                placeholder={m.memberKind === 'entity' ? 'Owning entity name' : 'Owner full name'} value={m.fullName}
                                onChange={e => setEm(ms => ms.map((x, j) => j === i
                                  ? { ...x, fullName: e.target.value, ...(x.memberKind === 'entity' ? { ownerLlcId: null } : {}) }
                                  : x))} />
                              <input className="input" style={{ width: 90 }} type="number" min="0.01" max={m.memberKind === 'entity' ? 100 : 99.99} placeholder="%" value={m.ownershipPct}
                                onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, ownershipPct: e.target.value } : x))} />
                              {m.memberKind !== 'entity' && (
                                <EmailInput style={{ flex: 2, minWidth: 150 }} placeholder="Email (optional)" value={m.email}
                                  onChange={v => setEm(ms => ms.map((x, j) => j === i ? { ...x, email: v } : x))} />
                              )}
                              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                title="Layered entity: this slice is owned by ANOTHER COMPANY, not a person. It gets its own full entity section (details, ownership, three documents) and must verify before this one.">
                                <input type="checkbox" checked={m.memberKind === 'entity'}
                                  onChange={e => setEm(ms => ms.map((x, j) => j === i
                                    ? { ...x, memberKind: e.target.checked ? 'entity' : 'person', ownerLlcId: null, email: '' }
                                    : x))} />
                                A company
                              </label>
                              <button className="btn link small" onClick={() => setEm(ms => ms.filter((_, j) => j !== i))}>Remove</button>
                              {/* WHO SIGNS, AND AS WHAT (owner-directed 2026-08-09).
                                  A DROPDOWN, never a text box: this value prints under
                                  a signature line on a recorded instrument and the
                                  document engine merges it verbatim, so "managing
                                  member", "Managing Member" and "MGR" must not all be
                                  reachable. Shares and the certificate number are the
                                  corporation's analogue of the percentage — a pledge of
                                  shares has to name the exact certificate handed over,
                                  the way a mortgage names the exact property. */}
                              {m.memberKind !== 'entity' && (
                                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', width: '100%', paddingLeft: 4 }}>
                                  <select className="input" style={{ flex: 1, minWidth: 170 }} value={m.memberTitle || ''}
                                    aria-label={`Title for ${m.fullName || 'this owner'}`}
                                    onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, memberTitle: e.target.value } : x))}>
                                    <option value="">Title — not set</option>
                                    {titlesFor(ef.entityType || l.entity_type).map(t => <option key={t} value={t}>{t}</option>)}
                                  </select>
                                  {describeEntity({ entity_type: ef.entityType || l.entity_type }).usesShares && (
                                    <>
                                      <input className="input" style={{ width: 120 }} type="number" min="1" step="1" placeholder="Shares"
                                        value={m.shares || ''} aria-label={`Shares held by ${m.fullName || 'this owner'}`}
                                        onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, shares: e.target.value } : x))} />
                                      <input className="input" style={{ width: 160 }} placeholder="Certificate no."
                                        value={m.certificateNumber || ''} aria-label={`Stock certificate number for ${m.fullName || 'this owner'}`}
                                        onChange={e => setEm(ms => ms.map((x, j) => j === i ? { ...x, certificateNumber: e.target.value } : x))} />
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                            <button className="btn ghost small" onClick={() => setEm(ms => [...(ms || []), { fullName: '', ownershipPct: '', email: '', memberTitle: '', shares: '', certificateNumber: '' }])}>+ Add an owner</button>
                            {/* #102 — one click adds the file's co-borrower to the ownership
                                structure with their details pre-filled; just enter their %. */}
                            {app.co_borrower_id && (() => {
                              const coName = fullNameOf(app, 'co_');
                              const already = coName && (em || []).some(m => (m.fullName || '').trim().toLowerCase() === coName.toLowerCase());
                              return coName && !already ? (
                                <button className="btn ghost small"
                                  title="Add the file's co-borrower as an additional owner — their info is filled automatically; enter their ownership %"
                                  onClick={() => setEm(ms => [...(ms || []), { fullName: coName, ownershipPct: '', email: app.co_email || '', memberTitle: '', shares: '', certificateNumber: '' }])}>
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
                    <span className="muted small">Formed {l.formation_date ? fmtDay(l.formation_date) : '—'}</span>
                    <span className="muted small">Borrower owns {l.ownership_pct != null ? `${l.ownership_pct}%` : '—'}</span>
                    {(l.members || []).map(m => (
                      <span key={m.id} className="muted small">
                        {m.full_name}: {m.ownership_pct}%
                        {m.member_kind === 'entity' && <span className="pill" style={{ marginLeft: 4, borderColor: 'var(--teal)', color: 'var(--teal)' }} title={`Layered entity${m.owner_is_verified ? ' — verified' : ' — must be verified before this one'}`}>entity{m.owner_is_verified ? ' ✓' : ''}</span>}
                        {m.member_kind !== 'entity' && Number(m.ownership_pct) >= 20 && <span className="pill" style={{ marginLeft: 4, borderColor: 'var(--gold)', color: 'var(--gold-ink)' }}>≥20% — guarantor likely required</span>}
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
                        {notes.map((n, i) => <span key={i} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold-ink)' }}>{n}</span>)}
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
                        onDrop={canDropSlot ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); onFilesDropped(e, (files) => uploadLlcFiles(files, slotTarget)); } : undefined}>
                        <span className="muted small" style={{ minWidth: 170 }}>{s.label}{s.is_required === false ? ' (optional)' : ''}</span>
                        {toggleable && (
                          <button className="btn link small" disabled={!!busy}
                            title={s.is_required === false
                              ? 'Optional (default) — click to make it REQUIRED: it will gate this entity\'s verification'
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
                            <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : { borderColor: 'var(--gold)', color: 'var(--gold-ink)' }}>
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
                            {canDeleteDoc(role) && <button className="btn link small" style={{ color: 'var(--danger)' }} disabled={reviewBusy} title="Permanently delete — for a mistake upload (never synced to SharePoint)" onClick={() => review(s, 'delete')}>Delete</button>}
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
                              onClick={() => setVerified(l, true)}>{busy === l.id ? '…' : 'Mark entity verified'}</button>
                          : <span className="muted small">Verifying is the processor's sign-off — you can reject documents or raise an issue.</span>)}
                    {!l.is_verified && completer && (l.missing || []).length > 0 && (
                      <span className="muted small">Outstanding: {l.missing.slice(0, 4).join(' · ')}{l.missing.length > 4 ? ` · +${l.missing.length - 4} more` : ''}</span>
                    )}
                    {appId && (
                      <button className="btn ghost small" disabled={busy === l.id}
                        title="Flag an internal issue about this entity for the team to review — the borrower is NOT notified"
                        onClick={async () => {
                          const reason = await askPrompt(`Raise an internal issue about "${l.llc_name}" — what's the concern?\n\nThis is INTERNAL only: the borrower is NOT notified. Use "Post a condition" if you need the borrower to act.`);
                          if (reason == null || !reason.trim()) return;
                          setBusy(l.id); setErr(''); setMsg('');
                          try { await api.staffRaiseLlcIssue(l.id, appId, reason.trim()); setMsg(`Issue raised on ${l.llc_name} — recorded internally for review (the borrower was not notified).`); onChanged && onChanged(); }
                          catch (e) { setErr(e.message || 'Could not raise the issue'); }
                          finally { setBusy(''); }
                        }}>Raise an issue</button>
                    )}
                    {appId && (
                      <button className="btn ghost small" disabled={busy === l.id}
                        title="Post a borrower-facing condition on THIS loan about this entity — the borrower is notified"
                        onClick={async () => {
                          const reason = await askPrompt(`Post a condition on this loan about the entity "${l.llc_name}" — what does the borrower need to provide?\n\nThe borrower WILL be notified.`);
                          if (reason == null || !reason.trim()) return;
                          setBusy(l.id); setErr(''); setMsg('');
                          try { await api.staffRaiseLlcIssue(l.id, appId, reason.trim(), true); setMsg(`Condition posted about ${l.llc_name} — the borrower was notified.`); onChanged && onChanged(); }
                          catch (e) { setErr(e.message || 'Could not post the condition'); }
                          finally { setBusy(''); }
                        }}>Post a condition</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
          };
          // Vesting entity first, then its LAYERED owning entities (always
          // visible — verification is bottom-up, so staff must see the owners
          // they have to verify FIRST); the rest are track-record entities.
          const vesting = llcs.filter(l => l.vesting || l.id === app.llc_id);
          const layered = llcs.filter(l => l.layered && !(l.vesting || l.id === app.llc_id));
          const others = llcs.filter(l => !(l.vesting || l.id === app.llc_id) && !l.layered);
          return (
            <>
              {vesting.map(renderLlc)}
              {layered.length > 0 && (
                <p className="muted small" style={{ margin: '6px 0 2px' }}>
                  Ownership chain — these entities own (part of) an entity on this file and must be verified first:
                </p>
              )}
              {layered.map(renderLlc)}
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
/* WHAT'S WRONG WITH THIS TRACK RECORD, AND WHAT TO DO ABOUT IT (owner-directed
   2026-08-02: "we should have findings ON the track record of stuff that was not
   done correctly … and you should not be able to sign off the experience
   condition till you clear those findings … give a few options over there what
   to do").

   The options come from the SERVER (`f.actions`), never from a list re-typed
   here — the same discipline the sync-review screen follows, so a finding type
   added later gets its buttons for free and the two can never disagree about
   what is on offer. Text is explicit dark ink: `var(--ink*)` is a LIGHT token in
   this palette and would render white-on-white. */
const TRK_ACTION_LABEL = {
  merge: 'Yes — same property, merge them',
  keep_both: 'They are two different properties',
  remove_line: 'Take this line off the track record',
  not_our_property: 'The borrower really did own this before',
  dismiss: 'Dismiss',
};
const TRK_ACTION_TITLE = {
  merge: 'Fold the two lines into one. Details only the second line had are kept, and any documents on it move across. This removes the duplicate line.',
  keep_both: 'Record that these really are two different properties. Both lines stay and you will not be asked about this pair again.',
  remove_line: 'Remove this line from the borrower’s track record. Any documents on it are kept — they are just no longer attached to a deal.',
  not_our_property: 'Record that the borrower genuinely owned and exited this property before. The line stays and counts as experience.',
  dismiss: 'Set this aside without changing anything.',
};

function TrackRecordFindings({ appId, onChanged }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.staffTrackRecordFindings(appId)
      .then((r) => setRows(Array.isArray(r && r.findings) ? r.findings : []))
      .catch(() => setRows([]));
  }, [appId]);
  useEffect(load, [load]);

  async function act(f, action) {
    setBusy(f.id + action); setErr(''); setMsg('');
    try {
      const r = await api.staffResolveTrackRecordFinding(appId, f.id, action, null);
      setRows(Array.isArray(r && r.findings) ? r.findings : []);
      setMsg(r && r.outcome ? r.outcome : 'Done.');
      if (onChanged) onChanged();
    } catch (e) {
      setErr((e && e.message) || 'That did not go through.');
    } finally { setBusy(''); }
  }

  if (!rows) return null;
  if (!rows.length) {
    return (
      <p className="small" style={{ color: '#4B585C', marginTop: 0 }}>
        Nothing to review on this track record.
      </p>
    );
  }
  return (
    <div className="panel" style={{ marginBottom: 16, borderLeft: '4px solid #AE8746' }}>
      <h3 style={{ color: '#141B22', marginTop: 0 }}>
        Track record — {rows.length} thing{rows.length === 1 ? '' : 's'} to review
      </h3>
      <p className="small" style={{ color: '#4B585C', marginTop: 0 }}>
        The experience condition cannot be signed off until each of these is settled.
      </p>
      {err ? <p className="small" style={{ color: '#B3261E' }}>{err}</p> : null}
      {msg ? <p className="small" style={{ color: '#2F7F86' }}>{msg}</p> : null}
      {rows.map((f) => (
        <div key={f.id} style={{ borderTop: '1px solid #EAE4D7', paddingTop: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 600, color: '#141B22' }}>{f.title}</div>
          <p className="small" style={{ color: '#4B585C', margin: '4px 0 10px' }}>{f.detail}</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(f.actions || []).map((a) => (
              <button key={a} type="button" className="btn secondary small"
                title={TRK_ACTION_TITLE[a] || ''}
                disabled={!!busy}
                onClick={() => act(f, a)}>
                {busy === f.id + a ? 'Working…' : (TRK_ACTION_LABEL[a] || a)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* WHAT'S LEFT ON THIS TRACK RECORD (owner-directed 2026-08-03: "after the track
   record there should be the skew of the stuff that still needs to be done to
   the track record — stuff that still needs to be reviewed — nicely laid out
   within the file as well").

   Everything here is WORKED OUT ON THE SERVER (`src/lib/track-record-todo.js`).
   The 3-year exit window is a frozen rule and the refusals are the sign-off
   gate's own wording, so nothing on this panel is re-derived in the browser —
   a screen that judged a line "ready" while the gate refused it is exactly the
   confusion this replaces.

   Grouped by WHO OWES THE WORK, because that is the question an officer opens
   this section with. Our own work comes first: it is the only part anyone here
   can finish today. */
const TODO_GROUPS = [
  { key: 'us', title: 'For us to do', tone: '#2F7F86', blurb: 'Nobody outside the office is holding these up.' },
  { key: 'borrower', title: 'Waiting on the borrower', tone: '#8A6D3B', blurb: 'Asked for, or still to be asked for.' },
  { key: 'nobody', title: 'Worth knowing', tone: '#4B585C', blurb: 'Nothing to chase — these lines simply cannot count.' },
];

function TrackRecordTodo({ appId, borrowerId, reloadKey, preloaded }) {
  /* The panel now fetches the to-do ONCE and shares it (header math, per-line
     chips, and this detailed list all read the same payload) — `preloaded`
     short-circuits the self-fetch so the section never asks twice. A mount
     without it still fetches for itself, unchanged. */
  const shared = preloaded !== undefined;
  const [fetched, setFetched] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (shared) return undefined;
    let alive = true;
    api.staffTrackRecordTodo(appId, borrowerId)
      .then((d) => { if (alive) { setFetched(d && typeof d === 'object' ? d : null); setErr(''); } })
      .catch((e) => { if (alive) { setFetched(null); setErr((e && e.message) || 'could not work out what is left'); } });
    return () => { alive = false; };
  }, [appId, borrowerId, reloadKey, shared]);
  const data = shared ? preloaded : fetched;

  if (err) return <div className="small" style={{ color: '#8A6D3B', marginTop: 12 }}>{err}</div>;
  if (!data) return null;

  const lines = Array.isArray(data.lines) ? data.lines : [];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const exp = data.experience || null;
  const s = data.summary || { items: 0, us: 0, borrower: 0, lines: 0 };
  /* SHORTFALL-ONLY — being unregistered stopped being a gate refusal on
     2026-08-06 (a fully-verified claim signs off; Products & Pricing's own
     condition is what demands a registration), so "short" here means the
     shortfall alone, matching the server's `ok` and the gate. */
  const expShort = !!(exp && (exp.shortfall || []).length);

  // One flat list per group — the property is named on each row, so an officer
  // reads their own work in one place instead of hunting it across ten cards.
  const byGroup = {};
  for (const l of lines) {
    for (const t of (l.todo || [])) {
      const k = t.waitingOn || 'nobody';
      (byGroup[k] = byGroup[k] || []).push({ ...t, line: l });
    }
  }

  const headline = data.ok
    ? 'Nothing left — every deal on this track record has been reviewed.'
    : [
      s.items ? `${s.items} ${s.items === 1 ? 'thing' : 'things'} on ${s.lines} ${s.lines === 1 ? 'deal' : 'deals'}` : '',
      findings.length ? `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} to settle` : '',
      expShort ? 'experience short of what this file needs' : '',
    ].filter(Boolean).join(' · ');

  return (
    <div className="panel" style={{ marginTop: 12, padding: 12 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, color: '#141B22' }}>What&rsquo;s left on this track record</h4>
        {!data.ok && s.us > 0 && (
          <span className="pill small" style={{ borderColor: '#2F7F86', color: '#2F7F86' }}>
            {s.us} on us
          </span>
        )}
        {!data.ok && s.borrower > 0 && (
          <span className="pill small" style={{ borderColor: '#8A6D3B', color: '#8A6D3B' }}>
            {s.borrower} with the borrower
          </span>
        )}
      </div>
      <div className="small" style={{ color: data.ok ? '#2F7F86' : '#4B585C', margin: '4px 0 0' }}>
        {headline}
      </div>

      {/* The two other things the sign-off gate refuses on, in ITS order:
          the findings first, then the experience shortfall. */}
      {findings.length > 0 && (
        <div className="small" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8,
          border: '1px solid var(--gold)', background: 'rgba(174,135,70,.08)', color: '#141B22' }}>
          <strong>{findings.length === 1 ? 'One finding' : `${findings.length} findings`} to settle first.</strong>{' '}
          They are at the top of this section — the experience condition cannot be signed off until each one is
          settled or dismissed.
        </div>
      )}
      {expShort && (
        <div className="small" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8,
          border: '1px solid #EAE4D7', background: '#FBF9F4', color: '#141B22' }}>
          <strong>Verified experience is short of {exp.registered ? 'the registered product' : 'this file’s claim'}.</strong>{' '}
          Verified on the record: {exp.verified.flips} {exp.verified.flips === 1 ? 'flip' : 'flips'},{' '}
          {exp.verified.holds} {exp.verified.holds === 1 ? 'hold' : 'holds'}, {exp.verified.ground} ground-up.
          {exp.registered ? (
            <> The product was registered on {exp.need.flips}/{exp.need.holds}/{exp.need.ground} — verify{' '}
              {exp.shortfall.map((x) => x.text).join(', ')}, or re-register on the experience the borrower can prove.</>
          ) : (
            <> The file claims {exp.need.flips}/{exp.need.holds}/{exp.need.ground} — verify{' '}
              {exp.shortfall.map((x) => x.text).join(', ')}, or lower the claim to what the borrower can prove.</>
          )}
        </div>
      )}
      {exp && !exp.registered && !expShort && (
        /* INFORMATIONAL, never blocking — the gate signs off a fully-verified
           claim without a registration (2026-08-06); the registration is
           Products & Pricing's own condition. Note it, don't refuse on it. */
        <div className="small" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8,
          border: '1px solid #EAE4D7', background: '#FBF9F4', color: '#4B585C' }}>
          <strong style={{ color: '#141B22' }}>No product registered yet.</strong>{' '}
          The claim is fully verified, so the experience condition can be signed off. Registering a product is
          Products &amp; Pricing&rsquo;s own condition — a registration on different experience re-checks this.
        </div>
      )}

      {TODO_GROUPS.map((g) => {
        const rows = byGroup[g.key] || [];
        if (!rows.length) return null;
        return (
          <div key={g.key} style={{ marginTop: 12 }}>
            <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: g.tone }}>
                {g.title}
              </span>
              <span className="muted small">{g.blurb}</span>
            </div>
            {rows.map((r, i) => (
              <div key={`${r.line.id}:${r.code}:${i}`}
                style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: '1px solid rgba(127,169,176,.18)' }}>
                <span aria-hidden="true" style={{ width: 3, borderRadius: 2, background: g.tone, flex: '0 0 3px' }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <strong style={{ color: '#141B22' }}>{r.title}</strong>
                    <span className="muted small">{r.line.address}</span>
                    {r.line.selfReported && (
                      <span className="pill small" title="The borrower typed this deal themselves — it is self-reported until somebody reads the documents behind it">
                        Self-reported
                      </span>
                    )}
                    {r.line.exitDate && <span className="muted small">exit {r.line.exitDate}</span>}
                  </div>
                  <div className="small" style={{ color: '#4B585C', marginTop: 2 }}>{r.how}</div>
                  {r.code === 'open_request' && (r.line.openRequests || []).map((rq) => (
                    <div key={rq.id} className="small" style={{ color: '#4B585C', marginTop: 2 }}>
                      ↳ {rq.label} <span className="pill small">{rq.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

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
  const [full, setFull] = useState(false);   // full-screen tool sheet (same UX as the Scope of Work)
  // Per-line-item list so staff can raise an issue/request against a SPECIFIC
  // past project — it becomes a named condition on this file the borrower answers.
  const [trs, setTrs] = useState([]);
  const [trBusy, setTrBusy] = useState('');
  const completerTR = canComplete(role);
  // Per-line documents and their review now live inside <LineDetail> (it fetches
  // its own line and owns preview / accept / reject / delete), so this only needs
  // to refresh the list of lines.
  const refreshTrs = useCallback(() => {
    api.staffBorrowerTrackRecords(borrowerId)
      .then((rows) => setTrs(Array.isArray(rows) ? rows : []))
      .catch(() => setTrs([]));
  }, [borrowerId]);
  // Anything that CHANGES the record also re-asks the server what is left. The
  // plain mount path deliberately does NOT bump this — the to-do panel already
  // fetches once when it mounts, and bumping there would make every open of the
  // section fetch it twice.
  const [todoKey, setTodoKey] = useState(0);
  const reloadAll = useCallback(() => { refreshTrs(); setTodoKey((k) => k + 1); }, [refreshTrs]);
  /* ONE to-do fetch for the whole section (mega-workspace phase C): the
     experience header, the per-line "not counting" reasons and the detailed
     what's-left list all read this single payload — the server's own wording,
     the same definitions the sign-off gate uses. Best-effort: with it null the
     ledger degrades to verified/unverified and the header to the file's own
     claim columns. */
  const [todo, setTodo] = useState(null);
  /* When THIS fetch fails, the detail list below gets `preloaded={undefined}`
     and falls back to its own self-fetch — a second chance, and its own amber
     "could not work out what is left" note if that fails too. Without this, a
     parent failure silently blanked the list (pre-merge audit NIT). */
  const [todoFailed, setTodoFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setTodoFailed(false);
    api.staffTrackRecordTodo(app.id, borrowerId)
      .then((d) => { if (alive) setTodo(d && typeof d === 'object' ? d : null); })
      .catch(() => { if (alive) { setTodo(null); setTodoFailed(true); } });
    return () => { alive = false; };
  }, [app.id, borrowerId, todoKey]);
  const todoByLine = useMemo(() => {
    const m = {};
    for (const l of ((todo && todo.lines) || [])) m[String(l.id)] = l.todo || [];
    return m;
  }, [todo]);
  // The three per-line asks, exactly as the flat list carried them — now handed
  // to the ledger's expanded detail as extra actions. Feedback goes through the
  // app's own message box so a confirmation or a refusal is always visible.
  const trRequestDoc = useCallback(async (t, addr) => {
    const label = await askPrompt(`Request a document for "${addr}" — which document do you need? (the borrower will see this)`);
    if (label == null || !label.trim()) return;
    setTrBusy(t.id);
    try { await api.staffRequestTrackRecordDoc(t.id, app.id, label.trim()); reloadAll(); showMessage(`Document requested on ${addr} — added as a condition on this file.`); }
    catch (e) { showMessage(e.message || 'Could not request the document'); }
    finally { setTrBusy(''); }
  }, [app.id, reloadAll]);
  const trRaiseIssue = useCallback(async (t, addr) => {
    const reason = await askPrompt(`Raise an internal issue about "${addr}" — what's the concern?\n\nThis is INTERNAL only: the borrower is NOT notified. Use "Post a condition" if you need the borrower to act.`);
    if (reason == null || !reason.trim()) return;
    setTrBusy(t.id);
    try { await api.staffRaiseTrackRecordIssue(t.id, app.id, reason.trim()); reloadAll(); showMessage(`Issue raised on ${addr} — recorded internally for review (the borrower was not notified).`); }
    catch (e) { showMessage(e.message || 'Could not raise the issue'); }
    finally { setTrBusy(''); }
  }, [app.id, reloadAll]);
  const trPostCondition = useCallback(async (t, addr) => {
    const reason = await askPrompt(`Post a condition on this loan about the track-record property "${addr}" — what does the borrower need to provide?\n\nThe borrower WILL be notified. It appears on their loan as a track-record item (never as a condition on ${addr}).`);
    if (reason == null || !reason.trim()) return;
    setTrBusy(t.id);
    try { await api.staffRaiseTrackRecordIssue(t.id, app.id, reason.trim(), true); reloadAll(); showMessage(`Condition posted about ${addr} — the borrower was notified.`); }
    catch (e) { showMessage(e.message || 'Could not post the condition'); }
    finally { setTrBusy(''); }
  }, [app.id, reloadAll]);
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
  // #112 live cross-user refresh: when the borrower (or another staffer) changes
  // THIS borrower's track record, the server pushes track_record:updated. Reload
  // the embedded tool + refresh the per-line-item list and saved-copy snapshot —
  // but only for the borrower whose record is on screen. Our own edits are
  // excluded server-side, so this never fights the tool's own autosave, and the
  // tool defers a reload while a form is open.
  useEffect(() => {
    const unsub = subscribeChat((event, data) => {
      if (event !== 'track_record:updated' || !data || data.borrowerId !== borrowerId) return;
      reloadAll();
      refreshSnap();
      document.querySelectorAll('iframe').forEach((f) => {
        try { if (f.contentWindow) f.contentWindow.postMessage({ type: 'ys-tr-reload' }, window.location.origin); }
        catch { /* cross-origin frame — not ours */ }
      });
    });
    return unsub;
  }, [borrowerId, reloadAll, refreshSnap]);
  async function download() {
    if (!snap) return;
    setDl(true);
    try { const { blob, filename } = await api.staffDownloadDoc(snap.documentId); saveBlob(blob, filename || snap.filename); }
    catch (_) { /* surfaced by the button state */ }
    finally { setDl(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      {/* What is WRONG with this track record comes first — it holds the
          experience condition, so it must not be below the fold. */}
      <TrackRecordFindings appId={app.id} onChanged={reloadAll} />
      <div className="row" style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3>Track record &amp; experience</h3>
        <div className="spacer" />
        <button className="btn primary small" onClick={() => setFull(true)}
          title="Open the track record in the full-screen workspace — same as the Scope of Work">
          Open full screen
        </button>
        {/* #82: the "Preview" of a saved static copy was removed — it opened a
            stale snapshot. "Open full screen" is the live, editable, auto-saving
            record; the HTML export below stays for a static copy on hand. */}
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
      {/* THE EXPERIENCE MATH, AT THE TOP (mega-workspace phase C): claimed /
          verified / still-needed, every figure off the ONE track-record-todo
          fetch above — the same definitions the sign-off gate uses, so this
          header can never promise what the gate would refuse. Degrades to the
          file's own claim columns when the todo is unreachable. */}
      <ExperienceHeader app={app} experience={todo && todo.experience}
        findingsOpen={((todo && todo.findings) || []).length}
        multiBorrower={people.length > 1} />
      {/* THE RECORD, AS A LEDGER — grouped the way the tool has always grouped
          it, with the REO band carrying every not-counting line AND its reason.
          Every line OPENS IN PLACE into the shared <LineDetail> (the same
          component the full screen renders): the Elementix check, the three
          verdicts + override, verify, documents with preview/download, and edit
          — all here (owner-directed 2026-08-09 "one screen, everything"). The
          loan file injects its file verbs (request/raise/post a condition on
          THIS file) via `lineActions`; the doc review + verify are native. */}
      <RecordLedger lines={trs} todoByLine={todoByLine} lens="file"
        maySignOff={completerTR} canDelete={canDeleteDoc(role)} role={role} onChanged={reloadAll}
        lineActions={(t, addr) => (
          <>
            <button className="btn ghost small" disabled={trBusy === t.id}
              title="Ask the borrower for a specific document on this past project — it becomes a condition on this file"
              onClick={() => trRequestDoc(t, addr)}>Request a document</button>
            <button className="btn ghost small" disabled={trBusy === t.id}
              title="Flag an internal issue about this past project — the borrower is NOT notified"
              onClick={() => trRaiseIssue(t, addr)}>Raise an issue</button>
            <button className="btn ghost small" disabled={trBusy === t.id}
              title="Post a borrower-facing condition on THIS loan about this past project — the borrower is notified"
              onClick={() => trPostCondition(t, addr)}>Post a condition</button>
          </>
        )} />
      {/* THE PUBLIC-RECORDS WORKBENCH, IN THE LOAN FILE (owner-directed
          2026-08-09: "the Elementix stuff is still missing from the actual track
          record within the loan file … merge together, old information lives in
          one place"). Until now the search button and the staged candidates
          lived ONLY on the borrower CRM profile — an officer working the FILE
          had no path to them at all. Same component, same borrower key, so the
          profile tab and this section can never drift: it is the person's one
          queue, shown wherever the person's record is worked. It follows the
          "Whose track record" picker above, so on a co-borrower file it shows
          the selected person's queue. Searching still costs vendor lookups and
          still confirms first — mounting it here changes where it is, never
          what it spends. */}
      <div style={{ marginTop: 12 }}>
        <StaffPropertyWorkbench key={`wb-${borrowerId}`} borrowerId={borrowerId}
          borrowerName={(people.find(p => p.id === borrowerId) || {}).label || ''} />
      </div>
      {/* Phase E (owner-directed 2026-08-09): the EMBEDDED legacy editor is
          retired — the ledger above is the record you read, "Open full screen"
          is the editor, and the borrower's saved copy is rebuilt SERVER-SIDE on
          every write (src/lib/track-record/html-copy.js), so nothing depends on
          this page hosting the tool any more. The borrower's own tool sheet and
          the ?internal=1 bridge are untouched (constraint A13). */}
      {/* AFTER the record itself (owner-directed 2026-08-03) — you read the track
          record, then you read what is still left on it. The detail list reads
          the SAME todo payload fetched above (`preloaded`), so the section costs
          one fetch, not two. */}
      <TrackRecordTodo appId={app.id} borrowerId={borrowerId} reloadKey={todoKey}
        preloaded={todoFailed ? undefined : todo} />
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

/* Now a thin wrapper over the shared ConditionNote, so both row shapes get the
   SAME behaviour: an existing note is shown, and with no note there is a quiet
   "add" link instead of an empty box. The private copy that lived here rendered
   an input and a Save button on every condition whether or not one was ever
   written — about a full screen of blank boxes down a 24-condition list. */
function CondNote({ item, onPatch }) {
  return (
    <div style={{ width: '100%', paddingLeft: 20, marginTop: 4 }}>
      <ConditionNote it={item} onPatch={onPatch} />
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
              <span style={{ minWidth: 200 }}>{fullNameOf(o) || '(borrower)'}
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
// The loan team (#64): the PRIMARY loan officer + processor plus any full-access
// ASSISTANTS. Shows every teammate with a "Primary" badge; assistants carry a
// remove (×). Add-assistant pickers below. The PRIMARY is changed through the
// admin-only Assign controls, not here. `officers`/`processors` are the roster
// lists already loaded by the parent; `onChanged` refreshes the file.
function TeamAssignees({ appId, officers, processors, closers = [], drawCoordinators = [], onChanged }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [adds, setAdds] = useState({});   // role -> picked staffId
  const load = () => api.staffAssignees(appId).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appId]);
  if (!rows) return null;
  const byRole = (role) => rows.filter(r => r.role === role);
  async function add(role, staffId, primary) {
    if (!staffId) return;
    setBusy('add'); setErr('');
    try { await api.staffAddAssignee(appId, staffId, role, primary); setAdds(a => ({ ...a, [role]: '' })); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(''); }
  }
  async function remove(role, staffId) {
    setBusy(staffId); setErr('');
    try { await api.staffRemoveAssignee(appId, staffId, role); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Could not remove'); } finally { setBusy(''); }
  }
  // Closer / draw-coordinator primaries CAN be cleared here (db/392) — only the
  // LO/processor primaries stay locked to the Assign selects above.
  const primaryRemovable = (role) => role === 'closer' || role === 'draw_coordinator';
  const Chip = ({ r }) => (
    <span className="asg-chip">
      {r.full_name}
      {r.is_primary && <span className="asg-badge">Primary</span>}
      {(!r.is_primary || primaryRemovable(r.role)) && (
        <button className="asg-x" title={r.is_primary ? 'Clear this assignment (falls back to the whole desk)' : 'Remove from this file'}
          disabled={busy === r.staff_id} onClick={() => remove(r.role, r.staff_id)}>×</button>
      )}
    </span>
  );
  const Line = ({ label, list }) => (
    <div className="metrow" style={{ alignItems: 'flex-start' }}>
      <span className="k">{label}</span>
      <span className="v" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
        {list.length ? list.map(r => <Chip key={r.staff_id} r={r} />) : <span className="muted small">Whole desk (nobody assigned)</span>}
      </span>
    </div>
  );
  // ONE add-control per role. The first closer / draw coordinator added becomes
  // the PRIMARY (their workflow gets the file's submissions); more people can be
  // added to the same role — every assigned person sees the file's items
  // (owner-directed 2026-07-31: multiple closers / draw coordinators per file).
  const AddRow = ({ role, label, pool, firstIsPrimary }) => {
    const cur = byRole(role);
    const hasPrimary = cur.some(r => r.is_primary);
    const val = adds[role] || '';
    return (
      <>
        <select className="input" style={{ maxWidth: 210, flex: '1 1 160px' }} value={val}
          onChange={e => setAdds(a => ({ ...a, [role]: e.target.value }))}>
          <option value="">{label}</option>
          {pool.filter(m => !cur.some(r => r.staff_id === m.id)).map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
        </select>
        {val && <button className="btn ghost small" disabled={busy === 'add'}
          onClick={() => add(role, val, firstIsPrimary && !hasPrimary)}>{firstIsPrimary && !hasPrimary ? 'Assign' : 'Add'}</button>}
      </>
    );
  };
  return (
    <div style={{ marginBottom: 4 }}>
      <Line label="Loan officers" list={byRole('loan_officer')} />
      <Line label="Processors" list={byRole('processor')} />
      <Line label="Closers" list={byRole('closer')} />
      <Line label="Draw coordinators" list={byRole('draw_coordinator')} />
      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <AddRow role="loan_officer" label="+ Add assistant LO…" pool={officers} firstIsPrimary={false} />
        <AddRow role="processor" label="+ Add assistant processor…" pool={processors} firstIsPrimary={false} />
        <AddRow role="closer" label="+ Assign / add closer…" pool={closers} firstIsPrimary />
        <AddRow role="draw_coordinator" label="+ Assign / add draw coordinator…" pool={drawCoordinators} firstIsPrimary />
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        Closing and draw submissions go to the file’s assigned closer / draw coordinator; with nobody assigned they
        go to the whole desk (the default, unchanged). Everyone assigned to a role here sees the file’s items in
        their own workflow.
      </p>
      {err && <p className="notice err small" style={{ marginTop: 6 }}>{err}</p>}
    </div>
  );
}

// contact, DOB, SSN reveal) and lets staff add/link or remove one. The record is
// created encrypted + identity-matched server-side; removing only unlinks it.
function CoBorrowerBlock({ appId, app, onChanged }) {
  const has = !!app.co_borrower_id;
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ firstName: '', middleName: '', lastName: '', email: '', phone: '', dob: '', ssn: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // #98 — internal-only autocomplete: type a name to find someone already in the
  // database and link them without re-entering their details. staffBorrowerSearch
  // is a staff-scoped, guarded endpoint (never exposed on the borrower side).
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  // Last-request-wins: while typing, a SLOW earlier response must never
  // overwrite a newer query's matches (vanishing-search bug class, 2026-07-16).
  const searchSeq = useRef(0);
  async function runSearch(text) {
    setQ(text);
    const mine = ++searchSeq.current;
    if (text.trim().length < 2) { setMatches(null); return; }
    setSearchBusy(true);
    try { const m = await api.staffBorrowerSearch(text.trim()); if (mine === searchSeq.current) setMatches(m); }
    catch (_) { if (mine === searchSeq.current) setMatches([]); }
    finally { if (mine === searchSeq.current) setSearchBusy(false); }
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
      await api.staffSetCoBorrower(appId, { firstName: f.firstName, middleName: f.middleName || undefined, lastName: f.lastName, email: f.email, phone: f.phone || undefined, dob: f.dob || undefined, ssn: f.ssn || undefined });
      setAdding(false); setF({ firstName: '', middleName: '', lastName: '', email: '', phone: '', dob: '', ssn: '' }); setQ(''); setMatches(null); await onChanged();
    } catch (e) { setErr(e.message || 'Could not save the co-borrower'); } finally { setBusy(false); }
  }
  async function remove() {
    if (!(await askConfirm('Remove the co-borrower from this file? The borrower record is kept for other files.'))) return;
    setBusy(true); setErr('');
    try { await api.staffSetCoBorrower(appId, { unlink: true }); await onChanged(); }
    catch (e) { setErr(e.message || 'Could not remove the co-borrower'); } finally { setBusy(false); }
  }
  // A co-borrower is its own borrower record with its OWN portal login and full
  // (shared) access to the loan — but the primary's invite never reaches them, so
  // invite them directly here (owner-directed 2026-07-14). If they already have a
  // login the endpoint emails a sign-in link instead of a fresh invite.
  const [inviteMsg, setInviteMsg] = useState('');
  async function inviteCo() {
    if (!app.co_borrower_id) return;
    setBusy(true); setErr(''); setInviteMsg('');
    try {
      const r = await api.staffBorrowerInvite(app.co_borrower_id);
      setInviteMsg(r && r.hasAccount ? 'Sign-in link emailed — they already have a portal login.' : 'Portal invitation emailed to the co-borrower.');
    } catch (e) { setErr(e.message || 'Could not invite the co-borrower'); }
    finally { setBusy(false); }
  }
  return (
    <>
      {/* THE SECOND BORROWER IS EDITED EXACTLY LIKE THE FIRST (owner-directed
          2026-07-27). This block used to print eight read-only rows — the same
          ones as the primary panel, with NO way to change any of them, so a
          co-borrower's phone, citizenship, address or SSN could only ever be
          entered at the moment they were linked and never corrected. Their
          record is now the shared BorrowerProfilePanel mounted right above
          this, on the co-borrower's own id. What stays HERE is what is genuinely
          about the LINK rather than about the person: find/add/remove them, and
          send them their own portal invitation. */}
      <div className="panel" style={{ marginTop: has && !adding ? 8 : 14 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: '#141B22' }}>
            {has ? 'Co-borrower on this file' : 'Co-borrower'}
          </span>
          <div className="spacer" />
          {has && !adding && (
            <button className="btn ghost small" onClick={inviteCo} disabled={busy || !app.co_email}
              title={app.co_email ? 'Email the co-borrower their own portal invitation (they get full access to this loan)' : 'Add a co-borrower email first'}>
              Invite to portal
            </button>
          )}
          {has && !adding && <button className="btn link small" onClick={remove} disabled={busy}>Remove from this file</button>}
          {!has && !adding && <button className="btn ghost small" onClick={() => { setAdding(true); setErr(''); }}>+ Add co-borrower</button>}
        </div>
        {!has && !adding && (
          <p className="small" style={{ color: '#4B585C', margin: '6px 0 0' }}>
            No second borrower on this file yet. Adding one links their own record — every field on it is editable here.
          </p>
        )}
        {inviteMsg && <span className="muted small" style={{ color: 'var(--ok)' }}>{inviteMsg}</span>}
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
          <label><span>Middle name <span style={{ color: '#4B585C', fontWeight: 400 }}>(optional)</span></span>
            <input className="input" value={f.middleName} onChange={e => setF({ ...f, middleName: e.target.value })} /></label>
          <label><span>Last name</span><input className="input" value={f.lastName} onChange={e => setF({ ...f, lastName: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}><span>Email <span style={{ color: '#4B585C', fontWeight: 400 }}>(optional — needed later to invite or sign)</span></span><EmailInput value={f.email} onChange={v => setF({ ...f, email: v })} /></label>
          <label><span>Phone</span><PhoneInput value={f.phone} onChange={v => setF({ ...f, phone: v })} /></label>
          <label><span>Date of birth</span><input className="input" type="date" value={f.dob} onChange={e => setF({ ...f, dob: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}><span>SSN (stored encrypted)</span><input className="input" inputMode="numeric" value={f.ssn} onChange={e => setF({ ...f, ssn: formatSSN(e.target.value) })} placeholder="XXX-XX-XXXX" /></label>
        </div>
        {err && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn primary small" onClick={save} disabled={busy || !f.firstName.trim() || !f.lastName.trim()}>{busy ? 'Saving…' : 'Save co-borrower'}</button>
          <button className="btn ghost small" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
        </div>
        </>}
        {err && !adding && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
      </div>
    </>
  );
}

// #107: the LO / processor / admin can ENTER the appraisal payment card on the
// borrower's behalf (often taken over the phone). Same validation + at-rest
// encryption + condition completion as the borrower's own form, via the staff
// endpoint. An inline, toggle-open form — never persists anything until Save.
// The card entry moved into its OWN component (components/AppraisalCardEntry.jsx)
// so the appraisal ORDER desk renders the same one — the owner's "one card,
// entered once, both places" needs one form, not two that drift. This name is
// kept because the condition row below refers to it.
const StaffCardEntry = AppraisalCardEntry;

// Staff can enter/EDIT the title or insurance contact directly ON the condition
// (owner-directed 2026-07-20) — the same structured contact form the borrower
// fills, so the LO/processor can complete it on the borrower's behalf. Saving
// writes the file's title_company / insurance_agent service contact (which the
// backend also flips the condition to 'received'); the condition still can't be
// signed off until the contact exists (the signOffGate structured-data check).
function StaffContactEntry({ appId, toolKey, current, onSaved }) {
  const contactType = toolKey === 'title_contact' ? 'title_company' : 'insurance_agent';
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ companyName: '', contactName: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  function startEdit() {
    setF({ companyName: current?.company_name || '', contactName: current?.contact_name || '', email: current?.email || '', phone: current?.phone || '' });
    setErr(''); setOpen(true);
  }
  async function save() {
    if (!f.companyName && !f.contactName && !f.email && !f.phone) { setErr('Enter at least one detail (company, name, email or phone).'); return; }
    setBusy(true); setErr('');
    try {
      if (current && current.link_id) await api.staffEditFileContact(current.link_id, { ...f, contactType });
      else await api.staffAddFileContact(appId, { ...f, contactType });
      setOpen(false);
      if (onSaved) await onSaved();
    } catch (e) { setErr((e && e.message) || 'Could not save the contact.'); }
    finally { setBusy(false); }
  }
  if (!open) return <button className="btn ghost small" onClick={startEdit}>{current ? 'Edit contact' : 'Enter contact'}</button>;
  return (
    <div className="small" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
      <input className="input" style={{ maxWidth: 180 }} placeholder="Company" value={f.companyName} onChange={set('companyName')} />
      <input className="input" style={{ maxWidth: 150 }} placeholder="Contact name" value={f.contactName} onChange={set('contactName')} />
      <EmailInput style={{ maxWidth: 190 }} placeholder="Email" value={f.email} onChange={v => setF(p => ({ ...p, email: v }))} />
      <PhoneInput style={{ maxWidth: 150 }} placeholder="Phone" value={f.phone} onChange={v => setF(p => ({ ...p, phone: v }))} />
      <button className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save contact'}</button>
      <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
      {err && <span style={{ color: 'var(--bad, #c0392b)', flexBasis: '100%', textAlign: 'right' }}>{err}</span>}
    </div>
  );
}

/* IT'S AN INDIVIDUAL — the CHOICE, not an upload (owner-directed 2026-07-31,
   corrected 2026-08-03: "on the Condition Slot on the LLC, if there's no LLC
   selected, the LLC condition says 'Add LLC,' but it doesn't have a way for this
   condition because it's an individual").

   The affidavit stopped being a PREREQUISITE of the choice on 2026-08-02 (db/417
   moved it to its own rule-driven condition, `cond_noo_affidavit_individual`),
   and the server's 400 went with it — but this control never followed. Its only
   button opened a FILE PICKER, so the one door that could answer "this file has
   no entity" still demanded a document the officer usually doesn't have yet, and
   a file with no LLC was left with nothing to click but "Add LLC". So the plain
   choice comes first now, and the upload stays beside it for whoever DOES have
   the affidavit in hand — one request files it and marks the file in one step,
   exactly as before.

   THE BLUE LAKE GATE rides both buttons: the reason comes from the server
   (`app.vesting_individual_blocked`, the same rule the door enforces), so the
   control is greyed WITH the reason instead of answering 409 after the click. */
function PersonalNameWaiver({ appId, app, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [err, setErr] = React.useState('');
  const fileRef = React.useRef(null);
  const isPersonal = !!(app && app.personal_name_purchase);
  const blocked = (app && app.vesting_individual_blocked) || '';
  const run = async (body, okMsg, failMsg) => {
    setBusy(true); setMsg(''); setErr('');
    try {
      await api.staffVestingPersonalName(appId, body);
      setMsg(okMsg);
      onChanged && await onChanged();
    } catch (e) { setErr(e.message || failMsg); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  // The plain choice — no document required. This is what the owner asked for.
  const markIndividual = () => run({},
    'Saved — this file closes in the borrower’s own name. The LLC documents stand down; the signed non-owner-occupied affidavit is now asked for as its own condition.',
    'could not mark this file individual');
  // The same choice WITH the affidavit already in hand: filed as the condition's
  // evidence in the same request, so it is never a second step.
  const waive = async (file) => {
    if (!file) return;
    let dataUrl;
    try {
      dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('could not read the file')); fr.readAsDataURL(file);
      });
    } catch (e) { setErr(e.message || 'could not read the file'); return; }
    await run({ filename: file.name, contentType: file.type || 'application/pdf', dataUrl },
      'Saved — this file closes in the borrower’s own name and the affidavit is on file.',
      'could not save the affidavit');
  };
  const undo = () => run({ undo: true }, 'Back to an LLC purchase — vesting is LLC.', 'could not undo');
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, color: '#141B22' }}>
      {isPersonal ? (
        <>
          <span className="pill ok">Closing as an individual — no entity</span>
          <span className="muted small" style={{ color: '#4B585C' }}>Title goes in the borrower’s own name, not an LLC. ClickUp vesting is Individual.</span>
          <button className="btn link small" disabled={busy} onClick={undo}>Undo — back to an LLC</button>
        </>
      ) : (
        <>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" style={{ display: 'none' }}
            onChange={(e) => waive(e.target.files && e.target.files[0])} />
          <button className="btn small" disabled={busy || !!blocked} title={blocked || undefined} onClick={markIndividual}>
            {busy ? 'Saving…' : 'No LLC — this file closes as an individual'}
          </button>
          <button className="btn ghost small" disabled={busy || !!blocked} title={blocked || undefined}
            onClick={() => fileRef.current && fileRef.current.click()}>
            …and I have the affidavit
          </button>
          <span className="muted small" style={{ color: '#4B585C' }}>
            {blocked || 'Stands the LLC documents down and asks for the signed non-owner-occupied affidavit on its own condition.'}
          </span>
        </>
      )}
      {msg && <span className="muted small" style={{ color: '#256168', flexBasis: '100%' }}>{msg}</span>}
      {err && <span className="small" style={{ color: 'var(--danger)', flexBasis: '100%' }}>{err}</span>}
    </div>
  );
}

// Which conditions a person may hand-delete: only the MANUALLY-added ones
// (owner-directed 2026-08-04). Auto/rules/system conditions are engine-owned.
const MANUAL_CONDITION_ORIGINS = ['manual_custom', 'manual_library', 'exception'];
const isManualCondition = (it) => MANUAL_CONDITION_ORIGINS.includes(it && it.origin_kind);

// Delete a manual condition. The adder / an admin succeeds; anyone else gets a
// 403 and is offered to ASK the adder to delete it (the server records the request
// and notifies them). The server is the sole authority — the client just tries.
function ManualConditionDelete({ it, appId, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!isManualCondition(it)) return null;
  async function doDelete() {
    if (!(await askConfirm(`Delete "${it.label}"? This removes the condition from the file.`))) return;
    setBusy(true);
    try {
      await api.staffDeleteCondition(appId, it.id);
      onChanged && onChanged();
    } catch (e) {
      if (e && e.status === 403 && e.data && e.data.code === 'needs_delete_request') {
        const who = e.data.creatorName || 'the person who added it';
        if (await askConfirm(`Only ${who} can delete this condition (they added it). Ask them to delete it?`)) {
          const reason = await askPrompt('Add a short note for them (optional):', { defaultValue: '' }) || '';
          try { await api.staffRequestDeleteCondition(appId, it.id, reason); onChanged && onChanged(); showMessage(`Asked ${who} to delete it. They'll get a prompt.`); }
          catch (_) { showMessage('Could not send the request.'); }
        }
      } else {
        showMessage((e && e.message) || 'Could not delete the condition.');
      }
    } finally { setBusy(false); }
  }
  return (
    <button className="btn link small" style={{ marginLeft: 8, color: '#b3261e' }} disabled={busy} onClick={doDelete}>
      {busy ? 'Working…' : 'Delete'}
    </button>
  );
}

// The prompt the ADDER sees when someone asked them to delete a condition. They
// can delete it (they are the adder, so the server allows it) or keep it.
function DeleteRequestBanner({ it, appId, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!it || !it.delete_requested_by) return null;
  const who = it.delete_requested_by_name || 'A teammate';
  async function del() { setBusy(true); try { await api.staffDeleteCondition(appId, it.id); onChanged && onChanged(); } catch (e) { showMessage((e && e.message) || 'Could not delete it.'); } finally { setBusy(false); } }
  async function keep() { setBusy(true); try { await api.staffDismissDeleteRequest(appId, it.id); onChanged && onChanged(); } catch (_) {} finally { setBusy(false); } }
  return (
    <div className="notice" style={{ marginTop: 6, borderLeft: '3px solid var(--gold)', padding: '6px 10px', background: 'rgba(174,135,70,0.06)' }}>
      <b style={{ color: '#141B22' }}>{who} asked to delete this condition.</b>
      {it.delete_request_reason ? <span style={{ color: '#4B585C' }}> — “{it.delete_request_reason}”</span> : null}
      <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
        <button className="btn small" disabled={busy} onClick={del}>Delete it</button>
        <button className="btn ghost small" disabled={busy} onClick={keep}>Keep it</button>
      </div>
    </div>
  );
}

function BorrowerConditions({ appId, app, items, docs, onPatch, onReviewDoc, onDownloadDoc, dlBusy, role, onUploadTo, onDropTo, onChanged, onPreview, onOpenStudio, onRequestWaiver, team, canImportCredit, fullscreen = false, closingActive = false }) {
  const completer = canComplete(role);
  const [sowOpen, setSowOpen] = useState(null);   // itemId of the SOW being edited
  const [card, setCard] = useState(null);         // decrypted appraisal card (revealed on demand)
  const [cardBusy, setCardBusy] = useState(false);
  // File service contacts (title / insurance) so staff can see + edit them right
  // on the condition. contactFor() maps a contact-form condition's tool_key to
  // the matching linked contact row.
  const [fileContacts, setFileContacts] = useState([]);
  const loadContacts = useCallback(() => api.staffFileContacts(appId).then(setFileContacts).catch(() => setFileContacts([])), [appId]);
  useEffect(() => { loadContacts(); }, [loadContacts]);
  const contactFor = (toolKey) => {
    const want = toolKey === 'title_contact' ? ['title_company'] : ['insurance_agent', 'flood_insurance'];
    return (fileContacts || []).find(c => want.includes(c.contact_type)) || null;
  };
  // #66 — role-aware visibility: default hides what's already off THIS viewer's
  // plate (LO clears on review/"complete"; processor·underwriter on sign-off;
  // anyone on satisfied). The picker re-shows cleared items or everything —
  // and the choice is persisted per user (owner-directed 2026-07-16).
  const [condFilter, setCondFilter] = useStickyFilter('conds', 'mine');
  // Collapse satisfied + signed-off conditions (and the verified entity condition)
  // to just their header wording (owner-directed 2026-07-20): a done condition is a
  // one-line row; click Expand to open the full slot. Auto by default, per-row
  // manual override tracked here (the entity row uses the synthetic id '__llc').
  const [expandedConds, setExpandedConds] = useState(() => new Set());
  const toggleCond = (id) => setExpandedConds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // The LLC condition stays its OWN dedicated section (LlcReview) AND is also
  // surfaced here as a condition to close, rendered with the full entity template
  // (owner-directed). It's excluded from the generic list below (so it isn't a bare
  // duplicate row) and rendered explicitly as `llcCondItem`.
  // WHO SEES IT is a FILTER, not a place (blueprint Move 4b). Audience was a
  // TAB, which made the one question a processor actually asks — "what is still
  // open on this file?" — impossible to answer, because the answer was split
  // across two tabs that could not be shown at once. Every lending platform
  // benchmarked treats audience as a property of the condition; Encompass ran
  // the tabs-by-persona experiment and collapsed it back into one list.
  const [audFilter, setAudFilter] = useStickyFilter('condAudience', 'all');
  // Subject groups collapse. Persisted as one string so a processor who only
  // ever works title keeps Title open and the rest shut, file after file.
  const [shutGroups, setShutGroups] = useStickyFilter('condGroups', '');
  const shut = new Set(String(shutGroups || '').split(',').filter(Boolean));
  /* Where the reader was before they shut each group. A subject group can be 30
     conditions tall, so closing one takes most of the page away and the browser
     clamps them upward; re-opening has to hand the place back (owner-reported
     2026-08-02). Keyed by group so shutting Title then Insurance and re-opening
     Title still lands on Title. */
  const parkedGroups = useRef({});
  const toggleGroup = (k, el) => {
    const n = new Set(shut);
    const closing = !n.has(k);
    if (closing) { n.add(k); parkedGroups.current[k] = parkScroll(); }
    else n.delete(k);
    // Closing: hold the header the reader clicked, then remember where they were.
    // Opening: put them back, unless they have scrolled somewhere else since.
    keepAnchored(closing ? el : null, () => setShutGroups([...n].join(',')));
    if (!closing) { const p = parkedGroups.current[k]; delete parkedGroups.current[k]; unparkScroll(p); }
  };
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
  // ONE LIST. The internal conditions join the borrower's here rather than
  // living behind their own tab. They keep their OWN row renderer (Item, with
  // the assignee picker, the status control and the phase) — folding them in
  // must not cost them a control, so the list carries two row shapes rather
  // than flattening both into one and losing the difference.
  // ...EXCEPT the handful that are stored as conditions but are really WORKFLOW
  // STEPS (LTC/LTV/ARV/interest-reserve checks). Phase 5a moved them here off
  // their item_kind, which records how a row is STORED, not what it means — the
  // owner reads them as the checklist they asked to have taken off the file, and
  // they are right. See lib/condition-workflow-steps.js for why the three
  // clear-to-close gates are deliberately NOT on that list yet.
  const staffConds = items.filter(it => it.audience === 'staff'
    && (it.item_kind === 'document' || it.item_kind === 'condition')
    && !isWorkflowStep(it));
  const ordered = [...lead, ...rest, ...staffConds];

  async function revealCard() {
    if (card) { setCard(null); return; }
    setCardBusy(true);
    try { setCard(await api.staffAppraisalCard(appId)); }
    catch (e) { showMessage(e.message || 'No card on file yet.'); }
    finally { setCardBusy(false); }
  }
  // Wipe the credit card off the file for good. Deleting it is one-way — the number is
  // encrypted at rest and there is no second copy to put back — so it asks TWICE, and
  // the second question is only about that: it cannot be undone.
  async function clearCard() {
    const ok1 = await askConfirm(
      'Clear the credit card from this file?\n\nThis deletes the card number, the expiry date, the security code and the billing ZIP from this loan file.',
      { title: 'Clear the credit card', confirmLabel: 'Yes, clear it', danger: true });
    if (!ok1) return;
    const ok2 = await askConfirm(
      'Last warning — this cannot be undone.\n\nOnce it is cleared the card CANNOT be retrieved. Nobody can look it up again, and if the card is needed for the appraisal it will have to be entered from scratch.\n\nClear it now?',
      { title: 'This cannot be undone', confirmLabel: 'Clear the card permanently', danger: true });
    if (!ok2) return;
    setCardBusy(true);
    try {
      const out = await api.staffClearAppraisalCard(appId);
      setCard(null);                       // hide anything currently revealed
      showMessage(
        `Card${out.last4 ? ` ending ${out.last4}` : ''} cleared from this file. It cannot be retrieved.`
        + (out.reopened ? '\n\nThe credit-card condition is open again, so the file asks for a card.' : '')
        + (out.savedCopyRemains ? '\n\nNote: the borrower kept a saved card on their own profile for future files — that copy is separate and is still there.' : ''),
        { tone: 'info' });
      if (onChanged) await onChanged();
    } catch (e) { showMessage(e.message || 'Could not clear the card.'); }
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
  // ONE shared rule for every surface — see roleDone() above.
  const offMyPlate = (it) => roleDone(it, role);
  const matchFilter = (it) => {
    switch (condFilter) {
      case 'awaiting':  return ['outstanding', 'requested'].includes(it.status) && !it.signed_off_at;      // nothing submitted yet
      case 'review':    return it.status === 'received' && !it.signed_off_at;                              // uploaded/accepted, not signed off
      case 'attention': return it.status === 'issue';                                                       // needs a fix
      case 'signed':    return !!it.signed_off_at || it.status === 'satisfied';                             // done
      // Everything the processor has NOT signed off yet (owner-directed 2026-08-12:
      // a loan officer wants to see only what is still pending the processor's
      // sign-off). The complement of "Signed off" — across every sub-status
      // (outstanding, requested, received, issue) — excluding waived/satisfied,
      // which are already cleared.
      case 'unsigned':  return !(it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at);
      case 'all':       return true;
      case 'mine':
      default:          return !offMyPlate(it);                                                             // role default
    }
  };
  const isInternal = (it) => it.audience === 'staff';
  const matchAudience = (it) => audFilter === 'all' ? true
    : audFilter === 'internal' ? isInternal(it) : !isInternal(it);
  // CLOSING DOCS STAY OUT OF THE WAY UNTIL THE FILE IS ACTUALLY CLOSING
  // (owner-directed 2026-07-30: the balanced HUD/ALTA, the signed closing package
  // and the collateral tracking label "should not come up immediately when the
  // file is still in processing… it sounds too much"). They are the closer's
  // end-of-file work and never hold up clear-to-close, so while the file is still
  // in processing they surface ONLY under the "Everything" filter — tucked in the
  // Closing group at the bottom — and never in the default "needs my sign-off"
  // view. They keep their own dedicated home in the Closing section's upload panel
  // throughout. Once the file reaches closing (a closer is on it, or it's
  // clear-to-close/funded) they behave like any other condition again.
  const tuckClosing = (it) => !closingActive && condFilter !== 'all' && subjectOf(it) === 'closing';
  const visible = ordered.filter(it => matchFilter(it) && matchAudience(it) && !tuckClosing(it));
  // Grouped by what each condition is ABOUT — see lib/condition-subjects.js.
  // "Done" here is the same role-aware rule the rest of this list uses, so a
  // group header can never disagree with the rows under it.
  const groups = groupBySubject(visible, offMyPlate);
  // FULL SCREEN restores the OLD split layout (owner-directed 2026-07-29): before
  // the merge, internal (staff) and external (borrower) conditions each lived in
  // their own section. The regular screen keeps the merged, subject-grouped list;
  // ONLY full screen splits back into "Borrower conditions" and "Internal
  // conditions" so you can view each side on its own. The subject grouping is
  // kept WITHIN each side, so nothing else about the list changes.
  const countTotal = (gs) => gs.reduce((n, g) => n + g.total, 0);
  const extGroups = fullscreen ? groupBySubject(visible.filter((it) => !isInternal(it)), offMyPlate) : [];
  const intGroups = fullscreen ? groupBySubject(visible.filter((it) => isInternal(it)), offMyPlate) : [];
  const sectionBanner = (label, sub, count) => (
    <div className="cond-section-banner">
      <div className="cond-section-title">{label}</div>
      <div className="cond-section-sub">{sub}</div>
      <span className="cond-section-count">{count} condition{count === 1 ? '' : 's'}</span>
    </div>
  );
  const sections = fullscreen
    ? [
        { key: 'ext', banner: extGroups.length ? sectionBanner('Borrower conditions', 'What the borrower sees and uploads', countTotal(extGroups)) : null, groups: extGroups },
        { key: 'int', banner: intGroups.length ? sectionBanner('Internal conditions', 'Staff-only — never shown to the borrower', countTotal(intGroups)) : null, groups: intGroups },
      ]
    : [{ key: 'all', banner: null, groups }];
  // The LLC condition renders as its own row; drive its visibility off a
  // synthesized status so it honors the same filters.
  const llcPseudo = { id: '__llc', tool_key: null, reviewed_at: null,
    status: app.entity_verified ? 'satisfied' : (app.llc_id ? 'received' : 'outstanding'),
    signed_off_at: app.entity_verified ? 'x' : null };
  const llcShown = !!llcCondItem && matchFilter(llcPseudo);
  // Compact until opened, like every other condition (owner-directed
  // 2026-07-28). It used to open itself whenever the entity was NOT yet
  // verified — which is most of a file's life, and the entity panel is the
  // tallest thing in the list.
  const llcOpen = expandedConds.has('__llc');

  // FULL SCREEN opens EVERYTHING (owner-directed 2026-07-28): when you fill the
  // screen to work through the file, the categories, the conditions and the LLC
  // row should all be open — not auto-collapsed the way they are in the normal
  // (space-saving) view. You can still collapse any of them by hand. On entering
  // full screen we snapshot the normal collapse state and open everything; on
  // leaving we put the normal state back, so day-to-day collapses aren't lost.
  const prevFullRef = useRef(false);
  const fsSnapRef = useRef(null);
  useEffect(() => {
    if (fullscreen && !prevFullRef.current) {
      fsSnapRef.current = { shut: shutGroups, expanded: expandedConds };
      setShutGroups('');                                        // every category open
      const allIds = new Set(visible.map((v) => v.id));         // every condition open
      allIds.add('__llc');
      setExpandedConds(allIds);
    } else if (!fullscreen && prevFullRef.current) {
      const snap = fsSnapRef.current;
      if (snap) { setShutGroups(snap.shut); setExpandedConds(snap.expanded); }
      fsSnapRef.current = null;
    }
    prevFullRef.current = fullscreen;
    // Only react to the full-screen transition; the collapse state it reads is the
    // live value at that moment (opening full screen always re-renders first).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  if (ordered.length === 0 && !llcCondItem) return null;
  return (
    <div className="panel" style={{ marginTop: 18, borderColor: 'var(--gold)' }}>
      {/* THE FILTER ROW (blueprint Move 4b). Two questions, side by side, each
          on its own labelled control rather than crammed into the title row
          where both truncated to "Ever…" and "All c…" and answered nothing. */}
      <div className="row" style={{ marginBottom: 4, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Conditions</h3>
        <div className="spacer" />
        <span className="muted small">{signedCount}/{ordered.length} signed off</span>
      </div>
      <div className="cond-filters">
        {/* WHO SEES IT — a filter, not a tab. This is the control that finally
            lets a processor see everything outstanding on the file at once. */}
        <label className="cond-filter">
          <span>Who sees it</span>
          {/* The two answers mirror the row stamps exactly (conditions-vocab §4).
              "Everyone" used to be the no-filter option — it read as "conditions
              everyone sees", which is the OTHER option. */}
          <select className="input" value={audFilter} onChange={e => setAudFilter(e.target.value)}
            title="Conditions the borrower also sees, internal-only ones, or the whole list">
            <option value="all">All conditions</option>
            <option value="borrower">{audienceLabel('borrower')}</option>
            <option value="internal">{audienceLabel('staff')}</option>
          </select>
        </label>
        <label className="cond-filter">
          <span>Show</span>
        <select className="input" value={condFilter} onChange={e => setCondFilter(e.target.value)}
          title={isLO ? 'Your default shows conditions still needing your review; marking one Done clears it here.' : 'Your default shows conditions still needing your sign-off; accepting a document keeps it here until you sign off.'}>
          {/* Words come from lib/conditions-vocab.js — the same five a condition
              is described with everywhere else. 'awaiting' spans two stored
              statuses, so it names the earlier of the two. */}
          <option value="mine">{isLO ? 'Needs my review' : 'Needs my sign-off'}</option>
          <option value="awaiting">{conditionStatusLabel('outstanding')}</option>
          <option value="review">{conditionStatusLabel('received')}</option>
          <option value="attention">{conditionStatusLabel('issue')}</option>
          <option value="unsigned">Not signed off yet</option>
          <option value="signed">Signed off</option>
          <option value="all">Everything</option>
        </select>
        </label>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        The conditions list exactly as the borrower sees it — with each condition's uploaded documents and sign-off.
      </p>
      {/* The LLC condition to close — the FULL entity template (details, ownership,
          the three documents, verification state), rendered here as a condition in
          addition to its dedicated Vesting entity section above. Gate. */}
      {llcShown && (
        // Once the entity is VERIFIED the full-width entity template is huge and
        // just noise, so it auto-collapses to a one-line header (owner-directed
        // 2026-07-20). Expand to reopen it. Unverified, it stays open (there's work
        // to do). '__llc' in expandedConds forces it open.
        !llcOpen
          ? (
            <div className="checkitem" data-keep-scroll="cond-llc" style={{ padding: '2px 10px', borderColor: 'var(--gold)' }}>
              <div className="cnd" role="button" tabIndex={0} aria-expanded={false}
                onClick={() => toggleCond('__llc')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCond('__llc'); } }}
                title="Open the entity condition">
                <span className="cnd-chev" aria-hidden="true">▶</span>
                <span className={`dot ${app.entity_verified ? 'cond-satisfied' : conditionStatusClass(llcPseudo.status)}`} />
                <span className="cnd-name">{llcCondItem.label || 'LLC (vesting entity)'}</span>
                <span className={`aud ${audienceStamp(llcCondItem.audience).cls}`}
                  title={audienceStamp(llcCondItem.audience).title}>{audienceStamp(llcCondItem.audience).label}</span>
                <span className="pill" style={{ borderColor: 'var(--gold)', color: '#8A6D3B', flex: 'none' }}>gate</span>
                <span className="cnd-meta">
                  {/* "No entity linked" is the wrong answer on a file that HAS
                      answered — with "an individual". It read as an unanswered
                      question and pointed at an Add-LLC step that must never
                      happen here (owner-reported 2026-08-03). */}
                  {app.entity_verified ? 'Verified'
                    : app.llc_id ? 'In progress'
                      : app.personal_name_purchase ? 'Individual — no entity'
                        : 'No entity linked'}
                </span>
              </div>
            </div>
          ) : (
            <div className="checkitem" data-keep-scroll="cond-llc" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, borderColor: 'var(--gold)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className={`dot ${app.entity_verified ? 'done' : 'outstanding'}`} />
                <strong>{llcCondItem.label || 'LLC (vesting entity)'}</strong>
                <Badge tone="gold">gate</Badge>
                <span className={`aud ${audienceStamp(llcCondItem.audience).cls}`}
                  title={audienceStamp(llcCondItem.audience).title}>{audienceStamp(llcCondItem.audience).label}</span>
                {app.entity_verified
                  ? <span className="pill ok">Verified ✓</span>
                  : app.llc_id ? <span className="pill">In progress</span>
                    : app.personal_name_purchase ? <span className="pill ok">Individual — no entity</span>
                      : <span className="pill">No entity linked</span>}
                {/* Top-right, always — the ONE shared control (components/ConditionLine). */}
                <ConditionCollapse onToggle={() => toggleCond('__llc')} />
              </div>
              <div className="muted small">
                {app.personal_name_purchase && !app.llc_id
                  ? 'Condition to close. This file closes in the borrower’s own name, so there is no entity to document — the signed non-owner-occupied affidavit is chased on its own condition instead.'
                  : 'Condition to close — the borrower fills this too. Verifying the entity (below or here) satisfies and signs it off.'}
              </div>
              {/* THE FULL LOGIC FOR A FILE WITH NO ENTITY (owner-reported
                  2026-08-03). There are two reasons an entity can be missing and
                  they need opposite answers: nobody has picked one yet (link or
                  create one), or the file vests in an individual (there is
                  nothing to pick, by definition). Saying "link or create one" to
                  the second was a dead end — the only way out of this condition
                  was an entity it must never have. */}
              {app.llc_id
                ? <LlcManager llcId={app.llc_id} staff compactHeader
                    coBorrower={app.co_borrower_id
                      ? { fullName: fullNameOf(app, 'co_'), email: app.co_email || '' }
                      : null} />
                : app.personal_name_purchase
                  ? <p className="muted small" style={{ margin: 0 }}>No entity on this file, and none is needed — title goes in the borrower’s own name.</p>
                  : <p className="muted small" style={{ margin: 0 }}>No vesting entity linked yet — link or create one in the “Vesting entity (LLC)” section above, or mark this file individual below.</p>}
              {!app.entity_verified && <PersonalNameWaiver appId={appId} app={app} onChanged={onChanged} />}
            </div>
          )
      )}
      {visible.length === 0 && !llcShown && (
        <p className="muted small">Nothing matches this filter — switch to “All conditions” to see everything on the file.</p>
      )}
      {/* GROUPED BY SUBJECT (blueprint Move 4b). Fifty conditions in one flat
          list is a wall; grouped by what they are about it is a page you can
          scan. Each header carries its own count, so "is the title work done?"
          is answerable without reading the rows. Groups collapse and the choice
          sticks. A group with nothing in it is not rendered at all. */}
      {sections.map(sec => (
        <React.Fragment key={sec.key}>
          {sec.banner}
          {sec.groups.map(g => (
        <div className="cond-group" key={g.key}>
          <button type="button" className="cond-group-h" aria-expanded={!shut.has(g.key)}
            onClick={(e) => toggleGroup(g.key, e.currentTarget)}>
            <span className={`cond-group-chev${shut.has(g.key) ? '' : ' open'}`} aria-hidden="true">▶</span>
            <span className="cond-group-name">{g.label}</span>
            <span className="cond-group-count">{g.done} of {g.total} done</span>
          </button>
          {!shut.has(g.key) && g.rows.map(it => {
            // Two row shapes, on purpose. An INTERNAL condition keeps Item — its
            // assignee picker, status control and phase — because folding it into
            // this list must not cost it a control it had behind its own tab.
            if (isInternal(it)) return (
              <Item key={it.id} it={it} team={team} onPatch={onPatch} role={role}
                docs={docs} onUploadTo={onUploadTo} onDropTo={onDropTo} onReviewDoc={onReviewDoc}
                onDownloadDoc={onDownloadDoc} dlBusy={dlBusy} onPreview={onPreview} appId={appId}
                onChanged={onChanged} canImportCredit={canImportCredit} fullscreen={fullscreen}
                onRequestWaiver={onRequestWaiver}
                expanded={expandedConds.has(it.id)} onToggleExpand={() => toggleCond(it.id)} />
            );
        const itemDocs = docsFor(it.id);
        const signed = !!it.signed_off_at;
        const done = signed || it.status === 'satisfied' || it.status === 'received';
        // EVERY condition is a compact line until you open it (owner-directed
        // 2026-07-28). It used to collapse only once SATISFIED or SIGNED OFF, so
        // everything still being worked rendered in full — which is what made
        // this list over seven screens tall on a real file.
        const rowDone = it.status === 'satisfied' || signed;
        if (!expandedConds.has(it.id)) {
          return (
            <div className="checkitem" key={it.id} data-keep-scroll={`cond-${it.id}`} style={{ padding: '2px 10px' }}>
              <ConditionLine it={it} role={role} docs={itemDocs} open={false} done={rowDone}
                onToggle={() => toggleCond(it.id)} onPatch={onPatch} />
              {/* A pending "please delete" request shows even on the collapsed row,
                  so the adder notices it without opening the condition. */}
              <DeleteRequestBanner it={it} appId={appId} onChanged={onChanged} />
            </div>
          );
        }
        // Drop a file onto a document condition to upload it (same as the button).
        const canDrop = !it.tool_key && !!onDropTo;
        const dropProps = canDrop ? {
          onDragOver: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-over'); },
          onDragLeave: (e) => { e.currentTarget.classList.remove('drop-over'); },
          onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); onFilesDropped(e, (files) => onDropTo(files, { itemId: it.id, slotBase: itemDocs.length })); },
        } : {};
        return (
          <div className={`checkitem${canDrop ? ' cond-drop' : ''}`} key={it.id} data-keep-scroll={`cond-${it.id}`} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }} {...dropProps}>
            <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
              <span className={`dot ${signed ? 'cond-satisfied' : conditionStatusClass(it.status)}`} style={{ marginTop: 4 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {it.label}
                  {/* WHO SEES IT stays visible when the row is open. Full screen
                      opens every row, so without this the whole full-screen list
                      lost its Internal + external / Internal only stamps — the
                      compact line and the internal rows (Item) already carry it
                      (owner-directed 2026-08-02). */}
                  <span className={`aud ${audienceStamp(it.audience).cls}`} style={{ marginLeft: 8, verticalAlign: 'text-bottom' }}
                    title={audienceStamp(it.audience).title}>{audienceStamp(it.audience).label}</span>
                  {/* Whose requirement this is, when it belongs to one capital
                      partner — derived from the rule, staff-only. */}
                  {it.note_buyer_mark && <span style={{ marginLeft: 8 }}><NoteBuyerMark it={it} /></span>}
                  {it.origin_kind === 'auto' && (
                    <span className="pill" style={{ marginLeft: 8, borderColor: 'var(--gold)', color: 'var(--gold-ink)' }}
                      title={(it.origin_detail && it.origin_detail.rule) ? `Added automatically — applies when: ${it.origin_detail.rule}` : 'Added automatically by a condition rule'}>Auto</span>
                  )}
                  {/* Delete a manually-added condition (owner-directed 2026-08-04). */}
                  <ManualConditionDelete it={it} appId={appId} onChanged={onChanged} />
                </div>
                <DeleteRequestBanner it={it} appId={appId} onChanged={onChanged} />
                {it.pilot_advice && (
                  <div style={{ marginTop: 5 }}><PilotAdvice it={it} /></div>
                )}
                <PilotAdviceNote it={it} />
                <div className="muted small">
                  {it.tool_key === 'info_field' ? (() => {
                      const p = it.tool_payload || {};
                      return `Information request → ${it.field_key || 'field'}${p.value !== undefined ? ` · answered: ${p.value}` : ' · awaiting the borrower’s answer'}`;
                    })()
                    : it.tool_key === 'esign' ? `E-signature${it.esign_doc ? ` — ${it.esign_doc}` : ''} (activates with the e-sign integration)`
                    : it.tool_key === 'rehab_budget' ? `Scope of Work builder${app.rehab_budget != null ? ` · total ${money(app.rehab_budget)}` : ''}`
                    : it.tool_key === 'track_record' ? (() => {
                        // live counts stamped on the condition by the server on
                        // every track-record change — no need to open the panel.
                        // ENTERED (on record) vs VERIFIED are shown side by side;
                        // the condition can only be signed off on VERIFIED
                        // experience (owner-directed 2026-07-20).
                        const p = it.tool_payload || {};
                        // Shortfall is measured against what must actually be VERIFIED
                        // to sign off — the REGISTERED product's experience (gateNeed),
                        // matching the sign-off gate. Falls back to the claim on older
                        // payloads that predate gateNeed.
                        const c = p.counts, v = p.verifiedCounts || {}, r = p.gateNeed || p.required;
                        // No experience priced/claimed on this file → nothing to
                        // verify. It reactivates the moment experience is entered
                        // on the application or in Products & Pricing.
                        if (p.notApplicable) return 'No experience required on this file — reactivates if experience is entered on the application or in Products & Pricing';
                        if (!c) return 'Verified from the borrower\'s general track record (panel below)';
                        const fmt = (x) => `${x.flips || 0} flip${x.flips === 1 ? '' : 's'} · ${x.holds || 0} hold${x.holds === 1 ? '' : 's'}${x.ground ? ` · ${x.ground} ground-up` : ''}`;
                        const have = `Entered: ${fmt(c)} · Verified: ${fmt(v)}`;
                        const needsAny = r && (r.flips + r.holds + r.ground > 0);
                        // Shortfall is judged on VERIFIED — entering deals is not
                        // enough; they must be verified before sign-off.
                        const short = needsAny ? [
                          r.flips > (v.flips || 0) ? `${r.flips - (v.flips || 0)} flip${r.flips - (v.flips || 0) === 1 ? '' : 's'}` : null,
                          r.holds > (v.holds || 0) ? `${r.holds - (v.holds || 0)} hold${r.holds - (v.holds || 0) === 1 ? '' : 's'}` : null,
                          r.ground > (v.ground || 0) ? `${r.ground - (v.ground || 0)} ground-up` : null,
                        ].filter(Boolean) : [];
                        return `${have}${needsAny ? (short.length ? ` — still needs ${short.join(', ')} verified` : ' — requirement met ✓ (verified)') : ''}`;
                      })()
                    : it.tool_key === 'product_pricing' ? (app.registered_program ? `Registered · ${app.registered_program === 'gold' ? 'Gold Standard' : app.registered_program === 'silver' ? 'Silver' : app.registered_program === 'manual' ? 'Manual' : 'Standard'} · ${money(app.registered_total_loan)}` : 'No product registered yet')
                    : it.tool_key === 'appraisal_card' ? 'Card for ordering the appraisal (reveal is audited)'
                    : ['title_contact', 'insurance_contact'].includes(it.tool_key) ? (() => {
                        const c = contactFor(it.tool_key);
                        const who = c ? [c.company_name, c.contact_name].filter(Boolean).join(' · ') : '';
                        const reach = c ? [c.email, c.phone].filter(Boolean).join(' · ') : '';
                        return c
                          ? `${it.tool_key === 'title_contact' ? 'Title' : 'Insurance'} contact: ${who || reach || 'on file'}${who && reach ? ` — ${reach}` : ''}`
                          : `${it.tool_key === 'title_contact' ? 'Title' : 'Insurance'} contact — none entered yet`;
                      })()
                    : it.template_code === 'rtl_p3_assets' ? (() => {
                        // Assets & liquidity: show the registered requirement summary
                        // on the internal login too (#85), not just a bare "document".
                        const liq = it.tool_payload && it.tool_payload.liquidity;
                        // Max cash to close (db/574) — stamped by the assets ledger under its
                        // OWN key (liquidity.* is replaced wholesale on every re-register).
                        const al = it.tool_payload && it.tool_payload.assetLedger;
                        const maxBit = al && al.maxCashToClose != null ? ` · max cash to close ${money2(al.maxCashToClose)}` : '';
                        return liq && liq.required != null
                          ? `Required liquidity ${money2(liq.required)}${liq.cashToClose ? ` · cash to close ${money2(liq.cashToClose)}` : ''}${liq.reserveRequirement ? ` · reserves ${money2(liq.reserveRequirement)}` : ''}${maxBit}`
                          : 'Assets & bank statements — the required liquidity is set the moment a product is registered';
                      })()
                    : it.template_code === 'rtl_p5_assign' ? (() => {
                        // Assignment-of-contract: show the assignment amount (purchase −
                        // original contract) so the officer knows what the uploaded
                        // assignment letter must reflect (owner-directed 2026-07-20).
                        const fee = app.assignment_fee != null ? Number(app.assignment_fee)
                          : (app.purchase_price != null && app.underlying_contract_price != null
                              ? Math.max(0, Number(app.purchase_price) - Number(app.underlying_contract_price)) : null);
                        if (fee == null) return 'Assignment of contract — upload the assignment letter';
                        return `Assignment ${money(fee)}${app.purchase_price != null && app.underlying_contract_price != null
                          ? ` (purchase ${money(app.purchase_price)} − original contract ${money(app.underlying_contract_price)})` : ''} — upload the assignment letter`;
                      })()
                    : it.item_kind}
                  {` · ${conditionStatusLabel(it.status)}`}
                  {signed && ` · signed off by ${it.signed_off_name || 'the internal team'}`}
                </div>
                {/* Cleared without what it asks for — said plainly on the row. */}
                {it.override_at && (
                  <div className="small" style={{ marginTop: 2, color: 'var(--gold, #AE8746)' }}>{overrideLine(it)}</div>
                )}
                <CondInlineEntry it={it} appId={appId} onChanged={onChanged} />
                {it.template_code === 'rtl_p3_assets' && it.hint && (
                  <LoudHint hint={it.hint} className="muted small"
                    style={{ marginTop: 6, padding: '8px 10px', border: '1px solid rgba(127,169,176,.3)', borderRadius: 8 }} />
                )}
                {it.tool_key === 'track_record' && it.tool_payload && it.tool_payload.perBorrower && it.tool_payload.perBorrower.length > 1 && (
                  // #103 — per-borrower breakdown: each borrower's own 3-year-window
                  // deals, so it's clear who contributes what. The requirement is the
                  // combined total shown in the summary line above.
                  <div className="small" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {it.tool_payload.perBorrower.map(p => {
                      const c = p.counts || {}, v = p.verifiedCounts || {};
                      const one = (x) => `${x.flips || 0} flip${x.flips === 1 ? '' : 's'} · ${x.holds || 0} hold${x.holds === 1 ? '' : 's'}${x.ground ? ` · ${x.ground} ground-up` : ''}`;
                      return (
                        <div key={p.borrowerId} className="muted">
                          <b style={{ color: 'var(--ink-9,inherit)' }}>{p.name}</b>{p.isPrimary ? ' (borrower)' : ' (co-borrower)'} — entered {one(c)} · verified {one(v)}
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
              {it.tool_key === 'track_record' && app.borrower_id && (
                /* Phase E (2026-08-09): this used to open the legacy tool in an
                   iframe modal. The Track Record CENTER on this same page is now
                   the workspace — jump there (the whose-record picker at its top
                   covers the co-borrower case the old per-borrower buttons did;
                   full editing stays one click away via its "Open full screen"). */
                <button className="btn ghost small" onClick={() => goToSection('sec-track')}
                  title="Open the Track Record Center on this file — the record, the experience math, and every action">
                  Open the track record
                </button>
              )}
              {it.tool_key === 'appraisal_card' && (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button className="btn ghost small" disabled={cardBusy} onClick={revealCard}>
                    {cardBusy ? '…' : card ? 'Hide card' : 'Reveal card'}
                  </button>
                  <StaffCardEntry appId={appId} onSaved={onChanged} />
                  {/* Shred the card once the appraisal is paid for, so a live card
                      number isn't left sitting on the file. One-way — clearCard()
                      warns twice before it calls the server. */}
                  <button className="btn ghost small" disabled={cardBusy} onClick={clearCard}
                    title="Permanently delete the credit card from this file — it cannot be retrieved afterwards">
                    Clear card
                  </button>
                  {/* The credit-card-for-appraisal condition can be waived directly
                      by the loan officer AND the back office / super admin
                      (owner-directed) — e.g. the appraisal is paid another way. It's
                      a required task, so the generic optional-only Waive below never
                      shows for it; this is its own always-available waive. */}
                  {(isLO || completer) && !signed && it.status !== 'satisfied' && !it.waived_at && (
                    <button className="btn ghost small" title="Waive the credit-card-for-appraisal condition (e.g. the appraisal is paid another way) — clears it without a card"
                      onClick={async () => { if (await askConfirm('Waive the credit-card-for-appraisal condition? It clears without a card on file.')) onPatch(it.id, { waived: true }); }}>Waive</button>
                  )}
                </div>
              )}
              {/* PLANS & PERMITS ON A PURCHASE (owner-directed 2026-08-18): waivable directly
                  "for now" — the enforcement returns before the FIRST DRAW (the condition
                  re-populates, pre-filled with the closing-time document, and the draw
                  coordinator signs off again). It's a required task, so the generic
                  optional-only Waive never shows for it; on a REFINANCE this button never
                  renders — plans are required before closing there. */}
              {it.template_code === 'rtl_p1_plans' && app && !payoffApplies(app.loan_type)
                && completer && !signed && it.status !== 'satisfied' && !it.waived_at && (
                <button className="btn ghost small"
                  title="Waive plans & permits for closing on this purchase — the condition comes back before the first construction draw for the draw coordinator to sign off"
                  onClick={async () => { if (await askConfirm('Waive plans & permits for now? On this purchase they are not needed to close — the condition comes back before the FIRST construction draw, pre-filled with whatever was already uploaded, and the draw coordinator signs it off then.')) onPatch(it.id, { waived: true }); }}>
                  Waive this condition
                </button>
              )}
              {['title_contact', 'insurance_contact'].includes(it.tool_key) && (
                <StaffContactEntry appId={appId} toolKey={it.tool_key} current={contactFor(it.tool_key)}
                  onSaved={async () => { await loadContacts(); if (onChanged) await onChanged(); }} />
              )}
              {/* Order it straight from the condition — the same modal the internal
                  rows carry, so the contact you just entered can be used to send
                  the order without going to the Orders section. */}
              {orderKindForCondition(it) && (
                <ConditionOrderButton appId={appId} it={it} role={role} onChanged={onChanged} />
              )}
              {/* Ask for one more document WITHIN this condition (db/578) — the
                  borrower sees it as still needed; never a brand-new condition. */}
              {it.template_code !== 'rtl_cond_credit' && (
                <RequestSlotButton appId={appId} it={it} onChanged={onChanged} />
              )}
              {!it.tool_key && onUploadTo && (
                <button className="btn ghost small"
                  title="Upload documents into this condition on the borrower's behalf (multiple PDFs at once supported) — they land in the shared list exactly as if the borrower uploaded them"
                  onClick={() => onUploadTo({ itemId: it.id, slotBase: itemDocs.length })}>
                  {itemDocs.length ? '+ Add doc' : 'Upload'}
                </button>
              )}
              {/* ONE next step, everything else behind More — the SAME bar the
                  internal rows use, so the two shapes can never drift again.
                  canSendBack is forced on: these rows are the borrower's list,
                  so sending one back is always a real option here. */}
              <ConditionActions it={it} role={role} team={team} onPatch={onPatch}
                docs={itemDocs} canSendBack onRequestWaiver={onRequestWaiver} />
              {/* Top-right, always — the ONE shared control (components/ConditionLine). */}
              <ConditionCollapse onToggle={() => toggleCond(it.id)} />
            </div>
            {(it.issue_reason || it.rejection_reason) && (
              <div className="small" style={{ color: 'var(--danger)', paddingLeft: 20 }}>Sent back: {it.issue_reason || it.rejection_reason}</div>
            )}
            {it.borrower_hint && /still needed/i.test(it.borrower_hint) && (
              <div className="small" style={{ color: 'var(--gold-ink)', paddingLeft: 20 }}>Requested from borrower: {it.borrower_hint.replace(/^[\s\S]*?Still needed:\s*/i, '')}</div>
            )}
            {/* Ad-hoc requested document slots (db/578) — each open ask on this
                condition, whether the borrower owes it or our own team, with
                upload / remove right on the line. A filled one points at the
                document list below. */}
            {Array.isArray(it.slots) && it.slots.some((s) => s.extra) && (
              <div style={{ width: '100%', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {it.slots.filter((s) => s.extra).map((s) => {
                  const filled = itemDocs.some((d) => docInSlot(d, s.label));
                  return (
                    <div className="row" key={s.key} style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="pill" style={{ borderColor: 'var(--gold, #AE8746)', color: 'var(--gold, #AE8746)' }}
                        title={`Requested${s.added_by_name ? ` by ${s.added_by_name}` : ''}`}>
                        requested{s.audience === 'external' ? ' · borrower' : ' · internal'}
                      </span>
                      <span className="small" style={{ fontWeight: 600 }}>{s.label}</span>
                      {filled ? (
                        <span className="small muted">uploaded — see the documents below</span>
                      ) : (
                        <>
                          <span className="small muted">not uploaded{s.added_by_name ? ` · asked by ${s.added_by_name}` : ''}</span>
                          {onUploadTo && <button className="btn ghost small" onClick={() => onUploadTo({ itemId: it.id, slot: s.label })}>Upload</button>}
                          <button className="btn ghost small" title="Remove this request (only an unfilled slot can be removed)"
                            onClick={async () => {
                              if (!(await askConfirm(`Remove the request for "${s.label}"?`))) return;
                              try { await api.conditionSlotRemove(appId, it.id, String(s.key).replace(/^extra:/, '')); if (onChanged) await onChanged(); }
                              catch (e) { await showMessage((e && e.message) || 'Could not remove the request.'); }
                            }}>Remove</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <CondNote item={it} onPatch={onPatch} />
            {itemDocs.length > 0 && (
              <div style={{ width: '100%', paddingLeft: 20 }}>
                {itemDocs.map((d, i) => {
                  const rs = d.review_status || 'pending';
                  return (
                    <div className="row" key={d.id} style={{ gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                      <span className="muted small" style={{ minWidth: 140 }}>{d.slot_label || (d.source_type === 'system' ? 'Tool export' : `Document ${i + 1}`)}</span>
                      <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                      <span className="pill" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                      <DocActions doc={d} role={role} onReviewDoc={onReviewDoc} fullscreen={fullscreen}
                        onDownloadDoc={onDownloadDoc} onPreview={onPreview} dlBusy={dlBusy}
                        onReplace={(onUploadTo && d.source_type !== 'system')
                          ? () => onUploadTo({ itemId: it.id, slot: d.slot_label || undefined, replaceDocumentId: d.id }) : null} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
          })}
        </div>
          ))}
        </React.Fragment>
      ))}
      {sowOpen && (
        <ToolModal
          title="Rehab Budget — Scope of Work (internal)"
          url={sowUrl(appId, sowOpen, app)}
          onClose={() => setSowOpen(null)} />
      )}
    </div>
  );
}

/* WHAT PILOT HOLDS vs WHAT THE CARD HOLDS, field by field (owner-directed
   2026-08-02: "Pipeline data" becomes ClickUp Sync, with a full every-field data
   comparison).

   The old panel printed a read-only list of the figures the last PULL happened to
   leave on the file — PILOT's own columns, labelled as though they came from
   ClickUp — so it could not answer the one question anyone asks of a sync screen:
   do the two systems agree right now? Both values are on screen now, and the
   VERDICT is the sync's own (lib/clickup-compare reuses the same equivalence rule
   the outbound no-op suppression uses), so a row this table calls "matching" is
   exactly a row a push would decline to write.

   Disagreements come first — nobody scrolls a 60-row table to find the one thing
   that is wrong. Everything that agrees is one click away, deliberately kept
   rather than hidden: "these match" is exactly what somebody is checking. */
function ClickupCompare({ appId }) {
  const [state, setState] = useState({ loading: true });
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => {
    setState({ loading: true });
    return api.clickupCompare(appId)
      .then((r) => setState({ loading: false, ...r }))
      .catch((e) => setState({ loading: false, error: e.message || 'Could not compare' }));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (state.loading) return <p className="small" style={{ color: '#4B585C' }}>Comparing with ClickUp…</p>;
  if (state.error) return <p className="small" style={{ color: '#B3261E' }}>{state.error}</p>;
  if (state.linked === false) {
    return <p className="small" style={{ color: '#4B585C' }}>This file is not linked to a ClickUp card yet, so there is nothing to compare.</p>;
  }
  if (state.unreadable) {
    return (
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="small" style={{ color: '#8A6A22' }}>{state.summary}</span>
        <button className="btn ghost small" onClick={load}>Try again</button>
      </div>
    );
  }

  const rows = state.rows || [];
  const attention = state.attention || [];
  const clean = attention.length === 0;
  const shown = showAll ? rows : attention;
  const TONE = {
    differs: { c: '#B3261E', t: 'Different' },
    only_pilot: { c: '#8A6A22', t: 'Only in PILOT' },
    only_clickup: { c: '#8A6A22', t: 'Only on the card' },
    match: { c: '#1F7A4D', t: 'Match' },
    blank: { c: '#4B585C', t: 'Neither' },
  };

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, color: clean ? '#1F7A4D' : '#8A6A22' }}>{state.summary}</span>
        <div className="spacer" />
        <button className="btn ghost small" onClick={load}>Re-check</button>
        <button className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only what differs' : `Show all ${rows.length} fields`}
        </button>
      </div>
      {clean && !showAll && (
        <p className="small" style={{ color: '#4B585C', margin: '0 0 8px' }}>
          Nothing to reconcile. Use &ldquo;Show all&rdquo; to read every field side by side.
        </p>
      )}
      {shown.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse', color: '#141B22' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>Field</th>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>PILOT</th>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>ClickUp card</th>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>Syncs</th>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const tone = TONE[r.status] || TONE.blank;
                return (
                  <tr key={r.fieldId || r.field} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '6px 8px', color: '#141B22' }}>{r.label}</td>
                    <td style={{ padding: '6px 8px', color: r.pilot ? '#141B22' : '#4B585C' }}>{r.pilot || '—'}</td>
                    <td style={{ padding: '6px 8px', color: r.clickup ? '#141B22' : '#4B585C' }}>{r.clickup || '—'}</td>
                    <td style={{ padding: '6px 8px', color: '#4B585C' }}>{r.direction}</td>
                    <td style={{ padding: '6px 8px', color: tone.c, whiteSpace: 'nowrap' }}>{tone.t}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small" style={{ color: '#4B585C', marginTop: 8, marginBottom: 0 }}>
        A row reads &ldquo;Match&rdquo; when the two systems mean the same thing, even if they spell it
        differently — that is the same test the sync itself uses to decide whether a push would
        actually change anything.
      </p>
    </div>
  );
}

/* THE YS LOAN NUMBER, enterable where every other detail is (owner-directed
   2026-08-02: "YS loan number — add an action to ENTER it"). Until now it could
   only be typed on a completeness pill, which DISAPPEARS once the number is
   set — so a wrong one could never be corrected from anywhere.

   ONE WRITE PATH: it posts to the same dedicated `/loan-number` door, which is
   what enforces the YSCAP format and refuses a number already used on another
   file or ClickUp card (a duplicate is parked to manual review). This is a
   second BUTTON, never a second rule. */
function LoanNumberEntry({ appId, value, onSaved, autoOpen = false, label = 'YS loan number' }) {
  const [editing, setEditing] = useState(!!autoOpen);
  const [val, setVal] = useState(value || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    const v = String(val || '').trim();
    if (!v) { setErr('Enter the loan number.'); return; }
    setBusy(true); setErr('');
    try {
      await api.staffSetLoanNumber(appId, v);
      setEditing(false);
      if (onSaved) await onSaved();
    } catch (e) { setErr(e.message || 'Could not save that loan number.'); }
    finally { setBusy(false); }
  }
  const inner = (
    <>
        {!editing ? (
          <span className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: value ? '#141B22' : '#4B585C' }}>{value || 'not set yet'}</span>
            <button className="btn ghost small" onClick={() => { setVal(value || ''); setErr(''); setEditing(true); }}>
              {value ? 'Change' : 'Enter the loan number'}
            </button>
          </span>
        ) : (
          <span className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input" style={{ maxWidth: 220 }} value={val} placeholder="YSCAP…"
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
            <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn ghost small" disabled={busy} onClick={() => { setEditing(false); setErr(''); }}>Cancel</button>
          </span>
        )}
        {err && <div className="small" style={{ color: '#B3261E', marginTop: 4 }}>{err}</div>}
    </>
  );
  // On a condition card there is no label column — the condition's own wording is
  // the label, and a `metrow` there would read as a stray table row.
  if (label === null) return <div style={{ marginTop: 8 }}>{inner}</div>;
  return (
    <div className="metrow" style={{ alignItems: 'flex-start' }}>
      <span className="k">{label}</span>
      <span className="v" style={{ display: 'block' }}>{inner}</span>
    </div>
  );
}

/* ClickUp sync panel — staff-only surface on the file overview.
   Shows the two-layer status (exact ClickUp mirror vs. borrower-facing), the
   YS loan number, the note buyer (internal only — never borrower-facing), the
   link to the ClickUp task, and last-synced time. Admins (platform_setup) can
   force a re-push / re-pull. */
function ClickupSyncPanel({ app, canSetup, isAdmin, onResynced }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [linkInput, setLinkInput] = useState('');
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
  // ADMIN: detach this file from its ClickUp card. Plain-language confirm; the
  // card is never deleted, the file just stops syncing until it is relinked.
  async function doUnlink() {
    if (!(await askConfirm(`Unlink this file from its ClickUp card?\n\nThe ClickUp card is NOT deleted — the file just stops syncing with it until you link a card again. Use this when the wrong file is connected to the card.`))) return;
    setBusy('unlink'); setNote('');
    try {
      await api.clickupUnlink(app.id);
      setNote('Unlinked from ClickUp ✓ — this file no longer syncs with any card.');
      if (onResynced) onResynced();
    } catch (e) { setNote(e.message || 'Unlink failed'); }
    finally { setBusy(''); }
  }
  // ADMIN: link this file to a ClickUp card. If the card is currently on another
  // file (the twin-file case), the server asks us to confirm the move.
  async function doRelink(confirmMove) {
    const val = linkInput.trim();
    if (!val) { setNote('Paste a ClickUp card link or id first.'); return; }
    setBusy('relink'); setNote('');
    try {
      const r = await api.clickupRelink(app.id, val, confirmMove);
      setNote(`Linked to ClickUp card ${r.taskId}${r.movedFrom ? ' ✓ (moved it off the file that was wrongly holding it)' : ' ✓'}.`);
      setLinkInput('');
      if (onResynced) onResynced();
    } catch (e) {
      // Held card → the server returns the current holder so we can confirm.
      if (e && e.data && e.data.needsConfirm) {
        const h = e.data.holder || {};
        const who = [h.borrower, h.address].filter(Boolean).join(' — ') || 'another file';
        if (await askConfirm(`That ClickUp card is currently linked to:\n\n${who}\n\nMove the card to THIS file? The other file will be unlinked (nothing is deleted) and left for you to review/archive.`)) {
          return doRelink(true);
        }
        setNote('Move cancelled — nothing changed.');
      } else { setNote(e.message || 'Link failed'); }
    }
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
        {isAdmin && taskId && (
          <button className="btn ghost small" disabled={!!busy} onClick={doUnlink} title="Detach this file from its ClickUp card (the card is not deleted)">{busy === 'unlink' ? 'Unlinking…' : 'Unlink card'}</button>
        )}
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <span className="muted small">Internal status (ClickUp mirror): <b>{app.internal_status || '—'}</b></span>
        <span className="muted small">Borrower sees: <b>{app.status || '—'}</b></span>
        {app.ys_loan_number && <span className="muted small">YS loan #: <b>{app.ys_loan_number}</b></span>}
        <NoteBuyerRef value={app.lender} />
        {app.clickup_last_synced_at && <span className="muted small">Last synced: {new Date(app.clickup_last_synced_at).toLocaleString()}</span>}
      </div>
      {/* ADMIN relink: only when this file has NO card. Paste the correct card's
          link/id; if that card is on another file, we confirm the move. */}
      {isAdmin && !taskId && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
          <input className="input small" style={{ minWidth: 220, flex: '1 1 240px' }} placeholder="Paste the correct ClickUp card link or id…"
            value={linkInput} onChange={(e) => setLinkInput(e.target.value)} disabled={!!busy} />
          <button className="btn primary small" disabled={!!busy || !linkInput.trim()} onClick={() => doRelink(false)}>{busy === 'relink' ? 'Linking…' : 'Link this card'}</button>
        </div>
      )}
      {note && <div className="muted small" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}

/* Clean line icons (Feather-style) replacing the old emoji on the Message /
   Remind actions — owner-directed 2026-07-14 ("looks like kid play"). */
const IconMessage = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 7, verticalAlign: '-2px' }}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-4-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
  </svg>
);
const IconBell = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 7, verticalAlign: '-2px' }}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

// #84 — a clear-to-close / funded (or terminal) file's loan STRUCTURE is frozen
// for everyone. A super-admin can deliberately unlock a file to correct a genuine
// mistake, then re-lock it. Shows the lock state to everyone; the Unlock / Re-lock
// buttons are super-admin-only (the server enforces this too).
const STRUCTURAL_LOCK_STATUSES = ['clear_to_close', 'funded', 'declined', 'withdrawn'];

function StructuralLockBanner({ app, role, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!STRUCTURAL_LOCK_STATUSES.includes(app.status)) return null;
  const unlocked = !!app.structural_unlocked_at;
  const isSuper = role === 'super_admin';
  const label = APP_STATUS_LABEL[app.status] || app.status;
  const toggle = async (next) => {
    setErr('');
    if (next) {
      const reason = await askPrompt('Unlock this file so its locked loan details can be corrected? Add a short reason (this is logged):', { defaultValue: '' });
      if (reason === null) return;   // cancelled
      setBusy(true);
      try { await api.staffSetStructuralLock(app.id, true, reason || null); onChanged && await onChanged(); }
      catch (e) { setErr((e && e.message) || 'Could not unlock the file.'); }
      setBusy(false);
    } else {
      setBusy(true);
      try { await api.staffSetStructuralLock(app.id, false); onChanged && await onChanged(); }
      catch (e) { setErr((e && e.message) || 'Could not re-lock the file.'); }
      setBusy(false);
    }
  };
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-b" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <b>{unlocked ? '🔓' : '🔒'} This file is {label} — its loan structure is {unlocked ? 'temporarily UNLOCKED' : 'locked'}.</b>
          <div className="muted small" style={{ marginTop: 2 }}>
            {unlocked
              ? 'A super-admin unlocked it so the price, loan amount, pricing, rehab budget or vesting entity can be corrected. Re-lock it when the fix is done.'
              : 'The price, loan amount, pricing, rehab budget and vesting entity can’t be changed while it’s locked.'}
          </div>
          {err && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
        </div>
        {isSuper && (unlocked
          ? <button className="btn" disabled={busy} onClick={() => toggle(false)}>{busy ? '…' : 'Re-lock'}</button>
          : <button className="btn primary" disabled={busy} onClick={() => toggle(true)}>{busy ? '…' : 'Unlock to correct'}</button>)}
      </div>
    </div>
  );
}

export default function StaffApplication() {
  const { id } = useParams();
  const nav = useNavigate();
  const { search, pathname } = useLocation();
  // A counter-signer bouncing back from DocuSign's embedded view lands on
  // …?esign=<state>. Show a confirmation, then strip the param.
  const esignReturn = new URLSearchParams(search || '').get('esign');
  const [esignMsg] = useState(() => ESIGN_RETURN_MSG[esignReturn] || null);
  useEffect(() => {
    if (!esignReturn) return;   // strip whenever the param is present, even if unmapped
    const sp = new URLSearchParams(search);
    sp.delete('esign');
    nav({ pathname, search: sp.toString() ? `?${sp.toString()}` : '' }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { role, can, actor: authActor } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const completer = canComplete(role);   // may CLEAR (sign off) a condition; others only mark it reviewed
  const canDelete = can('delete_files');
  const [app, setApp] = useState(null);
  // For the per-file notification override panel — only surfaces when THIS
  // user is the file's assigned loan officer. Must be computed AFTER `app` is
  // declared (const bindings are in the TDZ until initialised).
  const isMyFile = !!(authActor && app && app.loan_officer_id && String(authActor.id) === String(app.loan_officer_id));
  // Deep-link to a section: a URL ending in "#sec-<name>" (e.g. the Orders queue's
  // "Open" button → #sec-orders) opens + scrolls to that collapsed section once the
  // file has rendered. Best-effort; a no-op when the fragment names no real section.
  //
  // LANDING IS ONCE PER FILE, NEVER ON A REFRESH (owner-reported 2026-07-27: "whenever
  // I accept the document or I sign off a condition it automatically flies down to the
  // bottom and to the closing section"). This effect is keyed on `app`, and EVERY
  // action on the file — accept a document, sign off a condition, upload, assign —
  // ends in `load()`, which hands back a brand-new `app` object. So the closer's
  // land-on-Closing jump (and the #sec- deep link) re-fired on every single action and
  // dragged the reader from whatever they were working on down to the Closing section.
  // The `landed` ref makes it what it was always meant to be: where you arrive when you
  // OPEN the file, not somewhere you get sent while you work. Reset per file id below.
  const landed = useRef(false);
  useEffect(() => { landed.current = false; }, [id]);
  useEffect(() => {
    // `app` still holds the PREVIOUS file for one render after the url changes
    // (it's cleared in the [id] effect below), so match it to the url or the
    // landing would burn itself on the old file and never fire for the new one.
    if (!app || String(app.id) !== String(id) || landed.current) return;
    landed.current = true;
    const rawHash = String(window.location.hash || '');
    // A `?finding=` / `?focus=` arrival is OWNED by its own landing effect below.
    // Without this stand-down the closer landing fires 300ms later, hops to
    // Signing & Closing, and strands the anchor's scroll in a room that is no
    // longer rendered — and admin/super_admin/closer all hold manage_closings,
    // so it hit exactly the people the fatal-finding email fans out to
    // (pre-merge audit 2026-08-02).
    const qAt = rawHash.indexOf('?');
    const landingQuery = new URLSearchParams(search || (qAt >= 0 ? rawHash.slice(qAt + 1) : ''));
    if (landingQuery.get('finding') || landingQuery.get('focus')) return;
    // Any anchor the room map knows, not only a `sec-*` one: the old
    // `#(sec-[a-z-]+)` filter dropped `#ai-findings` (emitted by
    // src/lib/ai/cost-meter.js) before it was ever looked up, so that email
    // landed on the file top with nothing opened (post-merge audit 2026-08-02).
    const m = rawHash.match(/#([a-z][a-z0-9-]*)$/);
    if (m && stationOf(m[1])) {
      const target = m[1];
      let inner = null;
      const t = setTimeout(() => {
        if (target.startsWith('sec-')) {
          // A RETIRED address (#sec-encompass) lands on the section that holds
          // its content, with the right tab already showing. Resolved HERE as
          // well as in the room resolver because CLASSIC view registers no
          // resolver at all — every section renders, so the jump would go to an
          // element that no longer exists and quietly do nothing.
          const moved = resolveSection(target);
          if (moved.appTab) requestAppDetailTab(moved.appTab);
          goToSection(moved.id);
          return;
        }
        // Rooms view: the resolver hops to the owning room, opens it and scrolls.
        if (revealAnchor(target)) return;
        // revealAnchor is three-state collapsed into a boolean: `true` means only
        // that the RESOLVER took it. Its own getElementById path scrolls and still
        // returns false, so without this the fallback below would schedule a
        // SECOND scroll of the same element 400ms later — which yanks a reader who
        // scrolled away in between (re-audit 2026-08-02). If the element is on the
        // page, the reveal already did the work.
        if (document.getElementById(target)) return;
        // Classic view registers NO resolver, and the owning section may be
        // collapsed — a collapsed Section unmounts its children, so there is
        // nothing for revealAnchor to find. Open the section first, then scroll:
        // the same shape the ?focus=ai-findings landing already uses.
        const owner = ANCHOR_SECTION[target];
        if (owner) requestOpenSection(owner);
        inner = setTimeout(() => {
          const el = document.getElementById(target) || (owner ? document.getElementById(owner) : null);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 400);
      }, 250);
      // BOTH timers: the inner one is created inside the outer callback, so a
      // cleanup that only cleared `t` left an orphan that could fire against the
      // NEXT file and scroll it to the top (open A, switch to B within ~650ms).
      return () => { clearTimeout(t); if (inner) clearTimeout(inner); };
    }
    // A plain REFRESH lands here: no deep link, no ?finding/?focus. The room is
    // already restored (the [id] effect read it from sessionStorage); if the
    // reader was scrolled into a specific section, open it and put them back on it.
    // A remembered NON-trivial place (any section, or a room other than Overview)
    // wins over the closer's default landing below — a closer who was working a
    // section should refresh back onto it, not be yanked to Closing. A first-time
    // open, or "remembered the top of Overview", has nothing meaningful to restore
    // and falls through so the closer landing still runs.
    const savedRoom = readStation(id);
    const savedSec = readSection(id);
    if (savedRoom && (savedRoom !== 'st-overview' || savedSec)) {
      if (!savedSec) return;   // remembered only the room; the [id] effect already put them there
      let inner = null;
      const t = setTimeout(() => {
        requestOpenSection(savedSec);   // the section may render collapsed — open it first
        inner = setTimeout(() => {
          const el = document.getElementById(savedSec);
          if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
        }, 120);
      }, 220);
      return () => { clearTimeout(t); if (inner) clearTimeout(inner); };
    }
    // A closer lands on the Closing section by default (owner-directed 2026-07-26)
    // when there's actually a closing to work — a closer on file or a CTC/funded file.
    if (can('manage_closings') && (app.closer_id || ['clear_to_close', 'funded'].includes(app.status))) {
      const t = setTimeout(() => goToSection('sec-closing'), 300);
      return () => clearTimeout(t);
    }
  }, [app, id]);
  // R3.44 — jump straight to the AI Findings panel from ?focus=ai-findings (the
  // Insights dashboard's "Review AI →" button).
  //
  // This USED TO SILENTLY DO NOTHING. #ai-findings lives inside the "Document
  // review" section, which is collapsed by default — and a collapsed Section
  // unmounts its children (FileSections.jsx), so getElementById found nothing and
  // the click went nowhere. Open the section FIRST, then scroll. Falls back to the
  // section itself if the panel is still mounting.
  //
  // It also has to live HERE, after `app` is declared: the effect is gated on the
  // file having loaded (the sections don't exist before that), and a `const` read
  // from a deps array above its own declaration is a TDZ crash.
  //
  // Like the closer landing above, this is a LANDING — it fires when you arrive,
  // never again while you work. `app` is a fresh object after every action, so
  // without the ref an underwriter who arrived from the Insights dashboard was
  // dragged back to the findings panel on every accept / sign-off.
  const focusedAi = useRef(false);
  useEffect(() => { focusedAi.current = false; }, [id]);
  useEffect(() => {
    if (!app || focusedAi.current) return;
    if (new URLSearchParams(search || '').get('focus') !== 'ai-findings') return;
    focusedAi.current = true;
    // Seven Rooms: from another room the resolver hops + opens + scrolls; when
    // already on the Review room (or in classic view) keep today's path.
    if (revealAnchor('ai-findings')) return;
    requestOpenSection('sec-underwriting');
    const tid = setTimeout(() => {
      const el = document.getElementById('ai-findings') || document.getElementById('sec-underwriting');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 600);
    return () => clearTimeout(tid);
  }, [app, search]);
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
  // Appraisal review summary (fatal/warning counts) — reported up by AppraisalPanel so
  // the section nav can show a findings badge without a second fetch here.
  const [apprSummary, setApprSummary] = useState(null);
  const onApprSummary = useCallback((s) => setApprSummary(s), []);
  const [uwSummary, setUwSummary] = useState(null);
  const onUwSummary = useCallback((s) => setUwSummary(s), []);
  // Known internal (ClickUp) statuses for the picker — file-independent, loaded once.
  const [internalStatuses, setInternalStatuses] = useState([]);
  const [condFilter, setCondFilter] = useState('all');
  const [cForm, setCForm] = useState({ title: '', audience: 'staff', severity: 'standard' });
  const [inviteBusy, setInviteBusy] = useState(false);
  // One in-flight action at a time: double-clicking Assign/Remind/Accept/Request
  // used to double-assign, double-email the borrower, or create duplicate items.
  const [busyAct, setBusyAct] = useState('');
  const [apprReload, setApprReload] = useState(0);   // bumped when an XML upload auto-builds the appraisal

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };
  // The file's audit log. `deepActivity` adds the request-level layer — one
  // line per API call that touched this file. Opt-in, because it is enormous
  // and mostly page loads; it is what you turn on when the business trail
  // doesn't explain what happened.
  const [deepActivity, setDeepActivity] = useState(false);
  const activityFetcher = useCallback(
    () => api.staffActivity(id, { requests: deepActivity, limit: deepActivity ? 1200 : 600 }),
    [id, deepActivity]);

  async function inviteBorrower() {
    setInviteBusy(true); setErr('');
    try {
      const r = await api.staffInviteBorrower(id);
      flash(r.hasAccount
        ? 'That borrower already has PILOT access — a sign-in link was emailed to them.'
        : 'Invitation emailed. When the borrower sets up access they will see this file immediately.');
    } catch (e) { setErr(e.message || 'Could not send the invite.'); }
    finally { setInviteBusy(false); }
  }
  function jumpToChat() {
    // From another room the resolver switches to Messages & History first.
    if (revealAnchor('conversations')) return;
    // Fall back to the section itself if the conversation panel is still mounting,
    // so the jump always lands somewhere useful rather than nowhere at all.
    const el = document.getElementById('conversations') || document.getElementById('sec-messages');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const idRef = useRef(id); idRef.current = id;
  // The first load of a file paints an empty page — there is no place to hold,
  // and it's the one moment a landing (above) is allowed to move you. Every
  // load AFTER it is a refresh triggered by something the user just did, and
  // must leave them exactly where they were.
  const firstLoad = useRef(true);
  async function load() {
    const forId = id;   // drop late responses after switching to another file
    const isFirst = firstLoad.current;
    firstLoad.current = false;
    try {
      const a = await api.staffApplication(id);
      if (idRef.current !== forId) return;
      // Captured AFTER the fetch, right before the re-render: the reader may
      // have scrolled while the request was in flight, and putting them back
      // where they were a second ago is the very thing this is fixing.
      const anchor = isFirst ? null : captureScrollAnchor();
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
      // …and put them back once the new list has painted (a no-op when nothing
      // above them moved, which is most refreshes).
      restoreScrollAnchor(anchor);
      if (a.borrower_id) api.staffBorrower(a.borrower_id).then(b => { if (idRef.current === forId) setBorrower(b); }).catch(() => {});
      api.staffGating(id).then(g => { if (idRef.current === forId) setGating(g); }).catch(() => setGating(null));
    } catch (e) { if (idRef.current === forId) setErr(e.message); }
  }
  useEffect(() => {
    // This component is reused across /internal/app/:id changes — clear the old
    // file's data or it renders under the new file's URL until the fetch lands.
    setApp(null); setItems([]); setDocs([]); setConds([]); setBorrower(null); setGating(null); setErr(''); setMsg('');
    firstLoad.current = true;   // a new file opens fresh — nothing to hold, landing allowed
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
      // Same trap as ?focus=ai-findings above: #conversations lives inside the
      // collapsed "Communication & history" section (whose children are unmounted
      // while closed) AND only renders on the Chats tab — so arriving from the Chat
      // hub used to scroll to an element that wasn't there. Open the section and
      // select the tab, then scroll once both have rendered.
      setCommTab('messages');
      if (!revealAnchor('conversations')) {
        requestOpenSection('sec-messages');
        setTimeout(jumpToChat, 250);
      }
    }
    /* eslint-disable-next-line */
  }, [app]);

  // Arriving from "Findings to review" (?finding=<id>): that link was DEAD —
  // StaffFindingEscalations emits it, but no handler existed here and the pulse
  // code lives inside UnderwritingPanel, which is UNMOUNTED while its section
  // is collapsed (and it starts collapsed) — so the click landed and did
  // nothing (red-team R1, docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md §6).
  // NOTE the producer puts the query INSIDE the hash (…#/internal/app/:id?finding=x),
  // which location.search never sees — parse both forms, exactly as the
  // panel's own pulse does. Once the section mounts, the panel takes over
  // (scrolls to the exact finding and pulses it gold).
  const focusedFinding = useRef(false);
  useEffect(() => { focusedFinding.current = false; }, [id]);
  useEffect(() => {
    if (!app || focusedFinding.current) return;
    let fid = new URLSearchParams(search || '').get('finding');
    if (!fid) {
      const h = String(window.location.hash || '');
      const q = h.indexOf('?');
      if (q >= 0) fid = new URLSearchParams(h.slice(q + 1)).get('finding');
    }
    if (!fid) return;
    focusedFinding.current = true;
    if (revealAnchor('ai-findings')) return;
    requestOpenSection('sec-underwriting');
    const tid = setTimeout(() => {
      const el = document.getElementById('sec-underwriting');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 400);
    return () => clearTimeout(tid);
  }, [app, search]);

  // In-place document preview (any PDF/image/text) — see it before signing off,
  // without downloading. Uses the same authenticated loader as the download.
  const [previewDoc, setPreviewDoc] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);   // #94 — Message opens a popup, not a scroll
  const [remindOpen, setRemindOpen] = useState(false);   // #93 — Remind opens the reminder/task manager
  // The ClickUp/pipeline plumbing — the sync panel (super-admin push/pull/refresh,
  // link/unlink) and the 38-status internal-status dropdown — is shown by default so
  // staff can change/maneuver the ClickUp status and re-sync right from the file. The
  // toggle stays so it can be collapsed when someone wants a quieter overview.
  const openPreview = useCallback((doc) => setPreviewDoc(doc), []);

  // Revealing / adding / correcting the SSN moved into the shared
  // BorrowerProfilePanel (owner-directed 2026-07-27) so the CO-borrower gets
  // the identical audited flow — including the duplicate-profile resolver — that
  // only the primary borrower used to have here.

  async function patch(itemId, body) {
    try {
      await api.staffPatchItem(itemId, body);
      flash(body && body.adminOverride ? 'Cleared by override ✓ — recorded on the file' : 'Saved ✓');
      await load();
    }
    catch (e) {
      const msg = e.message || 'Update failed';
      // A BLOCKED sign-off / verification (#88) needs an unmissable explanation of
      // WHY it can't be signed off (e.g. experience still needs verifying, budgets
      // don't match, a required document is missing). The page-top banner is easy
      // to miss on a long file, so surface the exact reason right here too.
      const completing = isCompletion(body);
      // THE OVERRIDE, OFFERED WHERE THE WALL IS (owner-directed 2026-07-27). The
      // refusal is exactly the moment the owner described — "if we're unable to
      // clear it" — so a super admin is offered the way through right here,
      // carrying the gate's own explanation into the confirmation. Every
      // condition gets this for free: every refusal on this screen lands here.
      if (completing && !body.adminOverride && canOverride(role)) {
        const extra = await askOverride((items.find((x) => x.id === itemId) || {}).label, { blocked: msg });
        if (!extra) { setErr(msg); return; }
        return patch(itemId, { ...body, ...extra });
      }
      setErr(msg);
      if (completing) {
        try { showMessage('Can’t clear this yet:\n\n' + msg); } catch (_) { /* no window */ }
      }
    }
  }
  // Any staffer may ASK an admin/super-admin to waive a condition (owner-directed
  // 2026-08-04). Prompts for the reason, files the request; approval (in the
  // Exceptions box) marks the condition waived.
  async function requestWaiver(it) {
    const reason = await askPrompt(
      `Ask an admin to waive this condition:\n\n“${(it && it.label) || 'condition'}”\n\n`
      + 'Why should it be waived? (an admin/super-admin will review; if approved, it is marked waived)');
    if (reason == null || !reason.trim()) return;
    try {
      const r = await api.requestConditionWaiver(id, it.id, { reasonNote: reason.trim() });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not send the request.');
      flash('Waiver requested — an admin will review it ✓');
      await load();
    } catch (e) {
      const emsg = (e && e.data && e.data.error) || (e && e.message) || 'Could not send the request.';
      setErr(emsg);
      try { showMessage(emsg); } catch (_) { /* no window */ }
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
    // Permanent delete — for a mistake-upload. Removes it for good (bytes + row)
    // and, crucially, keeps it out of SharePoint (a deleted doc was never needed).
    if (action === 'delete') {
      if (!(await askConfirm(`Permanently delete "${doc.filename || 'this document'}"?\n\nThis removes it for good and it will NOT be synced to SharePoint. Use this only for a document uploaded by mistake.`))) return;
      setBusyAct('review');
      try { await api.staffDeleteDoc(doc.id); flash('Document deleted for good.'); await load(); }
      catch (e) { setErr(e.message); }
      finally { setBusyAct(''); }
      return;
    }
    if (action === 'reject') {
      reason = await askPrompt('Why is this document being rejected? The borrower will see this and can upload a new version.');
      if (reason == null || !reason.trim()) return;
    }
    if (action === 'accept_more') {
      // Accept the PDF, keep the condition open, ask for one more document.
      const note = await askPrompt('This document is accepted ✓ — what ELSE is needed to satisfy the condition? The borrower sees this note.');
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
      let appraisal = null;
      // Did any of these actually land borrower-visible? null = the server did not
      // say, in which case claim NOTHING either way rather than guess.
      let borrowerVisible = null;
      for (let i = 0; i < files.length; i++) {
        const resp = await api.staffUploadAppDoc(id, {
          checklistItemId: tgt.itemId || undefined,
          llcId: tgt.llcId || undefined,
          // LLC document slots are single-doc per slot (formation/EIN/…), so an
          // LLC upload keeps the slot's own label rather than "Document N".
          slot: (tgt.replaceDocumentId || tgt.llcId) ? (tgt.slot || undefined)
            : slotBase != null ? `Document ${slotBase + i + 1}` : (tgt.slot || undefined),
          replaceDocumentId: tgt.replaceDocumentId || undefined,
          filename: files[i].name, contentType: files[i].type, dataBase64: await fileToBase64(files[i]),
        });
        if (resp && resp.appraisal) appraisal = resp.appraisal;   // XML dropped on the appraisal condition auto-built the findings
        // The server is the only thing that knows: visibility is derived from the
        // TARGET CONDITION's audience, not from anything this screen chose.
        const vis = resp && (resp.visibility || (resp.document && resp.document.visibility));
        // ALL, not ANY: "the borrower sees them too" must not be said when only
        // one of three landed borrower-visible.
        if (vis) borrowerVisible = (borrowerVisible === null ? true : borrowerVisible) && vis === 'borrower';
      }
      // An appraisal XML on the appraisal-documents condition builds the findings
      // right there — surface that and refresh the appraisal panel so the findings
      // show immediately (no separate re-import into the findings screen).
      if (appraisal && appraisal.ok) { setApprReload((n) => n + 1); flash('Appraisal imported ✓ — findings built from the XML.'); }
      else if (appraisal && !appraisal.ok) { flash(`Uploaded, but the appraisal XML did not import: ${appraisal.error || 'check it is the DATA file (XML)'}.`); }
      // "the borrower sees it too" was said UNCONDITIONALLY, including for a
      // document just stored staff_only (the upload endpoint decides visibility
      // from the target condition's audience). Wrong in the safe direction, but
      // it trains exactly the mental model that files a confidential document —
      // a purchase advice, say — against a borrower-facing condition. Only claim
      // it when the server actually says so.
      else {
        const many = files.length > 1;
        const tail = borrowerVisible === true ? (many ? ' — the borrower sees them too.' : ' — the borrower sees it too.')
          : borrowerVisible === false ? ' (staff only).' : '';
        flash(`${many ? `${files.length} files uploaded ✓` : 'Uploaded ✓'}${tail}`);
      }
      setUploadTarget(null); await load();
    } catch (e2) { setErr(e2.message || 'Upload failed'); }
    finally { setBusyAct(''); if (staffFileRef.current) staffFileRef.current.value = ''; }
  }
  const onStaffFile = (e) => uploadStaffFiles(e.target.files, uploadTarget);
  async function archiveApp() {
    const reason = await askPrompt('Archive this file? It leaves the pipeline and stops counting in the dashboard, but is kept in the Archived folder and can be restored anytime. Optional reason:');
    if (reason === null) return;
    try { await api.staffArchiveApp(id, reason || undefined); nav('/internal'); }
    catch (e) { setErr(e.message || 'Could not archive'); }
  }
  async function restoreApp() {
    try { await api.staffRestoreApp(id); await load(); flash('File restored ✓ — back in the pipeline.'); }
    catch (e) { setErr(e.message || 'Could not restore'); }
  }
  async function purgeApp() {
    const ok1 = await askConfirm('Delete this file PERMANENTLY? This removes the loan file and every document, condition and message under it, and it will disappear from all figures. This cannot be undone.');
    if (!ok1) return;
    const typed = await askPrompt('This is permanent. Type DELETE to confirm.');
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
        if (isAdmin && await askConfirm(`This file isn't ready for "${APP_STATUS_LABEL[status]}":\n\n${lines}\n\nOverride as admin and advance anyway?`)) {
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
    const title = cForm.title.trim();
    if (!title || busyAct) return;   // double-submit created the condition twice
    const reason = strayConditionReason(title);
    if (reason && !(await askConfirm(strayConfirmText(reason, title)))) return;
    setBusyAct('addcond');
    try {
      await api.staffAddLoanCondition(id, {
        title,
        borrowerTitle: cForm.audience !== 'staff' ? title : undefined,
        audience: cForm.audience, severity: cForm.severity,
        confirmStrayLabel: reason ? true : undefined,
      });
      setCForm({ title: '', audience: 'staff', severity: 'standard' }); flash('Condition added ✓'); await load();
    } catch (e) { setErr(e.message || 'Could not add condition'); }
    finally { setBusyAct(''); }
  }
  async function clearCond(cid) { if (busyAct) return; setBusyAct('cond:' + cid); try { await api.staffClearCondition(cid); flash('Cleared ✓'); await load(); } catch (e) { setErr(e.message); } finally { setBusyAct(''); } }
  async function waiveCond(cid) { if (busyAct) return; const r = await askPrompt('Waive this condition — reason (required):'); if (!r) return; setBusyAct('cond:' + cid); try { await api.staffWaiveCondition(cid, r); flash('Waived ✓'); await load(); } catch (e) { setErr(e.message); } finally { setBusyAct(''); } }
  // Super-admin override on an underwriting condition — the same act, the same
  // words and the same permanent record as on the conditions list above, so
  // "override" means one thing on this screen (owner-directed 2026-07-27).
  async function overrideCond(cid, title) {
    if (busyAct) return;
    const x = await askOverride(title);
    if (!x) return;
    setBusyAct('cond:' + cid);
    try { await api.staffClearCondition(cid, x); flash('Cleared by override ✓ — recorded on the file'); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusyAct(''); }
  }
  async function reviewCond(cid, reviewed) { if (busyAct) return; setBusyAct('cond:' + cid); try { await api.staffReviewCondition(cid, reviewed); flash(reviewed ? 'Marked reviewed ✓' : 'Review cleared'); await load(); } catch (e) { setErr(e.message); } finally { setBusyAct(''); } }
  async function addCondition() {
    const label = newCond.trim();
    if (!label) return;
    const reason = strayConditionReason(label);
    if (reason && !(await askConfirm(strayConfirmText(reason, label)))) return;
    try { await api.staffAddCondition(id, { label, audience: 'staff', confirmStrayLabel: reason ? true : undefined }); setNewCond(''); flash('Added ✓'); await load(); }
    catch (e) { setErr(e.message || 'Failed'); }
  }

  // Role-aware defaults + per-user persistence (owner-directed 2026-07-16): the
  // internal CHECKLIST now defaults to "Open for me" like the other sections —
  // an LO's Done (and a processor's sign-off) clears the item off their default
  // view; the picker (persisted per user) re-shows everything, collapsed.
  // The Conditions section is now ONE tabbed hub (Borrower · Underwriting ·
  // Internal · LLC) instead of four separate sections. A "Go fix →" link can flip
  // straight to the right tab via the section bus.
  const [condTabRaw, setCondTab] = useStickyFilter('condTab', 'borrower');
  useEffect(() => subscribeConditionsTab(setCondTab), []);   // eslint-disable-line react-hooks/exhaustive-deps
  // 'internal' was the staff-conditions + checklist tab. Those conditions are in
  // the one list now and the checklist is off the file, so that tab no longer
  // exists — but two things can still ASK for it: a sticky value saved by
  // someone who was last on it, and the server's condTabForBlocker(), which
  // returns 'internal' for any staff-audience blocker behind a "Go fix →".
  // Normalising on READ covers both without touching the server, and without a
  // migration for a value living in people's browsers. Landing on a tab that
  // renders nothing is exactly the dead-deep-link class Phase 1 fixed.
  const condTab = condTabRaw === 'internal' ? 'borrower' : condTabRaw;
  // Conversations + Activity + Email Center are one "Communication" hub (tabs).
  const [commTab, setCommTab] = useStickyFilter('commTab', 'messages');
  /* Where the reader was in each tab of the two hubs. A panel shorter than the
     window leaves the page nothing to scroll, so holding the tab strip is not
     enough on its own — coming BACK to a tab is what has to put them back
     (owner-reported 2026-08-02). Deliberately NOT persisted: a scroll offset only
     means anything against the page you were just looking at. */
  const condTabY = useRef({});
  const commTabY = useRef({});

  /* ===== SEVEN ROOMS (Phase 1 — docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md) =====
     The 17 sections regroup into 7 rooms and ONE room renders at a time; the
     other rooms' sections are not on the page at all (the ~27-screen scroll is
     gone structurally). Every section moves WHOLE — ids, labels, badges,
     summaries, collapse behavior and full-screen are byte-identical inside a
     room. "Full file (classic view)" (persisted per user) renders today's page
     exactly — the rooms code stands aside entirely, incl. the jump resolver. */
  const [fileViewPref, setFileViewPref] = useStickyFilter('fileView', 'rooms');
  const classic = fileViewPref === 'classic';
  // Start in the room the reader was last in ON THIS FILE, so a browser REFRESH
  // lands them back where they were working — not on Overview (owner-reported).
  // Per-file (readStation keys on the id), so opening a DIFFERENT file never
  // inherits this file's room — the guarantee the old hard `st-overview` reset
  // was there to give (audit 2026-08-02 #3). A file never opened before, or a
  // fresh tab, has nothing stored and still starts on Overview.
  const [activeStation, setActiveStation] = useState(() => readStation(id) || 'st-overview');
  useEffect(() => { setActiveStation(readStation(id) || 'st-overview'); pendingRevealRef.current = null; }, [id]);
  const activeStationRef = useRef(activeStation); activeStationRef.current = activeStation;
  const pendingRevealRef = useRef(null);
  // Keep the reader's place saved as they scroll (room + the section they're
  // reading), so a refresh restores it (see the landing effect below). Debounced
  // to ~300ms after scrolling STOPS — one sessionStorage write per scroll burst,
  // never per frame. A pure courtesy: it never throws and does nothing in classic
  // view (no rooms to restore there).
  useEffect(() => {
    if (classic) return undefined;
    let t = null;
    const onScroll = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        savePlace(idRef.current, { station: activeStationRef.current, section: nearestFileSectionId() || '' });
      }, 300);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (t) clearTimeout(t); };
    // Re-arm on file change too, so a pending save from the previous file's
    // scroll can't fire against the new one.
  }, [classic, id]);
  // Permission-gated rooms vanish exactly as their sections do today; a deep
  // link into a hidden room stays a silent no-op (parity with today).
  const stationEnabled = useCallback((stId) => {
    // Send to investor is open to anyone on the file: it now carries the TPR and
    // MISMO exports as well as the data tape, and only the TAPE needs the
    // export_data_tapes permission (gated inside the section, 2026-08-02).
    if (stId === 'st-delivery') return true;
    if (stId === 'st-draws') return can('manage_draws') || can('view_draws');
    return STATIONS.some((s) => s.id === stId);
  }, [can]);
  // The ONE executor for a queued jump — runs after the target's room has
  // mounted (flush effect below), or immediately for a same-room jump whose
  // target section is merely collapsed.
  const runReveal = useCallback((t) => {
    if (!t) return;
    if (t.kind === 'section') {
      requestOpenSection(t.id);
      if (t.tab) requestConditionsTab(t.tab);
      // A jump at a RETIRED section id (sec-encompass) resolves to the section
      // that took its content PLUS the tab holding it — open the tab first, so
      // the scroll lands on the thing the link was actually pointing at.
      if (t.appTab) requestAppDetailTab(t.appTab);
      setTimeout(() => {
        const el = document.getElementById(t.id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    } else if (t.kind === 'anchor') {
      const owner = ANCHOR_SECTION[t.id];
      if (owner) requestOpenSection(owner);
      if (t.id === 'conversations') setCommTab('messages');
      setTimeout(() => {
        const el = document.getElementById(t.id) || (owner ? document.getElementById(owner) : null);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: t.block || 'start' });
      }, owner ? 400 : 60);
    } else if (t.kind === 'action' && t.action === 'open-studio') {
      // Cross-room "Open the studio": ProductStudioPanel mounts only while
      // sec-pricing is open, and its imperative ref lands a beat later — poll
      // briefly, then degrade to today's scroll-to-the-section fallback.
      requestOpenSection('sec-pricing');
      let tries = 0;
      const poll = () => {
        if (studioRef.current) { studioRef.current.openStudio(); return; }
        if (++tries < 60) requestAnimationFrame(poll);
        else { const el = document.getElementById('sec-pricing'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      };
      setTimeout(poll, 120);
    }
  }, [setCommTab]);
  // The E-sign Send button calls this to FINALIZE the term sheet (owner-directed
  // 2026-08-04). The studio (ProductStudioPanel) mounts only while sec-pricing is
  // open and its imperative ref lands a beat later — so open the section, poll for
  // the ref, then drive its finalizeTermSheet(). Degrades to a clear message if the
  // studio never mounts. Returns a { ok, reason } promise the caller shows/acts on.
  const finalizeTermSheetBridge = useCallback(() => new Promise((resolve) => {
    requestOpenSection('sec-pricing');
    let tries = 0;
    const poll = () => {
      const ref = studioRef.current;
      if (ref && typeof ref.finalizeTermSheet === 'function') {
        Promise.resolve(ref.finalizeTermSheet())
          .then((r) => resolve(r || { ok: false, reason: 'Could not finalize the term sheet.' }))
          .catch((e) => resolve({ ok: false, reason: (e && e.message) || 'Could not finalize the term sheet.' }));
        return;
      }
      if (++tries < 120) { setTimeout(poll, 50); return; }
      resolve({ ok: false, reason: 'Open Products & Pricing and re-register to attach the final term sheet.' });
    };
    setTimeout(poll, 120);
  }), []);
  // Flush a queued jump once the newly-active room's sections have mounted.
  useEffect(() => {
    const t = pendingRevealRef.current;
    if (!t) return undefined;
    // Consume INSIDE the timer — never eagerly. load() commits several state
    // updates in a row right when a landing queues its reveal, and each commit
    // re-runs this effect; consuming eagerly + clearing the timer in cleanup
    // silently swallowed the jump (audit 2026-08-02 #1, MAJOR). Left queued, a
    // cancelled timer is simply re-scheduled by the re-run.
    const timer = setTimeout(() => { pendingRevealRef.current = null; runReveal(t); }, 120);
    return () => clearTimeout(timer);
  }, [activeStation, runReveal]);
  // Register the jump resolver (goToSection/revealAnchor consult it first).
  // Registered in an effect WITH CLEANUP so the borrower screen / Draw Center —
  // which share FileSections — can never be hijacked by an unmounted file
  // screen; ids outside the map (and hidden rooms) decline to today's behavior.
  useEffect(() => {
    if (classic) return undefined;
    return setSectionResolver((t) => {
      // A RETIRED section id is rewritten to where its content lives now (plus
      // the tab holding it) BEFORE anything else looks at it — the default path
      // below would call getElementById on an id that no longer renders and
      // silently do nothing, which is a dead link, not a fallback.
      const moved = t.kind === 'section' ? resolveSection(t.id) : null;
      const target = moved && moved.moved ? { ...t, id: moved.id, appTab: moved.appTab } : t;
      const st = stationOf(target.id);
      if (!st || !stationEnabled(st)) return false;
      if (st === activeStationRef.current) {
        // Right room already — but the target section may be collapsed
        // (unmounted). Take over only for the anchor/tab work goToSection's
        // default path already handles… it does, so decline. The one caller
        // that needs more (open-studio) queues an action explicitly.
        // A retired id is the exception: there is nothing at its address for
        // that default path to open or scroll to, so run the rewritten jump here.
        if (target === t) return false;
        runReveal(target);
        return true;
      }
      pendingRevealRef.current = target;
      setActiveStation(st);
      writeStation(idRef.current, st);   // remember the room for a refresh
      return true;
    });
  }, [classic, stationEnabled, runReveal]);
  // A rail click: switch rooms and start at the top of the new room.
  const goStation = useCallback((stId) => {
    writeStation(idRef.current, stId);   // remember the room (and clear the section) for a refresh
    if (stId === activeStationRef.current) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    pendingRevealRef.current = null;
    setActiveStation(stId);
    window.scrollTo({ top: 0 });
  }, []);
  // "Open the studio" from a condition row — works from ANY room (red-team R2):
  // ref alive → straight in; otherwise hop to The Deal (or just open the
  // section when already there / in classic view) and invoke once mounted.
  const openStudioAnywhere = useCallback(() => {
    if (studioRef.current) { studioRef.current.openStudio(); return; }
    const t = { kind: 'action', action: 'open-studio' };
    if (!classic && activeStationRef.current !== 'st-deal') {
      pendingRevealRef.current = t;
      setActiveStation('st-deal');
      writeStation(idRef.current, 'st-deal');   // remember the room for a refresh
      return;
    }
    runReveal(t);
  }, [classic, runReveal]);
  /* ===== end Seven Rooms machinery (render wiring further down) ===== */
  // "Application details" is ONE tabbed sub-hub too (owner-directed 2026-07-31:
  // "split in between 100 places… clean up the view"): Deal & property ·
  // Missing info · Pipeline data. Plain local useState (not sticky) — the deal
  // editor is the right first thing every time the section is opened.
  const [appDetailTab, setAppDetailTab] = useState('deal');
  // A completeness pill for a field only the Borrower profile can edit asks for
  // that tab (they are two tabs of THIS section, so nothing has to navigate).
  useEffect(() => subscribeAppDetailTab(setAppDetailTab), []);
  // ONE "off my plate" rule for every surface — see roleDone() above.
  // The internal checklist shows ONLY staff-facing work items — the borrower's
  // conditions (audience borrower/both) already live in "Conditions to close",
  // so they must not be listed twice.
  //
  // A CHECKLIST IS NOT A CONDITION (owner-directed 2026-07-27: "the checklist
  // should not be mixed up with the conditions"). Every row already carries the
  // distinction in `item_kind`; the split here used to draw the line in the
  // wrong place — "conditions" meant `document` and "checklist" meant EVERYTHING
  // ELSE, which swept the 12 staff `condition` rows into the checklist alongside
  // the 24 real tasks. That is most of why the checklist never felt right.
  //
  // The correct line, and it needs no new data:
  //   document + condition -> a CONDITION. Something must be satisfied and cleared.
  //   task                 -> the CHECKLIST. Staff work steps, phase by phase.
  //
  // This also has to happen BEFORE the checklist comes off the screen, not
  // after: three of the file's four clear-to-close gates (rtl_p4_ts,
  // rtl_f_review, rtl_f_ctc) are staff `condition` rows sitting in the
  // checklist right now — verified against the seeded templates, where no
  // `task` is a gate. Hiding the checklist first would take the gates with it.
  // internalItems / phases / itemFilter / bucketOf / internalConds / condOffPlate
  // all went with the checklist panel above — every one of them existed only to
  // render it. The staff CONDITIONS they used to sit beside are in the one list
  // (BorrowerConditions filters items itself), and the tasks are worked from
  // "My tasks". Left in place they would be dead code that still costs a render.

  if (err && !app) return <div role="alert" className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;
  const processors = team.filter(m => m.role === 'processor');
  const officers = team.filter(m => ['loan_officer', 'admin', 'super_admin'].includes(m.role));
  const uwName = (team.find(m => m.id === app.underwriter_id) || {}).full_name;
  // Headline the file with the property's one-line address (incl. zip) so it's
  // instantly obvious which property this file is — with a graceful fallback.
  const propAddress = addrLine(app.property_address);

  const borrowerItems = items.filter(it => it.audience === 'borrower' || it.audience === 'both');
  const nCondOpen = borrowerItems.filter(it => !it.signed_off_at && it.status !== 'satisfied').length;
  // The rail is grouped into a few labeled sets and — critically — listed in the
  // SAME order the sections actually render down the page, so clicking a rail item
  // and then scrolling never feels out of sync (they used to disagree). Each entry
  // carries a `group`; FileSections prints a quiet header when the group changes.
  // The Closing section shows for closers/admins always, and for the file's
  // officer once the file has a closer or is at/after clear-to-close.
  const showClosing = can('manage_closings') || !!app.closer_id || ['clear_to_close', 'funded'].includes(app.status);
  /* ONE badge computation for the whole file.
     The navigation rail and the section headers used to work these out SEPARATELY,
     and had already drifted: the rail showed "✓" where the header said
     "Registered ✓"; the appraisal rail counted ONLY fatals while the header walked
     a fatal → warning → reviewed ladder; and the document-review rail ADDED the
     note-buyer fatals onto the document fatals into one number, while the header
     deliberately reports them separately (two re-audits on 2026-07-27 hardened that
     ladder so a green tick could never sit over a red or amber card — the rail's
     crude sum quietly bypassed both fixes).
     Each badge is now derived ONCE here and rendered in two lengths: `short` for the
     narrow rail, `long` for the roomy section header. They can differ in wording;
     they can no longer differ in fact. */
  /* THE PAYOFF SECTION exists only where there is a loan to pay off, and its
     header says at a glance whether the three things a payoff needs are on the
     file. Both answers come from the shared mirror of the server's payoff model
     (lib/payoff.js), so the header can never contradict the card inside it. */
  const isRefiFile = payoffApplies(app.loan_type);
  const payoffMissing = isRefiFile ? payoffMissingKeys(app) : [];
  const payoffBadge = { short: payoffMissing.length ? `${payoffMissing.length} ⚠` : '✓',
    long: payoffMissing.length ? `${payoffMissing.length} to fill in` : 'Complete ✓' };
  const badges = {
    pricing: { short: app.registered_program ? '✓' : '', long: app.registered_program ? 'Registered ✓' : 'Not registered' },
    appraisal: (() => {
      if (!apprSummary) return { short: '', long: '' };
      if (apprSummary.fatal) return { short: `${apprSummary.fatal} ⚠`, long: severityCount(apprSummary.fatal, 'fatal') };
      if (apprSummary.warning) return { short: `${apprSummary.warning}`, long: `${apprSummary.warning} warning` };
      return { short: '✓', long: 'Reviewed ✓' };
    })(),
    underwriting: (() => {
      if (!uwSummary) return { short: '', long: '' };
      const g = uwSummary.guideline || {};
      if (uwSummary.fatal) return { short: `${uwSummary.fatal} ⚠`, long: severityCount(uwSummary.fatal, 'fatal') };
      // A note-buyer dealbreaker is not clear-to-close work, so it is counted
      // separately — but it must never let this badge read "Reviewed ✓" over a red
      // fatal card (re-audit 2026-07-27).
      if (g.fatal) return { short: `${g.fatal} ⚠`, long: `${g.fatal} note-buyer` };
      if (uwSummary.warning) return { short: `${uwSummary.warning}`, long: `${uwSummary.warning} warning` };
      // A guideline WARNING is milder than a dealbreaker but still an open item —
      // falling through to the green tick here put a checkmark over an amber card
      // (re-audit 2026-07-27).
      if (g.warning) return { short: `${g.warning}`, long: `${g.warning} note-buyer` };
      return { short: '✓', long: 'Reviewed ✓' };
    })(),
    documents: { short: docs.length || '', long: docs.length ? `${docs.length} files` : '' },
  };
  /* ONE PLAIN LINE PER SHUT SECTION (blueprint Move 3, "make every closed
     section worth judging"). Fourteen collapsed headers down the page tell you
     nothing about which is worth opening; a badge gives a number without saying
     what it counts. These say it in words.

     BUILT ONLY FROM WHAT THE PAGE ALREADY HAS. `items`, `docs`, `gating` and
     `app` come from this screen's own load, so a line is right the moment the
     file renders. `apprSummary` / `uwSummary` deliberately are NOT used here:
     they are reported up by panels that live INSIDE those sections, and a
     collapsed Section unmounts its children — so while the section is shut (the
     only time a summary shows) those values are always null. A section with
     nothing truthful to say gets no line at all, which beats a guess.

     What the file's own outstanding list says about a section is honest for all
     of them, though: the server already stamps every blocker with the section
     that fixes it, so any section can say how much of the file's open work
     lands on it. Advisories are excluded — PILOT's notes are never outstanding
     work (owner-directed 2026-07-27) — and counted separately in words. */
  const needsBySection = {};
  const notesBySection = {};
  if (gating) {
    const g = gating.clear_to_close || {};
    for (const r of [...(g.conditions || []), ...(g.gates || [])]) {
      if (r.section) needsBySection[r.section] = (needsBySection[r.section] || 0) + 1;
    }
    for (const r of (g.advisories || [])) {
      if (r.section) notesBySection[r.section] = (notesBySection[r.section] || 0) + 1;
    }
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  /* Join the parts that actually have something to say. */
  const line = (...parts) => {
    const kept = parts.filter(Boolean);
    return kept.length ? kept.join(' · ') : null;
  };
  /* The shared tail every section can carry: what the file's outstanding list
     puts here, and what PILOT has flagged here. */
  const openHere = (secId) => {
    const n = needsBySection[secId] || 0;
    const notes = notesBySection[secId] || 0;
    return [n ? `${plural(n, 'item')} still open here` : null,
      notes ? `${plural(notes, 'PILOT note')} to read` : null];
  };
  /* WHAT CAME BACK ON EACH ORDER AND STILL NEEDS A HUMAN. Per order type now that
     each is its own section — a badge on "Title" must count title returns, not the
     whole desk's. The room badge is still the sum, so the rail reads the same
     total it always did. A returned document with no slot_label is one nobody has
     said what it IS yet, which is the work. */
  const nReturnsToAssign = (kind) => docs.filter(d =>
    d.doc_kind === `${kind}_order_return` && !d.slot_label && d.is_current !== false).length;
  const nTitleToAssign = nReturnsToAssign('title');
  const nInsToAssign = nReturnsToAssign('insurance');
  const nOrdersToAssign = nTitleToAssign + nInsToAssign;
  // The attorney chain needs no classification (closing-inbox files its documents
  // on no condition and no slot), so its section counts what ARRIVED instead.
  const nClosingDocs = docs.filter(d => d.doc_kind === 'closing_correspondence' && d.is_current !== false).length;
  const summaries = {
    /* THE PAYOFF — a refinance-only section, so both of these are computed from
       the file's own row through the shared mirror in lib/payoff.js (pinned
       against the server's model by test-payoff-model-pure.js). The card itself
       asks the server for everything richer. */
    'sec-payoff': line(
      payoffMissing.length
        ? (payoffMissing.length === 1 ? '1 detail to fill in' : `${payoffMissing.length} details to fill in`)
        : 'Payoff details are complete',
      ...openHere('sec-payoff')),
    'sec-pricing': line(
      app.registered_program
        ? `Registered: ${app.registered_product_label || (app.registered_program === 'gold' ? 'Gold Standard Program' : app.registered_program === 'silver' ? 'Silver Program' : app.registered_program === 'manual' ? 'Manual Program' : 'Standard Program')}`
        : 'No product registered yet',
      ...openHere('sec-pricing')),
    'sec-appraisal': line(...openHere('sec-appraisal')),
    'sec-underwriting': line(...openHere('sec-underwriting')),
    'sec-conditions': (() => {
      const open = borrowerItems.filter(it => !it.signed_off_at && it.status !== 'satisfied');
      if (!items.length) return null;
      if (!open.length) return line(`All ${plural(borrowerItems.length, 'borrower condition')} cleared`, ...openHere('sec-conditions'));
      return line(
        `${open.length} of ${borrowerItems.length} still open`,
        open.filter(it => it.status === 'received').length
          ? `${open.filter(it => it.status === 'received').length} waiting on you to review` : null,
        open.filter(it => it.status === 'issue').length
          ? `${open.filter(it => it.status === 'issue').length} sent back to the borrower` : null,
        notesBySection['sec-conditions'] ? `${plural(notesBySection['sec-conditions'], 'PILOT note')} to read` : null);
    })(),
    'sec-closing': line(
      app.status === 'funded' ? 'Funded' : app.closer_id ? 'Closer assigned' : 'No closer assigned yet',
      ...openHere('sec-closing')),
    'sec-esign': line(...openHere('sec-esign')),
    'sec-order-title': line(nTitleToAssign ? `${plural(nTitleToAssign, 'return')} to assign` : 'Nothing waiting to be assigned'),
    'sec-order-insurance': line(nInsToAssign ? `${plural(nInsToAssign, 'return')} to assign` : 'Nothing waiting to be assigned'),
    'sec-order-appraisal': line('Order the appraisal directly from the AMC'),
    'sec-order-closing': line(nClosingDocs ? `${plural(nClosingDocs, 'document')} on the closing chain` : 'Nothing on the closing chain yet'),
    // The header badge already carries the file COUNT, so the line must not
    // repeat it — a summary that echoes the badge is noise. It speaks only when
    // it has something the count cannot say.
    'sec-documents': (() => {
      if (!docs.length) return 'No documents on this file yet';
      const rejected = docs.filter(d => d.review_status === 'rejected' && d.is_current !== false).length;
      return rejected ? `${plural(rejected, 'file')} rejected — the borrower needs to send a replacement` : null;
    })(),
  };
  const SECTIONS = [
    { id: 'sec-overview', label: 'File overview', group: 'Overview' },
    { id: 'sec-application', label: 'Application details', group: 'Application & pricing' },
    // Refinance only — a purchase has no loan to pay off, so the rail does not
    // carry a section that would only ever say so.
    ...(isRefiFile ? [{ id: 'sec-payoff', label: 'Payoff', group: 'Application & pricing', badge: payoffBadge.short }] : []),
    { id: 'sec-pricing', label: 'Structure & pricing', group: 'Application & pricing', badge: badges.pricing.short },
    // Exceptions sits directly under pricing (most exceptions are pricing
    // exceptions). Encompass sync is NOT a section — it is a tab of Application
    // details, beside the ClickUp comparison it belongs with (owner-directed
    // 2026-08-03: "it should not be a separate section in the deal"). Listing it
    // here would put a second door to one screen in the rail.
    { id: 'sec-exceptions', label: 'Exceptions', group: 'Application & pricing' },
    /* REVIEW & CONDITIONS, in the owner's order (2026-08-02): conditions, track
       record, appraisal and findings, document review, documents. This array is
       what the RAIL reads, so it has to move in lock-step with the JSX order
       below and with lib/stations.js — see the note at the top of that file.
       One shared `group` keeps the classic view's group headers contiguous. */
    { id: 'sec-conditions', label: 'Conditions', group: 'Review & conditions', badge: nCondOpen || '' },
    { id: 'sec-track', label: 'Track record', group: 'Review & conditions' },
    { id: 'sec-appraisal', label: 'Appraisal & findings', group: 'Review & conditions', badge: badges.appraisal.short },
    { id: 'sec-underwriting', label: 'Document review', group: 'Review & conditions', badge: badges.underwriting.short },
    // "& exports" is gone with the exports themselves (owner-directed 2026-08-02:
    // "that section should just be called Documents").
    { id: 'sec-documents', label: 'Documents', group: 'Review & conditions', badge: badges.documents.short },
    /* THE THREE ORDERS ARE THREE SECTIONS (owner-directed 2026-08-03), which is
       what puts them in the rail under Orders — the spoke list only renders for a
       room with more than one section, so the single combined section showed
       nothing at all beneath "Orders". Each carries the same count its own summary
       line uses, derived once above so the rail and the header cannot drift. */
    { id: 'sec-order-title', label: 'Title', group: 'Orders',
      badge: nTitleToAssign ? `${nTitleToAssign} to assign` : '' },
    { id: 'sec-order-insurance', label: 'Insurance', group: 'Orders',
      badge: nInsToAssign ? `${nInsToAssign} to assign` : '' },
    { id: 'sec-order-appraisal', label: 'Appraisal', group: 'Orders', badge: '' },
    { id: 'sec-order-closing', label: 'Attorney closing prep', group: 'Orders', badge: '' },
    // E-signatures BEFORE closing (owner-directed 2026-08-02).
    { id: 'sec-esign', label: 'E-signatures', group: 'Signing & closing' },
    // Closing — the closer's desk. Shown to closers/admins always, and to the
    // file's officer once the file is heading to (or is at) closing so they have
    // their own closing view. The panel gates closer-only actions internally.
    ...(showClosing ? [{ id: 'sec-closing', label: 'Closing', group: 'Signing & closing', badge: app.status === 'funded' ? '' : (app.closer_id ? 'active' : '') }] : []),
    // Send to investor holds the TPR + MISMO exports (open to anyone on the file)
    // AND the capital-provider data tape, which keeps its own permission gate
    // inside the section — see the note on the section itself.
    { id: 'sec-tapes', label: 'Send to investor', group: 'Send to investor' },
    // Task management (owner-directed 2026-08-18): the file's scheduled tasks +
    // reminders as a standing section, beside the communication they fire through.
    { id: 'sec-tasks', label: 'Tasks & reminders', group: 'Communication' },
    // The Drafting desk (owner-directed 2026-08-18): AI drafts emails from the
    // file, copy-paste only — no send exists on this path.
    { id: 'sec-drafting', label: 'Drafting', group: 'Communication' },
    { id: 'sec-messages', label: 'Communication & history', group: 'Communication' },
    // Construction draws is the LAST phase (post-funding), so it's the LAST section.
    // Shown for anyone who manages draws — funded or not — so the Draw Center is
    // always findable here (it just says "opens after funding" before funding).
    ...((can('manage_draws') || can('view_draws')) ? [{ id: 'sec-draws', label: 'Construction draws', group: 'Construction draws', badge: app.status === 'funded' ? '' : 'soon' }] : []),
  ];

  // Seven Rooms render wiring. `show` decides whether a section renders (its
  // room is on screen, or classic view shows everything); the room badges roll
  // up ONLY from page-level sources — the server-stamped gating counts and the
  // queue counts. The appraisal/underwriting summary ladders are reported up by
  // panels that mount on first visit, so they are after-visit enrichment and
  // never a roll-up source (a never-visited room must still show its work —
  // red-team R3 in docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md).
  const show = (sid) => classic || STATION_OF[sid] === activeStation;
  const stationNeeds = (ids) => ids.reduce((n, sid) => n + (needsBySection[sid] || 0), 0);
  const STATION_DEFS = STATIONS
    .filter((st) => stationEnabled(st.id))
    .map((st) => {
      let badge = stationNeeds(st.sections);
      if (st.id === 'st-deal' && isRefiFile) badge += payoffMissing.length;
      // Follows sec-orders into its own room (2026-08-02) — a badge left on the
      // room the section came FROM points at work that is no longer there.
      if (st.id === 'st-orders') badge += nOrdersToAssign;
      // Open conditions vs the gating rows for the same sections overlap —
      // take the larger, never the sum (no double counting).
      if (st.id === 'st-review') badge = Math.max(badge, nCondOpen);
      return { id: st.id, label: st.label, badge: badge || '' };
    });
  const railFooter = (
    <div className="file-nav-foot">
      <button type="button" className="btn link small" style={{ color: '#4B585C' }}
        title={classic
          ? 'Back to the seven-room view'
          : 'Show the whole file on one page, exactly as before — for printing, QC, and Ctrl-F across everything'}
        onClick={() => setFileViewPref(classic ? 'rooms' : 'classic')}>
        {classic ? '← Back to the room view' : 'Full file (classic view)'}
      </button>
      {!classic && (
        <details className="file-nav-help">
          <summary>Where did everything go?</summary>
          <ul>
            {whereDidItGo(SECTIONS).map((r) => (
              <li key={r.old}><span>{r.old}</span> → <b>{r.now}</b></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  /* STATUS & CLOSING — ONE definition, rendered in BOTH places (owner-directed
     2026-08-02: it belongs under Application details, and "may stay on the
     overview too").

     It is a plain element built once and rendered twice rather than a second
     copy of the markup, so the two can never drift — the trap the borrower
     editor fell into. Safe to render twice because sec-overview and
     sec-application live in DIFFERENT ROOMS: only one of them is ever on screen,
     so nobody sees two identical status panels at once. */
  const statusClosingBlock = (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <b>Status &amp; closing</b>
            {gating && (() => {
              const g = gating.clear_to_close || {};
              const n = (g.conditions ? g.conditions.length : 0) + (g.gates ? g.gates.length : 0);
              const jump = () => revealAnchor('ctc-outstanding');
              return g.ready
                ? <button type="button" className="ts-badge ok" style={{ cursor: 'pointer' }} onClick={jump} title="All prior-to-docs conditions cleared and gates satisfied — view the checklist">Clear-to-close ready</button>
                : <button type="button" className="ts-badge warn" style={{ cursor: 'pointer' }} onClick={jump}
                    title={[...(g.conditions || []).map(c => c.title), ...(g.gates || []).map(x => x.title || x.label)].join(' · ')}>{n} to clear before CTC — see what’s left →</button>;
            })()}
            <div className="spacer" />
            {/* The ClickUp controls moved to their own tab under Application
                details, alongside the field-by-field comparison — this is the way
                in, so the toggle that used to hide them here is retired. */}
            <button type="button" className="btn link small"
              onClick={() => { setAppDetailTab('pipeline'); goToSection('sec-application'); }}
              title="The ClickUp card: the link, re-sync, and a field-by-field comparison of what PILOT holds against what the card holds">
              ClickUp Sync →
            </button>
          </div>

          {/* The workflow moves the status automatically now (owner-directed
              2026-07-21) — the team uses the Submit buttons above, not this
              dropdown. Only a super-admin keeps a manual override. Everyone else
              sees the status read-only. */}
          {role === 'super_admin' ? (
          <div className="grid cols-2" style={{ gap: 16 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Borrower-facing status <span className="muted small">(super-admin override)</span></label>
              <select className="input" value={app.status} onChange={e => changeStatus(e.target.value)}>
                {APP_STATUSES.map(s => <option key={s} value={s}>{APP_STATUS_LABEL[s]}</option>)}
              </select>
              <div className="hint" style={{ marginTop: 6 }}>Manual override — normally the Submit buttons move this. Advancing notifies the borrower &amp; assigned team.</div>
            </div>
            {/* The internal status renders UNCONDITIONALLY (it used to hide with
                the pipeline toggle; the retired right aside was then its only
                always-visible surface — red-team minor, Seven Rooms Phase 1). */}
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Internal status (ClickUp) <span className="muted small">(override)</span></label>
              <select className="input" value={app.internal_status || ''}
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
              <div className="hint" style={{ marginTop: 6 }}>Pushes the exact status to ClickUp; borrower status is re-derived.</div>
            </div>
          </div>
          ) : (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Status</label>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className={`pill ${app.status}`}>{APP_STATUS_LABEL[app.status] || app.status}</span>
                {app.internal_status && <span className="muted small">ClickUp: {app.internal_status}</span>}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>The status moves on its own when you use the Submit buttons above — you don’t set it by hand.</div>
            </div>
          )}

          <div className="grid cols-2" style={{ gap: 16, marginTop: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Expected closing</label>
              <ClosingDateField value={app.expected_closing} onSave={v => setClosing('expectedClosing', v)} />
              <div className="hint" style={{ marginTop: 6 }}>Setting an expected date notifies the borrower.</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Actual closing</label>
              <ClosingDateField value={app.actual_closing} onSave={v => setClosing('actualClosing', v)} />
            </div>
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick={() => setChatOpen(true)}><IconMessage />Message</button>
            <button className="btn ghost" onClick={() => setRemindOpen(true)} title="Schedule a reminder or task — pick a date/time, who's included, and what it says"><IconBell />Remind</button>
            <div className="spacer" />
            <button className="btn primary" onClick={inviteBorrower} disabled={inviteBusy}
              title="Email the borrower an invite to join this file in PILOT">
              {inviteBusy ? 'Sending…' : 'Invite borrower'}
            </button>
          </div>
        </div>
  );

  return (
    <>
      {/* The file overview at a glance — the left-edge slide-over (owner-directed
          2026-08-18), on every file screen; this is the INTERNAL audience. */}
      <FileOverviewSlideOver key={id} fetcher={() => api.staffFileOverview(id)} />
      {/* The file's identity bar STAYS while you scroll — borrower, address,
          loan number and status pin under the app header; only the sections
          below (and the rail beside them) move. */}
      <div className="file-top">
        <Link to="/internal" className="btn link" style={{ flex: 'none' }}>← Pipeline</Link>
        <div className="file-top-main">
          <h1 className="file-top-addr">{app.first_name} {app.last_name}{app.co_borrower_id ? ` & ${app.co_first_name || ''} ${app.co_last_name || ''}`.trimEnd() : ''} · {propAddress === '—' ? 'Address pending' : propAddress}</h1>
          <span className="muted small">{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}{app.loan_amount != null ? <> · <b style={{ color: '#141B22' }}>{money(app.loan_amount)}</b></> : null}</span>
        </div>
        {/* BORROWER VIEW (owner-directed 2026-07-26) — step into this
            borrower's portal straight from their file, landing on THIS loan, so
            you can walk them through a condition while looking at their screen. */}
        <BorrowerViewButton applicationId={id} borrowerId={app.borrower_id}
          borrowerName={fullNameOf(app)} />
        {canDelete && (app.deleted_at
          ? <span className="row" style={{ gap: 8, flex: 'none' }}>
              <span className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold-ink)' }} title="This file is archived">Archived</span>
              <button className="btn link small" onClick={restoreApp} title="Restore this file to the pipeline">Restore</button>
              <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} onClick={purgeApp} title="Delete permanently — cannot be undone">Delete permanently</button>
            </span>
          : <button className="btn link small" style={{ color: 'var(--danger,#e06666)', flex: 'none' }} onClick={archiveApp} title="Archive this file (reversible; leaves the dashboard figures)">Archive file</button>
        )}
        <span className={`pill ${app.status}`} style={{ flex: 'none' }}>{APP_STATUS_LABEL[app.status] || app.status}</span>
      </div>

      {esignMsg && <div className={`notice ${esignMsg.tone}`} role="status">{esignMsg.text}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {err && app && <div role="alert" className="notice err">{err}</div>}

      {/* The stage dots ride the top of the page in EVERY room (moved out of
          the Overview section — Seven Rooms Phase 1), so "where does this deal
          stand" never needs a room switch: every room switch starts at the top,
          where this is. */}
      <LoanProgress status={app.status} />

      {/* The work list used to ALSO render here, above the room nav, duplicating
          the Overview's clear-to-close list with a different slice of the same
          payload. Owner-directed 2026-08-02: one list, inside the Overview
          (WhatsLeftPanel, in sec-overview) — the top of the file stays clean. */}

      {/* The super-admin structural UNLOCK must be reachable WITHOUT hunting.
          It used to live inside "Application details", which starts collapsed —
          and a collapsed Section renders none of its children (FileSections.jsx),
          so on a locked (clear-to-close / funded) file the 🔓 button was simply
          absent from the page until you happened to expand that one section
          (owner-reported 2026-07-27: "the unlock button disappeared"). It now
          sits here, above the sixteen sections, so a locked file always shows its
          lock state and the Unlock/Re-lock control up top. Self-hides on any
          non-locked status; the button itself stays super-admin-only. */}
      <StructuralLockBanner app={app} role={role} onChanged={load} />

      {/* THE SEVEN ROOMS CANVAS (Phase 1 — docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md).
          The rail lists 7 rooms; ONE room's sections render at a time (each
          section byte-identical inside). "Full file (classic view)" in the rail
          footer renders all sections + the flat grouped rail, exactly as
          before. The old right-hand file-summary aside is RETIRED — everything
          it showed lives in the header (loan #, status, amount), the Overview
          room (team, internal status), or a room badge (documents count). */}
      <FileSections
        sections={classic ? SECTIONS : SECTIONS.filter((s) => STATION_OF[s.id] === activeStation)}
        stations={classic ? null : STATION_DEFS}
        activeStation={activeStation} onStationGo={goStation}
        footer={railFooter}>

      <Section hidden={!show('sec-overview')} id="sec-overview" title="File overview"
        info="Status, milestone gating, assignments and the deal at a glance — the control panel for this file.">
      {/* The LoanProgress stepper moved ABOVE the rooms (page top) so it shows
          in every room, not only here. */}
      {/* Only the file's assigned LO sees this — presets to VIP / Quiet /
          Silent + per-notification override rows for JUST this file. */}
      <FileNotificationOverrides applicationId={id} isMyFile={isMyFile} />
      {/* ONE BLOCK, NOT TWO (owner-directed 2026-08-02: the first section of the
          overview "with what's left to clear to close MERGED TOGETHER WITH IT").
          The deal facts and the work they imply were two separately-bordered
          cards stacked on each other, which read as two subjects; they are one.
          `.deal-block` joins them into a single bordered card — the two children
          keep their own internals untouched, so nothing about either component
          had to be rewritten to say they belong together. WhatsLeftPanel keeps
          the permanent #ctc-outstanding anchor, so every deep link and the
          header's "N to clear before CTC" badge still land exactly here. */}
      <div className="deal-block">
        <DealSnapshot app={app} gating={gating} />
        {/* THE RATE-AND-TERM $2,000 RED WARNING (owner-directed 2026-08-18) — on the
            OUTSIDE structure screen, never inside the term sheet generator. Renders
            nothing unless the file is a rate-&-term whose structure hands the borrower
            more than $2,000; carries the "Validate closing costs" editor + the
            super-admin exception request. */}
        <RateTermCashCard appId={id} onChanged={load} />
        <WhatsLeftPanel gating={gating} items={items} conds={conds} />
      </div>
      <PropertyPhoto address={propAddress !== '—' ? propAddress : ''} />
      {/* THE NOTE-BUYER SLOT (owner-directed 2026-07-27) — one obvious home for the
          capital partner: who it is, what they require of this file, and what
          switching would change. It used to live only as a pencil icon on a muted
          line inside the ClickUp panel, which is not a path anyone would find. */}
      <div id="note-buyer-slot"><NoteBuyerCard appId={id} value={app.lender} onSaved={load} /></div>
      {/* THE WORKFLOW (owner-directed 2026-07-21) — the primary way a file moves.
          Submit it to the next person; the status follows automatically. */}
      <SubmitFilePanel appId={id} onChange={load} />
      {/* Status, ClickUp status & closing — one clean labeled control panel. The
          old version crammed the selects + buttons into loose rows and cut off the
          long ClickUp-status field; labels now sit above full-width fields in a
          responsive 2-col grid (owner-directed redesign 2026-07-14). */}
      {statusClosingBlock}


      {/* THE PEOPLE MOVED INTO APPLICATION DETAILS (owner-directed 2026-08-02:
          "both borrower profiles under Application Details, side by side").
          They used to render right here on the overview — see the "Borrower
          profiles" tab in sec-application for the panels themselves and for why
          the discoverability worry that put them here is now handled.

          A POINTER, NOT A SECOND COPY. The record is edited in exactly ONE place
          per person; printing a read-only echo of it here would recreate the
          very drift the shared panel exists to prevent. */}
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: '#141B22' }}>
            {app.co_borrower_id ? 'Borrower & co-borrower' : 'Borrower'}
          </span>
          <span className="small" style={{ color: '#4B585C' }}>
            {[fullNameOf(app), app.co_borrower_id ? fullNameOf(app, 'co_') : null].filter(Boolean).join(' · ')}
          </span>
          <div className="spacer" />
          <button type="button" className="btn primary small"
            onClick={() => { setAppDetailTab('people'); goToSection('sec-application'); }}
            title="Every field on both borrowers' records — name, contact, date of birth, Social, home address, housing, employment, and where each of them stands with the portal">
            Open borrower profiles
          </button>
        </div>
      </div>

      {/* THE TEAM, AND ONLY THE TEAM (owner-directed 2026-08-02: the old
          "Entity, team & assignment" panel "mingled a few sections for no good
          reason"). The ENTITY row and the ASSIGNMENT figures moved up into the
          first overview block, which already owns the parties and the deal's
          economics; the As-is row went with them (the snapshot has shown it for
          a while, so this was printing the same number twice).

          What is left is the one thing this panel is for: who is on this file,
          in every role, and how to change it. It is the LAST thing on the
          overview — first block, then Status & closing, then the team. */}
      <div className="panel team-panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
          <h3 style={{ margin: 0 }}>Team on this file</h3>
          <span className="small" style={{ color: '#4B585C' }}>Who is working it, in every role.</span>
        </div>
        <TeamAssignees appId={id} officers={officers} processors={processors}
          closers={team.filter(m => m.role === 'closer')}
          drawCoordinators={team.filter(m => m.role === 'draw_coordinator')}
          onChanged={load} />
        {uwName && <div className="metrow"><span className="k">Underwriter</span><span className="v">{uwName}</span></div>}
        {/* Reassigning a file is an admin function (S3-02) — the server 403s a
            non-admin, so the control is not offered to them. Side by side rather
            than stacked: they are two halves of one action, and the Assign button
            sits with them instead of floating under a tall column. */}
        {isAdmin ? (
          <div className="team-assign">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Loan officer</label>
              <select className="input" value={lo} onChange={e => setLo(e.target.value)}>
                <option value="">— select —</option>
                {officers.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Processor</label>
              <select className="input" value={proc} onChange={e => setProc(e.target.value)}>
                <option value="">— select —</option>
                {processors.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </div>
            <button className="btn primary" onClick={assign} disabled={(!lo && !proc) || busyAct === 'assign'}>
              {busyAct === 'assign' ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        ) : (
          <p className="small" style={{ color: '#4B585C', marginBottom: 0 }}>
            Only an admin can change who this file is assigned to.
          </p>
        )}
      </div>
      </Section>

      <Section hidden={!show('sec-application')} id="sec-application" title="Application details" defaultOpen={false}
        info="What the borrower filled out, plus the editable deal numbers — changes here flow straight into pricing.">
      {/* ONE TABBED SUB-HUB (owner-directed 2026-07-31: "the application details
          are split in between 100 places… everything together, easier for the
          eye, better organized in sections"). The six stacked panels this
          section used to hold are now three tabs — the deal editor first, the
          missing-field pills second, the read-only ClickUp figures last —
          mirroring the Conditions hub's tab pattern. The PEOPLE on this file
          are NOT here (#850; owner-directed 2026-07-27): their records are the
          two BorrowerProfilePanel mounts up on the file overview, once per
          person, never twice on one page — the line under the tabs points
          there so nobody hunts this section for them. */}
      <div className="cond-tabs" role="tablist" aria-label="Application details">
        {[
          { k: 'deal', label: 'Deal & property' },
          { k: 'people', label: app.co_borrower_id ? 'Borrower profiles' : 'Borrower profile' },
          { k: 'missing', label: 'Missing info' },
          { k: 'status', label: 'Status & closing' },
          { k: 'pipeline', label: 'ClickUp Sync' },
          { k: 'encompass', label: 'Encompass sync' },
        ].map(t => (
          <button key={t.k} type="button" role="tab" aria-selected={appDetailTab === t.k}
            className={`cond-tab${appDetailTab === t.k ? ' active' : ''}`} onClick={() => setAppDetailTab(t.k)}>
            {t.label}
          </button>
        ))}
      </div>

      {appDetailTab === 'deal' && (
        /* The structural lock/unlock banner used to render here; it now sits at
           the top of the file (above the collapsible sections) so it is visible
           without expanding this section. EditFileDetails is where the actual
           correction is made once a super-admin has unlocked the file up top.
           openByDefault: the form IS this tab, so it renders expanded instead
           of hiding behind a second collapse. */
        <>
          <EditFileDetails app={app} onSaved={load} openByDefault role={role} />
          {/* Read-only, under the editable deal fields: what the appraisal put on
              the file (db/403). Renders nothing until an appraisal is imported. */}
          <AppraisalFileFacts app={app} />
        </>
      )}

      {/* BOTH PEOPLE, SIDE BY SIDE (owner-directed 2026-08-02). Each is the ONE
          shared BorrowerProfilePanel (#850) keyed on a borrower id, so the
          primary and the co-borrower are literally the same code path and
          neither can drift — and each is mounted exactly ONCE on the page.

          WHY IT IS SAFE HERE NOW. These panels sat on the overview because
          "Application details" is collapsed by default, and a Borrower editor
          nobody can see is how this surface stayed read-only in the first place
          (2026-07-27). That worry is answered rather than ignored: the overview
          carries a named button that opens this exact tab, the completeness
          pills that used to point at the overview now land here with the tab
          already open, and the tab is named after the people it holds. */}
      {appDetailTab === 'people' && <>
        <p className="small" style={{ margin: '0 0 10px', color: '#4B585C' }}>
          Every field on each person&rsquo;s own record — name, contact, date of birth, Social,
          home address, housing and employment — plus where each of them stands with the portal.
          A change here follows the person onto every file they are on.
        </p>
        <div className="bprof-pair">
          {app.borrower_id && (
            <BorrowerProfilePanel borrowerId={app.borrower_id} heading="Borrower profile" onChanged={load} />
          )}
          {app.co_borrower_id && (
            <BorrowerProfilePanel borrowerId={app.co_borrower_id} heading="Co-borrower profile" onChanged={load} />
          )}
        </div>
        {/* What is about the LINK rather than about the person: find / add /
            remove / invite. It stays full width under the pair. */}
        <CoBorrowerBlock appId={id} app={app} onChanged={load} />
      </>}

      {/* THREE LISTS, BY SUBJECT (owner-directed 2026-08-02). What is missing on
          the DEAL, on the BORROWER, and on the CO-BORROWER — one flat run of
          pills mixed the loan number in with somebody's date of birth, so
          neither the processor chasing terms nor the officer chasing identity
          could see their own work. The co-borrower panel already stood apart;
          this makes the primary borrower its equal instead of leaving their
          identity fields looking like part of the deal. */}
      {appDetailTab === 'missing' && <>
        <p className="small" style={{ margin: '0 0 4px', color: '#4B585C' }}>
          Anything still missing, split three ways — the deal, the borrower, the co-borrower.
          Fill a pill and it disappears. Every field here can also be edited any time under
          Deal &amp; property or on the borrower&rsquo;s own profile.
        </p>
        <Completeness app={app} borrower={borrower} appId={app.id} onSaved={load} />
        <BorrowerCompleteness app={app} borrower={borrower} appId={app.id} onSaved={load} />
        <CoBorrowerCompleteness app={app} appId={app.id} onSaved={load} />
        {/* The two primary-address rows moved here rather than being deleted
            with the people's editors: this small panel still edits something
            the BorrowerProfilePanel's address boxes don't offer (the Apt/Unit
            slot, and it writes the one-line mailing form). Once an address is
            on file each collapses to a single row. */}
        {app.borrower_id && (
          <PrimaryAddressPanel borrowerId={app.borrower_id}
            address={borrower && borrower.current_address}
            name={fullNameOf(app) || 'Borrower'} onSaved={load} />
        )}
        {app.co_borrower_id && (
          <PrimaryAddressPanel borrowerId={app.co_borrower_id}
            address={app.co_current_address}
            name={fullNameOf(app, 'co_') || 'Co-borrower'} onSaved={load} />
        )}
      </>}

      {/* EVERY DETAIL, EVERY EDIT (owner-directed 2026-08-02: "you should not
          look where you need to change stuff, everything should be available
          right there"). The owner named five things: the YS loan number with an
          action to ENTER it, the expected and actual closing dates, BOTH
          statuses, and the note buyer.

          The Status & closing panel is the SAME ELEMENT the overview renders —
          built once, rendered twice — so the two can never drift. That is safe
          here because sec-overview and sec-application are in different ROOMS:
          only one is ever on screen. The owner explicitly asked for it in both
          places ("may stay on the overview too"). */}
      {appDetailTab === 'status' && <>
        <div className="panel" style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px', color: '#141B22' }}>File identity</h4>
          <LoanNumberEntry appId={app.id} value={app.ys_loan_number} onSaved={load} />
        </div>
        {statusClosingBlock}
        {/* The note buyer's ONE editor, mounted here as well — same card, same
            single write path (complete-fields with `lender`). Never a second
            editor: this is the card itself. */}
        <NoteBuyerCard appId={id} value={app.lender} onSaved={load} />
      </>}

      {/* CLICKUP SYNC (owner-directed 2026-08-02) — everything about the card in
          ONE place: the link and the re-sync controls (moved down from the
          overview, where they sat behind a "Pipeline details" toggle on a panel
          about a different subject), then the field-by-field comparison, then the
          read-only figures the pipeline carries. The tab was called "Pipeline
          data (read-only)", which described the least useful third of it. */}
      {appDetailTab === 'pipeline' && <>
        <ClickupSyncPanel app={app} canSetup={can('platform_setup')} isAdmin={isAdmin} onResynced={load} />
        <div className="panel" style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px', color: '#141B22' }}>PILOT vs the ClickUp card</h4>
          <ClickupCompare appId={app.id} />
        </div>
        <ClickupFileData app={app} />
      </>}

      {/* ENCOMPASS SYNC (owner-directed 2026-08-02) — the file's two outside
          systems now sit side by side under Application details, in the order the
          owner asked for: ClickUp first, then Encompass. It was its own top-level
          section, which put the same KIND of screen (a live field-by-field
          comparison against another system) two rooms away from its twin.
          READ-ONLY, unchanged: Encompass is never written to. */}
      {appDetailTab === 'encompass' && (
        <EncompassSyncPanel appId={id} />
      )}
      </Section>

      {/* THE PAYOFF (owner-directed 2026-07-31) — its own section on a refinance,
          sitting between the application and the structure because that is what it
          is: part of the real structure. It collects how much, to whom and on
          which loan, states what the borrower walks away with on a cash-out, and
          explains how a payoff works. Purchases never see it. */}
      {isRefiFile && (
        <Section hidden={!show('sec-payoff')} id="sec-payoff" summary={summaries['sec-payoff']} title="Payoff" defaultOpen={false}
          info="The loan already on this property: what it costs to clear it, who holds it, and which of their loans it is — everything the closing attorney needs to order a payoff letter. On a cash-out refinance it also shows what the borrower actually walks away with after the payoff and the closing costs."
          badge={payoffBadge.long}>
          <PayoffCard appId={id} app={app} onSaved={load} />
        </Section>
      )}

      <Section hidden={!show('sec-pricing')} id="sec-pricing" summary={summaries['sec-pricing']} title="Structure & pricing" defaultOpen={false}
        info="The registered product and the Term Sheet Studio to re-price or re-register — every registration attaches the term sheet PDF."
        badge={badges.pricing.long}>
      <ProductStudioPanel ref={studioRef} appId={id} app={app} onRegistered={load} mode="staff" staffRole={role}
        toolItemId={(items.find(it => it.tool_key === 'product_pricing') || {}).id} />
      </Section>

      {/* The file's policy-exception REGISTER (redesign 2026-07-24): every
          deviation this loan asked for or carries — guaranty waiver, early
          send, pricing exception, recorded overrides — with EX-n references.
          Requests are made from the sections they belong to; this is the
          one-look history a diligence conversation starts from. Sits directly
          under Structure & pricing (most exceptions are pricing exceptions). */}
      <Section hidden={!show('sec-exceptions')} id="sec-exceptions" title="Exceptions" defaultOpen={false}
        info="Every exception to loan policy on this file — asked for, granted, denied, or recorded — with its EX-number, validity, and whether the deal has changed since. Granted exceptions ride onto the decision certificate and the register export automatically.">
        {/* The personal-guaranty status + co-borrower guaranty-waiver REQUEST live
            HERE now (owner-directed 2026-08-06: "remove it from Products & Pricing,
            add it to the general request & exceptions area"). Self-hides with no
            co-borrower. The approve side already lives in the Exceptions box. */}
        <GuarantyWaiverCard appId={id} />
        <ExceptionRegisterCard appId={id} canSeeBox={can('manage_pricing') || role === 'super_admin'} />
      </Section>

      {/* THERE IS NO "Encompass sync" SECTION (owner-directed 2026-08-03: it "is
          now duplicated also in the application details and it's also a separate
          section in the deal … it should not be a separate section in the deal").
          The 2026-08-02 move left a shell here whose only content was a button
          pointing at the tab — which read as a second Encompass room and is
          exactly the duplicate the owner is describing. The panel has ONE home:
          Application details → Encompass sync.

          The ADDRESS `#sec-encompass` is not dead — it is a permanent public
          address carried by emails already sent, so `RETIRED_SECTION` in
          lib/stations.js resolves it to that section + that tab. Deleting a
          section means retiring its id there, never just removing the JSX. */}

      {/* ONE Conditions hub with tabs (owner-directed cleanup): the borrower's
          conditions, the underwriting conditions, the internal staff conditions +
          checklist, and the LLC used to be four separate sections — they're now one
          section you switch between with tabs, so there's a single place to look. */}
      {/* fullscreenable: owner-directed — the conditions list is the one section
          you sit and work through, so it gets a button to fill the screen. */}
      <Section hidden={!show('sec-conditions')} id="sec-conditions" summary={summaries['sec-conditions']} title="Conditions" defaultOpen={false}
        info="Everything to clear on this file — the borrower's conditions, your underwriting conditions, internal staff conditions, and the LLC. Switch with the tabs."
        badge={nCondOpen || ''} fullscreenable>

      {({ full }) => (<>
      <input ref={staffFileRef} type="file" multiple style={{ display: 'none' }} onChange={onStaffFile} />
      {(() => {
        const uwOpen = conds.filter(c => c.status === 'open' || c.status === 'borrower_responded').length;
        const TABS = [
          { k: 'borrower', label: 'All conditions', badge: nCondOpen || '' },
          { k: 'underwriting', label: 'Underwriting', badge: uwOpen || '' },
          { k: 'llc', label: 'LLC / entity', badge: app.llc_id ? (app.llc_verified ? '✓' : '!') : '' },
        ];
        return (
          <div className="cond-tabs" role="tablist" aria-label="Conditions">
            {TABS.map(t => (
              <button key={t.k} type="button" role="tab" aria-selected={condTab === t.k}
                /* Hold the tab the reader clicked where it is, and remember a place
                   per tab: a panel shorter than the window leaves the page nothing
                   to scroll, so coming BACK is what has to restore them
                   (owner-reported 2026-08-02). */
                className={`cond-tab${condTab === t.k ? ' active' : ''}`}
                onClick={(e) => keepTabPlace(condTabY.current, condTab, t.k, e.currentTarget, () => setCondTab(t.k))}>
                {t.label}{t.badge !== '' && <span className="cond-tab-badge">{t.badge}</span>}
              </button>
            ))}
          </div>
        );
      })()}

      {condTab === 'borrower' && <>
        <BorrowerConditions appId={id} app={app} items={items} docs={docs} role={role}
          team={team} canImportCredit={can('pull_credit')} fullscreen={full}
          closingActive={!!app.closer_id || ['clear_to_close', 'funded'].includes(app.status)}
          onPatch={patch} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc} dlBusy={dlBusy}
          onUploadTo={pickUpload} onDropTo={uploadStaffFiles} onChanged={load} onPreview={openPreview}
          onOpenStudio={openStudioAnywhere} onRequestWaiver={requestWaiver} />
        <StaffChangeRequests appId={id} onChanged={load} />
        <FileContacts appId={id} isStaff heading="File contacts (realtor, attorney, title, insurance, contractor…)" />
        <div className="stack" style={{ marginTop: 14 }}>
          <AddConditionPanel appId={id} items={items} onChanged={load}
            onError={(t) => setErr(t)} onFlash={flash} />
        </div>
      </>}

      {condTab === 'underwriting' && (
        <LoanConditionsPanel conds={conds} condFilter={condFilter} setCondFilter={setCondFilter}
          cForm={cForm} setCForm={setCForm} addLoanCondition={addLoanCondition}
          clearCond={clearCond} waiveCond={waiveCond} overrideCond={overrideCond} isAdmin={isAdmin} completer={completer}
          reviewCond={reviewCond} role={role} />
      )}

      {/* THE CHECKLIST IS OFF THE FILE (owner-directed 2026-07-27: "the checklist
          is just things with loans to sign off on — get the entire checklist
          removed and leave only the condition section"). Blueprint Move 4c.

          HIDDEN, NOT DELETED. Every row is still in checklist_items with its
          history intact, still worked from the "My tasks" screen (which reads
          checklist_items with no item_kind filter), and still counted wherever
          the server counts it. This is a rendering change and it reverses by
          putting the panel back.

          SAFE ONLY BECAUSE 5a WENT FIRST. The scope is audience='staff' AND
          item_kind='task'. Verified against the live templates: that set
          contains ZERO gates and neither carve-out — rtl_p1_titlec and
          rtl_p1_insc are task-kind but audience='both', so scoping to 'staff'
          protects them without naming them. The file's conditions, gates
          included, moved into the one list in 5a. */}

      {condTab === 'llc' && <>
        <LlcReview appId={id} app={app} role={role} onReviewDoc={reviewDoc} onDownloadDoc={downloadDoc}
          dlBusy={dlBusy} onChanged={load} reviewBusy={busyAct === 'review'} onPreview={openPreview} />
        <VestingLlcOwners appId={id} app={app} />
      </>}
      </>)}
      </Section>

      <Section hidden={!show('sec-track')} id="sec-track" title="Track record" defaultOpen={false}
        info="The borrower's live track record — one record shared by every file. Add, edit, verify and attach closing docs; changes save automatically.">
      {app.borrower_id
        ? <StaffTrackRecordPanel app={app} role={role} />
        : <p className="muted small">No borrower linked yet.</p>}
      </Section>

      <Section hidden={!show('sec-appraisal')} id="sec-appraisal" summary={summaries['sec-appraisal']} title="Appraisal & findings" defaultOpen={false}
        info="Import the appraisal XML and PILOT builds the property profile and flags every value that differs from the file for your team to review."
        badge={badges.appraisal.long}>
        {/* The REVIEW-side "No XML available" waiver — the appraisal-review entry
            point (the review task itself is worked from My Tasks, not the
            conditions list). It self-hides on a file that already has an imported
            appraisal (there IS XML), and shares the SAME As-Is/ARV values as the
            appraisal-documents waiver, so entering on either side shows "already
            entered — confirm" on the other. */}
        <AppraisalXmlWaiver appId={id} onChanged={() => { load(); setApprReload((n) => n + 1); }} context="review" />
        {/* FIND COMPARABLES FOR THIS FILE, without leaving it and re-typing the
            subject from memory. The comp search takes an application id and reads
            the subject off the file, so this works whether or not an appraisal has
            been imported yet. */}
        <div style={{ margin: '0 0 12px' }}>
          <Link className="btn ghost small" to={`/internal/research/comps?application_id=${id}`}>
            Find comparables for this property →
          </Link>
          <span style={{ color: '#4B585C', fontSize: 12, marginLeft: 10 }}>
            Searches every comparable sale our own appraisals have shown us.
          </span>
        </div>
        <AppraisalPanel appId={id} onSummary={onApprSummary} reloadSignal={apprReload} />
      </Section>

      {/* The standalone "Investor guidelines" section was RETIRED (owner-directed 2026-07-24):
          the investor-specific guidelines are now a subsection of THIS section —
          one review, one place, no separate AI pass. */}

      <Section hidden={!show('sec-underwriting')} id="sec-underwriting" summary={summaries['sec-underwriting']} title="Document review" defaultOpen={false}
        info="PILOT reads every uploaded document (government ID, purchase contract, title, bank statement and more), understands it, and checks it against the loan file — flagging anything that doesn't match on the document itself AND anything that disagrees across documents (the seller, price, and property address must be the same on the contract, title, and appraisal). Choose a document and the type it is, and PILOT reads and checks it. Each finding is yours to resolve: post a condition, request a document, fix the file, clear it, grant an exception, dismiss, or decline. Nothing is ever written onto the loan file automatically."
        badge={badges.underwriting.long}>
        <UnderwritingPanel appId={id} docs={docs} onSummary={onUwSummary} canResolve={can('sign_off_conditions')} canWaive={can('waive_conditions')} />
        {/* Investor-specific guidelines live INSIDE the one document review (owner-directed 2026-07-24):
            not a separate section, not a separate AI pass — the same review, one place. */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid var(--line,#E7E1D3)' }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#141B22', marginBottom: 4 }}>Investor-specific guidelines</div>
          <InvestorGuidelinesPanel appId={id} />
        </div>
      </Section>

      {/* Just "Documents" now (owner-directed 2026-08-02: "since we don't have any
          exports anymore in the document section, that section should just be called
          Documents where you can just see all the documents"). */}
      <Section hidden={!show('sec-documents')} id="sec-documents" summary={summaries['sec-documents']} title="Documents" defaultOpen={false}
        info="Every document on the file, titled by condition — with the working set on top and rejected/replaced versions in the trash. Open a document for where it was uploaded, why it was asked for, and its full history: accepted, rejected, replaced, synced."
        badge={badges.documents.long}>
      <DocumentsPanel docs={docs} role={role} dlBusy={dlBusy}
        onPreview={openPreview} onDownload={downloadDoc} onReview={reviewDoc} />
      {app.status === 'funded' && <PostClosing appId={id} />}
      {/* TprExport + MismoExport used to sit here. They moved to Send to Investor
          (owner-directed 2026-08-02) — which is also why this section is no longer
          called "Documents & exports". */}
      </Section>

      {/* ONE SECTION PER ORDER (owner-directed 2026-08-03). They open by DEFAULT,
          unlike the single combined section they replace: landing in the Orders
          room and finding three collapsed headers is the very "go into orders and
          then see the 3 options" the split is meant to end. A collapsed Section
          unmounts its children, so the panel's shared store (OrdersPanel) still
          makes this ONE request for the file however many of them are showing. */}
      <Section hidden={!show('sec-order-title')} id="sec-order-title" summary={summaries['sec-order-title']} title="Title"
        info="Order title from the title company on the file. The order emails them with the borrower, loan officer and processor copied, tracks its own thread, and files what they send back onto the title condition for you to classify.">
      <OrdersPanel appId={id} canAccept={canComplete(role)} only="title" />
      </Section>

      <Section hidden={!show('sec-order-insurance')} id="sec-order-insurance" summary={summaries['sec-order-insurance']} title="Insurance"
        info="Order insurance from the agent on the file. The order emails them with the borrower, loan officer and processor copied, tracks its own thread, and files the binder and invoice they send back onto the insurance condition for you to classify.">
      <OrdersPanel appId={id} canAccept={canComplete(role)} only="insurance" />
      </Section>

      <Section hidden={!show('sec-order-appraisal')} id="sec-order-appraisal" summary={summaries['sec-order-appraisal']} title="Appraisal"
        info="Order the appraisal with every field filled in and shown to you first. Two places can do it — AppraisalScope / NAN and Class Valuation — and you pick which one per file; neither is the default. Track the status, message them back and forth, request revisions or dispute the value, send documents up, and pay the appraisal card. Each turns on once its login is set up.">
      {/* ONE unified "Appraisal order" section. A vendor selector chooses which backend
          the BUILDER targets; the active-order cards and the one drafts+failed drawer
          show orders from BOTH vendors together, each carrying its own vendor stamp.
          The two vendors stay TECHNICALLY SEPARATE — no mixing of backends. The owner
          has not picked a default ("none of them are ready right now"), so the selector
          only chooses the display/builder target; it never registers a file preference. */}
      {/* THE ORDERS-DESK STRIP for the appraisal (owner-directed 2026-08-05,
          re-confirmed 2026-08-16). The appraisal is now a real order on the Orders
          desk — its own due date, owner, note and history, and a row in the
          cross-file Orders queue — and this is that half of it, sitting above the
          builder exactly as the attorney strip sits above the closing card. It
          RENDERS NOTHING until an appraisal has actually been ordered. */}
      <OrdersPanel appId={id} canAccept={canComplete(role)} only="appraisal" />
      <AppraisalOrderSection appId={id} onChanged={load} />
      </Section>

      <Section hidden={!show('sec-order-closing')} id="sec-order-closing" summary={summaries['sec-order-closing']} title="Attorney closing prep"
        info="Send the closing attorney the file for closing prep, with the package of documents attached. Everything that goes back and forth on that chain — from the attorney, title, the settlement agent — files here as the file's closing correspondence.">
      <OrdersPanel appId={id} canAccept={canComplete(role)} only="closing" />
      </Section>

      <Section hidden={!show('sec-esign')} id="sec-esign" summary={summaries['sec-esign']} title="E-signatures" defaultOpen={false}
        info="Send and track the term-sheet package and Heter Iska, with live per-signer status, resend, void, re-issue and downloads.">
      {/* The same rate-&-term cash card at the SEND gate (owner: the validate-closing-costs
          button lives at both places) — the gate's blocker names this exact remedy. */}
      <RateTermCashCard appId={id} onChanged={load} />
      <EsignFileSection appId={id} role={role} onChanged={load} onFinalizeTermSheet={finalizeTermSheetBridge} />
      </Section>
      {showClosing && (
        <Section hidden={!show('sec-closing')} id="sec-closing" summary={summaries['sec-closing']} title="Closing" defaultOpen={false}
          info="The closer's desk — cash-to-close vs verified liquidity, the warehouse line, collateral tracking, closing conditions, checklists, TPR / investor-delivery sign-off, and the funded-date reconciliation.">
          <ClosingPanel appId={id} app={app} can={can} onDownloadDoc={downloadDoc} onPreview={openPreview} onChanged={load} />
        </Section>
      )}

      {/* Closed by default like the other 13 sections. It was the ONLY export tool
          sitting open on every file — above the collapsed Track record and
          Communication sections, which matter more day to day. */}
      {/* SEND TO INVESTOR — everything that leaves this file for an outside party
          (owner-directed 2026-08-02: "the TPR Clean File Export should be part of
          the Send to Investor section. The Mismo 3.4 exports should also be part
          of the Send to Investor section").

          The SECTION is deliberately no longer wrapped in `can('export_data_tapes')`.
          That permission is about a capital provider's own WORKBOOK, and gating the
          whole section on it would have taken the TPR and MISMO exports away from
          every loan officer who has them today — the room itself disappears without
          it (stationEnabled). So the tape workbook keeps its own gate, INSIDE. */}
      <Section hidden={!show('sec-tapes')} id="sec-tapes" title="Send to investor" defaultOpen={false}
        info="Everything that leaves this file for an outside party: the TPR clean-file export, the MISMO 3.4 file, and the capital provider's own data tape.">
      <TprExport appId={id} />
      <CorrfirstExport appId={id} />
      <MismoExport appId={id} />
      {can('export_data_tapes') && <TapeExport appId={id} />}
      </Section>

      {/* Conversations, Email Center and Activity are one "Communication & history"
          section with tabs — they're all the file's talk + trail, so they share a
          home instead of three separate sections. */}
      {/* Task management (owner-directed 2026-08-18): the file's task board. */}
      <Section hidden={!show('sec-tasks')} id="sec-tasks" title="Tasks & reminders" defaultOpen={false}
        info="Scheduled tasks and reminders on this file — who owns each one, when it's due, and who gets told. A task also shows on its owner's My-tasks queue; reminders fire automatically at their due moment.">
        <FileTasksPanel appId={id} team={team} />
      </Section>

      {/* The Drafting desk (owner-directed 2026-08-18): copy-paste email drafts. */}
      <Section hidden={!show('sec-drafting')} id="sec-drafting" title="Drafting" defaultOpen={false}
        info="Pilot AI drafts a human-sounding email from this file — the borrower's outstanding conditions, a deal overview, or anything you describe — for you to edit and COPY into your own email program. Nothing is ever sent from here.">
        <DraftingPanel appId={id} />
      </Section>

      <Section hidden={!show('sec-messages')} id="sec-messages" title="Communication & history" defaultOpen={false}
        info="Everything said and logged on this file — chats, the email history, and the full AUDIT LOG: every action, who did it, what changed, every notification and email that went out, every push to ClickUp or the LOS, and (on request) every single API call. This is where you look when you need to know what happened.">
      <div className="comm-tabs" role="tablist" aria-label="Communication">
        {[{ k: 'messages', label: '💬 Chats' }, { k: 'emails', label: '✉️ Email' }, { k: 'activity', label: '🕓 Audit log' }].map(t => (
          <button key={t.k} type="button" role="tab" aria-selected={commTab === t.k}
            className={`comm-tab${commTab === t.k ? ' active' : ''}`}
            onClick={(e) => keepTabPlace(commTabY.current, commTab, t.k, e.currentTarget, () => setCommTab(t.k))}>{t.label}</button>
        ))}
      </div>
      {commTab === 'messages' && <ChatPanel appId={id} onTaskCreated={load} />}
      {commTab === 'emails' && <EmailCenter mode="file" appId={id} />}
      {commTab === 'activity' && (
        <ActivityFeed fetcher={activityFetcher} title="File audit log" audit
          deep={deepActivity} onDepth={setDeepActivity} />
      )}
      </Section>

      {/* Construction draws — the LAST phase (post-funding), so the LAST section. Opens in its own full
          window too (everything about the draw process lives there). */}
      {/* Construction draws is the post-funding PHASE — it lives in its own Draw Management workspace,
          not inside the file. The file just hands off to it. */}
      {(can('manage_draws') || can('view_draws')) && (
        <Section hidden={!show('sec-draws')} id="sec-draws" title="Construction draws" collapsible={false}>
          {app.status === 'funded' ? (
            <div className="panel" style={{ background: 'var(--paper,#f6f3ec)' }}>
              <b>This file is funded — its draws are managed in the Draw Center.</b>
              <div className="muted small" style={{ marginTop: 3, marginBottom: 10 }}>
                The construction-draw process is its own phase after funding: each draw, approvals, the inspector’s
                photos and reports, our fee &amp; net release, and the borrower’s accept/dispute — all live in the Draw
                Center workspace, not on this file screen.
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary btn-sm" onClick={() => nav(`/internal/app/${id}/draws`)}>Open this file’s Draw Center →</button>
                <button className="btn ghost btn-sm" onClick={() => nav('/internal/draws')}>All draws</button>
                <button className="btn ghost btn-sm" title="Open the full Draw Center in its own window"
                  onClick={() => window.open(`${window.location.pathname}#/internal/app/${id}/draws`, '_blank', 'noopener')}>Open in a new window ↗</button>
              </div>
            </div>
          ) : (
            // NOT funded — the Draw Center is locked. Construction draws are the last
            // phase and can't start until the file reaches Funded, so nothing here is
            // actionable yet: the buttons are disabled and we say what unlocks them.
            <div className="notice warn" role="status" aria-label="Draw Center locked until the file is funded">
              <b>🔒 Waiting on funding — the construction-draw process hasn’t started.</b>
              <div className="small" style={{ marginTop: 4, marginBottom: 10, opacity: .92 }}>
                Construction draws are the last phase and open only once this file’s status is <b>Funded</b>.
                Until then nothing can be requested, approved, inspected, or released here — advance the file to
                Funded to unlock the Draw Center.
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary btn-sm" disabled aria-disabled="true"
                  title="The Draw Center opens once this file is funded">Draw Center — locked until funded</button>
              </div>
            </div>
          )}
        </Section>
      )}

      </FileSections>

      {/* The old right-hand "File summary" aside is RETIRED (Seven Rooms Phase
          1) — it only duplicated facts that now live in the header (loan #,
          status, amount), the Status & closing panel (internal status, target
          closing), the Overview room (team) and the room badges (documents). */}

      {previewDoc && (
        <DocPreview
          title={previewDoc.item_label || previewDoc.slot_label || 'Document preview'}
          filename={previewDoc.filename} contentType={previewDoc.content_type}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          ocr={() => api.staffOcrDoc(previewDoc.id)}
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
              <h3 style={{ margin: 0, display: 'inline-flex', alignItems: 'center' }}><IconMessage />Conversation{addrLine(app.property_address) !== '—' ? ` — ${addrLine(app.property_address)}` : ''}</h3>
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
function LoanConditionsPanel({ conds, condFilter, setCondFilter, cForm, setCForm, addLoanCondition, clearCond, waiveCond, overrideCond, isAdmin, completer, reviewCond, role }) {
  return (
        <div className="panel">
          <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
            {/* "Timing", not "severity": the stored column holds a SCHEDULE
                (before docs / before funding), not a danger level — see the note
                in lib/conditions-vocab.js. Findings own the word "severity". */}
            <h3>Underwriting conditions <InfoTip tip="Formal loan conditions by timing (before docs, before funding…). These gate clear-to-close; clear or waive them here." /></h3>
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
              const timing = timingLabel(c.severity);
              const open = c.status === 'open' || c.status === 'borrower_responded';
              return (
                <div className="checkitem" key={c.id} style={{ alignItems: 'flex-start', opacity: open ? 1 : .6 }}>
                  <span className={`dot ${open ? 'outstanding' : 'done'}`} style={{ marginTop: 4 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div className="muted small">
                      {timing} · {audienceLabel(c.audience)}
                      {c.status !== 'open' ? ` · ${loanConditionStatusLabel(c.status).toLowerCase()}${c.cleared_by_name ? ` by ${c.cleared_by_name}` : ''}` : ''}
                      {open && c.reviewed_by_name ? ` · reviewed by ${c.reviewed_by_name}` : ''}
                      {c.waive_reason ? ` · ${c.waive_reason}` : ''}
                    </div>
                    {c.override_at && (
                      <div className="small" style={{ marginTop: 2, color: 'var(--gold, #AE8746)' }}>
                        {`Cleared by super-admin override — ${c.override_by_name || 'a super admin'} · ${new Date(c.override_at).toLocaleDateString()}${c.override_reason ? ` · ${c.override_reason}` : ''}`}
                      </div>
                    )}
                  </div>
                  {/* Clearing (sign-off) is a processor/underwriter call; a loan officer marks it reviewed instead. */}
                  {open && completer && <button className="btn ghost small" onClick={() => clearCond(c.id)}>Clear</button>}
                  {open && isAdmin && <button className="btn link small" onClick={() => waiveCond(c.id)}>Waive</button>}
                  {open && canOverride(role) && (
                    <button className="btn link small" style={{ color: 'var(--gold, #AE8746)' }}
                      title="Super admin: clear this condition without meeting its requirement. Your reason is saved on the file."
                      onClick={() => overrideCond(c.id, c.title)}>Override</button>
                  )}
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
            {/* Words from conditions-vocab §4 — two visibilities, never a bare
                "External"/"Borrower-facing" (staff see everything). */}
            <select className="input" style={{ maxWidth: 190 }} value={cForm.audience} onChange={e => setCForm({ ...cForm, audience: e.target.value })}>
              <option value="staff">{audienceLabel('staff')}</option>
              <option value="both">{audienceLabel('both')}</option>
            </select>
            {/* Stored values unchanged (conditions.severity CHECK constraint);
                only the words the user reads come from the shared vocabulary. */}
            <select className="input" style={{ maxWidth: 170 }} title="When this condition is due"
              value={cForm.severity} onChange={e => setCForm({ ...cForm, severity: e.target.value })}>
              {CONDITION_TIMINGS.map(t => <option key={t} value={t}>{timingLabel(t)}</option>)}
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
    try { const { blob, filename } = await api.staffTprExport(appId); saveBlob(blob, filename || 'TPR_export.zip'); }
    catch (e) { showMessage(e.message || 'Export failed'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3>TPR / clean-file export</h3>
        <div className="spacer" />
        <button className="btn primary" onClick={download} disabled={busy || !prev || (prev.includedCount === 0 && !prev.trackDocs)}>
          {busy ? 'Building…' : 'Export clean file (ZIP)'}
        </button>
      </div>
      {!prev ? <p className="muted small">Checking readiness…</p> : (
        <>
          <p className="muted small">
            One folder named for the property, with a clean subfolder per document type (ID, LLC, Insurance, TITLE,
            Appraisal, Term Sheet, Contract &amp; Assignment…). REO holds the track-record Excel plus a folder per prior
            property. {prev.includedCount} document{prev.includedCount === 1 ? '' : 's'}
            {prev.trackDocs > 0 ? ` plus ${prev.trackDocs} track-record file${prev.trackDocs === 1 ? '' : 's'}` : ''} will be included. Only documents somebody has ACCEPTED go
            into the package — the Heter Iska, rejected and superseded files are excluded too.
          </p>
          {/* HELD BACK, NAMED (owner-directed 2026-08-03). The package carries
              only accepted documents, so the one thing this panel must never do
              is let a package go out one document short without saying which
              one. Named, not counted — "3 held back" sends nobody anywhere. */}
          {(prev.pending || []).length > 0 && (
            <div className="notice" style={{ marginTop: 8, borderLeft: '3px solid var(--gold,#AE8746)', padding: '6px 10px' }}>
              <b style={{ color: '#141B22' }}>
                {prev.pending.length} document{prev.pending.length === 1 ? '' : 's'} on this file {prev.pending.length === 1 ? 'has' : 'have'} not been accepted yet, so {prev.pending.length === 1 ? 'it is' : 'they are'} NOT in the export:
              </b>
              <ul style={{ margin: '3px 0 0 18px', padding: 0, color: '#4B585C' }}>
                {prev.pending.slice(0, 15).map((d) => (
                  <li key={d.id} className="small">{d.filename}{d.requirement ? ` — ${d.requirement}` : ''}</li>
                ))}
              </ul>
              {prev.pending.length > 15 && (
                <div className="small" style={{ color: '#4B585C' }}>…and {prev.pending.length - 15} more.</div>
              )}
              <div className="small" style={{ color: '#4B585C', marginTop: 3 }}>
                Accept each one on its condition (or reject it) and it will be in the next export.
              </div>
            </div>
          )}
          {prev.missing.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <span className="muted small">Would ship empty:</span>
              {prev.missing.slice(0, 12).map((m, i) => <span key={i} className="pill" style={{ borderColor: 'var(--gold)', color: 'var(--gold-ink)' }}>{m}</span>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* CORRFIRST EXPORT — the Track Record Investor Export.

   CorrFirst wants the borrower's prior projects on THEIR OWN spreadsheet: they
   sent us an empty CSV (a header row) and a filled sample showing exactly how
   they want the values written. This downloads that exact file, filled in, so it
   can be handed to them with no editing.

   Only VERIFIED track records go out — the same rule the TPR/REO investor
   package already follows. Anything the file can't state (a property type nobody
   entered, an ownership share nobody recorded) is NAMED here before the download,
   never left for CorrFirst's import to reject. */
function CorrfirstExport({ appId }) {
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.staffCorrfirstTrackRecordPreview(appId).then(setPrev).catch(() => setPrev({ error: true }));
  }, [appId]);
  async function download() {
    setBusy(true);
    try {
      const { blob, filename } = await api.staffCorrfirstTrackRecordExport(appId);
      saveBlob(blob, filename || 'Track Record.csv');
    } catch (e) { showMessage(e.message || 'Export failed'); }
    finally { setBusy(false); }
  }
  const w = (prev && prev.warnings) || {};
  const gaps = [
    { rows: w.missingPropertyType || [], text: 'no property type on the line — CorrFirst’s Property Type column will be blank. Add it on the track record and export again.' },
    { rows: w.missingOwnership || [], text: 'no ownership share recorded — the "% of Ownership" column will be blank. Record the borrower’s stake in the entity that held it.' },
    { rows: w.missingPurchase || [], text: 'missing a purchase price or purchase date.' },
    { rows: w.noTitleName || [], text: 'nobody recorded who held title.' },
  ].filter((g) => g.rows.length > 0);
  const unmapped = w.unmappedPropertyType || [];
  const judged = w.judgedPropertyType || [];
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3>Corrfirst Export</h3>
        <div className="spacer" />
        <button className="btn primary" onClick={download} disabled={busy || !prev || prev.error || !prev.rowCount}>
          {busy ? 'Building…' : 'Export track record (CSV)'}
        </button>
      </div>
      {!prev ? <p className="muted small">Checking the track record…</p> : prev.error ? (
        <p className="muted small" style={{ color: 'var(--gold-ink)' }}>Couldn’t read the track record. Refresh to try again.</p>
      ) : (
        <>
          <p className="muted small">
            The borrower’s track record on CorrFirst’s own spreadsheet — their exact columns, their exact
            formatting — so it imports on their side with nothing to fix.{' '}
            <b style={{ color: '#141B22' }}>{prev.rowCount}</b> verified propert{prev.rowCount === 1 ? 'y' : 'ies'} will be sent
            {prev.rowCount > 0 ? ` (${prev.soldCount} sold, ${prev.retainedCount} kept as a rental)` : ''}. Only projects the loan
            team has VERIFIED are included — a project still pending review never goes to an investor.
          </p>
          {prev.rowCount === 0 && (
            <div className="notice" style={{ marginTop: 8, borderLeft: '3px solid var(--gold,#AE8746)', padding: '6px 10px' }}>
              <b style={{ color: '#141B22' }}>Nothing to send yet.</b>
              <div className="small" style={{ color: '#4B585C', marginTop: 3 }}>
                This borrower has no verified projects on their track record. Verify their projects first and the export fills itself in.
              </div>
            </div>
          )}
          {gaps.length > 0 && (
            <div className="notice" style={{ marginTop: 8, borderLeft: '3px solid var(--gold,#AE8746)', padding: '6px 10px' }}>
              <b style={{ color: '#141B22' }}>Some columns will go out blank:</b>
              <ul style={{ margin: '3px 0 0 18px', padding: 0, color: '#4B585C' }}>
                {gaps.map((g, i) => (
                  <li key={i} className="small">
                    {g.rows.length} propert{g.rows.length === 1 ? 'y has' : 'ies have'} {g.text}
                    <div style={{ color: '#4B585C', opacity: 0.9 }}>{g.rows.slice(0, 6).join(' · ')}{g.rows.length > 6 ? ` …and ${g.rows.length - 6} more` : ''}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* CorrFirst's own Property Type list has no value for land, a lot or a
              plain "commercial" building. Those go out BLANK rather than as a made-up
              value their form would reject — so the staffer is told by name, with the
              choices their form actually offers. Never a blocker. */}
          {unmapped.length > 0 && (
            <div className="notice" style={{ marginTop: 8, borderLeft: '3px solid var(--gold,#AE8746)', padding: '6px 10px' }}>
              <b style={{ color: '#141B22' }}>CorrFirst has no property type for {unmapped.length} propert{unmapped.length === 1 ? 'y' : 'ies'} — that column goes out blank:</b>
              <ul style={{ margin: '3px 0 0 18px', padding: 0, color: '#4B585C' }}>
                {unmapped.slice(0, 8).map((u, i) => (
                  <li key={i} className="small">{u.property}{u.ours ? ` — we have it as “${u.ours}”` : ''}</li>
                ))}
              </ul>
              {unmapped.length > 8 && <div className="small" style={{ color: '#4B585C' }}>…and {unmapped.length - 8} more.</div>}
              <div className="small" style={{ color: '#4B585C', marginTop: 3 }}>
                CorrFirst’s form only offers: SFR-Detached, SFR-Attached, Condo, 2-4 Units, PUD, Mixed-Use, Modular, Multifamily 5+,
                Industrial, Manufactured, Self Storage, Office, Retail, Warehouse, Automotive. If one of those fits, set it on the track
                record and export again; otherwise fill it in on their side.
              </div>
            </div>
          )}
          {/* A townhouse is the one shape their list has no exact value for, so it goes
              out as SFR-Attached (a one-dwelling home attached to its neighbour). Worth
              a glance, never a blocker. */}
          {judged.length > 0 && (
            <div className="notice" style={{ marginTop: 8, borderLeft: '3px solid var(--teal,#2F7F86)', padding: '6px 10px' }}>
              <b style={{ color: '#141B22' }}>{judged.length} propert{judged.length === 1 ? 'y is' : 'ies are'} sent as the closest type on CorrFirst’s list:</b>
              <ul style={{ margin: '3px 0 0 18px', padding: 0, color: '#4B585C' }}>
                {judged.slice(0, 8).map((u, i) => (
                  <li key={i} className="small">{u.property}{u.ours ? ` — we have it as “${u.ours}”` : ''}, sending “{u.value}”</li>
                ))}
              </ul>
              {judged.length > 8 && <div className="small" style={{ color: '#4B585C' }}>…and {judged.length - 8} more.</div>}
              <div className="small" style={{ color: '#4B585C', marginTop: 3 }}>
                Their list has no “Townhouse”, so a townhouse goes out as <b style={{ color: '#141B22' }}>SFR-Attached</b> — a one-home
                property attached to its neighbour. Every other property type we send is a one-for-one match with their own list.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Capital-provider data tape — fill this loan into its capital provider's own
   Excel workbook (e.g. the Fidelis Pricing Matrix / Data Tape). A loan can only
   export the tape of the provider it is CURRENTLY assigned to; the others show a
   plain reason (switch the capital provider first). */
function TapeExport({ appId }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(''); // "Exported the X tape" confirmation
  const [pending, setPending] = useState(null); // { tapeKey, name, questions, forSend } — questionnaire modal
  const [sendPending, setSendPending] = useState(null); // { tapeKey, name, answers, preview } — send-to-investor compose
  const [ln, setLn] = useState('');       // loan-number slot input
  const [lnBusy, setLnBusy] = useState(false);
  const [lnErr, setLnErr] = useState('');
  const [reqOpen, setReqOpen] = useState(false); // request-exception form open
  const [reqNote, setReqNote] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqErr, setReqErr] = useState('');
  function load() { api.staffTapesForApp(appId).then(setState).catch(() => setState({ tapes: [], currentBuyer: null, error: true })); }
  useEffect(() => { load(); }, [appId]);
  const enc = (state && state.encompass) || null;
  const exc = enc && enc.exception;              // { status:'approved'|'requested', ... } | null
  const approved = !!(exc && exc.status === 'approved');
  // Click → check whether this loan needs extra details before exporting:
  //  • New-Construction-only fields (ground-up loans), and/or
  //  • a seasoned-loan confirmation (current balance / next due / reserve).
  // If either applies, open the modal; otherwise export straight away.
  async function start(tapeKey, name, forSend) {
    setBusy(tapeKey);
    try {
      const q = await api.staffTapeQuestions(appId, tapeKey);
      const questions = (q && q.questions) || [];
      const seasoned = q && q.seasoned && q.seasoned.isSeasoned ? q.seasoned : null;
      if (questions.length || seasoned) { setPending({ tapeKey, name, questions, seasoned, supplementalMissing: (q && q.supplementalMissing) || 0, forSend: !!forSend }); setBusy(null); return; }
      if (forSend) { await openSendCompose(tapeKey, name, undefined); return; }
      await runExport(tapeKey, name, undefined);
    } catch (e) { showMessage((e.data && e.data.message) || e.message || 'Export failed'); setBusy(null); }
  }
  // The send-to-investor compose: fetch the saved contacts + subject/figure
  // preview, then open the modal. Any questionnaire answers ride along so the
  // emailed tape is built with them exactly like a download.
  async function openSendCompose(tapeKey, name, answers) {
    try {
      const preview = await api.staffTapeSendPreview(appId);
      setSendPending({ tapeKey, name, answers, preview });
    } catch (e) { showMessage((e.data && e.data.error) || e.message || 'Could not load the investor contacts.'); }
    finally { setBusy(null); }
  }
  async function runSend(tapeKey, name, answers, to, note, extra) {
    setBusy(tapeKey); setMsg('');
    try {
      const out = await api.staffTapeSend(appId, tapeKey, { ...(answers || {}), ...(extra || {}), to, note });
      setSendPending(null);
      setMsg(`Sent the ${name} tape to ${out.to.join(', ')}. Replies thread into this file.`);
    } catch (e) {
      const d = (e && e.data) || {};
      // The SAME Encompass reconciliation gate as the download — super admins may
      // allow inline with a logged reason; everyone else asks for an exception.
      if (d.code === 'encompass_override_reason_required') {
        const reason = await askPrompt(`${d.message || 'This loan doesn’t fully match Encompass yet.'}\n\nAs a super admin you can allow it — type a short reason (this is logged):`, { defaultValue: '' });
        if (reason && reason.trim()) { await runSend(tapeKey, name, answers, to, note, { ...(extra || {}), encompassOverrideReason: reason.trim() }); return; }
        setBusy(null); return;
      }
      if (d.code === 'encompass_exception_required' || d.code === 'encompass_unreconciled') {
        setSendPending(null); setReqOpen(true); load();
        setBusy(null); return;
      }
      await showMessage(d.message || d.error || e.message || 'The send failed — nothing went out.');
    }
    finally { setBusy(null); }
  }
  async function runExport(tapeKey, name, answers) {
    setBusy(tapeKey); setMsg('');
    try {
      const { blob, filename } = await api.staffTapeExport(appId, tapeKey, answers);
      saveBlob(blob, filename || `${name}-tape.xlsx`);
      setPending(null);
      setMsg(`Exported the ${name} tape. Check your downloads.`);
    } catch (e) {
      const d = (e && e.data) || {};
      // Encompass reconciliation gate (owner-directed 2026-07-26; tightened 2026-08-02):
      // the file must be in Encompass and every field matching before its tape leaves.
      // NOBODY may self-override — a super admin can allow it inline with a reason;
      // everyone else asks a super admin for an exception.
      if (d.code === 'encompass_override_reason_required') {
        // Super admin — allow it inline with a reason.
        const reason = await askPrompt(`${d.message || 'This loan doesn’t fully match Encompass yet.'}\n\nAs a super admin you can allow it — type a short reason (this is logged):`, { defaultValue: '' });
        if (reason && reason.trim()) { await runExport(tapeKey, name, { ...(answers || {}), encompassOverrideReason: reason.trim() }); return; }
        setBusy(null); return;
      }
      if (d.code === 'encompass_exception_required' || d.code === 'encompass_unreconciled') {
        // Not a super admin — ask a super admin for an exception.
        setPending(null); setReqOpen(true); load();
        setBusy(null); return;
      }
      showMessage(d.message || e.message || 'Export failed');
    }
    finally { setBusy(null); }
  }
  async function saveLoanNumber() {
    const v = String(ln || '').trim();
    setLnErr('');
    if (!v) { setLnErr('Enter the loan number.'); return; }
    setLnBusy(true);
    try { await api.staffSetLoanNumber(appId, v); setLn(''); load(); }
    catch (e) { setLnErr((e.data && e.data.error) || e.message || 'Could not save the loan number.'); }
    finally { setLnBusy(false); }
  }
  async function submitRequest() {
    const note = String(reqNote || '').trim();
    setReqErr('');
    if (!note) { setReqErr('Say why the tape needs to go out now.'); return; }
    setReqBusy(true);
    try { await api.requestTapeException(appId, { reasonNote: note }); setReqOpen(false); setReqNote(''); load(); }
    catch (e) { setReqErr((e.data && e.data.error) || e.message || 'Could not send the request.'); }
    finally { setReqBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 4 }}>
      <div className="row" style={{ marginBottom: 6, alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="small" style={{ fontWeight: 600 }}>
          This loan's capital provider: {state && (state.currentBuyer ? <strong>{state.currentBuyer}</strong> : <em>not set</em>)}
        </span>
        <button type="button" className="btn ghost small" onClick={() => goToSection('sec-overview')}
          title="Jump to File overview, where you can change this loan's capital provider, then come back here to export its tape">
          Change capital provider →
        </button>
      </div>
      <p className="muted small">
        Each capital provider has its own tape — their Excel workbook with this loan's figures filled in. You can only
        export the tape for the provider this loan is <strong>currently set to</strong>. To export a different provider's
        tape, use “Change capital provider” above, switch it on the file, then come back here and export.
      </p>
      {enc && approved && (
        <div className="small" role="status" style={{ margin: '8px 0', padding: '10px 12px', borderRadius: 8, border: '1px solid #2F7F86', background: '#EAF3F3', color: '#141B22' }}>
          <strong style={{ color: '#141B22' }}>A super admin allowed this tape to go out.</strong>{' '}
          <span style={{ color: '#3A4550' }}>You can export it now{exc && exc.expiresAt ? ` (allowed until ${fmtDay(exc.expiresAt)})` : ''}. It still needs the Encompass check the normal way — this exception is just for now.</span>
        </div>
      )}
      {enc && enc.blocked && !approved && (
        <div className="small" role="alert" style={{ margin: '8px 0', padding: '10px 12px', borderRadius: 8, border: '1px solid #E0B84C', background: '#FCF6E6', color: '#141B22' }}>
          <strong style={{ color: '#141B22' }}>The tape can’t go out until Encompass matches.</strong>{' '}
          <span style={{ color: '#3A4550' }}>{enc.message}</span>
          {/* No loan number yet → give a slot to add it, which starts the Encompass sync. */}
          {!enc.hasLoanNumber && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: '#4B585C', marginBottom: 4 }}>The loan number isn’t in the system yet. Add it here — that pulls the loan from Encompass so it can be matched.</div>
              <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={ln} onChange={(e) => setLn(e.target.value)} placeholder="YSCAP258134628"
                  style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #C9C7BE', minWidth: 190, fontSize: 14 }} />
                <button className="btn primary small" disabled={lnBusy} onClick={saveLoanNumber}>{lnBusy ? 'Saving…' : 'Save loan number'}</button>
              </div>
              {lnErr && <div style={{ color: '#B4401F', marginTop: 4 }}>{lnErr}</div>}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            {/* The comparison is a TAB of Application details, not a section —
                ask for the tab, then open the section that holds it. */}
            <button type="button" onClick={() => { requestAppDetailTab('encompass'); goToSection('sec-application'); }}
              title="Open the Encompass sync tab, reconcile every field, then come back to export"
              style={{ background: 'none', border: 'none', color: '#0B6B63', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}>
              Open the Encompass sync tab →
            </button>
          </div>
          {/* Escape hatch. Super admin: allow inline (a reason is asked at export). */}
          {enc.canOverride && (
            <div style={{ marginTop: 6, color: '#4B585C' }}>As a super admin you can allow it now — click Export and you’ll be asked for a short reason, which is logged.</div>
          )}
          {/* A request is already in a super admin's queue. */}
          {exc && exc.status === 'requested' && (
            <div style={{ marginTop: 6, color: '#4B585C' }}>A request to allow this tape is waiting for a super admin{exc.seq ? ` (EX-${exc.seq})` : ''}.</div>
          )}
          {/* Everyone else: ask a super admin for an exception. */}
          {enc.canRequestException && !(exc && exc.status === 'requested') && !reqOpen && (
            <div style={{ marginTop: 8 }}>
              <button className="btn small" onClick={() => { setReqOpen(true); setReqErr(''); }}>Ask a super admin to allow it</button>
            </div>
          )}
          {reqOpen && (
            <div style={{ marginTop: 8, borderTop: '1px solid #E7DFC5', paddingTop: 8 }}>
              <div style={{ color: '#141B22', fontWeight: 600, marginBottom: 4 }}>Ask a super admin to allow this tape</div>
              <textarea value={reqNote} onChange={(e) => setReqNote(e.target.value)} rows={3}
                placeholder="Why does the tape need to go out before Encompass matches?"
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #C9C7BE', fontSize: 14, boxSizing: 'border-box' }} />
              {reqErr && <div style={{ color: '#B4401F', marginTop: 4 }}>{reqErr}</div>}
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button className="btn primary small" disabled={reqBusy} onClick={submitRequest}>{reqBusy ? 'Sending…' : 'Send request'}</button>
                <button className="btn ghost small" disabled={reqBusy} onClick={() => { setReqOpen(false); setReqErr(''); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <p className="small" role="status" style={{ color: 'var(--teal)', fontWeight: 600 }}>✓ {msg}</p>}
      {!state ? <p className="muted small">Loading…</p> : state.error ? (
        <p className="muted small" style={{ color: 'var(--gold-ink)' }}>Couldn’t load the available tapes. Refresh to try again.</p>
      ) : (state.tapes || []).length === 0 ? (
        <p className="muted small">No tapes configured yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          {state.tapes.map((t) => (
            <div key={t.key} className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 170 }}>
                <strong>{t.name}</strong> <span className="muted small">tape</span>
                {t.available && <span className="pill done small" style={{ marginLeft: 6 }}>this loan's provider</span>}
              </div>
              {t.available ? (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn primary small" disabled={busy === t.key} onClick={() => start(t.key, t.name)}>
                    {busy === t.key ? 'Building…' : `Export the ${t.name} tape (Excel)`}
                  </button>
                  <button className="btn ghost small" disabled={busy === t.key}
                    title="Email the Excel tape to this investor's saved contacts — you pick the recipients and press Send; nothing goes out automatically"
                    onClick={() => start(t.key, t.name, true)}>
                    Send to investor…
                  </button>
                </span>
              ) : (
                <span className="row small" style={{ gap: 6, alignItems: 'center', color: 'var(--gold-ink)', flexWrap: 'wrap' }}>
                  <button className="btn small" disabled title={t.reason}>Export the {t.name} tape</button>
                  <span>{t.reason || `This loan isn't set to ${t.name}.`}</span>
                  <button type="button" onClick={() => goToSection('sec-overview')}
                    title="Jump to File overview to change the capital provider or register the correct program, then come back to export"
                    style={{ background: 'none', border: 'none', color: 'var(--teal)', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}>
                    open the file overview →
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {pending && (
        <TapeQuestionsModal
          title={pending.questions.length ? `${pending.name} tape — a few details` : `${pending.name} tape — confirm current numbers`}
          subtitle={pending.questions.length
            ? (pending.supplementalMissing > 0
                ? "This is a ground-up loan. Fill in these details — they're saved on the file and pre-filled here every time you export."
                : "These details are saved on the file and pre-filled here. Review or change anything, then export.")
            : undefined}
          questions={pending.questions}
          seasoned={pending.seasoned}
          busy={busy === pending.tapeKey}
          onCancel={() => setPending(null)}
          onSubmit={(answers) => {
            if (pending.forSend) { const p = pending; setPending(null); setBusy(p.tapeKey); openSendCompose(p.tapeKey, p.name, answers); return; }
            runExport(pending.tapeKey, pending.name, answers);
          }}
        />
      )}
      {sendPending && (
        <TapeSendModal
          name={sendPending.name}
          preview={sendPending.preview}
          busy={busy === sendPending.tapeKey}
          onCancel={() => setSendPending(null)}
          onSend={({ to, note }) => runSend(sendPending.tapeKey, sendPending.name, sendPending.answers, to, note)}
        />
      )}
    </div>
  );
}

/* MISMO 3.4 export — hand this loan file to any other system in the mortgage
   industry's shared file format. Downloads a MISMO v3.4 XML document. */
function MismoExport({ appId }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try { const { blob, filename } = await api.staffExportMismo(appId); saveBlob(blob, filename || 'MISMO_3.4.xml'); }
    catch (e) { showMessage(e.message || 'Export failed'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3>MISMO 3.4 export</h3>
        <div className="spacer" />
        <button className="btn primary" onClick={download} disabled={busy}>
          {busy ? 'Building…' : 'Export MISMO 3.4 (XML)'}
        </button>
      </div>
      <p className="muted small">
        The mortgage industry's standard file format. Downloads this loan file as a MISMO v3.4 XML document —
        borrower, property, loan terms and the vesting entity — so it can be handed to any other system that reads MISMO.
      </p>
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
