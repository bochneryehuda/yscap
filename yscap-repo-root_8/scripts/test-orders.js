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
// The loan officer signs the order + appears as the branded contact card.
assert.ok(t.html.includes('Chaim Klein'), 'the loan officer signs / appears on the order');
ok('title order email: subject + mortgage clause + loan# + entity + vendor greeting + officer card');

// With no officer on file the email still builds (card + signature simply omit the name).
const noOfficer = orders.buildOrderEmail('title', { ...base, officer: null }, {});
assert.ok(noOfficer.html.includes('YS Capital Group'), 'a file with no officer still signs from YS Capital');
ok('order email is robust when the file has no loan officer');

/* ---- insurance order email ---- */
const insData = { ...base, vendors: { title: null, insurance: { id: 'i1', company_name: 'SafeCo', email: 'ins@safeco.com' } } };
const i = orders.buildOrderEmail('insurance', insData, {});
assert.ok(/Insurance Order Request/.test(i.subject), 'insurance subject');
assert.ok(i.html.includes('Builders Risk'), 'insurance asks for a Builders Risk policy');
assert.ok(i.html.includes('01/02/1980'), 'insurance carries borrower DOB');
assert.ok(i.html.includes('ISAOA/ATIMA'), 'insurance carries the mortgage clause too');
ok('insurance order email: Builders Risk + DOB + mortgage clause');

/* ---- BOTH coverages are named, in the industry's own terms (owner-directed
   2026-08-07: "we need builders' risk coverage and vacant property coverage").
   The vacancy half is the one that has to be named PRECISELY: every standard
   property form carries a vacancy clause that guts coverage on a vacant building,
   and the fix has a name — a vacancy permit / vacancy permission endorsement.
   Asking for "coverage on a vacant property" without naming it is how a binder
   arrives that reads fine and pays nothing. ---- */
assert.ok(/Course of Construction/i.test(i.html), 'the Builders Risk ask names Course of Construction');
assert.ok(/replacement cost/i.test(i.html), 'it asks for replacement cost');
assert.ok(/renovation and construction work expressly permitted/i.test(i.html),
  'it states renovations are permitted — without it a property form excludes the work itself');
assert.ok(/vacancy permit/i.test(i.html) && /vacancy permission endorsement/i.test(i.html),
  'the vacant-property ask names the vacancy permit / vacancy permission endorsement');
assert.ok(/vacancy clause/i.test(i.html), 'and says the vacancy clause must not apply');
assert.ok(/30 days/i.test(i.html), 'it asks for 30 days notice of cancellation to the mortgagee');
// A TITLE order has no coverage to request and must not grow one.
assert.ok(!/vacancy permit/i.test(t.html), 'a title order carries no coverage section');
ok('insurance order names BOTH coverages precisely; title order unaffected');

/* ---- The details the agency kept writing back for (owner-reported 2026-08-07: a
   live reply asked for the borrower's mailing address, phone, email, closing date,
   purchase price and rehab cost — all of which PILOT already held). ---- */
const insFull = orders.buildOrderEmail('insurance', {
  ...insData,
  borrowerMailingAddress: '12 Elm St, Beachwood, OH 44122',
  borrowerPhone: '216-555-0142',
  expectedClosing: '2026-08-21',
  purchasePrice: 200000,
  rehabBudget: 45000,
}, {});
assert.ok(insFull.html.includes('12 Elm St, Beachwood, OH 44122'), 'the mailing address is stated');
assert.ok(/Mailing Address/i.test(insFull.html) && /home address/i.test(insFull.html),
  'and it is LABELLED as the borrower\'s home address — a policy on a vacant house cannot be mailed to it');
