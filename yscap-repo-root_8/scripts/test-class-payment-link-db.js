'use strict';
/**
 * Class Valuation — the payment link's second leg and the document send, against a
 * REAL Postgres and the REAL HTTP doors (owner-directed 2026-09-03: no invoicing; the
 * link goes to the file mailbox and PILOT forwards it to the borrower, the loan
 * officer and the processor; and the pre-merge audit's two defects on the send route).
 *
 * The mailer is STUBBED and inspected — a passing send against the `none` provider
 * proves nothing about who was addressed. Nothing reaches Class: the transport is
 * stubbed on the module the route calls.
 */
if (!process.env.DATABASE_URL) { console.log('test-class-payment-link-db: SKIP (no DATABASE_URL)'); process.exit(0); }
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.test';
process.env.CLASS_ENABLED = '1';
process.env.CLASS_OUTBOUND_ENABLED = '1';
delete process.env.CLASS_DRYRUN;
process.env.CLASS_ENVIRONMENT = process.env.CLASS_ENVIRONMENT || 'uat';
process.env.CLASS_CLIENT_ID = process.env.CLASS_CLIENT_ID || 'cid';
process.env.CLASS_CLIENT_SECRET = process.env.CLASS_CLIENT_SECRET || 'secret';
process.env.CLASS_USERNAME = process.env.CLASS_USERNAME || 'user';
process.env.CLASS_PASSWORD = process.env.CLASS_PASSWORD || 'pass';

const db = require('../src/db');
const { signJwt } = require('../src/lib/crypto');
const mailer = require('../src/lib/email');
const client = require('../src/class/client');
const orderService = require('../src/class/order-service');
const plink = require('../src/class/payment-link-inbox');
const documents = require('../src/class/documents');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };
const rid = () => Math.random().toString(36).slice(2, 10);

