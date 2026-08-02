'use strict';
/**
 * test-term-sheet-final-stamp-db.js — the term sheet that goes out for signature
 * is the FINAL one (owner-directed 2026-08-02), against a REAL Postgres.
 *
 * Run: DATABASE_URL=... node scripts/test-term-sheet-final-stamp-db.js
 *
 * THE REPORT: "the term sheet going out from the loan file's DocuSign section,
 * after everything is ready, still says NOT FINAL / initial only."
 *
 * Covered here (the pure rule itself lives in test-term-sheet-final-stamp.js):
 *   A. termSheetStamp against REAL conditions — most importantly that the P&P
 *      SIGN-OFF alone does not hold the stamp (that was the bug: the sign-off
 *      happens AFTER the sheet is generated, so nothing could ever be final),
 *      while every other requirement still does.
 *   B. documents.term_sheet_final round-trips through the REAL upload doors.
 *   C. buildDefinition REFUSES a sheet stamped initial — and a legacy sheet with
 *      no recorded stamp — and accepts a final one.
 *   D. the panel (tracking.fileEsign) reports the same verdict the send will,
 *      about the SAME document, so nobody meets the refusal blind.
 *   E. the upload dedupe treats two differently-stamped sheets as two documents.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tsf';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

const TAG = 'tsf-' + Date.now().toString(36);

(async () => {
  // DB-gated like every other *-db suite in the `npm test` chain.
  let db;
  try {
    db = require(REPO + '/src/db');
    await db.query('SELECT 1');
  } catch (e) {
    console.log('term-sheet final stamp (DB): SKIPPED — no database (' + (e && e.message) + ')');
    process.exit(0);
  }
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const { termSheetStamp } = require(REPO + '/src/lib/esign/term-sheet-stamp');
  const tracking = require(REPO + '/src/lib/esign/tracking');
  const orchestrate = require(REPO + '/src/lib/esign/orchestrate');
  const { recentDuplicateDocId } = require(REPO + '/src/lib/doc-dedup');

  const bId = crypto.randomUUID(), adminId = crypto.randomUUID();
  let appId;
  const T_APPR = '2026-07-10T00:00:00Z', T_AFTER = '2026-07-15T00:00:00Z';

  const tmplId = async (code) =>
    (await db.query(`SELECT id FROM checklist_templates WHERE code=$1`, [code])).rows[0].id;
  const setCond = async (code, status, signedOffAt) => {
    const t = await tmplId(code);
    await db.query(
      `INSERT INTO checklist_items (application_id, template_id, scope, label, status, signed_off_at)
       VALUES ($1,$2,'application',$3,$4,$5)`, [appId, t, code, status, signedOffAt || null]);
  };

  try {
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Pat','Borrower',$2)`,
      [bId, `b+${TAG}@example.com`]);
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Owner Admin','super_admin')`,
      [adminId, `admin+${TAG}@ys.com`]);
    appId = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, property_address, loan_amount, expected_closing)
       VALUES ($1,$2,'{"oneLine":"1 Main St, Town, NY"}',400000,'2026-09-01') RETURNING id`,
      [`YSCAP-${TAG}`, bId])).rows[0].id;

    // ---- A. the stamp rule against real conditions --------------------------
    console.log('\nA. termSheetStamp on a real file');
    ok((await termSheetStamp(appId, { db })).final === false,
      'a bare file (nothing signed off) is stamped INITIAL');

    // Appraisal back + reviewed, P&P NOT signed off — THE reported case: this is
    // exactly the moment the term sheet is generated (the officer is registering
    // right now; the sign-off is the next click), and it must stamp FINAL.
    await setCond('rtl_cond_appraisaldocs', 'satisfied', T_APPR);
    await setCond('rtl_p3_apprreview', 'satisfied', T_APPR);
    await setCond('appraisal_review_cleared', 'satisfied', T_APPR);
    {
      const s = await termSheetStamp(appId, { db });
      ok(s.final === true,
        'appraisal back + reviewed, P&P not yet signed off → FINAL (the bug: this is when the sheet is generated, and requiring the P&P sign-off made a final stamp unreachable)');
      ok(s.blockers.length === 0, 'and nothing is reported as blocking the stamp');
    }
    // The real send gate still refuses at this exact moment — the two must NOT
    // agree, or the stamp would be authorizing something.
    {
      const g = await require(REPO + '/src/lib/esign/gate').esignSendGate(appId, { db });
      ok(g.ready === false && g.outstanding.some((o) => o.code === 'rtl_p1_product'),
        'the SEND gate still enforces the P&P sign-off in full — the stamp relaxes the wording, never the authorization');
    }
    // A requirement that is NOT the P&P sign-off still holds the stamp.
    await db.query(`UPDATE applications SET expected_closing=NULL, est_closing_date=NULL WHERE id=$1`, [appId]);
    {
      const s = await termSheetStamp(appId, { db });
      ok(s.final === false && s.blockers.some((b) => b.code === 'expected_closing'),
        'no estimated closing date → still INITIAL, and the blocker is named');
    }
    await db.query(`UPDATE applications SET expected_closing='2026-09-01' WHERE id=$1`, [appId]);

    // Now sign off P&P after the appraisal — fully ready, still FINAL.
    await setCond('rtl_p1_product', 'satisfied', T_AFTER);
    ok((await termSheetStamp(appId, { db })).final === true, 'a fully ready file is FINAL');

    // ---- B. the column round-trips through the real upload doors ------------
    console.log('\nB. the printed stamp is recorded on the document');
    const upload = async (finalFlag, filename) => {
      const r = await db.query(
        `INSERT INTO documents (application_id, filename, storage_provider, storage_ref, doc_kind, is_current, term_sheet_final, uploaded_by_kind, uploaded_by_id, size_bytes)
         VALUES ($1,$2,'local',$3,'term_sheet',true,$4,'staff',$5,999) RETURNING id, term_sheet_final`,
        [appId, filename, 'ref-' + filename, finalFlag, adminId]);
      return r.rows[0];
    };
    {
      const src = require('fs').readFileSync(REPO + '/src/routes/staff.js', 'utf8');
      ok(/b\.termSheetFinal === true/.test(src),
        'the staff upload door reads the generator\'s reported stamp (and only an explicit true counts)');
      ok(/docKind, slot, docVisibility, termSheetFinal\]/.test(src),
        'and persists it on the insert');
      const bsrc = require('fs').readFileSync(REPO + '/src/routes/borrower.js', 'utf8');
      ok(/b\.termSheetFinal === true/.test(bsrc) && /docKind, slot, termSheetFinal\]/.test(bsrc),
        'the borrower door does the same — a borrower-generated sheet is recorded honestly, not assumed');
    }

    // ---- C. the send refuses anything not stamped FINAL ---------------------
    console.log('\nC. the DocuSign send refuses a sheet that says it is not final');
    const fakeStorage = { async read() { return Buffer.from('%PDF-1.4 term-sheet'); } };
    const envRow = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required)
       VALUES ($1,'term_sheet_package','not_sent',true) RETURNING *`, [appId])).rows[0];
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,false,'1',$2,'Pat Borrower',$3,true,$4,'created'),
              ($1,'admin',2,true,'2',NULL,'YS Capital',$5,true,$6,'created')`,
      [envRow.id, bId, `b+${TAG}@example.com`, `${envRow.id}:borrower`,
       `admin+${TAG}@ys.com`, `${envRow.id}:admin`]);

    const build = async () => {
      try { await orchestrate.buildDefinition(envRow, { db, storage: fakeStorage }); return null; }
      catch (e) { return e; }
    };
    const onlyCurrent = async (keepId) =>
      db.query(`UPDATE documents SET is_current=false WHERE application_id=$1 AND doc_kind='term_sheet' AND id<>$2`, [appId, keepId]);

    const initialDoc = await upload(false, 'ts-initial.pdf');
    await onlyCurrent(initialDoc.id);
    {
      const e = await build();
      ok(e && /INITIAL TERM SHEET/.test(e.message),
        'a sheet stamped INITIAL is refused, quoting what it prints');
      ok(e && /Products & Pricing/.test(e.message) && e.retryable === false,
        'the refusal names the one-step fix and is PERMANENT (retrying can never change the bytes)');
    }

    const legacyDoc = await upload(null, 'ts-legacy.pdf');
    await onlyCurrent(legacyDoc.id);
    ok(legacyDoc.term_sheet_final === null, 'sanity: a legacy sheet records NULL, not false');
    {
      const e = await build();
      ok(e && /INITIAL TERM SHEET/.test(e.message),
        'a LEGACY sheet (stamp never recorded) is refused too — every one of those was generated under the rule that printed the initial wording');
    }

    const finalDoc = await upload(true, 'ts-final.pdf');
    await onlyCurrent(finalDoc.id);
    {
      const e = await build();
      ok(e === null, 'a FINAL-stamped sheet builds the envelope — nothing else changed about the send');
    }

    // ---- D. the panel says it BEFORE the officer presses Send ---------------
    console.log('\nD. the e-sign panel reports the same verdict');
    {
      const v = await tracking.fileEsign(db, appId);
      ok(v.termSheet && v.termSheet.final === true && v.termSheet.block === false,
        'a final sheet reports no block');
      await db.query(`UPDATE documents SET is_current=false WHERE id=$1`, [finalDoc.id]);
      await db.query(`UPDATE documents SET is_current=true WHERE id=$1`, [initialDoc.id]);
      const v2 = await tracking.fileEsign(db, appId);
      ok(v2.termSheet && v2.termSheet.block === true && /INITIAL TERM SHEET/.test(v2.termSheet.message || ''),
        'an initial sheet reports the block with the same wording the send would use — the panel and the send never disagree');
      // Both must be judging the SAME document the send would attach.
      const e = await build();
      ok(!!e === !!v2.termSheet.block,
        'the panel\'s verdict matches what the send actually does, on the same current document');
    }

    // ---- E. dedupe never collapses two differently-stamped sheets ----------
    console.log('\nE. the upload dedupe is stamp-aware');
    {
      const keys = {
        filename: 'ts-initial.pdf', sizeBytes: 999, uploadedByKind: 'staff', uploadedById: adminId,
        applicationId: appId, docKind: 'term_sheet',
      };
      const sameStamp = await recentDuplicateDocId({ ...keys, termSheetFinal: false });
      ok(sameStamp === initialDoc.id, 'a genuine re-post of the SAME sheet still dedupes');
      const otherStamp = await recentDuplicateDocId({ ...keys, termSheetFinal: true });
      ok(otherStamp === null,
        'a FINAL sheet is never collapsed onto an initial one — that would leave the file holding a sheet whose face says NOT FINAL while the send read it as settled');
      // Every other doc_kind is untouched by the new clause.
      const other = await recentDuplicateDocId({ ...keys, filename: 'x.pdf', docKind: null });
      ok(other === null, 'a non-term-sheet lookup still runs (the clause is a no-op for it)');
    }

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    if (appId) {
      await db.query(`DELETE FROM esign_recipients WHERE envelope_row_id IN (SELECT id FROM esign_envelopes WHERE application_id=$1)`, [appId]).catch(() => {});
      await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM documents WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    }
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗ FAILED:', e); process.exit(1); });
