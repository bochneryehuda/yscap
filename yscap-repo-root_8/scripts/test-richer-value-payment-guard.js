'use strict';
/**
 * PURE test — the three things a Richer Values order now decides for itself before
 * it costs money: WHO pays, WHETHER the loan is one we recommend this product for,
 * and WHAT happens to the scope of work when ours changes.
 *
 *   node scripts/test-richer-value-payment-guard.js
 *
 * No database, no network, no vendor. Every one of these is a rule the owner
 * stated in words, and each is written down here in the form the screen and the
 * server BOTH read — which is the point: a $400,000 threshold retyped in a React
 * file is exactly how a button comes to say one thing while the server does
 * another.
 */
const assert = require('assert');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const R = require('path').resolve(__dirname, '..');
const guard = require(R + '/src/richervalues/loan-guard');
const sow = require(R + '/src/richervalues/scope-of-work');
const payment = require(R + '/src/richervalues/payment');

/* ═══ A. the $400,000 rule ═══════════════════════════════════════════════ */
// The owner: *"if any loan amount is more than $400,000, we don't recommend Richer
// Value… If there is no loan amount registered yet, just let them know that it's
// better if they registered the loan amount before."*
{
  ok(guard.LOAN_LIMIT === 400000, 'A the limit is the owner’s number and lives in one place');

  const under = guard.judgeLoanAmount(399999);
  ok(under.level === 'ok' && !under.requiresDoubleConfirm && !under.message,
    'A a loan under the limit orders with nothing said');

  // The boundary belongs to the ALLOWED side: the owner said "more than", and a
  // file registered at exactly $400,000 is inside the product, not outside it.
  const exact = guard.judgeLoanAmount(400000);
  ok(exact.level === 'ok', 'A exactly $400,000 is NOT over the limit — the owner said “more than”');

  const over = guard.judgeLoanAmount(400001);
  ok(over.level === 'warn' && over.requiresDoubleConfirm && over.ack === 'over_400k',
    'A a dollar over the limit is the strict warning, and it needs a double confirmation');
  ok(/\$400,001/.test(over.title) && /\$400,000/.test(over.title),
    'A the warning names BOTH numbers — this loan, and the limit');
  ok(/investors might not accept/i.test(over.message),
    'A it says what it actually costs us: an investor may refuse the report');
  ok(over.confirmPrompt && over.secondPrompt && over.confirmPrompt !== over.secondPrompt,
    'A the two confirmations say DIFFERENT things — a second identical prompt is just a slower click');

  const none = guard.judgeLoanAmount(null);
  ok(none.level === 'advise' && !none.requiresDoubleConfirm,
    'A no loan amount registered is ADVICE, never a refusal — a brand-new file must still be able to order');
  ok(/register the loan amount before/i.test(none.message) && /\$400,000/.test(none.message),
    'A and the advice says WHY (they are shown what we expect) and states the limit');

  // Junk must never read as a number that happens to be under the limit. A blank,
  // a zero and a word are all "nobody has registered a loan amount".
  for (const bad of ['', '  ', 0, -1, NaN, undefined, 'four hundred thousand', {}]) {
    const j = guard.judgeLoanAmount(bad);
    ok(j.level === 'advise', `A ${JSON.stringify(String(bad))} reads as “not registered”, never as a small loan`);
  }
  // A string of digits IS a loan amount — every one of these arrives from a form.
  ok(guard.judgeLoanAmount('500000').level === 'warn', 'A a loan amount typed as text is still judged');
  // AND SO IS ONE WRITTEN THE WAY PEOPLE WRITE MONEY. A bare Number() on a grouped
  // value is NaN, which would read as "nothing registered" and let a $500,000 loan
  // through with only advice — so this goes through the repo's one money parser.
  ok(guard.judgeLoanAmount('500,000').level === 'warn', 'A a grouped "500,000" is judged, not read as “not registered”');
  ok(guard.judgeLoanAmount('$1,250,000.00').level === 'warn', 'A and one with a currency symbol and cents');
  ok(guard.judgeLoanAmount('$399,000').level === 'ok', 'A a grouped amount UNDER the limit is judged as under it, not warned about');
}

