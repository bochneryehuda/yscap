#!/usr/bin/env node
'use strict';
/**
 * LT — THE VERIFICATION OF RENT'S DOORS AGREE WITH EACH OTHER, against a REAL
 * Postgres with the mailer and DocuSign stubbed and INSPECTED.
 *
 * The 2026-09-02 audit of the orders desk found five ways the rent verification
 * could tell two stories about one file, and each is a door here:
 *
 *   A. (B1) THE LETTER NEVER LEAVES WITHOUT THE FORM. The orders desk and the
 *      condition card both placed the `vor` order with `{note}` alone, so the
 *      landlord got a letter reading "complete the short verification attached"
 *      over an empty attachment list. `orders.place` now refuses a rent order with
 *      no attachment; the rent desk, which draws the form, is the one door through.
 *   B. (S11) THE LAST LINE OF THE LETTER IS TRUE OF THE SEND. An email-only send
 *      promised "signed electronically from the link in this email" — there is no
 *      link. The closing is keyed by method.
 *   C. (S6) A MANUAL RETURN IS NOT A DEAD END. The order row stayed 'ordered'
 *      after a form came back another way, so the next email send was refused as
 *      "already ordered" with no way through. The return now stands the order
 *      down, with the person's note as the reason, on the thread — and a later
 *      send is a fresh order through the ordinary door.
 *   D. (S1) A DOCUSIGN-ONLY SEND IS AN ORDER. Only `place` ever wrote the order
 *      row and moved `lt_vor_sent`; an envelope alone left the condition
 *      outstanding and the desk at "Not ordered" while the landlord had the form.
 *   E. (S2) THE SIGNED FORM REACHES THE HOUSING-HISTORY CONDITION. A completed
 *      envelope was a return row with a filename and no document.
 *
 * PROVEN TO FAIL, each with a green control either side:
 *   · the `vor_form_required` guard removed from `orders.place` → A red (the
 *     letter reaches the mailer with no attachment);
 *   · `closing` no longer passed through `sendAttachment` → B red;
 *   · the stand-down removed from `recordManualReturn` → C red (409 on re-send);
 *   · `recordExternalSend` no longer called after the envelope → D red;
 *   · `fileSignedDocument` no longer called on completion → E red.
 *
 * DB-GATED.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.STORAGE_DIR = process.env.STORAGE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-vor-doors-'));

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

/* DOCUSIGN IS STUBBED AND INSPECTED — a real envelope must never be created by a
   test, and the assertions below read what was asked of the client. */
let dsOn = false;
let envelopes = 0;
const dsCalls = { createEnvelope: 0, getCombinedDocument: 0, voidEnvelope: 0 };
const dsPath = require.resolve('../src/lib/integrations/docusign');
require.cache[dsPath] = {
  id: dsPath, filename: dsPath, loaded: true,
  exports: {
    configured: () => dsOn,
    buildEnvelopeDefinition: (def) => ({ stub: true, subject: def.subject, signers: def.signers }),
    createEnvelope: async () => { dsCalls.createEnvelope += 1; envelopes += 1; return { envelopeId: `ENV-DOORS-${envelopes}`, status: 'sent' }; },
    getCombinedDocument: async (id) => { dsCalls.getCombinedDocument += 1; return Buffer.from(`%PDF-1.4 signed ${id}`); },
    voidEnvelope: async () => { dsCalls.voidEnvelope += 1; return { ok: true }; },
    getEnvelope: async () => ({ status: 'completed' }),
    parseRecipients: () => [],
  },
};

/* THE MAILER IS STUBBED AND INSPECTED, not switched off. */
const email = require('../src/lib/email');
const sent = [];
email.sendMail = async (payload) => { sent.push(payload); return { id: `stub-${sent.length}`, ok: true }; };

