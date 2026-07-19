/**
 * esign/test-send.js — the admin "send myself a test envelope" tool.
 *
 * Lets an admin confirm, end-to-end, that DocuSign renders our generated Word
 * documents correctly and the signing experience works — WITHOUT setting up a
 * real loan file that passes the send-gate. It builds the disclosure + Heter Iska
 * from an obviously-fake sample loan and sends ONE envelope to the admin's own
 * staff email.
 *
 * It is safe by construction, reusing the exact guards the real send path uses:
 *   • refuses unless DOCUSIGN_SEND_ENABLED is on (same master switch);
 *   • the send-once engine's guardTestEmails is the final backstop — in test mode
 *     (the default) it THROWS unless the recipient is on DOCUSIGN_TEST_EMAIL_ALLOWLIST,
 *     so a test can only ever reach an allow-listed address (never a real borrower);
 *   • the route is admin-only.
 * It does NOT touch esign_envelopes / the tracking tables — it is a throwaway test
 * envelope, not a tracked loan send, so it also bypasses the loan-file gate.
 */
const dbDefault = require('../../db');
const docusignDefault = require('../integrations/docusign');
const docgen = require('./docgen');
const send = require('./send');
const cfg = require('../../config');

/** An obviously-fake sample loan so a test envelope never looks like a real file. */
function sampleData() {
  return {
    loanNumber: 'YS-TEST-0000',
    applicationDate: '2026-01-01',
    executionDate: '2026-01-01',
    loanAmount: 750000,
    propStreet: '145 Forest Avenue',
    propCity: 'Lakewood', propState: 'NJ', propZip: '08701',
    bFirst: 'Test', bLast: 'Borrower', hasCoBorrower: false,
  };
}

async function sendTestEnvelope({ actorId, db = dbDefault, docusign = docusignDefault } = {}) {
  if (!cfg.docusign.sendEnabled) {
    const e = new Error('Sending is off — set DOCUSIGN_SEND_ENABLED=1 (test mode) in Render first, then try again.');
    e.code = 'DOCUSIGN_SEND_DISABLED'; e.retryable = false; throw e;
  }
  const s = (await db.query(`SELECT email, full_name FROM staff_users WHERE id=$1 AND is_active`, [actorId])).rows[0];
  if (!s || !s.email) { const e = new Error('Your staff account has no email address to send the test to.'); e.retryable = false; throw e; }
  const name = (s.full_name || 'Test Signer').trim() || 'Test Signer';

  const data = sampleData();
  const documents = [
    { base64: docgen.generate('bp_disclosure', data).toString('base64'), name: 'Business-Purpose Disclosure (TEST)', documentId: 1, fileExtension: 'docx' },
    { base64: docgen.generate('heter_iska', data).toString('base64'),   name: 'Heter Iska (TEST)',                  documentId: 2, fileExtension: 'docx' },
  ];
  const signers = [{
    recipientId: '1', name, email: s.email, routingOrder: 1,
    tabsByDoc: {
      1: { sign: ['/bpd_b1_sig/'], date: ['/bpd_b1_dt/'] },
      2: { sign: ['/iska_b1_sig/'], date: ['/iska_b1_dt/'] },
    },
  }];

  // Final safety backstop — identical to the real send path. In test mode this
  // throws unless s.email is on DOCUSIGN_TEST_EMAIL_ALLOWLIST.
  send.guardTestEmails(docusign, signers);

  const def = docusign.buildEnvelopeDefinition({
    documents, signers,
    subject: 'PILOT e-signature TEST — please review the rendered documents',
    emailBlurb: 'This is a TEST envelope to confirm your documents render and sign correctly. It is NOT a real loan — the borrower, amount, and address are made up.',
    brandId: cfg.docusign.brandId || undefined,
  });
  const res = await docusign.createEnvelope(def);
  if (!res || !res.envelopeId) { const e = new Error('DocuSign did not return an envelope id.'); e.retryable = true; throw e; }
  return { envelopeId: res.envelopeId, to: s.email };
}

module.exports = { sendTestEnvelope, sampleData };
