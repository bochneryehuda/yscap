'use strict';

/**
 * ONE VISIT, ONE LEAD — and what makes a visitor a lead at all (owner-directed 2026-08-21, item 24).
 *
 * The owner: *"Everybody that is using our marketing site and is generating a term sheet is now
 * getting a lead … You need to make sure that if it's on one session, it only gets one lead and only
 * gets the one loan officer, even if he's exporting several term sheets and he's pricing several
 * deals. The main thing is that only if he puts in his contact information, either a phone number or
 * an email, then he should become a lead. If he's just generating term sheets, he should not become a
 * lead, not get into loan officers' notifications that somebody generated a term sheet, only if it
 * was with contact information. If somebody is using the loan officers' specific link, then the loan
 * officer should get a notification the same way he's getting now, with the full details of his term
 * sheet … and it should specifically say in the email, letting them know that it was from their
 * link."*
 *
 * WHAT WAS ALREADY TRUE, AND WHAT WAS NOT. The 2026-08-07 and 2026-08-11 rounds already made one
 * visit stick to ONE OFFICER (`lead-assignment.findRecentAssignment`) and kept a nameless export out
 * of the working queue. What they did not do is stop the visit producing one ROW PER SUBMISSION: a
 * PDF, an Excel and a proof-of-funds are three POSTs, and pricing a second property is a fourth — so
 * one person at one sitting arrived in an officer's book as four leads. This module is the missing
 * half: the visit's FIRST submission creates the lead and every later one ENRICHES that same row.
 *
 * TWO SEPARATE QUESTIONS, KEPT SEPARATE ON PURPOSE:
 *   · WHO IS THIS?      `isContactable` — an email or a phone number. A NAME IS NOT CONTACT: a name
 *                       with no way to reach anybody cannot be followed up, which is the whole point
 *                       of a lead. (This narrows the 2026-08-07 reading, which counted a name, to the
 *                       owner's own words here — "either a phone number or an email".)
 *   · IS THIS THE SAME VISIT?  the session id the page keeps in `sessionStorage` — one visit, nothing
 *                       personal in it, gone when the tab closes.
 *
 * WHY MERGE ON THE SESSION AND NOTHING ELSE. Merging on the EMAIL would silently swallow a visitor's
 * second, deliberate message days later — and this codebase's standing rule is the opposite: "a
 * visitor's second message or corrected submission must always land and notify". The session id is
 * exactly the unit the owner named, and it is the only one that cannot absorb a genuinely new
 * conversation.
 *
 * NOTHING IS EVER LOST BY MERGING. Every repeat still files its own generated PDF onto the lead and
 * writes its own line on the lead's activity feed, so "they priced three deals" is visible on the one
 * row. What stops is the duplicate ROW and the duplicate EMAIL.
 *
 * Pure except `findSessionLead`, which reads one row.
 */

/** The term-sheet family — the tools the owner is describing. A REPEAT from one of these is quiet:
 *  the officer already heard about this visitor on the first one. Deliberately NOT a list of every
 *  tool: a contact message or a loan application typed later in the same visit is a person actually
 *  asking for something, and going silent on it would be a worse bug than a duplicate email. */
const TERM_SHEET_TOOLS = new Set(['term_sheet', 'term_sheet_generated', 'term_sheet_exception']);

/** How long one visit's lead stays enrichable. A session id already means one visit, so this is only
 *  a bound on the lookup — a tab left open for a week is still that visit. */
const SESSION_WINDOW_HOURS = 72;

/** A way to reach the visitor. An email OR a phone number — never a name. */
function isContactable(v) {
  const email = v && v.email != null ? String(v.email).trim() : '';
  const phone = v && v.phone != null ? String(v.phone).replace(/[^0-9]/g, '') : '';
  return !!email || phone.length >= 7;
}

/** Plain words for what a submission left us, used on the sales-desk notice so nobody hunts for a
 *  name that was never given — and so "a name but no way to call them" reads as what it is. */
function contactGapNote(v) {
  const hasName = !!(v && v.name && String(v.name).trim());
  return hasName
    ? 'They gave a name but no email and no phone, so there is nobody to follow up with.'
    : 'They left no name, email or phone, so there is nobody to follow up with.';
}

/** The line the officer's own email carries when the visitor arrived on THEIR link (owner-directed:
 *  "it should specifically say in the email, letting them know that it was from their link"). One
 *  definition — the route never retypes it. */
function officerLinkNote(code) {
  const c = String(code || '').trim();
  return `This came from YOUR personal link${c ? ` (?lo=${c})` : ''} — the visitor arrived on your own branded page, `
    + 'so this lead is yours and was not put into the rotation.';
}

/**
 * The lead this visit already has, if any.
 *
 * Matched on the session id ALONE (see the header). Includes an ARCHIVED row on purpose: a visit that
 * began with a nameless export and later left a phone number must UPGRADE that row rather than leave
 * the archived one behind and open a second — otherwise the officer sees the export twice, once as
 * dead weight.
 *
 * Never throws: a lookup hiccup falls through to inserting a new row, which is exactly the behaviour
 * that existed before this module.
 */
