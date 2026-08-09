import React, { useEffect, useRef, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import DocPreview from './DocPreview.jsx';
import { fileToBase64 } from '../lib/files.js';
import { onFilesDropped } from '../lib/drop-files.js';
import { EmailInput } from './FormattedInputs.jsx';
import { ENTITY_TYPES, describeEntity, entityTypeAssumed, titlesFor, subtypesFor } from '../lib/entityType.js';

/* One LLC, fully managed: entity details, ownership structure (the borrower's
   own % plus every other member until it totals 100%), and the three fixed
   document slots (state formation docs / IRS EIN letter / operating
   agreement). Used on the borrower profile (Entities) AND inside a loan
   file's LLC condition — same entity, same data, everywhere.

   Server shape (GET /api/borrower/llcs/:id): the llcs row + members[] +
   slots[] (one per requirement, with the slot's CURRENT document + its
   review_status) + completeness {info_complete, ownership_complete,
   docs_uploaded, docs_accepted, ready_to_verify, ...}. */

export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];

const pctNum = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

/* Overall badge for one LLC bundle. */
export function llcBadge(llc) {
  if (llc.is_verified) return { cls: 'ok', text: 'Verified ✓' };
  const c = llc.completeness || {};
  if (c.docs_rejected > 0) return { cls: 'err', text: 'Needs attention' };
  if (c.ready_to_verify || (c.docs_uploaded >= c.docs_required && c.info_complete && c.ownership_complete))
    return { cls: 'warn', text: 'In review' };
  return { cls: 'warn', text: 'Setup incomplete' };
}

function SlotRow({ llc, slot, onPick, onDownload, onPreview, dlBusy, uploading, locked, onDropFiles }) {
  const [over, setOver] = useState(false);
  const canDrop = !locked && !!onDropFiles;
  const drop = canDrop ? {
    onDragOver: (e) => { e.preventDefault(); if (!over) setOver(true); },
    onDragLeave: (e) => { if (e.currentTarget === e.target) setOver(false); },
    onDrop: (e) => { e.preventDefault(); setOver(false); onFilesDropped(e, onDropFiles); },
  } : {};
  const d = slot.document_id ? slot : null;
  const rs = d ? slot.review_status : null;
  const pill = !d ? { text: 'Not uploaded', style: undefined }
    : rs === 'accepted' ? { text: 'Accepted ✓', style: { borderColor: 'var(--ok)', color: 'var(--ok)' } }
    : rs === 'rejected' ? { text: 'Rejected', style: { borderColor: 'var(--danger)', color: 'var(--danger)' } }
    : { text: 'In review', style: { borderColor: 'var(--gold)', color: 'var(--gold-ink)' } };
  return (
    <div className={`checkitem${canDrop ? ' cond-drop' : ''}${over ? ' drop-over' : ''}`} style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }} {...drop}>
      {over && canDrop && <div className="drop-hint">Drop file to upload</div>}
      <span className={`dot ${rs === 'accepted' ? 'done' : 'outstanding'}`} style={{ marginTop: 5, ...(rs === 'rejected' ? { background: 'var(--danger)' } : {}) }} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 600 }}>
          {slot.label}
          {slot.is_required === false && <span className="muted small" style={{ fontWeight: 400 }}> · optional</span>}
        </div>
        {slot.hint && <div className="muted small">{slot.hint}</div>}
        {d && <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{slot.filename} · {new Date(slot.uploaded_at).toLocaleDateString()}</div>}
        {rs === 'rejected' && slot.rejection_reason && (
          <div className="small" style={{ color: 'var(--danger)' }}>Needs a new version: {slot.rejection_reason}</div>
        )}
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span className="pill" style={pill.style}>{pill.text}</span>
        {d && <button className="btn ghost small" title="Preview" onClick={() => onPreview(slot)}>Preview</button>}
        {d && <button className="btn ghost small" disabled={dlBusy === slot.document_id} onClick={() => onDownload(slot)}>{dlBusy === slot.document_id ? '…' : '⤓'}</button>}
        {!locked && (
          <button className="btn ghost small" disabled={uploading} onClick={() => onPick(slot)}>{d ? 'Replace' : 'Upload PDF'}</button>
        )}
      </div>
    </div>
  );
}

