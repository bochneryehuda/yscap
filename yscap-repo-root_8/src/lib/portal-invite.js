'use strict';
/**
 * WHERE THIS PERSON STANDS WITH THE PORTAL — one definition, for every borrower
 * on every file (owner-directed 2026-08-02: the file must show, for the borrower
 * AND the co-borrower, whether they were invited and when, with a way to send it
 * again, and whether they joined and when they last signed in).
 *
 * THE DEFECT THIS CLOSES. Two invite buttons existed and both were WRITE-ONLY:
 * you pressed one, a green line appeared for a moment, and nothing on the screen
 * ever recorded it. "Has anyone invited this person?" had no answer, so the only
 * safe move was to press it again — which is how a borrower ends up with four
 * identical invitations.
 *
 * WHY A CHOKEPOINT AND NOT A COLUMN WRITE AT EACH DOOR. There are FOUR doors
 * that send a portal invitation, and they are in three different files:
 *   · staff.js  inviteBorrowerToFile   (the file's invite + the co-borrower's own
 *                                       + the new-file create path)
 *   · staff.js  POST /invite-to-portal (no file needed — the CRM door)
 *   · borrower.js  the co-borrower invite sent from the borrower's own portal
 *   · auth/index.js  the claim email sent when somebody self-registers onto an
 *                    existing record
 * A stamp hand-written at three of them is a stamp that silently disagrees with
 * itself at the fourth. `recordInviteSent` is the ONE writer; add a fifth door
 * and it calls this too.
 *
 * IT CAN NEVER BREAK AN INVITATION. Every write here is best-effort and swallows
 * its own error: failing to record that we sent an email is annoying, failing to
 * SEND it because the recording failed is a real outage. Reads degrade to a
 * shaped "we don't know" rather than throwing into a page load.
 */

const db = require('../db');

/**
 * Record that a portal invitation just went out to this person.
 *
 * @param borrowerId  who it was sent to (the PERSON — invitations are per-person,
 *                    exactly like the login they lead to)
 * @param email       the address it actually went to, so an invite sent to a
 *                    since-corrected address reads as stale instead of counting
 *                    as "we told them"
 * @param byStaffId   the staffer who sent it; NULL when the borrower's own side
 *                    did (a co-borrower invited from the borrower portal, or the
 *                    self-registration claim email) — that is a real distinction
 *                    the panel shows, not a missing value
 */
async function recordInviteSent(borrowerId, { email = null, byStaffId = null, client = db } = {}) {
  if (!borrowerId) return false;
  try {
    const r = await client.query(
      `UPDATE borrowers
          SET portal_invited_at       = now(),
              /* FIRST is filled once and never moved — it is what "they have been
                 sitting on this for three weeks" is measured from. */
              portal_first_invited_at = COALESCE(portal_first_invited_at, now()),
              portal_invite_count     = COALESCE(portal_invite_count, 0) + 1,
              portal_invited_by       = $2,
              portal_invited_email    = NULLIF($3, ''),
              updated_at              = now()
        WHERE id = $1`,
      [borrowerId, byStaffId || null, String(email || '').trim()]);
    return r.rowCount > 0;
  } catch (_) {
    // Never let bookkeeping take an invitation down with it.
    return false;
  }
}

/** The columns this module owns, as one SELECT fragment, so no caller re-types them. */
const PORTAL_SELECT = `
  b.portal_invited_at, b.portal_first_invited_at, b.portal_invite_count,
  b.portal_invited_by, b.portal_invited_email,
  (ba.borrower_id IS NOT NULL) AS has_account,
  ba.created_at    AS portal_joined_at,
  ba.last_login_at AS portal_last_login_at`;

/**
 * Read the portal standing of one or more borrowers.
 * Returns a Map keyed by borrower id; a borrower we cannot read is simply absent
 * (the caller renders "we don't know", never a wrong claim).
 */
