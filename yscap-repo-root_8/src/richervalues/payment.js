'use strict';
/**
 * Richer Value — PAYING FOR THE ORDER.
 *
 * THE OWNER'S RULE (2026-08-14): *"We don't want to allow Add to Invoice. We don't
 * want to allow ACH. We want the system to automatically be able to put in the
 * credit card details and process the payment from the credit card that was
 * entered under conditions. If there is no credit card entered yet under
 * conditions, you can pay it manually right over here, put in the credit card
 * information in our system, or we can send payment links."*
 *
 * So there are exactly THREE ways to pay, and invoice and ACH are not among them:
 *
 *   CARD_ON_FILE   the card the borrower (or a staffer on their behalf) entered on
 *                  the appraisal-card condition. PILOT reveals it through the
 *                  existing audited chokepoint, hands it to Richer Value, charges
 *                  the order, and REMOVES the card from their side again.
 *   NEW_CARD       no card on the file yet: a staffer types one here. It is saved
 *                  onto the file FIRST through the SAME shared chokepoint
 *                  (`lib/appraisal-card.js`), so the appraisal-card condition is
 *                  filled by the act of paying, and only then charged.
 *   PAYMENT_LINK   Richer Value emails the borrower their own hosted payment page.
 *                  The order exists but does not start until they pay.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THAT IS NOT IN OUR HANDS, AND IT IS MEASURED, NOT GUESSED
 * ─────────────────────────────────────────────────────────────────────────────
 * Their `POST /api/v1/company/add-card` forwards the card number straight to
 * Stripe, and Stripe REFUSES it on their account. Verbatim, from their training
 * tenant on 2026-08-14:
 *
 *   "Sending credit card numbers directly to the Stripe API is generally unsafe.
 *    We suggest you use test tokens that map to the test card you are using…
 *    To enable testing raw card data APIs, see …/enabling-access-to-raw-card-data-apis."
 *
 * And a Stripe TOKEN cannot be used instead, because their own validator refuses
 * it before it ever reaches Stripe: `"card_number" must be a number`.
 *
 * That is a setting on RICHER VALUE'S Stripe account, not a bug in this code. So
 * this module is written the documented way — add the card, charge the order,
 * remove the card — and it will work the day they enable raw card data (or add a
 * tokenised endpoint). Until then `chargeCardOnFile` catches THAT SPECIFIC
 * refusal, says so in plain words, and points at the payment link, which works
 * today. What it never does is fail silently or leave a card sitting on their
 * side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CARD IS REMOVED AGAIN, AND THAT IS NOT TIDINESS
 * ─────────────────────────────────────────────────────────────────────────────
 * Their add-card endpoint is COMPANY-level: a card added there becomes a payment
 * source on the YS Capital account and would be chargeable for anybody's order.
 * A borrower's card must not sit there after their own appraisal is paid for. So
 * the charge runs add → pay → DELETE, the delete runs in a `finally`, and a
 * delete that fails is recorded loudly rather than swallowed — an orphaned card on
 * a vendor's account is exactly the kind of thing nobody notices for a year.
 */

const crypto = require('crypto');
const client = require('./client');
const appraisalCard = require('../lib/appraisal-card');
const C = require('../lib/crypto');

/** The three the owner allows. Invoice and ACH are deliberately absent. */
const METHODS = ['CARD_ON_FILE', 'NEW_CARD', 'PAYMENT_LINK'];

/**
 * Stripe's refusal to take a raw card number, told apart from every other
 * failure. Matched on the two phrases Stripe itself uses, not on a status code —
 * their API relays it as an ordinary `success:false`, so there is nothing else to
 * key on. A false positive here would merely show a more helpful message; a false
 * NEGATIVE would show "something went wrong" for a problem with a known answer.
 */
function isRawCardBlocked(e) {
  const text = `${(e && e.message) || ''} ${JSON.stringify((e && e.body) || {})}`.toLowerCase();
  return /raw card data/.test(text)
    || /sending credit card numbers directly to the stripe api/.test(text);
}

const RAW_CARD_BLOCKED_MESSAGE =
  'Richer Value cannot take a card number through their system yet — their payment provider (Stripe) '
  + 'refuses it on their account, so this is something only Richer Value can switch on. Ask their tech '
  + 'team to enable raw card data on their Stripe account (tech@richervalues.com). In the meantime, use '
  + '“Send the borrower a payment link”, which works today.';

