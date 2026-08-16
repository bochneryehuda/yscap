#!/usr/bin/env node
'use strict';
/* DRAW WIRE FORM — the MANUAL upload + CLEAR flow, against a real Postgres + real HTTP
 * (owner-directed 2026-08: "add an 'upload manually' option beside Send DocuSign … after sending
 * DocuSign, allow clearing it and uploading the form manually instead … the manual wire form must
 * be included in the draw investor-delivery package").
 *
 * What is pinned:
 *   A. POST /draw-request/upload-manual files a draw_request_signed (source_type='staff_upload')
 *      onto the draw condition, marks the condition 'received', and returns 201.
 *   B. the manual form satisfies the SAME money gate a DocuSign copy does: wireFormStatus reads
 *      it (needs review → accepted after the coordinator accepts it via /wire-form/review).
 *   C. the manual form is INCLUDED in the investor-delivery package (gatherAttachments,
 *      investor_direct mode) exactly like a DocuSign copy.
 *   D. supersede: a second manual upload leaves EXACTLY ONE current wire form.
 *   E. the generic staff document door, uploading onto the draw condition, ALSO tags the file
 *      draw_request_signed (belt) so it flows to investor delivery from anywhere.
 *   F. POST /draw-request/clear voids the DocuSign envelope, supersedes its signed doc and
 *      REOPENS the draw condition (the clear-then-upload flow).
 *   G. IDOR / scope: a manage_draws staffer who can't see the file is refused (403).
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-wire-manual-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';           // no real email provider — notifications no-op safely
if (!process.env.STORAGE_DIR) process.env.STORAGE_DIR = require('os').tmpdir() + '/pilot-draw-wire-test';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const investorSend = require('../src/sitewire/investor-delivery-send');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const b64 = (s) => Buffer.from(s).toString('base64');
const upload = (name) => ({ filename: name, contentType: 'application/pdf', dataBase64: b64(`%PDF-1.4 ${name} ${Math.random()}`) });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  try {
    // The draw condition template must exist for any of this to work.
    const tpl = (await db.query(`SELECT id, is_active FROM checklist_templates WHERE code='draw_cond_signed_request'`)).rows[0];
    ok('draw_cond_signed_request template exists + active', !!(tpl && tpl.is_active));

    // ---- fixtures: a super_admin, a manage_draws LO who ISN'T on the file, a funded file ----
    const superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,password_hash,token_version) VALUES ($1,'Super','super_admin',true,'x',0) RETURNING id`, [`dwm-super-${sfx}@test.local`])).rows[0].id;
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    // A PROCESSOR holds manage_draws but NOT see_all_files, and is NOT assigned to this file —
    // so the refusal below comes from canSeeFile (the file-SCOPE gate), not the permission gate
    // (a loan_officer would 403 on manage_draws first, for the wrong reason).
    const loId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,password_hash,token_version) VALUES ($1,'Proc','processor',true,'x',0) RETURNING id`, [`dwm-proc-${sfx}@test.local`])).rows[0].id;
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'processor', tv: 0 });
    const borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Wire','Payee',$1) RETURNING id`, [`dwm-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term)
       VALUES ($1,$2,$3,'funded','Purchase','Standard','12 Months') RETURNING id`,
      [borId, `YSW${String(Math.random()).slice(-9)}`,
       JSON.stringify({ oneLine: '1 Wire St, Lakewood, NJ 08701', line1: '1 Wire St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;

    const drawItem = async () => (await db.query(
      `SELECT id, status FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, `draw:request:${appId}`])).rows[0] || null;
    const currentWireDocs = async () => (await db.query(
      `SELECT id, doc_kind, source_type, review_status, is_current FROM documents
        WHERE application_id=$1 AND doc_kind='draw_request_signed' ORDER BY created_at`, [appId])).rows;

    // ---- G. scope: an unassigned processor (has manage_draws, not see_all) is refused by
    //        canSeeFile — this exercises the file-scope gate, not the permission gate. ----------
    {
      const r = await call(server, 'POST', `/api/sitewire/files/${appId}/draw-request/upload-manual`, loTok, upload('wire.pdf'));
      ok('G an unassigned staffer is refused by the file-scope gate (403)', r.status === 403);
      ok('G nothing was filed by the refused call', (await currentWireDocs()).length === 0);
      // The clear route is scope-gated the same way.
      const c = await call(server, 'POST', `/api/sitewire/files/${appId}/draw-request/clear`, loTok, {});
      ok('G the clear route is also scope-gated (403)', c.status === 403);
    }

    // ---- A. the manual upload files onto the draw condition -----------------------------------
    {
      const r = await call(server, 'POST', `/api/sitewire/files/${appId}/draw-request/upload-manual`, superTok, upload('manual-wire.pdf'));
      ok('A upload-manual returns 201', r.status === 201 && r.body && r.body.documentId);
      const docs = await currentWireDocs();
      ok('A exactly one wire form on file', docs.length === 1);
      ok('A it is a draw_request_signed', docs[0] && docs[0].doc_kind === 'draw_request_signed');
      ok('A it is provenance-tagged as a manual (staff_upload, not system)', docs[0] && docs[0].source_type === 'staff_upload');
      ok('A it is pending review', docs[0] && docs[0].review_status === 'pending');
      const item = await drawItem();
      ok('A the draw condition exists and is now received', item && item.status === 'received');
      ok('A the doc is attached to the draw condition', docs[0] && String(docs[0].id) &&
        (await db.query(`SELECT checklist_item_id FROM documents WHERE id=$1`, [docs[0].id])).rows[0].checklist_item_id != null);
    }

    // ---- B. the SAME money gate reads the manual form ----------------------------------------
    {
      const g1 = await investorSend.wireFormStatus(appId);
      ok('B money gate: the manual form is present but NOT yet accepted', g1.present === true && g1.accepted === false);
      // Accept it via the draw desk's own accept step.
      const ar = await call(server, 'POST', `/api/sitewire/files/${appId}/wire-form/review`, superTok, { action: 'accept' });
      ok('B accept returns ok', ar.status === 200 && ar.body && ar.body.ok);
      const g2 = await investorSend.wireFormStatus(appId);
      ok('B money gate: the manual form is now ACCEPTED (money can move)', g2.accepted === true);
    }

    // ---- C. the manual form is INCLUDED in the investor-delivery package ----------------------
    {
      const { items } = await investorSend.gatherAttachments(appId, 999001, 'investor_direct');
      const wire = items.find((it) => it.what === 'Signed wire instructions');
      ok('C investor delivery (investor_direct) INCLUDES the manual wire form', !!wire && wire.buf && wire.buf.length > 0);
      // And a REIMBURSEMENT delivery deliberately does NOT attach it (WE wired the borrower).
      const reimb = await investorSend.gatherAttachments(appId, 999001, 'reimbursement');
      ok('C a reimbursement delivery does NOT attach the borrower wire form', !reimb.items.find((it) => it.what === 'Signed wire instructions'));
    }

    // ---- D. supersede: a second manual upload leaves exactly one current --------------------
    {
      const r = await call(server, 'POST', `/api/sitewire/files/${appId}/draw-request/upload-manual`, superTok, upload('manual-wire-v2.pdf'));
      ok('D second manual upload returns 201', r.status === 201);
      const all = (await db.query(`SELECT is_current FROM documents WHERE application_id=$1 AND doc_kind='draw_request_signed'`, [appId])).rows;
      ok('D two wire-form rows now exist (history kept)', all.length === 2);
      ok('D exactly ONE is current', all.filter((x) => x.is_current).length === 1);
    }

    // ---- E. the generic staff document door onto the draw condition tags it AND supersedes,
    //        so exactly one wire form is current and the gate can't read green off a stale
    //        accepted copy while delivery attaches an unaccepted one (the DEFECT-1 guard) ------
    {
      // Accept the CURRENT wire form first, so there is a current ACCEPTED copy to be superseded.
      await call(server, 'POST', `/api/sitewire/files/${appId}/wire-form/review`, superTok, { action: 'accept' });
      ok('E precondition: the money gate is accepted before the conditions-list upload', (await investorSend.wireFormStatus(appId)).accepted === true);
      const item = (await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, `draw:request:${appId}`])).rows[0];
      const r = await call(server, 'POST', `/api/staff/applications/${appId}/documents`, superTok,
        { ...upload('wire-from-conditions.pdf'), checklistItemId: item.id });
      ok('E generic upload onto the draw condition returns 201', r.status === 201 && r.body && r.body.documentId);
      const doc = (await db.query(`SELECT doc_kind FROM documents WHERE id=$1`, [r.body.documentId])).rows[0];
      ok('E it is tagged draw_request_signed (so it flows to investor delivery)', doc && doc.doc_kind === 'draw_request_signed');
      const nCur = (await db.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='draw_request_signed' AND is_current`, [appId])).rows[0].n;
      ok('E EXACTLY ONE wire form is current after the conditions-list upload (supersede guard)', nCur === 1);
      ok('E the money gate is NOT green off the old accepted copy (the new current form is pending)', (await investorSend.wireFormStatus(appId)).accepted === false);
      const { items } = await investorSend.gatherAttachments(appId, 999002, 'investor_direct');
      ok('E investor delivery does NOT attach the new unaccepted wire form', !items.find((it) => it.what === 'Signed wire instructions'));
    }

    // ---- F. CLEAR a DocuSign form voids it + supersedes its doc + reopens the condition ------
    {
      // Seed a COMPLETED DocuSign draw_request package: an envelope + a signed doc bound to the
      // draw condition, condition satisfied (signed off) — the state a clear must undo.
      const item = await drawItem();
      // Reset the condition to satisfied to prove the clear reopens it.
      await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [item.id, superId]);
      // Supersede whatever is current so this seeded DocuSign copy is the single live wire form.
      await db.query(`UPDATE documents SET is_current=false WHERE application_id=$1 AND doc_kind='draw_request_signed' AND is_current=true`, [appId]);
      const env = (await db.query(
        `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required, product_version, envelope_id)
         VALUES ($1,'draw_request','completed',false,0,$2) RETURNING id`, [appId, `dwm-ENV-${sfx}`])).rows[0];
      const dsDoc = (await db.query(
        `INSERT INTO documents (application_id, checklist_item_id, filename, content_type, size_bytes, storage_provider, storage_ref,
                                uploaded_by_kind, doc_kind, source_type, visibility, is_current, review_status)
         VALUES ($1,$2,'docusign-wire.pdf','application/pdf',9,'local',$3,'staff','draw_request_signed','system','borrower',true,'accepted')
         RETURNING id`, [appId, item.id, `dwm-ds-${sfx}`])).rows[0].id;
      await db.query(
        `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id, completed_document_id)
         VALUES ($1,1,'draw_request_signed',$2,$3)`, [env.id, item.id, dsDoc]);

      const r = await call(server, 'POST', `/api/sitewire/files/${appId}/draw-request/clear`, superTok, {});
      ok('F clear returns ok', r.status === 200 && r.body && r.body.ok);
      const ds = (await db.query(`SELECT is_current, review_status FROM documents WHERE id=$1`, [dsDoc])).rows[0];
      ok('F the DocuSign signed doc was superseded (not current)', ds.is_current === false && ds.review_status === 'superseded');
      const envAfter = (await db.query(`SELECT status FROM esign_envelopes WHERE id=$1`, [env.id])).rows[0];
      ok('F the envelope is voided', envAfter.status === 'voided');
      const itemAfter = await drawItem();
      ok('F the draw condition was REOPENED (outstanding, no sign-off)', itemAfter.status === 'outstanding' &&
        (await db.query(`SELECT signed_off_at FROM checklist_items WHERE id=$1`, [item.id])).rows[0].signed_off_at === null);
      // And now nothing is sent to clear again.
      const r2 = await call(server, 'POST', `/api/sitewire/files/${appId}/draw-request/clear`, superTok, {});
      ok('F a second clear (nothing sent) returns 409', r2.status === 409);
    }

    console.log(`\n${fail ? 'FAIL' : 'PASS'} test-draw-wire-manual-db: ${pass} passed, ${fail} failed`);
  } catch (e) { console.error(e); fail++; }
  finally { server.close(); await db.pool.end().catch(() => {}); }
  process.exit(fail ? 1 : 0);
})();
