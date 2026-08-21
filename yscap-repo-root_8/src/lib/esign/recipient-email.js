/**
 * esign/recipient-email.js — change a signer's email on an ALREADY-SENT DocuSign
 * package and re-send the invitation to the new address (owner-directed).
 *
 * "Any DocuSign package that is going out, we need the ability to change the email
 *  address once it was sent out already — re-send the invitation to a different email
 *  address. If we had a wrong email address … we should be able to manually change it,
 *  but WARN that we should also change the email on the file if this is the correct one."
 *
 * The correction uses DocuSign's own "Correct" flow (docusign.updateRecipients with
 * resend_envelope=true), so it works for EVERY package — the term-sheet package, the
 * Heter Iska, the draw/wire-request form, and the NOO certification — because they are
 * all just esign_envelopes rows with recipients in esign_recipients. Nothing here
 * touches the borrower record on the file: that stays the ONE shared borrower writer
 * (PATCH /api/staff/borrowers/:id). We only report whether the new address differs from
 * the file's email so the caller can raise the "also update it on the file" warning.
 *
 * Pure decision (planRecipientEmailChange) + a thin IO wrapper (changeRecipientEmail),
 * with db/docusign/notify injected so the plan is unit-tested with no network or DB.
 * The IO dependencies are required LAZILY (like esign/term-sheet-stamp.js) so the pure
 * rule + its wording load with no database in reach.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// esign_envelopes.status values that are terminal — a package here can't be re-addressed.
const TERMINAL_ENV = new Set(['completed', 'declined', 'voided']);
// Only these recipient ROLES may be re-addressed. A borrower/co-borrower email is the
// one that's typo'd; the lender's counter-signer (role 'admin' / is_countersigner) and
// the loan-officer signer carry SYSTEM-sourced emails (config / the staff record), and
// re-addressing the counter-signer would let a file-scoped staffer redirect the binding
// lender signature to an address they control. The UI hides those; the SERVER enforces
// it (the UI is never the security boundary).
const READDRESSABLE_ROLES = new Set(['borrower', 'co_borrower']);

const recipientSigned = (r) => !!(r && (r.signed_at || r.status === 'signed' || r.status === 'completed'));
const recipientDeclined = (r) => !!(r && (r.declined_at || r.status === 'declined'));

/** A small classified error carrying a safe, exposable message + HTTP status. */
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  e.retryable = false;
  return e;
}

/**
 * PURE — decide whether/how to correct a recipient's email. No IO. Returns either
 * `{ ok:false, status, error }` (a refusal to surface verbatim) or `{ ok:true, … }`
 * with the exact DocuSign signer-update payload and the derived new email/name.
 */
function planRecipientEmailChange({ env, recipient, email, name, sendEnabled }) {
  const newEmail = String(email == null ? '' : email).trim();
  if (!EMAIL_RE.test(newEmail)) return { ok: false, status: 400, error: 'Enter a valid email address.' };
  if (!env) return { ok: false, status: 404, error: 'That signing package is no longer on the file — refresh and try again.' };
  if (!env.envelope_id) return { ok: false, status: 409, error: 'This package hasn’t been sent yet — there’s no invitation to re-address.' };
  if (TERMINAL_ENV.has(String(env.status || ''))) {
    return { ok: false, status: 409, error: `This package is already ${env.status} — its email can’t be changed. Void and re-issue it to send to a different address.` };
  }
  if (!sendEnabled) return { ok: false, status: 409, error: 'Sending is paused right now. Turn sending back on before re-sending the invitation.' };
  if (!recipient) return { ok: false, status: 404, error: 'That signer isn’t on this package — refresh and try again.' };
  // AUTHORIZATION: only a borrower / co-borrower invitation may be re-addressed (see
  // READDRESSABLE_ROLES). Rejecting the counter-signer here is the real control — the
  // route is gated only by file visibility, so without this a file-scoped staffer could
  // redirect the lender's binding counter-signature.
  if (recipient.is_countersigner || !READDRESSABLE_ROLES.has(recipient.role)) {
    return { ok: false, status: 403, error: 'Only a borrower or co-borrower’s email can be changed here. For a loan officer or the counter-signer, fix their email on their own record and re-issue the package.' };
  }
  if (recipientSigned(recipient)) return { ok: false, status: 409, error: `${recipient.name || 'This signer'} has already signed — their email can’t be changed.` };
  if (recipientDeclined(recipient)) return { ok: false, status: 409, error: `${recipient.name || 'This signer'} declined — void and re-issue the package to send to a different address.` };

  const newName = (String(name == null ? '' : name).trim()) || String(recipient.name || '').trim();
  const curEmail = String(recipient.email || '').trim();
  if (curEmail.toLowerCase() === newEmail.toLowerCase() && newName === String(recipient.name || '').trim()) {
    return { ok: false, status: 400, error: 'That’s already the email on this invitation — nothing to change.' };
  }
  const signerUpdate = { recipientId: String(recipient.recipient_id_ds), email: newEmail, name: newName };
  // Keep the embedded (captive) config so the in-portal magic link keeps working against the
  // corrected address. PILOT sends the new invitation itself; DocuSign sends nothing.
  if (recipient.client_user_id) {
    /* Captive, exactly as the original send is (2026-08-21). `embeddedRecipientStartURL` used
       to ride here too, so a corrected address received DocuSign's own dead link as well as
       PILOT's working one — the same duplicate the send itself carried. PILOT re-notifies the
       corrected signer with its own branded email (`notifyReadyToSign` with `onlyRecipientIdDs`),
       which is the whole point of correcting the address. */
    signerUpdate.clientUserId = String(recipient.client_user_id);
  }
  const isBorrowerRecipient = ['borrower', 'co_borrower'].includes(recipient.role) && !!recipient.borrower_id;
  return { ok: true, newEmail, newName, prevEmail: curEmail || null, signerUpdate, isBorrowerRecipient };
}

