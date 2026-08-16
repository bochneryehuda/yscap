'use strict';
/**
 * HOW AN APPRAISAL GETS PAID FOR — the ways, and what each one can actually do at
 * each of the three appraisal companies.
 *
 * READ `methodsFor(vendor)`, NEVER THE FLAT `METHODS` ARRAY. Every company offers
 * the owner's three; Richer Values additionally offers a fourth (COMPANY_CARD, the
 * card YS Capital keeps on their account) that genuinely does not exist at the
 * other two. The flat array is the VOCABULARY — every way any company can be paid
 * — and is not an offer.
 *
 * THE OWNER'S RULE (2026-08-16, re-stating and widening the 2026-08-05 one):
 *   *"We're gonna keep it manual. We're gonna have all the options over there,
 *    like: if we want to, we should be able to send the payment link. If we want
 *    to, share to use the card on file. We should be able to use the card
 *    manually. We should keep all the options open."*
 *
 * So: PILOT never charges anything on its own. A person picks a way, every time,
 * on purpose. This module is the ONE place that says what the ways are and what
 * pressing each one does at a given vendor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SHARED DEFINITION AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * Richer Values already had exactly these three (`src/richervalues/payment.js`,
 * built 2026-08-14 from the same instruction in the owner's own words) and the
 * other two vendors had NONE — the Pay button on a NAN or a Class order saved a
 * card and said, correctly, that nothing had been charged. That is where the
 * options stopped being "open": on two vendors out of three there was only ever
 * one option, and no way to say which of the three you meant.
 *
 * `richervalues/payment.js` now builds its own `METHODS` from `methodsFor('rv')`,
 * so the vocabulary has exactly one definition and the vendor that performs the
 * payment and the desk that records it can never disagree about what the ways are
 * called — while Richer Values still honestly offers the extra one it alone has.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "MANUAL" IS THE WHOLE POINT, AND IT IS WHY THE CHOICE IS RECORDED
 * ─────────────────────────────────────────────────────────────────────────────
 * The thing that was actually missing is not a charge button — the owner does not
 * want one. It is that nothing told the back office HOW a given order was meant to
 * be paid. A card was saved on the file and that was the entire instruction, so
 * "send them a link" and "put this on the card" and "she's paying it herself"
 * looked identical from the outside and someone had to go and ask.
 *
 * So every one of the three is a real, recordable INSTRUCTION (see
 * `appraisal_payment_intents`, db/562) whatever the vendor can do about it. On a
 * vendor that can carry it out, pressing it carries it out. On a vendor that
 * cannot, pressing it writes down what a person decided so the back office reads
 * an instruction instead of guessing. Both are honest; neither is automatic.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE GUESSES A VENDOR'S PAYMENT API
 * ─────────────────────────────────────────────────────────────────────────────
 * A wrong guess at a money endpoint is the most expensive kind of wrong in this
 * codebase, so the capability table below records only what has been READ from a
 * vendor's own client module in this repository:
 *
 *   Richer Values  — `src/richervalues/client.js` has `addCard`, `payForOrder`,
 *                    `deletePaymentSource` and `sendPaymentLink`. All three ways
 *                    are wired and shipped.
 *   Class Valuation — `src/class/client.js` has NO payment call of any kind: its
 *                    whole surface is products, orders, attachments, notes and
 *                    callbacks. Class DOES send borrower payment links (their
 *                    `PaymentLinkSentToBorrower` callback is in our subscribed
 *                    list) — but that is them telling US it happened, not a lever
 *                    we can pull. Every method here is therefore back-office.
 *   AppraisalScope  — Cotality's Digital Gateway catalogs `PaymentAuthCapture`,
 *                    `BillInvoice`, `SendInvoice` and `eCheckPayment`, and NOT ONE
 *                    of them has a verified request shape (`src/amc/cdg.js` builds
 *                    none of them). The only payment call we have read and built
 *                    is `GetPaymentOptions`, which is a pure READ of what the
 *                    account is permitted to use. So every method here is
 *                    back-office too, and it stays that way until somebody
 *                    verifies a real request against the live account.
 *
 * When a vendor's payment call IS verified, move it from `back_office` to
 * `vendor` in ONE place — this table — and the desk, the wording and the recorded
 * instruction all follow with no second edit.
 */

