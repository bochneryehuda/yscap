'use strict';
/**
 * THE RECORDED PAYMENT INSTRUCTION — the database half of `payment-options.js`.
 *
 * `payment-options.js` says what the three ways ARE and what each one does at each
 * appraisal company; this reads and writes which one was actually chosen for a
 * given order (`appraisal_payment_intents`, db/555).
 *
 * IT NEVER CHARGES ANYTHING. Not one function here talks to a vendor. On Richer
 * Values — the only company whose payment calls we have — the CHARGE is performed
 * by `src/richervalues/payment.js` exactly as it always was, and this module is
 * called afterwards to write down what happened. Keeping the two apart is
 * deliberate: the proven money path stays untouched, and the recording can never
 * become a second, half-tested way to move money.
 *
 * WHY `record` NEVER THROWS, AND WHY THE ROUTE STILL CHECKS
 *   On Richer Values this rides along after a real payment. A failure to write the
 *   note must never surface as "the payment failed" on an order that was in fact
 *   paid — that is the worst possible lie for this screen to tell. So `record`
 *   swallows and reports. On AppraisalScope and Class the instruction IS the whole
 *   action, so the route there checks the returned `ok` and says so plainly; a
 *   silent no-op would leave the back office with nothing, which is the exact hole
 *   this table was added to close.
 */

const options = require('./payment-options');

/** Lazy, so the pure half of this feature stays requireable with no database. */
function database() { return require('../../db'); }

/**
 * Write (or change) the instruction for one order.
 *
 * @param {object}  opts
 * @param {string}  opts.appId
 * @param {string}  opts.vendor      'nan' | 'class' | 'rv'
 * @param {number}  opts.orderId     the vendor order table's own id
 * @param {string}  opts.method      one of payment-options.METHODS
 * @param {string} [opts.staffId]    who decided
 * @param {string} [opts.note]
 * @param {boolean}[opts.settled]    the vendor took the money just now
 * @param {object} [opts.dbc]        run on a caller's connection/transaction
 * @returns {Promise<{ok:boolean, intent?:object, error?:string}>} never throws
 */
