/**
 * esign/notify-signers.js — PILOT's OWN "your documents are ready to sign" email.
 *
 * Owner-directed (2026-07-20): when a package is sent, PILOT emails each signer its OWN
 * branded invitation whose button (`signUrl`) takes them STRAIGHT into the DocuSign signing
 * session (no portal stop, no "Sign now" click) and brings a BORROWER back INSIDE their loan
 * file afterward, already logged in.
 *
 * IT IS NOW THE ONLY INVITATION THERE IS (owner-directed 2026-08-21). Recipients were hybrid
 * (`SIGN_AT_DOCUSIGN`), so DocuSign emailed everybody as well — and that second email led to a
 * page a captive recipient cannot sign on: *"The only link that works is the link that is coming
 * directly from Pilot."* The property is gone, DocuSign sends nothing, and this email covers
 * EVERY signer — borrowers and our own staff signers alike, the latter of whom previously
 * received DocuSign's email and nothing from us at all.
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
  noo_affidavit: 'Non-owner-occupied certification',
};

/**
 * Email every borrower/co-borrower on an envelope who still needs to sign a PILOT
 * magic link. `envelopeRowId` is the esign_envelopes.id. Returns { sent, skipped }.
 * Never throws.
 *
 * `opts.onlyRecipientIdDs` (a DocuSign recipientId like "1") narrows the send to ONE
 * recipient — used after a recipient-email CORRECTION so only the corrected signer is
 * re-nudged with PILOT's own branded link, never their co-signer.
 */