assert.ok(insFull.html.includes('216-555-0142'), 'the borrower phone is stated');
assert.ok(insFull.html.includes('ins@example.com') || /Borrower Email/i.test(insFull.html), 'the borrower email row is present');
assert.ok(insFull.html.includes('August 21, 2026'), 'the estimated closing date is stated in plain English');
assert.ok(insFull.html.includes('$200,000'), 'the purchase price is stated');
assert.ok(insFull.html.includes('$45,000'), 'the rehab / construction cost is stated');
assert.ok(/Named Insured/i.test(insFull.html), 'the entity is labelled the Named Insured');
ok('the insurance order states every detail the agency asked for');

/* A value we do NOT hold is OMITTED, never printed blank or guessed — a row reading
   "Purchase Price: —" teaches an agent our numbers are unreliable and invites the
   very reply this exists to prevent. `insData` carries none of the six. */
assert.ok(!/Borrower Phone/i.test(i.html), 'no phone on file → no phone row at all');
assert.ok(!/Estimated Closing Date/i.test(i.html), 'no closing date on file → no date row at all');
assert.ok(!/Purchase Price/i.test(i.html), 'no price on file → no price row at all');
assert.ok(!/Rehab \/ Construction Cost/i.test(i.html), 'no rehab budget on file → no rehab row at all');
assert.ok(!/—/.test(orders.insuranceDetailMeta({}).map((r) => r.value).join('')),
  'insuranceDetailMeta never emits a placeholder value');
assert.deepStrictEqual(orders.insuranceDetailMeta({}), [], 'a file with none of the details emits no rows');
// The date is CALENDAR-STRING formatted — never `new Date('YYYY-MM-DD')`, which
// shifts a date-only value by the server's timezone (the standing date rule).
assert.strictEqual(orders.dayText('2026-01-01'), 'January 1, 2026', 'a New Year date does not slip a day');
assert.strictEqual(orders.dayText('2026-12-31'), 'December 31, 2026', 'a year-end date does not slip a day');
assert.strictEqual(orders.dayText(null), null, 'no date → nothing to print');
assert.strictEqual(orders.dayText('nonsense'), null, 'an unreadable date prints nothing, never "Invalid Date"');
ok('a detail we do not hold is omitted, and dates never slip a day');

/* The same details ride the FOLLOW-UP, which is precisely when an agent is waiting
   on them — shared helper, so the order and the follow-up can never disagree. */
const insFollow = orders.buildOrderEmail('insurance', {
  ...insData, borrowerPhone: '216-555-0142', purchasePrice: 200000,
}, { followup: true });
assert.ok(insFollow.html.includes('216-555-0142') && insFollow.html.includes('$200,000'),
  'the insurance follow-up restates the borrower/deal details');
const titleFollow = orders.buildOrderEmail('title', { ...base, purchasePrice: 200000 }, { followup: true });
assert.ok(!titleFollow.html.includes('$200,000'), 'a title follow-up is unaffected');
ok('the insurance follow-up carries the same details; title is untouched');

