#!/usr/bin/env node
/**
 * A BORROWER WITH NO LOAN FILE IS STILL INVITABLE.
 *
 * Owner-reported 2026-08-07: "We have, in our Borrower profiles, all the Borrowers,
 * even though they didn't take a loan on our system because it was not an RTL loan. If
 * somebody takes a DSCR loan, it takes the information from ClickUp and builds them up
 * a profile. When we tried to invite the Borrower into our system to be able to apply
 * for an RTL loan, it comes up that there are no active loans that you can invite this
 * Borrower to. You need to be able to invite the Borrower, even if it doesn't have any
 * active loans in our system. Just invite this Borrower so he should be able to create
 * an active loan."
 *
 * ROOT CAUSE — the repo's own documented class. `POST /borrowers/:id/portal-invite`
 * refused with `400 code:'no_active_file'`, and the 2026-08-04 fix for that refusal was
 * written in ONE SCREEN'S CLICK HANDLER instead of at the server. FOUR buttons call
 * that endpoint, so three still dead-ended — including the borrowers LIST and the
 * shared BorrowerProfilePanel, which are the two a staffer is most likely to press.
 *
 * PURE — no DB, no network (the DB behaviour is exercised by the run recorded in the
 * commit message; this pins the rule, the wording, and that no screen carries a
 * private copy of the workaround). Runs in `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

console.log('\n1. The server no longer refuses — the refusal is GONE, not handled');
{
  const s = read('../src/routes/staff.js');
  ok(!/code: 'no_active_file'/.test(s), "the 400 with code:'no_active_file' is gone from the server");
  ok(!/no active file to invite them to/.test(s), 'and so is its message');
  const route = s.slice(s.indexOf("router.post('/borrowers/:id/portal-invite'"));
  const body = route.slice(0, route.indexOf('\n});'));
  ok(/appId: app \? app\.id : null/.test(body), 'the route invites with a NULL appId when there is no file');
  ok(/noFile: !app/.test(body), 'and reports `noFile` so the screens can say what happened');
  ok(!/inviteOnly/.test(body), 'it does NOT manufacture an application to have something to invite to');
}

console.log('\n2. The invite helper genuinely works with no file');
{
  const s = read('../src/routes/staff.js');
  const fn = s.slice(s.indexOf('async function inviteBorrowerToFile'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(/appId = null/.test(body), 'appId is optional (defaulted to null)');
  ok(/const meta = appId/.test(body), 'the property lookup is skipped when there is no file — not run against a null id');
  ok(/rows: \[\]/.test(body), '…and degrades to an empty result the existing fallbacks already handle');
  ok(/replyTo: appId \? fileReplyTo\(appId\) : undefined/.test(body),
    'the per-file reply-to is only used when there IS a file');
  ok(/appId \? 'application' : 'borrower'/.test(body),
    'the audit row points at the borrower, never at an application id that does not exist');
  ok(/noFile: !appId/.test(body), 'and the email is told, so it cannot promise a file that does not exist');
}

console.log('\n3. NO SCREEN carries a private copy of the workaround any more');
{
  // This is the assertion that would have caught the original bug: the fix belongs at
  // the ONE server door, not in whichever screen someone happened to be looking at.
  const screens = ['../app-v2/src/screens/StaffBorrowerDetail.jsx',
                   '../app-v2/src/screens/StaffBorrowers.jsx',
                   '../app-v2/src/components/BorrowerProfilePanel.jsx',
                   '../app-v2/src/screens/StaffApplication.jsx'];
  for (const f of screens) {
    const s = read(f);
    ok(!/no_active_file/.test(s), `${path.basename(f)} has no no_active_file special case`);
  }
  // Every one of the four callers still exists — the fix must not have removed a button.
  let callers = 0;
  for (const f of screens) if (/api\.staffBorrowerInvite\(/.test(read(f))) callers += 1;
  ok(callers === 4, `all four invite buttons are still wired (found ${callers})`);
  // And the one that used to fake a file no longer does.
  ok(!/staffCreateFile\(\{ inviteOnly: true, borrowerId/.test(read('../app-v2/src/screens/StaffBorrowerDetail.jsx')),
    'the detail screen no longer creates an empty application to invite into');
}

console.log('\n4. The invitation email says the right thing, both ways');
{
  process.env.APP_URL = process.env.APP_URL || 'https://example.test';
  const c = require('../src/lib/email/catalog');
  const withFile = c.borrowerInvite({ firstName: 'Dave', propertyLabel: '12 Main St', loanNumber: 'YSCAP1',
    inviter: 'Josh', acceptUrl: 'https://x/a', hasAccount: false });
  const noFile = c.borrowerInvite({ firstName: 'Dave', propertyLabel: 'your loan', loanNumber: null,
    inviter: 'Josh', acceptUrl: 'https://x/a', hasAccount: false, noFile: true });

  ok(/opened a loan file/.test(withFile.text), 'WITH a file it still says a loan file was opened');
  ok(/12 Main St/.test(withFile.text), '…and still names the property');

  ok(!/opened a loan file/.test(noFile.text),
    'with NO file it does NOT claim one was opened — that would send them looking for it');
  ok(/start a loan application/.test(noFile.text), '…it says they can start an application');
  ok(!/Property:/.test(noFile.text) && !/12 Main St/.test(noFile.text),
    '…and names no property, because there is none');
  ok(!/Loan #/.test(noFile.text), '…and no loan number');
  ok(noFile.subject === 'You’re invited to the YS Capital borrower portal',
    `…and the subject carries no file tag (got: ${noFile.subject})`);

  // An already-registered borrower gets the sign-in wording, still without a file.
  const noFileHasAccount = c.borrowerInvite({ firstName: 'Dave', inviter: 'Josh', acceptUrl: 'https://x/a',
    hasAccount: true, noFile: true });
  ok(/Sign in below to start a new loan application/.test(noFileHasAccount.text),
    'an existing login is told to sign in AND start an application');

  // BACK-COMPAT: without the flag, byte-identical to the invitation that has always
  // gone out with a file.
  const a = c.borrowerInvite({ firstName: 'D', propertyLabel: 'P', loanNumber: 'L', inviter: 'I', acceptUrl: 'u', hasAccount: false });
  const b = c.borrowerInvite({ firstName: 'D', propertyLabel: 'P', loanNumber: 'L', inviter: 'I', acceptUrl: 'u', hasAccount: false, noFile: false });
  ok(a.html === b.html, 'noFile:false renders byte-identically to the flag being absent');
}

console.log('\n5. The borrower can actually do what the invitation promises');
{
  // "so he should be able to create an active loan" — the portal must let them start
  // one with no existing application. If this door ever required one, the invitation
  // would be a dead end again.
  const s = read('../src/routes/borrower.js');
  const idx = s.indexOf("router.post('/applications'");
  ok(idx > 0, 'the borrower can create an application from their portal');
  const body = s.slice(idx, idx + 1200);
  ok(!/no active|existing application required/i.test(body),
    '…and that door does not require an existing file');
}

console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ borrower invite with no file: all assertions passed\n');
process.exit(fails ? 1 : 0);
