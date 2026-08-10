'use strict';
/**
 * WHAT IS STILL LEFT ON THIS TRACK RECORD (owner-directed 2026-08-03: "on the
 * track record screen inside the file, after the track record, there should be
 * the skew of the stuff that still needs to be done to the track record — stuff
 * that still needs to be reviewed — nicely laid out within the file as well").
 *
 * THE PROBLEM THIS SOLVES. Everything needed to answer "what is left?" was
 * already on the screen and none of it was ADDED UP: a status pill per line, a
 * document list per line, an open-request line under some of them, a findings
 * card above, and — three sections away — an experience condition that refuses
 * to be signed off for reasons none of those pills mention. An officer had to
 * read ten rows and infer the work. This states it.
 *
 * IT IS COMPUTED ON THE SERVER, ON PURPOSE. The 36-month exit window is a FROZEN
 * rule (`experience.RECENT_EXIT_SQL`) and the sign-off refusals are the server's
 * own wording. Re-deriving either in the browser is how a screen ends up telling
 * an officer a line is fine while the gate refuses it — the repo's standing rule
 * is never re-derive a rule in the browser, ask the server.
 *
 * IT MIRRORS THE GATE, IN THE GATE'S ORDER. `signOffGate`'s experience branch
 * refuses on (1) an open track-record finding, (2) no registered product, then
 * (3) verified experience short of the registered need. This list reports the
 * same three, from the same modules, so "what is left" and "why won't it sign
 * off" can never be different answers.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. Every entry is a description of state
 * with a plain instruction; the buttons that act on them are the ones that
 * already exist (accept a document, ask for one, set the line Verified). It
 * never throws — a to-do list that 500s must not take the Track record section
 * down with it.
 */

/* The database and the experience module are required LAZILY, inside the one
   async function that needs them, so the pure half (`lineTodo`, `summarize`,
   `shortfallOf`, the wording) loads and unit-tests with no database in reach —
   the same split as `esign/term-sheet-stamp`. */

/* The reasons a line CANNOT be verified toward experience, in the verify route's
   OWN words. ONE definition: `POST /track-records/:id/verify` refuses with these
   and this list explains them ahead of time, so the panel can never promise a
   line is ready and then have the click answer 422 with different wording. */
const EXIT_PROBLEM_MSG = {
  no_exit: 'This project has no completed exit date (a sale date for a flip, or a lease / refinance date for a hold). It can’t be verified toward experience until the exit is recorded — request the exit documents instead.',
  future_exit: 'This project’s exit date is in the future — it can’t be verified until the exit has actually closed.',
  exit_expired: 'This project’s exit is more than 3 years ago, so it no longer counts toward experience (only exits within the last 36 months count). It can’t be verified toward experience.',
};

/* Every kind of outstanding work a single line can carry. `waitingOn` is what
   makes the list readable at a glance — 'us' is work the desk owes, 'borrower'
   is work we are waiting on, and 'nobody' is a fact about the line that no
   amount of chasing changes (an exit outside the window). */
const LINE_TODO = {
  documents_waiting: {
    waitingOn: 'us', title: 'Documents waiting for your review',
    how: 'Open each one and accept it, or reject it with a reason.',
  },
  ready_to_verify: {
    waitingOn: 'us', title: 'Ready to verify',
    how: 'The exit is recorded and the documentation is accepted — set this line to Verified so it counts toward experience.',
  },
  no_documents: {
    waitingOn: 'borrower', title: 'No documentation on this deal',
    how: 'Ask for the closing statement, deed or lease behind it — a line is verified against a document, not against typing.',
  },
  document_rejected: {
    waitingOn: 'borrower', title: 'A document was rejected',
    how: 'They were told why. This line stays out of the experience count until a replacement arrives and is accepted.',
  },
  open_request: {
    waitingOn: 'borrower', title: 'Waiting on a document we asked for',
    how: 'It is already a condition on this file — nothing more to do here until it lands.',
  },
  no_exit: { waitingOn: 'borrower', title: 'No completed exit recorded', how: EXIT_PROBLEM_MSG.no_exit },
  future_exit: { waitingOn: 'nobody', title: 'The exit has not happened yet', how: EXIT_PROBLEM_MSG.future_exit },
  exit_expired: { waitingOn: 'nobody', title: 'Outside the 3-year window', how: EXIT_PROBLEM_MSG.exit_expired },
};