// Ownership chains (layered entities) are capped server-side at 5 layers;
// the UI stops offering deeper nesting one step earlier.
const MAX_NESTED_DEPTH = 4;

export default function LlcManager({ llcId, onChanged, compactHeader, staff = false, depth = 0, coBorrower = null }) {
  // Staff and borrower hit different route namespaces for the SAME entity actions.
  // This component was hard-wired to the borrower endpoints, so rendering it in a
  // staff surface (the CRM entity section) 403'd ("borrower only"). The `staff`
  // prop routes every call to the staff equivalents.
  const A = staff ? {
    get: (id) => api.staffLlc(id),
    update: (id, b) => api.staffUpdateLlc(id, b),
    members: (id, m) => api.staffSaveLlcMembers(id, m),
    upload: (b) => api.staffUploadLlcDoc(b.llcId, b),
    download: (id) => api.staffDownloadDoc(id),
  } : {
    get: (id) => api.llc(id),
    update: (id, b) => api.updateLlc(id, b),
    members: (id, m) => api.saveLlcMembers(id, m),
    upload: (b) => api.uploadDoc(b),
    download: (id) => api.downloadDoc(id),
  };
  const [llc, setLlc] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [dlBusy, setDlBusy] = useState(null);
  const [previewSlot, setPreviewSlot] = useState(null);   // LLC doc being previewed
  const [f, setF] = useState(null);            // details form state
  const [members, setMembers] = useState(null); // members form state
  const fileRef = useRef(null);
  const slotRef = useRef(null);
  // This component is reused across llcId changes (e.g. switching the file's
  // vesting entity) — guard against a stale response rendering under the new id.
  const idRef = useRef(llcId); idRef.current = llcId;

  const load = () => {
    const forId = llcId;
    return A.get(llcId).then(l => {
      if (idRef.current !== forId) return;
      setLlc(l);
      setF({
        llcName: l.llc_name || '', ein: l.ein || '', formationState: l.formation_state || '',
        formationDate: l.formation_date ? String(l.formation_date).slice(0, 10) : '',
        ownershipPct: l.ownership_pct == null ? '' : String(l.ownership_pct),
        // WHAT KIND OF COMPANY (owner-directed 2026-08-09). Blank when nobody has
        // chosen — db/494 stamped the back book as an LLC without anybody saying
        // so, and showing that assumption pre-selected would turn it into a fact
        // the first time somebody pressed Save without looking at it.
        entityType: l.entity_type_confirmed ? (l.entity_type || '') : '',
        // Which KIND of partnership or trust. Unlike the type, this is never
        // assumed by a migration — a value here was always typed by a person.
        entitySubtype: l.entity_subtype || '',
      });
      setMembers((l.members || []).map(m => ({
        fullName: m.full_name, ownershipPct: String(m.ownership_pct), email: m.email || '',
        memberKind: m.member_kind === 'entity' ? 'entity' : 'person',
        ownerLlcId: m.owner_llc_id || null,
        // Who they are on the signature line, and — for a corporation — what they
        // hold. STAFF-ONLY: the borrower's editor never renders or sends these.
        memberTitle: m.member_title || '', shares: m.shares == null ? '' : String(m.shares),
        certificateNumber: m.certificate_number || '',
      })));
    }).catch(e => { if (idRef.current === forId) setErr(e.message || 'Could not load this entity'); });
  };
  useEffect(() => { setLlc(null); setF(null); setMembers(null); setErr(''); load(); /* eslint-disable-next-line */ }, [llcId]);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  async function saveDetails() {
    setBusy('details'); setErr('');
    try { await A.update(llcId, f); flash('Saved ✓'); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(''); }
  }
  async function saveMembers() {
    setBusy('members'); setErr('');
    try {
      // The borrower's own % lives in the details form — save it together with
      // the members so "Save ownership" never reverts an unsaved percentage.
      await A.update(llcId, f);
      await A.members(llcId, members.filter(m => m.fullName.trim()).map(m => ({
        fullName: m.fullName.trim(), ownershipPct: Number(m.ownershipPct),
        email: m.memberKind === 'entity' ? undefined : (m.email.trim() || undefined),
        memberKind: m.memberKind === 'entity' ? 'entity' : 'person',
        // An id pins the exact entity; a name alone finds-or-creates it in
        // this borrower's library (renaming the row re-resolves by name).
        ownerLlcId: m.memberKind === 'entity' ? (m.ownerLlcId || undefined) : undefined,
        ownerLlcName: m.memberKind === 'entity' ? m.fullName.trim() : undefined,
        /* STAFF-ONLY, and sent as keys rather than values so a blank deliberately
           CLEARS one. A holding company has no title and holds no certificate —
           it signs through its own people, recorded on its own row — so an entity
           owner is skipped entirely. The server ignores these keys on the
           borrower's door, but not sending them at all is the honest half: the
           borrower's editor cannot see them, so it must not appear to answer. */
        ...(staff && m.memberKind !== 'entity' ? {
          memberTitle: m.memberTitle || '',
          shares: m.shares === '' ? null : m.shares,
          certificateNumber: m.certificateNumber || '',
        } : {}),
      })));
      flash('Ownership saved ✓'); await load(); onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not save the members'); }
    finally { setBusy(''); }
  }

  const pickSlot = (slot) => { slotRef.current = slot; fileRef.current && fileRef.current.click(); };
  // Shared by the file picker AND drag-and-drop: upload every file to this slot
  // (a condition can hold several documents).
  async function uploadToSlot(fileList, slot) {
    const files = Array.from(fileList || []);
    if (!files.length || !slot) return;
    setBusy('upload'); setErr('');
    try {
      for (const file of files) {
        await A.upload({
          llcId, checklistItemId: slot.item_id,
          filename: file.name, contentType: file.type, dataBase64: await fileToBase64(file),
        });
      }
      flash(files.length > 1 ? `Uploaded ${files.length} files ✓` : 'Uploaded ✓'); await load(); onChanged && onChanged();
    } catch (e2) { setErr(e2.message || 'Upload failed'); }
    // slotRef is NOT cleared here: pickSlot always re-arms it, and clearing it
    // in this finally could race a second slot's file dialog already open.
    finally { setBusy(''); if (fileRef.current) fileRef.current.value = ''; }
  }
  const onFile = (e) => uploadToSlot((e.target && e.target.files) || [], slotRef.current);
  async function downloadSlot(slot) {
    setDlBusy(slot.document_id);
    try { const { blob, filename } = await A.download(slot.document_id); saveBlob(blob, filename || slot.filename); }
    catch (e) { setErr(e.message || 'Download failed'); }
    finally { setDlBusy(null); }
  }

  if (err && !llc) return <div role="alert" className="notice err">{err}</div>;
  if (!llc || !f) return <p className="muted small">Loading entity…</p>;

  const readOnly = !!llc.read_only;   // a co-borrower viewing the primary's entity
  const locked = !!llc.is_verified || readOnly;
  const badge = llcBadge(llc);
  /* WHAT THIS ENTITY IS, as the screen should speak about it. Reads the value
     being EDITED first so switching the type re-words the owners section
     immediately, before Save — otherwise picking "Corporation" leaves the page
     still asking for members and offering an LLC's titles. */
  const kind = describeEntity({ entity_type: f.entityType || llc.entity_type, entity_subtype: f.entitySubtype || llc.entity_subtype });
  const own = pctNum(f.ownershipPct);
  const ownSet = f.ownershipPct !== '';
  const memberTotal = (members || []).reduce((s, m) => s + pctNum(m.ownershipPct), 0);
  const total = own + memberTotal;
  const needsMembers = ownSet && own < 100;
  // Keep the ownership + LAYERED-ENTITY editor visible whenever the entity is
  // editable, even at 100% personal ownership — so "owned by another LLC" is
  // always discoverable, not hidden the moment someone claims 100% (owner-directed:
  // the layered-entity capability must show everywhere an entity appears).
  const showOwnership = ownSet && (needsMembers || (!locked && depth < MAX_NESTED_DEPTH));
  const remaining = Math.round((100 - total) * 100) / 100;

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
        {!compactHeader && <div className="ent-name" style={{ fontSize: 17 }}>{llc.llc_name}</div>}
        <span className={`ts-badge ${badge.cls}`}>{badge.text}</span>
        {(llc.completeness || {}).gs_expired &&
          <span className="ts-badge warn" title="The Certificate of Good Standing on file is more than 30 days old — upload a current one. The entity stays verified.">Good standing expired</span>}
        <div className="spacer" />
        {msg && <span className="muted small">{msg}</span>}
      </div>
      {readOnly ? (
        <p className="muted small" style={{ marginBottom: 10 }}>
          This entity is managed by the primary borrower on your file — you can see its progress here.
        </p>
      ) : locked && (
        <p className="muted small" style={{ marginBottom: 10 }}>
          This entity is verified — its details, ownership and documents are locked and reused automatically on every loan.
          Ask your loan team if something needs to change.
        </p>
      )}
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
      {/* NOBODY HAS SAID WHAT THIS COMPANY IS. Everything behaves as an LLC in
          the meantime (which it usually is), but the documents we ask for and
          the words on the loan documents both hang off this one answer, so the
          screen admits it is assuming rather than staying quiet about it. */}
      {!locked && entityTypeAssumed(llc) && (
        <p className="muted small" style={{ marginBottom: 8, color: '#4B585C' }}>
          We have this entity down as an <strong>LLC</strong> because that is what almost every entity here is —
          nobody has confirmed it. If it is a corporation, a partnership or a trust, set the entity type below and
          we will ask for the right documents.
        </p>
      )}

      {/* ---- entity details ---- */}
      <div className="ts-inputs">
        <label style={{ gridColumn: '1 / -1' }}><span>Entity name</span>
          <input className="input" value={f.llcName} disabled={locked} onChange={e => setF({ ...f, llcName: e.target.value })} /></label>
        {/* WHAT KIND OF COMPANY THIS IS (owner-directed 2026-08-09). It decides
            which governing document we ask for — a corporation has bylaws and a
            stock certificate, an LLC an operating agreement — so it sits next to
            the name rather than buried. Blank until somebody chooses: the whole
            back book was stamped as an LLC by the migration with nobody saying
            so, and a pre-selected guess would become a stated fact on the next
            Save. Saving a type re-labels the entity's document slots. */}
        <label><span>Entity type</span>
          <select className="input" value={f.entityType} disabled={locked}
            onChange={e => setF({ ...f, entityType: e.target.value, entitySubtype: '' })}>
            <option value="">Select…</option>
            {ENTITY_TYPES.map(t => <option key={t.key} value={t.key}>{t.longLabel}</option>)}
          </select></label>
        {/* WHICH KIND — only a partnership and a trust have one, and it earns its
            place: a REVOCABLE living trust has no EIN of its own (it uses the
            grantor's Social Security number) and a GENERAL partnership is filed
            with no state, so this is what stops us demanding documents that do
            not exist and leaving the entity permanently unverifiable. It also
            decides what the loan documents call it. */}
        {kind.hasSubtypes && (
          <label><span>What kind of {kind.label.toLowerCase()}?</span>
            <select className="input" value={f.entitySubtype || ''} disabled={locked}
              onChange={e => setF({ ...f, entitySubtype: e.target.value })}>
              <option value="">Select…</option>
              {subtypesFor(f.entityType || llc.entity_type).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select></label>
        )}
        <label><span>EIN</span>
          <input className="input" value={f.ein} placeholder="XX-XXXXXXX" disabled={locked} onChange={e => setF({ ...f, ein: e.target.value })} /></label>
        <label><span>{kind.stateLabel}</span>
          <select className="input" value={f.formationState} disabled={locked} onChange={e => setF({ ...f, formationState: e.target.value })}>
            <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select></label>
        <label><span>{kind.dateLabel}</span>
          <input className="input" type="date" value={f.formationDate} disabled={locked} onChange={e => setF({ ...f, formationDate: e.target.value })} /></label>
        <label><span>Your ownership %</span>
          <input className="input" type="number" min="0" max="100" value={f.ownershipPct} disabled={locked} onChange={e => setF({ ...f, ownershipPct: e.target.value })} /></label>
      </div>
      {!locked && <button className="btn primary small" style={{ marginTop: 8 }} disabled={busy === 'details'} onClick={saveDetails}>{busy === 'details' ? 'Saving…' : 'Save details'}</button>}

      {/* Co-borrower quick-split (owner-directed 2026-07-21): when the file has
          a CO-BORROWER and this LLC doesn't already list them, offer a one-
          click 50/50 split. Rendered OUTSIDE the showOwnership gate so a FRESH
          LLC (borrower hasn't typed their own % yet) still surfaces the prompt
          — the whole point is to avoid the manual add. Clicking sets the
          borrower to 50%, adds the co-borrower as a 50% member, and OPENS the
          Ownership structure section (by seeding ownershipPct). User can then
          edit either % or click "Save ownership" as usual. */}
      {(() => {
        if (locked || !coBorrower || !String(coBorrower.fullName || '').trim()) return null;
        const already = (members || []).some((m) =>
          m.memberKind !== 'entity'
          && String(m.fullName || '').trim().toLowerCase() === String(coBorrower.fullName).trim().toLowerCase());
        if (already) return null;
        const currentOwn = ownSet ? own : null;
        const applySplit = () => {
          setF((s) => ({ ...s, ownershipPct: '50' }));
          setMembers((ms) => [
            ...(ms || []),
            { fullName: coBorrower.fullName, ownershipPct: '50',
              email: coBorrower.email || '', memberKind: 'person', ownerLlcId: null },
          ]);
        };
        return (
          <div className="notice" role="status"
            style={{ marginTop: 12, marginBottom: 4, background: 'var(--primary-soft, rgba(47,127,134,.06))',
              borderLeft: '3px solid var(--teal, #2F7F86)', padding: '10px 12px', borderRadius: 8,
              display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="small" style={{ fontWeight: 600, color: 'var(--ivory)' }}>
                Two borrowers on this file
              </div>
              <div className="small muted" style={{ marginTop: 2 }}>
                Split the entity 50/50 with {coBorrower.fullName} to start — you can adjust either
                percentage after adding.
              </div>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted small">
                {currentOwn == null ? 'You haven\'t set your % yet' : `Currently ${currentOwn}% you`}
              </span>
              <button className="btn primary small" onClick={applySplit}
                aria-label={`Split ownership 50/50 with ${coBorrower.fullName}`}>
                <span aria-hidden="true" style={{ marginRight: 4 }}>⇋</span>
                Split 50/50 with {coBorrower.fullName.split(' ')[0]}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ---- ownership structure (incl. layered entities): who owns the rest? ---- */}
      {showOwnership && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600 }}>Ownership structure</div>
          <p className="muted small" style={{ marginBottom: 8 }}>
            {needsMembers
              ? <>You own {own}% — tell us who owns the remaining {Math.max(0, Math.round((100 - own) * 100) / 100)}%. Every {kind.ownerNoun} and their percentage, until the total is 100%.</>
              : <>You own 100%. If this entity is actually owned by <strong>another entity</strong> (a layered entity), lower your % and add it below as an entity owner — it gets its own section, details and three documents.</>}
          </p>
          {/* (Co-borrower quick-split moved above the ownership gate so a fresh entity still surfaces it.) */}
          {(members || []).map((m, i) => (
            <div className="row" key={i} style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
              <input className="input" style={{ flex: 2, minWidth: 160 }}
                placeholder={m.memberKind === 'entity' ? 'Owning entity name — e.g. Holdings Group LLC' : `${kind.ownerNoun.charAt(0).toUpperCase()}${kind.ownerNoun.slice(1)} full name`}
                value={m.fullName} disabled={locked}
                onChange={e => setMembers(ms => ms.map((x, j) => j === i
                  // Renaming an entity member re-resolves by name — drop the pin.
                  ? { ...x, fullName: e.target.value, ...(x.memberKind === 'entity' ? { ownerLlcId: null } : {}) }
                  : x))} />
              <input className="input" style={{ width: 110 }} type="number" min="0.01" max={m.memberKind === 'entity' ? 100 : 99.99} placeholder="%" value={m.ownershipPct} disabled={locked}
                onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, ownershipPct: e.target.value } : x))} />
              {m.memberKind !== 'entity' && (
                <EmailInput style={{ flex: 2, minWidth: 160 }} placeholder="Email (optional)" value={m.email} disabled={locked}
                  onChange={v => setMembers(ms => ms.map((x, j) => j === i ? { ...x, email: v } : x))} />
              )}
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: locked || depth >= MAX_NESTED_DEPTH ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                title="Layered entity: this slice is owned by ANOTHER COMPANY, not a person. Saving opens a full entity section for it — its details, its owners, and its three documents.">
                <input type="checkbox" checked={m.memberKind === 'entity'} disabled={locked || (m.memberKind !== 'entity' && depth >= MAX_NESTED_DEPTH)}
                  onChange={e => setMembers(ms => ms.map((x, j) => j === i
                    ? { ...x, memberKind: e.target.checked ? 'entity' : 'person', ownerLlcId: null, email: '' }
                    : x))} />
                This owner is a company
              </label>
              {!locked && <button className="btn link small" onClick={() => setMembers(ms => ms.filter((_, j) => j !== i))}>Remove</button>}
              {/* ---- WHO SIGNS, AND AS WHAT — STAFF ONLY (owner-directed 2026-08-09).
                  The owner asked for this to be "only for the staff side to fill
                  out", and it belongs there: the title prints under the signature
                  line on every recorded instrument and DocLab merges it verbatim,
                  so it is a DROPDOWN and never a text box — "managing member",
                  "Managing Member" and "MGR" must not all be reachable. The share
                  count and the certificate number are the CORPORATION's analogue
                  of the percentage: a corporation issues numbered stock
                  certificates and the pledge of that ownership has to name the
                  exact certificate being handed over, the way a mortgage names
                  the exact property. A company owner is skipped — it holds no
                  title and no certificate; it signs through its own people, who
                  are recorded on its own row. ---- */}
              {staff && m.memberKind !== 'entity' && (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', width: '100%', paddingLeft: 4 }}>
                  <select className="input" style={{ flex: 1, minWidth: 180 }} value={m.memberTitle || ''} disabled={locked}
                    aria-label={`Title for ${m.fullName || 'this owner'}`}
                    onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, memberTitle: e.target.value } : x))}>
                    <option value="">Title — not set</option>
                    {titlesFor(f.entityType || llc.entity_type).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {kind.usesShares && (
                    <>
                      <input className="input" style={{ width: 130 }} type="number" min="1" step="1" placeholder="Shares"
                        value={m.shares || ''} disabled={locked} aria-label={`Shares held by ${m.fullName || 'this owner'}`}
                        onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, shares: e.target.value } : x))} />
                      <input className="input" style={{ width: 170 }} placeholder="Certificate no."
                        value={m.certificateNumber || ''} disabled={locked} aria-label={`Stock certificate number for ${m.fullName || 'this owner'}`}
                        onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, certificateNumber: e.target.value } : x))} />
                    </>
                  )}
                  {!m.memberTitle && (
                    <span className="muted small" style={{ color: '#4B585C' }}>
                      A title is needed before the closing package can be drafted.
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!locked && <button className="btn ghost small" onClick={() => setMembers(ms => [...(ms || []), { fullName: '', ownershipPct: '', email: '', memberKind: 'person', ownerLlcId: null, memberTitle: '', shares: '', certificateNumber: '' }])}>+ Add {kind.ownerNoun === 'member' ? 'a member' : `a ${kind.ownerNoun}`}</button>}
            {!locked && <button className="btn primary small" disabled={busy === 'members'} onClick={saveMembers}>{busy === 'members' ? 'Saving…' : 'Save ownership'}</button>}
            <span className={`ts-badge ${Math.abs(total - 100) <= 0.01 ? 'ok' : 'warn'}`}>
              {Math.abs(total - 100) <= 0.01 ? 'Ownership totals 100% ✓' : total > 100 ? `Over 100% by ${Math.round((total - 100) * 100) / 100}%` : `${remaining}% still unaccounted for`}
            </span>
          </div>
        </div>
      )}

      {/* ---- layered entities: each SAVED entity member opens its owning LLC
           as a full nested entity section — details, ownership (which can
           itself contain entity members, recursively) and the three document
           slots. Verification is bottom-up: owners verify before this one. ---- */}
      {depth < MAX_NESTED_DEPTH && (llc.members || []).some(m => m.member_kind === 'entity' && m.owner_llc_id) && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600 }}>Owning entities (layered)</div>
          <p className="muted small" style={{ marginBottom: 8 }}>
            {llc.llc_name} is partly owned by the entit{(llc.members || []).filter(m => m.member_kind === 'entity' && m.owner_llc_id).length === 1 ? 'y' : 'ies'} below.
            Complete each one exactly like any entity — details, full ownership, and its three documents. An owning entity must be verified before {llc.llc_name} can be.
          </p>
          {(llc.members || []).filter(m => m.member_kind === 'entity' && m.owner_llc_id).map(m => (
            <div key={m.id} style={{ marginBottom: 12, padding: '12px 14px', border: '1px solid var(--line, rgba(127,169,176,.25))', borderLeft: '3px solid var(--teal, #4E777F)', borderRadius: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{m.owner_llc_name || m.full_name}</span>
                <span className="pill small">owns {m.ownership_pct}% of {llc.llc_name}</span>
              </div>
              <LlcManager llcId={m.owner_llc_id} staff={staff} depth={depth + 1} compactHeader
                onChanged={() => { load(); onChanged && onChanged(); }} />
            </div>
          ))}
        </div>
      )}

      {/* ---- the three document slots ---- */}
      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 600 }}>Entity documents</div>
          <span className="muted small">{(llc.completeness || {}).docs_accepted || 0}/{(llc.completeness || {}).docs_required || 3} accepted</span>
        </div>
        <p className="muted small" style={{ marginBottom: 4 }}>
          Uploaded once here, reviewed by your loan team, and reused automatically on every loan this LLC takes title on.
        </p>
        <input ref={fileRef} type="file" multiple accept=".pdf,application/pdf,image/*" style={{ display: 'none' }} onChange={onFile} />
        {(llc.slots || []).map(s => (
          <SlotRow key={s.item_id} llc={llc} slot={s} onPick={pickSlot} onDownload={downloadSlot}
            onPreview={setPreviewSlot} dlBusy={dlBusy} uploading={busy === 'upload'} locked={locked}
            onDropFiles={(files) => uploadToSlot(files, s)} />
        ))}
        {busy === 'upload' && <p className="muted small">Uploading…</p>}
      </div>
      {previewSlot && (
        <DocPreview title={previewSlot.label} filename={previewSlot.filename}
          load={() => A.download(previewSlot.document_id)}
          onDownload={() => downloadSlot(previewSlot)}
          onClose={() => setPreviewSlot(null)} />
      )}
    </div>
  );
}
