'use strict';
/**
 * AS-IS / ARV super-admin OVERRIDE of the term-sheet-sent freeze (owner-directed 2026-08).
 *
 * The owner's words: "update the as-is value and the ARV value in that application, but
 * leaving all the details of the term sheet the same … When clicking Save Changes, it should
 * put in something which gives me the option to override as admin." Then, choosing the scope
 * for a change that WOULD re-price the loan (2026-08, "Save ARV, keep the loan"): RECORD the
 * new as-is/ARV but keep the loan amount, the registration and the sent term sheet EXACTLY as
 * they are — "you're just updating the recorded value. Nothing about the loan changes."
 *
 * So: on a file whose Term Sheet DocuSign package has been SENT (term-sheet-frozen), a
 * SUPER-ADMIN — behind a double warning + a typed reason — may update ONLY the as-is value
 * and the ARV, keeping the sent term sheet and everything it prices EXACTLY as they are —
 * whether or not re-pricing at the new figures WOULD have moved the loan. The loan never
 * moves: only the recorded as-is/ARV changes.
 *
 * TWO THINGS this module handles (see docs / CLAUDE.md file-lock notes):
 *   1. KEEPING THE LOAN FROZEN is the whole point, and it is done by apply(), NOT by refusing
 *      the save. The db/486 trigger reopens Products & Pricing + the signed-term-sheet
 *      condition + marks the registration stale on ANY as_is_value/arv write, at the DB layer,
 *      regardless of route. So `apply` runs in ONE transaction: capture the exact rows the
 *      trigger will reopen, write as_is/arv, then RE-ASSERT those rows to their captured
 *      before-state — so loan_amount, the registration, the sent term sheet and its conditions
 *      stay untouched. This is what implements "keep the loan" for a change that would
 *      otherwise re-size it.
 *   2. NEUTRALITY IS NOW ADVISORY, NOT A GATE. We still RE-PRICE the current registration at
 *      the new figures (fileLock.finalNumbersKey, with the stored-quote SANITY GATE) to record
 *      whether the override kept the borrower-visible terms or deliberately moved past them —
 *      but this is best-effort and never blocks the save. A super-admin who explicitly requests
 *      the override saves regardless. The STATUS freeze (CTC/funded/…) still always stands.
 *
 * The freeze DECISION itself is the pure fileLock.asIsArvTermSheetOverride (a sibling of
 * termsNeutralReregister). This module orchestrates: validate the request, compute the
 * (advisory) neutrality verdict, and apply with the re-assert.
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
async function computeNeutral(appId, changes, client = db) {
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
    // Patch ONLY the fields the caller is actually changing — a field left untouched keeps
    // the stored input verbatim, so an arv-only override never disturbs the as-is side (and
    // never fabricates a value for a NULL as-is column).
    const patched = { ...storedInputs };
    if ('asIsValue' in changes) { patched.asIsValue = changes.asIsValue; if (refi) patched.purchasePrice = changes.asIsValue; }
    if ('arv' in changes) patched.arv = changes.arv;
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
 *   { status: 'apply', changes: {asIsValue?, arv?}, reason }
 *
 * `changes` carries ONLY the fields the request actually sent — an arv-only override never
 * writes (nor fabricates) a value for the as-is column, and vice versa.
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

  // Confirm the application exists (it is also the target of the write).
  const cur = (await db.query(`SELECT as_is_value, arv FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!cur) return { status: 'refused', code: 404, message: 'application not found' };

  // Build the change set from ONLY the fields the request sent. A field left out is never
  // written — so an arv-only override leaves the as-is column exactly as it is (including a
  // NULL as-is, which the old "read current, coalesce" shape would have written as 0).
  const changes = {};
  if ('asIsValue' in body) {
    const n = numOrNull(body.asIsValue);
    if (Number.isNaN(n)) return { status: 'refused', code: 400, message: 'asIsValue must be a number' };
    if (n != null) {
      const bad = numberBounds.applicationColumnProblem('as_is_value', n);
      if (bad) return { status: 'refused', code: 400, message: bad };
    }
    changes.asIsValue = n;
  }
  if ('arv' in body) {
    const n = numOrNull(body.arv);
    if (Number.isNaN(n)) return { status: 'refused', code: 400, message: 'arv must be a number' };
    if (n != null) {
      const bad = numberBounds.applicationColumnProblem('arv', n);
      if (bad) return { status: 'refused', code: 400, message: bad };
    }
    changes.arv = n;
  }

  // Read the freeze once. A STATUS freeze (CTC/funded/…) is never lifted by this override
  // — the recorded way through those is a super-admin UNLOCK.
  const row = await fileLock._internals.lockInputs(appId, db);
  if (!row) return { status: 'refused', code: 404, message: 'application not found' };
  const statusReason = fileLock._internals.statusFreezeReason(row, { actor });
  if (statusReason) return { status: 'refused', code: 409, message: statusReason };
  const tsReason = fileLock._internals.termSheetFreezeReason(row, { actor });
  if (!tsReason) return { status: 'not_needed' };   // not term-sheet-frozen → ordinary save

  // Term-sheet-frozen. Owner-directed 2026-08 ("Save ARV, keep the loan"): a super_admin
  // may RECORD the new as-is/ARV whether or not re-pricing at them would move the loan. The
  // loan itself never moves — apply() re-asserts Products & Pricing, the signed-term-sheet
  // condition and the registration's stale flag, so loan_amount, the registration, the sent
  // term sheet and its conditions stay EXACTLY as they are. So there is NO neutrality
  // refusal any more. We still compute the neutrality verdict best-effort (never blocking)
  // purely so the audit trail can record whether the override kept the terms or deliberately
  // moved past them — a throw here must never stop the save (fail-open on the INFO value).
  let neutral = null;
  try { neutral = (await computeNeutral(appId, changes, db)).neutral; } catch (_) { neutral = null; }

  // Final freeze gate (pure) — belt-and-suspenders on super-admin + explicit request. The
  // STATUS freeze (checked above) still always stands; neutrality no longer gates.
  const block = fileLock.asIsArvTermSheetOverride(row, neutral, { actor, overrideRequested: true });
  if (block) return { status: 'refused', code: 409, message: block };

  return { status: 'apply', changes, reason, neutral };
}

// Map a `changes` key to its applications column. The ONLY writable targets — anything
// else in `changes` is ignored (evaluate has already proved the request touched only these).
const COLUMN_OF = { asIsValue: 'as_is_value', arv: 'arv' };

/**
 * Apply a neutral as-is/ARV override in ONE transaction, keeping the sent term sheet valid:
 * capture the exact rows the db/486 trigger reopens, write ONLY the changed columns, then
 * RE-ASSERT those rows to their captured before-state. `changes` carries only the fields the
 * request sent (an arv-only override never touches as_is_value). Returns { before, changed }.
 *
 * NOTE: this trusts `evaluate` — it does NOT re-run the super-admin / neutrality / freeze
 * gates. Never call apply() on a `changes` set that did not come from a `status:'apply'`
 * evaluate() on the same request.
 */
async function apply({ appId, changes }) {
  // Build the dynamic SET from the changed columns only. A field left out of `changes` is
  // never written — the whole point of the changes-shape.
  const sets = [];
  const params = [];
  for (const key of Object.keys(COLUMN_OF)) {
    if (key in (changes || {})) { params.push(changes[key]); sets.push(`${COLUMN_OF[key]} = $${params.length}`); }
  }
  if (!sets.length) { const e = new Error('nothing to change'); e.notFound = true; throw e; }

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

    params.push(appId);
    const upd = await client.query(
      `UPDATE applications SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params);
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
    // Report only the columns actually written (from → to), so the audit trail reflects the
    // real change and never invents a from/to for a column the override left alone.
    const changed = {};
    if ('asIsValue' in changes) changed.as_is_value = { from: beforeRow.as_is_value, to: changes.asIsValue };
    if ('arv' in changes) changed.arv = { from: beforeRow.arv, to: changes.arv };
    return { before: { as_is_value: beforeRow.as_is_value, arv: beforeRow.arv }, changed };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { isAsIsArvOnly, computeNeutral, evaluate, apply, _internals: { numOrNull, ALLOWED_KEYS } };
