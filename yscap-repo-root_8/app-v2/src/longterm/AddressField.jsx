/* ──────────────────────────────────────────────────────────────────────────
   LONG-TERM — THE PROPERTY ADDRESS BOX, WITH LOOK-UP.

   Owner-directed 2026-08-30: *"You can put in property addresses. The property
   address should be linked with the Find My Property address to autofill the
   property address from the short-term site. You can use the same credentials."*

   ⛔ WHAT IS SHARED IS THE VENDOR PROXY, NOT SHORT-TERM CODE. `/api/address/*`
   is a product-neutral door — it exists so the provider's key never leaves the
   server, and its own header says it serves "the marketing site AND portal". It
   is mounted at the top level, holds no loan data, reads no RTL table and
   returns nothing about either product. So this is the same class as the LOGIN
   TOKEN `http.js` already shares: infrastructure both products stand on, not a
   short-term feature lifted across. Nothing here imports RTL code — that would
   be the crossing, and `check-product-separation.js` would refuse it.
   Recorded in `docs/LONG-TERM-AUTHORIZED-COPIES.md` with the owner's own words.

   ⛔ TYPING ALWAYS WINS. The look-up is a CONVENIENCE and never a gate: a new
   build, a rural parcel or a provider having a bad minute must not stop an
   officer putting an address on a term sheet. Every failure — no key, a
   throttled provider, nothing found, a network error — degrades to an ordinary
   text box, silently. The one thing it never does is clear what somebody typed.

   ⛔ EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` are LIGHT paper colours
   in this palette whose names lie, so `color: var(--ink)` renders white on white.
   ────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { INK, MUTED, SLATE, GOLD } from './ppeStyles.js';

/** How long after the last keystroke we ask. Long enough not to spend a call per
 *  character, short enough that a person who stops typing sees a list. */
const DEBOUNCE_MS = 250;
/** The provider itself ignores anything shorter, so we do not spend the trip. */
const MIN_CHARS = 3;

/**
 * The one-line address a document prints, from the provider's own parts.
 *
 * ⛔ BUILT FROM THE PARTS, NOT FROM THE PICKER'S LABEL. A suggestion label is
 * written to be SCANNED in a list — some providers put the county, the country
 * or a neighbourhood in it — and a term sheet must carry the mailing address.
 * With no parts to build from, the label is the honest fallback: something the
 * person recognises beats an empty box.
 */
export function oneLineFrom(address, fallbackLabel) {
  const a = address && typeof address === 'object' ? address : null;
  if (!a) return String(fallbackLabel || '').trim();
  const street = String(a.line1 || a.street || '').trim();
  const city = String(a.city || '').trim();
  const state = String(a.state || '').trim();
  const zip = String(a.zip || a.postalCode || '').trim();
  const tail = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const out = [street, tail].filter(Boolean).join(', ');
  return out || String(fallbackLabel || '').trim();
}

export default function AddressField({ id, value, onChange, placeholder, style, ariaLabel }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The text the last request was for. A slower answer to an older keystroke must
  // never replace the list for what is in the box NOW.
  const wanted = useRef('');
  const timer = useRef(null);
  // Set the moment a suggestion is taken, so the answer that is already in flight
  // for the half-typed text does not re-open the list under the finished address.
  const justPicked = useRef(false);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (justPicked.current) { justPicked.current = false; return undefined; }
    const q = String(value || '').trim();
    if (timer.current) clearTimeout(timer.current);
    if (q.length < MIN_CHARS) { setList([]); setOpen(false); return undefined; }
    timer.current = setTimeout(async () => {
      wanted.current = q;
      setBusy(true);
      try {
        const r = await fetch(`/api/address/suggest?q=${encodeURIComponent(q)}`, {
          credentials: 'same-origin',
        });
        const data = await r.json();
        // Still the text they are looking at? An out-of-order answer is dropped.
        if (wanted.current !== q) return;
        const out = Array.isArray(data && data.suggestions) ? data.suggestions.slice(0, 6) : [];
        setList(out);
        setOpen(out.length > 0);
      } catch {
        // ⛔ SILENT ON PURPOSE. The box still works as plain typing, which is
        // exactly what it does when the provider is down. An error message about
        // a convenience would read as though the address itself were refused.
        setList([]); setOpen(false);
      } finally { setBusy(false); }
    }, DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value]);

  async function take(s) {
    justPicked.current = true;
    setOpen(false); setList([]);
    // Some providers hand the parts back with the suggestion; Google needs a
    // second call. Either way a failure falls back to the label, never to blank.
    let address = s && s.address;
    if (!address && s && s.id) {
      try {
        const r = await fetch(`/api/address/details?id=${encodeURIComponent(s.id)}`, {
          credentials: 'same-origin',
        });
        const d = await r.json();
        address = d && d.address;
      } catch { address = null; }
    }
    onChange(oneLineFrom(address, s && s.label));
  }

  return (
    <div style={{ position: 'relative', ...(style || {}) }}>
      <input
        id={id}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { if (list.length) setOpen(true); }}
        onBlur={() => { setTimeout(() => setOpen(false), 120); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        placeholder={placeholder || 'Start typing the property address'}
        aria-label={ariaLabel || 'Property address'}
        autoComplete="off"
        style={{
          width: '100%', boxSizing: 'border-box',
          border: '1px solid rgba(20,27,34,.18)', borderRadius: 8, padding: '7px 9px',
          // 16px: iOS Safari zooms the whole page on focus of anything smaller,
          // which throws this panel off screen on a phone.
          fontSize: 16, color: INK, background: '#fff',
        }}
      />
      {busy && !open ? (
        <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>Looking…</div>
      ) : null}
      {open && list.length ? (
        <ul
          style={{
            position: 'absolute', zIndex: 40, left: 0, right: 0, top: '100%', marginTop: 3,
            listStyle: 'none', padding: 4, background: '#fff', color: INK,
            border: `1px solid ${GOLD}55`, borderRadius: 8,
            boxShadow: '0 8px 24px rgba(20,27,34,.14)', maxHeight: 220, overflowY: 'auto',
          }}
        >
          {list.map((s, i) => (
            <li key={s.id || `${s.label}-${i}`}>
              {/* onMouseDown, not onClick — the input's blur fires first and would
                  close the list out from under the click. */}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); take(s); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 0,
                  background: 'transparent', cursor: 'pointer', color: SLATE,
                  fontSize: 13, lineHeight: 1.45, padding: '6px 7px', borderRadius: 6,
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
