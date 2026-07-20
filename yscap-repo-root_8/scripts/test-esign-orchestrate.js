/**
 * test-esign-orchestrate.js — end-to-end integration test for the send
 * orchestration + the inbound webhook drainer, against a REAL Postgres (a
 * throwaway fixture DB) with injected fakes for DocuSign + storage.
 *
 * Exercises the exact SQL the code runs (column names, joins, upserts) plus the
 * whole flow: gate -> envelope row -> docs map -> recipient roster ->
 * buildDefinition (documents + anchored tabs) -> "send" -> Connect completion ->
 * download + store signed PDFs -> clear conditions.
 *
 * Run (PG on the demo socket):
 *   PGHOST=/tmp PGPORT=5433 PGUSER=postgres node scripts/test-esign-orchestrate.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');

const R = path.resolve(__dirname, '..');
const HOST = process.env.PGHOST || '/tmp';
const PORT = parseInt(process.env.PGPORT || '5433', 10);
const USER = process.env.PGUSER || 'postgres';
const PW = process.env.PGPASSWORD || 'postgres';
const DBNAME = 'esign_it_test';

// Force sends ON + a permissive allow-list so the gate doesn't block the test
// before our code runs. (No real DocuSign call happens — docusign is faked.)
process.env.DOCUSIGN_SEND_ENABLED = '1';
process.env.DOCUSIGN_TEST_MODE = '1';
process.env.DOCUSIGN_TEST_EMAIL_ALLOWLIST =
  'borrower@example.com,co@example.com,yehuda@yscapgroup.com';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

async function admin(sql) {
  const c = new Client({ host: HOST, port: PORT, user: USER, password: PW, database: 'postgres' });
  await c.connect(); try { await c.query(sql); } finally { await c.end(); }
}

// A fake DocuSign connector — records what it was asked to send + serves a
// completed envelope back for the webhook phase.
function fakeDocusign() {
  const calls = { created: null };
  return {
    _calls: calls,
    idempotencyKey: (a, p, v) => `idem:${a}:${p}:${v}`,
    buildEnvelopeDefinition: (inputs) => ({ __def: inputs }),
    eventNotification: () => ({ url: 'x' }),
    notificationSettings: () => ({}),
    isDemoHost: () => true,
    async createEnvelope(def) { calls.created = def.__def; calls.n = (calls.n || 0) + 1; return { envelopeId: `ENV-${calls.n}`, status: 'sent' }; },
    async getEnvelope() {
      return {
        status: 'completed', currentRoutingOrder: 2,
        recipients: { signers: [
          { recipientId: '1', routingOrder: '1', name: 'Pat Borrower', email: 'borrower@example.com',
            status: 'completed', sentDateTime: '2026-07-19T10:00:00Z', deliveredDateTime: '2026-07-19T10:05:00Z', signedDateTime: '2026-07-19T10:10:00Z' },
          { recipientId: '2', routingOrder: '1', name: 'Chris Co', email: 'co@example.com',
            status: 'completed', sentDateTime: '2026-07-19T10:00:00Z', signedDateTime: '2026-07-19T10:12:00Z' },
          { recipientId: '3', routingOrder: '2', name: 'YS Capital', email: 'yehuda@yscapgroup.com',
            status: 'completed', sentDateTime: '2026-07-19T10:13:00Z', signedDateTime: '2026-07-19T10:20:00Z' },
        ] },
      };
    },
    async getDocument(_env, id) { return Buffer.from(`signed-doc-${id}`); },
    async getCertificate() { return Buffer.from('certificate'); },
    parseRecipients(env) { return require(R + '/src/lib/integrations/docusign').parseRecipients(env); },
  };
}

// A fake storage provider — keeps bytes in a Map keyed by ref.
function fakeStorage() {
  const store = new Map();
  let i = 0;
  return {
    async save(buf) { const ref = `ref-${++i}`; store.set(ref, Buffer.from(buf)); return { ref, provider: 'local', bytes: buf.length }; },
    async read(ref) { if (!store.has(ref)) throw new Error(`no bytes for ${ref}`); return store.get(ref); },
    _store: store,
  };
}

(async () => {
  // Fresh DB + fixture.
  await admin(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin(`CREATE DATABASE ${DBNAME}`);
  const pool = new Pool({ host: HOST, port: PORT, user: USER, password: PW, database: DBNAME });
  await pool.query(fs.readFileSync(path.join(__dirname, 'esign-it-fixture.sql'), 'utf8'));

  const orchestrate = require(R + '/src/lib/esign/orchestrate');
  const webhook = require(R + '/src/lib/esign/webhook');

  try {
    // ---- seed a file: borrower + co-borrower, gate-passing conditions --------
    const b = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pat','Borrower','borrower@example.com') RETURNING id`)).rows[0].id;
    const cb = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Chris','Co','co@example.com') RETURNING id`)).rows[0].id;
    const app = (await pool.query(
      `INSERT INTO applications (ys_loan_number,borrower_id,co_borrower_id,property_address,loan_amount,submitted_at)
       VALUES ('YS-1001',$1,$2,
               '{"line1":"1 Main St","city":"Town","state":"NY","zip":"10001","oneLine":"1 Main St, Town, NY"}',
               487500, '2026-06-01T00:00:00Z') RETURNING id`, [b, cb])).rows[0].id;

    // Conditions: appraisal back (t0), review (t0), product AFTER appraisal (t1),
    // plus the target conditions the signed docs clear.
    const codes = ['rtl_cond_appraisaldocs', 'rtl_p3_apprreview', 'rtl_p1_product',
      'rtl_cond_signedts', 'rtl_cond_signed_app', 'rtl_cond_disclosures', 'rtl_cond_iska'];
    const tmpl = {};
    for (const code of codes) tmpl[code] = (await pool.query(`INSERT INTO checklist_templates (code) VALUES ($1) RETURNING id`, [code])).rows[0].id;
    const mkItem = async (code, status, signedAt) =>
      pool.query(`INSERT INTO checklist_items (application_id,template_id,status,signed_off_at) VALUES ($1,$2,$3,$4)`,
        [app, tmpl[code], status, signedAt || null]);
    await mkItem('rtl_cond_appraisaldocs', 'satisfied', '2026-07-10T00:00:00Z');
    await mkItem('rtl_p3_apprreview', 'satisfied', '2026-07-11T00:00:00Z');
    await mkItem('rtl_p1_product', 'satisfied', '2026-07-12T00:00:00Z');   // AFTER appraisal → gate passes
    await mkItem('rtl_cond_signedts', 'open', null);
    await mkItem('rtl_cond_signed_app', 'open', null);
    await mkItem('rtl_cond_disclosures', 'open', null);

    // Stored source PDF for the term-sheet package. Only the TERM SHEET is a stored
    // (browser-jsPDF) document now; the application export + business-purpose
    // disclosure are GENERATED on our server at send time, so no stored bytes for
    // them — the send must still work without a stored application_export.
    const storage = fakeStorage();
    for (const kind of ['term_sheet']) {
      const { ref } = await storage.save(Buffer.from(`${kind}-bytes`));
      await pool.query(
        `INSERT INTO documents (application_id,filename,storage_provider,storage_ref,doc_kind,is_current)
         VALUES ($1,$2,'local',$3,$4,true)`, [app, `${kind}.pdf`, ref, kind]);
    }

    // ---- SEND the term-sheet package ----------------------------------------
    const docusign = fakeDocusign();
    const res = await orchestrate.sendPackage(app, 'term_sheet_package', { id: null }, { db: pool, docusign, storage });
    ok(res.ok, 'sendPackage returned ok');
    ok(res.result && res.result.sent, 'send engine reported sent');

    // Envelope row + status.
    const env = (await pool.query(`SELECT * FROM esign_envelopes WHERE application_id=$1`, [app])).rows[0];
    eq(env.status, 'sent', 'envelope marked sent');
    ok(env.envelope_id && /^ENV-\d+$/.test(env.envelope_id), 'envelope_id stamped');
    eq(env.countersign_required, true, 'term-sheet package requires countersign');
    eq(Number(env.product_version), 0, 'first issue is product_version 0');

    // Docs map bound to the right conditions.
    const edocs = (await pool.query(`SELECT * FROM esign_envelope_docs WHERE envelope_row_id=$1 ORDER BY document_id`, [env.id])).rows;
    eq(edocs.length, 3, 'three documents mapped');
    eq(edocs[0].doc_kind, 'term_sheet_signed', 'doc 1 = signed term sheet');
    ok(edocs[0].checklist_item_id, 'doc 1 bound to a condition');

    // Recipient roster: borrower + co + admin at the right routing orders.
    const recs = (await pool.query(`SELECT * FROM esign_recipients WHERE envelope_row_id=$1 ORDER BY recipient_id_ds`, [env.id])).rows;
    eq(recs.length, 3, 'three recipients seeded');
    eq(recs[0].role, 'borrower', 'recip 1 = borrower');
    eq(Number(recs[0].routing_order), 1, 'borrower routes first');
    eq(recs[2].role, 'admin', 'recip 3 = admin');
    eq(Number(recs[2].routing_order), 2, 'admin routes last');
    eq(recs[2].is_countersigner, true, 'admin is the counter-signer');
    eq(recs[2].email, 'yehuda@yscapgroup.com', 'admin email = owner');

    // The envelope definition the connector was handed: 3 docs, correct anchors.
    const def = docusign._calls.created;
    eq(def.documents.length, 3, 'definition carries 3 documents');
    const borrowerSigner = def.signers.find((s) => s.recipientId === '1');
    const adminSigner = def.signers.find((s) => s.recipientId === '3');
    ok(borrowerSigner.tabsByDoc['1'].sign.includes('/ts_b1_sig/'), 'borrower has term-sheet anchor');
    ok(borrowerSigner.tabsByDoc['2'].sign.includes('/app_b1_sig/'), 'borrower has application anchor');
    ok(borrowerSigner.tabsByDoc['3'].sign.includes('/bpd_b1_sig/'), 'borrower has disclosure anchor');
    eq(Object.keys(adminSigner.tabsByDoc).length, 1, 'admin signs exactly one document');
    ok(adminSigner.tabsByDoc['1'].sign.includes('/ts_admin_sig/'), 'admin counter-signs the term sheet only');
    ok(borrowerSigner.clientUserId && borrowerSigner.embeddedRecipientStartURL === 'SIGN_AT_DOCUSIGN', 'borrower is hybrid embedded+email');

    // ---- the disclosure is GENERATED on our server (jsPDF → branded PDF) --------
    // Owner-directed (2026-07-20): the business-purpose disclosure now renders on the
    // PILOT letterhead as a real PDF (disclosure-pdf.js), uploaded AS a PDF — the same
    // path as the loan application. Its legal certification text is preserved verbatim.
    const bpdDoc = def.documents.find((d) => d.name === 'Business-Purpose Disclosure');
    eq(bpdDoc.fileExtension, 'pdf', 'disclosure uploads AS a branded PDF (not .docx)');
    const bpdPdf = Buffer.from(bpdDoc.base64, 'base64');
    eq(bpdPdf.slice(0, 5).toString('latin1'), '%PDF-', 'disclosure is a real PDF');
    const bpdText = bpdPdf.toString('latin1');
    ok(bpdText.includes('487,500.00'), 'disclosure filled with the loan amount');
    ok(bpdText.includes('YS-1001'), 'disclosure filled with the loan number');
    ok(bpdText.includes('1 Main St') && bpdText.includes('10001'), 'disclosure filled with the subject property');
    ok(bpdText.includes('/bpd_b1_sig/') && bpdText.includes('/bpd_b1_dt/'), 'disclosure carries the borrower sign+date anchors');
    ok(bpdText.includes('/bpd_b2_sig/'), 'disclosure carries the co-borrower anchor');
    ok(bpdText.includes('Promissory') && bpdText.includes('Homeowners'), 'disclosure preserves the legal certification text');
    ok(!/«[^»]+»/.test(bpdText), 'no unfilled «merge fields» left in the disclosure');

    // ---- the LOAN APPLICATION is GENERATED on our server (jsPDF → real PDF) -----
    // Nothing stores an application_export anymore; generation covers it. It must be
    // in the envelope as a PDF carrying the borrower signature anchor + the file data.
    const appDoc = def.documents.find((d) => d.name === 'Loan Application');
    ok(appDoc, 'the generated Loan Application is in the envelope');
    eq(appDoc.fileExtension, 'pdf', 'Loan Application uploads AS a PDF (not .docx)');
    const appPdf = Buffer.from(appDoc.base64, 'base64');
    eq(appPdf.slice(0, 5).toString('latin1'), '%PDF-', 'Loan Application is a real PDF');
    const appText = appPdf.toString('latin1');
    ok(appText.includes('/app_b1_sig/') && appText.includes('/app_b1_dt/'), 'Loan Application carries the borrower sign+date anchors');
    ok(appText.includes('/app_b2_sig/'), 'Loan Application carries the co-borrower anchor (file has a co-borrower)');
    ok(appText.includes('YS-1001'), 'Loan Application shows the loan number');
    ok(appText.includes('Pat') && appText.includes('Borrower'), 'Loan Application shows the borrower name');

    // ---- the Heter Iska is ALSO generated on our server, now as a real PDF -------
    // (owner 2026-07-20: send a PDF we build, not a .docx handed to DocuSign). The
    // sacred Hebrew nusach is a verified pre-render; the Latin amount + names + anchors
    // are drawn on top (see iska-pdf.js). So we assert the PDF bytes, not docx XML.
    const iskaRes = await orchestrate.sendPackage(app, 'heter_iska', { id: null }, { db: pool, docusign, storage });
    ok(iskaRes.ok, 'Heter Iska package sent');
    const iskaDef = docusign._calls.created;
    eq(iskaDef.documents.length, 1, 'Iska envelope carries one document');
    const iskaDoc = iskaDef.documents[0];
    eq(iskaDoc.fileExtension, 'pdf', 'Iska uploaded AS a PDF (DocuSign does not convert it)');
    const iskaPdf = Buffer.from(iskaDoc.base64, 'base64');
    eq(iskaPdf.slice(0, 5).toString('latin1'), '%PDF-', 'Iska bytes really are a PDF');
    const iskaRaw = iskaPdf.toString('latin1');
    ok(iskaRaw.includes('487,500.00'), 'Iska filled with the loan amount');
    ok(iskaRaw.includes('/iska_b1_sig/') && iskaRaw.includes('/iska_b1_dt/'), 'Iska carries the borrower sign+date anchors');
    ok(iskaRaw.includes('/iska_b2_sig/'), 'Iska carries the co-borrower anchor');
    const iskaSigner = iskaDef.signers.find((s) => s.recipientId === '1');
    ok(iskaSigner.tabsByDoc['1'].sign.includes('/iska_b1_sig/'), 'Iska borrower anchor wired to the tab');

    // ---- send-once idempotency: a second send returns the same in-flight row --
    const res2 = await orchestrate.sendPackage(app, 'term_sheet_package', { id: null }, { db: pool, docusign, storage });
    eq(res2.envelopeRowId, env.id, 'second send reuses the in-flight envelope row');
    const envCount = (await pool.query(`SELECT count(*)::int n FROM esign_envelopes WHERE application_id=$1 AND purpose='term_sheet_package'`, [app])).rows[0].n;
    eq(envCount, 1, 'no duplicate envelope row created');

    // ---- COMPLETION via the webhook drainer ---------------------------------
    await pool.query(`INSERT INTO docusign_event_inbox (body_sha256,envelope_id,event_type) VALUES ('sha-1',$1,'envelope-completed')`, [env.envelope_id]);
    const drained = await webhook.drainInbox({ db: pool, docusign, storage });
    eq(drained.length, 1, 'one inbox event drained');
    eq(drained[0].reconciled, 'completed', 'reconciled to completed');

    // Envelope + recipients updated.
    const env2 = (await pool.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [env.id])).rows[0];
    eq(env2.status, 'completed', 'envelope now completed');
    ok(env2.completed_at, 'completed_at stamped');
    const recDone = (await pool.query(`SELECT status, signed_at FROM esign_recipients WHERE envelope_row_id=$1 AND role='admin'`, [env.id])).rows[0];
    eq(recDone.status, 'completed', 'admin recipient marked completed');
    ok(recDone.signed_at, 'admin signed_at captured');

    // Signed docs stored + conditions cleared to received.
    const signedDocs = (await pool.query(`SELECT doc_kind, checklist_item_id FROM documents WHERE application_id=$1 AND doc_kind LIKE '%_signed' ORDER BY doc_kind`, [app])).rows;
    eq(signedDocs.length, 3, 'three signed PDFs stored');
    const cleared = (await pool.query(`SELECT count(*)::int n FROM esign_envelope_docs WHERE envelope_row_id=$1 AND completed_document_id IS NOT NULL`, [env.id])).rows[0].n;
    eq(cleared, 3, 'all three envelope docs marked stored');
    const tsItem = (await pool.query(
      `SELECT ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id WHERE ci.application_id=$1 AND t.code='rtl_cond_signedts'`, [app])).rows[0];
    eq(tsItem.status, 'received', 'signed-term-sheet condition moved to received');
    const cert = (await pool.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='esign_certificate'`, [app])).rows[0].n;
    eq(cert, 1, 'certificate of completion stored');

    // The read model surfaces the signed PDFs + the certificate for download links
    // on BOTH the cockpit and the per-file view (attachSignedArtifacts).
    const tracking = require(R + '/src/lib/esign/tracking');
    const fe = await tracking.fileEsign(pool, app);
    const feEnv = fe.envelopes.find((x) => String(x.id) === String(env.id));
    ok(feEnv && feEnv.documents && feEnv.documents.length === 3, 'read model attaches the 3 signed PDFs to the envelope');
    ok(feEnv && feEnv.certificate && feEnv.certificate.documentId, 'read model attaches the certificate for download');

    // Borrower access: the 3 signed copies carry borrower_id (so they appear in the
    // borrower's in-portal document library); the certificate stays staff-only (null).
    const bwSigned = (await pool.query(
      `SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind LIKE '%_signed' AND borrower_id IS NOT NULL`, [app])).rows[0].n;
    eq(bwSigned, 3, 'signed copies carry borrower_id (visible in the borrower library)');
    const certBw = (await pool.query(
      `SELECT borrower_id FROM documents WHERE application_id=$1 AND doc_kind='esign_certificate'`, [app])).rows[0];
    ok(certBw && certBw.borrower_id === null, 'certificate stays staff-only (no borrower_id)');
    // Condition merge: the signed disclosure files into the combined application condition.
    const discCond = (await pool.query(
      `SELECT t.code FROM esign_envelope_docs ed
         JOIN checklist_items ci ON ci.id = ed.checklist_item_id
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ed.envelope_row_id=$1 AND ed.doc_kind='bp_disclosure_signed'`, [env.id])).rows[0];
    eq(discCond && discCond.code, 'rtl_cond_signed_app', 'signed disclosure files into the combined application condition (merge)');

    // ---- idempotent re-drain: a duplicate completion event is a no-op --------
    await pool.query(`INSERT INTO docusign_event_inbox (body_sha256,envelope_id,event_type) VALUES ('sha-2',$1,'envelope-completed')`, [env.envelope_id]);
    await webhook.drainInbox({ db: pool, docusign, storage });
    const signedAfter = (await pool.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind LIKE '%_signed'`, [app])).rows[0].n;
    eq(signedAfter, 3, 'no duplicate signed docs on re-drain (idempotent)');
    const certAfter = (await pool.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='esign_certificate'`, [app])).rows[0].n;
    eq(certAfter, 1, 'no duplicate certificate on re-drain');

    // ---- a PLAIN re-send after completion is a NO-OP (no duplicate envelope) --
    // Fixes the "click Send again and again → a pile of envelopes" bug: a plain send
    // never mints a duplicate for a terminal (completed/declined/voided/error) package;
    // it reports terminal so the UI steers to an explicit Re-issue instead of stacking.
    const plainAfterDone = await orchestrate.sendPackage(app, 'term_sheet_package', { id: null }, { db: pool, docusign, storage });
    ok(plainAfterDone.terminal === true && plainAfterDone.ok === false, 'plain re-send after completion is a no-op (terminal, not sent)');
    eq(plainAfterDone.envelopeRowId, env.id, 'plain re-send returns the completed envelope, mints nothing');
    const afterPlain = (await pool.query(`SELECT count(*)::int n FROM esign_envelopes WHERE application_id=$1 AND purpose='term_sheet_package'`, [app])).rows[0].n;
    eq(afterPlain, 1, 'plain re-send did NOT create a duplicate envelope row');

    // ---- an EXPLICIT re-issue after completion gets a NEW row + DISTINCT version (M2) -----
    const reissue = await orchestrate.sendPackage(app, 'term_sheet_package', { id: null }, { db: pool, docusign, storage, reissue: true });
    ok(reissue.envelopeRowId !== env.id, 'explicit re-issue after completion creates a NEW envelope row');
    const versions = (await pool.query(
      `SELECT product_version FROM esign_envelopes WHERE application_id=$1 AND purpose='term_sheet_package' ORDER BY created_at`, [app])).rows;
    eq(versions.length, 2, 'two envelope rows over the file life');
    ok(String(versions[0].product_version) !== String(versions[1].product_version), 're-issue got a distinct product_version (distinct idempotency key)');

    // ---- HIGH-2: a stored term sheet produced BEFORE the appraisal is blocked -
    // (it could carry a pre-appraisal loan amount that contradicts the disclosure,
    // which regenerates on the current amount — one envelope, two loan figures).
    {
      const tsRow = (await pool.query(
        `SELECT * FROM esign_envelopes WHERE application_id=$1 AND purpose='term_sheet_package' ORDER BY created_at DESC LIMIT 1`, [app])).rows[0];
      // appraisal came back 2026-07-10; backdate the term sheet to before that.
      await pool.query(`UPDATE documents SET created_at='2026-07-01T00:00:00Z' WHERE application_id=$1 AND doc_kind='term_sheet'`, [app]);
      let staleBlocked = false;
      try { await orchestrate.buildDefinition(tsRow, { db: pool, storage }); }
      catch (e) { staleBlocked = /before the appraisal/.test(e.message) && e.retryable === false; }
      ok(staleBlocked, 'HIGH-2: a term sheet produced before the appraisal is blocked (non-retryable)');
      // refresh it to AFTER the appraisal → the freshness guard must NOT fire
      await pool.query(`UPDATE documents SET created_at=now() WHERE application_id=$1 AND doc_kind='term_sheet'`, [app]);
      let freshFreshnessOk = true;
      try { await orchestrate.buildDefinition(tsRow, { db: pool, storage }); }
      catch (e) { freshFreshnessOk = !/before the appraisal/.test(e.message); }
      ok(freshFreshnessOk, 'HIGH-2: a term sheet refreshed after the appraisal passes the freshness guard');
      // The application_export is GENERATED fresh at send time from the current file,
      // so it can never be stale — no freshnessCheck applies to it. Instead of a
      // (now-moot) staleness assertion, confirm buildDefinition PRODUCES the generated
      // application PDF (with the borrower signature anchor) every time.
      const freshDef = await orchestrate.buildDefinition(tsRow, { db: pool, storage });
      const freshApp = freshDef.documents.find((dd) => dd.name === 'Loan Application');
      ok(freshApp && freshApp.fileExtension === 'pdf', 'the Loan Application is generated fresh on every build (as a PDF)');
      ok(Buffer.from(freshApp.base64, 'base64').toString('latin1').includes('/app_b1_sig/'),
        'the freshly-generated Loan Application carries the borrower signature anchor');
    }

    // ---- gate blocks when product signed BEFORE the appraisal ----------------
    await pool.query(`UPDATE checklist_items SET signed_off_at='2026-07-05T00:00:00Z' WHERE application_id=$1 AND template_id=$2`, [app, tmpl['rtl_p1_product']]);
    let blocked = false;
    try { await orchestrate.sendPackage(app, 'heter_iska', { id: null }, { db: pool, docusign, storage }); }
    catch (e) { blocked = /Not ready/.test(e.message); }
    ok(blocked, 'send is gated when P&P was signed before the appraisal');

    console.log(`\n✓ esign orchestrate + webhook: ${n} assertions passed`);
  } finally {
    await pool.end();
    await admin(`DROP DATABASE IF EXISTS ${DBNAME}`);
  }
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