/**
 * THE WHOLE VOCABULARY — every way any appraisal company can be paid.
 *
 * The owner's three come first, in the owner's own order. COMPANY_CARD is a
 * FOURTH, and it is deliberately not one of "the three": the owner's three are all
 * about the BORROWER's money (their link, their card), while COMPANY_CARD is US
 * paying in house off a card YS Capital keeps with the vendor.
 *
 * NOT EVERY VENDOR OFFERS EVERY ENTRY, WHICH IS WHY NOTHING READS THIS ARRAY
 * DIRECTLY — ask `methodsFor(vendor)`. COMPANY_CARD is real at Richer Values only
 * (2026-08-16, owner-directed: a human saves a card once in the Richer Values
 * portal and every order charges the source they already hold — the one card route
 * their Stripe does not refuse). AppraisalScope and Class have no verified payment
 * call of any kind, so a company card held with them is not a thing that exists,
 * and offering it there would be advertising a button that cannot work.
 */
const METHODS = ['PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD', 'COMPANY_CARD'];

/** Plain-language names. These reach a screen, so they are written for a person. */
const METHOD_LABEL = {
  PAYMENT_LINK: 'Send the borrower a payment link',
  CARD_ON_FILE: 'Use the card on file',
  NEW_CARD: 'Enter a card now',
  COMPANY_CARD: 'Pay with our own card',
};

/** One line each, saying what the option IS — never what it does at a vendor. */
const METHOD_BLURB = {
  PAYMENT_LINK: 'The borrower pays it themselves on the appraisal company’s own payment page.',
  CARD_ON_FILE: 'The card already saved on this loan file is the one that gets charged.',
  NEW_CARD: 'Type a card in now. It is saved onto the file too, so the appraisal-payment condition fills in.',
  COMPANY_CARD: 'We pay for it ourselves, on the card YS Capital keeps with the appraisal company.',
};

/**
 * What pressing an option DOES, as three outcomes:
 *   'vendor'      the appraisal company carries it out when you press it
 *   'back_office' PILOT records the decision; a person settles it by hand
 *   'unavailable' there is no such path at this vendor at all
 * `unavailable` is what lets a vendor honestly offer a different set. The owner's
 * three are genuinely open on all three companies — there the difference is only
 * who performs it — but COMPANY_CARD exists at Richer Values alone, so it is
 * `unavailable` at AppraisalScope and Class by simply having no row there, and
 * `methodsFor` leaves it out of their screens entirely rather than showing a row
 * that could never work.
 */
const DOES = { VENDOR: 'vendor', BACK_OFFICE: 'back_office', UNAVAILABLE: 'unavailable' };

/** The three appraisal companies, by the key the rest of the appraisal code uses. */
const VENDORS = ['nan', 'class', 'rv'];

const VENDOR_NAME = { nan: 'AppraisalScope', class: 'Class Valuation', rv: 'Richer Values' };

/**
 * THE TABLE. Per vendor, per method: who performs it, and the sentence a person
 * reads under the button. The sentences differ per vendor on purpose — "we record
 * it and the back office charges it" and "pressing this charges it" must never
 * look the same on screen.
 */
