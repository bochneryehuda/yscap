'use strict';

/**
 * terms-notify.js — the single chokepoint for CONFIRMING a registered product's
 * terms to the borrower (the "your loan terms are ready" email).
 *
 * It is called from exactly the places a borrower is allowed to see confirmed
 * terms (owner-directed 2026-07-21):
 *   • a CLEAN, auto-eligible Standard/Gold registration (confirms immediately), and
 *   • a super-admin APPROVING an escalated registration — every Manual Program,
 *     and any Standard/Gold registration the engine returned as MANUAL (below the
 *     $100,000 minimum, over the program maximum, or any other manual-review
 *     reason). Those confirm ONLY after the escalation is approved.
 *
 * It is NEVER called while a registration is pending super-admin approval, so a
 * borrower can never receive confirmed terms before sign-off. Borrower-safe by
 * construction: borrowerTermsEmail uses only the program label + the borrower's
 * own deal numbers, and the notify chokepoint scrubs note-buyer names again.
 */

async function sendBorrowerTerms(appId, { quote, total, termMonths } = {}) {
  if (!appId || !quote) return;
  const db = require('../db');
  const notify = require('./notify');
  const email = require('./email');
  const { borrowerTermsEmail } = require('./product-registration');

  // Term-sheet options (owner-directed 2026-07-22) live on the file after
  // registration — load them so the confirm email shows the accrual + key dates
  // and includes the 3-month minimum-interest line ONLY when it's on. A legacy
  // file (registered before this change, min_interest_enabled NULL) falls back to
  // the program default (manual ON, Standard/Gold OFF).
  let termOptions = null;
  // Brand the email to (and From) the assigned loan officer, matching the
  // register routes so recurring business stays with the officer's name.
  let officer = null;
  try {
    const t = await db.query(
      `SELECT loan_officer_id, accrual_type, min_interest_enabled, deferred_orig_pct,
              first_payment_date, maturity_date, co_borrower_pg_waived
         FROM applications WHERE id=$1`, [appId]);
    const row = t.rows[0] || {};
    termOptions = {
      accrualType: row.accrual_type || 'non_dutch',
      minInterestEnabled: row.min_interest_enabled != null
        ? row.min_interest_enabled === true
        : (quote && quote.program === 'manual'),
      deferredOrigPct: row.deferred_orig_pct != null ? Number(row.deferred_orig_pct) : 0,
      firstPayment: row.first_payment_date || null,
      maturity: row.maturity_date || null,
      coBorrowerPgWaived: !!row.co_borrower_pg_waived,
    };
    const loId = row.loan_officer_id;
    if (loId) {
      const o = await db.query(
        `SELECT full_name, title, email, phone, cell, nmls FROM staff_users WHERE id=$1`, [loId]);
      if (o.rows[0]) {
        officer = {
          name: o.rows[0].full_name, title: o.rows[0].title, email: o.rows[0].email,
          phone: o.rows[0].cell || o.rows[0].phone, nmls: o.rows[0].nmls,
        };
      }
    }
  } catch (_) { /* officer branding is best-effort */ }

  let ctx = null;
  try { ctx = await notify.fileContext(appId); } catch (_) {}

  await notify.notifyAppBorrowers(appId, {
    ...borrowerTermsEmail({ ctx, quote, total, termMonths, officer, termOptions }),
    applicationId: appId,
    link: `/app/${appId}`,
    from: officer ? email.fromWithName(officer.name) : null,
    replyTo: officer ? officer.email : null,
  });
}

module.exports = { sendBorrowerTerms };
