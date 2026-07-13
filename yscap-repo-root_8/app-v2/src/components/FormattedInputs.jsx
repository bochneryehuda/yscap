import React from 'react';

/* Money input: shows a $ prefix and comma-grouped digits while storing a plain
   numeric string in the form (so the backend still gets a number). */
// Strip to digits + AT MOST ONE decimal point — "1.2.3" (paste, fat-finger,
// European "1.200.000") used to render "NaN" and feed an unparseable string
// to drafts and the pricing engine.
function cleanMoney(v) {
  const s = String(v).replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
}
// Group the integer part with commas but PRESERVE a decimal being typed (a
// trailing '.' and any cents) — running Number().toLocaleString() on the whole
// string rendered 'NaN' for a lone '.' and erased the decimal point mid-entry,
// making cents impossible to type.
function formatMoney(value) {
  if (value === '' || value == null) return '';
  const s = cleanMoney(value);
  if (s === '' || s === '.') return s;                 // '.' shown transiently as the user types
  const dot = s.indexOf('.');
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot);            // includes the '.' and any digits
  const n = Number(intPart);
  const grouped = intPart === '' ? '' : (isFinite(n) ? n.toLocaleString('en-US') : intPart);
  return grouped + frac;
}
export function MoneyInput({ value, onChange, placeholder, ...rest }) {
  const display = formatMoney(value);
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted,#9fb0ba)', pointerEvents: 'none' }}>$</span>
      <input className="input" inputMode="numeric" autoComplete="off" style={{ paddingLeft: 22 }}
        value={display} placeholder={placeholder || '0'}
        onChange={(e) => onChange(cleanMoney(e.target.value))}
        {...rest} />
    </div>
  );
}

/* Phone input: formats US digits as (XXX) XXX-XXXX as the user types, storing
   the formatted string. */
export function formatPhone(v) {
  const d = String(v || '').replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
export function PhoneInput({ value, onChange, placeholder, ...rest }) {
  return (
    <input className="input" type="tel" autoComplete="off" value={formatPhone(value)}
      placeholder={placeholder || '(555) 123-4567'}
      onChange={(e) => onChange(formatPhone(e.target.value))} {...rest} />
  );
}
