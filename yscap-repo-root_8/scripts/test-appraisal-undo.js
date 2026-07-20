/**
 * Appraisal XML auto-build surfacing (#7) + import undo/delete (#8),
 * owner-directed 2026-07-20.
 *   (7) an XML dropped on the appraisal-documents condition auto-runs the import
 *       and the upload RESPONSE surfaces the result (so the UI shows findings /
 *       an error — no separate re-import).
 *   (8) POST /api/appraisal/:id/undo-import clears the findings + imported
 *       appraisal data, resets the two internal conditions + source documents,
 *       and restores the file fields the import blank-filled.
 * Requires DATABASE_URL; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-undo (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cnt = async (sql, p) => (await db.query(sql, p)).rows[0].n;

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  let adminId, borrowerId;
  try {
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    adminId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'A','super_admin',true,false,'x',0) RETURNING id`, [`au-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Au','Test',$1) RETURNING id`, [`au-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id,loan_officer_id,status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, adminId])).rows[0].id;

    // ---- (7) auto-import surfacing: upload a (bad) XML to the appraisal-docs XML slot ----
    // Materialize the appraisal-documents condition, then upload to its XML slot.
    const tpl = (await db.query(`SELECT id, item_kind, label FROM checklist_templates WHERE code='rtl_cond_appraisaldocs'`)).rows[0];
    const condId = (await db.query(
      `INSERT INTO checklist_items (template_id,scope,application_id,label,status,item_kind,is_required) VALUES ($1,'application',$2,$3,'received',$4,true) RETURNING id`,
      [tpl.id, appId, tpl.label, tpl.item_kind])).rows[0].id;
    const badXml = Buffer.from('<not-a-real-appraisal/>', 'utf8').toString('base64');
    const up = await call(server, 'POST', `/api/staff/applications/${appId}/documents`, token,
      { checklistItemId: condId, slot: 'Appraisal data file (XML)', filename: 'appraisal.xml', contentType: 'application/xml', dataBase64: badXml });
    assert(up.status === 201 && up.body && up.body.appraisal, 'XML upload to the appraisal condition surfaces the auto-import result in the response');
    assert(up.body.appraisal && up.body.appraisal.ok === false, 'a non-appraisal XML reports the import problem (never silent)');

    // ---- (8) undo: seed a real appraisal + findings + conditions + filled fields ----
    await db.query(`UPDATE applications SET as_is_value=430000, arv=560000, appraiser_name='Jane Appraiser' WHERE id=$1`, [appId]);
    const apprId = (await db.query(
      `INSERT INTO appraisals (application_id, as_is_value, arv_value, appraiser_name, superseded, imported_at)
       VALUES ($1,430000,560000,'Jane Appraiser',false, now()) RETURNING id`, [appId])).rows[0].id;
    await db.query(`INSERT INTO appraisal_findings (appraisal_id, application_id, code, severity, status, title, blocks_ctc) VALUES ($1,$2,'x','fatal','open','t',true)`, [apprId, appId]);
    // the two internal conditions
    for (const code of ['appraisal_review_cleared', 'appraisal_as_is_verify']) {
      const t = (await db.query(`SELECT id,item_kind,label FROM checklist_templates WHERE code=$1`, [code])).rows[0];
      if (t) await db.query(`INSERT INTO checklist_items (template_id,scope,application_id,label,status,item_kind,is_required) VALUES ($1,'application',$2,$3,'outstanding',$4,true)`, [t.id, appId, t.label, t.item_kind]);
    }

    assert(await cnt(`SELECT count(*)::int n FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId]) === 1, 'seed: an active appraisal exists');

    const undo = await call(server, 'POST', `/api/appraisal/${appId}/undo-import`, token);
    assert(undo.status === 200 && undo.body && undo.body.ok, 'undo-import succeeds');
    assert(await cnt(`SELECT count(*)::int n FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId]) === 0, 'the appraisal data is removed');
    assert(await cnt(`SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1`, [appId]) === 0, 'the appraisal findings are cleared');
    assert(await cnt(`SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id WHERE ci.application_id=$1 AND t.code IN ('appraisal_review_cleared','appraisal_as_is_verify')`, [appId]) === 0, 'the two internal appraisal conditions are reset');
    const a = (await db.query(`SELECT as_is_value, arv, appraiser_name FROM applications WHERE id=$1`, [appId])).rows[0];
    assert(a.as_is_value == null && a.arv == null && a.appraiser_name == null, 'the file fields the import blank-filled are restored (back to empty)');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL appraisal auto-import + undo assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
