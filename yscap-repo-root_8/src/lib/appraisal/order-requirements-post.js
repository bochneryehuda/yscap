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
const LIKE_CORRECTION = `${reqs.CORRECTION_MARKER}%`;
async function alreadyPosted(db, vendor, orderRowId, likeMarker = LIKE_MARKER) {
  try {
    const r = vendor === 'class'
      ? await db.query('SELECT 1 FROM class_notes WHERE class_order_row = $1 AND content LIKE $2 LIMIT 1',
        [orderRowId, likeMarker])
      : await db.query('SELECT 1 FROM amc_order_comments WHERE order_id = $1 AND body LIKE $2 LIMIT 1',
        [orderRowId, likeMarker]);
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

/* ═══════════════════════════════════════════════════════════════════════════
   THE ONE-TIME CORRECTION (owner-directed 2026-09-01): "make a one-time run job
   for all the files that you sent this message in the past, everybody,
   correcting the instructions."

   Between 2026-08-16 and 2026-09-01 the requirements message told every
   appraiser that ALL comparable sales must be within 1 mile — which is not the
   rule (it is the anchor comp's rule) — and listed two ordinary report standards
   as requirements. Every order that still carries that message gets ONE
   correction, on the same vendor thread, from the same single definition
   (`reqs.correctionMessage`).

   SHAPE — the same as every other boot backfill in this repo:
     · BOUNDED per pass (`limit`, default 200 per vendor per boot — a backlog
       larger than that drains over the next boots, never in one unbounded
       sweep), and SELF-DRAINING: an order is selected only while it carries a
       superseded message and NO correction; posting the correction removes it
       from the next pass. Never a duplicate, because the correction row exists
       only once the vendor accepted it (NAN) or is written first and
       re-checked by marker (Class). A vendor FAILURE differs by vendor, and
       that is stated rather than implied: NAN inserts its comment only after
       the vendor accepts, so a failed NAN correction is re-selected next boot
       (a retry); Class writes its note row BEFORE calling the vendor and stamps
       `send_error` on failure, so a failed Class correction reads as posted to
       this job and is NOT retried here — it sits on the Class thread with its
       error visible, where the desk's ordinary resend handles it.
     · WHO: orders that are not cancelled/rejected and not un-placed
       drafts/errors — INCLUDING completed ones. The owner said "everybody",
       and a report already delivered under the wrong instruction is exactly
       the one whose appraiser should hear the rule was narrower than stated.
     · A file whose investor has since changed (no requirements any more) is
       counted and skipped: a correction that states a requirement the file no
       longer has would be a new error. It stays in the selection, so it is
       re-looked at (cheaply) each boot rather than silently dropped.
     · It never throws; the verdict says what was measured.
     · Kill switch: APPRAISAL_REQS_CORRECTION_DISABLED=1.
   ═══════════════════════════════════════════════════════════════════════════ */

// An order still "live enough" to hear a correction: anything placed and not
// withdrawn. Shared by both vendors' selections so the two can never disagree.
const CORRECTION_EXCLUDED_STATUSES = ['draft', 'error', 'cancelled', 'rejected'];
// The SQL pre-filter: every withdrawn message carried its rule 1, so selecting on
// that line keeps a current-wording message out of the pass entirely (self-draining
// means "nothing left to look at", not "looked at and skipped, every boot"). The
// JS `isSupersededMessage` remains the authority on each row.
const LIKE_SUPERSEDED = `%${reqs.SUPERSEDED_LINES[0]}%`;

async function supersededAmcOrders(db, limit) {
  return (await db.query(
    `SELECT o.*, c.body AS superseded_body
       FROM amc_order_comments c
       JOIN amc_orders o ON o.id = c.order_id
       JOIN applications a ON a.id = o.application_id AND a.deleted_at IS NULL
      WHERE c.direction = 'outbound'
        AND c.body LIKE $1
        AND c.body LIKE $5
        AND NOT (o.status = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM amc_order_comments x WHERE x.order_id = o.id AND x.body LIKE $3)
      ORDER BY c.created_at ASC
      LIMIT $4`, [LIKE_MARKER, CORRECTION_EXCLUDED_STATUSES, LIKE_CORRECTION, limit, LIKE_SUPERSEDED])).rows;
}

async function supersededClassOrders(db, limit) {
  return (await db.query(
    `SELECT o.id, o.application_id, o.status, c.content AS superseded_body
       FROM class_notes c
       JOIN class_orders o ON o.id = c.class_order_row
       JOIN applications a ON a.id = o.application_id AND a.deleted_at IS NULL
      WHERE c.direction = 'FromClient'
        AND c.content LIKE $1
        AND c.content LIKE $5
        AND NOT (o.status = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM class_notes x WHERE x.class_order_row = o.id AND x.content LIKE $3)
      ORDER BY c.created_at ASC
      LIMIT $4`, [LIKE_MARKER, CORRECTION_EXCLUDED_STATUSES, LIKE_CORRECTION, limit, LIKE_SUPERSEDED])).rows;
}

/**
 * One bounded pass over both vendors. Returns
 * { looked, corrected, currentWording, noRequirements, failed, byVendor:{amc,class} }.
 */
async function correctSupersededOnce(db, opts = {}) {
  const out = { looked: 0, corrected: 0, currentWording: 0, noRequirements: 0, failed: 0,
    byVendor: { amc: 0, class: 0 } };
  if (process.env.APPRAISAL_REQS_CORRECTION_DISABLED === '1') return { ...out, skipped: 'disabled' };
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 200));

  let amcRows = [], classRows = [];
  try { amcRows = await supersededAmcOrders(db, limit); } catch (e) {
    console.warn('[appraisal-reqs] correction: could not read NAN threads:', e && e.message);
  }
  try { classRows = await supersededClassOrders(db, limit); } catch (e) {
    console.warn('[appraisal-reqs] correction: could not read Class threads:', e && e.message);
  }

  for (const order of amcRows) {
    out.looked++;
    try {
      // The SQL selected on the marker; the JS confirms the WORDING is the withdrawn
      // one. A current-wording message (posted after this change) is not corrected.
      if (!reqs.isSupersededMessage(order.superseded_body)) { out.currentWording++; continue; }
      const ctx = await contextFor(db, order.application_id);
      const body = ctx ? reqs.correctionMessage(ctx) : null;
      if (!body) { out.noRequirements++; continue; }
      if (await alreadyPosted(db, 'amc', order.id, LIKE_CORRECTION)) continue;
      const res = await require('../../amc/comments').postComment(db, order,
        { staffId: opts.staffId || null, staffName: 'PILOT', body }, opts.deps || {});
      if (res && res.ok) { out.corrected++; out.byVendor.amc++; }
      else {
        out.failed++;
        console.warn(`[appraisal-reqs] correction not posted to NAN order ${order.id}:`,
          (res && (res.message || res.error)) || 'unknown');
      }
    } catch (e) { out.failed++; console.warn('[appraisal-reqs] NAN correction threw (non-fatal):', e && e.message); }
  }

  for (const order of classRows) {
    out.looked++;
    try {
      if (!reqs.isSupersededMessage(order.superseded_body)) { out.currentWording++; continue; }
      const ctx = await contextFor(db, order.application_id);
      const body = ctx ? reqs.correctionMessage(ctx) : null;
      if (!body) { out.noRequirements++; continue; }
      if (await alreadyPosted(db, 'class', order.id, LIKE_CORRECTION)) continue;
      const res = await require('../../class/messages').note(order.id, body, { staffId: opts.staffId || null });
      if (res && res.ok) { out.corrected++; out.byVendor.class++; }
      else {
        out.failed++;
        console.warn(`[appraisal-reqs] correction not posted to Class order ${order.id}:`,
          (res && (res.message || res.error)) || 'unknown');
      }
    } catch (e) { out.failed++; console.warn('[appraisal-reqs] Class correction threw (non-fatal):', e && e.message); }
  }

  if (out.corrected) console.log(`[appraisal-reqs] correction posted on ${out.corrected} order(s)`, JSON.stringify(out));
  return out;
}

