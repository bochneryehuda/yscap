import React from 'react';

/* THE RECORDS STAMP — the browser mirror of the server's ONE definition
   (src/lib/track-record/records-stamp.js; the portal cannot require server
   code — the lib/payoff.js arrangement). scripts/test-records-stamp-pure.js
   reads BOTH files and fails the moment the wording or the states drift.

   Two honest states, never collapsed (owner-directed 2026-08-19):
     verified — the records CHECK matched this line to the county records
     sourced  — the line was IMPORTED from the records; not yet matched
   State is never carried by colour alone: the glyph (filled disc vs outline
   ring) and the word both differ, so the chip survives grayscale and
   colour-blindness (WCAG 1.4.1). Colours are explicit darks on white per the
   hard rule — never an --ink* token. */

export const STAMP_WORDING = {
  verified: {
    chip: 'VERIFIED · PUBLIC RECORDS',
    long: 'Matched to the county public records via Elementix',
  },
  sourced: {
    chip: 'FROM PUBLIC RECORDS',
    long: 'Imported from the county public records via Elementix — not yet matched line by line',
  },
};

const day = (v) => {
  const m = String(v == null ? '' : v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};

/* The shared 12px glyph — the same check path at every size (design spec
   §2.2): filled teal disc + white check for VERIFIED, slate outline ring +
   slate check for SOURCED. */
function Glyph({ verified }) {
  return verified ? (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="6" fill="#2F7F86" />
      <path d="M3.3 6.2 L4.9 7.9 L8.7 3.9" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="5.25" fill="none" stroke="#5B5F64" strokeWidth="1.5" />
      <path d="M3.3 6.2 L4.9 7.9 L8.7 3.9" fill="none" stroke="#5B5F64" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function RecordsStamp({ stamp, at, compact = false }) {
  const w = STAMP_WORDING[stamp];
  if (!w) return null;                 // no stamp = render nothing, never a grey placeholder
  const d = day(at);
  const verified = stamp === 'verified';
  return (
    <span className={`rstamp rstamp-${stamp}`} title={w.long + (d ? ` · ${d}` : '')} role="img"
      aria-label={w.long + (d ? ` on ${d}` : '')}>
      <Glyph verified={verified} />
      {compact ? (verified ? 'VERIFIED' : 'RECORDS') : w.chip}
    </span>
  );
}

/* The ENTITY flavour — a company the records import put on the profile
   (llcs.adopted_source='elementix'). One state on purpose: an entity's
   document verification is a human judgement about its papers, a different
   thing this chip must never imply. */
export function EntityRecordsStamp({ adoptedSource, at }) {
  if (String(adoptedSource || '') !== 'elementix') return null;
  return <RecordsStamp stamp="sourced" at={at} />;
}
