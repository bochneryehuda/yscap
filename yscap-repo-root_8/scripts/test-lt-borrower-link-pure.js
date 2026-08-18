'use strict';
/**
 * PROOF that the borrower matcher proposes only what it can prove, and REFUSES
 * every ambiguity — with no database and no Encompass.
 *
 * This is the highest-stakes rule on the long-term side. A confirmed link is what
 * puts a loan on a client's own login, so a wrong one shows one borrower another
 * borrower's file: their property, their loan amount, their officer. Every refusal
 * below is therefore tested as hard as the happy path, and several of them are the
 * ONLY thing standing between an ordinary household mailbox and that outcome.
 *
 * PURE. `borrower-match.js` takes every input as an argument, so the whole policy
 * runs here in milliseconds.
 */

const assert = require('assert');

const m = require('../src/longterm/borrower-match');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ---------------------------------------------------------------------------
// A. AN ADDRESS THAT IDENTIFIES NOBODY IS NEVER A KEY.
//    PILOT MINTS these itself — the ClickUp sync and the MISMO import both
//    fabricate `noemail+<task>@clickup.local` for a person who has none, purely to
//    satisfy a NOT NULL constraint that db/569 has since removed. They are shaped
//    exactly like an address, and matching on one would gather every email-less
//    borrower in the book onto whichever profile happened to hold the shadow.
// ---------------------------------------------------------------------------
ok(m.isUnusableEmail(''), 'a blank address identifies nobody');
ok(m.isUnusableEmail(null), 'a missing address identifies nobody');
ok(m.isUnusableEmail('noemail+abc123@clickup.local'), 'a ClickUp shadow address identifies nobody');
ok(m.isUnusableEmail('someone+9@import.local'), 'an import shadow address identifies nobody');
ok(m.isUnusableEmail('NoEmail+ABC@ClickUp.Local'), '…in any casing');
ok(m.isUnusableEmail('change.me@email.com'), 'the tenant placeholder identifies nobody');
ok(!m.isUnusableEmail('real.person@example.com'), 'an ordinary address is usable');
// The settings list is the tenant's, not ours — a different lender's placeholder is
// a different string, and hard-coding one would silently stop protecting them.
ok(m.isUnusableEmail('ops@theirshop.com', { 'contacts.placeholderEmails': ['ops@theirshop.com'] }),
  'a tenant-configured placeholder identifies nobody');
ok(!m.isUnusableEmail('ops@theirshop.com'), '…and is not a placeholder anywhere else');

// ---------------------------------------------------------------------------
// B. THE GROUPING — the unit of decision is the ADDRESS, and a name that is merely
//    SPELLED differently is still one person.
// ---------------------------------------------------------------------------
{
  const loans = [
    { id: 'l1', borrower_email: 'Sam@Example.com', borrower_name: 'Sam Fried' },
    { id: 'l2', borrower_email: 'sam@example.com', borrower_name: 'Fried  Sam' },
    { id: 'l3', borrower_email: '', borrower_name: 'No Address' },
    { id: 'l4', borrower_email: 'noemail+7@clickup.local', borrower_name: 'Shadow Person' },
  ];
  const g = m.groupLoansByEmail(loans);
  eq(g.groups.length, 1, 'the two spellings of one address are ONE group');
  eq(g.groups[0].loans.length, 2, '…carrying both loans');
  eq(g.groups[0].names.length, 1,
    'double-spaced and reversed spellings of one name are ONE person, not two');
  eq(g.noEmail.length, 2, 'the blank and the shadow address are set aside, not silently dropped');
}

// ---------------------------------------------------------------------------
// C. THE HAPPY PATH — one address, one name, one profile.
// ---------------------------------------------------------------------------
{
  const out = m.matchBorrowers(
    [
      { id: 'l1', borrower_email: 'sam@example.com', borrower_name: 'Sam Fried' },
      { id: 'l2', borrower_email: 'sam@example.com', borrower_name: 'Sam Fried' },
    ],
    [{ id: 'B1', email: 'sam@example.com', full_name: 'Sam Fried' }],
  );
  eq(out.suggestions.length, 1, 'one address with one profile is proposed');
  eq(out.suggestions[0].borrowerId, 'B1', '…naming the profile');
  eq(out.suggestions[0].loanCount, 2, '…and saying how many loans it would attach');
  eq(out.suggestions[0].method, 'email', '…matched on the email');
  eq(out.suggestions[0].nameAgrees, true, '…with the names agreeing');
  eq(out.unmatched.length, 0, 'nothing is left unexplained');
}

// ---------------------------------------------------------------------------
// D. THE REFUSALS. Each of these is a real state of this tenant's data, and each
//    would be a client seeing somebody else's loan.
// ---------------------------------------------------------------------------
const profileOf = (id, email, name) => ({ id, email, full_name: name });

{
  // TWO PEOPLE ON ONE MAILBOX, ENCOMPASS SIDE. A household sharing an address is
  // ordinary. Because the decision is recorded about the ADDRESS, confirming it
  // would hand one spouse the other's loans — so the machine stops.
  const out = m.matchBorrowers(
    [
      { id: 'l1', borrower_email: 'home@example.com', borrower_name: 'Sam Fried' },
      { id: 'l2', borrower_email: 'home@example.com', borrower_name: 'Rivka Fried' },
    ],
    [profileOf('B1', 'home@example.com', 'Sam Fried')],
  );
  eq(out.suggestions.length, 0, 'two different borrower names on one address propose NOTHING');
  eq(out.unmatched[0].reason, m.NO_MATCH.AMBIGUOUS_ENCOMPASS, '…and say exactly why');
  eq(out.unmatched[0].encompassNames.length, 2, '…listing both names for the human to read');
}

