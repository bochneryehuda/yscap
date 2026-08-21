'use strict';
/**
 * test-esign-one-invitation-pure — ONE signing email, from PILOT, for every signer; and an
 * execution notice with the document attached once it is signed.
 *
 * Owner-reported 2026-08-21: *"they're receiving an email from DocuSign directly to sign, and
 * they're also receiving an email from Pilot to sign. When they're clicking on the DocuSign link,
 * it comes up an error … The only link that works is the link that is coming directly from
 * Pilot."*, *"The Loan Officers and the Admins … should not receive the DocuSign emails. They
 * should receive it directly from Pilot with the direct link to sign."*, and *"we need to add a
 * notification for every document that is completed … with the document attached."*
 *
 * Pure — no database, no network. What it pins:
 *  1. Nothing asks DocuSign to email a captive recipient any more.
 *  2. A signing token names exactly ONE identity — a borrower or one of ours, never both, never
 *     neither — because a token naming nobody would match whichever recipient sorted first.
 *  3. The staff invitation exists, reads as internal, and carries the signing link.
 *  4. The execution notice tells the truth about the attachment, and never announces a package it
 *     has no wording for.
 *  5. The borrower invitation no longer promises a second email from DocuSign.
 */

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✘ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

console.log('1. DocuSign no longer emails anybody');
/* The property is what made DocuSign send its own invitation beside PILOT's. Comments are
   stripped first: the change that removed it necessarily NAMES it in a comment, and a guard that
   read comments would fail on its own explanation and then get "fixed" by deleting it. */
for (const f of ['src/lib/esign/orchestrate.js', 'src/lib/esign/recipient-email.js']) {
  ok(!/embeddedRecipientStartURL\s*[:=]/.test(stripComments(read(f))),
    `${f} never asks DocuSign to email a captive recipient`);
}
/* The BUILDER keeps the passthrough — it is a generic DocuSign client and a future non-captive
   recipient may legitimately need it. What must not come back is a caller setting it. */
ok(/embeddedRecipientStartURL/.test(read('src/lib/integrations/docusign.js')),
  'the DocuSign client still SUPPORTS the field — it is the callers that stopped setting it');

console.log('2. a signing token names exactly one identity');
const magic = require(REPO + '/src/lib/esign/magic-link');
const bTok = magic.mintSigningToken({ envelopeRowId: 'env-1', borrowerId: 'bor-1', recipientIdDs: '1' });
const sTok = magic.mintSigningToken({ envelopeRowId: 'env-1', staffId: 'staff-1', recipientIdDs: '3' });
const bc = magic.verifySigningToken(bTok);
const sc = magic.verifySigningToken(sTok);
ok(bc && bc.borrowerId === 'bor-1' && bc.staffId === null, 'a borrower token names the borrower and no staff member');
ok(sc && sc.staffId === 'staff-1' && sc.borrowerId === null, 'a staff token names the staff member and no borrower');
eq(magic.verifySigningToken(
  magic.mintSigningToken({ envelopeRowId: 'e', borrowerId: 'b', staffId: 's', recipientIdDs: '1' })), null,
'a token naming BOTH is refused');
eq(magic.verifySigningToken(
  magic.mintSigningToken({ envelopeRowId: 'e', recipientIdDs: '1' })), null,
'a token naming NEITHER is refused — it would match whichever recipient sorted first');
eq(magic.verifySigningToken('not-a-token'), null, 'junk is refused');

console.log('3. the sign route resolves a staff signer, and pins each token to its own identity');
const pub = read('src/routes/esign-public.js');
ok(/claims\.borrowerId\s*\n?\s*\?/.test(pub) || /claims\.borrowerId\s*$/m.test(pub) || /claims\.borrowerId/.test(pub),
  'the route branches on which identity the token carries');
ok(/r\.borrower_id\s*=\s*\$3/.test(pub), 'a borrower token is pinned to that borrower');
ok(/r\.borrower_id IS NULL/.test(pub) && /su\.is_active = true/.test(pub),
  'a staff token is pinned to a staff row with no borrower, and only an ACTIVE one');
