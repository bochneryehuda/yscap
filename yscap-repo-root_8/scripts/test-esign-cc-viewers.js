'use strict';
/**
 * test-esign-cc-viewers.js — the file's loan officer + processor (+ assistants) are
 * COPIED as viewers on every envelope (task #42, owner-directed 2026-07-20: "add the
 * loan officer and the processor as viewers for every envelope … so they can see
 * everything happens in real life"). DocuSign CC recipients receive the completed,
 * signed copy + Certificate of Completion and can view the envelope; they never sign.
 *
 * Run: DATABASE_URL=... PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres node scripts/test-esign-cc-viewers.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cc';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const ds = require(REPO + '/src/lib/integrations/docusign');
const orchestrate = require(REPO + '/src/lib/esign/orchestrate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// ---- 1. buildEnvelopeDefinition CC support (no DB) ---------------------------
{
  console.log('\n1. buildEnvelopeDefinition carbon copies');
  const base = { documents: [{ base64: 'x', name: 'D', documentId: 1 }], signers: [{ recipientId: '1', name: 'B', email: 'b@x.com', routingOrder: 1, tabsByDoc: {} }], subject: 's' };
  let d = ds.buildEnvelopeDefinition({ ...base, carbonCopies: [{ recipientId: '2', name: 'LO', email: 'lo@ys.com', routingOrder: 2 }] });
  ok(d.recipients.carbonCopies && d.recipients.carbonCopies.length === 1, 'a valid CC is added to recipients.carbonCopies');
  ok(d.recipients.carbonCopies[0].email === 'lo@ys.com' && d.recipients.carbonCopies[0].recipientId === '2', 'CC carries the email + recipientId');
  ok(!d.recipients.carbonCopies[0].tabs, 'a CC has no signing tabs (viewer only)');
  d = ds.buildEnvelopeDefinition({ ...base, carbonCopies: [{ recipientId: '2', name: 'LO', email: 'not-an-email', routingOrder: 2 }] });
  ok(!d.recipients.carbonCopies, 'an invalid CC email is dropped (never blocks the send)');
  d = ds.buildEnvelopeDefinition(base);
  ok(!d.recipients.carbonCopies, 'no carbonCopies key when there are none');
}

// ---- 2. orchestrate.buildDefinition copies the file's team (DB) --------------
const TAG = 'cc-' + Date.now().toString(36);
async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  console.log('\n2. orchestrate.buildDefinition copies the loan officer + processor');
  const loId = crypto.randomUUID(), prId = crypto.randomUUID(), bId = crypto.randomUUID();
  const cbId = crypto.randomUUID(), dupAdmin = crypto.randomUUID();
  let appId, envRowId;
  try {
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Dana Officer','loan_officer'),($3,$4,'Perry Processor','processor')`,
      [loId, `lo+${TAG}@ys.com`, prId, `pr+${TAG}@ys.com`]);
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Pat','Borrower',$2)`, [bId, `b+${TAG}@example.com`]);
    appId = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, loan_officer_id, processor_id, property_address, loan_amount)
       VALUES ($1,$2,$3,$4,'{"oneLine":"1 Main St, Town, NY"}',400000) RETURNING id`, [`YSCAP-${TAG}`, bId, loId, prId])).rows[0].id;
    // Ensure both are active assignees (belt-and-suspenders alongside the db/103 trigger).
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
       VALUES ($1,$2,'loan_officer',true),($1,$3,'processor',true) ON CONFLICT DO NOTHING`, [appId, loId, prId]).catch(() => {});

    // A heter_iska envelope (single generated doc, no counter-signer, no stored PDFs)
    // — enough to exercise buildDefinition's CC computation without seeding documents.
    envRowId = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required)
       VALUES ($1,'heter_iska','not_sent',false) RETURNING id`, [appId])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,'1',$2,'Pat Borrower',$3,true,$4,'created')`,
      [envRowId, bId, `b+${TAG}@example.com`, `${envRowId}:borrower`]);

    const row = (await db.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [envRowId])).rows[0];
    const def = await orchestrate.buildDefinition(row, { db });
    const ccEmails = (def.carbonCopies || []).map((c) => c.email).sort();
    ok(ccEmails.length === 2, 'both the loan officer AND the processor are copied');
    ok(ccEmails.includes(`lo+${TAG}@ys.com`) && ccEmails.includes(`pr+${TAG}@ys.com`), 'the CC emails are the file team');
    // recipientIds continue after the signer ("1") and never collide with it.
    const ccIds = (def.carbonCopies || []).map((c) => c.recipientId);
    ok(!ccIds.includes('1') && ccIds.every((id) => Number(id) >= 2), 'CC recipientIds are assigned AFTER the signers');
    ok((def.carbonCopies || []).every((c) => Number(c.routingOrder) >= 1), 'CCs get a routing order (receive the completed copy)');
    // The signer is never also CC'd.
    ok(!ccEmails.includes(`b+${TAG}@example.com`), 'the borrower (a signer) is never copied');

    // Collision: if the loan officer IS the borrower's email, they are NOT copied twice.
    await db.query(`UPDATE staff_users SET email=$2 WHERE id=$1`, [loId, `b+${TAG}@example.com`]);
    const def2 = await orchestrate.buildDefinition(row, { db });
    const cc2 = (def2.carbonCopies || []).map((c) => c.email);
    ok(!cc2.includes(`b+${TAG}@example.com`), 'a staffer whose email equals a signer is not copied (dedup vs signers)');
    ok(cc2.includes(`pr+${TAG}@ys.com`), '…the other team member is still copied');

    // Restore the LO email for the next scenario.
    await db.query(`UPDATE staff_users SET email=$2 WHERE id=$1`, [loId, `lo+${TAG}@ys.com`]);

    // ---- 3. term-sheet worst case: 3 signers (borrower 1 + co 2 + admin 3) ------
    // CCs must start at recipientId 4 (no collision) and the staffer whose email
    // equals the ADMIN counter-signer must be deduped out.
    console.log('\n3. term-sheet package: CC ids start after 3 signers + admin-email dedup');
    // buildDefinition uses the SEEDED admin-recipient email (it only re-resolves the
    // borrower/co emails from the file), so a TAG-scoped admin email is faithful and
    // avoids colliding with the DB's real counter-signer staff row.
    const adminEmail = `admin+${TAG}@ys.com`;
    // A staffer whose email == the admin counter-signer (must NOT be double-copied).
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Owner Admin','admin')`, [dupAdmin, adminEmail]);
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Chris','Co',$2)`, [cbId, `co+${TAG}@example.com`]);
    await db.query(`UPDATE applications SET co_borrower_id=$2 WHERE id=$1`, [appId, cbId]);
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
       VALUES ($1,$2,'processor',false) ON CONFLICT DO NOTHING`, [appId, dupAdmin]).catch(() => {});
    // A stored term sheet (the only stored doc; app + disclosure are generated).
    const fakeStorage = { async read() { return Buffer.from('%PDF-1.4 term-sheet'); } };
    await db.query(
      `INSERT INTO documents (application_id, filename, storage_provider, storage_ref, doc_kind, is_current)
       VALUES ($1,'ts.pdf','local','ref-ts','term_sheet',true)`, [appId]);
    const tsRow = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required)
       VALUES ($1,'term_sheet_package','not_sent',true) RETURNING *`, [appId])).rows[0];
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,false,'1',$2,'Pat Borrower',$3,true,$4,'created'),
              ($1,'co_borrower',1,false,'2',$5,'Chris Co',$6,true,$7,'created'),
              ($1,'admin',2,true,'3',NULL,'YS Capital',$8,true,$9,'created')`,
      [tsRow.id, bId, `b+${TAG}@example.com`, `${tsRow.id}:borrower`,
       cbId, `co+${TAG}@example.com`, `${tsRow.id}:co_borrower`, adminEmail, `${tsRow.id}:admin`]);
    const tdef = await orchestrate.buildDefinition(tsRow, { db, storage: fakeStorage });
    const tcc = tdef.carbonCopies || [];
    const tccEmails = tcc.map((c) => c.email);
    ok(tccEmails.includes(`lo+${TAG}@ys.com`), 'the loan officer is copied on the term-sheet envelope');
    ok(!tccEmails.includes(adminEmail), 'a staffer whose email equals the admin counter-signer is NOT copied (dedup)');
    ok(!tccEmails.includes(`b+${TAG}@example.com`) && !tccEmails.includes(`co+${TAG}@example.com`), 'neither signer is copied');
    ok(tcc.every((c) => Number(c.recipientId) >= 4), 'CC recipientIds start at 4 — after borrower(1)+co(2)+admin(3), no collision');
    ok(tcc.length >= 1, 'at least the loan officer is copied');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    if (appId) await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]).catch(() => {});
    if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bId, cbId]]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[loId, prId, dupAdmin]]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
