'use strict';
/**
 * test-borrower-action-items.js — the borrower's cross-file "Action needed" home
 * feed (GET /api/borrower/action-items, #39). One call returns everything the
 * borrower must DO right now — signatures, fixes, documents to provide — across all
 * their ACTIVE files, priority-sorted and borrower-safe. Quiet files (funded/…) and
 * in-review/done items never appear; a capital-partner name is never leaked.
 *
 * Run: DATABASE_URL=... PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres node scripts/test-borrower-action-items.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-action';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const express = require('express');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const auth = require(REPO + '/src/auth');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

const uid = crypto.randomUUID();
const app = express();
app.use(express.json());
app.use('/api/borrower', require(REPO + '/src/routes/borrower'));   // the router enforces requireAuth+requireBorrower itself
let token = '';
const authGet = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

let server, base;
const listen = () => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
const TAG = 'act-' + Date.now().toString(36);

async function ci(appId, audience, status, label, extra = {}) {
  await db.query(
    `INSERT INTO checklist_items (scope, application_id, audience, status, label, borrower_label, borrower_hint, issue_reason, is_required, sort_order)
     VALUES ('application',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [appId, audience, status, label, extra.borrower_label || label, extra.borrower_hint || null, extra.issue_reason || null, extra.is_required !== false, extra.sort_order || 0]);
}

async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  await listen();
  const bId = uid;
  let app1, app2, envRowId;
  try {
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Pat','Borrower',$2)`, [bId, `b+${TAG}@ex.com`]);
    await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, email_verified) VALUES ($1,'x',true)`, [bId]);
    token = await auth.mintBorrowerSession(bId);   // a real borrower session for the Bearer header
    app1 = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, status, property_address, loan_amount)
       VALUES ($1,$2,'processing','{"oneLine":"12 Elm St, Lakewood, NJ"}',400000) RETURNING id`, [`YSCAP-${TAG}-A`, bId])).rows[0].id;
    app2 = (await db.query(   // a FUNDED (quiet) file — its items must NOT nag on the home
      `INSERT INTO applications (ys_loan_number, borrower_id, status, property_address, loan_amount)
       VALUES ($1,$2,'funded','{"oneLine":"9 Oak Ave, Toms River, NJ"}',300000) RETURNING id`, [`YSCAP-${TAG}-B`, bId])).rows[0].id;

    await ci(app1, 'borrower', 'outstanding', 'Bank statement', { borrower_label: 'Upload your bank statement' });   // → document
    await ci(app1, 'borrower', 'issue', 'Photo ID', { borrower_label: 'Re-upload your photo ID', issue_reason: 'the image was blurry' });   // → fix
    await ci(app1, 'both', 'requested', 'Insurance', { borrower_label: 'Provide your insurance binder' });   // → document (requested is actionable)
    await ci(app1, 'borrower', 'received', 'In review', { borrower_label: 'Already uploaded' });   // in review → excluded
    await ci(app1, 'borrower', 'satisfied', 'Done item', { borrower_label: 'All set' });   // done → excluded
    await ci(app1, 'staff', 'outstanding', 'Staff only', { borrower_label: 'Internal task' });   // staff → excluded
    await ci(app1, 'borrower', 'outstanding', 'Partner', { borrower_label: 'Upload the BlueLake statement' });   // partner name → scrubbed
    await ci(app2, 'borrower', 'outstanding', 'Funded item', { borrower_label: 'This should not nag' });   // quiet file → excluded

    // A sent envelope waiting on the borrower's signature (app1).
    envRowId = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, countersign_required)
       VALUES ($1,'heter_iska','sent',$2,false) RETURNING id`, [app1, `ENV-${TAG}`])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, status)
       VALUES ($1,'borrower',1,'1',$2,'Pat Borrower',$3,'sent')`, [envRowId, bId, `b+${TAG}@ex.com`]);
    // A second envelope the borrower already signed → must NOT appear.
    const env2 = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, countersign_required)
       VALUES ($1,'term_sheet_package','sent',$2,true) RETURNING id`, [app1, `ENV2-${TAG}`])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, status, signed_at)
       VALUES ($1,'borrower',1,'1',$2,'Pat Borrower',$3,'completed',now())`, [env2, bId, `b+${TAG}@ex.com`]);

    const r = await authGet('/api/borrower/action-items');
    const d = await r.json();
    ok(r.status === 200 && d && Array.isArray(d.items), 'endpoint returns { items, counts }');
    const items = d.items || [];
    const labels = items.map((i) => i.label);
    const byKind = (k) => items.filter((i) => i.kind === k);

    ok(byKind('sign').length === 1, 'the unsigned envelope shows as ONE signature to do');
    ok(byKind('sign')[0].route.includes('esign'), 'the sign item routes into the file esign view');
    ok(items[0].kind === 'sign', 'signatures sort FIRST (priority 0)');
    ok(byKind('fix').length === 1 && /blurry/i.test(byKind('fix')[0].hint || ''), 'the issue shows as a fix with its borrower-safe reason');
    ok(byKind('document').length === 3, 'the outstanding + requested borrower docs (incl. the scrubbed one) show as documents to provide');

    ok(!labels.some((l) => /already uploaded/i.test(l)), 'a received (in-review) item is NOT shown');
    ok(!labels.some((l) => /all set/i.test(l)), 'a satisfied (done) item is NOT shown');
    ok(!labels.some((l) => /internal task/i.test(l)), 'a staff-only item is NOT shown to the borrower');
    ok(!labels.some((l) => /this should not nag/i.test(l)), 'a FUNDED (quiet) file item does NOT nag on the home');
    ok(!items.some((i) => /BlueLake/i.test(i.label) || /BlueLake/i.test(i.hint || '')), 'a capital-partner name is scrubbed (never borrower-facing)');

    const c = d.counts || {};
    ok(c.toSign === 1 && c.toFix === 1 && c.toProvide === 3 && c.total === 5, 'counts summarize the feed (1 sign, 1 fix, 3 provide)');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    if (envRowId) await db.query(`DELETE FROM esign_envelopes WHERE application_id IN ($1,$2)`, [app1, app2]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id IN ($1,$2)`, [app1, app2]).catch(() => {});
    if (app1) await db.query(`DELETE FROM applications WHERE id IN ($1,$2)`, [app1, app2]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await new Promise((r) => server.close(r));
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
