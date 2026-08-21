import React from 'react';
import { fmtDay } from '../lib/dates.js';

/* A NOTE THE LOAN TEAM WROTE ON THIS CONDITION, FOR THE PERSON READING IT (db/604,
   owner-directed 2026-08-21: "We should also be able to put external notes that
   should be visible for the borrowers and TpOS").

   ONE component for BOTH client surfaces — the borrower's portal and the TPO
   broker's file — so the sentence a staff member typed can never be presented one
   way to a borrower and another way to their broker. It is the same note, about the
   same condition; the only thing that differs is who is looking.

   It renders NOTHING when there is no note. The server sends the note only when
   there is one, already scrubbed and reshaped by lib/conditions/external-note.js —
   so this component holds no rule, just the presentation.

   The DATE is shown and the AUTHOR is not, deliberately: "is this current?" is the
   question a reader has, and naming an individual underwriter to an outside party
   is a new exposure nobody asked for. */
export default function ConditionTeamNote({ note, style }) {
  const body = note && typeof note === 'object' ? String(note.note || '').trim() : '';
  if (!body) return null;
  const day = note.at ? fmtDay(note.at) : '';
  return (
    <div className="cnd-teamnote" style={style}>
      <div className="cnd-teamnote-h">
        A note from your loan team{day ? ` · ${day}` : ''}
      </div>
      <div className="cnd-teamnote-body">{body}</div>
    </div>
  );
}