async function findSessionLead(client, sessionId, opts = {}) {
  const sid = sessionId ? String(sessionId) : '';
  if (!sid) return null;
  const hours = Number(opts.windowHours) > 0 ? Number(opts.windowHours) : SESSION_WINDOW_HOURS;
  try {
    const r = await client.query(
      `SELECT id, tool, name, email, phone, officer_id, officer_code, assigned_via, status, message,
              company, property_address, property_type, program, loan_amount, created_at
         FROM leads
        WHERE session_id = $1
          AND created_at > now() - (($2 || ' hours')::interval)
        ORDER BY created_at ASC
        LIMIT 1`, [sid, String(hours)]);
    return r.rows[0] || null;
  } catch (e) {
    console.warn('[leads] session-lead lookup failed:', e && e.message);
    return null;
  }
}

/** The columns a later submission may FILL IN. Never overwrite — what the visitor told us first
 *  stands, and a later blank can never erase it. */
const FILLABLE = ['name', 'email', 'phone', 'company', 'property_address', 'property_type',
  'loan_amount', 'program', 'message'];

/**
 * What this submission does to the visit's existing lead — PURE, so every branch is testable with no
 * database.
 *
 * @param {object|null} existing  the row from findSessionLead
 * @param {object} incoming { tool, name, email, phone, officerId, officerCode, assignedVia, facts, message }
 * @returns {object} {
 *   action: 'insert' | 'enrich',
 *   set: {column: value}      // only columns that should actually change
 *   notify: boolean,          // does anybody hear about THIS submission?
 *   reason: string,           // why (for the audit line and the tests)
 *   becameContactable, gainedOfficer
 * }
 */
function planSessionSubmission(existing, incoming = {}) {
  const inc = incoming || {};
  if (!existing) {
    return {
      action: 'insert', set: {}, notify: true, reason: 'first_submission_of_the_visit',
      becameContactable: isContactable(inc), gainedOfficer: !!inc.officerId,
    };
  }

  const set = {};
  const facts = inc.facts || {};
  const candidate = {
    name: inc.name, email: inc.email, phone: inc.phone, message: inc.message,
    company: facts.company, property_address: facts.propertyAddress,
    property_type: facts.propertyType, program: facts.program, loan_amount: facts.loanAmount,
  };
  for (const col of FILLABLE) {
    const cur = existing[col];
    const next = candidate[col];
    const curBlank = cur == null || (typeof cur === 'string' && cur.trim() === '');
    const nextReal = next != null && !(typeof next === 'string' && next.trim() === '');
    if (curBlank && nextReal) set[col] = next;
  }

  // The officer is settled once. A visit that started anonymous and then landed on an officer's own
  // branded link gains one; a visit that already has one NEVER changes hands (the 2026-08-07 rule).
  const gainedOfficer = !existing.officer_id && !!inc.officerId;
  if (gainedOfficer) {
    set.officer_id = inc.officerId;
    if (inc.officerCode) set.officer_code = inc.officerCode;
    if (inc.assignedVia) set.assigned_via = inc.assignedVia;
  }

  const wasContactable = isContactable(existing);
  const nowContactable = wasContactable || isContactable(inc);
  const becameContactable = !wasContactable && nowContactable;

  /* A NAMELESS EXPORT THAT LATER LEAVES A PHONE NUMBER BECOMES A REAL LEAD. `archived` is where an
     anonymous export is parked (out of the working queue); the moment there is somebody to call, or
     an officer owns it, it belongs in the queue. Only ever `archived → new`: a status a human moved
     ('contacted', 'converted', 'archived by hand') is theirs and is never rewritten from here. */
  if (existing.status === 'archived' && (becameContactable || gainedOfficer)) set.status = 'new';

  // WHO HEARS ABOUT THIS ONE. A repeat export is silent — that is the whole complaint. What is NOT
  // silent: the visit becoming followable, the officer becoming known, or a submission from a tool
  // where the visitor is actually asking us for something.
  let notify = false, reason = 'repeat_submission_of_the_same_visit';
  if (becameContactable) { notify = true; reason = 'the_visit_left_contact_details'; }
  else if (gainedOfficer) { notify = true; reason = 'the_visit_landed_on_an_officer_link'; }
  else if (!TERM_SHEET_TOOLS.has(String(inc.tool || ''))) { notify = true; reason = 'a_deliberate_submission'; }

  return { action: 'enrich', set, notify, reason, becameContactable, gainedOfficer };
}

module.exports = {
  TERM_SHEET_TOOLS, SESSION_WINDOW_HOURS, FILLABLE,
  isContactable, contactGapNote, officerLinkNote, findSessionLead, planSessionSubmission,
};
