/**
 * esign/notify-signers.js — PILOT's OWN "your documents are ready to sign" email.
 *
 * Owner-directed (2026-07-20): when a package is sent, PILOT emails each borrower
 * signer its OWN branded invitation whose button (`signUrl`) takes them STRAIGHT
 * into the DocuSign signing session (no portal stop, no "Sign now" click) and brings
 * them back INSIDE their loan file afterward, already logged in. This rides ALONGSIDE
 * DocuSign's own email (the recipients stay hybrid `SIGN_AT_DOCUSIGN`) — "both".
 *
 * Best-effort: a failed email must NEVER break the send. Borrower-safe by
 * construction — the email names only the loan #, property, and package (never a
 * capital-partner / note-buyer name), and the catalog template is the borrower
 * audience (light PILOT letterhead).
 */
const dbDefault = require('../../db');
const magic = require('./magic-link');
const mailDefault = require('../email/catalog');
const { fileReplyTo } = require('../file-address');

// Borrower-facing package names (never the internal PACKAGES.label).
const PACKAGE_LABEL = {
  term_sheet_package: 'Term sheet, application & disclosure',
  heter_iska: 'Heter Iska',
};

/**
 * Email every borrower/co-borrower on an envelope who still needs to sign a PILOT
 * magic link. `envelopeRowId` is the esign_envelopes.id. Returns { sent, skipped }.
 * Never throws.
 */
async function notifyReadyToSign(envelopeRowId, opts = {}) {
  const db = opts.db || dbDefault;
  const mail = opts.mail || mailDefault;   // injectable for tests
  const out = { sent: 0, skipped: 0, recipients: [] };
  let rows;
  try {
    rows = (await db.query(
      `SELECT r.recipient_id_ds, r.borrower_id, r.name, r.email, r.role,
              b.first_name AS b_first,
              e.application_id, e.purpose, e.status, e.envelope_id,
              a.ys_loan_number, a.rehab_budget,
              COALESCE(a.property_address->>'oneLine',
                       NULLIF(concat_ws(', ', a.property_address->>'line1', a.property_address->>'city',
                                        a.property_address->>'state', a.property_address->>'zip'), ''),
                       CASE WHEN jsonb_typeof(a.property_address) = 'string'
                            THEN a.property_address #>> '{}' END) AS property_label,
              lo.full_name AS officer_name, lo.title AS officer_title, lo.phone AS officer_phone,
              lo.email AS officer_email, lo.nmls AS officer_nmls
         FROM esign_recipients r
         JOIN esign_envelopes e ON e.id = r.envelope_row_id
         LEFT JOIN applications a ON a.id = e.application_id
         LEFT JOIN borrowers b ON b.id = r.borrower_id
         LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
        WHERE r.envelope_row_id = $1
          AND r.role IN ('borrower', 'co_borrower')
          AND r.borrower_id IS NOT NULL
          AND r.email IS NOT NULL
          AND r.signed_at IS NULL AND r.declined_at IS NULL`, [envelopeRowId])).rows;
  } catch (e) {
    console.warn('[esign-notify-signers] load failed:', db.describeError ? db.describeError(e) : e.message);
    return out;
  }
  for (const r of rows) {
    // Only email once the envelope is actually out for signing.
    if (!r.envelope_id || !['sent', 'delivered'].includes(r.status)) { out.skipped++; continue; }
    try {
      const token = magic.mintSigningToken({
        envelopeRowId: String(envelopeRowId),
        borrowerId: String(r.borrower_id),
        recipientIdDs: String(r.recipient_id_ds),
      });
      const signUrl = magic.signingUrl(token);
      const officer = r.officer_name ? {
        name: r.officer_name, title: r.officer_title, phone: r.officer_phone,
        email: r.officer_email, nmls: r.officer_nmls,
      } : null;
      // A DRAW wire-instructions package gets PILOT's own DRAW-branded email (with the direct
      // signing link) instead of the generic ready-to-sign one, and is recorded to the file's
      // DRAW email section (msg_type 'draw_request') carrying the per-file reply-to that monitors
      // replies. The magic signUrl authenticates AS this borrower — sent to the borrower only.
      const isDrawWire = r.purpose === 'draw_request';
      const res = isDrawWire
        ? await mail.send('drawWireReadyToSign', r.email, {
            firstName: r.b_first || (r.name || '').split(' ')[0] || '',
            propertyLabel: r.property_label || '',
            loanNumber: r.ys_loan_number || '',
            budgetCents: r.rehab_budget != null ? Math.round(Number(r.rehab_budget) * 100) : 0,
            signUrl, officer,
          }, { replyTo: fileReplyTo(r.application_id) || undefined, applicationId: r.application_id, type: 'draw_request' })
        : await mail.send('esignReadyToSign', r.email, {
            firstName: r.b_first || (r.name || '').split(' ')[0] || '',
            propertyLabel: r.property_label || '',
            loanNumber: r.ys_loan_number || '',
            packageLabel: PACKAGE_LABEL[r.purpose] || 'loan documents',
            signUrl, officer,
          }, { replyTo: fileReplyTo(r.application_id) || undefined });
      // ok = actually sent; skipped = provider intentionally no-op'd (EMAIL_PROVIDER=none
      // in dev) — both mean the pipeline ran; a hard failure (ok:false, not skipped) is a skip.
      if (res && (res.ok || res.skipped)) { out.sent++; out.recipients.push(r.email); }
      else out.skipped++;
    } catch (e) {
      out.skipped++;
      console.warn('[esign-notify-signers] send failed for', r.email, '::', e.message);
    }
  }
  return out;
}

module.exports = { notifyReadyToSign, PACKAGE_LABEL };
