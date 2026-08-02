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

// Place an order through the active provider. Same shaped result for both.
async function orderFlood(args) {
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
async function certificateFiled(appId) {
  try {
    const desk = activeDesk();
    if (typeof desk.latestCompletedOrder !== 'function' || typeof desk.certificateOnFile !== 'function') return null;
    const done = await desk.latestCompletedOrder(appId);
    if (!done) return null;
    return await desk.certificateOnFile(done);
  } catch (_) { return null; }
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

module.exports = { providerName, activeDesk, activeClient, enabled, orderFlood, latestFloodOrder, readiness, fetchCertificate, certificateFiled };