/* AN EMAIL LINK MAY NEVER MINT AN INTERNAL CONSOLE SESSION. The borrower hand-off exists and is
   deliberate; the staff one must not. */
ok(/isStaffSigner \? null : magic\.mintReturnAuth/.test(pub),
  'no return-auth is minted for a staff signer — an email link never becomes a console session');
ok(/dest=staff/.test(pub), 'a staff signer lands on the internal file and signs in normally');

console.log('4. our own signers get our own email');
const cat = require(REPO + '/src/lib/email/catalog');
const staffMail = cat.esignStaffReadyToSign({
  firstName: 'Moshe', role: 'loan officer', packageLabel: 'Heter Iska',
  borrowerName: 'Grace Hopper', propertyLabel: '3 Sold St', loanNumber: 'YSCAP1',
  signUrl: 'https://pilot.example/api/esign/sign?t=abc',
});
ok(/signature/i.test(staffMail.subject), 'it says a signature is needed');
ok(staffMail.html.includes('https://pilot.example/api/esign/sign?t=abc'), 'it carries the direct signing link');
ok(/Grace Hopper/.test(staffMail.html), 'it names the borrower whose file it is');
ok(!/disregard/i.test(staffMail.html), 'it does not reassure an internal signer like a borrower');
const ns = read('src/lib/esign/notify-signers.js');
ok(/'borrower', 'co_borrower', 'loan_officer', 'admin'/.test(ns), 'the notifier covers staff signers');
ok(/is_active = true/.test(ns), 'a departed officer’s address is never sent a signing link');
/* A COUNTER-SIGNER'S TURN. Emailing them at send time would say "your signature is needed" when
   DocuSign will not let them sign yet, and the link would fail — the exact experience being fixed. */
ok(/recipient_status/.test(ns), 'a signer whose turn has not come is not invited');
const wh = read('src/lib/esign/webhook.js');
ok(/becameActive/.test(wh) && /notifyReadyToSign/.test(wh),
  'the webhook invites our own signer the moment their turn comes');
ok(/old_status/.test(wh), 'and detects the transition from the row, so a repeated webhook cannot re-email');

console.log('5. the execution notice');
const done = cat.esignCompleted({
  firstName: 'Grace', packageLabel: 'Heter Iska', propertyLabel: '3 Sold St',
  loanNumber: 'YSCAP1', completedOn: '2026-08-21', portalUrl: 'https://pilot.example/portal', attached: true,
});
ok(/Signed and complete/i.test(done.subject), 'the subject says it is done');
ok(/attached to this email/i.test(done.html), 'it says the copy is attached');
ok(/Nothing further is needed/i.test(done.html), 'it asks for nothing — it is a record, not a request');
const notAttached = cat.esignCompleted({ firstName: 'Grace', packageLabel: 'Heter Iska', attached: false });
ok(/too large to attach/i.test(notAttached.html),
  'and when the copy could not be attached it says so, rather than promising an attachment that is not there');
const CN = require(REPO + '/src/lib/esign/completion-notice');
for (const p of ['term_sheet_package', 'heter_iska', 'draw_request']) {
  ok(!!CN.PACKAGE[p], `the three packages the owner named are covered: ${p}`);
}
ok(!CN.PACKAGE.something_else, 'a package with no wording is not announced at all');
const cn = read('src/lib/esign/completion-notice.js');
ok(/ed\.envelope_row_id = \$1/.test(cn),
  'the attached copy is the one THIS envelope produced — never the newest signed copy on the file');
ok(/role IN \('borrower', 'co_borrower'\)/.test(cn), 'it goes to the people who signed it');

console.log('6. the borrower invitation stopped promising a second email');
const invite = cat.esignReadyToSign({ firstName: 'Grace', packageLabel: 'Heter Iska', signUrl: 'https://x/y' });
ok(!/separate email directly from DocuSign/i.test(invite.html),
  'it no longer tells the borrower to expect a DocuSign email');
ok(/only place your signing link comes from|will not receive a separate one/i.test(invite.html),
  'it says this is the only link there is');

console.log(`\ntest-esign-one-invitation-pure: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
