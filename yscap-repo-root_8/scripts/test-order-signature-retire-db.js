/**
 * THE SIGNATURE IMAGES THAT WERE ALREADY ON THE FILES — real Postgres.
 * Skips cleanly with no DATABASE_URL.
 *
 * The owner, 2026-08-03: "the small tiny pictures from the email signatures of
 * the reply agent … is still coming in as documents and we still need to
 * manually reject it on every file — maybe it's still from the past."
 *
 * It was from the past. The filter (order-return-filter.js) shipped 2026-08-02
 * and is go-forward only; db/420, hours later, attached every ORPHANED order
 * return to its title / insurance condition and the file screen began rendering
 * the documents that are not in a slot — so months of already-filed signature
 * images appeared on the conditions at once. This proves the missing half.
 *
 * Every assertion below reproduces something that was true on the pre-fix code:
 * the image sitting is_current on the condition, db/420 re-attaching it on the
 * next boot, and the team having to reject it by hand.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-order-signature-retire-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const storage = require('../src/lib/storage');
const orderInbox = require('../src/lib/order-inbox');
const { retireSignatureImagesOnce } = require('../src/lib/order-signature-retire');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `osr-${process.pid}-${Date.now()}`;

// A 155 x 40 PNG — the shape of the "SIB INSURANCE BROKERAGE" logo in the
// owner's own screenshot — but padded past the 150 KB byte floor, so ONLY the
// pixel rule can catch it. That is the case the byte rule alone would keep.
const pngOf = (w, h, pad) => {
  const head = Buffer.alloc(24);
  Buffer.from([0x89]).copy(head, 0);
  head.write('PNG\r\n\x1a\n', 1, 'latin1');
  head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
};
const LOGO_SMALL = pngOf(155, 40, 5 * 1024);          // the reported 5 KB signature card
const LOGO_HEAVY = pngOf(400, 120, 200 * 1024);       // a retina logo, over the byte floor
const PAGE = pngOf(1700, 2200, 300 * 1024);           // a genuine scanned page
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

(async () => {
  /* ───────────────────────────────── seed ─────────────────────────────────── */
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ophelia Officer','loan_officer',true) RETURNING id`,
    [`${uniq}-lo@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type)
     VALUES ($1,$2,$3,$4,'underwriting','Purchase') RETURNING id`,
    [borrower, officer, `YS${String(Date.now()).slice(-8)}11`,
     JSON.stringify({ oneLine: '3091 Patricia Ct, Brooklyn, NY 11211' })])).rows[0].id;

  // File a real binder through the live sink so the insurance condition exists
  // exactly as it does on a real file.
  await orderInbox.saveReturnedDocs({
    applicationId: appId, orderType: 'insurance',
    attachments: [{ filename: 'sib binder.pdf', contentType: 'application/pdf', content: PDF.toString('base64') }],
    fromEmail: 'agent@sib.test',
  });
  const cond = (await db.query(
    `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_cond_insurance' LIMIT 1`, [appId])).rows[0];
  assert(!!cond, 'the insurance condition is on the file');

  // Plant the documents the PRE-FILTER months left behind — inserted straight into
  // `documents`, which is exactly the state those rows are in today.
  const plant = async (filename, buf, contentType, kind, reviewStatus, slot) => {
    const { ref, provider } = await storage.save(buf, { filename });
    return (await db.query(
      `INSERT INTO documents
         (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, doc_kind, review_status, slot_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,$11) RETURNING id`,
      [appId, borrower, cond.id, filename, contentType, buf.length, provider, ref, kind, reviewStatus, slot || null])).rows[0].id;
  };
  const sigPending = await plant('image.png', LOGO_SMALL, 'image/png', 'insurance_order_return', 'pending', null);
  const sigRejected = await plant('image.png', LOGO_SMALL, 'image/png', 'insurance_order_return', 'rejected', null);
  const sigHeavy = await plant('image.png', LOGO_HEAVY, 'image/png', 'insurance_order_return', 'pending', null);
  const sigClosing = await plant('image001.png', LOGO_SMALL, 'image/png', 'closing_correspondence', 'pending', null);
  const realPdf = await plant('policy.pdf', PDF, 'application/pdf', 'insurance_order_return', 'pending', null);
  const realScan = await plant('binder-scan.png', PAGE, 'image/png', 'insurance_order_return', 'pending', null);
  const accepted = await plant('agent-headshot.png', LOGO_SMALL, 'image/png', 'insurance_order_return', 'accepted', null);
  const slotted = await plant('image.png', LOGO_SMALL, 'image/png', 'insurance_order_return', 'pending', 'Insurance binder');

  const row = async (id) => (await db.query(
    `SELECT is_current, review_status, checklist_item_id, doc_kind, storage_ref FROM documents WHERE id=$1`, [id])).rows[0];

  /* ── 1. the state the owner is looking at ────────────────────────────────── */
  {
    const r = await row(sigPending);
    assert(r.is_current === true && r.checklist_item_id === cond.id,
      'before the pass, the signature image is live ON the insurance condition — what the team keeps rejecting by hand');
  }

  /* ── 2. the pass retires exactly the signature images ────────────────────── */
  const res = await retireSignatureImagesOnce({ limit: 100 });
  assert(res.retired >= 4, `the pass retires the signature images (retired ${res.retired})`);
  {
    const a = await row(sigPending);
    assert(a.is_current === false, 'the pending signature image is off the current file');
    assert(a.review_status === 'superseded',
      'it is DECIDED — so the condition can be signed off without a human clicking Reject on a company logo');
    assert(a.checklist_item_id === cond.id && a.doc_kind === 'insurance_order_return',
      'its provenance is kept: the row still says which order it came back on and which condition it sat in');
    assert(!!(await storage.read(a.storage_ref)), 'the bytes are still in storage — nothing is deleted');

    const b = await row(sigRejected);
    assert(b.is_current === false && b.review_status === 'rejected',
      'one the team already rejected by hand is cleared away too, and their verdict is not overwritten');

    const h = await row(sigHeavy);
    assert(h.is_current === false, 'a heavy retina logo is retired on its PIXELS, over the byte floor');

    const cl = await row(sigClosing);
    assert(cl.is_current === false, 'the closing email chain is cleaned up the same way');
  }

  /* ── 3. and touches nothing else ─────────────────────────────────────────── */
  {
    assert((await row(realPdf)).is_current === true, 'a returned PDF is untouched');
    assert((await row(realScan)).is_current === true, 'a genuine scanned page is untouched');
    const acc = await row(accepted);
    assert(acc.is_current === true && acc.review_status === 'accepted',
      'a document a human ACCEPTED is never second-guessed, even if it looks like a logo');
    assert((await row(slotted)).is_current === true,
      'a document a human filed into a slot is never touched');
  }

  /* ── 4. idempotent, and db/420 cannot undo it on the next boot ───────────── */
  {
    const second = await retireSignatureImagesOnce({ limit: 100 });
    assert(second.retired === 0, 'a second pass retires nothing — it is self-draining');
    // Most candidates are KEPT (a real photo scan is an image on an order return
    // too), so without a resumable cursor they would be re-read from storage on
    // every boot and, once there were more of them than the per-boot limit,
    // would starve everything behind them out of the pass — a silent cap.
    assert(second.scanned === 0, 'and it re-examines nothing — the pass resumes from a durable cursor');
    const cur = (await db.query(
      `SELECT value FROM sync_runtime_state WHERE key='order_signature_retire_cursor'`)).rows[0];
    assert(!!(cur && cur.value && cur.value.afterId), 'the cursor is recorded');

    // db/420 runs on EVERY boot and re-attaches orphaned returns. Retiring by
    // is_current is what puts these rows outside its predicate for good.
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '420_order_returns_reach_their_condition.sql'), 'utf8');
    await db.query(sql);
    const after = await row(sigPending);
    assert(after.is_current === false, 'the next boot\'s db/420 re-attach pass leaves the retired image retired');
  }

  /* ── 5. it is recorded — the row is off every screen, so the audit log is
         the only place that says it was ever here ───────────────────────────── */
  {
    const a = (await db.query(
      `SELECT detail FROM audit_log WHERE action='order_signature_image_retired' AND entity_id=$1`, [sigPending])).rows[0];
    assert(!!a, 'the retirement is audited');
    assert(a && a.detail && a.detail.reason === 'tiny_image', 'and the audit row says WHY it was judged a signature image');
  }

  /* ── 6. the off-switch ───────────────────────────────────────────────────── */
  {
    process.env.ORDER_SIGNATURE_RETIRE_DISABLED = '1';
    const off = await retireSignatureImagesOnce({ limit: 100 });
    assert(off.skipped === true && off.retired === 0, 'ORDER_SIGNATURE_RETIRE_DISABLED=1 stops the pass');
    delete process.env.ORDER_SIGNATURE_RETIRE_DISABLED;
  }

  /* ── 7. and going forward the same email files only the real document ────── */
  {
    const r = await orderInbox.saveReturnedDocs({
      applicationId: appId, orderType: 'insurance',
      attachments: [
        { filename: 'sib invoice.pdf', contentType: 'application/pdf', content: PDF.toString('base64') },
        { filename: 'image.png', contentType: 'image/png', content: LOGO_SMALL.toString('base64') },
        { filename: 'image.png', contentType: 'image/png', content: LOGO_HEAVY.toString('base64') },
      ],
      fromEmail: 'agent@sib.test',
    });
    assert(r.saved === 1 && r.skipped === 2,
      'the agent\'s reply files the invoice and leaves BOTH signature images out — nothing to reject');
  }

  /* ── 8. AN ORDER IS NOT LEFT WAITING ON DOCUMENTS THAT ARE NO LONGER THERE ──
     `order-inbox` flips an order to 'documents_in' and stamps `first_response_at`
     when ANY attachment files — so an order that turned over on what we now know
     was a signature strip was left claiming the vendor delivered. It then sat on
     the Orders desk reading "waiting on us" with nothing to classify, its Chase
     button withheld (that needs 'ordered'), while the overdue ladder emailed the
     team "N days of documents waiting to be filed" every two days, escalating to
     the administrators, about nothing at all. */
  {
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type)
       VALUES ((SELECT borrower_id FROM applications WHERE id=$1), (SELECT loan_officer_id FROM applications WHERE id=$1),
               $2, '{"oneLine":"9 Unwind Way"}'::jsonb, 'underwriting', 'Purchase') RETURNING id`,
      [appId, `YSUNW${String(Date.now()).slice(-9)}`])).rows[0].id;
    await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, ordered_at, first_response_at)
       VALUES ($1,'insurance','documents_in', now() - interval '9 days', now() - interval '8 days')`, [app2]);
    // The ONLY thing that ever came back was the agent's signature card.
    const s1 = await storage.save(LOGO_SMALL, { filename: 'image.png' });
    await db.query(
      `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref, doc_kind, is_current, review_status)
       VALUES ($1,'image.png','image/png',$2,$3,$4,'insurance_order_return',true,'pending')`,
      [app2, LOGO_SMALL.length, s1.provider, s1.ref]);

    await retireSignatureImagesOnce({ limit: 200 });
    const o = (await db.query(
      `SELECT status, first_response_at FROM file_orders WHERE application_id=$1 AND order_type='insurance'`,
      [app2])).rows[0];
    assert(o.status === 'ordered',
      'with its only "delivery" retired, the order goes back to waiting on the vendor');
    assert(o.first_response_at === null,
      'and the vendor loses credit for a response that was a signature strip');

    // AND IT IS NARROW: a real document alongside the logo means the vendor DID
    // answer, so that order must not be touched.
    const app3 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type)
       VALUES ((SELECT borrower_id FROM applications WHERE id=$1), (SELECT loan_officer_id FROM applications WHERE id=$1),
               $2, '{"oneLine":"11 Unwind Way"}'::jsonb, 'underwriting', 'Purchase') RETURNING id`,
      [appId, `YSUNWB${String(Date.now()).slice(-9)}`])).rows[0].id;
    await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, ordered_at, first_response_at)
       VALUES ($1,'insurance','documents_in', now() - interval '9 days', now() - interval '8 days')`, [app3]);
    const s2 = await storage.save(PDF, { filename: 'binder.pdf' });
    const s3 = await storage.save(LOGO_SMALL, { filename: 'image.png' });
    await db.query(
      `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref, doc_kind, is_current, review_status)
       VALUES ($1,'binder.pdf','application/pdf',$2,$3,$4,'insurance_order_return',true,'pending'),
              ($1,'image.png','image/png',$5,$6,$7,'insurance_order_return',true,'pending')`,
      [app3, PDF.length, s2.provider, s2.ref, LOGO_SMALL.length, s3.provider, s3.ref]);

    await retireSignatureImagesOnce({ limit: 200 });
    const o3 = (await db.query(
      `SELECT status, first_response_at FROM file_orders WHERE application_id=$1 AND order_type='insurance'`,
      [app3])).rows[0];
    assert(o3.status === 'documents_in' && o3.first_response_at !== null,
      'an order that also got a REAL document keeps its delivery — only an emptied one is put back');

    await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[app2, app3]]);
  }

  await db.query(`DELETE FROM documents WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
