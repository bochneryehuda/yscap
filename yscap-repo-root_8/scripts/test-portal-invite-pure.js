'use strict';
/**
 * WHERE THIS PERSON STANDS WITH THE PORTAL — the wording and the shaping, proven
 * with no database (owner-directed 2026-08-02: the file must show, for the
 * borrower AND the co-borrower, whether they were invited and when, with a way to
 * send it again, and whether they joined and when they last signed in).
 *
 * The sentence a staffer reads is decided in ONE place so the loan file and the
 * borrower profile can never word it differently — which is exactly the kind of
 * thing that only stays true if a test pins it.
 */
const P = require('../src/lib/portal-invite');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const DAY = 86400000;
const NOW = new Date('2026-08-02T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

console.log('\nA. the four states a person can be in');

{
  const d = P.describePortalAccess({ hasAccount: false, canInvite: true }, NOW);
  ok(d.state === 'not_invited', 'nobody has sent it → not_invited');
  ok(/no portal invitation has been sent yet/i.test(d.headline), '…said in plain words');
  ok(/cannot see the loan/i.test(d.detail), '…and it says what that costs them');
}
{
  const d = P.describePortalAccess({ hasAccount: false, canInvite: false }, NOW);
  ok(d.state === 'no_email', 'no email on the profile is its OWN state, not "not invited"');
  ok(/add an email/i.test(d.detail), '…and it names the one thing to do first');
}
{
  const d = P.describePortalAccess({
    hasAccount: false, canInvite: true, invitedAt: daysAgo(3), inviteCount: 1,
  }, NOW);
  ok(d.state === 'invited', 'sent and not accepted → invited');
  ok(/3 days ago/.test(d.headline), '…with WHEN, in words');
  ok(/have not joined yet/i.test(d.headline), '…and that they still have not joined');
  ok(!/sent \d+ times/.test(d.headline), 'a single invitation does not brag about a count');
}
{
  const d = P.describePortalAccess({
    hasAccount: true, joinedAt: daysAgo(40), lastLoginAt: daysAgo(1),
  }, NOW);
  ok(d.state === 'joined', 'they have a login → joined');
  ok(/a month ago/.test(d.headline), 'joined WHEN');
  ok(/yesterday/.test(d.detail), 'last signed in WHEN — the second half the owner asked for');
}
{
  const d = P.describePortalAccess({ hasAccount: true, joinedAt: daysAgo(2) }, NOW);
  ok(/have not signed in since joining/i.test(d.detail),
    'joined but never came back is SAID, not left blank');
}

console.log('\nB. what a re-send and a stale address look like');

{
  const d = P.describePortalAccess({
    hasAccount: false, canInvite: true, invitedAt: daysAgo(10), inviteCount: 4,
    invitedByName: 'Lisa Katz',
  }, NOW);
  ok(/sent 4 times/.test(d.headline), 'a fourth send reads as a fourth send');
  ok(/by Lisa Katz/.test(d.headline), '…and says who sent the last one');
}
{
  const d = P.describePortalAccess({
    hasAccount: false, canInvite: true, invitedAt: daysAgo(20), inviteCount: 1,
    invitedEmail: 'old@example.com', invitedEmailStale: true,
  }, NOW);
  ok(/old@example\.com/.test(d.detail) && /not the address on the profile/i.test(d.detail),
    'an invitation sent to a since-corrected address is called out, not counted as "we told them"');
}
{
  // A borrower-side invite has NO staff behind it, and must not invent one.
  const d = P.describePortalAccess({
    hasAccount: false, canInvite: true, invitedAt: daysAgo(1), inviteCount: 1, invitedByName: null,
  }, NOW);
  ok(!/ by /.test(d.headline), 'with nobody recorded it never makes up a sender');
}

console.log('\nC. shapePortal reads the row and invents nothing');

{
  const s = P.shapePortal({
    email: 'Person@Example.com', has_account: true,
    portal_joined_at: '2026-06-01T00:00:00Z', portal_last_login_at: '2026-08-01T00:00:00Z',
    portal_invited_at: '2026-05-01T00:00:00Z', portal_first_invited_at: '2026-04-01T00:00:00Z',
    portal_invite_count: 3, portal_invited_email: 'person@example.com',
    invited_by_name: 'Sara',
  });
  ok(s.hasAccount === true && s.inviteCount === 3, 'the plain values come across');
  ok(s.invitedEmailStale === false,
    'the SAME address in different casing is not stale — an email is case-insensitive');
  ok(s.canInvite === true, 'an address on file means we can send');
}
{
  const s = P.shapePortal({ email: 'new@example.com', portal_invited_email: 'old@example.com' });
  ok(s.invitedEmailStale === true, 'a genuinely different address IS stale');
}
{
  const s = P.shapePortal({ email: null, portal_invited_email: 'old@example.com' });
  ok(s.invitedEmailStale === false,
    'with NO address on the profile there is nothing to disagree with — never a false "stale"');
  ok(s.canInvite === false, '…and we cannot send, so the button knows to stay off');
}
{
  const s = P.shapePortal({});
  ok(s.hasAccount === false && s.inviteCount === 0 && s.invitedAt === null,
    'an empty row shapes to a clean "we know nothing", never a crash');
}
{
  const s = P.shapePortal(null);
  ok(s && s.hasAccount === false, 'even a null row returns a shape');
}
{
  const s = P.shapePortal({ portal_invite_count: 'not a number' });
  ok(s.inviteCount === 0, 'a junk count reads as 0, never NaN on the screen');
}

console.log('\nD. "how long ago" never shows a raw timestamp');

{
  const a = P._internals.ago;
  ok(a(NOW, NOW) === 'today', 'today');
  ok(a(daysAgo(1), NOW) === 'yesterday', 'yesterday');
  ok(a(daysAgo(9), NOW) === '9 days ago', 'days');
  ok(a(daysAgo(45), NOW) === 'a month ago', 'a month');
  ok(a(daysAgo(200), NOW) === '6 months ago', 'months');
  ok(a(daysAgo(400), NOW) === 'a year ago', 'a year');
  ok(a(new Date(NOW.getTime() + DAY), NOW) === 'just now',
    'a clock-skewed future stamp reads "just now", never "-1 days ago"');
  ok(a('nonsense', NOW) === 'at an unknown time', 'unreadable is said plainly');
  ok(a(null, NOW) === 'at an unknown time', 'and so is missing');
}

console.log('\nE. the SELECT fragment names the columns the shaper reads');

{
  for (const col of ['portal_invited_at', 'portal_first_invited_at', 'portal_invite_count',
    'portal_invited_by', 'portal_invited_email', 'has_account',
    'portal_joined_at', 'portal_last_login_at']) {
    ok(P.PORTAL_SELECT.includes(col), `PORTAL_SELECT carries ${col}`);
  }
  // The joined/last-login halves come from borrower_auth, so any caller of the
  // fragment has to join it — say so loudly rather than let a caller find out
  // through a 42P01 at runtime.
  ok(/ba\.created_at/.test(P.PORTAL_SELECT) && /ba\.last_login_at/.test(P.PORTAL_SELECT),
    '…and reads joined/last-login off the borrower_auth alias `ba`');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  portal-invite: one wording for where every borrower stands with the portal');
process.exit(fail ? 1 : 0);
