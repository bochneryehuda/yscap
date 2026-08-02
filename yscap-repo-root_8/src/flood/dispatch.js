'use strict';
/**
 * src/flood/dispatch.js — chooses WHICH flood provider the "Order flood
 * certificate" button uses, so the two implementations stay fully separate.
 *
 * FLOOD_ORDER_PROVIDER (cfg.floodProvider):
 *   'xactus'   (default) → src/xactus/flood-desk.js  (the cheaper, active provider)
 *   'encompass'          → src/encompass/flood-desk.js (kept, PARKED — flip back
 *                          here once the Encompass flood service id is sorted)
 *
 * Both providers write to the ONE flood-orders ledger (encompass_flood_orders,
 * historically named for its first provider; db/394 added the `provider` column),
 * so `latestFloodOrder` — what the button reads for its state — is provider-
 * agnostic and shows the newest order whoever placed it.
 */
const cfg = require('../config');
const db = require('../db');

function providerName() {
  return /^encompass$/i.test(String(cfg.floodProvider || 'xactus')) ? 'encompass' : 'xactus';
}
function activeDesk() {
  return providerName() === 'encompass' ? require('../encompass/flood-desk') : require('../xactus/flood-desk');
}
function activeClient() {
  return providerName() === 'encompass' ? require('../encompass/flood-order') : require('../xactus/flood');
}

// Whether the active provider is turned on (drives the button's visibility).
function enabled() {
  try { return !!activeClient().enabled(); } catch (_) { return false; }
}

// The newest COMPLETED flood order on this file, WHICHEVER provider placed it —
// the proof a determination has already been bought for this property. Deliberately
// does NOT swallow: a caller about to spend money must be able to tell "no order"
// from "the database did not answer".
async function latestCompletedOrder(appId) {
  const r = await db.query(
    `SELECT * FROM encompass_flood_orders
      WHERE application_id=$1 AND status='completed'
      ORDER BY completed_at DESC NULLS LAST, ordered_at DESC LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

// Place an order through the active provider. Same shaped result for both.
//
// ALREADY BOUGHT — the ONE billing guard, here at the single door every order goes
// through, so it protects BOTH providers (owner-directed 2026-08-02: "after
// successful on each file you should not be able to do it again unless if it
// failed"). A flood order is billable and a Life-of-Loan determination is monitored
// for the life of the loan, so a second one is pure waste. A FAILED or dry-run order
// does not block. `force` is the deliberate way through (a corrected property
// address genuinely needs a fresh determination) and is admin-gated by the route.
async function orderFlood(args) {
  const { appId, force } = args || {};
  if (!force) {
    let done;
    try {
      done = await latestCompletedOrder(appId);
    } catch (e) {
      // FAIL CLOSED. If we cannot prove this file has NOT already been charged, we
      // do not charge it (the opposite of the fail-open circuit breaker would be a
      // silent double bill).
      return { ok: false, error: 'check_failed', message: 'PILOT couldn’t confirm whether this file already has a flood determination, so it did not order one. Try again in a moment.' };
    }
    if (done) {
      // Only claim the certificate is filed when it actually is — this refusal used
      // to assert it unconditionally, which is the very untruth this work removed
      // from the card.
      let filed = false;
      try {
        const desk = activeDesk();
        filed = typeof desk.certificateOnFile === 'function' ? await desk.certificateOnFile(done) : false;
      } catch (_) { filed = false; }
      return {
        ok: false, error: 'already_completed', order: done,
        message: filed
          ? 'A flood certificate has already come back for this file, so PILOT did not order another one (each order is billable). It’s filed on this condition.'
          : 'A flood determination has already come back for this file, so PILOT did not order another one (each order is billable). Use “Get the certificate PDF” to pull down the certificate we already paid for.',
      };
    }
  }
  return activeDesk().orderFlood(args);
}

// The newest flood order for a file (any provider) — drives the button's state.
async function latestFloodOrder(appId) {
  try {
    const r = await db.query(`SELECT * FROM encompass_flood_orders WHERE application_id=$1 ORDER BY ordered_at DESC LIMIT 1`, [appId]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

// Retrieve the certificate for a determination ALREADY paid for (never a new
// order). Only the Xactus desk implements it; the parked Encompass desk does not,
// so it degrades to a plain "not available" instead of throwing.
async function fetchCertificate(args) {
  const desk = activeDesk();
  if (typeof desk.fetchCertificate !== 'function') {
    return { ok: false, error: 'unsupported', message: 'This flood provider can’t re-fetch a certificate — upload it manually instead.' };
  }
  return desk.fetchCertificate(args);
}

// Is the file's completed determination's certificate actually filed as a live
// document? Drives the truthful "certificate is / isn't attached" wording.
// null = we genuinely can't tell (no completed order, a provider whose desk can't
// answer, or a DB error). Callers must render null as UNKNOWN — never as "filed",
// which is the exact untruth this whole change removed.
async function certificateFiled(appId) {
  try {
    const done = await latestCompletedOrder(appId);   // provider-agnostic
    if (!done) return null;
    const desk = activeDesk();
    if (typeof desk.certificateOnFile !== 'function') return null;
    return await desk.certificateOnFile(done);
  } catch (_) { return null; }
}

// Does this file already have a completed determination? Drives BOTH the "we won't
// order again" wording and whether an admin is offered the deliberate re-order —
// the card must offer it in the errored state too, or a failed forced order is a
// dead end (the newest row is then an error, so the done branch never renders).
async function hasCompletedOrder(appId) {
  try { return !!(await latestCompletedOrder(appId)); } catch (_) { return false; }
}

// Whether the file has what the ACTIVE provider needs before it can order.
//   xactus    → a usable property address (the determination is on the property)
//   encompass → a loan number (the link to the Encompass loan)
async function readiness(appId) {
  if (providerName() === 'xactus') {
    try { return await require('../xactus/flood-desk').readiness(appId); }
    catch (_) { return { ready: false, needs: 'error' }; }
  }
  // Encompass: needs a loan number (the parked desk has no readiness() of its own).
  try {
    const r = await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [appId]);
    const hasLoan = !!(r.rows[0] && r.rows[0].ys_loan_number && String(r.rows[0].ys_loan_number).trim());
    return { ready: hasLoan, needs: hasLoan ? null : 'loan_number', hasLoanNumber: hasLoan };
  } catch (_) { return { ready: false, needs: 'error' }; }
}

module.exports = { providerName, activeDesk, activeClient, enabled, orderFlood, latestFloodOrder, readiness, fetchCertificate, certificateFiled, latestCompletedOrder, hasCompletedOrder };
