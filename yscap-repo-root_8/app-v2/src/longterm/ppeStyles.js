// LT PPE — the screen tokens, in ONE place.
//
// Extracted so the pricing-engine screen and the rate-sheet console cannot drift into two slightly
// different cards. It is a small file on purpose: it carries the tokens the PPE screens share and
// nothing else.
//
// DARK TEXT ON THE WHITE PILOT CANVAS, ALWAYS — and never a `--ink*` token, which is a LIGHT paper
// colour in this palette and renders white-on-white (the trap CLAUDE.md records by name). Every
// colour here is an explicit hex chosen to be readable on white.

export const INK = '#141B22';     // primary text
export const MUTED = '#4B585C';   // secondary text
export const SLATE = '#3A4550';   // body text inside lists
export const GOLD = '#AE8746';
export const PAPER = '#F4F1EA';
export const DANGER = '#8A2F2F';  // a refusal
export const CAUTION = '#7A5C25'; // a "you should know" note that is not an error

export const card = {
  border: '1px solid rgba(20,27,34,.12)', borderRadius: 12, padding: 16,
  background: '#fff', marginBottom: 14,
};
export const h2 = { margin: '0 0 4px', fontSize: 16, color: INK };
export const sub = { margin: '0 0 12px', fontSize: 13, color: MUTED };
export const eyebrow = {
  fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700,
};

// A text input on the white canvas. 16px is deliberate: iOS Safari zooms the whole page on focus of
// any control under 16px, which throws a form off screen on a phone.
export const input = {
  fontSize: 16, padding: '8px 10px', borderRadius: 8, color: INK, background: '#fff',
  border: '1px solid rgba(20,27,34,.22)', width: '100%', boxSizing: 'border-box',
};
export const mono = {
  ...input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13,
  minHeight: 120, lineHeight: 1.5, whiteSpace: 'pre', overflowX: 'auto',
};
export const label = { display: 'block', fontSize: 12, color: MUTED, fontWeight: 600, marginBottom: 4 };
