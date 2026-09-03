'use strict';
/**
 * LONG-TERM ORDERS FOLLOW THEIR CONDITIONS (owner-directed 2026-09-03: *"if the
 * provider accidentally replies in a new email chain, we can't see that response
 * under the original Order section … If the documents are being uploaded to the
 * condition and the condition is being signed off, then update the status of
 * the order that it's done. Don't say 'hey, orders past due'."*).
 *
 * Against a real database, through the REAL doors (conditions-center/write.js
 * satisfy / waive / reopen; the sweep) — never by calling the sync module with a
 * hand-built row:
 *   A. a document on the docs condition → the order reads 'documents_in'
 *   B. the condition signed off → 'completed', with completed_at and
 *      meta.completed_via = 'condition'
 *   C. reopen → back to 'documents_in'; a PERSON's completion is left alone
 *   D. a waive completes it too
 *   E. an unrelated condition never moves an order
 *   F. the sweep completes an already-signed-off book without the live door
 *
 * Requires DATABASE_URL with migrations applied (incl. db/693); skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-order-condition-sync-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const crypto = require('crypto');
const db = require('../src/longterm/db');
const write = require('../src/longterm/conditions-center/write');
const sync = require('../src/longterm/orders/condition-sync');

let failures = 0; let n = 0;
const assert = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const uniq = `ltocs-${process.pid}-${Date.now()}`;
  let borrowerId; let staffId;
  try {
    staffId = String((await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'LT Sync Officer','processor',true) RETURNING id`,
      [`${uniq}@example.test`])).rows[0].id);
    borrowerId = String((await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,'Sync',$2) RETURNING id`,
      [uniq, `${uniq}-b@example.test`])).rows[0].id);
    const mkLoan = async (tag) => {
      const id = String((await db.query(
        `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months, program_name, loan_amount, loan_folder, loan_officer_id)
         VALUES ($1::uuid,$2,'Bo Rrower',$3::uuid,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline',$4::uuid) RETURNING id`,
        [crypto.randomUUID(), `${uniq}-${tag}`, borrowerId, staffId])).rows[0].id);
      await db.query(`INSERT INTO lt_properties (loan_id, street, city, state, zip) VALUES ($1::uuid,'12 Test Street','Lakewood','NJ','08701')`, [id]);
      return id;
    };
    const tplId = async (code, kind) => String((await db.query(
      `INSERT INTO checklist_templates (code, scope, label, audience, item_kind, is_active, sort_order, slots)
       VALUES ($1,'lt_loan',$2,'staff',$3,true,100,'[]'::jsonb) ON CONFLICT (code) DO UPDATE SET is_active = true RETURNING id`,
      [code, code, kind])).rows[0].id);
    const mkCondition = async (loanId, code, kind = 'document') => String((await db.query(
      `INSERT INTO checklist_items (scope, lt_loan_id, template_id, category, label, audience, status, item_kind, is_required)
       VALUES ('lt_loan',$1::uuid,$2::uuid,'prior_to_approval',$3,'staff','outstanding',$4,true) RETURNING id`,
      [loanId, await tplId(code, kind), code, kind])).rows[0].id);
    const mkOrder = async (loanId, kind, status, conditionId = null) => String((await db.query(
      `INSERT INTO lt_file_orders (loan_id, kind, status, ordered_at, condition_id) VALUES ($1::uuid,$2,$3,now(),$4::uuid) RETURNING id`,
      [loanId, kind, status, conditionId])).rows[0].id);
    const orderOf = async (id) => (await db.query(`SELECT status, completed_at, meta FROM lt_file_orders WHERE id=$1::uuid`, [id])).rows[0];
    const fileDoc = async (loanId, conditionId) => db.query(
      `INSERT INTO documents (lt_loan_id, checklist_item_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind, review_status, is_current)
       VALUES ($1::uuid,$2::uuid,'commitment.pdf','application/pdf',10,'local',$3,'staff','title_commitment','accepted',true)`,
      [loanId, conditionId, `test/${uniq}/${conditionId}.pdf`]);

    // ── the loan under test: a title order placed, pointing at its ORDER condition
    const loan = await mkLoan('main');
    const orderCond = await mkCondition(loan, 'lt_order_title', 'condition');
    const docsCond = await mkCondition(loan, 'lt_title_docs');
    const unrelated = await mkCondition(loan, 'lt_purchase_contract');
    const order = await mkOrder(loan, 'title', 'ordered', orderCond);

    console.log('\nA. a document on the DOCS condition (a reply in a fresh email chain, filed by hand)');
    await fileDoc(loan, docsCond);
    const a = await sync.onDocumentFiled(loan, docsCond);   // the upload door's hook
    assert(a.moved === 1 && a.kinds.includes('title'), `the hook says it moved the title order (${JSON.stringify(a)})`);
    assert((await orderOf(order)).status === 'documents_in', 'the order reads "Documents in", though nothing ever reached its thread');

    console.log('\nB. the docs condition signed off — through the real satisfy door');
    const s = await write.satisfy(loan, docsCond, staffId);
    assert(s.ok === true, `satisfy accepted the condition (${JSON.stringify(s.error || s.status || 'ok')})`);
    assert(s.order && s.order.moved === 1, 'satisfy reports the order it finished');
    let o = await orderOf(order);
    assert(o.status === 'completed', 'the order is Done');
    assert(!!o.completed_at, '…with a finish date');
    assert(o.meta && o.meta.completed_via === 'condition', '…stamped as finished BY THE CONDITION');

    console.log('\nC. reopen puts back only what the condition closed');
    const r = await write.reopen(loan, docsCond);
    assert(r.ok === true && r.order && r.order.moved === 1, 'reopening the condition reopens the order');
    o = await orderOf(order);
    assert(o.status === 'documents_in' && o.completed_at == null, 'the order is back to "Documents in" (the documents are still there)');
    // A person's own finish is theirs.
    await db.query(`UPDATE lt_file_orders SET status='completed', completed_at=now(), meta='{}'::jsonb WHERE id=$1::uuid`, [order]);
    await write.satisfy(loan, docsCond, staffId);
    const r2 = await write.reopen(loan, docsCond);
    assert(r2.ok === true && r2.order.moved === 0 && (await orderOf(order)).status === 'completed',
      'an order a PERSON marked finished stays finished when the condition reopens');

    console.log('\nD. a waive completes it too — the desk has nothing left to chase');
    await db.query(`UPDATE lt_file_orders SET status='ordered', completed_at=NULL, meta='{}'::jsonb WHERE id=$1::uuid`, [order]);
    const w = await write.waive(loan, orderCond, staffId, 'Title came through the attorney instead.');
    assert(w.ok === true && w.order.moved === 1 && (await orderOf(order)).status === 'completed',
      'waiving the ORDER condition (condition_id match) completes the order');

    console.log('\nE. an unrelated condition never moves an order');
    await db.query(`UPDATE lt_file_orders SET status='ordered', completed_at=NULL, meta='{}'::jsonb WHERE id=$1::uuid`, [order]);
    await fileDoc(loan, unrelated);
    const e1 = await sync.onDocumentFiled(loan, unrelated);
    const e2 = await write.satisfy(loan, unrelated, staffId);
    assert(e1.moved === 0 && e2.ok === true && e2.order.moved === 0 && (await orderOf(order)).status === 'ordered',
      'the purchase contract condition leaves the title order exactly where it was');

    console.log('\nF. the sweep — previous AND future');
    const loan2 = await mkLoan('book');
    const docs2 = await mkCondition(loan2, 'lt_insurance_docs');
    const order2 = await mkOrder(loan2, 'insurance', 'ordered');           // no condition_id: the kind map answers
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE id=$1::uuid`, [docs2]);
    const loan3 = await mkLoan('docs');
    const docs3 = await mkCondition(loan3, 'lt_title_docs');
    const order3 = await mkOrder(loan3, 'title', 'ordered');
    await fileDoc(loan3, docs3);
    const loan4 = await mkLoan('open');
    await mkCondition(loan4, 'lt_title_docs');
    await mkCondition(loan4, 'lt_order_title', 'condition');
    const order4 = await mkOrder(loan4, 'title', 'ordered');
    const sw = await sync.sweepOnce({});
    assert(sw.ok === true, `the sweep ran (${sw.reason || 'ok'})`);
    assert((await orderOf(order2)).status === 'completed', 'a signed-off insurance condition on the existing book completes its order');
    assert((await orderOf(order3)).status === 'documents_in', 'a document already on a title docs condition moves its order to Documents in');
    assert((await orderOf(order4)).status === 'ordered', 'an order whose conditions are still open, with no document, is not touched by the sweep');
    assert((await orderOf(order)).status === 'completed', 'the main loan\'s waived ORDER condition (step D) is honoured by the sweep too');
    const again = await sync.sweepOnce({});
    assert(again.ok && again.completed === 0 && again.documentsIn === 0, 'a second pass finds nothing to do (idempotent)');

    console.log(failures ? `\n${failures} of ${n} assertion(s) failed` : `\nALL ${n} lt-order-condition-sync assertions passed`);
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE $1`, [`${uniq}-%`]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
