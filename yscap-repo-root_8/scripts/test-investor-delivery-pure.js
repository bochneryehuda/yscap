'use strict';
/**
 * INVESTOR DELIVERY — the pure rules (owner-directed 2026-08-03). No database, no network.
 *
 * Every assertion here reproduces something the owner asked for by name: the two funding modes and
 * which one is the default, the three figures the email must state, the borrower NEVER being a
 * recipient, and the borrower's agreement being the thing that unlocks the send.
 */
const assert = require('assert');
const ID = require('../src/sitewire/investor-delivery');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// ---------------------------------------------------------------- A. the funding mode
eq(ID.DEFAULT_MODE, 'reimbursement', 'A1 the default is reimbursement (we release, the investor reimburses us)');
eq(ID.resolveFundingMode({}), 'reimbursement', 'A2 nothing set anywhere → the default');
eq(ID.resolveFundingMode({ fileMode: 'investor_direct' }), 'investor_direct', 'A3 the file default is used when the draw has none');
eq(ID.resolveFundingMode({ drawMode: 'reimbursement', fileMode: 'investor_direct' }), 'reimbursement', 'A4 the per-draw choice beats the file default');
eq(ID.resolveFundingMode({ drawMode: 'nonsense', fileMode: 'investor_direct' }), 'investor_direct', 'A5 an unrecognised stored value falls through — never takes effect');
eq(ID.resolveFundingMode({ drawMode: 'nonsense', fileMode: 'rubbish' }), 'reimbursement', 'A6 two bad values still land on the default');

// ---------------------------------------------------------------- B. the money split
// The owner's own worked example: $25,000 approved, our $299 fee, $24,701 to the borrower.
const DRAW = { requested_cents: 2500000, approved_cents: 2500000, fee_cents: 29900, retainage_held_cents: 0, net_release_cents: 2470100 };

const reim = ID.investorMoney(DRAW, 'reimbursement');
eq(reim.investor_total_cents, 2500000, 'B1 reimbursement: the investor funds the whole approved amount');
eq(reim.to_borrower_cents, 2470100, 'B2 reimbursement: the borrower nets the approved amount less our fee');
eq(reim.to_us_cents, 29900, 'B3 reimbursement: our fee is what stays with us');

const direct = ID.investorMoney(DRAW, 'investor_direct');
eq(direct.investor_total_cents, 2500000, 'B4 investor-direct funds the same total');
eq(direct.to_borrower_cents, 2470100, 'B5 investor-direct: the borrower still nets the same');
eq(direct.to_us_cents, 29900, 'B6 investor-direct: our fee comes to us as its own payment');
ok(reim.investor_total_cents === direct.investor_total_cents, 'B7 the mode changes WHO is paid, never the total funded');

// retainage rides with our side of the split (we hold it), never with the borrower's
const withRet = ID.investorMoney({ ...DRAW, retainage_held_cents: 250000, net_release_cents: 2220100 }, 'reimbursement');
eq(withRet.to_borrower_cents, 2220100, 'B8 retainage comes out of the borrower net');
eq(withRet.to_us_cents, 279900, 'B9 fee + retainage is what we hold');
eq(withRet.investor_total_cents, 2500000, 'B10 the investor still funds the approved amount');

// a draw with no fee at all
const free = ID.investorMoney({ requested_cents: 100000, approved_cents: 100000, fee_cents: 0, retainage_held_cents: 0, net_release_cents: 100000 }, 'reimbursement');
eq(free.to_us_cents, 0, 'B11 no fee → nothing comes to us');
eq(free.to_borrower_cents, 100000, 'B12 no fee → the borrower gets the whole approved amount');

// A stored net LARGER than what was approved must never make our side negative.
const weird = ID.investorMoney({ approved_cents: 100000, fee_cents: 0, net_release_cents: 900000 }, 'reimbursement');
eq(weird.to_borrower_cents, 100000, 'B13 a net above the approved amount is clamped to it');
eq(weird.to_us_cents, 0, 'B14 our side can never go negative');

// Missing money (an unreadable rollup) must not throw or invent figures.
const empty = ID.investorMoney({}, 'reimbursement');
eq(empty.approved_cents, 0, 'B15 an empty draw reports zero, never a guess');
eq(empty.investor_total_cents, 0, 'B16 nothing to fund when nothing is approved');

