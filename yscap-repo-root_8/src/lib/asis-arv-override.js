'use strict';
/**
 * AS-IS / ARV super-admin OVERRIDE of the term-sheet-sent freeze (owner-directed 2026-08).
 *
 * The owner's words: "update the as-is value and the ARV value in that application, but
 * leaving all the details of the term sheet the same … if any details from the loan are
 * changing, then the admin should not be able to overwrite if the loan amount or any fees
 * are changing … When clicking Save Changes, it should put in something which gives me the
 * option to override as admin."
 *
 * So: on a file whose Term Sheet DocuSign package has been SENT (term-sheet-frozen), a
 * SUPER-ADMIN — behind a double warning + a typed reason — may update ONLY the as-is value
 * and the ARV, keeping the sent term sheet VALID, but ONLY when the change is terms-neutral.
 * If re-pricing at the new as-is/ARV would move the loan amount or ANY fee, the override is
 * REFUSED (clear the package and re-register).
 *
 * TWO HARD PROBLEMS this module solves (see docs / CLAUDE.md file-lock notes):
 *   1. Neutrality is FORWARD-LOOKING. An as-is/ARV edit does not itself move the loan, but a
 *      later re-register would re-size — so "the loan amount or a fee is changing" means:
 *      would re-pricing the CURRENT registration at the new as-is/ARV keep the same
 *      borrower-visible figures? We RE-PRICE (fileLock.finalNumbersKey) and, as a SANITY
 *      GATE, first prove our re-price reproduces the STORED quote — failing CLOSED (refuse)
 *      if it does not (a changed company default, a TPO settings file, an engine change).
 *   2. The db/486 trigger reopens Products & Pricing + the signed-term-sheet condition + marks
 *      the registration stale on ANY as_is_value/arv write, at the DB layer, regardless of the
 *      route. A neutral override must NOT reopen them, so `apply` runs in ONE transaction:
 *      capture the exact rows the trigger will reopen, write as_is/arv, then RE-ASSERT those
 *      rows to their captured before-state — so the sent term sheet stays valid.
 *
 * The freeze DECISION itself is the pure fileLock.asIsArvTermSheetOverride (a sibling of
 * termsNeutralReregister). This module orchestrates: validate the request, compute
 * neutrality (fail-closed), and apply with the re-assert.
 */
const db = require('../db');
const fileLock = require('./file-lock');
const pricing = require('./pricing');
const numberBounds = require('./number-bounds');
const dealBasis = require('./deal-basis');

// The ONLY body keys an as-is/ARV override request may carry. adminOverride /
// overrideReason are the control keys; econVersion is a harmless concurrency stamp some
// callers send. Anything else means it is NOT an as-is/ARV-only edit → the freeze governs.
const ALLOWED_KEYS = new Set(['asIsValue', 'arv', 'adminOverride', 'overrideReason', 'econVersion']);

/** PURE: does this request body touch ONLY the as-is value / ARV (and control keys)? */
function isAsIsArvOnly(body) {
  const keys = Object.keys(body || {});
  if (!keys.length) return false;
  const touchesTarget = ('asIsValue' in body) || ('arv' in body);
  return touchesTarget && keys.every((k) => ALLOWED_KEYS.has(k));
}

// A number from a body value, or null for blank, or NaN for junk.
function numOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Re-price the CURRENT registration at the proposed as-is/ARV and decide whether the
 * borrower-visible terms stay byte-identical (terms-neutral). FAILS CLOSED — any
 * unreadable registration/quote, a re-price that throws, or a re-price that does not
 * reproduce the stored quote (the sanity gate) → { neutral: false }.
 */
