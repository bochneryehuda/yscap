import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, saveBlob } from '../../lib/api.js';
import { askConfirm, askPrompt } from '../../lib/dialog.js';
import DocPreview from '../DocPreview.jsx';

/* ONE LINE'S WHOLE STORY, IN ONE COMPONENT (mega-workspace "one screen"
   enhancement, owner-directed 2026-08-09: "every single option available on the
   full screen should also be available on the default screen … every line item
   should be openable separately to review, with all the details, the Elementix
   verify, and the documents with preview/download/reject/delete").

   THIS IS THE FULL-SCREEN WORKSPACE'S PER-LINE DETAIL, EXTRACTED so the inline
   Track Record Center (the loan file + the borrower profile) renders the SAME
   thing — parity is structural, the two can never drift. It is SELF-CONTAINED:
   it fetches its own line via `staffTrackRecordLine` (`workspace.loadLine`) and
   owns every action (Elementix "Check the records", the three pillar verdicts +
   override, verify/revoke, document preview/download/accept/reject/delete,
   request a document, internal notes, and an inline edit of the line's own
   figures). Every verdict still comes from the SERVER — this never decides which
   button is primary, never writes its own hint, never pre-judges a refusal.

   COLOURS: explicit darks. Every `--ink*` token is a LIGHT paper colour in this
   palette, so text is #141B22 / #4B585C, never a token (the white-on-white bug). */

const INK = '#141B22';
const MUTED = '#4B585C';

const day = (d) => (d ? String(d).slice(0, 10) : null);
const money = (n) => (n == null || n === '' ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));
/* A PARSER, not a formatter — answers `number | null` (the money() formatter
   below turns that into a string). Named `readNum`, matching the valuation
   screen's parser, so it never collides with the app-v2 `num` FORMATTER the
   research screens use (test-research-formatters-pure guards that boundary). */
const readNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const dealLabel = (t) => {
  const s = String(t || '').toLowerCase();
  if (s.includes('ground') || s.includes('construction')) return 'Ground-up';
  if (s.includes('hold') || s.includes('rental')) return 'Fix & Hold';
  return 'Fix & Flip';
};

/* The reviewer's at-a-glance state per pillar. `neutral` ("nothing found") is
   deliberately its own colour: painting it like `bad` would tell a reviewer we
   could not verify the borrower, when the truth is usually the county does not
   publish. This is the owner's "verified / definitely wrong / unable to verify"
   in the engine's own words (proved / contradicted / no_data). */
const TONE_STYLE = {
  good: { mark: '✓', color: '#1F6B3F', border: '#1F6B3F' },
  bad: { mark: '✗', color: '#8A2B2B', border: '#8A2B2B' },
  neutral: { mark: '–', color: '#4B585C', border: '#AE8746' },
  unknown: { mark: '?', color: '#4B585C', border: '#C9CFD3' },
};
const PILLAR_TITLE = { recency: 'Finished in the last 3 years', ownership: 'They owned it', exit: 'The exit really happened' };

const holdText = (days) => {
  const n = readNum(days);
  if (n == null) return null;
  if (n < 45) return `${n} day${n === 1 ? '' : 's'}`;
  const mo = Math.round(n / 30.44);
  return `${mo} mo`;
};

/* One labelled figure in the deal-detail grid — label over value, min-width:0 +
   overflow-wrap so a long number never pushes the row sideways (blueprint §8.2). */
function Fig({ label, value, hint, strong }) {
  if (value == null) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', color: MUTED }}>{label}</div>
      <div style={{ color: INK, fontWeight: strong ? 700 : 600, overflowWrap: 'anywhere' }}>{value}</div>
      {hint ? <div className="small" style={{ color: MUTED }}>{hint}</div> : null}
    </div>
  );
}

/* `extraActions` (optional render-prop): lens-specific buttons shown in the
   action row — the LOAN FILE injects its file verbs (request a document / raise
   an issue / post a condition on THIS file) here; the borrower PROFILE passes
   none, because its verbs (Check the records / Verify / Revoke) are native. */
