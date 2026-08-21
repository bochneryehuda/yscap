'use strict';
/**
 * THE MONEY RULES, against a real Postgres, with the vendor stubbed.
 *
 * `test-amc-payment-pure.js` proves the REQUESTS match the vendor's own samples.
 * This proves the things that decide whether a borrower gets charged twice, which
 * no shape comparison can see:
 *
 *   A. a charge is claimed before anything is sent, so two presses is one charge
 *   B. a paid order can never be charged again
 *   C. a send that never reached them releases the claim — the button works again
 *   D. an answer we could not read KEEPS the claim, deliberately, and says so
 *   E. a decline releases the claim and keeps the vendor's own words
 *   F. the receipt is recorded, and the card is never returned, logged or stored
 *   G. the payment link emails per recipient and reports each one separately
 *   H. a card with no security code is refused BEFORE anything is sent
 *
 * The vendor is an INJECTED transport, so nothing here touches the network and the
 * whole path runs with the integration switched off. One transaction, rolled back.
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-payment-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const payment = require(path.join(ROOT, 'src/amc/payment'));
const apprCard = require(path.join(ROOT, 'src/lib/appraisal-card'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const CARD = { number: '4012888888881881', expMonth: 1, expYear: 2032, cvc: '731', zip: '73114' };
const AUTH = { apiKey: 'K', subdomain: 'integrations.uat' };

// A vendor that answers with a receipt, recording every request it was handed.
function okTransport(txn = '40064185551') {
  const seen = [];
  return {
    seen,
    write: async (req) => {
      seen.push(req);
      return {
        message: {
          digitalGatewaySystem: { statusResponses: [{ statusCode: '0', statusCondition: 'Success', statusName: 'ACK' }] },
          products: [{ payments: [{ paymentTransactionId: txn }] }],
        },
      };
    },
  };
}
// A vendor that refuses (a decline).
const declineTransport = {
  write: async () => ({
    message: {
      digitalGatewaySystem: {
        statusResponses: [{ statusCode: '-2001', statusCondition: 'Nack', statusName: 'DECLINED', statusDescription: 'Card declined by issuer' }],
      },
    },
  }),
};
// A vendor that answers Success but sends NO receipt.
const noReceiptTransport = {
  write: async () => ({
    message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '0', statusCondition: 'Success', statusName: 'ACK' }] } },
  }),
};
// A vendor we never reached.
const deadTransport = { write: async () => { const e = new Error('AMC PaymentAuthCapture -> 503'); throw e; } };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();

  const intentOf = async (orderId) => (await c.query(
    `SELECT * FROM appraisal_payment_intents WHERE vendor='nan' AND vendor_order_id=$1::bigint`, [orderId])).rows[0] || null;

  try {
    await c.query('BEGIN');
    const bo = (await c.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,current_address)
       VALUES ('Pay','Test',$1,'555-222-5555','{"line1":"501 NE 122nd St","city":"OKLAHOMA CITY","state":"OK","zip":"73114"}')
       RETURNING id`, [`amc-pay-${Date.now()}@example.com`])).rows[0];

    let n = 0;
    const mkOrder = async (withCard = true) => {
      n += 1;
      const appId = (await c.query(
        `INSERT INTO applications (borrower_id, ys_loan_number) VALUES ($1,$2) RETURNING id`,
        [bo.id, `YSCAP-PAY-${n}`])).rows[0].id;
      const order = (await c.query(
        `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain)
         VALUES ($1,$2,$3,'in_process','integrations.uat') RETURNING *`,
        [appId, `YSCAP-PAY-${n}`, `SP-PAY-${n}`])).rows[0];
      if (withCard) {
        // Through the SHARED chokepoint, so this is the same row the condition
        // writes — on our own connection, since the file is not committed yet.
        await apprCard.saveApplicationCard({ appId, borrowerId: bo.id, ...CARD, dbc: c });
      }
      return { appId, order };
    };

    // =====================================================================
    // F (first, because everything else builds on a good charge working).
    // =====================================================================
    {
      const { appId, order } = await mkOrder();
      const t = okTransport();
      const out = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: t, authContext: AUTH } });
      ok(out.ok && out.transactionId === '40064185551', 'F: a good charge answers with the vendor\'s receipt');
      ok(t.seen.length === 1 && t.seen[0].message.requestActionType === 'PaymentAuthCapture',
        'F: exactly one PaymentAuthCapture went out');

      // THE CARD REALLY WENT — this is what makes it a charge rather than a note.
      const sentPay = t.seen[0].message.products[0].payments[0];
      ok(sentPay.paymentAccountIdentifier === CARD.number, 'F: the card on file is the card that was charged');
      ok(sentPay.paymentAccountCardSecurityCode === '731',
        'F: with its security code — which is why storing it is what makes this work at all');
      ok(sentPay.paymentAccountCardHolderEmail && sentPay.paymentAccountCardHolderCity === 'OKLAHOMA CITY',
        'F: and the cardholder is the file\'s borrower, from their own address');

      const intent = await intentOf(order.id);
      ok(intent && intent.vendor_transaction_id === '40064185551', 'F: the receipt is recorded on the order');
      ok(intent.settled_at && intent.method === 'CARD_ON_FILE' && intent.performed_by === 'vendor',
        'F: and it reads as PAID BY THE VENDOR, not as a note for the back office');
      ok(intent.payment_reference === payment.referenceFor(order.id),
        'F: our own payment reference is kept — a later capture is addressed to it');

      // NOTHING SECRET COMES BACK, and nothing secret is stored outside the one
      // encrypted column. The CVC is matched as a JSON VALUE (`"731"`), exactly
      // like the row check below — a bare `.includes('731')` false-fires on the
      // volatile noise inside `out.intent` (RETURNING * carries UUID hex and
      // millisecond timestamps, either of which contains "731" a few percent of
      // the time; it did, on main run 32286841845, failing this suite with the
      // payment code entirely correct). A leaked CVC is a FIELD carrying 731,
      // and the quoted form catches every such field deterministically.
      const body = JSON.stringify(out);
      ok(!body.includes(CARD.number) && !body.includes(`"${CARD.cvc}"`), 'F: the answer carries no card number and no security code');
      const row = JSON.stringify(intent);
      ok(!row.includes(CARD.number) && !row.includes('"731"'), 'F: and neither does the recorded row');
      void appId;
    }

    // =====================================================================
    // B. A paid order is never charged again.
    // =====================================================================
    {
      const { order } = await mkOrder();
      const t = okTransport('TXN-B');
      await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: t, authContext: AUTH } });
      const again = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: t, authContext: AUTH } });
      ok(!again.ok && again.error === 'already_paid', 'B: a second charge on a paid order is refused');
      ok(again.transactionId === 'TXN-B' && /already paid/i.test(again.detail),
        'B: and the refusal quotes the receipt, so nobody has to go looking');
      ok(t.seen.length === 1, 'B: NOTHING was sent the second time — the refusal is before the wire');
    }

    // =====================================================================
    // A. ONE PRESS, ONE CHARGE — the claim.
    //
    // WHAT THIS PROVES AND WHAT IT DOES NOT, stated plainly. The mechanism is the
    // `charge_started_at IS NULL` predicate in the claim's DO UPDATE; the atomicity
    // under it is Postgres's, applied beneath the row lock the conflict already
    // took, and is not something this code can get wrong. What this code CAN get
    // wrong is dropping the predicate — and that is exactly what these assertions
    // catch, because without it the second claim would succeed and return a row.
    //
    // The claims run in sequence rather than in parallel on purpose: everything
    // here lives inside one rolled-back transaction, so a second connection could
    // not see the file at all. A staged parallel race that could only ever run
    // against committed rows would be a worse test, not a better one.
    // =====================================================================
    {
      const { order } = await mkOrder();
      const first = await payment._internals.claimCharge(c, { appId: order.application_id, orderId: order.id, method: 'CARD_ON_FILE' });
      ok(!!first, 'A: the first claim on an unclaimed order wins');
      const second = await payment._internals.claimCharge(c, { appId: order.application_id, orderId: order.id, method: 'CARD_ON_FILE' });
      ok(second === null, 'A: and a second claim while it is held gets NOTHING');

      // The loser of that race is what a double click actually hits, and it is told
      // to reload rather than to try again.
      const t = okTransport();
      const loser = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: t, authContext: AUTH } });
      ok(!loser.ok && loser.error === 'charge_in_flight' && /already going through/i.test(loser.detail),
        'A: a press while one is in flight is refused, and says why');
      ok(t.seen.length === 0, 'A: and NOTHING was sent — the claim is taken before the wire, not after');

      // A claim can never be taken on an order that is already paid, whatever the
      // claim state — belt to the braces of case B.
      await c.query(
        `UPDATE appraisal_payment_intents SET vendor_transaction_id='TXN-PAID', charge_started_at=NULL
          WHERE vendor='nan' AND vendor_order_id=$1::bigint`, [order.id]);
      ok((await payment._internals.claimCharge(c, { appId: order.application_id, orderId: order.id, method: 'CARD_ON_FILE' })) === null,
        'A: a paid order cannot be claimed again even with the claim released');
    }

    // =====================================================================
    // C. Nothing reached them → the claim is released.
    // =====================================================================
    {
      const { order } = await mkOrder();
      const out = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: deadTransport, authContext: AUTH } });
      ok(!out.ok && out.error === 'send_failed', 'C: a failed send says so');
      const intent = await intentOf(order.id);
      ok(intent && intent.charge_started_at === null, 'C: and the claim is RELEASED — the button works again');
      ok(/503/.test(intent.charge_error || ''), 'C: with what actually happened kept on the row');
      // Proven by doing it: the retry goes through.
      const retry = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: okTransport('TXN-C'), authContext: AUTH } });
      ok(retry.ok && retry.transactionId === 'TXN-C', 'C: so the next press really does charge it');
    }

    // =====================================================================
    // D. Answered, but unreadable → the claim STAYS. This is the rule that
    //    stops a double charge in the one case where it would be invisible.
    // =====================================================================
    {
      const { order } = await mkOrder();
      const out = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: noReceiptTransport, authContext: AUTH } });
      ok(!out.ok && out.error === 'no_receipt', 'D: an answer with no receipt is not reported as success');
      ok(/cannot tell whether the card was charged/i.test(out.detail) && /left locked/i.test(out.detail),
        'D: it says we do not know, and that the order is deliberately locked');
      const intent = await intentOf(order.id);
      ok(intent && intent.charge_started_at !== null, 'D: the claim is KEPT');
      const t = okTransport('TXN-D');
      const again = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: t, authContext: AUTH } });
      ok(!again.ok && again.error === 'charge_in_flight' && t.seen.length === 0,
        'D: …so pressing again sends NOTHING — a human has to go and look');
    }

    // =====================================================================
    // E. A decline is a refusal, not an unknown.
    // =====================================================================
    {
      const { order } = await mkOrder();
      const out = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: declineTransport, authContext: AUTH } });
      ok(!out.ok && out.error === 'declined', 'E: a decline is reported as a decline');
      ok(/Card declined by issuer/.test(out.detail), 'E: in the vendor\'s own words');
      const intent = await intentOf(order.id);
      ok(intent && intent.charge_started_at === null, 'E: nothing was taken, so the claim is released');
      ok(!intent.vendor_transaction_id, 'E: and no receipt was invented');
    }

    // =====================================================================
    // H. A card that cannot be charged is refused BEFORE the wire.
    // =====================================================================
    {
      // No card at all.
      const bare = await mkOrder(false);
      const t = okTransport();
      const none = await payment.charge(c, { orderId: bare.order.id, method: 'CARD_ON_FILE', deps: { transport: t, authContext: AUTH } });
      ok(!none.ok && none.error === 'no_card' && t.seen.length === 0, 'H: no card on file sends nothing');
      ok(/payment link/i.test(none.detail), 'H: and names the other way out, so it is never a dead end');

      // A card saved WITHOUT its security code — the shape an older row has.
      const { appId, order } = await mkOrder(false);
      const C2 = require(path.join(ROOT, 'src/lib/crypto'));
      await c.query(
        `INSERT INTO application_payment_cards (application_id,borrower_id,card_encrypted,last4,brand,exp_month,exp_year,billing_zip)
         VALUES ($1,$2,$3,'1881','Visa',1,2032,'73114')`,
        [appId, bo.id, C2.encryptSSN(JSON.stringify({ number: CARD.number })).toString('base64')]);
      const t2 = okTransport();
      const noCvv = await payment.charge(c, { orderId: order.id, method: 'CARD_ON_FILE', deps: { transport: t2, authContext: AUTH } });
      ok(!noCvv.ok && noCvv.error === 'no_security_code' && t2.seen.length === 0,
        'H: a card with no security code is refused before the wire, not declined at the vendor');
      // And the SCREEN says so before anybody presses.
      const state = await payment.paymentState(c, order.id);
      ok(state.ok && state.card.present && state.cardChargeable === false && /security code/i.test(state.cardReason || ''),
        'H: …and the order screen says so ahead of time');

      // NEW_CARD saves the card first, then charges it.
      const t3 = okTransport('TXN-H');
      const fresh = await payment.charge(c, {
        orderId: order.id, method: 'NEW_CARD',
        card: { number: CARD.number, expMonth: '01', expYear: '2032', cvc: '999', zip: '73114' },
        deps: { transport: t3, authContext: AUTH },
      });
      ok(fresh.ok && fresh.transactionId === 'TXN-H', 'H: entering a card now charges it');
      ok(t3.seen[0].message.products[0].payments[0].paymentAccountCardSecurityCode === '999',
        'H: with the code that was just typed');
      const cond = (await c.query(
        `SELECT last4 FROM application_payment_cards WHERE application_id=$1`, [appId])).rows[0];
      ok(cond && cond.last4 === '1881', 'H: and the card is saved onto the file, so the condition fills');
    }

    // =====================================================================
    // G. The payment link — one call per person, reported per person.
    // =====================================================================
    {
      const { order } = await mkOrder(false);
      const t = okTransport();
      const out = await payment.sendInvoice(c, {
        orderId: order.id, emails: ['borrower@example.com', 'officer@yscapgroup.com', 'borrower@example.com', ''],
        deps: { transport: t, authContext: AUTH },
      });
      ok(out.ok && out.sent.length === 2, 'G: two people, two invoices — duplicates and blanks dropped');
      ok(t.seen.length === 2 && t.seen.every((r) => r.message.requestActionType === 'SendInvoice'),
        'G: one SendInvoice call each, never one call with two names in it');
      ok(t.seen.map((r) => r.message.products[0].notifications[0].contactEmail).sort()
        .join(',') === 'borrower@example.com,officer@yscapgroup.com',
        'G: and each call names exactly one of them');
      const intent = await intentOf(order.id);
      ok(intent && intent.method === 'PAYMENT_LINK' && !intent.settled_at,
        'G: the instruction is recorded as a link, and NOT as paid — they have not paid yet');
      ok(/borrower@example.com/.test(intent.note || ''), 'G: with who was emailed');

      // Every send failing records NOTHING — a link nobody received is not an instruction.
      const { order: o2 } = await mkOrder(false);
      const bad = await payment.sendInvoice(c, {
        orderId: o2.id, emails: ['a@b.com'], deps: { transport: deadTransport, authContext: AUTH },
      });
      ok(!bad.ok && bad.failed.length === 1, 'G: a failed invoice is reported as failed');
      ok((await intentOf(o2.id)) === null, 'G: and nothing is written down when nobody was reached');

      // Nobody to send to is a refusal, not a silent success.
      const nobody = await payment.sendInvoice(c, { orderId: o2.id, emails: ['', null, 'not-an-email'] });
      ok(!nobody.ok && nobody.error === 'no_recipient', 'G: with nobody to email, it says so');
    }

    // =====================================================================
    // The state a screen reads, and the guards that never throw.
    // =====================================================================
    {
      ok((await payment.paymentState(c, 99999999)).error === 'no_order', 'an unknown order answers, never throws');
      ok((await payment.charge(c, { orderId: 99999999, method: 'CARD_ON_FILE' })).error === 'no_order',
        'and so does a charge against one');
      ok((await payment.charge(c, { orderId: 1, method: 'ACH' })).error === 'unknown_method',
        'a way we do not offer is refused before anything is loaded');
    }

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.stack || e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-payment-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