/* ═══ B. the double confirmation, on the SERVER ══════════════════════════ */
// A confirmation a client can skip by not rendering it is not a confirmation.
{
  const over = guard.judgeLoanAmount(750000);
  ok(guard.checkAcknowledged(over, []).ok === false, 'B ordering over the limit with nothing acknowledged is REFUSED');
  ok(guard.checkAcknowledged(over, []).code === 'loan_amount_over_limit', 'B and the refusal names itself');
  ok(guard.checkAcknowledged(over, ['something_else']).ok === false,
    'B some other token does not settle THIS warning');
  ok(guard.checkAcknowledged(over, ['over_400k']).ok === true, 'B the right token lets it through');
  ok(guard.checkAcknowledged(over, 'over_400k').ok === true, 'B a single token, not in an array, is still accepted');

  ok(guard.checkAcknowledged(guard.judgeLoanAmount(null), []).ok === true,
    'B the “no loan amount yet” advice never refuses an order');
  ok(guard.checkAcknowledged(guard.judgeLoanAmount(100000), []).ok === true,
    'B and an ordinary loan needs no acknowledgement at all');
  ok(guard.checkAcknowledged(null, []).ok === true, 'B nothing to judge is not a refusal');
}

/* ═══ C. the scope-of-work revision ═════════════════════════════════════ */
// Owner: *"updated scopes of work can be sent for revisions… we should be able to
// update the scope of work in their system if the scope of work updates in ours."*
// The action is decided by what the order is DOING, never by a clock.
{
  const at = (status, extra = {}) => sow.revisionPlanFor({ intake_token: 'tok', status, ...extra });

  for (const s of ['intake', 'ordered', 'on_hold', 'assigned', 'scheduled']) {
    ok(at(s).action === 'update', `C “${s}” — nothing has been valued yet, so the ORDER is updated`);
  }
  for (const s of ['inspected', 'in_review', 'quality_review']) {
    ok(at(s).action === 'upload', `C “${s}” — somebody is working on it, so the new file is sent straight over`);
  }
  for (const s of ['completed', 'delivered', 'report_ready']) {
    const p = at(s);
    ok(p.action === 'reopen' && p.reopenReason === 'new-budget',
      `C “${s}” — a finished report priced against a scope nobody is building is REOPENED with the new budget`);
  }
  for (const s of ['cancelled', 'rejected', 'error', 'draft']) {
    ok(at(s).action === 'none', `C “${s}” — there is no live order to revise`);
  }
  ok(sow.revisionPlanFor({ status: 'ordered' }).action === 'none',
    'C an order with no intake token at their end is nothing to revise');
  ok(at('ordered', { dryrun: true }).action === 'none',
    'C a test-mode order is never revised for real');
  // A status THEY invent tomorrow must still reach the appraiser. Uploading can
  // never undo work, so it is the safe reading — silence would not be.
  ok(at('some_status_nobody_has_seen').action === 'upload',
    'C an unrecognised status still sends the document rather than going quiet');
  ok(sow.revisionPlanFor(null).action === 'none', 'C and nothing at all is handled');

  // Every plan explains itself — the screen prints this before anyone commits.
  for (const s of ['ordered', 'in_review', 'completed', 'cancelled']) {
    ok(typeof at(s).why === 'string' && at(s).why.length > 20, `C the plan for “${s}” says why, in words`);
  }
}

/* ═══ D. which document IS the scope of work ════════════════════════════ */
// PDF first (an appraiser opens it on a phone at a property), then a spreadsheet.
// The HTML snapshot is a tool artifact and never goes — the investor package
// leaves it out for the same reason.
{
  const choose = sow._internals.choose;
  const doc = (filename, extra = {}) => ({ id: filename, filename, storage_ref: 'ref', ...extra });

  ok(choose([doc('sow.xlsx'), doc('sow.pdf')]).filename === 'sow.pdf',
    'D the PDF is preferred over the spreadsheet, whatever order they come back in');
  ok(choose([doc('sow.html'), doc('sow.xlsx')]).filename === 'sow.xlsx',
    'D the HTML snapshot is never chosen');
  ok(choose([doc('snapshot.htm')]) === null, 'D nor is an .htm one');
  ok(choose([doc('x.bin', { content_type: 'text/html' })]) === null,
    'D nor one that merely CLAIMS to be HTML by its type');
  ok(choose([doc('huge.pdf', { size_bytes: 999 * 1024 * 1024 })]) === null,
    'D a file far too big to send with an order is not chosen — that is the wrong file');
  ok(choose([{ id: 'x', filename: 'sow.pdf', storage_ref: null }]) === null,
    'D nor one whose stored copy is missing');
  ok(choose([doc('budget.docx')]).filename === 'budget.docx',
    'D with neither a PDF nor a spreadsheet, whatever there is still goes — an order with no scope of work is put On Hold');
  ok(choose([]) === null && choose(null) === null, 'D and nothing is nothing');
}

