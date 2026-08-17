#!/usr/bin/env node
'use strict';
/**
 * THE THREE WAYS TO PAY FOR AN APPRAISAL — the shared definition.
 *
 * Owner-directed 2026-08-16: *"We're gonna keep it manual. We're gonna have all
 * the options over there … send the payment link … use the card on file … use the
 * card manually. We should keep all the options open."*
 *
 * Two things this suite exists to stop, both of which are silent:
 *   1. AN OPTION QUIETLY DISAPPEARING on one vendor. That is the exact state the
 *      owner was complaining about — Richer Values had all three and the other two
 *      companies had none — and nothing would fail if it came back.
 *   2. A BUTTON CLAIMING TO CHARGE SOMETHING IT CANNOT. "Pressing this charges it"
 *      and "we write it down and somebody charges it by hand" must never render
 *      the same, and an unrecognised vendor must fall to the safe side.
 *
 * Pure — no database, no network.
 */

const assert = require('assert');
const O = require('../src/lib/appraisal/payment-options');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.error('FAIL ' + name); } };
const eq = (a, b, name) => {
  try { assert.deepStrictEqual(a, b); pass++; console.log('PASS ' + name); }
  catch (_) { fail++; console.error(`FAIL ${name} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
};

console.log('\n1. the vocabulary carries the owner\'s three, and every way any company has');
// THIS ASSERTION DELIBERATELY CHANGED (2026-08-16). It used to pin the flat array
// to exactly the owner's three. On the same day, from the same instruction read
// from the Richer Values end, #1198 added a FOURTH that exists there and nowhere
// else — COMPANY_CARD, the card YS Capital keeps on their account, which is the
// one card route their Stripe does not refuse. Pinning "exactly three" here would
// have meant deleting a real production capability to make a test pass.
//
// WHAT THE GUARD IS NOW: the owner's three are all present and still lead, in the
// owner's order, and the array may only ever grow by a way some company genuinely
// has. The thing it protects — an option quietly disappearing — is unchanged, and
// is asserted per vendor in section 3 where it actually bites.
eq(O.METHODS.slice(0, 3), ['PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD'],
  'send a payment link, use the card on file, enter a card now — first, and in order');
ok(O.METHODS.includes('COMPANY_CARD'),
  'and the fourth Richer Values genuinely has: pay on our own card');
ok(O.METHODS.every((m) => O.METHOD_LABEL[m] && O.METHOD_BLURB[m]),
  'every one has a name and a sentence a person can read');
// Invoice and ACH were refused by name on 2026-08-14 and must not creep back in
// through a widened list.
ok(!O.METHODS.some((m) => /INVOICE|ACH/i.test(m)),
  'invoice and ACH are still not among them');

console.log('\n2. ONE definition — Richer Values does not keep a second copy');
{
  const rv = require('../src/richervalues/payment');
  // It is no longer the very same ARRAY OBJECT, because Richer Values asks the
  // table what IT offers (`methodsFor('rv')`) rather than taking the whole
  // vocabulary — which is what lets it have the fourth without advertising it on
  // the two companies that cannot do it. The anti-drift property is the one that
  // matters and is asserted directly: its list is DERIVED from this module, so a
  // change here moves it and a second hand-written copy would fail this.
  eq(rv.METHODS, O.methodsFor('rv'),
    'richervalues/payment.js takes its list from this module — not a copy that can drift');
  ok(rv.METHODS.includes('COMPANY_CARD'),
    'and Richer Values still offers the company card, which only it has');
  // A source guard, because the equality above would also pass if somebody
  // re-typed the same four strings by hand today and the two drifted tomorrow.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/richervalues/payment.js'), 'utf8');
  ok(/methodsFor\(\s*['"]rv['"]\s*\)/.test(src) && !/const METHODS\s*=\s*\[/.test(src),
    'it asks for the list rather than declaring one');
}

console.log('\n3. every appraisal company offers the owner\'s three — that is the whole ask');
for (const v of O.VENDORS) {
  const opts = O.optionsFor(v, { cardOnFile: { present: true } });
  // Per vendor, because the offer is per vendor now. The owner's ask — all three
  // ways open on every company — is asserted directly rather than via the flat
  // array, so it keeps biting no matter what any one vendor adds.
  for (const m of ['PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD']) {
    ok(opts.some((o) => o.method === m), `${O.VENDOR_NAME[v]} offers ${m}`);
  }
  eq(opts.map((o) => o.method), O.methodsFor(v), `${O.VENDOR_NAME[v]} offers exactly what it can, in its own order`);
  ok(opts.every((o) => o.does !== O.DOES.UNAVAILABLE),
    `${O.VENDOR_NAME[v]} has no option that is simply missing`);
  ok(opts.every((o) => o.says && o.says.length > 10),
    `${O.VENDOR_NAME[v]} says what each one will do`);
}

console.log('\n3b. the company card is Richer Values only — never advertised elsewhere');
{
  ok(O.methodsFor('rv')[0] === 'COMPANY_CARD',
    'Richer Values leads with it, as the owner asked');
  for (const v of ['nan', 'class']) {
    ok(!O.methodsFor(v).includes('COMPANY_CARD'),
      `${O.VENDOR_NAME[v]} does not offer it — there is no such card there`);
    ok(!O.optionsFor(v, { cardOnFile: { present: true } }).some((o) => o.method === 'COMPANY_CARD'),
      `${O.VENDOR_NAME[v]} does not even render it as a dead row`);
    ok(O.capability(v, 'COMPANY_CARD').does === O.DOES.UNAVAILABLE,
      `${O.VENDOR_NAME[v]} answers "unavailable" if something asks anyway`);
  }
  // An unknown vendor must not be handed a way that only one company has.
  ok(!O.methodsFor('zzz').includes('COMPANY_CARD'),
    'an unrecognised company is never offered it either');
}

console.log('\n4. who actually performs it differs, and is never blurred');
{
  // Richer Values is the ONLY company whose payment calls this repo has
  // (addCard / payForOrder / sendPaymentLink in richervalues/client.js).
  const rv = O.optionsFor('rv', { cardOnFile: { present: true } });
  ok(rv.every((o) => o.does === O.DOES.VENDOR),
    'Richer Values carries out all three itself');

  // APPRAISALSCOPE MOVED TO `vendor` ON 2026-08-16, owner-directed: *"I want to be
  // a real vendor charge, yes. I want them to charge the credit card that I'm
  // importing."* It was back-office for exactly one reason — no payment request had
  // been verified against their contract — and that reason is gone: their own
  // client package is in the repository and cdg.js builds their requests from it.
  ok(O.optionsFor('nan', { cardOnFile: { present: true } }).every((o) => o.does === O.DOES.VENDOR),
    'AppraisalScope carries out all three itself now');

  // Class Valuation's client still has NO payment call of any kind, so it stays
  // back-office. This is the assertion that keeps the distinction honest.
  ok(O.optionsFor('class', { cardOnFile: { present: true } }).every((o) => o.does === O.DOES.BACK_OFFICE),
    'Class Valuation is recorded for the back office — nothing here claims to charge it');
}

console.log('\n4b. a company may only be marked `vendor` if the request actually exists');
{
  // THE GUARD THAT REPLACES "AppraisalScope is back-office". The old assertion
  // protected one thing: that this table never claims a capability the code does
  // not have. Marking a row `vendor` when nothing can perform it puts a charge
  // button in front of a person that either does nothing or, far worse, sends a
  // guessed request at a money endpoint. So rather than pinning one vendor's
  // answer, this pins the RULE — and it keeps biting for whichever vendor is
  // wired up next.
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // What each vendor's payment code must contain for each way it claims to perform.
  // A method named here is only credible if the named module really builds/sends it.
  const PROOF = {
    nan: {
      module: 'src/amc/payment.js',
      PAYMENT_LINK: /buildSendInvoice/,
      CARD_ON_FILE: /buildPaymentAuthCapture/,
      NEW_CARD: /buildPaymentAuthCapture/,
    },
    rv: {
      module: 'src/richervalues/payment.js',
      PAYMENT_LINK: /sendPaymentLink/,
      CARD_ON_FILE: /payForOrder/,
      NEW_CARD: /payForOrder/,
      COMPANY_CARD: /payForOrder/,
    },
  };
  for (const v of O.VENDORS) {
    for (const m of O.methodsFor(v)) {
      if (O.capability(v, m).does !== O.DOES.VENDOR) continue;
      const proof = PROOF[v];
      ok(!!proof, `${O.VENDOR_NAME[v]} claims to perform ${m} — and there is a module named for it`);
      if (!proof) continue;
      const src = read(proof.module);
      ok(proof[m] && proof[m].test(src),
        `${O.VENDOR_NAME[v]}'s ${m} is really built in ${proof.module}, not just claimed in the table`);
    }
  }
  // And the inverse: a back-office row must NOT be quietly performing anything.
  ok(O.capability('class', 'CARD_ON_FILE').does === O.DOES.BACK_OFFICE,
    'Class Valuation still has no payment call, so its rows stay honest about that');
}

