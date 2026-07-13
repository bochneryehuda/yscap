import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';

/* Pick a vesting entity / LLC from the borrower's reusable LLC database, or
   create a new one inline. Creating a new LLC materializes its required
   documents (EIN letter, formation docs, operating agreement) via the backend.
   `value` = current LLC name; onPick({ id, name }) fires on select/create. */
export default function LlcPicker({ value, onPick, placeholder }) {
  const [name, setName] = useState(value || '');
  const [llcs, setLlcs] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);

  useEffect(() => { setName(value || ''); }, [value]);
  useEffect(() => { api.llcs().then(setLlcs).catch(() => {}); }, []);
  useEffect(() => {
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = name.trim().toLowerCase();
  const matches = llcs.filter(l => (l.llc_name || '').toLowerCase().includes(q));
  const exact = llcs.find(l => (l.llc_name || '').toLowerCase() === q);

  const choose = (l) => { setName(l.llc_name); setOpen(false); onPick && onPick({ id: l.id, name: l.llc_name }); };
  const gate = useSubmitGate();
  async function create() {
    const nm = name.trim();
    if (!nm || busy || !gate.enter()) return;   // guard against a double-tap creating two LLCs
    setBusy(true);
    try {
      const r = await api.createLlc({ llcName: nm });
      const fresh = await api.llcs().catch(() => llcs); setLlcs(fresh);
      setOpen(false);
      onPick && onPick({ id: r.llcId, name: nm });
    } catch { /* leave as typed text */ }
    finally { setBusy(false); gate.leave(); }
  }

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input className="input" autoComplete="off" value={name} placeholder={placeholder || 'Start typing your LLC name…'}
        onChange={e => { setName(e.target.value); setOpen(true); onPick && onPick({ id: null, name: e.target.value }); }}
        onFocus={() => setOpen(true)} />
      {open && (matches.length > 0 || (q && !exact)) && (
        <div className="addr-menu" role="listbox">
          {matches.map(l => (
            <div key={l.id} role="option" className="addr-item" onMouseDown={e => { e.preventDefault(); choose(l); }}>
              <span className="addr-pin">◆</span>
              <span>
                {l.llc_name}{l.formation_state ? ` · ${l.formation_state}` : ''}
                {l.is_verified ? ' · Verified ✓' : (l.completeness && Number(l.completeness.docs_uploaded) ? ` · ${l.completeness.docs_uploaded}/${l.completeness.docs_required} docs` : '')}
              </span>
            </div>
          ))}
          {q && !exact && (
            <div role="option" className="addr-item" onMouseDown={e => { e.preventDefault(); create(); }} style={{ color: 'var(--teal)' }}>
              <span className="addr-pin">＋</span><span>{busy ? 'Creating…' : `Create new LLC “${name.trim()}”`}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