async function computeNeutral(appId, proposed, client = db) {
  const reg = (await client.query(
    `SELECT program, quote, inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`,
    [appId])).rows[0];
  if (!reg) return { neutral: false, reason: 'no_registration' };
  const parse = (x) => { if (x == null) return null; if (typeof x !== 'string') return x; try { return JSON.parse(x); } catch (_) { return null; } };
  const storedQuote = parse(reg.quote);
  const storedInputs = parse(reg.inputs);
  if (!storedQuote || !storedInputs || !reg.program) return { neutral: false, reason: 'unreadable_registration' };
  const term = storedInputs.term;

  // A refinance sizes on the as-is value (its purchasePrice input IS the as-is value —
  // db/399 / 2026-08-02), so on a refinance the purchasePrice input must move with as-is.
  // A purchase's purchasePrice is the real contract price and is left alone.
  const app = (await client.query(`SELECT loan_type FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  const refi = dealBasis.sizesOnAsIsValue(app.loan_type);

  let oldQuote, newQuote;
  try {
    // Re-derive the stored quote from the stored inputs (retail path — no opts). If the
    // registration used TPO firm/channel settings, or a company default changed since,
    // this will NOT reproduce the stored quote and the sanity gate below refuses.
    oldQuote = pricing.quoteProgram(reg.program, storedInputs);
    const patched = { ...storedInputs, asIsValue: proposed.asIsValue, arv: proposed.arv };
    if (refi) patched.purchasePrice = proposed.asIsValue;
    newQuote = pricing.quoteProgram(reg.program, patched);
  } catch (_) {
    return { neutral: false, reason: 'reprice_failed' };
  }

  const storedKey = fileLock.finalNumbersKey(storedQuote, term);
  // SANITY GATE: our re-price must reproduce the stored quote before we can trust the
  // neutrality verdict. An unreadable quote is not proof the loan is unchanged.
  if (fileLock.finalNumbersKey(oldQuote, term) !== storedKey) return { neutral: false, reason: 'reprice_mismatch' };
  const neutral = fileLock.finalNumbersKey(newQuote, term) === storedKey;
  return { neutral, reason: neutral ? 'ok' : 'terms_moved' };
}

/**
 * Decide what to do with an as-is/ARV override request (body.adminOverride === true).
 * Returns one of:
 *   { status: 'refused', code, message }
 *   { status: 'not_needed' }                    // the file is not term-sheet-frozen → normal path
 *   { status: 'apply', values: {asIsValue, arv}, reason }
 */
async function evaluate({ appId, body, actor }) {
  if (!(actor && actor.kind === 'staff' && actor.role === 'super_admin')) {
    return { status: 'refused', code: 403, message: 'Only a super admin can override a sent term sheet to update the as-is value and ARV.' };
  }
  if (!isAsIsArvOnly(body)) {
    return { status: 'refused', code: 400, message: 'The admin override can update ONLY the as-is value and the ARV. Clear the Term Sheet package to change anything else.' };
  }
  const reason = String(body.overrideReason || '').trim();
  if (!reason) return { status: 'refused', code: 400, message: 'Enter a short reason for the override before saving.' };

  const cur = (await db.query(`SELECT as_is_value, arv FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!cur) return { status: 'refused', code: 404, message: 'application not found' };

  // The FINAL as-is/ARV the file would carry: the new value where given, else current.
  const asIs = ('asIsValue' in body) ? numOrNull(body.asIsValue) : Number(cur.as_is_value);
  const arv = ('arv' in body) ? numOrNull(body.arv) : Number(cur.arv);
  if (('asIsValue' in body) && Number.isNaN(asIs)) return { status: 'refused', code: 400, message: 'asIsValue must be a number' };
  if (('arv' in body) && Number.isNaN(arv)) return { status: 'refused', code: 400, message: 'arv must be a number' };
  // Bound each supplied value to its column (a fat-fingered paste is a 400, not a 500).
  if (('asIsValue' in body) && asIs != null) {
    const bad = numberBounds.applicationColumnProblem('as_is_value', asIs);
    if (bad) return { status: 'refused', code: 400, message: bad };
  }
  if (('arv' in body) && arv != null) {
    const bad = numberBounds.applicationColumnProblem('arv', arv);
    if (bad) return { status: 'refused', code: 400, message: bad };
  }
  const values = { asIsValue: asIs != null && Number.isFinite(asIs) ? asIs : null, arv: arv != null && Number.isFinite(arv) ? arv : null };

  // Read the freeze once. A STATUS freeze (CTC/funded/…) is never lifted by this override
  // — the recorded way through those is a super-admin UNLOCK.
  const row = await fileLock._internals.lockInputs(appId, db);
  if (!row) return { status: 'refused', code: 404, message: 'application not found' };
  const statusReason = fileLock._internals.statusFreezeReason(row, { actor });
  if (statusReason) return { status: 'refused', code: 409, message: statusReason };
  const tsReason = fileLock._internals.termSheetFreezeReason(row, { actor });
  if (!tsReason) return { status: 'not_needed' };   // not term-sheet-frozen → ordinary save

  // Term-sheet-frozen: the override applies ONLY when the change is terms-neutral.
  const neut = await computeNeutral(appId, values, db);
  if (!neut.neutral) {
    return {
      status: 'refused', code: 409,
      message: 'This change would move the loan amount or a fee, so the sent term sheet would no longer match. Clear the Term Sheet package first, then re-register.',
    };
  }
  // Final freeze gate (pure) — belt-and-suspenders on the neutrality + super-admin + request.
  const block = fileLock.asIsArvTermSheetOverride(row, true, { actor, overrideRequested: true });
  if (block) return { status: 'refused', code: 409, message: block };

  return { status: 'apply', values, reason };
}

/**
 * Apply a neutral as-is/ARV override in ONE transaction, keeping the sent term sheet valid:
 * capture the exact rows the db/486 trigger reopens, write as_is/arv, then RE-ASSERT those
 * rows to their captured before-state. Returns { before, changed }.
 */
async function apply({ appId, values }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Capture the before-state of exactly what the db/486 trigger will reopen on an
    // as_is_value/arv change: the Products & Pricing item(s), the signed-term-sheet
    // condition item(s), and the current registration's stale flag. (rtl_cond_iska and
    // the SOW condition are gated on loan_amount / rehab_budget, which we never touch.)
    const items = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.reviewed_at, ci.reviewed_by, ci.notes
         FROM checklist_items ci LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id = $1 AND (ci.tool_key = 'product_pricing' OR t.code = 'rtl_cond_signedts')`,
      [appId])).rows;
    const reg = (await client.query(
      `SELECT stale, stale_reason FROM product_registrations WHERE application_id = $1 AND is_current LIMIT 1`,
      [appId])).rows[0] || null;
    const beforeRow = (await client.query(`SELECT as_is_value, arv FROM applications WHERE id = $1`, [appId])).rows[0] || {};

    const upd = await client.query(
      `UPDATE applications SET as_is_value = $1, arv = $2, updated_at = now() WHERE id = $3`,
      [values.asIsValue, values.arv, appId]);
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); const e = new Error('application not found'); e.notFound = true; throw e; }

    // RE-ASSERT — restore the exact rows the trigger just reopened, so a neutral change
    // leaves the sent term sheet and its conditions untouched (the whole point).
    for (const it of items) {
      await client.query(
        `UPDATE checklist_items
            SET status = $2, signed_off_at = $3, signed_off_by = $4, reviewed_at = $5, reviewed_by = $6, notes = $7, updated_at = now()
          WHERE id = $1`,
        [it.id, it.status, it.signed_off_at, it.signed_off_by, it.reviewed_at, it.reviewed_by, it.notes]);
    }
    if (reg) {
      await client.query(
        `UPDATE product_registrations SET stale = $2, stale_reason = $3 WHERE application_id = $1 AND is_current`,
        [appId, reg.stale, reg.stale_reason]);
    }
    await client.query('COMMIT');
    return {
      before: { as_is_value: beforeRow.as_is_value, arv: beforeRow.arv },
      changed: {
        as_is_value: { from: beforeRow.as_is_value, to: values.asIsValue },
        arv: { from: beforeRow.arv, to: values.arv },
      },
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { isAsIsArvOnly, computeNeutral, evaluate, apply, _internals: { numOrNull, ALLOWED_KEYS } };