console.log('\n5. the card-on-file option is DISABLED WITH A REASON, never hidden');
{
  const none = O.optionsFor('nan', {}).find((o) => o.method === 'CARD_ON_FILE');
  ok(!none.available && /no card on this file/i.test(none.disabled),
    'no card yet — it stays on screen and points at "Enter a card now"');

  const expired = O.optionsFor('nan', { cardOnFile: { present: true, expired: true } })
    .find((o) => o.method === 'CARD_ON_FILE');
  ok(!expired.available && /expired/i.test(expired.disabled),
    'an expired card says so, and names both ways out');

  // The other two are never gated on the card — a payment link needs no card at
  // all, and "enter a card now" is the thing you press BECAUSE there is no card.
  const rest = O.optionsFor('nan', {}).filter((o) => o.method !== 'CARD_ON_FILE');
  ok(rest.every((o) => o.available),
    'the payment link and a new card are offered whether or not a card is on file');
}

console.log('\n6. the one caveat rides with the option it belongs to');
{
  const rvCard = O.optionsFor('rv', { cardOnFile: { present: true } })
    .find((o) => o.method === 'CARD_ON_FILE');
  ok(/cannot take a card number/i.test(rvCard.caveat || ''),
    'Richer Values card charges carry their measured Stripe caveat');
  ok(rvCard.available,
    'and it is still OFFERED — their setting can be switched on any day, so a button '
    + 'disabled from a stale note would be wrong in the expensive direction');
  ok(!O.optionsFor('rv', {}).find((o) => o.method === 'PAYMENT_LINK').caveat,
    'the payment link, which works today, carries no caveat');
}

