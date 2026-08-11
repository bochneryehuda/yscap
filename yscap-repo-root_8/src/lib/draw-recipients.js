'use strict';
/**
 * Draw-send RECIPIENTS for a file — the borrower and (when present) the co-borrower, each with a
 * display name + email. Used by the draw desk so staff can CHOOSE who a directed draw send goes to
 * (owner-directed 2026-07-21): the Sitewire access invitation and the DocuSign wire form each let the
 * coordinator pick the borrower or the co-borrower before sending. Ongoing draw NOTIFICATIONS always go
 * to BOTH (that fan-out is `notify.notifyAppBorrowers`, which already includes both) — this is only for
 * the two one-to-one sends where a single recipient is required.
 */
// Lazy so the PURE helpers (replyCcFrom) can be required without pulling in `pg` — the DB is
// only touched when a resolver that reads the file is actually called.
let _db = null;
const db = () => (_db || (_db = require('../db')));

async function drawRecipients(appId) {
  const r = (await db().query(
    `SELECT b.id  AS b_id,  NULLIF(btrim(concat_ws(' ', b.first_name,  b.last_name)),  '') AS b_name,  b.email  AS b_email,
            cb.id AS c_id,  NULLIF(btrim(concat_ws(' ', cb.first_name, cb.last_name)), '') AS c_name, cb.email AS c_email
       FROM applications a
       JOIN borrowers b  ON b.id  = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1`, [appId])).rows[0];
  if (!r) return { borrower: null, coBorrower: null };
  return {
    borrower: r.b_id ? { id: r.b_id, name: r.b_name || 'Borrower', email: r.b_email || null } : null,
    coBorrower: r.c_id ? { id: r.c_id, name: r.c_name || 'Co-borrower', email: r.c_email || null } : null,
  };
}

/**
 * The internal people who must be looped in on EVERY borrower draw email (owner-directed
 * 2026-07-27: "in the email that the borrowers are receiving loop always in the loan officer
 * and the draw coordinator"). Returned as `bccExtra` for the notify helpers — a silent
 * monitoring copy, the same shape the assigned loan officer already rides on (notify.js), so
 * the borrower's email stays clean and no internal address is exposed to them.
 *
 * Best-effort by design: a lookup failure returns just the shared inbox, never throws into a
 * notification path.
 */
const DRAW_DESK_INBOX = 'draws@yscapgroup.com';

/** Lowercase + trim + de-duplicate an email list, dropping blanks. */
function uniqEmails(list) {
  return [...new Set((list || []).map((e) => String(e == null ? '' : e).trim().toLowerCase()).filter(Boolean))];
}

/**
 * THE FILE'S OWN draw coordinator — one definition, used by every surface that has to reach
 * "the draw coordinator assigned to THIS file" (owner-directed 2026-07-28). PILOT has no
 * `applications.draw_coordinator_id` pointer (`application_assignees` carries only
 * loan_officer / processor — db/103), so the assignment is expressed by what the coordinator
 * actually DID on the file, in this precedence:
 *
 *   1. `sitewire_property_links.draw_setup_started_by` — whoever pressed "Start the draw
 *      process". Written COALESCE-style (fill-only, routes/sitewire.js), so it is the durable
 *      per-file record of who owns this file's draws.
 *   2. A LIVE draw hand-off in their Workflow — `workflow_items` routed `to_role =
 *      'draw_coordinator'` with a resolved `to_staff_id` (portal-draws, trustpoint-intake,
 *      workflow-automation all route this way). Keyed on the ROLE, not on a submission-type
 *      list, so a hand-off type added later is covered without touching this.
 *
 * Deactivated staff and blank emails are excluded (they can't receive anything). Returns
 * `[{ id, full_name, email, src }]`, most-specific first, deterministic. NEVER throws — an
 * empty list simply means "nobody is assigned yet", and every caller falls back to the desk.
 */
