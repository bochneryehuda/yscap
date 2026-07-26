'use strict';
/**
 * App-less TEST envelope completion now STORES + DISPLAYS the signed PDFs + the
 * Certificate of Completion (owner-directed 2026-07-20: "send myself a test" must
 * prove the whole chain). handleCompletion used to bail on an app-less envelope, so
 * a self-test showed nothing; now it stores the signed copies staff-only (no borrower,
 * no condition, never SharePoint/TPR) and tracking.dashboard attaches them so the
 * cockpit shows the signed PDFs + certificate for the test envelope too.
 * Run: DATABASE_URL=... node scripts/test-esign-selftest-artifacts.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-selftest';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const webhook = require(REPO + '/src/lib/esign/webhook');
const tracking = require(REPO + '/src/lib/esign/tracking');
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// Fakes: DocuSign returns signed bytes + a certificate; storage keeps bytes in memory.
const ENV = 'ENV-selftest-' + Date.now().toString(36);
const fakeDocusign = {
  getDocument: async () => Buffer.from('%PDF-1.4 signed-test-doc'),
  getCertificate: async () => Buffer.from('%PDF-1.4 certificate-of-completion'),
};
const store = new Map();
const fakeStorage = { save: async (buf, { filename } = {}) => { const ref = 'ref-' + uuid(); store.set(ref, { buf, filename }); return { ref, provider: 'local' }; } };

async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const envRowId = uuid();
  try {
    // An app-less TEST envelope (application_id NULL) that already "sent" + has its
    // per-document rows seeded (the term-sheet package's 3 docs).
    await db.query(
      `INSERT INTO esign_envelopes (id, application_id, is_test, test_label, purpose, status, envelope_id, countersign_required)
       VALUES ($1, NULL, true, 'Self-test', 'term_sheet_package', 'sent', $2, true)`, [envRowId, ENV]);
    for (const [i, kind] of [[1, 'term_sheet_signed'], [2, 'application_signed'], [3, 'bp_disclosure_signed']]) {
      await db.query(
        `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id)
         VALUES ($1, $2, $3, NULL)`, [envRowId, i, kind]);
    }
    const envRow = (await db.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [envRowId])).rows[0];

    // Complete it (what the webhook/poller do when the borrower finishes signing).
    await webhook.handleCompletion(db, fakeDocusign, fakeStorage, envRow);

    // Signed PDFs stored — app-less (application_id NULL), staff-only, current.
    const signed = (await db.query(
      `SELECT doc_kind, application_id, visibility, is_current FROM documents
        WHERE filename LIKE $1 AND doc_kind LIKE '%_signed' ORDER BY doc_kind`, [`%${ENV}.pdf`])).rows;
    ok(signed.length === 3, 'all 3 signed PDFs stored for the self-test');
    ok(signed.every((d) => d.application_id === null), 'signed test copies have NO application_id (app-less)');
    ok(signed.every((d) => d.visibility === 'staff_only'), 'signed test copies are staff-only');
    ok(signed.every((d) => d.is_current === true), 'signed test copies are current');

    // The app-less test docs are settled OUT of the SharePoint mirror's pending
    // population (no file/borrower to mirror under) — never left backed_up_at NULL,
    // which would trip a permanent mirror backlog / health-SLO alert.
    const mirror = (await db.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE sharepoint_backed_up_at IS NOT NULL AND sharepoint_skipped_reason IS NOT NULL)::int settled
         FROM documents WHERE filename LIKE $1 OR filename=$2`,
      [`%${ENV}.pdf`, `esign_certificate_${ENV}.pdf`])).rows[0];
    ok(mirror.total === 4 && mirror.settled === 4, 'all self-test docs are settled out of the SharePoint mirror queue (no stuck backlog)');

    // Certificate stored (staff-only, app-less).
    const cert = (await db.query(
      `SELECT application_id, visibility FROM documents WHERE doc_kind='esign_certificate' AND filename=$1`,
      [`esign_certificate_${ENV}.pdf`])).rows;
    ok(cert.length === 1 && cert[0].application_id === null && cert[0].visibility === 'staff_only',
      'certificate stored for the self-test (staff-only, app-less)');

    // envelope_docs stamped with the stored copies.
    const mapped = (await db.query(
      `SELECT count(*)::int n FROM esign_envelope_docs WHERE envelope_row_id=$1 AND completed_document_id IS NOT NULL`, [envRowId])).rows[0].n;
    ok(mapped === 3, 'each package document maps to its stored signed copy');

    // Idempotent: re-running stores nothing new.
    await webhook.handleCompletion(db, fakeDocusign, fakeStorage, envRow);
    const again = (await db.query(`SELECT count(*)::int n FROM documents WHERE filename LIKE $1`, [`%${ENV}.pdf`])).rows[0].n;
    ok(again === 4, 'idempotent — re-completion adds no duplicate docs (3 signed + 1 cert)');

    // The cockpit read model attaches them to the test envelope.
    const { envelopes } = await tracking.dashboard(db, { where: 'AND e.id = $1', params: [envRowId] });
    const e = envelopes.find((x) => x.id === envRowId);
    ok(e && (e.documents || []).length === 3, 'cockpit shows the 3 signed PDFs on the test envelope');
    ok(e && e.certificate && /esign_certificate_/.test(e.certificate.filename), 'cockpit shows the certificate on the test envelope');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    await db.query(`DELETE FROM documents WHERE filename LIKE $1 OR filename=$2`, [`%${ENV}.pdf`, `esign_certificate_${ENV}.pdf`]).catch(() => {});
    await db.query(`DELETE FROM esign_envelope_docs WHERE envelope_row_id=$1`, [envRowId]).catch(() => {});
    await db.query(`DELETE FROM esign_envelopes WHERE id=$1`, [envRowId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
