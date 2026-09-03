'use strict';

/**
 * terms-notify.js — the single chokepoint for CONFIRMING a registered product's
 * terms to the borrower (the "your loan terms are ready" email).
 *
 * AND THE ONE PLACE THAT REMEMBERS WHAT THE BORROWER WAS LAST TOLD (db/692;
 * owner-reported 2026-09-03: *"processor adjusted the experience from 4 to 3 and
 * borrower received an email that product has been registered … if you didn't
 * re-register the product, why are you getting an email … if it's fully
 * registered, then yes"*). Each caller has its own "did the economics change"
 * guard keyed on the previous REGISTRATION; this door keys on the previous
 * SEND, on the borrower-visible numbers only, so a re-register that moves
 * nothing the borrower can see — an experience edit on a program where it does
 * not change the leverage, a program-label change, a door with a weaker guard —
 * is never announced twice. See `borrowerSentTermsKey` / `decideSend`.
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

/**
 * THE BORROWER-VISIBLE NUMBERS, AS ONE STRING — what "the same terms" means at
 * this door (owner-reported 2026-09-03: an experience edit re-registered a file
 * and the borrower was told the product was registered although nothing they
 * could see had moved). Composed from the two keys the file already trusts —
 * `file-lock.finalNumbersKey` (loan amount, construction holdback, financed
 * reserve, origination dollars, note rate, term: the figures printed on the
 * sent term sheet) plus the two the borrower's own email leads with (cash to
 * close, initial advance). It deliberately reads NO INPUT — not the experience,
 * not the program name, not a product label — so a re-register that changes
 * only how the deal was priced, and none of what the borrower is told, is the
 * same terms. Pure.
 */
function borrowerSentTermsKey(quote, termMonths) {
  const q = quote || {};
  const s = q.sizing || {};
  const r = (v) => { const x = Number(v); return v == null || v === '' || !Number.isFinite(x) ? null : Math.round(x); };
  const fileLock = require('./file-lock');
  return JSON.stringify([
    fileLock.finalNumbersKey(q, termMonths),
    r(q.cashToClose),
    r(s.initialAdvance),
  ]);
}

/**
 * Send, or not? Pure. `force` is a person explicitly asking for a re-send.
 * @returns {{send:boolean, reason:'first'|'changed'|'forced'|'unchanged'}}
 */
function decideSend({ lastKey, key, force = false } = {}) {
  if (force) return { send: true, reason: 'forced' };
  if (lastKey == null) return { send: true, reason: 'first' };
  return lastKey === key ? { send: false, reason: 'unchanged' } : { send: true, reason: 'changed' };
}

async function sendBorrowerTerms(appId, { quote, total, termMonths, encompassOverride, force = false } = {}) {
  if (!appId || !quote) return { sent: false, reason: 'nothing_to_send' };
  const db0 = require('../db');

  // THE DOOR'S OWN MEMORY (db/692). Whatever the caller's guard decided, the
  // borrower is told about their terms only when a number they would notice has
  // changed since they were LAST TOLD — or when a person asks for a re-send.
  // Fails OPEN: an unreadable memory sends, as this door always did.
  const key = borrowerSentTermsKey(quote, termMonths);
  let lastKey = null;
  try {
    const r = await db0.query('SELECT terms_key FROM borrower_terms_sent WHERE application_id = $1', [appId]);
    lastKey = r.rows[0] ? r.rows[0].terms_key : null;
  } catch (_) { lastKey = null; }
  const verdict = decideSend({ lastKey, key, force: force === true });
  if (!verdict.send) {
    console.log(`[terms-notify] app ${appId}: borrower-visible terms unchanged since last sent — not re-announced`);
    return { sent: false, reason: verdict.reason, key };
  }
  const out = await sendBorrowerTermsNow(appId, { quote, total, termMonths, encompassOverride });
  // Remember what was sent — after the send, so a send that threw is not recorded
  // as told. Best-effort: a memory write that fails costs one possible repeat
  // later, never the email that just went.
  try {
    await db0.query(
      `INSERT INTO borrower_terms_sent (application_id, terms_key, last_reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (application_id) DO UPDATE
         SET terms_key = EXCLUDED.terms_key, sent_at = now(),
             send_count = borrower_terms_sent.send_count + 1, last_reason = EXCLUDED.last_reason`,
      [appId, key, verdict.reason]);
  } catch (e) { console.warn('[terms-notify] could not remember the sent terms:', (e && e.message) || e); }
  return { sent: true, reason: verdict.reason, key, ...(out || {}) };
}

/** The send itself — everything below is exactly the door as it was. */
async function sendBorrowerTermsNow(appId, { quote, total, termMonths, encompassOverride } = {}) {
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

module.exports = { sendBorrowerTerms, borrowerSentTermsKey, decideSend, _internals: { sendBorrowerTermsNow } };