(async () => {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-vor-doors');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/longterm/db');
  const desk = require('../src/longterm/vor/desk');
  const orders = require('../src/longterm/orders/desk');
  const F = require('../src/longterm/vor/fields');
  const lib = require('../src/longterm/conditions-center/library');
  const engine = require('../src/longterm/conditions-center/engine');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const stamp = `${process.pid}-${Date.now()}`;
  const loanId = crypto.randomUUID();
  let failed = false;
  try {
    /* ── the file: a renting borrower, a landlord with an email, the form filled
          in and confirmed, the conditions the engine attaches ──────────────── */
    const staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'VOR Doors Officer','loan_officer',true) RETURNING id`, [`vor-doors-${stamp}@example.test`])).rows[0].id;
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Vor','Doors',$1) RETURNING id`,
      [`vor-doors-b-${stamp}@example.test`])).rows[0].id;
    await db.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, borrower_name, program_name, loan_officer_id, loan_amount)
       VALUES ($1::uuid,$2::uuid,$3,'Vor Doors','DSCR 30yr',$4::uuid,400000)`, [loanId, borrowerId, `VORD-${stamp}`, staffId]);
    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
       VALUES ($1::uuid,'7 Rent Way','Anytown','NJ','07001',1,'SFR')`, [loanId]);
    const pair = (await db.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
      [crypto.randomUUID(), loanId])).rows[0].id;
    const party = (await db.query(
      `INSERT INTO lt_parties (id, pair_id, role, party_type, borrower_id, first_name, last_name)
       VALUES ($1::uuid,$2::uuid,'borrower','individual',$3::uuid,'Vor','Doors') RETURNING id`,
      [crypto.randomUUID(), pair, borrowerId])).rows[0].id;
    await db.query(
      `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip, duration_months, monthly_rent)
       VALUES ($1::uuid,$2::uuid,'current','rent','12 Oak Street','Lakewood','NJ','08701',24,2100)`,
      [crypto.randomUUID(), party]);
    const landlordEmail = `landlord-${stamp}@example.test`;
    const card = (await db.query(
      `INSERT INTO service_contacts (contact_type, company_name, contact_name, email)
       VALUES ('other',$1,'Rivka Stein',$2) RETURNING id`, [`Rent Management ${stamp}`, landlordEmail])).rows[0].id;
    await db.query(
      `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary)
       VALUES ($1::uuid,'landlord',$2::uuid,true)`, [loanId, card]);

    const evaluated = await engine.evaluateLoan(loanId, { db });
    const codes = (await db.query(
      `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid`, [loanId])).rows.map((r) => r.code);
    ok(codes.includes('lt_vor_sent') && codes.includes('lt_housing_history'),
      'FIXTURE: the engine put the rent order and the housing-history condition on the file',
      `codes=${codes.join(',')} evaluated=${JSON.stringify(evaluated).slice(0, 200)}`);

    const answers = {};
    for (const f of F.FIELDS) if (f.who === 'us' && !f.optional) answers[f.key] = `answer for ${f.key}`;
    await desk.saveForm(loanId, answers, staffId, db);
    const confirmed = await desk.confirmForm(loanId, staffId, db);
    ok(confirmed.ok === true, 'FIXTURE: the form is confirmed', JSON.stringify(confirmed));

    const condStatus = async (code) => (await db.query(
      `SELECT ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid AND t.code = $2`, [loanId, code])).rows.map((r) => r.status)[0] || null;
    const orderRow = async () => (await db.query(
      `SELECT id, status, cancel_reason FROM lt_file_orders WHERE loan_id = $1::uuid AND kind = 'vor'`, [loanId])).rows[0] || null;
    const events = async () => (await db.query(
      `SELECT direction, msg_type, status, body_text, attachments FROM lt_order_events
        WHERE loan_id = $1::uuid ORDER BY occurred_at ASC, id ASC`, [loanId])).rows;
    const lastMail = () => sent[sent.length - 1] || {};
    const mailText = (m) => `${m.text || ''}\n${m.html || ''}`;

    // ── A. THE LETTER NEVER LEAVES WITHOUT THE FORM (B1) ─────────────────────
    console.log('\nA. THE RENT ORDER REFUSES TO GO OUT WITHOUT THE FORM');
    {
      ok((await condStatus('lt_vor_sent')) === 'outstanding', 'CONTROL: the rent order condition starts outstanding');
      const before = sent.length;
      const r = await orders.place(loanId, 'vor', { staffId, note: 'from the desk' });
      ok(r && r.ok === false && r.status === 422 && r.reason === 'vor_form_required',
        'THE ONE THAT MATTERS: the desk refuses a rent order that carries no form',
        JSON.stringify(r).slice(0, 200));
      ok(/form/i.test((r && r.error) || '') && /Verification of rent/i.test((r && r.error) || ''),
        '…in words that say where to send it from', String(r && r.error));
      ok(sent.length === before, '…and NOTHING reached the mailer — asserted on the mailer, not on the status');
      ok((await orderRow()) === null, '…and no order row was written');
      ok((await condStatus('lt_vor_sent')) === 'outstanding', '…and the condition did not move');
      // The same refusal through an empty array, which is what a screen sending `attachments: []` would carry.
      const r2 = await orders.place(loanId, 'vor', { staffId, attachments: [] });
      ok(r2 && r2.ok === false && r2.reason === 'vor_form_required', 'an empty attachment list is refused the same way');
      ok(sent.length === before, '…with nothing sent');
    }

    // ── B. THE RENT DESK SENDS IT, WITH THE FORM, AND THE LAST LINE IS TRUE (S11)
    console.log('\nB. SENT AS AN EMAIL ATTACHMENT: the form rides, and the closing has no e-signature link in it');
    {
      const before = sent.length;
      const r = await desk.send(loanId, { method: 'email', staffId, db });
      ok(r && r.ok === true && r.email && r.email.ok === true,
        'the rent desk sends it by email', JSON.stringify(r).slice(0, 240));
      ok(sent.length === before + 1, '…exactly one letter');
      const m = lastMail();
      const atts = Array.isArray(m.attachments) ? m.attachments : [];
      ok(atts.length === 1 && atts[0].filename === desk.FILENAME && String(atts[0].content || '').length > 100,
        'THE ONE THAT MATTERS: the letter carries the rendered form', JSON.stringify(atts.map((a) => a.filename)));
      ok([].concat(m.to || []).join(' ').includes(landlordEmail), '…addressed to the landlord on the file');
      const text = mailText(m);
      ok(!/signed electronically from the link in this email/i.test(text),
        'the email-only closing does NOT promise a link in this email', text.slice(-400));
      ok(/replying to this email/i.test(text) && /Part III/i.test(text),
        '…and says what to do instead: fill it in and send it back by reply', text.slice(-400));
      const row = await orderRow();
      ok(row && row.status === 'ordered', 'the order row reads ordered');
      ok((await condStatus('lt_vor_sent')) === 'received', 'and the rent order condition moved to asked-for');
    }

    // ── C. A MANUAL RETURN STANDS THE ORDER DOWN, AND A RE-SEND GOES (S6) ────
    console.log('\nC. THE FORM CAME BACK ANOTHER WAY — the order stands down with the note, and a later send is not a dead end');
    {
      const before = sent.length;
      const note = 'The landlord emailed it back signed.';
      const r = await desk.recordManualReturn(loanId, { note, staffId }, db);
      ok(r && r.ok === true, 'the manual return is recorded', JSON.stringify(r));
      const row = await orderRow();
      ok(row && row.status === 'cancelled', 'THE ONE THAT MATTERS: the rent order is stood down', JSON.stringify(row));
      ok(row && /emailed it back signed/.test(row.cancel_reason || ''),
        '…with the person\'s own note as the reason', String(row && row.cancel_reason));
      ok(r && r.orderStoodDown && String(r.orderStoodDown) === String(row.id), '…and the return says which order it stood down');
      const evs = await events();
      const ret = evs.find((e) => e.direction === 'inbound' && e.msg_type === 'return');
      ok(!!ret && /emailed it back signed/.test(ret.body_text || ''),
        'the return is on the thread, beside the letter that asked for it', JSON.stringify(evs.map((e) => `${e.direction}/${e.msg_type}`)));

      const again = await desk.send(loanId, { method: 'email', staffId, db });
      ok(again && again.ok === true && again.email && again.email.ok === true,
        'THE OTHER HALF: sending again after the return GOES — no "already been ordered" dead end',
        JSON.stringify(again).slice(0, 240));
      ok(sent.length === before + 1, '…and one letter went');
      ok((await orderRow()).status === 'ordered', '…as a fresh order');
      // A completed order is a person's, and the stand-down must not touch it.
      await db.query(`UPDATE lt_file_orders SET status = 'completed' WHERE loan_id = $1::uuid AND kind = 'vor'`, [loanId]);
      await desk.recordManualReturn(loanId, { note: 'A second copy arrived by fax.', staffId }, db);
      ok((await orderRow()).status === 'completed', 'a return never stands down an order somebody already completed');
      await db.query(`UPDATE lt_file_orders SET status = 'ordered' WHERE loan_id = $1::uuid AND kind = 'vor'`, [loanId]);
    }

    // ── D. A DOCUSIGN-ONLY SEND IS AN ORDER (S1) ─────────────────────────────
    console.log('\nD. SENT ON DOCUSIGN ALONE — the order row, the thread and the condition all say so');
    {
      dsOn = true;
      // Stage the two surfaces at "nothing sent", so what moves them is the envelope.
      await db.query(`UPDATE lt_file_orders SET status = 'cancelled', cancel_reason = 'staged' WHERE loan_id = $1::uuid AND kind = 'vor'`, [loanId]);
      await db.query(
        `UPDATE checklist_items ci SET status = 'outstanding' FROM checklist_templates t
          WHERE t.id = ci.template_id AND t.code = 'lt_vor_sent' AND ci.lt_loan_id = $1::uuid`, [loanId]);
      ok((await condStatus('lt_vor_sent')) === 'outstanding' && (await orderRow()).status === 'cancelled',
        'CONTROL: the condition is outstanding and the order stood down before the envelope goes');
      const before = sent.length;
      const evBefore = (await events()).length;
      const r = await desk.send(loanId, { method: 'docusign', staffId, db });
      ok(r && r.ok === true && r.docusign && r.docusign.ok === true && dsCalls.createEnvelope === 1,
        'the envelope goes out', JSON.stringify(r).slice(0, 240));
      ok(sent.length === before, '…and no email went — DocuSign alone');
      ok(r && r.recorded && r.recorded.ok === true, '…and the send says it was recorded on the order', JSON.stringify(r && r.recorded));
      const row = await orderRow();
      ok(row && row.status === 'ordered', 'THE ONE THAT MATTERS: the orders desk reads the rent order as ORDERED');
      ok((await condStatus('lt_vor_sent')) === 'received', '…and lt_vor_sent moved to asked-for — both surfaces agree');
      const evs = await events();
      const env = evs.slice(evBefore).find((e) => e.direction === 'outbound' && e.msg_type === 'order');
      const att = env && Array.isArray(env.attachments) ? env.attachments[0] : null;
      ok(!!env && att && att.channel === 'docusign' && att.externalRef === r.docusign.envelopeId,
        '…and the thread carries the envelope as an order event, naming the channel and the envelope',
        JSON.stringify(env && env.attachments));
      ok(!!env && /DocuSign/.test(env.body_text || '') && /ENV-DOORS-1/.test(env.body_text || ''),
        '…in words a person reads on the thread', String(env && env.body_text));
    }

    // ── E. THE SIGNED FORM REACHES THE HOUSING-HISTORY CONDITION (S2) ────────
    console.log('\nE. THE LANDLORD SIGNS — the signed form is downloaded and filed on housing history');
    {
      const hh = (await db.query(
        `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
          WHERE ci.lt_loan_id = $1::uuid AND t.code = 'lt_housing_history'`, [loanId])).rows[0];
      ok(!!hh, 'CONTROL: the housing-history condition is on the file');
      const docsBefore = (await db.query(`SELECT count(*)::int AS n FROM documents WHERE lt_loan_id = $1::uuid`, [loanId])).rows[0].n;
      const applied = await desk.applyEnvelopeStatus('ENV-DOORS-1', 'completed', { answers: { ll_rent_amount: '2100' }, db });
      ok(applied && applied.ok === true && applied.recorded === true, 'the completion is applied', JSON.stringify(applied).slice(0, 240));
      ok(dsCalls.getCombinedDocument === 1, 'THE ONE THAT MATTERS: the completed envelope\'s document was fetched from the shared client');
      ok(applied && applied.document && applied.document.ok === true && applied.document.slot === 'vor',
        '…and the send reports it filed, in the rent slot', JSON.stringify(applied && applied.document));
      const docs = (await db.query(
        `SELECT filename, slot_label, checklist_item_id, review_status, visibility, storage_ref
           FROM documents WHERE lt_loan_id = $1::uuid ORDER BY created_at DESC`, [loanId])).rows;
      const signed = docs.find((d) => d.filename === desk.SIGNED_FILENAME);
      ok(docs.length === docsBefore + 1 && !!signed, 'one document row was written for the signed form');
      ok(!!signed && String(signed.checklist_item_id) === String(hh.id), '…on the housing-history condition');
      ok(!!signed && signed.slot_label === 'vor', '…in the "vor" slot');
      ok(!!signed && signed.review_status === 'pending' && signed.visibility === 'staff_only',
        '…pending review and staff-only, the same shape as every returned vendor document');
      const ret = (await db.query(
        `SELECT storage_ref, filename FROM lt_vor_returns WHERE loan_id = $1::uuid AND source = 'docusign'`, [loanId])).rows;
      ok(ret.length === 1 && !!ret[0].storage_ref && ret[0].storage_ref === signed.storage_ref,
        '…and the return row points at the same stored document', JSON.stringify(ret));

      // Connect redelivers freely: the same completion again fetches nothing and files nothing twice.
      const again = await desk.applyEnvelopeStatus('ENV-DOORS-1', 'completed', { answers: {}, db });
      ok(again && again.recorded === true && again.document && again.document.already === true,
        'a redelivery is answered and says the document is already there', JSON.stringify(again && again.document));
      ok(dsCalls.getCombinedDocument === 1, '…without a second download');
      const docsAfter = (await db.query(`SELECT count(*)::int AS n FROM documents WHERE lt_loan_id = $1::uuid`, [loanId])).rows[0].n;
      ok(docsAfter === docsBefore + 1, '…and without a second document row');
    }

    // ── F. "BOTH": the closing points at the separate DocuSign email (S11) ───
    console.log('\nF. SENT BOTH WAYS — the letter says the DocuSign copy comes separately');
    {
      // ENV-DOORS-1 is completed (not live), so nothing blocks; the order row is
      // 'ordered' from D, so this is a deliberate re-send.
      const before = sent.length;
      const r = await desk.send(loanId, { method: 'both', staffId, db, force: true });
      ok(r && r.ok === true && r.docusign && r.docusign.ok && r.email && r.email.ok,
        'both halves go', JSON.stringify(r).slice(0, 240));
      ok(sent.length === before + 1 && dsCalls.createEnvelope === 2, '…one letter and one envelope');
      const text = mailText(lastMail());
      ok(/separate DocuSign email/i.test(text) && !/link in this email/i.test(text),
        'the "both" closing points at the separate DocuSign email, never at a link in this one', text.slice(-500));
      ok(r && r.recorded && r.recorded.ok === true, '…and the envelope is recorded on the order beside the letter');
      const evs = await events();
      ok(evs.filter((e) => e.direction === 'outbound' && e.msg_type === 'order').length >= 4,
        'the thread carries every send', JSON.stringify(evs.map((e) => `${e.direction}/${e.msg_type}`)));
    }

    if (fails.length) failed = true;
  } catch (e) {
    failed = true;
    console.error('  ✗ threw: ' + ((e && e.stack) || e));
  } finally {
    try { await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [loanId]); } catch (_) { /* best effort */ }
    try { await db.pool.end(); } catch (_) { /* already gone */ }
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (failed || fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
  process.exit(0);
})();