/* ═══ E. the four ways to pay, and the two that are NOT offered ═════════ */
// Owner: *"We don't want to allow Add to Invoice. We don't want to allow ACH."*
{
  assert(Array.isArray(payment.METHODS));
  ok(payment.METHODS.length === 4, 'E there are exactly four ways to pay');
  for (const m of ['COMPANY_CARD', 'CARD_ON_FILE', 'NEW_CARD', 'PAYMENT_LINK']) {
    ok(payment.METHODS.includes(m), `E ${m} is one of them`);
  }
  // OUR OWN CARD IS FIRST, and that ordering is the default the whole desk falls
  // back to — the owner's "we pay in-house, payment link as the backup".
  ok(payment.METHODS[0] === 'COMPANY_CARD',
    'E our own card is first, so it is what an unconfigured deployment reaches for');
  for (const m of ['ADD_TO_INVOICE', 'ACH']) {
    ok(!payment.METHODS.includes(m), `E ${m} is NOT offered`);
  }
  // USE_EXISTING_SOURCE is the VENDOR's wire word for charging a saved card. It is
  // what COMPANY_CARD sends, and it must never be offerable as a method itself —
  // asking for it directly would skip the "which card?" rule below.
  ok(!payment.METHODS.includes('USE_EXISTING_SOURCE'),
    'E USE_EXISTING_SOURCE is their wire word, never a method a screen can ask for');

  // The default a deployment starts with must be one of the three, or the very
  // first order would try a method the owner ruled out.
  const cfg = require(R + '/src/config');
  const configured = String((cfg.richerValue || {}).paymentMethod || '').toUpperCase();
  ok(payment.METHODS.includes(configured) || configured === 'NONE',
    `E the configured default (${configured || 'unset'}) is one of the allowed methods`);

  // Stripe's refusal to take a raw card number is told apart from every other
  // failure, because it has a KNOWN answer (their tech team) and "something went
  // wrong" would send somebody hunting for a problem at our end.
  ok(payment.isRawCardBlocked({ message: 'Sending credit card numbers directly to the Stripe API is generally unsafe' }),
    'E the Stripe raw-card refusal is recognised from its message');
  ok(payment.isRawCardBlocked({ body: { errors: [{ message: 'enable raw card data APIs' }] } }),
    'E and from their relayed body');
  ok(!payment.isRawCardBlocked({ message: 'card declined' }),
    'E an ordinary decline is NOT mistaken for it — that one is the borrower’s bank, not their Stripe settings');
  ok(!payment.isRawCardBlocked(null) && !payment.isRawCardBlocked({}),
    'E and nothing at all is not it either');
  ok(/tech@richervalues\.com/.test(payment.RAW_CARD_BLOCKED_MESSAGE)
    && /payment link/i.test(payment.RAW_CARD_BLOCKED_MESSAGE),
  'E the message says who can fix it AND what to do today');
}

