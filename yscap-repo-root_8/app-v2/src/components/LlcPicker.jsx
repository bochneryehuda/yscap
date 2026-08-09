import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { ENTITY_TYPES, DEFAULT_ENTITY_TYPE, describeEntity, subtypesFor, hasSubtypes } from '../lib/entityType.js';

/* Pick the file's VESTING ENTITY from the borrower's reusable entity library, or
   create a new one inline. Creating one materializes its document slots (state
   formation documents, EIN letter, governing document) via the backend.
   `value` = current entity name; onPick({ id, name, entityType }) fires on
   select/create.

   AN ENTITY IS NOT ALWAYS AN LLC (owner-directed 2026-08-09). Creating a new one
   requires saying WHICH KIND it is — LLC, corporation, partnership or trust —
   because that answer decides which governing document we ask the borrower to
   upload (a corporation has bylaws and a stock certificate, never an operating
   agreement) and it is what lets the loan documents say whether the entity has
   members holding a percentage or shareholders holding shares. Picking an entity
   the borrower ALREADY has never re-asks: it keeps its own type.

   Staff mode (owner-directed 2026-07-20): pass `staff` + `borrowerId` to list and
   create against a SPECIFIC borrower's entity library (staff endpoints) instead of
   the logged-in borrower's own. With no borrowerId yet (a brand-new borrower on
   the staff new-file form) it still captures a typed entity name + type via
   onPick — the server resolves/creates the entity once the borrower exists. */
export default function LlcPicker({ value, onPick, placeholder, staff = false, borrowerId = null, entityType = '', entitySubtype = '' }) {
  const [name, setName] = useState(value || '');
  const [type, setType] = useState(entityType || '');
  const [sub, setSub] = useState(entitySubtype || '');
  const [llcs, setLlcs] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(!!value);   // an entity from the list owns its own type
  const box = useRef(null);
  const canCreate = !staff || !!borrowerId;   // staff need a borrower to create an entity

  useEffect(() => { setName(value || ''); }, [value]);
  useEffect(() => { setType(entityType || ''); }, [entityType]);
  useEffect(() => { setSub(entitySubtype || ''); }, [entitySubtype]);
  useEffect(() => {
    const load = staff ? (borrowerId ? api.staffBorrowerLlcs(borrowerId) : Promise.resolve([])) : api.llcs();
    load.then(setLlcs).catch(() => setLlcs([]));
  }, [staff, borrowerId]);
  useEffect(() => {
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = name.trim().toLowerCase();
  const matches = llcs.filter(l => (l.llc_name || '').toLowerCase().includes(q));
  const exact = llcs.find(l => (l.llc_name || '').toLowerCase() === q);

  const choose = (l) => {
    setName(l.llc_name); setOpen(false); setPicked(true);
    /* An entity they already have keeps the type it was set up with — never
       re-asked. But only a type somebody CONFIRMED travels: db/509 stamped the
       whole back book as an LLC with nobody choosing, and carrying that
       assumption out of the picker would let simply SELECTING an old entity
       record it as a human's answer. An unconfirmed one carries nothing, and the
       entity screen asks properly. */
    const stated = l.entity_type_confirmed ? (l.entity_type || '') : '';
    setType(stated); setSub(l.entity_subtype || '');
    onPick && onPick({ id: l.id, name: l.llc_name, entityType: stated || null, entitySubtype: l.entity_subtype || null });
  };
  const gate = useSubmitGate();
  async function create() {
    const nm = name.trim();
    if (!nm || busy || !type || !gate.enter()) return;   // guard against a double-tap creating two entities
    setBusy(true);
    try {
      const body = { llcName: nm, entityType: type, ...(sub ? { entitySubtype: sub } : {}) };
      const r = staff ? await api.staffCreateLlc(borrowerId, body) : await api.createLlc(body);
      const fresh = await (staff ? api.staffBorrowerLlcs(borrowerId) : api.llcs()).catch(() => llcs); setLlcs(fresh);
      setOpen(false); setPicked(true);
      onPick && onPick({ id: r.llcId || r.id, name: nm, entityType: type, entitySubtype: sub || null });
    } catch { /* leave as typed text */ }
    finally { setBusy(false); gate.leave(); }
  }

  // The type question only appears for a name that is NOT one of their existing
  // entities — asking it about an entity that already answered it is noise.
  const askType = !!q && !exact && !picked;
  const kind = type ? describeEntity({ entity_type: type }) : null;

  return (
    <div ref={box}>
      <div style={{ position: 'relative' }}>
        <input className="input" autoComplete="off" value={name} placeholder={placeholder || 'Start typing the entity name…'}
          onChange={e => {
            setName(e.target.value); setOpen(true); setPicked(false);
            onPick && onPick({ id: null, name: e.target.value, entityType: type || null, entitySubtype: sub || null });
          }}
          onFocus={() => setOpen(true)} />
        {open && (matches.length > 0 || (q && !exact)) && (
          <div className="addr-menu" role="listbox">
            {matches.map(l => (
              <div key={l.id} role="option" className="addr-item" onMouseDown={e => { e.preventDefault(); choose(l); }}>
                <span className="addr-pin">◆</span>
                <span>
                  {l.llc_name}{l.entity_type && l.entity_type !== DEFAULT_ENTITY_TYPE ? ` · ${describeEntity(l).label}` : ''}
                  {l.formation_state ? ` · ${l.formation_state}` : ''}
                  {l.is_verified ? ' · Verified ✓' : (l.completeness && Number(l.completeness.docs_uploaded) ? ` · ${l.completeness.docs_uploaded}/${l.completeness.docs_required} docs` : '')}
                </span>
              </div>
            ))}
            {q && !exact && canCreate && (
              <div role="option" className="addr-item"
                onMouseDown={e => { e.preventDefault(); create(); }}
                style={{ color: type ? 'var(--teal)' : '#4B585C', cursor: type ? 'pointer' : 'default' }}>
                <span className="addr-pin">＋</span>
                <span>{busy ? 'Creating…' : (type ? `Create “${name.trim()}”` : 'Pick the entity type below first')}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {askType && (
        <div style={{ marginTop: 8 }}>
          <label className="lbl" style={{ color: '#3A4550' }}>Entity type</label>
          <select className="input" value={type}
            onChange={e => {
              setType(e.target.value); setSub('');
              onPick && onPick({ id: null, name, entityType: e.target.value || null, entitySubtype: null });
            }}>
            <option value="">Select…</option>
            {ENTITY_TYPES.map(t => <option key={t.key} value={t.key}>{t.longLabel}</option>)}
          </select>
          {/* Only a partnership and a trust have a kind. It decides what we can
              ask them for — a revocable trust has no EIN of its own, a general
              partnership no state filing — so asking it here saves the entity
              being stuck later. */}
          {hasSubtypes(type) && (
            <select className="input" style={{ marginTop: 6 }} value={sub}
              onChange={e => {
                setSub(e.target.value);
                onPick && onPick({ id: null, name, entityType: type || null, entitySubtype: e.target.value || null });
              }}>
              <option value="">What kind? Select…</option>
              {subtypesFor(type).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          )}
          <div className="hint" style={{ color: '#4B585C' }}>
            {kind
              ? `We'll ask for its ${kind.governingDocWord}${kind.usesShares ? ' and stock certificate' : ''}, state formation documents and EIN letter.`
              : 'This decides which documents we ask for — a corporation uploads bylaws and a stock certificate where an LLC uploads an operating agreement.'}
          </div>
        </div>
      )}
    </div>
  );
}
