/**
 * Appraisal payment card — save & reuse.
 *
 * The borrower enters the credit card the appraisal is ordered on. It is stored
 * encrypted at rest with the SAME AES-256-GCM helper used for SSNs
 * (src/lib/crypto.js encryptSSN/decryptSSN) and is NEVER logged in plaintext.
 * There are two at-rest homes:
 *   - application_payment_cards.card_encrypted (text; base64 of the GCM blob) —
 *     the per-file card the back office decrypts to place the appraisal order.
 *   - borrowers.saved_card_*  — an OPT-IN reusable copy carried across files
 *     (PAN + CVV each in their own bytea column; save_card_for_reuse=true).
 *
 * This module owns the reusable-copy lifecycle so both the borrower routes and
 * (a future) authorized-staff route can share one implementation. Callers are
 * responsible for their own authorization; the functions here only touch the
 * borrower profile / application rows they are handed.
 */
const db = require('../db');
const C = require('./crypto');

function cardBrand(num) {
  const s = String(num || '').replace(/\D/g, '');
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(s)) return 'Mastercard';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^6(011|5)/.test(s)) return 'Discover';
  return 'Card';
}

// Expiry is stored as "MM/YYYY" text so it round-trips cleanly to month/year.
function formatExp(month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!(m >= 1 && m <= 12) || !y) return null;
  return `${String(m).padStart(2, '0')}/${y < 100 ? 2000 + y : y}`;
}
function parseExp(exp) {
  const m = String(exp || '').match(/^\s*(\d{1,2})\s*\/\s*(\d{2,4})\s*$/);
  if (!m) return { expMonth: null, expYear: null };
  let year = parseInt(m[2], 10);
  if (year < 100) year += 2000;
  return { expMonth: parseInt(m[1], 10), expYear: year };
}

const last4Of = (num) => String(num || '').replace(/\D/g, '').slice(-4);

