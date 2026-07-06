import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* Borrower's reusable entities (LLCs). Lists every LLC with formation details,
   verification status, and document count, and lets the borrower add a new
   entity or fill in details (EIN / formation state / date / ownership) they
   left blank when they first created it by name in the application. Entities
   are reusable across every file — the same database the application picker
   reads from. */

const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];

function Row({ llc, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ ein: llc.ein || '', formationState: llc.formation_state || '', formationDate: llc.formation_date ? String(llc.formation_date).slice(0, 10) : '', ownershipPct: llc.ownership_pct || '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true); setErr('');
    try { await api.updateLlc(llc.id, f); setEdit(false); onSaved && onSaved(); }
    catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }

  return (
    <div className="ent-row">
      <div className="ent-main">
        <div className="ent-name">{llc.llc_name}</div>
        <div className="muted small">
          {llc.formation_state ? llc.formation_state : 'State —'}
          {llc.ein ? ' · EIN on file' : ' · no EIN'}
          {llc.ownership_pct ? ` · ${llc.ownership_pct}% owned` : ''}
          {Number(llc.doc_count) > 0 ? ` · ${llc.doc_count} doc${Number(llc.doc_count) === 1 ? '' : 's'}` : ''}
        </div>
        {edit && (
          <div className="ts-inputs" style={{ marginTop: 8 }}>
            <label><span>EIN</span><input className="input" value={f.ein} placeholder="XX-XXXXXXX" onChange={e => setF({ ...f, ein: e.target.value })} /></label>
            <label><span>Formation state</span>
              <select className="input" value={f.formationState} onChange={e => setF({ ...f, formationState: e.target.value })}>
                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label><span>Formation date</span><input className="input" type="date" value={f.formationDate} onChange={e => setF({ ...f, formationDate: e.target.value })} /></label>
            <label><span>Your ownership %</span><input className="input" type="number" min="0" max="100" value={f.ownershipPct} onChange={e => setF({ ...f, ownershipPct: e.target.value })} /></label>
          </div>
        )}
        {err && <div className="notice err" style={{ marginTop: 6 }}>{err}</div>}
      </div>
      <div className="ent-act">
        <span className={`ts-badge ${llc.is_verified ? 'ok' : 'warn'}`}>{llc.is_verified ? 'Verified' : 'Unverified'}</span>
        {edit
          ? <><button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
              <button className="btn link small" onClick={() => setEdit(false)}>Cancel</button></>
          : <button className="btn ghost small" onClick={() => setEdit(true)}>Edit details</button>}
      </div>
    </div>
  );
}

export default function Entities() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [f, setF] = useState({ llcName: '', ein: '', formationState: '', formationDate: '', ownershipPct: '' });
  const [busy, setBusy] = useState(false);

  const load = () => api.llcs().then(r => setRows(r || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function add() {
    if (!f.llcName.trim()) { setErr('Entity name is required.'); return; }
    setBusy(true); setErr('');
    try { await api.createLlc(f); setF({ llcName: '', ein: '', formationState: '', formationDate: '', ownershipPct: '' }); setShowAdd(false); await load(); }
    catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginBottom: 10 }}>Your entities (LLCs)</h3>
      {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {rows == null ? <p className="muted small">Loading…</p>
        : rows.length === 0 ? <p className="muted small">No entities yet. Add the LLC(s) you borrow through — they're reused on every file, and we'll collect their formation documents once.</p>
          : <div className="ent-list">{rows.map(l => <Row key={l.id} llc={l} onSaved={load} />)}</div>}

      {!showAdd && <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setShowAdd(true)}>+ Add an entity</button>}
      {showAdd && (
        <div className="tr-add">
          <div className="ts-inputs">
            <label style={{ gridColumn: '1 / -1' }}><span>Entity name</span><input className="input" value={f.llcName} placeholder="e.g. 1420 Bedford Holdings LLC" onChange={e => setF({ ...f, llcName: e.target.value })} /></label>
            <label><span>EIN</span><input className="input" value={f.ein} placeholder="XX-XXXXXXX" onChange={e => setF({ ...f, ein: e.target.value })} /></label>
            <label><span>Formation state</span>
              <select className="input" value={f.formationState} onChange={e => setF({ ...f, formationState: e.target.value })}>
                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label><span>Formation date</span><input className="input" type="date" value={f.formationDate} onChange={e => setF({ ...f, formationDate: e.target.value })} /></label>
            <label><span>Your ownership %</span><input className="input" type="number" min="0" max="100" value={f.ownershipPct} onChange={e => setF({ ...f, ownershipPct: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add entity'}</button>
            <button className="btn link" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
