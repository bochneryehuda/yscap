'use strict';
/**
 * LONG-TERM — matching a loan's borrower to a PILOT borrower profile.
 *
 * The owner (2026-08-16): *"We need to make sure we are mapping it to the correct
 * borrower profile so the borrower can also see it on their login."*
 *
 * `lt_loans.borrower_id` has existed since db/549 and nothing has ever written it,
 * so every long-term loan is attached to no person and a borrower signing in sees
 * none of them. This module is the rule that proposes the link — and, like the
 * staff roster matcher beside it, it **SUGGESTS and never decides.** Nothing it
 * returns takes effect until a human presses a button. That is the owner's own
 * shape for the staff side (2026-08-14, "auto-match by email, admin confirms"),
 * and the stakes here are strictly higher: a wrong staff link shows an officer the
 * wrong pipeline, while a wrong borrower link shows a CLIENT somebody else's loan.
 *
 * WHY THE KEY IS THE EMAIL
 * ------------------------------------------------------------------------
 * It is the only identifier both sides genuinely hold. Encompass field 1240
 * (`$.applications[0].borrower.emailAddressText`) is filled on **92.4%** of the
 * DSCR cohort — the long-term book — per the live field dictionary (772 loans,
 * 2026-08-14); PILOT's `borrowers.email` is the address every notification and
 * term sheet already goes to. Nothing else lines up: a loan number is ours alone,
 * an SSN is not on the pipeline read, and the NAME is not a key (see below).
 *
 * WHY THE NAME IS NOT A KEY, EVEN THOUGH IT IS RIGHT THERE
 * ------------------------------------------------------------------------
 * `Loan.BorrowerName` is on every discovery row, free. It is still not allowed to
 * produce a suggestion, for the same reason `people/match.js` refuses it: names in
 * this tenant carry double spaces, trailing spaces, reversed order, and — proven
 * by the live probe on the staff side — outright stale values naming the wrong
 * human. And borrower names collide in a way login ids never do: a book of several
 * hundred loans in one community reliably holds two unrelated people with the same
 * name. `nameLooksLike` exists to DISPLAY a hint beside a proposal, and to detect
 * the disagreement in rule 3, and is never permitted to make one on its own.
 *
 * WHY THE DECISION IS RECORDED ABOUT THE PERSON, NOT THE LOAN
 * ------------------------------------------------------------------------
 * A borrower has many long-term loans. Confirming the same human once per loan,
 * across a book this size, is not a workflow anybody finishes — so a decision is
 * recorded once per ADDRESS (`lt_borrower_links`, db/573) and every loan carrying
 * it inherits the answer, exactly as a staff link recorded against a login id
 * governs every loan that officer touches. It also makes a REJECTION durable: a
 * match a human turned down never returns on the next loan.
 *
 * FAILS TOWARD THE HUMAN. Every ambiguity produces NO suggestion and a plain
 * sentence the admin reads verbatim. An unmatched row costs a five-second click; a
 * wrong match puts one client's loan in front of another.
 *
 * PURE. No database, no network, no config. Every input is passed in, so the whole
 * policy is unit-testable without a Postgres and without Encompass.
 */

const peopleMatch = require('./people/match');

/**
 * Addresses that identify NOBODY.
 *
 * The first two are PILOT's own: the ClickUp sync and the MISMO import mint a
 * synthetic `noemail+<task>@clickup.local` / `@import.local` address for a person
 * who has none, precisely so a NOT NULL constraint could be satisfied (see
 * `clickup/ingest.js`, and db/569 which finally removed the constraint). They are
 * shaped like an address and are the opposite of an identity — matching on one
 * would gather every email-less borrower in the book onto a single profile.
 *
 * Compared by SUFFIX, because the local part carries a task id and is different
 * every time; the LT placeholder list is compared whole, as it is on the staff
 * side, because those are literal shared addresses.
 */
const SHADOW_EMAIL_DOMAINS = ['@clickup.local', '@import.local'];

/** Lowercase + trim — the ONE normalisation, shared with the staff matcher. */
const normalizeEmail = peopleMatch.normalizeEmail;
const nameLooksLike = peopleMatch.nameLooksLike;

/**
 * Is this an address that cannot identify a person?
 *
 * Three ways: it is blank; it is one of PILOT's own synthetic stand-ins; or it is
 * on the tenant's placeholder list (`contacts.placeholderEmails` — the same
 * setting the staff matcher reads, so a lender who lists one shared address has to
 * say so once rather than twice).
 */
function isUnusableEmail(email, settings = {}) {
  const e = normalizeEmail(email);
  if (!e) return true;
  if (SHADOW_EMAIL_DOMAINS.some((d) => e.endsWith(d))) return true;
  return peopleMatch.isPlaceholderEmail(e, settings);
}

/** The display name for a PILOT borrower, tolerating either shape of row. */
function borrowerName(b) {
  if (!b) return '';
  const full = b.full_name || b.fullName;
  if (full && String(full).trim()) return String(full).trim();
  const first = String(b.first_name || b.firstName || '').trim();
  const last = String(b.last_name || b.lastName || '').trim();
  return `${first} ${last}`.trim();
}

/** Why an address produced no suggestion — plain language, shown verbatim. */
const NO_MATCH = {
  NO_EMAIL: 'These loans carry no borrower email in Encompass, so there is nothing to match on. Link them by hand.',
  PLACEHOLDER: 'This email is a shared placeholder that identifies nobody, so it is never matched automatically.',
  NOT_FOUND: 'No borrower profile in PILOT uses this email address.',
  AMBIGUOUS_PROFILE: 'More than one borrower profile uses this email address, so we cannot tell which person this is.',
  AMBIGUOUS_ENCOMPASS: 'Encompass has more than one borrower name on this email address, so we cannot tell whose loans these are.',
  DECIDED: 'A person has already decided this one.',
};

