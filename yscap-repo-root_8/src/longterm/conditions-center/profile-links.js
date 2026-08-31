'use strict';
/**
 * LONG-TERM — THE TWO CONDITIONS WHOSE ANSWER LIVES ON THE PERSON, NOT THE LOAN.
 *
 * The owner's share-the-code directive, item 7 (`docs/longterm/SHARE-THE-CODE-DIRECTIVE.md`):
 * *"Profile-linked conditions — photo ID from the shared profile; the
 * credit-card-for-appraisal card BIDIRECTIONAL with the shared profile; the
 * REO/mortgage answers saved to the shared profile."*
 *
 * Both conditions already DECLARED this in the library — `lt_photo_id` and
 * `lt_appraisal_card` carry `readsFromBorrowerProfile: true` /
 * `savesToBorrowerProfile: true`, and their hints tell the borrower in as many
 * words that *"an ID given on any previous loan is already here"* and that a
 * card *"given on one loan is already here on the next"*. Nothing implemented
 * either: no long-term module referenced `saved_card_*` or
 * `photo_id_document_id` at all. This is that half, and it is the SAME class of
 * defect as the vesting-entity write side — a promise on a screen with nothing
 * behind it.
 *
 * ── WHY THERE IS NO LONG-TERM CARD TABLE, AND MUST NEVER BE ─────────────────
 *
 * The reusable card ALREADY lives on the person: `borrowers.saved_card_*`
 * (db/043 + db/049), the shared identity zone. `application_payment_cards` is
 * only RTL's per-file WORKING COPY of it, with a NOT NULL foreign key to
 * `applications` and a unique index per file. A long-term twin of that table
 * would be the single worst reinvention available here: a second store of a
 * PRIMARY ACCOUNT NUMBER, with its own encryption handling to keep in step, so
 * that a borrower who gave a card on one product is asked for it again on the
 * other — the exact opposite of the directive.
 *
 * So this module reads and writes the PROFILE copy through `src/lib/appraisal-card.js`,
 * and touches no per-file card row on either side. Whether the long-term
 * appraisal needs a per-file copy at all is a question about how that appraisal
 * is actually paid for, which is the owner's to answer, not one to infer from an
 * RTL table's shape.
 *
 * ── THE PAN IS NEVER READ ───────────────────────────────────────────────────
 *
 * `getSavedCard` returns display-safe fields only — brand, last four, expiry,
 * billing ZIP — and never decrypts the number. Nothing here decrypts anything,
 * so there is no path through this module by which a card number reaches a
 * screen, a log or an error message.
 *
 * ── WHAT IS DELIBERATELY NOT DONE, AND IS AN OPEN QUESTION ──────────────────
 *
 * A photo ID uploaded on a long-term file does NOT become the profile's ID here.
 * On the short-term side that upload additionally REOPENS every government-ID
 * condition across the borrower's files, signed-off ones included, because the
 * prior sign-off attested to the OLD ID. That rule is right, and it is a rule
 * about RTL conditions on RTL files — Long-Term writing those would be one
 * product reaching into the other's workflow, which the two-product law forbids
 * and which nobody has asked for. Doing the stamp WITHOUT the reopen would make
 * the two products behave differently about the same act, which is the drift the
 * share-the-code directive exists to stop. Both halves need the owner, so
 * neither is guessed: the READ works today (an ID already on the profile answers
 * the long-term condition, which is what its hint promises), and the write is
 * named here rather than half-built.
 *
 * NEVER THROWS. An unreadable profile answers "nothing on file" — never an error
 * on a loan screen, and never a false "already given".
 */

const db = require('../db');
const card = require('../../lib/appraisal-card');

/** The loan's borrower, read from the long-term columns only. */
async function borrowerOf(loanId, client) {
  const { rows } = await client.query(
    `SELECT borrower_id FROM lt_loans WHERE id = $1::uuid`, [String(loanId)]);
  return rows[0] ? rows[0].borrower_id : null;
}

/**
 * WHAT THE BORROWER ALREADY HAS ON FILE for these two conditions.
 *
 * @returns {Promise<{
 *   borrowerId: string|null,
 *   card: {available:boolean, brand?:string|null, last4?:string|null, exp?:string|null, expired?:boolean},
 *   photoId: {available:boolean, documentId?:string|null, filename?:string|null},
 *   unreadable: boolean, why: string|null
 * }>}
 */