/* ---- #18: RCN note buyer swaps the mortgagee clause (order email only) ---- */
// No note buyer (or any non-RCN buyer) → the standard YS Capital clause.
assert.deepStrictEqual(orders.mortgageeClauseFor(null), orders.MORTGAGEE_CLAUSE, 'no note buyer → standard clause');
assert.deepStrictEqual(orders.mortgageeClauseFor('Blue Lake'), orders.MORTGAGEE_CLAUSE, 'a non-RCN note buyer → standard clause');
// RCN, in every spelling ClickUp sends, → the Elite Commercial Servicing clause.
for (const spelling of ['RCN', 'rcn', 'RCN Capital', 'RCN Capital, LLC', ' rcn  capital ']) {
  assert.ok(orders.isRcnNoteBuyer(spelling), `RCN detected: "${spelling}"`);
  assert.deepStrictEqual(orders.mortgageeClauseFor(spelling), orders.MORTGAGEE_CLAUSE_RCN, `RCN → servicer clause: "${spelling}"`);
}
// No false positive (a wrong servicer on an order is expensive).
assert.ok(!orders.isRcnNoteBuyer('Churchill'), 'a non-RCN buyer is not treated as RCN');
assert.ok(!orders.isRcnNoteBuyer(''), 'a blank note buyer is not RCN');
// The exact owner-provided servicer address.
assert.deepStrictEqual(orders.MORTGAGEE_CLAUSE_RCN, [
  'YS Capital Group, ISAOA ATIMA',
  'c/o Elite Commercial Servicing, LLC',
  'PO Box 15126',
  'Richmond, VA 23227-0526',
], 'the RCN clause is the owner-provided servicer address');
// End to end: the ORDER EMAIL carries the RCN clause when the file's note buyer is RCN — both order types.
const rcnIns = orders.buildOrderEmail('insurance', { ...insData, lender: 'RCN Capital' }, {});
assert.ok(rcnIns.html.includes('Elite Commercial Servicing') && rcnIns.html.includes('Richmond, VA 23227-0526'), 'RCN insurance order carries the servicer clause');
assert.ok(!rcnIns.html.includes('5 New Montrose'), 'the RCN order does NOT carry the standard Brooklyn address');
assert.ok(rcnIns.html.includes('Loan Number: YSCAP1042'), 'the RCN clause still carries the loan number');
const rcnTitle = orders.buildOrderEmail('title', { ...base, lender: 'RCN' }, {});
assert.ok(rcnTitle.html.includes('Elite Commercial Servicing'), 'RCN title order carries the servicer clause too');
// Regression: a non-RCN file still gets the standard clause.
assert.ok(i.html.includes('5 New Montrose') && !i.html.includes('Elite Commercial Servicing'), 'a non-RCN insurance order keeps the standard clause');
ok('#18: RCN note buyer swaps the mortgagee clause to the Elite Commercial Servicing address (order email only)');

/* ---- follow-up email (separate, on-demand) ---- */
const fu = orders.buildOrderEmail('title', base, { followup: true });
assert.ok(/Follow-up/.test(fu.subject), 'follow-up subject is distinct');
assert.ok(fu.html.includes('CPL') && fu.html.includes('Title Commitment'), 'title follow-up lists the deliverables');
const fuNote = orders.buildOrderEmail('insurance', insData, { followup: true, note: 'Any update on the binder?' });
assert.ok(fuNote.html.includes('Any update on the binder?'), 'a custom follow-up message is used');
ok('follow-up email is separate, lists deliverables, and honors a custom message');

/* ---- recipient / CC assembly (owner-directed 2026-07-31: the borrower is NOT
   CC'd on the TITLE order by default; a per-order choice or the LO's own
   setting turns it on. Insurance keeps its borrower CC by default.) ---- */