/**
 * Group the mirrored loans by borrower email.
 *
 * The unit of decision is the ADDRESS, so this is what the whole rule runs over.
 * Loans with no usable address are kept together in `noEmail` — they are real
 * loans and the census must still account for them, they simply cannot be
 * proposed.
 *
 * @param {Array} loans rows carrying `borrower_email` / `borrower_name` / `id`
 * @returns {{groups: Array, noEmail: Array}}
 */
function groupLoansByEmail(loans, settings = {}) {
  const byEmail = new Map();
  const noEmail = [];
  for (const l of Array.isArray(loans) ? loans : []) {
    const email = normalizeEmail(l.borrower_email || l.borrowerEmail);
    if (isUnusableEmail(email, settings)) { noEmail.push(l); continue; }
    if (!byEmail.has(email)) byEmail.set(email, { email, loans: [], names: [] });
    const g = byEmail.get(email);
    g.loans.push(l);
    const nm = String(l.borrower_name || l.borrowerName || '').trim();
    if (nm && !g.names.some((n) => nameLooksLike(n, nm))) g.names.push(nm);
  }
  return { groups: [...byEmail.values()], noEmail };
}

/**
 * Propose borrower links for a whole book.
 *
 * @param {Array}  loans     mirrored `lt_loans` rows (borrower_email, borrower_name, id, borrower_id)
 * @param {Array}  profiles  PILOT `borrowers` rows (id, email, name fields)
 * @param {Object} opts.existing  current `lt_borrower_links` rows
 * @param {Object} opts.settings  effective settings
 *
 * @returns {{suggestions, unmatched, noEmail, counts}} — every address appears in
 *   exactly one of `suggestions` / `unmatched`, so a screen can always account for
 *   the whole book; `noEmail` carries the loans that could not be grouped at all.
 */
function matchBorrowers(loans, profiles, { existing = [], settings = {} } = {}) {
  const links = new Map();
  for (const l of Array.isArray(existing) ? existing : Object.values(existing || {})) {
    if (!l) continue;
    const key = normalizeEmail(l.encompass_email || l.encompassEmail);
    if (key) links.set(key, l);
  }

  const profilesByEmail = peopleMatch._internals.indexByEmail(profiles, (p) => p.email);
  const { groups, noEmail } = groupLoansByEmail(loans, settings);

  const suggestions = [];
  const unmatched = [];

  for (const g of groups) {
    const row = {
      email: g.email,
      encompassNames: g.names,
      encompassName: g.names[0] || '',
      loanCount: g.loans.length,
      loanIds: g.loans.map((l) => l.id),
      // How many of these loans are already attached to somebody — so the screen
      // can show what a confirmation would actually change.
      alreadyLinked: g.loans.filter((l) => l.borrower_id || l.borrowerId).length,
    };

    // A decision a human already made is never re-litigated — the rule the RTL
    // finding-decisions ledger exists to enforce. A rejected match that returns
    // every sync trains people to ignore the screen.
    const link = links.get(g.email);
    if (link && (link.status === 'confirmed' || link.status === 'rejected')) {
      unmatched.push({
        ...row,
        reason: NO_MATCH.DECIDED,
        decided: link.status,
        borrowerId: link.borrower_id || link.borrowerId || null,
      });
      continue;
    }

    if (isUnusableEmail(g.email, settings)) {
      unmatched.push({ ...row, reason: NO_MATCH.PLACEHOLDER });
      continue;
    }

    // TWO DIFFERENT PEOPLE ON ONE ADDRESS, ON THE ENCOMPASS SIDE. A household
    // sharing a mailbox is ordinary, and because the decision is recorded about
    // the ADDRESS, confirming it would hand one spouse the other's loans. There is
    // no tiebreak worth having here — this is exactly where a machine stops.
    if (g.names.length > 1) {
      unmatched.push({ ...row, reason: NO_MATCH.AMBIGUOUS_ENCOMPASS });
      continue;
    }

    const candidates = profilesByEmail.get(g.email) || [];
    if (candidates.length === 0) { unmatched.push({ ...row, reason: NO_MATCH.NOT_FOUND }); continue; }
    // TWO PROFILES ON ONE ADDRESS, ON OUR SIDE. This is not hypothetical and not a
    // data error: db/318 replaced the blanket unique index on `borrowers.email`
    // with a partial one so a husband and wife CAN deliberately share a mailbox
    // (`shares_email`). The record is right and the question is unanswerable, so
    // we ask.
    if (candidates.length > 1) { unmatched.push({ ...row, reason: NO_MATCH.AMBIGUOUS_PROFILE }); continue; }

    const profile = candidates[0];
    suggestions.push({
      ...row,
      borrowerId: String(profile.id),
      borrowerName: borrowerName(profile),
      method: 'email',
      // Shown beside the proposal so an admin confirming twenty rows can see at a
      // glance which one deserves a second look. It NEVER gates the suggestion —
      // a legally-married borrower whose Encompass record still carries a maiden
      // name is the same person, and refusing on that would leave the honest
      // matches unconfirmable.
      nameAgrees: nameLooksLike(row.encompassName, borrowerName(profile)),
    });
  }

  return {
    suggestions,
    unmatched,
    noEmail,
    counts: {
      addresses: groups.length,
      suggested: suggestions.length,
      unmatched: unmatched.length,
      loansWithoutEmail: noEmail.length,
      loans: (Array.isArray(loans) ? loans : []).length,
    },
  };
}

module.exports = {
  SHADOW_EMAIL_DOMAINS,
  NO_MATCH,
  normalizeEmail,
  isUnusableEmail,
  borrowerName,
  groupLoansByEmail,
  matchBorrowers,
};