console.log('\n7. an unrecognised vendor or method falls to the SAFE side');
{
  const bogus = O.capability('acme', 'CARD_ON_FILE');
  eq(bogus.does, O.DOES.UNAVAILABLE, 'an unknown appraisal company offers nothing');
  const badMethod = O.capability('nan', 'WIRE');
  eq(badMethod.does, O.DOES.UNAVAILABLE, 'an unknown way to pay is not quietly enabled');
  ok(O.optionsFor('acme', {}).every((o) => !o.available),
    'and nothing on an unknown vendor renders as pressable');
  // It feeds a screen, so it must degrade rather than throw.
  ok(!!O.capability(null, null) && !!O.optionsFor(undefined, undefined),
    'null and undefined are answered, not thrown at');
  ok(!O.isVendor('') && !O.isMethod('') && !O.isMethod('card_on_file '.trim() + 'x'),
    'the guards refuse blanks and near-misses');
  ok(O.isMethod('card_on_file') && O.isVendor('NAN'),
    'but casing is forgiven, because these arrive from a form');
}

console.log('\n8. "to be paid" and "paid" are different sentences');
{
  const chosen = O.describeIntent({ vendor: 'nan', method: 'PAYMENT_LINK', settled_at: null });
  ok(/^To be paid/.test(chosen.head), 'an unsettled link reads as still to be paid');

  const paid = O.describeIntent({ vendor: 'nan', method: 'PAYMENT_LINK', settled_at: new Date() });
  ok(/^Paid/.test(paid.head) && paid.settled, 'once settled it reads as paid');
  ok(!paid.awaitingBackOffice, 'and stops asking anybody to do anything');

  // THE DISTINCTION THAT MATTERS, and it now covers TWO vendors: an unsettled
  // payment on a company that performs its own payments is waiting on the VENDOR or
  // the BORROWER, never on our back office. Telling the desk to go and charge it
  // would be wrong — and it moved from one vendor to two on 2026-08-16 when
  // AppraisalScope's payment requests were built, which is exactly the kind of
  // change a per-vendor hard-coded expectation would have hidden.
  for (const v of ['rv', 'nan']) {
    const pending = O.describeIntent({ vendor: v, method: 'PAYMENT_LINK', settled_at: null });
    ok(!pending.awaitingBackOffice,
      `an unsettled ${O.VENDOR_NAME[v]} link is NOT on the back office's list — they sent it`);
  }
  // And the one company that IS still waiting on a person says so.
  const classPending = O.describeIntent({ vendor: 'class', method: 'PAYMENT_LINK', settled_at: null });
  ok(classPending.awaitingBackOffice,
    'a Class Valuation instruction is still waiting on somebody here — nothing can carry it out');

  ok(O.describeIntent(null) === null && O.describeIntent({}) === null,
    'nothing chosen yet describes as nothing, rather than as an empty instruction');

  // Each method reads as itself — a desk that called them all "paid" would defeat
  // the point of recording which one was chosen. Counted against the vocabulary
  // rather than against the number three, so adding a way cannot silently make two
  // of them share a sentence.
  const heads = O.METHODS.map((m) => O.describeIntent({ vendor: 'rv', method: m, settled_at: null }).head);
  ok(new Set(heads).size === O.METHODS.length, 'every way reads differently on the desk');
  ok(heads.every((h) => h && /^To be /.test(h)), 'and every one of them reads as not yet done');

  // THE TAIL USED TO BE A CATCH-ALL that named the borrower's card, so the day a
  // fourth way arrived the desk would have printed a confident, wrong sentence
  // about a card nobody could point at, with nothing failing anywhere.
  const cc = O.describeIntent({ vendor: 'rv', method: 'COMPANY_CARD', settled_at: null });
  ok(/our own card/i.test(cc.head) && !/entered here|on file/i.test(cc.head),
    'the company card is described as ours — never as the card entered on the file');
  ok(!cc.awaitingBackOffice,
    'and Richer Values charges it, so it is not on the back office\'s list');
  ok(/Paid on our own card/.test(O.describeIntent({ vendor: 'rv', method: 'COMPANY_CARD', settled_at: new Date() }).head),
    'once settled it reads as paid on our own card');
  // An unrecognised method says only what is certain rather than naming a card.
  const unknown = O.describeIntent({ vendor: 'rv', method: 'SOMETHING_NEW', settled_at: null });
  ok(unknown.head === 'To be paid' && !/card|link/i.test(unknown.head),
    'an unrecognised way names no card and no link');
}