async function drawCoordinatorsForFile(appId) {
  if (!appId) return [];
  try {
    const r = await db().query(
      `WITH cand AS (
            SELECT pl.draw_setup_started_by AS staff_id, 'started_draw'::text AS src, 1 AS pref
              FROM sitewire_property_links pl
             WHERE pl.application_id = $1 AND pl.draw_setup_started_by IS NOT NULL
            UNION ALL
            SELECT wi.to_staff_id, 'workflow'::text AS src, 2 AS pref
              FROM workflow_items wi
             WHERE wi.application_id = $1 AND wi.to_role = 'draw_coordinator'
               AND wi.to_staff_id IS NOT NULL AND wi.status IN ('open','in_progress')
          ),
          pick AS (
            -- is_external=false: the draw coordinator is always internal (the sources above are
            -- staff-only actions), but the filter keeps an external/broker user out of this staff
            -- fan-out by construction (TPO PORTAL invariant, CLAUDE.md).
            SELECT DISTINCT ON (su.id) su.id, su.full_name, su.email, c.src, c.pref
              FROM cand c JOIN staff_users su ON su.id = c.staff_id
             WHERE su.is_active = true AND su.is_external = false AND NULLIF(btrim(su.email),'') IS NOT NULL
             ORDER BY su.id, c.pref
          )
       SELECT id, full_name, email, src FROM pick ORDER BY pref, lower(email)`, [appId]);
    return r.rows;
  } catch (_) { return []; }   // never throw into a notification / e-sign path
}

/** Every ACTIVE draw coordinator on the team — the desk-wide fallback when a file has none. */
async function drawDeskCoordinators() {
  try {
    const r = await db().query(
      `SELECT id, full_name, email FROM staff_users
        WHERE is_active = true AND is_external = false AND role = 'draw_coordinator' AND NULLIF(btrim(email),'') IS NOT NULL
        ORDER BY lower(email)`);
    return r.rows.map((x) => ({ ...x, src: 'desk' }));
  } catch (_) { return []; }
}

/**
 * WHO to reach for a file's draws: its own coordinator(s) when one is assigned, else the
 * whole active desk — so a draw message is never uncovered. The one place that fallback is
 * decided; every caller below uses it.
 */
async function coordinatorsOrDesk(appId) {
  const people = await drawCoordinatorsForFile(appId);
  return people.length ? people : await drawDeskCoordinators();
}

/**
 * The draw DESK for a file, as a BCC list: the shared draws@ inbox plus the coordinator(s)
 * above. Called with no `appId` it is exactly the old desk-wide behavior (back-compat for
 * callers that have no file in hand).
 */
async function drawTeamBcc(appId) {
  const people = await coordinatorsOrDesk(appId);
  return uniqEmails([DRAW_DESK_INBOX, ...people.map((p) => p.email)]);
}

/**
 * The file's LOAN OFFICER(s) — the primary plus any full-access assistant officer (#113
 * `application_assignees`), with the denormalized `applications.loan_officer_id` pointer as a
 * belt-and-suspenders second source (the db/103 trigger keeps them in lock-step, but a file
 * that somehow carries only the pointer must still reach its officer).
 */
async function fileLoanOfficerEmails(appId) {
  if (!appId) return [];
  try {
    // is_external=false on both branches: on a TPO file the loan_officer IS the external broker,
    // and this feeds the draw email loop-in — a broker must never be a recipient of an internal
    // draw email (TPO PORTAL firm-isolation invariant, CLAUDE.md). Retail is unaffected
    // (is_external is NOT NULL DEFAULT false).
    const r = await db().query(
      `SELECT su.email
         FROM application_assignees aa JOIN staff_users su ON su.id = aa.staff_id
        WHERE aa.application_id = $1 AND aa.removed_at IS NULL AND aa.role = 'loan_officer'
          AND su.is_active = true AND su.is_external = false AND NULLIF(btrim(su.email),'') IS NOT NULL
        UNION
       SELECT su.email
         FROM applications a JOIN staff_users su ON su.id = a.loan_officer_id
        WHERE a.id = $1 AND su.is_active = true AND su.is_external = false AND NULLIF(btrim(su.email),'') IS NOT NULL`, [appId]);
    return uniqEmails(r.rows.map((x) => x.email));
  } catch (_) { return []; }
}

/**
 * THE LOOP-IN for every borrower draw email (owner-directed 2026-07-28: "on every email that
 * is going out to the borrower about the draw process the draw coordinator and the loan
 * officer should always be looped into that email"). The file's draw coordinator(s) + the
 * draws@ desk + the file's loan officer(s), as a BCC list. Applied at the ONE borrower
 * fan-out chokepoint (`notify.js`, keyed on the notification's 'draws' category), so every
 * draw email — the ones that exist today and the ones added later — carries it without each
 * call site remembering to. Never throws.
 */
async function drawLoopInBcc(appId) {
  const [team, officers] = await Promise.all([drawTeamBcc(appId), fileLoanOfficerEmails(appId)]);
  return uniqEmails([...team, ...officers]);
}

