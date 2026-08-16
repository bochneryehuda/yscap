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

console.log('\n1. the vocabulary is the owner\'s three, in the owner\'s order');
eq(O.METHODS, ['PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD'],
  'send a payment link, use the card on file, enter a card now');
ok(O.METHODS.every((m) => O.METHOD_LABEL[m] && O.METHOD_BLURB[m]),
  'every one has a name and a sentence a person can read');
// Invoice and ACH were refused by name on 2026-08-14 and must not creep back in
// through a widened list.
ok(!O.METHODS.some((m) => /INVOICE|ACH/i.test(m)),
  'invoice and ACH are still not among them');

console.log('\n2. ONE definition — Richer Values does not keep a second copy');
{
  const rv = require('../src/richervalues/payment');
  ok(rv.METHODS === O.METHODS,
    'richervalues/payment.js re-exports this very array — not a copy that can drift');
}

console.log('\n3. every appraisal company offers all three — that is the whole ask');
for (const v of O.VENDORS) {
  const opts = O.optionsFor(v, { cardOnFile: { present: true } });
  eq(opts.map((o) => o.method), O.METHODS, `${O.VENDOR_NAME[v]} offers all three, in order`);
  ok(opts.every((o) => o.does !== O.DOES.UNAVAILABLE),
    `${O.VENDOR_NAME[v]} has no option that is simply missing`);
  ok(opts.every((o) => o.says && o.says.length > 10),
    `${O.VENDOR_NAME[v]} says what each one will do`);
}

console.log('\n4. who actually performs it differs, and is never blurred');
{
  // Richer Values is the ONLY company whose payment calls this repo has
  // (addCard / payForOrder / sendPaymentLink in richervalues/client.js).
  const rv = O.optionsFor('rv', { cardOnFile: { present: true } });
  ok(rv.every((o) => o.does === O.DOES.VENDOR),
    'Richer Values carries out all three itself');

  // Class Valuation's client has NO payment call of any kind, and AppraisalScope's
  // payment actions have no verified request shape. Both are back-office, and a
  // future verified endpoint moves them in ONE place.
  for (const v of ['nan', 'class']) {
    ok(O.optionsFor(v, { cardOnFile: { present: true } }).every((o) => o.does === O.DOES.BACK_OFFICE),
      `${O.VENDOR_NAME[v]} is recorded for the back office — nothing here claims to charge it`);
  }
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
  ok(chosen.awaitingBackOffice, 'and on AppraisalScope it is waiting on a person here');

  const paid = O.describeIntent({ vendor: 'nan', method: 'PAYMENT_LINK', settled_at: new Date() });
  ok(/^Paid/.test(paid.head) && paid.settled, 'once settled it reads as paid');
  ok(!paid.awaitingBackOffice, 'and stops asking anybody to do anything');

  // THE DISTINCTION THAT MATTERS: an unsettled Richer Values payment is waiting on
  // the VENDOR or the BORROWER, not on our back office. Telling the desk to go and
  // charge it would be wrong.
  const rvPending = O.describeIntent({ vendor: 'rv', method: 'PAYMENT_LINK', settled_at: null });
  ok(!rvPending.awaitingBackOffice,
    'an unsettled Richer Values link is NOT on the back office\'s list — they sent it');

  ok(O.describeIntent(null) === null && O.describeIntent({}) === null,
    'nothing chosen yet describes as nothing, rather than as an empty instruction');

  // Each method reads as itself — a desk that called them all "paid" would defeat
  // the point of recording which one was chosen.
  const heads = O.METHODS.map((m) => O.describeIntent({ vendor: 'nan', method: m, settled_at: null }).head);
  ok(new Set(heads).size === 3, 'all three read differently on the desk');
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