/**
 * Read the file's appraisal card back out. This is the SAME audited reveal the
 * staff screen uses — a card is decrypted in exactly one way in this codebase —
 * and the caller is expected to write the `view_appraisal_card` audit row, because
 * a decryption nobody recorded is the one thing this data must never allow.
 *
 * Returns `{present, number, cvc, expMonth, expYear, last4, brand, zip}` or
 * `{present:false}`. NEVER logs, and never returns the number in an error.
 */
async function readFileCard(db, appId) {
  const r = await db.query(
    `SELECT card_encrypted, last4, brand, exp_month, exp_year, billing_zip
       FROM application_payment_cards WHERE application_id=$1`, [appId]);
  const row = r.rows[0];
  if (!row) return { present: false };
  let full = null;
  try { full = JSON.parse(C.decryptSSN(Buffer.from(row.card_encrypted, 'base64'))); } catch (_) { full = null; }
  if (!full || !full.number) return { present: false, undecryptable: true, last4: row.last4 || null };
  return {
    present: true,
    number: String(full.number).replace(/\D/g, ''),
    cvc: String(full.cvc || '').replace(/\D/g, ''),
    expMonth: row.exp_month,
    expYear: row.exp_year,
    last4: row.last4 || String(full.number).slice(-4),
    brand: row.brand || null,
    zip: row.billing_zip || null,
  };
}

/** What the order screen shows about the card, with nothing secret in it. */
async function cardStatus(db, appId) {
  try {
    const r = await db.query(
      `SELECT last4, brand, exp_month, exp_year, updated_at FROM application_payment_cards WHERE application_id=$1`, [appId]);
    const row = r.rows[0];
    if (!row) return { present: false };
    const expired = isExpired(row.exp_month, row.exp_year);
    return {
      present: true,
      last4: row.last4 || null,
      brand: row.brand || null,
      exp: row.exp_month && row.exp_year ? `${String(row.exp_month).padStart(2, '0')}/${String(row.exp_year).slice(-2)}` : null,
      expired,
      updatedAt: row.updated_at,
    };
  } catch (_) { return { present: false }; }
}

function isExpired(month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!(m >= 1 && m <= 12) || !(y > 1900)) return false;   // unknown is not expired
  const now = new Date();
  return !(y > now.getUTCFullYear() || (y === now.getUTCFullYear() && m >= now.getUTCMonth() + 1));
}

/**
 * ADD → PAY → REMOVE. The whole card charge, in one place.
 *
 * `card` is `{number, cvc, expMonth, expYear}` — already validated by
 * `appraisalCard.validateCardInput` at the door, so this never sees junk.
 *
 * @returns {Promise<{ok:boolean, orderTokens?:Array, error?:string, code?:string, cleanupFailed?:boolean}>}
 */
async function chargeCard(db, { intakeToken, companyToken, card, journal }) {
  if (!intakeToken) return { ok: false, code: 'no_intake', error: 'There is nothing to pay for yet.' };
  if (!card || !card.number) return { ok: false, code: 'no_card', error: 'No card to charge.' };

  const last4 = String(card.number).slice(-4);
  let paymentSourceId = null;

  // ---- 1. hand them the card ---------------------------------------------
  try {
    const added = await client.addCard({
      company_token: companyToken,
      payment_source_type: 'CREDIT_CARD',
      card_number: card.number,
      exp_month: String(card.expMonth).padStart(2, '0'),
      exp_year: String(card.expYear),
      cvv: card.cvc,
    });
    if (added && added.__dryrun) return { ok: true, dryrun: true };
    // Their add-card reply shape is not guaranteed to carry the id (their own
    // documentation shows an empty `data` on success), so the source is resolved
    // from their LIST when it is not returned — matched on the last four and the
    // newest row, because that is the only handle they give us.
    paymentSourceId = (added && added.data && added.data.payment_source && added.data.payment_source.payment_source_id) || null;
    if (!paymentSourceId) paymentSourceId = await findCardSource(companyToken, last4);
    if (journal) await journal({ action: 'add_card', ok: true, response: { last4 }, request: { last4 } });
  } catch (e) {
    if (journal) await journal({ action: 'add_card', ok: false, error: e.message, request: { last4 }, response: e.body || null });
    if (isRawCardBlocked(e)) {
      return { ok: false, code: 'raw_card_blocked', error: RAW_CARD_BLOCKED_MESSAGE };
    }
    return { ok: false, code: 'add_card_failed', error: `Richer Value would not take the card: ${e.message}` };
  }

  if (!paymentSourceId) {
    return { ok: false, code: 'no_payment_source', error: 'Richer Value took the card but did not say which payment method it became, so nothing was charged. Try the payment link.' };
  }

  // ---- 2. charge it, and 3. take it back off their account ----------------
  // The removal is in a `finally` so a failed CHARGE cannot leave the card
  // sitting on the company account either.
  try {
    const paid = await client.payForOrder(intakeToken, {
      payment_method: 'USE_EXISTING_SOURCE',
      payment_source_id: paymentSourceId,
    });
    if (journal) await journal({ action: 'pay_card', ok: true, response: paid, request: { last4 } });
    const tokens = (paid && paid.data && paid.data.order_tokens) || [];
    return { ok: true, orderTokens: tokens };
  } catch (e) {
    if (journal) await journal({ action: 'pay_card', ok: false, error: e.message, request: { last4 }, response: e.body || null });
    return { ok: false, code: 'charge_failed', error: `The card was not charged: ${e.message}` };
  } finally {
    const removed = await removeSource(paymentSourceId).catch(() => false);
    if (!removed) {
      // LOUD, not swallowed: a borrower's card left on the company account at a
      // vendor is exactly what nobody notices for a year.
      console.error('[rv] COULD NOT REMOVE the card from Richer Value after paying —',
        `payment source ${paymentSourceId} is still on the company account. Remove it in their portal.`);
      if (journal) {
        await journal({ action: 'remove_card', ok: false, error: 'the card could not be removed from Richer Value — remove it in their portal', request: { last4 } });
      }
    } else if (journal) {
      await journal({ action: 'remove_card', ok: true, request: { last4 } });
    }
  }
}