/**
 * THE LOOP-IN for a REPLY on a file that is in a draw process (owner-directed 2026-08-06:
 * "I only see in my email CC the officer and myself, I don't see the draw coordinator … we
 * need everything to be visible in the CC line … everybody that is receiving this email
 * should be on the CC line, including the loan officer and the draw coordinator").
 *
 * Returns the file's draw coordinator(s) + the draws@ desk + the file's loan officer(s) — but
 * ONLY when the file actually has an assigned draw coordinator (`drawCoordinatorsForFile`
 * non-empty), so an ordinary reply on a file that is NOT in a draw process never Cc's the draw
 * desk. This deliberately does NOT fall back to the whole desk the way `drawLoopInBcc` does:
 * an OUTBOUND draw email is known-to-be-a-draw by its notification category, but a REPLY path
 * (the file inbox / the email-center reply) can't tell a draw thread from any other, so the
 * file's own coordinator being assigned IS the signal that this file's threads should loop the
 * draw team in. Never throws.
 *
 * @returns {Promise<string[]>} lowercased, de-duped emails (empty when no coordinator).
 */
async function drawReplyLoopIn(appId) {
  return (await drawReplyLoopInDetailed(appId)).map((x) => x.email);
}

/**
 * The same loop-in as `drawReplyLoopIn`, but as `[{ email, name }]` — so a recipient PREVIEW
 * (the reply composer's chips) can show WHO is looped in, which is exactly what the owner asked
 * to be able to see. The email-only `drawReplyLoopIn` is derived from this, so the preview and
 * the actual send can never disagree about who the draw loop-in is. Never throws.
 */
async function drawReplyLoopInDetailed(appId) {
  if (!appId) return [];
  const coords = await drawCoordinatorsForFile(appId);
  if (!coords.length) return [];                 // file not in a draw process → loop nobody in
  const officers = await fileLoanOfficerEmails(appId);
  const out = [];
  const seen = new Set();
  const add = (email, name) => {
    const e = String(email == null ? '' : email).trim().toLowerCase();
    if (!e || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, name: name || e });
  };
  for (const c of coords) add(c.email, c.full_name);
  add(DRAW_DESK_INBOX, 'YS Capital Draw Desk');
  for (const e of officers) add(e);              // the LO is usually already an assignee chip
  return out;
}

/**
 * Compose the visible Cc for a reply: the draw loop-in, minus anyone already a TO recipient and
 * minus the sender (never Cc a person on their own message). PURE — so the exclusion/de-dup is
 * unit-tested with no DB. Returns a lowercased, de-duped array (possibly empty).
 */
function replyCcFrom(loopIn, { toEmails = [], sender = '' } = {}) {
  const drop = new Set([...(Array.isArray(toEmails) ? toEmails : []), sender]
    .map((e) => String(e == null ? '' : e).trim().toLowerCase()).filter(Boolean));
  return uniqEmails(loopIn).filter((e) => !drop.has(e));
}

/**
 * The draw coordinator as DocuSign CC VIEWERS on the wire-request package (owner-directed
 * 2026-07-28: "the draw coordinator assigned to a file should always be added as a viewer on
 * the DocuSign package that goes out for the wire request form … receiving notifications when
 * it's being signed"). A DocuSign carbon copy is a real recipient: they get the sent/viewed/
 * signed/completed notifications and the executed copy + Certificate of Completion.
 *
 * Returns `[{ email, name }]` — the file's coordinator(s), or the desk when none is assigned,
 * PLUS the shared draws@ inbox so the envelope is covered either way. Never throws; the
 * caller de-dupes against the signers and drops anything DocuSign would reject.
 */
async function drawEnvelopeViewers(appId) {
  const people = await coordinatorsOrDesk(appId);
  const candidates = people.map((p) => ({ email: p.email, name: p.full_name || p.email }));
  candidates.push({ email: DRAW_DESK_INBOX, name: 'YS Capital Draw Desk' });
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = String(c.email || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ email: key, name: c.name || key });
  }
  return out;
}

module.exports = {
  drawRecipients, drawTeamBcc, DRAW_DESK_INBOX,
  drawCoordinatorsForFile, drawDeskCoordinators, coordinatorsOrDesk,
  fileLoanOfficerEmails, drawLoopInBcc, drawEnvelopeViewers,
  drawReplyLoopIn, drawReplyLoopInDetailed, replyCcFrom,
};
