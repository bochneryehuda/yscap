/**
 * CLEAR a DocuSign package (owner-directed 2026-07-22). Clearing a sent/signed
 * package must, in ONE atomic move: void it at DocuSign (only if it's still out
 * for signature — a completed one can't be voided there), supersede its signed
 * document(s) (soft — never hard-delete), reopen exactly THIS package's
 * condition(s), and stamp the envelope cleared (status→voided + cleared_* audit).
 *
 * Proves: the completed path (no DocuSign void), the sent path (void called),
 * per-package isolation, and the not-clearable guard. Requires DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-esign-clear (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { clearPackage, CLEARABLE_STATUSES } = require('../src/lib/esign/clear');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Build one file with a signed package on a condition. `status` seeds the
// envelope state; returns the ids so each scenario is fully isolated.
async function seed(sfx, { envStatus, purpose = 'term_sheet_package', itemStatus = 'satisfied', signedOff = true }) {
  const superId = (await db.query(
    `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
     VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`ec-super-${sfx}@test.local`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ec','Test',$1) RETURNING id`, [`ec-bo-${sfx}@test.local`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, superId])).rows[0].id;
  // The condition THIS package satisfied — signed off by a human, as it would be post-completion.
  const itemId = (await db.query(
    `INSERT INTO checklist_items (application_id, scope, label, status, signed_off_at, signed_off_by, reviewed_at, reviewed_by, notes, tool_key)
     VALUES ($1,'application','Signed term sheet',$2,$3,$4,$5,$6,'Signed off after the term sheet came back.','signed_term_sheet')
     RETURNING id`,
    [appId, itemStatus, signedOff ? new Date() : null, signedOff ? superId : null, signedOff ? new Date() : null, signedOff ? superId : null])).rows[0].id;
  // The stored signed PDF, current + accepted.
  const docId = (await db.query(
    `INSERT INTO documents (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
       doc_kind, review_status, is_current, source_type, visibility)
     VALUES ($1,$2,$3,'term_sheet_signed.pdf','application/pdf',1234,'term_sheet_package_signed','accepted',true,'system','borrower')
     RETURNING id`, [appId, borrowerId, itemId])).rows[0].id;
  const envId = (await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [appId, purpose, envStatus, `ENV-${sfx}`, superId])).rows[0].id;
  await db.query(
    `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id, completed_document_id, cleared_at)
     VALUES ($1,1,'term_sheet_package_signed',$2,$3, now())`, [envId, itemId, docId]);
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
    // ---- (A) COMPLETED (fully signed) package: cleared on OUR side, DocuSign NOT voided ----
    {
      const ids = await seed(`${sfx}a`, { envStatus: 'completed' }); created.push(ids);
      let voidCalled = false;
      const docusign = { voidEnvelope: async () => { voidCalled = true; } };
      const out = await clearPackage({ rowId: ids.envId, actorId: ids.superId, reason: 'Restructuring the deal', db, docusign });
      assert(out.ok === true, 'A: clear returns ok');
      assert(voidCalled === false, 'A: a COMPLETED package is NOT voided at DocuSign (it can\'t be) — cleared our side only');
      assert(out.voided === false, 'A: out.voided is false for a completed package');
      assert(out.docsCleared === 1, 'A: the one signed document was superseded');
      assert((out.conditionsReopened || []).length === 1, 'A: the one condition was reopened');

      const doc = (await db.query(`SELECT is_current, review_status FROM documents WHERE id=$1`, [ids.docId])).rows[0];
      assert(doc.is_current === false && doc.review_status === 'superseded', 'A: the signed document is superseded (is_current=false, superseded) — off the file but kept for history');
      const item = (await db.query(`SELECT status, signed_off_at, signed_off_by, reviewed_at, notes FROM checklist_items WHERE id=$1`, [ids.itemId])).rows[0];
      assert(item.status === 'outstanding', 'A: the condition reopened to outstanding');
      assert(item.signed_off_at === null && item.signed_off_by === null && item.reviewed_at === null, 'A: every sign-off / review stamp cleared');
      assert(/\[auto\] Reopened — the Term Sheet DocuSign package was cleared\./.test(item.notes || ''), 'A: an [auto] reopened note was appended');
      const env = (await db.query(`SELECT status, cleared_at, cleared_by, clear_reason, voided_at FROM esign_envelopes WHERE id=$1`, [ids.envId])).rows[0];
      assert(env.status === 'voided', 'A: the envelope is terminal (status=voided) — frees the send-once guard + lifts the term-sheet freeze');
      assert(env.cleared_at !== null && env.cleared_by === ids.superId && env.clear_reason === 'Restructuring the deal', 'A: cleared_at / cleared_by / clear_reason recorded (a CLEAR, not an ordinary void)');
      const edoc = (await db.query(`SELECT completed_document_id FROM esign_envelope_docs WHERE envelope_row_id=$1`, [ids.envId])).rows[0];
      assert(edoc.completed_document_id === null, 'A: the signed artifact is detached from the envelope-doc map');
    }

    // ---- (B) SENT (still out for signature) package: DocuSign IS voided ----
    {
      const ids = await seed(`${sfx}b`, { envStatus: 'sent' }); created.push(ids);
      let voidArgs = null;
      const docusign = { voidEnvelope: async (eid, reason) => { voidArgs = { eid, reason }; } };
      const out = await clearPackage({ rowId: ids.envId, actorId: ids.superId, reason: 'Wrong numbers', db, docusign });
      assert(out.voided === true, 'B: a SENT package IS voided at DocuSign before clearing');
      assert(voidArgs && voidArgs.eid === `ENV-${sfx}b` && voidArgs.reason === 'Wrong numbers', 'B: voidEnvelope called with the envelope id + reason');
      const env = (await db.query(`SELECT status, cleared_at FROM esign_envelopes WHERE id=$1`, [ids.envId])).rows[0];
      assert(env.status === 'voided' && env.cleared_at !== null, 'B: envelope cleared + voided');
    }

    // ---- (C) DocuSign void FAILS for a real reason → nothing changes ----
    {
      const ids = await seed(`${sfx}c`, { envStatus: 'sent' }); created.push(ids);
      const docusign = { voidEnvelope: async () => { throw new Error('network is down'); } };
      let threw = false;
      try { await clearPackage({ rowId: ids.envId, actorId: ids.superId, reason: 'x', db, docusign }); }
      catch (e) { threw = true; assert(e.status === 502, 'C: a genuine DocuSign failure surfaces as 502'); }
      assert(threw, 'C: clear throws when DocuSign can\'t void (nothing half-done)');
      const doc = (await db.query(`SELECT is_current FROM documents WHERE id=$1`, [ids.docId])).rows[0];
      const env = (await db.query(`SELECT status FROM esign_envelopes WHERE id=$1`, [ids.envId])).rows[0];
      assert(doc.is_current === true, 'C: the signed document is untouched after a failed void');
      assert(env.status === 'sent', 'C: the envelope is untouched after a failed void');
    }

    // ---- (D) DocuSign says "already voided/terminal" → we proceed to clear our side ----
    {
      const ids = await seed(`${sfx}d`, { envStatus: 'sent' }); created.push(ids);
      const docusign = { voidEnvelope: async () => { throw new Error('Envelope is already Voided'); } };
      const out = await clearPackage({ rowId: ids.envId, actorId: ids.superId, reason: 'x', db, docusign });
      assert(out.ok === true && out.docsCleared === 1, 'D: an already-terminal DocuSign envelope still clears our side (idempotent)');
    }

    // ---- (E) NOT clearable (not_sent / voided / declined / error) → 409, no changes ----
    for (const st of ['not_sent', 'voided', 'declined', 'error']) {
      const ids = await seed(`${sfx}e-${st}`, { envStatus: st }); created.push(ids);
      let threw = false;
      try { await clearPackage({ rowId: ids.envId, actorId: ids.superId, reason: 'x', db, docusign: { voidEnvelope: async () => {} } }); }
      catch (e) { threw = true; assert(e.status === 409, `E: a "${st}" package can't be cleared (409)`); }
      assert(threw, `E: clear refuses a "${st}" package`);
      const doc = (await db.query(`SELECT is_current FROM documents WHERE id=$1`, [ids.docId])).rows[0];
      assert(doc.is_current === true, `E: the document is untouched for a "${st}" package`);
    }
    assert(JSON.stringify(CLEARABLE_STATUSES) === JSON.stringify(['sent', 'delivered', 'completed']), 'E: only sent/delivered/completed are clearable');

    // ---- (F) per-package ISOLATION: clearing the Term Sheet does NOT reopen the Heter Iska ----
    {
      const ids = await seed(`${sfx}f`, { envStatus: 'completed', purpose: 'term_sheet_package' }); created.push(ids);
      // A SECOND, independent Heter Iska package + its own signed-off condition on the SAME file.
      const iskaItem = (await db.query(
        `INSERT INTO checklist_items (application_id, scope, label, status, signed_off_at, signed_off_by, tool_key)
         VALUES ($1,'application','Heter Iska','satisfied',now(),$2,'iska') RETURNING id`, [ids.appId, ids.superId])).rows[0].id;
      const iskaEnv = (await db.query(
        `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id) VALUES ($1,'heter_iska','completed',$2) RETURNING id`, [ids.appId, `ISKA-${sfx}f`])).rows[0].id;
      await db.query(`INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id) VALUES ($1,1,'heter_iska_signed',$2)`, [iskaEnv, iskaItem]);

      await clearPackage({ rowId: ids.envId, actorId: ids.superId, reason: 'restructure', db, docusign: { voidEnvelope: async () => {} } });
      const tsItem = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [ids.itemId])).rows[0];
      const iska = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [iskaItem])).rows[0];
      const iskaE = (await db.query(`SELECT status FROM esign_envelopes WHERE id=$1`, [iskaEnv])).rows[0];
      assert(tsItem.status === 'outstanding', 'F: clearing the Term Sheet reopened the term-sheet condition');
      assert(iska.status === 'satisfied' && iska.signed_off_at !== null, 'F: the Heter Iska condition is UNTOUCHED (per-package isolation)');
      assert(iskaE.status === 'completed', 'F: the Heter Iska envelope is UNTOUCHED');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL esign-clear assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    for (const ids of created) await cleanup(ids);
    process.exit(failures ? 1 : 0);
  }
})();