const r = orders.recipientsFor('title', base);
assert.deepStrictEqual(r.to, ['title@abc.com'], 'TO is the vendor');
assert.ok(!r.cc.includes('john@example.com'), 'borrower is NOT CC on a title order by default');
assert.strictEqual(r.ccBorrower, false, 'the effective ccBorrower flag reports off');
assert.ok(r.cc.includes('lo@yscapgroup.com'), 'loan officer is CC');
assert.ok(r.cc.includes('proc@yscapgroup.com'), 'processor is CC');
assert.ok(!r.cc.includes('title@abc.com'), 'the vendor is never also CC');
assert.strictEqual(r.replyTo, `title+${APP}@reply.yscapgroup.com`, 'reply-to is the unique order address');
// The explicit per-order choice wins…
const rOn = orders.recipientsFor('title', base, { ccBorrower: true });
assert.ok(rOn.cc.includes('john@example.com'), 'ccBorrower:true loops the borrower in on a title order');
// …and the officer's own default (lo-settings) turns title on when set.
const rLo = orders.recipientsFor('title', base, { loCcSetting: true });
assert.ok(rLo.cc.includes('john@example.com'), 'the LO setting defaults the borrower CC on');
assert.strictEqual(orders.ccBorrowerDefault('title'), false, 'title default is OFF with no setting');
// Company default is now OFF for EVERY order kind (owner-directed 2026-08-05):
// insurance was hard-coded ON; it now matches title and only CCs when the officer
// opted in (their own ccBorrowerOnInsuranceOrder default) or per order.
assert.strictEqual(orders.ccBorrowerDefault('insurance'), false, 'insurance default is OFF too (company default)');
assert.strictEqual(orders.ccBorrowerDefault('insurance', true), true, 'insurance CCs when the officer opted in');
const rIns = orders.recipientsFor('insurance', { ...base, vendors: { insurance: { email: 'ins@abc.com' } } });
assert.ok(!rIns.cc.includes('john@example.com'), 'insurance order does NOT CC the borrower by default');
const rInsOn = orders.recipientsFor('insurance', { ...base, vendors: { insurance: { email: 'ins@abc.com' } } }, { loCcSetting: true });
assert.ok(rInsOn.cc.includes('john@example.com'), 'insurance CCs when the officer default is on');
const rInsExplicit = orders.recipientsFor('insurance', { ...base, vendors: { insurance: { email: 'ins@abc.com' } } }, { ccBorrower: true });
assert.ok(rInsExplicit.cc.includes('john@example.com'), 'insurance CC can be turned on per order');
// The per-kind setting key each default reads.
assert.strictEqual(orders.ccBorrowerSettingKey('title'), 'ccBorrowerOnTitleOrder', 'title reads its own officer setting');
assert.strictEqual(orders.ccBorrowerSettingKey('insurance'), 'ccBorrowerOnInsuranceOrder', 'insurance reads its own officer setting');
// CC de-dupes case-insensitively (borrower == officer edge case).
const dupCc = orders.recipientsFor('title', { ...base, officer: { name: 'x', email: 'JOHN@example.com' } }, { ccBorrower: true });
assert.strictEqual(dupCc.cc.filter((e) => e === 'john@example.com').length, 1, 'CC is deduped case-insensitively');
ok('recipients: vendor=TO; borrower-CC OFF by default for every kind (per-order/LO-setting turns on); LO/processor CC (deduped); unique reply-to');

/* ---- order-inbox: returned docs file into the real title/insurance condition ---- */
const orderInbox = require('../src/lib/order-inbox');
assert.strictEqual(orderInbox.CONDITION_CODE.title, 'rtl_cond_title', 'title returns file into the title-documents condition');
assert.strictEqual(orderInbox.CONDITION_CODE.insurance, 'rtl_cond_insurance', 'insurance returns file into the insurance (binder+invoice) condition');
assert.strictEqual(orderInbox.DOC_KIND.title, 'title_order_return');
assert.strictEqual(orderInbox.DOC_KIND.insurance, 'insurance_order_return');
ok('returned docs map to the real title/insurance conditions');

/* ---- order slots: ONE vocabulary, shared with the condition ----------------
   The Orders desk used to keep its OWN list of classification labels ('Binder',
   'Invoice'), while the insurance CONDITION declares its slots as "Insurance
   binder" / "Insurance invoice" and the file screen matches a document to a slot
   by an EXACT label compare. So a classified document was filed correctly and
   then rendered nowhere on the condition. These checks pin the derivation and the
   legacy-label acceptance that closed it. */
const orderSlots = require('../src/lib/order-slots');

assert.strictEqual(orderSlots.CONDITION_CODE.title, 'rtl_cond_title');
assert.strictEqual(orderSlots.CONDITION_CODE.insurance, 'rtl_cond_insurance');

// slotsFor DERIVES the condition's own slots from the template row. A stub client
// stands in for the database so this stays a pure test.
const stubDb = (slots) => ({ query: async () => ({ rows: [{ slots }] }) });
const throwingDb = { query: async () => { throw new Error('db down'); } };

