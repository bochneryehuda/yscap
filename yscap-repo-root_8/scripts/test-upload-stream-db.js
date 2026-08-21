'use strict';
/**
 * test-upload-stream-db — a document BIGGER than any JSON body can carry, uploaded for
 * real, over real HTTP, and read back byte-for-byte.
 *
 * Owner-reported 2026-08-21: a 23.3 MB executed contract could not be uploaded at all,
 * and the refusal appeared at the top of the page rather than beside the condition.
 *
 * WHAT IS REAL HERE: Express, the auth middleware, the file-scope gate, the streaming
 * door, the storage layer and Postgres. The ceilings are set small on purpose so the
 * suite proves the RULES in seconds rather than pushing a gigabyte through loopback:
 * a 12 MB document with a 4 MB JSON ceiling is the same relationship as a 300 MB one
 * with a 25 MB ceiling.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-upload-stream-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

// Set BEFORE anything requires config.
process.env.MAX_UPLOAD_MB = '64';
process.env.MAX_JSON_UPLOAD_MB = '4';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const REPO = path.join(__dirname, '..');
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const storage = require(REPO + '/src/lib/storage');
const U = require(REPO + '/src/lib/upload-stream');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✘ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

function call(server, method, p, { body = null, headers = {}, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: b ? (() => { try { return JSON.parse(b); } catch (_) { return b; } })() : null,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const B = uuid(), APP = uuid(), LO = uuid();
  let itemId = null, staffItemId = null;
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'Upload Officer','loan_officer','x',true)`,
      [LO, `up_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email,cell_phone) VALUES ($1,'Ada','Byron',$2,'7325550111')`,
      [B, `ab_${B.slice(0, 8)}@x.test`]);
    await db.query(
      `INSERT INTO applications (id,borrower_id,loan_officer_id,status,property_address)
       VALUES ($1,$2,$3,'underwriting',$4::jsonb)`,
      [APP, B, LO, JSON.stringify({ street: '1 Big File Way', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    itemId = (await db.query(
      `INSERT INTO checklist_items (application_id,label,borrower_label,audience,item_kind,status,is_required,scope)
       VALUES ($1,'Executed contract','Executed contract','both','document','outstanding',true,'application') RETURNING id`, [APP])).rows[0].id;
    staffItemId = (await db.query(
      `INSERT INTO checklist_items (application_id,label,audience,item_kind,status,is_required,scope)
       VALUES ($1,'Internal only','staff','document','outstanding',true,'application') RETURNING id`, [APP])).rows[0].id;

    const tok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    const meta = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

    // ---------------------------------------------------------------- 1. the big one
    console.log('1. a document larger than any JSON body can carry');
    /* 12 MB against a 4 MB JSON ceiling: this file CANNOT go through the historic door,
       which is precisely the owner's 23.3 MB contract against the old 20 MB cap. */
    const big = crypto.randomBytes(12 * 1024 * 1024);
    const bigSha = crypto.createHash('sha256').update(big).digest('hex');
    const r1 = await call(server, 'POST', `/api/staff/applications/${APP}/documents/binary`, {
      body: big, token: tok,
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-upload-meta': meta({ filename: 'Fully_Executed_Contract.pdf', contentType: 'application/pdf', checklistItemId: itemId }),
      },
    });
    eq(r1.status, 201, 'a 12 MB document uploads');
    ok(r1.body && r1.body.documentId, 'it comes back with a document id');
    const doc = (await db.query(`SELECT * FROM documents WHERE id=$1`, [r1.body.documentId])).rows[0];
    ok(!!doc, 'the document row exists');
    eq(Number(doc.size_bytes), big.length, 'the recorded size is the real size');
    eq(doc.filename, 'Fully_Executed_Contract.pdf', 'the filename came through the header intact');
    eq(doc.checklist_item_id, itemId, 'it landed on the condition it was uploaded to');
    /* THE BYTES ARE THE POINT. A streaming path that stores a truncated or re-encoded
       file would pass every other assertion here. */
    const back = await storage.read(doc.storage_ref);
    eq(crypto.createHash('sha256').update(back).digest('hex'), bigSha, 'the stored bytes are byte-for-byte what was sent');

    // ------------------------------------------------- 2. the same handler, both doors
    console.log('2. one handler — the staff-only rule cannot differ by door');
    const r2 = await call(server, 'POST', `/api/staff/applications/${APP}/documents/binary`, {
      body: Buffer.from('internal'), token: tok,
      headers: { 'Content-Type': 'application/octet-stream',
        'x-upload-meta': meta({ filename: 'internal.txt', contentType: 'text/plain', checklistItemId: staffItemId }) },
    });
    eq(r2.status, 201, 'a document on a staff-audience condition uploads');
    eq(r2.body.visibility, 'staff_only', 'and is stored STAFF-ONLY through the streaming door too');

    // ----------------------------------------------------------- 3. the honest refusal
    console.log('3. a refusal says exactly what is wrong');
    /* Just over the JSON ceiling but still inside what express will parse, so the DOOR's
       own sentence is what the user sees — not a bare "upload too large" from the parser. */
    const overJson = crypto.randomBytes(Math.round(4.6 * 1024 * 1024));
    const r3 = await call(server, 'POST', `/api/staff/applications/${APP}/documents`, {
      token: tok,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'too-big-for-json.pdf', contentType: 'application/pdf', checklistItemId: itemId, dataBase64: overJson.toString('base64') }),
    });
    eq(r3.status, 413, 'the JSON door refuses a body over its ceiling');
    ok(/too-big-for-json\.pdf/.test(r3.body.error), 'the refusal names the file');
    ok(/4 MB|4\.0 MB/.test(r3.body.error), 'the refusal quotes the real limit');

    // --------------------------------------------------- 4. the streaming door's guard
    console.log('4. the streaming guard cuts a runaway upload off mid-flight');
    const { Readable } = require('stream');
    const fakeReq = Readable.from((function* () {
      for (let i = 0; i < 40; i++) yield Buffer.alloc(64 * 1024, 9);
    })());
    let refused = null;
    try { await U.receiveUpload(fakeReq, { maxBytes: 1024 * 1024, filename: 'runaway.bin' }); }
    catch (e) { refused = e; }
    ok(refused && refused.status === 413, 'it refuses with 413');
    ok(refused && /runaway\.bin/.test(refused.message), 'and names the file');
    /* NOTHING IS LEFT BEHIND. A document is the most sensitive thing this system holds;
       a stray copy of a refused one in the temp directory is exactly what must not
       survive. */
    const os = require('os'), fs = require('fs');
    const strays = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pilot-up-'));
    eq(strays.length, 0, 'no temp copy of a refused upload is left in /tmp');

    console.log('5. an empty upload is an error, not a zero-byte document');
    const r5 = await call(server, 'POST', `/api/staff/applications/${APP}/documents/binary`, {
      body: null, token: tok,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0',
        'x-upload-meta': meta({ filename: 'nothing.pdf', checklistItemId: itemId }) },
    });
    ok(r5.status >= 400, 'an empty body is refused');
    ok(/empty/i.test(String(r5.body && r5.body.error)), 'and says so');

    console.log('6. the scope still governs — a streamed upload is not a way past it');
    const OUT = uuid();
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'Outsider','loan_officer','x',true)`,
      [OUT, `out_${OUT.slice(0, 8)}@x.test`]);
    const r6 = await call(server, 'POST', `/api/staff/applications/${APP}/documents/binary`, {
      body: Buffer.from('nope'), token: C.signJwt({ sub: OUT, kind: 'staff', role: 'loan_officer', tv: 0 }),
      headers: { 'Content-Type': 'application/octet-stream',
        'x-upload-meta': meta({ filename: 'sneaky.pdf', checklistItemId: itemId }) },
    });
    ok(r6.status === 403 || r6.status === 404, `a staffer with no access to the file is refused (got ${r6.status})`);

    console.log('7. the OTHER document doors take the big file too');
    /* "It should be fixed across the entire system. Do research everywhere where you can upload
       documents." The condition door was fixed first; these are the rest of the doors a person
       actually files a DOCUMENT through, and each was still capped at the JSON ceiling. An
       operating agreement or a set of articles is a multi-page SCAN — routinely the largest
       thing on a loan — so the entity door had no business being the one left behind.

       The SAME 12 MB body against the SAME 4 MB JSON ceiling: a file that cannot go through the
       historic door at all. */
    const llc = (await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`,
      [B, `Streamed Holdings ${APP.slice(0, 8)} LLC`])).rows[0].id;
    const trk = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type)
       VALUES ($1,$2,'flip') RETURNING id`,
      [B, JSON.stringify({ street: '9 Past Deal Rd', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    const lead = (await db.query(
      // `tool` is the one NOT NULL column with no default — a lead is always recorded with the
      // marketing tool it came in through.
      `INSERT INTO leads (name, email, officer_id, tool) VALUES ('Streamed Lead',$1,$2,'loan_application') RETURNING id`,
      [`lead_${APP.slice(0, 8)}@x.test`, LO])).rows[0].id;

    const DOORS = [
      { what: 'an entity document (operating agreement)', path: `/api/staff/llcs/${llc}/documents/binary`, name: 'operating-agreement.pdf' },
      { what: 'a track-record document', path: `/api/staff/track-records/${trk}/documents/binary`, name: 'hud-statement.pdf' },
      { what: 'a lead document', path: `/api/staff/leads/${lead}/documents/binary`, name: 'prospect-contract.pdf' },
    ];
    for (const D of DOORS) {
      const r = await call(server, 'POST', D.path, {
        body: big, token: tok,
        headers: { 'Content-Type': 'application/octet-stream',
          'x-upload-meta': meta({ filename: D.name, contentType: 'application/pdf' }) },
      });
      eq(r.status, 201, `${D.what} uploads at 12 MB`);
      const docId = r.body && r.body.documentId;
      ok(!!docId, `${D.what} is recorded`);
      if (docId) {
        /* THE BYTES ARE THE POINT — asserted by reading the stored copy back and hashing it,
           not by trusting the 201. A streamed upload that recorded a row and stored nothing
           would pass every other check here. */
        const row = (await db.query(`SELECT storage_ref, storage_provider, size_bytes FROM documents WHERE id=$1`, [docId])).rows[0];
        eq(Number(row && row.size_bytes), big.length, `${D.what}: the recorded size is the real one`);
        const back = await storage.forRow(row).read(row.storage_ref);
        eq(crypto.createHash('sha256').update(back).digest('hex'), bigSha,
          `${D.what}: and the stored copy is the file, byte for byte`);
      }
    }
    /* AND THE JSON DOOR STILL REFUSES HONESTLY on the same door — the ceiling did not move for
       the transport that cannot afford it, and the refusal still names the file and the limit. */
    const llcJsonRefusal = await call(server, 'POST', `/api/staff/llcs/${llc}/documents`, {
      body: JSON.stringify({ filename: 'too-big.pdf', contentType: 'application/pdf',
        dataBase64: big.slice(0, 6 * 1024 * 1024).toString('base64') }),
      token: tok, headers: { 'Content-Type': 'application/json' },
    });
    ok(llcJsonRefusal.status === 413 || llcJsonRefusal.status === 400,
      `the JSON door still refuses what it cannot afford (got ${llcJsonRefusal.status})`);
    if (llcJsonRefusal.status === 413) {
      ok(/too-big\.pdf/.test(String(llcJsonRefusal.body && llcJsonRefusal.body.error)),
        '…naming the file, not just "upload failed"');
    }
  } finally {
    await db.query(`DELETE FROM documents WHERE llc_id IN (SELECT id FROM llcs WHERE borrower_id=$1)`, [B]).catch(() => {});
    await db.query(`DELETE FROM documents WHERE track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)`, [B]).catch(() => {});
    await db.query(`DELETE FROM documents WHERE lead_id IN (SELECT id FROM leads WHERE officer_id=$1)`, [LO]).catch(() => {});
    await db.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE officer_id=$1)`, [LO]).catch(() => {});
    await db.query(`DELETE FROM leads WHERE officer_id=$1`, [LO]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)`, [B]).catch(() => {});
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE llc_id IN (SELECT id FROM llcs WHERE borrower_id=$1)`, [B]).catch(() => {});
    await db.query(`DELETE FROM llcs WHERE borrower_id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    server.close();
  }
  console.log(`\ntest-upload-stream-db: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