async function record(opts = {}) {
  const {
    appId, vendor, orderId, method, staffId = null, note = null,
    settled = false, dbc = null,
  } = opts;

  if (!appId) return { ok: false, error: 'no_application' };
  if (!options.isVendor(vendor)) return { ok: false, error: 'unknown_vendor' };
  if (!options.isMethod(method)) return { ok: false, error: 'unknown_method' };
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) return { ok: false, error: 'no_order' };

  const v = String(vendor).toLowerCase();
  const m = String(method).toUpperCase();

  // WHAT WAS TRUE WHEN IT WAS CHOSEN. Stored rather than derived on read, so a
  // vendor whose payment API is wired up next year cannot silently rewrite the
  // history of the orders somebody settled by hand.
  const performedBy = options.capability(v, m).does === options.DOES.VENDOR ? 'vendor' : 'back_office';

  const q = dbc || database();
  try {
    const r = await q.query(
      // EVERY PLACEHOLDER IS CAST. `$5` appears twice — once as `chosen_by` and
      // once inside a CASE for `settled_by` — and Postgres cannot deduce one type
      // for a parameter it sees in two positions ("inconsistent types deduced for
      // parameter $5"). The same goes for the boolean driving both CASEs.
      `INSERT INTO appraisal_payment_intents
         (application_id, vendor, vendor_order_id, method, chosen_by, note, performed_by,
          settled_at, settled_by)
       VALUES ($1::uuid, $2::text, $3::bigint, $4::text, $5::uuid, $6::text, $7::text,
               CASE WHEN $8::boolean THEN now() END,
               CASE WHEN $8::boolean THEN $5::uuid END)
       ON CONFLICT (vendor, vendor_order_id) DO UPDATE SET
         method       = EXCLUDED.method,
         chosen_by    = EXCLUDED.chosen_by,
         chosen_at    = now(),
         note         = EXCLUDED.note,
         performed_by = EXCLUDED.performed_by,
         -- CHANGING YOUR MIND DOES NOT UN-PAY AN ORDER. A settled instruction
         -- keeps its settlement unless this write is itself a settlement: the
         -- money already moved, and the desk must never go back to reading
         -- "still to be paid" because somebody corrected the method afterwards.
         settled_at   = COALESCE(appraisal_payment_intents.settled_at, EXCLUDED.settled_at),
         settled_by   = COALESCE(appraisal_payment_intents.settled_by, EXCLUDED.settled_by)
       RETURNING *`,
      [appId, v, oid, m, staffId, note || null, performedBy, !!settled]);
    return { ok: true, intent: r.rows[0] };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Mark an instruction as actually paid. Separate from `record` on purpose: saying
 * "this is how it will be paid" and "this has been paid" are different claims and
 * the desk prints them differently.
 *
 * Refuses an order with no instruction rather than inventing one — settling
 * something nobody chose would put a paid stamp on a method that was never picked.
 */
async function settle(opts = {}) {
  const { vendor, orderId, staffId = null, note = null, dbc = null } = opts;
  if (!options.isVendor(vendor)) return { ok: false, error: 'unknown_vendor' };
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) return { ok: false, error: 'no_order' };

  const q = dbc || database();
  try {
    const r = await q.query(
      `UPDATE appraisal_payment_intents
          SET settled_at   = COALESCE(settled_at, now()),
              settled_by   = COALESCE(settled_by, $3),
              settled_note = COALESCE($4, settled_note)
        WHERE vendor=$1 AND vendor_order_id=$2
        RETURNING *`,
      [String(vendor).toLowerCase(), oid, staffId, note || null]);
    if (!r.rows[0]) return { ok: false, error: 'no_intent' };
    return { ok: true, intent: r.rows[0] };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** Undo a settlement — somebody marked the wrong order paid. Keeps the method. */
async function unsettle(opts = {}) {
  const { vendor, orderId, dbc = null } = opts;
  if (!options.isVendor(vendor)) return { ok: false, error: 'unknown_vendor' };
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) return { ok: false, error: 'no_order' };
  const q = dbc || database();
  try {
    const r = await q.query(
      `UPDATE appraisal_payment_intents
          SET settled_at=NULL, settled_by=NULL, settled_note=NULL
        WHERE vendor=$1 AND vendor_order_id=$2 RETURNING *`,
      [String(vendor).toLowerCase(), oid]);
    if (!r.rows[0]) return { ok: false, error: 'no_intent' };
    return { ok: true, intent: r.rows[0] };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Every instruction on a file, keyed `<vendor>:<orderId>` so a caller holding a
 * mixed list of orders can look each one up without a query per order.
 * Returns `{}` on any failure — this decorates a screen, and a payment note that
 * cannot be read must never take the orders list down with it.
 */
async function forApplication(appId, dbc = null) {
  if (!appId) return {};
  const q = dbc || database();
  try {
    const r = await q.query(
      `SELECT i.*, s.full_name AS chosen_by_name, t.full_name AS settled_by_name
         FROM appraisal_payment_intents i
         LEFT JOIN staff_users s ON s.id = i.chosen_by
         LEFT JOIN staff_users t ON t.id = i.settled_by
        WHERE i.application_id = $1`, [appId]);
    const out = {};
    for (const row of r.rows) out[`${row.vendor}:${row.vendor_order_id}`] = decorate(row);
    return out;
  } catch (_) { return {}; }
}

/** One instruction, or null. Same failure posture as `forApplication`. */
async function forOrder(vendor, orderId, dbc = null) {
  if (!options.isVendor(vendor)) return null;
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) return null;
  const q = dbc || database();
  try {
    const r = await q.query(
      `SELECT i.*, s.full_name AS chosen_by_name, t.full_name AS settled_by_name
         FROM appraisal_payment_intents i
         LEFT JOIN staff_users s ON s.id = i.chosen_by
         LEFT JOIN staff_users t ON t.id = i.settled_by
        WHERE i.vendor=$1 AND i.vendor_order_id=$2`,
      [String(vendor).toLowerCase(), oid]);
    return r.rows[0] ? decorate(r.rows[0]) : null;
  } catch (_) { return null; }
}

/** Attach the plain-language reading so every surface says the same sentence. */
function decorate(row) {
  return { ...row, describe: options.describeIntent(row) };
}

module.exports = { record, settle, unsettle, forApplication, forOrder, _internals: { decorate } };