/* ═══ E2. paying has THREE outcomes, and the screen must not collapse them ═ */
// A false success on a money action is the one thing that must be impossible. So
// `ok` ("did what you pressed happen?") and `settled` ("has the money moved?") are
// separate, and the order card's own handler is checked here at the SOURCE, since
// a passing HTTP call proves nothing about what the screen then says.
{
  const fs = require('fs');
  const card = fs.readFileSync(R + '/app-v2/src/components/AppraisalOrderSection.jsx', 'utf8');
  ok(/out\.ok === false/.test(card),
    'E2 the order card treats an explicit ok:false as a FAILURE — a refused charge can never read as “charged”');
  ok(/setNotice\(\(out && out\.note\)/.test(card),
    'E2 and it prefers the server’s own wording, so an asked-for payment link is reported as what it is');

  const svc = fs.readFileSync(R + '/src/richervalues/order-service.js', 'utf8');
  ok(/__payment/.test(svc) && /settled: true/.test(svc) && /settled: false/.test(svc),
    'E2 the server carries the verdict back rather than leaving the screen to infer it from paid_at');
  ok(/ok: askedForLink/.test(svc),
    'E2 a payment link the staffer CHOSE is a success; one a refused card fell through to is not');

  const route = fs.readFileSync(R + '/src/routes/richervalues.js', 'utf8');
  ok(/ok: !!p\.ok, settled: !!p\.settled/.test(route),
    'E2 and the pay route answers both, never one standing in for the other');
  ok(/payment\.METHODS\.includes\(method\)/.test(route),
    'E2 the pay route refuses any method outside the four — invoice and ACH cannot be asked for');
}

/* ═══ E3. OUR OWN CARD — the route the owner chose, wired end to end ═════ */
// Owner (2026-08-16), answering "in production, who pays Richer Values?":
// *"Both: our card, link as backup"* — we pay in-house by default, and a staffer can
// switch a single order to a payment link. Their CEO named the same two routes.
//
// This is the SOURCE check. The rules it stands on are exercised for real below in
// section G; what is asserted here is that every layer actually reaches for it, in
// the order the owner asked for — a server that defaults to our card while the
// button still says "charge the card on file" is exactly the drift this catches.
{
  const fs = require('fs');
  const R2 = R;

  const svc = fs.readFileSync(R2 + '/src/richervalues/order-service.js', 'utf8');
  ok(/method === 'COMPANY_CARD'/.test(svc), 'E3 the server has a COMPANY_CARD route');
  ok(/payment\.payWithCompanyCard\(/.test(svc),
    'E3 and it charges through the shared helper, never a private call of its own');
  // "LINK AS BACKUP" IS THE OTHER HALF OF THE OWNER'S ANSWER. An intake already
  // exists at the vendor by this point, so a payment problem must never throw the
  // order away — it falls through to the link exactly as the other card routes do.
  const ccBranch = svc.slice(svc.indexOf("if (method === 'COMPANY_CARD')"));
  ok(/return sendLink\(/.test(ccBranch.slice(0, 800)),
    'E3 a failed company-card charge falls through to the payment link — the owner’s “link as backup”');

  const cfgSrc = fs.readFileSync(R2 + '/src/config.js', 'utf8');
  ok(/RV_PAYMENT_METHOD \|\| 'COMPANY_CARD'/.test(cfgSrc),
    'E3 an unconfigured deployment pays with OUR card, not the Stripe-blocked file card');
  ok(/RV_PAYMENT_SOURCE_ID/.test(cfgSrc),
    'E3 and the card can be named explicitly when the account holds more than one');

  const card = fs.readFileSync(R2 + '/app-v2/src/components/AppraisalOrderSection.jsx', 'utf8');
  ok(/COMPANY_CARD: '/.test(card), 'E3 the order screen has a label for it — an unlabelled method renders as a raw token');
  ok(/\['COMPANY_CARD', 'CARD_ON_FILE', 'NEW_CARD', 'PAYMENT_LINK'\]/.test(card),
    'E3 it is in the screen’s own fallback list, in the same order the server offers');
  ok(/payment\.method \|\| 'COMPANY_CARD'/.test(card),
    'E3 and it is what the picker starts on');
  ok(!/method: 'CARD_ON_FILE'/.test(card),
    'E3 no button still hard-codes the Stripe-blocked file card — that one can only end in a refusal today');
}

/* ═══ F. an expired card is not a usable card ═══════════════════════════ */
{
  const isExpired = payment._internals.isExpired;
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;

  ok(isExpired(12, thisYear - 1) === true, 'F last year’s card is expired');
  ok(isExpired(thisMonth, thisYear) === false, 'F a card expiring THIS month is still good — it runs to month end');
  ok(isExpired(1, thisYear + 5) === false, 'F a card years out is fine');
  ok(isExpired(null, null) === false, 'F an unknown expiry is not claimed to be expired');
  ok(isExpired('x', 'y') === false, 'F nor is junk');
}

/* ═══ G. WHICH company card to charge — it never guesses, never sees ACH ═ */
// Two cards on the account is a money decision belonging to a person: the wrong one
// is charged silently and nothing on any screen would say so. So more than one is a
// REFUSAL, not a pick. These run the REAL function against a stubbed vendor — the
// rules are the whole safety of the route the owner made the default, so asserting
// them by reading the source would prove nothing.
//
// LAST, and async, so the summary below runs after it. The vendor call is stubbed
// by swapping ONE property on the client and putting it back afterwards, so nothing
// else in this file sees a different module.
(async () => {
  const client = require(R + '/src/richervalues/client');
  const realPaymentSources = client.paymentSources;
  const sources = (creditCards, ach) => async () => ({ data: { paymentSources: { stripe: { creditCards, ach } } } });
  const CARD = { payment_source_id: 'src_1', last_4: '4242', brand: 'Visa', exp_month: 12, exp_year: 2030 };

  try {
    // ONE card — unambiguous, so it is used. And the ACH source sitting beside it is
    // never even seen: the owner forbade ACH outright, and reading only `creditCards`
    // makes it unreachable rather than merely unlisted.
    client.paymentSources = sources([CARD], [{ payment_source_id: 'ach_1', last_4: '9999' }]);
    const one = await payment.resolveCompanySource('co_tok', null);
    ok(one.ok === true && one.paymentSourceId === 'src_1',
      'G exactly one card on the account is unambiguous, so it is used');
    ok(one.card && one.card.last4 === '4242',
      'G and it reports WHICH card, so the screen can name it before anyone presses pay');

    const listed = await payment.listCompanyCards('co_tok');
    ok(listed.ok && listed.cards.length === 1 && listed.cards[0].id === 'src_1',
      'G the list reads the CARD side only — an ACH source on the account is unreachable, not merely unlisted');

    // TWO cards — a refusal, and this is the assertion the whole route rests on.
    client.paymentSources = sources([CARD, { payment_source_id: 'src_2', last_4: '1111', brand: 'Amex' }]);
    const both = await payment.resolveCompanySource('co_tok', null);
    ok(both.ok === false && both.code === 'several_company_cards',
      'G TWO cards is a REFUSAL, not a pick — charging the wrong company card is silent');
    ok(/4242/.test(both.error) && /1111/.test(both.error),
      'G and the refusal names the cards, so a human can choose one');
    ok(/RV_PAYMENT_SOURCE_ID/.test(both.error) && /payment link/i.test(both.error),
      'G it also says both ways forward — name the card, or send the link');

    // A configured id is an operator naming a card deliberately, so it wins outright
    // and does not even ask — which is what makes the two-card state fixable.
    const named = await payment.resolveCompanySource('co_tok', 'src_2');
    ok(named.ok === true && named.paymentSourceId === 'src_2',
      'G a configured card id wins, so a two-card account is not a dead end');

    client.paymentSources = sources([]);
    const none = await payment.resolveCompanySource('co_tok', null);
    ok(none.ok === false && none.code === 'no_company_card',
      'G no card on the account is the ordinary not-set-up-yet state');
    ok(/Richer Values portal/i.test(none.error) && /payment link/i.test(none.error),
      'G and it says exactly what a human has to go and do about it');

    // AN OUTAGE IS NOT A CARD LIST. It refuses rather than guessing, and refusing
    // ends at the payment link — which is the safe direction on a money action.
    client.paymentSources = async () => { throw new Error('502 Bad Gateway'); };
    const broken = await payment.resolveCompanySource('co_tok', null);
    ok(broken.ok === false && broken.code === 'sources_unreadable',
      'G an unreadable list is a refusal, never a guess');
    const brokenList = await payment.listCompanyCards('co_tok');
    ok(brokenList.ok === false && brokenList.cards.length === 0,
      'G the list NEVER throws; an outage reads as “no cards”');

    const noTok = await payment.listCompanyCards(null);
    ok(noTok.ok === false, 'G and with no company token there is nothing to ask about');

    // Paying with no intake is refused BEFORE the vendor is asked anything.
    const noIntake = await payment.payWithCompanyCard('', { companyToken: 'co_tok' });
    ok(noIntake.ok === false && noIntake.code === 'no_intake',
      'G paying for an intake that does not exist yet is refused before any call');
  } finally {
    client.paymentSources = realPaymentSources;
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\ntest-richer-value-payment-guard: all checks passed');
  process.exit(failures ? 1 : 0);
})();
