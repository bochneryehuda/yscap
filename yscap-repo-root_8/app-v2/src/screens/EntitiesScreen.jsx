import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import LlcManager, { llcBadge, US_STATES } from '../components/LlcManager.jsx';

/* Your entities (LLCs) — the full, standalone section. Every LLC the borrower
   borrows through lives here as its own card: formation details, EIN, the
   ownership structure, the document set (including the Certificate of Good
   Standing), which loan files it vests, and its verification state. The same
   entities power the Profile section, every file's LLC condition, and the
   track record's entity linking — one database, set up once, reused forever. */

const mask = (ein) => ein ? `••-•••${String(ein).replace(/\D/g, '').slice(-4)}` : null;
const dt = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null;

function EntityCard({ llc, apps, onChanged, startOpen }) {
  const [open, setOpen] = useState(!!startOpen);
  const badge = llcBadge(llc);
  const c = llc.completeness || {};
  const linked = apps.filter(a => a.llc_id === llc.id);
  const gs = (llc.slots || []).find(s => /good standing/i.test(s.label || ''));
  const docsPct = Math.min(100, Math.round(((c.docs_accepted || 0) / (c.docs_required || 3)) * 100));
  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{llc.llc_name}</h3>
            <span className={`ts-badge ${badge.cls}`}>{badge.text}</span>
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            {[
              llc.formation_state ? `Formed in ${llc.formation_state}` : 'Formation state —',
              dt(llc.formation_date) ? `on ${dt(llc.formation_date)}` : null,
              mask(llc.ein) ? `EIN ${mask(llc.ein)}` : 'no EIN yet',
              llc.ownership_pct != null ? `you own ${llc.ownership_pct}%${(llc.members || []).length ? ` + ${llc.members.length} member${llc.members.length === 1 ? '' : 's'}` : ''}` : 'ownership —',
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button className="btn ghost small" onClick={() => setOpen(o => !o)}>{open ? 'Close' : llc.is_verified ? 'View entity' : 'Manage entity'}</button>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <span className={`reqchip ${docsPct >= 100 ? 'met' : 'short'}`}>
          {c.docs_accepted || 0}/{c.docs_required || 3} documents accepted
        </span>
        {gs && (
          <span className={`reqchip ${gs.review_status === 'accepted' ? 'met' : ''}`}
            title={gs.is_required === false ? 'Optional unless your loan team requires it' : 'Required on this entity'}>
            Good standing: {gs.document_id ? (gs.review_status === 'accepted' ? 'on file ✓' : 'in review') : (gs.is_required === false ? 'optional' : 'needed')}
          </span>
        )}
        <span className={`reqchip ${linked.length ? 'met' : ''}`}>
          {linked.length ? `Vesting ${linked.length} loan file${linked.length === 1 ? '' : 's'}` : 'Not vesting any file yet'}
        </span>
        {llc.is_verified && <span className="reqchip met">✓ Auto-fulfills the LLC condition on every loan</span>}
      </div>
      <div className="progress" style={{ marginTop: 10 }}>
        <div className="progress-fill" style={{ width: `${llc.is_verified ? 100 : docsPct}%` }} />
      </div>

      {linked.length > 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>
          Vesting: {linked.map(a => {
            const pa = a.property_address || {};
            return pa.oneLine || [pa.street || pa.line1, pa.city].filter(Boolean).join(', ') || a.ys_loan_number || 'a file';
          }).join(' · ')}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <LlcManager llcId={llc.id} compactHeader onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

export default function EntitiesScreen() {
  const [rows, setRows] = useState(null);
  const [apps, setApps] = useState([]);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [f, setF] = useState({ name: '', state: '', date: '', ein: '', pct: '' });
  const [busy, setBusy] = useState(false);
  const [openNewId, setOpenNewId] = useState(null);

  const load = () => Promise.all([
    api.llcs().then(r => setRows(r || [])),
    api.applications().then(a => setApps(a || [])).catch(() => {}),
  ]).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function add() {
    if (busy) return;   // double-Enter must not create duplicate entities
    if (!f.name.trim()) { setErr('Entity name is required.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createLlc({
        llcName: f.name.trim(),
        formationState: f.state || undefined,
        formationDate: f.date || undefined,
        ein: f.ein || undefined,
        ownershipPct: f.pct === '' ? undefined : Number(f.pct),
      });
      setF({ name: '', state: '', date: '', ein: '', pct: '' });
      setShowAdd(false);
      setOpenNewId(r.llcId || null);
      await load();
    } catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); }
  }

  const verified = (rows || []).filter(l => l.is_verified).length;

  return (
    <>
      <div className="row" style={{ marginBottom: 14, alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1>Your entities (LLCs)</h1>
          <p className="muted small" style={{ margin: 0 }}>
            The LLCs you borrow through — details, ownership and formation documents collected once,
            verified by your loan team, and reused automatically on every loan.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setShowAdd(s => !s)}>{showAdd ? 'Cancel' : '+ Add an entity'}</button>
      </div>

      {rows != null && (
        <div className="kpi-row">
          <div className="kpi"><div className="kpi-v">{rows.length}</div><div className="kpi-k">Entities on file</div></div>
          <div className="kpi"><div className="kpi-v">{verified}</div><div className="kpi-k">Verified ✓</div></div>
          <div className="kpi"><div className="kpi-v">{apps.filter(a => a.llc_id).length}</div><div className="kpi-k">Files vesting in them</div></div>
        </div>
      )}

      {err && <div role="alert" className="notice err">{err}</div>}

      {showAdd && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 10 }}>New entity</h3>
          <div className="ts-inputs">
            <label style={{ gridColumn: '1 / -1' }}><span>Entity name</span>
              <input className="input" value={f.name} placeholder="e.g. 1420 Bedford Holdings LLC"
                onChange={e => setF({ ...f, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && add()} /></label>
            <label><span>Formation state</span>
              <select className="input" value={f.state} onChange={e => setF({ ...f, state: e.target.value })}>
                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
            <label><span>Formation date</span>
              <input className="input" type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
            <label><span>EIN</span>
              <input className="input" placeholder="XX-XXXXXXX" value={f.ein} onChange={e => setF({ ...f, ein: e.target.value })} /></label>
            <label><span>Your ownership %</span>
              <input className="input" type="number" min="0" max="100" value={f.pct} onChange={e => setF({ ...f, pct: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add entity'}</button>
            <span className="muted small">You can fill in the rest — members and the three documents — right after.</span>
          </div>
        </div>
      )}

      {rows == null ? <div className="panel muted">Loading…</div>
        : rows.length === 0 ? (
          <div className="panel">
            <p className="muted" style={{ margin: 0 }}>
              No entities yet. Add the LLC(s) you borrow through — we collect each one's formation
              documents once, your loan team verifies it, and it clears the LLC condition on every
              future loan automatically.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {rows.map(l => <EntityCard key={l.id} llc={l} apps={apps} onChanged={load} startOpen={l.id === openNewId} />)}
          </div>
        )}

      <p className="muted small" style={{ marginTop: 16 }}>
        Each entity needs its details, a full ownership structure (to 100%), and three documents —
        state formation documents, the IRS EIN letter, and the operating agreement. A Certificate of
        Good Standing is optional unless your loan team requires one for a specific closing.
      </p>
    </>
  );
}
