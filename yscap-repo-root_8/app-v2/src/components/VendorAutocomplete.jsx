import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* TYPE A FEW LETTERS, GET THE WHOLE VENDOR BACK (owner-directed 2026-08-20:
   "we already have a database from all the vendors that we're using across the
   board. Anywhere you start typing in the insurance contact, title contact, or
   any other contact, you should get the same way [as] when you start typing an
   address, you get a lot of options … that you can auto-populate all the
   information just by starting to type").

   The owner named the address box as the model, so this behaves like it:
   debounced query, arrow keys, Enter to take, Escape to dismiss, and a menu
   PORTALED to <body> and fixed-positioned against the input's own rect — that
   last part is not decoration. These fields live inside condition rows and modal
   cards with their own `overflow`, and a menu rendered in place is clipped by the
   first of them; the address box was rewritten for exactly that bug and this
   inherits the fix rather than re-earning it.

   TWO THINGS IT DOES THAT THE ADDRESS BOX DOES NOT:

   · IT OPENS ON FOCUS WITH NOTHING TYPED. A blank query means "show me what I
     have used", which is the OTHER half of the owner's request ("he should be
     able to pre-fill from his previous contacts … it should come up with all the
     options that he used previously for title"). One control answers both asks,
     so there is no separate "saved contacts" list to keep in step with it.
   · IT FILLS THE WHOLE FORM, not one field. `onPick` hands back the vendor —
     company, contact name, EVERY email, phone, address — because "auto-populate
     all the information" is the ask. What the caller does with it is the caller's
     business; this never writes.

   The staleness guard on every fetch (`seq`) is the same one the address box
   carries and exists for the same reason: a slow earlier request must never
   overwrite a newer one's results, which on a type-ahead is the difference
   between "Mad" showing Madison Title and showing whatever "M" matched. */

/** One line of the menu: the name, then whatever else identifies the vendor. */
function label(v) {
  return v.companyName || v.contactName || (v.emails && v.emails[0]) || 'Contact';
}
function sub(v) {
  const bits = [];
  if (v.companyName && v.contactName) bits.push(v.contactName);
  if (v.emails && v.emails.length) {
    bits.push(v.emails.length > 1 ? `${v.emails[0]} +${v.emails.length - 1} more` : v.emails[0]);
  }
  if (v.phone) bits.push(v.phone);
  return bits.join(' · ');
}

/**
 * @param value/onChange   the text in the field (usually the company name)
 * @param onPick           (vendor) => void — the whole contact, for the form to spread
 * @param fetchSuggestions (q) => Promise<vendor[]> — the caller supplies its own
 *                         door (staff and borrower have different ones, and the
 *                         AUDIENCE boundary belongs on the server, never here)
 * @param placeholder/className/disabled  as an ordinary input
 * @param emptyHint        what to say when there is nothing saved yet
 */
export default function VendorAutocomplete({
  value, onChange, onPick, fetchSuggestions,
  placeholder, className, disabled = false, emptyHint = 'Nothing saved yet — type the details in.',
}) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState(false);   // have we run a query at all yet?
  const seq = useRef(0);
  const timer = useRef(null);
  const inputRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Close on an outside click. The menu lives in <body>, so it has to be excluded
  // from "outside" explicitly — checked via its own ref, not the input's wrapper.
  useEffect(() => {
    function onDoc(e) {
      const inInput = inputRef.current && inputRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inInput && !inMenu) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const place = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const mh = menuRef.current ? menuRef.current.offsetHeight : 0;
    const below = vh - r.bottom; const above = r.top;
    const flip = mh && below < mh + 8 && above > below;
    const next = { left: Math.round(r.left), width: Math.round(r.width), top: Math.round(flip ? r.top - mh - 4 : r.bottom + 4) };
    // IDEMPOTENT — `place` runs on every scroll tick, and an unconditional
    // setState would re-render the field on each one AND make the
    // measure-on-attach below an infinite loop.
    setPos((cur) => (cur && cur.left === next.left && cur.width === next.width && cur.top === next.top ? cur : next));
  }, []);

  /* Measure the menu once it EXISTS. The flip-above decision needs its height, and
     on the first open there is nothing in the DOM to measure — which is how the
     address box used to render its menu off the bottom of a short window with no
     way to scroll to it. A callback ref fires at exactly the moment the height
     becomes knowable. */
  const attachMenu = useCallback((el) => { menuRef.current = el; if (el) place(); }, [place]);

  useEffect(() => {
    if (!open) { setPos(null); return undefined; }
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); };
  }, [open, items.length, place]);

  const run = useCallback((q) => {
    const mine = ++seq.current;
    setLoading(true);
    Promise.resolve()
      .then(() => fetchSuggestions(q))
      .then((rows) => {
        if (mine !== seq.current) return;          // a newer keystroke won
        setItems(Array.isArray(rows) ? rows : []);
        setActive(-1); setAsked(true); setLoading(false); setOpen(true);
      })
      .catch(() => {
        // A failed lookup is not a failed form. The field stays typeable; the menu
        // simply says nothing came back rather than showing a stale list.
        if (mine !== seq.current) return;
        setItems([]); setAsked(true); setLoading(false); setOpen(true);
      });
  }, [fetchSuggestions]);

  function onFocus() {
    if (disabled) return;
    // A blank query IS the prefill — "show me the ones I have used before".
    run(String(value || '').trim());
  }
  function onInput(e) {
    const v = e.target.value;
    onChange && onChange(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(String(v || '').trim()), 220);
  }
  function take(v) {
    setOpen(false);
    onPick && onPick(v);
  }
  function onKey(e) {
    if (!open || !items.length) {
      if (e.key === 'Escape') setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); take(items[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  const menu = open && pos ? createPortal(
    <div className="addr-menu vendor-menu" role="listbox" ref={attachMenu}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, right: 'auto',
        marginTop: 0, zIndex: 2147483000, maxHeight: 'min(320px, 44vh)', overflowY: 'auto' }}>
      {loading && !items.length && <div className="addr-item"><span>Looking…</span></div>}
      {!loading && !items.length && asked && <div className="addr-item"><span>{emptyHint}</span></div>}
      {items.map((v, i) => (
        <div key={v.id || i} role="option" aria-selected={i === active}
          className={`addr-item${i === active ? ' active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); take(v); }}
          onMouseEnter={() => setActive(i)}>
          <span className="addr-pin" aria-hidden="true">{v.mine ? '★' : '●'}</span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 600 }}>{label(v)}</span>
            {sub(v) && <span style={{ display: 'block', opacity: .82, fontSize: '.92em' }}>{sub(v)}</span>}
            {/* WHY a row is being offered, in words. "You used this before" is the
                single most useful thing on the line — it is the prefill the owner
                asked for — and the file count is how you tell one of forty
                near-identical saved rows apart. */}
            <span style={{ display: 'block', opacity: .7, fontSize: '.85em' }}>
              {v.mine ? 'You used this before' : 'From our vendor list'}
              {v.usedCount > 1 ? ` · on ${v.usedCount} files` : ''}
            </span>
          </span>
        </div>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div style={{ position: 'relative' }}>
      <input ref={inputRef} className={className || 'input'} value={value || ''} placeholder={placeholder}
        disabled={disabled} autoComplete="off" onChange={onInput} onKeyDown={onKey} onFocus={onFocus} />
      {menu}
    </div>
  );
}
