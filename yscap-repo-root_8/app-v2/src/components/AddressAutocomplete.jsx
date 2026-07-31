import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* Typeahead address input backed by our own /api/address/suggest (the provider
   key stays server-side). `value`/`onChange` drive the text; `onPick` fires with
   { line1, city, state, zip, country } when a suggestion is chosen. Degrades to a
   plain input if the lookup is unavailable.

   The suggestion menu is PORTALED to <body> and FIXED-positioned against the
   input's bounding rect (owner-directed 2026-07-12) so it can never be clipped by
   an ancestor's overflow (the "only 1 address / too short" bug) and never covers
   the field itself (the "pops up on top of the text bar" bug). It repositions on
   scroll/resize and flips above the field when there isn't room below. */
export default function AddressAutocomplete({ value, onChange, onPick, placeholder, className, autoFocus }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [provider, setProvider] = useState('');
  const [pos, setPos] = useState(null);          // { top, left, width, flip }
  // USPS verification of the PICKED address (the authoritative standardizer). null
  // until a pick is verified; then 'verified' | 'corrected' | 'unverified'. States
  // that mean "the feature isn't on / had a hiccup" (not_configured/error/rate_limited)
  // stay silent so the form never nags when USPS isn't active yet.
  const [usps, setUsps] = useState(null);        // { status } | null
  const seq = useRef(0);
  const timer = useRef(null);
  const vseq = useRef(0);
  const inputRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Close on an outside click — but the menu now lives in <body>, so it must be
  // excluded from "outside" too (checked via menuRef, not the input wrapper).
  useEffect(() => {
    function onDoc(e) {
      const inInput = inputRef.current && inputRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inInput && !inMenu) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function place() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const mh = menuRef.current ? menuRef.current.offsetHeight : 0;
    const below = vh - r.bottom, above = r.top;
    const flip = mh && below < mh + 8 && above > below;
    setPos({ left: Math.round(r.left), width: Math.round(r.width), top: Math.round(flip ? r.top - mh - 4 : r.bottom + 4), flip });
  }

  // Reposition while open (scroll of ANY ancestor uses capture) + on resize.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestions.length]);

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
      // Same staleness guard as the success path: a slow earlier request that
      // fails must not wipe a newer request's results.
      .catch(() => { if (mine !== seq.current) return; setSuggestions([]); setOpen(false); });
  }
  function onInput(e) {
    const v = e.target.value;
    onChange && onChange(v);
    if (usps) setUsps(null);                    // editing invalidates the last USPS check
    vseq.current++;                             // and any in-flight verify result
    clearTimeout(timer.current);
    if (v.trim().length < 3) { setOpen(false); setSuggestions([]); return; }
    timer.current = setTimeout(() => runQuery(v.trim()), 250);
  }
  // Standardize a picked/entered address against USPS. If USPS confirms it (and
  // maybe fixes the spelling/ZIP) we hand the USPS-correct address to onPick and
  // update the visible field; if USPS can't confirm (or isn't set up) we keep what
  // was picked. Never blocks: the pick already applied before this runs.
  async function verifyWithUsps(addr) {
    const mine = ++vseq.current;
    setUsps(null);
    try {
      const r = await fetch('/api/address/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });
      const j = await r.json();
      if (mine !== vseq.current) return;                 // a newer pick won
      if (j && j.configured && (j.status === 'verified' || j.status === 'corrected')) {
        // Always adopt the USPS response. Even an "already correct" input may
        // gain ZIP+4 or canonical USPS abbreviations.
        if (j.address) {
          onChange && onChange(j.address.line1 || value);
          onPick && onPick(j.address);
        }
        setUsps({ status: j.status });
      } else if (j && j.configured && j.status === 'unverified') {
        setUsps({ status: 'unverified' });
      } else {
        setUsps(null);                                   // not_configured / error / rate_limited → silent
      }
    } catch { if (mine === vseq.current) setUsps(null); }
  }

  async function pick(s) {
    setOpen(false);
    setUsps(null);
    let addr = s.address;
    if (!addr && s.id) {
      try { const j = await (await fetch('/api/address/details?id=' + encodeURIComponent(s.id))).json(); addr = j.address; }
      catch { addr = null; }
    }
    if (addr) { onChange && onChange(addr.line1 || value); onPick && onPick(addr); verifyWithUsps(addr); }
    else { onChange && onChange(s.label); }
  }
  function onKey(e) {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(suggestions[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  const menu = open && pos ? createPortal(
    <div className="addr-menu" role="listbox" ref={menuRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, right: 'auto', marginTop: 0, zIndex: 2147483000, maxHeight: 'min(320px, 44vh)', overflowY: 'auto' }}>
      {suggestions.map((s, i) => (
        <div key={s.id || i} role="option" aria-selected={i === active}
          className={'addr-item' + (i === active ? ' active' : '')}
          onMouseDown={e => { e.preventDefault(); pick(s); }}
          onMouseEnter={() => setActive(i)}>
          <span className="addr-pin">●</span><span>{s.label}</span>
        </div>
      ))}
      <div className="addr-foot">Address lookup{provider === 'google' ? ' · Google' : provider === 'smarty' ? ' · Smarty' : ' · OpenStreetMap'}</div>
    </div>,
    document.body
  ) : null;

  // Tiny USPS status line under the field. Dark text on the white portal (never a
  // light var(--ink*) token). Green = USPS-confirmed, amber = couldn't confirm.
  const uspsBadge = usps ? (
    <div style={{ marginTop: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, lineHeight: 1.3,
      color: usps.status === 'unverified' ? '#8A6D1F' : '#256168' }}>
      <span aria-hidden="true">{usps.status === 'unverified' ? '⚠' : '✓'}</span>
      <span>{usps.status === 'verified' ? 'USPS verified'
        : usps.status === 'corrected' ? 'USPS verified — corrected to the official mailing address'
        : "Couldn't verify this address with USPS — please double-check it"}</span>
    </div>
  ) : null;

  return (
    <div style={{ position: 'relative' }}>
      <input ref={inputRef} className={className || 'input'} value={value || ''} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete="off" onChange={onInput} onKeyDown={onKey}
        onFocus={() => { if (suggestions.length) setOpen(true); }} />
      {uspsBadge}
      {menu}
    </div>
  );
}
