#!/usr/bin/env node
'use strict';
/**
 * A TYPED REPLY IS THE PERSON'S OWN WORDS — NOT A FOLLOW-UP.
 *
 * Owner-reported 2026-09-01: "even if they manually reply, it fills out like it's a
 * follow-up email. It pre-fills stuff from the follow-up button. The official
 * follow-up only if you go to the official follow-up button. If you just write
 * your own reply and you just write text, then only your text should be sent."
 *
 * Root cause: the Email Center's reply door built the vendor email through the
 * FOLLOW-UP branch of buildOrderEmail (followup:true, note:<typed text>), whose
 * template appends the deliverables ask, a fact table and a "— Follow-up"
 * headline — and then recorded the send as a chase (followup_count++). Pure test:
 * no database, no network.
 */
// closing-prep requires the db module at load; a pure test gives it a placeholder so the
// module loads without the FATAL banner. Nothing here ever opens a connection.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pure-test@localhost:5432/none';
const path = require('path');
const R = path.resolve(__dirname, '..');
const orderEmail = require(R + '/src/lib/order-email');
const orders = require(R + '/src/lib/orders');
const closingPrep = require(R + '/src/lib/closing-prep');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const base = {
  appId: '11111111-1111-4111-8111-111111111111', loanNumber: 'YSCAP1042', hasLoanNumber: true,
  propertyLine: '123 Main St, Brooklyn, NY 11211', propertyState: 'NJ', transactionType: 'Purchase',
  borrowerName: 'John Smith', borrowerEmail: 'john@example.com', coBorrowerEmail: null,
  dob: '01/02/1980', entityName: 'Smith Holdings LLC', loanAmount: '$500,000',
  officer: { name: 'Chaim Klein', email: 'lo@yscapgroup.com', title: 'Loan Officer' },
  processor: { name: 'Pat Proc', email: 'proc@yscapgroup.com' },
  vendors: {
    title: { id: 't1', company_name: 'ABC Title', contact_name: 'Jane Doe', email: 'title@abc.com', phone: '555-1000' },
    insurance: { id: 'i1', company_name: 'SafeCo', contact_name: 'Sam Agent', email: 'ins@safeco.com' },
  },
};
const TYPED = 'The closing moved to Tuesday the 9th.\n\nCan you confirm the binder will be ready by Monday?';

for (const kind of ['title', 'insurance']) {
  const reply = orders.buildOrderEmail(kind, base, { reply: true, note: TYPED, senderName: 'Chaim Klein' });
  const follow = orders.buildOrderEmail(kind, base, { followup: true, note: TYPED });
  const text = reply.text || '';

  ok(/The closing moved to Tuesday the 9th\./.test(text) && /Can you confirm the binder/.test(text),
    `${kind}: the typed paragraphs are in the reply`);
  ok(/Hi (Jane|Sam)/.test(text), `${kind}: it greets the vendor by name`);
  ok(/Chaim Klein/.test(text), `${kind}: the sender signs it`);
  // NONE of the follow-up furniture.
  ok(!/Follow-up/i.test(reply.subject) && !/Follow-up/.test(text), `${kind}: no "Follow-up" headline anywhere`);
  ok(!/Please provide the following/.test(text) && !/Insurance quote \/ binder/.test(text) && !/Invoice/.test(text)
    && !/Title commitment/i.test(text) && !/Wiring instructions/i.test(text),
    `${kind}: no deliverables ask rides on a typed reply`);
  ok(!/Property Address|Property:|Borrower Name|Borrower:|Loan Amount|Loan Number/.test(text),
    `${kind}: no restated fact table on a typed reply`);
  ok(!/Mortgagee Clause/.test(text) && !/Coverage required/.test(text), `${kind}: no clause, no coverage block`);
  ok(/Reply to this email and it reaches the whole loan team/.test(text), `${kind}: the reply delimiter still rides (inbound cut depends on it)`);
  // And the follow-up branch is unchanged — still the official chase, with its ask.
  ok(/Follow-up/.test(follow.subject) || /Follow-up/.test(follow.text || ''), `${kind}: the Follow-up BUTTON still produces the follow-up`);
  ok(kind === 'title' ? /Please provide the following|Title/.test(follow.text || '') : /Insurance quote \/ binder/.test(follow.text || ''),
    `${kind}: the follow-up still carries its deliverables ask`);
  ok(reply.text !== follow.text, `${kind}: a reply and a follow-up with the same typed text are different emails`);
}

