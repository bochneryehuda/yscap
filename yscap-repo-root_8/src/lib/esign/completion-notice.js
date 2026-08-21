'use strict';

/**
 * "YOUR DOCUMENT IS SIGNED" — the execution notice, to the people who signed it, with the
 * executed copy attached.
 *
 * Owner-directed 2026-08-21: *"we need to add a notification for every document that is
 * completed. The [borrower] should also get a notification after it was signed. That is not
 * firing right now on all 3 packages that we currently have. They should receive a nice Pilot
 * email with the document attached once it's completed, which means: the ISKA once they sign ·
 * the Wire Form once they sign · the Term Sheet Package once everyone has signed."*
 *
 * WHAT WAS THERE BEFORE. `notifyTerminal` told OUR TEAM a package was fully signed and told the
 * borrower nothing at all — the person who actually signed it received DocuSign's own completion
 * email, or nothing once we stopped DocuSign emailing. So the one party whose record it is got
 * the least.
 *
 * THE TIMING RULE IS THE OWNER'S AND IT IS ALREADY GUARANTEED. This runs from the terminal claim
 * in `reconcileEnvelope` — the `${col} IS NULL RETURNING` update that exactly one caller wins —
 * so a redelivered webhook racing a poller tick cannot send twice; and a counter-signed package
 * reaches `completed` only after the lender's admin has signed, so "fully executed" is never said
 * while a signature is outstanding. That is precisely *"the Term Sheet Package once everyone has
 * signed"*, with no extra bookkeeping.
 *
 * IT ATTACHES WHAT THIS ENVELOPE PRODUCED, never "the newest signed copy on the file" — on a
 * re-issued package those are different documents, and attaching the wrong one to an execution
 * notice is worse than attaching none. Oversize is handled honestly: the email says the copy is
 * in the portal rather than pretending it is attached.
 *
 * BEST-EFFORT THROUGHOUT. A completed envelope may never be reversed or re-driven by an email
 * failing, so every step is caught and the function never throws.
 */

const dbDefault = require('../../db');
const mailDefault = require('../email/catalog');
const cfg = require('../../config');
const { fileReplyTo } = require('../file-address');

/* Which signed document belongs to which package, and what a BORROWER calls it. The doc kinds are
   `esign_envelope_docs.doc_kind` — the envelope↔document link, never a filename match. */
const PACKAGE = Object.freeze({
  term_sheet_package: { label: 'Term sheet package', kinds: ['term_sheet_signed'] },
  heter_iska: { label: 'Heter Iska', kinds: ['heter_iska_signed'] },
  draw_request: { label: 'Draw request & wire instructions', kinds: ['draw_request_signed'] },
  noo_affidavit: { label: 'Non-owner-occupied certification', kinds: ['noo_affidavit_signed'] },
});

/**
 * Tell every borrower signer on this envelope that it is executed, and attach the copy.
 * Returns { sent, skipped, reason? }. Never throws.
 */
async function notifyExecuted(envelopeRow, opts = {}) {
  const db = opts.db || dbDefault;
  const mail = opts.mail || mailDefault;
  const out = { sent: 0, skipped: 0 };
  try {
    if (!envelopeRow || envelopeRow.is_test || !envelopeRow.application_id) {
      return { ...out, reason: 'no_file' };
    }
    const spec = PACKAGE[envelopeRow.purpose];
    /* A PACKAGE WE HAVE NO WORDING FOR IS NOT ANNOUNCED. Sending "your documents are executed"
       about something this module cannot name would be worse than the silence it replaces —
       and adding a package here is one line. */
    if (!spec) return { ...out, reason: 'unknown_package' };

    const rows = (await db.query(
      `SELECT r.name, r.email, b.first_name AS b_first,
              a.ys_loan_number,
              COALESCE(a.property_address->>'oneLine',
                       a.property_address->>'formatted_address',
                       NULLIF(concat_ws(', ',
                                        COALESCE(a.property_address->>'line1', a.property_address->>'street'),
                                        a.property_address->>'city',
                                        a.property_address->>'state', a.property_address->>'zip'), '')) AS property_label,
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
          AND r.email IS NOT NULL`, [envelopeRow.id])).rows;
    if (!rows.length) return { ...out, reason: 'no_borrower_signers' };

    /* THE EXECUTED COPY THIS ENVELOPE PRODUCED. `buildAttachments` applies the mail providers'
       own size ceiling and reports what it withheld, so the email can tell the truth either way
       rather than promising an attachment that is not there. */
    let attachments = [];
    try {
      const d = (await db.query(
        `SELECT doc.filename, doc.content_type, doc.storage_ref, doc.size_bytes
           FROM esign_envelope_docs ed
           JOIN documents doc ON doc.id = ed.completed_document_id
          WHERE ed.envelope_row_id = $1 AND ed.doc_kind = ANY($2::text[])
          ORDER BY doc.created_at DESC LIMIT 1`, [envelopeRow.id, spec.kinds])).rows[0];
      if (d && d.storage_ref) {
        const built = await require('../closing-prep').buildAttachments([d]);
        attachments = built.attachments || [];
      }
    } catch (e) {
      console.warn('[esign-completion] could not attach the executed copy:', e && e.message);
    }

    const completedOn = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      try {
        const officer = r.officer_name ? {
          name: r.officer_name, title: r.officer_title, phone: r.officer_phone,
          email: r.officer_email, nmls: r.officer_nmls,
        } : null;
        const res = await mail.send('esignCompleted', r.email, {
          firstName: r.b_first || (r.name || '').split(' ')[0] || '',
          packageLabel: spec.label,
          propertyLabel: r.property_label || '',
          loanNumber: r.ys_loan_number || '',
          completedOn,
          portalUrl: `${cfg.appUrl || ''}${cfg.portalPath}/#/app/${envelopeRow.application_id}`,
          officer,
          attached: attachments.length > 0,
        }, {
          replyTo: fileReplyTo(envelopeRow.application_id) || undefined,
          applicationId: envelopeRow.application_id,
          attachments: attachments.length ? attachments : undefined,
        });
        if (res && (res.ok || res.skipped)) out.sent++; else out.skipped++;
      } catch (e) {
        out.skipped++;
        console.warn('[esign-completion] send failed for', r.email, '::', e && e.message);
      }
    }
    return out;
  } catch (e) {
    return { ...out, reason: (e && e.message) ? String(e.message).slice(0, 120) : 'error' };
  }
}

module.exports = { notifyExecuted, PACKAGE };
