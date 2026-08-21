/**
 * THE GC RECORD END TO END (db/605) — real Postgres, real HTTP.
 *
 * Owner-directed 2026-08-21, two asks that are one deliverable: "adding the feasibility
 * report … and the contractor contact information in the TPR export and in the
 * SharePoint" (item 8) and "take this information and lay it out on a PDF GC contractor
 * information nicely to include in the invested delivery TPR export SharePoint" +
 * "Keep that slot as an optional slot, which means it should not need to upload something
 * to sign off the condition" (item 10).
 *
 * So what is measured is the three things that were actually asked for: the record can be
 * typed, the sheet it produces really reaches the investor package and the team site's
 * Scope-of-Work folder, and the condition can be signed off with nothing uploaded.
 */
const http = require('http');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP test-gc-record-db (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const GC = require(R + '/src/lib/contractor/gc-record');
  const sheet = require(R + '/src/lib/contractor/gc-sheet');
  const tpr = require(R + '/src/lib/tpr-export');
  const spCat = require(R + '/src/lib/sharepoint-backup').categoryFor;
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@gc.test`;

  try {
    const hash = await C.hashPassword('GcPass123!');
    const superId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'GC Super','super_admin',true,false,$2,0) RETURNING id`, [mail('super'), hash])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Gc','Owner',$1) RETURNING id`, [mail('bo')])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,ys_loan_number,property_address)
       VALUES ($1,$2,'underwriting','Purchase',$3,'{"oneLine":"9 Builder Way"}') RETURNING id`,
      [borId, superId, 'YSGC' + sfx.slice(-6)])).rows[0].id;
    // The GC condition, from the real template so the category rules are the live ones.
    const tpl = (await db.query(`SELECT id, item_kind FROM checklist_templates WHERE code='rtl_cond_gc_info'`)).rows[0];
    ok(!!tpl, 'the GC condition template exists (db/601)');
    const item = (await db.query(
      `INSERT INTO checklist_items (scope,application_id,template_id,label,borrower_label,audience,item_kind,is_required,created_by_kind)
       VALUES ('application',$1,$2,'GC information (general contractor)','Your general contractor''s information','both',$3,true,'staff') RETURNING id`,
      [appId, tpl.id, tpl.item_kind])).rows[0].id;

    /* ── A. the upload slot is OPTIONAL ──────────────────────────────────── */
    console.log('\nA. the condition signs off with nothing uploaded');
    const so = await call(server, 'PATCH', `/api/staff/checklist/${item}`, tok, { signedOff: true });
    ok(so.status === 200, 'a GC condition with NO document signs off — the owner\'s "it should not need to upload something"');
    // …and it is still a REQUIRED condition, so it still carries its weight before clear to close.
    ok((await db.query(`SELECT is_required FROM checklist_items WHERE id=$1`, [item])).rows[0].is_required === true,
      '…while staying REQUIRED — the upload is optional, the condition is not');
    // A CONTROL: an ordinary document condition still refuses, so the exclusion is narrow.
    const other = (await db.query(
      `INSERT INTO checklist_items (scope,application_id,label,audience,item_kind,is_required,created_by_kind)
       VALUES ('application',$1,'Some other document','staff','document',true,'staff') RETURNING id`, [appId])).rows[0].id;
    const soOther = await call(server, 'PATCH', `/api/staff/checklist/${other}`, tok, { signedOff: true });
    ok(soOther.status === 422, 'an ORDINARY document condition still refuses an empty sign-off — the exclusion is only the GC slot');
    await db.query(`UPDATE checklist_items SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL WHERE id=$1`, [item]);

    /* ── B. with no contractor on the file ───────────────────────────────── */
    console.log('\nB. before a contractor is on the file');
    const empty = await call(server, 'GET', `/api/staff/applications/${appId}/gc-record`, tok);
    ok(empty.status === 200 && empty.body.contact === null, 'the card reads as empty rather than erroring');
    ok(Array.isArray(empty.body.fields) && empty.body.fields.length >= 10, '…and still says what CAN be recorded');
    const early = await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, { license_number: 'X' });
    ok(early.status === 409 && early.body.code === 'no_contractor',
      'saving a licence before there is a contractor says WHAT to do, rather than inventing a company');
    ok((await sheet.refreshForApplication(appId)).reason === 'nothing_recorded', 'and no sheet is drawn from nothing');

    /* ── C. the record ───────────────────────────────────────────────────── */
    console.log('\nC. the record');
    const contact = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email, phone, address, added_by_staff_id)
       VALUES ($1,'contractor','Kraft Builders LLC','Moshe Kraft',$2,'732-555-0140','12 Cedar Ave, Lakewood, NJ 08701',$3) RETURNING id`,
      [borId, mail('gc'), superId])).rows[0].id;
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type, added_by_kind, added_by_id)
       VALUES ($1,$2,'contractor','staff',$3)`, [appId, contact, superId]);

    const got = await call(server, 'GET', `/api/staff/applications/${appId}/gc-record`, tok);
    ok(got.body.contact && got.body.contact.company_name === 'Kraft Builders LLC',
      'the identity comes from the FILE CONTACT — one record of a company, not a second copy');
    ok(got.body.contact.license_number == null, '…with the contractor-specific part still blank');

    const saved = await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, {
      license_number: '13VH01234500', license_state: 'nj', license_expires_on: '2027-03-31',
      gl_carrier: 'Hartford', gl_policy_number: 'GL-88231', gl_expires_on: '2026-05-01' });
    ok(saved.status === 200, 'the record saves');
    ok(saved.body.contact.license_state === 'NJ', 'a state is stored the way a register spells it');
    ok(saved.body.sheet && saved.body.sheet.made === true, '…and the sheet is drawn in the same breath');

    // Partial saves must not blank what is already there — a builder pays in instalments.
    const later = await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, { wc_carrier: 'NJM' });
    ok(later.status === 200 && later.body.contact.wc_carrier === 'NJM' && later.body.contact.license_number === '13VH01234500',
      "recording the workers' comp later does not blank the licence recorded before it");
    const nothingNew = await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, { wc_carrier: 'NJM' });
    ok(nothingNew.body.sheet && nothingNew.body.sheet.reason === 'unchanged',
      'saving the same thing twice does NOT mint a second sheet — that is what fills a mirror with identical copies');
    const bad = await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, { license_expires_on: '31/03/2027' });
    ok(bad.status === 400, 'a date in the wrong shape is refused at the door');
    ok((await GC.loadForApplication(appId)).license_expires_on != null, '…and the refusal wrote nothing');

    /* ── D. the sheet reaches the investor package and the team site ─────── */
    console.log('\nD. where the sheet goes');
    const doc = (await db.query(
      `SELECT id, filename, doc_kind, review_status, checklist_item_id, visibility FROM documents
        WHERE application_id=$1 AND doc_kind=$2 AND is_current=true`, [appId, sheet.DOC_KIND])).rows;
    ok(doc.length === 1, 'exactly ONE current sheet on the file');
    ok(doc[0].review_status === 'accepted',
      'it is born ACCEPTED — PILOT drew it, so there is nobody to review it, and a pending copy would be held back from the export it exists for');
    ok(doc[0].checklist_item_id === item, 'it is filed ON the GC condition, which is what puts it in the right folder for free');
    ok(tpr.categoryFor({ doc_kind: sheet.DOC_KIND, template_code: 'rtl_cond_gc_info' }) === 'Scope of Work',
      'the investor package files it with the Scope of Work');
    ok(spCat({ doc_kind: sheet.DOC_KIND, template_code: 'rtl_cond_gc_info' }) === 'Scope of Work',
      '…and the team site files it in the SAME folder, through the same categorizer');
    ok(tpr.categoryFor({ doc_kind: sheet.DOC_KIND }) === 'Scope of Work',
      'and it still lands there on a file that never had a GC condition — not in the catch-all');
    const sel = await tpr.selectTprDocuments(appId);
    ok(sel.some((d) => d.doc_kind === sheet.DOC_KIND), 'the sheet is actually SELECTED into the investor package');

    /* ── E. a redraw supersedes only its own predecessor ─────────────────── */
    console.log('\nE. a second version');
    await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, { ein: '82-1234567' });
    const after = (await db.query(
      `SELECT is_current FROM documents WHERE application_id=$1 AND doc_kind=$2 ORDER BY created_at`, [appId, sheet.DOC_KIND])).rows;
    ok(after.length >= 2 && after.filter((d) => d.is_current).length === 1, 'a redraw leaves exactly one current sheet');
    // A human's own document on the same condition is NOT superseded by our sheet.
    const human = (await db.query(
      `INSERT INTO documents (application_id,borrower_id,checklist_item_id,filename,content_type,size_bytes,
                              storage_provider,storage_ref,uploaded_by_kind,is_current,visibility,source_type,review_status)
       VALUES ($1,$2,$3,'License certificate.pdf','application/pdf',10,'local',$4,'staff',true,'staff_only','staff_upload','accepted') RETURNING id`,
      [appId, borId, item, 'gc/' + sfx])).rows[0].id;
    await call(server, 'PUT', `/api/staff/applications/${appId}/gc-record`, tok, { website: 'kraftbuilders.com' });
    ok((await db.query(`SELECT is_current FROM documents WHERE id=$1`, [human])).rows[0].is_current === true,
      "our redraw never supersedes the human's own certificate on the same condition");

    console.log(`\ntest-gc-record-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('FAILED:', e && (e.stack || e.message));
    fail++;
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  process.exit(fail ? 1 : 0);
})();
