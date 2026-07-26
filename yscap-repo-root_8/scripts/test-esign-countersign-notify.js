'use strict';
/**
 * test-esign-countersign-notify.js — the "borrower signed → awaiting the lender's
 * counter-signature" milestone notification (task #41). DocuSign keeps a counter-
 * signed envelope 'sent' from the moment the borrower finishes until the admin counter-
 * signs, so the file's loan officer + processor previously never learned the deal was
 * now waiting on THEM. reconcileEnvelope now fires that alert exactly once.
 *
 * Run: DATABASE_URL=... PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres node scripts/test-esign-countersign-notify.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-countersign';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const webhook = require(REPO + '/src/lib/esign/webhook');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// Fake DocuSign — envelope still 'sent'; borrower (recip 1) completed, admin (recip 2) pending.
const fakeDs = (adminSigned = false) => ({
  parseRecipients: (env) => require(REPO + '/src/lib/integrations/docusign').parseRecipients(env),
  async getEnvelope() {
    return {
      status: adminSigned ? 'completed' : 'sent', currentRoutingOrder: adminSigned ? 2 : 1,
      recipients: { signers: [
        { recipientId: '1', routingOrder: '1', name: 'Pat Borrower', email: 'b@example.com',
          status: 'completed', sentDateTime: '2026-07-20T10:00:00Z', signedDateTime: '2026-07-20T10:05:00Z' },
        { recipientId: '2', routingOrder: '2', name: 'YS Capital', email: 'admin@example.com',
          status: adminSigned ? 'completed' : 'sent', sentDateTime: '2026-07-20T10:06:00Z',
          signedDateTime: adminSigned ? '2026-07-20T10:10:00Z' : null },
      ] },
    };
  },
});
const fakeStorage = { async save() { return { ref: 'x', provider: 'local' }; }, async read() { return Buffer.from('x'); } };
const TAG = 'cntr-' + Date.now().toString(36);

async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const loId = crypto.randomUUID();
  const bId = crypto.randomUUID();
  let appId, envRowId;
  const env = (id) => db.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [id]).then((r) => r.rows[0]);
  const noteCount = () => db.query(
    `SELECT count(*)::int n FROM notifications WHERE application_id=$1 AND title ILIKE '%counter-signature needed%'`, [appId]).then((r) => r.rows[0].n);
  try {
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'LO Tester','loan_officer')`, [loId, `lo+${TAG}@ys.com`]);
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Pat','Borrower',$2)`, [bId, `b+${TAG}@example.com`]);
    appId = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, loan_officer_id, property_address, loan_amount)
       VALUES ($1,$2,$3,'{"oneLine":"1 Main St, Town, NY"}',400000) RETURNING id`, [`YSCAP-${TAG}`, bId, loId])).rows[0].id;
    // Ensure the LO is an active assignee (the db/103 trigger mirrors loan_officer_id,
    // but insert explicitly too so the test doesn't depend on trigger timing).
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
       VALUES ($1,$2,'loan_officer',true) ON CONFLICT DO NOTHING`, [appId, loId]).catch(() => {});

    envRowId = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, countersign_required)
       VALUES ($1,'term_sheet_package','sent',$2,true) RETURNING id`, [appId, `ENV-${TAG}`])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds, borrower_id, name, email, status)
       VALUES ($1,'borrower',1,false,'1',$2,'Pat Borrower',$3,'sent'),
              ($1,'admin',2,true,'2',NULL,'YS Capital','admin@example.com','sent')`,
      [envRowId, bId, `b+${TAG}@example.com`]);

    // --- 1. NOT fired before the borrower signs (everyone still just 'sent') -----
    const dsUnsigned = {
      parseRecipients: (e) => require(REPO + '/src/lib/integrations/docusign').parseRecipients(e),
      async getEnvelope() {
        return { status: 'sent', recipients: { signers: [
          { recipientId: '1', routingOrder: '1', status: 'sent', sentDateTime: '2026-07-20T10:00:00Z' },
          { recipientId: '2', routingOrder: '2', status: 'sent', sentDateTime: '2026-07-20T10:00:00Z' },
        ] } };
      },
    };
    await webhook.reconcileEnvelope(db, dsUnsigned, fakeStorage, await env(envRowId));
    ok(!(await env(envRowId)).countersign_notified_at, 'no milestone fired while the borrower has not signed');
    ok((await noteCount()) === 0, 'no "counter-signature needed" notification before the borrower signs');

    // --- 2. borrower signed, admin pending → fire the milestone ONCE -------------
    await webhook.reconcileEnvelope(db, fakeDs(false), fakeStorage, await env(envRowId));
    const stampedAt = (await env(envRowId)).countersign_notified_at;
    ok(stampedAt, 'countersign_notified_at is stamped when the borrower signs + admin is pending');
    ok((await noteCount()) === 1, 'the loan officer got exactly one "counter-signature needed" notification');

    // --- 3. idempotent: another reconcile pass does NOT re-notify ---------------
    await webhook.reconcileEnvelope(db, fakeDs(false), fakeStorage, await env(envRowId));
    const stampedAt2 = (await env(envRowId)).countersign_notified_at;
    ok(String(stampedAt2) === String(stampedAt), 'countersign_notified_at is unchanged on a repeat pass');
    ok((await noteCount()) === 1, 'no duplicate notification on the poller re-reading the envelope');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]).catch(() => {});
    if (appId) await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]).catch(() => {});
    if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [loId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
