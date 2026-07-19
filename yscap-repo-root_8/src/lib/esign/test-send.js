/**
 * esign/test-send.js — the admin "send myself a test envelope" tool, now TRACKED.
 *
 * Confirms end-to-end that DocuSign renders our generated Word documents and the
 * signing experience works — WITHOUT a real loan file. It sends the TWO packages a
 * real borrower would receive, mirroring production (the disclosure and the Heter
 * Iska are SEPARATE packages):
 *   • a "Term-sheet package (TEST)" carrying the business-purpose disclosure, and
 *   • a "Heter Iska (TEST)".
 * Each goes to the admin's OWN staff email and is recorded as a first-class is_test
 * envelope row (app-less by construction) so it shows in the E-Signatures cockpit
 * and reconciles through the SAME webhook/poller as a real send — the admin can
 * watch it move sent → viewed → signed → completed.
 *
 * Safe by construction, reusing the real guards:
 *   • refuses unless DOCUSIGN_SEND_ENABLED is on;
 *   • send.guardTestEmails is the final backstop (in test mode it THROWS unless the
 *     recipient is on DOCUSIGN_TEST_EMAIL_ALLOWLIST) — called BEFORE any DB write;
 *   • the route is admin-only, and every test row is app-less (is_test), so it can
 *     never touch a real loan file, condition, or SharePoint mirror (the webhook
 *     and the tracking queries both special-case an app-less row).
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

// The two test packages, mirroring the real borrower flow (disclosure and Heter
// Iska are SEPARATE packages). Each carries only the generated doc(s) a test can
// build — the term sheet + application are file-specific PDFs, absent for a test.
const TEST_PACKAGES = [
  {
    label: 'Term-sheet package (TEST)',
    subject: 'PILOT e-signature TEST — Term-sheet package (please review the rendered document)',
    docs: [{ kind: 'bp_disclosure', signedKind: 'bp_disclosure_signed', name: 'Business-Purpose Disclosure (TEST)', prefix: 'bpd' }],
  },
  {
    label: 'Heter Iska (TEST)',
    subject: 'PILOT e-signature TEST — Heter Iska (please review the rendered document)',
    docs: [{ kind: 'heter_iska', signedKind: 'heter_iska_signed', name: 'Heter Iska (TEST)', prefix: 'iska' }],
  },
];

/** Send ONE tracked test package to the admin. Records an app-less is_test row. */
async function sendOnePackage({ db, docusign, actorId, name, email, pkg }) {
  const data = sampleData();
  const documents = [];
  const tabsByDoc = {};
  pkg.docs.forEach((d, i) => {
    const documentId = i + 1;
    documents.push({
      base64: docgen.generate(d.kind, data).toString('base64'),
      name: d.name, documentId, fileExtension: 'docx',
    });
    tabsByDoc[documentId] = { sign: [`/${d.prefix}_b1_sig/`], date: [`/${d.prefix}_b1_dt/`] };
  });
  const signers = [{ recipientId: '1', name, email, routingOrder: 1, tabsByDoc }];

  // Final safety backstop — identical to the real send path, BEFORE any DB write so
  // a blocked recipient leaves no phantom row. In test mode this throws unless the
  // email is on DOCUSIGN_TEST_EMAIL_ALLOWLIST.
  send.guardTestEmails(docusign, signers);

  // Record the tracked envelope FIRST (status not_sent) so a create failure is
  // visible in the cockpit rather than lost. App-less + is_test by construction.
  const row = (await db.query(
    `INSERT INTO esign_envelopes (application_id, is_test, test_label, purpose, status,
        countersign_required, product_version, embedded, created_by)
     VALUES (NULL, true, $1, 'test', 'not_sent', false, 0, false, $2)
     RETURNING id`, [pkg.label, actorId || null])).rows[0];
  await db.query(
    `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, is_countersigner,
        recipient_id_ds, borrower_id, name, email, embedded, status)
     VALUES ($1,'borrower',1,false,'1',NULL,$2,$3,false,'created')`,
    [row.id, name, email]);
  for (let i = 0; i < pkg.docs.length; i++) {
    await db.query(
      `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id)
       VALUES ($1,$2,$3,NULL)`, [row.id, i + 1, pkg.docs[i].signedKind]);
  }

  const def = docusign.buildEnvelopeDefinition({
    documents, signers, subject: pkg.subject,
    emailBlurb: 'This is a TEST envelope to confirm your documents render and sign correctly. It is NOT a real loan — the borrower, amount, and address are made up.',
    brandId: cfg.docusign.brandId || undefined,
    customFields: { textCustomFields: [
      { name: 'ys_envelope_row', value: String(row.id), show: 'false', required: 'false' },
      { name: 'ys_purpose', value: 'test', show: 'false' },
    ] },
    eventNotification: docusign.eventNotification(`${cfg.appUrl}/api/esign/webhook`),
    notification: docusign.notificationSettings(),
  });

  let res;
  try {
    res = await docusign.createEnvelope(def);
  } catch (e) {
    await db.query(`UPDATE esign_envelopes SET status='error', last_error=$2, dead_lettered_at=now(), updated_at=now() WHERE id=$1`,
      [row.id, String((e && e.message) || e).slice(0, 500)]);
    throw e;
  }
  if (!res || !res.envelopeId) {
    await db.query(`UPDATE esign_envelopes SET status='error', last_error=$2, dead_lettered_at=now(), updated_at=now() WHERE id=$1`,
      [row.id, 'DocuSign did not return an envelope id.']);
    const e = new Error('DocuSign did not return an envelope id.'); e.retryable = true; throw e;
  }

  const recipientsSnapshot = JSON.stringify([{
    role: 'borrower', name, email, recipientId: '1', routingOrder: 1, embedded: false,
  }]);
  await db.query(
    `UPDATE esign_envelopes SET envelope_id=$2, status='sent', sent_at=now(), recipients=$3::jsonb, updated_at=now()
      WHERE id=$1`, [row.id, res.envelopeId, recipientsSnapshot]);
  await db.query(`UPDATE esign_recipients SET status='sent', sent_at=now(), updated_at=now() WHERE envelope_row_id=$1`, [row.id]);
  return { envelopeId: res.envelopeId, envelopeRowId: row.id, label: pkg.label };
}

async function sendTestEnvelope({ actorId, db = dbDefault, docusign = docusignDefault } = {}) {
  if (!cfg.docusign.sendEnabled) {
    const e = new Error('Sending is off — set DOCUSIGN_SEND_ENABLED=1 (test mode) in Render first, then try again.');
    e.code = 'DOCUSIGN_SEND_DISABLED'; e.retryable = false; throw e;
  }
  const s = (await db.query(`SELECT email, full_name FROM staff_users WHERE id=$1 AND is_active`, [actorId])).rows[0];
  if (!s || !s.email) { const e = new Error('Your staff account has no email address to send the test to.'); e.retryable = false; throw e; }
  const name = (s.full_name || 'Test Signer').trim() || 'Test Signer';

  const packages = [];
  for (const pkg of TEST_PACKAGES) {
    packages.push(await sendOnePackage({ db, docusign, actorId, name, email: s.email, pkg }));
  }
  return { to: s.email, packages, envelopeId: packages[0] && packages[0].envelopeId };
}

module.exports = { sendTestEnvelope, sampleData, TEST_PACKAGES };
