'use strict';
/**
 * ONE HOME FOR APPRAISAL FINDINGS — against a real database (owner-reported 2026-08-02:
 * "make sure that the appraisal findings page has ALL the appraisal findings and not some of the
 * appraisal findings is going over to the document findings section"; "appraisal findings should
 * need to be resolved before you clear the appraisal review condition").
 *
 * Proves, end to end:
 *   A. An appraisal finding stored on the DOCUMENT side (the AVM-vs-appraised-value check) is
 *      LISTED by the Appraisal page and is RESOLVABLE from it.
 *   B. The same finding is REMOVED from the document desk's own lists — including the per-section
 *      arrays, which is where a "moved" finding used to keep showing.
 *   C. The appraisal review is refused while ANY appraisal finding is open — not only a fatal one —
 *      and across BOTH tables; and it clears the moment each has an answer.
 *   D. A DERIVED advisory (an appraisal-only tie-out row) is shown but never gates: a card with no
 *      resolve button must never be able to hold a file.
 *   E. The kill switch APPRAISAL_FINDINGS_ENFORCE=0 still drops the whole thing back to advisory.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly without one.
 * Run: DATABASE_URL=... node scripts/test-appraisal-finding-home-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-finding-home-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
delete process.env.APPRAISAL_FINDINGS_ENFORCE;   // the default posture under test: ENFORCED

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const staffRoutes = require('../src/routes/staff');
const store = require('../src/lib/underwriting/store');
const subject = require('../src/lib/appraisal/finding-subject');

let failures = 0, n = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const tag = `${process.pid}${Date.now()}`;

async function seedFile() {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Home','Finding',$1) RETURNING id`,
    [`fhome_${tag}_${Math.random().toString(36).slice(2, 8)}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, status, purchase_price, as_is_value, arv, submitted_at)
     VALUES ($1,'underwriting',300000,280000,450000,'2026-07-01') RETURNING id`, [bor.id])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function attach(appId, code) {
  return (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'underwriter'),
            t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0].id;
}

(async () => {
  await ensureSchema();
  const cleanupApps = [], cleanupBors = [];
  try {
    const staff = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'Finding Home','underwriter',true) RETURNING id`, [`fh_${tag}@test.local`])).rows[0];

    // ---- the file: a current appraisal, an As-Is the human has confirmed, and the review condition
    const { appId, borId } = await seedFile();
    cleanupApps.push(appId); cleanupBors.push(borId);
    const apprId = (await db.query(
      `INSERT INTO appraisals (application_id, superseded, form_type, arv_value, as_is_value, fields, imported_at)
       VALUES ($1,false,'FNM1004',450000,280000,'{}',now()) RETURNING id`, [appId])).rows[0].id;
    const reviewId = await attach(appId, 'appraisal_review_cleared');
    // The As-Is prerequisite: confirm-condition signed off, and a real value on the file.
    const asIsItem = await attach(appId, 'appraisal_as_is_verify');
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [asIsItem, staff.id]);

    const gate = () => staffRoutes.signOffGate(reviewId, { id: staff.id, role: 'underwriter' });
    ok(!(await gate()), 'baseline: a clean appraised file with a confirmed As-Is clears the appraisal review');

    // ============ A/B. an appraisal finding stored on the DOCUMENT side ============
    const avmId = (await db.query(
      `INSERT INTO document_findings
         (application_id, borrower_id, source, code, severity, field, doc_value, file_value, title, how_to, blocks_ctc, status)
       VALUES ($1,$2,'avm_consensus','avm_consensus_disagreement','warning','appraisal.arv',
               'AVM median $402,000','Appraisal ARV $450,000','AVM consensus disagrees with the appraisal ARV',
               'Order a desk review.',false,'open') RETURNING id`, [appId, borId])).rows[0].id;

    ok(subject.isAppraisalSubject({ source: 'avm_consensus' }) === true,
      'A: the shared predicate claims the AVM finding for the Appraisal page');

    // The APPRAISAL route lists it…
    const deskList = await require('../src/routes/appraisal')._deskAppraisalFindings(appId);
    const listed = deskList.find((f) => String(f.id) === String(avmId));
    ok(!!listed, 'A: the Appraisal page lists the AVM finding');
    ok(listed && listed.resolvable === true, 'A: …and offers to resolve it (it has a real stored row)');

    // …and the DOCUMENT desk does not: the same predicate is what removes it there, so the two
    // screens are one decision, not two lists that can drift.
    const deskRow = (await db.query(`SELECT * FROM document_findings WHERE id=$1`, [avmId])).rows[0];
    ok(subject.split([deskRow]).document.length === 0 && subject.split([deskRow]).appraisal.length === 1,
      'B: the document desk drops it from its lists (same predicate, opposite side)');

    // ============ C. the gate counts EVERY open appraisal finding ============
    let msg = await gate();
    ok(/open appraisal finding/i.test(String(msg || '')),
      'C: a WARNING appraisal finding on the document side holds the appraisal review');

    // Resolve it through the Appraisal page's own path (the document desk's resolution machinery).
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await store.resolveFinding(client, { findingId: avmId, action: 'dismiss', by: staff.id });
      await client.query('COMMIT');
    } finally { client.release(); }
    ok(!(await gate()), 'C: …and the review clears once it has an answer');

    // The appraisal desk's OWN warning holds it too (this is the half that was never enforced).
    const warnId = (await db.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
       VALUES ($1,$2,'appraisal','comp_distance','warning','open',false,'comps are far away') RETURNING id`,
      [apprId, appId])).rows[0].id;
    msg = await gate();
    ok(/open appraisal finding/i.test(String(msg || '')), 'C: an appraisal-desk WARNING holds the review (not only fatals)');
    ok(!/fatal/i.test(String(msg || '')), 'C: …and the message does not call a warning a dealbreaker');

    // A FATAL still gets the dealbreaker wording (the 2026-07-30 behaviour is intact).
    await db.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
       VALUES ($1,$2,'appraisal','address_mismatch','fatal','open',true,'wrong property')`, [apprId, appId]);
    msg = await gate();
    ok(/fatal/i.test(String(msg || '')), 'C: a fatal is still reported as a fatal, ahead of the warnings');
    await db.query(`UPDATE appraisal_findings SET status='dismissed' WHERE application_id=$1 AND severity='fatal'`, [appId]);
    await db.query(`UPDATE appraisal_findings SET status='resolved' WHERE id=$1`, [warnId]);
    ok(!(await gate()), 'C: with every finding answered on both tables, the review clears');

    // ============ D. a DERIVED advisory is shown but never gates ============
    // The tie-out is recomputed from the file's own data, so it is represented here the way the
    // route hands it to the page: no id, resolvable:false. It must not appear in the gate's count.
    const { appraisalCompleteness } = require('../src/lib/underwriting/appraisal-advisory');
    const comp = await appraisalCompleteness(db, appId);
    ok(comp.openFindings === 0 && comp.complete === true,
      'D: the advisory badge counts only answerable findings, and agrees with the gate');
    ok(subject.isAppraisalSubject({ source: 'tie_out', sources: [{ kind: 'file' }, { kind: 'document', docType: 'appraisal' }] }) === true,
      'D: an appraisal-only tie-out row is still ROUTED to the Appraisal page (shown, just not gating)');

    // ============ E. the kill switch ============
    await db.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
       VALUES ($1,$2,'appraisal','comp_pool_thin','warning','open',false,'thin pool')`, [apprId, appId]);
    ok(!!(await gate()), 'E: control — the fresh warning holds the review again');
    process.env.APPRAISAL_FINDINGS_ENFORCE = '0';
    ok(!(await gate()), 'E: APPRAISAL_FINDINGS_ENFORCE=0 drops the whole gate back to advisory');
    delete process.env.APPRAISAL_FINDINGS_ENFORCE;
    ok(!!(await gate()), 'E: …and unsetting it re-arms enforcement');

    // ============ F. the DATA COMPARISON survives the finding ============
    // (owner-directed 2026-08-02: "the data-comparison table should still show the data comparison
    // of the appraisal even if the flag is already raised on the appraisal findings screen".)
    // The appraisal disagrees with the file on ARV, as-is, units and the address — every one of
    // which is now suppressed as a duplicate FINDING because the appraisal desk owns it. The
    // comparison must still state all of them, side by side.
    await db.query(
      `UPDATE appraisals SET arv_value=520000, as_is_value=240000, units=4, property_type='Condominium',
              subject_address='999 Elsewhere Rd', subject_city='Springfield', subject_state='MA', subject_zip='01109'
        WHERE id=$1`, [apprId]);
    await db.query(
      `UPDATE applications SET units=2, property_type='Multi 2-4',
              property_address='{"line1":"76 Thompson St","city":"Springfield","state":"MA","zip":"01109"}'::jsonb
        WHERE id=$1`, [appId]);
    const cmp = await require('../src/routes/appraisal')._appraisalComparison(appId);
    ok(!!cmp && Array.isArray(cmp.rows) && cmp.rows.length > 0, 'F: the appraisal has a data comparison');
    const row = (k) => cmp.rows.find((r) => r.key === k);
    for (const k of ['arv', 'as_is_value', 'units', 'property_type', 'property_address']) {
      const r = row(k);
      ok(!!r, `F: "${k}" is in the comparison — a fact the appraisal desk owns is still COMPARED`);
      ok(r && r.appraisalValue != null && String(r.appraisalValue).trim() !== '',
        `F: …and the appraisal's own ${k} is shown`);
    }
    ok(row('arv') && row('arv').status === 'disagree' && row('arv').fileValue != null,
      'F: a real disagreement reads as "differs", with BOTH numbers — the finding moving never hid it');
    ok(cmp.summary && cmp.summary.disagree > 0, 'F: the summary counts what differs');
    // A fact the appraisal cannot carry is not padded into the table.
    ok(!cmp.rows.some((r) => r.key === 'borrower_dob'), 'F: facts the appraisal never states are left out');

    // ============ G. photos carried IN the XML are stored, labelled, photographs first ============
    // (owner-directed 2026-08-02: "I'm sure that the XML does carry some photos … do further
    // digging".) No existing test exercised this storage path, and it writes real documents.
    {
      const { encodePng } = require('../src/lib/appraisal/photos');
      const png = (r, g, b) => encodePng(Buffer.alloc(8 * 8 * 3).map((_, i) => [r, g, b][i % 3]), 8, 8, 3);
      // Deliberately out of order: the EXHIBIT (a licence page — not a photograph) comes FIRST in
      // the document, exactly like the signature page that started all this.
      const xmlPhotos = `<?xml version="1.0"?><VALUATION_RESPONSE><REPORT>
        <FORM AppraisalReportContentType="Exhibit"><IMAGE _Name="HasImage" _Identifier="Exhibit">
          <EMBEDDED_FILE _Type="PNG" MIMEType="image/png"><DOCUMENT>${png(250, 250, 250).toString('base64')}</DOCUMENT></EMBEDDED_FILE>
        </IMAGE></FORM>
        <FORM AppraisalReportContentType="SubjectPhotos"><IMAGE _Name="HasImage" _Identifier="SubjectFront" _CaptionComment="76 Thompson St">
          <EMBEDDED_FILE _Type="PNG" MIMEType="image/png"><DOCUMENT>${png(120, 170, 90).toString('base64')}</DOCUMENT></EMBEDDED_FILE>
        </IMAGE></FORM></REPORT></VALUATION_RESPONSE>`;
      const n = await require('../src/lib/appraisal/desk')
        .extractAndStorePhotos(apprId, appId, null, staff.id, xmlPhotos);
      ok(n === 2, 'G: both images carried in the XML are stored (no PDF needed at all)');
      const rows = (await db.query(
        `SELECT ap.sequence, ap.category, ap.caption, d.content_type, d.filename
           FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
          WHERE ap.appraisal_id=$1 AND ap.document_id IS NOT NULL ORDER BY ap.sequence`, [apprId])).rows;
      ok(rows.length === 2, 'G: …and both are on the gallery');
      ok(rows[0] && rows[0].category === 'subject_front',
        'G: the SUBJECT FRONT shot is photo #1 — ahead of the exhibit that came first in the file');
      ok(rows[0] && rows[0].caption === '76 Thompson St', 'G: the appraiser’s own caption is kept');
      ok(rows[1] && rows[1].category === 'exhibit', 'G: the exhibit is kept, labelled, and last');
      ok(rows.length === 2 && rows.every((r) => r.content_type === 'image/png' && /\.png$/.test(r.filename)),
        'G: the image is stored in its OWN format, not re-encoded');
    }

    await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff.id]).catch(() => {});
  } finally {
    for (const id of cleanupApps) await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {});
    for (const id of cleanupBors) await db.query(`DELETE FROM borrowers WHERE id=$1`, [id]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\nFAILED (${failures}/${n})` : `\nOK  appraisal-finding-home-db: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