// A single-paragraph reply, no sender name: still the person's words + the officer's sign-off.
{
  const r = orderEmail.buildOrderEmail('title', base, { reply: true, note: 'Received, thank you.' });
  ok(/Received, thank you\./.test(r.text) && /Chaim Klein/.test(r.text), 'one line in → one line out, signed by the officer');
}

// The closing chain: a typed reply is not headlined "Following up on this closing".
{
  const data = { loanNumber: 'YSCAP1042', propertyLine: '123 Main St, Brooklyn, NY 11211', borrowerName: 'John Smith',
    officer: base.officer, borrowerEmail: 'john@example.com' };
  const reply = closingPrep.buildFollowupEmail(data, { note: TYPED, senderName: 'Chaim Klein', reply: true });
  const follow = closingPrep.buildFollowupEmail(data, { note: TYPED, senderName: 'Chaim Klein' });
  ok(!/Following up on this closing/.test(reply.text || '') && !/Following up on closing prep/.test(reply.text || ''),
    'closing: a typed reply is not headlined as a follow-up');
  ok(/The closing moved to Tuesday/.test(reply.text || ''), 'closing: the typed text is the message');
  ok(/Following up on this closing/.test(follow.text || ''), 'closing: the Follow-up button still says so');
  ok(reply.text !== follow.text, 'closing: reply and follow-up differ');
}

// THE DOOR ITSELF (source guards — no unit test can see a route's choice of builder).
{
  const staff = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
  const start = staff.indexOf("router.post('/applications/:id/emails/reply'");
  const end = staff.indexOf('ORDERS DESK (#orders)', start);
  const door = staff.slice(start, end);
  ok(start > 0 && end > start, 'the reply door is where the guard expects it');
  ok(/buildOrderEmail\(kind, data, \{ reply: true, note: bodyText/.test(door), 'the vendor branch builds in REPLY mode');
  ok(!/buildOrderEmail\(kind, data, \{ followup: true/.test(door), 'the vendor branch no longer builds a follow-up');
  ok(/buildFollowupEmail\(data, \{ note: bodyText, address, senderName, reply: true \}\)/.test(door), 'the closing branch builds in REPLY mode');
  ok(!/followup_count=followup_count\+1/.test(door), 'a typed reply no longer counts as a chase (followup_count untouched)');
  ok(!/kind: 'followed_up'/.test(door), 'a typed reply is not recorded as followed_up');
  ok(/type: `\$\{kind\}_message`/.test(door) && !/type: `\$\{kind\}_followup`/.test(door), 'it is logged as a message, not a follow-up');
  ok(/previewOnly/.test(door) && (door.match(/previewShape\(/g) || []).length >= 3, 'every branch of the door can answer a preview');
  ok((door.match(/MO\.applyOverride\(/g) || []).length >= 3, 'every branch lands an edit through the one chokepoint');
  // And the real follow-up door still chases — it was never the bug.
  ok(/kind: 'followed_up'/.test(staff.slice(end)), 'the Follow-up button route still records followed_up');
  const ec = fs.readFileSync(R + '/app-v2/src/components/EmailCenter.jsx', 'utf8');
  ok(/preview: true/.test(ec) && /<EmailPreview/.test(ec), 'the Email Center composer previews before it sends');
  ok(!/onClick=\{send\}/.test(ec), 'nothing in the composer sends without the preview');
}

console.log(`order reply mode: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