(async () => {
  const ins = await orderSlots.slotsFor(
    stubDb([{ key: 'binder', label: 'Insurance binder' }, { key: 'invoice', label: 'Insurance invoice' }]), 'insurance');
  assert.deepStrictEqual(ins.conditionSlots, ['Insurance binder', 'Insurance invoice'],
    "the condition's OWN slot labels are what the desk offers");
  assert.strictEqual(ins.all[0], 'Insurance binder', 'condition slots come first in the picker');
  assert.ok(ins.all.includes('Quote') && ins.all.includes('Other'),
    'the descriptive labels the condition has no slot for are still offered');
  assert.ok(ins.conditionSlots.every((s) => !ins.extraSlots.includes(s)), 'no slot is offered twice');
  // The sign-off gate matches by lower-case substring, so the derived labels must
  // still satisfy it — otherwise a classified binder+invoice would stop clearing
  // the condition.
  assert.ok(ins.conditionSlots.some((s) => s.toLowerCase().includes('binder'))
         && ins.conditionSlots.some((s) => s.toLowerCase().includes('invoice')),
    'insurance slots include binder + invoice (matches the sign-off gate)');
  ok('order slots are DERIVED from the condition template, condition slots first');

  // An admin renaming a slot must carry through to the desk with no code change.
  const renamed = await orderSlots.slotsFor(stubDb([{ key: 'binder', label: 'Hazard binder' }]), 'insurance');
  assert.deepStrictEqual(renamed.conditionSlots, ['Hazard binder'], 'a renamed slot flows through');
  assert.deepStrictEqual(orderSlots.canonicalizeSlot('Binder', renamed.all), { ok: true, slot: 'Hazard binder' },
    'a legacy "Binder" still lands in the renamed binder slot');

  // An unreadable template must NOT report "this condition has no slots" — that
  // would silently turn the binder/invoice picker into free text.
  const down = await orderSlots.slotsFor(throwingDb, 'insurance');
  assert.deepStrictEqual(down.conditionSlots, ['Insurance binder', 'Insurance invoice'],
    'an unreadable template falls back to the seeded slots, never to none');

  // Title is free-form: no named slots, only descriptive labels.
  const title = await orderSlots.slotsFor(stubDb(null), 'title');
  assert.deepStrictEqual(title.conditionSlots, [], 'the title condition declares no named slots');
  assert.ok(title.all.includes('CPL'), 'title still offers its descriptive labels');
  ok('a renamed slot flows through; an unreadable template falls back; title stays free-form');
})().then(() => {
  /* ---- canonicalizeSlot: the whole truth table (pure) ---- */
  const ALLOWED = ['Insurance binder', 'Insurance invoice', 'Quote', 'Other'];
  assert.deepStrictEqual(orderSlots.canonicalizeSlot('', ALLOWED), { ok: true, slot: null }, 'empty clears the slot');
  assert.deepStrictEqual(orderSlots.canonicalizeSlot(null, ALLOWED), { ok: true, slot: null }, 'null clears the slot');
  assert.deepStrictEqual(orderSlots.canonicalizeSlot('Insurance binder', ALLOWED), { ok: true, slot: 'Insurance binder' });
  assert.deepStrictEqual(orderSlots.canonicalizeSlot('  insurance INVOICE ', ALLOWED), { ok: true, slot: 'Insurance invoice' },
    'matching is case- and whitespace-insensitive');
  // THE BUG THIS MODULE EXISTS FOR: the label the old desk wrote must land in the
  // condition's own slot, stored with the condition's spelling.
  assert.deepStrictEqual(orderSlots.canonicalizeSlot('Binder', ALLOWED), { ok: true, slot: 'Insurance binder' });
  assert.deepStrictEqual(orderSlots.canonicalizeSlot('Invoice', ALLOWED), { ok: true, slot: 'Insurance invoice' });
  assert.strictEqual(orderSlots.canonicalizeSlot('Something else', ALLOWED).ok, false, 'an unknown label is refused, never stored as free text');
  assert.strictEqual(orderSlots.canonicalizeSlot('Binder', []).ok, false, 'with nothing allowed, nothing is guessed');
  ok('canonicalizeSlot: clears, matches loosely, maps the legacy labels, refuses the unknown');

  console.log(`\n${n} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