/**
 * WHAT THE ORDER SCREEN SHOWS BEFORE AN ORDER IS PLACED (owner-directed
 * 2026-09-01: "if there is no investor on file yet, you don't know if you should
 * send this message or not before you order the appraisal. Please ask them to
 * select which capital provider is going to be for this file … but it's not
 * required, optional").
 *
 * Returns, for a file:
 *   investor        the key whose requirements would be posted, or null
 *   noteBuyer       the file's stored note buyer label (STAFF-ONLY surface)
 *   registeredProgram
 *   message         the exact text that would be posted, or null
 *   needsProvider   true when NOTHING decides the investor — no note buyer on
 *                   the file and no program that implies one — so the officer
 *                   should be asked (never required) to pick the provider first.
 * A file with a named provider that has no requirements answers
 * needsProvider:false with investor:null — there is a decision, and it is "nothing".
 */
async function summaryFor(db, appId) {
  const r = await db.query(
    `SELECT a.lender, a.program,
            (SELECT pr.program FROM product_registrations pr
              WHERE pr.application_id = a.id AND pr.is_current = true
              ORDER BY pr.created_at DESC LIMIT 1) AS registered_program
       FROM applications a WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const app = r.rows[0];
  if (!app) return null;
  const registeredProgram = app.registered_program || app.program || null;
  const ctx = await contextFor(db, appId);
  const noteBuyer = app.lender && String(app.lender).trim() ? app.lender : null;
  let impliedByProgram = null;
  try { impliedByProgram = require('../note-buyer-for-program').noteBuyerForProgram(registeredProgram) || null; }
  catch (_) { impliedByProgram = null; }
  return {
    investor: ctx ? ctx.investorKey : null,
    noteBuyer,
    registeredProgram,
    message: ctx ? reqs.orderMessage(ctx) : null,
    needsProvider: !ctx && !noteBuyer && !impliedByProgram,
  };
}

module.exports = { postForAmcOrder, postForClassOrder, correctSupersededOnce, contextFor, summaryFor,
  _internals: { alreadyPosted, CORRECTION_EXCLUDED_STATUSES } };