const CAPABILITY = {
  rv: {
    // FIRST ON PURPOSE — the Richer Values order screen leads with this and
    // defaults to it (owner-directed 2026-08-16: our own card by default, with the
    // payment link as the per-order backup). It is also the one card route their
    // Stripe does not refuse, because no card number is ever sent: a human saves
    // the card ONCE in the Richer Values portal and we reference the payment
    // source they already hold.
    COMPANY_CARD: {
      does: DOES.VENDOR,
      says: 'Richer Values charges the card YS Capital keeps on their account. The borrower is not asked for anything.',
    },
    PAYMENT_LINK: {
      does: DOES.VENDOR,
      says: 'Richer Values emails the borrower their payment page. The order waits until it is paid.',
    },
    CARD_ON_FILE: {
      does: DOES.VENDOR,
      // The caveat is real, measured against their training tenant on 2026-08-14,
      // and lives in richervalues/payment.js. It is surfaced at the moment of
      // failure rather than pre-emptively greying the button out: their Stripe
      // setting can be switched on any day, and a button disabled from a stale
      // note would then be wrong in the expensive direction.
      says: 'Richer Values charges the card saved on this file, then removes it from their side again.',
      caveat: 'rv_raw_card',
    },
    NEW_CARD: {
      does: DOES.VENDOR,
      says: 'The card is saved onto the file first, then charged at Richer Values.',
      caveat: 'rv_raw_card',
    },
  },

  nan: {
    PAYMENT_LINK: {
      does: DOES.BACK_OFFICE,
      // DELIBERATELY DOES NOT SAY *HOW* the back office sends it. AppraisalScope's
      // GetPaymentOptions reports a `paymentFormAvailable` flag, but nothing in this
      // repo has verified a way to send a borrower a link — so naming one would put
      // an instruction on screen that may not be followable. What is true is that
      // the decision is recorded and a person arranges it.
      says: 'Recorded as the way this one is being paid. The back office arranges it with AppraisalScope.',
    },
    CARD_ON_FILE: {
      does: DOES.BACK_OFFICE,
      says: 'Recorded as the way this one is being paid. The back office charges the card on this file by hand.',
    },
    NEW_CARD: {
      does: DOES.BACK_OFFICE,
      says: 'The card is saved onto the file, and recorded as the one to charge. The back office charges it by hand.',
    },
  },

  class: {
    PAYMENT_LINK: {
      does: DOES.BACK_OFFICE,
      // Class genuinely sends borrower payment links — their
      // `PaymentLinkSentToBorrower` callback is in our subscribed list, so this one
      // is a stated fact rather than an assumption. What we cannot do is TRIGGER it.
      says: 'Recorded as the way this one is being paid. Class Valuation sends the borrower their link.',
    },
    CARD_ON_FILE: {
      does: DOES.BACK_OFFICE,
      says: 'Recorded as the way this one is being paid. The back office charges the card on this file by hand.',
    },
    NEW_CARD: {
      does: DOES.BACK_OFFICE,
      says: 'The card is saved onto the file, and recorded as the one to charge. The back office charges it by hand.',
    },
  },
};

/** The one caveat text there is, kept here so the desk and the server agree. */
const CAVEAT = {
  rv_raw_card:
    'Richer Values cannot take a card number through their system yet — their payment provider refuses it '
    + 'on their account, and only they can switch it on. If it fails, use the payment link, which works today.',
};

function isMethod(m) { return METHODS.includes(String(m || '').toUpperCase()); }
function isVendor(v) { return VENDORS.includes(String(v || '').toLowerCase()); }

/**
 * The ways THIS vendor can be paid, in the owner's order. PURE.
 *
 * This is the function every consumer should use — the flat `METHODS` array is the
 * vocabulary, not an offer. `richervalues/payment.js` builds its own `METHODS` from
 * `methodsFor('rv')`, so the vendor module and this table cannot drift about what
 * Richer Values accepts, and Richer Values can carry a fourth way (COMPANY_CARD)
 * without either hiding it from itself or advertising it on the two vendors that
 * have no verified payment call at all.
 *
 * DERIVED FROM THE CAPABILITY TABLE, never a second hand-written list: a method is
 * offered exactly when that vendor has a row for it that is not `unavailable`. So
 * adding a vendor's new payment route is ONE table entry and every screen, every
 * validation and every recorded instruction follows.
 *
 * An unknown vendor answers the owner's three rather than nothing — a screen that
 * cannot name its vendor must still offer the ways that are recordable everywhere,
 * and recording an instruction is never the dangerous direction.
 */
function methodsFor(vendor) {
  const v = String(vendor || '').toLowerCase();
  const table = CAPABILITY[v];
  if (!table) return METHODS.filter((m) => m !== 'COMPANY_CARD');
  // THE VENDOR'S OWN TABLE ORDER, not the flat vocabulary's — so "which way does
  // this company lead with" is a property of that company's entry and is decided
  // once, where its rows are written. Richer Values leads with COMPANY_CARD
  // (owner-directed: our own card by default, the payment link as the per-order
  // backup); the other two have no such card and lead with the owner's three in
  // the owner's order. Object key order is insertion order for string keys, so
  // this is the literal order the rows are written in below.
  return Object.keys(table).filter((m) => METHODS.includes(m) && table[m].does !== DOES.UNAVAILABLE);
}

/**
 * What one method does at one vendor. PURE.
 * An unknown vendor or method answers `unavailable` rather than throwing — this
 * feeds a screen, and an unrecognised pair must render as "not offered", never as
 * a crash and never as a silently enabled charge button.
 */
