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

async function sendBorrowerTerms(appId, { quote, total, termMonths, encompassOverride } = {}) {
  if (!appId || !quote) return;
  // WO-E — the term-sheet issuance gate, at the CHOKEPOINT: withhold the "your
  // terms are ready" email while the file has OPEN blocking Encompass mismatches,
  // so EVERY issuance path (register, accept-counter, AND the super-admin
  // escalation approval) is covered at one point — fail-safe for any future
  // caller too. An explicit `encompassOverride` (an admin who already overrode at
  // the register route) bypasses it. Dormant until Encompass is live + a loan is
  // pulled; fails OPEN (never withholds) on any reconcile error.
  // Owner-directed 2026-07-26 (CORRECTION): the borrower's term sheet is NOT withheld
  // on an Encompass mismatch any more. Issuing terms stays open; the ONLY thing the
  // match gates is SENDING the DocuSign term-sheet package (staff.js esign/send).
  const db = require('../db');
  const notify = require('./notify');
  const email = require('./email');
  const fileAddress = require('./file-address');
  const { borrowerTermsEmail } = require('./product-registration');

  // Term-sheet options (owner-directed 2026-07-22) live on the file after
  // registration — load them so the confirm email shows the accrual + key dates
  // and includes the 3-month minimum-interest line ONLY when it's on. A legacy
  // file (registered before this change, min_interest_enabled NULL) falls back to
  // the program default (manual ON, Standard/Gold OFF).
  let termOptions = null;
  // Cash-out proceeds for a cash-out refinance (see below) — surfaced to the
  // borrower as "cash to you".
  let cashOut = null;
  // Brand the email to (and From) the assigned loan officer, matching the
  // register routes so recurring business stays with the officer's name.
  let officer = null;
  try {
    const t = await db.query(
      `SELECT loan_officer_id, accrual_type, min_interest_enabled, deferred_orig_pct,
              first_payment_date, maturity_date, co_borrower_pg_waived, estimated_cash_out
         FROM applications WHERE id=$1`, [appId]);
    const row = t.rows[0] || {};
    // Cash-out figure of record (mirrors payoff.cashOutOfRecord): a per-file typed
    // amount wins (>=0 is a real answer), else the structure's implied proceeds from
    // the quote. Only >0 on a cash-out refi — the borrower email surfaces it as
    // "cash to you" instead of a $0 cash-to-close (owner-directed 2026-08-04).
    const typedCashOut = row.estimated_cash_out != null ? Number(row.estimated_cash_out) : null;
    cashOut = (typedCashOut != null && typedCashOut >= 0)
      ? typedCashOut
      : ((quote && quote.refi) ? Number(quote.refi.cashOut) || 0 : null);
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

  /* Attach the term sheet to the borrower "terms are ready" email (owner-directed
     2026-08-12: "the borrower is only receiving an email, not the actual term sheet
     — attach the initial term sheet as a PDF").

     IT IS THE STUDIO'S SIX-PAGER, READ OFF THE FILE — never rendered here
     (owner-directed 2026-08-14: "any term sheet that it's using right now should be
     only this six-pager version"). Between 2026-08-12 and 2026-08-14 this built its
     own copy with the short server-side renderer, so the borrower was emailed a
     three-page document that matched nothing else on the file. That renderer is
     gone; this reads the stored sheet the Term Sheet Studio drew.

     AND ONLY THIS REGISTRATION'S SHEET. The studio attaches the PDF from the
     browser just AFTER the register call returns, so at this moment the newest
     stored sheet may still be the PREVIOUS registration's — and this email exists
     precisely because a headline number moved, so mailing that one would hand the
     borrower the figures we just changed. Anything older than the registration is
     therefore ignored and the email goes out without an attachment (exactly as it
     did before 2026-08-12) rather than with the wrong numbers. In practice a
     re-register from the studio lands the fresh sheet first on every path that has
     one; a path with no studio (an accepted counter, an auto-register from an
     offer) simply has nothing to attach, which is honest.

     Best-effort throughout: a hiccup never blocks the (already best-effort) email.
     `files` lists it in the body even if a provider drops the bytes. */
  let attachments = null;
  try {
    const r = await db.query(
      `SELECT d.storage_ref, d.filename
         FROM documents d
         JOIN product_registrations pr
           ON pr.application_id = d.application_id AND pr.is_current
        WHERE d.application_id = $1
          AND d.doc_kind = 'term_sheet'
          AND COALESCE(d.review_status,'') <> 'rejected'
          AND d.created_at >= pr.created_at
        ORDER BY d.is_current DESC NULLS LAST, d.created_at DESC
        LIMIT 1`, [appId]);
    if (r.rows[0] && r.rows[0].storage_ref) {
      const buf = await require('./storage').read(r.rows[0].storage_ref);
      if (buf && buf.length > 0 && buf.length <= 3 * 1024 * 1024) {
        attachments = [{ filename: 'Term Sheet.pdf', contentType: 'application/pdf', content: Buffer.from(buf).toString('base64') }];
      }
    }
  } catch (_) { /* the PDF attachment is best-effort — never break the email */ }

  await notify.notifyAppBorrowers(appId, {
    ...borrowerTermsEmail({ ctx, quote, total, termMonths, officer, termOptions, cashOut }),
    applicationId: appId,
    link: `/app/${appId}`,
    from: officer ? email.fromWithName(officer.name) : null,
    // Owner-directed 2026-08-18 ("every single email must have the unique
    // reply-to"): the per-file address wins so a borrower's reply threads into
    // the file and reaches the WHOLE team — the officer included — instead of
    // one person's inbox. The officer's inbox is only the fallback when no
    // inbound reply domain is configured.
    replyTo: fileAddress.fileReplyTo(appId) || (officer ? officer.email : null),
    ...(attachments ? { attachments, files: ['Term Sheet.pdf'] } : {}),
  });
}

module.exports = { sendBorrowerTerms };
