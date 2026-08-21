'use strict';
/**
 * A RESEND MUST NEVER DEAD-END (owner-reported 2026-08-21: "Make sure the Resend
 * Draw form works if the borrower hasn't seen it for a long time or the form has
 * expired").
 *
 * A resend re-notifies the SAME DocuSign envelope; it never makes a new one. An
 * envelope that has sat unsigned past the account's expiry window is VOIDED by
 * DocuSign, so the exact case the owner describes is the case where a resend is
 * impossible by construction -- and the old refusal answered `envelope already
 * voided`: true, and a dead end, because it names a state instead of an action.
 *
 * These assertions are about the WORDING and the machine-readable code, because
 * that is the whole feature: every refusal has to carry a way through, and the
 * pre-check and the DocuSign-refusal path have to produce the SAME answer for the
 * same situation -- otherwise the screen offers the fix in one case and a "server
 * error" in the other, which is what happened when our stored status lagged.
 *
 * Run: node scripts/test-esign-resend-readiness.js
 */
const R = require('../src/lib/esign/resend-readiness');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL:', name, extra == null ? '' : `\n        ${extra}`);
};

// ---- a live envelope is nudge-able ----------------------------------------
for (const st of ['sent', 'delivered', 'created', 'signed']) {
  ok(`a ${st} envelope may be resent`, R.resendProblem({ status: st, envelope_id: 'env-1', purpose: 'draw_request' }) === null);
}

// ---- the reported case ----------------------------------------------------
const voided = R.resendProblem({ status: 'voided', envelope_id: 'env-1', purpose: 'draw_request' });
ok('a voided draw form refuses', !!voided && voided.status === 409);
ok('...with ONE machine-readable code a screen can branch on', voided.code === 'envelope_not_live');
ok('...naming the expiry, which is what actually happened', /expired|sat unsigned/i.test(voided.error), voided.error);
ok('...and NAMING THE WAY THROUGH — the dead end this fixes',
  /fresh draw form/i.test(voided.error), voided.error);
ok('...and telling the screen which re-issue to offer', voided.reissue === 'draw_request');
ok('...in plain words, never a status code echoed back',
  !/^envelope already/i.test(voided.error) && !/\bstatus\b/i.test(voided.error), voided.error);

// ---- the other terminal states are told apart ------------------------------
const done = R.resendProblem({ status: 'completed', envelope_id: 'e', purpose: 'draw_request' });
ok('a SIGNED form refuses without offering to replace it — there is nothing wrong',
  done.code === 'envelope_not_live' && /already been signed/i.test(done.error) && !/fresh draw form/i.test(done.error), done.error);
const declined = R.resendProblem({ status: 'declined', envelope_id: 'e', purpose: 'draw_request' });
ok('a DECLINED form says the signer declined, and offers a fresh one',
  /declined/i.test(declined.error) && /fresh draw form/i.test(declined.error), declined.error);
ok('the underlying state is still reported, for the record',
  voided.envelopeStatus === 'voided' && done.envelopeStatus === 'completed');

// ---- never sent -----------------------------------------------------------
const unsent = R.resendProblem({ status: 'created', envelope_id: null, purpose: 'draw_request' });
ok('an unsent package says so and says to send it', unsent.code === 'not_sent' && /Send it first/i.test(unsent.error), unsent.error);

// ---- each package is named as its readers name it ---------------------------
ok('a term sheet is called a term sheet package, and points at ITS own way through',
  /term sheet package/i.test(R.resendProblem({ status: 'voided', envelope_id: 'e', purpose: 'term_sheet_package' }).error)
  && /e-sign panel/i.test(R.resendProblem({ status: 'voided', envelope_id: 'e', purpose: 'term_sheet_package' }).error));
ok('an unknown package still answers, generically, rather than throwing',
  !!R.resendProblem({ status: 'voided', envelope_id: 'e', purpose: 'something_new' }).error);

