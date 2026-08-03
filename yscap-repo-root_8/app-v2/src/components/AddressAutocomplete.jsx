import React, { useCallback, useEffect, useRef, useState } from 'react';
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
export default function AddressAutocomplete({ value, onChange, onPick, placeholder, className, autoFocus,
  withPosition = false, onPosition, staleKey }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [provider, setProvider] = useState('');
  const [pos, setPos] = useState(null);          // { top, left, width, flip }
  // WHERE THE PICKED ADDRESS IS. Only resolved when the caller asks for it
  // (`withPosition`), because a screen that just wants the text should not fire a
  // geocoder lookup on every pick. null = not asked / not resolved yet;
  // { lat, lng, source } = placed; { lat: null, why } = looked and could not.
  const [position, setPosition] = useState(null);
  // THE CURRENT PICK, HELD IN REFS AND REPORTED FROM ONE PLACE. Three independent
  // things improve a pick after it is made — the details lookup, USPS standardising
  // the text, and the position lookup — and they finish in whatever order the
  // network gives them. Reporting from each one separately means the LAST to
  // finish wins, so a slow USPS answer used to erase the position and a slow
  // position lookup used to erase the USPS correction. `report()` merges the best
  // of both every time, so arrival order stops mattering.
  const addrRef = useRef(null);                  // the best TEXT we have for this pick
  const posRef = useRef(null);                   // the position that pick carries, if any
  const pseq = useRef(0);
  const withPos = (addr, p) => (p && p.lat != null && p.lng != null
    ? { ...addr, lat: p.lat, lng: p.lng, positionSource: p.source || null }
    : { ...addr });
  /* EVERY REPORT SAYS WHAT IT LEARNED, because the three of them learn different
     things and a consumer that treats them alike overwrites the user's own work.
       'pick'         — the address the user chose. Everything is new.
       'standardized' — USPS corrected the TEXT of that address. It is the
                        authority on that address's town and ZIP, so a consumer
                        should adopt them.
       'position'     — a coordinate arrived, and NOTHING else was learned. A
                        consumer that re-applied the address here would revert
                        whatever the user typed in the second since the pick,
                        silently and with no explanation. */
  const report = (kind) => {
    if (!addrRef.current) return;
    onPick && onPick({ ...withPos(addrRef.current, posRef.current), reportKind: kind });
  };
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
    const next = { left: Math.round(r.left), width: Math.round(r.width), top: Math.round(flip ? r.top - mh - 4 : r.bottom + 4), flip: !!flip };
    // IDEMPOTENT. `place` runs on every scroll event and on the menu attaching, so
    // an unconditional setState would re-render the whole field on every scroll
    // tick — and would make the measure-on-attach below an infinite loop.
    setPos((cur) => (cur && cur.left === next.left && cur.width === next.width
      && cur.top === next.top && cur.flip === next.flip ? cur : next));
  }

  /* MEASURE THE MENU ONCE IT EXISTS — the flip-above decision needs its height,
     and on the first open there is nothing to measure yet.
     The menu renders only when `open && pos`, and `pos` only exists after
     `place()` has run — so on the first open `place()` necessarily measured a
     menu that was not in the DOM, took its height as 0, and could never decide to
     flip. The consequence was invisible until an address box landed low on a tall
     page: the field sat at y=688 in a 720px window, the menu was pinned
     (position:fixed) at y=739, and the suggestions were simply off the bottom of
     the screen with no way to scroll to them — you could type and nothing would
     ever appear. It only ever worked because scrolling re-ran `place()` with the
     menu present by then.
     A callback ref fires the moment the element attaches, which is the only point
     at which the height is knowable — the same reason CompMap measures its box
     with one. `place` reads refs and calls an idempotent setter, so capturing the
     first render's copy is safe and the empty dep list keeps the ref stable. */
  const attachMenu = useCallback((el) => {
    menuRef.current = el;
    if (el) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* THE PICK IS STALE — told from OUTSIDE, because only the screen can know.
   *
   * Typing over the address line already drops everything (`onInput`). But a
   * research screen keeps the town, state and ZIP in its OWN boxes, and correcting
   * one of those invalidates the coordinate just as surely: pick "26 S 10th St,
   * Brooklyn NY", change the town to Queens, and the position that arrives a beat
   * later measures from Brooklyn while the search filters Queens. The screen nulls
   * its own copy, and without this the autocomplete's refs still held the pick and
   * the next late report put it straight back.
   *
   * A change to `staleKey` clears the pick exactly as retyping does — same three
   * lines, so the two paths cannot drift. The mount pass is skipped: an initial
   * value is not a change. */
  const staleSeen = useRef(staleKey);
  useEffect(() => {
    if (staleSeen.current === staleKey) return;
    staleSeen.current = staleKey;
    addrRef.current = null;
    posRef.current = null;
    pseq.current++;
    vseq.current++;
    setPosition(null);
    onPosition && onPosition(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleKey]);

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
    // EDITING THE TEXT INVALIDATES THE POSITION. Keeping it would leave a distance
    // search measuring from the address the user just typed away from — which is
    // exactly the class of bug this whole feature exists to fix.
    if (position) setPosition(null);
    if (posRef.current) { posRef.current = null; onPosition && onPosition(null); }
    addrRef.current = null;
    pseq.current++;
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
          // USPS corrects the TEXT and has no coordinate of its own, so it updates
          // only the address half and re-reports through `report()` — handing its
          // answer back bare would drop a position the pick had already resolved.
          addrRef.current = j.address;
          report('standardized');
        }
        setUsps({ status: j.status });
      } else if (j && j.configured && j.status === 'unverified') {
        setUsps({ status: 'unverified' });
      } else {
        setUsps(null);                                   // not_configured / error / rate_limited → silent
      }
    } catch { if (mine === vseq.current) setUsps(null); }
  }

  /**
   * WHERE IS THIS ADDRESS? Asked only when the caller wants it. The suggestion may
   * already carry the position (OpenStreetMap's own search answer does, free), in
   * which case nothing is fetched. Otherwise ONE keyless lookup — the server side
   * of this deliberately never uses Google for a coordinate, so the answer is safe
   * to store and to search on.
   *
   * A failure is an ANSWER, not silence: "we could not place this one" is what
   * tells an officer a half-mile search cannot be run from it, which is precisely
   * the thing that was invisible before.
   */
  function settlePosition(p) {
    posRef.current = p && p.lat != null ? p : null;
    setPosition(p);
    onPosition && onPosition(posRef.current);
    report('position');
  }
  async function resolvePosition(addr, carried) {
    const mine = ++pseq.current;
    if (carried && carried.lat != null && carried.lng != null) return settlePosition(carried);
    setPosition({ pending: true });
    const qs = new URLSearchParams();
    if (addr && addr.line1) {
      qs.set('line1', addr.line1);
      if (addr.city) qs.set('city', addr.city);
      if (addr.state) qs.set('state', addr.state);
      if (addr.zip) qs.set('zip', addr.zip);
    } else qs.set('q', String(value || ''));
    try {
      const j = await (await fetch('/api/address/position?' + qs.toString())).json();
      if (mine !== pseq.current) return;                      // a newer pick won
      settlePosition(j && j.lat != null && j.lng != null
        ? { lat: j.lat, lng: j.lng, source: j.source, precision: j.precision }
        : { lat: null, lng: null, why: (j && j.why) || 'we could not place that address on the map' });
    } catch {
      if (mine !== pseq.current) return;
      settlePosition({ lat: null, lng: null, why: 'the address lookup is not answering right now' });
    }
  }

  async function pick(s) {
    setOpen(false);
    setUsps(null);
    setPosition(null);
    addrRef.current = null;
    posRef.current = null;
    // EVERY IN-FLIGHT ANSWER FROM THE PREVIOUS PICK IS INVALIDATED HERE, all three
    // of them. Bumping only the position counter left a window across the details
    // await in which the PREVIOUS pick's USPS answer still passed its own guard
    // and reported itself over the newer pick's address.
    const mine = ++pseq.current;
    vseq.current++;
    let addr = s.address;
    if (!addr && s.id) {
      try { const j = await (await fetch('/api/address/details?id=' + encodeURIComponent(s.id))).json(); addr = j.address; }
      catch { addr = null; }
    }
    // The details lookup is a network call (Google's provider needs one), so the
    // user may have typed on or picked something else while it was out.
    if (mine !== pseq.current) return;
    if (addr) {
      onChange && onChange(addr.line1 || value);
      addrRef.current = addr;
      if (withPosition && s.position) posRef.current = s.position;   // free, straight off the suggestion
      report('pick');
      if (withPosition) resolvePosition(addr, s.position);
      verifyWithUsps(addr);
    } else { onChange && onChange(s.label); }
  }
  function onKey(e) {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(suggestions[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  const menu = open && pos ? createPortal(
    <div className="addr-menu" role="listbox" ref={attachMenu}
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

  /* CAN WE MEASURE FROM THIS ADDRESS? Only shown when the caller asked for a
     position, because it is only then that the answer means anything. It is worded
     as the CONSEQUENCE rather than as a technical fact — "we can measure distances
     from here" is what an officer needs to know before asking for everything within
     half a mile, and "we could not place this one" is why that search will refuse.
     Dark text on the white portal (never a light var(--ink*) token). */
  const posBadge = withPosition && position ? (
    <div style={{ marginTop: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, lineHeight: 1.3,
      color: position.pending ? '#4B585C' : (position.lat != null ? '#256168' : '#8A6D1F') }}>
      <span aria-hidden="true">{position.pending ? '…' : (position.lat != null ? '✓' : '⚠')}</span>
      <span>{position.pending ? 'Finding this address on the map…'
        : position.lat != null ? 'Found on the map — distance searches can run from here'
        : `${position.why || 'We could not place that address on the map'} — a distance search cannot be answered from it, so search by town instead.`}</span>
    </div>
  ) : null;

  return (
    <div style={{ position: 'relative' }}>
      <input ref={inputRef} className={className || 'input'} value={value || ''} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete="off" onChange={onInput} onKeyDown={onKey}
        onFocus={() => { if (suggestions.length) setOpen(true); }} />
      {uspsBadge}
      {posBadge}
      {menu}
    </div>
  );
}