function capability(vendor, method) {
  const v = String(vendor || '').toLowerCase();
  const m = String(method || '').toUpperCase();
  const row = (CAPABILITY[v] || {})[m];
  if (!row) {
    return { method: m, does: DOES.UNAVAILABLE, label: METHOD_LABEL[m] || m, says: 'Not offered here.', caveat: null };
  }
  return {
    method: m,
    does: row.does,
    label: METHOD_LABEL[m],
    blurb: METHOD_BLURB[m],
    says: row.says,
    caveat: row.caveat ? CAVEAT[row.caveat] : null,
  };
}

/**
 * Every option for a vendor, in the owner's order, ready to render. PURE.
 *
 * `ctx` narrows what is OFFERABLE right now without changing what is POSSIBLE:
 *   ctx.cardOnFile   {present, last4, brand, expired}
 * A missing card does not remove "Use the card on file" — it disables it with the
 * reason, because a greyed option with a reason teaches what to do next and a
 * vanished one just looks like the feature is missing. That is the same rule the
 * Richer Values order screen already follows.
 */
function optionsFor(vendor, ctx = {}) {
  const card = ctx.cardOnFile || {};
  // Per VENDOR, not the flat vocabulary: a method this company has no route for is
  // absent rather than greyed. The "disable with a reason, never hide" rule below
  // is about a way that EXISTS here and cannot be used RIGHT NOW (no card on file
  // yet, an expired one) — that reason teaches the reader what to do next. "This
  // company has no such thing, ever" teaches nothing and would put a permanently
  // dead row on every AppraisalScope and Class order screen.
  return methodsFor(vendor).map((m) => {
    const cap = capability(vendor, m);
    let disabled = null;
    if (cap.does === DOES.UNAVAILABLE) disabled = 'Not offered by this appraisal company.';
    else if (m === 'CARD_ON_FILE' && !card.present) disabled = 'There is no card on this file yet — use “Enter a card now”.';
    else if (m === 'CARD_ON_FILE' && card.expired) disabled = 'The card on this file has expired — enter a new one, or send a payment link.';
    return { ...cap, disabled, available: !disabled };
  });
}

/**
 * The sentence the Orders desk prints once somebody has chosen. PURE.
 * Written so it reads correctly whether the vendor did it or a person still has
 * to: "Paid by link" and "To be paid by link" are different facts and the desk
 * must never print the first when it means the second.
 */
function describeIntent(intent) {
  if (!intent || !intent.method) return null;
  const cap = capability(intent.vendor, intent.method);
  const done = !!intent.settled_at;
  const byVendor = cap.does === DOES.VENDOR;
  // Keyed per method, NOT a ternary with a catch-all tail. The tail used to read
  // "the card entered here", which is a specific claim about WHOSE card it is —
  // so the day a fourth way arrived (COMPANY_CARD, our own card held at the
  // vendor) the desk would have printed a confident, wrong sentence about the
  // borrower's card with nothing failing anywhere.
  const HEAD = {
    PAYMENT_LINK: ['To be paid by payment link', 'Paid by payment link'],
    CARD_ON_FILE: ['To be charged to the card on file', 'Paid with the card on file'],
    NEW_CARD: ['To be charged to the card entered here', 'Paid with the card entered here'],
    COMPANY_CARD: ['To be paid on our own card', 'Paid on our own card'],
  };
  const pair = HEAD[intent.method];
  // An unrecognised method says only what is certain — that somebody chose a way —
  // rather than naming a card nobody can point at.
  const head = pair ? pair[done ? 1 : 0] : (done ? 'Paid' : 'To be paid');
  return {
    head,
    settled: done,
    // Only a back-office instruction is WAITING on a person. A vendor-performed
    // payment that has not settled is waiting on the vendor or the borrower, and
    // telling the back office to go and do it would be wrong.
    awaitingBackOffice: !done && !byVendor,
    label: cap.label,
    says: cap.says,
  };
}

module.exports = {
  METHODS, METHOD_LABEL, METHOD_BLURB, DOES, VENDORS, VENDOR_NAME, CAVEAT,
  isMethod, isVendor, methodsFor, capability, optionsFor, describeIntent,
  _internals: { CAPABILITY },
};