// EVERY package this system can send must have its own wording. Read from the
// SOURCE rather than requiring orchestrate.js -- that module pulls in the database,
// DocuSign and the document builders, and this one is pure on purpose. A package
// added next year fails here until somebody decides what to call it and how to
// re-issue it, instead of silently degrading to "package"/"void it on the e-sign
// panel" on a real refusal a person has to act on.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/esign/orchestrate.js'), 'utf8');
  const block = src.slice(src.indexOf('const PACKAGES = {'));
  const known = [...block.slice(0, block.indexOf('\n};')).matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]);
  ok('the package list was actually found in orchestrate.js', known.length >= 4, `found ${known.length}`);
  for (const p of known) {
    ok(`the ${p} package is named in a person's words`, !!R._internal.PACKAGE[p], `no PACKAGE entry for "${p}"`);
  }
}
ok('a missing row never throws', R.resendProblem(null) && R.resendProblem(null).code === 'not_sent');

// ---- DocuSign's own refusal maps to the SAME answer -------------------------
// This is the half our stored status cannot cover: expired on their side, no
// webhook landed yet, so the pre-check passed and the wire is where we learn.
const SAME = [
  { errorCode: 'ENVELOPE_CANNOT_BE_MODIFIED', message: 'The envelope is not in a state that allows this operation.' },
  { message: 'This envelope has been voided.' },
  { errorCode: 'INVALID_ENVELOPE_STATUS' },
  { body: 'ENVELOPE_EXPIRED' },
  { message: 'Envelope has expired' },
];
for (const e of SAME) {
  const got = R.docusignRefusal(e, { purpose: 'draw_request' });
  ok(`DocuSign's "${(e.errorCode || e.message || e.body || '').slice(0, 34)}" is recognised as not-live`, !!got);
  if (got) {
    ok('...and answers with the SAME code as the pre-check', got.code === 'envelope_not_live');
    ok('...and offers the same fresh form', /fresh draw form/i.test(got.error) && got.reissue === 'draw_request');
  }
}
// A transient failure must NOT be dressed up as an expiry — that would tell
// somebody to re-issue a perfectly good form during an outage.
for (const e of [
  new Error('socket hang up'),
  { errorCode: 'INTERNAL_SERVER_ERROR', message: 'try again' },
  { message: 'ECONNRESET' },
  null,
]) {
  ok(`a transient failure (${(e && (e.errorCode || e.message)) || 'none'}) is NOT reported as an expiry`,
    R.docusignRefusal(e, { purpose: 'draw_request' }) === null);
}

// ---- staleness is advisory, and never a guess ------------------------------
const day = 86400000;
const now = new Date('2026-08-21T12:00:00Z');
ok('a fresh form says nothing', R.staleNotice({ sent_at: new Date(now - 5 * day), purpose: 'draw_request' }, now) === null);
const old40 = R.staleNotice({ sent_at: new Date(now - 40 * day), purpose: 'draw_request' }, now);
ok('a 40-day-old form says how long it has been', /40 days/.test(old40 || ''), old40);
ok('...and does not yet cry expiry', !/expires/i.test(old40 || ''));
const old200 = R.staleNotice({ sent_at: new Date(now - 200 * day), purpose: 'draw_request' }, now);
ok('a 200-day-old form warns that a reminder may reach nothing', /expires|fresh form/i.test(old200 || ''), old200);
ok('an unreadable date says nothing rather than guessing',
  R.staleNotice({ sent_at: 'not a date', purpose: 'draw_request' }, now) === null
  && R.staleNotice({ purpose: 'draw_request' }, now) === null);
ok('a future date says nothing rather than a negative age',
  R.daysSinceSent(new Date(now.getTime() + day), now) === null);
ok('the day count is calendar-exact', R.daysSinceSent(new Date(now - 3 * day), now) === 3);

// The stale notice may NEVER become a refusal: the account's real expiry window is
// DocuSign's to set, and refusing on our guess would block a nudge that would work.
ok('staleness never refuses — resendProblem ignores age entirely',
  R.resendProblem({ status: 'sent', envelope_id: 'e', purpose: 'draw_request', sent_at: new Date(now - 900 * day) }) === null);

console.log(`test-esign-resend-readiness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