async function forLoan(loanId, opts = {}) {
  const client = opts.db || db;
  const empty = {
    borrowerId: null,
    card: { available: false },
    photoId: { available: false },
    unreadable: false,
    why: null,
  };

  let borrowerId = null;
  try {
    borrowerId = await borrowerOf(loanId, client);
  } catch (_) {
    // UNREADABLE IS NOT "NOTHING ON FILE". Saying the second when the first is
    // true asks a borrower for a card and an ID they have already given.
    return { ...empty, unreadable: true, why: 'PILOT could not read the borrower’s profile just now, so it did not check what is already on file.' };
  }
  if (!borrowerId) return empty;

  let saved = { available: false };
  try {
    saved = (await card.getSavedCard(borrowerId)) || { available: false };
  } catch (_) {
    return { ...empty, borrowerId, unreadable: true, why: 'PILOT could not read the card on the borrower’s profile just now.' };
  }

  /* AN EXPIRED CARD IS REPORTED AS EXPIRED, NOT AS ABSENT — through the shared
     module's own `isCardExpired`, so both products agree about when a card has
     run out. Absent and expired lead to different sentences: one asks for a
     card, the other says the one on file needs replacing. */
  let expired = false;
  if (saved.available && saved.exp) {
    // `parseExp` answers `{expMonth, expYear}` — its own names, not month/year.
    const { expMonth, expYear } = card.parseExp(saved.exp);
    if (expMonth && expYear) {
      try { expired = !!card.isCardExpired(expMonth, expYear); } catch (_) { expired = false; }
    }
  }

  let photo = { available: false };
  try {
    const { rows } = await client.query(
      `SELECT d.id, d.filename
         FROM borrowers b
         JOIN documents d ON d.id = b.photo_id_document_id
        WHERE b.id = $1::uuid`, [borrowerId]);
    if (rows[0]) photo = { available: true, documentId: String(rows[0].id), filename: rows[0].filename || null };
  } catch (_) {
    // The card half already answered; a photo-ID read failing on its own is
    // reported as nothing on file rather than losing the card answer with it.
    photo = { available: false };
  }

  return {
    borrowerId: String(borrowerId),
    card: saved.available
      ? { available: true, brand: saved.brand || null, last4: saved.last4 || null, exp: saved.exp || null, expired }
      : { available: false },
    photoId: photo,
    unreadable: false,
    why: null,
  };
}

/**
 * SAVE A CARD TO THE BORROWER'S PROFILE — the "bidirectional" half.
 *
 * VALIDATED THROUGH THE SHARED MODULE'S OWN `validateCardInput`, so a card this
 * door accepts is one the short-term side would accept too, refused in the same
 * words. A second validator is how one product starts taking a number the other
 * rejects.
 *
 * @returns {Promise<{ok:true, last4, brand}|{ok:false,status,error}>}
 */
async function saveCard(loanId, input, opts = {}) {
  const client = opts.db || db;

  let borrowerId = null;
  try {
    borrowerId = await borrowerOf(loanId, client);
  } catch (_) {
    return { ok: false, status: 503, error: 'PILOT could not read this loan just now. Try again in a moment.' };
  }
  if (!borrowerId) {
    return {
      ok: false,
      status: 409,
      error: 'This loan is not linked to a borrower profile yet, so there is nowhere to keep the card. Link the borrower first.',
    };
  }

  /* THE SHARED VALIDATOR ALSO NORMALISES, and what it hands back is what gets
     stored — the digits-only number, the four-digit year, the trimmed ZIP. Using
     its OUTPUT rather than the raw input is the difference between both products
     storing a card the same way and one of them storing whatever was typed.
     It accepts `expMonth`/`expYear`, so a screen that sends a single "MM/YY" box
     is split HERE through the module's own parser rather than by a second
     reading of what an expiry looks like. */
  const b = input || {};
  let expMonth = b.expMonth;
  let expYear = b.expYear;
  if ((expMonth === undefined || expMonth === null || expMonth === '') && b.exp) {
    ({ expMonth, expYear } = card.parseExp(b.exp));
  }
  const checked = card.validateCardInput({
    number: b.number, cvc: b.cvc, expMonth, expYear, zip: b.zip,
  });
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };

  let saved = null;
  try {
    saved = await card.saveCardForReuse(borrowerId, {
      number: checked.number,
      cvc: checked.cvc,
      expMonth: checked.expMonth,
      expYear: checked.expYear,
      zip: checked.zip,
    });
  } catch (_) {
    // NOTHING ABOUT THE FAILURE IS ECHOED. The input is a card number; an error
    // that quoted it would put a PAN in a log and on a screen.
    return { ok: false, status: 503, error: 'The card could not be saved just now. Try again in a moment.' };
  }

  return { ok: true, last4: saved.last4, brand: saved.brand, borrowerId: String(borrowerId) };
}

module.exports = { forLoan, saveCard, _internals: { borrowerOf } };
