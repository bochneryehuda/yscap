/**
 * ISKA auto-clear on a loan-amount change (owner-directed 2026-07-22). Two layers:
 *   1. db/278 trigger — reopens the rtl_cond_iska condition on ANY loan-amount
 *      writer, labelled "reopened because the loan amount changed."
 *   2. app-layer autoClearIskaOnLoanChange — voids the live heter_iska DocuSign
 *      package + supersedes its signed doc (the DocuSign-side clear a trigger
 *      can't do), called from the register after-commit path.
 * Requires DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-iska-autoclear (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { autoClearIskaOnLoanChange } = require('../src/lib/esign/iska-autoclear');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The rtl_cond_iska template must exist (db/051 seeds it). Look it up; the trigger
// joins on checklist_templates.code='rtl_cond_iska'.
async function iskaTemplateId() {
  const r = await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_iska' LIMIT 1`);
  return r.rows[0] && r.rows[0].id;
}

async function seed(sfx, { loanAmount = 300000, envStatus = 'completed', signedOff = true } = {}) {
  const superId = (await db.query(
    `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
     VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`ia-super-${sfx}@test.local`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ia','Test',$1) RETURNING id`, [`ia-bo-${sfx}@test.local`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_amount) VALUES ($1,$2,'processing',$3) RETURNING id`, [borrowerId, superId, loanAmount])).rows[0].id;
  const tmpl = await iskaTemplateId();
  // The rtl_cond_iska condition, signed off, linked to its template so the trigger sees it.
  const itemId = (await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, status, signed_off_at, signed_off_by, tool_key)
     VALUES ($1,$2,'application','ISKA','satisfied',$3,$4,'iska') RETURNING id`,
    [appId, tmpl, signedOff ? new Date() : null, signedOff ? superId : null])).rows[0].id;
  const docId = (await db.query(
    `INSERT INTO documents (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
       doc_kind, review_status, is_current, source_type, visibility)
     VALUES ($1,$2,$3,'heter_iska_signed.pdf','application/pdf',1000,'heter_iska_signed','accepted',true,'system','borrower')
     RETURNING id`, [appId, borrowerId, itemId])).rows[0].id;
  const envId = (await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, created_by)
     VALUES ($1,'heter_iska',$2,$3,$4) RETURNING id`, [appId, envStatus, `ISKA-${sfx}`, superId])).rows[0].id;
  await db.query(
    `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id, completed_document_id)
     VALUES ($1,1,'heter_iska_signed',$2,$3)`, [envId, itemId, docId]);
  return { superId, borrowerId, appId, itemId, docId, envId };
}
async function cleanup(ids) {
  try { if (ids.borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [ids.borrowerId]); } catch (_) {}
  try { if (ids.superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [ids.superId]); } catch (_) {}
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const created = [];
  try {
    const tmpl = await iskaTemplateId();
    assert(!!tmpl, 'precondition: the rtl_cond_iska template exists');

    // ---- (A) db/278 trigger reopens the ISKA condition on a loan-amount change ----
    {
      const ids = await seed(`${sfx}a`, { loanAmount: 300000 }); created.push(ids);
      // Change the loan amount → the trigger should reopen the signed ISKA condition.
      await db.query(`UPDATE applications SET loan_amount=325000 WHERE id=$1`, [ids.appId]);
      const it = (await db.query(`SELECT status, signed_off_at, notes FROM checklist_items WHERE id=$1`, [ids.itemId])).rows[0];
      assert(it.status === 'outstanding' && it.signed_off_at === null, 'A: the ISKA condition reopened to outstanding on a loan-amount change');
      assert(/reopened because the loan amount changed/i.test(it.notes || ''), 'A: the reopen note says it was because the loan amount changed');
    }

    // ---- (A2) control: NO loan-amount change → the ISKA condition is NOT reopened ----
    {
      const ids = await seed(`${sfx}a2`, { loanAmount: 300000 }); created.push(ids);
      await db.query(`UPDATE applications SET status='underwriting' WHERE id=$1`, [ids.appId]); // a non-economics change
      const it = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [ids.itemId])).rows[0];
      assert(it.status === 'satisfied' && it.signed_off_at !== null, 'A2: an unrelated change does NOT reopen the ISKA condition');
    }

    // ---- (B) app-layer helper voids the live ISKA package + supersedes its signed doc ----
    {
      const ids = await seed(`${sfx}b`, { envStatus: 'completed' }); created.push(ids);
      const out = await autoClearIskaOnLoanChange({ appId: ids.appId, actorId: ids.superId, db, docusign: { voidEnvelope: async () => {} } });
      assert(out.cleared === true && out.count === 1, 'B: the helper cleared the one live Heter Iska package');
      const env = (await db.query(`SELECT status, cleared_at FROM esign_envelopes WHERE id=$1`, [ids.envId])).rows[0];
      const doc = (await db.query(`SELECT is_current, review_status FROM documents WHERE id=$1`, [ids.docId])).rows[0];
      assert(env.status === 'voided' && env.cleared_at !== null, 'B: the ISKA envelope is voided + cleared');
      assert(doc.is_current === false && doc.review_status === 'superseded', 'B: the signed ISKA doc is superseded');
    }

    // ---- (B2) a SENT (still-out) ISKA is voided at DocuSign before clearing ----
    {
      const ids = await seed(`${sfx}b2`, { envStatus: 'sent', signedOff: false }); created.push(ids);
      let voided = false;
      const out = await autoClearIskaOnLoanChange({ appId: ids.appId, actorId: ids.superId, db, docusign: { voidEnvelope: async () => { voided = true; } } });
      assert(out.cleared === true, 'B2: the helper cleared a still-out ISKA');
      assert(voided === true, 'B2: a sent ISKA is voided at DocuSign');
    }

    // ---- (C) no live ISKA → no-op ----
    {
      const superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'S','super_admin',true,false,'x',0) RETURNING id`, [`ia-c-${sfx}@test.local`])).rows[0].id;
      const borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('C','T',$1) RETURNING id`, [`ia-cb-${sfx}@test.local`])).rows[0].id;
      const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, loan_amount) VALUES ($1,$2,'processing',200000) RETURNING id`, [borrowerId, superId])).rows[0].id;
      created.push({ superId, borrowerId });
      const out = await autoClearIskaOnLoanChange({ appId, actorId: superId, db, docusign: { voidEnvelope: async () => {} } });
      assert(out.cleared === false, 'C: no live ISKA package → the helper is a no-op');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL iska-autoclear assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    for (const ids of created) await cleanup(ids);
    process.exit(failures ? 1 : 0);
  }
})();
