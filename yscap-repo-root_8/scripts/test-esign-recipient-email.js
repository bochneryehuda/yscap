/**
 * Pure test for changing a signer's email on an already-sent DocuSign package and
 * re-sending the invitation (owner-directed: "any DocuSign package that is going out —
 * we need to change the email address once it was sent, re-send to a different address,
 * and warn to also change the email on the file if this is the correct one").
 *
 * No DB, no network: the DocuSign client + db + notify are injected as fakes, so this
 * exercises the guard logic, the exact correction payload (resend + hybrid config), the
 * DB write, the scoped re-nudge, and the "differs from the file email" warning input.
 *   node scripts/test-esign-recipient-email.js
 */
const R = require('path').resolve(__dirname, '..');
const docusign = require(R + '/src/lib/integrations/docusign');
const { planRecipientEmailChange, changeRecipientEmail } = require(R + '/src/lib/esign/recipient-email');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

(async () => {
// ---------------------------------------------------------------------------
// docusign.buildRecipientUpdateBody — the correction payload shape.
// ---------------------------------------------------------------------------
{
  const body = docusign.buildRecipientUpdateBody({ signers: [{ recipientId: 1, email: 'a@b.com', name: 'A B', clientUserId: 'c1', embeddedRecipientStartURL: 'SIGN_AT_DOCUSIGN' }] });
  eq(body.signers.length, 1, 'one signer in body');
  eq(body.signers[0].recipientId, '1', 'recipientId stringified');
  eq(body.signers[0].email, 'a@b.com', 'email carried');
  eq(body.signers[0].name, 'A B', 'name carried');
  eq(body.signers[0].clientUserId, 'c1', 'embedded clientUserId preserved');
  eq(body.signers[0].embeddedRecipientStartURL, 'SIGN_AT_DOCUSIGN', 'hybrid email flag preserved');
  ok(body.carbonCopies === undefined, 'no carbonCopies key when none given');
  const bodyNoName = docusign.buildRecipientUpdateBody({ signers: [{ recipientId: '2', email: 'x@y.com' }] });
  ok(!('name' in bodyNoName.signers[0]), 'name omitted when not given');
  ok(!('clientUserId' in bodyNoName.signers[0]), 'clientUserId omitted for a non-embedded recipient');
}

// ---------------------------------------------------------------------------
// docusign.recipientUpdateFailure — a 200 with a failed recipient must surface.
// ---------------------------------------------------------------------------
ok(docusign.recipientUpdateFailure([{ errorDetails: { errorCode: 'SUCCESS' } }]) === null, 'all-SUCCESS -> null');
ok(docusign.recipientUpdateFailure([]) === null, 'empty -> null');
ok(docusign.recipientUpdateFailure(null) === null, 'null -> null');
ok(docusign.recipientUpdateFailure(undefined) === null, 'undefined -> null');
{
  const bad = docusign.recipientUpdateFailure([{ errorDetails: { errorCode: 'RECIPIENT_UPDATE_FAILED', message: 'already signed' } }]);
  ok(bad && bad.errorDetails.errorCode === 'RECIPIENT_UPDATE_FAILED', 'a non-SUCCESS result is returned');
  const mixed = docusign.recipientUpdateFailure([{ errorDetails: { errorCode: 'SUCCESS' } }, { errorDetails: { errorCode: 'ENVELOPE_INVALID_STATUS' } }]);
  ok(mixed && mixed.errorDetails.errorCode === 'ENVELOPE_INVALID_STATUS', 'the FIRST failing result is returned');
}

// ---------------------------------------------------------------------------
// planRecipientEmailChange — every guard branch (pure).
// ---------------------------------------------------------------------------
const liveEnv = { id: 'env1', envelope_id: 'DS-1', status: 'sent', application_id: 'app1', purpose: 'term_sheet_package' };
const pendingBorrower = { id: 'rec1', role: 'borrower', recipient_id_ds: '1', borrower_id: 'bor1', name: 'Old Name', email: 'old@x.com', client_user_id: 'env1:borrower', status: 'sent' };
const base = { env: liveEnv, recipient: pendingBorrower, email: 'new@x.com', sendEnabled: true };

eq(planRecipientEmailChange({ ...base, email: 'notanemail' }).status, 400, 'invalid email -> 400');
eq(planRecipientEmailChange({ ...base, email: '' }).status, 400, 'blank email -> 400');
eq(planRecipientEmailChange({ ...base, env: null }).status, 404, 'no envelope -> 404');
eq(planRecipientEmailChange({ ...base, env: { ...liveEnv, envelope_id: null } }).status, 409, 'not sent yet -> 409');
for (const st of ['completed', 'declined', 'voided']) {
  eq(planRecipientEmailChange({ ...base, env: { ...liveEnv, status: st } }).status, 409, `terminal (${st}) -> 409`);
}
eq(planRecipientEmailChange({ ...base, sendEnabled: false }).status, 409, 'sending paused -> 409');
eq(planRecipientEmailChange({ ...base, recipient: null }).status, 404, 'no recipient -> 404');
eq(planRecipientEmailChange({ ...base, recipient: { ...pendingBorrower, signed_at: '2026-01-01' } }).status, 409, 'signed recipient -> 409');
eq(planRecipientEmailChange({ ...base, recipient: { ...pendingBorrower, status: 'completed' } }).status, 409, 'completed recipient -> 409');
eq(planRecipientEmailChange({ ...base, recipient: { ...pendingBorrower, declined_at: '2026-01-01' } }).status, 409, 'declined recipient -> 409');
// Same email AND same name -> nothing to change.
eq(planRecipientEmailChange({ ...base, email: 'OLD@x.com', name: 'Old Name' }).status, 400, 'same email+name -> 400');
// Same email but a NEW name IS a change (a name correction).
ok(planRecipientEmailChange({ ...base, email: 'old@x.com', name: 'Corrected Name' }).ok, 'same email, new name -> allowed');

// The happy path builds the exact hybrid signer payload.
{
  const p = planRecipientEmailChange(base);
  ok(p.ok, 'valid change -> ok');
  eq(p.newEmail, 'new@x.com', 'new email trimmed/carried');
  eq(p.newName, 'Old Name', 'name defaults to the recipient name when not given');
  eq(p.prevEmail, 'old@x.com', 'previous email reported');
  eq(p.signerUpdate.recipientId, '1', 'signer keyed by DocuSign recipient id');
  eq(p.signerUpdate.email, 'new@x.com', 'signer email is the new one');
  eq(p.signerUpdate.clientUserId, 'env1:borrower', 'embedded clientUserId preserved in the correction');
  eq(p.signerUpdate.embeddedRecipientStartURL, 'SIGN_AT_DOCUSIGN', 'hybrid resend preserved');
  ok(p.isBorrowerRecipient, 'a borrower recipient is flagged for the file-email warning');
}
// A non-embedded recipient (no clientUserId) -> no embedded fields.
{
  const p = planRecipientEmailChange({ ...base, recipient: { ...pendingBorrower, client_user_id: null } });
  ok(p.ok && !('clientUserId' in p.signerUpdate), 'non-embedded recipient carries no clientUserId');
}
// A loan-officer signer is correctable but is NOT a borrower recipient (no file warning).
{
  const lo = { id: 'rec2', role: 'loan_officer', recipient_id_ds: '3', borrower_id: null, name: 'LO', email: 'lo@x.com', status: 'sent' };
  const p = planRecipientEmailChange({ ...base, recipient: lo });
  ok(p.ok && p.isBorrowerRecipient === false, 'loan-officer recipient is not a borrower recipient');
}
// A leading/trailing-space email is trimmed, not rejected.
eq(planRecipientEmailChange({ ...base, email: '  new@x.com  ' }).newEmail, 'new@x.com', 'email is trimmed');

// ---------------------------------------------------------------------------
// changeRecipientEmail — full IO flow with injected fakes.
// ---------------------------------------------------------------------------
function fakeDb({ env, recipient, borrowerEmail }) {
  const updates = [];
  return {
    updates,
    async query(sql, params) {
      if (/FROM esign_envelopes/i.test(sql)) return { rows: env ? [env] : [] };
      if (/UPDATE esign_recipients/i.test(sql)) { updates.push({ sql, params }); return { rows: [] }; }
      if (/FROM esign_recipients/i.test(sql)) return { rows: recipient ? [recipient] : [] };
      if (/FROM borrowers/i.test(sql)) return { rows: [{ email: borrowerEmail }] };
      return { rows: [] };
    },
  };
}
function fakeDocusign(throwErr) {
  const calls = [];
  return {
    calls,
    async updateRecipients(envelopeId, opts) {
      calls.push({ envelopeId, opts });
      if (throwErr) throw throwErr;
      return { recipientUpdateResults: [{ errorDetails: { errorCode: 'SUCCESS' } }] };
    },
  };
}
function fakeNotify() {
  const calls = [];
  return { calls, async notifyReadyToSign(rowId, opts) { calls.push({ rowId, opts }); return { sent: 1 }; } };
}
const onSwitch = { on: () => true };
const offSwitch = { on: () => false };

// (1) Happy path: new address DIFFERS from the file email -> warning input true.
{
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'old@x.com' });
  const ds = fakeDocusign();
  const notify = fakeNotify();
  const out = await changeRecipientEmail({
    envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'new@x.com',
    db, docusign: ds, switches: onSwitch, notify,
  });
  eq(ds.calls.length, 1, 'DocuSign correction called once');
  eq(ds.calls[0].envelopeId, 'DS-1', 'correction targets the DocuSign envelope id');
  eq(ds.calls[0].opts.resend, true, 'correction re-sends the invitation');
  eq(ds.calls[0].opts.signers[0].email, 'new@x.com', 'correction carries the new email');
  eq(db.updates.length, 1, 'the recipient row is updated once');
  eq(db.updates[0].params[1], 'new@x.com', 'recipient email persisted');
  eq(notify.calls.length, 1, 'PILOT re-nudge sent');
  eq(notify.calls[0].opts.onlyRecipientIdDs, '1', 're-nudge scoped to the corrected recipient only');
  eq(out.differsFromFile, true, 'differsFromFile true when the file still shows the old address');
  eq(out.fileEmail, 'old@x.com', 'the file email is reported for the warning');
  eq(out.email, 'new@x.com', 'result carries the new email');
  eq(out.prevEmail, 'old@x.com', 'result carries the previous email');
  eq(out.role, 'borrower', 'result carries the role');
  eq(out.borrowerId, 'bor1', 'result carries the borrower id');
  eq(out.applicationId, 'app1', 'result carries the application id');
}

