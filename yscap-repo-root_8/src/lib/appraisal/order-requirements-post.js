'use strict';
/**
 * POST THE INVESTOR'S APPRAISAL REQUIREMENTS ONTO THE ORDER, right after it is
 * placed (owner-directed 2026-08-16).
 *
 * The requirements themselves are stated ONCE in
 * `investor-appraisal-requirements.js`; this file is only the plumbing that puts
 * them on the order thread of whichever AMC the order went to. Two vendors have
 * a message channel and both are wired: NAN (`amc/comments.postComment`, the CDG
 * AddComment) and Class Valuation (`class/messages.note`). Richer Values is
 * deliberately not wired — their API has no messaging at all (31 message-shaped
 * paths probed live, all 404), so their thread is EMAIL, and an automatic email
 * to an outside desk on every order is a different decision from a note on an
 * order the owner has not asked for.
 *
 * FOUR RULES, all of which matter more than the feature:
 *
 *  1. IT CAN NEVER FAIL AN ORDER. The appraisal is already placed by the time
 *     this runs, so every path returns a VERDICT and nothing throws. Both
 *     callers DO await it — one message on a request that has already made
 *     several, in exchange for the message not being lost if the process is
 *     recycled the moment the response goes out — and both wrap the call anyway.
 *  2. IT POSTS ONCE. Both vendors keep the thread in our own tables, so "have we
 *     already said this?" is answered by looking, keyed on the stable first line
 *     (`MARKER`). A re-ordered appraisal is a NEW order row and gets its own
 *     message, which is right — it is a new appraiser.
 *  3. IT NAMES NOBODY. The message is built by the requirements module, which
 *     scrubs it. An AMC is an outside company and the capital partner's name
 *     never reaches one.
 *  4. A FAILURE IS VISIBLE, NOT SWALLOWED. Class writes the note row first and
 *     records `send_error` on it, so a message that did not go out sits on the
 *     file's own thread and can be retried by hand. NAN journals the attempt.
 *     Either way the reason is logged with the order id.
 */

const reqs = require('./investor-appraisal-requirements');

/**
 * Did this order already carry the requirements message? Keyed on the stable
 * first line, on the vendor's own thread table — the same rows their human
 * messages live in, so nothing extra has to be kept in step.
 *
 * The two queries are written out rather than built from a table name: this is
 * the kind of helper somebody extends later, and a hand-assembled identifier is
 * how that goes wrong.
 */
const LIKE_MARKER = `${reqs.MARKER}%`;
async function alreadyPosted(db, vendor, orderRowId) {
  try {
    const r = vendor === 'class'
      ? await db.query('SELECT 1 FROM class_notes WHERE class_order_row = $1 AND content LIKE $2 LIMIT 1',
        [orderRowId, LIKE_MARKER])
      : await db.query('SELECT 1 FROM amc_order_comments WHERE order_id = $1 AND body LIKE $2 LIMIT 1',
        [orderRowId, LIKE_MARKER]);
    return r.rows.length > 0;
  } catch (_) {
    // Unreadable → say YES. A duplicate note to an outside appraiser is worse
    // than a missing one: the requirements are also enforced on the way back in.
    return true;
  }
}

/**
 * Everything the message needs, read from the file. Returns null when this file
 * has no investor requirements to state.
 */
async function contextFor(db, appId) {
  const r = await db.query(
    `SELECT a.lender, a.ys_loan_number, a.property_address, a.program, a.loan_type, a.rehab_type,
            (SELECT pr.program FROM product_registrations pr
              WHERE pr.application_id = a.id AND pr.is_current = true
              ORDER BY pr.created_at DESC LIMIT 1) AS registered_program
       FROM applications a WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const app = r.rows[0];
  if (!app) return null;
  const investorKey = reqs.investorForFile({ noteBuyer: app.lender, registeredProgram: app.registered_program || app.program });
  if (!investorKey) return null;

  let rentalExit = false;
  try {
    const registry = require('../conditions/field-registry');
    const strategy = registry.normStrategy([app.program, app.loan_type, app.rehab_type].filter(Boolean).join(' '));
    rentalExit = strategy === 'fix_hold' || strategy === 'rental_dscr';
  } catch (_) { /* unknown exit → the rental line is simply not stated */ }

  // The address is rendered by the ONE canonical formatter, so the appraiser
  // reads it in the same mailing form every other surface prints — never a
  // hand-joined "Lakewood, NJ, 08701" with a comma where none belongs.
  const pa = app.property_address && typeof app.property_address === 'object' ? app.property_address : {};
  let addr = '';
  try { addr = require('../address').canonicalOneLine(pa) || ''; } catch (_) { addr = ''; }

  return { investorKey, loanNumber: app.ys_loan_number || null, propertyAddress: addr || null, rentalExit };
}

/**
 * NAN (AppraisalScope / CDG). `order` is the `amc_orders` row as it stands after
 * the ack, so it already carries the vendor's own order number.
 */
async function postForAmcOrder(db, order, opts = {}) {
  try {
    if (!order || !order.application_id || !order.id) return { posted: false, reason: 'no_order' };
    const ctx = await contextFor(db, order.application_id);
    if (!ctx) return { posted: false, reason: 'no_requirements' };
    const body = reqs.orderMessage(ctx);
    if (!body) return { posted: false, reason: 'no_requirements' };
    if (await alreadyPosted(db, 'amc', order.id)) return { posted: false, reason: 'already_posted' };

    const out = await require('../../amc/comments').postComment(db, order,
      { staffId: opts.staffId || null, staffName: 'PILOT', body }, opts.deps || {});
    if (!out || !out.ok) {
      console.warn(`[appraisal-reqs] could not post the requirements to NAN order ${order.id}:`,
        (out && (out.message || out.error)) || 'unknown');
      return { posted: false, reason: (out && out.error) || 'send_failed' };
    }
    return { posted: true, dryrun: !!out.dryrun, investor: ctx.investorKey };
  } catch (e) {
    console.warn('[appraisal-reqs] NAN post threw (non-fatal):', e && e.message);
    return { posted: false, reason: 'threw' };
  }
}

/** Class Valuation. `orderRowId` is the `class_orders` row id. */
async function postForClassOrder(db, orderRowId, appId, opts = {}) {
  try {
    if (!orderRowId || !appId) return { posted: false, reason: 'no_order' };
    const ctx = await contextFor(db, appId);
    if (!ctx) return { posted: false, reason: 'no_requirements' };
    const body = reqs.orderMessage(ctx);
    if (!body) return { posted: false, reason: 'no_requirements' };
    if (await alreadyPosted(db, 'class', orderRowId)) return { posted: false, reason: 'already_posted' };

    const out = await require('../../class/messages').note(orderRowId, body, { staffId: opts.staffId || null });
    if (!out || !out.ok) {
      console.warn(`[appraisal-reqs] could not post the requirements to Class order ${orderRowId}:`,
        (out && (out.message || out.error)) || 'unknown');
      return { posted: false, reason: (out && out.error) || 'send_failed' };
    }
    return { posted: true, dryrun: !!out.dryrun, investor: ctx.investorKey };
  } catch (e) {
    console.warn('[appraisal-reqs] Class post threw (non-fatal):', e && e.message);
    return { posted: false, reason: 'threw' };
  }
}

module.exports = { postForAmcOrder, postForClassOrder, contextFor, _internals: { alreadyPosted } };
