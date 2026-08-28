'use strict';
/**
 * test-esign-one-invitation-db — the DocuSign restructure, proven ON THE WIRE.
 *
 * WHY THIS EXISTS. The whole 2026-08-21 DocuSign restructure shipped covered by ONE suite that
 * reads the source and checks wording. That proves the property is gone and the sentences are
 * right; it cannot prove that an email leaves the building, reaches the person the owner named,
 * or carries the document. The owner's two headline asks were exactly those:
 *
 *   · *"The Loan Officers and the Admins that are signing … should receive it directly from Pilot
 *     with the direct link to sign."*
 *   · *"we need to add a notification for every document that is completed … They should receive a
 *     nice Pilot email with the document attached once it's completed."*
 *
 * So this drives the REAL functions against a REAL database, with the REAL catalog rendering, and
 * asserts the WIRE PAYLOAD — `src/lib/email`.sendMail is stubbed and inspected. A passing send
 * against the `none` provider proves nothing about who was addressed or what rode along, which is
 * this repo's own standing rule for any outbound-email suite.
 *
 * DB-gated: skips cleanly with no DATABASE_URL. Nothing leaves the process.
 * Run: DATABASE_URL=… node scripts/test-esign-one-invitation-db.js
 */
if (!process.env.DATABASE_URL) { console.log('test-esign-one-invitation-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-esign-db';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');
const db = require(REPO + '/src/db');
const storage = require(REPO + '/src/lib/storage');
const mailer = require(REPO + '/src/lib/email');
const notifySigners = require(REPO + '/src/lib/esign/notify-signers');
const completionNotice = require(REPO + '/src/lib/esign/completion-notice');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL - ' + m); } };
const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log(`  FAIL - ${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); } };
const TAG = 'es' + crypto.randomBytes(4).toString('hex');

(async () => {
  /* THE MIGRATIONS RUN FIRST. Booting the server kicks them off asynchronously, so a suite that
     starts writing straight away races a column into existence and reads "does not exist" on the
     very run meant to prove it. */
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const outbox = [];
  const realSend = mailer.sendMail;
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };

  const ids = { apps: [], borrowers: [], staff: [], envelopes: [], docs: [] };
  try {
    // ---------------------------------------------------------------- the file
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Grace','Hopper',$1) RETURNING id`,
      [`bor.${TAG}@example.com`])).rows[0].id;
    ids.borrowers.push(bor);
    const lo = (await db.query(
      `INSERT INTO staff_users(email, full_name, role, is_active, is_external)
       VALUES($1,'Moshe Officer','loan_officer',true,false) RETURNING id`,
      [`lo.${TAG}@example.com`])).rows[0].id;
    ids.staff.push(lo);
    const app = (await db.query(
      `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount)
       VALUES($1,$2,'approved',$3,'{"oneLine":"3 Sign St, Town, NY 11111"}',500000) RETURNING id`,
      [bor, lo, `YS${TAG.toUpperCase()}`])).rows[0].id;
    ids.apps.push(app);

    const envelope = async (purpose, status = 'sent') => {
      const e = (await db.query(
        `INSERT INTO esign_envelopes(application_id, provider, envelope_id, status, purpose, embedded)
         VALUES($1,'docusign',$2,$3,$4,true) RETURNING *`,
        [app, `ds-${TAG}-${purpose}`, status, purpose])).rows[0];
      ids.envelopes.push(e.id);
      return e;
    };
    /* BORN 'created' — THE STATE THE SEND PATH ACTUALLY WRITES. This defaulted to 'sent',
       which `orchestrate.js` never produces for anybody: it inserts EVERY recipient as
       'created' (line 924) and nothing moves them before `notifyReadyToSign` runs a moment
       later. So the fixture was testing a state that only exists after a webhook, and the
       suite could not see the 2026-08-25 defect — every real borrower was skipped while
       every test borrower was invited. A fixture must stage what the code under test is
       actually handed. */
    const recipient = async (envId, o) => db.query(
      `INSERT INTO esign_recipients(envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds,
                                    borrower_id, name, email, embedded, client_user_id, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
      [envId, o.role, o.order || 1, !!o.counter, String(o.rid), o.borrowerId || null,
       o.name, o.email, `${envId}:${o.role}`, o.status || 'created']);

    // ============================================================== 1. OUR OWN SIGNER
    console.log('1. a loan officer who has to sign gets OUR email, with a working link');
    const iska = await envelope('heter_iska');
    await recipient(iska.id, { role: 'borrower', rid: 1, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
    await recipient(iska.id, { role: 'loan_officer', rid: 2, name: 'Moshe Officer', email: `lo.${TAG}@example.com` });

    outbox.length = 0;
    const r1 = await notifySigners.notifyReadyToSign(iska.id, { db });
    const to = (m) => (Array.isArray(m.to) ? m.to : [m.to]).filter(Boolean).map(String);
    const forStaff = outbox.find((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`));
    ok(!!forStaff, 'the loan officer is actually emailed — not merely resolved as a recipient');
    ok(!!forStaff && /sign/i.test(String(forStaff.subject || '')), 'the subject says a signature is needed');
    const staffBody = String((forStaff && (forStaff.html || forStaff.text)) || '');
    ok(/\/api\/esign\/sign\?t=/.test(staffBody), '…and it carries a direct signing link, not a portal detour');
    /* OUR OWN SIGNER IS NOT GREETED AS THE BORROWER. The borrower letter reassures the reader
       about documents they asked for; sent to an officer it reads as a mistake. */
    ok(/Grace Hopper/.test(staffBody), 'the internal letter names the borrower whose file it is');
    const forBorrower = outbox.find((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`));
    ok(!!forBorrower, 'the borrower is emailed too — one invitation each, both from PILOT');
    ok(String(forBorrower.html || '') !== staffBody, '…and the two letters are not the same letter');
    ok(r1.sent >= 2, 'both were reported sent');

    // ============================================================== 2. WHOSE TURN IT IS
    /* THE OWNER'S 2026-08-25 REPORT LIVES HERE: *"borrowers are not getting email notification
       to sign term sheet … this is the final term sheet that I'm talking about. He needs to
       sign it."*

       This is the exact package `orchestrate.js` builds and then calls `notifyReadyToSign` on,
       staged the way it really arrives — borrower and officer on routing order 1, the lender's
       counter-signer on order 2, EVERY ONE OF THEM at 'created'. The turn test used to ask
       `recipient_status` alone, which is 'created' for all of them at that moment, so every
       recipient was skipped and the run reported {sent:0}. Since the same 2026-08-21 change
       stopped DocuSign emailing captive recipients, the borrower received NOTHING AT ALL.
       Reverting the turn test to that reproduces the report exactly. */
    console.log('2. the borrower is invited on a fresh send — and only when it is their turn');
    const ts = await envelope('term_sheet_package');
    await recipient(ts.id, { role: 'borrower', rid: 1, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
    /* DocuSign holds a routing-order-2 recipient at `created` until everyone before them signs.
       Emailing them now would say "your signature is needed" when DocuSign will not let them
       sign, and the link would fail — the exact experience being fixed. */
    await recipient(ts.id, { role: 'admin', rid: 3, order: 2, counter: true, name: 'Moshe Officer',
      email: `lo.${TAG}@example.com`, status: 'created' });
    outbox.length = 0;
    const r2 = await notifySigners.notifyReadyToSign(ts.id, { db });
    ok(outbox.some((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`)),
      'the borrower on a freshly-sent package IS emailed the invitation to sign');
    ok(r2.sent >= 1, '…and the run reports it sent, not skipped');
    ok(!outbox.some((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`)),
      'the counter-signer is left alone until the signers before them have finished');

    /* THE RECORD, and the reason `invited_at` exists at all: the owner asked *"Please audit all
       the logs from the last few final terms that we sent out"* and there was nothing to audit.
       This email is the one `catalog.send` that passes no applicationId — deliberately, its body
       carries a magic link that signs the holder in AS THE BORROWER — so the Email Center cannot
       answer it either. A timestamp answers "was this signer invited, and when" without putting
       a bearer credential anywhere a staffer can read it. */
    const invite = async (rid) => (await db.query(
      `SELECT invited_at, invite_count FROM esign_recipients
        WHERE envelope_row_id = $1 AND recipient_id_ds = $2`, [ts.id, String(rid)])).rows[0];
    const firstInvite = await invite(1);
    ok(!!firstInvite.invited_at, 'the invitation is recorded on the borrower’s own row');
    eq(Number(firstInvite.invite_count), 1, '…counted once');
    eq((await invite(3)).invited_at, null, 'and the counter-signer carries no invitation yet');

    /* NEVER THE SAME INVITATION TWICE. Both the send path and the webhook may legitimately reach
       a recipient first, so the send-once guard has to be the RECORD, not which caller arrived. */
    outbox.length = 0;
    const rAgain = await notifySigners.notifyReadyToSign(ts.id, { db });
    eq(rAgain.sent, 0, 'running the send again invites nobody a second time');
    eq(outbox.length, 0, '…and puts no second email on the wire');

    /* THE ONE CASE THAT MAY RE-SEND is an explicit force — today a corrected email address,
       where re-inviting is the entire point. `invited_at` keeps the FIRST time (the audit
       answer) while `invite_count` records the re-nudge. */
    outbox.length = 0;
    const rForce = await notifySigners.notifyReadyToSign(ts.id, { db, onlyRecipientIdDs: '1', force: true });
    eq(rForce.sent, 1, 'an explicit force does re-send — a corrected address must be re-invited');
    const second = await invite(1);
    eq(String(second.invited_at), String(firstInvite.invited_at),
      '…and the FIRST invitation time is what the record keeps');
    eq(Number(second.invite_count), 2, '…with the re-nudge counted');

    /* AND THEIR TURN OPENS ON ITS OWN. Nothing writes recipient status at send time, so the
       counter-signer's invitation cannot wait on one: the routing order answers it, and it is
       the same thing DocuSign is deciding — nobody earlier is still to sign. */
    await db.query(
      `UPDATE esign_recipients SET signed_at = now(), status = 'signed'
        WHERE envelope_row_id = $1 AND routing_order = 1`, [ts.id]);
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(ts.id, { db });
    ok(outbox.some((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`)),
      'once the signers before them finish, the counter-signer is invited');
    ok(!!(await invite(3)).invited_at, '…and that invitation is recorded too');

    // ============================================================== 3. AN UNPLACEABLE SIGNER
    console.log('3. a staff signer we cannot place is never emailed a signing bearer');
    const orphan = await envelope('draw_request');
    await recipient(orphan.id, { role: 'loan_officer', rid: 1, name: 'Nobody Here',
      email: `ghost.${TAG}@example.com` });
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(orphan.id, { db });
    ok(!outbox.length, 'an address on no ACTIVE staff row gets nothing — the token signs an envelope');
    /* AND A DEPARTED OFFICER IS THE SAME CASE, which is the one that actually happens.

       IT NEEDS ITS OWN ENVELOPE, and that is the whole point of putting it here rather than
       re-running an earlier one: every recipient on `iska` was invited back in section 1, so
       `invited_at` would skip them and this would report a clean pass with the active-staff
       guard deleted — a mutation masked by an unrelated rule, which is exactly the failure
       this suite's header warns about. A fresh package makes the guard the only thing that
       can refuse. (Its own purpose too: `uq_esign_inflight` allows one in-flight envelope per
       file and purpose, and this file has already spent the other three.) */
    await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [lo]);
    const departed = await envelope('noo_affidavit');
    await recipient(departed.id, { role: 'loan_officer', rid: 4, name: 'Moshe Officer',
      email: `lo.${TAG}@example.com` });
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(departed.id, { db });
    ok(!outbox.some((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`)),
      'a deactivated officer’s address is never sent a signing link');
    await db.query(`UPDATE staff_users SET is_active=true WHERE id=$1`, [lo]);
    /* THE CONTROL, on the same envelope: re-activate them and the very same call DOES invite —
       so the refusal above was the active-staff guard and not some other rule quietly biting. */
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(departed.id, { db });
    ok(outbox.some((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`)),
      '…and an ACTIVE officer on that same package is invited — the control');

    // ============================================================== 4. THE EXECUTED COPY
    console.log('4. every completed package emails the borrower — with the document attached');
    const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x41)]);
    const attachFor = async (env, kind, filename) => {
      const saved = await storage.save(PDF, { filename });
      const doc = (await db.query(
        `INSERT INTO documents(application_id, filename, content_type, storage_ref, storage_provider,
                               size_bytes, doc_kind, source_type, visibility, review_status, is_current)
         VALUES($1,$2,'application/pdf',$3,$4,$5,$6,'system','borrower','accepted',true) RETURNING id`,
        [app, filename, saved.ref, saved.provider, PDF.length, kind])).rows[0].id;
      ids.docs.push(doc);
      /* `document_id` is DOCUSIGN'S OWN index within the envelope (1, 2, 3…), an integer — it is
         NOT a foreign key to `documents`. The uuid of the executed copy lives in
         `completed_document_id`, which is what completion-notice joins on. */
      await db.query(
        `INSERT INTO esign_envelope_docs(envelope_row_id, document_id, doc_kind, completed_document_id)
         VALUES($1,$2,$3,$4)`, [env.id, 1, kind, doc]);
      return doc;
    };

    /* THE THREE PACKAGES THE OWNER NAMED, each with its own executed copy. */
    const PACKAGES = [
      { env: iska, kind: 'heter_iska_signed', file: 'heter-iska-signed.pdf', label: /Heter Iska/i },
      { env: ts, kind: 'term_sheet_signed', file: 'term-sheet-signed.pdf', label: /Term sheet/i },
    ];
    for (const P of PACKAGES) {
      await attachFor(P.env, P.kind, P.file);
      outbox.length = 0;
      const res = await completionNotice.notifyExecuted(P.env, { db });
      const mail = outbox.find((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`));
      ok(!!mail, `${P.kind}: the borrower who signed it is told`);
      ok(!!mail && P.label.test(String(mail.subject || '') + String(mail.html || '')),
        `${P.kind}: …and the package is named in words they would use`);
      /* THE ATTACHMENT IS THE POINT. Asserted on the BYTES, not on a flag: an email that claims
         a copy is attached and carries none is worse than one that says it is in the portal. */
      const att = (mail && mail.attachments) || [];
      eq(att.length, 1, `${P.kind}: exactly one document rides along`);
      const content = att[0] && (att[0].content || att[0].data);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'base64');
      ok(bytes.length === PDF.length && bytes.slice(0, 5).toString() === '%PDF-',
        `${P.kind}: and it is the real executed PDF, byte for byte`);
      ok(res.sent >= 1, `${P.kind}: reported sent`);
    }

    /* A PACKAGE THIS MODULE HAS NO WORDING FOR IS NOT ANNOUNCED AT ALL — "your documents are
       executed" about something it cannot name is worse than the silence it replaces.

       THE CASES ARE THE ONES THE DATABASE CAN ACTUALLY REACH, not an invented purpose: the
       `chk_esign_purpose` CHECK admits exactly term_sheet_package / heter_iska / test /
       draw_request / noo_affidavit / NULL, and `completion-notice.PACKAGE` names four of them.
       So the unnamed states are the CONNECTION SELF-TEST and a purpose nobody set — and the
       self-test one matters, because that envelope is fired against a real DocuSign account and
       must never mail a borrower. */
    for (const [purpose, what] of [['test', 'the DocuSign connection self-test'], [null, 'an envelope whose purpose was never set']]) {
      const unnamed = await envelope(purpose);
      await recipient(unnamed.id, { role: 'borrower', rid: 1, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
      outbox.length = 0;
      const un = await completionNotice.notifyExecuted(unnamed, { db });
      eq(un.reason, 'unknown_package', `${what} is skipped with a stated reason`);
      eq(outbox.length, 0, `…and ${what} sends nothing`);
    }

    /* THE COPY THIS ENVELOPE PRODUCED, never the newest signed copy on the file. Both envelopes
       above now carry a signed document; the Heter Iska's notice must still attach ITS own. */
    outbox.length = 0;
    await completionNotice.notifyExecuted(iska, { db });
    const again = outbox.find((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`));
    const name0 = again && again.attachments && again.attachments[0] && again.attachments[0].filename;
    eq(String(name0 || ''), 'heter-iska-signed.pdf',
      'a re-run attaches the copy THIS envelope produced, not the newest one on the file');

    console.log('5. a test envelope, and one with no file, are never announced');
    const orphanEnv = { id: iska.id, purpose: 'heter_iska', application_id: null, is_test: false };
    eq((await completionNotice.notifyExecuted(orphanEnv, { db })).reason, 'no_file',
      'an envelope with no loan file behind it says so rather than throwing');
    eq((await completionNotice.notifyExecuted({ ...iska, is_test: true }, { db })).reason, 'no_file',
      'and a self-test envelope is never mailed to anybody');

    // ================================================= 6. VIEWED, NOT SIGNED
    /* THE OWNER'S OTHER HALF (2026-08-21): *"Get a notification from Docusign when it's signed
       and when it's being viewed."* The signed half was already ours. The viewed half rested on
       DocuSign's carbon copies, which are mailed when routing reaches them and when the envelope
       completes — NOT on each open. PILOT already received the signal and stored it
       (`delivered_at`; DocuSign's `delivered` means OPENED) and told nobody. Driven through the
       exported webhook path so this is the real transition, not a hand-called helper. */
    console.log('\n6. a signer OPENING the package tells the team, once, in-app');
    const webhook = require(REPO + '/src/lib/esign/webhook');
    /* ITS OWN FILE, for two reasons: `uq_esign_inflight` allows ONE in-flight envelope per
       (file, purpose) and the sections above already spent this file's, and counting "opened"
       notices on a private file means no other section's fan-out can be mistaken for this one. */
    const app6 = (await db.query(
      `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount)
       VALUES($1,$2,'approved',$3,'{"oneLine":"6 View St, Town, NY 11111"}',500000) RETURNING id`,
      [bor, lo, `YSV${TAG.toUpperCase()}`])).rows[0].id;
    ids.apps.push(app6);
    const envelope6 = async (purpose) => {
      const e = (await db.query(
        `INSERT INTO esign_envelopes(application_id, provider, envelope_id, status, purpose, embedded)
         VALUES($1,'docusign',$2,'sent',$3,true) RETURNING *`,
        [app6, `ds-${TAG}-v-${purpose}`, purpose])).rows[0];
      ids.envelopes.push(e.id);
      return e;
    };
    const viewedEnv = await envelope6('term_sheet_package');
    await recipient(viewedEnv.id, {
      role: 'borrower', rid: 7, borrowerId: bor, name: 'Grace Hopper',
      email: `bor.${TAG}@example.com`, status: 'sent',
    });
    const dsEnvelope = (status, deliveredAt) => ({
      recipients: { signers: [{
        recipientId: '7', routingOrder: 1, name: 'Grace Hopper',
        email: `bor.${TAG}@example.com`, status, deliveredDateTime: deliveredAt,
      }] },
    });
    const openedCount = async () => Number((await db.query(
      `SELECT count(*) AS n FROM notifications WHERE application_id=$1 AND title ILIKE '%opened%'`,
      [app6])).rows[0].n);

    outbox.length = 0;
    await webhook.applyRecipients(db, viewedEnv, dsEnvelope('delivered', '2026-08-21T10:00:00Z'));
    await require(REPO + '/src/lib/notify').drainEmails().catch(() => {});
    eq(await openedCount(), 1, 'opening the package raises exactly one notice for the file team');
    const stamped = (await db.query(
      `SELECT delivered_at, status FROM esign_recipients WHERE envelope_row_id=$1 AND recipient_id_ds='7'`,
      [viewedEnv.id])).rows[0];
    ok(!!stamped.delivered_at, '…and the viewed stamp is on the recipient row');
    eq(stamped.status, 'delivered', '…with the status DocuSign reported');
    /* IN-APP ONLY. A borrower opens a term sheet whenever they read their mail; the owner's
       standing rule on this class is "stop the bombardment with stuff that is not important".
       Asserted on the WIRE with the mailer stubbed — a quiet `none` provider proves nothing. */
    const openedMail = outbox.filter((m) => /opened/i.test(String(m.subject || '')));
    eq(openedMail.length, 0, 'and it is IN-APP ONLY — nobody is emailed that a document was opened');

    /* DocuSign resends `delivered` freely; the notice must not resend with it. */
    await webhook.applyRecipients(db, viewedEnv, dsEnvelope('delivered', '2026-08-21T10:00:00Z'));
    await require(REPO + '/src/lib/notify').drainEmails().catch(() => {});
    eq(await openedCount(), 1, 'a repeated delivered webhook does NOT announce it a second time');

    /* SIGNING IS NOT OPENING — the terminal notice is `notifyTerminal`'s job, and a signer who
       goes straight to completed must not also be announced as merely having looked. */
    const signedEnv = await envelope6('heter_iska');
    await recipient(signedEnv.id, {
      role: 'borrower', rid: 8, borrowerId: bor, name: 'Grace Hopper',
      email: `bor.${TAG}@example.com`, status: 'sent',
    });
    const before8 = await openedCount();
    await webhook.applyRecipients(db, signedEnv, {
      recipients: { signers: [{
        recipientId: '8', routingOrder: 1, name: 'Grace Hopper', email: `bor.${TAG}@example.com`,
        status: 'completed', signedDateTime: '2026-08-21T11:00:00Z',
      }] },
    });
    await require(REPO + '/src/lib/notify').drainEmails().catch(() => {});
    eq(await openedCount(), before8, 'a signer who goes straight to signed is never announced as "opened"');

    /* An app-less admin self-test has no file and no team — it must tell nobody rather than throw. */
    const testEnv = (await db.query(
      `INSERT INTO esign_envelopes(application_id, provider, envelope_id, status, purpose, embedded, is_test)
       VALUES(NULL,'docusign',$1,'sent','test',true,true) RETURNING *`, [`ds-${TAG}-selftest`])).rows[0];
    ids.envelopes.push(testEnv.id);
    await recipient(testEnv.id, { role: 'admin', rid: 9, name: 'Admin Self', email: `adm.${TAG}@example.com`, status: 'sent' });
    let threw = null;
    try { await webhook.applyRecipients(db, testEnv, dsEnvelope('delivered', '2026-08-21T10:00:00Z')); }
    catch (e) { threw = e; }
    ok(!threw, 'an app-less self-test envelope does not throw on the viewed path');

    // ============================================ 7. THE WEBHOOK'S OWN RECOVERY
    /* THE SECOND HALF OF THE 2026-08-25 FIX. When DocuSign opens a recipient's turn, the webhook
       invites them — and that recovery used to run for OUR OWN STAFF ONLY. So with the send path
       skipping everyone at 'created', a BORROWER could be invited by neither path, which is what
       made the report "they get nothing at all" rather than "it arrives late".

       Widening it is only safe because the send-once guard is now the RECORD on the row rather
       than which caller happened to arrive first — so whichever path reaches a signer wins and
       the other skips. Both halves are asserted here, on the wire, through the real webhook. */
    console.log('\n7. the webhook invites whoever DocuSign has just opened — borrower included');
    const late = await envelope6('noo_affidavit');
    await recipient(late.id, {
      role: 'borrower', rid: 11, borrowerId: bor, name: 'Grace Hopper',
      email: `bor.${TAG}@example.com`, status: 'created',
    });
    const opened = (rid, status) => ({
      recipients: { signers: [{
        recipientId: String(rid), routingOrder: 1, name: 'Grace Hopper',
        email: `bor.${TAG}@example.com`, status,
      }] },
    });
    outbox.length = 0;
    await webhook.applyRecipients(db, late, opened(11, 'sent'));
    ok(outbox.some((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`)),
      'a BORROWER whose turn DocuSign just opened is invited by the webhook, not only our staff');
    const lateRow = async () => (await db.query(
      `SELECT invited_at, invite_count FROM esign_recipients
        WHERE envelope_row_id = $1 AND recipient_id_ds = '11'`, [late.id])).rows[0];
    eq(Number((await lateRow()).invite_count), 1, '…and the invitation is recorded once');

    /* AND NEITHER PATH INVITES SOMEBODY THE OTHER ALREADY DID. DocuSign redelivers freely, and
       the send path may run again for its own reasons; the row is what stops a second copy. */
    outbox.length = 0;
    await webhook.applyRecipients(db, late, opened(11, 'delivered'));
    await notifySigners.notifyReadyToSign(late.id, { db });
    eq(outbox.filter((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`)
      && /sign/i.test(String(m.subject || ''))).length, 0,
      'a later webhook and a re-run of the send both find them already invited');
    eq(Number((await lateRow()).invite_count), 1, '…and the count does not move');

    // ================================ 8. THE PACKAGES ALREADY OUT WHEN THE DEFECT WAS LIVE
    /* THE PREVIOUS HALF of previous-AND-future, and the owner asked for it by name: *"please
       check it out from the previous file or two. Why didn't the borrower receive it?"* The fix
       above only reaches the NEXT package sent — an envelope already at DocuSign has a borrower
       who received nothing and whom nothing re-drives, because the send has happened and the
       webhook transition that would have recovered them came and went. */
    console.log('\n8. a package sent while the defect was live gets its invitation now');
    const recovery = require(REPO + '/src/lib/esign/invite-recovery');
    const app8 = (await db.query(
      `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount)
       VALUES($1,$2,'approved',$3,'{"oneLine":"8 Waiting St, Town, NY 11111"}',500000) RETURNING id`,
      [bor, lo, `YSR${TAG.toUpperCase()}`])).rows[0].id;
    ids.apps.push(app8);
    const stranded = async (purpose, createdAt) => {
      const e = (await db.query(
        `INSERT INTO esign_envelopes(application_id, provider, envelope_id, status, purpose, embedded, created_at)
         VALUES($1,'docusign',$2,'sent',$3,true,$4) RETURNING *`,
        [app8, `ds-${TAG}-r-${purpose}`, purpose, createdAt])).rows[0];
      ids.envelopes.push(e.id);
      return e;
    };
    const invitedOn = async (envId, rid) => (await db.query(
      `SELECT invited_at FROM esign_recipients WHERE envelope_row_id=$1 AND recipient_id_ds=$2`,
      [envId, String(rid)])).rows[0].invited_at;

    /* SENT AFTER THE REGRESSION — the borrower is owed an email. */
    const after = await stranded('term_sheet_package', '2026-08-23T12:00:00Z');
    await recipient(after.id, { role: 'borrower', rid: 21, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
    /* SENT BEFORE IT — that borrower ALREADY received the invitation, because until 4d34752
       notifyReadyToSign had no recipient-level turn test at all and invited everybody at send
       time. Re-inviting them would be an unrequested nudge on a months-old package, which is
       what the date cutoff exists to prevent. */
    const before = await stranded('heter_iska', '2026-08-20T12:00:00Z');
    await recipient(before.id, { role: 'borrower', rid: 22, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
    /* AND A COUNTER-SIGNER WHOSE TURN HAS NOT COME is legitimately uninvited — this pass must
       not select their envelope over and over doing nothing, or it would never drain. */
    const waiting = await stranded('draw_request', '2026-08-23T12:00:00Z');
    await recipient(waiting.id, { role: 'borrower', rid: 23, borrowerId: bor, name: 'Grace Hopper',
      email: `bor.${TAG}@example.com`, status: 'sent' });
    await db.query(`UPDATE esign_recipients SET invited_at = now(), invite_count = 1
                     WHERE envelope_row_id=$1 AND recipient_id_ds='23'`, [waiting.id]);
    await recipient(waiting.id, { role: 'admin', rid: 24, order: 2, counter: true, name: 'Moshe Officer',
      email: `lo.${TAG}@example.com` });

    /* WHICH PACKAGES THE PASS PICKS UP is asserted on the SELECTOR ITSELF, not by watching what
       a run happened to email. The sweep is global and bounded, so another suite's fixtures
       share the batch and any count — or any "did this one get reached" — would be flaky; and
       the turn term below is a DRAINING property, invisible end-to-end because notifyReadyToSign
       enforces the same rule again downstream. Asking the query is what makes both exact. */
    const picked = async () => new Set((await db.query(
      recovery._internals.CANDIDATES, [recovery._internals.REGRESSION_AT, 100000])).rows.map((r) => r.id));
    /* AND A DEAD DEAL IS NOT OWED ONE. An envelope is normally voided or cleared along with its
       file, but not always — and "please sign your term sheet" landing on a loan that was
       withdrawn is worse than the silence it replaces. */
    const dead = (await db.query(
      `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount)
       VALUES($1,$2,'withdrawn',$3,'{"oneLine":"9 Gone St, Town, NY 11111"}',500000) RETURNING id`,
      [bor, lo, `YSD${TAG.toUpperCase()}`])).rows[0].id;
    ids.apps.push(dead);
    const deadEnv = (await db.query(
      `INSERT INTO esign_envelopes(application_id, provider, envelope_id, status, purpose, embedded, created_at)
       VALUES($1,'docusign',$2,'sent','term_sheet_package',true,'2026-08-23T12:00:00Z') RETURNING *`,
      [dead, `ds-${TAG}-dead`])).rows[0];
    ids.envelopes.push(deadEnv.id);
    await recipient(deadEnv.id, { role: 'borrower', rid: 26, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });

    const set0 = await picked();
    ok(set0.has(after.id), 'a package sent while the defect was live is picked up');
    ok(!set0.has(deadEnv.id), 'a package on a withdrawn file is not — a dead deal is owed nothing');
    ok(!set0.has(before.id),
      'a package sent BEFORE it is not — that borrower already had their email, and a nudge on a '
      + 'months-old package is not what went wrong');
    ok(!set0.has(waiting.id),
      'and an envelope whose only uninvited signer is a counter-signer out of turn is not picked '
      + 'up at all — otherwise the pass would re-select it every boot and never drain');

    outbox.length = 0;
    await recovery.recoverUninvitedOnce({ db, limit: 500 });
    /* ASSERTED ON THE ROWS, never on the pass's own totals, for the same reason. */
    ok(!!(await invitedOn(after.id, 21)), 'the stranded borrower is finally invited');
    ok(outbox.some((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`)),
      '…with a real email on the wire, not just a stamp');
    eq(await invitedOn(before.id, 22), null, '…and the older package is left alone');
    eq(await invitedOn(waiting.id, 24), null,
      'a counter-signer whose turn has not come is still not invited early');

    /* SELF-DRAINING: the stamp removes them from the set, so a second pass is a no-op. */
    outbox.length = 0;
    const firstAt = await invitedOn(after.id, 21);
    await recovery.recoverUninvitedOnce({ db, limit: 500 });
    eq(String(await invitedOn(after.id, 21)), String(firstAt), 'a second pass does not re-invite them');
    eq(outbox.filter((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`)).length, 0,
      '…and sends nothing the second time');

    /* ONE INSTANCE AT A TIME. Two servers booting together — an ordinary deploy on a scaled-out
       service — would otherwise both select the same package and both email its borrower, because
       there is a real window between the select and the `invited_at` stamp. A second pass DROPS
       rather than queueing behind the first: by the time it got its turn the set would already be
       drained, so waiting only risks re-running it. */
    const holder = await db.getClient();
    await holder.query(`SELECT pg_advisory_lock(hashtextextended('esign-invite-recovery', 0))`);
    const contended = await recovery.recoverUninvitedOnce({ db, limit: 500 });
    eq(contended.reason, 'already_running', 'a second instance stands down instead of re-sending');
    await holder.query(`SELECT pg_advisory_unlock(hashtextextended('esign-invite-recovery', 0))`);
    holder.release();
    /* THE CONTROL: released, the very same call runs — so the stand-down was the lock. */
    eq((await recovery.recoverUninvitedOnce({ db, limit: 500 })).reason, null,
      '…and once the first has finished, the next pass runs normally');

    /* THE OFF SWITCH, and it is checked before anything is read. */
    const strandedToo = await stranded('noo_affidavit', '2026-08-23T12:00:00Z');
    await recipient(strandedToo.id, { role: 'borrower', rid: 25, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
    process.env.ESIGN_INVITE_RECOVERY_DISABLED = '1';
    outbox.length = 0;
    eq((await recovery.recoverUninvitedOnce({ db, limit: 500 })).reason, 'disabled', 'the off switch stops the pass');
    delete process.env.ESIGN_INVITE_RECOVERY_DISABLED;
    eq(await invitedOn(strandedToo.id, 25), null, '…and nobody was invited while it was off');
    /* THE CONTROL: switched back on, that same package IS recovered — so the silence above was
       the switch and not some other rule quietly excluding it. */
    await recovery.recoverUninvitedOnce({ db, limit: 500 });
    ok(!!(await invitedOn(strandedToo.id, 25)), '…and switching it back on recovers that same package');

  } finally {
    mailer.sendMail = realSend;
    try { await require(REPO + '/src/lib/notify').drainEmails(); } catch (_) {}
    for (const e of ids.envelopes) {
      await db.query(`DELETE FROM esign_envelope_docs WHERE envelope_row_id=$1`, [e]).catch(() => {});
      await db.query(`DELETE FROM esign_recipients WHERE envelope_row_id=$1`, [e]).catch(() => {});
      await db.query(`DELETE FROM esign_envelopes WHERE id=$1`, [e]).catch(() => {});
    }
    for (const d of ids.docs) await db.query(`DELETE FROM documents WHERE id=$1`, [d]).catch(() => {});
    for (const a of ids.apps) {
      await db.query(`DELETE FROM notifications WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [a]).catch(() => {});
    }
    for (const b of ids.borrowers) await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]).catch(() => {});
    for (const s of ids.staff) await db.query(`DELETE FROM staff_users WHERE id=$1`, [s]).catch(() => {});
  }

  console.log(fail ? `\ntest-esign-one-invitation-db: ${pass} passed, ${fail} FAILED`
    : `\ntest-esign-one-invitation-db: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-esign-one-invitation-db threw:', e); process.exit(1); });
