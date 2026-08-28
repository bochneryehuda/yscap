'use strict';
/**
 * LONG-TERM — matching an Encompass user to a PILOT person.
 *
 * Owner-directed 2026-08-14, choosing between four shapes: **"Auto-match by email,
 * admin confirms."** So this module SUGGESTS and never decides. Nothing it returns
 * takes effect until a human presses a button.
 *
 * WHY THE JOIN KEY AND THE MATCH KEY ARE DIFFERENT THINGS — and why getting this
 * backwards would be the worst bug in the long-term build.
 *
 *   · The JOIN key, forever, is the Encompass LOGIN ID (`sweiss`, `mkatz`). It is
 *     what `LoanTeamMember.UserId.<role>` carries on every loan, it is stable, and
 *     the live probe (2026-08-14) found it on every surface. Once a link is
 *     confirmed, every loan is attributed through that id and email is never read
 *     again.
 *   · The MATCH key — used ONCE, to propose the link to an admin — is the email,
 *     because a login id like `skaff` cannot be recognised as a person by a human
 *     reading a list.
 *
 * WHAT THE LIVE PROBE PROVED ABOUT THAT EMAIL, and every rule below is one of these
 * findings turned into code:
 *
 *   · **10 of the 46 users share `change.me@email.com`.** Auto-matching on it would
 *     hand ten people each other's pipelines. It is a SETTING
 *     (`contacts.placeholderEmails`) because the next lender's placeholder is a
 *     different string.
 *   · **Casing is inconsistent** (`Moshe@` vs `moshe@`) — so compare lowercased.
 *   · **Two real users legitimately share a mailbox family** (`ezra` / `pgrunberger`).
 *     One address matching two people is not a near-miss to be broken by a tiebreak;
 *     it is the exact case where a machine must stop.
 *   · **`fullName` is unusable as a key** — double spaces (`"Malky  Katz"`), trailing
 *     spaces, and demonstrably STALE snapshots inside `/associates` that named the
 *     wrong human entirely. `nameLooksLike` exists to DISPLAY a hint to the admin,
 *     and is deliberately not allowed to produce a suggestion.
 *
 * FAILS TOWARD THE HUMAN. Every ambiguity — two staff on one address, two Encompass
 * users on one address, a placeholder, a blank — produces NO suggestion and a plain
 * reason the admin can read. An unmatched row is a five-second click; a wrong match
 * silently gives somebody another officer's book.
 *
 * PURE. No database, no network. Every input is passed in, so the whole policy is
 * unit-testable without a Postgres and without Encompass.
 */

const DEFAULT_PLACEHOLDER_EMAILS = ['change.me@email.com'];

/** Lowercase + trim. The ONE normalisation, used on both sides of every compare. */
function normalizeEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * Is this address one that identifies nobody?
 *
 * Settings-driven (`contacts.placeholderEmails`) and compared normalised, so a
 * lender who lists `Change.Me@Email.com` is still matched.
 */
function isPlaceholderEmail(email, settings = {}) {
  const list = Array.isArray(settings['contacts.placeholderEmails'])
    ? settings['contacts.placeholderEmails']
    : DEFAULT_PLACEHOLDER_EMAILS;
  const e = normalizeEmail(email);
  if (!e) return true; // nothing to match on is, for our purposes, the same answer
  return list.some((p) => normalizeEmail(p) === e);
}

/**
 * A loose name comparison — for SHOWING the admin why two rows might be the same
 * person. Never used to produce a suggestion; see the header.
 */
