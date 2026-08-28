'use strict';
/**
 * WHAT ENCOMPASS HAS DONE FOR ONE LONG-TERM FILE — the one definition.
 *
 * WHY THIS EXISTS (owner-directed 2026-08-25): *"We need to add one more section,
 * which would be the Encompass syncing, the same way we have a ClickUp syncing. We
 * can click it to try to read that file from Encompass and see what it read and
 * what it didn't read. You see all the details on every file about the Encompass
 * integration: the pull, the refresh, the last pull, last refresh, last webhooks,
 * and stuff like that."*
 *
 * THE FACTS WERE ALL RECORDED AND NONE OF THEM WERE READABLE FROM A FILE. Whether
 * a loan had ever been read in full, when, whether the last read was refused and
 * why, what Encompass's own last-changed stamp says, when the conditions were last
 * asked for — every one of those is a column on `lt_loans`, and the only screen
 * that showed any of it was the whole-book sync page. So a person looking at ONE
 * half-empty file had nowhere to learn whether it was new, stale, or refused. That
 * is the same shape as a column with no reader: correct, recorded, invisible.
 *
 * A LONG-TERM LOAN REACHES PILOT IN TWO STEPS AND THE SECTION SAYS WHICH IT IS AT.
 * DISCOVERY pages the pipeline search and stores the nine fields that search
 * returns. THE FULL READ then opens the loan itself and brings back the milestone
 * ladder, the vesting, the sale and the rest. Between the two the row is real and
 * half empty — which is exactly what the owner was looking at on the three Sherman
 * Ave files, with nothing on any screen to tell "new" from "broken".
 *
 * THE TWO LISTS BELOW ARE THE ANSWER TO "what it read and what it didn't", and they
 * are held to the code that actually writes them by
 * `scripts/test-lt-file-sync-view-pure.js`, which reads `sync/loans.js` and fails
 * if a column here is not written where this claims it is. A hand-kept list that
 * drifts from the writer is worse than no list: it would state, confidently, that
 * PILOT read something it never asked for.
 *
 * PURE. No database, no network, no requires — so the route, the screen and the
 * tests all ask the same thing and none of them can grow a second opinion.
 */

/** Where a value on the row came from. */
const FROM = {
  DISCOVERY: 'discovery',   // the pipeline search — arrives within seconds of the loan existing
  FULL: 'full_read',        // opening the loan itself — the step that fills the file in
};

/**
 * WHAT DISCOVERY BRINGS BACK. Nine columns, written by `loans.upsertDiscovered`
 * from the pipeline search's own row. These are filled on a loan PILOT has never
 * opened, which is why a brand-new file shows a number, an address and an amount
 * and nothing else.
 */
const DISCOVERY_FIELDS = [
  { column: 'loan_number', label: 'Loan number' },
  { column: 'borrower_name', label: 'Borrower name (as the pipeline states it)' },
  { column: 'loan_amount', label: 'Loan amount' },
  { column: 'loan_folder', label: 'Encompass folder' },
  { column: 'program_name', label: 'Program' },
  { column: 'term_months', label: 'Term (months)' },
  { column: 'milestone_name', label: 'Milestone' },
  { column: 'stage_key', label: 'Stage' },
  { column: 'encompass_last_modified', label: 'Encompass’s own last-changed stamp' },
];

/**
 * WHAT THE FULL READ BRINGS BACK — the columns `loans.readLoan` writes, and the
 * ones a file is missing while it waits in the read queue.
 *
 * `milestone_name` / `stage_key` / `program_name` / `term_months` / `loan_amount`
 * are deliberately NOT repeated here even though the full read also writes them:
 * discovery already filled them, so listing them under "what the full read brought
 * back" would credit the read with values that were there before it ran. This list
 * is what the full read ADDS.
 */
const FULL_READ_FIELDS = [
  { column: 'borrower_first_name', label: 'Borrower first name' },
  { column: 'borrower_last_name', label: 'Borrower last name' },
  { column: 'borrower_email', label: 'Borrower email' },
  { column: 'vesting_type', label: 'How the loan vests' },
  { column: 'vesting_entity_name', label: 'Vesting entity' },
  { column: 'ms_status', label: 'Status wording from Encompass' },
  { column: 'ms_status_date', label: 'Status date from Encompass' },
  { column: 'purchased_status', label: 'Investor purchase status' },
  { column: 'purchased_at', label: 'Purchase advice date' },

  // THE FIGURES SOMEBODY ACTUALLY NOTICES ARE MISSING (owner-reported 2026-08-25).
  // The report was a file that sat empty for twenty hours — and what the owner meant
  // by empty was the rate and the DSCR, which this list did not mention. So the one
  // panel whose entire job is "what it read and what it didn't" could not answer the
  // only question anybody was asking it. `syncLoanTerms` writes all four onto
  // `lt_loans`, so they are on the row this view already has.
  { column: 'note_rate_pct', label: 'Note rate' },
  { column: 'dscr_ratio', label: 'DSCR' },
  { column: 'housing_expense_total', label: 'Monthly housing expense' },
  { column: 'loan_purpose', label: 'Purpose' },
];

/** Plain words for the shape of a webhook ping. Never a code on a screen. */
const NUDGE_WORDS = {
  guid: 'Encompass named the loan by its own id',
  loan_number: 'Encompass named the loan by its YSCAP number',
  sweep: 'a bare ping — PILOT asked Encompass which loans had changed and this was one',
  manual: 'somebody pressed “Read this file from Encompass now”',
};