{
  // TWO PROFILES ON ONE MAILBOX, OUR SIDE. Not a data error: db/318 replaced the
  // blanket unique index on `borrowers.email` with a partial one precisely so a
  // husband and wife CAN deliberately share a mailbox. The record is right and the
  // question is unanswerable.
  const out = m.matchBorrowers(
    [{ id: 'l1', borrower_email: 'home@example.com', borrower_name: 'Sam Fried' }],
    [profileOf('B1', 'home@example.com', 'Sam Fried'),
      profileOf('B2', 'home@example.com', 'Rivka Fried')],
  );
  eq(out.suggestions.length, 0, 'two PILOT profiles on one address propose NOTHING');
  eq(out.unmatched[0].reason, m.NO_MATCH.AMBIGUOUS_PROFILE, '…and say exactly why');
}

{
  const out = m.matchBorrowers(
    [{ id: 'l1', borrower_email: 'nobody@example.com', borrower_name: 'Sam Fried' }],
    [profileOf('B1', 'other@example.com', 'Sam Fried')],
  );
  eq(out.suggestions.length, 0, 'an address no profile uses proposes nothing');
  eq(out.unmatched[0].reason, m.NO_MATCH.NOT_FOUND, '…and says so plainly');
}

{
  // THE NAME IS NEVER A KEY. This is the whole point of D: the same human, an
  // obvious match to any reader, and NO suggestion — because a book this size
  // reliably holds two unrelated people with one name, and the tenant's own name
  // data is known to be stale and mis-spaced.
  const out = m.matchBorrowers(
    [{ id: 'l1', borrower_email: 'work@example.com', borrower_name: 'Sam Fried' }],
    [profileOf('B1', 'personal@example.com', 'Sam Fried')],
  );
  eq(out.suggestions.length, 0, 'an identical NAME never produces a suggestion on its own');
  eq(out.unmatched[0].reason, m.NO_MATCH.NOT_FOUND, '…the address is still the only key');
}

{
  // A NAME THAT DISAGREES DOES NOT BLOCK THE MATCH — it is flagged. A borrower
  // whose Encompass record still carries a maiden name is the same person, and
  // refusing on that would leave the honest matches unconfirmable.
  const out = m.matchBorrowers(
    [{ id: 'l1', borrower_email: 'sam@example.com', borrower_name: 'Sam Klein' }],
    [profileOf('B1', 'sam@example.com', 'Sam Fried')],
  );
  eq(out.suggestions.length, 1, 'a disagreeing name still proposes');
  eq(out.suggestions[0].nameAgrees, false, '…and is flagged for a second look');
}

// ---------------------------------------------------------------------------
// E. A DECISION A HUMAN MADE IS NEVER RE-LITIGATED — the rule the RTL
//    finding-decisions ledger exists to enforce. A rejected match that comes back
//    every sync trains people to ignore the screen, and this one governs whose
//    loan a client can see.
// ---------------------------------------------------------------------------
{
  const loans = [{ id: 'l1', borrower_email: 'sam@example.com', borrower_name: 'Sam Fried' }];
  const profiles = [profileOf('B1', 'sam@example.com', 'Sam Fried')];

  const rejected = m.matchBorrowers(loans, profiles, {
    existing: [{ encompass_email: 'sam@example.com', status: 'rejected', borrower_id: null }],
  });
  eq(rejected.suggestions.length, 0, 'a REJECTED address is never proposed again');
  eq(rejected.unmatched[0].reason, m.NO_MATCH.DECIDED, '…and says a person already decided');
  eq(rejected.unmatched[0].decided, 'rejected', '…which way');

  const confirmed = m.matchBorrowers(loans, profiles, {
    existing: [{ encompass_email: 'sam@example.com', status: 'confirmed', borrower_id: 'B1' }],
  });
  eq(confirmed.suggestions.length, 0, 'a CONFIRMED address is not re-proposed either');
  eq(confirmed.unmatched[0].borrowerId, 'B1', '…and still reports who it belongs to');

  // A SUGGESTED row is not a decision — nobody has answered it yet, so it must
  // keep being offered or it would vanish from the screen unanswered.
  const pending = m.matchBorrowers(loans, profiles, {
    existing: [{ encompass_email: 'sam@example.com', status: 'suggested', borrower_id: 'B1' }],
  });
  eq(pending.suggestions.length, 1, 'an undecided suggestion is still offered');
}

// ---------------------------------------------------------------------------
// F. THE CENSUS DISCIPLINE — every address is accounted for, exactly once, so a
//    screen can never quietly lose a borrower.
// ---------------------------------------------------------------------------
{
  const loans = [
    { id: 'l1', borrower_email: 'a@x.com', borrower_name: 'A One' },      // suggested
    { id: 'l2', borrower_email: 'b@x.com', borrower_name: 'B Two' },      // not found
    { id: 'l3', borrower_email: 'c@x.com', borrower_name: 'C Three' },    // ambiguous encompass
    { id: 'l4', borrower_email: 'c@x.com', borrower_name: 'D Four' },
    { id: 'l5', borrower_email: '', borrower_name: 'No Address' },        // no email
  ];
  const out = m.matchBorrowers(loans, [profileOf('B1', 'a@x.com', 'A One')]);
  eq(out.counts.addresses, 3, 'three usable addresses');
  eq(out.suggestions.length + out.unmatched.length, out.counts.addresses,
    'every address is in exactly one of the two lists — a census never loses a row');
  eq(out.counts.loansWithoutEmail, 1, 'the address-less loan is counted, not dropped');
  eq(out.counts.loans, 5, 'and the total is every loan we were given');
}

console.log(`\n✓ lt borrower-link (pure): ${checks} assertions passed`);
