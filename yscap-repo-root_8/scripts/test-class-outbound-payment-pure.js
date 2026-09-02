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
  console.log('\n--- the order carries HOW it is paid ---');
  {
    const base = {
      referenceNumber: 'YS-1', productId: 'p1',
      property: { addressLine: '1 Main St', city: 'Brooklyn', state: 'NY', postalCode: '11201', county: 'Kings', category: 'sfr', categoryLabel: 'SFR', occupancy: 'investment' },
      loan: { loanNumber: 'YS-1', loanAmount: 100000, purchaseAmount: 150000, loanType: 'purchase' },
      borrower: { firstName: 'A', lastName: 'B', email: 'ab@example.com', mobile: '5555555555' },
      lender: { clientName: 'YS Capital Group' }, notifyEmails: [],
      paymentMethod: 'Invoice', paymentEmail: 'ab@example.com',
    };
    const inv = orderBuild.buildOrder(base);
    eq(inv.body.paymentDetails, { paymentMethod: 'Invoice' }, 'Invoice by default, and no recipient email rides with it');
    const link = orderBuild.buildOrder(base, { paymentMethod: 'PaymentLink' });
    eq(link.body.paymentDetails, { paymentMethod: 'PaymentLink', recipientEmail: 'ab@example.com' }, 'a payment link goes to the borrower\'s email');
    ok(link.overridden.includes('paymentMethod'), 'and the screen\'s choice is recorded as an override');
    const other = orderBuild.buildOrder(base, { paymentMethod: 'payment link', paymentEmail: 'lo@ys.com' });
    eq(other.body.paymentDetails, { paymentMethod: 'PaymentLink', recipientEmail: 'lo@ys.com' }, 'a loosely typed method folds to their casing; a named address wins');
    const noMail = orderBuild.buildOrder({ ...base, borrower: { ...base.borrower, email: null }, paymentEmail: null }, { paymentMethod: 'PaymentLink' });
    ok(noMail.missing.some((m) => m.field === 'paymentDetails.recipientEmail'), 'a payment link with nobody to send it to BLOCKS the order');
    ok(!noMail.body.paymentDetails.recipientEmail, 'and no blank address is sent');
    const bad = orderBuild.buildOrder(base, { paymentMethod: 'Bitcoin' });
    ok(bad.missing.some((m) => m.field === 'paymentDetails.paymentMethod'), 'a method Class does not have blocks the order with the three it does');
    eq(orderBuild.screenOptions('v1').paymentMethods, ['Invoice', 'PaymentLink', 'Prepay'], 'the screen is offered exactly their three');
    const sum = orderBuild.orderSummary({ request_body: link.body });
    ok(sum.some((r) => r.label === 'Paid by' && /Payment link/.test(r.value) && /ab@example.com/.test(r.value)), 'the stored order says how it was to be paid');
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
    const badFour = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { amount: 10, last4: '4111111111111111' });
    eq(badFour.ok && badFour.body.cardNumber, '1111', 'a full card number is cut to its last four before it can leave');
    const badAmt = await payment.recordCardPayment(dbh, { id: 9, class_order_id: '77' }, { amount: 'ten', last4: '4242' });
    eq(badAmt.error, 'bad_amount', 'a non-number amount is refused here');
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
