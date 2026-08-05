/**
 * TPO PORTAL — Phase 6a (a broker VIEWS the borrower-safe appraisal), real Postgres + HTTP.
 *
 * Proves the broker's "property profile report" is BORROWER-SAFE by construction:
 *   • the appraisal object drops the lender / AMC / owner-of-record / lender-address /
 *     appraiser-contact fields and the `fields`/`warnings` catch-alls — no capital-partner
 *     name can reach a broker;
 *   • underwriting-scrutiny findings (arv_defensibility…) and every note_buyer finding are
 *     hidden, while a real hidden fatal blocker still surfaces the neutral "under review"
 *     placeholder (the broker is never told a gated file is clear);
 *   • a visible finding's title is scrubbed of any partner name;
 *   • score.arv is null (the ARV-defensibility cross-check is staff-only);
 *   • the payload is BYTE-IDENTICAL to the shared borrower-safe view (single definition —
 *     the borrower + broker surfaces can never drift);
 *   • firm isolation on the report AND on the photo bytes; the photo route is NOT a
 *     download-any-document hole (a non-appraisal / cross-firm doc id → 404);
 *   • a file with no appraisal returns the empty shape.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: raw ? b : (b ? JSON.parse(b) : null) })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO appraisal DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const storage = require(R + '/src/lib/storage');
  const { buildBorrowerSafeAppraisalView } = require(R + '/src/lib/appraisal/borrower-safe-view');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });

  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,origin) VALUES ('Ann','Appraisal',$1,'tpo') RETURNING id`, [mail('ann')])).rows[0].id;
    const appA = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source, borrower_portal_enabled)
       VALUES ($1,true,$2,$3,'YSTPOAP1','file_intake','Purchase','tpo',true) RETURNING id`, [borId, firmA, brokerA])).rows[0].id;

    // An appraisal carrying every staff-only leak vector (partner names in lender/amc/owner/fields).
    const apprId = (await db.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at,
         lender_name, amc_name, owner_of_record, lender_address, appraiser_name, appraiser_email, appraiser_phone,
         as_is_value, arv_value, gla, fields, warnings,
         reconciliation_comment, addendum_text, market_conditions_comment, contract_review_comment)
       VALUES ($1,false,now(),
         'RCN Capital LLC','Nationwide AMC','Prior Owner Holdings','1 Servicer Way',
         'Jane Appraiser','jane@appraise.test','555-0100',
         420000, 560000, 1800, $2::jsonb, $3::jsonb,
         'Prepared for the exclusive use of BlueLake Capital.',
         'Intended user: Nationwide AMC on behalf of RCN Capital LLC.',
         'Ordered by Fidelis Investors for this transaction.',
         'Client BlueLake reviewed the contract and assignment.') RETURNING id`,
      [appA,
        JSON.stringify({ appraiser: { lender: 'BlueLake Capital', amc: 'Nationwide AMC' } }),
        JSON.stringify(['comp_split_review', 'nbhd_declining'])])).rows[0].id;

    const finding = (source, code, severity, blocks, title) => db.query(
      `INSERT INTO appraisal_findings (application_id, appraisal_id, source, code, severity, field, appraisal_value, file_value, title, blocks_ctc, status)
       VALUES ($1,$2,$3,$4,$5,'value',null,null,$6,$7,'open')`, [appA, apprId, source, code, severity, title, blocks]);
    // HIDDEN: an underwriting-scrutiny fatal blocker → must NOT appear, but must trip the placeholder.
    await finding('underwriter', 'arv_defensibility', 'fatal', true, 'ARV looks inflated vs the comps');
    // HIDDEN: a note-buyer finding (its title names a buyer) → dropped by SOURCE.
    await finding('note_buyer', 'emcap_anchor', 'warning', false, 'EMCAP requires an anchor comp within 12 months');
    // VISIBLE ordinary finding whose title carries a partner name → shown, but title scrubbed.
    await finding('appraisal', 'value_note', 'info', false, 'Value note — see BlueLake Capital guidance');

    // A borrower-visible appraisal PHOTO with real stored bytes (so the photo route can stream it).
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f8b0000000049454e44ae426082', 'hex');
    const s = await storage.save(png, { filename: 'photo.png' });
    const photoDoc = (await db.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type,review_status,reviewed_at)
       VALUES ($1,$2,'RCN Capital front.png','image/png',$3,$4,$5,'staff',$6,'appraisal_photo','borrower','system','accepted',now()) RETURNING id`,
      [appA, borId, png.length, s.provider, s.ref, brokerA])).rows[0].id;
    await db.query(`INSERT INTO appraisal_photos (appraisal_id, document_id, sequence, width, height, category) VALUES ($1,$2,0,1,1,'photo')`, [apprId, photoDoc]);
    // A NON-appraisal document on the same file (must never be reachable via the photo route).
    const otherDoc = (await db.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type)
       VALUES ($1,$2,'secret.pdf','application/pdf',10,$3,$4,'staff',$5,'credit_pdf','staff_only','system') RETURNING id`,
      [appA, borId, s.provider, s.ref, brokerA])).rows[0].id;

    // ---------------------------------------------------------------
    // 1) BORROWER-SAFE REPORT
    // ---------------------------------------------------------------
    const rep = await call(server, 'GET', `/api/tpo/applications/${appA}/appraisal`, tokA);
    ok(rep.status === 200 && rep.body && rep.body.appraisal, 'broker reads the appraisal report (200)');
    const a = rep.body.appraisal || {};
    ok(a.appraiser_name === 'Jane Appraiser', 'the "prepared by" appraiser name is kept (standard disclosure)');
    const dropped = ['lender_name', 'amc_name', 'owner_of_record', 'lender_address', 'fields', 'warnings', 'appraiser_email', 'appraiser_phone'];
    ok(dropped.every((k) => !(k in a)), 'the staff-only appraisal columns are DROPPED (lender/AMC/owner/contact/fields/warnings)');
    // The free-text appraiser NARRATIVE columns are dropped too — an appraiser routinely names the
    // client / ordering lender / AMC / capital partner in the reconciliation / addendum / intended-use
    // narrative, which a denylist of the structured columns alone would leak.
    const narrative = ['reconciliation_comment', 'addendum_text', 'market_conditions_comment', 'market_reconciliation_comment', 'conditions_comment', 'condition_comment', 'contract_review_comment', 'sales_agreement_analysis', 'nbhd_boundaries', 'appraiser_id'];
    ok(narrative.every((k) => !(k in a)), 'the appraiser NARRATIVE columns are DROPPED (they name the client/lender/AMC/intended user)');
    ok(rep.body.score && rep.body.score.arv === null, 'score.arv is null (ARV-defensibility is staff-only)');
    const codes = (rep.body.findings || []).map((f) => f.code);
    ok(!codes.includes('arv_defensibility'), 'the underwriting-scrutiny finding is hidden');
    ok(!codes.includes('emcap_anchor'), 'the note-buyer finding is hidden (by source)');
    ok(codes.includes('value_note'), 'the ordinary finding is shown');
    ok(codes.includes('appraisal_under_review'), 'a hidden FATAL blocker still surfaces the neutral "under review" placeholder');
    const bodyStr = JSON.stringify(rep.body);
    ok(!/BlueLake|Blue Lake|RCN Capital|EMCAP|Nationwide AMC|Prior Owner|Fidelis/i.test(bodyStr),
      'NO capital-partner / note-buyer / lender / AMC / owner name leaks anywhere in the payload (incl. the appraiser narrative)');

    // ---------------------------------------------------------------
    // 2) SINGLE DEFINITION — byte-identical to the shared borrower-safe view
    // ---------------------------------------------------------------
    const shared = await buildBorrowerSafeAppraisalView(db, appA);
    ok(JSON.stringify(rep.body) === JSON.stringify(shared), 'the broker payload is byte-identical to the shared borrower-safe view (no drift)');

    // ---------------------------------------------------------------
    // 3) FIRM ISOLATION on the report
    // ---------------------------------------------------------------
    ok((await call(server, 'GET', `/api/tpo/applications/${appA}/appraisal`, tokB)).status === 404, 'broker B cannot read firm A appraisal (404)');

    // ---------------------------------------------------------------
    // 4) PHOTO BYTES — firm-scoped, appraisal-photos only (never a download-any-doc hole)
    // ---------------------------------------------------------------
    const ph = await call(server, 'GET', `/api/tpo/appraisal-photo/${photoDoc}?inline=1`, tokA, null, true);
    ok(ph.status === 200 && ph.body && ph.body.length > 0, 'broker A fetches the appraisal photo bytes (200)');
    ok((await call(server, 'GET', `/api/tpo/appraisal-photo/${photoDoc}?inline=1`, tokB)).status === 404, 'broker B cannot fetch firm A appraisal photo (404)');
    ok((await call(server, 'GET', `/api/tpo/appraisal-photo/${otherDoc}?inline=1`, tokA)).status === 404, 'the photo route refuses a non-appraisal document id (not a download-any-doc hole)');
    ok((await call(server, 'GET', `/api/tpo/appraisal-photo/00000000-0000-0000-0000-000000000000?inline=1`, tokA)).status === 404, 'the photo route 404s an unknown document id');

    // ---------------------------------------------------------------
    // 5) NO APPRAISAL → empty shape
    // ---------------------------------------------------------------
    const appEmpty = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source)
       VALUES ($1,true,$2,$3,'YSTPOAP2','file_intake','Purchase','tpo') RETURNING id`, [borId, firmA, brokerA])).rows[0].id;
    const emp = await call(server, 'GET', `/api/tpo/applications/${appEmpty}/appraisal`, tokA);
    ok(emp.status === 200 && emp.body.appraisal === null && Array.isArray(emp.body.findings) && emp.body.findings.length === 0,
      'a file with no appraisal returns the empty shape');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message, e.stack ? e.stack.split('\n')[1] : '');
  } finally {
    try {
      const like = `%${sfx}%`;
      const appIds = (await db.query(
        `SELECT id FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)
            OR borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like])).rows.map((r) => r.id);
      if (appIds.length) {
        await db.query(`DELETE FROM appraisal_photos WHERE appraisal_id IN (SELECT id FROM appraisals WHERE application_id = ANY($1::uuid[]))`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM appraisal_findings WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM appraisal_comparables WHERE appraisal_id IN (SELECT id FROM appraisals WHERE application_id = ANY($1::uuid[]))`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM appraisals WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM documents WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
      }
      await db.query(`DELETE FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)`, [like]);
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE email LIKE $1)`, [like]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM tpo_firms WHERE name LIKE $1`, [like]);
    } catch (_) { /* best-effort cleanup */ }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    console.log(`test-tpo-appraisal-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
