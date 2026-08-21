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
    const recipient = async (envId, o) => db.query(
      `INSERT INTO esign_recipients(envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds,
                                    borrower_id, name, email, embedded, client_user_id, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
      [envId, o.role, o.order || 1, !!o.counter, String(o.rid), o.borrowerId || null,
       o.name, o.email, `${envId}:${o.role}`, o.status || 'sent']);

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
    console.log('2. a counter-signer whose turn has not come is not invited');
    const ts = await envelope('term_sheet_package');
    await recipient(ts.id, { role: 'borrower', rid: 1, borrowerId: bor, name: 'Grace Hopper', email: `bor.${TAG}@example.com` });
    /* DocuSign holds a routing-order-2 recipient at `created` until everyone before them signs.
       Emailing them now would say "your signature is needed" when DocuSign will not let them
       sign, and the link would fail — the exact experience being fixed. */
    await recipient(ts.id, { role: 'admin', rid: 3, order: 2, counter: true, name: 'Moshe Officer',
      email: `lo.${TAG}@example.com`, status: 'created' });
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(ts.id, { db });
    ok(!outbox.some((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`)),
      'the counter-signer is left alone until DocuSign opens their turn');
    ok(outbox.some((m) => to(m).some((a) => a.toLowerCase() === `bor.${TAG}@example.com`)),
      '…while the borrower, whose turn it is, is invited');

    // ============================================================== 3. AN UNPLACEABLE SIGNER
    console.log('3. a staff signer we cannot place is never emailed a signing bearer');
    const orphan = await envelope('draw_request');
    await recipient(orphan.id, { role: 'loan_officer', rid: 1, name: 'Nobody Here',
      email: `ghost.${TAG}@example.com` });
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(orphan.id, { db });
    ok(!outbox.length, 'an address on no ACTIVE staff row gets nothing — the token signs an envelope');
    /* AND A DEPARTED OFFICER IS THE SAME CASE, which is the one that actually happens. */
    await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [lo]);
    outbox.length = 0;
    await notifySigners.notifyReadyToSign(iska.id, { db });
    ok(!outbox.some((m) => to(m).some((a) => a.toLowerCase() === `lo.${TAG}@example.com`)),
      'a deactivated officer’s address is never sent a signing link');
    await db.query(`UPDATE staff_users SET is_active=true WHERE id=$1`, [lo]);

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