async function notifyReadyToSign(envelopeRowId, opts = {}) {
  const db = opts.db || dbDefault;
  const mail = opts.mail || mailDefault;   // injectable for tests
  const onlyRid = opts.onlyRecipientIdDs != null ? String(opts.onlyRecipientIdDs) : null;
  const out = { sent: 0, skipped: 0, recipients: [] };
  let rows;
  try {
    rows = (await db.query(
      `SELECT r.recipient_id_ds, r.borrower_id, r.name, r.email, r.role,
              b.first_name AS b_first,
              -- The FILE's borrower, for our own signers: a staff recipient has no borrower_id,
              -- so the join above answers nothing and their email would name nobody.
              fb.full_name AS file_borrower_name,
              r.status AS recipient_status, r.routing_order, r.invited_at,
              /* IS IT ACTUALLY THEIR TURN? Status alone cannot answer this at SEND time.
                 orchestrate.js inserts every recipient as 'created' and NOTHING writes
                 recipient status until a webhook arrives (applyRecipients is called from
                 exactly one place), so at the moment of the send the borrower on routing
                 order 1 and the counter-signer on order 2 look identical. Routing order
                 does answer it, and it is the same thing DocuSign itself is deciding:
                 nobody earlier is still to sign. */
              NOT EXISTS (SELECT 1 FROM esign_recipients e2
                           WHERE e2.envelope_row_id = r.envelope_row_id
                             AND e2.routing_order < r.routing_order
                             AND e2.signed_at IS NULL AND e2.declined_at IS NULL) AS turn_now,
              e.application_id, e.purpose, e.status, e.envelope_id,
              a.ys_loan_number, a.rehab_budget,
              COALESCE(a.property_address->>'oneLine',
                       a.property_address->>'formatted_address',
                       a.property_address->>'formatted',
                       NULLIF(concat_ws(', ',
                                        COALESCE(a.property_address->>'line1', a.property_address->>'street', a.property_address->>'address'),
                                        a.property_address->>'city',
                                        a.property_address->>'state', a.property_address->>'zip'), ''),
                       CASE WHEN jsonb_typeof(a.property_address) = 'string'
                            THEN a.property_address #>> '{}' END) AS property_label,
              lo.full_name AS officer_name, lo.title AS officer_title, lo.phone AS officer_phone,
              lo.email AS officer_email, lo.nmls AS officer_nmls
         FROM esign_recipients r
         JOIN esign_envelopes e ON e.id = r.envelope_row_id
         LEFT JOIN applications a ON a.id = e.application_id
         LEFT JOIN borrowers b ON b.id = r.borrower_id
         LEFT JOIN borrowers fb ON fb.id = a.borrower_id
         LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
        WHERE r.envelope_row_id = $1
          AND r.role IN ('borrower', 'co_borrower', 'loan_officer', 'admin')
          AND r.email IS NOT NULL
          AND r.signed_at IS NULL AND r.declined_at IS NULL`, [envelopeRowId])).rows;
  } catch (e) {
    console.warn('[esign-notify-signers] load failed:', db.describeError ? db.describeError(e) : e.message);
    return out;
  }
  for (const r of rows) {
    // A correction re-nudges ONLY the recipient whose email we just changed.
    if (onlyRid && String(r.recipient_id_ds) !== onlyRid) { out.skipped++; continue; }
    // Only email once the envelope is actually out for signing.
    if (!r.envelope_id || !['sent', 'delivered'].includes(r.status)) { out.skipped++; continue; }
    /* NEVER THE SAME INVITATION TWICE. Both the send path and the webhook may legitimately
       reach a recipient first, so the send-once guard is the RECORD of having invited them,
       not the caller. Only an explicit `force` re-sends — today that is a corrected email
       address, where re-inviting is the entire point. */
    if (r.invited_at && !opts.force) { out.skipped++; continue; }
    /* AND ONLY WHEN IT IS ACTUALLY THEIR TURN. A counter-signer on routing order 2 sits at
       `created` until every earlier signer has finished; DocuSign will not let them sign before
       then, so "your signature is needed" would be false and the link would fail.
       THIS USED TO TEST recipient_status ALONE, and that is the bug the owner reported on
       2026-08-25: the send path writes 'created' for EVERYONE and nothing moves it before
       notifyReadyToSign runs, so the borrower was skipped on every package we sent — while the
       webhook's recovery re-invited staff only. Since the same 2026-08-21 change stopped
       DocuSign emailing captive recipients, the borrower received nothing at all. Ask the
       ROUTING ORDER, which is knowable at send time; a sent/delivered status still counts on
       its own so a later turn granted by the webhook needs no re-derivation. */
    const theirTurn = ['sent', 'delivered'].includes(String(r.recipient_status || '')) || r.turn_now === true;
    if (!theirTurn) { out.skipped++; continue; }
    try {
      /* WHO IS THIS SIGNER? A borrower row carries `borrower_id`; one of OUR OWN carries none and
         is matched to the staff roster by the email the envelope was addressed to. An ACTIVE
         staff row is required — a departed officer's address must not receive a signing link —
         and a staff recipient we cannot place is SKIPPED rather than emailed an unauthenticated
         link, because the token is a bearer for signing that envelope. */
      let staffId = null;
      if (!r.borrower_id) {
        const su = (await db.query(
          `SELECT id, full_name FROM staff_users WHERE lower(email)=lower($1) AND is_active = true LIMIT 1`,
          [r.email])).rows[0];
        if (!su) { out.skipped++; continue; }
        staffId = su.id;
      }
      const token = magic.mintSigningToken({
        envelopeRowId: String(envelopeRowId),
        borrowerId: r.borrower_id ? String(r.borrower_id) : null,
        staffId: staffId ? String(staffId) : null,
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
      //
      // THIS IS THE ONE DRAW EMAIL THE COORDINATOR/OFFICER LOOP-IN DELIBERATELY SKIPS, and it
      // must stay that way: the body carries a magic link that signs the borrower IN AS THEM
      // and drops them straight into the DocuSign ceremony, so BCC'ing staff would hand a
      // staffer the ability to sign the wire form in the borrower's legal identity. The
      // coordinator is looped into this exact step the correct way instead — as a DocuSign CC
      // VIEWER on the envelope itself (orchestrate.loadCcViewers, owner-directed 2026-07-28),
      // which is what gives them the sent/viewed/signed notifications and the executed copy.
      const isDrawWire = r.purpose === 'draw_request';
      /* OUR OWN SIGNER GETS OUR OWN EMAIL — never the borrower letter, which greets them as the
         borrower and reassures them about documents they did not ask for. */
      const res = staffId
        ? await mail.send('esignStaffReadyToSign', r.email, {
            firstName: (r.name || '').split(' ')[0] || '',
            role: r.role === 'admin' ? 'lender signatory' : 'loan officer',
            packageLabel: PACKAGE_LABEL[r.purpose] || 'loan documents',
            borrowerName: r.file_borrower_name || null,
            propertyLabel: r.property_label || '',
            loanNumber: r.ys_loan_number || '',
            signUrl,
          }, { replyTo: fileReplyTo(r.application_id) || undefined, applicationId: r.application_id })
        : isDrawWire
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
      if (res && (res.ok || res.skipped)) {
        out.sent++; out.recipients.push(r.email);
        /* THE RECORD, and the reason a column exists at all: "was this signer ever invited,
           and when" had no answer anywhere. The borrower's signing email is the one
           catalog.send that passes no applicationId — deliberately, because its body carries
           a magic link that signs the holder in AS THE BORROWER, which must not sit in a
           staff-readable email log — so the Email Center cannot answer it either.
           COALESCE keeps the FIRST invitation time (the audit answer) while invite_count
           records re-nudges. Best-effort: the email has already gone, and failing to record
           it must never look like a failure to send it. */
        try {
          await db.query(
            `UPDATE esign_recipients
                SET invited_at = COALESCE(invited_at, now()), invite_count = invite_count + 1,
                    updated_at = now()
              WHERE envelope_row_id = $1 AND recipient_id_ds = $2`,
            [envelopeRowId, String(r.recipient_id_ds)]);
        } catch (e) {
          console.warn('[esign-notify-signers] invited_at stamp failed for', r.email, '::', e.message);
        }
      }
      else out.skipped++;
    } catch (e) {
      out.skipped++;
      console.warn('[esign-notify-signers] send failed for', r.email, '::', e.message);
    }
  }
  return out;
}

module.exports = { notifyReadyToSign, PACKAGE_LABEL };
