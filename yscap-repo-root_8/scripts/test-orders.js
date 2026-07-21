'use strict';
/* Orders desk (#orders) — pure logic: per-order reply-to addressing, order-email
   building (merge fields, mortgage clause, subject), gating and recipient/CC
   assembly. NO DB. Run: node scripts/test-orders.js */

// The per-order reply addresses only exist when a reply domain is configured, so
// set it BEFORE config/file-address are required (config reads env at load).
process.env.CHAT_REPLY_DOMAIN = 'reply.yscapgroup.com';

const assert = require('assert');
const { orderReplyTo, orderRefFromRecipient, fileReplyTo } = require('../src/lib/file-address');
const orders = require('../src/lib/orders');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const APP = '11111111-1111-1111-1111-111111111111';

/* ---- per-order reply-to addressing ---- */
assert.strictEqual(orderReplyTo(APP, 'title'), `title+${APP}@reply.yscapgroup.com`);
assert.strictEqual(orderReplyTo(APP, 'insurance'), `insurance+${APP}@reply.yscapgroup.com`);
assert.strictEqual(orderReplyTo(APP, 'bogus'), null, 'unknown order kind → no address');
assert.strictEqual(orderReplyTo('not-a-uuid', 'title'), null, 'bad id → no address');
ok('orderReplyTo builds title+/insurance+ addresses (and rejects bad input)');

// Round-trips back to {applicationId, orderType}, case-insensitively.
assert.deepStrictEqual(orderRefFromRecipient(`TITLE+${APP.toUpperCase()}@reply.yscapgroup.com`), { applicationId: APP, orderType: 'title' });
assert.deepStrictEqual(orderRefFromRecipient(`insurance+${APP}@reply.yscapgroup.com`), { applicationId: APP, orderType: 'insurance' });
assert.strictEqual(orderRefFromRecipient(`file+${APP}@reply.yscapgroup.com`), null, 'a plain file+ address is NOT an order address');
assert.strictEqual(orderRefFromRecipient(`title+${APP}@evil.com`), null, 'wrong domain is rejected');
ok('orderRefFromRecipient parses order addresses and rejects file+/wrong-domain');

// The order addresses never collide with the generic file reply-to.
assert.strictEqual(fileReplyTo(APP), `file+${APP}@reply.yscapgroup.com`);
assert.notStrictEqual(fileReplyTo(APP), orderReplyTo(APP, 'title'));
ok('the file reply-to and the order reply-to are distinct addresses');

/* ---- order data helpers ---- */
assert.strictEqual(orders.transactionType('Purchase'), 'Purchase');
assert.strictEqual(orders.transactionType('rate_term_refi'), 'Refinance');
assert.strictEqual(orders.propertyLine({ street: '123 Main St', city: 'Brooklyn', state: 'NY', zip: '11211' }), '123 Main St, Brooklyn, NY 11211');
ok('transactionType + propertyLine format correctly');

/* ---- gating (blockers) ---- */
const base = {
  appId: APP, loanNumber: 'YSCAP1042', hasLoanNumber: true,
  propertyLine: '123 Main St, Brooklyn, NY 11211', transactionType: 'Purchase',
  borrowerName: 'John Smith', borrowerEmail: 'john@example.com', coBorrowerEmail: null,
  dob: '01/02/1980', entityName: 'Smith Holdings LLC', loanAmount: '$500,000',
  officer: { name: 'Chaim Klein', email: 'lo@yscapgroup.com' },
  processor: { name: 'Pat Proc', email: 'proc@yscapgroup.com' },
  vendors: {
    title: { id: 't1', company_name: 'ABC Title', contact_name: 'Jane Doe', email: 'title@abc.com', phone: '555-1000' },
    insurance: null,
  },
};
assert.deepStrictEqual(orders.blockers('title', base), [], 'title is ready (loan# + contact present)');
assert.deepStrictEqual(orders.blockers('insurance', base), ['contact'], 'insurance blocked — no agent');
assert.deepStrictEqual(orders.blockers('title', { ...base, hasLoanNumber: false }), ['loan_number'], 'no loan number blocks');
const noEmail = { ...base, vendors: { ...base.vendors, title: { ...base.vendors.title, email: '' } } };
assert.deepStrictEqual(orders.blockers('title', noEmail), ['contact'], 'a contact with no email still blocks');
ok('blockers gate on loan number AND a vendor contact with an email');

/* ---- title order email ---- */
const t = orders.buildOrderEmail('title', base, {});
assert.ok(/Title Order Request/.test(t.subject), 'subject names the order');
assert.ok(t.subject.includes('YSCAP1042'), 'subject carries the loan number');
assert.ok(t.subject.includes('123 Main St'), 'subject carries the property');
assert.ok(t.html.includes('ISAOA/ATIMA') && t.html.includes('YS Capital Group'), 'mortgagee clause present');
assert.ok(t.html.includes('Loan Number: YSCAP1042'), 'mortgage clause carries the loan number');
assert.ok(t.html.includes('Smith Holdings LLC'), 'borrowing entity present');
assert.ok(t.html.includes('Jane Doe') || t.html.includes('ABC Title'), 'greets the vendor');
ok('title order email: subject + mortgage clause + loan# + entity + vendor greeting');

/* ---- insurance order email ---- */
const insData = { ...base, vendors: { title: null, insurance: { id: 'i1', company_name: 'SafeCo', email: 'ins@safeco.com' } } };
const i = orders.buildOrderEmail('insurance', insData, {});
assert.ok(/Insurance Order Request/.test(i.subject), 'insurance subject');
assert.ok(i.html.includes('Builders Risk'), 'insurance asks for a Builders Risk policy');
assert.ok(i.html.includes('01/02/1980'), 'insurance carries borrower DOB');
assert.ok(i.html.includes('ISAOA/ATIMA'), 'insurance carries the mortgage clause too');
ok('insurance order email: Builders Risk + DOB + mortgage clause');

/* ---- follow-up email (separate, on-demand) ---- */
const fu = orders.buildOrderEmail('title', base, { followup: true });
assert.ok(/Follow-up/.test(fu.subject), 'follow-up subject is distinct');
assert.ok(fu.html.includes('CPL') && fu.html.includes('Title Commitment'), 'title follow-up lists the deliverables');
const fuNote = orders.buildOrderEmail('insurance', insData, { followup: true, note: 'Any update on the binder?' });
assert.ok(fuNote.html.includes('Any update on the binder?'), 'a custom follow-up message is used');
ok('follow-up email is separate, lists deliverables, and honors a custom message');

/* ---- recipient / CC assembly ---- */
const r = orders.recipientsFor('title', base);
assert.deepStrictEqual(r.to, ['title@abc.com'], 'TO is the vendor');
assert.ok(r.cc.includes('john@example.com'), 'borrower is CC');
assert.ok(r.cc.includes('lo@yscapgroup.com'), 'loan officer is CC');
assert.ok(r.cc.includes('proc@yscapgroup.com'), 'processor is CC');
assert.ok(!r.cc.includes('title@abc.com'), 'the vendor is never also CC');
assert.strictEqual(r.replyTo, `title+${APP}@reply.yscapgroup.com`, 'reply-to is the unique order address');
// CC de-dupes case-insensitively (borrower == officer edge case).
const dupCc = orders.recipientsFor('title', { ...base, officer: { name: 'x', email: 'JOHN@example.com' } });
assert.strictEqual(dupCc.cc.filter((e) => e === 'john@example.com').length, 1, 'CC is deduped case-insensitively');
ok('recipients: vendor=TO, borrower/LO/processor=CC (deduped), unique reply-to');

console.log(`\n${n} checks passed`);