/** How long a loan may go unread before the rota re-reads it whatever the stamps
 *  say. Read from the same environment variable `sync/loans.js` reads, so the
 *  screen can never promise a different rota from the one that runs.
 *
 *  A LOAN WHOSE LAST READ CAME BACK EMPTY IS ON THE SHORT ROTA, and this has to say
 *  so. `needsRead` brings such a loan back in an hour rather than twelve; a screen
 *  still counting down from twelve would be telling somebody to wait most of a day
 *  for something already scheduled for the next hour — which is the same class of
 *  wrong this whole change is about, just pointed at the reader instead of the row. */
function rotaHours(row = null) {
  const n = parseInt(process.env.LT_ENCOMPASS_REREAD_HOURS || '12', 10);
  const full = Number.isFinite(n) && n >= 0 ? n : 12;
  if (!row || !row.encompass_sync_error || full === 0) return full;
  const p = parseInt(process.env.LT_ENCOMPASS_PARTIAL_REREAD_HOURS || '1', 10);
  return Math.min(Number.isFinite(p) && p >= 0 ? p : 1, full);
}

const isFilled = (v) => !(v === null || v === undefined || v === '');

function pick(row, list) {
  const out = [];
  for (const f of list) {
    const raw = row ? row[f.column] : undefined;
    out.push({ column: f.column, label: f.label, filled: isFilled(raw), value: isFilled(raw) ? raw : null });
  }
  return out;
}

/**
 * WHEN THE ROTA WILL COME ROUND. Answers null rather than a guess when the loan has
 * never been read (there is no clock to count from) or the rota is switched off.
 */
function nextRotaDue(row, now) {
  // The ROW's rota, not the deployment's — a loan whose last read came back empty
  // is due in an hour, and this is the number the screen counts down from.
  const hours = rotaHours(row);
  if (!hours) return null;
  const synced = row && row.encompass_synced_at ? Date.parse(row.encompass_synced_at) : NaN;
  if (!Number.isFinite(synced)) return null;
  return new Date(synced + hours * 3600 * 1000).toISOString();
}

/**
 * The whole section, from one `lt_loans` row.
 *
 * `readState` is NOT re-derived here — it is handed in by the caller from
 * `src/longterm/read-state.js`, which is the one definition every other screen
 * already asks. Deciding it a second time is how two screens come to disagree
 * about whether the same file has been read.
 */
function fileSyncView(row, { readState, switches, now = Date.now() } = {}) {
  const r = row || {};
  const discovery = pick(r, DISCOVERY_FIELDS);
  const full = pick(r, FULL_READ_FIELDS);

  return {
    // WHICH LOAN, in Encompass's own terms. The GUID is what every read is keyed
    // on, so a row without one can never be read however healthy the connection is.
    identity: {
      loanNumber: r.loan_number || null,
      guid: r.encompass_loan_guid || null,
      folder: r.loan_folder || null,
      archived: r.encompass_archived === true,
      archivedDuplicate: r.archived_duplicate === true,
    },

    // THE FIVE DATES THE OWNER ASKED FOR, each said plainly and each allowed to be
    // unknown. A null here always means "this has not happened", never "we lost it".
    when: {
      // "the last pull" — the last time PILOT opened this loan and read it in full.
      lastFullRead: r.encompass_synced_at || null,
      // "the last refresh" — Encompass's OWN stamp for when the loan last changed.
      // This is a fact about the LOAN, not about us, which is why it can be newer
      // than our last read (that is precisely what makes the loan due).
      encompassChanged: r.encompass_last_modified || null,
      // The Condition Center reads on its own cadence, so its freshness is its own
      // fact — a screen reporting one as the other would be confidently wrong about
      // which.
      conditionsRead: r.conditions_synced_at || null,
      nextRotaDue: nextRotaDue(r, now),
      rotaHours: rotaHours(r),
    },

    // "last webhooks" (db/629). Before those columns this was recorded nowhere, so a
    // webhook that had silently stopped looked exactly like one that never fired.
    nudge: {
      at: r.encompass_nudged_at || null,
      via: r.encompass_nudged_via || null,
      viaWords: r.encompass_nudged_via ? (NUDGE_WORDS[r.encompass_nudged_via] || r.encompass_nudged_via) : null,
      count: Number(r.encompass_nudge_count || 0),
    },

    // Waiting / read / refused, plus the reason in words.
    read: {
      state: readState ? readState.state : null,
      why: readState ? readState.why : null,
      everRead: readState ? readState.everRead : !!r.encompass_synced_at,
      error: r.encompass_sync_error || null,
    },

    // "what it read and what it didn't read", as two lists with a count each.
    fields: {
      discovery: { from: FROM.DISCOVERY, filled: discovery.filter((f) => f.filled).length, total: discovery.length, rows: discovery },
      fullRead: { from: FROM.FULL, filled: full.filter((f) => f.filled).length, total: full.length, rows: full },
    },

    switches: switches || null,
  };
}

module.exports = {
  FROM,
  DISCOVERY_FIELDS,
  FULL_READ_FIELDS,
  NUDGE_WORDS,
  fileSyncView,
  rotaHours,
  nextRotaDue,
  _internals: { isFilled, pick },
};