function nameLooksLike(a, b) {
  // PUNCTUATION IS STRIPPED FIRST, and that single line is the whole of a bug the
  // owner reported on 2026-08-23: EVERY row on the borrower-match screen read "the
  // names are spelled differently — worth a second look", including
  // "Bluming, Yisroel" against "Yisroel bluming".
  //
  // Case and word order were already handled. What was not is that ENCOMPASS WRITES
  // A NAME AS "Last, First" — so `split(' ')` produced the token `"bluming,"`, with
  // the comma still attached, which equals nothing on the other side. The flag
  // therefore fired on every single loan in the book, which is worse than not having
  // it: a warning that is always on is a warning nobody reads, and it asked a human
  // to second-guess four hundred matches that were all correct.
  //
  // A period goes with it, for "Yisroel M. Bluming"; hyphens and apostrophes are
  // deliberately turned into nothing rather than a space, so "Bat-Sheva" still reads
  // as one word and "O'Brien" does not become "o brien".
  const norm = (v) => String(v == null ? '' : v)
    .replace(/[.,]/g, ' ')
    .replace(/['\u2019-]/g, '')
    .trim().replace(/\s+/g, ' ').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Same words in a different order — "Katz Malky" vs "Malky Katz".
  const words = (s) => s.split(' ').filter(Boolean).sort();
  const wx = words(x);
  const wy = words(y);
  if (wx.join(' ') === wy.join(' ')) return true;
  // ONE SIDE CARRYING A MIDDLE NAME IS THE SAME PERSON. "Yisroel M Bluming" and
  // "Yisroel Bluming" are not two people, and this flag exists to say when a second
  // look is WORTH IT — it gates nothing, a human still answers yes or no on every
  // row. So the expensive direction is a false warning, not a missing one, and the
  // smaller name being wholly contained in the larger counts as agreement.
  //
  // Both sides must carry at least two words: a lone surname inside a full name is
  // not evidence of anything, and treating it as agreement would quietly wave
  // through two different people who share one.
  const [small, large] = wx.length <= wy.length ? [wx, wy] : [wy, wx];
  if (small.length < 2) return false;
  const pool = large.slice();
  return small.every((w) => {
    const at = pool.indexOf(w);
    if (at < 0) return false;
    pool.splice(at, 1);   // consume it, so a repeated word needs a repeat to match
    return true;
  });
}

/** The display name for a PILOT person, tolerating either shape of row. */
function staffName(s) {
  if (!s) return '';
  const full = s.full_name || s.fullName;
  if (full && String(full).trim()) return String(full).trim();
  const first = String(s.first_name || s.firstName || '').trim();
  const last = String(s.last_name || s.lastName || '').trim();
  return `${first} ${last}`.trim();
}

/**
 * Index a list of people by normalised email, keeping EVERY person on an address
 * rather than the last one to win. The collisions are the point — an address held
 * by two people is a refusal, not a lookup miss.
 */
function indexByEmail(rows, getEmail) {
  const idx = new Map();
  for (const r of rows || []) {
    const e = normalizeEmail(getEmail(r));
    if (!e) continue;
    if (!idx.has(e)) idx.set(e, []);
    idx.get(e).push(r);
  }
  return idx;
}

/** Why a row produced no suggestion — plain language, shown to the admin verbatim. */
const NO_MATCH = {
  NO_EMAIL: 'This Encompass user has no email address, so there is nothing to match on.',
  PLACEHOLDER: 'This Encompass user\'s email is a shared placeholder that identifies nobody, so it is never matched automatically.',
  NOT_FOUND: 'No PILOT person uses this email address.',
  AMBIGUOUS_STAFF: 'More than one PILOT person uses this email address, so we cannot tell which one this is.',
  AMBIGUOUS_ENCOMPASS: 'More than one Encompass user shares this email address, so we cannot tell which one this is.',
  STAFF_TAKEN: 'That PILOT person is already linked to a different Encompass user.',
  STAFF_INACTIVE: 'The PILOT person on this address is deactivated, so we are not proposing it.',
  DECIDED: 'A person has already decided this one.',
};

/**
 * Propose links for a whole roster.
 *
 * @param {Array}  encompassUsers  rows of lt_encompass_users (login_id, email, full_name, is_active…)
 * @param {Array}  staffUsers      PILOT people (id, email, is_active, name fields)
 * @param {Object} opts.existing   current lt_staff_links rows, by login id or as a list
 * @param {Object} opts.settings   effective settings
 *
 * @returns {{suggestions: Array, unmatched: Array}} — `suggestions` are proposals
 *   awaiting a human; `unmatched` each carry a `reason` from NO_MATCH. Every
 *   Encompass user appears in exactly one of the two, so the screen can always
 *   account for the whole roster.
 */
function matchRoster(encompassUsers, staffUsers, { existing = [], settings = {} } = {}) {
  const links = new Map();
  const takenStaff = new Set();
  for (const l of Array.isArray(existing) ? existing : Object.values(existing || {})) {
    if (!l) continue;
    const key = String(l.encompass_login_id || l.encompassLoginId || '');
    if (key) links.set(key, l);
    // A staff member with a CONFIRMED link is spoken for. The partial unique index
    // would refuse a second one anyway, and proposing a link nobody can accept is a
    // dead end — the class this codebase keeps having to fix.
    const status = String(l.status || '');
    const sid = l.staff_id || l.staffId;
    if (status === 'confirmed' && sid) takenStaff.add(String(sid));
  }

  const staffByEmail = indexByEmail(staffUsers, (s) => s.email);
  const encByEmail = indexByEmail(encompassUsers, (u) => u.email);

  const suggestions = [];
  const unmatched = [];

  for (const u of encompassUsers || []) {
    const loginId = String(u.login_id || u.loginId || u.id || '');
    if (!loginId) continue;

    const row = {
      loginId,
      encompassName: u.full_name || u.fullName || '',
      email: normalizeEmail(u.email),
      encompassActive: u.is_active !== false,
    };

    // A decision a human already made is never re-litigated — the same rule the
    // finding-decisions ledger exists to enforce on the RTL side. A rejected match
    // that comes back every sync trains people to ignore the screen.
    const link = links.get(loginId);
    if (link && (link.status === 'confirmed' || link.status === 'rejected')) {
      unmatched.push({ ...row, reason: NO_MATCH.DECIDED, decided: link.status });
      continue;
    }

    if (!row.email) { unmatched.push({ ...row, reason: NO_MATCH.NO_EMAIL }); continue; }
    if (isPlaceholderEmail(row.email, settings)) {
      unmatched.push({ ...row, reason: NO_MATCH.PLACEHOLDER });
      continue;
    }
    if ((encByEmail.get(row.email) || []).length > 1) {
      unmatched.push({ ...row, reason: NO_MATCH.AMBIGUOUS_ENCOMPASS });
      continue;
    }

    const candidates = staffByEmail.get(row.email) || [];
    if (candidates.length === 0) { unmatched.push({ ...row, reason: NO_MATCH.NOT_FOUND }); continue; }
    if (candidates.length > 1) { unmatched.push({ ...row, reason: NO_MATCH.AMBIGUOUS_STAFF }); continue; }

    const staff = candidates[0];
    if (staff.is_active === false) {
      unmatched.push({ ...row, reason: NO_MATCH.STAFF_INACTIVE });
      continue;
    }
    if (takenStaff.has(String(staff.id))) {
      unmatched.push({ ...row, reason: NO_MATCH.STAFF_TAKEN });
      continue;
    }

    suggestions.push({
      ...row,
      staffId: String(staff.id),
      staffName: staffName(staff),
      staffRole: staff.role || null,
      method: 'email',
      // Shown beside the proposal so an admin confirming twenty rows can see at a
      // glance which one deserves a second look. It NEVER gates the suggestion.
      nameAgrees: nameLooksLike(row.encompassName, staffName(staff)),
    });
  }

  return { suggestions, unmatched };
}

module.exports = {
  DEFAULT_PLACEHOLDER_EMAILS,
  NO_MATCH,
  normalizeEmail,
  isPlaceholderEmail,
  nameLooksLike,
  staffName,
  matchRoster,
  _internals: { indexByEmail },
};
