import React, { useEffect, useRef, useState } from 'react';

/* Typeahead address input backed by our own /api/address/suggest (the provider
   key stays server-side). `value`/`onChange` drive the text; `onPick` fires with
   { line1, city, state, zip, country } when a suggestion is chosen. Degrades to a
   plain input if the lookup is unavailable. */
export default function AddressAutocomplete({ value, onChange, onPick, placeholder, className, autoFocus }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [provider, setProvider] = useState('');
  const seq = useRef(0);
  const timer = useRef(null);
  const box = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    function onDoc(e) { if (box.current && !box.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function runQuery(q) {
    const mine = ++seq.current;
    fetch('/api/address/suggest?q=' + encodeURIComponent(q))
      .then(r => r.json())
      .then(j => {
        if (mine !== seq.current) return;
        setProvider(j.provider || '');
        setSuggestions(j.suggestions || []);
        setActive(-1);
        setOpen(!!(j.suggestions && j.suggestions.length));
      })
      .catch(() => { setSuggestions([]); setOpen(false); });
  }
  function onInput(e) {
    const v = e.target.value;
    onChange && onChange(v);
    clearTimeout(timer.current);
    if (v.trim().length < 3) { setOpen(false); setSuggestions([]); return; }
    timer.current = setTimeout(() => runQuery(v.trim()), 250);
  }
  async function pick(s) {
    setOpen(false);
    let addr = s.address;
    if (!addr && s.id) {
      try { const j = await (await fetch('/api/address/details?id=' + encodeURIComponent(s.id))).json(); addr = j.address; }
      catch { addr = null; }
    }
    if (addr) { onChange && onChange(addr.line1 || value); onPick && onPick(addr); }
    else { onChange && onChange(s.label); }
  }
  function onKey(e) {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(suggestions[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input className={className || 'input'} value={value || ''} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete="off" onChange={onInput} onKeyDown={onKey}
        onFocus={() => { if (suggestions.length) setOpen(true); }} />
      {open && (
        <div className="addr-menu" role="listbox">
          {suggestions.map((s, i) => (
            <div key={s.id || i} role="option" aria-selected={i === active}
              className={'addr-item' + (i === active ? ' active' : '')}
              onMouseDown={e => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}>
              <span className="addr-pin">●</span><span>{s.label}</span>
            </div>
          ))}
          <div className="addr-foot">Address lookup{provider === 'google' ? ' · Google' : provider === 'smarty' ? ' · Smarty' : ' · OpenStreetMap'}</div>
        </div>
      )}
    </div>
  );
}
