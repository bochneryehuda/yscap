'use strict';
/**
 * LONG-TERM ORDERS — the three vocabularies agree, the desk cannot guess, and the
 * shared code is used rather than copied.
 *
 * WHAT THIS SUITE IS FOR. The order kinds are named in THREE files that cannot see
 * each other — the registry (`src/longterm/orders/kinds.js`), the CHECK constraints
 * in `db/644`, and each order condition's `config.orderType` in the condition library
 * — and every possible disagreement fails LATE and QUIETLY. A kind the registry
 * offers that the CHECK refuses fails at the moment somebody presses Order, on a
 * real file, as a Postgres error. A `contactType` the library names that the registry
 * does not map means the order is addressed to nobody and the desk says "add the
 * contact" about a contact that is already there. None of that is visible in a unit
 * test of any one file, so this reads all three out of the source.
 *
 * The rest is about the two things this desk must never do: GUESS which slot a
 * returned document fills, and reach the short-term database pool.
 *
 * PURE: no database, no network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'orders.yscapgroup.example';

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ok = (m) => { n++; console.log('  ok -', m); };

const kinds = require('../src/longterm/orders/kinds');
const letter = require('../src/longterm/orders/letter');
const library = require('../src/longterm/conditions-center/library');

/* ─────────────────────────────────────────────────────────────────────────────
   A. THE THREE VOCABULARIES
   ───────────────────────────────────────────────────────────────────────────── */
const migration = read('db/644_lt_orders_desk_vendors_orders_and_the_vendor_thread.sql');

