'use strict';
/**
 * Class Valuation — documents OUT to the appraiser, and the money picture. Pure:
 * the vendor transport is stubbed, no database, nothing leaves the process.
 *
 * Covers the three "AMC has it, Class does not" gaps the owner named on 2026-09-02:
 *   1. upload — category / attachment-type mapping, the multipart body, the gates;
 *   2. payment — the order-time paymentDetails, the payment-details parse, the
 *      record-only card call;
 *   3. fee before ordering — the history read's shape (the API has no quote).
 */
const path = require('path');

// Env before config (config freezes env at load). Fake credentials, UAT, dry-run OFF
// so the write path builds a real request against the stubbed fetch.
process.env.CLASS_ENABLED = '1';
process.env.CLASS_OUTBOUND_ENABLED = '1';
delete process.env.CLASS_DRYRUN;
process.env.CLASS_ENVIRONMENT = 'uat';
process.env.CLASS_CLIENT_ID = 'cid';
process.env.CLASS_CLIENT_SECRET = 'secret';
process.env.CLASS_USERNAME = 'user';
process.env.CLASS_PASSWORD = 'pass';
delete process.env.CLASS_TOKEN_URL;
delete process.env.CLASS_ORDERS_URL;
delete process.env.CLASS_API_PREFIX;
// The file mailbox exists on this system, so the payment link defaults to it.
process.env.CHAT_REPLY_DOMAIN = 'reply.test';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', l); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (got ${JSON.stringify(a)})`);

function makeRes(status, bodyObj) {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(text, 'utf8') };
}
let calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body, headers: (opts && opts.headers) || {} });
  if (String(url).endsWith('/connect/token')) return makeRes(200, { access_token: 'tok', expires_in: 3600 });
  if (/payment-details/.test(String(url))) return makeRes(200, { orderId: 77, clientFee: 550, additionalFees: [{ description: 'Rush', amount: 100, date: '2026-09-02T00:00:00Z' }], totalAmount: 650, paidAmount: 100, outstandingBalance: 550 });
  return makeRes(200, { success: true, message: null });
};

const ROOT = path.join(__dirname, '..');
const client = require(path.join(ROOT, 'src/class/client'));
const documents = require(path.join(ROOT, 'src/class/documents'));
const payment = require(path.join(ROOT, 'src/class/payment'));
const orderBuild = require(path.join(ROOT, 'src/class/order-build'));