export default function LineDetail({ trackRecordId, maySignOff, canDelete, role, keyboard = false, onChanged, extraActions = null }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [rowErr, setRowErr] = useState({});
  const [ask, setAsk] = useState(null);         // the typed doc-request sheet
  const [docTypes, setDocTypes] = useState([]);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [editing, setEditing] = useState(null); // the inline edit draft, or null
  const [focusPillar, setFocusPillar] = useState(0);
  const [keysOpen, setKeysOpen] = useState(false);

  /* An error goes in the banner AND on the row — in a long section the banner is
     off-screen by the time you have scrolled to the row you clicked, and a
     failed action that shows nothing reads as the click not registering. */
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 12000); };
  const rowError = (id, text) => {
    setRowErr((m) => ({ ...m, [id]: text }));
    setTimeout(() => setRowErr((m) => { const n = { ...m }; delete n[id]; return n; }), 12000);
  };

  const reload = useCallback(() => {
    if (!trackRecordId) { setDetail(null); return Promise.resolve(); }
    return api.staffTrackRecordLine(trackRecordId)
      .then((d) => { setDetail(d); setErr(''); })
      .catch((e) => { setDetail(null); setErr((e && e.message) || 'could not open that project'); });
  }, [trackRecordId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { api.staffTrackRecordDocTypes().then((d) => setDocTypes((d && d.docTypes) || [])).catch(() => {}); }, []);
  // A new line resets the transient view (focus, an open edit form).
  useEffect(() => { setFocusPillar(0); setEditing(null); }, [trackRecordId]);

  // Anything that changes the line re-reads THIS detail and tells the parent to
  // refresh its list (so the ledger/queue outside stays in step).
  const changed = () => { reload(); if (onChanged) onChanged(); };

  async function decide(card, verdict) {
    const pillarId = card.pillarId;
    setBusy(pillarId);
    try {
      let note = null;
      if (verdict === 'rejected') {
        note = await askPrompt('Why can this check not be met? The next person to read this file sees your answer.', { multiline: true });
        if (note == null) { setBusy(''); return; }
      }
      const out = await api.staffDecidePillar(pillarId, { verdict, note });
      flash(true, out && out.readiness ? out.readiness.message : 'Saved.');
      changed();
    } catch (e) { const t = (e && e.message) || 'that did not save'; flash(false, t); rowError(pillarId, t); }
    finally { setBusy(''); }
  }

  async function undo(card) {
    setBusy(card.pillarId);
    try { await api.staffDecidePillar(card.pillarId, { verdict: '' }); changed(); }
    catch (e) { const t = (e && e.message) || 'could not undo that'; flash(false, t); rowError(card.pillarId, t); }
    finally { setBusy(''); }
  }

  async function verify(status) {
    /* #9 (owner-directed, HARD RULE): a human can ALWAYS verify a project, even
       when the three checks are not all confirmed — but with a CLEAR WARNING at
       the click, so nobody signs one off believing it was fully checked. This is
       advisory only and never blocks; the one real block is the frozen 36-month
       exit rule, which the server still enforces and returns word-for-word below. */
    if (detail && detail.readiness && !detail.readiness.ready) {
      if (!(await askConfirm(
        `${detail.readiness.message}\n\nVerify ${detail.line.address} anyway? It goes on the record as verified even though the three checks are not all confirmed.`,
        { confirmLabel: 'Verify anyway', cancelLabel: 'Not yet' }))) return;
    }
    setBusy('verify');
    try {
      const out = await api.staffVerifyTrackRecord(trackRecordId, { status });
      flash(true, status === 'limited' ? 'Verified from public records.' : 'Verified — this project counts toward experience.');
      if (out && out.requestError) flash(false, out.requestError);
      changed();
    } catch (e) {
      // Real underwriting refusals — no completed exit, a future exit, an exit
      // outside the 3-year window, or not having sign-off. Shown word for word.
      const t = (e && e.message) || 'that did not save'; flash(false, t); rowError('verify', t);
    } finally { setBusy(''); }
  }

  async function revoke() {
    const reason = await askPrompt('Revoke this project’s verification. The borrower is notified with this reason:', { multiline: true });
    if (reason == null) return;
    if (!reason.trim()) { flash(false, 'A reason is required to revoke verification.'); return; }
    setBusy('verify');
    try { await api.staffVerifyTrackRecord(trackRecordId, { status: 'pending', reason: reason.trim() }); flash(true, 'Verification revoked — the borrower was notified.'); changed(); }
    catch (e) { flash(false, (e && e.message) || 'could not revoke'); }
    finally { setBusy(''); }
  }

  async function bulkConfirm() {
    if (!detail || !detail.bulk || !detail.bulk.ok) { rowError('verify', detail && detail.bulk && detail.bulk.reason); return; }
    if (!(await askConfirm(`Confirm all three checks on ${detail.line.address}? The records already prove each one.`))) return;
    setBusy('verify');
    try {
      const out = await api.staffBulkConfirmPillars(trackRecordId);
      flash(true, `${out.confirmed} check${out.confirmed === 1 ? '' : 's'} confirmed. ${out.readiness ? out.readiness.message : ''}`);
      changed();
    } catch (e) { const t = (e && e.message) || 'that did not save'; flash(false, t); rowError('verify', t); }
    finally { setBusy(''); }
  }

  /* CHECK THE RECORDS — the Elementix read the owner expected "Verify" to be:
     it reads the county's own records for THIS property and fills the three
     pillars (verify-run). It never marks the line verified — a person still
     does that. This is a DELIBERATE click; it may spend part of the office's
     shared hourly Elementix allowance, so it never fires on render. */
  async function research() {
    setBusy('research');
    try {
      const out = await api.staffResearchTrackRecord(trackRecordId);
      const errs = ((out && out.errors) || []).map((e) => e.detail || e.reason).filter(Boolean);
      flash(true, 'Checked against the public records.' + (errs.length ? ` ${errs.length} source${errs.length === 1 ? '' : 's'} could not be read.` : ''));
      changed();
    } catch (e) { flash(false, (e && e.message) || 'could not check the records'); }
    finally { setBusy(''); }
  }

  async function reviewDoc(d, action) {
    let reason;
    if (action === 'delete') {
      if (!(await askConfirm(`Permanently delete "${d.filename || 'this document'}"?\n\nThis removes it for good and it will NOT be synced to SharePoint. Use this only for a document uploaded by mistake.`))) return;
    }
    if (action === 'reject') {
      reason = await askPrompt('Why is this document being rejected? The borrower is notified and the line is un-verified until a new document is accepted.');
      if (reason == null || !reason.trim()) return;
    }
    setBusy(d.id);
    try {
      if (action === 'delete') await api.staffDeleteDoc(d.id);
      else await api.staffReviewDoc(d.id, action, reason);
      flash(true, action === 'reject' ? 'Document rejected — the borrower was notified.' : action === 'delete' ? 'Document deleted for good.' : 'Document accepted ✓');
      changed();
    } catch (e) { flash(false, (e && e.message) || 'could not review the document'); }
    finally { setBusy(''); }
  }

  async function downloadDoc(d) {
    try { const { blob, filename } = await api.staffDownloadDoc(d.id); saveBlob(blob, filename || d.filename); }
    catch (e) { flash(false, (e && e.message) || 'could not download that document'); }
  }

  async function addNote() {
    const body = await askPrompt('Internal note on this project — staff only, the borrower never sees it.', { multiline: true });
    if (body == null || !body.trim()) return;
    try { await api.staffAddTrackRecordNote({ subjectKind: 'property', subjectId: trackRecordId, body }); reload(); }
    catch (e) { flash(false, (e && e.message) || 'could not save that note'); }
  }

  function openAsk(pillar) {
    if (!detail) return;
    const t = docTypes.find((d) => d.pillars.includes(pillar)) || docTypes[0];
    setAsk({ trackRecordId, pillar, docType: t ? t.slug : '', llcId: detail.line.llcId || '', customLabel: '', internalNote: '' });
  }
  async function postRequest() {
    if (!ask || !ask.docType) return;
    setBusy('ask');
    try {
      const out = await api.staffRequestTrackRecordDocTyped(ask.trackRecordId, {
        docType: ask.docType, pillar: ask.pillar, llcId: ask.llcId || undefined,
        customLabel: ask.customLabel || undefined, internalNote: ask.internalNote || undefined,
      });
      setAsk(null);
      flash(true, out.scope === 'borrower_profile'
        ? 'Asked. It is on their profile and moves onto their next loan file automatically.'
        : 'Asked. It is now a condition on the loan file and the borrower has been told.');
      changed();
    } catch (e) { flash(false, (e && e.message) || 'could not post that request'); }
    finally { setBusy(''); }
  }

  /* INLINE EDIT of the line's own figures — the PUT door writes ONLY the columns
     the body sent and db/485 un-verifies only on a REAL material change, so
     re-sending the unchanged raw address (which the door always requires)
     resets nothing. A correction to a real figure DOES re-open the review, which
     is right — the reviewer confirmed the old numbers. */
  function startEdit() {
    const l = detail.line;
    setEditing({
      dealType: l.dealType || 'flip',
      ownedPersonally: !!l.ownedPersonally,
      entityName: l.entityName || '',
      purchasePrice: l.purchasePrice ?? '', purchaseDate: day(l.purchaseDate) || '',
      rehabAmount: l.rehabAmount ?? '',
      salePrice: l.salePrice ?? '', saleDate: day(l.saleDate) || '',
      rentAmount: l.rentAmount ?? '', rentDate: day(l.rentDate) || '',
      refiAmount: l.refiAmount ?? '', refiDate: day(l.refiDate) || '',
      addressText: '',   // blank = keep the stored address; typed = replace it
    });
  }
  async function saveEdit() {
    const e = editing; if (!e) return;
    setBusy('edit');
    try {
      const body = {
        dealType: e.dealType,
        ownedPersonally: !!e.ownedPersonally,
        entityName: e.ownedPersonally ? '' : e.entityName,
        purchasePrice: e.purchasePrice, purchaseDate: e.purchaseDate,
        rehabAmount: e.rehabAmount,
        salePrice: e.salePrice, saleDate: e.saleDate,
        rentAmount: e.rentAmount, rentDate: e.rentDate,
        refiAmount: e.refiAmount, refiDate: e.refiDate,
      };
      // THE ADDRESS IS OMITTED UNLESS THE USER TYPED A NEW ONE. A blank field
      // means "keep the stored address" (#29) — the PUT door preserves it, so we
      // never re-send (or have to reconstruct from the loaded line) an address the
      // edit isn't changing.
      if (e.addressText.trim()) body.propertyAddress = { oneLine: e.addressText.trim() };
      await api.staffUpdateTrackRecord(trackRecordId, body);
      flash(true, 'Saved. Editing a figure re-opens the review — verify it again when you’re ready.');
      setEditing(null); changed();
    } catch (ex) { flash(false, (ex && ex.message) || 'could not save the edit'); }
    finally { setBusy(''); }
  }

  /* DELETE THE WHOLE LINE (owner-directed #32) — a destructive cleanup for a
     duplicate line or a deal that plainly isn't theirs. TWO confirmations,
     because deleting a line also cascade-removes any documents attached to it
     and drops the deal from the borrower's experience count; a VERIFIED line is
     underwriting evidence, so that is called out. The server re-checks access
     (canSeeBorrowerId) and recomputes the tier. After the delete this line is
     gone, so we tell the PARENT to refresh and never reload() a dead line. */
  async function deleteLine() {
    const l = detail.line;
    const addr = l.address || 'this property';
    const docs = (detail.documents || []).length;
    const first = ['Delete this deal from the track record?', '', addr];
    if (docs) first.push('', `This also removes ${docs} document${docs === 1 ? '' : 's'} attached to this line.`);
    if (l.isVerified) first.push('', 'This line is VERIFIED — it is underwriting evidence, and deleting it lowers the borrower’s experience count.');
    if (!(await askConfirm(first.join('\n'), { title: 'Delete this line', tone: 'error', confirmLabel: 'Continue', cancelLabel: 'Keep it' }))) return;
    if (!(await askConfirm(`This cannot be undone.\n\nPermanently delete “${addr}”?`, { title: 'Delete permanently', tone: 'error', confirmLabel: 'Delete permanently', cancelLabel: 'Cancel' }))) return;
    setBusy('delete');
    try {
      await api.staffDeleteTrackRecord(trackRecordId);
      flash(true, 'Deleted.');
      if (onChanged) onChanged();
    } catch (ex) { flash(false, (ex && ex.message) || 'could not delete the line'); }
    finally { setBusy(''); }
  }

  /* THE PILLAR KEYBOARD (full-screen only): 1/2/3 focus a check, C/X confirm or
     reject the FOCUSED check, D asks for a document, ? shows the map. A key only
     ever fires an action the card's own buttons offer — never a way around a
     rule the buttons respect. Off inline (keyboard=false) so expanding a ledger
     row never hijacks the number keys. */
  useEffect(() => {
    if (!keyboard) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?') { setKeysOpen((v) => !v); e.preventDefault(); return; }
      if (e.key === 'Escape' && keysOpen) { setKeysOpen(false); return; }
      const k = e.key.toLowerCase();
      if (['1', '2', '3'].includes(k)) {
        setFocusPillar(Number(k) - 1);
        const el = document.querySelector(`[data-ld-pillar="${Number(k) - 1}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        e.preventDefault();
        return;
      }
      if (keysOpen || ask || editing || busy) return;
      if (!detail || !Array.isArray(detail.cards)) return;
      const card = detail.cards[focusPillar];
      if (!card) return;
      const offered = (verdict) => (card.next && card.next.verdict === verdict) || (card.other || []).some((o) => o.verdict === verdict);
      if (k === 'c') { if (offered('confirmed')) decide(card, 'confirmed'); else rowError(card.pillarId, 'Confirming is not offered on this check right now — use the buttons on the card.'); e.preventDefault(); }
      else if (k === 'x') { if (offered('rejected')) decide(card, 'rejected'); else rowError(card.pillarId, 'Rejecting is not offered on this check right now — use the buttons on the card.'); e.preventDefault(); }
      else if (k === 'd') { openAsk(card.pillar); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (err) return <div className="panel"><p className="small" style={{ color: '#8A2B2B', margin: 0 }}>{err}</p></div>;
  if (!detail) return <div className="panel"><p className="muted small" style={{ margin: 0 }}>Loading…</p></div>;

  const line = detail.line;
  const pp = readNum(line.purchasePrice);
  const sp = readNum(line.salePrice);
  const rehab = readNum(line.rehabAmount);
  const grossSpread = (sp != null && pp != null) ? sp - pp - (rehab || 0) : null;
  const exitFig = line.dealType && /hold|rental/i.test(line.dealType)
    ? (line.rentAmount != null
      ? { label: 'Rented', value: `${money(line.rentAmount)}/mo`, hint: day(line.rentDate) }
      : (line.refiAmount != null ? { label: 'Refinanced', value: money(line.refiAmount), hint: day(line.refiDate) }
        : (line.saleDate || sp != null ? { label: 'Sold', value: money(sp) || 'Sold', hint: day(line.saleDate) } : null)))
    : (sp != null || line.saleDate ? { label: 'Sold', value: money(sp) || 'Sold', hint: day(line.saleDate) } : null);

  return (
    <div>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 8 }}>{msg.text}</div>}

      {/* ── THE DEAL, WITH ALL THE DETAIL (owner: "all details available on the
          full screen should be here too") ─────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, color: INK, fontSize: 17 }}>{line.address}</h3>
          <span className="pill small">{dealLabel(line.dealType)}</span>
          {line.ownedPersonally
            ? <span className="pill small" title="Held under the borrower's personal name — no LLC">Personal name</span>
            : (line.entityName ? <span className="pill small" title={line.entityDocsVerified ? 'The company’s documents are complete' : 'The company’s documents are not complete yet'}>{line.entityName}{line.entityDocsVerified ? ' ✓' : ''}</span> : null)}
          {line.verificationStatus && <span className="pill small">{line.verificationStatus}</span>}
          {line.isVerified && <span className="ts-badge ok">Verified</span>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, margin: '10px 0 2px' }}>
          <Fig label="Purchase" value={money(pp)} hint={day(line.purchaseDate)} />
          <Fig label="Rehab" value={money(rehab)} />
          {exitFig && <Fig label={exitFig.label} value={exitFig.value} hint={exitFig.hint} />}
          <Fig label="Hold period" value={holdText(line.holdDays)} />
          <Fig label="Gross spread" value={money(grossSpread)} strong />
          <Fig label="Counts from" value={day(line.countsFrom) || (line.isVerified ? null : '—')} hint={line.countsFrom ? null : 'no completed exit yet'} />
        </div>

        {detail.readiness && (
          <div className="notice" style={{ marginTop: 8, background: 'rgba(47,127,134,.08)' }}>
            <strong style={{ color: INK }}>{detail.readiness.answered} of {detail.readiness.of} checks answered.</strong>{' '}
            <span style={{ color: MUTED }}>{detail.readiness.message}</span>
          </div>
        )}

        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost small" disabled={busy === 'research'} onClick={research}
            title="Read the county’s public records (Elementix) for this property — fills the three checks below. It never marks the line verified by itself.">
            {busy === 'research' ? 'Checking…' : 'Check the records (Elementix)'}
          </button>
          {maySignOff && !line.isVerified && (
            <button className="btn primary small" disabled={busy === 'verify'} onClick={() => verify('verified')}
              title="The final sign-off — this project counts toward experience. Needs a completed exit within 3 years.">Verify this project</button>
          )}
          {maySignOff && !line.isVerified && (
            <button className="btn small" disabled={busy === 'verify'} onClick={() => verify('limited')}
              title="Confirmed from public records only, with no documents on file — still counts.">Public records only</button>
          )}
          {maySignOff && !line.isVerified && detail.bulk && (
            <button className="btn small" disabled={busy === 'verify' || !detail.bulk.ok} title={detail.bulk.ok ? 'Confirm all three at once — only offered when the records already prove every one' : detail.bulk.reason} onClick={bulkConfirm}>
              Confirm all three
            </button>
          )}
          {maySignOff && line.isVerified && (
            <button className="btn ghost small" disabled={busy === 'verify'} onClick={revoke} title="Revoke this project’s verification (the borrower is notified)">Revoke verification</button>
          )}
          <button className="btn soft small" disabled={busy === 'edit'} onClick={editing ? () => setEditing(null) : startEdit}
            title="Correct the deal’s own figures — editing a figure re-opens the review.">{editing ? 'Cancel edit' : 'Edit details'}</button>
          <button className="btn ghost small" onClick={addNote}>Add an internal note</button>
          <Link className="btn ghost small" to={`/internal/borrowers/${line.borrowerId}`}>Open their profile</Link>
          {canDelete && (
            <button className="btn link small" style={{ color: 'var(--danger)' }} disabled={busy === 'delete'}
              title="Permanently delete this whole line from the track record — for a duplicate or a deal that isn’t theirs."
              onClick={deleteLine}>{busy === 'delete' ? 'Deleting…' : 'Delete this line'}</button>
          )}
          {extraActions && extraActions(line)}
        </div>
        {detail.bulk && !detail.bulk.ok && <p className="small" style={{ color: MUTED, margin: '6px 0 0' }}>{detail.bulk.reason}</p>}
        {rowErr.verify && <div className="notice err small" style={{ marginTop: 6 }}>{rowErr.verify}</div>}

        {/* INLINE EDIT — the deal's own figures. */}
        {editing && (
          <div className="panel" style={{ marginTop: 10, background: '#FBF9F4', border: '1px solid #EAE4D7' }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <label className="small" style={{ color: MUTED, flex: '1 1 220px', minWidth: 180 }}>Address (leave blank to keep it)
                <input className="input" placeholder={line.address} value={editing.addressText} onChange={(ev) => setEditing({ ...editing, addressText: ev.target.value })} />
              </label>
              <label className="small" style={{ color: MUTED, minWidth: 140 }}>Deal type
                <select className="input" value={editing.dealType} onChange={(ev) => setEditing({ ...editing, dealType: ev.target.value })}>
                  <option value="flip">Fix &amp; Flip</option>
                  <option value="hold">Fix &amp; Hold / rental</option>
                  <option value="ground_up">Ground-up</option>
                </select>
              </label>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <label className="small" style={{ color: MUTED, minWidth: 100 }}>Purchase $<input className="input" value={editing.purchasePrice} onChange={(ev) => setEditing({ ...editing, purchasePrice: ev.target.value })} /></label>
              <label className="small" style={{ color: MUTED, minWidth: 140 }}>Purchase date<input className="input" type="date" value={editing.purchaseDate} onChange={(ev) => setEditing({ ...editing, purchaseDate: ev.target.value })} /></label>
              <label className="small" style={{ color: MUTED, minWidth: 100 }}>Rehab $<input className="input" value={editing.rehabAmount} onChange={(ev) => setEditing({ ...editing, rehabAmount: ev.target.value })} /></label>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <label className="small" style={{ color: MUTED, minWidth: 100 }}>Sale $<input className="input" value={editing.salePrice} onChange={(ev) => setEditing({ ...editing, salePrice: ev.target.value })} /></label>
              <label className="small" style={{ color: MUTED, minWidth: 140 }}>Sale date<input className="input" type="date" value={editing.saleDate} onChange={(ev) => setEditing({ ...editing, saleDate: ev.target.value })} /></label>
              <label className="small" style={{ color: MUTED, minWidth: 100 }}>Rent $/mo<input className="input" value={editing.rentAmount} onChange={(ev) => setEditing({ ...editing, rentAmount: ev.target.value })} /></label>
              <label className="small" style={{ color: MUTED, minWidth: 140 }}>Rent since<input className="input" type="date" value={editing.rentDate} onChange={(ev) => setEditing({ ...editing, rentDate: ev.target.value })} /></label>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
              <label className="small" style={{ color: MUTED, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={editing.ownedPersonally} onChange={(ev) => setEditing({ ...editing, ownedPersonally: ev.target.checked })} /> Personal name (no company)
              </label>
              {!editing.ownedPersonally && (
                <label className="small" style={{ color: MUTED, flex: '1 1 200px', minWidth: 160 }}>Company / entity<input className="input" value={editing.entityName} onChange={(ev) => setEditing({ ...editing, entityName: ev.target.value })} /></label>
              )}
              <div className="spacer" />
              <button className="btn primary small" disabled={busy === 'edit'} onClick={saveEdit}>{busy === 'edit' ? 'Saving…' : 'Save changes'}</button>
            </div>
          </div>
        )}
      </div>

      {/* ── THE ELEMENTIX FINDER: the three checks, each verified / definitely-
          wrong / couldn't-verify, with the evidence and a manual override ───── */}
      {detail.cards.map((c, i) => {
        const tone = TONE_STYLE[c.tone] || TONE_STYLE.unknown;
        const pillarId = c.pillarId;
        return (
          <div className="panel" key={c.pillar} data-ld-pillar={i}
            style={{ marginBottom: 10, borderLeft: `3px solid ${tone.border}`, outline: keyboard && focusPillar === i ? '2px solid rgba(47,127,134,.55)' : 'none', outlineOffset: 2 }}>
            <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ color: tone.color, fontWeight: 700, fontSize: 16 }}>{tone.mark}</span>
              <strong style={{ color: INK }}>{i + 1} · {PILLAR_TITLE[c.pillar] || c.pillar}</strong>
              {c.humanVerdict && <span className="pill small">{c.humanVerdict === 'confirmed' ? 'Confirmed by a person' : c.humanVerdict === 'rejected' ? 'Rejected' : 'Document asked for'}</span>}
              {!c.humanVerdict && c.neutral && <span className="pill small">Nothing found — not a problem with the borrower</span>}
            </div>
            <p className="small" style={{ color: MUTED, margin: '6px 0 0' }}>{c.meaning}</p>
            {c.snippet
              ? <blockquote style={{ margin: '8px 0 0', padding: '8px 10px', borderLeft: '2px solid #C9CFD3', background: 'rgba(0,0,0,.03)', color: INK, fontSize: 13, overflowWrap: 'anywhere' }}>{c.snippet}</blockquote>
              : <p className="small" style={{ color: '#8A6D3B', margin: '8px 0 0' }}>{c.snippetNote}</p>}
            <div className="small" style={{ color: MUTED, marginTop: 6 }}>
              {[c.source ? `Source: ${c.source}` : null, c.confidence ? `confidence ${c.confidence}` : null, c.grade ? `evidence ${c.grade}` : null, c.when || null, c.carriedFromEntity ? 'carried from the company' : null].filter(Boolean).join(' · ') || 'Not checked yet'}
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {c.next.key === 'undo' || c.next.key === 'confirmed_locked'
                ? <button className="btn ghost small" disabled={busy === pillarId || c.next.key === 'confirmed_locked'} title={c.next.title} onClick={() => undo(c)}>{c.next.label}</button>
                : c.next.key === 'ask_doc'
                  ? <button className="btn primary small" title={c.next.title} onClick={() => openAsk(c.pillar)}>{c.next.label}</button>
                  : c.next.key === 'awaiting_doc'
                    ? <button className="btn ghost small" disabled title={c.next.title}>{c.next.label}</button>
                    : <button className={`btn ${c.next.tone === 'primary' ? 'primary' : 'ghost'} small`} disabled={busy === pillarId} title={c.next.title} onClick={() => (c.next.verdict ? decide(c, c.next.verdict) : openAsk(c.pillar))}>{c.next.label}</button>}
              {c.other.map((o) => (
                <button key={o.key} className="btn ghost small" disabled={busy === pillarId} title={o.title} onClick={() => (o.verdict ? decide(c, o.verdict) : openAsk(c.pillar))}>{o.label}</button>
              ))}
            </div>
            <p className="small" style={{ color: MUTED, margin: '6px 0 0' }}>{c.next.hint}</p>
            {rowErr[pillarId] && <div className="notice err small" style={{ marginTop: 6 }}>{rowErr[pillarId]}</div>}
          </div>
        );
      })}

      {/* ── DOCUMENTS (preview / download / accept / reject / delete — the same
          set as conditions), REQUESTS, FINDINGS, NOTES ─────────────────────── */}
      <div className="panel" style={{ marginBottom: 10 }}>
        <strong style={{ color: INK }}>Documents</strong>
        {detail.documents.length
          ? detail.documents.map((d) => {
            const rs = d.review_status || 'pending';
            return (
              <div className="row" key={d.id} style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid rgba(127,169,176,.15)' }}>
                <span className="small" style={{ flex: 1, minWidth: 140, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                <span className="pill small" style={rs === 'accepted' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : rs === 'rejected' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>{rs}</span>
                <button className="btn ghost small" onClick={() => setPreviewDoc(d)}>Preview</button>
                <button className="btn ghost small" onClick={() => downloadDoc(d)}>Download</button>
                {maySignOff && rs !== 'accepted' && <button className="btn primary small" disabled={busy === d.id} onClick={() => reviewDoc(d, 'accept')}>Accept</button>}
                {rs !== 'rejected' && <button className="btn link small" disabled={busy === d.id} onClick={() => reviewDoc(d, 'reject')}>Reject</button>}
                {canDelete && <button className="btn link small" style={{ color: 'var(--danger)' }} disabled={busy === d.id} title="Permanently delete — for a mistake upload (never synced to SharePoint)" onClick={() => reviewDoc(d, 'delete')}>Delete</button>}
                {rs === 'rejected' && d.rejection_reason && <span className="small" style={{ color: 'var(--danger)', width: '100%', paddingLeft: 8 }}>{d.rejection_reason}</span>}
              </div>
            );
          })
          : <p className="small" style={{ color: '#8A6D3B', margin: '6px 0 0' }}>Nothing has been uploaded on this project.</p>}

        {detail.requests.length > 0 && (
          <>
            <strong style={{ color: INK, display: 'block', marginTop: 10 }}>Asked for</strong>
            {detail.requests.map((r) => (
              <div key={r.id} className="small" style={{ color: MUTED, marginTop: 4 }}>
                <span className="pill small" style={{ marginRight: 6 }}>{r.status}</span>{r.label}
                {r.scope === 'borrower_profile' && <span style={{ color: '#8A6D3B' }}> · on their profile until a file opens</span>}
              </div>
            ))}
          </>
        )}

        {detail.findings.length > 0 && (
          <>
            <strong style={{ color: INK, display: 'block', marginTop: 10 }}>Problems found</strong>
            {detail.findings.map((f) => <div key={f.id} className="notice err small" style={{ marginTop: 4 }}>{f.title || f.code}</div>)}
          </>
        )}

        {detail.notes.length > 0 && (
          <>
            <strong style={{ color: INK, display: 'block', marginTop: 10 }}>Internal notes</strong>
            <p className="small" style={{ color: MUTED, margin: '2px 0 0' }}>Staff only — the borrower never sees these.</p>
            {detail.notes.map((n) => (
              <div key={n.id} className="small" style={{ color: n.retracted_at ? MUTED : INK, marginTop: 4, textDecoration: n.retracted_at ? 'line-through' : 'none' }}>
                {n.body}<span style={{ color: MUTED }}> — {n.author_name || 'staff'}, {day(n.created_at)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {keyboard && keysOpen && (
        <div className="cv-modal-back" onClick={() => setKeysOpen(false)}>
          <div className="cv-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h3 style={{ marginTop: 0, color: INK }}>Keyboard shortcuts</h3>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}><tbody>
              {[['1 / 2 / 3', 'Focus a check, by the number on its card'], ['C', 'Confirm the focused check — only when the card offers it'], ['X', 'Reject the focused check (asks for the reason)'], ['D', 'Ask for a document on the focused check'], ['?', 'Show or hide this map']].map(([key, what]) => (
                <tr key={key}>
                  <td style={{ padding: '6px 10px 6px 0', whiteSpace: 'nowrap' }}><code style={{ background: 'rgba(0,0,0,.05)', borderRadius: 6, padding: '2px 8px', color: INK, fontWeight: 700 }}>{key}</code></td>
                  <td className="small" style={{ padding: '6px 0', color: MUTED }}>{what}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </div>
      )}

      {ask && (
        <div className="cv-modal-back" onClick={() => setAsk(null)}>
          <div className="cv-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0, color: INK }}>Ask for a document</h3>
            <label className="small" style={{ color: MUTED, display: 'block', marginTop: 8 }}>What do you need?</label>
            <select className="input" value={ask.docType} onChange={(e) => setAsk({ ...ask, docType: e.target.value })}>
              {docTypes.filter((d) => d.pillars.includes(ask.pillar)).map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
            </select>
            {ask.docType === 'other' && <input className="input" style={{ marginTop: 6 }} placeholder="Name the document" value={ask.customLabel} onChange={(e) => setAsk({ ...ask, customLabel: e.target.value })} />}
            <label className="small" style={{ color: MUTED, display: 'block', marginTop: 8 }}>Internal note (staff only — the borrower never sees this)</label>
            <textarea className="input" rows={3} value={ask.internalNote} onChange={(e) => setAsk({ ...ask, internalNote: e.target.value })} />
            <p className="small" style={{ color: MUTED, marginTop: 8 }}>This becomes a real condition. If the borrower has no open loan file it sits on their profile and moves onto their next one automatically.</p>
            <div className="row" style={{ gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost small" onClick={() => setAsk(null)}>Cancel</button>
              <button className="btn primary small" disabled={busy === 'ask' || !ask.docType} onClick={postRequest}>Post the condition</button>
            </div>
          </div>
        </div>
      )}

      {previewDoc && (
        <DocPreview
          title={previewDoc.doc_type || previewDoc.filename || 'Document preview'}
          filename={previewDoc.filename} contentType={previewDoc.content_type}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          onDownload={() => downloadDoc(previewDoc)}
          onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