// (2) New address MATCHES the file email -> no "update the file" warning.
{
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'new@x.com' });
  const out = await changeRecipientEmail({
    envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'new@x.com',
    db, docusign: fakeDocusign(), switches: onSwitch, notify: fakeNotify(),
  });
  eq(out.differsFromFile, false, 'no warning when the new address already matches the file');
}

// (3) A DocuSign refusal must NOT persist the new email (the correction is atomic-ish).
{
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'old@x.com' });
  const err = new Error('DocuSign could not update the recipient: already signed');
  err.retryable = false;
  let threw = null;
  try {
    await changeRecipientEmail({
      envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'new@x.com',
      db, docusign: fakeDocusign(err), switches: onSwitch, notify: fakeNotify(),
    });
  } catch (e) { threw = e; }
  ok(threw && threw.retryable === false, 'a DocuSign refusal propagates');
  eq(db.updates.length, 0, 'a failed correction never persists the new email');
}

// (4) Sending paused -> refused BEFORE any DocuSign call.
{
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'old@x.com' });
  const ds = fakeDocusign();
  let threw = null;
  try {
    await changeRecipientEmail({
      envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'new@x.com',
      db, docusign: ds, switches: offSwitch, notify: fakeNotify(),
    });
  } catch (e) { threw = e; }
  eq(threw && threw.status, 409, 'paused sending -> 409');
  eq(ds.calls.length, 0, 'no DocuSign call when sending is paused');
}

// (5) A loan-officer recipient is corrected but NOT re-nudged with the borrower magic link.
{
  const lo = { id: 'rec2', role: 'loan_officer', recipient_id_ds: '3', borrower_id: null, name: 'LO', email: 'lo@x.com', status: 'sent' };
  const db = fakeDb({ env: liveEnv, recipient: lo, borrowerEmail: null });
  const notify = fakeNotify();
  const out = await changeRecipientEmail({
    envelopeRowId: 'env1', recipientRowId: 'rec2', email: 'newlo@x.com',
    db, docusign: fakeDocusign(), switches: onSwitch, notify,
  });
  eq(notify.calls.length, 0, 'a loan-officer correction sends no borrower magic-link nudge');
  eq(out.differsFromFile, false, 'no file-email warning for a non-borrower recipient');
  eq(db.updates.length, 1, 'the loan-officer recipient email is still corrected');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