/* The order the panel reads in: our own work first (it is the only part anyone
   here can finish today), then what we are waiting on, then the facts. */
const TODO_ORDER = [
  'documents_waiting', 'ready_to_verify',
  'no_documents', 'document_rejected', 'open_request', 'no_exit',
  'future_exit', 'exit_expired',
];

function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; }

function addressOf(pa) {
  // A row stored as a bare one-line string (public-records import before the
  // shape fix) still reads correctly rather than as "A past project".
  if (typeof pa === 'string') return pa.trim() || 'A past project';
  if (!pa || typeof pa !== 'object') return 'A past project';
  return pa.oneLine
    || [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ')
    || 'A past project';
}

/**
 * What one line still needs — PURE, so the whole truth table is unit-testable
 * with no database. `row` carries the exit verdicts the SQL computed off the
 * frozen window; this function never re-derives a date.
 *
 * A VERIFIED line is not finished if a document on it is still unreviewed or a
 * request is still open: somebody has to answer those either way, and leaving
 * them off the list is how they sit for a month.
 */
function lineTodo(row) {
  const r = row || {};
  const status = String(r.verification_status || '');
  // A REJECTED line is settled — the team decided it is not the borrower's, a
  // duplicate, or wrong — so it carries NO outstanding work (owner-directed
  // 2026-08-10, #40). It never nags anyone.
  if (status === 'rejected') return [];
  const verified = r.is_verified === true;
  // A recorded non-counting review outcome — "not verified" or one of the two
  // "unable to verify" reasons — is a DECISION: the reviewer has looked, so the
  // line never generates a "verify me" nag (matches the "waiting for review"
  // banner, which counts only genuinely-pending lines). Real outstanding items
  // (a document waiting to be reviewed, an open request) still surface below.
  const reviewDecided = status === 'not_verified' || status === 'unable_docs' || status === 'unable_mismatch';
  const codes = [];

  // Only ONE exit verdict can be true, and each is terminal for verification —
  // so nothing below claims the line is ready while the exit is unusable.
  const exitProblem = r.no_exit ? 'no_exit' : r.future_exit ? 'future_exit' : r.exit_expired ? 'exit_expired' : null;

  if (int(r.docs_waiting) > 0) codes.push('documents_waiting');
  if (int(r.open_request_count) > 0) codes.push('open_request');

  if (!verified && !reviewDecided) {
    if (exitProblem) codes.push(exitProblem);
    if (int(r.docs_rejected) > 0) codes.push('document_rejected');
    else if (int(r.doc_count) === 0 && !exitProblem) codes.push('no_documents');
    // Everything a reviewer needs is in front of them: an in-window exit, at
    // least one accepted document, and nothing left to read. The only thing
    // standing between this line and the experience count is the click.
    if (!exitProblem && int(r.docs_accepted) > 0 && int(r.docs_waiting) === 0 && int(r.docs_rejected) === 0) {
      codes.push('ready_to_verify');
    }
  } else if (verified && exitProblem === 'exit_expired') {
    // A verified line whose exit has aged out still shows as verified but counts
    // toward nothing — the exact "verified but counts toward nothing" confusion
    // the verify gate exists to prevent, so say it plainly.
    codes.push('exit_expired');
  }

  return TODO_ORDER.filter((c) => codes.includes(c)).map((code) => ({ code, ...LINE_TODO[code] }));
}

/** The headline: what the desk owes vs what the borrower owes. */
function summarize(lines) {
  const s = { lines: 0, items: 0, us: 0, borrower: 0 };
  for (const l of lines || []) {
    if (!l.todo || !l.todo.length) continue;
    s.lines += 1;
    for (const t of l.todo) {
      s.items += 1;
      if (t.waitingOn === 'us') s.us += 1;
      else if (t.waitingOn === 'borrower') s.borrower += 1;
    }
  }
  return s;
}

/** The experience shortfall, in the same words the sign-off gate uses. */
function shortfallOf(verified, need) {
  const out = [];
  const gap = (k, one, many) => {
    const n = int(need[k]) - int(verified[k]);
    if (n > 0) out.push({ bucket: k, short: n, text: `${n} more ${n === 1 ? one : many}` });
  };
  gap('flips', 'flip', 'flips');
  gap('holds', 'hold', 'holds');
  gap('ground', 'ground-up', 'ground-up');
  return out;
}

const LINE_SQL = (exitSql) => `
  SELECT t.id, t.borrower_id, t.property_address, t.deal_type, t.is_verified,
         t.verification_status, t.entered_by_kind, t.entered_at,
         (${exitSql}) AS exit_date,
         (${exitSql}) IS NULL AS no_exit,
         (${exitSql}) > CURRENT_DATE AS future_exit,
         (${exitSql}) < (CURRENT_DATE - INTERVAL '36 months') AS exit_expired,
         (SELECT count(*)::int FROM documents d
           WHERE d.track_record_id = t.id AND d.is_current) AS doc_count,
         (SELECT count(*)::int FROM documents d
           WHERE d.track_record_id = t.id AND d.is_current
             AND COALESCE(d.review_status,'pending') = 'pending') AS docs_waiting,
         (SELECT count(*)::int FROM documents d
           WHERE d.track_record_id = t.id AND d.is_current
             AND COALESCE(d.review_status,'') = 'accepted') AS docs_accepted,
         (SELECT count(*)::int FROM documents d
           WHERE d.track_record_id = t.id AND d.is_current
             AND COALESCE(d.review_status,'') = 'rejected') AS docs_rejected,
         (SELECT COALESCE(json_agg(json_build_object(
                 'id', ci.id, 'label', ci.label, 'status', ci.status,
                 'application_id', ci.application_id) ORDER BY ci.created_at), '[]'::json)
            FROM checklist_items ci
           WHERE ci.track_record_id = t.id AND ci.status <> 'satisfied') AS open_requests
    FROM track_records t
   WHERE t.borrower_id = ANY($1::uuid[])
   ORDER BY t.is_verified, (${exitSql}) DESC NULLS LAST, t.created_at DESC
   LIMIT 200`;

/**
 * The whole picture for one file. `borrowerId` narrows it to ONE person on a
 * co-borrower file — the section has a person switcher, and a to-do list for
 * somebody who is not on screen is noise. Omit it for the file's whole set.
 */
/* One row shape for every consumer — the app-scoped to-do and the borrower-
   scoped profile lens read the SAME mapping, so a line can never carry one
   code on the loan file and another on the profile. */
function mapLines(rows) {
  return rows.map((r) => {
    const requests = Array.isArray(r.open_requests) ? r.open_requests : [];
    const todo = lineTodo({ ...r, open_request_count: requests.length });
    return {
      id: r.id,
      borrowerId: r.borrower_id,
      address: addressOf(r.property_address),
      dealType: r.deal_type || '',
      exitDate: r.exit_date ? String(r.exit_date).slice(0, 10) : null,
      isVerified: r.is_verified === true,
      status: r.verification_status || 'pending',
      selfReported: r.entered_by_kind === 'borrower',
      docCount: int(r.doc_count),
      docsWaiting: int(r.docs_waiting),
      openRequests: requests,
      todo,
    };
  }).filter((l) => l.todo.length);
}

/**
 * THE PROFILE LENS (mega-workspace phase D): the borrower CRM profile mounts
 * the same Track Record Center the loan file has, minus everything that only
 * exists on a file — no claim, no registration, no findings gate. What it DOES
 * carry: the per-line to-do codes (the ledger's REO reasons + chips) and the
 * borrower's own VERIFIED in-window counts (the tier ladder), both from the
 * same definitions the loan file reads. Best-effort shape mirrors
 * trackRecordTodo's: an unreadable database answers `unreadable`, never throws.
 */
async function borrowerTrackRecordView(borrowerId, { client = null } = {}) {
  const EXP = require('./experience');
  if (!client) client = require('../db');
  const empty = { lines: [], verified: null, unreadable: false };
  if (!borrowerId) return empty;
  let rows = [];
  try {
    rows = (await client.query(LINE_SQL(EXP.EXIT_DATE_SQL), [[borrowerId]])).rows;
  } catch (_) { return { ...empty, unreadable: true }; }
  let verified = null;
  try {
    verified = await EXP.countBorrowersExperience([borrowerId], client, { verifiedOnly: true });
  } catch (_) { verified = null; }
  return { lines: mapLines(rows), verified, unreadable: false };
}

async function trackRecordTodo(appId, { borrowerId = null, client = null } = {}) {
  const EXP = require('./experience');
  if (!client) client = require('../db');
  const empty = {
    ok: true, summary: { lines: 0, items: 0, us: 0, borrower: 0 },
    lines: [], findings: [], experience: null, unreadable: false,
  };
  if (!appId) return empty;
  let app;
  try {
    app = (await client.query(
      `SELECT id, borrower_id, co_borrower_id,
              requested_exp_flips, requested_exp_holds, requested_exp_ground
         FROM applications WHERE id=$1`, [appId])).rows[0];
  } catch (_) { return { ...empty, unreadable: true }; }
  if (!app) return empty;

  let ids = EXP.fileBorrowerIds(app);
  // A borrower id that is not on this file is ignored rather than honoured — the
  // route is file-scoped, and reading a stranger's track record through it would
  // be a scope hole rather than a filter.
  if (borrowerId && ids.includes(borrowerId)) ids = [borrowerId];
  if (!ids.length) return empty;

  let rows = [];
  try {
    rows = (await client.query(LINE_SQL(EXP.EXIT_DATE_SQL), [ids])).rows;
  } catch (_) { return { ...empty, unreadable: true }; }

  const lines = mapLines(rows);

  // The two other things the gate refuses on, read from the modules that own
  // them — never re-stated here.
  let findings = [];
  try { findings = await require('./track-record-findings').openForFile(appId, client); } catch (_) { findings = []; }

  let experience = null;
  try {
    const claimed = EXP.requestedFromApp(app);
    // THE REGISTRATION IS ASKED FIRST — the same 2026-08-09 ordering the
    // sign-off gate got: a claim somebody lowered to zero UNDER a live
    // registration still owes the registered need, and gating this block on
    // the claim alone made the to-do say "no experience required" on the
    // exact file the gate refuses. registeredExperienceNeed falls back to
    // the claim when nothing is registered, so one call answers both shapes.
    const need = await EXP.registeredExperienceNeed(appId, client, claimed);
    if (EXP.hasRequirement(claimed) || EXP.hasRequirement(need)) {
      const verified = await EXP.countBorrowersExperience(EXP.fileBorrowerIds(app), client, { verifiedOnly: true });
      const reg = (await client.query(
        `SELECT 1 FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
      experience = {
        claimed, need, verified, registered: !!reg,
        shortfall: shortfallOf(verified, need),
      };
    }
  } catch (_) { experience = null; }

  const summary = summarize(lines);
  // `registered` is INFORMATIONAL, never blocking: since 2026-08-06 the gate
  // signs off a fully-verified claim with no registration (Products & Pricing's
  // own condition is what demands one), so `ok` turns on the SHORTFALL alone —
  // the old `!registered` term made the to-do read "not done" on files the
  // gate would clear.
  const ok = !summary.items && !findings.length
    && !(experience && experience.shortfall.length);
  return { ok, summary, lines, findings, experience, unreadable: false };
}

module.exports = {
  trackRecordTodo,
  borrowerTrackRecordView,
  lineTodo,
  summarize,
  shortfallOf,
  addressOf,
  EXIT_PROBLEM_MSG,
  LINE_TODO,
  TODO_ORDER,
};