/** Their list is the only handle on a source they did not name in the reply. */
async function findCardSource(companyToken, last4) {
  try {
    const r = await client.paymentSources(companyToken);
    const cards = (((r && r.data && r.data.paymentSources) || {}).stripe || {}).creditCards || [];
    const hit = cards.filter((c) => String(c.last_4 || '') === String(last4)).pop();
    return hit ? hit.payment_source_id : null;
  } catch (_) { return null; }
}

async function removeSource(paymentSourceId) {
  if (!paymentSourceId) return true;
  try { await client.deletePaymentSource(paymentSourceId); return true; } catch (_) { return false; }
}

/**
 * Ask Richer Value to email the borrower their hosted payment page. Verified
 * working against their training tenant.
 */
async function sendPaymentLink(intakeToken, { to, cc = [], comment }) {
  const list = (Array.isArray(to) ? to : [to]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, code: 'no_recipient', error: 'Say who the payment link goes to.' };
  await client.sendPaymentLink(intakeToken, { to: list, cc: (cc || []).filter(Boolean), comment: comment || '' });
  return { ok: true, sentTo: list };
}

/**
 * SAVE A CARD ONTO THE FILE AND THEN CHARGE IT — the owner's "if there is no
 * credit card entered yet under conditions… put in the credit card information in
 * our system".
 *
 * The save goes through the SHARED chokepoint, which is the point: entering a card
 * to pay for an appraisal ALSO fills the appraisal-card condition, encrypts it at
 * rest the one way this codebase encrypts a card, and keeps the reusable-card copy
 * in step. A private "just charge it" path here would take the money and leave the
 * condition still asking for a card.
 */
async function saveThenCharge(db, appId, { intakeToken, companyToken, cardInput, borrowerId, journal }) {
  const v = appraisalCard.validateCardInput(cardInput);
  if (!v.ok) return { ok: false, code: 'bad_card', error: v.error };
  await appraisalCard.saveApplicationCard({
    appId, borrowerId,
    number: v.number, cvc: v.cvc, expMonth: v.expMonth, expYear: v.expYear, zip: v.zip,
  });
  const out = await chargeCard(db, {
    intakeToken, companyToken, journal,
    card: { number: v.number, cvc: v.cvc, expMonth: v.expMonth, expYear: v.expYear },
  });
  // The card is saved either way. That is deliberate: a charge their end refused
  // does not make the card wrong, and re-typing it would be the second thing to go
  // wrong in a row for whoever is standing there.
  return { ...out, cardSaved: true, last4: v.number.slice(-4) };
}

/** A stable, non-secret fingerprint for the audit trail — never the number. */
function cardFingerprint(number) {
  return crypto.createHash('sha256').update(String(number || '')).digest('hex').slice(0, 16);
}

module.exports = {
  METHODS,
  readFileCard, cardStatus, chargeCard, saveThenCharge, sendPaymentLink,
  isRawCardBlocked, RAW_CARD_BLOCKED_MESSAGE, cardFingerprint,
  _internals: { findCardSource, removeSource, isExpired },
};
