import React from 'react';

/**
 * A condition hint whose FIRST LINE starts with '⚠️' carries a requirement the
 * owner wants UNMISSABLE (owner-directed 2026-07-30: the two-month bank-statement
 * rule "should stay in very bulk on the condition, highlighted, quoted"). The
 * server (src/lib/liquidity.js loudMonthsBanner) writes that line; this is the
 * portal half that renders it as a bold highlighted callout instead of muted
 * small print. A hint without the marker renders exactly as before.
 *
 * Dark text on the white canvas per the hard rule — explicit hex, never a
 * --ink* token.
 */
export function splitLoudHint(hint) {
  const s = String(hint == null ? '' : hint);
  if (!s.startsWith('⚠️')) return { loud: null, rest: s };
  const nl = s.indexOf('\n');
  if (nl < 0) return { loud: s, rest: '' };
  return { loud: s.slice(0, nl), rest: s.slice(nl + 1).trim() };
}

export function LoudBanner({ text, style }) {
  if (!text) return null;
  return (
    <div style={{
      padding: '10px 12px', border: '2px solid #AE8746', borderRadius: 10,
      background: 'rgba(174,135,70,.10)', color: '#141B22', fontWeight: 700,
      fontSize: '.92rem', lineHeight: 1.45, marginTop: 6, ...(style || {}),
    }}>
      {text}
    </div>
  );
}

/** Drop-in hint renderer: loud first line (if marked) + the rest as the normal hint. */
export default function LoudHint({ hint, className = 'muted small', style }) {
  const { loud, rest } = splitLoudHint(hint);
  if (!loud) {
    return hint ? <div className={className} style={{ whiteSpace: 'pre-line', ...(style || {}) }}>{hint}</div> : null;
  }
  return (
    <div>
      <LoudBanner text={loud} />
      {rest ? <div className={className} style={{ whiteSpace: 'pre-line', marginTop: 6, ...(style || {}) }}>{rest}</div> : null}
    </div>
  );
}