// ---------------------------------------------------------------- C. the email wording
const mailR = ID.deliveryEmail({ loanNo: 'YSCAP258134591', address: '195-197 Parrish St', drawNumber: 1, coordinatorName: 'Lisa Katz' }, reim);
ok(/Draw #1/.test(mailR.subject), 'C1 the subject names the draw');
ok(/195-197 Parrish St/.test(mailR.subject), 'C2 the subject names the property');
ok(/YSCAP258134591/.test(mailR.subject), 'C3 the subject carries the loan number');
const labelsR = mailR.rows.map((r) => r.label).join(' | ');
ok(/Requested by the borrower/.test(labelsR), 'C4 the email states what was requested');
ok(/Approved on inspection/.test(labelsR), 'C5 the email states what was approved');
ok(/released to the borrower/i.test(labelsR), 'C6 the email states what goes to the borrower');
ok(/to YS Capital/.test(labelsR), 'C7 the email states what comes to us');
ok(/reimburse/i.test(mailR.ask), 'C8 reimbursement mode ASKS to be reimbursed');
ok(/\$25,000\.00/.test(mailR.ask), 'C9 reimbursement asks for the full approved amount');
ok(/nothing to send separately/i.test(mailR.ask), 'C10 reimbursement says the fee needs no separate payment');
ok(/Lisa Katz/.test(mailR.signOff), 'C11 the coordinator signs it');
ok(/Draw Coordinator, YS Capital/.test(mailR.signOff), 'C12 signed on behalf of YS Capital');

const mailD = ID.deliveryEmail({ address: '195-197 Parrish St', drawNumber: 2 }, direct);
ok(/release \$24,701\.00 to the borrower/i.test(mailD.ask), 'C13 investor-direct asks for the borrower payment');
ok(/\$299\.00 to YS Capital/.test(mailD.ask), 'C14 investor-direct asks for our fee as its own payment');
ok(!/reimburse/i.test(mailD.ask), 'C15 investor-direct never says reimburse');
ok(/Draw Desk, YS Capital/.test(mailD.signOff), 'C16 with no coordinator named it signs as the desk');

const mailFree = ID.deliveryEmail({ address: 'x' }, free);
ok(!/YS Capital$/m.test(mailFree.rows.map((r) => r.label).join('\n')) || !mailFree.rows.some((r) => /fee/i.test(r.label)), 'C17 a $0 fee is not printed as a line');
ok(/no separate fee/i.test(mailFree.ask), 'C18 a $0 fee is stated plainly rather than shown as $0.00');

// It must not read like spam: no exclamation marks, no shouting, no urgency bait.
const allText = [mailR.subject, mailR.intro, mailR.ask, mailD.intro, mailD.ask].join(' ');
ok(!/!/.test(allText), 'C19 no exclamation marks anywhere in the wording');
ok(!/URGENT|ACT NOW|CLICK HERE|FREE/i.test(allText), 'C20 no spam-trigger phrasing');

// ---------------------------------------------------------------- D. recipients — the borrower is NEVER on it
const r1 = ID.composeRecipients({
  investorEmails: ['jcarara@fidelis-investors.com', 'drawrequest@fidelis-investors.com'],
  coordinatorEmails: ['lisa@yscapgroup.com'],
  officerEmails: ['officer@yscapgroup.com'],
  deskEmail: 'draws@yscapgroup.com',
  borrowerEmails: ['borrower@example.com'],
});
eq(r1.to.length, 2, 'D1 the investor contacts are the recipients');
ok(r1.to.includes('jcarara@fidelis-investors.com'), 'D2 the named investor contact is on it');
ok(r1.cc.includes('lisa@yscapgroup.com'), 'D3 the draw coordinator is copied');
ok(r1.cc.includes('officer@yscapgroup.com'), 'D4 the loan officer is copied');
ok(r1.cc.includes('draws@yscapgroup.com'), 'D5 the shared draw desk is copied');
ok(![...r1.to, ...r1.cc].includes('borrower@example.com'), 'D6 THE BORROWER IS NEVER A RECIPIENT');

// Even if a borrower's address is typed into the investor contacts by mistake, it is removed.
const r2 = ID.composeRecipients({
  investorEmails: ['good@investor.com', 'BORROWER@example.com'],
  borrowerEmails: ['borrower@example.com'],
});
eq(r2.to.length, 1, 'D7 a borrower address in the investor list is dropped');
ok(!r2.to.includes('borrower@example.com'), 'D8 dropped regardless of the casing it was typed in');
ok(r2.excludedBorrower.includes('borrower@example.com'), 'D9 the removal is reported, never silent');

// A borrower who is also on staff must not ride in on the coordinator/officer lists either.
const r3 = ID.composeRecipients({
  investorEmails: ['inv@x.com'], coordinatorEmails: ['borrower@example.com'],
  officerEmails: ['borrower@example.com'], deskEmail: 'draws@yscapgroup.com',
  borrowerEmails: ['Borrower@Example.com'],
});
ok(!r3.cc.includes('borrower@example.com'), 'D10 the borrower is stripped from the copy list too');

// de-duplication + junk rejection
const r4 = ID.composeRecipients({
  investorEmails: ['a@b.com', 'A@B.com', '', null, 'not an email', 'has space@b.com'],
  coordinatorEmails: ['a@b.com'], deskEmail: 'draws@yscapgroup.com',
});
eq(r4.to.length, 1, 'D11 duplicates and junk are dropped from the recipients');
ok(!r4.cc.includes('a@b.com'), 'D12 an address already on the To line is not also copied');

// ---------------------------------------------------------------- E. when may it be sent
const CONTACTS = [{ email: 'x@y.com' }];
eq(ID.deliveryBlockers({ finding: { status: 'accepted' }, investorContacts: CONTACTS, noteBuyer: 'Fidelis' }).length, 0, 'E1 an accepted draw with contacts is ready to go');
eq(ID.deliveryBlockers({ finding: { status: 'resolved' }, investorContacts: CONTACTS, noteBuyer: 'Fidelis' }).length, 0, 'E2 a resolved dispute counts as agreement');
ok(ID.deliveryBlockers({ finding: { status: 'delivered' }, investorContacts: CONTACTS, noteBuyer: 'Fidelis' })[0].includes('not agreed'), 'E3 still waiting on the borrower blocks the send');
ok(/pushed back/.test(ID.deliveryBlockers({ finding: { status: 'disputed' }, investorContacts: CONTACTS, noteBuyer: 'Fidelis' })[0]), 'E4 an open dispute blocks the send and says why');
ok(/not been delivered/.test(ID.deliveryBlockers({ finding: null, investorContacts: CONTACTS, noteBuyer: 'Fidelis' })[0]), 'E5 no findings at all blocks the send');
ok(ID.deliveryBlockers({ finding: { status: 'accepted' }, investorContacts: [], noteBuyer: 'Fidelis' }).some((b) => /No investor contacts/.test(b)), 'E6 a buyer with no saved contacts blocks and asks for them');
ok(ID.deliveryBlockers({ finding: { status: 'accepted' }, investorContacts: [], noteBuyer: '' }).some((b) => /no note buyer/.test(b)), 'E7 a file with no note buyer says so');
ok(ID.AGREED_STATUSES.includes('accepted') && ID.AGREED_STATUSES.includes('resolved') && ID.AGREED_STATUSES.length === 2,
  'E8 only accepted and resolved count as the borrower agreeing');

// ---------------------------------------------------------------- F. the MANUAL mode (#11)
ok(ID.MODES.includes('manual'), 'F1 manual is a funding/delivery mode');
eq(ID.MODES.length, 3, 'F2 there are exactly three modes now');
ok(!ID.EMAILED_MODES.includes('manual') && ID.EMAILED_MODES.length === 2, 'F3 manual is NOT one of the emailed modes');
ok(typeof ID.MODE_LABEL.manual === 'string' && ID.MODE_LABEL.manual.length > 0, 'F4 manual has a label for the desk');
ok(/no email/i.test(ID.MODE_HELP.manual), 'F5 the manual help says no email is sent');
eq(ID.resolveFundingMode({ drawMode: 'manual' }), 'manual', 'F6 a stored manual choice resolves to manual');
// A MANUAL delivery is handled outside PILOT — it needs the note buyer set (so we record WHICH
// investor) but NO saved contacts (no email is sent). The borrower must still have agreed.
eq(ID.deliveryBlockers({ finding: { status: 'accepted' }, investorContacts: [], noteBuyer: 'Fidelis', mode: 'manual' }).length, 0,
  'F7 manual with a note buyer and NO contacts is ready — no email, so no contacts needed');
ok(ID.deliveryBlockers({ finding: { status: 'accepted' }, investorContacts: [], noteBuyer: '', mode: 'manual' }).some((b) => /no note buyer/.test(b)),
  'F8 manual still needs the note buyer set — the record must name which investor');
ok(ID.deliveryBlockers({ finding: { status: 'delivered' }, investorContacts: [], noteBuyer: 'Fidelis', mode: 'manual' })[0].includes('not agreed'),
  'F9 manual still requires the borrower to have agreed');
// An EMAILED mode with no contacts is still blocked (the manual carve-out must not leak to it).
ok(ID.deliveryBlockers({ finding: { status: 'accepted' }, investorContacts: [], noteBuyer: 'Fidelis', mode: 'reimbursement' }).some((b) => /No investor contacts/.test(b)),
  'F10 an EMAILED mode with no contacts is still blocked (the carve-out is manual-only)');

console.log(`test-investor-delivery-pure: all ${n} investor-delivery rule checks passed.`);
