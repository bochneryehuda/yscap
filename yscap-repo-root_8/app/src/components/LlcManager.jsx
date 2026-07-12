import React, { useEffect, useRef, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import DocPreview from './DocPreview.jsx';
import { fileToBase64 } from '../lib/files.js';

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
    onDrop: (e) => { e.preventDefault(); setOver(false); const f = Array.from(e.dataTransfer.files || []); if (f.length) onDropFiles(f); },
  } : {};
  const d = slot.document_id ? slot : null;
  const rs = d ? slot.review_status : null;
  const pill = !d ? { text: 'Not uploaded', style: undefined }
    : rs === 'accepted' ? { text: 'Accepted ✓', style: { borderColor: 'var(--ok)', color: 'var(--ok)' } }
    : rs === 'rejected' ? { text: 'Rejected', style: { borderColor: 'var(--danger)', color: 'var(--danger)' } }
    : { text: 'In review', style: { borderColor: 'var(--gold)', color: 'var(--gold)' } };
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

export default function LlcManager({ llcId, onChanged, compactHeader, staff = false }) {
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
      });
      setMembers((l.members || []).map(m => ({ fullName: m.full_name, ownershipPct: String(m.ownership_pct), email: m.email || '' })));
    }).catch(e => { if (idRef.current === forId) setErr(e.message || 'Could not load this LLC'); });
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
        fullName: m.fullName.trim(), ownershipPct: Number(m.ownershipPct), email: m.email.trim() || undefined,
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
  if (!llc || !f) return <p className="muted small">Loading LLC…</p>;

  const readOnly = !!llc.read_only;   // a co-borrower viewing the primary's entity
  const locked = !!llc.is_verified || readOnly;
  const badge = llcBadge(llc);
  const own = pctNum(f.ownershipPct);
  const memberTotal = (members || []).reduce((s, m) => s + pctNum(m.ownershipPct), 0);
  const total = own + memberTotal;
  const needsMembers = f.ownershipPct !== '' && own < 100;
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
          This LLC is verified — its details, ownership and documents are locked and reused automatically on every loan.
          Ask your loan team if something needs to change.
        </p>
      )}
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}

      {/* ---- entity details ---- */}
      <div className="ts-inputs">
        <label style={{ gridColumn: '1 / -1' }}><span>Entity name</span>
          <input className="input" value={f.llcName} disabled={locked} onChange={e => setF({ ...f, llcName: e.target.value })} /></label>
        <label><span>EIN</span>
          <input className="input" value={f.ein} placeholder="XX-XXXXXXX" disabled={locked} onChange={e => setF({ ...f, ein: e.target.value })} /></label>
        <label><span>Formation state</span>
          <select className="input" value={f.formationState} disabled={locked} onChange={e => setF({ ...f, formationState: e.target.value })}>
            <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select></label>
        <label><span>Formation date</span>
          <input className="input" type="date" value={f.formationDate} disabled={locked} onChange={e => setF({ ...f, formationDate: e.target.value })} /></label>
        <label><span>Your ownership %</span>
          <input className="input" type="number" min="0" max="100" value={f.ownershipPct} disabled={locked} onChange={e => setF({ ...f, ownershipPct: e.target.value })} /></label>
      </div>
      {!locked && <button className="btn primary small" style={{ marginTop: 8 }} disabled={busy === 'details'} onClick={saveDetails}>{busy === 'details' ? 'Saving…' : 'Save details'}</button>}

      {/* ---- ownership structure: who owns the rest? ---- */}
      {needsMembers && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600 }}>Ownership structure</div>
          <p className="muted small" style={{ marginBottom: 8 }}>
            You own {own}% — tell us who owns the remaining {Math.max(0, Math.round((100 - own) * 100) / 100)}%.
            Every member and their percentage, until the total is 100%.
          </p>
          {(members || []).map((m, i) => (
            <div className="row" key={i} style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <input className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Member full name" value={m.fullName} disabled={locked}
                onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, fullName: e.target.value } : x))} />
              <input className="input" style={{ width: 110 }} type="number" min="0.01" max="99.99" placeholder="%" value={m.ownershipPct} disabled={locked}
                onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, ownershipPct: e.target.value } : x))} />
              <input className="input" style={{ flex: 2, minWidth: 160 }} type="email" placeholder="Email (optional)" value={m.email} disabled={locked}
                onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
              {!locked && <button className="btn link small" onClick={() => setMembers(ms => ms.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          ))}
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!locked && <button className="btn ghost small" onClick={() => setMembers(ms => [...(ms || []), { fullName: '', ownershipPct: '', email: '' }])}>+ Add a member</button>}
            {!locked && <button className="btn primary small" disabled={busy === 'members'} onClick={saveMembers}>{busy === 'members' ? 'Saving…' : 'Save ownership'}</button>}
            <span className={`ts-badge ${Math.abs(total - 100) <= 0.01 ? 'ok' : 'warn'}`}>
              {Math.abs(total - 100) <= 0.01 ? 'Ownership totals 100% ✓' : total > 100 ? `Over 100% by ${Math.round((total - 100) * 100) / 100}%` : `${remaining}% still unaccounted for`}
            </span>
          </div>
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