/** The values inside a `CHECK (kind IN (...))` on one table, read from the SQL. */
function checkKinds(table) {
  const re = new RegExp(`ALTER TABLE ${table} ADD CONSTRAINT \\w+_kind_chk\\s*\\n\\s*CHECK \\(kind IN \\(([\\s\\S]*?)\\)\\);`);
  const m = migration.match(re);
  assert.ok(m, `db/644 declares a kind CHECK on ${table}`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
}

const sqlOrderKinds = checkKinds('lt_file_orders');
const sqlVendorKinds = checkKinds('lt_loan_vendors');

assert.deepStrictEqual([...kinds.ORDER_KIND_KEYS].sort(), sqlOrderKinds,
  'every order kind the registry offers is one db/644 will store, and no more');
ok(`the order kinds agree between the registry and db/644 (${sqlOrderKinds.length})`);

// The vendor CHECK must carry every kind an ORDER is addressed to. It may carry MORE
// (a buyer's attorney and a realtor are on the file without being ordered from), so
// this is a superset test, not equality — stating that on purpose, because equality
// here would fail the day somebody adds a contact kind nobody orders from.
for (const k of kinds.ORDER_KIND_KEYS) {
  const vk = kinds.vendorKindFor(k);
  assert.ok(sqlVendorKinds.includes(vk), `db/644 can store the "${vk}" card an ${k} order is addressed to`);
  assert.ok(Object.prototype.hasOwnProperty.call(kinds.VENDOR_KINDS, vk), `the registry names the "${vk}" card`);
}
for (const vk of Object.keys(kinds.VENDOR_KINDS)) {
  assert.ok(sqlVendorKinds.includes(vk), `db/644 can store a "${vk}" card`);
}
ok('every vendor card the registry names is one db/644 will store, and every order is addressed to one of them');

/* THE CONDITION LIBRARY. Each order condition declares the order it stands for; the
   registry declares the condition it answers. They are two directions of one fact and
   a drift means the desk and the condition centre tell different stories about the
   same file. */
const LIBRARY = library.library();
const libraryByCode = new Map(LIBRARY.map((c) => [c.code, c]));
for (const k of kinds.ORDER_KIND_KEYS) {
  const def = kinds.orderKind(k);
  const cond = libraryByCode.get(def.condition);
  assert.ok(cond, `the condition "${def.condition}" that the ${k} order answers exists in the library`);
  const declared = cond.config && cond.config.orderType;
  assert.strictEqual(declared, k, `the library's "${def.condition}" declares orderType "${k}"`);
  if (def.docCondition) {
    assert.ok(libraryByCode.get(def.docCondition), `the condition "${def.docCondition}" a returned ${k} document is filed on exists`);
  }
}
ok('every order kind and the condition it answers point at each other');

// And the other direction: a library condition that says it is an order must be one
// the desk can actually place, or it sits on files with a button nobody built.
for (const c of LIBRARY) {
  if (c.kind !== 'order') continue;
  const ot = c.config && c.config.orderType;
  assert.ok(ot, `the order condition "${c.code}" names the order it stands for`);
  assert.ok(kinds.orderKind(ot), `the desk can place the "${ot}" order that "${c.code}" stands for`);
}
ok('every order CONDITION in the library is an order the desk can actually place');

/* ─────────────────────────────────────────────────────────────────────────────
   B. A WRONG SLOT IS WORSE THAN NO SLOT

   A binder filed into the invoice slot reads as an invoice that has ARRIVED, and a
   condition whose required slots are all full reads as satisfied — so a guess can
   clear a condition nobody has met, while an unplaced document merely leaves a
   person to place it. Every "no opinion" case must answer null.
   ───────────────────────────────────────────────────────────────────────────── */
for (const bad of ['', null, undefined, '   ', 'scan0001.pdf', 'IMG_4021.jpeg', 'document.pdf', 'attachment']) {
  assert.strictEqual(kinds.slotForFilename('title', bad), null, `a filename that says nothing (${JSON.stringify(bad)}) places nothing`);
}
assert.strictEqual(kinds.slotForFilename('nope', 'Title Commitment.pdf'), null, 'an unknown kind places nothing');
ok('a filename that says nothing places nothing');

const PLACES = [
  ['title', '2026 Title Commitment - 12 Oak St.pdf', 'commitment'],
  ['title', 'CPL.pdf', 'cpl'],
  ['title', 'closing protection letter.PDF', 'cpl'],
  ['title', 'Preliminary Settlement Statement.pdf', 'prelim_settlement'],
  ['title', 'wiring instructions.pdf', 'wire_instructions'],
  ['title', 'Invoice 88213.pdf', 'invoice'],
  ['insurance', 'Binder - Oak Holdings.pdf', 'binder'],
  ['insurance', 'Declarations Page.pdf', 'binder'],
  ['insurance', 'invoice.pdf', 'invoice'],
  ['flood_insurance', 'Flood Binder.pdf', 'binder'],
  ['ny_settlement_agent', 'Engagement Letter.pdf', 'engagement'],
  ['condo_questionnaire', 'HOA Questionnaire.pdf', 'questionnaire'],
  ['condo_questionnaire', '2026 Budget.pdf', 'budget'],
];
for (const [k, file, slot] of PLACES) {
  assert.strictEqual(kinds.slotForFilename(k, file), slot, `"${file}" fills the ${slot} slot on a ${k} order`);
}
ok(`a filename that names its own slot is placed (${PLACES.length} cases)`);

/* EVERY SLOT A MAP NAMES MUST EXIST ON THE CONDITION IT FILES ONTO, or a returned
   document is written into a slot the screen never renders — filed, invisible, and
   counted by nothing. */
for (const k of kinds.ORDER_KIND_KEYS) {
  const def = kinds.orderKind(k);
  if (!def.docCondition || !Array.isArray(def.slotMap) || !def.slotMap.length) continue;
  const cond = libraryByCode.get(def.docCondition);
  const slotKeys = new Set((cond.slots || []).map((s) => s.key));
  for (const [, slot] of def.slotMap) {
    if (slot == null) continue;   // deliberately "file it with no slot"
    assert.ok(slotKeys.has(slot), `the ${k} order's "${slot}" slot exists on ${def.docCondition}`);
  }
}
ok('every slot a returned document can be placed in exists on the condition it is filed onto');

/* ─────────────────────────────────────────────────────────────────────────────
   C. THE LETTERS
   ───────────────────────────────────────────────────────────────────────────── */
const DATA = {
  loanId: '11111111-2222-3333-4444-555555555555',
  appId: '11111111-2222-3333-4444-555555555555',
  loanNumber: 'LT-1001', hasLoanNumber: true,
  propertyLine: '12 Oak St, Lakewood, NJ 08701', propertyState: 'NJ',
  borrowerName: 'A Borrower', borrowerEmail: 'b@example.com', entityName: 'Oak Holdings LLC',
  loanAmount: '$400,000', transactionType: 'Purchase', loanPurpose: 'purchase',
  grossMonthlyRent: 3200, unitCount: 2, propertyType: 'Multi 2-4',
  officer: { name: 'A Officer', title: 'Loan Officer', email: 'lo@example.com', phone: '718-555-0000' },
  processor: { email: 'proc@example.com' }, helpers: [],
  vendors: {}, vendorsExtra: {},
};
for (const k of kinds.ORDER_KIND_KEYS) {
  DATA.vendors[k] = { company_name: 'A Vendor', email: 'v@example.com' };
  DATA.vendorsExtra[k] = [];
}

for (const k of kinds.ORDER_KIND_KEYS) {
  const built = letter.buildLetter(k, DATA, {});
  assert.ok(built && built.subject && built.html && built.text, `${k} builds a whole letter`);
  assert.ok(built.text.includes('LT-1001'), `${k} states the loan number`);
  assert.ok(built.text.includes('12 Oak St'), `${k} states the property`);
  // THE CLAUSE IS NEVER THE SHORT-TERM SERVICER VARIANT on a long-term loan: that
  // clause is keyed on a note-buyer registry that has no meaning here, and printing
  // it would put an outside servicer's address on our own loan's insurance policy.
  assert.ok(!built.text.includes('Elite Commercial Servicing'), `${k} never prints the short-term servicer clause`);
  assert.ok(built.text.includes('5 New Montrose Avenue'), `${k} prints the company mortgagee clause`);
  const fu = letter.buildLetter(k, DATA, { followup: true });
  assert.ok(fu && fu.subject && fu.text, `${k} builds a follow-up`);
}
ok(`every order kind builds an order and a follow-up (${kinds.ORDER_KIND_KEYS.length} kinds)`);

// THE INSURANCE LETTER FOLLOWS THE DEAL. A purchase asks an agent to QUOTE cover
// that does not exist; a refinance asks them to VERIFY the policy in force and add
// us to it. Sending the quote letter on a refinance is what produces a second policy
// nobody needed.
assert.strictEqual(letter.letterKeyFor('insurance', { loanPurpose: 'purchase' }), 'insurance_purchase');
assert.strictEqual(letter.letterKeyFor('insurance', { loanPurpose: 'refinance' }), 'insurance_refinance');
assert.strictEqual(letter.letterKeyFor('insurance', { loanPurpose: 'cash_out_refinance' }), 'insurance_refinance');
// An unreadable purpose falls to the QUOTE letter deliberately: asking for a quote on
// a policy that turns out to exist costs a reply, while asking to verify one that does
// not exist reads as our mistake and stalls the file.
assert.strictEqual(letter.letterKeyFor('insurance', {}), 'insurance_purchase');
assert.strictEqual(letter.letterKeyFor('insurance', { loanPurpose: null }), 'insurance_purchase');
ok('the insurance letter follows the deal, and an unreadable purpose falls the cheap way');

// THE LONG-TERM INSURANCE LETTER IS NOT THE SHORT-TERM ONE, and that is the point:
// the short-term letter asks for Builders Risk on a VACANT property under renovation.
// A long-term loan is a stabilised rental with a tenant in it.
const ins = letter.buildLetter('insurance', DATA, {});
assert.ok(!/builders risk|vacancy permit/i.test(ins.text),
  'the long-term insurance letter never asks for renovation cover on a vacant property');
assert.ok(/loss of rents|rental income/i.test(ins.text),
  'the long-term insurance letter asks for the rent loss cover a rental needs');
ok('the long-term insurance letter asks for what a rental needs, not what a renovation needs');

// THE TITLE LETTER *IS* THE SHORT-TERM ONE — both products ask a title company the
// same question, so it is literally the same function, and the owner's New-York cut
// comes with it for free.
const nyTitle = letter.buildLetter('title', { ...DATA, propertyState: 'NY' }, { followup: true });
const njTitle = letter.buildLetter('title', { ...DATA, propertyState: 'NJ' }, { followup: true });
assert.ok(njTitle.text.includes('CPL'), 'a title follow-up outside New York still asks for the CPL');
assert.ok(!nyTitle.text.includes('CPL'), 'a New York title follow-up never asks title for the CPL');
assert.ok(!/Preliminary Settlement Statement/i.test(nyTitle.text),
  'a New York title follow-up never asks title for the preliminary settlement statement');
ok('the New-York title cut applies on this side too, from the shared definition');

/* MERGE TOKENS. An unresolved token is left EXACTLY AS TYPED — a letter reading
   "Loan Number:" with nothing after it looks like our system lost the number, while a
   visible «Loan_Number» reads as a template somebody has not finished, which is the
   truth and is fixable by whoever sees it. */
const vals = letter.tokenValues(DATA);
assert.strictEqual(letter.merge('Loan «Loan_Number» at «Property_Address»', vals), 'Loan LT-1001 at 12 Oak St, Lakewood, NJ 08701');
assert.strictEqual(letter.merge('{{Borrower_Name}} / {{Entity_Name}}', vals), 'A Borrower / Oak Holdings LLC');
assert.strictEqual(letter.merge('«Nope» stays', vals), '«Nope» stays');
assert.strictEqual(letter.merge('«Co_Borrower_Name» stays when empty', vals), '«Co_Borrower_Name» stays when empty');
assert.strictEqual(letter.merge('', vals), '');
assert.strictEqual(letter.merge(null, vals), '');
ok('merge tokens resolve, and an unresolved one is left visible rather than blanked');

// A BUYER'S OWN WORDING REPLACES OURS, field by field — that is what "everything
// should be configurable in settings" means here.
const custom = letter.buildLetter('payoff', DATA, {
  template: { title: 'Payoff please', intro: 'Loan «Loan_Number» is being refinanced.', wants: ['A statement'] },
});
assert.ok(custom.subject.includes('Payoff please'), 'a buyer’s own title is what goes out');
assert.ok(custom.text.includes('Loan LT-1001 is being refinanced.'), 'a buyer’s own intro is merged and printed');
assert.ok(custom.text.includes('A statement'), 'a buyer’s own list of what we need replaces ours');
ok('a buyer’s own wording replaces the system’s, merge tokens and all');

/* ─────────────────────────────────────────────────────────────────────────────
   D. THE DESK NEVER REACHES THE OTHER PRODUCT'S POOL

   The whole reason `lib/orders.js` could not simply be imported. Every long-term
   order module must read its own pool and no other, and `vendor-directory.suggest`
   is the one shared function that would break it — it lazily requires the short-term
   pool to search the directory, which is why the ledger authorizes only the pure half.
   ───────────────────────────────────────────────────────────────────────────── */
const LT_FILES = ['kinds.js', 'data.js', 'letter.js', 'desk.js', 'inbox.js']
  .map((f) => [`src/longterm/orders/${f}`, read(`src/longterm/orders/${f}`)])
  .concat([
    ['src/longterm/routes/orders.js', read('src/longterm/routes/orders.js')],
    ['src/longterm/routes/order-inbox.js', read('src/longterm/routes/order-inbox.js')],
  ]);
// Comments are stripped first: these files necessarily NAME the things they must not
// do, because that is how a header explains a decision. A guard that read the prose
// would fail on its own explanation and then be "fixed" by loosening it.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
for (const [name, src] of LT_FILES) {
  const code = codeOnly(src);
  assert.ok(!/require\(\s*['"]\.\.\/\.\.\/db['"]\s*\)/.test(code), `${name} never requires the short-term pool`);
  assert.ok(!/vendorDirectory\.suggest|\.suggest\(/.test(code), `${name} never calls the directory suggester (it reaches the short-term pool)`);
  assert.ok(!/require\(\s*['"]\.\.\/\.\.\/lib\/orders['"]\s*\)/.test(code), `${name} never imports the short-term orders desk`);
  assert.ok(!/require\(\s*['"]\.\.\/\.\.\/lib\/file-inbox['"]\s*\)/.test(code), `${name} never imports the short-term inbox`);
}
ok('no long-term order module reaches the short-term pool, desk or inbox');

// A LONG-TERM SEND NEVER WRITES THE SHORT-TERM EMAIL CENTER.
const deskSrc = codeOnly(read('src/longterm/orders/desk.js'));
assert.ok(/_skipCapture:\s*true/.test(deskSrc), 'the long-term send skips the short-term Email Center capture');
ok('a long-term send never writes the short-term Email Center');

/* ─────────────────────────────────────────────────────────────────────────────
   E. THE APPRAISAL IS BUILT AND SWITCHED OFF, AND IT SAYS SO

   The owner's instruction was "NAN only, grayed out". A switched-off order must be
   SHOWN with its reason: a feature that silently disappears reads as one that broke.
   ───────────────────────────────────────────────────────────────────────────── */
assert.strictEqual(kinds.isEnabled('appraisal'), false, 'appraisal ordering ships switched off');
assert.ok(kinds.orderKind('appraisal').disabledReason, 'and it says why');
assert.strictEqual(kinds.orderKind('appraisal').vendorLock, 'nan', 'and it is locked to the one vendor the owner named');
for (const k of kinds.ORDER_KIND_KEYS) {
  if (k === 'appraisal') continue;
  assert.strictEqual(kinds.isEnabled(k), true, `${k} is switched on`);
}
const appraisalCond = libraryByCode.get('lt_order_appraisal');
assert.strictEqual(appraisalCond.isEnabled, false, 'the appraisal CONDITION is switched off in the same breath');
ok('appraisal ordering is built, switched off, locked to NAN, and says so on both the desk and the condition');

/* ─────────────────────────────────────────────────────────────────────────────
   F. THE WEBHOOK CLAIMS ONLY ITS OWN, AND HANDS EVERYTHING ELSE ON
   ───────────────────────────────────────────────────────────────────────────── */
const inbox = require('../src/longterm/orders/inbox');
const fileAddress = require('../src/lib/file-address');
const LOAN = '11111111-2222-3333-4444-555555555555';
const ltAddr = fileAddress.ltOrderReplyTo(LOAN, 'title');

assert.deepStrictEqual(inbox.ordersFromEvent({ to: [ltAddr] }), [{ loanId: LOAN, orderKind: 'title' }],
  'a delivery addressed to a long-term order is claimed');
assert.deepStrictEqual(inbox.ordersFromEvent({ to: [fileAddress.orderReplyTo(LOAN, 'title')] }), [],
  'a delivery addressed to a SHORT-TERM order is never claimed');
assert.deepStrictEqual(inbox.ordersFromEvent({ to: [fileAddress.fileReplyTo(LOAN)] }), [],
  'a delivery addressed to the short-term file inbox is never claimed');
assert.deepStrictEqual(inbox.ordersFromEvent({}), [], 'a delivery addressed to nothing is never claimed');
assert.deepStrictEqual(inbox.ordersFromEvent(null), [], 'a malformed event is never claimed');
// A reply-all naming the same order twice is ONE order, not two runs over the same
// documents.
assert.strictEqual(inbox.ordersFromEvent({ to: [ltAddr], cc: [ltAddr.toUpperCase()] }).length, 1,
  'the same order named twice on one delivery is handled once');
// A Bcc'd address is found: `received_for` is the ONLY field guaranteed to carry it,
// and a vendor's mail client routinely moves ours there.
assert.strictEqual(inbox.ordersFromEvent({ received_for: ltAddr }).length, 1, 'a Bcc-only long-term address is still found');
ok('the long-term webhook claims its own addresses and nothing else');

const hookSrc = codeOnly(read('src/longterm/routes/order-inbox.js'));
assert.ok(/return next\(\)/.test(hookSrc), 'a delivery that is not ours is handed on rather than swallowed');
assert.ok(/resendWebhookSecret/.test(hookSrc) && /invalid signature/.test(hookSrc),
  'and one that IS ours is refused without a valid signature');
// The mount order is what makes the hand-on work at all, and no runtime check can see it.
const serverSrc = read('src/server.js');
const ltMount = serverSrc.indexOf("app.use('/api/inbound/file-email', require('./longterm/routes/order-inbox'))");
const rtlMount = serverSrc.indexOf("app.use('/api/inbound/file-email', require('./routes/inbound-file-email'))");
assert.ok(ltMount >= 0 && rtlMount >= 0 && ltMount < rtlMount,
  'the long-term claim is mounted in FRONT of the short-term reader on the shared endpoint');
ok('the shared inbound endpoint tries the long-term claim first and hands the rest on');

console.log(`\ntest-lt-orders-pure: ${n} checks passed`);