async function main() {
  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();
  const tag = rid();
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, cell_phone) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['Ada', 'Reyes-' + tag, `ada.${tag}@example.com`, '5551234567'])).rows[0].id;
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,'loan_officer',true) RETURNING id`,
    [`lo-${tag}@example.test`, 'Ophelia Officer'])).rows[0].id;
  const processor = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,'processor',true) RETURNING id`,
    [`pr-${tag}@example.test`, 'Percy Processor'])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, loan_type, property_type, occupancy, property_address,
                               purchase_price, loan_amount, status, loan_officer_id, processor_id)
     VALUES ($1,$2,'fix_and_flip','Single Family','investment',$3::jsonb,180000,250000,'underwriting',$4,$5) RETURNING id`,
    [borrowerId, 'YSCAP' + tag,
     JSON.stringify({ addressLine: '195 Parrish St', city: 'Wilkes-Barre', state: 'PA', postalCode: '18702', county: 'Luzerne' }),
     officer, processor])).rows[0].id;
  await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [appId, officer]);
  await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'processor') ON CONFLICT DO NOTHING`, [appId, processor]);
  const mailbox = `file+${appId}@reply.test`;

  // ==========================================================================
  console.log('\n--- the order defaults to the payment link, addressed to the file mailbox ---');
  const ctx = await orderService.loadContext(db, appId);
  ok(ctx.paymentMethod === 'PaymentLink', 'the payment link is the default');
  ok(ctx.paymentEmail === mailbox, 'and it is addressed to the file\'s own mailbox');
  ok(ctx.paymentEmailVia === 'mailbox', 'which the screen is told');
  const pv = await orderService.buildPreview(db, appId, { overrides: { productId: 42 } });
  ok(pv.body.paymentDetails && pv.body.paymentDetails.paymentMethod === 'PaymentLink' && pv.body.paymentDetails.recipientEmail === mailbox,
     'the order body carries PaymentLink → the file mailbox');
  const inv = await orderService.buildPreview(db, appId, { overrides: { productId: 42, paymentMethod: 'Invoice' } });
  ok(inv.canPlace === false && inv.missing.some((m) => /invoicing/.test(m.why)), 'an invoice cannot be placed, and the reason says YS does not invoice');

  // ==========================================================================
  console.log('\n--- Class\'s email on the mailbox is forwarded to the borrower, officer and processor ---');
  const orderRow = (await db.query(
    `INSERT INTO class_orders (application_id, class_order_id, reference_number, api_version, uad, status, payment_method, payment_recipient_email)
     VALUES ($1,'555',$2,'v1','2.6','ordered','PaymentLink',$3) RETURNING id`, [appId, 'YSCAP' + tag, mailbox])).rows[0].id;
  const outbox = [];
  const realSend = mailer.sendMail;
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };
  try {
    const fileInbox = require('../src/lib/file-inbox');
    // Drive the REAL inbound path with the retrieval stubbed (the webhook carries metadata only).
    const realRetrieve = fileInbox.retrieveInboundEmail;
    const emailId = 'em-' + tag;
    const full = { from: 'Class Valuation <noreply@classvaluation.com>', subject: 'Payment for your appraisal',
      text: 'Please pay for the appraisal here: https://pay.classvaluation.com/p/' + tag, html: '', attachments: [] };
    // retrieveInboundEmail is called by name inside the module, so stub through the module's own binding.
    const inboundMod = require.cache[require.resolve('../src/lib/file-inbox')];
    void inboundMod; void realRetrieve;
    // Call the forward directly (the same function the inbound loop calls), then prove the
    // loop's skip-on-redelivery via the recorded delivery id.
    const r = await plink.handleInbound({ applicationId: appId, fromEmail: 'noreply@classvaluation.com', subject: full.subject, text: full.text, html: full.html, inboundId: emailId });
    ok(r.handled === true, 'the vendor email on the mailbox is handled');
    ok(outbox.length === 1, 'exactly ONE email goes out');
    const m = outbox[0] || {};
    ok(Array.isArray(m.to) && m.to.length === 1 && m.to[0] === `ada.${tag}@example.com`, 'to the borrower');
    ok(Array.isArray(m.cc) && m.cc.includes(`lo-${tag}@example.test`) && m.cc.includes(`pr-${tag}@example.test`), 'with the loan officer and the processor visibly copied');
    ok(!m.bcc, 'nobody is hidden on a Bcc');
    ok(new RegExp('pay\\.classvaluation\\.com/p/' + tag).test(String(m.html)), 'the payment page is in the email');
    ok(m.replyTo === mailbox, 'and a reply comes back to the file mailbox');
    const row = (await db.query('SELECT payment_link_forwarded_at, payment_link_forwarded_to, payment_link_sent_at FROM class_orders WHERE id=$1', [orderRow])).rows[0];
    ok(!!row.payment_link_forwarded_at && row.payment_link_forwarded_to && row.payment_link_forwarded_to.inboundId === emailId, 'the forward is recorded on the order, keyed on the delivery');
    ok(!!row.payment_link_sent_at, 'and the order now knows the link went out');
    const inapp = await db.query(`SELECT count(*)::int n FROM notifications WHERE application_id=$1 AND type='class_payment_link'`, [appId]);
    ok(inapp.rows[0].n >= 2, `the officer and processor each get a portal trace (${inapp.rows[0].n})`);
    const again = await plink.handleInbound({ applicationId: appId, fromEmail: 'noreply@classvaluation.com', subject: full.subject, text: full.text, html: '', inboundId: emailId });
    ok(again.handled && again.duplicate && outbox.length === 1, 'a redelivered webhook sends nothing twice');
    const other = await plink.handleInbound({ applicationId: appId, fromEmail: `ada.${tag}@example.com`, subject: 'hi', text: 'a reply', html: '', inboundId: 'em2-' + tag });
    ok(other.handled === false && outbox.length === 1, 'a borrower\'s own reply on the mailbox is not a payment link');
  } finally { mailer.sendMail = realSend; }

  // ==========================================================================
  console.log('\n--- the send-to-Class route (pre-merge audit: isUuid was undefined; a failure was "already sent") ---');
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jwt = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let d = null; try { d = await r.json(); } catch (_) {}
    return { status: r.status, body: d };
  };
  const docId = (await db.query(
    `INSERT INTO documents (application_id, filename, content_type, storage_ref, size_bytes, is_current, review_status, doc_kind)
     VALUES ($1,'sow.pdf','application/pdf','test/none.pdf',10,true,'accepted','sow') RETURNING id`, [appId])).rows[0].id;
  const realUpload = client.uploadAttachment;
  let uploads = 0; let failNext = true;
  client.uploadAttachment = async () => { uploads++; if (failNext) { failNext = false; throw new Error('HTTP 500 from Class'); } return { success: true }; };
  const storage = require('../src/lib/storage');
  const realRead = storage.read;
  storage.read = async () => Buffer.from('%PDF-1.4 test');
  try {
    const bad = await post(`/api/class/files/${appId}/orders/${orderRow}/documents`, { documentIds: ['not-a-uuid'] });
    ok(bad.status === 400, `a malformed document id is a 400, not a 500 (${bad.status})`);
    const first = await post(`/api/class/files/${appId}/orders/${orderRow}/documents`, { documentIds: [docId] });
    ok(first.status === 400 && first.body && first.body.skipped && first.body.skipped[0].reason === 'send_failed', 'a vendor failure is reported as a failure');
    const att1 = (await db.query('SELECT uploaded_at, upload_error, upload_attempts FROM class_attachments WHERE class_order_row=$1 AND document_id=$2', [orderRow, docId])).rows[0];
    ok(att1 && !att1.uploaded_at && /HTTP 500/.test(att1.upload_error) && att1.upload_attempts === 1, 'recorded as one failed attempt, not as sent');
    const list1 = await documents.listUploadable(db, appId, orderRow);
    const d1 = list1.find((d) => String(d.id) === String(docId));
    ok(d1 && d1.alreadyUploaded === false && /HTTP 500/.test(d1.uploadError), 'the picker still offers it, and says the last try failed');
    const second = await post(`/api/class/files/${appId}/orders/${orderRow}/documents`, { documentIds: [docId] });
    ok(second.status === 200 && second.body.uploaded && second.body.uploaded.length === 1, 'pressing Send again sends it');
    const att2 = (await db.query('SELECT uploaded_at, upload_error, upload_attempts FROM class_attachments WHERE class_order_row=$1 AND document_id=$2', [orderRow, docId])).rows[0];
    ok(att2 && att2.uploaded_at && !att2.upload_error && att2.upload_attempts === 0, 'and the row now says sent, with the failure cleared');
    const third = await post(`/api/class/files/${appId}/orders/${orderRow}/documents`, { documentIds: [docId] });
    ok(third.status === 400 && third.body.skipped && third.body.skipped[0].reason === 'already_uploaded' && uploads === 2, 'a document Class took is never sent twice');
    // The record-a-charge door refuses an incomplete record before it can reach Class.
    const rec = await post(`/api/class/files/${appId}/orders/${orderRow}/payment/record`, { amount: 10, last4: '4242' });
    ok(rec.status === 400 && rec.body && rec.body.error === 'bad_name', 'a charge with no name on the card is refused at the door');
  } finally {
    client.uploadAttachment = realUpload;
    storage.read = realRead;
    server.close();
  }

  // ---- cleanup ------------------------------------------------------------
  await db.query('DELETE FROM notifications WHERE application_id=$1', [appId]);
  await db.query('DELETE FROM class_orders WHERE application_id=$1', [appId]);
  await db.query('DELETE FROM applications WHERE id=$1', [appId]);
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]);
  await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [[officer, processor]]);
  console.log(`\ntest-class-payment-link-db: ${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('FAILED', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
