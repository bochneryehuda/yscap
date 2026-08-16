import React from 'react';

/**
 * The product stamp — "which book is this file in", at a glance.
 *
 * CLAUDE.md §7 requires a visible product stamp on every row and every file header,
 * so that a screen showing both books can never leave somebody guessing which loan
 * they are looking at.
 *
 * IT RENDERS WHAT THE ROW SAYS, AND NOTHING WHEN THE ROW SAYS NOTHING.
 *
 * The tempting version prints "Long-term" because this file lives in the long-term
 * folder. That is precisely the version that breaks: on a combined pipeline every row
 * would carry the same word, and the one thing the stamp exists to prevent is what it
 * would cause. So the label comes off the row (`productLabel`, set by the server), and
 * an untagged row renders NO stamp — an honest blank rather than a confident wrong
 * label. `src/longterm/product.js` is where the long-term tag is defined; the
 * short-term side tags its own rows in its own code.
 *
 * Colours are explicit darks: every `--ink*` token in this palette is a LIGHT paper
 * colour, so a body-text `var(--ink)` renders white on white.
 */

const TONE = {
  long_term: { bg: '#F0EEF7', border: 'rgba(74,58,122,.30)', fg: '#3B2F63' },
  rtl: { bg: '#F4F1EA', border: 'rgba(174,135,70,.32)', fg: '#6B5220' },
};
const FALLBACK = { bg: '#F4F1EA', border: 'rgba(20,27,34,.16)', fg: '#4B585C' };

export default function ProductStamp({ product, label, size = 'sm', style }) {
  // No tag, no stamp. Never a guess, and never the folder this component lives in.
  if (!product || !label) return null;
  const t = TONE[product] || FALLBACK;
  const small = size === 'sm';
  return (
    <span
      title={`This file is in the ${label} book`}
      style={{
        display: 'inline-block', whiteSpace: 'nowrap', borderRadius: 999,
        padding: small ? '1px 7px' : '3px 10px',
        fontSize: small ? 10 : 11,
        letterSpacing: '.06em', textTransform: 'uppercase', fontWeight: 700,
        background: t.bg, border: `1px solid ${t.border}`, color: t.fg,
        ...style,
      }}
    >{label}</span>
  );
}
