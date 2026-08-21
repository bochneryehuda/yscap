'use strict';
/**
 * THE NOTE ON A CONDITION THAT THE BORROWER AND THE TPO BROKER READ (db/604,
 * owner-directed 2026-08-21, verbatim: "on the condition center, maybe we
 * implemented it already. Right now, I only see internal notes. We should also be
 * able to put external notes that should be visible for the borrowers and TpOS.")
 *
 * ONE definition of everything about it, so the three surfaces that touch it — the
 * staff door that writes it, the borrower checklist and the TPO checklist — cannot
 * drift into disagreeing about what it is:
 *
 *  - WHAT IS ACCEPTED (`noteProblem` / `clean`): plain text, trimmed, capped, and an
 *    empty note is NULL rather than an empty string — "there is no note" and "there
 *    is a note that says nothing" must not be two states a screen has to tell apart.
 *
 *  - WHAT SHIPS OUTSIDE (`forClient`): the words and WHEN, never who by name. The
 *    scrub is MANDATORY and is passed in rather than required here, because it is
 *    `lib/borrower-safe`'s — this is free text a staff member typed, so it is exactly
 *    the case the standing rule covers: never expose a note buyer / capital partner
 *    name on a borrower-facing surface, and scrub what a human wrote rather than
 *    trusting them to remember.
 *
 * IT IS A SECOND FIELD, NEVER THE SAME ONE. `checklist_items.notes` stays internal
 * and unchanged — staff reasoning, [auto] messages, capital-partner names — and is
 * still never selected by a borrower or TPO route. Nothing that was internal
 * yesterday can become visible because of this.
 *
 * IT DOES NOT NOTIFY, DELIBERATELY. A note appears on the condition it is about, on
 * the screen the borrower is already working from. Emailing one would be a new
 * routine-activity email, which is the bombardment the 2026-07-20 rules cut back;
 * the borrower is gated to real events. Making it notify is an owner call.
 */

const EXTERNAL_NOTE_MAX = 2000;

/** Trim to what is stored. '' / whitespace / null all become NULL. */
function clean(v) {
  if (v == null) return null;
  const s = String(v).replace(/\r\n/g, '\n').trim();
  return s ? s.slice(0, EXTERNAL_NOTE_MAX) : null;
}

/**
 * '' when the value is storable, else the plain-language refusal.
 * A clear (null / '') is always allowed — taking a note down is not an edit anybody
 * should have to argue with.
 */
function noteProblem(v) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return 'A note is plain text.';
  const s = String(v).trim();
  if (!s) return '';
  if (s.length > EXTERNAL_NOTE_MAX) return `Keep the note under ${EXTERNAL_NOTE_MAX.toLocaleString('en-US')} characters.`;
  return '';
}

/**
 * The shape a borrower / TPO surface sends. `scrubText` is REQUIRED — a caller with
 * no scrubber gets NO note rather than an unscrubbed one, because failing closed on
 * a partner name is the whole reason the scrub exists.
 *
 * @returns {{note: string, at: string|null}|null} null when there is nothing to show
 */
function forClient(row, scrubText) {
  if (!row) return null;
  const raw = clean(row.external_note);
  if (!raw) return null;
  if (typeof scrubText !== 'function') return null;
  let note = '';
  try { note = String(scrubText(raw) || '').trim(); } catch (_) { return null; }
  if (!note) return null;
  return { note, at: row.external_note_at || null };
}

module.exports = { EXTERNAL_NOTE_MAX, clean, noteProblem, forClient };