(async () => {
  // -------------------------------------------------------------------------
  console.log('\n--- what a document is to Class: category + attachment type ---');
  eq(documents.classCategoryFor(documents.CAT_CONTRACT), 'SalesContract', 'the contract goes in their contract slot');
  eq(documents.classCategoryFor(documents.CAT_SOW), 'PlansAndSpecs', 'the scope of work goes in their plans & specs slot');
  eq(documents.classCategoryFor('Other Documents'), 'Miscellaneous', 'anything else is Miscellaneous');
  eq(documents.classCategory('salescontract'), 'SalesContract', 'a caller-named category is returned in THEIR casing');
  eq(documents.classCategory('Homework'), null, 'a category they do not have is refused, not passed through');
  ok(documents.CLASS_CATEGORIES.includes('PlansAndSpecs') && documents.CLASS_CATEGORIES.includes('ROVDocument'), 'the category list is the guide\'s');
  eq(documents.attachmentTypeFor('application/pdf', 'x.bin'), 'PDF', 'PDF by content type');
  eq(documents.attachmentTypeFor('application/octet-stream', 'report.PDF'), 'PDF', 'PDF by extension when the type is generic');
  eq(documents.attachmentTypeFor('text/xml', 'a.xml'), 'XML', 'XML');
  eq(documents.attachmentTypeFor('image/jpeg', 'a.jpg'), 'Image', 'an image');
  eq(documents.attachmentTypeFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sow.xlsx'), null,
    'an Excel export has NO Class attachment type — it must be skipped, never mislabelled');

  // -------------------------------------------------------------------------
  console.log('\n--- the upload on the wire: multipart, their path, the write gate ---');
  calls = [];
  client.invalidateToken();
  const bytes = Buffer.from('%PDF-1.4 fake');
  const r = await client.uploadAttachment('123456', 'SalesContract', { fileName: 'contract.pdf', contentType: 'application/pdf', bytes, attachmentType: 'PDF' });
  eq(r && r.success, true, 'the vendor\'s success envelope comes back');
  const up = calls.find((c) => /attachments\/SalesContract$/.test(c.url));
  ok(up, 'posted to …/{orderId}/attachments/{category}');
  ok(up && up.method === 'POST', 'as a POST');
  ok(up && /^https:\/\/api\.uat\.classvaluation\.com\/intg\/(orders\/)?123456\/attachments\/SalesContract$/.test(up.url),
    `on the /intg data base with the order id in the path (got ${up && up.url})`);
  ok(up && up.body && typeof up.body.get === 'function', 'the body is a FormData (multipart), not JSON');
  ok(up && !up.headers['Content-Type'], 'no Content-Type is set by hand — fetch writes the multipart boundary itself');
  ok(up && up.body.get('AttachmentType') === 'PDF', 'AttachmentType rides as a form field');
  const file = up && up.body.get('FileData');
  ok(file && typeof file === 'object' && file.size === bytes.length, 'FileData carries the bytes');
  ok(file && file.name === 'contract.pdf', 'under the document\'s own file name');
  ok(up && /^Bearer tok$/.test(up.headers.Authorization || ''), 'with the bearer');

  const described = client._internals.describeForm({ fields: { AttachmentType: 'PDF' }, file: { fileName: 'a.pdf', contentType: 'application/pdf', bytes } });
  ok(/AttachmentType/.test(described) && /a\.pdf/.test(described) && !/%PDF/.test(described), 'the dry-run description names the file without dumping its bytes');

  // The write gate: with outbound off the upload is refused before any fetch.
  process.env.CLASS_OUTBOUND_ENABLED = '0';
  delete require.cache[require.resolve(path.join(ROOT, 'src/config'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src/lib/integrations/switches'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src/class/client'))];
  const gated = require(path.join(ROOT, 'src/class/client'));
  calls = [];
  let gateErr = null;
  try { await gated.uploadAttachment('1', 'Miscellaneous', { fileName: 'x.pdf', contentType: 'application/pdf', bytes, attachmentType: 'PDF' }); }
  catch (e) { gateErr = e; }
  eq(gateErr && gateErr.code, 'CLASS_OUTBOUND_DISABLED', 'an upload is a WRITE: refused when the outbound switch is off');
  eq(calls.length, 0, 'and nothing was fetched');
  process.env.CLASS_OUTBOUND_ENABLED = '1';
  delete require.cache[require.resolve(path.join(ROOT, 'src/config'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src/lib/integrations/switches'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src/class/client'))];

  // -------------------------------------------------------------------------
  console.log('\n--- uploadToOrder: the service over a stubbed db + transport ---');
  {
    const sentUp = [];
    const transport = { uploadAttachment: async (orderId, cat, f) => { sentUp.push({ orderId, cat, fileName: f.fileName, attachmentType: f.attachmentType }); return { success: true }; } };
    const inserted = [];
    const dbh = { query: async (sql, params) => {
      if (/FROM documents d/.test(sql)) {
        return { rows: [
          { id: 'd1', filename: 'contract.pdf', content_type: 'application/pdf', storage_ref: 'r1', doc_kind: 'contract', llc_id: null, item_label: 'Contract & Assignment', template_code: 'CONTRACT' },
          { id: 'd2', filename: 'sow.xlsx', content_type: 'application/vnd.ms-excel', storage_ref: 'r2', doc_kind: 'sow', llc_id: null, item_label: 'Scope of Work', template_code: 'SOW' },
          { id: 'd3', filename: 'sow.html', content_type: 'text/html', storage_ref: 'r3', doc_kind: 'sow', llc_id: null, item_label: 'Scope of Work', template_code: 'SOW' },
        ] };
      }
      if (/SELECT document_id FROM class_attachments/.test(sql)) return { rows: [] };
      if (/INSERT INTO class_attachments/.test(sql)) { inserted.push(params); return { rows: [] }; }
      return { rows: [] };
    } };
    const order = { id: 9, application_id: 'app-1', class_order_id: '555' };
    const out = await documents.uploadToOrder(dbh, order, { staffId: 's1', documentIds: ['d1', 'd2', 'd3'] },
      { transport, readStorage: async () => Buffer.from('%PDF-1.4 x') });
    eq(out.ok, true, 'one document went');
    eq(out.uploaded.map((u) => u.documentId), ['d1'], 'the PDF contract');
    eq(sentUp[0] && sentUp[0].orderId, '555', 'to the CLASS order id, not our row id');
    ok(sentUp[0] && ['SalesContract', 'Miscellaneous', 'PlansAndSpecs'].includes(sentUp[0].cat), 'under a Class category');
    eq(out.skipped.map((s) => s.reason).sort(), ['html_export', 'unsupported_type'], 'the Excel SOW and the HTML export are skipped with a reason each');
    eq(inserted.length, 1, 'one outbound row recorded');
    ok(inserted[0].includes('s1'), 'stamped with who sent it');

    const forced = await documents.uploadToOrder(dbh, order, { documentIds: ['d1'], category: 'salescontract' },
      { transport, readStorage: async () => Buffer.from('%PDF-1.4 x') });
    eq(forced.ok && forced.uploaded[0].category, 'SalesContract', 'a caller-named category is honoured, in their casing');
    const badCat = await documents.uploadToOrder(dbh, order, { documentIds: ['d1'], category: 'Nonsense' }, { transport });
    eq(badCat.error, 'unknown_category', 'a category Class does not have is refused before anything is read');
    const notNumbered = await documents.uploadToOrder(dbh, { id: 9, application_id: 'app-1', class_order_id: null }, { documentIds: ['d1'] }, { transport });
    eq(notNumbered.error, 'not_numbered', 'nothing can be attached to an order Class has not numbered');
    const gatedOut = await documents.uploadToOrder(dbh, order, { documentIds: ['d1'] },
      { transport: { uploadAttachment: async () => { const e = new Error('off'); e.code = 'CLASS_OUTBOUND_DISABLED'; throw e; } }, readStorage: async () => Buffer.from('x') });
    eq(gatedOut.error, 'outbound_disabled', 'the write gate comes back as a plain refusal, never a throw');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a FAILED upload is retried, bounded, and never called "sent" (pre-merge audit 2026-09-03) ---');
  {
    const { MAX_UPLOAD_ATTEMPTS } = documents._internals;
    const docRow = { id: 'd1', filename: 'sow.pdf', content_type: 'application/pdf', storage_ref: 'r1', doc_kind: 'sow', llc_id: null, item_label: 'Scope of Work', template_code: 'SOW' };
    const mk = (prior) => {
      const writes = [];
      const dbh = { query: async (sql, params) => {
        if (/FROM documents d/.test(sql)) return { rows: [docRow] };
        if (/FROM class_attachments/.test(sql) && /upload_attempts/.test(sql)) return { rows: prior ? [prior] : [] };
        if (/INSERT INTO class_attachments/.test(sql)) { writes.push({ sql, params }); return { rows: [] }; }
        return { rows: [] };
      } };
      return { dbh, writes };
    };
    const order = { id: 9, application_id: 'app-1', class_order_id: '555' };
    const bytes = async () => Buffer.from('%PDF-1.4 x');
    const failing = { uploadAttachment: async () => { throw new Error('HTTP 500 from Class'); } };
    const working = { uploadAttachment: async () => ({ success: true }) };

    // First try fails: recorded as a failure with ONE attempt, not as sent.
    const a = mk(null);
    const r1 = await documents.uploadToOrder(a.dbh, order, { documentIds: ['d1'] }, { transport: failing, readStorage: bytes });
    eq(r1.ok, false, 'a vendor error is a failure');
    ok(a.writes[0] && /upload_attempts \+ 1/.test(a.writes[0].sql) && a.writes[0].params.includes('HTTP 500 from Class'), 'recorded with the error and an attempt count');
    // Next pass: the failed row is NOT "already sent" — it is tried again and succeeds.
    const b = mk({ document_id: 'd1', uploaded_at: null, upload_error: 'HTTP 500 from Class', upload_attempts: 1 });
    const r2 = await documents.uploadToOrder(b.dbh, order, { documentIds: ['d1'] }, { transport: working, readStorage: bytes });
    eq(r2.ok && r2.uploaded.map((u) => u.documentId), ['d1'], 'a failed document is retried on the next pass');
    ok(b.writes[0] && /upload_attempts = 0/.test(b.writes[0].sql), 'and a success resets the count');
    // A genuinely sent row IS skipped.
    const c = mk({ document_id: 'd1', uploaded_at: new Date(), upload_error: null, upload_attempts: 0 });
    const r3 = await documents.uploadToOrder(c.dbh, order, { documentIds: ['d1'] }, { transport: working, readStorage: bytes });
    eq(r3.skipped.map((x) => x.reason), ['already_uploaded'], 'a document Class took is never sent twice');
    // Past the cap the poller stops; a human's button (force) still gets one more try.
    const d = mk({ document_id: 'd1', uploaded_at: null, upload_error: 'HTTP 500 from Class', upload_attempts: MAX_UPLOAD_ATTEMPTS });
    const r4 = await documents.uploadToOrder(d.dbh, order, { documentIds: ['d1'] }, { transport: working, readStorage: bytes });
    eq(r4.skipped.map((x) => x.reason), ['gave_up'], `after ${MAX_UPLOAD_ATTEMPTS} failures the poller leaves it for a human`);
    const r5 = await documents.uploadToOrder(d.dbh, order, { documentIds: ['d1'], force: true }, { transport: working, readStorage: bytes });
    eq(r5.ok && r5.uploaded.length, 1, 'and a human pressing Send gets another try');
    // The master switch and missing credentials are gates, not failures of the document.
    for (const code of ['CLASS_DISABLED', 'CLASS_NOT_CONFIGURED']) {
      const g = mk(null);
      const rg = await documents.uploadToOrder(g.dbh, order, { documentIds: ['d1'] },
        { transport: { uploadAttachment: async () => { const e = new Error('off'); e.code = code; throw e; } }, readStorage: bytes });
      eq(rg.error, documents._internals.GATE_CODES[code], `${code} comes back as a refusal`);
      eq(g.writes.length, 0, 'and nothing is written against the document');
    }
    // The picker's list reads the same distinction.
    const listDb = { query: async (sql) => {
      if (/FROM documents d/.test(sql)) return { rows: [{ ...docRow, size_bytes: 10, review_status: 'accepted', created_at: new Date() }] };
      if (/FROM class_attachments/.test(sql)) return { rows: [{ document_id: 'd1', category: 'PlansAndSpecs', uploaded_at: null, upload_error: 'HTTP 500', upload_attempts: MAX_UPLOAD_ATTEMPTS }] };
      return { rows: [] };
    } };
    const listed = await documents.listUploadable(listDb, 'app-1', 9);
    eq(listed[0].alreadyUploaded, false, 'the picker never calls a failed upload "sent"');
    eq(listed[0].uploadGaveUp, true, 'and says when PILOT gave up on it');
    // The auto-upload asks the switches before it reads a byte.
    const reads = [];
    const off = { on: (k) => k === 'CLASS_ENABLED' };
    const gated = await documents.autoUploadForOrder(listDb, { id: 9, application_id: 'app-1', class_order_id: '555' }, { switches: off, readStorage: async () => { reads.push(1); return Buffer.from('x'); } });
    eq(gated.gated, 'outbound_disabled', 'with writes off the auto-upload stands down');
    eq(reads.length, 0, 'without reading anything off disk');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- the payment link\'s second leg: Class → file mailbox → borrower, officer, processor ---');
  {
    const plink = require(path.join(ROOT, 'src/class/payment-link-inbox'));
    eq(plink.isVendorSender('payments@classvaluation.com'), true, 'Class\'s own domain is the vendor');
    eq(plink.isVendorSender('Class Valuation <noreply@mail.classvaluation.com>'), true, 'a sub-domain too');
    eq(plink.isVendorSender('someone@notclassvaluation.com'), false, 'a look-alike domain is not');
    eq(plink.isVendorSender('ada@example.com'), false, 'a borrower is not');
    eq(plink.extractLink('Pay here: https://pay.classvaluation.com/p/abc123.', ''), 'https://pay.classvaluation.com/p/abc123', 'the payment page is read out of the text, trailing punctuation dropped');
    eq(plink.extractLink('', '<a href="https://x.example/unsubscribe">u</a> <a href="https://secure.example/pay/9">Pay</a>'), 'https://secure.example/pay/9', 'from HTML, an unsubscribe link is never the payment page');
    eq(plink.extractLink('no links here', '<p>none</p>'), null, 'and with no link there is no guess');
    eq(plink.realEmail('Ada@Example.com '), 'ada@example.com', 'an address is normalised');
    eq(plink.realEmail('noemail+123@clickup.local'), null, 'a sync shadow address is not a mailbox');
    eq(plink.looksLikePaymentLink({ subject: 'Payment for your appraisal', text: 'x', html: '', link: 'https://pay.classvaluation.com/p/1' }), true, 'an email carrying the link is the link');
    eq(plink.looksLikePaymentLink({ subject: 'Reminder', text: 'Your appraisal payment is due.', html: '', link: null }), true, 'a reminder that talks about paying is forwarded too');
    eq(plink.looksLikePaymentLink({ subject: 'Receipt for your payment', text: 'Thank you, paid', html: '', link: 'https://pay.classvaluation.com/r/1' }), false, 'a receipt is never told to the borrower as "how to pay"');
    eq(plink.looksLikePaymentLink({ subject: 'Your appraisal is scheduled', text: 'The inspection is Tuesday.', html: '', link: null }), false, 'a status note is not a payment link');
    // Post-merge audit 2026-09-03: "payment successful" can land before OrderPaid marks the order paid.
    eq(plink.looksLikePaymentLink({ subject: 'Payment successful — order 12345', text: 'Thank you. View your receipt: https://pay.classvaluation.com/receipt/1', html: '', link: 'https://pay.classvaluation.com/receipt/1' }), false, 'a "payment successful" note with a receipt link is never "how to pay"');
    eq(plink.looksLikePaymentLink({ subject: 'Order 12345', text: 'Thank you for your payment of $550. View receipt: https://pay.classvaluation.com/r/1', html: '', link: 'https://pay.classvaluation.com/r/1' }), false, 'nor is a receipt whose subject does not say so');
    eq(plink.looksLikePaymentLink({ subject: 'Order 12345', text: 'Please click below.', html: '<a href="https://pay.classvaluation.com/x">Open</a>', link: 'https://pay.classvaluation.com/x' }), false, 'a link on its own, with no payment wording, is not the link');
    eq(plink.looksLikePaymentLink({ subject: 'Payment link for order 12345', text: 'x', html: '', link: 'https://pay.classvaluation.com/p/1' }), true, '"payment link for order" is the link');
    eq(plink.looksLikePaymentLink({ subject: 'Your appraisal payment', text: 'Please pay here: https://pay.classvaluation.com/p/1', html: '', link: 'https://pay.classvaluation.com/p/1' }), true, 'and so is "please pay here"');
    eq(plink.looksLikePaymentLink({ subject: 'Your appraisal payment', text: 'Your payment of $550 was received. Pay here if a balance remains: https://pay.classvaluation.com/p/1', html: '', link: 'https://pay.classvaluation.com/p/1' }), true, 'an email that asks for a payment is the link even when it also mentions one received');
    // Re-audit 2026-09-03: a genuine link that mentions a receipt in passing must never be refused
    // (machine-stamped, it would otherwise be filed as an auto-reply and nobody told).
    eq(plink.looksLikePaymentLink({ subject: 'Payment Required for Order #12345', text: 'Payment is required before the appraisal can be scheduled. Click the button below. A receipt will be emailed once payment is complete. https://pay.classvaluation.com/p/1', html: '', link: 'https://pay.classvaluation.com/p/1' }), true, '"payment is required … a receipt will be emailed" is the link');
    eq(plink.looksLikePaymentLink({ subject: 'Invoice 123', text: 'Amount: $550. Due on receipt. https://pay.classvaluation.com/p/1', html: '', link: 'https://pay.classvaluation.com/p/1' }), true, 'an invoice-worded email carrying the pay link, "due on receipt", is the link');
    eq(plink.looksLikePaymentLink({ subject: 'Order #12345', text: 'Your payment has been processed. Receipt: https://pay.classvaluation.com/r/1', html: '', link: 'https://pay.classvaluation.com/r/1' }), false, 'while "your payment has been processed" is still a receipt');
    // Post-merge audit of #1431: receipts whose SUBJECT is only the order number.
    eq(plink.looksLikePaymentLink({ subject: 'Order 555', text: 'We have received your payment of $550.', html: '', link: null }), false, '"we have received your payment" under a neutral subject is a receipt');
    eq(plink.looksLikePaymentLink({ subject: 'Order 555', text: 'Your payment has been completed. https://pay.classvaluation.com/r/1', html: '', link: 'https://pay.classvaluation.com/r/1' }), false, 'and so is "your payment has been completed"');
    eq(plink.namesOrder('Payment link for order 555 (ref YSCAP-abc)', '555'), true, 'an order number in the subject names the order');
    eq(plink.namesOrder('Your payment of $5550 is due', '555'), false, 'but a digit run inside another number does not');
    eq(plink.namesOrder('ref YSCAP-abc', 'YSCAP-abc'), true, 'and our reference names it too');
    eq(plink.namesOrder('order 12', '12'), false, 'a two-character key never matches (too easy to hit by accident)');
    eq(plink.extractLink('', '<a href="https://www.classvaluation.com">Class</a> <a href="https://secure.processor.test/pay/9">Pay</a>'), 'https://secure.processor.test/pay/9', 'a footer link to their home page never beats the pay link');

    // The forward itself over a stubbed db + mailer: one email, borrower To, team Cc.
    const outbox = [];
    const writes = [];
    const dbh = { query: async (sql, params) => {
      if (/FROM class_orders/.test(sql)) return { rows: [{ id: 9, class_order_id: '555', reference_number: 'YS-1', payment_recipient_email: params[1], payment_link_forwarded_to: null }] };
      if (/FROM applications a/.test(sql)) return { rows: [{ b_email: 'Ada@example.com', c_email: null, lo_email: 'lo@ys.test', pr_email: 'pr@ys.test', lo_active: true, pr_active: true, lo_ext: false, pr_ext: false }] };
      if (/FROM application_assignees/.test(sql)) return { rows: [{ email: 'broker@firm.test', staff_id: 'x' }] .filter(() => false) };
      if (/UPDATE class_orders/.test(sql)) { writes.push({ sql, params }); return { rows: [] }; }
      return { rows: [] };
    } };
    const mailer = { sendMail: async (m) => { outbox.push(m); return { ok: true }; } };
    const appId = '0f3e1e3a-1111-4c9e-8b1c-000000000001';
    const res = await plink.handleInbound({ applicationId: appId, fromEmail: 'noreply@classvaluation.com', subject: 'Payment for order 555',
      text: 'Please pay for your appraisal: https://pay.classvaluation.com/p/abc123', html: '', inboundId: 'em-1' }, { db: dbh, mailer });
    eq(res.handled, true, 'a Class email on the file mailbox is handled');
    eq(outbox.length, 1, 'ONE email goes out');
    eq(outbox[0].to, ['ada@example.com'], 'to the borrower');
    eq(outbox[0].cc, ['lo@ys.test', 'pr@ys.test'], 'with the loan officer and processor VISIBLY copied');
    ok(/pay\.classvaluation\.com\/p\/abc123/.test(outbox[0].html), 'and the payment page is in it');
    ok(/Pay for the appraisal/.test(outbox[0].html), 'as a button');
    eq(outbox[0].replyTo, `file+${appId}@reply.test`, 'replies come back to the file mailbox');
    ok(writes[0] && /payment_link_forwarded_at = now\(\)/.test(writes[0].sql), 'the forward is recorded on the order');
    ok(writes[0] && JSON.parse(writes[0].params[1]).inboundId === 'em-1', 'keyed on the delivery id');
    const noBorrower = { query: async (sql, params) => {
      if (/FROM class_orders/.test(sql)) return { rows: [{ id: 9, class_order_id: '555', payment_recipient_email: params[1], payment_link_forwarded_to: null }] };
      if (/FROM applications a/.test(sql)) return { rows: [{ b_email: 'noemail+1@clickup.local', c_email: null, lo_email: 'lo@ys.test', pr_email: null, lo_active: true, lo_ext: false }] };
      return { rows: [] };
    } };
    const nb = await plink.handleInbound({ applicationId: appId, fromEmail: 'noreply@classvaluation.com', subject: 'Payment', text: 'pay https://pay.classvaluation.com/p/z', html: '', inboundId: 'em-3' }, { db: noBorrower, mailer });
    eq(nb.handled === false && nb.reason, 'no_borrower_email', 'with no borrower address the borrower-voiced email is not sent to the team instead');
    const receipt = await plink.handleInbound({ applicationId: appId, fromEmail: 'noreply@classvaluation.com', subject: 'Receipt for your payment', text: 'Thank you for your payment', html: '', inboundId: 'em-4' }, { db: dbh, mailer });
    eq(receipt.handled === false && receipt.reason, 'not_a_payment_link', 'a receipt from Class is left to the ordinary file forward');
    const notVendor = await plink.handleInbound({ applicationId: appId, fromEmail: 'ada@example.com', subject: 's', text: 't', html: '', inboundId: 'em-2' }, { db: dbh, mailer });
    eq(notVendor.handled, false, 'an ordinary reply on the same mailbox is left to the file forward');
    eq(outbox.length, 1, 'and sends nothing here');
    // A redelivery of the same email never sends three people the same link twice.
    const dup = { query: async (sql, params) => {
      if (/FROM class_orders/.test(sql)) return { rows: [{ id: 9, class_order_id: '555', payment_recipient_email: params[1], payment_link_forwarded_to: { inboundId: 'em-1', to: ['ada@example.com'], cc: [] } }] };
      return { rows: [] };
    } };
    const again = await plink.handleInbound({ applicationId: appId, fromEmail: 'noreply@classvaluation.com', subject: 's', text: 'x https://pay.classvaluation.com/p/abc123', html: '', inboundId: 'em-1' }, { db: dup, mailer });
    eq(again.handled && again.duplicate, true, 'a redelivered webhook is recognised');
    eq(outbox.length, 1, 'and nothing is sent again');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- the order carries HOW it is paid ---');
  {
    const base = {
      referenceNumber: 'YS-1', productId: 'p1',
      property: { addressLine: '1 Main St', city: 'Brooklyn', state: 'NY', postalCode: '11201', county: 'Kings', category: 'sfr', categoryLabel: 'SFR', occupancy: 'investment' },
      loan: { loanNumber: 'YS-1', loanAmount: 100000, purchaseAmount: 150000, loanType: 'purchase' },
      borrower: { firstName: 'A', lastName: 'B', email: 'ab@example.com', mobile: '5555555555' },
      lender: { clientName: 'YS Capital Group' }, notifyEmails: [],
      paymentMethod: 'PaymentLink', paymentEmail: 'file+0f3e1e3a-1111-4c9e-8b1c-000000000001@reply.test',
    };
    // NO INVOICING (owner-directed 2026-09-03). The link is the default and it is addressed
    // to the file's own mailbox; an explicit Invoice is refused in words, never sent.
    const dflt = orderBuild.buildOrder(base);
    eq(dflt.body.paymentDetails, { paymentMethod: 'PaymentLink', recipientEmail: 'file+0f3e1e3a-1111-4c9e-8b1c-000000000001@reply.test' },
      'the payment link is the default, addressed to the file mailbox');
    const inv = orderBuild.buildOrder(base, { paymentMethod: 'Invoice' });
    ok(inv.missing.some((m) => m.field === 'paymentDetails.paymentMethod' && /does not accept invoicing/.test(m.why)), 'Invoice is refused, and the reason says so');
    ok(inv.body.paymentDetails.paymentMethod !== 'Invoice', 'and no invoice body can leave');
    eq(orderBuild.normalizePaymentMethod('invoice'), null, 'normalisation cannot fold anything into Invoice');
    const link = orderBuild.buildOrder(base, { paymentMethod: 'PaymentLink', paymentEmail: 'ab@example.com' });
    eq(link.body.paymentDetails, { paymentMethod: 'PaymentLink', recipientEmail: 'ab@example.com' }, 'a staffer may point the link at one address instead');
    ok(link.overridden.includes('paymentMethod'), 'and the screen\'s choice is recorded as an override');
    const pre = orderBuild.buildOrder(base, { paymentMethod: 'Prepay' });
    eq(pre.body.paymentDetails, { paymentMethod: 'Prepay' }, 'prepaid is the one other choice, and carries no address');
    const other = orderBuild.buildOrder(base, { paymentMethod: 'payment link', paymentEmail: 'lo@ys.com' });
    eq(other.body.paymentDetails, { paymentMethod: 'PaymentLink', recipientEmail: 'lo@ys.com' }, 'a loosely typed method folds to their casing; a named address wins');
    const noMail = orderBuild.buildOrder({ ...base, borrower: { ...base.borrower, email: null }, paymentEmail: null }, { paymentMethod: 'PaymentLink' });
    ok(noMail.missing.some((m) => m.field === 'paymentDetails.recipientEmail'), 'a payment link with nobody to send it to BLOCKS the order');
    ok(!noMail.body.paymentDetails.recipientEmail, 'and no blank address is sent');
    const bad = orderBuild.buildOrder(base, { paymentMethod: 'Bitcoin' });
    ok(bad.missing.some((m) => m.field === 'paymentDetails.paymentMethod'), 'a method Class does not have blocks the order with the two it does');
    eq(orderBuild.screenOptions('v1').paymentMethods, ['PaymentLink', 'Prepay'], 'the screen is offered exactly the two — Invoice is not on it');
    eq(payment.PAYMENT_METHODS, ['PaymentLink', 'Prepay'], 'and the payment module carries the same two, from the one definition');
    const sum = orderBuild.orderSummary({ request_body: link.body });
    ok(sum.some((r) => r.label === 'Paid by' && /Payment link/.test(r.value) && /ab@example.com/.test(r.value)), 'the stored order says how it was to be paid');
    const sumBox = orderBuild.orderSummary({ request_body: dflt.body });
    ok(sumBox.some((r) => r.label === 'Paid by' && /forwarded by PILOT to the borrower, the loan officer and the processor/.test(r.value)), 'and a mailbox-addressed link says who PILOT forwards it to');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- the money picture: payment-details → our columns ---');
  {
    const p = payment.parsePaymentDetails({ clientFee: 550, additionalFees: [{ description: 'Rush', amount: 100.5, date: 'd' }], totalAmount: 650.5, paidAmount: 100, outstandingBalance: 550.5 });
    eq([p.client_fee_cents, p.total_cents, p.paid_cents, p.outstanding_cents], [55000, 65050, 10000, 55050], 'dollars become cents, exactly');
    eq(p.additional_fees, [{ description: 'Rush', amount_cents: 10050, date: 'd' }], 'additional fees are kept, in cents');
    const wrapped = payment.parsePaymentDetails({ data: { ClientFee: 1, TotalAmount: 1, PaidAmount: 1, OutstandingBalance: 0 } });
    eq([wrapped.client_fee_cents, wrapped.outstanding_cents], [100, 0], 'a `data` envelope and PascalCase keys are read too');
    eq(Object.keys(payment.parsePaymentDetails({})), [], 'a reply with nothing in it changes nothing');
    ok(/Paid in full/.test(payment.describeBalance({ outstanding_cents: 0, total_cents: 65000 })), 'a zero balance on a priced order reads as paid');
    ok(/\$550\.00 still owed/.test(payment.describeBalance({ outstanding_cents: 55000, payment_method: 'Invoice' })), 'an open balance says the amount');
    ok(/emailed the borrower/.test(payment.describeBalance({ outstanding_cents: 55000, payment_method: 'PaymentLink', payment_link_sent_at: 'x' })), 'and, on a payment link, whether the link went out');
    eq(payment.describeBalance({}), null, 'nothing known → no sentence');
  }

  console.log('\n--- refreshOrder + recordCardPayment over a stubbed db ---');
  {
    const updates = [];
    const dbh = { query: async (sql, params) => { updates.push({ sql, params }); return { rows: [{ id: 9, class_order_id: '77', outstanding_cents: 55000, total_cents: 65000 }] }; } };
    calls = [];
    const fresh = await payment.refreshOrder(dbh, { id: 9, class_order_id: '77', payment_checked_at: null }, { force: true });
    eq(fresh.ok && fresh.fresh, true, 'a forced refresh reads the vendor');
    ok(calls.some((c) => /\/orders\/77\/payment-details$/.test(c.url)), 'from GET /orders/{id}/payment-details');
    ok(updates[0] && /UPDATE class_orders SET/.test(updates[0].sql) && /outstanding_cents/.test(updates[0].sql), 'and writes the balance columns');
    ok(updates[0] && /payment_checked_at = now\(\)/.test(updates[0].sql), 'stamping when it was checked');
    ok(updates[0] && !/paid_at/.test(updates[0].sql), 'an open balance never marks paid');

    const throttled = await payment.refreshOrder(dbh, { id: 9, class_order_id: '77', payment_checked_at: new Date().toISOString() });
    eq(throttled.fresh, false, 'a recent read is not repeated on a poll');
    const unnumbered = await payment.refreshOrder(dbh, { id: 9, class_order_id: null });
    eq(unnumbered.error, 'not_numbered', 'an order Class has not numbered has no balance to read');

    calls = [];
    const rec = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { nameCardHolder: 'A B', amount: '650.5', last4: '4242', authorizationCode: 'AUTH1' });
    eq(rec.ok, true, 'a card charge taken elsewhere is recorded');
    const post = calls.find((c) => /add-creditcard-payment$/.test(c.url));
    ok(post && post.method === 'POST', 'via POST /orders/{id}/add-creditcard-payment');
    eq(post && JSON.parse(post.body), { nameCardHolder: 'A B', amount: 650.5, cardNumber: '4242', authorizationCode: 'AUTH1' }, 'with exactly their four fields — the last four, never a card number');
    const badFour = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { nameCardHolder: 'A B', authorizationCode: 'A1', amount: 10, last4: '4111111111111111' });
    eq(badFour.ok && badFour.body.cardNumber, '1111', 'a full card number is cut to its last four before it can leave');
    const badAmt = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { nameCardHolder: 'A B', authorizationCode: 'A1', amount: 'ten', last4: '4242' });
    eq(badAmt.error, 'bad_amount', 'a non-number amount is refused here');
    const noName = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { amount: 10, last4: '4242', authorizationCode: 'A1' });
    eq(noName.error, 'bad_name', 'a charge with no name on the card is refused (pre-merge audit: it used to send null)');
    const noAuth = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { nameCardHolder: 'A B', amount: 10, last4: '4242' });
    eq(noAuth.error, 'bad_auth_code', 'and one with no authorisation code — a record nobody can reconcile');
  }

  console.log('\n--- the fee before ordering is history, and says so ---');
  {
    const dbh = { query: async () => ({ rows: [
      { product_id: 'p1', client_fee_cents: 55000, placed_at: '2026-09-01' },
      { product_id: 'p1', client_fee_cents: 52500, placed_at: '2026-08-01' },
      { product_id: 'p2', client_fee_cents: 70000, placed_at: '2026-08-15' },
    ] }) };
    const fees = await payment.recentFees(dbh);
    eq(fees.p1, { lastCents: 55000, count: 2, lowCents: 52500, highCents: 55000 }, 'the last fee, and the range, per product');
    eq(fees.p2.count, 1, 'a product seen once');
    eq(fees.p3, undefined, 'a product never ordered has no estimate — the screen must not invent one');
  }

  console.log(`\ntest-class-outbound-payment-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
