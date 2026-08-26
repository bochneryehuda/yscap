'use strict';
/**
 * HAS ENCOMPASS ANSWERED FOR THIS LOAN YET — the one definition.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-24, three Sherman Ave files): *"All these
 * files somehow are not updating in pilot. I don't know why I'm not getting the
 * information."*
 *
 * A long-term loan reaches PILOT in TWO steps, and only the second one fills the
 * file in. DISCOVERY finds it in Encompass's pipeline search and stores what that
 * search returns — the number, the officer, the address, the program, the amount,
 * the borrower's name. THE FULL READ then opens the loan itself and brings back
 * everything else: the milestone ladder, the rate, the DSCR, the lock, the
 * investor, the 1003 sections. Between the two the row is real and half empty.
 *
 * PILOT HAS ALWAYS KNOWN WHICH STEP A LOAN IS AT, and said so nowhere a person
 * looking at a half-empty row would find it: `encompass_synced_at` is NULL until
 * the first successful read, and `encompass_sync_error` holds the reason when a
 * read is refused. The failure was surfaced on the sync screen; the WAITING state
 * was surfaced nowhere at all — so a freshly-arrived file looked broken rather
 * than new, with nothing on any screen to tell the two apart. That is the same
 * shape as a column with no reader: the fact is recorded, correct, and invisible.
 *
 * THREE STATES, AND THE ORDER OF THE TESTS IS THE RULE. An error is asked about
 * FIRST, because a loan that was read successfully a week ago and refused this
 * morning is showing STALE figures — and "stale, here is why" is a different
 * answer from "fresh". Then never-read. Then read.
 *
 * PURE. No database, no network, no requires — so every screen, route and test can
 * ask it, and none of them can drift into a second opinion.
 */

const STATE = { READ: 'read', FAILED: 'failed', WAITING: 'waiting' };

/** The sentence a person reads. Never a code, never a bare dash. */
const WAITING_WHY = 'PILOT has found this loan in Encompass but has not read the file itself yet, '
  + 'so only what the pipeline search returns is filled in. It is in the queue and fills in on its own.';

function readStateOf(row) {
  const r = row || {};
  const err = typeof r.encompass_sync_error === 'string' ? r.encompass_sync_error.trim() : '';
  if (err) {
    return {
      state: STATE.FAILED,
      why: `The last read from Encompass was refused: ${err}`,
      // Whether there is anything on the row at all, or only the discovery fields.
      everRead: !!r.encompass_synced_at,
    };
  }
  if (!r.encompass_synced_at) return { state: STATE.WAITING, why: WAITING_WHY, everRead: false };
  return { state: STATE.READ, why: null, everRead: true };
}

/** Short enough for a chip beside a loan number. */
function readStateLabel(state) {
  if (state === STATE.FAILED) return 'Read refused';
  if (state === STATE.WAITING) return 'Not read yet';
  return null;
}

module.exports = { STATE, WAITING_WHY, readStateOf, readStateLabel };