/**
 * IO — load the envelope + recipient, correct the email on DocuSign (re-sending the
 * invitation), persist the new email on esign_recipients, re-send PILOT's own branded
 * magic-link email to the new address (best-effort, that one recipient only), and
 * report whether the new address differs from the borrower's email on file.
 *
 * @param {{ envelopeRowId, recipientRowId, email, name?, actorId?,
 *           db?, docusign?, switches?, notify? }} p
 * @returns {Promise<{ ok, recipientRowId, role, borrowerId, prevEmail, email, name,
 *                     fileEmail, differsFromFile, applicationId, purpose }>}
 */
async function changeRecipientEmail(p) {
  const db = p.db || require('../../db');
  const docusign = p.docusign || require('../integrations/docusign');
  const switches = p.switches || require('../integrations/switches');
  const notify = p.notify || require('./notify-signers');

  const env = (await db.query('SELECT * FROM esign_envelopes WHERE id = $1', [p.envelopeRowId])).rows[0] || null;
  const recipient = env
    ? ((await db.query('SELECT * FROM esign_recipients WHERE id = $1 AND envelope_row_id = $2', [p.recipientRowId, p.envelopeRowId])).rows[0] || null)
    : null;

  const plan = planRecipientEmailChange({
    env, recipient, email: p.email, name: p.name,
    sendEnabled: switches.on('DOCUSIGN_SEND_ENABLED'),
  });
  if (!plan.ok) throw fail(plan.status, plan.error);

  // Pre-go-live safety: while on the DEMO host OR in test mode, a re-address must obey
  // the SAME allow-list the send engine enforces (send.js guardTestEmails). Otherwise
  // re-addressing would be a hole that mails a REAL recipient a binding envelope before
  // go-live — the exact thing the allow-list exists to prevent.
  const dcfg = p.cfg || require('../../config').docusign;
  const onDemo = !!(docusign.isDemoHost && docusign.isDemoHost());
  if (onDemo || (dcfg && dcfg.testMode)) {
    const allow = ((dcfg && dcfg.testEmailAllowlist) || []).map((x) => String(x).toLowerCase());
    if (!allow.includes(plan.newEmail.toLowerCase())) {
      throw fail(409, `Sending is in test mode — “${plan.newEmail}” isn’t on the DocuSign test allow-list, so the invitation can’t be re-sent there until go-live.`);
    }
  }

  // Correct the recipient on the in-flight envelope and re-send to the new address.
  await docusign.updateRecipients(env.envelope_id, { signers: [plan.signerUpdate], resend: true });

  await db.query('UPDATE esign_recipients SET email = $2, name = $3, updated_at = now() WHERE id = $1',
    [recipient.id, plan.newEmail, plan.newName]);

  // Re-send PILOT's own branded "ready to sign" magic-link email to the corrected
  // recipient only. Best-effort — DocuSign already re-sent its own invitation above.
  let pilotEmail = null;
  if (plan.isBorrowerRecipient) {
    try {
      pilotEmail = await notify.notifyReadyToSign(p.envelopeRowId, { db, onlyRecipientIdDs: recipient.recipient_id_ds });
    } catch (_) { /* the magic-link nudge is a nicety; DocuSign's own email is the invitation */ }
  }

  // The warning input: does the corrected address match the borrower's email ON FILE?
  // If not, the caller reminds staff to update the file too (so future packages/emails
  // use it). We never write the borrower record here — that is the one shared writer.
  let fileEmail = null, differsFromFile = false;
  if (env.application_id && recipient.borrower_id) {
    try {
      const fr = (await db.query('SELECT email FROM borrowers WHERE id = $1', [recipient.borrower_id])).rows[0];
      fileEmail = fr && fr.email ? String(fr.email).trim() : null;
      differsFromFile = !!(fileEmail && fileEmail.toLowerCase() !== plan.newEmail.toLowerCase());
    } catch (_) { /* the warning is advisory — a read hiccup just omits it */ }
  }

  return {
    ok: true,
    recipientRowId: recipient.id,
    role: recipient.role,
    borrowerId: recipient.borrower_id || null,
    prevEmail: plan.prevEmail,
    email: plan.newEmail,
    name: plan.newName,
    fileEmail,
    differsFromFile,
    pilotEmailSent: !!(pilotEmail && pilotEmail.sent),
    applicationId: env.application_id || null,
    purpose: env.purpose,
  };
}

module.exports = { planRecipientEmailChange, changeRecipientEmail, EMAIL_RE, TERMINAL_ENV };