console.log('\n9. "what does this file\'s card look like" has ONE answer');
{
  // There were two, and they had drifted: Richer Values answered `{present, …,
  // expired}` and AppraisalScope answered `{onFile, …, conditionStatus}` — a
  // different key for the same boolean. A caller written against one shape and
  // handed the other reads a card that IS on file as absent, silently, and greys
  // out "use the card on file" with a reason that is not true. That went live the
  // moment a third caller appeared. Both vendors now delegate.
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const body = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const shared = require('../src/lib/appraisal-card');
  ok(typeof shared.cardStatus === 'function',
    'the shared card module answers it');

  for (const f of ['src/richervalues/payment.js', 'src/amc/order-service.js']) {
    ok(!/(async\s+)?function\s+cardStatus\s*\(/.test(body(f)),
      `${f.split('/').pop()} no longer keeps its own copy`);
  }
  // And nothing may reach past the shared module into a vendor's for it.
  ok(!/require\([^)]*richervalues\/payment[^)]*\)\.cardStatus/.test(body('src/routes/staff.js')),
    'the shared staff route asks the card module, not Richer Values');

  // The shape must carry BOTH historical key names, or one of the two vendors'
  // existing callers silently starts reading "no card".
  const empty = shared.cardStatus(
    { query: async () => { throw new Error('no db'); } }, 'x');
  ok(empty instanceof Promise, 'it is async, like both callers expect');
  ok(shared.isCardExpired(1, 1990) === true && shared.isCardExpired(null, null) === false,
    'an unknown expiry is NOT expired — a usable card is never refused on a blank');
}

console.log(fail ? `\n${fail} FAILURE(S)` : `\nOK  appraisal-payment-options-pure: ${pass} checks passed`);
process.exit(fail ? 1 : 0);