async function portalStateFor(borrowerIds, client = db) {
  const ids = (Array.isArray(borrowerIds) ? borrowerIds : [borrowerIds]).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  try {
    const r = await client.query(
      `SELECT b.id, b.email, b.last_seen_at, ${PORTAL_SELECT},
              s.full_name AS invited_by_name
         FROM borrowers b
         LEFT JOIN borrower_auth ba ON ba.borrower_id = b.id
         LEFT JOIN staff_users  s  ON s.id = b.portal_invited_by
        WHERE b.id = ANY($1::uuid[])`, [ids]);
    for (const row of r.rows) out.set(String(row.id), shapePortal(row));
  } catch (_) { /* shaped emptiness beats a thrown page */ }
  return out;
}

/**
 * Turn a borrower row into the block every surface renders. PURE — it takes the
 * row it is given and invents nothing, so it unit-tests with no database.
 *
 * `invitedEmailStale` is the one derived judgement: we sent the invitation to an
 * address the profile no longer carries, so the person may never have received
 * it and "invited 3 weeks ago" would be misleading on its own.
 */
function shapePortal(row) {
  const r = row || {};
  const invitedEmail = r.portal_invited_email ? String(r.portal_invited_email) : null;
  const currentEmail = r.email ? String(r.email) : null;
  return {
    hasAccount: !!r.has_account,
    joinedAt: r.portal_joined_at || null,
    lastLoginAt: r.portal_last_login_at || null,
    lastSeenAt: r.last_seen_at || null,
    invitedAt: r.portal_invited_at || null,
    firstInvitedAt: r.portal_first_invited_at || null,
    inviteCount: Number(r.portal_invite_count || 0) || 0,
    invitedBy: r.portal_invited_by || null,
    invitedByName: r.invited_by_name || null,
    invitedEmail,
    invitedEmailStale: !!(invitedEmail && currentEmail
      && invitedEmail.toLowerCase() !== currentEmail.toLowerCase()),
    canInvite: !!currentEmail,
  };
}

/**
 * THE WORDING, in one place, in the plain language the owner reads.
 * PURE. Returns { state, headline, detail } where `state` is what a badge colours
 * itself on and `headline` is the sentence.
 *
 * The states, in the order a person actually moves through them:
 *   joined      — they have a login (whether we invited them or they signed up)
 *   invited     — we sent it; they have not joined
 *   not_invited — nobody has sent it yet
 *   no_email    — we cannot send it: there is no address on the profile
 */
function describePortalAccess(portal, now = new Date()) {
  const p = portal || {};
  if (p.hasAccount) {
    const detail = p.lastLoginAt
      ? `Last signed in ${ago(p.lastLoginAt, now)}.`
      : 'They have not signed in since joining.';
    return {
      state: 'joined',
      headline: p.joinedAt ? `Joined the portal ${ago(p.joinedAt, now)}.` : 'They have a portal login.',
      detail,
    };
  }
  if (p.invitedAt) {
    const times = p.inviteCount > 1 ? ` (sent ${p.inviteCount} times)` : '';
    const stale = p.invitedEmailStale
      ? ` It went to ${p.invitedEmail}, which is not the address on the profile any more — send it again.`
      : '';
    const who = p.invitedByName ? ` by ${p.invitedByName}` : '';
    return {
      state: 'invited',
      headline: `Invited ${ago(p.invitedAt, now)}${who}${times} — they have not joined yet.`,
      detail: `They can still accept it.${stale}`,
    };
  }
  if (!p.canInvite) {
    return {
      state: 'no_email',
      headline: 'No portal invitation has been sent.',
      detail: 'Add an email address to this profile first.',
    };
  }
  return {
    state: 'not_invited',
    headline: 'No portal invitation has been sent yet.',
    detail: 'They cannot see the loan, upload anything, or sign until they join.',
  };
}

/** "3 days ago" / "today" — plain words, never a raw timestamp in front of the owner. */
function ago(when, now = new Date()) {
  // `new Date(null)` is the epoch, NOT an invalid date — so a missing stamp would
  // render as "56 years ago" on somebody's screen. Refuse a blank up front.
  if (when === null || when === undefined || when === '') return 'at an unknown time';
  const t = when instanceof Date ? when : new Date(when);
  if (!t || Number.isNaN(t.getTime())) return 'at an unknown time';
  const days = Math.floor((now.getTime() - t.getTime()) / 86400000);
  if (days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? 'a month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

module.exports = {
  recordInviteSent, portalStateFor, shapePortal, describePortalAccess,
  PORTAL_SELECT, _internals: { ago },
};
