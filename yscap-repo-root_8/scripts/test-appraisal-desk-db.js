/**
 * DB test for the shared appraisal-desk flow + the two-slot appraisal-documents condition.
 * Proves: runAppraisalImport (used by BOTH the /import route and the condition auto-import)
 * imports the appraisal + materializes the review condition; and the two-slot gate logic
 * (the exact SQL signOffGate runs) requires BOTH the XML and PDF slots.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-desk-db (no DATABASE_URL)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
const FILE = 'Completed_Product_(Data)_08108509.xml';
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // point the shared db module at the same pool so require('../lib/appraisal/desk') writes here
  process.env.DATABASE_URL = process.env.DATABASE_URL;
  const { runAppraisalImport } = require('../src/lib/appraisal/desk');
  try {
    const bid = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Desk','Test',$1) RETURNING id`, [`desk-${process.pid}@example.test`])).rows[0].id;
    const appId = (await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, units, loan_type)
       VALUES ($1,$2,'Multi 2-4',3,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: '148 Plymouth St', city: 'New Haven', state: 'CT' })])).rows[0].id;

    // Materialize the appraisal-documents condition from its template (as the reconciler would).
    const item = (await pool.query(
      `INSERT INTO checklist_items (template_id, scope, label, audience, item_kind, role_scope, phase, sort_order, hint, is_required, created_by_kind, application_id)
       SELECT t.id, t.scope, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'any'), t.phase, COALESCE(t.sort_order,435), t.hint, COALESCE(t.is_required,true), 'system', $1
         FROM checklist_templates t WHERE t.code='rtl_cond_appraisaldocs' RETURNING id`, [appId])).rows[0];
    assert(!!item, 'appraisal-documents condition materialized');
    const itemId = item.id;

    const xml = fs.readFileSync(path.join(DIR, FILE), 'utf8');

    // --- slot gate BEFORE any upload: both slots missing ---
    const slotSql = `SELECT lower(coalesce(slot_label,'')) AS slot FROM documents
                      WHERE checklist_item_id=$1 AND is_current AND COALESCE(review_status,'') <> 'rejected'`;
    const hasSlot = async (needle) => (await pool.query(slotSql, [itemId])).rows.some((r) => r.slot.includes(needle));
    assert(!(await hasSlot('xml')) && !(await hasSlot('pdf')), 'gate: neither slot present at start');

    // --- upload the XML to the XML slot (as the staff upload endpoint would) ---
    const xmlDoc = (await pool.query(
      `INSERT INTO documents (application_id,checklist_item_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,slot_label,visibility)
       VALUES ($1,$2,$3,'appraisal.xml','application/xml',$4,'local','ref-xml','staff',$5,'Appraisal data file (XML)','staff_only') RETURNING id`,
      [appId, itemId, bid, Buffer.byteLength(xml), bid])).rows[0].id;

    // --- run the shared desk import (what the auto-import hook calls) ---
    const out = await runAppraisalImport({ appId, xml, importedBy: bid, xmlDocumentId: xmlDoc });
    assert(out && out.ok, 'runAppraisalImport ok');
    const appr = (await pool.query(`SELECT id, form_type, arv_value FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0];
    assert(!!appr && appr.form_type === 'FNM1025', 'appraisal row created (FNM1025)');
    const nfind = (await pool.query(`SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1`, [appId])).rows[0].n;
    assert(nfind > 0, `PILOT findings created (${nfind})`);
    const rev = (await pool.query(
      `SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='appraisal_review_cleared'`, [appId])).rows[0];
    assert(!!rev, 'appraisal_review_cleared condition materialized by the desk flow');

    // --- gate now: XML present, PDF still missing → still blocked ---
    assert((await hasSlot('xml')) && !(await hasSlot('pdf')), 'gate: XML present, PDF still missing (sign-off still blocked)');

    // --- upload the PDF slot → both present → gate clears ---
    await pool.query(
      `INSERT INTO documents (application_id,checklist_item_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,slot_label,visibility)
       VALUES ($1,$2,$3,'appraisal.pdf','application/pdf',1024,'local','ref-pdf','staff',$4,'Appraisal report (PDF)','staff_only')`,
      [appId, itemId, bid, bid]);
    assert((await hasSlot('xml')) && (await hasSlot('pdf')), 'gate: BOTH slots present → sign-off allowed');

    await pool.query(`DELETE FROM applications WHERE borrower_id=$1`, [bid]);
    await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
  } catch (e) { console.log('FAIL threw:', e.message); failures++; }
  finally { await pool.end(); }
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL desk-DB assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();
