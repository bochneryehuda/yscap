import React, { useState } from 'react';
import { absTime, timeAgo } from '../lib/esign.js';

/* THE FULL LOG OF A SIGNING PACKAGE (owner-directed 2026-09-01: "a nicely designed
   log of the changes that were done … sent this at this time, changed the email and
   resent at this time, viewed at this time, signed at this time … at the bottom of
   every DocuSign package across the board").

   ONE component for every card — the per-file section, the cross-file cockpit and the
   draw wire form — fed by the ONE server builder (lib/esign/events), so the log can
   never read differently on two screens. It renders the list it is given; it decides
   nothing. Collapsed to a one-line count by default so a card with a long history
   stays as compact as the owner asked the packages to be; `defaultOpen` for a card
   that is already expanded. Colours are explicit darks on white (the --ink* tokens
   are LIGHT in this palette and must never colour text). */

const INK = '#141B22', MUTED = '#4B585C', LINE = '#E7E1D3';
const TONE = {
  signed: '#2E7A5E', completed: '#2E7A5E',
  viewed: '#2F7F86', delivered: '#2F7F86',
  declined: '#A32A2A', signer_declined: '#A32A2A', voided: '#A32A2A', failed: '#A32A2A', cleared: '#A32A2A',
  invited: '#AE8746', sent: '#AE8746', signer_sent: '#AE8746',
};
const dotFor = (kind) => TONE[kind] || (String(kind).startsWith('audit:esign_resend') || String(kind).includes('email_changed') ? '#AE8746' : '#9AA1AC');

export default function EsignEventLog({ events, defaultOpen = false, compact = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return null;
  // Newest first: the question at the bottom of a card is "what happened LAST".
  const rows = list.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const resent = rows.filter((e) => String(e.kind).startsWith('audit:esign_resend') || String(e.kind) === 'audit:esign_recipient_email_changed').length;
  const viewed = rows.some((e) => e.kind === 'viewed');
  const summary = [
    `${rows.length} event${rows.length === 1 ? '' : 's'}`,
    resent ? `re-sent ${resent}×` : null,
    viewed ? 'opened by a signer' : null,
    `last ${timeAgo(rows[0].at)}`,
  ].filter(Boolean).join(' · ');
  return (
    <div className="esign-log" style={{ marginTop: compact ? 8 : 12, borderTop: `1px solid ${LINE}`, paddingTop: 8 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        style={{ appearance: 'none', background: 'transparent', border: 0, padding: 0, cursor: 'pointer', font: 'inherit',
          display: 'flex', alignItems: 'center', gap: 8, color: MUTED, fontSize: 12.5 }}>
        <span className={`sec-chevron${open ? ' open' : ''}`} aria-hidden="true" style={{ fontSize: 10 }}>▶</span>
        <span style={{ fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 11 }}>Activity log</span>
        <span>· {summary}</span>
      </button>
      {open ? (
        <ol style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
          {rows.map((e, i) => (
            <li key={`${e.at}-${e.kind}-${i}`} style={{ display: 'grid', gridTemplateColumns: '14px 1fr', gap: 10, padding: '5px 0',
              borderTop: i ? `1px dashed ${LINE}` : 'none', alignItems: 'start' }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 99, marginTop: 6, background: dotFor(e.kind), display: 'inline-block' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: INK, fontSize: 13, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                  {e.label}{e.who ? <span style={{ color: MUTED }}> — {e.who}</span> : null}
                </div>
                <div style={{ color: MUTED, fontSize: 11.5 }} title={absTime(e.at)}>{absTime(e.at)} · {timeAgo(e.at)}</div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
