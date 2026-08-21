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
  /* CAPTIVE ONLY (2026-08-21). This used to pin the HYBRID shape — a captive recipient that
     DocuSign ALSO emails — which is what sent every borrower a second, broken link beside
     PILOT's working one. A correction re-sends PILOT's own email to the new address; DocuSign
     must stay silent, so the property is absent here exactly as it is on the send path. */
  eq(p.signerUpdate.embeddedRecipientStartURL, undefined, 'DocuSign is not asked to email the corrected address');
  ok(p.isBorrowerRecipient, 'a borrower recipient is flagged for the file-email warning');
}
// A non-embedded recipient (no clientUserId) -> no embedded fields.
{
  const p = planRecipientEmailChange({ ...base, recipient: { ...pendingBorrower, client_user_id: null } });
  ok(p.ok && !('clientUserId' in p.signerUpdate), 'non-embedded recipient carries no clientUserId');
}
// AUTHORIZATION: only a borrower / co-borrower may be re-addressed. A loan-officer or
// the lender's counter-signer is REJECTED on the server (403) — not merely hidden in the
// UI (the UI is not the security boundary). This is the core control: the route is gated
// only by file visibility, so without it a file-scoped staffer could redirect the binding
// lender counter-signature.
{
  const lo = { id: 'rec2', role: 'loan_officer', recipient_id_ds: '3', borrower_id: null, name: 'LO', email: 'lo@x.com', status: 'sent' };
  eq(planRecipientEmailChange({ ...base, recipient: lo }).status, 403, 'loan-officer recipient -> 403 (not re-addressable)');
}
{
  const admin = { id: 'rec3', role: 'admin', is_countersigner: true, recipient_id_ds: '4', borrower_id: null, name: 'Lender', email: 'lender@x.com', status: 'sent' };
  eq(planRecipientEmailChange({ ...base, recipient: admin }).status, 403, 'counter-signer (admin) recipient -> 403');
}
{
  // A row flagged is_countersigner is rejected regardless of role spelling.
  const cs = { id: 'rec5', role: 'borrower', is_countersigner: true, recipient_id_ds: '5', borrower_id: 'bor9', name: 'X', email: 'x@x.com', status: 'sent' };
  eq(planRecipientEmailChange({ ...base, recipient: cs }).status, 403, 'is_countersigner recipient -> 403');
}
{
  // A co-borrower IS re-addressable.
  const cob = { id: 'rec4', role: 'co_borrower', recipient_id_ds: '2', borrower_id: 'bor2', name: 'Co', email: 'co@x.com', status: 'sent' };
  const p = planRecipientEmailChange({ ...base, recipient: cob });
  ok(p.ok && p.isBorrowerRecipient === true, 'co-borrower recipient is re-addressable + flagged for the file warning');
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
// Not gated by the test-mode allow-list — the correction path only enforces it while on
// the demo host or in test mode. Passed to every IO call so the flow under test is the
// go-live path (the test-mode gate has its own cases below).
const noTestMode = { testMode: false, testEmailAllowlist: [] };

// (1) Happy path: new address DIFFERS from the file email -> warning input true.
{
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'old@x.com' });
  const ds = fakeDocusign();
  const notify = fakeNotify();
  const out = await changeRecipientEmail({
    envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'new@x.com',
    db, docusign: ds, switches: onSwitch, notify, cfg: noTestMode,
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
    db, docusign: fakeDocusign(), switches: onSwitch, notify: fakeNotify(), cfg: noTestMode,
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
      db, docusign: fakeDocusign(err), switches: onSwitch, notify: fakeNotify(), cfg: noTestMode,
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
      db, docusign: ds, switches: offSwitch, notify: fakeNotify(), cfg: noTestMode,
    });
  } catch (e) { threw = e; }
  eq(threw && threw.status, 409, 'paused sending -> 409');
  eq(ds.calls.length, 0, 'no DocuSign call when sending is paused');
}

// (5) A loan-officer recipient is REJECTED (403) — never corrected — and DocuSign is
// never called. Same for the admin counter-signer (the core authorization control).
for (const bad of [
  { id: 'rec2', role: 'loan_officer', recipient_id_ds: '3', borrower_id: null, name: 'LO', email: 'lo@x.com', status: 'sent' },
  { id: 'rec3', role: 'admin', is_countersigner: true, recipient_id_ds: '4', borrower_id: null, name: 'Lender', email: 'lender@x.com', status: 'sent' },
]) {
  const db = fakeDb({ env: liveEnv, recipient: bad, borrowerEmail: null });
  const ds = fakeDocusign();
  let threw = null;
  try {
    await changeRecipientEmail({
      envelopeRowId: 'env1', recipientRowId: bad.id, email: 'attacker@x.com',
      db, docusign: ds, switches: onSwitch, notify: fakeNotify(), cfg: noTestMode,
    });
  } catch (e) { threw = e; }
  eq(threw && threw.status, 403, `${bad.role}${bad.is_countersigner ? '/countersigner' : ''} correction -> 403`);
  eq(ds.calls.length, 0, `no DocuSign call for a rejected ${bad.role} correction`);
  eq(db.updates.length, 0, `no DB write for a rejected ${bad.role} correction`);
}

// (6) Test-mode allow-list gate: while in test mode, the new address must be on the
// allow-list, or the correction is refused BEFORE any DocuSign call (mirrors send.js).
{
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'old@x.com' });
  const ds = fakeDocusign();
  let threw = null;
  try {
    await changeRecipientEmail({
      envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'notallowed@x.com',
      db, docusign: ds, switches: onSwitch, notify: fakeNotify(),
      cfg: { testMode: true, testEmailAllowlist: ['allowed@x.com'] },
    });
  } catch (e) { threw = e; }
  eq(threw && threw.status, 409, 'test mode + non-allow-listed address -> 409');
  eq(ds.calls.length, 0, 'no DocuSign call for a test-mode-blocked address');
  eq(db.updates.length, 0, 'no DB write for a test-mode-blocked address');
}
{
  // An allow-listed address in test mode is accepted (case-insensitive).
  const db = fakeDb({ env: liveEnv, recipient: pendingBorrower, borrowerEmail: 'old@x.com' });
  const ds = fakeDocusign();
  const out = await changeRecipientEmail({
    envelopeRowId: 'env1', recipientRowId: 'rec1', email: 'Allowed@x.com',
    db, docusign: ds, switches: onSwitch, notify: fakeNotify(),
    cfg: { testMode: true, testEmailAllowlist: ['allowed@x.com'] },
  });
  eq(ds.calls.length, 1, 'an allow-listed test-mode address is corrected');
  eq(out.email, 'Allowed@x.com', 'the corrected email is returned');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
