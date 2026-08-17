'use strict';
/**
 * THE APPRAISALSCOPE PAYMENT REQUESTS, AGAINST THE VENDOR'S OWN SAMPLES.
 *
 * Every field name in `cdg.buildPayment*` was copied from the vendor's client
 * package, which is in this repository at `docs/vendor/appraisalscope/`. This test
 * reads those sample files and compares what we BUILD to what they SHIP — so the
 * contract is checked against the vendor's artifact rather than against a second
 * hand-typed list that would drift from it the day either changed.
 *
 * It also pins the two things about a payment request that are not about field
 * names at all, and that a shape comparison would happily pass while the feature
 * was dangerously wrong:
 *
 *   • THE CARD NEVER SURVIVES MASKING. Everything built here is journaled and
 *     logged, so `cdg.maskRequest` is the only thing between a card number and
 *     permanent storage in our own database.
 *   • THERE IS NO AMOUNT ON AN AUTH-CAPTURE. The vendor's guide says it charges
 *     "the full payment amount" already agreed on the order; sending a number
 *     would be us choosing the price.
 *
 * PURE — no database, no network. Runs anywhere.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cdg = require(path.join(ROOT, 'src/amc/cdg'));
const SAMPLES = path.join(ROOT, 'docs/vendor/appraisalscope/samples/Orders');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.error('FAIL ' + m); } };

const sample = (name) => JSON.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8'));
const payOf = (msg) => msg.message.products[0].payments[0];
const actionOf = (msg) => msg.message.requestActionType;
const refsOf = (msg, side) => (msg.message[side] || {}).referenceIdentifiers || [];
const refVal = (msg, side, type) => {
  const hit = refsOf(msg, side).find((r) => r.referenceIdentifierType === type);
  return hit ? hit.referenceIdentifierValue : null;
};

// The card the vendor's own samples use — the published Visa test PAN.
const CARD = {
  referenceId: '38298',
  firstName: 'API', lastName: 'Testing',
  address1: '501 NE 122nd St', address2: 'Apt B',
  city: 'OKLAHOMA CITY', state: 'OK', postalCode: '73114', country: 'United States',
  phone: '555-222-5555', email: 'brittthompson@corelogic.com',
  cardNumber: '4012888888881881', securityCode: '111',
  expMonth: '01', expYear: '2022',
};
const CTX = { apiKey: 'THE-KEY', subdomain: 'integrations.uat', clientOrderNumber: '1234AB', spOrderNumber: 'SP345' };

console.log('\n1. PaymentAuthCapture is the vendor\'s own shape, field for field');
{
  const built = cdg.buildPaymentAuthCapture({ ...CTX, payment: CARD });
  const theirs = sample('CDG JSON paymentauthcapture request.json');

  ok(actionOf(built) === 'PaymentAuthCapture', 'the action is what their sample calls it');
  ok(actionOf(built) === actionOf(theirs), 'and it matches their sample exactly');

  // EVERY key they send, we send. This is the assertion that catches a renamed or
  // dropped field — including one dropped by a well-meaning refactor here.
  const theirKeys = Object.keys(payOf(theirs)).sort();
  const ourKeys = Object.keys(payOf(built)).sort();
  assert.deepStrictEqual(ourKeys, theirKeys);
  ok(true, `all ${theirKeys.length} payment fields match their sample's, with nothing extra`);

  // And the VALUES are the ones we were handed — a builder that quietly normalised
  // a card number into something else would pass a key comparison.
  ok(payOf(built).paymentAccountIdentifier === '4012888888881881', 'the card number is sent as digits');
  ok(payOf(built).paymentAccountCardSecurityCode === '111', 'the security code is sent');
  ok(payOf(built).paymentReferenceIdentifier === '38298', 'our own payment reference rides along');

  // The envelope halves.
  ok(refVal(built, 'clientSystem', 'ApiKey') === 'THE-KEY', 'the api key is in the client system');
  ok(refVal(built, 'clientSystem', 'ClientOrderNumber') === '1234AB', 'our order number identifies the order');
  ok(refVal(built, 'serviceProviderSystem', 'ServiceProviderSubDomain') === 'integrations.uat', 'the subdomain is theirs');
  ok(refVal(built, 'serviceProviderSystem', 'ServiceProviderOrderNumber') === 'SP345', 'and their order number');
}

console.log('\n2. NO AMOUNT — the fee is the one already agreed on the order');
{
  const built = cdg.buildPaymentAuthCapture({ ...CTX, payment: { ...CARD, paymentTotalAmount: '999.99', amount: 999.99 } });
  ok(!('paymentTotalAmount' in payOf(built)),
    'an auth-capture carries no amount, even when a caller tries to pass one');
  // Their PartialPayment sample is the request that DOES take one — proving the
  // omission above is the contract and not an oversight.
  ok('paymentTotalAmount' in payOf(sample('CDG JSON partialpayment request.json')),
    'their PartialPayment sample is the one with an amount — a different action, on purpose');
}

console.log('\n3. the card NEVER survives masking');
{
  for (const [name, built] of [
    ['auth-capture', cdg.buildPaymentAuthCapture({ ...CTX, payment: CARD })],
  ]) {
    const masked = JSON.stringify(cdg.maskRequest(built));
    ok(!masked.includes('4012888888881881'), `${name}: the full card number is gone`);
    ok(!/"paymentAccountCardSecurityCode":"111"/.test(masked), `${name}: the security code is gone`);
    ok(/\*\*\*\*1881/.test(masked), `${name}: the last four survive, which is what a receipt shows anyway`);
    ok(!masked.includes('THE-KEY'), `${name}: and the api key is masked as it always was`);
    // The journal's value is being able to read back what was sent — masking must
    // not hollow the request out.
    const back = cdg.maskRequest(built);
    ok(back.message.requestActionType === built.message.requestActionType,
      `${name}: the action is still legible after masking`);
    ok(back.message.products[0].payments[0].paymentAccountCardHolderEmail === CARD.email,
      `${name}: and so is everything that is not a secret`);
  }
  // A masked request must be safe even when the card is written oddly.
  const spaced = cdg.buildPaymentAuthCapture({ ...CTX, payment: { ...CARD, cardNumber: '4012 8888 8888 1881' } });
  ok(!JSON.stringify(cdg.maskRequest(spaced)).includes('88881881'),
    'a card typed with spaces is masked too — the builder normalises before it is stored');
}

console.log('\n4+5. THE VAULT-THEN-CHARGE-LATER ROUTE IS NOT BUILT, and must not come back as two builders');
{
  // AppraisalScope offers a second way to take money: PaymentToCaptureLeter vaults
  // the card without charging it, PaymentCapture charges the vaulted card later.
  // Builders for both existed and NOTHING called them — a two-request money path
  // that had never been sent, with no route, no button and no record of which
  // orders were vaulted. It answers a problem PILOT does not have (the card is
  // already stored here) and doubles the states a payment can be stuck in, on the
  // one path where being wrong costs real money.
  ok(typeof cdg.buildPaymentToCaptureLater === 'undefined', 'the vault builder is gone');
  ok(typeof cdg.buildPaymentCapture === 'undefined', 'the capture-a-vaulted-card builder is gone');
  const src = fs.readFileSync(path.join(ROOT, 'src/amc/cdg.js'), 'utf8');
  ok(!/requestActionType:\s*'(PaymentToCaptureLeter|PaymentCapture)'/.test(src),
    'and nothing in cdg.js emits either action');
  // What it would take is recorded where the builders were, so the next person does
  // not mistake two envelopes for the job.
  ok(/VAULT-THEN-CHARGE-LATER ROUTE IS DELIBERATELY NOT BUILT/.test(src),
    'the reasoning is recorded in the file, not lost with the code');
  // The ONE way money moves is still exactly as it was.
  ok(actionOf(cdg.buildPaymentAuthCapture({ ...CTX, payment: CARD })) === 'PaymentAuthCapture',
    'the single-step charge is untouched');
}

console.log('\n6. SendInvoice names ONE address, the way their sample does');
{
  const built = cdg.buildSendInvoice({ ...CTX, email: 'yourEmail@corelogic.com' });
  const theirs = sample('CDG JSON sendinvoice request.json');
  ok(actionOf(built) === 'SendInvoice', 'the action is theirs');
  assert.deepStrictEqual(
    Object.keys(built.message.products[0]).sort(),
    Object.keys(theirs.message.products[0]).sort());
  ok(true, 'the product block carries only notifications, as theirs does');
  ok(built.message.products[0].notifications.length === 1,
    'one recipient per call — the plural array is not trusted to fan out (see the builder)');
  ok(built.message.products[0].notifications[0].contactEmail === 'yourEmail@corelogic.com',
    'and it is the address we were given');
  ok(!built.message.products[0].payments, 'an invoice request carries no card at all');
}

console.log('\n7. the receipt is read out of their own response shape');
{
  for (const f of ['CDG JSON paymentauthcapture response.json', 'CDG JSON paymentcapture response.json']) {
    ok(cdg.parsePaymentTransactionId(sample(f)) === '40064185551', `${f}: the transaction id is found`);
  }
  // A response with no receipt must answer null, NOT throw and NOT invent one —
  // the caller turns null into "we do not know", which is the safe reading.
  ok(cdg.parsePaymentTransactionId(sample('CDG JSON sendinvoice response.json')) === null,
    'a response with no payment block answers null');
  for (const junk of [null, undefined, {}, { message: {} }, { message: { products: 'x' } },
    { message: { products: [{ payments: [{}] }] } }, { message: { products: [{ payments: [{ paymentTransactionId: '' }] }] } }]) {
    ok(cdg.parsePaymentTransactionId(junk) === null, 'junk answers null rather than throwing');
  }
}

console.log('\n8. the card block normalises the things that arrive from a form');
{
  const p = cdg._internals.paymentAccount({
    cardNumber: '4012-8888-8888-1881', securityCode: ' 1 1 1 ', expMonth: 1, expYear: 22, state: 'ok',
  });
  ok(p.paymentAccountIdentifier === '4012888888881881', 'dashes come out of the card number');
  ok(p.paymentAccountCardSecurityCode === '111', 'and out of the security code');
  ok(p.paymentAccountCardExpirationMonth === '01', 'a single-digit month is padded');
  ok(p.paymentAccountCardExpirationYear === '2022', 'a two-digit year is expanded — their samples show both, we send the unambiguous one');
  ok(p.paymentAccountCardHolderState === 'OK', 'the state is a two-letter code');
  ok(p.paymentAccountCardHolderCountry === 'United States', 'and the country defaults to their sample\'s spelling');
  // A blank must be ABSENT rather than an empty string: an empty required field is
  // a different, harder-to-diagnose refusal than a missing one.
  const bare = cdg._internals.paymentAccount({ referenceId: 'R1' });
  ok(Object.keys(bare).length === 2 && bare.paymentReferenceIdentifier === 'R1' && bare.paymentAccountCardHolderCountry,
    'nothing blank is sent as an empty string');
}

console.log('\n9. the module surface says what it can do');
{
  for (const f of ['buildPaymentAuthCapture', 'buildSendInvoice', 'parsePaymentTransactionId']) {
    ok(typeof cdg[f] === 'function', `${f} is exported`);
  }
  // The payment module must not have grown a second, unmasked way to send a card.
  const src = fs.readFileSync(path.join(ROOT, 'src/amc/payment.js'), 'utf8');
  ok(/cdg\.buildPaymentAuthCapture/.test(src), 'amc/payment.js builds the charge through cdg, not by hand');
  ok(!/paymentAccountIdentifier/.test(src),
    'and it never assembles a payment field itself — one builder, one place the card is shaped');
}

console.log(`\n[test-amc-payment-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
