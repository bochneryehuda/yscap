/**
 * TPO PORTAL — Phase 6b (a broker VIEWS the draws), real Postgres + HTTP.
 *
 * Proves the broker's construction-draw view is BORROWER-SAFE + READ-ONLY by construction:
 *   • the rollup drops OUR fee income (`rollup.fees`) and the per-draw fee SCHEDULE (`fee_kind`),
 *     while the per-draw money the borrower is paid (net_release_cents) stays;
 *   • a capital-partner name planted in a finding line name / inspector comment / media note is
 *     SCRUBBED, and the media GPS (lat/lng) is dropped;
 *   • the finding's `reply_token` — a PUBLIC capability that also permits accept/dispute — NEVER
 *     reaches the broker (no field, no value, and the photo urls are firm-scoped /api/tpo/draw-media,
 *     never the /api/public/draw-findings reply_token url);
 *   • the payload is BYTE-IDENTICAL to the single shared borrower-safe scrub (borrower + broker can
 *     never drift);
 *   • firm isolation on the draws endpoint, the report, AND the media bytes; the media route is NOT
 *     a download-any-document hole (a non-image / cross-firm / unknown id → 404);
 *   • a file with no draws returns the empty shape.
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
      (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ctype: res.headers['content-type'] || '', buf, body: raw ? buf.toString('latin1') : (buf.length ? JSON.parse(buf.toString('utf8')) : null) });
      }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// a tiny valid PNG (1x1) so storage.save + the media route have real bytes to serve
function png() {
  return Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000d49444154789c6360000002000100ffff0300000600055773d6d40000000049454e44ae426082', 'hex');
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO draws DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const storage = require(R + '/src/lib/storage');
  const rollupMod = require(R + '/src/sitewire/rollup');
  const borrowerSafeDraws = require(R + '/src/sitewire/borrower-safe-draws');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  const DR = 700000 + Math.floor(Math.random() * 90000);   // unique-ish sitewire draw id

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
      `INSERT INTO borrowers (first_name,last_name,email,origin) VALUES ('Dan','Draw',$1,'tpo') RETURNING id`, [mail('dan')])).rows[0].id;
    const appA = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source, borrower_portal_enabled, rehab_budget)
       VALUES ($1,true,$2,$3,$4,'funded','Purchase','tpo',true,126000) RETURNING id`, [borId, firmA, brokerA, `YD${DR}A`])).rows[0].id;
    // A second firm-A file with NO draws → the empty shape.
    const appEmpty = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source, borrower_portal_enabled)
       VALUES ($1,true,$2,$3,$4,'file_intake','Purchase','tpo',true) RETURNING id`, [borId, firmA, brokerA, `YD${DR}B`])).rows[0].id;

    // A managed Sitewire property + a delivered draw + inspection findings carrying a note-buyer name
    // in every free-text field, a reply_token (must never leak), and real stored inspector media.
    const SECRET_TOKEN = `SECRET-${sfx}`;
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method) VALUES ($1,$2,'created','live',now(),'mobile')`, [appA, DR + 7]);
    await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES ($1,$2,1,'approved',2000000,1600000)`, [appA, DR]);
    const fid = (await db.query(
      `INSERT INTO draw_findings (application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at,updated_at,reply_token)
       VALUES ($1,$2,'delivered',2000000,1600000,now(),now(),$3) RETURNING id`, [appA, DR, SECRET_TOKEN])).rows[0].id;
    await db.query(
      `INSERT INTO draw_finding_lines (finding_id,sitewire_request_id,sow_line_key,name,requested_cents,approved_cents,not_approved_cents,inspector_comments,media)
       VALUES ($1,$2,'roof',$3,2000000,1600000,400000,$4,$5::jsonb)`,
      [fid, 9100, 'Roof — BlueLake Capital scope', 'Inspected for BlueLake Capital / Fidelis Investors; roof 80% complete.',
        JSON.stringify([{ note: 'Photo reviewed by BlueLake Capital', lat: 40.7128, lng: -74.006 }])]);
    const saved = await storage.save(png(), { filename: 'roof.png' });
    const mediaId = (await db.query(
      `INSERT INTO draw_media (application_id,sitewire_draw_id,sitewire_request_id,sow_line_key,kind,source_url,source_key,storage_provider,storage_ref,content_type,bytes,sha256,lat,lng)
       VALUES ($1,$2,$3,'roof','image',$4,$5,$6,$7,'image/png',$8,$9,40.71,-74.0) RETURNING id`,
      [appA, DR, 9100, `https://sw.test/media/${sfx}.png`, `k-${sfx}`, saved.provider, saved.ref, png().length, 'deadbeef'])).rows[0].id;
    // A NON-image media row (the draw PDF) — the media route must refuse it (image/video only).
    const pdfMediaId = (await db.query(
      `INSERT INTO draw_media (application_id,sitewire_draw_id,kind,source_url,source_key,storage_provider,storage_ref,content_type,bytes,sha256)
       VALUES ($1,$2,'draw_pdf',$3,$4,$5,$6,'application/pdf',10,'beef') RETURNING id`,
      [appA, DR, `https://sw.test/pdf/${sfx}.pdf`, `pdf-${sfx}`, saved.provider, saved.ref])).rows[0].id;

    // ── the draws endpoint (firm A) ──
    const r = await call(server, 'GET', `/api/tpo/applications/${appA}/draws`, tokA);
    ok(r.status === 200, `firm A broker → draws 200 (got ${r.status})`);
    const findings = (r.body && r.body.findings) || [];
    const f0 = findings[0] || {};
    const line0 = (f0.lines || [])[0] || {};
    const rawJson = JSON.stringify(r.body || {});

    ok(findings.length === 1, 'the broker sees the delivered finding');
    ok(!('fees' in (r.body.rollup || {})), 'our fee income across the project is NOT exposed (rollup.fees dropped)');
    const draw0 = ((r.body.rollup && r.body.rollup.draws) || []).find((d) => Number(d.sitewire_draw_id) === DR) || {};
    ok(!('fee_kind' in draw0), 'the per-draw fee SCHEDULE (fee_kind) is NOT exposed');
    ok('net_release_cents' in draw0, 'the broker is told the net that reaches the borrower');

    // the note-buyer name is scrubbed out of every free-text field
    ok(!/BlueLake|Blue Lake|Fidelis/i.test(String(line0.name || '')), 'the line name is scrubbed of a partner name');
    ok(!/BlueLake|Blue Lake|Fidelis/i.test(String(line0.inspector_comments || '')), 'the inspector comment is scrubbed');
    ok(!/BlueLake|Blue Lake|Fidelis/i.test(rawJson), 'NO capital-partner name anywhere in the draws payload');

    // the reply_token (accept/dispute capability) never reaches the broker
    ok(!('reply_token' in f0), 'the finding carries no reply_token field');
    ok(rawJson.indexOf(SECRET_TOKEN) === -1, 'the reply_token VALUE is nowhere in the payload');
    const photos = (line0.photos || []);
    ok(photos.length >= 1, 'the line surfaces its inspection photo');
    ok(photos.every((p) => /^\/api\/tpo\/draw-media\//.test(String(p.url || ''))), 'photo urls are firm-scoped /api/tpo/draw-media (never a public reply_token url)');
    ok(rawJson.indexOf('/api/public/draw-findings/') === -1, 'no /api/public/draw-findings reply_token url in the payload');

    // media GPS is dropped from the line media
    const lm = (line0.media || [])[0] || {};
    ok(!('lat' in lm) && !('lng' in lm), 'the media GPS (lat/lng) is dropped');
    ok(!/BlueLake|Blue Lake/i.test(String(lm.note || '')), 'the media note is scrubbed');

    // BYTE-IDENTICAL to the single shared borrower-safe scrub (single definition)
    const sowRow = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appA])).rows[0];
    const sowState = sowRow && sowRow.tool_payload && sowRow.tool_payload.state ? sowRow.tool_payload.state : null;
    const sharedRollup = borrowerSafeDraws.borrowerSafeRollup(await rollupMod.loadRollup(db, appA, { sowState }));
    const sharedFindings = await borrowerSafeDraws.loadDrawFindings(db, appA, { photoUrl: (ff, mm) => `/api/tpo/draw-media/${mm.id}?inline=1` });
    ok(JSON.stringify(r.body.rollup) === JSON.stringify(sharedRollup), 'the TPO rollup is byte-identical to the shared borrower-safe scrub');
    ok(JSON.stringify(r.body.findings) === JSON.stringify(sharedFindings), 'the TPO findings are byte-identical to the shared borrower-safe scrub');

    // ── the media bytes route ──
    const mA = await call(server, 'GET', `/api/tpo/draw-media/${mediaId}?inline=1`, tokA, null, true);
    ok(mA.status === 200 && mA.buf.length === png().length, 'firm A broker fetches its own inspection photo bytes (200)');
    ok(/image\/png/.test(mA.ctype), 'the media route serves an image content-type');
    const mB = await call(server, 'GET', `/api/tpo/draw-media/${mediaId}?inline=1`, tokB);
    ok(mB.status === 404, 'firm B broker CANNOT fetch firm A media (404 — firm isolation)');
    const mPdf = await call(server, 'GET', `/api/tpo/draw-media/${pdfMediaId}?inline=1`, tokA);
    ok(mPdf.status === 404, 'the media route refuses a non-image (draw_pdf) row');
    const mNone = await call(server, 'GET', `/api/tpo/draw-media/99999999?inline=1`, tokA);
    ok(mNone.status === 404, 'an unknown media id → 404');

    // ── firm isolation on the draws endpoint + report ──
    const rB = await call(server, 'GET', `/api/tpo/applications/${appA}/draws`, tokB);
    ok(rB.status === 404, 'firm B broker CANNOT read firm A draws (404)');
    const repB = await call(server, 'GET', `/api/tpo/applications/${appA}/draws/report`, tokB);
    ok(repB.status === 404, 'firm B broker CANNOT fetch firm A draw report (404)');
    const repA = await call(server, 'GET', `/api/tpo/applications/${appA}/draws/report`, tokA, null, true);
    ok(repA.status === 200 && /application\/pdf/.test(repA.ctype), `firm A broker gets the borrower-safe report PDF (got ${repA.status})`);
    // the stored report is visibility='borrower' (never a staff copy)
    const repDoc = (await db.query(`SELECT visibility FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report' LIMIT 1`, [appA])).rows[0];
    ok(repDoc && repDoc.visibility === 'borrower', 'the report the broker gets is the borrower-safe copy (visibility=borrower)');

    // ── the empty shape ──
    const rEmpty = await call(server, 'GET', `/api/tpo/applications/${appEmpty}/draws`, tokA);
    ok(rEmpty.status === 200 && rEmpty.body.has === false && (rEmpty.body.findings || []).length === 0 && (rEmpty.body.draws || []).length === 0,
      'a file with no draws returns the empty shape (has:false, no findings/draws)');

    console.log(`\ntest-tpo-draws-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('  FAIL (threw):', e && e.stack || e);
    fail++;
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})();
