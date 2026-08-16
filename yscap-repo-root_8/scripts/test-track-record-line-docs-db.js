#!/usr/bin/env node
'use strict';
/* TRACK RECORD — LINE-ITEM DOCUMENTS end to end (owner-directed 2026-08, Task B+C+D+E):
 *   "Request a document on a line must CREATE a real condition (staff internal+external AND
 *    borrower see it); anything uploaded to that condition FLOWS BACK as a document into that
 *    line. Staff can add MULTIPLE documents per line; the borrower can still upload to lines.
 *    All line-item docs go into the TPR export AND the SharePoint sync REO folder."
 *
 * This pins the whole chain against a real DB + real HTTP, so a future regression is caught:
 *   A. request-doc creates a both-audience document condition tagged with the line (track_record_id).
 *   B. a STAFF upload onto the line flows back (track_record_id set) + attaches to the request
 *      condition + marks it received; MULTIPLE docs live on one line.
 *   C. a BORROWER upload onto the line flows back too (audience-scoped to a borrower/both request).
 *   D. accepted line docs are selected by the TPR export (selectTrackRecordDocs).
 *   E. SharePoint files a line doc under REO/<property> at the borrower-profile level.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-line-docs-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';
if (!process.env.STORAGE_DIR) process.env.STORAGE_DIR = require('os').tmpdir() + '/pilot-tr-line-docs-test';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const tpr = require('../src/lib/tpr-export');
const sp = require('../src/lib/sharepoint-backup');
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
const upload = (name, extra) => ({ filename: name, contentType: 'application/pdf', dataBase64: b64(`%PDF-1.4 ${name} ${Math.random()}`), ...(extra || {}) });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  try {
    // ---- fixtures: a super_admin (sees all), a borrower + login, a flip line, a file --------
    const superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,password_hash,token_version) VALUES ($1,'Super','super_admin',true,'x',0) RETURNING id`, [`trl-super-${sfx}@test.local`])).rows[0].id;
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Track','Record',$1) RETURNING id`, [`trl-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0) ON CONFLICT (borrower_id) DO NOTHING`, [borId]);
    const borTok = C.signJwt({ sub: borId, kind: 'borrower', tv: 0 });
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date)
       VALUES ($1,'{"line1":"62 Highland St","city":"Lakewood","state":"NJ","zip":"08701"}'::jsonb,'flip','2024-02-01','2025-06-15')
       RETURNING id`, [borId])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term, loan_officer_id)
       VALUES ($1,$2,'{"oneLine":"9 New Deal Rd, Lakewood, NJ 08701"}'::jsonb,'underwriting','Purchase','Standard','12 Months',$3) RETURNING id`,
      [borId, `YST${String(Math.random()).slice(-9)}`, superId])).rows[0].id;

    const lineDocs = async () => (await db.query(
      `SELECT id, track_record_id, checklist_item_id, review_status, uploaded_by_kind, doc_kind, is_current
         FROM documents WHERE track_record_id=$1 AND is_current ORDER BY created_at`, [trId])).rows;

    // ---- A. request a document ON the line → a real both-audience condition tagged with it ----
    let condId;
    {
      const r = await call(server, 'POST', `/api/staff/track-records/${trId}/request-doc`, superTok,
        { applicationId: appId, docType: 'closing_statement', pillar: 'exit' });
      ok('A request-doc returns 200', r.status === 200 && r.body && r.body.itemId);
      condId = r.body && r.body.itemId;
      const cond = (await db.query(
        `SELECT audience, item_kind, track_record_id, is_required, application_id, status FROM checklist_items WHERE id=$1`, [condId])).rows[0];
      ok('A the condition is audience=both (staff internal+external AND borrower see it)', cond && cond.audience === 'both');
      ok('A the condition is a document condition on the file', cond && cond.item_kind === 'document' && String(cond.application_id) === String(appId));
      ok('A the condition is TAGGED with the line (track_record_id) so uploads flow back', cond && String(cond.track_record_id) === String(trId));
    }

    // ---- B. a STAFF upload onto the line flows back + attaches to the request + multi-doc ----
    {
      const r1 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents`, superTok, upload('closing-statement.pdf', { docType: 'closing_statement' }));
      ok('B staff upload #1 returns 201', r1.status === 201 && r1.body && r1.body.documentId);
      const r2 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents`, superTok, upload('recorded-deed.pdf', { docType: 'deed' }));
      ok('B staff upload #2 returns 201 (MULTIPLE docs per line)', r2.status === 201 && r2.body && r2.body.documentId);
      const docs = await lineDocs();
      ok('B both staff docs are on the line (track_record_id set)', docs.length === 2 && docs.every((d) => String(d.track_record_id) === String(trId)));
      const attached = docs.find((d) => String(d.checklist_item_id) === String(condId));
      ok('B a staff upload attached to the open request condition (flows back to the ask)', !!attached);
      const cond = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [condId])).rows[0];
      ok('B the request condition moved to received once a document arrived', cond && cond.status === 'received');
    }

    // ---- C. a BORROWER upload onto the same line flows back too -------------------------------
    {
      const r = await call(server, 'POST', `/api/borrower/track-records/${trId}/documents`, borTok, upload('borrower-lease.pdf', { docType: 'lease' }));
      ok('C borrower upload returns 201', r.status === 201 && r.body && r.body.documentId);
      const docs = await lineDocs();
      ok('C the borrower doc is on the line too (track_record_id set)', docs.length === 3 && docs.some((d) => d.uploaded_by_kind === 'borrower' && String(d.track_record_id) === String(trId)));
    }

    // ---- D. accepted line docs are selected by the TPR export --------------------------------
    {
      // Accept every current line doc through the shared review door.
      const docs = await lineDocs();
      for (const d of docs) {
        const rv = await call(server, 'POST', `/api/staff/documents/${d.id}/review`, superTok, { action: 'accept' });
        ok(`D accept doc ${d.doc_kind || ''} returns 200`, rv.status === 200);
      }
      const sel = await tpr.selectTrackRecordDocs([trId]);
      ok('D the TPR export selects the accepted line docs', Array.isArray(sel) && sel.length === 3);
      ok('D TPR selection is scoped to THIS line', sel.every((d) => String(d.track_record_id) === String(trId)));
    }

    // ---- E. SharePoint files a line doc under REO/<property> at the borrower level -----------
    {
      const row = { doc_kind: 'track_record_doc', track_record_id: trId, borrower_id: borId,
        tr_address: '62 Highland St, Lakewood, NJ', app_id: appId };
      const cat = sp.categoryPathFor(row);
      ok('E SharePoint files a line doc under REO/<property>', Array.isArray(cat) && cat[0] === 'REO' && /Highland/.test(cat[1]));
      ok('E SharePoint scopes the REO tree to the BORROWER (one tree per person, not per file)',
        sp.scopeKeyFor(row) === `borrower:${borId}`);
    }

    console.log(`\n${fail ? 'FAIL' : 'PASS'} test-track-record-line-docs-db: ${pass} passed, ${fail} failed`);
  } catch (e) { console.error(e); fail++; }
  finally { server.close(); await db.pool.end().catch(() => {}); }
  process.exit(fail ? 1 : 0);
})();
