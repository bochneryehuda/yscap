import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import LlcManager, { llcBadge } from './LlcManager.jsx';
import { ENTITY_TYPES, DEFAULT_ENTITY_TYPE, describeEntity, subtypesFor, hasSubtypes } from '../lib/entityType.js';

/* The borrower's reusable ENTITIES — the full entity section of the profile.
   Every entity the borrower owns lives here with its formation details, its
   ownership structure (owners until 100%), and its three document slots (state
   formation documents / IRS EIN letter / governing document). This is the single
   source of truth: applications, track records and conditions all link back to
   these, and a staff-verified entity auto-fulfills the entity condition on every
   file it vests.

   AN ENTITY IS NOT ALWAYS AN LLC (owner-directed 2026-08-09). Which kind it is —
   LLC, corporation, partnership or trust — decides which governing document we
   ask for, so it is asked at creation rather than assumed. */

function EntityCard({ llc, onChanged }) {
  const [open, setOpen] = useState(false);
  const badge = llcBadge(llc);
  const c = llc.completeness || {};
  return (
    <div className="ent-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', width: '100%' }}>
        <div className="ent-main">
          <div className="ent-name">{llc.llc_name}</div>
          <div className="muted small">
            {/* The kind is only worth a chip when it is not the ordinary answer —
                printing "LLC" on every row of a list that is mostly LLCs is noise. */}
            {llc.entity_type && llc.entity_type !== DEFAULT_ENTITY_TYPE ? `${describeEntity(llc).label} · ` : ''}
            {llc.formation_state || 'State —'}
            {llc.ein ? ' · EIN on file' : ' · no EIN'}
            {llc.ownership_pct != null ? ` · ${llc.ownership_pct}% owned${(llc.members || []).length ? ` +${llc.members.length} member${llc.members.length === 1 ? '' : 's'}` : ''}` : ''}
            {` · ${c.docs_accepted || 0}/${c.docs_required || 3} docs accepted`}
          </div>
        </div>
        <span className={`ts-badge ${badge.cls}`}>{badge.text}</span>
        <button className="btn ghost small" onClick={() => setOpen(o => !o)}>{open ? 'Close' : llc.is_verified ? 'View' : 'Set up'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10, width: '100%' }}>
          <LlcManager llcId={llc.id} compactHeader onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

export default function Entities() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [sub, setSub] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.llcs().then(r => setRows(r || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function add() {
    if (busy) return;   // double-Enter must not create duplicate entities
    if (!name.trim()) { setErr('Entity name is required.'); return; }
    if (!type) { setErr('Pick what kind of entity it is — it decides which documents we ask for.'); return; }
    setBusy(true); setErr('');
    try {
      await api.createLlc({ llcName: name.trim(), entityType: type, ...(sub ? { entitySubtype: sub } : {}) });
      setName(''); setType(''); setSub(''); setShowAdd(false); await load();
    }
    catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <h3 style={{ marginBottom: 4 }}>Your entities</h3>
        <div className="spacer" />
        <Link className="btn ghost small" to="/entities" title="The full entities section — status, linked loans, good standing, and more">Open full section →</Link>
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        Each entity needs its details, full ownership structure, and three documents — state formation
        documents, the IRS EIN letter, and its governing document (an operating agreement for an LLC,
        bylaws and a stock certificate for a corporation). Once your loan team verifies an entity, it
        fulfills the entity condition on every loan automatically.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {rows == null ? <p className="muted small">Loading…</p>
        : rows.length === 0 ? <p className="muted small">No entities yet. Add the one(s) you borrow through — they're reused on every file, and we'll collect their formation documents once.</p>
          : <div className="ent-list">{rows.map(l => <EntityCard key={l.id} llc={l} onChanged={load} />)}</div>}

      {!showAdd && <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setShowAdd(true)}>+ Add an entity</button>}
      {showAdd && (
        <div className="tr-add">
          <div className="ts-inputs">
            <label style={{ gridColumn: '1 / -1' }}><span>Entity name</span>
              <input className="input" value={name} placeholder="e.g. 1420 Bedford Holdings LLC"
                onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} /></label>
            <label style={{ gridColumn: '1 / -1' }}><span>Entity type</span>
              <select className="input" value={type} onChange={e => { setType(e.target.value); setSub(''); }}>
                <option value="">Select…</option>
                {ENTITY_TYPES.map(t => <option key={t.key} value={t.key}>{t.longLabel}</option>)}
              </select>
              {/* Only a partnership and a trust have a kind — and it decides what
                  we can ask for, so it is worth the one extra question. */}
              {hasSubtypes(type) && (
                <select className="input" style={{ marginTop: 6 }} value={sub} onChange={e => setSub(e.target.value)}>
                  <option value="">What kind? Select…</option>
                  {subtypesFor(type).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              )}
              <span className="muted small" style={{ color: '#4B585C' }}>
                {type ? `We'll ask for its ${describeEntity({ entity_type: type }).governingDocWord}${describeEntity({ entity_type: type }).usesShares ? ' and stock certificate' : ''}.`
                  : 'This decides which documents we ask for.'}
              </span></label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add entity'}</button>
            <button className="btn link" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>You'll fill in the EIN, ownership and documents right after.</p>
        </div>
      )}
    </div>
  );
}
