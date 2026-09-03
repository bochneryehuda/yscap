'use strict';
/**
 * RTL TITLE / INSURANCE ORDERS FOLLOW THEIR CONDITION — AT THE DOOR (owner-directed
 * 2026-09-03: *"if the provider accidentally replies in a new email chain, we
 * can't see that response under the original Order section … If the documents
 * are being uploaded to the condition and the condition is being signed off,
 * then update the status of the order that it's done. Don't say 'hey, orders
 * past due'."*).
 *
 * `retireSatisfiedOrdersOnce` already did this on the half-hourly digest tick.
 * These are the same rule at the moment it happens, through the real functions
 * the sign-off route and the upload hook call:
 *   A. a document on rtl_cond_title → the title order reads 'documents_in'
 *      (and the overdue ladder no longer has a thread-less "outstanding" order)
 *   B. the condition signed off → 'completed', completed_at, a 'completed'
 *      timeline line saying via:'condition'
 *   C. undoing the sign-off reopens ONLY an order the condition finished
 *   D. an unrelated condition never moves an order
 *
 * Requires DATABASE_URL with migrations applied; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-order-condition-sync-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const ot = require('../src/lib/order-tracking');
const { CONDITION_CODE } = require('../src/lib/order-slots');

let failures = 0; let n = 0;
const assert = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const sfx = `${process.pid}-${Date.now()}`;
  let borrowerId; let staffId;
  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Order Sync Processor','processor',true) RETURNING id`,
      [`ocs-${sfx}@test.local`])).rows[0].id;
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Order','Sync',$1) RETURNING id`, [`ocs-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, program) VALUES ($1,'processing','Fix & Flip With Construction') RETURNING id`,
      [borrowerId])).rows[0].id;
    const mkItem = async (code) => {
      const t = (await db.query(`SELECT id, label, item_kind FROM checklist_templates WHERE code=$1`, [code])).rows[0];
      return (await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
         VALUES ($1,'application',$2,$3,'outstanding',$4,true) RETURNING id`, [t.id, appId, t.label, t.item_kind])).rows[0].id;
    };
    const titleItem = await mkItem(CONDITION_CODE.title);
    const idItem = await mkItem('rtl_p1_id');
    const orderId = (await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, ordered_at) VALUES ($1,'title','ordered',now()) RETURNING id`, [appId])).rows[0].id;
    const orderRow = async () => (await db.query(`SELECT status, completed_at FROM file_orders WHERE id=$1`, [orderId])).rows[0];
    const events = async (kind) => (await db.query(
      `SELECT detail FROM file_order_events WHERE order_id=$1 AND kind=$2 ORDER BY created_at DESC`, [orderId, kind])).rows;

    console.log('\nA. a document on the title condition — whichever email chain it came back on');
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind)
       VALUES ($1,$2,$3,'commitment.pdf','application/pdf',10,'local',$4,'staff','title_commitment')`, [appId, titleItem, borrowerId, `test/${sfx}/c.pdf`]);
    assert(await ot.documentsInFromCondition(titleItem, { actorId: staffId }) === true, 'the upload hook moves the order');
    assert((await orderRow()).status === 'documents_in', 'the title order reads "documents in"');
    assert((await events('documents_in')).some((e) => e.detail && e.detail.via === 'condition'), '…with a timeline line saying the condition brought it');
    assert(await ot.documentsInFromCondition(titleItem, {}) === false, 'a second document changes nothing (already documents_in)');

    console.log('\nB. the condition signed off');
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [titleItem, staffId]);
    assert(await ot.completeFromCondition(titleItem, { actorId: staffId }) === true, 'the sign-off door finishes the order');
    let o = await orderRow();
    assert(o.status === 'completed' && !!o.completed_at, 'the order is completed with a finish date');
    const done = await events('completed');
    assert(done.length === 1 && done[0].detail && done[0].detail.via === 'condition', 'the timeline says the condition finished it');
    assert(await ot.completeFromCondition(titleItem, {}) === false, 'finishing twice is a no-op');

    console.log('\nC. undoing the sign-off');
    assert(await ot.reopenFromCondition(titleItem, { actorId: staffId }) === true, 'reopens the order the condition finished');
    o = await orderRow();
    assert(o.status !== 'completed' && o.completed_at == null, `the order is back on the desk (${o.status})`);
    // A person finishes it by hand → the condition's undo leaves it alone.
    await ot.completeOrder(appId, 'title', { actorId: staffId, reason: 'by hand' });
    assert(await ot.reopenFromCondition(titleItem, { actorId: staffId }) === false && (await orderRow()).status === 'completed',
      'an order a PERSON marked finished is not reopened by the condition');

    console.log('\nD. an unrelated condition');
    await db.query(`UPDATE file_orders SET status='ordered', completed_at=NULL WHERE id=$1`, [orderId]);
    assert(await ot.documentsInFromCondition(idItem, {}) === false && await ot.completeFromCondition(idItem, {}) === false,
      'the photo-ID condition never touches the title order');
    assert((await orderRow()).status === 'ordered', '…which still reads "ordered"');
    assert(await ot.completeFromCondition('00000000-0000-0000-0000-000000000000', {}) === false, 'an unknown condition id answers false, never throws');

    console.log(failures ? `\n${failures} of ${n} assertion(s) failed` : `\nALL ${n} order-condition-sync assertions passed`);
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