// Luhn mod-10 checksum — the standard card-number validity test.
function luhnOk(num) {
  const s = String(num || '').replace(/\D/g, '');
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = parseInt(s[i], 10);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

// The ONE validation contract for raw card input, shared by the borrower route and
// the authorized-staff route (#107). Returns { ok:true, number, cvc, expMonth,
// expYear, zip } (all normalized) or { ok:false, error } with a user-facing message.
function validateCardInput(b) {
  b = b || {};
  const number = String(b.number || '').replace(/\D/g, '');
  if (!luhnOk(number)) return { ok: false, error: 'That does not look like a valid card number — please check the digits.' };
  const expMonth = parseInt(b.expMonth, 10);
  const rawYear = parseInt(b.expYear, 10);
  if (!(expMonth >= 1 && expMonth <= 12)) return { ok: false, error: 'expiration month must be 1–12' };
  const fullYear = rawYear < 100 ? 2000 + rawYear : rawYear;
  const now = new Date();
  if (!(fullYear > now.getFullYear() || (fullYear === now.getFullYear() && expMonth >= now.getMonth() + 1)))
    return { ok: false, error: 'that card is expired' };
  const cvc = String(b.cvc || '').replace(/\D/g, '');
  if (cvc.length < 3 || cvc.length > 4) return { ok: false, error: 'security code must be 3 or 4 digits' };
  const zip = String(b.zip || '').trim().slice(0, 10);
  if (!zip) return { ok: false, error: 'billing ZIP is required' };
  return { ok: true, number, cvc, expMonth, expYear: fullYear, zip };
}

// Save the appraisal payment card onto a FILE and complete its condition — the
// single chokepoint the borrower route AND the authorized-staff route (#107) share
// (owner-directed: LO/processor/admin can enter these borrower conditions too).
// Input must already be validated via validateCardInput(). `borrowerId` is the
// card OWNER = the file's borrower (even when a staffer enters it). Encrypts PAN +
// CVV at rest with the GCM helper, upserts the per-file card, and moves the
// `appraisal_card` condition to 'received' (sign-off stays separate). Never logs
// card data. Returns a non-secret summary { last4, brand }.
async function saveApplicationCard({ appId, borrowerId, number, cvc, expMonth, expYear, zip }) {
  const brand = cardBrand(number);
  const enc = C.encryptSSN(JSON.stringify({ number, cvc })).toString('base64');
  await db.query(
    `INSERT INTO application_payment_cards (application_id,borrower_id,card_encrypted,last4,brand,exp_month,exp_year,billing_zip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (application_id) DO UPDATE SET
       card_encrypted=EXCLUDED.card_encrypted, last4=EXCLUDED.last4, brand=EXCLUDED.brand,
       exp_month=EXCLUDED.exp_month, exp_year=EXCLUDED.exp_year, billing_zip=EXCLUDED.billing_zip,
       borrower_id=EXCLUDED.borrower_id, updated_at=now()`,
    [appId, borrowerId, enc, last4Of(number), brand, expMonth, expYear, zip]);
  await db.query(
    `UPDATE checklist_items SET status='received', updated_at=now()
      WHERE application_id=$1 AND tool_key='appraisal_card'`, [appId]);
  return { last4: last4Of(number), brand };
}

/**
 * Persist an encrypted, reusable copy of the card onto the borrower's profile
 * and flip save_card_for_reuse on. `number` and `cvc` are plaintext strings in
 * memory only — they are encrypted before they touch the DB and never logged.
 * Returns a non-secret summary { last4, brand }.
 */
async function saveCardForReuse(borrowerId, { number, cvc, expMonth, expYear, zip }) {
  const brand = cardBrand(number);
  await db.query(
    `UPDATE borrowers SET
       saved_card_number_encrypted=$2,
       saved_card_cvv_encrypted=$3,
       saved_card_last4=$4,
       saved_card_exp=$5,
       saved_card_brand=$6,
       saved_card_billing_zip=$7,
       save_card_for_reuse=true,
       updated_at=now()
     WHERE id=$1`,
    [borrowerId,
     C.encryptSSN(String(number)),                 // bytea (GCM blob)
     cvc ? C.encryptSSN(String(cvc)) : null,       // bytea (GCM blob)
     last4Of(number),
     formatExp(expMonth, expYear),
     brand,
     zip || null]);
  return { last4: last4Of(number), brand };
}

/**
 * Masked preview of the borrower's saved card. Never decrypts the PAN — returns
 * only display-safe fields so a UI can offer "reuse my saved card". Returns
 * { available:false } when there is nothing to reuse.
 */
async function getSavedCard(borrowerId) {
  const r = await db.query(
    `SELECT save_card_for_reuse,
            saved_card_last4, saved_card_brand, saved_card_exp, saved_card_billing_zip,
            (saved_card_number_encrypted IS NOT NULL) AS has_number
       FROM borrowers WHERE id=$1`, [borrowerId]);
  const row = r.rows[0];
  if (!row || !row.save_card_for_reuse || !row.has_number) return { available: false };
  return {
    available: true,
    last4: row.saved_card_last4 ? String(row.saved_card_last4).trim() : null,
    brand: row.saved_card_brand || null,
    exp: row.saved_card_exp || null,
    zip: row.saved_card_billing_zip || null,
  };
}

/**
 * Copy the borrower's saved card into application_payment_cards for `applicationId`
 * and satisfy that file's appraisal_card condition — mirroring the direct-entry
 * path in routes/borrower.js. The PAN/CVV are decrypted only in memory to
 * re-encrypt them for the per-file column; nothing is logged.
 *
 *   profileBorrowerId — whose saved card to reuse (the profile that owns it)
 *   actorId           — borrower_id to stamp on the resulting per-file card row
 *
 * Authorization is the caller's responsibility. Returns
 * { ok:true, last4, brand } or { ok:false, error }.
 */
async function applySavedCardToApplication({ applicationId, profileBorrowerId, actorId }) {
  const r = await db.query(
    `SELECT save_card_for_reuse, saved_card_number_encrypted, saved_card_cvv_encrypted,
            saved_card_last4, saved_card_brand, saved_card_exp, saved_card_billing_zip
       FROM borrowers WHERE id=$1`, [profileBorrowerId]);
  const row = r.rows[0];
  if (!row || !row.save_card_for_reuse || !row.saved_card_number_encrypted)
    return { ok: false, error: 'no saved card on file to reuse' };

  const number = C.decryptSSN(row.saved_card_number_encrypted);
  if (!number) return { ok: false, error: 'could not decrypt the saved card' };
  const cvc = row.saved_card_cvv_encrypted ? (C.decryptSSN(row.saved_card_cvv_encrypted) || '') : '';
  const { expMonth, expYear } = parseExp(row.saved_card_exp);
  const brand = row.saved_card_brand || cardBrand(number);
  const last4 = row.saved_card_last4 ? String(row.saved_card_last4).trim() : last4Of(number);

  // Re-encrypt for the per-file text column (base64 of the same GCM helper).
  const enc = C.encryptSSN(JSON.stringify({ number, cvc })).toString('base64');
  await db.query(
    `INSERT INTO application_payment_cards (application_id,borrower_id,card_encrypted,last4,brand,exp_month,exp_year,billing_zip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (application_id) DO UPDATE SET
       card_encrypted=EXCLUDED.card_encrypted, last4=EXCLUDED.last4, brand=EXCLUDED.brand,
       exp_month=EXCLUDED.exp_month, exp_year=EXCLUDED.exp_year, billing_zip=EXCLUDED.billing_zip,
       borrower_id=EXCLUDED.borrower_id, updated_at=now()`,
    [applicationId, actorId, enc, last4, brand, expMonth, expYear, row.saved_card_billing_zip || null]);
  await db.query(
    `UPDATE checklist_items SET status='received', updated_at=now()
      WHERE application_id=$1 AND tool_key='appraisal_card'`, [applicationId]);
  return { ok: true, last4, brand };
}

/**
 * Auto-apply the borrower's saved reusable card to a NEW file, with no tap.
 * Called right after a file's checklist is generated: if the borrower opted into
 * "save to next file" (save_card_for_reuse=true, a card on file) AND this new
 * file has an OUTSTANDING appraisal_card condition, copy the card and satisfy the
 * condition automatically. No-op (and never throws) otherwise — file creation
 * must never be blocked by this. Returns { applied, last4? }.
 */
async function autoApplySavedCardIfOptedIn(applicationId, borrowerId) {
  try {
    // Only when the borrower opted in and actually has a card to reuse.
    const saved = await getSavedCard(borrowerId);
    if (!saved.available) return { applied: false };
    // Only when this file has an appraisal_card condition that isn't done yet
    // (never re-key or overwrite a card the borrower already entered on this file).
    const cond = await db.query(
      `SELECT 1 FROM checklist_items
        WHERE application_id=$1 AND tool_key='appraisal_card'
          AND status NOT IN ('received','satisfied') LIMIT 1`, [applicationId]);
    if (!cond.rows[0]) return { applied: false };
    const out = await applySavedCardToApplication({ applicationId, profileBorrowerId: borrowerId, actorId: borrowerId });
    return out.ok ? { applied: true, last4: out.last4, brand: out.brand } : { applied: false };
  } catch (_) { return { applied: false }; }
}

module.exports = {
  cardBrand, formatExp, parseExp,
  luhnOk, validateCardInput, saveApplicationCard,
  saveCardForReuse, getSavedCard, applySavedCardToApplication, autoApplySavedCardIfOptedIn,
};
