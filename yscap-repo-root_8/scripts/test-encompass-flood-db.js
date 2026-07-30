'use strict';
/**
 * test-encompass-flood-db.js — the PILOT-side flood-order orchestration, end to
 * end against a REAL database.
 *
 * Proves:
 *  (A) resolveLoanGuid refuses a file with no loan number ('loan_number_required')
 *      — the owner's rule that the loan number is what links the file to Encompass;
 *  (B) a COMPLETED flood order drives `in_flood_zone`, so evaluateApplication
 *      attaches the flood-insurance condition (rtl_cond_flood_insurance) when the
 *      determination is a flood zone, and does NOT when it isn't — from the FLOOD
 *      ORDER alone (no appraisal), and an A/V zone counts even with no SFHA flag;
 *  (C) the flood-insurance condition is staff-only, and it retracts (untouched)
 *      when the determination is later a non-flood-zone;
 *  (D) orderFlood is off by default (the ENCOMPASS_FLOOD_ENABLED switch), and the
 *      DB enforces at most one outstanding order per file.
 * DB-gated: skips without DATABASE_URL.
 */
const assert = require('assert');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) { console.log('SKIP test-encompass-flood-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/conditions/engine');
const desk = require('../src/encompass/flood-desk');

const FI = 'rtl_cond_flood_insurance';
const fiCount = async (appId) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2`, [appId, FI])).rows[0].n;
const fiItem = async (appId) => (await db.query(
  `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2 LIMIT 1`, [appId, FI])).rows[0];

async function completedOrder(appId, { sfha = null, zone = null } = {}) {
  await db.query(
    `INSERT INTO encompass_flood_orders (application_id, encompass_loan_guid, status, sfha, flood_zone, completed_at)
     VALUES ($1,'guid-abcdefgh', 'completed', $2, $3, now())`, [appId, sfha, zone]);
}

(async () => {
  await ensureSchema();
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Flood','Order',$1) RETURNING id`,
      [`fo-${sfx}@test.local`])).rows[0].id;
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type) VALUES ($1,'processing','Fix & Flip') RETURNING id`,
      [borrowerId])).rows[0].id;

    // (A) No loan number → refuse to order (the link key is missing).
    const aNoLoan = await mkApp();
    const res = await desk.resolveLoanGuid(aNoLoan);
    ok(res.error === 'loan_number_required', 'resolveLoanGuid refuses a file with no loan number');
    // The template of the flood-insurance condition exists and is rule-driven.
    const tpl = (await db.query(`SELECT audience, auto_apply, rule_logic FROM checklist_templates WHERE code=$1`, [FI])).rows[0];
    ok(!!tpl && tpl.audience === 'staff' && tpl.auto_apply === 'rules', 'flood-insurance template is staff-only + rule-driven');
    ok(/in_flood_zone/.test(JSON.stringify(tpl.rule_logic)), 'flood-insurance rule keys on in_flood_zone');

    // (B) A completed flood order = an authoritative flood-zone source.
    // (B1) SFHA true → flood-insurance condition attaches.
    const aYes = await mkApp();
    await engine.evaluateApplication(aYes, { reason: 'pre', notify: false });
    ok((await fiCount(aYes)) === 0, 'no flood order → no flood-insurance condition');
    await completedOrder(aYes, { sfha: true });
    await engine.evaluateApplication(aYes, { reason: 'flood_order', notify: false });
    ok((await fiCount(aYes)) === 1, 'flood order SFHA=true → flood-insurance condition attaches');
    ok((await fiItem(aYes)).audience === 'staff', 'flood-insurance condition is INTERNAL (staff-only)');

    // (B2) SFHA false → does NOT attach.
    const aNo = await mkApp();
    await completedOrder(aNo, { sfha: false });
    await engine.evaluateApplication(aNo, { reason: 'flood_order', notify: false });
    ok((await fiCount(aNo)) === 0, 'flood order SFHA=false → no flood-insurance condition');

    // (B3) Zone AE with no explicit SFHA flag → still a flood zone.
    const aZone = await mkApp();
    await completedOrder(aZone, { sfha: null, zone: 'AE' });
    await engine.evaluateApplication(aZone, { reason: 'flood_order', notify: false });
    ok((await fiCount(aZone)) === 1, 'flood order zone AE (no SFHA flag) → flood-insurance attaches');

    // (B4) Zone X → not a flood zone.
    const aX = await mkApp();
    await completedOrder(aX, { sfha: null, zone: 'X' });
    await engine.evaluateApplication(aX, { reason: 'flood_order', notify: false });
    ok((await fiCount(aX)) === 0, 'flood order zone X → no flood-insurance condition');

    // (C) Retracts (untouched) when a NEWER determination is a non-flood-zone.
    await completedOrder(aYes, { sfha: false });   // a newer completed order says NOT a flood zone
    await engine.evaluateApplication(aYes, { reason: 'flood_order', notify: false });
    ok((await fiCount(aYes)) === 0, 'a newer non-flood determination retracts the untouched flood-insurance condition');

    // (D) orderFlood is OFF by default (the master switch), and the DB allows only
    //     one outstanding order per file.
    const aOrd = await mkApp();
    const out = await desk.orderFlood({ appId: aOrd, actorId: null });
    ok(out.ok === false && out.error === 'disabled', 'orderFlood is off until ENCOMPASS_FLOOD_ENABLED is set');
    await db.query(`INSERT INTO encompass_flood_orders (application_id, encompass_loan_guid, status) VALUES ($1,'g','ordered')`, [aOrd]);
    let dup = null;
    try { await db.query(`INSERT INTO encompass_flood_orders (application_id, encompass_loan_guid, status) VALUES ($1,'g','ordered')`, [aOrd]); }
    catch (e) { dup = e; }
    ok(dup && dup.code === '23505', 'the DB refuses a second outstanding order on the same file');

    // (E) completeOrder files the certificate PDF onto the flood condition, records
    //     the determination, sets in_flood_zone (→ flood-insurance), and is idempotent.
    const client = require('../src/encompass/flood-order');
    const origDownload = client.downloadResultFile;
    client.downloadResultFile = async () => Buffer.from('%PDF-1.4\nfake flood cert\n%%EOF');
    try {
      const aPdf = await mkApp();
      // The flood condition (rtl_cond_flood, auto_apply='always') is attached by the engine.
      await engine.evaluateApplication(aPdf, { reason: 'pre', notify: false });
      const floodItemId = (await db.query(
        `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code='rtl_cond_flood' LIMIT 1`, [aPdf])).rows[0].id;
      const orderRow = (await db.query(
        `INSERT INTO encompass_flood_orders (application_id, checklist_item_id, encompass_loan_guid, order_id, status)
         VALUES ($1,$2,'guid-pdf','ORD-PDF-1','ordered') RETURNING *`, [aPdf, floodItemId])).rows[0];
      await desk.completeOrder(orderRow, { status: 'completed', sfha: true, floodZone: 'AE', fileUrl: 'https://api.elliemae.com/x/cert.pdf', determination: { community: 'X' }, raw: {} });

      const doc = (await db.query(
        `SELECT doc_kind, visibility, source_type, checklist_item_id FROM documents
          WHERE application_id=$1 AND doc_kind='flood_determination' AND is_current=true`, [aPdf])).rows;
      ok(doc.length === 1, 'completeOrder files exactly one flood-determination PDF');
      ok(doc[0] && doc[0].visibility === 'staff_only' && doc[0].source_type === 'system' && doc[0].checklist_item_id === floodItemId,
        'the filed PDF is staff-only, source_type=system, on the flood condition');
      const ord2 = (await db.query(`SELECT status, sfha, flood_zone, document_id FROM encompass_flood_orders WHERE id=$1`, [orderRow.id])).rows[0];
      ok(ord2.status === 'completed' && ord2.sfha === true && ord2.flood_zone === 'AE' && ord2.document_id,
        'the order row records completed + the determination + the document');
      const fi = (await db.query(
        `SELECT status FROM checklist_items WHERE id=$1`, [floodItemId])).rows[0];
      ok(fi.status === 'received', 'the flood condition is moved to received');
      ok((await fiCount(aPdf)) === 1, 'completeOrder attaches the flood-insurance condition (in_flood_zone via the order)');

      // Idempotent: a re-run (e.g. the row re-polled) does NOT file a second PDF.
      await desk.completeOrder(orderRow, { status: 'completed', sfha: true, floodZone: 'AE', fileUrl: 'https://api.elliemae.com/x/cert.pdf', determination: { community: 'X' }, raw: {} });
      const docs2 = (await db.query(
        `SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='flood_determination' AND is_current=true`, [aPdf])).rows[0].n;
      ok(docs2 === 1, 're-running completeOrder does not file a duplicate certificate');
    } finally { client.downloadResultFile = origDownload; }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\ntest-encompass-flood-db: ALL PASS');
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('FATAL', e);
    process.exitCode = 1;
  } finally {
    try { await db.pool.end(); } catch (_) { }
  }
})();
